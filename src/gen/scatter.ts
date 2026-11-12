// Placement rules: whatever a place's profile says stands on each kind of ground cover, on a
// world-aligned jittered grid so the same spot always gets the same thing, in whatever order
// things are generated. Density is shaped by distance to paths, streams and the coast, and by
// slope and relief, so a rule can say "headstones crowd the paths" or "nīkau in the gullies".
import { Grid, fillRing } from '../geo/raster.ts';
import type { Heightfield } from '../model/load.ts';
import type { TileModel } from '../model/types.ts';
import type { ProfileContext } from '../profile/context.ts';
import type { Cover, Falloff, ScatterLayer, Tone } from '../profile/schema.ts';
import { type Track, halfWidth } from './tracks.ts';

/** One placed thing: a tree, a headstone, a bench. */
export interface Instance {
  kit: string;
  x: number;
  y: number;
  h: number;
  /** Overall size multiplier and a 0..1 value for colour and shape variation. */
  size: number;
  tint: number;
  /** Facing, anticlockwise from east, and lean in radians toward `leanDir`. */
  yaw: number;
  lean: number;
  leanDir: number;
  tone?: Tone;
  /** Which resolved profile placed it. */
  profile: number;
}

function hash(ix: number, iy: number, salt: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(salt, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const falloff = (d: number, [a, b]: Falloff): number => {
  if (a <= b) return d <= a ? 1 : d >= b ? 0 : 1 - (d - a) / (b - a);
  return d >= a ? 1 : d <= b ? 0 : (d - b) / (a - b);
};
/** 1 inside the range, fading to 0 over `soft` beyond it. */
const within = (v: number, [lo, hi]: [number, number], soft: number): number => Math.max(0, Math.min(1, 1 - Math.max(lo - v, v - hi, 0) / soft));

/** A 2 m raster of everything a tree must not stand on: buildings, roads and footpaths. Or of just the roads, or just the buildings. */
export function occupancy(model: TileModel, tracks: Iterable<Track>, what: 'everything' | 'roads' | 'buildings' = 'everything'): (x: number, y: number) => boolean {
  const cell = 2;
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(model.size.x / cell);
  cv.height = Math.ceil(model.size.y / cell);
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  g.setTransform(1 / cell, 0, 0, -1 / cell, cv.width / 2, cv.height / 2);
  g.fillStyle = g.strokeStyle = '#fff';
  g.lineCap = g.lineJoin = 'round';
  for (const b of what === 'roads' ? [] : model.buildings) {
    g.beginPath();
    b.ring.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fill();
    g.lineWidth = 3;
    g.stroke();
  }
  for (const a of what === 'everything' ? model.areas : []) {
    if (a.kind !== 'pitch' && a.kind !== 'water' && a.kind !== 'parking' && a.kind !== 'plaza') continue;
    g.beginPath();
    a.ring.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fill();
  }
  for (const t of what === 'buildings' ? [] : tracks) {
    g.beginPath();
    for (let i = 0; i < t.n; i++) {
      if (i) g.lineTo(t.x[i], t.y[i]);
      else g.moveTo(t.x[i], t.y[i]);
    }
    g.lineWidth = 2 * halfWidth(t, t.n >> 1) + 9;
    g.stroke();
  }
  for (const p of what === 'everything' ? model.paths : []) {
    g.beginPath();
    p.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.lineWidth = 4;
    g.stroke();
  }
  const px = g.getImageData(0, 0, cv.width, cv.height).data;
  return (x, y) => {
    const c = Math.floor(x / cell + cv.width / 2);
    const r = Math.floor(cv.height / 2 - y / cell);
    if (c < 0 || r < 0 || c >= cv.width || r >= cv.height) return what === 'everything';
    return px[(r * cv.width + c) * 4] > 60;
  };
}

export interface ScatterStats {
  /** Instances per kit. */
  kits: Record<string, number>;
}

export function scatter(model: TileModel, ground: Heightfield, blocked: (x: number, y: number) => boolean, ctx: ProfileContext, seed = 1): Instance[] {
  const out: Instance[] = [];
  const mg = new Grid(model.size.x, model.size.y, 2);
  // Every mapped area is a source, and so is all the land no area covers.
  const sources: { kind: Cover; ring?: (typeof model.areas)[number]['ring']; salt: number }[] = model.areas.map((a, salt) => ({ kind: a.kind, ring: a.ring, salt }));
  sources.push({ kind: 'open', salt: 7777 });
  // One stamp raster shared by every source: a source fills its own number in, then tests for it.
  const stamp = new Int32Array(mg.size);
  let n = 0;

  for (const src of sources) {
    const present = ctx.profilesIn(src.ring);
    const wanted = present.filter((i) => ctx.profiles[i].value.cover[src.kind]?.length);
    if (!wanted.length) continue;
    let [x0, y0, x1, y1] = [-model.size.x / 2, -model.size.y / 2, model.size.x / 2, model.size.y / 2];
    let inside: (x: number, y: number) => boolean;
    if (src.ring) {
      [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, y] of src.ring) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      const mine = ++n;
      fillRing(mg, src.ring, (c) => (stamp[c] = mine));
      inside = (x, y) => stamp[mg.index(x, y)] === mine;
    } else {
      inside = (x, y) => ctx.coverAt(x, y) === 'open';
    }
    for (const pi of wanted) {
      const layers = ctx.profiles[pi].value.cover[src.kind]!;
      layers.forEach((L: ScatterLayer, li) => {
        const step = L.spacing;
        const s0 = seed + src.salt + li * 1000003;
        const s1 = li * 7919;
        const shaped = !!(L.near || L.slope || L.relief);
        for (let iy = Math.floor(y0 / step); iy <= Math.ceil(y1 / step); iy++) {
          for (let ix = Math.floor(x0 / step); ix <= Math.ceil(x1 / step); ix++) {
            if (hash(ix, iy, s0) > L.chance) continue;
            const x = (ix + 0.15 + 0.7 * hash(ix, iy, seed + 101 + s1)) * step;
            const y = (iy + 0.15 + 0.7 * hash(ix, iy, seed + 202 + s1)) * step;
            if (!inside(x, y) || ctx.indexAt(x, y) !== pi || blocked(x, y)) continue;
            if (shaped) {
              let d = 1;
              for (const [k, f] of Object.entries(L.near ?? {})) d *= falloff(ctx.sample(k as 'path', x, y), f as Falloff);
              if (L.slope) d *= within(ctx.sample('slope', x, y), L.slope, 6);
              if (L.relief) d *= within(ctx.sample('relief', x, y), L.relief, 3);
              if (d <= 0 || hash(ix, iy, seed + 505 + s1) > d) continue;
            }
            const r = hash(ix, iy, seed + 303 + s1);
            const tint = hash(ix, iy, seed + 404 + s1);
            let yaw = hash(ix, iy, seed + 606 + s1) * Math.PI * 2;
            if (L.face === 'path') {
              const [tx, ty] = ctx.towardPath(x, y);
              yaw = Math.atan2(ty, tx) + (hash(ix, iy, seed + 707 + s1) - 0.5) * 0.3;
            }
            const lean = L.lean ? ((hash(ix, iy, seed + 808 + s1) ** 2 * L.lean) * Math.PI) / 180 : 0;
            out.push({
              kit: L.kit,
              x,
              y,
              h: ground.at(x, y),
              size: L.size[0] + (L.size[1] - L.size[0]) * r,
              tint,
              yaw,
              lean,
              leanDir: hash(ix, iy, seed + 909 + s1) * Math.PI * 2,
              tone: L.tone,
              profile: pi,
            });
          }
        }
      });
    }
  }
  return out;
}
