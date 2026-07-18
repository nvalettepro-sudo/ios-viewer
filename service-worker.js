// ============================================================================
//  service-worker.js — Cache offline (app shell + dépendances vendorisées).
//  Stratégie :
//   - Code de l'app (HTML, CSS, JS) : RÉSEAU d'abord → les mises à jour
//     arrivent immédiatement quand on est en ligne ; repli cache si offline.
//   - Grosses libs vendor/ + wasm + icônes : CACHE d'abord (rapide, offline,
//     elles changent rarement).
//  Après le 1er chargement en ligne, l'app fonctionne hors connexion.
// ============================================================================
const CACHE = 'ifc-viewer-v3';

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

// Le code de l'app doit se rafraîchir dès qu'on est en ligne (sinon la PWA
// installée reste bloquée sur une ancienne version en cache).
function isAppCode(url) {
  return url.pathname.endsWith('.html')
      || url.pathname.endsWith('/')
      || url.pathname.includes('/js/')
      || url.pathname.includes('/css/')
      || url.pathname.endsWith('manifest.webmanifest');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin) return;

  // Navigations + code de l'app : RÉSEAU d'abord, repli cache si hors ligne.
  if (req.mode === 'navigate' || isAppCode(url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match('./index.html')))
    );
    return;
  }

  // Reste (vendor/, wasm, icônes) : CACHE d'abord, puis réseau (mise en cache).
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
