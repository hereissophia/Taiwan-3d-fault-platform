// File export: turns selected faults into OBJ, XYZ and Shapefile downloads, bundled as a zip.
//
// GEOMETRY -- the fault plane is rebuilt here with the same ruled-surface projection the 3D view
// uses (one down-dip direction for the whole fault, taken as the perpendicular to the trace's own
// start-to-end trend and flipped to agree with the recorded dip azimuth), so an exported plane is
// the same surface the user was looking at, not an approximation of it.
//
// Z DATUM -- absolute elevation above mean sea level throughout, for every format and both CRSs.
// Land traces start at the DEM surface; offshore traces start on the seabed. Segment depths are
// measured down from the trace, which is the datum both source tables use, so the exported Z is
// (trace elevation) minus (segment depth).
//
// CRS -- every dataset is written twice, WGS84 geographic (EPSG:4326) and TWD97 TM2 (EPSG:3826),
// except OBJ, which is a local metric frame (see below) with its origin stated in both.
import { lonLatToTWD97 } from './dem.js';

const DEG = Math.PI / 180;
const metersPerDegLat = (lat) => 111132.92 - 559.82 * Math.cos(2 * lat * DEG) + 1.175 * Math.cos(4 * lat * DEG);
const mPerDegLon = (lat) => 111320 * Math.cos(lat * DEG);

const PRJ_WGS84 = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
const PRJ_TWD97 = 'PROJCS["TWD97_TM2_zone_121",GEOGCS["GCS_TWD_1997",DATUM["D_TWD_1997",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",250000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",121.0],PARAMETER["Scale_Factor",0.9999],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';

// ---------------------------------------------------------------- geometry

/** Same down-dip direction rule as fault-geometry.js, in east/north components. Takes ALL strands
 *  of a structure, so every strand steps down-dip the same way and their depth lines join up. */
function dipDirection(parts, azimuthDeg) {
  let ve = 0, vn = 0;
  parts.forEach((pts) => {
    for (let i = 1; i < pts.length; i++) {
      const latm = (pts[i][1] + pts[i - 1][1]) / 2;
      ve += (pts[i][0] - pts[i - 1][0]) * mPerDegLon(latm);
      vn += (pts[i][1] - pts[i - 1][1]) * metersPerDegLat(latm);
    }
  });
  const len = Math.hypot(ve, vn) || 1;
  ve /= len; vn /= len;
  let pe = vn, pn = -ve; // perpendicular to the trend
  const ae = Math.sin(azimuthDeg * DEG), an = Math.cos(azimuthDeg * DEG);
  if (pe * ae + pn * an < 0) { pe = -pe; pn = -pn; }
  return { e: pe, n: pn };
}

/** Trace elevation for one point: the land DEM, or the seabed for offshore structures. */
function traceZ(fault, lon, lat, dem, bathy) {
  if (fault.offshore) {
    if (bathy && bathy.loaded) return Math.min(bathy.sample(lon, lat), 0);
    return -(fault.seabedKm || 0) * 1000;
  }
  return dem ? dem.sample(lon, lat) : 0;
}

/** One strand's ruled surface: rows[r][c] = {lon, lat, z}. Row 0 is the trace. */
function strandRows(fault, part, dem, bathy, dir) {
  const surf = part.map(([lon, lat]) => traceZ(fault, lon, lat, dem, bathy));
  const steps = [{ down: 0, off: 0 }];
  let depth = 0, off = 0;
  (fault.segments || []).forEach((seg) => {
    if (seg.horizKm != null) {
      // a FLAT: keeps its depth and steps out horizontally (offshore ramp-flat geometry)
      off += seg.horizKm * 1000;
    } else {
      off += ((seg.depth - depth) * 1000) / Math.tan((seg.dip || 90) * DEG);
      depth = seg.depth;
    }
    steps.push({ down: depth * 1000, off });
  });
  return steps.map((s) => part.map(([lon, lat], i) => ({
    lon: lon + (dir.e * s.off) / mPerDegLon(lat),
    lat: lat + (dir.n * s.off) / metersPerDegLat(lat),
    z: surf[i] - s.down,
  })));
}

/** Every strand of a fault, as {trace, rows}. Offshore structures can have several. */
function faultStrands(fault, dem, bathy) {
  const parts = (fault.offshore && fault.parts && fault.parts.length ? fault.parts : [fault.coords || []])
    .filter((p) => p && p.length > 1);
  const dir = dipDirection(parts, fault.dipAzimuth ?? 90);
  return parts.map((p) => {
    const rows = strandRows(fault, p, dem, bathy, dir);
    return { rows, trace: rows[0] };
  });
}

/** Iso-depth contour lines on one strand's fault plane.
 *  The plane is the ruled grid rows[r][c]; for a target elevation z the crossing point in each
 *  along-strike column c is found by walking down that column and interpolating linearly between
 *  the two rows that straddle z. Joining those points across all columns gives one contour
 *  polyline. Depths are absolute (metres relative to mean sea level), so contours of an onshore
 *  and an offshore structure are directly comparable. */
function strandContours(strand, intervalM) {
  const rows = strand.rows;
  if (!rows || rows.length < 2) return [];
  const cols = rows[0].length;
  let zMax = -Infinity, zMin = Infinity;
  rows.forEach((row) => row.forEach((p) => {
    if (p.z > zMax) zMax = p.z;
    if (p.z < zMin) zMin = p.z;
  }));
  const out = [];
  const first = Math.ceil(zMin / intervalM) * intervalM;
  for (let z = first; z <= zMax + 1e-6; z += intervalM) {
    if (z >= 0 && zMax >= 0 && z === 0) continue; // sea level itself is the trace, not a contour
    const pts = [];
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows.length - 1; r++) {
        const a = rows[r][c], b = rows[r + 1][c];
        const hi = Math.max(a.z, b.z), lo = Math.min(a.z, b.z);
        if (z > hi || z < lo) continue;
        const span = a.z - b.z;
        const f = Math.abs(span) < 1e-9 ? 0 : (a.z - z) / span;
        pts.push({ lon: a.lon + (b.lon - a.lon) * f, lat: a.lat + (b.lat - a.lat) * f, z });
        break;
      }
    }
    if (pts.length > 1) out.push({ z, pts });
  }
  return out;
}

// ---------------------------------------------------------------- text formats

const fx = (v, n = 3) => (Math.abs(v) < 1e-9 ? '0' : v.toFixed(n));

/** OBJ in a local metric frame: X east, Y up, Z north, origin at the fault's own centroid. Real
 *  metres, so scale is true; 3D tools cannot hold Taiwan-scale coordinates without precision loss,
 *  which is why this one format is local -- the origin is stated in both CRSs in the header. */
function toOBJ(fault, strands, name) {
  const all = strands.flatMap((s) => s.trace);
  const lon0 = all.reduce((a, p) => a + p.lon, 0) / all.length;
  const lat0 = all.reduce((a, p) => a + p.lat, 0) / all.length;
  const o = lonLatToTWD97(lon0, lat0);
  const L = [
    '# ' + name,
    '# Local metric frame: X=east, Y=up (m above mean sea level), Z=north. Metres, true scale.',
    '# Origin  WGS84: ' + lon0.toFixed(6) + ', ' + lat0.toFixed(6),
    '# Origin TWD97 TM2 (EPSG:3826): ' + o.x.toFixed(2) + ', ' + o.y.toFixed(2),
    '# Groups: trace_* = surface trace polyline, plane_*_segN = fault plane, dip ' + (fault.dip ?? '?') + ' deg',
  ];
  const xyz = (p) => {
    const x = (p.lon - lon0) * mPerDegLon(lat0);
    const zn = (p.lat - lat0) * metersPerDegLat(lat0);
    return 'v ' + fx(x, 2) + ' ' + fx(p.z, 2) + ' ' + fx(zn, 2);
  };
  let base = 1;
  strands.forEach((s, si) => {
    const tag = strands.length > 1 ? '_p' + (si + 1) : '';
    const cols = s.trace.length;
    L.push('g trace' + tag);
    s.trace.forEach((p) => L.push(xyz(p)));
    L.push('l ' + Array.from({ length: cols }, (_, i) => base + i).join(' '));
    base += cols;
    for (let r = 0; r < s.rows.length - 1; r++) {
      L.push('g plane' + tag + '_seg' + (r + 1));
      const top = base, bot = base + cols;
      s.rows[r].forEach((p) => L.push(xyz(p)));
      s.rows[r + 1].forEach((p) => L.push(xyz(p)));
      for (let c = 0; c < cols - 1; c++) {
        L.push('f ' + (top + c) + ' ' + (bot + c) + ' ' + (bot + c + 1) + ' ' + (top + c + 1));
      }
      base += cols * 2;
    }
  });
  return L.join('\n') + '\n';
}

/** XYZ point cloud in WGS84. */
function toXYZ(fault, strands, name) {
  const L = [
    '# ' + name,
    '# lon lat elev_m  layer',
    '# lon/lat = WGS84 (EPSG:4326)',
    '# elev_m  = metres above mean sea level (negative = below)',
  ];
  strands.forEach((s, si) => {
    const tag = strands.length > 1 ? 'p' + (si + 1) + '_' : '';
    s.rows.forEach((row, r) => {
      const layer = r === 0 ? tag + 'trace' : tag + 'row' + r;
      row.forEach((p) => {
        L.push([p.lon.toFixed(7), p.lat.toFixed(7), fx(p.z, 2), layer].join(' '));
      });
    });
  });
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- shapefile

const utf8 = (s) => new TextEncoder().encode(String(s ?? ''));

class Buf {
  constructor() { this.parts = []; this.len = 0; }
  push(u8) { this.parts.push(u8); this.len += u8.length; return this; }
  num(size, value, little, float) {
    const b = new Uint8Array(size), dv = new DataView(b.buffer);
    if (float) dv.setFloat64(0, value, little);
    else if (size === 4) dv.setInt32(0, value, little);
    return this.push(b);
  }
  i32be(v) { return this.num(4, v, false); }
  i32le(v) { return this.num(4, v, true); }
  // NB: the float flag is required -- without it num() falls through both branches and writes eight
  // zero bytes, which silently turned every shapefile coordinate into 0 and left QGIS with an empty
  // layer at the origin.
  f64le(v) { return this.num(8, v, true, true); }
  bytes() {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

/** .shp + .shx for a set of PolylineZ (11 -> type 13) or PolygonZ (15) records.
 *  Each record here is a single part, which keeps the ring/part table trivial. M values are omitted
 *  (they are optional in the ESRI spec and GDAL reads records without them). */
function shpPair(shapeType, records) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity, zmin = Infinity, zmax = -Infinity;
  records.forEach((pts) => pts.forEach((p) => {
    if (p.x < xmin) xmin = p.x; if (p.x > xmax) xmax = p.x;
    if (p.y < ymin) ymin = p.y; if (p.y > ymax) ymax = p.y;
    if (p.z < zmin) zmin = p.z; if (p.z > zmax) zmax = p.z;
  }));
  if (!records.length) { xmin = ymin = zmin = 0; xmax = ymax = zmax = 0; }

  const header = (fileWords) => {
    const b = new Buf();
    b.i32be(9994);
    for (let i = 0; i < 5; i++) b.i32be(0);
    b.i32be(fileWords);
    b.i32le(1000);
    b.i32le(shapeType);
    [xmin, ymin, xmax, ymax, zmin, zmax, 0, 0].forEach((v) => b.f64le(v));
    return b.bytes();
  };

  const bodies = records.map((pts) => {
    const b = new Buf();
    let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity, rz0 = Infinity, rz1 = -Infinity;
    pts.forEach((p) => {
      if (p.x < rx0) rx0 = p.x; if (p.x > rx1) rx1 = p.x;
      if (p.y < ry0) ry0 = p.y; if (p.y > ry1) ry1 = p.y;
      if (p.z < rz0) rz0 = p.z; if (p.z > rz1) rz1 = p.z;
    });
    b.i32le(shapeType);
    [rx0, ry0, rx1, ry1].forEach((v) => b.f64le(v));
    b.i32le(1);            // numParts
    b.i32le(pts.length);   // numPoints
    b.i32le(0);            // part 0 starts at point 0
    pts.forEach((p) => { b.f64le(p.x); b.f64le(p.y); });
    b.f64le(rz0); b.f64le(rz1);
    pts.forEach((p) => b.f64le(p.z));
    return b.bytes();
  });

  let words = 50;
  const shpParts = [], shxParts = [];
  bodies.forEach((body, i) => {
    const rh = new Buf();
    rh.i32be(i + 1);
    rh.i32be(body.length / 2);
    shpParts.push(rh.bytes(), body);
    const xi = new Buf();
    xi.i32be(words);
    xi.i32be(body.length / 2);
    shxParts.push(xi.bytes());
    words += 4 + body.length / 2;
  });

  const join = (head, parts) => {
    const total = parts.reduce((a, p) => a + p.length, head.length);
    const out = new Uint8Array(total);
    out.set(head, 0);
    let o = head.length;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  return {
    shp: join(header(words), shpParts),
    shx: join(header(50 + 4 * records.length), shxParts),
  };
}

/** dBASE III table. Text fields hold UTF-8 bytes, declared by a .cpg sidecar. */
function dbf(fields, rows) {
  const recLen = 1 + fields.reduce((a, f) => a + f.size, 0);
  const b = new Buf();
  const now = new Date();
  b.push(new Uint8Array([0x03, now.getFullYear() - 1900, now.getMonth() + 1, now.getDate()]));
  b.i32le(rows.length);
  const hdrLen = 32 + 32 * fields.length + 1;
  const h = new Uint8Array(4), dv = new DataView(h.buffer);
  dv.setUint16(0, hdrLen, true); dv.setUint16(2, recLen, true);
  b.push(h);
  b.push(new Uint8Array(20));
  fields.forEach((f) => {
    const fb = new Uint8Array(32);
    const nm = utf8(f.name).slice(0, 10);
    fb.set(nm, 0);
    fb[11] = f.type.charCodeAt(0);
    fb[16] = f.size;
    fb[17] = f.dec || 0;
    b.push(fb);
  });
  b.push(new Uint8Array([0x0d]));
  rows.forEach((r) => {
    b.push(new Uint8Array([0x20]));
    fields.forEach((f) => {
      const cell = new Uint8Array(f.size).fill(0x20);
      let v = r[f.name];
      if (f.type === 'N') {
        const s = v == null || v === '' ? '' : Number(v).toFixed(f.dec || 0);
        const sb = utf8(s).slice(0, f.size);
        cell.set(sb, f.size - sb.length); // numbers are right-aligned
      } else {
        cell.set(utf8(v).slice(0, f.size), 0);
      }
      b.push(cell);
    });
  });
  b.push(new Uint8Array([0x1a]));
  return b.bytes();
}

// The table answers only two questions: which fault is this line, and how deep is it.
const SHP_FIELDS = [
  { name: 'ID', type: 'C', size: 10 },
  { name: 'NAME', type: 'C', size: 60 },
  { name: 'NAME_EN', type: 'C', size: 80 },
  { name: 'Z_TOP_M', type: 'N', size: 12, dec: 1 },
  { name: 'Z_BOT_M', type: 'N', size: 12, dec: 1 },
];

function attrRow(f, mag, part, seg, zTop, zBot) {
  return { ID: f.id, NAME: f.name, NAME_EN: f.nameE || '', Z_TOP_M: zTop, Z_BOT_M: zBot };
}

/** Line shapefiles for one fault in one CRS: the surface trace, the geometry's own depth lines
 *  (dip changes and base) and, optionally, interpolated iso-depth contours. All PolylineZ. */
function faultShapefiles(fault, strands, mag, crs, contourKm) {
  const proj = crs === 'twd97'
    ? (p) => { const t = lonLatToTWD97(p.lon, p.lat); return { x: t.x, y: t.y, z: p.z }; }
    : (p) => ({ x: p.lon, y: p.lat, z: p.z });
  const traceRecs = [], traceAttrs = [];
  const contRecs = [], contAttrs = [];
  const hingeRecs = [], hingeAttrs = [];
  strands.forEach((s, si) => {
    traceRecs.push(s.trace.map(proj));
    // The geometry's own depth lines: every row below the trace sits at a segment boundary --
    // a dip change (kink) or the base of the fault. A handful of lines per fault, and unlike the
    // interpolated contours they are original data, not a resampling of it.
    for (let r = 1; r < s.rows.length; r++) {
      const row = s.rows[r];
      hingeRecs.push(row.map(proj));
      const zs = row.map((p) => p.z);
      hingeAttrs.push(attrRow(fault, mag, si + 1, r, Math.max(...zs), Math.min(...zs)));
    }
    if (contourKm > 0) {
      strandContours(s, contourKm * 1000).forEach((c) => {
        contRecs.push(c.pts.map(proj));
        contAttrs.push(attrRow(fault, mag, si + 1, 0, c.z, c.z));
      });
    }
    const z = s.trace.map((p) => p.z);
    traceAttrs.push(attrRow(fault, mag, si + 1, 0, Math.max(...z), Math.min(...z)));
  });
  const prj = crs === 'twd97' ? PRJ_TWD97 : PRJ_WGS84;
  const set = (base, type, recs, attrs) => {
    const { shp, shx } = shpPair(type, recs);
    return [
      [base + '.shp', shp], [base + '.shx', shx],
      [base + '.dbf', dbf(SHP_FIELDS, attrs)],
      [base + '.prj', prj], [base + '.cpg', 'UTF-8'],
    ];
  };
  const out = [...set('trace', 13, traceRecs, traceAttrs)];
  if (hingeRecs.length) out.push(...set('depth_lines', 13, hingeRecs, hingeAttrs));
  if (contRecs.length) out.push(...set('contour_' + String(contourKm).replace('.', 'p') + 'km', 13, contRecs, contAttrs));
  return out;
}

// ---------------------------------------------------------------- zip (stored)

let CRC_TABLE = null;
function crc32(u8) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Minimal store-only zip. No compression, so no deflate dependency; the payload is mostly text and
 *  the browser is handed one Blob. */
function makeZip(files) {
  const enc = files.map(([name, data]) => ({
    name: utf8(name),
    data: typeof data === 'string' ? utf8(data) : data,
  }));
  const local = [], central = [];
  let offset = 0;
  enc.forEach((f) => {
    const crc = crc32(f.data);
    const mk = (central0) => {
      const b = new Buf();
      b.i32le(central0 ? 0x02014b50 : 0x04034b50);
      if (central0) b.push(new Uint8Array([20, 0]));
      b.push(new Uint8Array([20, 0]));       // version needed
      b.push(new Uint8Array([0x00, 0x08]));  // flags: UTF-8 names
      b.push(new Uint8Array([0, 0]));        // method 0 = stored
      b.push(new Uint8Array([0, 0, 0, 0]));  // time/date
      b.i32le(crc | 0);
      b.i32le(f.data.length);
      b.i32le(f.data.length);
      const n = new Uint8Array(4), dv = new DataView(n.buffer);
      dv.setUint16(0, f.name.length, true);
      dv.setUint16(2, 0, true);
      b.push(n);
      if (central0) {
        // comment length (2) + disk number start (2) + internal attributes (2) = 6 bytes
        b.push(new Uint8Array(6));
        b.i32le(0);                          // external attributes
        b.i32le(offset);                     // offset of this entry's local header
      }
      b.push(f.name);
      return b.bytes();
    };
    const lh = mk(false);
    local.push(lh, f.data);
    central.push(mk(true));
    offset += lh.length + f.data.length;
  });
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Buf();
  end.i32le(0x06054b50);
  const e = new Uint8Array(8), edv = new DataView(e.buffer);
  edv.setUint16(0, 0, true); edv.setUint16(2, 0, true);
  edv.setUint16(4, enc.length, true); edv.setUint16(6, enc.length, true);
  end.push(e);
  end.i32le(cdSize);
  end.i32le(offset);
  end.push(new Uint8Array([0, 0]));
  return new Blob([...local, ...central, end.bytes()], { type: 'application/zip' });
}

// ---------------------------------------------------------------- entry point

/** Filesystem-safe basename, English where available so the zip unpacks cleanly everywhere. */
function slug(f) {
  const s = (f.nameE || f.name || String(f.id)).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  // keep any letter suffix on the number (54A / 54B are two structures, not one)
  const raw = String(f.num ?? f.id);
  const digits = (raw.match(/\d+/) || [''])[0];
  const suffix = raw.slice(raw.indexOf(digits) + digits.length).replace(/[^A-Za-z0-9]/g, '');
  return (f.offshore ? 'OS' : 'LD') + digits.padStart(2, '0') + suffix + '_' + (s || 'fault');
}

/**
 * Build and download the export bundle.
 * @param faults selected fault records
 * @param opts {format: 'obj'|'xyz'|'shp'|'all', dem, bathy, temMag, contourKm}
 */
export function exportFaults(faults, opts = {}) {
  const { format = 'all', dem, bathy, temMag, contourKm = 2 } = opts;
  const want = (k) => format === 'all' || format === k;
  const files = [];
  const usable = faults.filter((f) => (f.coords && f.coords.length > 1) || (f.parts && f.parts.length));

  usable.forEach((f) => {
    const strands = faultStrands(f, dem, bathy);
    if (!strands.length) return;
    const base = slug(f);
    const title = f.name + (f.nameE ? ' / ' + f.nameE : '');
    const mag = temMag ? String(temMag(f)) : '';
    if (want('obj')) files.push(['obj/' + base + '.obj', toOBJ(f, strands, title)]);
    if (want('xyz')) files.push(['xyz/' + base + '.xyz', toXYZ(f, strands, title)]);
    if (want('shp')) {
      ['wgs84'].forEach((crs) => {
        faultShapefiles(f, strands, mag, crs, contourKm).forEach(([nm, data]) => {
          // every sidecar carries the fault's id + name, so a QGIS project with many faults
          // loaded at once never shows a row of identical 'trace' / 'plane' layers
          files.push(['shp_' + crs + '/' + base + '/' + base + '_' + nm, data]);
        });
      });
    }
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const name = 'taiwan_faults_' + format + '_' + stamp + '.zip';
  const blob = makeZip(files);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { fileCount: files.length, faultCount: usable.length, name };
}

window.__faultExportModule = { exportFaults };
