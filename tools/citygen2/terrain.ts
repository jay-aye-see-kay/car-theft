// v2 ground (#58): the LiDAR DEM as a starting point, shaped to the roads
// and carved to one coastline. Roads decide their own heights first (smoothed
// along the network so every junction agrees), then the ground is made to
// meet them; v1 did it the other way round, draping roads over the DEM, and
// its road edges never quite sat on the ground.
//
// The field is the DEM's own 1 m grid in local coordinates (local axes are the
// NZTM grid, so cells line up exactly; no resampling).
import { corridorRadius, type Road } from '../citygen/roads.ts';
import { lonLatToLocal, ORIGIN_NZTM, type Local } from '../citygen/project.ts';
import type { Raster } from '../citygen/raster.ts';
import type { OsmData } from '../citygen/osm.ts';

export type Field = { x0: number; z0: number; res: number; nx: number; nz: number; h: Float32Array };

/** The DEM as a field; no-data (open water the LiDAR didn't see) becomes -5 m until the coast stage. */
export function fieldFromRaster(r: Raster): Field {
  const h = new Float32Array(r.data.length);
  for (let i = 0; i < h.length; i++) h[i] = Number.isNaN(r.data[i]) ? -5 : r.data[i];
  return { x0: r.west - ORIGIN_NZTM.e, z0: ORIGIN_NZTM.n - r.north, res: r.res, nx: r.width, nz: r.height, h };
}

export function sampleField(f: Field, x: number, z: number): number {
  const fx = (x - f.x0) / f.res - 0.5, fz = (z - f.z0) / f.res - 0.5;
  const c = Math.max(0, Math.min(f.nx - 2, Math.floor(fx))), r = Math.max(0, Math.min(f.nz - 2, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - c)), tz = Math.max(0, Math.min(1, fz - r));
  const i = r * f.nx + c;
  return (f.h[i] * (1 - tx) + f.h[i + 1] * tx) * (1 - tz) + (f.h[i + f.nx] * (1 - tx) + f.h[i + f.nx + 1] * tx) * tz;
}

// ------------------------------------------------------------ road profiles

/** Profile samples along each road, m. */
const SPACING = 4;
/**
 * Pull of the DEM on each sample against its neighbours. Smoothing reaches
 * about SPACING / sqrt(DATA_WEIGHT) along a road (~18 m): bumps and LiDAR
 * noise go, real hills stay.
 */
const DATA_WEIGHT = 0.05;
/** A profile never strays further than this from the DEM, m (the blend absorbs the rest). */
const MAX_LIFT = 1.5;
const ITERATIONS = 300;

export type Profiles = {
  /** Per road (same order as the input), a height at each of its points. */
  heights: number[][];
  samples: number;
};

/**
 * Heights for every road's points, solved together: samples at shared OSM
 * nodes are one sample, so roads meeting at a junction get the same height
 * there by construction. Bridges and tunnels are left out (their decks are
 * their own business) and get their points' DEM heights.
 */
export function roadProfiles(roads: Road[], dem: Field): Profiles {
  const x: number[] = [], z: number[] = [], data: number[] = [], nb: number[][] = [];
  const byNode = new Map<number, number>();
  const add = (p: Local, node?: number) => {
    if (node !== undefined) {
      const s = byNode.get(node);
      if (s !== undefined) return s;
    }
    const i = x.length;
    x.push(p.x); z.push(p.z); data.push(sampleField(dem, p.x, p.z)); nb.push([]);
    if (node !== undefined) byNode.set(node, i);
    return i;
  };
  const link = (a: number, b: number) => { if (a !== b) { nb[a].push(b); nb[b].push(a); } };
  // Each road's points as sample indices, with densified samples in between.
  const chains: { at: number[] }[] = [];
  for (const r of roads) {
    const at: number[] = [];
    if (r.bridge) { chains.push({ at }); continue; } // collectRoads already drops tunnels
    let prev = -1;
    for (let k = 0; k < r.pts.length; k++) {
      if (k > 0) {
        const a = r.pts[k - 1], b = r.pts[k];
        const n = Math.floor(Math.hypot(b.x - a.x, b.z - a.z) / SPACING);
        for (let j = 1; j < n; j++) {
          const s = add({ x: a.x + ((b.x - a.x) * j) / n, z: a.z + ((b.z - a.z) * j) / n });
          link(prev, s);
          prev = s;
        }
      }
      const s = add(r.pts[k], r.nodes[k]);
      if (prev >= 0) link(prev, s);
      prev = s;
      at.push(s);
    }
    chains.push({ at });
  }
  // Gauss-Seidel on (w * dem + sum of neighbours) / (w + degree), clamped near the DEM.
  const h = Float64Array.from(data);
  for (let it = 0; it < ITERATIONS; it++) {
    for (let i = 0; i < h.length; i++) {
      const n = nb[i];
      if (!n.length) continue;
      let s = DATA_WEIGHT * data[i];
      for (const j of n) s += h[j];
      const v = s / (DATA_WEIGHT + n.length);
      h[i] = Math.max(data[i] - MAX_LIFT, Math.min(data[i] + MAX_LIFT, v));
    }
  }
  const heights = roads.map((r, k) => (chains[k].at.length ? chains[k].at.map((s) => h[s]) : r.pts.map((p) => sampleField(dem, p.x, p.z))));
  return { heights, samples: h.length };
}

// --------------------------------------------------------------- corridors

/** Ground blends from a corridor's edge back to the DEM over this, m. */
export const BLEND = 12;

const smoothstep = (t: number) => t * t * (3 - 2 * t);

export type Shaped = { field: Field; /** Per cell, 0 to 1: how much the roads decide its height (1 inside a corridor). */ pull: Float32Array };

/** How sharply the nearest road wins where several reach a cell: higher is closer to "nearest only". */
const SHARPNESS = 4;

/**
 * The DEM shaped to the road profiles. Each road pulls the cells near it
 * towards its own height: fully inside its corridor (carriageway plus
 * footpaths, flat across: kerbs and camber are mesh detail), fading to
 * nothing BLEND past the edge. Where several roads reach a cell their heights
 * are averaged, weighted steeply towards the strongest pull; picking only the
 * nearest left a step wherever two roads at different heights met.
 */
export function shapeToRoads(dem: Field, roads: Road[], prof: Profiles): Shaped {
  const { nx, nz, res, x0, z0 } = dem;
  const pull = new Float32Array(nx * nz);
  const sumW = new Float32Array(nx * nz);
  const sumWH = new Float32Array(nx * nz);
  for (let k = 0; k < roads.length; k++) {
    const r = roads[k];
    if (r.bridge) continue;
    const half = corridorRadius(r), hs = prof.heights[k], reach = half + BLEND;
    for (let j = 0; j + 1 < r.pts.length; j++) {
      const a = r.pts[j], b = r.pts[j + 1];
      const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz || 1;
      const c0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - x0) / res)), c1 = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x) + reach - x0) / res));
      const r0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach - z0) / res)), r1 = Math.min(nz - 1, Math.ceil((Math.max(a.z, b.z) + reach - z0) / res));
      for (let row = r0; row <= r1; row++) {
        const pz = z0 + (row + 0.5) * res;
        for (let col = c0; col <= c1; col++) {
          const px = x0 + (col + 0.5) * res;
          const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / len2));
          const e = Math.hypot(px - a.x - dx * t, pz - a.z - dz * t) - half;
          if (e >= BLEND) continue;
          const p = e <= 0 ? 1 : 1 - smoothstep(e / BLEND);
          const i = row * nx + col;
          // Consecutive segments of one road overlap at their joints; that only
          // double-counts the same height, so it doesn't matter.
          const w = p ** SHARPNESS + 1e-6;
          sumW[i] += w;
          sumWH[i] += w * (hs[j] + (hs[j + 1] - hs[j]) * t);
          if (p > pull[i]) pull[i] = p;
        }
      }
    }
  }
  const h = new Float32Array(dem.h);
  for (let i = 0; i < h.length; i++) {
    if (!pull[i]) continue;
    h[i] = dem.h[i] + (sumWH[i] / sumW[i] - dem.h[i]) * pull[i];
  }
  return { field: { ...dem, h }, pull };
}

// -------------------------------------------------------------------- coast

/** OSM's coastline ways as local polylines (land on the left). */
export function coastLines(osm: OsmData): Local[][] {
  return [...osm.ways.values()]
    .filter((w) => w.tags.natural === 'coastline')
    .map((w) => w.nodes.map((id) => osm.nodes.get(id)).filter((n) => n !== undefined).map((n) => lonLatToLocal(n.lon, n.lat)));
}

/** Sea floor: just below the waterline at the shore, shelving to SEA_DEPTH over SEA_SHELF m. */
const SEA_SHORE = -1.5, SEA_DEPTH = -8, SEA_SHELF = 40;
/** Land is never lower than this above the water (NZVD2016 ~ mean sea level), m. */
const LAND_MIN = 0.6;

export type Coast = { sea: Uint8Array; seaCells: number; regions: number };

/**
 * Land and sea from OSM's coastline alone (land on the left of each way).
 * The lines are drawn as walls on the grid, every wall-free region is
 * flood-filled, and each region is land or sea by a vote of the cells just
 * either side of the lines bordering it. That copes with lines that run off
 * the edge of the area; a region no line borders (inland) is land.
 */
export function carveCoast(f: Field, coast: Local[][]): Coast {
  const { nx, nz, res, x0, z0 } = f;
  const n = nx * nz;
  const WALL = -1;
  const label = new Int32Array(n);
  const cell = (x: number, z: number) => {
    const c = Math.floor((x - x0) / res), r = Math.floor((z - z0) / res);
    return c < 0 || r < 0 || c >= nx || r >= nz ? -1 : r * nx + c;
  };
  const seeds: [number, number][] = []; // [cell, +1 land / -1 sea]
  for (const line of coast) {
    for (let k = 0; k + 1 < line.length; k++) {
      const a = line[k], b = line[k + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (!len) continue;
      // Left of travel in the local frame (x east, z south) is (dz, -dx).
      const lx = (b.z - a.z) / len, lz = -(b.x - a.x) / len;
      for (let s = 0; s <= len; s += res / 3) {
        const px = a.x + ((b.x - a.x) * s) / len, pz = a.z + ((b.z - a.z) * s) / len;
        const i = cell(px, pz);
        if (i >= 0) label[i] = WALL;
        // Wall cells are one wide but a diagonal line steps through corners, so seed 2 cells out.
        const L = cell(px + lx * 2 * res, pz + lz * 2 * res), S = cell(px - lx * 2 * res, pz - lz * 2 * res);
        if (L >= 0) seeds.push([L, 1]);
        if (S >= 0) seeds.push([S, -1]);
      }
    }
  }
  // Flood fill regions (4-connected) with an explicit stack.
  let regions = 0;
  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (label[start] !== 0) continue;
    const id = ++regions;
    let top = 0;
    stack[top++] = start;
    label[start] = id;
    while (top) {
      const i = stack[--top];
      const c = i % nx;
      if (c > 0 && label[i - 1] === 0) { label[i - 1] = id; stack[top++] = i - 1; }
      if (c < nx - 1 && label[i + 1] === 0) { label[i + 1] = id; stack[top++] = i + 1; }
      if (i >= nx && label[i - nx] === 0) { label[i - nx] = id; stack[top++] = i - nx; }
      if (i < n - nx && label[i + nx] === 0) { label[i + nx] = id; stack[top++] = i + nx; }
    }
  }
  const vote = new Float64Array(regions + 1);
  for (const [i, v] of seeds) if (label[i] > 0) vote[label[i]] += v;
  const sea = new Uint8Array(n);
  let seaCells = 0;
  for (let i = 0; i < n; i++) {
    const l = label[i];
    // Wall cells side with the sea: the line is the water's edge.
    if (l === WALL || vote[l] < 0) { sea[i] = 1; seaCells++; }
  }
  // Distance from the shore through the sea (two-pass chamfer, in cells), for the shelf.
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = sea[i] ? 1e9 : 0;
  const D1 = 1, D2 = Math.SQRT2;
  for (let r = 0; r < nz; r++) for (let c = 0; c < nx; c++) {
    const i = r * nx + c;
    if (!d[i]) continue;
    let v = d[i];
    if (c > 0) v = Math.min(v, d[i - 1] + D1);
    if (r > 0) {
      v = Math.min(v, d[i - nx] + D1);
      if (c > 0) v = Math.min(v, d[i - nx - 1] + D2);
      if (c < nx - 1) v = Math.min(v, d[i - nx + 1] + D2);
    }
    d[i] = v;
  }
  for (let r = nz - 1; r >= 0; r--) for (let c = nx - 1; c >= 0; c--) {
    const i = r * nx + c;
    if (!d[i]) continue;
    let v = d[i];
    if (c < nx - 1) v = Math.min(v, d[i + 1] + D1);
    if (r < nz - 1) {
      v = Math.min(v, d[i + nx] + D1);
      if (c < nx - 1) v = Math.min(v, d[i + nx + 1] + D2);
      if (c > 0) v = Math.min(v, d[i + nx - 1] + D2);
    }
    d[i] = v;
  }
  for (let i = 0; i < n; i++) {
    if (sea[i]) {
      const t = Math.min(1, (d[i] * res) / SEA_SHELF);
      f.h[i] = SEA_SHORE + (SEA_DEPTH - SEA_SHORE) * smoothstep(t);
    } else if (f.h[i] < LAND_MIN) f.h[i] = LAND_MIN;
  }
  return { sea, seaCells, regions };
}
