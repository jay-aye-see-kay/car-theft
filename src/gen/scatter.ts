// Placement rules: trees scattered by land type, on a world-aligned jittered grid so the
// same spot always gets the same tree, whatever order things are generated in.
import { pointInRing } from '../geo/poly.ts';
import type { Heightfield } from '../model/load.ts';
import type { Area, TileModel } from '../model/types.ts';
import { type Track, halfWidth } from './tracks.ts';

export interface Tree {
  x: number;
  y: number;
  h: number;
  /** Overall size multiplier and a 0..1 value for colour variation. */
  size: number;
  tint: number;
}

/** Grid spacing in metres and the chance each cell holds a tree, per land type. */
const DENSITY: Partial<Record<Area['kind'], [number, number]>> = {
  wood: [6.5, 0.9],
  cemetery: [10, 0.75],
  park: [19, 0.6],
  campus: [24, 0.5],
};

function hash(ix: number, iy: number, salt: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(salt, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

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

export function scatterTrees(model: TileModel, ground: Heightfield, blocked: (x: number, y: number) => boolean, seed = 1): Tree[] {
  const trees: Tree[] = [];
  model.areas.forEach((area, salt) => {
    const rule = DENSITY[area.kind];
    if (!rule) return;
    const [step, chance] = rule;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of area.ring) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    for (let iy = Math.floor(y0 / step); iy <= Math.ceil(y1 / step); iy++) {
      for (let ix = Math.floor(x0 / step); ix <= Math.ceil(x1 / step); ix++) {
        if (hash(ix, iy, seed + salt) > chance) continue;
        const x = (ix + 0.15 + 0.7 * hash(ix, iy, seed + 101)) * step;
        const y = (iy + 0.15 + 0.7 * hash(ix, iy, seed + 202)) * step;
        if (!pointInRing(x, y, area.ring) || blocked(x, y)) continue;
        const big = area.kind === 'wood' ? 1 : 1.25;
        trees.push({ x, y, h: ground.at(x, y), size: big * (0.7 + 0.7 * hash(ix, iy, seed + 303)), tint: hash(ix, iy, seed + 404) });
      }
    }
  });
  return trees;
}
