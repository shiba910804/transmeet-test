'use strict';
/**
 * Consolidated server.js
 * - 角色/權限（teacher / student）
 * - 資料夾管理（僅老師）
 * - 課程（建立 / 加入 / 結束自動通知 / 刪除 / 改名）
 * - 翻譯（Azure Translator）
 * - 摘要（HF + 本地備援）
 * - Socket.IO 廣播 meeting-ended，前端可自動跳Q轉
 * - 移除重複與互相覆蓋的路由，正確的中介軟體順序，DB 初始化在最前
 *
 * 覆蓋後：
 * - 新增/保留路由：
 *   POST   /api/signup                     （含角色）
 *   POST   /api/login                      （含角色）
 *   GET    /api/user/language              （查語言偏好）
 *   POST   /api/user/language              （設語言偏好）
 *   GET    /api/speech-key
 *   POST   /api/translate
 *   POST   /api/summarize
 *   
 *   // 資料夾（老師）
 *   GET    /api/folders
 *   POST   /api/folders
 *   PUT    /api/folders/:id
 *   DELETE /api/folders/:id
 *   GET    /api/folders/:id/meetings
 * 
 *   // 課程
 *   POST   /api/meetings                   （老師開課）
 *   GET    /api/meetings                   （依角色回傳）
 *   GET    /api/meetings/:id               （權限：開課者或參與者）
 *   POST   /api/meetings/:id/join          （學生加入，role=viewer）
 *   POST   /api/meetings/:id/end           （開課者結束，Socket 廣播）
 *   PUT    /api/meetings/:id/title         （開課者改名）
 *   DELETE /api/meetings/:id               （開課者刪除課程 + 訊息）
 *
 *   // 轉錄
 *   POST   /api/transcripts                （新增轉錄，token 可選）
 *   // 舊相容：
 *   POST   /api/add-transcript             （同上，保留相容）
 *   POST   /api/update-meeting/:meetingId  （相容舊路由→改名）
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const axios = require('axios');
const crypto = require('crypto');
const os = require('os');
const cookieParser = require('cookie-parser');
const SECRET = process.env.JWT_SECRET || 'dev_secret';


const onlineUsers = new Map(); // meetingId -> Set(userId)
const userSockets = new Map(); // userId -> socketId
const socketUsers = new Map(); // socketId -> { userId, meetingId, username }


// 保留原本引用（未必在此檔使用，但避免你現有相依壞掉）
const puppeteer = require('puppeteer');
const sdk = require('microsoft-cognitiveservices-speech-sdk');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, AlignmentType } = require('docx');


const nodemailer = require('nodemailer');
const APP_BASE_URL = process.env.APP_BASE_URL;

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});
// 創建 Gmail 傳輸
const gmailTransporter = nodemailer.createTransport({
  host: process.env.GMAIL_HOST,
  port: Number(process.env.GMAIL_PORT || 587),
  secure: false,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

// 創建 Outlook 傳輸
const outlookTransporter = nodemailer.createTransport({
  host: process.env.OUTLOOK_HOST,
  port: Number(process.env.OUTLOOK_PORT || 587),
  secure: false,
  auth: {
    user: process.env.OUTLOOK_USER,
    pass: process.env.OUTLOOK_PASS,
  },
});

// 1. 優化 getTransporterByEmail 函數 - 支援更多信箱類型
function getTransporterByEmail(email) {
  const domain = email.split('@')[1].toLowerCase();
  
  // Outlook/Hotmail/Live 系列
  if (domain.includes('outlook') || domain.includes('hotmail') || domain.includes('live')) {
    return {
      transporter: outlookTransporter,
      from: process.env.OUTLOOK_FROM
    };
  }
  
  // 企業或教育機構信箱 (例如 @mail.yzu.edu.tw)
  // 這些通常使用標準 SMTP，可以嘗試用 Gmail 設定
  // 或者為特定機構配置專用 SMTP
  if (domain.includes('.edu') || domain.includes('.gov') || domain.includes('.org')) {
    // 可以在這裡添加特定機構的 SMTP 設定
    // 目前先使用 Gmail 作為備選
    return {
      transporter: gmailTransporter,
      from: process.env.GMAIL_FROM
    };
  }
  
  // 其他信箱 (包括 Gmail 和其他服務商)
  // 使用 Gmail SMTP 作為通用發送服務
  return {
    transporter: gmailTransporter,
    from: process.env.GMAIL_FROM
  };
}

// -------------------------------------------------------------
// 基本設定
// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key_change_in_production';

const app = express();

// 一定要在路由前
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS（開發用：全部允許；正式環境請改白名單）
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

// CORS header（配合各種 run 環境）
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});


// 靜態檔案（public 資料夾）
app.use(express.static(path.join(__dirname, 'public')));

app.get('/join/:id', (req, res) => {
  const meetingId = req.params.id;
  console.log("Join meeting:", meetingId);

  // 直接回傳 meeting.html
  res.sendFile(path.join(__dirname, 'public', 'meeting.html'));
});

// 簡易請求日誌
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  if (req.body && Object.keys(req.body).length > 0) {
    try { console.log('Body:', JSON.stringify(req.body).slice(0, 800)); } catch {}
  }
  next();
});

app.use(cookieParser());
// --- Public health endpoints (no auth) ---
// 輕量健康：活著就回 200
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});
app.head('/health', (req, res) => res.sendStatus(200));

// 就緒度：順便檢查 DB（可選）
app.get('/readyz', async (req, res) => {
  let dbOK = false, dbErr = null;
  try { await pool.query('SELECT 1'); dbOK = true; } catch (e) { dbErr = e.message; }
  const ok = dbOK;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ready' : 'degraded',
    db: dbOK, db_error: dbErr,
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// 若你前端已經寫死打 /api/health，也一併提供（不重導，直接回應最單純）
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});
app.get('/api/readyz', (req, res) => {
  req.url = '/readyz'; // 轉到上面的 /readyz handler
  req.method = 'GET';
  return app._router.handle(req, res);
});

// -------------------------------------------------------------
// DB 連線池（務必在任何使用 DB 的函式之前建立）
// -------------------------------------------------------------
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || '127.0.0.1',
  database: process.env.DB_NAME || 'test02',
  password: process.env.DB_PASSWORD || '1234',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
  max: 20,
  idleTimeoutMillis: 30020,
  connectionTimeoutMillis: 2000,
});

// -------------------------------------------------------------
// 初始化與表結構修補
// -------------------------------------------------------------


function checkSmtpEnv() {
  const required = ['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','MAIL_FROM','APP_BASE_URL'];
  const missing = required.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
  if (missing.length) {
    console.warn('⚠️ 缺少 SMTP/APP 相關環境變數：', missing.join(', '));
  } else {
    console.log('✅ SMTP/APP 變數就緒：',
      { SMTP_HOST: process.env.SMTP_HOST, SMTP_PORT: process.env.SMTP_PORT, MAIL_FROM: process.env.MAIL_FROM, APP_BASE_URL: process.env.APP_BASE_URL });
  }
}
checkSmtpEnv();


app.get('/api/smtp-health', async (req, res) => {
  try {
    await mailer.verify(); // 嘗試連線/握手（含 STARTTLS）
    return res.json({ ok: true, host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587) });
  } catch (e) {
    console.error('❌ SMTP 驗證失敗:', e);
    return res.status(502).json({
      ok: false,
      error: 'SMTP_VERIFY_FAILED',
      details: e.message,
      host: process.env.SMTP_HOST || 'localhost',
      port: Number(process.env.SMTP_PORT || 587),
    });
  }
});

// ===== 動態 SMTP 工具（新增） =====
function resolveSmtpFromReqOrEnv(req) {
  const b = (req.body && req.body.smtp) ? req.body.smtp : {};
  const host  = (b.host || process.env.SMTP_HOST || '').trim();
  const port  = Number(b.port || process.env.SMTP_PORT || 587);
  const user  = (b.user || process.env.SMTP_USER || '').trim();
  const pass  = (b.pass || process.env.SMTP_PASS || '').trim();
  const from  = (b.from || process.env.MAIL_FROM || '').trim();
  const secure = (typeof b.secure === 'boolean') ? b.secure : (port === 465); // 465=SSL，其它走 STARTTLS

  if (!host || !user || !pass || !from) {
    const miss = [];
    if (!host) miss.push('host');
    if (!user) miss.push('user');
    if (!pass) miss.push('pass');
    if (!from) miss.push('from');
    const e = new Error(`SMTP_NOT_CONFIGURED: missing ${miss.join(', ')}`);
    e.code = 'SMTP_NOT_CONFIGURED';
    throw e;
  }
  return { host, port, user, pass, from, secure };
}

function buildTransport({ host, port, user, pass, secure }) {
  return nodemailer.createTransport({
    host, port, secure: !!secure,
    auth: { user, pass },
  });
}



async function testDatabaseConnection() {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW(), version()');
    console.log('✅ DB 連線成功，時間：', result.rows[0].now);
    client.release();
  } catch (err) {
    console.error('❌ DB 連線失敗:', err.message);
  }
}

// users 表：補 role / created_at / preferred_language + 索引
async function updateUserTableWithRoles() {
  try {
    const roleCol = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='role'`);
    if (roleCol.rows.length === 0) {
      await pool.query(`ALTER TABLE users ADD COLUMN role VARCHAR(20) DEFAULT 'student' CHECK (role IN ('teacher','student'))`);
      console.log('✅ users.role 加上');
    }

    const createdCol = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='created_at'`);
    if (createdCol.rows.length === 0) {
      await pool.query(`ALTER TABLE users ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
      console.log('✅ users.created_at 加上');
    }

    const prefLangCol = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='preferred_language'`);
    if (prefLangCol.rows.length === 0) {
      await pool.query(`ALTER TABLE users ADD COLUMN preferred_language VARCHAR(10) DEFAULT 'zh-Hant'`);
      console.log('✅ users.preferred_language 加上');
    }

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)`);
    console.log('✅ users 表結構檢查完成');
  } catch (error) {
    console.error('❌ 更新 users 表結構失敗:', error);
  }
}
// 在 updateUserTableWithRoles() 函數後面添加這個新函數
async function fixEmailVerifiedColumn() {
  try {
    console.log('🔧 開始檢查和修復 email_verified 欄位...');
    
    // 1. 確保欄位存在
    const columnCheck = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns 
      WHERE table_name='users' AND column_name='email_verified'
    `);
    
    if (columnCheck.rows.length === 0) {
      console.log('⚠️  email_verified 欄位不存在，正在創建...');
      await pool.query(`
        ALTER TABLE users 
        ADD COLUMN email_verified BOOLEAN DEFAULT FALSE NOT NULL
      `);
      console.log('✅ email_verified 欄位已創建');
    } else {
      console.log('✅ email_verified 欄位已存在:', columnCheck.rows[0]);
    }
    
    // 2. 修復所有 NULL 值
    const nullCount = await pool.query(`
      SELECT COUNT(*) as count FROM users WHERE email_verified IS NULL
    `);
    
    if (parseInt(nullCount.rows[0].count) > 0) {
      console.log(`⚠️  發現 ${nullCount.rows[0].count} 個用戶的 email_verified 為 NULL`);
      await pool.query(`
        UPDATE users 
        SET email_verified = FALSE 
        WHERE email_verified IS NULL
      `);
      console.log('✅ 已將所有 NULL 值設為 FALSE');
    }
    
    // 3. 檢查欄位約束
    await pool.query(`
      ALTER TABLE users 
      ALTER COLUMN email_verified SET NOT NULL,
      ALTER COLUMN email_verified SET DEFAULT FALSE
    `);
    console.log('✅ email_verified 欄位約束已設置');
    
    // 4. 顯示統計資訊
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE email_verified = TRUE) as verified,
        COUNT(*) FILTER (WHERE email_verified = FALSE) as unverified
      FROM users
    `);
    
    console.log('📊 用戶驗證統計:', {
      總用戶數: stats.rows[0].total,
      已驗證: stats.rows[0].verified,
      未驗證: stats.rows[0].unverified
    });
    
  } catch (error) {
    console.error('❌ 修復 email_verified 欄位失敗:', error);
    throw error;
  }
}
// 在 fixEmailVerifiedColumn 函數後面添加
async function auditAndFixExistingUsers() {
  try {
    console.log('🔍 審計現有用戶的驗證狀態...');
    
    // 查找所有 email_verified 但沒有 token 的可疑用戶
    const suspicious = await pool.query(`
      SELECT id, username, email, email_verified, 
             email_verification_token IS NOT NULL as has_token,
             created_at
      FROM users
      WHERE email_verified = TRUE 
        AND email_verification_token IS NULL
        AND created_at > NOW() - INTERVAL '7 days'
      ORDER BY created_at DESC
    `);
    
    if (suspicious.rows.length > 0) {
      console.log('⚠️  發現可疑用戶（已驗證但無 token）:', suspicious.rows.length);
      suspicious.rows.forEach(u => {
        console.log(`   - ${u.username} (${u.email}) 創建於 ${u.created_at}`);
      });
      
      // 選項 1：重置這些用戶（謹慎使用）
      // await pool.query(`
      //   UPDATE users 
      //   SET email_verified = FALSE
      //   WHERE id = ANY($1)
      // `, [suspicious.rows.map(u => u.id)]);
      // console.log('✅ 已重置可疑用戶的驗證狀態');
    } else {
      console.log('✅ 沒有發現可疑的用戶記錄');
    }
    
    // 統計報告
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE email_verified = TRUE) as verified,
        COUNT(*) FILTER (WHERE email_verified = FALSE) as unverified,
        COUNT(*) FILTER (WHERE email_verified = TRUE AND email_verification_token IS NOT NULL) as verified_with_token,
        COUNT(*) FILTER (WHERE email_verified = FALSE AND email_verification_token IS NULL) as unverified_no_token
      FROM users
    `);
    
    console.log('📊 用戶驗證完整統計:', stats.rows[0]);
    
  } catch (error) {
    console.error('❌ 審計用戶失敗:', error);
  }
}

// 更新啟動初始化
(async () => {
  try {
    console.log('🚀 開始初始化資料庫...');
    
    await testDatabaseConnection();
    await updateUserTableWithRoles();
    await ensureVerificationFields();
    await fixEmailVerifiedColumn();
    await auditAndFixExistingUsers();  // 新增
    await createFoldersTable();
    await createParticipantsTable();
    await createShareLinksTable();
    
    console.log('✅ 資料庫初始化完成');
  } catch (error) {
    console.error('❌ 資料庫初始化失敗:', error);
    process.exit(1);
  }
})();
// 確保 email_verification_token 和 expires 欄位也存在
async function ensureVerificationFields() {
  try {
    console.log('🔧 檢查驗證相關欄位...');
    
    // 檢查 email_verification_token
    const tokenCol = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name='users' AND column_name='email_verification_token'
    `);
    
    if (tokenCol.rows.length === 0) {
      console.log('⚠️  創建 email_verification_token 欄位...');
      await pool.query(`
        ALTER TABLE users 
        ADD COLUMN email_verification_token VARCHAR(255) NULL
      `);
      console.log('✅ email_verification_token 欄位已創建');
    }
    
    // 檢查 email_verification_expires
    const expiresCol = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name='users' AND column_name='email_verification_expires'
    `);
    
    if (expiresCol.rows.length === 0) {
      console.log('⚠️  創建 email_verification_expires 欄位...');
      await pool.query(`
        ALTER TABLE users 
        ADD COLUMN email_verification_expires TIMESTAMP NULL
      `);
      console.log('✅ email_verification_expires 欄位已創建');
    }
    
    console.log('✅ 所有驗證欄位檢查完成');
    
  } catch (error) {
    console.error('❌ 檢查驗證欄位失敗:', error);
    throw error;
  }
}
// folders 表 + meetings.folder_id 欄位
async function createFoldersTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS folders (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const col = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='meetings' AND column_name='folder_id'`);
    if (col.rows.length === 0) {
      await pool.query(`ALTER TABLE meetings ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL`);
      console.log('✅ meetings.folder_id 加上');
    }

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_folders_user_id ON folders(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_meetings_folder_id ON meetings(folder_id)`);

    console.log('✅ folders / meetings.folder_id 結構 OK');
  } catch (error) {
    console.error('❌ 建立 folders 表失敗:', error);
  }
}

// meeting_participants 表（唯一鍵 meeting_id+user_id）
async function createParticipantsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS meeting_participants (
        id SERIAL PRIMARY KEY,
        meeting_id INTEGER REFERENCES meetings(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(50) DEFAULT 'participant',
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name='meeting_participants' AND constraint_type='UNIQUE'
            AND constraint_name='meeting_participants_meeting_id_user_id_key'
        ) THEN
          ALTER TABLE meeting_participants
          ADD CONSTRAINT meeting_participants_meeting_id_user_id_key UNIQUE (meeting_id, user_id);
        END IF;
      END$$;
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mp_meeting_id ON meeting_participants(meeting_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mp_user_id ON meeting_participants(user_id)`);

    console.log('✅ meeting_participants 表結構 OK');
  } catch (error) {
    console.error('❌ 建立 meeting_participants 表失敗:', error);
  }
}

// 分享連結表（預備功能）
async function createShareLinksTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS meeting_share_links (
        id SERIAL PRIMARY KEY,
        meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        code VARCHAR(64),                       -- 舊欄位，保留相容
        share_token VARCHAR(64) UNIQUE,         -- 新欄位（API 使用）
        permission VARCHAR(32) DEFAULT 'viewer',
        expires_at TIMESTAMP NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // 欄位存在性檢查
    const cols = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name='meeting_share_links'
    `);
    const hasShareToken = cols.rows.some(r => r.column_name === 'share_token');
    const hasPermission = cols.rows.some(r => r.column_name === 'permission');
    const hasCode = cols.rows.some(r => r.column_name === 'code');

    if (!hasShareToken) {
      await pool.query(`ALTER TABLE meeting_share_links ADD COLUMN share_token VARCHAR(64) UNIQUE`);
    }
    if (!hasPermission) {
      await pool.query(`ALTER TABLE meeting_share_links ADD COLUMN permission VARCHAR(32) DEFAULT 'viewer'`);
    }
    // 若舊資料只有 code，回填到 share_token
    if (hasCode) {
      await pool.query(`UPDATE meeting_share_links SET share_token = code WHERE share_token IS NULL AND code IS NOT NULL`);
    }
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_share_token ON meeting_share_links(share_token)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_share_is_active ON meeting_share_links(is_active)`);

    console.log('✅ meeting_share_links 表結構 OK');
  } catch (err) {
    console.error('❌ 建立/修補 meeting_share_links 表失敗:', err);
  }
}


// 啟動時初始化
(async () => {
  try {
    console.log('🚀 開始初始化資料庫...');
    await testDatabaseConnection();
    await updateUserTableWithRoles();
    await ensureVerificationFields(); 
    await fixEmailVerifiedColumn(); 
    await createFoldersTable();
    await createParticipantsTable();
    await createShareLinksTable();
    console.log('✅ 資料庫初始化完成');
  } catch (error) {
    console.error('❌ 資料庫初始化失敗:', error);
    process.exit(1);
  }
})();

// -------------------------------------------------------------
// Socket.IO：用 meetingId 當房間，廣播 meeting-ended
// -------------------------------------------------------------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

io.on('connection', (socket) => {
  console.log(`🔌 新用戶連接: ${socket.id}`);
  
  // 用戶加入會議房間
  socket.on('join_meeting', async (data) => {
    const { meetingId, userId, username, userRole } = data;
    console.log(`👥 用戶加入會議房間:`, { meetingId, userId, username, userRole, socketId: socket.id });

        // 加在 join_meeting 成功之後
    try {
      // 撈最近 50 筆歷史轉錄（可依需求調整排序與筆數）
      const rows = (await pool.query(
        `SELECT original_text, original_language, speaker, created_at
        FROM messages
        WHERE meeting_id = $1
        ORDER BY id DESC
        LIMIT 50`,
        [meetingId]
      )).rows.reverse(); // reverse 讓舊 -> 新

      // 只傳給剛加入的這個使用者
      socket.emit('load_existing_transcripts', rows.map(r => ({
        originalText: r.original_text,
        originalLanguage: r.original_language || 'unknown',
        speaker: r.speaker || '發言者',
        ts: r.created_at,
      })));
    } catch (e) {
      console.warn('載入歷史轉錄失敗（不影響主流程）:', e);
    }

    
    try {
      // 驗證會議是否存在
      const meetingCheck = await pool.query('SELECT id, creator_id FROM meetings WHERE id = $1', [meetingId]);
      if (meetingCheck.rows.length === 0) {
        socket.emit('error', { message: '會議不存在' });
        return;
      }
      
      // 加入 Socket.IO 房間
      socket.join(`meeting:${meetingId}`);
      
      // 記錄用戶連接信息
      socketUsers.set(socket.id, { userId, meetingId, username, userRole });
      userSockets.set(userId, socket.id);
      
      // 更新在線用戶列表
      if (!onlineUsers.has(meetingId)) {
        onlineUsers.set(meetingId, new Set());
      }
      onlineUsers.get(meetingId).add(userId);
      
      // 獲取更新後的參與者列表
      const participantsList = await getUpdatedParticipantsList(meetingId);
      
      // 向房間內所有用戶廣播更新
      io.to(`meeting:${meetingId}`).emit('participants_updated', {
        participants: participantsList,
        onlineUsers: Array.from(onlineUsers.get(meetingId) || [])
      });
      
      // 向房間內其他用戶廣播用戶加入事件
      socket.to(`meeting:${meetingId}`).emit('user_joined', {
        userId,
        username,
        userRole
      });
      
      console.log(`✅ 用戶 ${username} 成功加入會議 ${meetingId}`);
      
    } catch (error) {
      console.error('❌ 用戶加入會議失敗:', error);
      socket.emit('error', { message: '加入會議失敗' });
    }
  });

  // 即時轉錄：接收老師端/發言端送來的字幕，轉發給同房間所有人
  socket.on('new_transcript', async (data) => {
    try {
      const { meetingId, originalText, originalLanguage, speaker } = data || {};
      if (!meetingId || !originalText) return;

      // 直接轉發給此會議房間
      io.to(`meeting:${meetingId}`).emit('receive_transcript', {
        originalText,
        originalLanguage: originalLanguage || 'unknown',
        speaker: speaker || '發言者',
        ts: new Date().toISOString(),
      });
    } catch (err) {
      console.error('❌ 轉發即時轉錄失敗:', err);
    }
  });

  
  // 用戶離開會議
  socket.on('leave_meeting', () => {
    handleUserDisconnect(socket);
  });
  
  // 心跳檢測
  socket.on('heartbeat', (data) => {
    const { meetingId, userId } = data;
    if (meetingId && userId) {
      if (!onlineUsers.has(meetingId)) {
        onlineUsers.set(meetingId, new Set());
      }
      onlineUsers.get(meetingId).add(userId);
    }
  });
  
  // 用戶手動離開
  socket.on('user_leaving', (data) => {
    const { meetingId, userId } = data;
    console.log(`👋 用戶主動離開:`, { meetingId, userId });
    handleUserDisconnect(socket);
  });
  
  // 連接斷開
  socket.on('disconnect', () => {
    console.log(`🔌 用戶斷開連接: ${socket.id}`);
    handleUserDisconnect(socket);
  });
});

async function handleUserDisconnect(socket) {
  const userInfo = socketUsers.get(socket.id);
  if (!userInfo) return;
  
  const { userId, meetingId, username } = userInfo;
  
  try {
    // 清理連接記錄
    socketUsers.delete(socket.id);
    userSockets.delete(userId);
    
    // 從在線列表中移除
    if (onlineUsers.has(meetingId)) {
      onlineUsers.get(meetingId).delete(userId);
      
      // 如果房間沒有人了，清理房間
      if (onlineUsers.get(meetingId).size === 0) {
        onlineUsers.delete(meetingId);
      }
    }
    
    // 獲取更新後的參與者列表
    const participantsList = await getUpdatedParticipantsList(meetingId);
    
    // 向房間內所有用戶廣播更新
    io.to(`meeting:${meetingId}`).emit('participants_updated', {
      participants: participantsList,
      onlineUsers: Array.from(onlineUsers.get(meetingId) || [])
    });
    
    // 向房間內其他用戶廣播用戶離開事件
    socket.to(`meeting:${meetingId}`).emit('user_left', {
      userId,
      username
    });
    
    console.log(`✅ 用戶 ${username} 已從會議 ${meetingId} 中移除`);
    
  } catch (error) {
    console.error('❌ 處理用戶斷開連接失敗:', error);
  }
}

async function getUpdatedParticipantsList(meetingId) {
  try {
    // 獲取會議信息
    const meetingQuery = await pool.query(
      'SELECT creator_id FROM meetings WHERE id = $1', 
      [meetingId]
    );
    
    if (meetingQuery.rows.length === 0) {
      return [];
    }
    
    const meeting = meetingQuery.rows[0];
    
    // 獲取主持人信息
    const hostQuery = await pool.query(
      'SELECT id, username, full_name, role FROM users WHERE id = $1',
      [meeting.creator_id]
    );
    
    // 獲取參與者信息（排除主持人以避免重複）
    const participantsQuery = await pool.query(
      `SELECT mp.role, mp.joined_at, u.id, u.username, u.full_name, u.role as user_role
       FROM meeting_participants mp 
       JOIN users u ON u.id = mp.user_id
       WHERE mp.meeting_id = $1 AND u.id != $2
       ORDER BY mp.joined_at`,
      [meetingId, meeting.creator_id]
    );
    
    const participants = [];
    
    // 添加主持人（總是第一個）
    if (hostQuery.rows.length > 0) {
      const host = hostQuery.rows[0];
      participants.push({
        role: 'host',
        joined_at: null, // 主持人沒有具體加入時間
        id: host.id,
        username: host.username,
        full_name: host.full_name,
        user_role: host.role
      });
    }
    
    // 添加其他參與者
    participants.push(...participantsQuery.rows);
    
    return participants;
    
  } catch (error) {
    console.error('❌ 獲取參與者列表失敗:', error);
    return [];
  }
}


// -------------------------------------------------------------
// 中介軟體：驗證
// -------------------------------------------------------------
function requireAuth(req, res, next) {
  const headerToken = req.headers.authorization?.split(' ')[1];
  const cookieToken = req.cookies?.authToken;
  const token = headerToken || cookieToken;
  if (!token) return res.status(401).json({ error: '未授權 - 請先登入' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { userId, username, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: '無效的授權令牌' });
  }
}


// 輕量登入狀態檢查：支援 header 或 cookie
app.get('/api/session', (req, res) => {
  const headerToken = req.headers.authorization?.split(' ')[1];
  const cookieToken = req.cookies?.authToken;
  const token = headerToken || cookieToken;
  if (!token) return res.status(401).json({ ok: false, error: 'NO_TOKEN' });
  try {
    const payload = jwt.verify(token, JWT_SECRET); // 內含 exp、iat
    return res.json({
      ok: true,
      user: { id: payload.userId, username: payload.username, role: payload.role },
      exp: payload.exp
    });
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }
});



function requireTeacher(req, res, next) {
  const headerToken = req.headers.authorization?.split(' ')[1];
  const cookieToken = req.cookies?.authToken;
  const token = headerToken || cookieToken;

  if (!token) return res.status(401).json({ error: '未授權 - 請先登入' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'teacher') {
      return res.status(403).json({ error: '權限不足 - 需要老師權限' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: '無效的授權令牌' });
  }
}

// -------------------------------------------------------------
// 語音金鑰（原樣保留）
// -------------------------------------------------------------
app.get('/api/speech-key', (req, res) => {
  if (!process.env.AZURE_SPEECH_KEY || !process.env.AZURE_SPEECH_REGION) {
    return res.status(500).json({ error: 'Azure 語音服務密鑰或區域未設置' });
  }
  res.json({ key: process.env.AZURE_SPEECH_KEY, region: process.env.AZURE_SPEECH_REGION });
});

// -------------------------------------------------------------
// 使用者：註冊 / 登入（支援角色 + 語言偏好）
// -------------------------------------------------------------
app.post('/api/signup', async (req, res) => {
  const { username, email, password, full_name, role } = req.body;

  console.log('📝 收到註冊請求:', { username, email, full_name, role });

  // 基本驗證
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email and password are required' });
  }
  
  if (!role || !['teacher','student'].includes(role)) {
    return res.status(400).json({ error: 'Valid role (teacher or student) is required' });
  }

  // Email 格式驗證
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ 
      error: 'Invalid email format',
      hint: '請輸入有效的電子信箱格式，例如：user@example.com' 
    });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long' });
  }

  try {
    // 檢查用戶是否已存在
    const exists = await pool.query(
      'SELECT username, email FROM users WHERE username=$1 OR email=$2',
      [username, email]
    );
    
    if (exists.rows.length > 0) {
      const u = exists.rows[0];
      if (u.username === username) {
        return res.status(400).json({ error: 'Username already exists' });
      }
      if (u.email === email) {
        return res.status(400).json({ error: 'Email already exists' });
      }
    }

    // 加密密碼
    const hashed = await bcrypt.hash(password, 12);

    // 生成驗證 token
    const verifToken = crypto.randomBytes(32).toString('hex');
    const verifExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24小時

    console.log('🔑 生成驗證 token:', {
      token_length: verifToken.length,
      token_preview: verifToken.substring(0, 10) + '...',
      expires: verifExpires
    });

    // 🔥 關鍵：插入新用戶，明確設置 email_verified = FALSE
    const inserted = await pool.query(
      `INSERT INTO users
        (username, email, password, full_name, role, 
         email_verified, 
         email_verification_token, 
         email_verification_expires,
         created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP)
       RETURNING id, username, email, full_name, role, created_at, 
                 preferred_language, email_verified,
                 email_verification_token`,
      [username, email, hashed, full_name || username, role, 
       false,  // 🔥 明確設置為 false
       verifToken, 
       verifExpires]
    );
    
    const user = inserted.rows[0];

    console.log('✅ 用戶已創建:', {
      id: user.id,
      username: user.username,
      email: user.email,
      email_verified: user.email_verified,
      has_token: !!user.email_verification_token
    });

    // 驗證插入結果
    if (user.email_verified !== false) {
      console.error('❌ 警告：email_verified 不是 false！', user.email_verified);
    }

    // 根據 email 選擇合適的傳輸器
    const { transporter, from } = getTransporterByEmail(email);
    const domain = email.split('@')[1];
    
    console.log(`📧 準備發送驗證信到: ${email} (使用 ${domain.includes('outlook') ? 'Outlook' : 'Gmail'} SMTP)`);

    // 構建驗證 URL
    const verifyUrl = `${APP_BASE_URL}/api/verify-email?token=${verifToken}`;

    console.log('🔗 驗證 URL:', verifyUrl);

    try {
      // 先驗證 SMTP 連接
      await transporter.verify();
      console.log(`✅ SMTP 連接驗證成功`);

      // 發送驗證郵件
      await transporter.sendMail({
        from: from,
        to: email,
        subject: '【TransClass】請驗證您的電子信箱',
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>
          <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
            <div style="max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
              
              <!-- Header -->
              <div style="background-color: #0a2463; color: white; padding: 30px 20px; text-align: center;">
                <h1 style="margin: 0; font-size: 28px;">TransClass</h1>
                <p style="margin: 10px 0 0 0; font-size: 14px; opacity: 0.9;">即時翻譯課堂系統</p>
              </div>
              
              <!-- Body -->
              <div style="padding: 40px 30px;">
                <h2 style="color: #0a2463; margin-top: 0; font-size: 24px;">歡迎加入 TransClass！</h2>
                
                <p style="color: #333; line-height: 1.6; font-size: 16px;">
                  嗨 <strong>${full_name || username}</strong>，
                </p>
                
                <p style="color: #333; line-height: 1.6; font-size: 16px;">
                  感謝您註冊我們的平台。請點擊下方按鈕完成帳號驗證（24 小時內有效）：
                </p>
                
                <!-- CTA Button -->
                <div style="text-align: center; margin: 35px 0;">
                  <a href="${verifyUrl}" 
                     style="display: inline-block; background-color: #0a2463; color: white; 
                            padding: 14px 40px; text-decoration: none; border-radius: 5px; 
                            font-size: 16px; font-weight: bold; box-shadow: 0 2px 4px rgba(0,0,0,0.2);">
                    驗證電子信箱
                  </a>
                </div>
                
                <!-- Alternative Link -->
                <div style="background-color: #f8f9fa; padding: 20px; border-radius: 5px; margin-top: 30px;">
                  <p style="color: #666; font-size: 14px; margin: 0 0 10px 0;">
                    如果按鈕無法點擊，請複製以下連結到瀏覽器：
                  </p>
                  <p style="margin: 0;">
                    <a href="${verifyUrl}" 
                       style="color: #0a2463; word-break: break-all; font-size: 13px;">
                      ${verifyUrl}
                    </a>
                  </p>
                </div>
                
                <!-- Account Info -->
                <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
                  <p style="color: #666; font-size: 14px; margin: 5px 0;">
                    <strong>帳號資訊：</strong>
                  </p>
                  <p style="color: #666; font-size: 14px; margin: 5px 0;">
                    • 使用者名稱：${username}
                  </p>
                  <p style="color: #666; font-size: 14px; margin: 5px 0;">
                    • 角色：${role === 'teacher' ? '教師' : '學生'}
                  </p>
                  <p style="color: #666; font-size: 14px; margin: 5px 0;">
                    • 電子信箱：${email}
                  </p>
                </div>
              </div>
              
              <!-- Footer -->
              <div style="background-color: #f8f9fa; padding: 20px 30px; text-align: center; border-top: 1px solid #e0e0e0;">
                <p style="color: #999; font-size: 12px; margin: 0;">
                  此信件由系統自動發送，請勿直接回覆。<br>
                  如有任何問題，請聯絡系統管理員。
                </p>
                <p style="color: #999; font-size: 12px; margin: 10px 0 0 0;">
                  © 2025 TransClass. All rights reserved.
                </p>
              </div>
              
            </div>
          </body>
          </html>
        `,
        text: `
歡迎加入 TransClass！

嗨 ${full_name || username}，

感謝您註冊我們的平台。請點擊以下連結完成帳號驗證（24 小時內有效）：

${verifyUrl}

帳號資訊：
- 使用者名稱：${username}
- 角色：${role === 'teacher' ? '教師' : '學生'}
- 電子信箱：${email}

此信件由系統自動發送，請勿直接回覆。
如有任何問題，請聯絡系統管理員。

© 2025 TransClass
        `
      });
      
      console.log(`✅ 驗證信已成功發送到: ${email}`);
      
      return res.status(201).json({
        success: true,
        message: '註冊成功！驗證信已發送，請前往信箱完成驗證後再登入。',
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role,
          email_verified: user.email_verified,  // 應該是 false
        },
        hint: '請檢查您的收件匣和垃圾郵件資料夾'
      });
      
    } catch (mailErr) {
      console.error('❌ 寄送驗證信失敗:', mailErr);
      
      // 即使郵件發送失敗，帳號也已建立
      return res.status(201).json({
        success: true,
        warning: 'MAIL_SEND_FAILED',
        message: '帳號已建立，但驗證信發送失敗。請稍後使用「重新發送驗證信」功能。',
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role,
          email_verified: user.email_verified,
        },
        details: mailErr.message,
        hint: '可能原因：SMTP 設定錯誤、網路問題、或收件伺服器暫時無法連接'
      });
    }
    
  } catch (err) {
    console.error('❌ 註冊錯誤:', err);
    return res.status(500).json({ 
      error: 'Server error', 
      details: err.message 
    });
  }
});
// 測試註冊後的狀態
app.get('/api/debug/user-by-email/:email', async (req, res) => {
  try {
    const { email } = req.params;
    
    const result = await pool.query(
      `SELECT id, username, email, full_name, role, 
              email_verified, 
              email_verification_token,
              LENGTH(email_verification_token) as token_length,
              email_verification_expires,
              created_at, last_login
       FROM users 
       WHERE email = $1`,
      [email]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '用戶不存在' });
    }
    
    const user = result.rows[0];
    
    return res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        created_at: user.created_at,
        last_login: user.last_login
      },
      verification_status: {
        email_verified: user.email_verified,
        email_verified_type: typeof user.email_verified,
        has_token: !!user.email_verification_token,
        token_preview: user.email_verification_token ? 
          user.email_verification_token.substring(0, 10) + '...' : null,
        token_length: user.token_length,
        expires_at: user.email_verification_expires,
        is_expired: user.email_verification_expires ? 
          new Date() > new Date(user.email_verification_expires) : null,
        time_until_expiry: user.email_verification_expires ?
          Math.round((new Date(user.email_verification_expires) - new Date()) / 1000 / 60) + ' 分鐘' : null
      },
      checks: {
        should_allow_login: user.email_verified === true,
        can_verify: user.email_verified === false && !!user.email_verification_token,
        needs_resend: user.email_verified === false && !user.email_verification_token
      }
    });
    
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
app.get('/api/verify-email', async (req, res) => {
  const token = req.query.token?.trim();

  if (!token) {
    return res.status(400).send(
      generateErrorPage("驗證失敗", "驗證連結無效，請重新註冊或聯繫系統管理員。")
    );
  }

  try {
    const result = await pool.query(
      `SELECT id, email, email_verified, email_verification_expires
       FROM users WHERE email_verification_token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).send(
        generateErrorPage("驗證失敗", "驗證連結不存在或已使用。")
      );
    }

    const user = result.rows[0];

    // Token 過期
    if (user.email_verification_expires && new Date() > new Date(user.email_verification_expires)) {
      return res.status(410).send(
        generateErrorPage("驗證連結已過期", "請重新註冊帳號或申請新的驗證信。")
      );
    }

    // 已驗證過
    if (user.email_verified === true) {
      return res.send(
        generateSuccessPage(
          "信箱已驗證過",
          "此帳號已完成信箱驗證。",
          `<div class="email">${user.email}</div>`,
          true
        )
      );
    }

    // 更新驗證狀態
    await pool.query(
      `UPDATE users 
         SET email_verified = TRUE, 
             email_verification_token = NULL, 
             email_verification_expires = NULL
       WHERE id = $1`,
      [user.id]
    );

    console.log(`✅ 用戶 ${user.email} 驗證成功`);

    return res.send(
      generateSuccessPage(
        "信箱驗證成功",
        "您的帳號已啟用，可以登入使用系統。",
        `<div class="email">${user.email}</div>`,
        true // 自動 3 秒跳轉登入頁
      )
    );

  } catch (err) {
    console.error("❌ 驗證過程發生錯誤:", err);
    return res.status(500).send(
      generateErrorPage("系統錯誤", "伺服器在處理驗證時發生錯誤，請稍後再試。")
    );
  }
});

// 輔助函數：生成錯誤頁面
function generateErrorPage(title, message) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>${title}</title>
      <style>
        body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
        .container { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
        .error { color: #d32f2f; font-size: 48px; margin-bottom: 1rem; }
        h1 { color: #333; margin: 0 0 1rem 0; }
        p { color: #666; line-height: 1.6; }
        .btn { display: inline-block; margin-top: 1.5rem; padding: 0.75rem 2rem; background: #0a2463; color: white; text-decoration: none; border-radius: 4px; }
        .btn:hover { background: #2c7db3; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="error">✗</div>
        <h1>${title}</h1>
        <p>${message}</p>
        <a href="/auth.html" class="btn">返回登入頁</a>
      </div>
    </body>
    </html>
  `;
}

// 輔助函數：生成成功頁面
function generateSuccessPage(title, subtitle, content, autoRedirect = false) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>${title}</title>
      ${autoRedirect ? '<meta http-equiv="refresh" content="3;url=/auth.html">' : ''}
      <style>
        body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
        .container { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
        .success { color: #4caf50; font-size: 48px; margin-bottom: 1rem; animation: scaleIn 0.5s ease-out; }
        @keyframes scaleIn { from { transform: scale(0); } to { transform: scale(1); } }
        h1 { color: #333; margin: 0 0 1rem 0; }
        p { color: #666; line-height: 1.6; }
        .email { background: #f5f5f5; padding: 0.5rem 1rem; border-radius: 4px; margin: 1rem 0; font-family: monospace; word-break: break-all; }
        .btn { display: inline-block; margin-top: 1.5rem; padding: 0.75rem 2rem; background: #0a2463; color: white; text-decoration: none; border-radius: 4px; }
        .btn:hover { background: #2c7db3; }
        .redirect-note { font-size: 0.9rem; color: #999; margin-top: 1rem; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="success">✓</div>
        <h1>${title}</h1>
        <p>${subtitle}</p>
        ${content}
        <a href="/auth.html" class="btn">立即登入</a>
        ${autoRedirect ? '<p class="redirect-note">3 秒後自動跳轉至登入頁...</p>' : ''}
      </div>
    </body>
    </html>
  `;
}
app.post('/api/login', async (req, res) => {
  const { full_name, password } = req.body;
  
  console.log('🔐 [Zeabur] 收到登入請求:', { 
    full_name, 
    timestamp: new Date().toISOString(),
    origin: req.headers.origin 
  });
  
  if (!full_name || !password) {
    return res.status(400).json({ error: 'Student ID and password are required' });
  }
  
  try {
    const found = await pool.query(
      `SELECT id, username, email, password, full_name, role, preferred_language, 
              created_at, last_login, email_verified 
       FROM users 
       WHERE full_name=$1`, 
      [full_name]
    );

    if (found.rows.length === 0) {
      console.log('❌ [Zeabur] 找不到用戶:', full_name);
      return res.status(401).json({ error: 'Invalid student ID' });
    }

    const user = found.rows[0];
    
    console.log('👤 [Zeabur] 找到用戶:', {
      id: user.id,
      username: user.username,
      email: user.email,
      email_verified: user.email_verified,
      email_verified_type: typeof user.email_verified,
      email_verified_value: JSON.stringify(user.email_verified)
    });
    
    // 驗證密碼
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      console.log('❌ [Zeabur] 密碼錯誤');
      return res.status(401).json({ error: 'Invalid password' });
    }

    // ⭐⭐⭐ 非常嚴格的驗證檢查 ⭐⭐⭐
    // 明確檢查 TRUE，任何其他值（false, null, undefined, 0, ''）都拒絕
    const isVerified = user.email_verified === true;
    
    console.log('🔍 [Zeabur] 驗證狀態詳細檢查:', {
      raw_value: user.email_verified,
      is_true: user.email_verified === true,
      is_false: user.email_verified === false,
      is_null: user.email_verified === null,
      is_undefined: user.email_verified === undefined,
      final_decision: isVerified ? '允許登入' : '拒絕登入'
    });
    
    if (!isVerified) {
      console.log('❌ [Zeabur] 登入被拒：Email 未驗證');
      console.log('   用戶:', user.email);
      console.log('   email_verified 值:', user.email_verified);
      
      return res.status(403).json({
        error: 'EMAIL_NOT_VERIFIED',
        message: 'Email 尚未驗證，請至信箱點擊驗證連結。',
        debug: {
          email_verified_value: user.email_verified,
          email_verified_type: typeof user.email_verified
        },
        user: {
          email: user.email,
          username: user.username,
          full_name: user.full_name
        }
      });
    }

    // ✅ Email 已驗證，允許登入
    console.log('✅ [Zeabur] Email 已驗證，允許登入');
    
    await pool.query(
      'UPDATE users SET last_login=CURRENT_TIMESTAMP WHERE id=$1', 
      [user.id]
    );

    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.cookie('authToken', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production', // Zeabur 上自動使用 HTTPS
      maxAge: 24 * 60 * 60 * 1000
    });

    console.log('✅ [Zeabur] 登入成功:', user.username);
    
    return res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        preferredLanguage: user.preferred_language || 'zh-Hant',
        created_at: user.created_at,
        last_login: new Date(),
      }
    });
    
  } catch (err) {
    console.error('❌ [Zeabur] 登入錯誤:', err);
    return res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// 🔧 診斷 API - 檢查用戶驗證狀態（部署後可以刪除）
app.get('/api/debug/user/:fullname', async (req, res) => {
  try {
    const { fullname } = req.params;
    
    const result = await pool.query(
      `SELECT id, username, email, full_name, role, email_verified, 
              email_verification_token, email_verification_expires, created_at
       FROM users 
       WHERE full_name = $1`,
      [fullname]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '用戶不存在' });
    }
    
    const user = result.rows[0];
    
    return res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        created_at: user.created_at
      },
      verification: {
        email_verified: user.email_verified,
        email_verified_type: typeof user.email_verified,
        email_verified_raw: JSON.stringify(user.email_verified),
        has_token: !!user.email_verification_token,
        token_length: user.email_verification_token?.length || 0,
        expires_at: user.email_verification_expires,
        is_expired: user.email_verification_expires ? 
          new Date() > new Date(user.email_verification_expires) : null
      },
      checks: {
        is_true: user.email_verified === true,
        is_false: user.email_verified === false,
        is_null: user.email_verified === null,
        is_undefined: user.email_verified === undefined,
        should_allow_login: user.email_verified === true
      }
    });
    
  } catch (err) {
    console.error('診斷 API 錯誤:', err);
    return res.status(500).json({ error: err.message });
  }
});
app.post('/api/resend-verification', async (req, res) => {
  const { email, full_name } = req.body || {};
  
  if (!email && !full_name) {
    return res.status(400).json({ 
      error: 'EMAIL_OR_FULL_NAME_REQUIRED',
      hint: '請提供 email 或 full_name 其中之一' 
    });
  }

  try {
    // 查詢使用者
    let q;
    if (email) {
      q = await pool.query(
        `SELECT id, username, full_name, email, email_verified, role 
         FROM users WHERE email=$1`,
        [email]
      );
    } else {
      q = await pool.query(
        `SELECT id, username, full_name, email, email_verified, role 
         FROM users WHERE full_name=$1`,
        [full_name]
      );
    }

    if (q.rows.length === 0) {
      return res.status(404).json({ error: 'USER_NOT_FOUND' });
    }

    const u = q.rows[0];
    
    if (u.email_verified) {
      return res.status(200).json({ 
        message: '此帳號已驗證，請直接登入。',
        verified: true 
      });
    }

    // 生成新的驗證 token
    const verifToken = crypto.randomBytes(32).toString('hex');
    const verifExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.query(
      `UPDATE users
       SET email_verification_token=$1, email_verification_expires=$2
       WHERE id=$3`,
      [verifToken, verifExpires, u.id]
    );

    // 根據信箱選擇傳輸器
    const { transporter, from } = getTransporterByEmail(u.email);
    const verifyUrl = `${APP_BASE_URL}/api/verify-email?token=${verifToken}`;

    try {
      await transporter.verify();
      await transporter.sendMail({
        from: from,
        to: u.email,
        subject: '【TransClass】重新發送：請驗證您的電子信箱',
        html: `
          <!DOCTYPE html>
          <html>
          <head><meta charset="UTF-8"></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background-color: #0a2463; color: white; padding: 20px; border-radius: 5px 5px 0 0;">
              <h2 style="margin: 0;">TransClass 驗證信</h2>
            </div>
            <div style="background-color: #f9f9f9; padding: 30px; border: 1px solid #ddd; border-top: none;">
              <p>嗨 <strong>${u.full_name || u.username}</strong>，</p>
              <p>您要求重新發送驗證信。請點擊下方按鈕完成帳號驗證（24 小時內有效）：</p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${verifyUrl}" 
                   style="display: inline-block; background-color: #0a2463; color: white; 
                          padding: 12px 30px; text-decoration: none; border-radius: 5px;">
                  驗證電子信箱
                </a>
              </div>
              <p style="font-size: 14px; color: #666;">
                如果按鈕無法點擊，請複製以下連結：<br>
                <a href="${verifyUrl}">${verifyUrl}</a>
              </p>
            </div>
          </body>
          </html>
        `
      });

      return res.json({ 
        success: true,
        message: '驗證信已重新發送，請至信箱收信。',
        email: u.email 
      });
      
    } catch (mailErr) {
      console.error('❌ 寄送驗證信失敗:', mailErr);
      return res.status(502).json({
        error: 'SMTP_SEND_FAILED',
        details: mailErr.message,
        hint: '請檢查 SMTP 設定或稍後再試'
      });
    }
    
  } catch (err) {
    console.error('❌ 重寄驗證信錯誤:', err);
    return res.status(500).json({ 
      error: 'Server error', 
      details: err.message 
    });
  }
});
// ===== 忘記密碼 =====
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const q = await pool.query(`SELECT id, username, full_name FROM users WHERE email=$1`, [email]);
    if (q.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const u = q.rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 小時有效

    await pool.query(
      `UPDATE users SET reset_password_token=$1, reset_password_expires=$2 WHERE id=$3`,
      [resetToken, resetExpires, u.id]
    );

    const resetUrl = `${APP_BASE_URL}/reset-password.html?token=${resetToken}`;
    const smtpCfg = resolveSmtpFromReqOrEnv(req);
    const tx = buildTransport(smtpCfg);

    await tx.sendMail({
      from: smtpCfg.from,
      to: email,
      subject: 'Reset your password',
      html: `
        <p>嗨 ${u.full_name || u.username},</p>
        <p>請點擊以下連結重設密碼（1 小時內有效）：</p>
        <p><a href="${resetUrl}">${resetUrl}</a></p>
      `
    });

    return res.json({ message: 'Password reset link sent to your email' });
  } catch (err) {
    console.error('❌ Forgot password error:', err);
    return res.status(500).json({ error: 'Server error', details: err.message });
  }
});


// ===== 重設密碼 =====
app.post('/api/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' });

  try {
    const q = await pool.query(
      `SELECT id, reset_password_expires FROM users WHERE reset_password_token=$1`,
      [token]
    );
    if (q.rows.length === 0) return res.status(400).json({ error: 'Invalid token' });

    const u = q.rows[0];
    if (!u.reset_password_expires || new Date() > new Date(u.reset_password_expires)) {
      return res.status(400).json({ error: 'Token expired' });
    }

    const hashed = await bcrypt.hash(newPassword, 12);
    await pool.query(
      `UPDATE users
       SET password=$1, reset_password_token=NULL, reset_password_expires=NULL
       WHERE id=$2`,
      [hashed, u.id]
    );

    return res.json({ message: 'Password reset successful, you can now login.' });
  } catch (err) {
    console.error('❌ Reset password error:', err);
    return res.status(500).json({ error: 'Server error', details: err.message });
  }
});



// 語言偏好
app.post('/api/user/language', requireAuth, async (req, res) => {
  const { language } = req.body;
  if (!language) return res.status(400).json({ error: '語言代碼是必填的' });
  const validLanguages = getSupportedLanguages().concat(['zh-Hant','zh-CN','zh-Hans']);
  if (!validLanguages.includes(language)) return res.status(400).json({ error: '不支援的語言代碼' });
  try {
    const updated = await pool.query(
      `UPDATE users SET preferred_language=$1 WHERE id=$2 RETURNING id, username, email, preferred_language`,
      [language, req.user.userId]
    );
    if (updated.rows.length === 0) return res.status(404).json({ error: '用戶不存在' });
    return res.json({ message: '語言偏好已更新', user: updated.rows[0] });
  } catch (err) {
    console.error('設定語言偏好錯誤:', err);
    return res.status(500).json({ error: '設定語言偏好失敗', details: err.message });
  }
});

app.get('/api/user/language', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, email, preferred_language FROM users WHERE id=$1', [req.user.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: '用戶不存在' });
    const u = result.rows[0];
    return res.json({ userId: u.id, username: u.username, email: u.email, preferredLanguage: u.preferred_language || 'zh-Hant' });
  } catch (err) {
    console.error('獲取語言偏好錯誤:', err);
    return res.status(500).json({ error: '獲取語言偏好失敗', details: err.message });
  }
});



app.post('/api/folders', requireTeacher, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '資料夾名稱是必填的' });
  try {
    const dup = await pool.query('SELECT id FROM folders WHERE user_id=$1 AND name=$2', [req.user.userId, name.trim()]);
    if (dup.rows.length > 0) return res.status(400).json({ error: '資料夾名稱已存在' });
    const inserted = (await pool.query(`INSERT INTO folders (name, user_id) VALUES ($1,$2) RETURNING id, name, created_at, updated_at`, [name.trim(), req.user.userId])).rows[0];
    return res.status(201).json({ message: '資料夾創建成功', folder: inserted });
  } catch (err) {
    console.error('創建資料夾失敗:', err);
    return res.status(500).json({ error: '創建資料夾失敗', details: err.message });
  }
});

app.put('/api/folders/:id', requireTeacher, async (req, res) => {
  const folderId = req.params.id;
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '資料夾名稱是必填的' });
  try {
    const owner = await pool.query('SELECT user_id FROM folders WHERE id=$1', [folderId]);
    if (owner.rows.length === 0) return res.status(404).json({ error: '資料夾不存在' });
    if (owner.rows[0].user_id !== req.user.userId) return res.status(403).json({ error: '無權限修改此資料夾' });

    const dup = await pool.query('SELECT id FROM folders WHERE user_id=$1 AND name=$2 AND id<>$3', [req.user.userId, name.trim(), folderId]);
    if (dup.rows.length > 0) return res.status(400).json({ error: '資料夾名稱已存在' });

    const updated = (await pool.query(`UPDATE folders SET name=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2 AND user_id=$3 RETURNING id, name, created_at, updated_at`, [name.trim(), folderId, req.user.userId])).rows[0];
    return res.json({ message: '資料夾名稱更新成功', folder: updated });
  } catch (err) {
    console.error('更新資料夾名稱失敗:', err);
    return res.status(500).json({ error: '更新資料夾名稱失敗', details: err.message });
  }
});

app.delete('/api/folders/:id', requireTeacher, async (req, res) => {
  const folderId = req.params.id;
  const client = await pool.connect();
  try {
    const owner = await pool.query('SELECT user_id, name FROM folders WHERE id=$1', [folderId]);
    if (owner.rows.length === 0) return res.status(404).json({ error: '資料夾不存在' });
    if (owner.rows[0].user_id !== req.user.userId) return res.status(403).json({ error: '無權限刪除此資料夾' });

    await client.query('BEGIN');
    await client.query(`DELETE FROM messages WHERE meeting_id IN (SELECT id FROM meetings WHERE folder_id=$1)`, [folderId]);
    const delMeetings = await client.query('DELETE FROM meetings WHERE folder_id=$1', [folderId]);
    await client.query('DELETE FROM folders WHERE id=$1', [folderId]);
    await client.query('COMMIT');

    return res.json({ message: '資料夾及其課程已成功刪除', deletedFolder: { id: Number(folderId), name: owner.rows[0].name }, deletedMeetingsCount: delMeetings.rowCount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('刪除資料夾失敗:', err);
    return res.status(500).json({ error: '刪除資料夾失敗', details: err.message });
  } finally { client.release(); }
});

app.get('/api/folders/:id/meetings', requireTeacher, async (req, res) => {
  const folderId = req.params.id;
  try {
    const check = await pool.query('SELECT name FROM folders WHERE id=$1 AND user_id=$2', [folderId, req.user.userId]);
    if (check.rows.length === 0) return res.status(404).json({ error: '資料夾不存在或無權限查看' });
    const rows = (await pool.query(`SELECT id, title, start_time, end_time, folder_id FROM meetings WHERE folder_id=$1 AND creator_id=$2 ORDER BY start_time DESC`, [folderId, req.user.userId])).rows;
    return res.json({ folder: check.rows[0], meetings: rows.map(m => ({ id: m.id, title: m.title, startTime: m.start_time, endTime: m.end_time, folderId: m.folder_id, status: m.end_time ? '已結束' : '進行中' })) });
  } catch (err) {
    console.error('獲取資料夾課程失敗:', err);
    return res.status(500).json({ error: '獲取資料夾課程失敗', details: err.message });
  }
});
// 主頁面路由
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 新增會議頁面路由 - 修復 Cannot GET /add-meeting
app.get('/add-meeting', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'add-meeting.html'));
});

// 會議頁面路由
app.get('/meeting.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'meeting.html'));
});

// 會議詳情頁面路由
app.get('/meeting-detail.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'meeting-detail.html'));
});

// 認證頁面路由
app.get('/auth.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'auth.html'));
});

// 兼容舊版 API - 重導向到新的課程建立流程
app.post('/add-meeting', requireAuth, async (req, res) => {
  try {
    const { title, startTime, endTime, folderId } = req.body;
    
    // 調用新的課程建立邏輯，但這次直接在這裡實現
    if (!title || !startTime) {
      return res.status(400).json({ error: '標題和開始時間是必填的' });
    }

    if (folderId) {
      const f = await pool.query('SELECT id, name FROM folders WHERE id=$1 AND user_id=$2', [folderId, req.user.userId]);
      if (f.rows.length === 0) {
        return res.status(400).json({ error: '指定的資料夾不存在或無權限' });
      }
    }

    // 先插入課程以獲取課程ID
    const inserted = (await pool.query(
      `INSERT INTO meetings (title, start_time, end_time, creator_id, folder_id)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, title, start_time, end_time, folder_id`,
       [title, startTime, endTime || null, req.user.userId, folderId || null]
    )).rows[0];

    const finalTitle = inserted.title;

    return res.status(201).json({
      message: '課程新增成功',
      meetingId: inserted.id,
      title: finalTitle, // 返回格式化後的標題
      startTime: inserted.start_time,
      endTime: inserted.end_time,
      folderId: inserted.folder_id,
    });
  } catch (error) {
    console.error('舊版課程建立API錯誤:', error);
    return res.status(500).json({ error: '建立課程失敗', details: error.message });
  }
});
// 提取會議建立邏輯為獨立函數以供重用
async function createMeetingHandler(req, res) {
  try {
    const { title, startTime, endTime, folderId } = req.body;
    if (!startTime) {
      return res.status(400).json({ error: '開始時間是必填的' });
    }

    // Validate folder if provided
    if (folderId) {
      const f = await pool.query('SELECT id, name FROM folders WHERE id=$1 AND user_id=$2', [folderId, req.user.userId]);
      if (f.rows.length === 0) {
        return res.status(400).json({ error: '指定的資料夾不存在或無權限' });
      }
    }

    // 先插入課程以獲取課程ID
    const inserted = (await pool.query(
      `INSERT INTO meetings (title, start_time, end_time, creator_id, folder_id)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, title, start_time, end_time, folder_id`,
      [title, startTime, endTime || null, req.user.userId, folderId || null]
    )).rows[0];

    // 如果有資料夾ID，則更新課程標題格式為 (資料夾名稱) + (課程ID)

    const finalTitle = inserted.title;

    return res.status(201).json({
      message: '課程新增成功',
      meetingId: inserted.id,
      title: finalTitle, // 返回格式化後的標題
      startTime: inserted.start_time,
      endTime: inserted.end_time,
      folderId: inserted.folder_id,
    });
  } catch (err) {
    console.error('創建課程失敗:', err);
    return res.status(500).json({ error: '創建課程失敗', details: err.message });
  }
}
// -------------------------------------------------------------
// 課程（Meeting）
// -------------------------------------------------------------
// 老師開課

app.post('/api/meetings', requireTeacher, async (req, res) => {
  try {
    const { title, startTime, endTime, folderId } = req.body;
    if (!title || !startTime) return res.status(400).json({ error: '標題和開始時間是必填的' });

    if (folderId) {
      const f = await pool.query('SELECT id, name FROM folders WHERE id=$1 AND user_id=$2', [folderId, req.user.userId]);
      if (f.rows.length === 0) return res.status(400).json({ error: '指定的資料夾不存在或無權限' });
    }

    // 先插入課程以獲取課程ID
    const inserted = (await pool.query(
      `INSERT INTO meetings (title, start_time, end_time, creator_id, folder_id)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, title, start_time, end_time, folder_id`,
       [title, startTime, endTime || null, req.user.userId, folderId || null]
    )).rows[0];

    // 如果有資料夾ID，則更新課程標題格式為 (資料夾名稱) + (課程ID)
    const finalTitle = inserted.title

    return res.status(201).json({
      message: '課程新增成功',
      meetingId: inserted.id,
      title: finalTitle, // 返回格式化後的標題
      startTime: inserted.start_time,
      endTime: inserted.end_time,
      folderId: inserted.folder_id,
    });
  } catch (err) {
    console.error('創建課程失敗:', err);
    return res.status(500).json({ error: '創建課程失敗', details: err.message });
  }
});
// 依角色取得課程清單（老師=自己開的；學生=自己參與或自己開的）
app.get('/api/meetings', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const userRole = req.user.role;

    let query, params;
    if (userRole === 'teacher') {
      query = `
        SELECT m.id, m.title, m.start_time, m.end_time, m.folder_id, f.name AS folder_name,
               EXTRACT(YEAR FROM m.start_time) AS year, EXTRACT(MONTH FROM m.start_time) AS month
        FROM meetings m
        LEFT JOIN folders f ON m.folder_id = f.id
        WHERE m.creator_id = $1
        ORDER BY m.start_time DESC`;
      params = [userId];
    } else {
      query = `
        SELECT m.id, m.title, m.start_time, m.end_time, m.folder_id, f.name AS folder_name,
               u.full_name AS teacher_name, mp.role AS participant_role,
               EXTRACT(YEAR FROM m.start_time) AS year, EXTRACT(MONTH FROM m.start_time) AS month
        FROM meetings m
        LEFT JOIN folders f ON m.folder_id = f.id
        LEFT JOIN users u ON m.creator_id = u.id
        LEFT JOIN meeting_participants mp ON m.id = mp.meeting_id AND mp.user_id = $1
        WHERE mp.user_id = $1 OR m.creator_id = $1
        ORDER BY m.start_time DESC`;
      params = [userId];
    }

    const rows = (await pool.query(query, params)).rows;

    const groupedByMonth = rows.reduce((acc, m) => {
      const monthKey = `${m.year}-${String(m.month).padStart(2,'0')}`;
      const monthName = new Date(m.year, m.month - 1).toLocaleDateString('zh-TW', { year: 'numeric', month: 'long' });
      if (!acc[monthKey]) acc[monthKey] = { name: monthName, meetings: [] };
      const item = {
        id: m.id,
        title: m.title,
        startTime: m.start_time,
        endTime: m.end_time,
        folderId: m.folder_id,
        folderName: m.folder_name,
        status: m.end_time ? '已結束' : '進行中'
      };
      if (userRole === 'student') {
        item.teacherName = m.teacher_name;
        item.participantRole = m.participant_role || 'viewer';
      }
      acc[monthKey].meetings.push(item);
      return acc;
    }, {});

    return res.json({ meetings: rows, groupedByMonth, userRole });
  } catch (err) {
    console.error('獲取課程記錄錯誤:', err);
    return res.status(500).json({ error: '獲取課程記錄失敗', details: err.message });
  }
});

// 取得課程詳情（需為創建者或參與者）
app.get('/api/meetings/:id', requireAuth, async (req, res) => {
  const meetingId = req.params.id;
  const userId = req.user.userId;
  const userRole = req.user.role;
  
  console.log(`📖 獲取課程詳情請求: 會議ID=${meetingId}, 用戶ID=${userId}, 用戶角色=${userRole}`);
  
  try {
    // 獲取會議基本信息
    const meetingQuery = await pool.query('SELECT * FROM meetings WHERE id=$1', [meetingId]);
    if (meetingQuery.rows.length === 0) {
      return res.status(404).json({ error: '課程不存在' });
    }

    const meeting = meetingQuery.rows[0];
    let userPermission = null;
    let canEdit = false;
    let canShare = false;
    let canEnd = false;
    
    // 判斷用戶權限
    if (meeting.creator_id === userId) {
      userPermission = 'host';
      canEdit = true;
      canShare = true;
      canEnd = true;
      console.log(`✅ 用戶是課程創建者，權限: host`);
    } else {
      // 檢查是否在參與者列表中
      const participantQuery = await pool.query(
        'SELECT role FROM meeting_participants WHERE meeting_id=$1 AND user_id=$2', 
        [meetingId, userId]
      );
      
      if (participantQuery.rows.length > 0) {
        userPermission = participantQuery.rows[0].role || 'viewer';
        console.log(`✅ 用戶是課程參與者，權限: ${userPermission}`);
      } else {
        console.log(`❌ 用戶無權限訪問此課程`);
        return res.status(403).json({ error: '無權限查看此課程' });
      }
    }

    // 獲取消息記錄
    const messagesQuery = await pool.query(
      `SELECT id, meeting_id, user_id, speaker, original_language, original_text, created_at
       FROM messages WHERE meeting_id=$1 ORDER BY created_at`, 
      [meetingId]
    );

    // 修復：使用新的參與者獲取邏輯
    const participants = await getUpdatedParticipantsList(meetingId);

    const responseData = {
      meeting: meeting,
      userRole: userRole,
      userPermission: userPermission,
      permissions: {
        canEdit: canEdit,
        canShare: canShare,
        canEnd: canEnd
      },
      participants: participants,
      messages: messagesQuery.rows,
      transcripts: messagesQuery.rows.map(msg => ({
        id: msg.id,
        meeting_id: msg.meeting_id,
        speaker: msg.speaker,
        original_language: msg.original_language,
        original_text: msg.original_text,
        timestamp: msg.created_at
      })),
      onlineUsers: Array.from(onlineUsers.get(meetingId) || [])
    };
    
    console.log(`✅ 課程詳情返回成功，權限: ${userPermission}, 參與者數量: ${participants.length}`);
    return res.json(responseData);
    
  } catch (err) {
    console.error('❌ 獲取課程詳情錯誤:', err);
    return res.status(500).json({ 
      error: '獲取課程詳情失敗', 
      details: err.message 
    });
  }
});

setInterval(async () => {
  console.log('🧹 執行定期清理任務...');
  
  // 清理空的在線用戶集合
  for (const [meetingId, userSet] of onlineUsers.entries()) {
    if (userSet.size === 0) {
      onlineUsers.delete(meetingId);
      console.log(`🗑️ 清理空的會議房間: ${meetingId}`);
    }
  }
  
  // 清理已結束會議的在線用戶記錄
  try {
    const endedMeetings = await pool.query('SELECT id FROM meetings WHERE end_time IS NOT NULL');
    endedMeetings.rows.forEach(row => {
      if (onlineUsers.has(row.id)) {
        onlineUsers.delete(row.id);
        console.log(`🗑️ 清理已結束會議的在線記錄: ${row.id}`);
      }
    });
  } catch (error) {
    console.error('❌ 清理已結束會議記錄失敗:', error);
  }
  
}, 5 * 60 * 1000); // 每5分鐘執行一次


// ===== 收集同課程（同 folder_id）歷屆學員 Email =====
async function collectAlumniEmails(meetingId) {
  // 先查目標課程的 folder_id 與 creator_id、title
  const m = await pool.query(
    `SELECT id, folder_id, creator_id, title
     FROM meetings WHERE id = $1`,
    [meetingId]
  );
  if (m.rows.length === 0) throw new Error('課程不存在');
  const { folder_id, creator_id, title } = m.rows[0];

  // 主要策略：同 folder 視為同課程；若無 folder，退回同老師 + 同標題
  let rows;
  if (folder_id) {
    rows = (await pool.query(
      `SELECT DISTINCT u.email
       FROM meetings m
       JOIN meeting_participants mp ON mp.meeting_id = m.id
       JOIN users u ON u.id = mp.user_id
       WHERE m.folder_id = $1
         AND u.email IS NOT NULL
         AND u.email <> ''
         AND u.id <> $2`,                       -- 排除老師自己
      [folder_id, creator_id]
    )).rows;
  } else {
    rows = (await pool.query(
      `SELECT DISTINCT u.email
       FROM meetings m
       JOIN meeting_participants mp ON mp.meeting_id = m.id
       JOIN users u ON u.id = mp.user_id
       WHERE m.creator_id = $1
         AND COALESCE(m.title,'') = COALESCE($2,'')
         AND u.email IS NOT NULL
         AND u.email <> ''
         AND u.id <> $1`,                       -- 排除老師自己
      [creator_id, title]
    )).rows;
  }

  // 額外：補上「曾加入當前這堂課」但可能沒有歸到上面條件的學生（保險）
  const current = (await pool.query(
    `SELECT DISTINCT u.email
     FROM meeting_participants mp
     JOIN users u ON u.id = mp.user_id
     WHERE mp.meeting_id = $1
       AND u.email IS NOT NULL
       AND u.email <> ''
       AND u.id <> $2`,
    [meetingId, creator_id]
  )).rows;

  // 去重、簡單過濾格式
  const emailSet = new Set();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  [...rows, ...current].forEach(r => { if (emailRegex.test(r.email)) emailSet.add(r.email.trim()); });
  return Array.from(emailSet);
}


// ===== 群發分享連結給同課程歷屆學員（老師/開課者限定） =====
// ======================= 取代整個 broadcast-alumni 路由 =======================

/** 依環境變數建立 nodemailer transporter */
function buildTransportFromEnv() {
  const host   = process.env.SMTP_HOST;
  const port   = Number(process.env.SMTP_PORT || 587);
  const user   = process.env.SMTP_USER;
  const pass   = process.env.SMTP_PASS;
  const from   = process.env.MAIL_FROM; // e.g. 'TransClass <your@gmail.com>'
  const secure = (process.env.SMTP_SECURE === 'true') || port === 465;

  if (!host || !user || !pass || !from) {
    throw new Error('SMTP_NOT_CONFIGURED: missing host/user/pass/from');
  }
  const tx = nodemailer.createTransport({
    host, port, secure,
    auth: { user, pass },
    // 587 走 STARTTLS；465 走 SMTPS
    requireTLS: !secure && port === 587,
    tls: { rejectUnauthorized: false },
  });
  return { tx, from, host, port, secure };
}

/** 確認呼叫者為此會議的主持人，並取回會議 */
async function assertIsMeetingHostAndGet(meetingId, reqUserId) {
  const { rows } = await pool.query(
    `SELECT id, title, folder_id, creator_id
     FROM meetings WHERE id = $1`,
    [meetingId]
  );
  if (!rows.length) throw new Error('MEETING_NOT_FOUND');
  const meeting = rows[0];
  if (String(meeting.creator_id) !== String(reqUserId)) {
    throw new Error('FORBIDDEN_NOT_HOST');
  }
  return meeting;
}

/** 產生或重用分享連結，修正 expires_at 參數順序 */
async function ensureShareLink(meetingId, permission = 'viewer', expiresInHours = 24, req) {
  // 先找未過期的同權限連結（可視需要放寬條件）
  const { rows: existing } = await pool.query(
    `SELECT share_token, expires_at
     FROM meeting_share_links
     WHERE meeting_id = $1 AND permission = $2 AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [meetingId, permission]
  );

  if (existing.length) {
    const shareCode = existing[0].share_token;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    return {
      shareUrl: `${baseUrl}/join/${meetingId}`,
      shareCode,
      expiresAt: existing[0].expires_at,
      permission,
    };
  }

  // 沒有 → 新增
  const crypto = require('crypto');
  const shareCode = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + expiresInHours * 3600 * 1000);
  // ⚠️ 關鍵修正：第 4 個參數一定要是 expiresAt（Date），不是 userId！
  await pool.query(
    `INSERT INTO meeting_share_links (meeting_id, share_token, permission, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5)`,
    [meetingId, shareCode, permission, req.user.userId]
  );
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  return {
    shareUrl: `${baseUrl}/join/${meetingId}`,
    shareCode,
    expiresAt,
    permission,
  };
}

/** 撈出同資料夾歷屆學員 email（去重、排除自己與空白） */
async function collectAlumniEmailsByFolder(folderId, excludeUserId) {
  // 依你的 schema 調整表名：這裡假設有 meeting_participants 與 users, meetings
  const { rows } = await pool.query(
    `SELECT DISTINCT u.email
     FROM meeting_participants mp
     JOIN users u     ON u.id = mp.user_id
     JOIN meetings m  ON m.id = mp.meeting_id
     WHERE m.folder_id = $1
       AND u.email IS NOT NULL AND u.email <> ''
       AND u.id <> $2`,
    [folderId, excludeUserId]
  );
  return rows.map(r => (r.email || '').trim()).filter(Boolean);
}

/** email 簡單驗證 */
const emailLike = /\b[^@\s]+@[^@\s]+\.[^@\s]+\b/;

/** 路由主體 */
app.post('/api/meetings/:id/share/broadcast-alumni', requireTeacher, async (req, res) => {
  const meetingId = req.params.id;
  // 前端可帶 shareUrl / permission / expiresIn / previewOnly / subject / message
  let { shareUrl, permission = 'viewer', expiresIn = 24, previewOnly = false, subject, message } = req.body || {};
  expiresIn = Number(expiresIn) || 24;

  try {
    // 1) 確認主持人 & 取得會議（抓 folder_id 用來找歷屆）
    const meeting = await assertIsMeetingHostAndGet(meetingId, req.user.userId);

    // 2) 確認/取得分享連結
    let link;
    if (shareUrl) {
      link = { shareUrl, permission, expiresAt: new Date(Date.now() + expiresIn * 3600 * 1000) };
    } else {
      link = await ensureShareLink(meetingId, permission, expiresIn, req);
      shareUrl = link.shareUrl;
    }

    // 3) 撈歷屆 email
    const emails = await collectAlumniEmailsByFolder(meeting.folder_id, req.user.userId);
    console.log("寄送對象：", emails)
    if (!emails.length) {
      return res.status(400).json({ error: 'NO_ALUMNI_EMAILS', note: '沒有找到任何歷屆學員的 email 可寄送' });
    }
    const validEmails = emails.filter(e => emailLike.test(e));
    if (!validEmails.length) {
      return res.status(400).json({ error: 'NO_VALID_EMAILS', note: '名單中沒有有效的 email' });
    }

    // 4) 預覽模式（不寄信，只回名單）
    if (previewOnly === true) {
      return res.json({
        previewOnly: true,
        total: emails.length,
        valid: validEmails.length,
        emails: validEmails.slice(0, 200), // 避免回太長
        shareUrl,
        permission,
        expiresAt: link.expiresAt,
      });
    }

    // 5) 建立 SMTP 傳輸並驗證
    const { tx, from } = buildTransportFromEnv();
    try { await tx.verify(); }
    catch (err) {
      return res.status(502).json({
        error: 'SMTP_SEND_FAILED',
        details: String(err?.message || err),
        hint: '請檢查 SMTP host/port/user/pass/from；587 用 secure=false + STARTTLS，或 465 + secure=true'
      });
    }

    // 6) 組信件內容
    const mailSubject = subject || `[Transmeet] ${meeting.title || '課程'} 分享連結`;
    const htmlBody = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial">
        <p>您好，這是 <b>${req.user?.full_name || '老師'}</b> 分享的課堂連結：</p>
        <p><a href="${shareUrl}" target="_blank" rel="noopener">${shareUrl}</a></p>
        <p>權限：${permission}；到期：${new Date(link.expiresAt).toLocaleString()}</p>
        ${message ? `<hr/><pre style="white-space:pre-wrap">${String(message).replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))}</pre>` : ''}
        <hr/>
        <p>此信由系統自動發送，請勿直接回覆。</p>
      </div>
    `;
    const textBody =
      `您好，這是 ${req.user?.full_name || '老師'} 分享的課堂連結：\n` +
      `${shareUrl}\n` +
      `權限：${permission}；到期：${new Date(link.expiresAt).toLocaleString()}\n` +
      (message ? `\n-----\n${message}\n` : '') +
      `\n(此信由系統自動發送，請勿直接回覆)`;

    // 7) 分批寄送（避免一次打太多）
    const BATCH = 30;
    let sent = 0;
    const failed = [];
    for (let i = 0; i < validEmails.length; i += BATCH) {
      const chunk = validEmails.slice(i, i + BATCH);
      // 組信件、並依照 Promise 結果決定是否成功或失敗
      const results = await Promise.allSettled(
        validEmails.map(to => tx.sendMail({
          from, to, subject: mailSubject, html: htmlBody, text: textBody
        }))
      );

      // 統計成功與失敗
      let sent = 0;
      let failed = [];
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') {
          sent++;
        } else {
          // 如果是 rejected，記錄錯誤信息
          failed.push({ email: validEmails[idx], reason: r.reason ? r.reason.message : '未知錯誤' });
        }
      });

      // 如果 failed 陣列空，顯示 0
      if (failed.length === 0) {
        failed.push({ email: '無', reason: '無失敗' });  // 顯示為「無失敗」
      }

      // 如果成功寄出，顯示結果
      return res.json({
        sent,
        failed,
        totalTargets: validEmails.length,
        shareUrl,
        permission,
        expiresAt: link.expiresAt,
      });}
  } catch (err) {
    console.error('❌ broadcast-alumni error:', err);
    const msg = String(err?.message || err || '');
    if (msg === 'MEETING_NOT_FOUND') return res.status(404).json({ error: 'MEETING_NOT_FOUND' });
    if (msg === 'FORBIDDEN_NOT_HOST') return res.status(403).json({ error: 'FORBIDDEN' });

    const low = msg.toLowerCase();
    if (
      low.includes('smtp') || low.includes('auth') || low.includes('invalid login') ||
      low.includes('authentication') || low.includes('econn') || low.includes('certificate') ||
      low.includes('self signed') || low.includes('tls')
    ) {
      return res.status(502).json({
        error: 'SMTP_SEND_FAILED',
        details: msg,
        hint: '請檢查 SMTP host/port/user/pass/from；587 用 secure=false + STARTTLS，或 465 用 secure=true'
      });
    }
    return res.status(500).json({ error: 'BROADCAST_FAILED', details: msg });
  }
});
// ===================== /api/meetings/:id/share/broadcast-alumni 完成 =====================

// 指定 email 名單寄送分享連結
app.post('/api/meetings/:id/share/send', requireTeacher, async (req, res) => {
  const meetingId = req.params.id;
  let { emails = [], shareUrl, permission = 'viewer', expiresIn = 24, subject, message } = req.body || {};
  if (!Array.isArray(emails)) emails = [emails].filter(Boolean);
  emails = emails.map(e => String(e || '').trim()).filter(Boolean);
  if (!emails.length) return res.status(400).json({ error: 'NO_EMAILS', note: '請提供至少一個 email' });

  try {
    // 驗證主持人 & 取得會議（與 broadcast-alumni 一致）
    const meeting = await assertIsMeetingHostAndGet(meetingId, req.user.userId);

    // 有帶 shareUrl 就用；沒有就產生/沿用有效連結（沿用 ensureShareLink）
    let link;
    if (shareUrl) {
      link = { shareUrl, permission, expiresAt: new Date(Date.now() + (Number(expiresIn)||24) * 3600 * 1000) };
    } else {
      link = await ensureShareLink(meetingId, permission, Number(expiresIn)||24, req);
      shareUrl = link.shareUrl;
    }

    // 驗證 email 格式（沿用既有的 emailLike）
    const valid = emails.filter(e => emailLike.test(e));
    const invalid = emails.filter(e => !emailLike.test(e));
    if (!valid.length) return res.status(400).json({ error: 'NO_VALID_EMAILS', invalid });

    // 建立 SMTP 傳輸
    const { tx, from } = buildTransportFromEnv();
    try { await tx.verify(); }
    catch (err) {
      return res.status(502).json({
        error: 'SMTP_SEND_FAILED',
        details: String(err?.message || err),
        hint: '請檢查 SMTP host/port/user/pass/from；587 用 secure=false + STARTTLS，或 465 + secure=true'
      });
    }

    // 信件內容
    const mailSubject = subject || `[Transmeet] ${meeting.title || '課程'} 分享連結`;
    const htmlBody = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial">
        <p>您好，這是 <b>${req.user?.full_name || '老師'}</b> 分享的課堂連結：</p>
        <p><a href="${shareUrl}" target="_blank" rel="noopener">${shareUrl}</a></p>
        <p>權限：${permission}；到期：${new Date(link.expiresAt).toLocaleString()}</p>
        ${message ? `<hr><div>${message}</div>` : ''}
      </div>
    `;

    // 寄送
    const results = await Promise.allSettled(valid.map(email =>
      tx.sendMail({ from, to: email, subject: mailSubject, html: htmlBody })
    ));

    const sent = results.filter(r => r.status === 'fulfilled').length;
    const failed = results
      .filter(r => r.status === 'rejected')
      .map((r, i) => ({ email: valid[i], reason: r.reason?.message || '未知錯誤' }));

    return res.json({
      sent,
      failed,
      invalidEmails: invalid,
      totalTargets: valid.length,
      shareUrl,
      permission,
      expiresAt: link.expiresAt
    });
  } catch (err) {
    console.error('❌ send-to-emails error:', err);
    return res.status(500).json({ error: 'SEND_FAILED', details: String(err?.message || err) });
  }
});

// === 全域搜尋（標題 + 內容） ===
app.get('/api/search', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const role = req.user.role;
    const q = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);

    if (!q) return res.json({ query: q, results: [], counts: { meetings: 0, messages: 0, folders: 0 } });
    const like = `%${q}%`;

    // 權限條件
    // 老師：自己開的課
    // 學生：自己是主持人或參與者（含 viewer/participant）
    const baseAccessMeetings =
      role === 'teacher'
        ? `m.creator_id = $2`
        : `(m.creator_id = $2 OR EXISTS (
             SELECT 1 FROM meeting_participants mp WHERE mp.meeting_id = m.id AND mp.user_id = $2
           ))`;

    // 1) 會議標題
    const meetingRows = (await pool.query(
      `
      SELECT m.id AS meeting_id, m.title, m.start_time, m.folder_id,
             COALESCE(f.name,'課程') AS folder_name
      FROM meetings m
      LEFT JOIN folders f ON f.id = m.folder_id
      WHERE ${baseAccessMeetings}
        AND m.title ILIKE $1
      ORDER BY m.start_time DESC
      LIMIT $3
      `,
      [like, userId, limit]
    )).rows;

    // 2) 訊息內容（轉錄文字）
    const messageRows = (await pool.query(
      `
      SELECT msg.id AS message_id, msg.meeting_id, msg.original_text, msg.created_at,
             m.title AS meeting_title, m.folder_id, COALESCE(f.name,'課程') AS folder_name
      FROM messages msg
      JOIN meetings m ON m.id = msg.meeting_id
      LEFT JOIN folders f ON f.id = m.folder_id
      WHERE ${baseAccessMeetings}
        AND msg.original_text ILIKE $1
      ORDER BY msg.created_at DESC
      LIMIT $3
      `,
      [like, userId, limit]
    )).rows;

    // 3) 資料夾名稱（使用者自己的）
    const folderRows = (await pool.query(
      `
      SELECT id, name, user_id
      FROM folders
      WHERE user_id = $2
        AND name ILIKE $1
      ORDER BY created_at DESC
      LIMIT $3
      `,
      [like, userId, limit]
    )).rows;

    // 包裝結果
    const results = [
      ...meetingRows.map(r => ({
        type: 'meeting',
        meetingId: r.meeting_id,
        folderId: r.folder_id,
        folderName: r.folder_name,
        title: r.title,
        ts: r.start_time,
        snippet: null,
      })),
      ...messageRows.map(r => ({
        type: 'message',
        messageId: r.message_id,
        meetingId: r.meeting_id,
        folderId: r.folder_id,
        folderName: r.folder_name,
        title: r.meeting_title,
        ts: r.created_at,
        // 取一小段做摘要
        snippet: (r.original_text || '').slice(0, 120),
      })),
      ...folderRows.map(r => ({
        type: 'folder',
        folderId: r.id,
        folderName: r.name,
        title: r.name,
        ts: null,
        snippet: null,
      })),
    ];

    return res.json({
      query: q,
      counts: {
        meetings: meetingRows.length,
        messages: messageRows.length,
        folders: folderRows.length,
      },
      results,
    });
  } catch (err) {
    console.error('❌ /api/search error:', err);
    return res.status(500).json({ error: 'SEARCH_FAILED', details: String(err?.message || err) });
  }
});




// 健檢 SMTP（成功會回 { ok: true, host, port, secure, from }）
app.get('/api/_smtp/verify', async (req, res) => {
  try {
    const cfg = resolveSmtpFromReqOrEnv(req);
    const tx = buildTransport(cfg);
    await tx.verify();
    return res.json({ ok: true, host: cfg.host, port: cfg.port, secure: !!cfg.secure, from: cfg.from });
  } catch (err) {
    return res.status(502).json({ error: 'SMTP_VERIFY_FAILED', details: String(err?.message || err) });
  }
});



app.post('/api/meetings/:id/share', requireAuth, async (req, res) => {
  const meetingId = req.params.id;
  const { permission = 'viewer', expiresIn = 24 } = req.body;
  
  console.log(`🔗 生成分享連結請求: 會議=${meetingId}, 權限=${permission}, 過期=${expiresIn}小時`);
  
  try {
    // 檢查會議是否存在且用戶有分享權限
    const meetingQuery = await pool.query(
      'SELECT id, creator_id, title FROM meetings WHERE id=$1', 
      [meetingId]
    );
    
    if (meetingQuery.rows.length === 0) {
      return res.status(404).json({ error: '課程不存在' });
    }
    
    const meeting = meetingQuery.rows[0];
    if (meeting.creator_id !== req.user.userId) {
      return res.status(403).json({ error: '只有課程創建者可以分享課程' });
    }
    
    // 生成分享代碼
    const shareCode = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + expiresIn);
    
    // 修改這裡：使用 share_token 而不是 code
    await pool.query(
      `INSERT INTO meeting_share_links (meeting_id, share_token, permission, expires_at, created_by) 
       VALUES ($1, $2, $3, $4, $5)`,
      [meetingId, shareCode, permission, expiresAt, req.user.userId]
    );
    
    // 構建分享 URL
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const shareUrl = `${baseUrl}/join/${meetingId}`;
    
    console.log(`✅ 分享連結生成成功: ${shareUrl}`);
    
    return res.json({
      shareUrl: shareUrl,
      shareCode: shareCode,
      permission: permission,
      expiresAt: expiresAt,
      meeting: {
        id: meeting.id,
        title: meeting.title
      }
    });
    
  } catch (err) {
    console.error('❌ 生成分享連結錯誤:', err);
    return res.status(500).json({ 
      error: '生成分享連結失敗', 
      details: err.message 
    });
  }
});
app.get('/api/share/:code', async (req, res) => {
  const shareCode = req.params.code;
  
  console.log(`🔍 驗證分享連結: ${shareCode}`);
  
  try {
    const shareQuery = await pool.query(
      `SELECT sl.*, m.title, m.id as meeting_id
      FROM meeting_share_links sl
      JOIN meetings m ON sl.meeting_id = m.id
      WHERE sl.share_token = $1 AND sl.is_active = true`,  // 改為 share_token
      [shareCode]
    );
    
    if (shareQuery.rows.length === 0) {
      return res.status(404).json({ error: '分享連結不存在或已失效' });
    }
    
    const shareLink = shareQuery.rows[0];
    
    // 檢查是否過期
    if (shareLink.expires_at && new Date() > new Date(shareLink.expires_at)) {
      return res.status(410).json({ error: '分享連結已過期' });
    }
    
    console.log(`✅ 分享連結驗證成功`);
    
    return res.json({
      valid: true,
      meeting: {
        id: shareLink.meeting_id,
        title: shareLink.title,
        creator_id: shareLink.creator_id,
        start_time: shareLink.start_time,
        end_time: shareLink.end_time
      },
      permission: 'viewer',
      expiresAt: shareLink.expires_at
    });
    
  } catch (err) {
    console.error('❌ 驗證分享連結錯誤:', err);
    return res.status(500).json({ 
      error: '驗證分享連結失敗', 
      details: err.message 
    });
  }
});

app.post('/api/meetings/join/:shareCode', requireAuth, async (req, res) => {
  const shareCode = req.params.shareCode;
  
  console.log(`👥 通過分享連結加入會議: ${shareCode}`);
  
  try {
    // 驗證分享連結
    const shareQuery = await pool.query(
      `SELECT sl.*, m.title, m.id as meeting_id, m.creator_id
       FROM meeting_share_links sl
       JOIN meetings m ON sl.meeting_id = m.id
       WHERE sl.share_token = $1 AND sl.is_active = true`,
      [shareCode]
    );
    
    if (shareQuery.rows.length === 0) {
      return res.status(404).json({ error: '分享連結不存在或已失效' });
    }
    
    const shareLink = shareQuery.rows[0];
    const meetingId = shareLink.meeting_id;
    
    // 檢查是否過期
    if (shareLink.expires_at && new Date() > new Date(shareLink.expires_at)) {
      return res.status(410).json({ error: '分享連結已過期' });
    }
    
    // 檢查用戶是否已經是會議創建者
    if (shareLink.creator_id === req.user.userId) {
      // 如果是創建者，直接返回，不需要添加到參與者表
      const meetingQuery = await pool.query('SELECT * FROM meetings WHERE id=$1', [meetingId]);
      console.log(`✅ 會議創建者通過分享鏈接訪問自己的會議`);
      
      return res.json({
        message: '歡迎回到您的課程',
        meeting: meetingQuery.rows[0],
        role: 'host'
      });
    }
    
    // 加入會議（使用 UPSERT 避免重複記錄）
    await pool.query(
      `INSERT INTO meeting_participants (meeting_id, user_id, role)
       VALUES ($1, $2, 'viewer')
       ON CONFLICT (meeting_id, user_id) DO UPDATE SET 
       role = 'viewer', 
       joined_at = CURRENT_TIMESTAMP`,
      [meetingId, req.user.userId]
    );
    
    // 獲取會議詳情
    const meetingQuery = await pool.query('SELECT * FROM meetings WHERE id=$1', [meetingId]);
    
    console.log(`✅ 成功通過分享連結加入會議`);
    
    return res.json({
      message: '成功加入課程',
      meeting: meetingQuery.rows[0],
      role: 'viewer'
    });
    
  } catch (err) {
    console.error('❌ 通過分享連結加入會議錯誤:', err);
    return res.status(500).json({ 
      error: '加入會議失敗', 
      details: err.message 
    });
  }
});


app.get('/api/share/:code/folder-info', async (req, res) => {
  const shareCode = req.params.code;
  
  console.log(`📁 獲取分享課程的資料夾信息: ${shareCode}`);
  
  try {
    // 查詢分享連結對應的課程和資料夾信息
    const shareQuery = await pool.query(
      `SELECT m.id as meeting_id, m.title, m.folder_id, f.name as folder_name, f.user_id as teacher_id
       FROM meeting_share_links sl
       JOIN meetings m ON sl.meeting_id = m.id
       LEFT JOIN folders f ON m.folder_id = f.id
       WHERE sl.share_token = $1 AND sl.is_active = true`,
      [shareCode]
    );
    
    if (shareQuery.rows.length === 0) {
      return res.status(404).json({ error: '分享連結不存在或已失效' });
    }
    
    const shareData = shareQuery.rows[0];
    
    // 檢查是否過期
    const shareLink = await pool.query(
      'SELECT expires_at FROM meeting_share_links WHERE share_token = $1',
      [shareCode]
    );
    
    if (shareLink.rows[0]?.expires_at && new Date() > new Date(shareLink.rows[0].expires_at)) {
      return res.status(410).json({ error: '分享連結已過期' });
    }
    
    console.log(`✅ 資料夾信息獲取成功: ${shareData.folder_name || '未分類'}`);
    
    return res.json({
      meetingId: shareData.meeting_id,
      meetingTitle: shareData.title,
      folderId: shareData.folder_id,
      folderName: shareData.folder_name || '課程',
      teacherId: shareData.teacher_id
    });
    
  } catch (err) {
    console.error('❌ 獲取資料夾信息錯誤:', err);
    return res.status(500).json({ 
      error: '獲取資料夾信息失敗', 
      details: err.message 
    });
  }
});

// 確保學生有對應的資料夾（如果沒有就創建）
app.post('/api/folders/ensure', requireAuth, async (req, res) => {
  const { name, teacherFolderId } = req.body;
  const studentId = req.user.userId;
  
  console.log(`📁 確保學生資料夾存在: 學生=${studentId}, 資料夾名稱="${name}"`);
  
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '資料夾名稱是必填的' });
  }
  
  try {
    // 檢查學生是否已有同名資料夾
    const existingFolder = await pool.query(
      'SELECT id, name, created_at FROM folders WHERE user_id = $1 AND name = $2',
      [studentId, name.trim()]
    );
    
    if (existingFolder.rows.length > 0) {
      console.log(`✅ 學生已有同名資料夾: ${name}`);
      return res.json({
        message: '資料夾已存在',
        folderId: existingFolder.rows[0].id,
        folderName: existingFolder.rows[0].name,
        created: false,
        createdAt: existingFolder.rows[0].created_at
      });
    }
    
    // 創建新資料夾
    const newFolder = await pool.query(
      `INSERT INTO folders (name, user_id, created_at, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING id, name, created_at, updated_at`,
      [name.trim(), studentId]
    );
    
    console.log(`✅ 為學生創建新資料夾成功: ${name}`);
    
    return res.json({
      message: '資料夾創建成功',
      folderId: newFolder.rows[0].id,
      folderName: newFolder.rows[0].name,
      created: true,
      createdAt: newFolder.rows[0].created_at,
      updatedAt: newFolder.rows[0].updated_at
    });
    
  } catch (err) {
    console.error('❌ 確保學生資料夾錯誤:', err);
    return res.status(500).json({ 
      error: '處理學生資料夾失敗', 
      details: err.message 
    });
  }
});

// 修改學生獲取課程列表的邏輯，讓課程能正確歸類到資料夾
// 替換現有的 GET /api/meetings 路由中學生部分的邏輯
app.get('/api/meetings', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const userRole = req.user.role;

    let query, params;
    if (userRole === 'teacher') {
      // 老師的邏輯保持不變
      query = `
        SELECT m.id, m.title, m.start_time, m.end_time, m.folder_id, f.name AS folder_name,
               EXTRACT(YEAR FROM m.start_time) AS year, EXTRACT(MONTH FROM m.start_time) AS month
        FROM meetings m
        LEFT JOIN folders f ON m.folder_id = f.id
        WHERE m.creator_id = $1
        ORDER BY m.start_time DESC`;
      params = [userId];
    } else {
      // 修改學生的邏輯，改善課程歸類
      query = `
        SELECT DISTINCT
          m.id, 
          m.title, 
          m.start_time, 
          m.end_time, 
          m.folder_id as original_folder_id,
          teacher_f.name AS teacher_folder_name,
          student_f.id as student_folder_id,
          student_f.name AS student_folder_name,
          u.full_name AS teacher_name, 
          mp.role AS participant_role,
          EXTRACT(YEAR FROM m.start_time) AS year, 
          EXTRACT(MONTH FROM m.start_time) AS month
        FROM meetings m
        LEFT JOIN folders teacher_f ON m.folder_id = teacher_f.id
        LEFT JOIN folders student_f ON teacher_f.name = student_f.name AND student_f.user_id = $1
        LEFT JOIN users u ON m.creator_id = u.id
        LEFT JOIN meeting_participants mp ON m.id = mp.meeting_id AND mp.user_id = $1
        WHERE mp.user_id = $1 OR m.creator_id = $1
        ORDER BY m.start_time DESC`;
      params = [userId];
    }

    const rows = (await pool.query(query, params)).rows;

    if (userRole === 'student') {
      // 為學生處理課程歸類邏輯
      const processedRows = rows.map(m => ({
        id: m.id,
        title: m.title,
        startTime: m.start_time,
        endTime: m.end_time,
        // 優先使用學生的資料夾ID，如果沒有則使用老師的
        folderId: m.student_folder_id || m.original_folder_id,
        // 優先顯示學生的資料夾名稱，如果沒有則使用老師的
        folderName: m.student_folder_name || m.teacher_folder_name,
        teacherName: m.teacher_name,
        participantRole: m.participant_role || 'viewer',
        status: m.end_time ? '已結束' : '進行中',
        year: m.year,
        month: m.month
      }));

      const groupedByMonth = processedRows.reduce((acc, m) => {
        const monthKey = `${m.year}-${String(m.month).padStart(2,'0')}`;
        const monthName = new Date(m.year, m.month - 1).toLocaleDateString('zh-TW', { year: 'numeric', month: 'long' });
        if (!acc[monthKey]) acc[monthKey] = { name: monthName, meetings: [] };
        acc[monthKey].meetings.push(m);
        return acc;
      }, {});

      return res.json({ meetings: processedRows, groupedByMonth, userRole });
    } else {
      // 老師的邏輯保持不變
      const groupedByMonth = rows.reduce((acc, m) => {
        const monthKey = `${m.year}-${String(m.month).padStart(2,'0')}`;
        const monthName = new Date(m.year, m.month - 1).toLocaleDateString('zh-TW', { year: 'numeric', month: 'long' });
        if (!acc[monthKey]) acc[monthKey] = { name: monthName, meetings: [] };
        const item = {
          id: m.id,
          title: m.title,
          startTime: m.start_time,
          endTime: m.end_time,
          folderId: m.folder_id,
          folderName: m.folder_name,
          status: m.end_time ? '已結束' : '進行中'
        };
        acc[monthKey].meetings.push(item);
        return acc;
      }, {});

      return res.json({ meetings: rows, groupedByMonth, userRole });
    }
  } catch (err) {
    console.error('獲取課程記錄錯誤:', err);
    return res.status(500).json({ error: '獲取課程記錄失敗', details: err.message });
  }
});

// 修改學生的資料夾獲取 API，允許學生查看自己的資料夾
app.get('/api/folders', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const userRole = req.user.role;
    
    if (userRole !== 'teacher' && userRole !== 'student') {
      return res.status(403).json({ error: '權限不足' });
    }
    
    // 獲取用戶的資料夾
    const rows = (await pool.query(
      `SELECT id, name, created_at, updated_at FROM folders 
       WHERE user_id=$1 ORDER BY created_at DESC`, 
      [userId]
    )).rows;
    
    // 如果是學生，添加每個資料夾中的課程數量統計
    if (userRole === 'student') {
      for (let folder of rows) {
        // 統計該資料夾中的課程數量（通過資料夾名稱匹配）
        const meetingCount = await pool.query(`
          SELECT COUNT(*) as count FROM meetings m
          LEFT JOIN folders teacher_f ON m.folder_id = teacher_f.id
          LEFT JOIN meeting_participants mp ON m.id = mp.meeting_id
          WHERE mp.user_id = $1 
            AND (teacher_f.name = $2 OR (teacher_f.name IS NULL AND $2 = '課程'))
        `, [userId, folder.name]);
        
        folder.meetingCount = parseInt(meetingCount.rows[0].count) || 0;
      }
    } else {
      // 老師的原有邏輯
      for (let folder of rows) {
        const meetingCount = await pool.query(
          'SELECT COUNT(*) as count FROM meetings WHERE folder_id = $1',
          [folder.id]
        );
        folder.meetingCount = parseInt(meetingCount.rows[0].count) || 0;
      }
    }
    
    return res.json({ folders: rows });
    
  } catch (err) {
    console.error('獲取資料夾錯誤:', err);
    return res.status(500).json({ error: '獲取資料夾失敗', details: err.message });
  }
});

// 新增 API 端點來獲取特定資料夾信息
app.get('/api/folders/:id', requireAuth, async (req, res) => {
  try {
    const folderId = req.params.id;
    const userId = req.user.userId;
    const userRole = req.user.role;
    
    let result;
    
    if (userRole === 'teacher') {
      // 教師只能存取自己的資料夾
      result = await pool.query(
        `SELECT id, name, created_at, updated_at FROM folders 
         WHERE id = $1 AND user_id = $2`, 
        [folderId, userId]
      );
    } else if (userRole === 'student') {
      // 學生可以存取：
      // 1. 自己的資料夾
      // 2. 參與課程相關的資料夾（透過課程關聯）
      result = await pool.query(
        `SELECT DISTINCT f.id, f.name, f.created_at, f.updated_at 
         FROM folders f
         WHERE (f.id = $1 AND f.user_id = $2)
         OR (
           f.id = $1 AND EXISTS (
             SELECT 1 FROM meetings m 
             LEFT JOIN meeting_participants mp ON m.id = mp.meeting_id
             WHERE m.folder_id = f.id 
             AND (mp.user_id = $2 OR m.creator_id = $2)
           )
         )`, 
        [folderId, userId]
      );
    }
    
    if (!result || result.rows.length === 0) {
      return res.status(404).json({ error: '資料夾不存在或無權限訪問' });
    }
    
    return res.json({ folder: result.rows[0] });
    
  } catch (err) {
    console.error('取得資料夾詳情錯誤:', err);
    return res.status(500).json({ error: '取得資料夾詳情失敗', details: err.message });
  }
});

// --- [新增] 匿名學生掃碼加入課程 API ---
app.post('/api/auth/anonymous-join', async (req, res) => {
  const { shareToken } = req.body;
  if (!shareToken) return res.status(400).json({ error: '缺少分享代碼' });

  try {
    // 1. 驗證分享連結 (在你的 meeting_share_links 表中搜尋)
    const shareQuery = await pool.query(
      `SELECT sl.*, m.title 
       FROM meeting_share_links sl
       JOIN meetings m ON sl.meeting_id = m.id
       WHERE sl.share_token = $1 AND sl.is_active = true`,
      [shareToken]
    );

    if (shareQuery.rows.length === 0) {
      return res.status(404).json({ error: '連結無效或已失效' });
    }

    const shareLink = shareQuery.rows[0];

    // 2. 檢查是否過期
    if (shareLink.expires_at && new Date() > new Date(shareLink.expires_at)) {
      return res.status(410).json({ error: '此連結已過期' });
    }

    // 3. 核發臨時 JWT (身份標記為 anonymous)
    const tempUserId = `anon_${crypto.randomBytes(4).toString('hex')}`;
    const token = jwt.sign(
      { 
        userId: tempUserId, 
        username: `訪客學生`, 
        role: 'student', 
        isAnonymous: true,
        meetingId: shareLink.meeting_id 
      },
      SECRET, // 使用你 server.js 定義的 SECRET
      { expiresIn: '6h' }
    );

    return res.json({
      success: true,
      token,
      meetingId: shareLink.meeting_id,
      meetingTitle: shareLink.title,
      role: 'viewer'
    });
  } catch (err) {
    console.error('匿名加入失敗:', err);
    return res.status(500).json({ error: '伺服器錯誤' });
  }
});

// 學生加入課程（viewer）
app.post('/api/meetings/:id/end', requireAuth, async (req, res) => {
  const meetingId = req.params.id;
  console.log(`📚 收到結束課程請求，會議ID: ${meetingId}，用戶ID: ${req.user.userId}`);
  
  try {
    // 檢查會議是否存在且用戶是否為創建者
    const meetingQuery = await pool.query(
      'SELECT id, creator_id, title, end_time FROM meetings WHERE id=$1', 
      [meetingId]
    );
    
    if (meetingQuery.rows.length === 0) {
      return res.status(404).json({ error: '課程不存在' });
    }
    
    const meeting = meetingQuery.rows[0];
    
    if (meeting.creator_id !== req.user.userId) {
      return res.status(403).json({ error: '無權限結束此課程，只有課程創建者可以結束課程' });
    }
    
    if (meeting.end_time) {
      return res.status(400).json({ error: '課程已經結束' });
    }
    
    // 結束會議
    const now = new Date().toISOString();
    const updated = await pool.query(
      'UPDATE meetings SET end_time=$1 WHERE id=$2 RETURNING *', 
      [now, meetingId]
    );
    
    // 清理在線用戶記錄
    if (onlineUsers.has(meetingId)) {
      onlineUsers.delete(meetingId);
      console.log(`🗑️ 清理會議 ${meetingId} 的在線用戶記錄`);
    }
    
    // 斷開所有該會議的Socket連接
    const socketsInRoom = await io.in(`meeting:${meetingId}`).fetchSockets();
    socketsInRoom.forEach(socket => {
      const userInfo = socketUsers.get(socket.id);
      if (userInfo) {
        socketUsers.delete(socket.id);
        userSockets.delete(userInfo.userId);
      }
    });
    
    console.log(`✅ 會議結束成功: ${meetingId}`);
    
    // 廣播會議結束事件
    io.to(`meeting:${meetingId}`).emit('meeting-ended', { 
      meetingId: Number(meetingId),
      message: '課程已結束',
      endTime: now
    });
    
    return res.json({ 
      success: true,
      message: '課程已結束', 
      meeting: updated.rows[0] 
    });
    
  } catch (err) {
    console.error('❌ 結束課程錯誤:', err);
    return res.status(500).json({ 
      error: '結束課程失敗', 
      details: err.message 
    });
  }
});

app.get('/api/meetings/:id/participants/online', requireAuth, async (req, res) => {
  const meetingId = req.params.id;
  
  try {
    // 驗證用戶是否有權限查看此會議
    const accessCheck = await pool.query(
      `SELECT 1 FROM meetings WHERE id = $1 AND creator_id = $2
       UNION
       SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2`,
      [meetingId, req.user.userId]
    );
    
    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ error: '無權限查看此會議的參與者' });
    }
    
    // 獲取所有參與者和在線狀態
    const participants = await getUpdatedParticipantsList(meetingId);
    const onlineUserIds = Array.from(onlineUsers.get(meetingId) || []);
    
    return res.json({
      participants: participants,
      onlineUsers: onlineUserIds,
      totalParticipants: participants.length,
      onlineCount: onlineUserIds.length
    });
    
  } catch (error) {
    console.error('❌ 獲取在線參與者失敗:', error);
    return res.status(500).json({ 
      error: '獲取參與者狀態失敗', 
      details: error.message 
    });
  }
});

// 新增：清理舊的參與者記錄（可選的管理員端點）
app.post('/api/meetings/:id/cleanup-participants', requireAuth, async (req, res) => {
  const meetingId = req.params.id;
  
  try {
    // 檢查權限
    const meeting = await pool.query('SELECT creator_id FROM meetings WHERE id = $1', [meetingId]);
    if (meeting.rows.length === 0) {
      return res.status(404).json({ error: '會議不存在' });
    }
    
    if (meeting.rows[0].creator_id !== req.user.userId) {
      return res.status(403).json({ error: '只有會議創建者可以清理參與者' });
    }
    
    // 清理已結束會議的參與者記錄（可選）
    const cleanupResult = await pool.query(
      `DELETE FROM meeting_participants 
       WHERE meeting_id = $1 AND meeting_id IN (
         SELECT id FROM meetings WHERE end_time IS NOT NULL
       )`,
      [meetingId]
    );
    
    // 清理內存中的記錄
    if (onlineUsers.has(meetingId)) {
      onlineUsers.delete(meetingId);
    }
    
    return res.json({
      message: '參與者記錄清理完成',
      cleanedRecords: cleanupResult.rowCount
    });
    
  } catch (error) {
    console.error('❌ 清理參與者記錄失敗:', error);
    return res.status(500).json({
      error: '清理失敗',
      details: error.message
    });
  }
});



// 結束課程（開課者）+ 廣播 meeting-ended
app.post('/api/end-meeting/:meetingId', requireAuth, async (req, res) => {
  console.log('📝 收到舊版結束課程請求，重導向到新API');
  req.params.id = req.params.meetingId;
  
  // 重導向到新的 API 處理
  return app._router.handle({
    ...req,
    method: 'POST',
    url: `/api/meetings/${req.params.meetingId}/end`
  }, res);
});

// 改名（開課者）
app.put('/api/meetings/:id/title', requireAuth, async (req, res) => {
  const meetingId = req.params.id;
  const { title } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: '課程標題不能為空' });
  if (title.length > 200) return res.status(400).json({ error: '課程標題不能超過200個字符' });
  try {
    const m = (await pool.query('SELECT id, creator_id FROM meetings WHERE id=$1', [meetingId])).rows;
    if (m.length === 0) return res.status(404).json({ error: '課程不存在' });
    if (m[0].creator_id !== req.user.userId) return res.status(403).json({ error: '無權限訪問此課程' });

    const updated = (await pool.query('UPDATE meetings SET title=$1 WHERE id=$2 AND creator_id=$3 RETURNING id, title', [title.trim(), meetingId, req.user.userId])).rows[0];
    return res.json({ success: true, message: '課程標題更新成功', meetingId: Number(meetingId), title: updated.title });
  } catch (err) {
    console.error('更新課程標題錯誤:', err);
    return res.status(500).json({ error: '服務器內部錯誤', details: err.message });
  }
});

// 舊相容：POST /api/update-meeting/:meetingId → 走同一邏輯
app.post('/api/update-meeting/:meetingId', requireAuth, async (req, res) => {
  req.params.id = req.params.meetingId;
  return app._router.handle(req, res, () => {}, 'PUT', `/api/meetings/${req.params.meetingId}/title`);
});

// 刪除課程（開課者）
app.delete('/api/meetings/:id', requireAuth, async (req, res) => {
  const meetingId = req.params.id;
  const client = await pool.connect();
  try {
    const m = (await pool.query('SELECT creator_id, title, folder_id FROM meetings WHERE id=$1', [meetingId])).rows;
    if (m.length === 0) return res.status(404).json({ error: '課程不存在' });
    if (m[0].creator_id !== req.user.userId) return res.status(403).json({ error: '無權限刪除此課程' });

    await client.query('BEGIN');
    const delMsg = await client.query('DELETE FROM messages WHERE meeting_id=$1', [meetingId]);
    const delMeeting = await client.query('DELETE FROM meetings WHERE id=$1', [meetingId]);
    await client.query('COMMIT');

    return res.json({
      message: '課程記錄已成功刪除',
      deletedMeeting: { id: Number(meetingId), title: m[0].title, folderId: m[0].folder_id },
      deletedMessagesCount: delMsg.rowCount
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('刪除課程錯誤:', err);
    return res.status(500).json({ error: '刪除課程失敗', details: err.message });
  } finally { client.release(); }
});


require('dotenv').config();



// 產生 Azure Speech Token
app.get('/api/speech-token', async (req, res) => {
  try {
    const key = process.env.AZURE_SPEECH_KEY;
    const region = process.env.AZURE_SPEECH_REGION;
    const endpoint = process.env.AZURE_SPEECH_ENDPOINT; // ← 要有這行

    if (!key) {
      return res.status(500).json({ error: 'Missing AZURE_SPEECH_KEY' });
    }

    // 有 endpoint 就用 endpoint，沒有才用區域
    const tokenUrl = endpoint
      ? `${endpoint.replace(/\/$/, '')}/sts/v1.0/issueToken`
      : `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;

    const r = await axios.post(tokenUrl, null, {
      headers: { 'Ocp-Apim-Subscription-Key': key },
    });

    res.json({
      token: r.data,
      region,
      endpoint: endpoint
        ? endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '')
        : null,
    });
  } catch (err) {
    console.error('Error fetching speech token:', err.message);
    res.status(500).json({ error: 'Failed to fetch token' });
  }
});

// ← 新增這個
app.get('/api/speech-debug', (req, res) => {
  res.json({
    region: process.env.AZURE_SPEECH_REGION || null,
    endpoint: process.env.AZURE_SPEECH_ENDPOINT || null,
    hasKey: !!process.env.AZURE_SPEECH_KEY
  });
});

// ✅ 短網址 /join/<token> 轉回匿名 share 入口
app.get('/join/:token', (req, res) => {
  res.redirect(`/meeting.html?share=${req.params.token}`);
});

module.exports = app;

// -------------------------------------------------------------
// 轉錄（token 可選）
// -------------------------------------------------------------
async function insertTranscript(req, res) {
  const { meetingId, speaker, originalLanguage, originalText } = req.body;
  if (!meetingId || !originalText) return res.status(400).json({ error: '必填欄位缺失' });
  try {
    let userId = null;
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      try { userId = jwt.verify(token, JWT_SECRET).userId; } catch {}
    }
    const inserted = (await pool.query(
      `INSERT INTO messages (meeting_id, user_id, speaker, original_language, original_text)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [meetingId, userId, speaker || '發言者', originalLanguage || 'unknown', originalText]
    )).rows[0];
    return res.status(201).json({ message: '轉錄記錄已添加', messageId: inserted.id, transcriptId: inserted.id });
  } catch (err) {
    console.error('添加轉錄記錄失敗:', err);
    return res.status(500).json({ error: '伺服器錯誤，請稍後再試', details: err.message });
  }
}

app.post('/api/transcripts', insertTranscript);
app.post('/api/add-transcript', insertTranscript); // 舊相容

// -------------------------------------------------------------
// 翻譯 API（Azure Translator）
// -------------------------------------------------------------
app.post('/api/translate', async (req, res) => {
  const { text, from, source, source_language, to, target, target_language } = req.body || {};
  const sourceLanguage = from || source || source_language;
  const targetLanguage = to || target || target_language;

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: '翻譯文本是必填的且必須是字符串' });
  }
  if (!targetLanguage) {
    return res.status(400).json({ error: '目標語言是必填的', details: '請指定 to/target/target_language' });
  }
  if (text.trim().length === 0) return res.status(400).json({ error: '翻譯文本不能為空' });
  if (text.length > 10000) return res.status(400).json({ error: '翻譯文本過長', currentLength: text.length, maxLength: 10000 });
  if (!process.env.TRANSLATION_KEY || !process.env.TRANSLATION_REGION) {
    return res.status(500).json({ error: 'Azure 翻譯服務未配置', details: '請檢查 TRANSLATION_KEY / TRANSLATION_REGION' });
  }

  try {
    const normalizedSource = sourceLanguage ? normalizeLanguageCodeForAPI(sourceLanguage) : undefined;
    const normalizedTarget = normalizeLanguageCodeForAPI(targetLanguage);
    if (!normalizedTarget) return res.status(400).json({ error: '不支援的目標語言', targetLanguage, supportedLanguages: getSupportedLanguages() });

    const translationParams = { 'api-version': '3.0', to: normalizedTarget };
    if (normalizedSource) translationParams.from = normalizedSource;

    const response = await axios({
      baseURL: 'https://api.cognitive.microsofttranslator.com',
      url: '/translate',
      method: 'post',
      headers: {
        'Ocp-Apim-Subscription-Key': process.env.TRANSLATION_KEY,
        'Ocp-Apim-Subscription-Region': process.env.TRANSLATION_REGION,
        'Content-type': 'application/json',
        'X-ClientTraceId': crypto.randomUUID()
      },
      params: translationParams,
      data: [{ text: text.trim() }],
      timeout: 30000,
      validateStatus: (status) => status < 500,
    });

    if (response.status !== 200) {
      let errorMessage = '翻譯服務錯誤';
      if (response.status === 401) errorMessage = '翻譯服務認證失敗';
      else if (response.status === 403) errorMessage = '翻譯服務訪問被拒絕';
      else if (response.status === 429) errorMessage = '翻譯請求過於頻繁';
      return res.status(response.status).json({ error: errorMessage, azureError: response.data });
    }

    const body = response.data;
    if (!Array.isArray(body) || body.length === 0 || !body[0].translations || body[0].translations.length === 0) {
      return res.status(500).json({ error: '翻譯服務返回了無效的響應格式' });
    }

    const translation = body[0].translations[0];
    const detectedLanguage = body[0].detectedLanguage;

    return res.json({
      text: translation.text,
      translated_text: translation.text,
      translation: translation.text,
      from: detectedLanguage?.language || normalizedSource || 'unknown',
      to: normalizedTarget,
      confidence: detectedLanguage?.score || 1.0,
      originalText: text,
      success: true,
      processingTime: Date.now(),
      apiVersion: '3.0'
    });
  } catch (err) {
    let statusCode = 500;
    let errorMessage = '翻譯失敗';
    if (err.code === 'ECONNREFUSED') { statusCode = 503; errorMessage = '無法連接到翻譯服務'; }
    else if (err.code === 'ENOTFOUND') { statusCode = 503; errorMessage = '翻譯服務地址解析失敗'; }
    else if (String(err.message || '').includes('timeout')) { statusCode = 504; errorMessage = '翻譯請求超時'; }
    else if (err.response) { statusCode = err.response.status; errorMessage = `翻譯服務錯誤 (${statusCode})`; }
    return res.status(statusCode).json({ error: errorMessage, details: err.message });
  }
});

// -------------------------------------------------------------
// 摘要（HF + 本地備援，與原版相容）
// -------------------------------------------------------------
app.post('/api/summarize', async (req, res) => {
  const { text, target_language = 'zh-Hant' } = req.body || {};
  if (!text || text.length < 30) {
    return res.status(400).json({ error: '摘要文字不足，請提供更長的文字（至少30字）' });
  }

  // 預清理
  let cleanedText = text
    .split('\n')
    .map(line => line
      .replace(/^\*\*[^*]+\*\*\s*-\s*[^a-zA-Z\u4e00-\u9fff]*/, '')
      .replace(/^[^:]+:\s*/, '')
      .replace(/^\d{4}\/\d{1,2}\/\d{1,2}.*?zh-TW\s*/, '')
      .replace(/^[a-zA-Z0-9]+\s*-\s*\d{4}\/\d{1,2}\/\d{1,2}.*?zh-TW\s*/, '')
      .trim()
    )
    .filter(Boolean)
    .join(' ');

  const chineseRegex = /[\u4e00-\u9fff]/;
  const isChinese = chineseRegex.test(cleanedText);

  if (!process.env.HUGGINGFACE_API_KEY) {
    let localSummary = generateAdvancedLocalSummary(cleanedText);
    let modelUsed = 'local-fallback';
    if (localSummary && target_language !== 'zh-Hant' && target_language !== 'zh-Hans') {
      try {
        const azureLanguageCode = mapToAzureLanguageCode(target_language);
        const t = await axios.post(`${req.protocol}://${req.get('host')}/api/translate`, { text: localSummary, from: 'zh-TW', to: azureLanguageCode }, { timeout: 30000 });
        if (t.data?.text) { localSummary = t.data.text.trim(); modelUsed += ` + Azure翻譯 (${getLanguageName(target_language)})`; }
      } catch { modelUsed += ' (翻譯失敗，保持中文)'; }
    }
    return res.json({ summary: localSummary, originalLength: text.length, summaryLength: localSummary.length, compressionRatio: `${((1 - localSummary.length / text.length) * 100).toFixed(1)}%`, model: modelUsed, targetLanguage: target_language, generatedAt: new Date().toISOString(), processFlow: generateProcessFlow(isChinese, target_language) });
  }

  try {
    let finalSummary = '';
    let modelUsed = '';
    const textToSummarize = cleanedText.slice(0, 3000);

    if (isChinese) {
      const models = [
        { name: 'THUDM/chatglm3-6b', display: 'ChatGLM3-6B 中文對話模型', type: 'text-generation', params: { max_new_tokens: 250, temperature: 0.1, do_sample: true, top_p: 0.8, repetition_penalty: 1.1 }, prompt: (t) => `請對以下課程內容進行簡潔的摘要，重點突出主要內容和關鍵信息：\n\n${t}\n\n課程摘要：` },
        { name: 'THUDM/chatglm2-6b', display: 'ChatGLM2-6B 中文對話模型', type: 'text-generation', params: { max_new_tokens: 200, temperature: 0.2, do_sample: true, top_p: 0.85, repetition_penalty: 1.1 }, prompt: (t) => `總結以下內容的重點：\n\n${t}\n\n總結：` },
        { name: 'baichuan-inc/Baichuan2-7B-Chat', display: 'Baichuan2-7B 中文對話模型', type: 'text-generation', params: { max_new_tokens: 200, temperature: 0.3, do_sample: true, top_p: 0.9, repetition_penalty: 1.05 }, prompt: (t) => `請簡要總結以下內容：\n${t}\n\n摘要：` },
        { name: 'shibing624/text2vec-base-chinese', display: 'Text2Vec 中文文本處理模型', type: 'summarization', params: { max_length: 200, min_length: 50, do_sample: false, early_stopping: true, no_repeat_ngram_size: 3, length_penalty: 1.2 } },
        { name: 'uer/t5-base-chinese-cluecorpussmall', display: 'T5 中文基礎模型 (改進版)', type: 'summarization', params: { max_length: 180, min_length: 40, do_sample: false, early_stopping: true, no_repeat_ngram_size: 3, length_penalty: 1.1 }, prompt: (t) => `摘要: ${t}` },
        { name: 'ClueAI/ChatYuan-large-v2', display: 'ChatYuan V2 中文生成模型', type: 'text-generation', params: { max_new_tokens: 220, temperature: 0.2, do_sample: true, top_p: 0.85, repetition_penalty: 1.1 }, prompt: (t) => `用戶：請對下面的課程記錄做一個簡潔的摘要，突出重點內容：\n\n${t}\n\n助手：` },
      ];

      let success = false;
      for (const m of models) {
        try {
          let input = m.prompt ? m.prompt(textToSummarize) : textToSummarize;
          const resp = await axios.post(`https://api-inference.huggingface.co/models/${m.name}`,
            { inputs: input, parameters: m.params, options: { wait_for_model: true, use_cache: false } },
            { headers: { Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}` }, timeout: 150000 }
          );
          let out = '';
          if (m.type === 'summarization') {
            out = resp.data?.[0]?.summary_text || resp.data?.[0]?.generated_text || '';
          } else {
            out = resp.data?.[0]?.generated_text || '';
            if (m.prompt && out) {
              for (const part of ['課程摘要：','總結：','摘要：','助手：']) {
                if (out.includes(part)) { out = out.split(part)[1] || out; break; }
              }
              const originalStart = textToSummarize.slice(0, 100);
              if (out.includes(originalStart)) out = out.replace(textToSummarize, '').trim();
            }
          }
          out = String(out).trim().replace(/^(總結|摘要|課程摘要|重點|內容概要)[:：]\s*/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').replace(/^用戶：.*?助手：/g, '').replace(/^.*?助手：/g, '').trim();

          const chineseChars = out.split('').filter(ch => /[\u4e00-\u9fff]/.test(ch)).length;
          const valid = out && out.length >= 25 && out.length <= textToSummarize.length * 0.6 && !/模型正在載入|Model is loading|Error occurred|用戶：|助手：/.test(out) && out !== textToSummarize.trim() && !out.includes(textToSummarize.slice(0,50)) && chineseChars >= 10;
          if (valid) { finalSummary = out; modelUsed = m.display; success = true; break; }
        } catch (e) { /* 繼續嘗試下一個模型 */ }
      }

      if (!success) { finalSummary = generateAdvancedLocalSummary(textToSummarize); modelUsed = '智能本地摘要 (AI備案)'; }
    } else {
      // 英文：BART
      const resp = await axios.post(
        'https://api-inference.huggingface.co/models/facebook/bart-large-cnn',
        { inputs: cleanedText.slice(0, 3000), parameters: { max_length: 200, min_length: 50, do_sample: false, early_stopping: true, no_repeat_ngram_size: 3 }, options: { wait_for_model: true } },
        { headers: { Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}` }, timeout: 120000 }
      );
      finalSummary = resp.data?.[0]?.summary_text?.trim() || '';
      modelUsed = 'BART 英文摘要模型';
      if ((target_language === 'zh-Hant' || target_language === 'zh-Hans') && finalSummary) {
        try {
          const azureLang = target_language === 'zh-Hant' ? 'zh-TW' : 'zh-CN';
          const t = await axios.post(`${req.protocol}://${req.get('host')}/api/translate`, { text: finalSummary, from: 'en', to: azureLang }, { timeout: 30000 });
          if (t.data?.text) { finalSummary = t.data.text.trim(); modelUsed += ` + Azure翻譯 (${target_language})`; }
        } catch { modelUsed += ' (翻譯失敗，返回英文)'; }
      }
    }

    if (finalSummary && !/[。！？.!?]$/.test(finalSummary)) finalSummary += '。';
    if (finalSummary) {
      const sentences = finalSummary.split(/[。！？.!?]+/).filter(s => s.trim().length > 0);
      const unique = [...new Set(sentences)];
      if (unique.length < sentences.length) finalSummary = unique.join('。') + '。';
      finalSummary = finalSummary.replace(/\s+/g, ' ').trim();
    }

    if (finalSummary && target_language !== 'zh-Hant' && target_language !== 'zh-Hans') {
      try {
        const azureLang = mapToAzureLanguageCode(target_language);
        const t = await axios.post(`${req.protocol}://${req.get('host')}/api/translate`, { text: finalSummary, from: 'zh-TW', to: azureLang }, { timeout: 30000 });
        if (t.data?.text) { finalSummary = t.data.text.trim(); modelUsed += ` + Azure翻譯 (${getLanguageName(target_language)})`; }
      } catch { modelUsed += ' (翻譯失敗，保持中文)'; }
    }

    const compressionRatio = ((1 - finalSummary.length / text.length) * 100).toFixed(1);
    return res.json({ summary: finalSummary, originalLength: text.length, summaryLength: finalSummary.length, compressionRatio: `${compressionRatio}%`, model: modelUsed, targetLanguage: target_language, generatedAt: new Date().toISOString(), processFlow: generateProcessFlow(isChinese, target_language) });
  } catch (err) {
    const localSummary = generateAdvancedLocalSummary(cleanedText);
    let modelUsed = '智能本地摘要';
    if (localSummary && target_language !== 'zh-Hant' && target_language !== 'zh-Hans') {
      try {
        const azureLang = mapToAzureLanguageCode(target_language);
        const t = await axios.post(`${req.protocol}://${req.get('host')}/api/translate`, { text: localSummary, from: 'zh-TW', to: azureLang }, { timeout: 30000 });
        if (t.data?.text) { modelUsed += ` + Azure翻譯 (${getLanguageName(target_language)})`; return res.json({ summary: t.data.text.trim(), originalLength: text.length, summaryLength: t.data.text.trim().length, compressionRatio: `${((1 - t.data.text.trim().length / text.length) * 100).toFixed(1)}%`, model: modelUsed, targetLanguage: target_language, generatedAt: new Date().toISOString(), processFlow: generateProcessFlow(true, target_language), warning: `AI 摘要失敗，使用本地：${err.message}` }); }
      } catch {}
    }
    return res.json({ summary: localSummary, originalLength: text.length, summaryLength: localSummary.length, compressionRatio: `${((1 - localSummary.length / text.length) * 100).toFixed(1)}%`, model: modelUsed, targetLanguage: target_language, generatedAt: new Date().toISOString(), processFlow: generateProcessFlow(true, target_language), warning: `AI 摘要失敗，使用本地：${err.message}` });
  }
});

// -------------------------------------------------------------
// 工具函式（翻譯/摘要）
// -------------------------------------------------------------
function normalizeLanguageCodeForAPI(code) {
  if (!code) return null;
  const map = {
    'zh-Hant':'zh-TW', 'zh-Hans':'zh-CN', 'zh-TW':'zh-TW', 'zh-CN':'zh-CN', 'zh':'zh-CN',
    'en-US':'en','en-GB':'en','en-AU':'en','en-CA':'en','en':'en',
    'ja-JP':'ja','ja':'ja','ko-KR':'ko','ko':'ko','id-ID':'id','id':'id',
    'es':'es','fr':'fr','de':'de','it':'it','pt':'pt','ru':'ru','ar':'ar','hi':'hi','th':'th','vi':'vi','ms':'ms','tr':'tr','pl':'pl','nl':'nl','sv':'sv','da':'da','no':'no','fi':'fi','cs':'cs','sk':'sk','hu':'hu','ro':'ro','bg':'bg','hr':'hr','sl':'sl','et':'et','lv':'lv','lt':'lt','uk':'uk','be':'be','fa':'fa','he':'he','bn':'bn','ta':'ta','te':'te','mr':'mr','gu':'gu','kn':'kn','ml':'ml','pa':'pa','ur':'ur','ne':'ne','si':'si','my':'my','km':'km','lo':'lo','sw':'sw','zu':'zu','af':'af'
  };
  const n = map[code];
  if (n) return n;
  const primary = String(code).split('-')[0].toLowerCase();
  return map[primary] || null;
}

function getSupportedLanguages() {
  return ['zh-TW','zh-CN','en','ja','ko','es','fr','de','it','pt','ru','ar','hi','th','vi','id','ms','tr','pl','nl','sv','da','no','fi','cs','sk','hu','ro','bg','hr','sl','et','lv','lt','uk','be','fa','he','bn','ta','te','mr','gu','kn','ml','pa','ur','ne','si','my','km','lo','sw','zu','af'];
}

function mapToAzureLanguageCode(langCode) {
  const m = {
    'zh-Hant':'zh-TW','zh-Hans':'zh-CN','en':'en','es':'es','fr':'fr','de':'de','it':'it','pt':'pt','ru':'ru','nl':'nl','sv':'sv','da':'da','no':'no','fi':'fi','ja':'ja','ko':'ko','th':'th','vi':'vi','id':'id','ms':'ms','my':'my','km':'km','lo':'lo','hi':'hi','bn':'bn','ta':'ta','te':'te','mr':'mr','gu':'gu','kn':'kn','ml':'ml','pa':'pa','ur':'ur','ne':'ne','si':'si','ar':'ar','fa':'fa','he':'he','tr':'tr','sw':'sw','zu':'zu','af':'af','pl':'pl','cs':'cs','sk':'sk','hu':'hu','ro':'ro','bg':'bg','hr':'hr','sl':'sl','et':'et','lv':'lv','lt':'lt','uk':'uk','be':'be'
  };
  return m[langCode] || langCode;
}

function getLanguageName(langCode) {
  const m = { 'zh-Hant':'繁體中文','zh-Hans':'簡體中文','en':'英文','es':'西班牙文','fr':'法文','de':'德文','it':'義大利文','pt':'葡萄牙文','ru':'俄文','nl':'荷蘭文','sv':'瑞典文','da':'丹麥文','no':'挪威文','fi':'芬蘭文','ja':'日文','ko':'韓文','th':'泰文','vi':'越南文','id':'印尼文','ms':'馬來文','my':'緬甸文','km':'柬埔寨文','lo':'寮文','hi':'印地文','bn':'孟加拉文','ta':'泰米爾文','te':'泰盧固文','mr':'馬拉地文','gu':'古吉拉特文','kn':'卡納達文','ml':'馬拉雅拉姆文','pa':'旁遮普文','ur':'烏爾都文','ne':'尼泊爾文','si':'僧加羅文','ar':'阿拉伯文','fa':'波斯文','he':'希伯來文','tr':'土耳其文','sw':'斯瓦希里文','zu':'祖魯文','af':'南非荷蘭文','pl':'波蘭文','cs':'捷克文','sk':'斯洛伐克文','hu':'匈牙利文','ro':'羅馬尼亞文','bg':'保加利亞文','hr':'克羅埃西亞文','sl':'斯洛維尼亞文','et':'愛沙尼亞文','lv':'拉脫維亞文','lt':'立陶宛文','uk':'烏克蘭文','be':'白俄羅斯文' };
  return m[langCode] || langCode;
}

function generateProcessFlow(isChinese, targetLanguage) {
  const isTargetChinese = targetLanguage === 'zh-Hant' || targetLanguage === 'zh-Hans';
  if (isChinese) {
    const flow = ['中文原文','新一代中文AI模型','智能後處理'];
    if (isTargetChinese) flow.push('完成'); else flow.push(`Azure翻譯→${getLanguageName(targetLanguage)}`,'完成');
    return flow;
  } else {
    const flow = ['英文原文','英文摘要模型'];
    if (targetLanguage === 'en') flow.push('完成'); else flow.push(`Azure翻譯→${getLanguageName(targetLanguage)}`,'完成');
    return flow;
  }
}

function generateAdvancedLocalSummary(text) {
  try {
    const cleanText = text
      .split('\n')
      .map(line => line
        .replace(/^\*\*[^*]+\*\*\s*-\s*[^a-zA-Z\u4e00-\u9fff]*/, '')
        .replace(/^[^:]+:\s*/, '')
        .replace(/^\d{4}\/\d{1,2}\/\d{1,2}.*?zh-TW\s*/, '')
        .replace(/^[a-zA-Z0-9]+\s*-\s*\d{4}\/\d{1,2}\/\d{1,2}.*?zh-TW\s*/, '')
        .trim()
      )
      .filter(Boolean)
      .join(' ');
    if (cleanText.length < 20) return '課程內容過短，無法生成摘要。';
    const sentences = cleanText.split(/[。！？.!?]+/).map(s => s.trim()).filter(s => s.length > 3);
    if (sentences.length === 0) return '課程內容無法解析，請查看完整記錄。';
    const keywordWeights = { '故事':2,'告訴':2,'寓意':3,'教訓':3,'啟示':3,'問題':1.5,'解決':1.5,'方法':1.5,'建議':1.5,'重要':2,'關鍵':2,'主要':1.5,'核心':2,'結果':1.5,'結論':2,'總結':2,'最後':1.5,'但是':1.5,'然而':1.5,'因此':2,'所以':2 };
    const scored = sentences.map((s, i) => {
      let score = 1;
      if (i === 0) score += 1.5; if (i === sentences.length - 1) score += 2; if (i === Math.floor(sentences.length/2)) score += 1;
      if (s.length >= 10 && s.length <= 50) score += 1;
      Object.keys(keywordWeights).forEach(k => { if (s.includes(k)) score += keywordWeights[k]; });
      return { s, i, score };
    }).sort((a,b)=>b.score-a.score);
    let selected = [];
    if (sentences.length <= 3) selected = sentences; else if (sentences.length <= 6) selected = scored.slice(0,3).map(x=>x.s); else selected = scored.slice(0,4).map(x=>x.s);
    const ordered = sentences.filter(s => selected.includes(s));
    return ordered.join('，') + '。';
  } catch (e) { return '課程已記錄，請查看完整內容了解詳情。'; }
}

// -------------------------------------------------------------
// 啟動伺服器
// -------------------------------------------------------------
server.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const lanIPs = [];
  Object.keys(nets).forEach((name) => {
    nets[name].forEach((net) => {
      if (net.family === 'IPv4' && !net.internal) lanIPs.push(net.address);
    });
  });

  
  const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

const START_PORT = Number(process.env.PORT) || 3000;

function start(port, retries = 5) {
  server.listen(port, () => {
    console.log('🎧 Server listening');
    console.log(`   Local:   http://localhost:${port}`);
    console.log(`   Local:   http://127.0.0.1:${port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && retries > 0) {
      console.warn(`⚠️  Port ${port} 已被占用，改試 ${port + 1} ...`);
      // 移除這次 error 監聽，避免重複綁定
      server.removeAllListeners('error');
      // 建立新的 server 物件再嘗試（避免已綁定的舊實例）
      const http2 = require('http');
      const newServer = http2.createServer(app);
      // 重新掛 socket.io
      const { Server } = require('socket.io');
      const io2 = new Server(newServer, { cors: { origin: true, credentials: true } });
      // 用新的 server 取代舊的引用
      global.server = newServer;
      global.io = io2;
      // 再試下一個埠
      start(port + 1, retries - 1);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
}

start(START_PORT);

});