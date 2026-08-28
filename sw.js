// Network-first service worker: always prefer a fresh network response and
// only fall back to the cache when offline. Deliberately NOT cache-first —
// this app already hit a stale-cache bug once (mismatched index.html/app.js
// after a deploy) and a cache-first strategy would reintroduce that risk on
// every future deploy.
const CACHE_NAME = 'egeszseg-dashboard-v1';
const SHELL_FILES = ['./', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('push', (event) => {
  let data = { title: 'Egészség Dashboard', body: '' };
  try { if (event.data) data = event.data.json(); } catch (err) { /* ignore malformed payload */ }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Egészség Dashboard', {
      body: data.body || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png'
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      if (clients.length) return clients[0].focus();
      return self.clients.openWindow('./index.html');
    })
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
