// Bathymetry loader: samples seabed elevation (metres, negative below sea level) from
// offshore-dem.png, the GEBCO-derived grid carried over from the model room.
//
// ENCODING -- the PNG is a 16-bit height field split across two channels: value = R*256 + G
// (blue unused), and elevation_m = value - 11000. Plate carree (unprojected lon/lat), 240 px per
// degree, so the 1920x1800 image covers exactly 8 deg of longitude by 7.5 deg of latitude.
//
// GEOREFERENCE -- extent and offset confirmed by the project owner: longitude 117E to 125E,
// latitude 19N to 26.5N, which at 240 px/deg is exactly the 1920x1800 raster. Two independent
// checks agree:
//   * the grid's highest cell lands at 121.231E 24.390N (Xueshan) at 3757 m -- the right peak, and
//     the right height for a 15-arcsec grid, which smooths Xueshan's true 3886 m;
//   * along 23.5N the zero-elevation crossings fall at 120.09E and 121.52E, matching Taiwan's
//     west and east coasts at that latitude.
const BATHY_URL = './offshore-dem.png';
const EXTENT = { lonMin: 117, lonMax: 125, latMin: 19, latMax: 26.5 };
const PX_PER_DEG = 240;
const ELEV_OFFSET = 11000;

let W = 0, H = 0, GRID = null;

function load() {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        W = img.width; H = img.height;
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, W, H).data;
        // pack to Int16 once so sampling touches a quarter of the memory the RGBA buffer needs
        GRID = new Int16Array(W * H);
        for (let i = 0, p = 0; i < GRID.length; i++, p += 4) GRID[i] = d[p] * 256 + d[p + 1] - ELEV_OFFSET;
        resolve(true);
      } catch (e) {
        // tainted canvas (file:// origin) -- bathymetry is simply skipped rather than fatal
        console.warn('bathy.js: could not read offshore-dem.png', e);
        resolve(false);
      }
    };
    img.onerror = () => { console.warn('bathy.js: offshore-dem.png failed to load'); resolve(false); };
    img.src = BATHY_URL;
  });
}

export const BATHY = {
  extent: EXTENT,
  get loaded() { return !!GRID; },
  ready: load(),
  /** Bilinear elevation in metres. Positive on land, negative below sea level, 0 outside the grid. */
  sample(lon, lat) {
    if (!GRID) return 0;
    const fx = (lon - EXTENT.lonMin) * PX_PER_DEG - 0.5;
    const fy = (EXTENT.latMax - lat) * PX_PER_DEG - 0.5;
    if (fx < 0 || fy < 0 || fx > W - 1 || fy > H - 1) return 0;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
    const tx = fx - x0, ty = fy - y0;
    const a = GRID[y0 * W + x0], b = GRID[y0 * W + x1], c = GRID[y1 * W + x0], e = GRID[y1 * W + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
  },
};

window.__bathyModule = { BATHY };
