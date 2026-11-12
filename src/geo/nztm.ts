// NZTM2000 (EPSG:2193): transverse Mercator on GRS80. LINZ rasters are in this
// projection, so using it for the world keeps 1 unit = 1 metre with no resampling.
const A = 6378137;
const F = 1 / 298.257222101;
const K0 = 0.9996;
const LON0 = (173 * Math.PI) / 180;
const FE = 1600000;
const FN = 10000000;
const E2 = 2 * F - F * F;
const EP2 = E2 / (1 - E2);

function meridianArc(lat: number): number {
  const e4 = E2 * E2;
  const e6 = e4 * E2;
  return (
    A *
    ((1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * lat -
      ((3 * E2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * lat) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * lat) -
      ((35 * e6) / 3072) * Math.sin(6 * lat))
  );
}

/** WGS84 degrees → NZTM [easting, northing] in metres. */
export function toNztm(latDeg: number, lonDeg: number): [number, number] {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const s = Math.sin(lat);
  const c = Math.cos(lat);
  const t = Math.tan(lat);
  const n = A / Math.sqrt(1 - E2 * s * s);
  const t2 = t * t;
  const c2 = EP2 * c * c;
  const a = (lon - LON0) * c;
  const m = meridianArc(lat);
  const a2 = a * a;
  const e =
    FE +
    K0 * n * (a + ((1 - t2 + c2) * a2 * a) / 6 + ((5 - 18 * t2 + t2 * t2 + 72 * c2 - 58 * EP2) * a2 * a2 * a) / 120);
  const nn =
    FN +
    K0 *
      (m +
        n *
          t *
          (a2 / 2 +
            ((5 - t2 + 9 * c2 + 4 * c2 * c2) * a2 * a2) / 24 +
            ((61 - 58 * t2 + t2 * t2 + 600 * c2 - 330 * EP2) * a2 * a2 * a2) / 720));
  return [e, nn];
}

/** NZTM metres → WGS84 [lat, lon] degrees, by Newton iteration on the forward transform. */
export function fromNztm(e: number, n: number): [number, number] {
  let lat = -36.85;
  let lon = 174.76;
  for (let i = 0; i < 8; i++) {
    const [e0, n0] = toNztm(lat, lon);
    const [e1] = toNztm(lat, lon + 1e-5);
    const [, n1] = toNztm(lat + 1e-5, lon);
    lon += ((e - e0) / (e1 - e0)) * 1e-5;
    lat += ((n - n0) / (n1 - n0)) * 1e-5;
  }
  return [lat, lon];
}
