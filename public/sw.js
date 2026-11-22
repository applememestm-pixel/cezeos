const cacheName = 'cezeos-shell-v6';
const shell = ['/', '/style.css', '/app.js', '/icons.js', '/controls.js', '/assets/aquamarine.png', '/assets/icon.svg', '/assets/icon-192.png', '/assets/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('cezeos-shell-') && key !== cacheName).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.well-known/') || url.pathname==='/healthz')) return;
  event.respondWith(fetch(event.request).catch(async () => {
    const saved = await caches.match(event.request);
    return saved || (event.request.mode === 'navigate' ? await caches.match('/') : Response.error());
  }));
});
