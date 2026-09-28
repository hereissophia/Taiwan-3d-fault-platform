// Point-data import: reads an earthquake catalogue (CSV or .xlsx) and turns it into 3D markers.
//
// COLUMNS -- longitude, latitude and depth are required; magnitude, group and time are optional.
// Headers are matched by name (English or Chinese, any case) so a working catalogue can be dropped in
// unchanged; if no header row is recognised the first three columns are taken as lon/lat/depth in
// that order. Rows outside Taiwan's neighbourhood, or with unparseable numbers, are counted and
// skipped rather than silently placed at the origin.
//
// DEPTH -- positive means downward, as in every standard catalogue (CWA, USGS), and is read in
// kilometres. Values are stored as metres of elevation (negative down) to match the scene.
//
// XLSX -- read without a library: .xlsx is a zip of XML, so the archive's stored/deflated entries are
// unpacked with DecompressionStream and sheet1.xml is walked for cell values, resolving shared
// strings. Only what a catalogue needs is supported: values and inline strings, no formulas.

const LON = ['lon', 'long', 'longitude', 'x', '經度', '經度(度)', 'elon'];
const LAT = ['lat', 'latitude', 'y', '緯度', '緯度(度)', 'elat'];
const DEP = ['depth', 'dep', 'z', 'depth_km', '深度', '深度(km)', 'focal_depth'];
const MAG = ['mag', 'magnitude', 'ml', 'mw', 'm', '規模', '芮氏規模'];
const GRP = ['group', 'type', 'class', 'kind', 'label', '分組', '類別', '型態'];
const TIM = ['time', 'date', 'datetime', 'origin_time', '時間', '日期', '發生時間'];

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s_\-()（）]/g, '');
const findCol = (headers, names) => headers.findIndex((h) => names.some((n) => norm(h) === norm(n)));

// Mainshock keywords in either language; everything else is treated as an aftershock.
const MAIN_WORDS = ['main', 'mainshock', 'main shock', 'master', '主震', '主', 'ms'];
function classify(raw) {
  const v = norm(raw);
  if (!v) return null;
  return MAIN_WORDS.some((w) => v === norm(w) || v.includes(norm(w))) ? 'main' : 'after';
}

function splitCSVLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === '\t' || c === ';') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parseCSV(text) {
  return text.replace(/^\ufeff/, '').split(/\r?\n/).filter((l) => l.trim()).map(splitCSVLine);
}

// ---------------------------------------------------------------- xlsx

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Unzip the entries we need by walking local file headers (no central directory needed). */
async function unzipEntries(buf, wanted) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder();
  const out = {};
  let o = 0;
  while (o + 30 <= buf.length && dv.getUint32(o, true) === 0x04034b50) {
    const method = dv.getUint16(o + 8, true);
    let comp = dv.getUint32(o + 18, true);
    let uncomp = dv.getUint32(o + 22, true);
    const nameLen = dv.getUint16(o + 26, true);
    const extraLen = dv.getUint16(o + 28, true);
    const name = dec.decode(buf.subarray(o + 30, o + 30 + nameLen));
    const dataStart = o + 30 + nameLen + extraLen;
    if (!comp && (dv.getUint16(o + 6, true) & 0x08)) break; // streamed sizes: unsupported writer
    const data = buf.subarray(dataStart, dataStart + comp);
    if (wanted.some((w) => name === w || name.endsWith(w))) {
      out[name] = method === 0 ? data : await inflateRaw(data);
    }
    o = dataStart + comp;
    void uncomp;
  }
  return out;
}

const A1_COL = (ref) => {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

async function parseXLSX(buf) {
  const files = await unzipEntries(buf, ['xl/worksheets/sheet1.xml', 'xl/sharedStrings.xml']);
  const dec = new TextDecoder();
  const sheetXml = Object.entries(files).find(([k]) => k.includes('sheet1.xml'));
  if (!sheetXml) throw new Error('sheet1.xml not found');
  const shared = [];
  const ssEntry = Object.entries(files).find(([k]) => k.includes('sharedStrings.xml'));
  if (ssEntry) {
    const xml = dec.decode(ssEntry[1]);
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
    }
  }
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const rows = [];
  for (const rm of dec.decode(sheetXml[1]).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1], body = cm[2];
      const ref = (/r="([A-Z]+\d+)"/.exec(attrs) || [])[1];
      const t = (/t="([^"]+)"/.exec(attrs) || [])[1];
      const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
      const is = (/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(body) || [])[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = unesc(is ?? '');
      else val = v ?? '';
      cells[A1_COL(ref) || cells.length] = unesc(String(val));
    }
    rows.push(cells);
  }
  return rows;
}

// ---------------------------------------------------------------- table -> points

const BOUNDS = { lonMin: 116, lonMax: 126, latMin: 18, latMax: 27.5 };

function rowsToPoints(rows, sourceName) {
  if (!rows.length) return { points: [], skipped: 0, headers: [] };
  const head = rows[0].map((c) => String(c ?? ''));
  let ix = { lon: findCol(head, LON), lat: findCol(head, LAT), dep: findCol(head, DEP) };
  let body = rows.slice(1);
  let mag = findCol(head, MAG), grp = findCol(head, GRP), tim = findCol(head, TIM);
  if (ix.lon < 0 || ix.lat < 0 || ix.dep < 0) {
    // no recognised header: fall back to the documented three-column order
    ix = { lon: 0, lat: 1, dep: 2 };
    mag = head.length > 3 ? 3 : -1;
    grp = head.length > 4 ? 4 : -1;
    tim = head.length > 5 ? 5 : -1;
    body = rows;
  }
  const points = [];
  let skipped = 0;
  body.forEach((r) => {
    const lon = Number(String(r[ix.lon] ?? '').trim());
    const lat = Number(String(r[ix.lat] ?? '').trim());
    const dep = Number(String(r[ix.dep] ?? '').trim());
    if (!isFinite(lon) || !isFinite(lat) || !isFinite(dep)) { skipped++; return; }
    if (lon < BOUNDS.lonMin || lon > BOUNDS.lonMax || lat < BOUNDS.latMin || lat > BOUNDS.latMax) { skipped++; return; }
    const m = mag >= 0 ? Number(String(r[mag] ?? '').trim()) : NaN;
    points.push({
      lon, lat,
      depthKm: Math.abs(dep),          // positive-down catalogue convention
      elevM: -Math.abs(dep) * 1000,
      mag: isFinite(m) ? m : null,
      group: grp >= 0 ? classify(r[grp]) : null,
      time: tim >= 0 ? String(r[tim] ?? '') : '',
      source: sourceName,
    });
  });
  return { points, skipped, headers: head };
}

export async function readPointFile(file) {
  const name = file.name || 'points';
  if (/\.xlsx$/i.test(name)) {
    const buf = new Uint8Array(await file.arrayBuffer());
    return rowsToPoints(await parseXLSX(buf), name);
  }
  return rowsToPoints(parseCSV(await file.text()), name);
}

// ---------------------------------------------------------------- 3D markers

export const GROUP_COLORS = { main: 0xd93025, after: 0x1f5fbf, none: 0x6d4bb8 };

/** Instanced spheres for a catalogue, coloured by group. Radius is constant: the answer to "is the
 *  aftershock cloud on the fault plane" is read from position, and magnitude-scaled spheres make a
 *  dense cluster read as one blob. */
export function buildPointCloud(THREE, points, lonLatToLocalMeters, lon0, lat0, radiusM = 700, yScale = 1) {
  const group = new THREE.Group();
  group.name = 'Imported_points';
  if (!points.length) return group;
  const byGroup = { main: [], after: [], none: [] };
  points.forEach((p) => byGroup[p.group || 'none'].push(p));
  Object.entries(byGroup).forEach(([key, list]) => {
    if (!list.length) return;
    const geo = new THREE.SphereGeometry(radiusM, 12, 10);
    const mat = new THREE.MeshStandardMaterial({
      color: GROUP_COLORS[key], roughness: 0.45, metalness: 0.1,
      emissive: GROUP_COLORS[key], emissiveIntensity: 0.25,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    const m4 = new THREE.Matrix4();
    list.forEach((p, i) => {
      const l = lonLatToLocalMeters(p.lon, p.lat, lon0, lat0);
      // yScale is the map's vertical exaggeration: hypocentres must move with the surface they
      // are referenced to, and an instanced matrix cannot be rescaled by the caller afterwards
      m4.makeTranslation(l.x, p.elevM * yScale, l.z);
      mesh.setMatrixAt(i, m4);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = 'points_' + key;
    mesh.userData.noShadow = true;
    mesh.userData.noVertExag = true; // its offsets live in instance matrices, not vertex Y
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  });
  return group;
}

window.__pointDataModule = { readPointFile, buildPointCloud, GROUP_COLORS };
