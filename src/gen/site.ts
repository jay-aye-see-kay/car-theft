// The cell stage: what one cell holds, given the tile stage's results (a `Site`). And `checkCells`, which
// tests that a cell comes out the same however it is generated.
import type { Heightfield } from '../model/load.ts';
import type { TileModel } from '../model/types.ts';
import { ProfileContext } from '../profile/context.ts';
import { type Cell, MARGIN, boxOf, cropModel, grow, inBounds, overlaps } from './cells.ts';
import type { JunctionShape } from './junctions.ts';
import { type Instance, occupancy, scatterCell } from './scatter.ts';
import { furnishStreets } from './street.ts';
import { DEFAULT_PARAMS, type Track } from './tracks.ts';

export const TREE_KITS = new Set(['broadleaf', 'oak', 'plane', 'pohutukawa', 'kauri', 'nikau', 'palm', 'ponga', 'cabbage', 'shrub', 'flax', 'tussock']);

/** The tile stage's results that the cell stage reads. */
export interface Site {
  model: TileModel;
  /** Ground as graded for the roads. */
  ground: Heightfield;
  ctx: ProfileContext;
  /**
   * The profile context roads take their character from. A road's lamps and trees are decided once for
   * the whole road, at its middle, which may be far outside a cell: that is a tile-stage decision.
   */
  roadCtx: ProfileContext;
  tracks: Track[];
  junctions: JunctionShape[];
  /** Buildings, roads, footpaths, pitches: where nothing scattered may stand. */
  occupied: (x: number, y: number) => boolean;
  /** Just the buildings: where street furniture may not stand. */
  walls: (x: number, y: number) => boolean;
  /** Kept clear for stamps (the falls and their pool). */
  clear: (x: number, y: number) => boolean;
  trees: boolean;
  furniture: boolean;
}

const trackBoxes = new WeakMap<Track, ReturnType<typeof boxOf>>();
function trackBox(t: Track) {
  let b = trackBoxes.get(t);
  if (!b) {
    b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (let i = 0; i < t.n; i++) [b.x0, b.y0, b.x1, b.y1] = [Math.min(b.x0, t.x[i]), Math.min(b.y0, t.y[i]), Math.max(b.x1, t.x[i]), Math.max(b.y1, t.y[i])];
    trackBoxes.set(t, b);
  }
  return b;
}

/** Everything placed in one cell: street furniture along the roads that reach it, then the profiles' scatter. */
export function generateCell(site: Site, cell: Cell): Instance[] {
  const out: Instance[] = [];
  if (site.furniture) {
    // Props stand at most a road's half width plus a few metres off its centreline.
    const near = grow(cell, 40);
    const tracks = site.tracks.filter((t) => overlaps(trackBox(t), near));
    for (const p of furnishStreets(tracks, site.junctions, DEFAULT_PARAMS, site.walls, site.roadCtx)) {
      if (!inBounds(cell, p.x, p.y) || (!site.trees && TREE_KITS.has(p.kind))) continue;
      out.push({ kit: p.kind, x: p.x, y: p.y, h: p.h, size: p.size, tint: p.tint, yaw: p.yaw, lean: 0, leanDir: 0, tone: p.tone, profile: site.ctx.indexAt(p.x, p.y) });
    }
  }
  if (site.trees) {
    const blocked = (x: number, y: number) => site.occupied(x, y) || site.clear(x, y);
    for (const f of scatterCell(site.model, site.ground, blocked, site.ctx, cell)) out.push(f);
  }
  return out;
}

/** The site as if only this cell and its margin had been fetched: a cropped model, and rasters built from it alone. */
export function cropSite(site: Site, cell: Cell): Site {
  const model = cropModel(site.model, grow(cell, MARGIN));
  const roads = new Set(model.roads.map((r) => r.id));
  const tracks = site.tracks.filter((t) => roads.has(t.road.id));
  const ctx = new ProfileContext(model, site.ctx.ground, { levels: site.ctx.levels, swaps: site.ctx.swaps, regional: site.ctx });
  return { ...site, model, ctx, tracks, occupied: occupancy(model, tracks), walls: occupancy(model, [], 'buildings') };
}

/** The same data in reverse order, as a rebake that listed things differently might give. */
export function reorderSite(site: Site): Site {
  const m = site.model;
  const model: TileModel = { ...m, areas: [...m.areas].reverse(), buildings: [...m.buildings].reverse(), paths: [...m.paths].reverse(), streams: m.streams && [...m.streams].reverse(), zones: m.zones && [...m.zones].reverse() };
  const tracks = [...site.tracks].reverse();
  const ctx = new ProfileContext(model, site.ctx.ground, { levels: site.ctx.levels, swaps: site.ctx.swaps });
  return { ...site, model, ctx, roadCtx: ctx, tracks, occupied: occupancy(model, tracks), walls: occupancy(model, [], 'buildings') };
}

export interface CheckResult {
  name: string;
  cells: number;
  instances: number;
  /** Instances in one run and not the other. */
  differ: number;
  examples: string[];
}

const keyOf = (site: Site, i: Instance) => `${i.kit} ${i.x.toFixed(2)},${i.y.toFixed(2)} ×${i.size.toFixed(3)} ${site.ctx.profiles[i.profile].key}`;

function compare(name: string, a: Site, cells: Cell[], other: (c: Cell) => Site): CheckResult {
  const r: CheckResult = { name, cells: cells.length, instances: 0, differ: 0, examples: [] };
  for (const cell of cells) {
    const sb = other(cell);
    const ka = generateCell(a, cell).map((i) => keyOf(a, i));
    const kb = new Set(generateCell(sb, cell).map((i) => keyOf(sb, i)));
    r.instances += ka.length;
    const sa = new Set(ka);
    for (const k of ka) if (!kb.has(k)) (r.differ++, r.examples.length < 4 && r.examples.push(`${cell.key}: only in whole tile: ${k}`));
    for (const k of kb) if (!sa.has(k)) (r.differ++, r.examples.length < 4 && r.examples.push(`${cell.key}: only in ${name}: ${k}`));
  }
  return r;
}

/**
 * Generates `cells` three ways and reports any difference from the whole-tile run:
 * alone (from a crop of the model to the cell and its margin), and from the data in reverse order.
 */
export function checkCells(site: Site, cells: Cell[]): CheckResult[] {
  const reordered = reorderSite(site);
  return [compare('crop', site, cells, (c) => cropSite(site, c)), compare('reordered data', site, cells, () => reordered)];
}
