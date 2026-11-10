const CACHE_NAME = 'school-news-shell-v2';
const DATA_CACHE = 'school-news-data-v1';
const SHELL = [
  './',
  './styles.css?v=6',
  './app.js?v=5',
  './manifest.json',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/splash-1170x2532.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => ![CACHE_NAME, DATA_CACHE].includes(key)).map(key => caches.delete(key)),
    )).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  const url = new URL(request.url);
  const isData = url.pathname.endsWith('/data/version.json') || url.pathname.endsWith('/data/articles.json');
  if (isData) {
    event.respondWith(
      fetch(new Request(request, {cache: 'no-store'})).then(response => {
        if (response.ok) caches.open(DATA_CACHE).then(cache => cache.put(request, response.clone()));
        return response;
      }).catch(() => caches.match(request).then(response => response || Response.error())),
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
      return response;
    }).catch(() => caches.match(request)));
    return;
  }

  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
    return response;
  })));
});
