// Adapter for the 55 offshore structures (Chen & Shyu 2025, BSSA doi 10.1785/0120250009), turning
// offshore-fault-data.js into the same record shape the app's land faults use so the list, the map,
// the selection tabs and the export cart can treat both alike.
//
// Kept distinct from the land records by `offshore: true` and an 'o'-prefixed id, and carrying
// `parts` (a structure may be mapped as several disjoint strands) plus `seabedKm` (Depth 0, the
// average water depth the trace sits at -- segment depths are measured DOWN FROM THERE, not from
// sea level).
import { OFFSHORE_FAULTS, OFFSHORE_DIP_AZIMUTH } from './offshore-fault-data.js';

const DEG = Math.PI / 180;

// The paper's slip codes: R reverse, N normal, RL right-lateral, LL left-lateral. A compound code
// like "RL/R" is right-lateral with a reverse component.
const TOKEN_ZH = { R: '逆移', N: '正移', RL: '右移', LL: '左移' };
const TOKEN_EN = { R: 'Reverse', N: 'Normal', RL: 'Dextral strike-slip', LL: 'Sinistral strike-slip' };

function tokens(type) {
  // strips the parenthetical hedge in "R(LL?)" -- it is a note on a possible extra component,
  // not a second slip code
  return String(type || '').replace(/\([^)]*\)/g, '').split('/').map((p) => p.trim().toUpperCase()).filter(Boolean);
}

function slipLabel(type, lang) {
  const ts = tokens(type);
  const tbl = lang === 'en' ? TOKEN_EN : TOKEN_ZH;
  if (!ts.length) return type || '—';
  if (ts.length === 1) return lang === 'en' ? tbl[ts[0]] || type : (tbl[ts[0]] || type) + '斷層';
  const parts = ts.map((x) => tbl[x] || x);
  return lang === 'en' ? parts.join('-') : parts.join('/') + '複合';
}

function traceLengthKm(line) {
  const R = 6371;
  let len = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const [lo1, la1] = line[i], [lo2, la2] = line[i + 1];
    const dLat = (la2 - la1) * DEG, dLon = (lo2 - lo1) * DEG;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * DEG) * Math.cos(la2 * DEG) * Math.sin(dLon / 2) ** 2;
    len += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return len;
}

const AZ_LABEL = (deg) => ['北', '東北', '東', '東南', '南', '西南', '西', '西北'][Math.round(((deg % 360) / 45)) % 8];

export const OFFSHORE = OFFSHORE_FAULTS.map((f) => {
  const parts = (f.parts || []).filter((p) => p && p.length > 1);
  // `coords` is the longest strand: the label anchor, viewport test and camera fit all want one
  // representative polyline, while the mesh builder draws every strand from `parts`.
  const coords = parts.slice().sort((a, b) => traceLengthKm(b) - traceLengthKm(a))[0] || [];
  const all = parts.flat();
  const lat = all.length ? all.reduce((a, c) => a + c[1], 0) / all.length : 0;
  const lon = all.length ? all.reduce((a, c) => a + c[0], 0) / all.length : 0;
  const segs = f.segments || [];
  const lastSeg = segs[segs.length - 1] || {};
  const dipAzimuth = OFFSHORE_DIP_AZIMUTH[String(f.id)] ?? 90;
  return {
    id: 'o' + f.id,
    num: f.tableId,
    offshore: true,
    type: f.type,
    name: f.nameC,
    nameE: f.nameE,
    coords,
    parts,
    segments: segs,
    seabedKm: f.seabedKm || 0,
    dipAzimuth,
    lat: +lat.toFixed(3),
    lon: +lon.toFixed(3),
    // two decimals, as mmc2.xlsx mostly gives them (23.08, 102.81) -- one decimal lost that
    lengthKm: f.lengthKm != null ? +Number(f.lengthKm).toFixed(2) : +traceLengthKm(coords).toFixed(2),
    widthKm: f.widthTableKm != null ? +Number(f.widthTableKm).toFixed(1) : null,
    depthKm: lastSeg.depth != null ? lastSeg.depth : null,
    temMag: null,
    dip: segs.length ? (segs.find((s) => s.dip != null) || {}).dip : null,
    dipDir: AZ_LABEL(dipAzimuth),
    strike: (dipAzimuth + 270) % 360,
    slipType: slipLabel(f.type, 'zh'),
    slipTypeEn: slipLabel(f.type, 'en'),
    region: '海域',
    activity: 'Chen & Shyu (2025) 海域構造',
    activityEn: 'Chen & Shyu (2025) offshore structure',
    lastRupture: '—',
    desc: '',
  };
});

window.__offshoreFaultsModule = { OFFSHORE };
