# CLAUDE.md — Viewer IFC (PWA iPhone)

Ce fichier oriente Claude Code (et tout contributeur) sur ce dépôt. Lis-le avant
d'intervenir.

## Objectif

PWA (Progressive Web App) de **visualisation IFC utilisable sur iPhone** (Safari),
installable sur l'écran d'accueil, fonctionnant hors connexion après le premier
chargement. L'utilisateur importe un `.ifc`/`.ifczip` depuis l'app **Fichiers**
d'iOS et explore la maquette en 3D au doigt.

Public : architecte / BIM Manager **non-développeur**. Toute consigne Git ou
déploiement doit être expliquée pas à pas, sans jargon non défini.

## Stack (versions figées au build, à revérifier avant toute mise à jour)

- **Parsing IFC** : `web-ifc` 0.0.77 (gère IFC2x3 **et** IFC4.x). Dépôt amont :
  `ThatOpen/engine_web-ifc`.
- **Rendu 3D** : `Three.js` 0.185.1 + `OrbitControls` (import
  `three/addons/controls/OrbitControls.js`).
- **Décompression `.ifczip`** : `fflate` 0.8.2 (chargé paresseusement).
- ⚠️ **Ne pas** réintroduire `web-ifc-three` ni `web-ifc-viewer` (abandonnés
  ~2024, remplacés par l'écosystème ThatOpen).

### Dépendances vendorisées (pas de CDN à l'exécution)

Toutes les libs vivent dans `vendor/` (copiées depuis npm, pas de fetch CDN au
runtime). Raison : offline PWA fiable, pas de dépendance réseau tierce, pas de
blocage CORS. Pour mettre à jour une version :

```
npm install three@<v> web-ifc@<v> fflate@<v>
cp node_modules/three/build/three.module.js        vendor/
cp node_modules/three/build/three.core.js          vendor/   # three.module importe three.core
cp node_modules/three/examples/jsm/controls/OrbitControls.js vendor/
cp node_modules/web-ifc/web-ifc-api.js             vendor/
cp node_modules/web-ifc/web-ifc.wasm               vendor/
cp node_modules/fflate/esm/browser.js              vendor/fflate.js
```

Puis mettre à jour les numéros de version cités dans ce fichier, `index.html`
(commentaire de l'import map) et `js/ifc-worker.js`. **Bumper `CACHE`** dans
`service-worker.js` (`ifc-viewer-vN`) pour invalider l'ancien cache.

## Architecture des fichiers

```
index.html            Coquille : canvas, UI, import map (→ vendor/), méta viewport iOS
css/styles.css        Responsive vertical/paysage, safe-area iOS, anti-zoom natif
js/app.js             Thread principal : scène Three.js, OrbitControls tactile, UI, PWA
js/ifc-worker.js      Web Worker (module) : web-ifc + WASM, extraction géométrie
manifest.webmanifest  Manifest PWA (standalone, icônes)
service-worker.js     Cache offline (app shell + vendor/ en cache-first)
vendor/               three, web-ifc(.wasm), OrbitControls, fflate (vendorisés)
icons/                icon-192/512, maskable, apple-touch-icon (cube isométrique)
.nojekyll             Empêche GitHub Pages de filtrer les fichiers
```

## Contraintes iOS critiques (ne pas casser)

1. **Mémoire = facteur limitant.** Safari tue WebContent bien avant ~2 Go, sans
   exception JS interceptable (crash/rechargement silencieux). Gestion
   **préventive** uniquement : `performance.memory` n'existe pas sur iOS.
   - Parsing dans un **Worker**, géométrie **regroupée par couleur** (moins de
     draw calls / objets), modèle web-ifc **fermé** (`CloseModel`) et géométries
     WASM **libérées** (`geom.delete()`) dès l'extraction.
   - `renderer.setPixelRatio(min(dpr, 2))` pour plafonner le coût GPU.
2. **Seuils de taille** : < 20 Mo fiable partout ; 20–50 Mo OK sur iPhone récent ;
   **> 50 Mo → avertissement** avant tentative (voir `WARN_SIZE_MB` dans app.js).
   Au-delà, la vraie solution est la conversion Fragments (Phase 2, non faite).
3. **Import de fichiers** : l'`<input type="file">` **n'a pas d'attribut `accept`**
   (un filtre MIME grise les `.ifc` dans Fichiers iOS). On filtre l'extension en JS.
   Pas de File System Access API ni de « Ouvrir avec » sur iOS : import manuel.
4. **Gestes tactiles** : `touch-action: none` sur le canvas, viewport
   `user-scalable=no, maximum-scale=1`, `gesturestart/change/end` et double-tap
   neutralisés, `overscroll-behavior: none` (anti pull-to-refresh). 1 doigt =
   rotation, 2 doigts = zoom + pan (`controls.touches`).
5. **Hébergement HTTPS obligatoire** (GitHub Pages) : le `.wasm` est chargé par
   fetch (cassé en `file://`), et PWA + service worker exigent HTTPS.

## Déploiement

GitHub Pages sur la branche par défaut, dossier racine (`/`). Le `.nojekyll` est
nécessaire. Après un push, Pages se met à jour en 1–2 min. Voir `README.md` pour
le pas-à-pas destiné à l'utilisateur.

## Phase 2 (non implémentée — ne pas construire à l'aveugle)

Conversion IFC → **Fragments** (`@thatopen/fragments`) côté client pour les gros
fichiers (> ~50 Mo), cache du `.frag` en IndexedDB/OPFS, chargement progressif.
À n'entamer **qu'après** retour terrain sur les tailles de fichiers réelles de
l'utilisateur. Vérifier alors la compatibilité croisée des versions
(`three`, `web-ifc`) dans les peer dependencies.

## Vérification (avant de pousser une modif non triviale)

Un test Playwright headless (Chromium) valide le pipeline complet
(parse → rendu → recentrage → orbite → cycle import/fermer/ré-import → paysage).
Servir le dossier en HTTP local (les dépendances sont vendorisées, aucun CDN
requis) et piloter avec un iPhone émulé. Ne jamais se fier au seul typecheck :
observer le rendu réel.
