// ============================================================================
//  ifc-worker.js — Parsing IFC hors du thread principal (web-ifc + WASM)
//  Extrait toute la géométrie, la regroupe par couleur, transforme en
//  coordonnées monde, et renvoie des buffers transférables à app.js.
// ============================================================================

// Dépendances vendorisées localement (versions au build : web-ifc 0.0.77, fflate 0.8.2).
// URLs absolues résolues depuis l'emplacement du worker (import maps ne s'appliquent
// pas aux workers → on utilise des chemins explicites vers /vendor/).
const WEBIFC_API_URL = new URL('../vendor/web-ifc-api.js', import.meta.url).href;
const WEBIFC_BASE = new URL('../vendor/', import.meta.url).href; // dossier contenant web-ifc.wasm
const FFLATE_URL = new URL('../vendor/fflate.js', import.meta.url).href;

let IfcAPI = null;
let ifcAPI = null;

function post(type, payload, transfer) {
  self.postMessage({ type, ...payload }, transfer || []);
}

// -- Initialisation paresseuse du moteur web-ifc (une seule fois) -------------
async function ensureEngine() {
  if (ifcAPI) return;
  post('status', { title: 'Préparation du moteur IFC…', detail: 'Chargement du module WASM' });
  const mod = await import(WEBIFC_API_URL);
  IfcAPI = mod.IfcAPI;
  ifcAPI = new IfcAPI();
  // true => chemin absolu ; web-ifc ira chercher web-ifc.wasm à cette URL
  ifcAPI.SetWasmPath(WEBIFC_BASE, true);
  await ifcAPI.Init();
}

// -- Décompression .ifczip si nécessaire --------------------------------------
async function maybeUnzip(uint8, fileName) {
  const isZip = uint8.length > 3 && uint8[0] === 0x50 && uint8[1] === 0x4b; // "PK"
  const looksZipName = /\.ifczip$/i.test(fileName || '');
  if (!isZip && !looksZipName) return uint8;

  post('status', { title: 'Décompression…', detail: 'Extraction de l\'archive IFCZIP' });
  const { unzipSync } = await import(FFLATE_URL);
  const files = unzipSync(uint8);
  const entry = Object.keys(files).find((n) => /\.ifc$/i.test(n));
  if (!entry) throw new Error('Aucun fichier .ifc trouvé dans l\'archive IFCZIP.');
  return files[entry];
}

// -- Accumulateur de buffers extensibles (évite les gros tableaux JS) ---------
class GrowFloat {
  constructor() { this.buf = new Float32Array(1024); this.len = 0; }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + n) cap *= 2;
    const nb = new Float32Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  pushTransformedVerts(verts, m) {
    // verts : [px,py,pz, nx,ny,nz] * N  (6 floats/sommet). m : matrice 4x4 col-major
    const count = verts.length / 6;
    this.ensure(count * 6);
    const out = this.buf;
    let o = this.len;
    for (let i = 0; i < count; i++) {
      const b = i * 6;
      const px = verts[b], py = verts[b + 1], pz = verts[b + 2];
      const nx = verts[b + 3], ny = verts[b + 4], nz = verts[b + 5];
      // Position en coordonnées monde
      out[o]     = m[0] * px + m[4] * py + m[8] * pz + m[12];
      out[o + 1] = m[1] * px + m[5] * py + m[9] * pz + m[13];
      out[o + 2] = m[2] * px + m[6] * py + m[10] * pz + m[14];
      // Normale (partie rotation 3x3, puis renormalisation)
      let tx = m[0] * nx + m[4] * ny + m[8] * nz;
      let ty = m[1] * nx + m[5] * ny + m[9] * nz;
      let tz = m[2] * nx + m[6] * ny + m[10] * nz;
      const l = Math.hypot(tx, ty, tz) || 1;
      out[o + 3] = tx / l; out[o + 4] = ty / l; out[o + 5] = tz / l;
      o += 6;
    }
    this.len = o;
  }
}
class GrowUint {
  constructor() { this.buf = new Uint32Array(1024); this.len = 0; }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint32Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  pushIndices(indices, offsetVerts) {
    this.ensure(indices.length);
    const out = this.buf;
    let o = this.len;
    for (let i = 0; i < indices.length; i++) out[o++] = indices[i] + offsetVerts;
    this.len = o;
  }
}

function colorKey(c) {
  // Quantifie la couleur pour regrouper (réduit le nombre de meshes → mémoire)
  const q = (v) => Math.round(v * 255);
  return `${q(c.x)},${q(c.y)},${q(c.z)},${Math.round(c.w * 100)}`;
}

// -- Traitement d'un fichier IFC ----------------------------------------------
async function processIFC(buffer, fileName) {
  await ensureEngine();

  let uint8 = new Uint8Array(buffer);
  uint8 = await maybeUnzip(uint8, fileName);

  post('status', { title: 'Ouverture du modèle…', detail: 'Analyse de la structure IFC' });

  const modelID = ifcAPI.OpenModel(uint8, {
    COORDINATE_TO_ORIGIN: true, // recentre les modèles à grandes coordonnées géo
  });

  // Groupes indexés par couleur : { key -> {r,g,b,a, verts:GrowFloat, index:GrowUint, vcount} }
  const groups = new Map();
  let meshCount = 0;
  let triCount = 0;

  post('status', { title: 'Extraction de la géométrie…', detail: '0 objet' });

  ifcAPI.StreamAllMeshes(modelID, (flatMesh) => {
    const placed = flatMesh.geometries;
    const n = placed.size();
    for (let i = 0; i < n; i++) {
      const pg = placed.get(i);
      const geom = ifcAPI.GetGeometry(modelID, pg.geometryExpressID);

      const vptr = geom.GetVertexData();
      const vsize = geom.GetVertexDataSize();
      const iptr = geom.GetIndexData();
      const isize = geom.GetIndexDataSize();
      if (vsize === 0 || isize === 0) { geom.delete(); continue; }

      const verts = ifcAPI.GetVertexArray(vptr, vsize);   // vue Float32 sur le heap WASM
      const indices = ifcAPI.GetIndexArray(iptr, isize);  // vue Uint32 sur le heap WASM

      const c = pg.color;
      const key = colorKey(c);
      let g = groups.get(key);
      if (!g) {
        g = { r: c.x, g: c.y, b: c.z, a: c.w, verts: new GrowFloat(), index: new GrowUint(), vcount: 0 };
        groups.set(key, g);
      }
      const offset = g.vcount;
      g.verts.pushTransformedVerts(verts, pg.flatTransformation);
      g.index.pushIndices(indices, offset);
      g.vcount += verts.length / 6;
      triCount += indices.length / 3;

      geom.delete(); // libère la géométrie côté WASM immédiatement
    }
    meshCount++;
    if (meshCount % 150 === 0) {
      post('status', { title: 'Extraction de la géométrie…', detail: `${meshCount} éléments` });
    }
  });

  ifcAPI.CloseModel(modelID); // libère la mémoire WASM du modèle

  // -- Sérialisation des groupes en buffers transférables ---------------------
  const meshes = [];
  const transfer = [];
  const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };

  for (const g of groups.values()) {
    if (g.vcount === 0) continue;
    // Copies compactes (taille exacte) — les GrowArray sont sur-alloués
    const positionsNormals = g.verts.buf.slice(0, g.verts.len);
    const index = g.index.buf.slice(0, g.index.len);

    // Bounding box globale (à partir des positions monde)
    for (let i = 0; i < positionsNormals.length; i += 6) {
      const x = positionsNormals[i], y = positionsNormals[i + 1], z = positionsNormals[i + 2];
      if (x < bbox.min[0]) bbox.min[0] = x; if (x > bbox.max[0]) bbox.max[0] = x;
      if (y < bbox.min[1]) bbox.min[1] = y; if (y > bbox.max[1]) bbox.max[1] = y;
      if (z < bbox.min[2]) bbox.min[2] = z; if (z > bbox.max[2]) bbox.max[2] = z;
    }

    meshes.push({
      color: [g.r, g.g, g.b],
      opacity: g.a,
      positionsNormals,       // Float32 interleavé [px,py,pz,nx,ny,nz]
      index,                  // Uint32
    });
    transfer.push(positionsNormals.buffer, index.buffer);
  }

  post('done', {
    meshes,
    bbox,
    stats: { groups: meshes.length, elements: meshCount, triangles: Math.round(triCount) },
    fileName,
  }, transfer);
}

// -- Routage des messages -----------------------------------------------------
self.onmessage = async (e) => {
  const { type } = e.data;
  if (type === 'load') {
    try {
      await processIFC(e.data.buffer, e.data.fileName);
    } catch (err) {
      post('error', { message: (err && err.message) || String(err) });
    }
  }
};
