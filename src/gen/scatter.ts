// Placement rules: whatever a place's profile says stands on each kind of ground cover, on a
// world-aligned jittered grid so the same spot always gets the same thing, in whatever order
// things are generated. Density is shaped by distance to paths, streams and the coast, and by
// slope and relief, so a rule can say "headstones crowd the paths" or "nīkau in the gullies".
import { type Bounds, Grid, fillRing, strokeLine } from '../geo/raster.ts';
import { boundsOf, boxOf, inBounds, overlaps } from './cells.ts';
import type { Heightfield } from '../model/load.ts';
import type { Area, TileModel } from '../model/types.ts';
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

/**
 * A 1 m raster of everything a tree must not stand on: buildings, roads and footpaths. Or of just the
 * roads, or just the buildings. Drawn by our own rasteriser on the NZTM grid rather than a canvas, so the
 * same data gives the same cells in a crop, another browser, a worker or the offline bake.
 */
export function occupancy(model: TileModel, tracks: Iterable<Track>, what: 'everything' | 'roads' | 'buildings' = 'everything'): (x: number, y: number) => boolean {
  const g = Grid.over(boundsOf(model), 1, model.origin);
  const mask = new Uint8Array(g.size);
  for (const b of what === 'roads' ? [] : model.buildings) {
    fillRing(g, b.ring, (c) => (mask[c] = 1));
    strokeLine(g, [...b.ring, b.ring[0]], 1.5, mask);
  }
  for (const a of what === 'everything' ? model.areas : []) {
    if (a.kind === 'pitch' || a.kind === 'water' || a.kind === 'parking' || a.kind === 'plaza') fillRing(g, a.ring, (c) => (mask[c] = 1));
  }
  for (const t of what === 'buildings' ? [] : tracks) {
    const pts: [number, number][] = [];
    for (let i = 0; i < t.n; i++) pts.push([t.x[i], t.y[i]]);
    strokeLine(g, pts, halfWidth(t, t.n >> 1) + 4.5, mask);
  }
  for (const p of what === 'everything' ? model.paths : []) strokeLine(g, p.pts, 2, mask);
  return (x, y) => {
    const c = g.index(x, y);
    return c < 0 ? what === 'everything' : mask[c] === 1;
  };
}

/** An integer salt from a stable id, so a rebake that adds or reorders areas leaves the others alone. */
function saltOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % 1000003;
}

/**
 * Everything the profiles scatter inside one cell. Each rule draws a jittered grid whose points sit on
 * NZTM, so a point's fate depends only on where it is: the same tree stands there whichever cell, crop or
 * tile generated it. Points belong to the cell their jittered position lands in.
 */
export function scatterCell(model: TileModel, ground: Heightfield, blocked: (x: number, y: number) => boolean, ctx: ProfileContext, cell: Bounds, seed = 1): Instance[] {
  const out: Instance[] = [];
  const { e, n } = model.origin;
  const present = ctx.profilesIn(cell);
  // Every mapped area that reaches the cell is a source, and so is the land no area covers.
  const sources: { kind: Cover; area?: Area; salt: number }[] = model.areas.filter((a) => overlaps(boxOf(a.ring), cell)).map((a) => ({ kind: a.kind, area: a, salt: saltOf(a.id) }));
  sources.push({ kind: 'open', salt: 7777 });

  for (const src of sources) {
    const inside = src.area ? (x: number, y: number) => ctx.areaAt(x, y) === src.area : (x: number, y: number) => !ctx.areaAt(x, y);
    const box = src.area ? boxOf(src.area.ring) : cell;
    const [x0, y0, x1, y1] = [Math.max(cell.x0, box.x0), Math.max(cell.y0, box.y0), Math.min(cell.x1, box.x1), Math.min(cell.y1, box.y1)];
    for (const pi of present) {
      const layers = ctx.profiles[pi].value.cover[src.kind];
      if (!layers?.length) continue;
      layers.forEach((L: ScatterLayer, li) => {
        const step = L.spacing;
        const s0 = seed + src.salt + li * 1000003;
        const s1 = li * 7919;
        const shaped = !!(L.near || L.slope || L.relief);
        // Grid indices in NZTM; jitter keeps a point within its own grid square, so one square either side is enough.
        for (let iy = Math.floor((y0 + n) / step) - 1; iy <= Math.ceil((y1 + n) / step); iy++) {
          for (let ix = Math.floor((x0 + e) / step) - 1; ix <= Math.ceil((x1 + e) / step); ix++) {
            if (hash(ix, iy, s0) > L.chance) continue;
            const x = (ix + 0.15 + 0.7 * hash(ix, iy, seed + 101 + s1)) * step - e;
            const y = (iy + 0.15 + 0.7 * hash(ix, iy, seed + 202 + s1)) * step - n;
            if (!inBounds(cell, x, y) || !inside(x, y) || ctx.indexAt(x, y) !== pi || blocked(x, y)) continue;
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
