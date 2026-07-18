// ============================================================================
//  service-worker.js — Cache offline (app shell + dépendances CDN).
//  Après le 1er chargement en ligne, l'app fonctionne hors connexion.
// ============================================================================
const CACHE = 'ifc-viewer-v2';

// Coquille locale à pré-cacher lors de l'installation.
// web-ifc-api.js (~5,9 Mo) et web-ifc.wasm (~1,3 Mo) sont vendorisés : chargés
// paresseusement par le worker, on les met en cache à la volée (pas au install
// pour ne pas ralentir la 1re ouverture) via la stratégie cache-first ci-dessous.
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/ifc-worker.js',
  './vendor/three.module.js',
  './vendor/three.core.js',
  './vendor/OrbitControls.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Navigations : réseau d'abord, repli sur l'index en cache (offline).
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Assets locaux (dont /vendor/ volumineux) : cache d'abord, puis réseau
  // (et on met en cache au passage pour les prochaines ouvertures offline).
  if (sameOrigin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          // On ne met en cache que les réponses exploitables.
          if (res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        });
      })
    );
  }
});
