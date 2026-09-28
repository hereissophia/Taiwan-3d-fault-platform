// Land mask: a raster of "is this lon/lat on land", derived from the county-boundary vector layer.
//
// WHY THIS EXISTS -- cutting the terrain mesh along the coast leaves a sawtooth, because a cut edge
// can only ever fall on grid lines. Instead the terrain stays one uncut sheet and this mask decides,
// per texel of a high-resolution colour texture, whether to paint land or seabed. The shoreline is
// then as sharp as the texture (about 430 m), not as coarse as the mesh.
//
// METHOD -- the county layer is an unordered soup of line segments, and it contains INTERNAL county
// borders as well as the coast, so a scanline parity fill would stripe the island. Instead the
// segments are rasterised as hairlines and the SEA is flood-filled inward from the image border:
// whatever the flood cannot reach is land. Internal borders are simply never reached, so they do no
// harm, and the result needs no ring ordering or polygon topology at all.
//
// The layer covers Taiwan, Penghu, Kinmen, Matsu, Green Island, Orchid Island and Turtle Island, so
// all of them come out as land. It also reaches Taiping Island in the South China Sea, which falls
// outside this extent and is ignored.
import { twd97ToLonLat } from './dem.js';
import { COUNTY_BOUNDARY_EDGES } from './county-boundary-edges.js';

// Matches bathy.js so the mask, the bathymetry grid and the colour texture share one frame.
const EXTENT = { lonMin: 117, lonMax: 125, latMin: 19, latMax: 26.5 };
const W = 2048;
const H = Math.round((W * (EXTENT.latMax - EXTENT.latMin)) / (EXTENT.lonMax - EXTENT.lonMin));

let MASK = null;

function build() {
  const e = COUNTY_BOUNDARY_EDGES;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#fff';
  // slightly over 1px so the rasterised boundary is watertight and the flood cannot leak inland
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  const sx = W / (EXTENT.lonMax - EXTENT.lonMin), sy = H / (EXTENT.latMax - EXTENT.latMin);
  for (let i = 0; i < e.length; i += 4) {
    const a = twd97ToLonLat(e[i], e[i + 1]);
    const b = twd97ToLonLat(e[i + 2], e[i + 3]);
    ctx.moveTo((a.lon - EXTENT.lonMin) * sx, (EXTENT.latMax - a.lat) * sy);
    ctx.lineTo((b.lon - EXTENT.lonMin) * sx, (EXTENT.latMax - b.lat) * sy);
  }
  ctx.stroke();

  const d = ctx.getImageData(0, 0, W, H).data;
  const wall = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) wall[k] = d[k * 4] > 40 ? 1 : 0;

  const sea = new Uint8Array(W * H);
  // Mark-on-push BFS. Marking on POP instead lets a pixel be queued from all four neighbours, so
  // the queue can grow past W*H -- writes past the end of a fixed Int32Array are silently dropped,
  // which left whole patches of sea unvisited and therefore mis-classified as land (a green slab
  // south of Taiwan plus thin bars east of it). Marking on push bounds the queue to one entry per
  // pixel exactly.
  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  const push = (k) => { if (!sea[k] && !wall[k]) { sea[k] = 1; queue[tail++] = k; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (head < tail) {
    const k = queue[head++];
    const x = k % W, y = (k - x) / W;
    if (x > 0) push(k - 1);
    if (x < W - 1) push(k + 1);
    if (y > 0) push(k - W);
    if (y < H - 1) push(k + W);
  }
  const land = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) land[k] = sea[k] ? 0 : 1;
  return land;
}

export const LANDMASK = {
  extent: EXTENT,
  width: W,
  height: H,
  get loaded() { return !!MASK; },
  ready: (async () => {
    try { MASK = build(); return true; }
    catch (err) { console.warn('land-mask.js: could not build mask', err); return false; }
  })(),
  /** Mask value at a texel index, for callers walking the raster directly. */
  at(ix, iy) {
    if (!MASK || ix < 0 || iy < 0 || ix >= W || iy >= H) return 0;
    return MASK[iy * W + ix];
  },
  isLand(lon, lat) {
    if (!MASK) return false;
    const ix = Math.floor((lon - EXTENT.lonMin) * (W / (EXTENT.lonMax - EXTENT.lonMin)));
    const iy = Math.floor((EXTENT.latMax - lat) * (H / (EXTENT.latMax - EXTENT.latMin)));
    return this.at(ix, iy) === 1;
  },
};

window.__landMaskModule = { LANDMASK };
