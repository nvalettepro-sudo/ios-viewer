// ============================================================================
//  app.js — Thread principal : scène Three.js, contrôles tactiles, UI, PWA.
// ============================================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Numéro de version affiché en haut à gauche (permet de vérifier quelle
// version est réellement chargée, notamment après un cache PWA). À incrémenter
// à chaque changement visible ; garder en phase avec le cache du service worker.
const APP_VERSION = 'v3';

// Seuil d'avertissement mémoire (voir contraintes iOS du brief).
const WARN_SIZE_MB = 50;

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

// -- Three.js -----------------------------------------------------------------
let renderer, scene, camera, controls, modelGroup, grid;
let hasModel = false;

function initThree() {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: window.devicePixelRatio < 2, // AA coûteux ; inutile sur écrans Retina denses
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // plafonne le coût GPU/mémoire
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  scene = new THREE.Scene();
  scene.background = null; // laisse le dégradé CSS du canvas visible

  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 5000);
  camera.position.set(12, 10, 14);

  // Lumières : hémisphère (ambiance) + directionnelle (relief)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x36404d, 1.1));
  const dir = new THREE.DirectionalLight(0xffffff, 1.5);
  dir.position.set(1, 2, 1.5);
  scene.add(dir);
  const dir2 = new THREE.DirectionalLight(0xffffff, 0.5);
  dir2.position.set(-1, 0.5, -1);
  scene.add(dir2);

  // -- OrbitControls calibré pour le tactile iOS ----------------------------
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.rotateSpeed = 0.9;
  controls.zoomSpeed = 1.1;
  controls.panSpeed = 0.8;
  controls.screenSpacePanning = true;
  // 1 doigt = rotation orbitale ; 2 doigts = pincer (zoom) + glisser (pan)
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN,
  };

  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 200));

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}

// -- Construction du modèle à partir des buffers du worker --------------------
function buildModel(meshes) {
  disposeModel();

  modelGroup = new THREE.Group();
  // web-ifc renvoie déjà la géométrie en Y-up (comme Three.js) : il applique
  // lui-même la conversion depuis le Z-up de l'IFC. On n'ajoute donc AUCUNE
  // rotation ici — en rajouter une couchait le modèle sur le côté.

  for (const m of meshes) {
    const geo = new THREE.BufferGeometry();
    // Buffer interleavé [px,py,pz,nx,ny,nz] : deux attributs sur le même ArrayBuffer
    const interleaved = new THREE.InterleavedBuffer(m.positionsNormals, 6);
    geo.setAttribute('position', new THREE.InterleavedBufferAttribute(interleaved, 3, 0));
    geo.setAttribute('normal', new THREE.InterleavedBufferAttribute(interleaved, 3, 3));
    geo.setIndex(new THREE.BufferAttribute(m.index, 1));

    const transparent = m.opacity < 0.98;
    const mat = new THREE.MeshLambertMaterial({
      color: new THREE.Color(m.color[0], m.color[1], m.color[2]),
      side: THREE.DoubleSide, // winding IFC parfois incohérent → évite les faces manquantes
      transparent,
      opacity: transparent ? m.opacity : 1,
      depthWrite: !transparent,
    });
    modelGroup.add(new THREE.Mesh(geo, mat));
  }

  scene.add(modelGroup);
  hasModel = true;
  addGrid();
  fitCamera();
}

function addGrid() {
  const box = new THREE.Box3().setFromObject(modelGroup);
  const size = box.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.z, 1);
  const divisions = 20;
  grid = new THREE.GridHelper(span * 1.6, divisions, 0x3a4250, 0x2a303a);
  grid.position.y = box.min.y;
  scene.add(grid);
}

function fitCamera() {
  const box = new THREE.Box3().setFromObject(modelGroup);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;

  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = (radius / Math.sin(fov / 2)) * 1.25;

  const d = new THREE.Vector3(1, 0.7, 1).normalize();
  camera.position.copy(center).addScaledVector(d, dist);
  camera.near = Math.max(dist / 1000, 0.01);
  camera.far = dist * 1000;
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.update();
}

function disposeModel() {
  if (modelGroup) {
    modelGroup.traverse((o) => {
      if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); }
    });
    scene.remove(modelGroup);
    modelGroup = null;
  }
  if (grid) { grid.geometry.dispose(); grid.material.dispose(); scene.remove(grid); grid = null; }
  hasModel = false;
  if (renderer) renderer.renderLists.dispose();
}

// -- Worker IFC ---------------------------------------------------------------
let worker = null;
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./ifc-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'status') {
      setLoading(d.title, d.detail);
    } else if (d.type === 'done') {
      onParsed(d);
    } else if (d.type === 'error') {
      hideAll();
      showToast('Erreur : ' + d.message, true);
      updateActions();
    }
  };
  worker.onerror = (e) => {
    hideAll();
    showToast('Erreur du moteur IFC : ' + (e.message || 'inconnue'), true);
  };
  return worker;
}

function onParsed(d) {
  try {
    buildModel(d.meshes);
    const s = d.stats;
    $('stat-name').textContent = d.fileName || 'Modèle';
    $('stat-meta').textContent =
      `${s.elements.toLocaleString('fr')} élts · ${s.triangles.toLocaleString('fr')} triangles`;
    statusbar.classList.remove('hidden');
    hideAll();
    updateActions();
    if (s.groups === 0) showToast('Aucune géométrie affichable dans ce fichier.', true);
  } catch (err) {
    hideAll();
    showToast('Erreur d\'affichage : ' + err.message, true);
  }
}

// -- Chargement d'un fichier --------------------------------------------------
function handleFile(file) {
  if (!file) return;
  const name = file.name || '';
  if (!/\.(ifc|ifczip)$/i.test(name)) {
    showToast('Veuillez choisir un fichier .ifc ou .ifczip.', true);
    return;
  }
  const sizeMB = file.size / (1024 * 1024);
  if (sizeMB > WARN_SIZE_MB) {
    $('warn-text').textContent =
      `Ce fichier fait ${sizeMB.toFixed(0)} Mo. Le seuil fiable sur iPhone est d'environ ${WARN_SIZE_MB} Mo.`;
    warn.classList.remove('hidden');
    warn._pending = file;
    return;
  }
  startLoad(file);
}

function startLoad(file) {
  welcome.classList.add('hidden');
  warn.classList.add('hidden');
  setLoading('Lecture du fichier…', file.name);
  loading.classList.remove('hidden');

  const reader = new FileReader();
  reader.onload = () => {
    const buffer = reader.result; // ArrayBuffer
    getWorker().postMessage({ type: 'load', buffer, fileName: file.name }, [buffer]);
  };
  reader.onerror = () => {
    hideAll();
    showToast('Impossible de lire le fichier.', true);
  };
  reader.readAsArrayBuffer(file);
}

// -- UI helpers ---------------------------------------------------------------
function setLoading(title, detail) {
  $('loading-title').textContent = title || 'Chargement…';
  $('loading-detail').textContent = detail || '';
  // Barre "pulsée" faute de progression fiable côté web-ifc
  const bar = $('progress-bar');
  const cur = parseFloat(bar.style.width) || 5;
  bar.style.width = Math.min(cur + 12, 90) + '%';
}
function hideAll() {
  loading.classList.add('hidden');
  warn.classList.add('hidden');
  $('progress-bar').style.width = '0%';
}
let toastTimer;
function showToast(msg, isError) {
  toast.textContent = msg;
  toast.classList.toggle('error', !!isError);
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 5000);
}
function updateActions() {
  btnFit.disabled = !hasModel;
  btnClear.disabled = !hasModel;
}

// -- Neutralisation des gestes natifs Safari (zoom/double-tap) ----------------
function blockNativeGestures() {
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) =>
    canvas.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
  // Double-tap zoom
  let lastTap = 0;
  canvas.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTap < 300) e.preventDefault();
    lastTap = now;
  }, { passive: false });
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
}

// -- Wiring des boutons -------------------------------------------------------
function openPicker() { fileInput.value = ''; fileInput.click(); }
$('btn-open').addEventListener('click', openPicker);
$('btn-open-2').addEventListener('click', openPicker);
fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

btnFit.addEventListener('click', () => { if (hasModel) fitCamera(); });
btnClear.addEventListener('click', () => {
  disposeModel();
  statusbar.classList.add('hidden');
  welcome.classList.remove('hidden');
  updateActions();
});

$('warn-cancel').addEventListener('click', () => { warn.classList.add('hidden'); warn._pending = null; });
$('warn-continue').addEventListener('click', () => {
  const f = warn._pending; warn._pending = null;
  if (f) startLoad(f);
});

// -- Service worker (offline après 1er chargement) ----------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {/* silencieux */});
  });
}

// -- Démarrage ----------------------------------------------------------------
$('build-tag').textContent = APP_VERSION;
initThree();
blockNativeGestures();
updateActions();
