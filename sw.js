const CACHE_NAME = 'reagan-it-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/dashboard.html',
  '/admin-simple.html',
  '/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});