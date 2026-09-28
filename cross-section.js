// Cross-section: samples a vertical slice between two points and draws it as SVG.
//
// GEOMETRY -- the section plane is the vertical plane through A and B. Everything is expressed in
// (s, z): s = distance along the A->B azimuth from A in km, z = elevation in metres. Off-plane
// faults are drawn only where they truly intersect the plane; hypocentres are the one thing
// projected onto it, which is why the corridor half-width matters for them.
//
// FAULT INTERSECTION -- a fault plane is the ruled surface between its depth rows, so its trace with
// the section is found row by row: for each depth row, the polyline is walked looking for crossings
// of the section plane, and the crossings of consecutive rows are joined into a segment. That gives
// the true intersection line, not a projection of the whole plane onto the section.
//
// OUTPUT -- one SVG string, used both for the on-screen panel and for the SVG download; the PNG is
// rasterised from the same SVG so the two exports cannot drift apart.
const DEG = Math.PI / 180;
const metersPerDegLat = (lat) => 111132.92 - 559.82 * Math.cos(2 * lat * DEG) + 1.175 * Math.cos(4 * lat * DEG);
const mPerDegLon = (lat) => 111320 * Math.cos(lat * DEG);

/** Local east/north metres of P relative to A. */
function offsetM(a, p) {
  const latm = (a.lat + p.lat) / 2;
  return { e: (p.lon - a.lon) * mPerDegLon(latm), n: (p.lat - a.lat) * metersPerDegLat(latm) };
}

/** Section frame: unit vector along A->B, and the in-plane distance / perpendicular offset of any
 *  point, both in kilometres. */
function frame(a, b) {
  const d = offsetM(a, b);
  const len = Math.hypot(d.e, d.n) || 1;
  const ue = d.e / len, un = d.n / len;
  return {
    lengthKm: len / 1000,
    azimuth: (Math.atan2(ue, un) / DEG + 360) % 360,
    project(p) {
      const o = offsetM(a, p);
      return { s: (o.e * ue + o.n * un) / 1000, t: (o.e * -un + o.n * ue) / 1000 };
    },
    lonLatAt(km) {
      const m = km * 1000;
      const latm = a.lat;
      return { lon: a.lon + (ue * m) / mPerDegLon(latm), lat: a.lat + (un * m) / metersPerDegLat(latm) };
    },
  };
}

/** Ground profile along the section: land DEM on land, seabed at sea. */
function groundProfile(f, dem, bathy, landmask, samples = 400) {
  const out = [];
  for (let i = 0; i <= samples; i++) {
    const s = (f.lengthKm * i) / samples;
    const { lon, lat } = f.lonLatAt(s);
    let z;
    if (landmask && landmask.loaded && bathy && bathy.loaded) {
      z = landmask.isLand(lon, lat) ? Math.max(dem ? dem.sample(lon, lat) : 0, 0) : Math.min(bathy.sample(lon, lat), 0);
    } else {
      z = dem ? dem.sample(lon, lat) : 0;
    }
    out.push({ s, z });
  }
  return out;
}

/** Depth rows of one fault strand in (lon, lat, z), same construction as the 3D view and the export. */
function strandRows(fault, part, dem, bathy, allParts) {
  let ve = 0, vn = 0;
  // the trend is summed over every strand of the structure, so all strands dip the same way
  (allParts || [part]).forEach((seg) => {
    for (let i = 1; i < seg.length; i++) {
      const latm = (seg[i][1] + seg[i - 1][1]) / 2;
      ve += (seg[i][0] - seg[i - 1][0]) * mPerDegLon(latm);
      vn += (seg[i][1] - seg[i - 1][1]) * metersPerDegLat(latm);
    }
  });
  const L = Math.hypot(ve, vn) || 1;
  ve /= L; vn /= L;
  let pe = vn, pn = -ve;
  const az = (fault.dipAzimuth ?? 90) * DEG;
  if (pe * Math.sin(az) + pn * Math.cos(az) < 0) { pe = -pe; pn = -pn; }
  const surf = part.map(([lon, lat]) => {
    if (fault.offshore) {
      return bathy && bathy.loaded ? Math.min(bathy.sample(lon, lat), 0) : -(fault.seabedKm || 0) * 1000;
    }
    return dem ? dem.sample(lon, lat) : 0;
  });
  const steps = [{ down: 0, off: 0 }];
  let depth = 0, off = 0;
  (fault.segments || []).forEach((seg) => {
    if (seg.horizKm != null) off += seg.horizKm * 1000;
    else { off += ((seg.depth - depth) * 1000) / Math.tan((seg.dip || 90) * DEG); depth = seg.depth; }
    steps.push({ down: depth * 1000, off });
  });
  return steps.map((st) => part.map(([lon, lat], i) => ({
    lon: lon + (pe * st.off) / mPerDegLon(lat),
    lat: lat + (pn * st.off) / metersPerDegLat(lat),
    z: surf[i] - st.down,
  })));
}

/** Where one depth row crosses the section plane, as {s, z} (there can be several). */
function rowCrossings(f, row) {
  const pr = row.map((p) => ({ ...f.project(p), z: p.z }));
  const out = [];
  for (let i = 1; i < pr.length; i++) {
    const a = pr[i - 1], b = pr[i];
    if ((a.t < 0) === (b.t < 0)) continue;
    const u = a.t / (a.t - b.t);
    const s = a.s + (b.s - a.s) * u;
    // crossings outside the drawn span are KEPT: a dipping plane's deep rows can cross well beyond
    // A or B', and dropping them used to break the polyline and lose the fault entirely. The plot
    // clips the drawing, so only the in-span part shows.
    out.push({ s, z: a.z + (b.z - a.z) * u });
  }
  return out;
}

/** Down-dip crossings: for each along-strike column, walk DOWN the rows and interpolate where the
 *  column passes through the section plane. This is what catches a section running near-parallel to
 *  strike -- such a plane cuts a dipping fault at one depth, giving a sub-horizontal line, which
 *  the along-strike test can never find. Joined across columns it is a true intersection. */
function columnCrossings(f, rows) {
  if (rows.length < 2) return [];
  const pr = rows.map((row) => row.map((p) => ({ ...f.project(p), z: p.z })));
  const cols = Math.min(...pr.map((r) => r.length));
  const line = [];
  for (let c = 0; c < cols; c++) {
    for (let r = 1; r < pr.length; r++) {
      const a = pr[r - 1][c], b = pr[r][c];
      if ((a.t < 0) === (b.t < 0)) continue;
      const u = a.t / (a.t - b.t);
      line.push({ s: a.s + (b.s - a.s) * u, z: a.z + (b.z - a.z) * u });
      break;
    }
  }
  const inSpan = line.filter((p) => p.s >= -0.5 && p.s <= f.lengthKm + 0.5);
  return line.length > 1 && inSpan.length ? [line] : [];
}

/** Intersection polylines of every selected fault with the section. */
function faultIntersections(f, faults, dem, bathy) {
  const out = [];
  faults.forEach((fault) => {
    const parts = fault.offshore && fault.parts && fault.parts.length ? fault.parts : [fault.coords || []];
    parts.forEach((part) => {
      if (!part || part.length < 2) return;
      const rows = strandRows(fault, part, dem, bathy, parts);
      const perRow = rows.map((r) => rowCrossings(f, r));
      const hit = [];
      // join equivalent crossings between consecutive rows -- index k is the k-th crossing of each
      // row, which holds as long as the trace does not double back across the plane between rows
      const nMax = Math.max(0, ...perRow.map((c) => c.length));
      for (let k = 0; k < nMax; k++) {
        const line = perRow.map((c) => c[k]).filter(Boolean);
        if (line.length < 2) continue;
        // keep it only if some part of the line falls inside the section span
        const inSpan = line.some((p) => p.s >= -0.5 && p.s <= f.lengthKm + 0.5);
        if (inSpan) hit.push({ fault, line });
      }
      // down-dip crossings are a FALLBACK: when the along-strike test already found the
      // intersection, adding them again drew the same fault twice, a few hundred metres apart
      if (!hit.length) columnCrossings(f, rows).forEach((line) => hit.push({ fault, line }));
      // a sinuous trace can cross the plane twice within a few hundred metres, which reads as a
      // doubled line rather than two structures -- keep only the distinct ones
      hit.forEach((h) => {
        const dup = out.some((o) => o.fault === fault && o.line.length === h.line.length
          && Math.abs(o.line[0].s - h.line[0].s) < 0.4 && Math.abs(o.line[0].z - h.line[0].z) < 300);
        if (!dup) out.push(h);
      });
    });
  });
  return out;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const niceStep = (span, target) => {
  const raw = span / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= raw) || 10 * p;
};

/**
 * Render the section as SVG.
 * @param opts {a, b, faults, points, dem, bathy, landmask, corridorKm, vExag, lang, width, height}
 * @returns {{svg:string, stats:{pointsIn:number, faultsIn:number, lengthKm:number, azimuth:number}}}
 */
export function renderSection(opts) {
  const {
    a, b, faults = [], points = [], dem, bathy, landmask,
    corridorKm = 10, vExag = 1, lang = 'zh', width = 1000, height = 460,
    depthMinKm, fitHeightPx,
  } = opts;
  const T = lang === 'en'
    ? { dist: 'Distance (km)', elev: 'Elevation (km)', main: 'Mainshock', after: 'Aftershock', pts: 'Hypocentre', corridor: 'Corridor', exag: 'Vertical exaggeration' }
    : { dist: '水平距離（km）', elev: '高程（km）', main: '主震', after: '餘震', pts: '震源', corridor: '廊帶半寬', exag: '垂直比例' };

  const f = frame(a, b);
  const ground = groundProfile(f, dem, bathy, landmask);
  const inters = faultIntersections(f, faults, dem, bathy);
  const proj = points
    .map((p) => ({ ...f.project(p), z: p.elevM, group: p.group, mag: p.mag }))
    .filter((p) => Math.abs(p.t) <= corridorKm && p.s >= 0 && p.s <= f.lengthKm);

  let zMin = Math.min(...ground.map((g) => g.z), 0);
  let zMax = Math.max(...ground.map((g) => g.z), 0);
  inters.forEach((it) => it.line.forEach((p) => {
    if (p.s < -0.5 || p.s > f.lengthKm + 0.5) return; // off-span parts must not stretch the axis
    zMin = Math.min(zMin, p.z); zMax = Math.max(zMax, p.z);
  }));
  proj.forEach((p) => { zMin = Math.min(zMin, p.z); });
  // snap the depth axis to the next 10 km below the deepest feature drawn, so a shallow section is
  // not stretched down to a fixed 30 km; depthMinKm only acts as a floor
  const deepestKm = Math.max(depthMinKm || 10, -zMin / 1000);
  zMin = -Math.ceil(deepestKm / 10) * 10 * 1000;
  zMax += Math.max((zMax - zMin) * 0.04, 400);

  const M = { l: 74, r: 20, t: 22, b: 46 };
  const plotW = width - M.l - M.r;
  // vExag 1 means the vertical scale equals the horizontal one; the plot box grows or shrinks with
  // it. fitHeightPx instead asks for the exaggeration that fills that height, so a section of any
  // length still shows its whole depth range in the panel -- the caller reports it back to the user.
  const kmPerPx = f.lengthKm / plotW;
  const trueH = (zMax - zMin) / 1000 / kmPerPx;
  const usedExag = fitHeightPx ? Math.max(0.1, Math.round((fitHeightPx / trueH) * 100) / 100) : vExag;
  const plotH = Math.max(120, Math.min(4000, trueH * usedExag));
  const H = plotH + M.t + M.b;
  const X = (s) => M.l + (s / f.lengthKm) * plotW;
  const Y = (z) => M.t + ((zMax - z) / (zMax - zMin)) * plotH;

  const P = [];
  P.push(`<rect x="0" y="0" width="${width}" height="${H}" fill="#f3eee4"/>`);
  P.push(`<rect x="${M.l}" y="${M.t}" width="${plotW}" height="${plotH}" fill="#ffffff" stroke="#c9c2b4"/>`);

  const zStepM = niceStep((zMax - zMin) / 1000, 6) * 1000;
  const sStepMaj = niceStep(f.lengthKm, 8);
  for (let z = Math.ceil(zMin / zStepM) * zStepM; z <= zMax; z += zStepM) {
    P.push(`<text x="${M.l - 8}" y="${(Y(z) + 4).toFixed(1)}" font-size="12" fill="#3c4a5c" text-anchor="end" font-family="system-ui,sans-serif">${(z / 1000).toFixed(0)}</text>`);
  }
  const sStep = sStepMaj;
  for (let s = 0; s <= f.lengthKm + 1e-6; s += sStep) {
    const x = X(s);
    P.push(`<text x="${x.toFixed(1)}" y="${(M.t + plotH + 18).toFixed(1)}" font-size="12" fill="#3c4a5c" text-anchor="middle" font-family="system-ui,sans-serif">${s.toFixed(0)}</text>`);
  }
  P.push(`<text x="${(M.l + plotW / 2).toFixed(1)}" y="${(H - 10).toFixed(1)}" font-size="12.5" fill="#3c4a5c" text-anchor="middle" font-family="system-ui,sans-serif">${esc(T.dist)}</text>`);
  P.push(`<text x="16" y="${(M.t + plotH / 2).toFixed(1)}" font-size="12.5" fill="#3c4a5c" text-anchor="middle" transform="rotate(-90 16 ${(M.t + plotH / 2).toFixed(1)})" font-family="system-ui,sans-serif">${esc(T.elev)}</text>`);

  P.push(`<clipPath id="sec-clip"><rect x="${M.l}" y="${M.t}" width="${plotW}" height="${plotH}"/></clipPath>`);
  P.push(`<g clip-path="url(#sec-clip)">`);

  // ground profile, filled below
  const gPath = ground.map((g, i) => `${i ? 'L' : 'M'}${X(g.s).toFixed(1)} ${Y(g.z).toFixed(1)}`).join(' ');
  P.push(`<path d="${gPath} L${X(f.lengthKm).toFixed(1)} ${(M.t + plotH).toFixed(1)} L${X(0).toFixed(1)} ${(M.t + plotH).toFixed(1)} Z" fill="#efe9dc" stroke="none"/>`);
  P.push(`<path d="${gPath}" fill="none" stroke="#6b5f4c" stroke-width="1.8"/>`);

  // depth grid, drawn over the ground fill so it stays visible: minor lines at a fifth of the
  // labelled step, the labelled lines themselves a shade darker
  for (let z = Math.ceil(zMin / (zStepM / 5)) * (zStepM / 5); z <= zMax; z += zStepM / 5) {
    const y = Y(z);
    P.push(`<line x1="${M.l}" y1="${y.toFixed(1)}" x2="${M.l + plotW}" y2="${y.toFixed(1)}" stroke="#c9c9c9" stroke-opacity="0.55"/>`);
  }
  for (let z = Math.ceil(zMin / zStepM) * zStepM; z <= zMax; z += zStepM) {
    const y = Y(z);
    P.push(`<line x1="${M.l}" y1="${y.toFixed(1)}" x2="${M.l + plotW}" y2="${y.toFixed(1)}" stroke="#a8a8a8" stroke-width="1"/>`);
  }

  // fault intersections + labels
  const labelled = new Set();
  inters.forEach((it) => {
    const d = it.line.map((p, i) => `${i ? 'L' : 'M'}${X(p.s).toFixed(1)} ${Y(p.z).toFixed(1)}`).join(' ');
    P.push(`<path d="${d}" fill="none" stroke="#c02828" stroke-width="2.4" stroke-linejoin="round"/>`);
    const head = it.line.find((p) => p.s >= 0 && p.s <= f.lengthKm) || it.line[0];
    if (!labelled.has(it.fault.id)) {
      labelled.add(it.fault.id);
      P.push(`<circle cx="${X(head.s).toFixed(1)}" cy="${Y(head.z).toFixed(1)}" r="3.4" fill="#c02828"/>`);
      const nm = lang === 'en' ? (it.fault.nameE || it.fault.name) : it.fault.name;
      P.push(`<text x="${(X(head.s) + 6).toFixed(1)}" y="${(Y(head.z) - 7).toFixed(1)}" font-size="12" font-weight="700" fill="#8f1f1f" font-family="system-ui,sans-serif">${esc(nm)}</text>`);
    }
  });

  // hypocentres
  const GC = { main: '#d93025', after: '#1f5fbf', none: '#6d4bb8' };
  proj.forEach((p) => {
    P.push(`<circle cx="${X(p.s).toFixed(1)}" cy="${Y(p.z).toFixed(1)}" r="3.2" fill="${GC[p.group || 'none']}" fill-opacity="0.8"/>`);
  });
  P.push(`</g>`);

  // A / B end labels
  P.push(`<text x="${M.l}" y="${(M.t - 7).toFixed(1)}" font-size="13" font-weight="800" fill="#1c2a3a" font-family="system-ui,sans-serif">A</text>`);
  P.push(`<text x="${(M.l + plotW).toFixed(1)}" y="${(M.t - 7).toFixed(1)}" font-size="13" font-weight="800" fill="#1c2a3a" text-anchor="end" font-family="system-ui,sans-serif">B</text>`);
  const meta = [`${f.lengthKm.toFixed(1)} km`, `${f.azimuth.toFixed(0)}°`,
    ...(proj.length ? [`${T.corridor} ±${corridorKm} km`] : []),
    `${T.exag} ${usedExag}×`].join(' · ');
  P.push(`<text x="${(M.l + plotW / 2).toFixed(1)}" y="${(M.t - 7).toFixed(1)}" font-size="11.5" fill="#5b6675" text-anchor="middle" font-family="system-ui,sans-serif">${esc(meta)}</text>`);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}">${P.join('')}</svg>`;
  return {
    svg,
    stats: { pointsIn: proj.length, faultsIn: labelled.size, lengthKm: f.lengthKm, azimuth: f.azimuth, vExag: usedExag },
  };
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const el = document.createElement('a');
  el.href = url; el.download = name;
  document.body.appendChild(el); el.click(); el.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function downloadSectionSVG(svg, name = 'cross_section.svg') {
  download(new Blob([svg], { type: 'image/svg+xml' }), name);
}

/** PNG rasterised from the same SVG, at 2x for print. */
export function downloadSectionPNG(svg, name = 'cross_section.png', scale = 2) {
  const m = /width="(\d+)" height="(\d+)"/.exec(svg);
  const w = m ? +m[1] : 1000, h = m ? +m[2] : 460;
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  img.onload = () => {
    const cv = document.createElement('canvas');
    cv.width = w * scale; cv.height = h * scale;
    const ctx = cv.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    cv.toBlob((blob) => blob && download(blob, name), 'image/png');
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

window.__crossSectionModule = { renderSection, downloadSectionSVG, downloadSectionPNG };
