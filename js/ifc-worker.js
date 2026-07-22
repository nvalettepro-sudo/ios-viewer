// ============================================================================
//  ifc-worker.js — Parsing IFC hors du thread principal (web-ifc + WASM)
//  Extrait la géométrie EN CONSERVANT L'IDENTITÉ de chaque élément (expressID),
//  sa catégorie (classe IFC) et son étage, regroupée par catégorie pour un
//  rendu efficace. Le modèle reste ouvert pour lire les propriétés à la demande.
// ============================================================================

// Dépendances vendorisées localement (versions au build : web-ifc 0.0.77, fflate 0.8.2).
const WEBIFC_API_URL = new URL('../vendor/web-ifc-api.js', import.meta.url).href;
const WEBIFC_BASE = new URL('../vendor/', import.meta.url).href;
const FFLATE_URL = new URL('../vendor/fflate.js', import.meta.url).href;

let IfcAPI = null;
let ifcAPI = null;
let openModelID = null; // modèle courant laissé ouvert (propriétés paresseuses)

function post(type, payload, transfer) {
  self.postMessage({ type, ...payload }, transfer || []);
}

async function ensureEngine() {
  if (ifcAPI) return;
  post('status', { title: 'Préparation du moteur IFC…', detail: 'Chargement du module WASM' });
  const mod = await import(WEBIFC_API_URL);
  IfcAPI = mod.IfcAPI;
  ifcAPI = new IfcAPI();
  ifcAPI.SetWasmPath(WEBIFC_BASE, true);
  await ifcAPI.Init();
}

async function maybeUnzip(uint8, fileName) {
  const isZip = uint8.length > 3 && uint8[0] === 0x50 && uint8[1] === 0x4b;
  if (!isZip && !/\.ifczip$/i.test(fileName || '')) return uint8;
  post('status', { title: 'Décompression…', detail: 'Extraction de l\'archive IFCZIP' });
  const { unzipSync } = await import(FFLATE_URL);
  const files = unzipSync(uint8);
  const entry = Object.keys(files).find((n) => /\.ifc$/i.test(n));
  if (!entry) throw new Error('Aucun fichier .ifc trouvé dans l\'archive IFCZIP.');
  return files[entry];
}

// -- Buffers extensibles ------------------------------------------------------
class Grow {
  constructor(Type) { this.Type = Type; this.buf = new Type(1024); this.len = 0; }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + n) cap *= 2;
    const nb = new this.Type(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  compact() { return this.buf.slice(0, this.len); }
}

// Libellés FR pour les classes IFC courantes (sinon on retire le préfixe "Ifc").
const CAT_LABELS = {
  IfcWall: 'Murs', IfcWallStandardCase: 'Murs', IfcSlab: 'Dalles / planchers',
  IfcBeam: 'Poutres', IfcColumn: 'Poteaux', IfcWindow: 'Fenêtres', IfcDoor: 'Portes',
  IfcStair: 'Escaliers', IfcStairFlight: 'Escaliers', IfcRailing: 'Garde-corps',
  IfcRoof: 'Toitures', IfcCovering: 'Revêtements', IfcFooting: 'Fondations',
  IfcMember: 'Membrures', IfcPlate: 'Plaques', IfcCurtainWall: 'Murs rideaux',
  IfcRamp: 'Rampes', IfcRampFlight: 'Rampes', IfcBuildingElementProxy: 'Éléments divers',
  IfcFurnishingElement: 'Mobilier', IfcSpace: 'Espaces', IfcPile: 'Pieux',
  IfcReinforcingBar: 'Armatures', IfcFlowTerminal: 'Terminaux', IfcRoofElement: 'Toitures',
};
function catLabel(name) { return CAT_LABELS[name] || String(name).replace(/^Ifc/, ''); }
function typeName(code) { try { return ifcAPI.GetNameFromTypeCode(code); } catch { return 'Ifc' + code; } }

const IFCBUILDINGSTOREY = 3124254112;

// Construit la table expressID -> index d'étage à partir de l'arbre spatial.
async function buildStoreyMap() {
  const storeyIds = ifcAPI.GetLineIDsWithType(openModelID, IFCBUILDINGSTOREY);
  const storeys = [];
  const idToStorey = new Map(); // storeyExpressID -> index
  for (let i = 0; i < storeyIds.size(); i++) {
    const sid = storeyIds.get(i);
    const line = ifcAPI.GetLine(openModelID, sid);
    storeys.push({ sid, name: line.Name ? line.Name.value : 'Niveau', elevation: line.Elevation ? line.Elevation.value : 0 });
  }
  storeys.sort((a, b) => a.elevation - b.elevation);
  storeys.forEach((s, i) => idToStorey.set(s.sid, i));

  const elemStorey = new Map(); // elementExpressID -> storeyIdx
  try {
    const tree = await ifcAPI.properties.getSpatialStructure(openModelID, false);
    (function walk(node, curStorey) {
      const sIdx = idToStorey.has(node.expressID) ? idToStorey.get(node.expressID) : curStorey;
      if (node.expressID != null) elemStorey.set(node.expressID, sIdx);
      if (node.children) for (const c of node.children) walk(c, sIdx);
    })(tree, -1);
  } catch (_) { /* pas d'arbre spatial exploitable */ }

  return { storeys: storeys.map((s) => ({ name: s.name, elevation: s.elevation })), elemStorey };
}

async function processIFC(buffer, fileName) {
  await ensureEngine();
  if (openModelID != null) { try { ifcAPI.CloseModel(openModelID); } catch {} openModelID = null; }

  let uint8 = new Uint8Array(buffer);
  uint8 = await maybeUnzip(uint8, fileName);

  post('status', { title: 'Ouverture du modèle…', detail: 'Analyse de la structure IFC' });
  openModelID = ifcAPI.OpenModel(uint8, { COORDINATE_TO_ORIGIN: true });

  post('status', { title: 'Analyse des étages…', detail: 'Structure spatiale' });
  const { storeys, elemStorey } = await buildStoreyMap();

  // Groupes par catégorie (typeCode) : buffers + liste d'éléments avec leurs plages.
  const cats = new Map(); // typeCode -> {name, verts:Grow(F32), cols:Grow(U8), idx:Grow(U32), vcount, elements:[]}
  const meta = {}; // expressID -> [name, catLabel, storeyIdx, globalId]
  let meshCount = 0, triCount = 0;
  const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };

  post('status', { title: 'Extraction de la géométrie…', detail: '0 élément' });

  ifcAPI.StreamAllMeshes(openModelID, (flatMesh) => {
    const eid = flatMesh.expressID;
    const placed = flatMesh.geometries;
    const n = placed.size();
    if (n === 0) return;

    const typeCode = ifcAPI.GetLineType(openModelID, eid);
    let g = cats.get(typeCode);
    if (!g) {
      g = { name: typeName(typeCode), verts: new Grow(Float32Array), cols: new Grow(Uint8Array), idx: new Grow(Uint32Array), vcount: 0, elements: [] };
      cats.set(typeCode, g);
    }

    const elVStart = g.vcount;
    const elIStart = g.idx.len;

    for (let i = 0; i < n; i++) {
      const pg = placed.get(i);
      const geom = ifcAPI.GetGeometry(openModelID, pg.geometryExpressID);
      const vsize = geom.GetVertexDataSize(), isize = geom.GetIndexDataSize();
      if (vsize === 0 || isize === 0) { geom.delete(); continue; }
      const verts = ifcAPI.GetVertexArray(geom.GetVertexData(), vsize);
      const indices = ifcAPI.GetIndexArray(geom.GetIndexData(), isize);
      const m = pg.flatTransformation;
      const c = pg.color; // {x,y,z,w}
      const cr = Math.round(c.x * 255), cg = Math.round(c.y * 255), cb = Math.round(c.z * 255);

      const vertCount = verts.length / 6;
      const base = g.vcount;
      g.verts.ensure(vertCount * 6);
      g.cols.ensure(vertCount * 3);
      const vo = g.verts.buf, co = g.cols.buf;
      let vp = g.verts.len, cp = g.cols.len;
      for (let k = 0; k < vertCount; k++) {
        const b = k * 6;
        const px = verts[b], py = verts[b + 1], pz = verts[b + 2];
        const nx = verts[b + 3], ny = verts[b + 4], nz = verts[b + 5];
        const wx = m[0] * px + m[4] * py + m[8] * pz + m[12];
        const wy = m[1] * px + m[5] * py + m[9] * pz + m[13];
        const wz = m[2] * px + m[6] * py + m[10] * pz + m[14];
        let tx = m[0] * nx + m[4] * ny + m[8] * nz;
        let ty = m[1] * nx + m[5] * ny + m[9] * nz;
        let tz = m[2] * nx + m[6] * ny + m[10] * nz;
        const l = Math.hypot(tx, ty, tz) || 1;
        vo[vp] = wx; vo[vp + 1] = wy; vo[vp + 2] = wz;
        vo[vp + 3] = tx / l; vo[vp + 4] = ty / l; vo[vp + 5] = tz / l;
        vp += 6;
        co[cp] = cr; co[cp + 1] = cg; co[cp + 2] = cb; cp += 3;
        if (wx < bbox.min[0]) bbox.min[0] = wx; if (wx > bbox.max[0]) bbox.max[0] = wx;
        if (wy < bbox.min[1]) bbox.min[1] = wy; if (wy > bbox.max[1]) bbox.max[1] = wy;
        if (wz < bbox.min[2]) bbox.min[2] = wz; if (wz > bbox.max[2]) bbox.max[2] = wz;
      }
      g.verts.len = vp; g.cols.len = cp;

      g.idx.ensure(indices.length);
      const io = g.idx.buf; let ip = g.idx.len;
      for (let k = 0; k < indices.length; k++) io[ip++] = indices[k] + base;
      g.idx.len = ip;
      g.vcount += vertCount;
      triCount += indices.length / 3;
      geom.delete();
    }

    const storeyIdx = elemStorey.has(eid) ? elemStorey.get(eid) : -1;
    g.elements.push({
      expressID: eid, storeyIdx,
      vStart: elVStart, vCount: g.vcount - elVStart,
      iStart: elIStart, iCount: g.idx.len - elIStart,
    });

    // Métadonnées légères (pour le panneau, sans rouvrir le modèle)
    let name = '';
    try { const ln = ifcAPI.GetLine(openModelID, eid); name = ln.Name ? ln.Name.value : ''; var gid = ln.GlobalId ? ln.GlobalId.value : ''; } catch { var gid = ''; }
    meta[eid] = [name, catLabel(g.name), storeyIdx, gid];

    meshCount++;
    if (meshCount % 200 === 0) post('status', { title: 'Extraction de la géométrie…', detail: `${meshCount} éléments` });
  });

  // Sérialisation transférable
  const groups = [];
  const transfer = [];
  const categories = [];
  let catIndex = 0;
  for (const [typeCode, g] of cats.entries()) {
    if (g.vcount === 0) continue;
    const positionsNormals = g.verts.compact();
    const colors = g.cols.compact();
    const index = g.idx.compact();
    groups.push({
      categoryIndex: catIndex, name: g.name, label: catLabel(g.name),
      positionsNormals, colors, index, elements: g.elements,
    });
    categories.push({ index: catIndex, name: g.name, label: catLabel(g.name), count: g.elements.length });
    transfer.push(positionsNormals.buffer, colors.buffer, index.buffer);
    catIndex++;
  }

  // NB : on NE ferme PAS le modèle → propriétés lisibles à la demande.
  post('done', {
    groups, categories, storeys, meta, bbox,
    stats: { categories: categories.length, elements: meshCount, triangles: Math.round(triCount) },
    fileName,
  }, transfer);
}

// -- Propriétés à la demande --------------------------------------------------
async function getProperties(expressID) {
  if (openModelID == null) return { expressID, sets: [] };
  const out = [];
  try {
    const psets = await ifcAPI.properties.getPropertySets(openModelID, expressID, true);
    for (const ps of psets) {
      const props = [];
      const list = ps.HasProperties || ps.Quantities || [];
      for (const pr of list) {
        if (!pr) continue;
        const pname = pr.Name ? pr.Name.value : '?';
        let val = '';
        const v = pr.NominalValue || pr.LengthValue || pr.AreaValue || pr.VolumeValue ||
                  pr.CountValue || pr.WeightValue || pr.value;
        if (v != null) val = (typeof v === 'object' && 'value' in v) ? v.value : v;
        else if (pr.NominalValue == null && pr.HasProperties) val = '(groupe)';
        props.push([pname, String(val)]);
      }
      out.push({ name: ps.Name ? ps.Name.value : 'Propriétés', props });
    }
  } catch (e) { /* pas de propriétés */ }
  return { expressID, sets: out };
}

self.onmessage = async (e) => {
  const { type } = e.data;
  if (type === 'load') {
    try { await processIFC(e.data.buffer, e.data.fileName); }
    catch (err) { post('error', { message: (err && err.message) || String(err) }); }
  } else if (type === 'properties') {
    const r = await getProperties(e.data.expressID);
    post('properties', r);
  } else if (type === 'close') {
    if (openModelID != null) { try { ifcAPI.CloseModel(openModelID); } catch {} openModelID = null; }
  }
};
