/* 生活费记账 —— Service Worker
   1) 预缓存 app shell，离线可用
   2) 导航请求：先返回缓存秒开，后台静默更新（下次打开生效）
   3) 拦截 Web Share Target 的 POST，把账单文件暂存到 IndexedDB 后跳转导入页
*/
const VERSION = '2026.10.05a';
const CACHE = 'ledger-' + VERSION;
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function putSharedFile(file) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('pocket-ledger', 1);
    open.onsuccess = () => {
      const tx = open.result.transaction('shareInbox', 'readwrite');
      tx.objectStore('shareInbox').put({
        id: 's-' + Date.now() + '-' + Math.random().toString(16).slice(2),
        name: file.name || 'shared.csv',
        blob: file,
        ts: Date.now()
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // Web Share Target：系统分享进来的账单文件
  if (req.method === 'POST') {
    e.respondWith((async () => {
      try {
        const form = await req.formData();
        const file = form.get('bill');
        if (file) await putSharedFile(file);
      } catch (err) { /* 忽略，仍然跳转到导入页 */ }
      return new Response(null, { status: 303, headers: { Location: './index.html#/import' } });
    })());
    return;
  }

  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then((cached) => {
        const net = fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        }).catch(() => cached);
        return cached || net;
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((c) => c || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((ch) => ch.put(req, copy));
      return res;
    }))
  );
});
