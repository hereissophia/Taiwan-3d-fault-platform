// Adapted from the model room's fault-model.js: builds a self-centered 3D group for one fault
// (surface trace + segmented dip-projected plane + DEM terrain patch), given real coords/segments.
const DEG = Math.PI / 180;

// WGS84 meters-per-degree-latitude, exact function of latitude (varies ~110,574m at equator to
// ~111,694m at the poles) -- matches the model room's fault-model.js so both projects agree.
function metersPerDegLat(latDeg) {
  const lat = latDeg * DEG;
  return 111132.92 - 559.82 * Math.cos(2 * lat) + 1.175 * Math.cos(4 * lat) - 0.0023 * Math.cos(6 * lat);
}

export function lonLatToLocalMeters(lon, lat, lon0, lat0) {
  const mPerDegLon = 111320 * Math.cos(lat0 * DEG);
  return { x: (lon - lon0) * mPerDegLon, z: -(lat - lat0) * metersPerDegLat(lat0) };
}

// densify the trace by INSERTING collinear points between existing vertices (never moving or dropping
// originals) so the mesh gets small, evenly-sized triangles. Geometry is unchanged -- this only affects
// tessellation quality. Ported from the model room's fault-model.js.
function densifyCoords(coords, targetCols = 240) {
  if (!coords || coords.length < 2) return (coords || []).slice();
  const midLat = coords.reduce((a, c) => a + c[1], 0) / coords.length;
  const mPerLon = 111320 * Math.cos(midLat * DEG), mPerLat = metersPerDegLat(midLat);
  const segLens = [];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = Math.hypot((coords[i][0] - coords[i - 1][0]) * mPerLon, (coords[i][1] - coords[i - 1][1]) * mPerLat);
    segLens.push(d); total += d;
  }
  if (!total) return coords.slice();
  const maxSeg = Math.max(total / targetCols, 50);
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const n = Math.max(1, Math.ceil(segLens[i - 1] / maxSeg));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push([
        coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
        coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t,
      ]);
    }
  }
  return out;
}

// Down-dip direction for a fault: the perpendicular to the trace's OWN overall trend (start-to-end
// direction), not the literal compass table value directly -- closer to the real strike than a coarse
// cardinal direction, and kept as ONE direction for the whole fault so every depth row shifts the same
// way and the rows stack into a flat ruled surface instead of a warped one. Ported from the model room's
// fault-model.js so both projects' meshes match.
function computeFaultAzimuth(surfacePts, confirmedAzimuthDeg) {
  let vx = 0, vz = 0;
  for (let i = 1; i < surfacePts.length; i++) { vx += surfacePts[i].x - surfacePts[i - 1].x; vz += surfacePts[i].z - surfacePts[i - 1].z; }
  const len = Math.hypot(vx, vz) || 1;
  vx /= len; vz /= len;
  let px = -vz, pz = vx;
  // z is south-positive here, but compass bearings are north-positive, so flip z's sign when
  // building the bearing's vector (east/west are unaffected since their z-component is 0).
  const az = { x: Math.sin(confirmedAzimuthDeg * DEG), z: -Math.cos(confirmedAzimuthDeg * DEG) };
  if (px * az.x + pz * az.z < 0) { px = -px; pz = -pz; }
  return { x: px, z: pz };
}

/** One down-dip direction for a whole multi-strand structure. Taking it per strand made each
 *  strand step down-dip perpendicular to ITS OWN trend, so at the junctions between strands the
 *  depth lines of a structure did not join up (offshore structure 3 was the visible case). Trend
 *  vectors are summed within each strand only, so the gaps between strands contribute nothing. */
function structureDipDir(partsPts, confirmedAzimuthDeg) {
  let vx = 0, vz = 0;
  partsPts.forEach((pts) => {
    for (let i = 1; i < pts.length; i++) { vx += pts[i].x - pts[i - 1].x; vz += pts[i].z - pts[i - 1].z; }
  });
  const len = Math.hypot(vx, vz) || 1;
  vx /= len; vz /= len;
  let px = -vz, pz = vx;
  const az = { x: Math.sin(confirmedAzimuthDeg * DEG), z: -Math.cos(confirmedAzimuthDeg * DEG) };
  if (px * az.x + pz * az.z < 0) { px = -px; pz = -pz; }
  return { x: px, z: pz };
}

import { lonLatToTWD97, twd97ToLonLat, NODATA_ELEV } from './dem.js';
import { COUNTY_BOUNDARY_EDGES } from './county-boundary-edges.js';
import { COASTLINE } from './coastline-data.js';
import { LANDMASK } from './land-mask.js';
import { TRENCHES } from './trench-data.js';
import { DECOLLEMENT } from './decollement-data.js';

// Hypsometric tint: sea-level green -> foothill olive -> mid-elevation brown -> high peaks light
// grey, painted straight onto the full rectangular terrain grid (no coastline masking) -- the
// ground looks like real relief and the coastline is conveyed by the outline drawn on top of it.
const HYPSO_STOPS = [
  { t: 0.00, c: [0x2f, 0x5c, 0x3e] },
  { t: 0.12, c: [0x4f, 0x74, 0x3f] },
  { t: 0.30, c: [0x8a, 0x86, 0x46] },
  { t: 0.55, c: [0xa3, 0x74, 0x46] },
  { t: 0.80, c: [0x8f, 0x80, 0x76] },
  { t: 1.00, c: [0xe4, 0xe1, 0xd8] },
];
function elevColor(e, maxElev) {
  const t = Math.max(0, Math.min(1, e / maxElev));
  let a = HYPSO_STOPS[0], b = HYPSO_STOPS[HYPSO_STOPS.length - 1];
  for (let i = 0; i < HYPSO_STOPS.length - 1; i++) {
    if (t >= HYPSO_STOPS[i].t && t <= HYPSO_STOPS[i + 1].t) { a = HYPSO_STOPS[i]; b = HYPSO_STOPS[i + 1]; break; }
  }
  const span = b.t - a.t || 1;
  const f = (t - a.t) / span;
  return [
    (a.c[0] + (b.c[0] - a.c[0]) * f) / 255,
    (a.c[1] + (b.c[1] - a.c[1]) * f) / 255,
    (a.c[2] + (b.c[2] - a.c[2]) * f) / 255,
  ];
}

function linesFromPoints(THREE, pts, color, yOffset, onTop) {
  const positions = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => { positions[i * 3] = p.x; positions[i * 3 + 1] = yOffset; positions[i * 3 + 2] = p.z; });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({ color, depthTest: !onTop, depthWrite: !onTop });
  const line = new THREE.LineSegments(geo, mat);
  if (onTop) line.renderOrder = 999;
  return line;
}

/** The subduction interfaces themselves (Slab2 depth grids), one translucent sheet per slab.
 *  Built as LANES rather than grid quads: each lane runs down-dip from the model's own up-dip edge
 *  point -- which lies ON the trench axis -- through the grid cells to the 60 km cut-off point.
 *  Stepping on grid cells instead left a sawtooth margin that did not meet the trench line, and a
 *  ragged deep end; the two boundary arrays give a clean edge at both ends, and since every
 *  deepEdge point is exactly 60 km, the down-dip termination is flat.
 *  Consecutive lanes are stitched by normalised position along the lane, so lanes of unequal
 *  vertex count still triangulate without slivers. */
function buildDecollementSurfaces(THREE, lon0, lat0) {
  const group = new THREE.Group();
  group.name = 'Taiwan_slab_surface';
  const shallow = new THREE.Color('#e8912f'), deep = new THREE.Color('#8a3d07');

  DECOLLEMENT.forEach((slab) => {
    const { lons, lats, depth, edge, deepEdge, edgeAxis } = slab;
    const byLat = edgeAxis === 'lat';
    const laneCount = byLat ? lats.length : lons.length;
    const lanes = [];

    for (let k = 0; k < laneCount; k++) {
      const a = edge[k], b = deepEdge[k];
      if (!a || !b) continue;
      const lane = [{ lon: a[0], lat: a[1], d: a[2] }];
      const from = byLat ? a[0] : a[1];
      const to = byLat ? b[0] : b[1];
      const lo = Math.min(from, to), hi = Math.max(from, to);
      const inner = [];
      if (byLat) {
        for (let i = 0; i < lons.length; i++) {
          const v = depth[k][i];
          if (v == null || lons[i] <= lo || lons[i] >= hi) continue;
          inner.push({ lon: lons[i], lat: lats[k], d: v });
        }
      } else {
        for (let j = 0; j < lats.length; j++) {
          const v = depth[j][k];
          if (v == null || lats[j] <= lo || lats[j] >= hi) continue;
          inner.push({ lon: lons[k], lat: lats[j], d: v });
        }
      }
      inner.sort((p, q) => Math.abs((byLat ? p.lon : p.lat) - from) - Math.abs((byLat ? q.lon : q.lat) - from));
      lane.push(...inner, { lon: b[0], lat: b[1], d: b[2] });
      if (lane.length > 1) lanes.push(lane);
    }

    const pos = [], col = [];
    const push = (p) => {
      const l = lonLatToLocalMeters(p.lon, p.lat, lon0, lat0);
      pos.push(l.x, -p.d * 1000, l.z);
      const c = shallow.clone().lerp(deep, Math.max(0, Math.min(1, p.d / 60)));
      col.push(c.r, c.g, c.b);
    };
    for (let n = 0; n < lanes.length - 1; n++) {
      const A = lanes[n], B = lanes[n + 1];
      let ia = 0, ib = 0;
      while (ia < A.length - 1 || ib < B.length - 1) {
        const ta = ia / (A.length - 1), tb = ib / (B.length - 1);
        const nextA = Math.min(ia + 1, A.length - 1) / (A.length - 1);
        const nextB = Math.min(ib + 1, B.length - 1) / (B.length - 1);
        if (ib >= B.length - 1 || (ia < A.length - 1 && nextA <= nextB)) {
          push(A[ia]); push(A[ia + 1]); push(B[ib]);
          ia++;
        } else {
          push(A[ia]); push(B[ib + 1]); push(B[ib]);
          ib++;
        }
        if (ta === tb && false) break;
      }
    }
    if (!pos.length) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.62,
      depthWrite: false, emissive: new THREE.Color('#5a2a06'), emissiveIntensity: 0.25 }));
    mesh.name = 'slab_' + slab.id;
    mesh.userData.noShadow = true;
    mesh.renderOrder = 4;
    group.add(mesh);
  });
  return group;
}

/** Trench axes (Slab2), draped on the seabed: each vertex takes its own bathymetric depth rather
 *  than one flat offset, so the line hugs the trough instead of floating over it. Labels are canvas
 *  sprites at the axis midpoint, flagged so the exaggeration slider lifts them with the surface. */
function buildTrenches(THREE, lon0, lat0, bathy, lang) {
  const group = new THREE.Group();
  group.name = 'Taiwan_trench';
  const color = 0xd9720f;
  TRENCHES.forEach((t) => {
    const pts = [];
    t.axis.forEach(([lon, lat, seabedKm]) => {
      const p = lonLatToLocalMeters(lon, lat, lon0, lat0);
      // the rendered sheet is the bathymetry grid, so sample it; the axis's own seabed depth is the
      // fallback where the grid has not loaded
      const y = bathy && bathy.loaded ? Math.min(bathy.sample(lon, lat), 0) : -seabedKm * 1000;
      pts.push({ x: p.x, y: y + 140, z: p.z });
    });
    const segs = [];
    for (let i = 0; i < pts.length - 1; i++) segs.push(pts[i], pts[i + 1]);
    const positions = new Float32Array(segs.length * 3);
    segs.forEach((p, i) => { positions[i * 3] = p.x; positions[i * 3 + 1] = p.y; positions[i * 3 + 2] = p.z; });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color, depthTest: false, depthWrite: false, transparent: true }));
    line.renderOrder = 1180;
    group.add(line);

    const mid = pts[Math.floor(pts.length / 2)];
    const text = lang === 'en' ? (t.nameE || t.nameC) : (t.nameC || t.nameE);
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 96;
    const cx = cv.getContext('2d');
    cx.font = 'bold 44px "Noto Sans TC", system-ui, sans-serif';
    cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.lineWidth = 8; cx.strokeStyle = 'rgba(255,255,255,0.92)';
    cx.strokeText(text, 256, 52);
    cx.fillStyle = '#b35c08';
    cx.fillText(text, 256, 52);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true, sizeAttenuation: false }));
    sprite.scale.set(0.15, 0.028, 1);
    sprite.position.set(mid.x, mid.y, mid.z);
    sprite.renderOrder = 1181;
    sprite.userData.trenchLabel = true;
    group.add(sprite);
  });
  return group;
}

/** Real surveyed coastline (coastline-data.js), drawn as thin lines directly -- smooth by
 *  construction since it's vector data, not a grid-quantized mask boundary. */
function buildCoastlineFromArcs(THREE, lon0, lat0, color, yOffset) {
  const pts = [];
  COASTLINE.forEach((line) => {
    for (let i = 0; i < line.length - 1; i++) {
      const [lo0, la0] = line[i], [lo1, la1] = line[i + 1];
      pts.push(lonLatToLocalMeters(lo0, la0, lon0, lat0));
      pts.push(lonLatToLocalMeters(lo1, la1, lon0, lat0));
    }
  });
  // drawn depth-tested-off + high renderOrder, same as the county-boundary overlay it alternates
  // with. Now that the land and sea DEMs are fused into one uncut sheet, this surveyed line IS the
  // shoreline reference; depth-testing a line held at a constant 60 m against terrain that carries
  // real elevation (and is then multiplied by the exaggeration slider) buried a quarter of it at 1x
  // and nearly half at 8x.
  return linesFromPoints(THREE, pts, color, yOffset, true);
}

// County-boundary edges are stored once in TWD97 TM2 meters; converting them to lon/lat is the
// same for every map build, so cache it instead of re-running the inverse projection each time.
// A few source features (offshore Kaohsiung-administered islands like Pratas/Itu Aba) sit far
// outside Taiwan proper and blow up the scene's auto-framed camera bounds, so drop anything
// outside a generous Taiwan+islets box.
let _countyLonLat = null;
function getCountyEdgesLonLat() {
  if (_countyLonLat) return _countyLonLat;
  const e = COUNTY_BOUNDARY_EDGES;
  const inBounds = (p) => p.lon >= 118.0 && p.lon <= 122.3 && p.lat >= 21.6 && p.lat <= 26.5;
  const out = [];
  for (let i = 0; i < e.length; i += 4) {
    const p1 = twd97ToLonLat(e[i], e[i + 1]);
    const p2 = twd97ToLonLat(e[i + 2], e[i + 3]);
    if (!inBounds(p1) || !inBounds(p2)) continue;
    out.push(p1, p2);
  }
  _countyLonLat = out;
  return out;
}

function buildCountyBoundaryLines(THREE, lon0, lat0, color, yOffset) {
  const pts = getCountyEdgesLonLat().map((p) => lonLatToLocalMeters(p.lon, p.lat, lon0, lat0));
  // drawn depth-tested-off + high renderOrder so it stays visible over the terrain regardless of
  // vertical exaggeration or elevation, same trick as the per-fault surface trace tube.
  return linesFromPoints(THREE, pts, color, yOffset, true);
}


// One colour texture shared by every surface mesh in every domain, so the background never changes
// when the domain switch moves. Land texels take the hypsometric ramp against a FIXED maximum
// (Taiwan's highest ground) rather than a per-build maximum, so the tint is stable; sea texels take
// the bathymetric ramp. The land/sea decision is the flood-filled county-boundary mask, which is why
// the shoreline is as sharp as the texture (~430 m) instead of as coarse as the mesh.
const MAX_LAND_ELEV = 3800;
let _surfaceTex = null;
function surfaceTexture(THREE, DEM, BATHY) {
  if (_surfaceTex) return _surfaceTex;
  if (!LANDMASK.loaded || !BATHY || !BATHY.loaded) return null;
  const W = LANDMASK.width, H = LANDMASK.height, ex = LANDMASK.extent;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const spanLon = ex.lonMax - ex.lonMin, spanLat = ex.latMax - ex.latMin;
  for (let iy = 0; iy < H; iy++) {
    const lat = ex.latMax - (spanLat * (iy + 0.5)) / H;
    for (let ix = 0; ix < W; ix++) {
      const lon = ex.lonMin + (spanLon * (ix + 0.5)) / W;
      const k = (iy * W + ix) * 4;
      let c;
      if (LANDMASK.at(ix, iy)) {
        // the land DEM only covers Taiwan proper; the outlying islands fall back to a low-ground
        // tint rather than the NODATA floor, which would have painted them as deep water
        let e = DEM.sample(lon, lat);
        if (e <= NODATA_ELEV + 0.01) e = 20;
        c = hypsoColor(Math.max(e, 0));
      } else {
        c = bathyColor(Math.min(BATHY.sample(lon, lat), 0));
      }
      d[k] = c[0] * 255; d[k + 1] = c[1] * 255; d[k + 2] = c[2] * 255; d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 8;
  _surfaceTex = tex;
  return tex;
}

const HYPSO = [
  { t: 0.00, c: [0x3f, 0x7a, 0x4a] },
  { t: 0.15, c: [0x63, 0x8f, 0x45] },
  { t: 0.35, c: [0x93, 0x8a, 0x48] },
  { t: 0.60, c: [0xa3, 0x74, 0x46] },
  { t: 0.82, c: [0x8f, 0x80, 0x76] },
  { t: 1.00, c: [0xe4, 0xe1, 0xd8] },
];
function hypsoColor(e) {
  const t = Math.max(0, Math.min(1, e / MAX_LAND_ELEV));
  let a = HYPSO[0], b = HYPSO[HYPSO.length - 1];
  for (let i = 0; i < HYPSO.length - 1; i++) {
    if (t >= HYPSO[i].t && t <= HYPSO[i + 1].t) { a = HYPSO[i]; b = HYPSO[i + 1]; break; }
  }
  const f = (t - a.t) / (b.t - a.t || 1);
  return [
    (a.c[0] + (b.c[0] - a.c[0]) * f) / 255,
    (a.c[1] + (b.c[1] - a.c[1]) * f) / 255,
    (a.c[2] + (b.c[2] - a.c[2]) * f) / 255,
  ];
}

/** UVs that place a mesh's vertices on the shared texture by their real lon/lat. */
function setTextureUVs(THREE, geo, lon0, lat0) {
  const ex = LANDMASK.extent;
  const pos = geo.attributes.position;
  const mPerDegLon = 111320 * Math.cos(lat0 * DEG);
  const mPerDegLat = metersPerDegLat(lat0);
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const lon = lon0 + pos.getX(i) / mPerDegLon;
    const lat = lat0 - pos.getZ(i) / mPerDegLat;
    uv[i * 2] = (lon - ex.lonMin) / (ex.lonMax - ex.lonMin);
    uv[i * 2 + 1] = 1 - (ex.latMax - lat) / (ex.latMax - ex.latMin);
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function buildFaultMeshShared(THREE, DEM, fault, lon0, lat0) {
  const group = new THREE.Group();
  group.name = fault.nameE.replace(/\s+/g, '_') + '_map';
  group.userData.faultId = fault.id;

  const denseCoords = densifyCoords(fault.coords);
  const surfacePts = denseCoords.map(([lon, lat]) => lonLatToLocalMeters(lon, lat, lon0, lat0));
  const surfaceElev = denseCoords.map(([lon, lat]) => DEM.sample(lon, lat));

  const azimuthDeg = fault.dipAzimuth ?? 90;
  const dipDir = computeFaultAzimuth(surfacePts, azimuthDeg);

  const depths = [0, ...fault.segments.map((s) => s.depth)];
  const rows = depths.length;
  const cols = surfacePts.length;
  const offsetAccum = new Array(cols).fill(0);
  const gridX = [], gridY = [], gridZ = [];
  for (let r = 0; r < rows; r++) {
    const rowX = [], rowY = [], rowZ = [];
    if (r > 0) {
      const seg = fault.segments[r - 1];
      const depthDeltaM = (depths[r] - depths[r - 1]) * 1000;
      const horizDelta = depthDeltaM / Math.tan(seg.dip * DEG);
      for (let c = 0; c < cols; c++) offsetAccum[c] += horizDelta;
    }
    for (let c = 0; c < cols; c++) {
      rowX.push(surfacePts[c].x + dipDir.x * offsetAccum[c]);
      rowZ.push(surfacePts[c].z + dipDir.z * offsetAccum[c]);
      rowY.push(surfaceElev[c] - depths[r] * 1000);
    }
    gridX.push(rowX); gridY.push(rowY); gridZ.push(rowZ);
  }

  const positions = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      positions.push(gridX[r][c], gridY[r][c], gridZ[r][c]);

  const segColors = [0x999999, 0x999999, 0x999999];
  for (let segIdx = 0; segIdx < rows - 1; segIdx++) {
    const segPositions = [];
    for (let r = segIdx; r <= segIdx + 1; r++)
      for (let c = 0; c < cols; c++) {
        const base = (r * cols + c) * 3;
        segPositions.push(positions[base], positions[base + 1], positions[base + 2]);
      }
    const segIndices = [];
    // flip the quad diagonal every other column so the tessellation does not read as one
    // continuous set of parallel diagonal lines across the whole plane
    for (let c = 0; c < cols - 1; c++) {
      const a = c, b = a + 1, d = a + cols, e = d + 1;
      if ((c + segIdx) % 2 === 0) segIndices.push(a, d, b, b, d, e);
      else segIndices.push(a, d, e, a, e, b);
    }
    const segGeo = new THREE.BufferGeometry();
    segGeo.setAttribute('position', new THREE.Float32BufferAttribute(segPositions, 3));
    segGeo.setIndex(segIndices);
    segGeo.computeVertexNormals();
    const segMat = new THREE.MeshStandardMaterial({
      color: segColors[segIdx % segColors.length], roughness: 1.0, metalness: 0, side: THREE.DoubleSide,
      // emissive adds a constant, light-independent base so the lit/unlit contrast is compressed --
      // creases at trace bends and terrain corrugation stop catching hard highlights. Shading only:
      // no vertex coordinate is touched.
      emissive: 0x8a8a8a, emissiveIntensity: 1,
      transparent: true, opacity: 0.7, depthWrite: false, flatShading: false,
    });
    const segMesh = new THREE.Mesh(segGeo, segMat);
    segMesh.name = `${group.name}_faultPlane_seg${segIdx + 1}`;
    segMesh.userData.faultId = fault.id;
    segMesh.userData.baseColor = segColors[segIdx % segColors.length];
    // no shadows on the fault planes: a curved translucent sheet self-shadows, baking a dark band
    // onto itself that is fixed to the light direction (it does not move with the camera).
    segMesh.castShadow = false;
    segMesh.receiveShadow = false;
    segMesh.userData.noShadow = true; // three-d-stage re-enables shadows on traverse unless flagged
    group.add(segMesh);
  }

  const tracePts3d = surfacePts.map((p, i) => new THREE.Vector3(p.x, surfaceElev[i] + 40, p.z));
  const traceCurve = new THREE.CatmullRomCurve3(tracePts3d);
  const traceGeo = new THREE.TubeGeometry(traceCurve, Math.min(Math.max(cols * 2, 20), 400), 350, 8, false);
  const traceMat = new THREE.MeshBasicMaterial({ color: 0xe11d1d, depthTest: false, depthWrite: false, transparent: true, opacity: 1 });
  const traceMesh = new THREE.Mesh(traceGeo, traceMat);
  traceMesh.name = `${group.name}_surfaceTrace`;
  traceMesh.userData.faultId = fault.id;
  traceMesh.renderOrder = 999;
  // no shadow: the trace keeps TRUE elevation while the terrain is vertically exaggerated, so its
  // real position sits inside the mountain -- the tube still draws on top (depthTest off) but its
  // shadow landed on the terrain as a grey streak unrelated to where the red line appears.
  traceMesh.castShadow = false;
  traceMesh.userData.noShadow = true;
  group.add(traceMesh);

  return group;
}

/** Taiwan-scale basemap: real DEM terrain + coastline + every fault plane placed at true
 *  relative position, matching the model room's "台灣地圖" view. Returns { group, faultGroups }
 *  where faultGroups maps fault.id -> its THREE.Group (for highlight/selection). */
export function buildTaiwanMap(THREE, DEM, faults, mapLon0 = 120.7, mapLat0 = 23.7, opts = {}) {
  const group = new THREE.Group();
  group.name = 'Taiwan_Map';
  // Bathymetry underlay. Optional: with no grid loaded the map falls back to the land-only look,
  // where the terrain plate is drawn as a full rectangle including its sea areas.
  const bathy = opts.bathy && opts.bathy.loaded ? opts.bathy : null;
  // Padded to include the outlying islands in the county-boundary data (Kinmen west, Matsu
  // north), not just the main island.
  const TAIWAN_BOUNDS = { lonMin: 116.4, lonMax: 122.3, latMin: 20.5, latMax: 26.5 };

  // ONE surface for the whole map, land and sea alike. It used to be two meshes -- a fine sheet over
  // Taiwan and a coarse seabed beyond it, with the seabed's quads dropped inside the fine sheet's box
  // -- but they did not meet: PlaneGeometry is centred on the local origin, which is mapLon0/mapLat0
  // (120.7/23.7), not on the middle of the bounds it was sized from, so the sheet actually sat about
  // 1.35 deg east of where the hole was cut. One mesh at one resolution cannot have a seam at all.
  const useWide = !!(bathy && LANDMASK.loaded);
  const BOUNDS = useWide ? LANDMASK.extent : TAIWAN_BOUNDS;
  const mPerDegLonAtCenter = 111320 * Math.cos(mapLat0 * DEG);
  // Computed as positive magnitudes directly (deriving them from lonLatToLocalMeters differences
  // flips sign for latitude, since z runs south-positive -- that silently mirrored the DEM
  // sampling north-south once the bounds were no longer roughly symmetric around mapLat0).
  const w = (BOUNDS.lonMax - BOUNDS.lonMin) * mPerDegLonAtCenter;
  const h = (BOUNDS.latMax - BOUNDS.latMin) * metersPerDegLat(mapLat0);
  const N = useWide ? 400 : 260;
  const NLat = Math.max(60, Math.round((N * h) / w));
  const terrainGeo = new THREE.PlaneGeometry(w, h, N, NLat);
  terrainGeo.rotateX(-Math.PI / 2);
  // place the sheet on its real bounds instead of leaving it centred on the local origin
  const boxCenter = lonLatToLocalMeters(
    (BOUNDS.lonMin + BOUNDS.lonMax) / 2, (BOUNDS.latMin + BOUNDS.latMax) / 2, mapLon0, mapLat0);
  terrainGeo.translate(boxCenter.x, 0, boxCenter.z);
  const tp = terrainGeo.attributes.position;
  const mPerDegLon = 111320 * Math.cos(mapLat0 * DEG);
  const elevs = new Float32Array(tp.count);
  let maxElev = 1;
  for (let i = 0; i < tp.count; i++) {
    const lx = tp.getX(i), lz = tp.getZ(i);
    const lon = mapLon0 + lx / mPerDegLon;
    const lat = mapLat0 - lz / metersPerDegLat(mapLat0);
    // FUSED SURFACE: one continuous uncut sheet. The land mask decides which DEM a vertex takes,
    // so land and seabed meet exactly on the surveyed coastline instead of on a mesh cut edge --
    // cutting triangles could only ever follow grid lines, which is what produced the sawtooth.
    let e;
    if (bathy && LANDMASK.loaded) {
      e = LANDMASK.isLand(lon, lat) ? Math.max(DEM.sample(lon, lat), 0) : Math.min(bathy.sample(lon, lat), 0);
    } else {
      e = DEM.sample(lon, lat);
      if (bathy && e <= NODATA_ELEV + 0.01) e = Math.min(bathy.sample(lon, lat), 0);
    }
    tp.setY(i, e);
    elevs[i] = e;
    if (e > maxElev) maxElev = e;
  }
  // hypsometric tint: low ground reads as green farmland/plains, rising through olive foothills
  // to a brown mid-elevation and pale-grey high peaks, so relief is visible by position, not just shading.
  const stops = [
    { t: 0.00, c: [0x3f, 0x7a, 0x4a] },
    { t: 0.15, c: [0x63, 0x8f, 0x45] },
    { t: 0.35, c: [0x93, 0x8a, 0x48] },
    { t: 0.60, c: [0xa3, 0x74, 0x46] },
    { t: 0.82, c: [0x8f, 0x80, 0x76] },
    { t: 1.00, c: [0xe4, 0xe1, 0xd8] },
  ];
  function elevColor(e) {
    if (e < 0) return bathyColor(e);
    const t = Math.max(0, Math.min(1, e / maxElev));
    let a = stops[0], b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (t >= stops[i].t && t <= stops[i + 1].t) { a = stops[i]; b = stops[i + 1]; break; }
    }
    const f = (t - a.t) / (b.t - a.t || 1);
    return [
      (a.c[0] + (b.c[0] - a.c[0]) * f) / 255,
      (a.c[1] + (b.c[1] - a.c[1]) * f) / 255,
      (a.c[2] + (b.c[2] - a.c[2]) * f) / 255,
    ];
  }
  const surfTex = surfaceTexture(THREE, DEM, bathy);
  if (surfTex) {
    setTextureUVs(THREE, terrainGeo, mapLon0, mapLat0);
  } else {
    const colors = new Float32Array(tp.count * 3);
    for (let i = 0; i < tp.count; i++) {
      const [r, g, b] = elevColor(elevs[i]);
      colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
    }
    terrainGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  terrainGeo.computeVertexNormals();
  const terrainMat = new THREE.MeshStandardMaterial({
    map: surfTex || null, vertexColors: !surfTex,
    roughness: 0.9, metalness: 0, transparent: false, depthWrite: true, side: THREE.DoubleSide,
  });
  const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
  terrainMesh.name = 'Taiwan_terrain';
  // keep the unexaggerated elevations so the viewer can re-scale relief without rebuilding
  terrainMesh.userData.baseElev = elevs;
  // flags the meshes the viewer's exaggeration/opacity sliders act on, so the seabed follows the
  // land surface without a second set of controls
  terrainMesh.userData.surfaceLayer = true;
  terrainMesh.receiveShadow = true;
  group.add(terrainMesh);

  const trenchGroup = buildTrenches(THREE, mapLon0, mapLat0, bathy, opts.lang);
  trenchGroup.visible = opts.showTrench !== false;
  group.add(trenchGroup);

  const slabGroup = buildDecollementSurfaces(THREE, mapLon0, mapLat0);
  slabGroup.visible = opts.showTrench !== false;
  group.add(slabGroup);

  const coastLines = buildCoastlineFromArcs(THREE, mapLon0, mapLat0, 0x2c6e8f, 60);
  coastLines.name = 'Taiwan_coastline';
  group.add(coastLines);

  // county-boundary overlay REPLACES the coastline line (not drawn together) -- hidden by
  // default, toggled on/off from the sidebar checkbox.
  const countyLines = buildCountyBoundaryLines(THREE, mapLon0, mapLat0, 0x2c6e8f, 60);
  countyLines.name = 'Taiwan_countyBoundary';
  countyLines.visible = false;
  group.add(countyLines);

  const faultGroups = {};
  faults.forEach((fault) => {
    let fg = null;
    if (fault.offshore) {
      if (!(fault.parts && fault.parts.length)) return;
      fg = buildOffshoreFaultMesh(THREE, fault, mapLon0, mapLat0, bathy);
    } else {
      if (!fault.coords) return;
      fg = buildFaultMeshShared(THREE, DEM, fault, mapLon0, mapLat0);
    }
    faultGroups[fault.id] = fg;
    group.add(fg);
  });

  return { group, faultGroups };
}


// Bathymetric tint: pale shelf blue down through open-ocean blues to a near-black trench floor.
const BATHY_STOPS = [
  { d: 0, c: [0xc4, 0xdb, 0xe9] },
  { d: -150, c: [0x9b, 0xc2, 0xdb] },
  { d: -600, c: [0x6d, 0xa1, 0xc7] },
  { d: -1800, c: [0x48, 0x7d, 0xaf] },
  { d: -3500, c: [0x30, 0x5c, 0x92] },
  { d: -5500, c: [0x21, 0x42, 0x72] },
  { d: -8000, c: [0x16, 0x2c, 0x54] },
];
function bathyColor(e) {
  const d = Math.min(0, e);
  let a = BATHY_STOPS[0], b = BATHY_STOPS[BATHY_STOPS.length - 1];
  for (let i = 0; i < BATHY_STOPS.length - 1; i++) {
    if (d <= BATHY_STOPS[i].d && d >= BATHY_STOPS[i + 1].d) { a = BATHY_STOPS[i]; b = BATHY_STOPS[i + 1]; break; }
  }
  const f = Math.max(0, Math.min(1, (d - a.d) / ((b.d - a.d) || 1)));
  return [
    (a.c[0] + (b.c[0] - a.c[0]) * f) / 255,
    (a.c[1] + (b.c[1] - a.c[1]) * f) / 255,
    (a.c[2] + (b.c[2] - a.c[2]) * f) / 255,
  ];
}

/** Seabed surface from the bathymetry grid, laid under the land terrain in the same local frame.
 *  Vertices are clamped at sea level and quads that are wholly on land are dropped, so the mesh is
 *  a sea-only sheet with an island-shaped hole rather than a plate running under Taiwan.
 *  Tagged `surfaceLayer` so the exaggeration and opacity sliders drive it together with the land. */
export function buildBathymetry(THREE, BATHY, lon0, lat0, bounds, targetN, hole, sharedTex, DEM) {
  if (!BATHY || !BATHY.loaded) return null;
  const b = bounds || BATHY.extent;
  const spanLon = b.lonMax - b.lonMin, spanLat = b.latMax - b.latMin;
  const N = targetN || Math.max(120, Math.min(380, Math.round(Math.max(spanLon, spanLat) * 45)));
  const M = Math.max(60, Math.round((N * spanLat) / spanLon));
  const cols = N + 1, rows = M + 1, count = cols * rows;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const baseElev = new Float32Array(count);
  const raw = new Float32Array(count);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const lon = b.lonMin + (spanLon * i) / N;
      const lat = b.latMax - (spanLat * j) / M;
      const e = BATHY.sample(lon, lat);
      const p = lonLatToLocalMeters(lon, lat, lon0, lat0);
      const k = j * cols + i;
      raw[k] = e;
      baseElev[k] = Math.min(e, 0);
      pos[k * 3] = p.x; pos[k * 3 + 1] = baseElev[k]; pos[k * 3 + 2] = p.z;
      const c = bathyColor(baseElev[k]);
      col[k * 3] = c[0]; col[k * 3 + 1] = c[1]; col[k * 3 + 2] = c[2];
    }
  }
  const idx = [];
  const inHole = (lon, lat) => hole && lon >= hole.lonMin && lon <= hole.lonMax && lat >= hole.latMin && lat <= hole.latMax;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i, bb = a + 1, c = a + cols, d = c + 1;
      if (raw[a] >= 0 && raw[bb] >= 0 && raw[c] >= 0 && raw[d] >= 0) continue; // wholly on land
      // a quad fully inside the hole is covered by the higher-resolution fused sheet
      if (hole) {
        const lonA = b.lonMin + (spanLon * i) / N, lonB = b.lonMin + (spanLon * (i + 1)) / N;
        const latA = b.latMax - (spanLat * j) / M, latB = b.latMax - (spanLat * (j + 1)) / M;
        if (inHole(lonA, latA) && inHole(lonB, latA) && inHole(lonA, latB) && inHole(lonB, latB)) continue;
      }
      if ((i + j) % 2 === 0) idx.push(a, c, bb, bb, c, d);
      else idx.push(a, c, d, a, d, bb);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  const tex = sharedTex || surfaceTexture(THREE, DEM, BATHY);
  if (tex) setTextureUVs(THREE, geo, lon0, lat0);
  else geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    map: tex || null, vertexColors: !tex,
    roughness: 0.95, metalness: 0, transparent: false, depthWrite: true, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'Taiwan_seabed';
  mesh.userData.baseElev = baseElev;
  mesh.userData.surfaceLayer = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Stacked depth rows for one offshore strand. Three things differ from the land builder: the trace
 *  starts at the structure's average water depth (Depth 0) instead of on the DEM, so it is level;
 *  the rows are a single ruled surface shared by every strand of the structure; and a segment may be
 *  a FLAT ({depth, horizKm}), which keeps the depth and steps out horizontally instead of descending. */
function offshoreRowStack(fault, surfacePts, dipDir, seabedY) {
  const steps = [{ down: 0, off: 0 }];
  let depth = 0, off = 0;
  (fault.segments || []).forEach((seg) => {
    if (seg.horizKm != null) {
      off += seg.horizKm * 1000;
    } else {
      off += ((seg.depth - depth) * 1000) / Math.tan((seg.dip || 90) * DEG);
      depth = seg.depth;
    }
    steps.push({ down: depth * 1000, off });
  });
  // Each column descends from ITS OWN seabed height, so the whole surface hangs off the real
  // seabed instead of one level line. The segment depths stay trace-relative, which is the datum
  // the workbook uses ("Depth 1/2" measured down from the seabed, not below sea level).
  return steps.map((s) => surfacePts.map((p, i) => ({
    x: p.x + dipDir.x * s.off, y: seabedY[i] - s.down, z: p.z + dipDir.z * s.off,
  })));
}

/** Seabed height along a trace: the bathymetry grid where it is available, falling back to the
 *  structure's single average water depth (Depth 0) when no grid is loaded. */
function offshoreSeabedY(BATHY, fault, denseCoords) {
  const fallback = -(fault.seabedKm || 0) * 1000;
  if (!BATHY || !BATHY.loaded) return denseCoords.map(() => fallback);
  return denseCoords.map(([lon, lat]) => Math.min(BATHY.sample(lon, lat), 0));
}

function offshorePlaneMeshes(THREE, name, grid, cols) {
  const out = [];
  for (let segIdx = 0; segIdx < grid.length - 1; segIdx++) {
    const segPositions = [];
    for (let r = segIdx; r <= segIdx + 1; r++)
      for (let c = 0; c < cols; c++) segPositions.push(grid[r][c].x, grid[r][c].y, grid[r][c].z);
    const segIndices = [];
    for (let c = 0; c < cols - 1; c++) {
      const a = c, b = a + 1, d = a + cols, e = d + 1;
      if ((c + segIdx) % 2 === 0) segIndices.push(a, d, b, b, d, e);
      else segIndices.push(a, d, e, a, e, b);
    }
    const segGeo = new THREE.BufferGeometry();
    segGeo.setAttribute('position', new THREE.Float32BufferAttribute(segPositions, 3));
    segGeo.setIndex(segIndices);
    segGeo.computeVertexNormals();
    const segMat = new THREE.MeshStandardMaterial({
      color: 0x999999, roughness: 1.0, metalness: 0, side: THREE.DoubleSide,
      emissive: 0x8a8a8a, emissiveIntensity: 1,
      transparent: true, opacity: 0.7, depthWrite: false, flatShading: false,
    });
    const m = new THREE.Mesh(segGeo, segMat);
    m.name = name + '_faultPlane_seg' + (segIdx + 1);
    m.userData.baseColor = 0x999999;
    m.castShadow = false;
    m.receiveShadow = false;
    m.userData.noShadow = true;
    out.push(m);
  }
  return out;
}

/** One offshore structure on the Taiwan-scale map: every mapped strand's plane plus its trace. */
export function buildOffshoreFaultMesh(THREE, fault, lon0, lat0, BATHY) {
  const group = new THREE.Group();
  const safe = String(fault.nameE || ('offshore_' + fault.id)).replace(/[^A-Za-z0-9]+/g, '_');
  group.name = safe + '_map';
  group.userData.faultId = fault.id;
  group.userData.offshore = true;
  const strandsIn = (fault.parts || []).filter((p) => p && p.length > 1).map((part) => {
    const dense = densifyCoords(part);
    return { dense, pts: dense.map(([lon, lat]) => lonLatToLocalMeters(lon, lat, lon0, lat0)) };
  });
  const dipDir = structureDipDir(strandsIn.map((s) => s.pts), fault.dipAzimuth ?? 90);
  strandsIn.forEach(({ dense, pts }) => {
    const seabedY = offshoreSeabedY(BATHY, fault, dense);
    const grid = offshoreRowStack(fault, pts, dipDir, seabedY);
    offshorePlaneMeshes(THREE, group.name, grid, pts.length).forEach((m) => {
      m.userData.faultId = fault.id;
      group.add(m);
    });
    const curve = new THREE.CatmullRomCurve3(pts.map((p, i) => new THREE.Vector3(p.x, seabedY[i], p.z)));
    const tube = new THREE.TubeGeometry(curve, Math.min(Math.max(pts.length * 2, 20), 400), 350, 8, false);
    const traceMesh = new THREE.Mesh(tube, new THREE.MeshBasicMaterial({
      color: 0xe11d1d, depthTest: false, depthWrite: false, transparent: true, opacity: 1,
    }));
    traceMesh.name = group.name + '_surfaceTrace';
    traceMesh.userData.faultId = fault.id;
    traceMesh.renderOrder = 999;
    traceMesh.castShadow = false;
    traceMesh.userData.noShadow = true;
    group.add(traceMesh);
  });
  return group;
}

/** Single-structure page for an offshore fault: the same planes and traces, self-centred, over a
 *  bathymetry reference patch at the detail view's fixed 3x exaggeration. */
export function buildOffshoreFaultGroup(THREE, BATHY, fault) {
  const group = new THREE.Group();
  group.name = String(fault.nameE || ('offshore_' + fault.id)).replace(/[^A-Za-z0-9]+/g, '_');
  const all = (fault.parts || []).flat();
  if (!all.length) return group;
  const lat0 = all.reduce((a, c) => a + c[1], 0) / all.length;
  const lon0 = all.reduce((a, c) => a + c[0], 0) / all.length;

  const strands = [];
  let cx = 0, cz = 0, n = 0;
  const partsIn = (fault.parts || []).filter((p) => p && p.length > 1).map((part) => {
    const dense = densifyCoords(part);
    return { dense, pts: dense.map(([lon, lat]) => lonLatToLocalMeters(lon, lat, lon0, lat0)) };
  });
  const dipDirAll = structureDipDir(partsIn.map((s) => s.pts), fault.dipAzimuth ?? 90);
  partsIn.forEach(({ dense, pts }) => {
    const seabedY = offshoreSeabedY(BATHY, fault, dense);
    const grid = offshoreRowStack(fault, pts, dipDirAll, seabedY);
    grid.forEach((row) => row.forEach((p) => { cx += p.x; cz += p.z; n++; }));
    strands.push({ pts, grid, seabedY });
  });
  if (!n) return group;
  cx /= n; cz /= n;

  strands.forEach(({ pts, grid, seabedY }) => {
    const centred = grid.map((row) => row.map((p) => ({ x: p.x - cx, y: p.y, z: p.z - cz })));
    offshorePlaneMeshes(THREE, group.name, centred, pts.length).forEach((m) => group.add(m));
    const curve = new THREE.CatmullRomCurve3(pts.map((p, i) => new THREE.Vector3(p.x - cx, seabedY[i] + 6, p.z - cz)));
    const tube = new THREE.TubeGeometry(curve, Math.min(Math.max(pts.length * 2, 20), 400), 8, 8, false);
    const traceMesh = new THREE.Mesh(tube, new THREE.MeshBasicMaterial({
      color: 0xe11d1d, depthTest: false, depthWrite: false, transparent: true, opacity: 1,
    }));
    traceMesh.name = group.name + '_surfaceTrace';
    traceMesh.renderOrder = 999;
    traceMesh.castShadow = false;
    traceMesh.userData.noShadow = true;
    group.add(traceMesh);
  });

  const allPts = strands.flatMap((s) => s.pts);
  const gridSize = Math.max(
    Math.max(...allPts.map((p) => Math.abs(p.x - cx))),
    Math.max(...allPts.map((p) => Math.abs(p.z - cz)))
  ) * 2.1;

  if (BATHY && BATHY.loaded) {
    const half = Math.max(gridSize, 3000) / 2;
    const TERRAIN_EXAG = 1; // true vertical scale, matching the land single-fault page
    const N = 40;
    const mPerDegLon = 111320 * Math.cos(lat0 * DEG);
    const geo = new THREE.PlaneGeometry(half * 2, half * 2, N, N);
    geo.rotateX(-Math.PI / 2);
    const tp = geo.attributes.position;
    for (let i = 0; i < tp.count; i++) {
      const lon = lon0 + (tp.getX(i) + cx) / mPerDegLon;
      const lat = lat0 - (tp.getZ(i) + cz) / metersPerDegLat(lat0);
      tp.setY(i, Math.min(BATHY.sample(lon, lat), 0) * TERRAIN_EXAG);
    }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0x4a7daf, roughness: 0.95, metalness: 0, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide,
    }));
    mesh.name = group.name + '_seabed';
    mesh.renderOrder = -1;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  const grid = new THREE.GridHelper(Math.max(gridSize, 3000), 10, 0x9aa0a8, 0x9aa0a8);
  grid.name = group.name + '_groundRef';
  grid.material.transparent = true;
  grid.material.opacity = 0.15;
  grid.position.y = (strands[0].seabedY[Math.floor(strands[0].seabedY.length / 2)] || 0) + 2;
  group.add(grid);

  const midStrand = strands[0];
  const midC = Math.floor(midStrand.pts.length / 2);
  group.userData.depthAnchor = new THREE.Vector3(
    midStrand.pts[midC].x - cx, midStrand.seabedY[midC], midStrand.pts[midC].z - cz);
  // measured from the trace, matching how the workbook reports offshore seismogenic depth
  const depths = (fault.segments || []).map((s) => s.depth).filter((d) => d != null);
  group.userData.maxDepthKm = depths.length ? Math.max(...depths) : 0;
  return group;
}

/** Point the stage's camera straight down (north-up) over the given object, like the model
 *  room's "台灣地圖" button. Call after stage.setObject(). */
export function setTopDownView(stage, radiusM, center) {
  const cam = stage._camera, controls = stage._controls;
  if (!cam || !controls) return;
  // radiusM overrides the stage's own auto-fit. Needed because the seabed backdrop is now always
  // built out to the full grid, so an object-bounds fit would show the same wide view in every
  // domain; the domain should change the camera, not the backdrop.
  const target = controls.target.clone();
  if (radiusM) target.set(center ? center.x : 0, 0, center ? center.z : 0);
  const dist = radiusM
    ? radiusM / Math.tan((cam.fov * Math.PI) / 360)
    : (cam.position.distanceTo(target) || 200000);
  if (radiusM) controls.target.copy(target);
  cam.up.set(0, 1, 0);
  // Position almost-but-not-quite straight overhead: a perfectly vertical camera with a
  // standard Y-up vector is a degenerate basis (up parallel to view direction), which is what
  // caused the view to flip when orbited past the horizon. A tiny southward offset keeps the
  // basis well-defined and still reads as north-up, while letting the camera orbit smoothly
  // and continuously all the way under the terrain without ever flipping.
  const tiltEps = dist * 0.02;
  cam.position.set(target.x, target.y + dist, target.z + tiltEps);
  cam.lookAt(target);
  controls.update();
}

/** Top-down north-up fit over just the given faults' surface traces — centers and
 *  distances the camera so all of them stay in view, even a widely spread selection. */
export function fitFaultsToView(THREE, stage, faults, mapLon0 = 120.7, mapLat0 = 23.7) {
  const cam = stage._camera, controls = stage._controls;
  if (!cam || !controls || !faults || !faults.length) return;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  faults.forEach((f) => (f.coords || []).forEach(([lon, lat]) => {
    const p = lonLatToLocalMeters(lon, lat, mapLon0, mapLat0);
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }));
  if (!isFinite(minX)) return;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const span = Math.max(maxX - minX, maxZ - minZ, 4000);
  const dist = span * 1.6 + 15000;
  controls.target.set(cx, 0, cz);
  cam.up.set(0, 1, 0);
  const tiltEps = dist * 0.02;
  cam.position.set(cx, dist, cz + tiltEps);
  cam.lookAt(controls.target);
  controls.update();
}

export function buildFaultGroup(THREE, DEM, fault) {
  const group = new THREE.Group();
  group.name = fault.nameE.replace(/\s+/g, '_');

  const lats = fault.coords.map((c) => c[1]);
  const lons = fault.coords.map((c) => c[0]);
  const lat0 = lats.reduce((a, b) => a + b, 0) / lats.length;
  const lon0 = lons.reduce((a, b) => a + b, 0) / lons.length;

  const denseCoords = densifyCoords(fault.coords);
  const surfacePts = denseCoords.map(([lon, lat]) => lonLatToLocalMeters(lon, lat, lon0, lat0));
  const surfaceElev = denseCoords.map(([lon, lat]) => DEM.sample(lon, lat));

  const azimuthDeg = fault.dipAzimuth ?? 90;
  const dipDir = computeFaultAzimuth(surfacePts, azimuthDeg);
  const perp = surfacePts.map(() => dipDir);

  const depths = [0, ...fault.segments.map((s) => s.depth)];
  const rows = depths.length;
  const cols = surfacePts.length;

  const offsetAccum = new Array(cols).fill(0);
  const gridX = [], gridY = [], gridZ = [];
  for (let r = 0; r < rows; r++) {
    const rowX = [], rowY = [], rowZ = [];
    if (r > 0) {
      const seg = fault.segments[r - 1];
      const depthDeltaM = (depths[r] - depths[r - 1]) * 1000;
      const horizDelta = depthDeltaM / Math.tan(seg.dip * DEG);
      for (let c = 0; c < cols; c++) offsetAccum[c] += horizDelta;
    }
    for (let c = 0; c < cols; c++) {
      rowX.push(surfacePts[c].x + perp[c].x * offsetAccum[c]);
      rowZ.push(surfacePts[c].z + perp[c].z * offsetAccum[c]);
      rowY.push(surfaceElev[c] - depths[r] * 1000);
    }
    gridX.push(rowX); gridY.push(rowY); gridZ.push(rowZ);
  }

  let cx = 0, cz = 0, n = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { cx += gridX[r][c]; cz += gridZ[r][c]; n++; }
  cx /= n; cz /= n;

  const positions = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      positions.push(gridX[r][c] - cx, gridY[r][c], gridZ[r][c] - cz);

  const segColors = [0x999999, 0x999999, 0x999999];
  for (let segIdx = 0; segIdx < rows - 1; segIdx++) {
    const segPositions = [];
    for (let r = segIdx; r <= segIdx + 1; r++)
      for (let c = 0; c < cols; c++) {
        const base = (r * cols + c) * 3;
        segPositions.push(positions[base], positions[base + 1], positions[base + 2]);
      }
    const segIndices = [];
    // flip the quad diagonal every other column so the tessellation does not read as one
    // continuous set of parallel diagonal lines across the whole plane
    for (let c = 0; c < cols - 1; c++) {
      const a = c, b = a + 1, d = a + cols, e = d + 1;
      if ((c + segIdx) % 2 === 0) segIndices.push(a, d, b, b, d, e);
      else segIndices.push(a, d, e, a, e, b);
    }
    const segGeo = new THREE.BufferGeometry();
    segGeo.setAttribute('position', new THREE.Float32BufferAttribute(segPositions, 3));
    segGeo.setIndex(segIndices);
    segGeo.computeVertexNormals();
    const segMat = new THREE.MeshStandardMaterial({
      color: segColors[segIdx % segColors.length], roughness: 1.0, metalness: 0, side: THREE.DoubleSide,
      emissive: 0x8a8a8a, emissiveIntensity: 1,
      transparent: true, opacity: 0.7, depthWrite: false, flatShading: false,
    });
    const segMesh = new THREE.Mesh(segGeo, segMat);
    segMesh.name = `${group.name}_faultPlane_seg${segIdx + 1}_dip${fault.segments[segIdx].dip}`;
    segMesh.castShadow = false;
    segMesh.receiveShadow = false;
    segMesh.userData.noShadow = true;
    group.add(segMesh);
  }

  const tracePts3d = surfacePts.map((p, i) => new THREE.Vector3(p.x - cx, surfaceElev[i] + 6, p.z - cz));
  const traceCurve = new THREE.CatmullRomCurve3(tracePts3d);
  const traceGeo = new THREE.TubeGeometry(traceCurve, Math.min(Math.max(cols * 2, 20), 400), 8, 8, false);
  const traceMat = new THREE.MeshBasicMaterial({ color: 0xe11d1d, depthTest: false, depthWrite: false, transparent: true, opacity: 1 });
  const traceMesh = new THREE.Mesh(traceGeo, traceMat);
  traceMesh.name = `${group.name}_surfaceTrace`;
  traceMesh.renderOrder = 999;
  // no shadow: the trace keeps TRUE elevation while the terrain is vertically exaggerated, so its
  // real position sits inside the mountain -- the tube still draws on top (depthTest off) but its
  // shadow landed on the terrain as a grey streak unrelated to where the red line appears.
  traceMesh.castShadow = false;
  traceMesh.userData.noShadow = true;
  group.add(traceMesh);

  const gridSize = Math.max(
    Math.max(...surfacePts.map((p) => Math.abs(p.x - cx))),
    Math.max(...surfacePts.map((p) => Math.abs(p.z - cz)))
  ) * 2.1;
  const terrainHalf = Math.max(gridSize, 3000) / 2;
  const N = 28;
  const mPerDegLon = 111320 * Math.cos(lat0 * DEG);
  // true vertical scale on the single-fault pages: the reference patch, the fault plane and the
  // surface trace are all at real elevation/depth, so nothing on this page is exaggerated.
  const TERRAIN_EXAG = 1;
  const terrainGeo = new THREE.PlaneGeometry(terrainHalf * 2, terrainHalf * 2, N, N);
  terrainGeo.rotateX(-Math.PI / 2);
  const tp = terrainGeo.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    const lx = tp.getX(i) + cx;
    const lz = tp.getZ(i) + cz;
    const lon = lon0 + lx / mPerDegLon;
    const lat = lat0 - lz / metersPerDegLat(lat0);
    tp.setY(i, DEM.sample(lon, lat) * TERRAIN_EXAG);
  }
  terrainGeo.computeVertexNormals();
  const terrainMat = new THREE.MeshStandardMaterial({
    color: 0x5b6b57, roughness: 0.95, metalness: 0, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide,
  });
  const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
  terrainMesh.name = `${group.name}_terrain`;
  terrainMesh.renderOrder = -1;
  terrainMesh.receiveShadow = true;
  group.add(terrainMesh);

  const grid = new THREE.GridHelper(Math.max(gridSize, 3000), 10, 0x9aa0a8, 0x9aa0a8);
  grid.name = `${group.name}_groundRef`;
  grid.material.transparent = true;
  grid.material.opacity = 0.15;
  grid.position.y = 2;
  group.add(grid);

  // reference anchor for the detail page's depth ruler: a real point on the surface trace
  // (depth 0) plus the fault's true max depth, so the ruler tracks real geometry, not exaggeration.
  const midC = Math.floor(cols / 2);
  group.userData.depthAnchor = new THREE.Vector3(surfacePts[midC].x - cx, surfaceElev[midC], surfacePts[midC].z - cz);
  group.userData.maxDepthKm = depths[depths.length - 1];

  return group;
}

window.__faultGeometryModule = {
  buildFaultGroup, buildTaiwanMap, setTopDownView, fitFaultsToView, lonLatToLocalMeters,
  buildBathymetry, buildOffshoreFaultMesh, buildOffshoreFaultGroup,
};
