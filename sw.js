/* Offline support: the whole app is cached on install and served from the cache.
   Bump VERSION on every deploy — that is what makes phones pick up the new files. */
const VERSION = 'dance-mix-v2'; // keep the number in step with APP_VERSION in js/app.js
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './js/app.js',
  './js/engine.js',
  './js/player.js',
  './js/store.js',
  './js/exporter.js',
  './js/icons.js',
  './vendor/mp4-muxer.js',
  './manifest.webmanifest',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', event => {
  // cache: 'reload' skips the browser's own copy (GitHub Pages lets it keep files for 10 minutes),
  // so a new version never gets cached with the previous version's files.
  const fresh = ASSETS.map(url => new Request(url, { cache: 'reload' }));
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
});
