// ===================== 資料庫連接診斷和修復 =====================

const { Pool } = require('pg');
const net = require('net');

// 1. 網路連通性測試函數
async function testNetworkConnection(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = 5000; // 5秒超時
    
    socket.setTimeout(timeout);
    
    socket.on('connect', () => {
      console.log(`✅ 網路連接成功: ${host}:${port}`);
      socket.destroy();
      resolve(true);
    });
    
    socket.on('timeout', () => {
      console.log(`❌ 連接超時: ${host}:${port}`);
      socket.destroy();
      resolve(false);
    });
    
    socket.on('error', (err) => {
      console.log(`❌ 網路連接失敗: ${host}:${port} - ${err.message}`);
      resolve(false);
    });
    
    socket.connect(port, host);
  });
}

// 2. 多種資料庫配置選項
const dbConfigs = [
  {
    name: '遠程資料庫 (原配置)',
    config: {
      user: 'postgres',
      host: '10.243.218.119',
      database: 'test02',
      password: '1234',
      port: 5432,
      connectionTimeoutMillis: 5000,
    }
  },
  {
    name: '本地資料庫',
    config: {
      user: 'postgres',
      host: 'localhost',
      database: 'test02',
      password: '1234',
      port: 5432,
      connectionTimeoutMillis: 5000,
    }
  },
  {
    name: '本地資料庫 (127.0.0.1)',
    config: {
      user: 'postgres',
      host: '127.0.0.1',
      database: 'test02',
      password: '1234',
      port: 5432,
      connectionTimeoutMillis: 5000,
    }
  },
  {
    name: '本地資料庫 (預設資料庫)',
    config: {
      user: 'postgres',
      host: 'localhost',
      database: 'postgres', // 使用預設資料庫
      password: '1234',
      port: 5432,
      connectionTimeoutMillis: 5000,
    }
  }
];

// 3. 測試資料庫連接的函數
async function testDatabaseConnection(config) {
  const pool = new Pool(config);
  
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT version(), current_database(), current_user');
    
    console.log(`✅ 資料庫連接成功!`);
    console.log(`   版本: ${result.rows[0].version.split(' ')[0]}`);
    console.log(`   資料庫: ${result.rows[0].current_database}`);
    console.log(`   用戶: ${result.rows[0].current_user}`);
    
    client.release();
    await pool.end();
    return true;
  } catch (error) {
    console.log(`❌ 資料庫連接失敗: ${error.message}`);
    await pool.end();
    return false;
  }
}

// 4. 檢查資料庫和表是否存在
async function checkDatabaseStructure(config) {
  const pool = new Pool(config);
  
  try {
    const client = await pool.connect();
    
    // 檢查資料庫是否存在
    const dbCheck = await client.query(`
      SELECT datname FROM pg_catalog.pg_database 
      WHERE datname = 'test02'
    `);
    
    if (dbCheck.rows.length === 0) {
      console.log('❌ 資料庫 test02 不存在');
      console.log('💡 請執行: CREATE DATABASE test02;');
    } else {
      console.log('✅ 資料庫 test02 存在');
    }
    
    // 檢查表是否存在
    const tablesCheck = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('users', 'meetings', 'messages')
    `);
    
    const existingTables = tablesCheck.rows.map(row => row.table_name);
    const requiredTables = ['users', 'meetings', 'messages'];
    const missingTables = requiredTables.filter(table => !existingTables.includes(table));
    
    console.log(`現有表: ${existingTables.join(', ') || '無'}`);
    if (missingTables.length > 0) {
      console.log(`❌ 缺少表: ${missingTables.join(', ')}`);
    } else {
      console.log('✅ 所有必要的表都存在');
    }
    
    client.release();
    await pool.end();
    
  } catch (error) {
    console.log(`❌ 檢查資料庫結構失敗: ${error.message}`);
    await pool.end();
  }
}

// 5. 主要診斷函數
async function diagnoseDatabaseConnection() {
  console.log('🔍 開始資料庫連接診斷...\n');
  
  for (let i = 0; i < dbConfigs.length; i++) {
    const { name, config } = dbConfigs[i];
    console.log(`--- 測試 ${i + 1}: ${name} ---`);
    
    // 先測試網路連接
    const networkOk = await testNetworkConnection(config.host, config.port);
    
    if (networkOk) {
      // 網路通了，測試資料庫連接
      const dbOk = await testDatabaseConnection(config);
      
      if (dbOk) {
        console.log(`🎉 找到可用的資料庫配置: ${name}`);
        console.log('建議使用以下配置:');
        console.log(JSON.stringify(config, null, 2));
        
        // 檢查資料庫結構
        await checkDatabaseStructure(config);
        return config;
      }
    }
    
    console.log(''); // 空行分隔
  }
  
  console.log('❌ 所有配置都無法連接');
  return null;
}

// 6. 創建資料庫和表的 SQL
const createDatabaseSQL = `
-- 如果需要創建資料庫 (在 postgres 資料庫中執行)
CREATE DATABASE test02;

-- 切換到 test02 資料庫後執行以下命令:

-- 創建用戶表
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    full_name VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

-- 創建會議表
CREATE TABLE IF NOT EXISTS meetings (
    id SERIAL PRIMARY KEY,
    creator_id INTEGER REFERENCES users(id),
    title VARCHAR(255) NOT NULL,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP,
    active_speaker_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 創建消息表
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    meeting_id INTEGER REFERENCES meetings(id),
    user_id INTEGER REFERENCES users(id),
    speaker VARCHAR(100),
    original_language VARCHAR(10),
    translated_language VARCHAR(10),
    original_text TEXT NOT NULL,
    translated_text TEXT,
    timestamp TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 創建索引
CREATE INDEX IF NOT EXISTS idx_meetings_creator ON meetings(creator_id);
CREATE INDEX IF NOT EXISTS idx_messages_meeting ON messages(meeting_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
`;

// 7. 修復後的連接池配置
function createOptimizedPool(config) {
  return new Pool({
    ...config,
    max: 20,                    // 最大連接數
    idleTimeoutMillis: 30000,   // 空閒超時
    connectionTimeoutMillis: 2000, // 連接超時
    ssl: false,                 // 本地連接不需要 SSL
  });
}

// 執行診斷
if (require.main === module) {
  diagnoseDatabaseConnection().then((workingConfig) => {
    if (workingConfig) {
      console.log('\n📋 建議的修復步驟:');
      console.log('1. 更新你的 .env 文件或直接修改配置');
      console.log('2. 如果資料庫不存在，請執行創建 SQL');
      console.log('3. 重新啟動你的應用程序');
      
      console.log('\n📄 創建資料庫和表的 SQL:');
      console.log(createDatabaseSQL);
    } else {
      console.log('\n🛠️  可能的解決方案:');
      console.log('1. 確保 PostgreSQL 已安裝並運行');
      console.log('2. 檢查用戶名和密碼是否正確');
      console.log('3. 確認網路連接和防火牆設置');
      console.log('4. 考慮使用本地資料庫 (localhost)');
    }
  });
}

module.exports = {
  diagnoseDatabaseConnection,
  testDatabaseConnection,
  createOptimizedPool,
  dbConfigs
};