// Service Worker — NES Arcade PWA
// Self-destruct old caches on activate, cache fresh on install

const CACHE_NAME = 'nes-arcade-v4';

const ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/galaga.nes',
  '/js/main.js',
  '/js/nes-worker.js',
  '/js/WorkerBridge.js',
  '/js/RendererWorker.js',
  '/js/AudioEngineWorker.js',
  '/js/ROMLoader.js',
  '/js/vendor/jsnes.min.js',
  '/js/vendor/ringbuf.js',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap',
];

// Install — precache all assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch — cache-first for precached assets, network-first for everything else
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetch(event.request).then((response) => {
        // Cache successful GET responses (fonts, etc.)
        if (response.ok && event.request.method === 'GET' && new URL(event.request.url).origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(() => {
        // Offline fallback — return index for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});
