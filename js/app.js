// ============================================================================
//  app.js — Thread principal : scène Three.js, contrôles tactiles, UI, PWA.
//  Fonctions de revue : sélection + propriétés, arborescence étages/catégories
//  avec visibilité, colorisation, vues prédéfinies, plein écran.
// ============================================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Numéro de version affiché en haut à gauche (diagnostic de cache PWA).
// À incrémenter à chaque changement visible ; garder en phase avec le SW.
const APP_VERSION = 'v5';

// Seuil d'avertissement mémoire par défaut ; s'ajuste ensuite via MEM.
const WARN_SIZE_MB = 50;

// -- Apprentissage du plafond mémoire de l'appareil ---------------------------
const MEM = {
  _get(k) { try { const v = parseFloat(localStorage.getItem(k)); return isNaN(v) ? null : v; } catch { return null; } },
  _set(k, v) { try { localStorage.setItem(k, String(v)); } catch {} },
  setPending(name, sizeMB) { try { localStorage.setItem('ifcv-pending', JSON.stringify({ name, sizeMB, t: Date.now() })); } catch {} },
  clearPending() { try { localStorage.removeItem('ifcv-pending'); } catch {} },
  readPending() { try { return JSON.parse(localStorage.getItem('ifcv-pending') || 'null'); } catch { return null; } },
  recordSuccess(sizeMB) { const cur = MEM._get('ifcv-maxok') || 0; if (sizeMB > cur) MEM._set('ifcv-maxok', Math.round(sizeMB)); },
  recordCrash(sizeMB) { const cur = MEM._get('ifcv-crash'); if (cur == null || sizeMB < cur) MEM._set('ifcv-crash', Math.round(sizeMB)); },
  maxOk() { return MEM._get('ifcv-maxok'); },
  crashAt() { return MEM._get('ifcv-crash'); },
};
let currentLoad = null;

// -- Éléments DOM -------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const canvas = $('viewport');
const fileInput = $('file-input');
const welcome = $('welcome');
const loading = $('loading');
const warn = $('warn');
const toast = $('toast');
const statusbar = $('statusbar');
const btnFit = $('btn-fit');
const btnClear = $('btn-clear');
const btnPanel = $('btn-panel');
const panel = $('panel');
const propsPanel = $('props');

// -- Three.js -----------------------------------------------------------------
let renderer, scene, camera, controls, modelGroup, grid;
let hasModel = false;

// -- État du modèle courant ---------------------------------------------------
// MODEL.groups[i] = { mesh, geo, elements, origColors(Uint8), liveColors(Uint8),
//                     fullIndex(Uint32), faceElement(Uint32), curFaceElement, catIndex }
let MODEL = null;
let colorMode = 'category';      // 'category' | 'storey' | 'original'
let catVisible = [];             // par index de catégorie
let storeyVisible = [];          // par index d'étage ; dernier slot = « non assigné »
let selected = null;             // { groupIdx, elemIdx }
let pendingPropId = null;
const SEL_RGB = [64, 200, 255];  // cyan de surbrillance

function initThree() {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: window.devicePixelRatio < 2,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  scene = new THREE.Scene();
  scene.background = null;

  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 5000);
  camera.position.set(12, 10, 14);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x36404d, 1.1));
  const dir = new THREE.DirectionalLight(0xffffff, 1.5); dir.position.set(1, 2, 1.5); scene.add(dir);
  const dir2 = new THREE.DirectionalLight(0xffffff, 0.5); dir2.position.set(-1, 0.5, -1); scene.add(dir2);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.rotateSpeed = 0.9;
  controls.zoomSpeed = 1.1;
  controls.panSpeed = 0.8;
  controls.screenSpacePanning = true;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 200));

  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}

// -- Palettes -----------------------------------------------------------------
function paletteColor(i) { const c = new THREE.Color(); c.setHSL((i * 0.61803398875) % 1, 0.55, 0.6); return c; }
function storeyPalette(i, n) { const c = new THREE.Color(); c.setHSL(n > 1 ? (i / n) * 0.8 : 0.6, 0.6, 0.55); return c; }

// -- Construction du modèle ---------------------------------------------------
function buildModel(d) {
  disposeModel();
  modelGroup = new THREE.Group();
  // web-ifc renvoie déjà la géométrie en Y-up : aucune rotation ici.

  const groups = [];
  d.groups.forEach((g) => {
    const geo = new THREE.BufferGeometry();
    const inter = new THREE.InterleavedBuffer(g.positionsNormals, 6);
    geo.setAttribute('position', new THREE.InterleavedBufferAttribute(inter, 3, 0));
    geo.setAttribute('normal', new THREE.InterleavedBufferAttribute(inter, 3, 3));

    const liveColors = g.colors.slice(); // buffer VIVANT, réécrit selon le mode
    const colorAttr = new THREE.BufferAttribute(liveColors, 3, true); // Uint8 normalisé
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('color', colorAttr);
    geo.setIndex(new THREE.BufferAttribute(g.index, 1));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.groupIdx = groups.length;
    modelGroup.add(mesh);

    // faceElement : pour chaque triangle, l'index local d'élément (picking).
    const faceElement = new Uint32Array(g.index.length / 3);
    g.elements.forEach((el, ei) => {
      const t0 = el.iStart / 3, t1 = (el.iStart + el.iCount) / 3;
      for (let t = t0; t < t1; t++) faceElement[t] = ei;
    });

    groups.push({
      mesh, geo, elements: g.elements, origColors: g.colors, liveColors,
      fullIndex: g.index, faceElement, curFaceElement: faceElement, catIndex: g.categoryIndex,
    });
  });
  scene.add(modelGroup);

  const catColors = d.categories.map((_, i) => paletteColor(i));
  const nStorey = d.storeys.length;
  const storeyColors = d.storeys.map((_, i) => storeyPalette(i, nStorey));

  MODEL = {
    groups, categories: d.categories, storeys: d.storeys, meta: d.meta,
    catColors, storeyColors, unassigned: new THREE.Color(0x888888),
  };
  catVisible = d.categories.map(() => true);
  storeyVisible = new Array(nStorey + 1).fill(true); // dernier = non assigné
  selected = null;
  hasModel = true;

  applyColorMode();
  addGrid();
  setView('iso');
  buildTree();
}

function applyColorMode() {
  if (!MODEL) return;
  for (const g of MODEL.groups) {
    const live = g.liveColors;
    if (colorMode === 'original') {
      live.set(g.origColors);
    } else {
      for (const el of g.elements) {
        let col;
        if (colorMode === 'category') col = MODEL.catColors[g.catIndex];
        else col = el.storeyIdx >= 0 ? MODEL.storeyColors[el.storeyIdx] : MODEL.unassigned;
        const r = col.r * 255, gg = col.g * 255, b = col.b * 255;
        const s = el.vStart * 3, e = (el.vStart + el.vCount) * 3;
        for (let k = s; k < e; k += 3) { live[k] = r; live[k + 1] = gg; live[k + 2] = b; }
      }
    }
    g.geo.getAttribute('color').needsUpdate = true;
  }
  reapplySelectionTint();
}

function reapplySelectionTint() {
  if (!selected || !MODEL) return;
  const g = MODEL.groups[selected.groupIdx];
  const el = g.elements[selected.elemIdx];
  const live = g.liveColors;
  const s = el.vStart * 3, e = (el.vStart + el.vCount) * 3;
  for (let k = s; k < e; k += 3) { live[k] = SEL_RGB[0]; live[k + 1] = SEL_RGB[1]; live[k + 2] = SEL_RGB[2]; }
  g.geo.getAttribute('color').needsUpdate = true;
}

function rebuildVisibility() {
  if (!MODEL) return;
  const uSlot = storeyVisible.length - 1;
  for (const g of MODEL.groups) {
    if (!catVisible[g.catIndex]) { g.mesh.visible = false; continue; }
    let anyHidden = false;
    for (const el of g.elements) {
      const sv = el.storeyIdx >= 0 ? storeyVisible[el.storeyIdx] : storeyVisible[uSlot];
      if (!sv) { anyHidden = true; break; }
    }
    if (!anyHidden) {
      g.mesh.visible = true;
      if (g.geo.getIndex().array !== g.fullIndex) g.geo.setIndex(new THREE.BufferAttribute(g.fullIndex, 1));
      g.curFaceElement = g.faceElement;
      continue;
    }
    let total = 0;
    for (const el of g.elements) {
      const sv = el.storeyIdx >= 0 ? storeyVisible[el.storeyIdx] : storeyVisible[uSlot];
      if (sv) total += el.iCount;
    }
    if (total === 0) { g.mesh.visible = false; continue; }
    const ni = new Uint32Array(total);
    const nf = new Uint32Array(total / 3);
    let o = 0, fo = 0;
    g.elements.forEach((el, ei) => {
      const sv = el.storeyIdx >= 0 ? storeyVisible[el.storeyIdx] : storeyVisible[uSlot];
      if (!sv) return;
      ni.set(g.fullIndex.subarray(el.iStart, el.iStart + el.iCount), o);
      o += el.iCount;
      const tc = el.iCount / 3;
      for (let t = 0; t < tc; t++) nf[fo++] = ei;
    });
    g.mesh.visible = true;
    g.geo.setIndex(new THREE.BufferAttribute(ni, 1));
    g.curFaceElement = nf;
  }
}

function addGrid() {
  const box = new THREE.Box3().setFromObject(modelGroup);
  const size = box.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.z, 1);
  grid = new THREE.GridHelper(span * 1.6, 20, 0x3a4250, 0x2a303a);
  grid.position.y = box.min.y;
  scene.add(grid);
}

function setView(kind) {
  if (!modelGroup) return;
  const box = new THREE.Box3().setFromObject(modelGroup);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = (radius / Math.sin(fov / 2)) * 1.25;
  let dir;
  if (kind === 'top') dir = new THREE.Vector3(0, 1, 0.0001);
  else if (kind === 'front') dir = new THREE.Vector3(0, 0, 1);
  else if (kind === 'side') dir = new THREE.Vector3(1, 0, 0);
  else dir = new THREE.Vector3(1, 0.7, 1);
  dir.normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = Math.max(dist / 1000, 0.01);
  camera.far = dist * 1000;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

function disposeModel() {
  if (modelGroup) {
    modelGroup.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    scene.remove(modelGroup); modelGroup = null;
  }
  if (grid) { grid.geometry.dispose(); grid.material.dispose(); scene.remove(grid); grid = null; }
  MODEL = null; selected = null; hasModel = false;
  hideProperties();
  if (renderer) renderer.renderLists.dispose();
}

// -- Sélection / picking ------------------------------------------------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function pickAt(clientX, clientY) {
  if (!MODEL) return;
  ndc.x = (clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const meshes = MODEL.groups.filter((g) => g.mesh.visible).map((g) => g.mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  if (!hits.length) { clearSelection(); return; }
  const h = hits[0];
  const gi = h.object.userData.groupIdx;
  const ei = MODEL.groups[gi].curFaceElement[h.faceIndex];
  selectElement(gi, ei);
}

function selectElement(groupIdx, elemIdx) {
  selected = { groupIdx, elemIdx };
  applyColorMode(); // restaure toutes les couleurs puis re-teinte la sélection
  const el = MODEL.groups[groupIdx].elements[elemIdx];
  showProperties(el.expressID);
}

function clearSelection() {
  if (!selected) return;
  selected = null;
  applyColorMode();
  hideProperties();
}

// -- Propriétés ---------------------------------------------------------------
function showProperties(expressID) {
  const meta = (MODEL.meta && MODEL.meta[expressID]) || ['', '', -1, ''];
  const [name, cat, storeyIdx, gid] = meta;
  const storeyName = storeyIdx >= 0 && MODEL.storeys[storeyIdx] ? MODEL.storeys[storeyIdx].name : 'Non assigné';
  $('prop-title').textContent = name || cat || ('Élément ' + expressID);
  $('prop-sub').textContent = `${cat || '—'} · ${storeyName}`;
  $('prop-id').textContent = gid ? ('IFC ' + gid) : ('#' + expressID);
  $('prop-sets').innerHTML = '<p class="muted small">Chargement des propriétés…</p>';
  propsPanel.classList.remove('hidden');
  pendingPropId = expressID;
  getWorker().postMessage({ type: 'properties', expressID });
}

function renderProperties(d) {
  if (d.expressID !== pendingPropId) return;
  const host = $('prop-sets');
  if (!d.sets || !d.sets.length) { host.innerHTML = '<p class="muted small">Aucune propriété.</p>'; return; }
  host.innerHTML = '';
  for (const ps of d.sets) {
    const sec = document.createElement('div'); sec.className = 'pset';
    const h = document.createElement('div'); h.className = 'pset-name'; h.textContent = ps.name; sec.appendChild(h);
    for (const [k, v] of ps.props) {
      const row = document.createElement('div'); row.className = 'pset-row';
      const kk = document.createElement('span'); kk.className = 'pk'; kk.textContent = k;
      const vv = document.createElement('span'); vv.className = 'pv'; vv.textContent = v;
      row.appendChild(kk); row.appendChild(vv); sec.appendChild(row);
    }
    host.appendChild(sec);
  }
}

function hideProperties() { propsPanel.classList.add('hidden'); pendingPropId = null; }

// -- Arborescence (étages + catégories) ---------------------------------------
function makeToggle(label, on, cb, swatchColor) {
  const row = document.createElement('label'); row.className = 'tg';
  const cbx = document.createElement('input'); cbx.type = 'checkbox'; cbx.checked = on;
  cbx.addEventListener('change', () => cb(cbx.checked));
  row.appendChild(cbx);
  if (swatchColor) { const s = document.createElement('span'); s.className = 'swatch'; s.style.background = '#' + swatchColor.getHexString(); row.appendChild(s); }
  const sp = document.createElement('span'); sp.className = 'tg-label'; sp.textContent = label; row.appendChild(sp);
  return row;
}

function buildTree() {
  const stHost = $('tree-storeys'); stHost.innerHTML = '';
  if (MODEL.storeys.length === 0) stHost.innerHTML = '<p class="muted small">Aucun étage déclaré.</p>';
  MODEL.storeys.forEach((s, i) => {
    stHost.appendChild(makeToggle(`${s.name} (${s.elevation.toFixed(2)} m)`, true, (on) => { storeyVisible[i] = on; rebuildVisibility(); },
      colorMode === 'storey' ? MODEL.storeyColors[i] : null));
  });

  const catHost = $('tree-cats'); catHost.innerHTML = '';
  MODEL.categories.forEach((c, i) => {
    catHost.appendChild(makeToggle(`${c.label} (${c.count})`, true, (on) => { catVisible[i] = on; rebuildVisibility(); }, MODEL.catColors[i]));
  });
}

function setColorMode(mode) {
  colorMode = mode;
  document.querySelectorAll('.cmode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  applyColorMode();
  if (MODEL) buildTree(); // rafraîchit les pastilles étage/catégorie
}

// -- Plein écran --------------------------------------------------------------
const fsEl = document.documentElement;
const canFullscreen = !!(fsEl.requestFullscreen || fsEl.webkitRequestFullscreen);
function toggleFullscreen() {
  const doc = document;
  const isFs = doc.fullscreenElement || doc.webkitFullscreenElement;
  if (!isFs) { (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen).call(fsEl); }
  else { (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc); }
}

// -- Worker IFC ---------------------------------------------------------------
let worker = null;
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./ifc-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'status') setLoading(d.title, d.detail);
    else if (d.type === 'done') onParsed(d);
    else if (d.type === 'properties') renderProperties(d);
    else if (d.type === 'error') { MEM.clearPending(); hideAll(); showToast('Erreur : ' + d.message, true); updateActions(); }
  };
  worker.onerror = (e) => { MEM.clearPending(); hideAll(); showToast('Erreur du moteur IFC : ' + (e.message || 'inconnue'), true); };
  return worker;
}

function onParsed(d) {
  try {
    buildModel(d);
    const s = d.stats;
    $('stat-name').textContent = d.fileName || 'Modèle';
    $('stat-meta').textContent =
      `${s.elements.toLocaleString('fr')} élts · ${s.categories} catég. · ${s.triangles.toLocaleString('fr')} triangles`;
    statusbar.classList.remove('hidden');
    hideAll();
    updateActions();
    if (s.categories === 0) showToast('Aucune géométrie affichable dans ce fichier.', true);

    requestAnimationFrame(() => requestAnimationFrame(() => {
      MEM.clearPending();
      if (currentLoad) MEM.recordSuccess(currentLoad.sizeMB);
      updateDeviceNote();
    }));
  } catch (err) {
    MEM.clearPending(); hideAll(); showToast('Erreur d\'affichage : ' + err.message, true);
  }
}

// -- Chargement d'un fichier --------------------------------------------------
function handleFile(file) {
  if (!file) return;
  const name = file.name || '';
  if (!/\.(ifc|ifczip)$/i.test(name)) { showToast('Veuillez choisir un fichier .ifc ou .ifczip.', true); return; }
  const sizeMB = file.size / (1024 * 1024);
  const maxOk = MEM.maxOk();
  const crashAt = MEM.crashAt();
  const provenOk = maxOk != null && sizeMB <= maxOk;
  const risky = !provenOk && (sizeMB > WARN_SIZE_MB || (crashAt != null && sizeMB >= crashAt * 0.9));
  if (risky) {
    let txt = `Ce fichier fait ${sizeMB.toFixed(0)} Mo.`;
    if (crashAt != null) txt += ` Une maquette de ${Math.round(crashAt)} Mo a déjà fait planter l'app sur cet appareil.`;
    else txt += ` Le seuil prudent est d'environ ${WARN_SIZE_MB} Mo.`;
    if (maxOk != null) txt += ` Plus gros modèle chargé avec succès ici : ${Math.round(maxOk)} Mo.`;
    $('warn-text').textContent = txt;
    warn.classList.remove('hidden'); warn._pending = file;
    return;
  }
  startLoad(file);
}

function startLoad(file) {
  const sizeMB = file.size / (1024 * 1024);
  currentLoad = { name: file.name, sizeMB };
  MEM.setPending(file.name, sizeMB);
  welcome.classList.add('hidden');
  warn.classList.add('hidden');
  closePanel();
  setLoading('Lecture du fichier…', file.name);
  loading.classList.remove('hidden');
  const reader = new FileReader();
  reader.onload = () => getWorker().postMessage({ type: 'load', buffer: reader.result, fileName: file.name }, [reader.result]);
  reader.onerror = () => { hideAll(); showToast('Impossible de lire le fichier.', true); };
  reader.readAsArrayBuffer(file);
}

// -- UI helpers ---------------------------------------------------------------
function setLoading(title, detail) {
  $('loading-title').textContent = title || 'Chargement…';
  $('loading-detail').textContent = detail || '';
  const bar = $('progress-bar');
  const cur = parseFloat(bar.style.width) || 5;
  bar.style.width = Math.min(cur + 12, 90) + '%';
}
function hideAll() { loading.classList.add('hidden'); warn.classList.add('hidden'); $('progress-bar').style.width = '0%'; }
let toastTimer;
function showToast(msg, isError, duration) {
  toast.textContent = msg;
  toast.classList.toggle('error', !!isError);
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), duration || 5000);
}
function updateDeviceNote() {
  const el = $('device-note'); if (!el) return;
  const maxOk = MEM.maxOk(), crashAt = MEM.crashAt();
  const parts = [];
  if (maxOk != null) parts.push(`jusqu'à ${maxOk} Mo chargés avec succès`);
  if (crashAt != null) parts.push(`plantage constaté dès ${crashAt} Mo`);
  el.textContent = parts.length ? `Sur cet appareil : ${parts.join(' · ')}.` : '';
}
function checkPreviousCrash() {
  const p = MEM.readPending(); if (!p) return;
  MEM.clearPending();
  const age = Date.now() - (p.t || 0);
  if (age < 5 * 60 * 1000 && p.sizeMB) {
    MEM.recordCrash(p.sizeMB); updateDeviceNote();
    showToast(`⚠️ La dernière ouverture de « ${p.name} » (${Math.round(p.sizeMB)} Mo) a fait planter l'app : ` +
      `cet appareil manque de mémoire pour un fichier de cette taille. Essaie un modèle plus léger.`, true, 12000);
  }
}
function updateActions() {
  btnFit.disabled = !hasModel; btnClear.disabled = !hasModel; btnPanel.disabled = !hasModel;
  if (!hasModel) closePanel();
}

// -- Panneau latéral ----------------------------------------------------------
function togglePanel() { panel.classList.toggle('open'); }
function closePanel() { panel.classList.remove('open'); }

// -- Gestes natifs + tap pour sélectionner ------------------------------------
function blockNativeGestures() {
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) =>
    canvas.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
  let lastTap = 0;
  canvas.addEventListener('touchend', (e) => { const now = Date.now(); if (now - lastTap < 300) e.preventDefault(); lastTap = now; }, { passive: false });
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
}

// Détection d'un « tap » (sélection) distinct d'un glissé (rotation).
const activePointers = new Set();
let tapStart = null;
canvas.addEventListener('pointerdown', (e) => {
  activePointers.add(e.pointerId);
  tapStart = activePointers.size === 1 ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
});
canvas.addEventListener('pointerup', (e) => {
  activePointers.delete(e.pointerId);
  if (tapStart) {
    const moved = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y);
    if (moved < 8 && Date.now() - tapStart.t < 350) pickAt(e.clientX, e.clientY);
  }
  tapStart = null;
});
canvas.addEventListener('pointercancel', (e) => { activePointers.delete(e.pointerId); tapStart = null; });

// -- Wiring des boutons -------------------------------------------------------
function openPicker() { fileInput.value = ''; fileInput.click(); }
$('btn-open').addEventListener('click', openPicker);
$('btn-open-2').addEventListener('click', openPicker);
fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

btnFit.addEventListener('click', () => { if (hasModel) setView('iso'); });
btnPanel.addEventListener('click', togglePanel);
$('panel-close').addEventListener('click', closePanel);
$('prop-close').addEventListener('click', clearSelection);

btnClear.addEventListener('click', () => {
  disposeModel();
  if (worker) worker.postMessage({ type: 'close' });
  statusbar.classList.add('hidden');
  welcome.classList.remove('hidden');
  closePanel();
  updateActions();
});

document.querySelectorAll('.viewbtn').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
document.querySelectorAll('.cmode').forEach((b) => b.addEventListener('click', () => setColorMode(b.dataset.mode)));

const btnFs = $('btn-fullscreen');
if (canFullscreen) btnFs.addEventListener('click', toggleFullscreen);
else btnFs.style.display = 'none';

$('warn-cancel').addEventListener('click', () => { warn.classList.add('hidden'); warn._pending = null; });
$('warn-continue').addEventListener('click', () => { const f = warn._pending; warn._pending = null; if (f) startLoad(f); });

// -- Service worker -----------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(() => {}));
}

// -- Démarrage ----------------------------------------------------------------
$('build-tag').textContent = APP_VERSION;
initThree();
blockNativeGestures();
updateActions();
updateDeviceNote();
checkPreviousCrash();
