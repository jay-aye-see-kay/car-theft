// The map picture: the city from above in flat colours (land, paving,
// parks, sand, water, buildings), one pixel per PX metres over the chunk
// grid, written to public/city/<area>/map.png. The game's minimap and
// full-screen map (src/map/) draw the roads over it as lines from the
// road graph, so they stay sharp however far you zoom in.
//
//   node --experimental-strip-types tools/citygen/map.ts
//
// It's made from the committed chunk files rather than OSM, so it needs no
// cache or network and always matches the city the game streams (build.ts
// runs it last, after writing them).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  decodeBuildings, decodeGround, decodeTerrain, SURFACE_ID, type CityManifest,
} from '../../src/city/format.ts';
import { MAP_COLOURS, MAP_PX, MAP_SHADES } from '../../src/map/style.ts';

const CBD_DIR = fileURLToPath(new URL('../../public/city/cbd/', import.meta.url));

/** Roofs: triangles whose normal is at least this upright. */
const UPRIGHT = 0.5;

export function writeMap(DIR = CBD_DIR): void {
  const manifest = JSON.parse(readFileSync(DIR + 'manifest.json', 'utf8')) as CityManifest;
  const { bounds, grid, chunkSize } = manifest;
  const w = Math.round((bounds.maxX - bounds.minX) / MAP_PX);
  const h = Math.round((bounds.maxZ - bounds.minZ) / MAP_PX);
  const px = new Uint8Array(w * h);
  const level = manifest.water?.level ?? 0;
  const cell = manifest.terrain.cellSize;

  const shade = (s: keyof typeof MAP_SHADES) => MAP_SHADES[s];
  const ofClass = new Uint8Array(16).fill(shade('land'));
  ofClass[SURFACE_ID.grass] = shade('park');
  ofClass[SURFACE_ID.flowerbed] = shade('park');
  ofClass[SURFACE_ID.trees] = shade('woods');
  ofClass[SURFACE_ID.sand] = shade('sand');
  ofClass[SURFACE_ID.path] = shade('park');
  ofClass[SURFACE_ID.paving] = shade('paving');
  ofClass[SURFACE_ID.footpath] = shade('paving');
  ofClass[SURFACE_ID.road] = shade('paving');

  for (const ch of manifest.chunks) {
    const x0 = grid.x0 + ch.i * chunkSize;
    const z0 = grid.z0 + ch.j * chunkSize;
    const terrain = decodeTerrain(inflateSync(readFileSync(DIR + ch.files.terrain)));
    const ground = ch.files.ground ? decodeGround(inflateSync(readFileSync(DIR + ch.files.ground))) : null;
    const ta = manifest.terrain.apron;
    const ga = manifest.ground?.apron ?? 0;
    // Nearest lattice point to each pixel centre in this chunk.
    const p0x = Math.round((x0 - bounds.minX) / MAP_PX);
    const p0z = Math.round((z0 - bounds.minZ) / MAP_PX);
    const side = Math.round(chunkSize / MAP_PX);
    for (let r = 0; r < side; r++) {
      for (let c = 0; c < side; c++) {
        const lx = Math.round(((c + 0.5) * MAP_PX) / cell);
        const lz = Math.round(((r + 0.5) * MAP_PX) / cell);
        const y = terrain.heights[(lz + ta) * terrain.n + lx + ta];
        let v: number;
        if (y < level) v = shade('water');
        else if (ground) v = ofClass[ground.classes[(lz + ga) * ground.n + lx + ga]];
        else v = shade('land');
        px[(p0z + r) * w + p0x + c] = v;
      }
    }
  }

  // Roofs on top: the chunk's main building triangles (not the near-only
  // detail or the tree tiles), seen from above.
  const fill = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number, v: number) => {
    const tx = (x: number) => (x - bounds.minX) / MAP_PX;
    const tz = (z: number) => (z - bounds.minZ) / MAP_PX;
    const [x1, z1, x2, z2, x3, z3] = [tx(ax), tz(az), tx(bx), tz(bz), tx(cx), tz(cz)];
    const area = (x2 - x1) * (z3 - z1) - (x3 - x1) * (z2 - z1);
    if (Math.abs(area) < 1e-9) return;
    const minC = Math.max(0, Math.floor(Math.min(x1, x2, x3)));
    const maxC = Math.min(w - 1, Math.ceil(Math.max(x1, x2, x3)));
    const minR = Math.max(0, Math.floor(Math.min(z1, z2, z3)));
    const maxR = Math.min(h - 1, Math.ceil(Math.max(z1, z2, z3)));
    for (let r = minR; r <= maxR; r++) {
      const pz = r + 0.5;
      for (let c = minC; c <= maxC; c++) {
        const pxc = c + 0.5;
        const e1 = ((x2 - x1) * (pz - z1) - (pxc - x1) * (z2 - z1)) / area;
        const e2 = ((x3 - x2) * (pz - z2) - (pxc - x2) * (z3 - z2)) / area;
        const e3 = ((x1 - x3) * (pz - z3) - (pxc - x3) * (z1 - z3)) / area;
        if (e1 >= 0 && e2 >= 0 && e3 >= 0) px[r * w + c] = v;
      }
    }
  };
  for (const ch of manifest.chunks) {
    if (!ch.files.buildings) continue;
    const m = decodeBuildings(inflateSync(readFileSync(DIR + ch.files.buildings)));
    const cx = grid.x0 + (ch.i + 0.5) * chunkSize;
    const cz = grid.z0 + (ch.j + 0.5) * chunkSize;
    const end = Math.min(m.nearOnly ?? Infinity, m.fineFrom ?? Infinity, m.groups ? m.groups.from[0] : Infinity, m.indices.length);
    const ix = m.indices;
    for (let t = 0; t + 2 < end; t += 3) {
      const a = ix[t], b = ix[t + 1], c = ix[t + 2];
      const ux = (m.xCm[b] - m.xCm[a]) / 100, uy = (m.yCm[b] - m.yCm[a]) / 100, uz = (m.zCm[b] - m.zCm[a]) / 100;
      const vx = (m.xCm[c] - m.xCm[a]) / 100, vy = (m.yCm[c] - m.yCm[a]) / 100, vz = (m.zCm[c] - m.zCm[a]) / 100;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-6 || Math.abs(ny) / len < UPRIGHT) continue;
      fill(cx + m.xCm[a] / 100, cz + m.zCm[a] / 100, cx + m.xCm[b] / 100, cz + m.zCm[b] / 100, cx + m.xCm[c] / 100, cz + m.zCm[c] / 100, shade('building'));
    }
  }
  // Landmarks drawn by hand-made models are left out of the chunks: fill their footprints.
  for (const lm of manifest.landmarks ?? []) {
    if (!lm.hidden) continue;
    const f = lm.footprint;
    for (let k = 0; k < f.length; k++) {
      const [ax, az] = f[k];
      const [bx, bz] = f[(k + 1) % f.length];
      fill(lm.x, lm.z, ax, az, bx, bz, shade('building'));
    }
  }

  const png = encodePng(w, h, px, MAP_COLOURS);
  writeFileSync(DIR + 'map.png', png);
  console.log(`map.png: ${w} x ${h} px at ${MAP_PX} m, ${(png.length / 1024).toFixed(0)} KB`);
}

/** An 8-bit palette PNG: no dependency, and flat colours compress to almost nothing. */
function encodePng(w: number, h: number, px: Uint8Array, palette: readonly string[]): Uint8Array {
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, w);
  hv.setUint32(4, h);
  ihdr.set([8, 3, 0, 0, 0], 8);
  const plte = new Uint8Array(palette.length * 3);
  palette.forEach((hex, k) => plte.set([1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16)), k * 3));
  const raw = new Uint8Array(h * (w + 1));
  for (let r = 0; r < h; r++) raw.set(px.subarray(r * w, (r + 1) * w), r * (w + 1) + 1);
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeMap();
