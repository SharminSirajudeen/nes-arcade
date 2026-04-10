// Service Worker — Galaga Arcade PWA
// Caches all assets for offline play including the ROM

const CACHE_NAME = 'galaga-arcade-v1';

const ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/galaga.nes',
  '/js/main.js',
  '/js/EmulatorCore.js',
  '/js/Renderer.js',
  '/js/AudioEngine.js',
  '/js/InputHandler.js',
  '/js/MemoryHacker.js',
  '/js/ROMLoader.js',
  '/js/StateManager.js',
  '/js/PaletteFix.js',
  '/manifest.json',
  'https://unpkg.com/jsnes@2.0.0/dist/jsnes.min.js',
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
        if (response.ok && event.request.method === 'GET') {
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
