self.addEventListener('install', (e) => {
  console.log('PWA Service Worker 已安裝');
});

self.addEventListener('fetch', (e) => {
  // 基本轉發，維持在線功能
  e.respondWith(fetch(e.request));
});