// Grades the terrain to meet the generated roads, then meshes it.
import * as THREE from 'three';
import { pointInRing } from '../geo/poly.ts';
import type { Heightfield } from '../model/load.ts';
import type { Area, Path, Pt, TileModel } from '../model/types.ts';
import type { Network } from './network.ts';
import type { ProfileContext } from '../profile/context.ts';
import { type RoadParams, type Track, deckDepth, halfWidth } from './tracks.ts';

/** How far the ground sits below a road surface, so it can never show through. */
const SINK = 0.15;

/**
 * Further in from a road's edge the ground drops away under it, by this much per metre and up to
 * `DEEP`. A road's surface is flat facets between its own edges, and on a slope those can dip below
 * any estimate of its height made from nearby: only at the edge does the ground need to be close.
 */
const DEEPEN = 0.5;
const DEEP = 1;
/** Starts more than one square of the ground's grid in from the edge, so no slope down reaches the edge. */
const deepen = (inside: number): number => Math.min(DEEP, Math.max(0, inside - 3) * DEEPEN);

/** Standing room under a deck. */
const UNDER_DECK = 2.6;
/** Rise per metre of the ramps a cut-through makes down to its floor. */
const UNDER_RAMP = 0.2;

/**
 * Under a bridge. A survey from the air cannot see beneath a deck, so where a road was built across a
 * gap and bridged, the ground often reads as solid fill up to the road. Where the map has a footpath
 * crossing under a bridge there is a way through: the path is cut down to pass beneath the deck, and
 * ramps back up to the ground on either side.
 */
function cutUnderpasses(out: Heightfield, bed: Float32Array, ceiling: Float32Array, tracks: Track[], paths: Path[]): void {
  const decks: { x: number; y: number; h: number; half: number; tx: number; ty: number }[] = [];
  for (const t of tracks) for (let i = 0; i < t.n; i++) if (t.level[i] > 0) decks.push({ x: t.x[i], y: t.y[i], h: t.h[i] - deckDepth(t, i), half: halfWidth(t, i), tx: t.tx[i], ty: t.ty[i] });
  if (!decks.length) return;
  const { cols, rows, cell, x0, y0 } = out;
  // Every path at one-metre steps, with the floor height each step needs: under a deck, low enough
  // to pass beneath it.
  type Step = { x: number; y: number; floor: number };
  const walks: Step[][] = [];
  for (const path of paths) {
    if (path.level !== 0 || path.pts.length < 2) continue;
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of path.pts) [minX, minY, maxX, maxY] = [Math.min(minX, x), Math.min(minY, y), Math.max(maxX, x), Math.max(maxY, y)];
    const near = decks.filter((d) => d.x > minX - 20 && d.x < maxX + 20 && d.y > minY - 20 && d.y < maxY + 20);
    const steps: Step[] = [];
    for (let i = 1; i < path.pts.length; i++) {
      const [a, b] = [path.pts[i - 1], path.pts[i]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const [ux, uy] = [(b[0] - a[0]) / (len || 1), (b[1] - a[1]) / (len || 1)];
      for (let s = 0; s < len; s++) {
        const [x, y] = [a[0] + ux * s, a[1] + uy * s];
        let floor = Infinity;
        for (const d of near) {
          // Only where the path goes across the deck: one running along a bridge is on it, not under it.
          if (Math.hypot(d.x - x, d.y - y) < d.half + 0.5 && Math.abs(ux * d.tx + uy * d.ty) < 0.7) floor = Math.min(floor, d.h - UNDER_DECK);
        }
        steps.push({ x, y, floor });
      }
    }
    const last = path.pts[path.pts.length - 1];
    steps.push({ x: last[0], y: last[1], floor: Infinity });
    walks.push(steps);
  }
  // Ramps climb away from each low stretch, and carry on along whichever paths join at its ends.
  const ends = new Map<string, number>();
  const key = (s: Step) => `${Math.round(s.x * 2)},${Math.round(s.y * 2)}`;
  for (let round = 0, changed = true; changed && round < 8; round++) {
    changed = false;
    for (const steps of walks) {
      const [first, last] = [steps[0], steps[steps.length - 1]];
      for (const e of [first, last]) e.floor = Math.min(e.floor, ends.get(key(e)) ?? Infinity);
      if (!steps.some((s) => s.floor < Infinity)) continue;
      for (let i = 1; i < steps.length; i++) steps[i].floor = Math.min(steps[i].floor, steps[i - 1].floor + UNDER_RAMP);
      for (let i = steps.length - 2; i >= 0; i--) steps[i].floor = Math.min(steps[i].floor, steps[i + 1].floor + UNDER_RAMP);
      for (const e of [first, last]) {
        // No need to pass a ramp on once it has climbed back out of the ground.
        if (e.floor < out.at(e.x, e.y) - 0.1 && e.floor < (ends.get(key(e)) ?? Infinity) - 0.01) {
          ends.set(key(e), e.floor);
          changed = true;
        }
      }
    }
  }
  for (const steps of walks) {
    for (const s of steps) {
      if (s.floor > out.at(s.x, s.y) - 0.1) continue;
      const R = 6;
      for (let r = Math.max(0, Math.floor((s.y - R - y0) / cell)); r <= Math.min(rows - 1, Math.ceil((s.y + R - y0) / cell)); r++) {
        for (let c = Math.max(0, Math.floor((s.x - R - x0) / cell)); c <= Math.min(cols - 1, Math.ceil((s.x + R - x0) / cell)); c++) {
          const k = r * cols + c;
          // The cut has a flat floor and steep sides, and never bites into a road's own bed: only into
          // open ground, or fill that was pressed up against the underside of a deck.
          if (bed[k] >= 1 && out.data[k] < ceiling[k] - 0.05) continue;
          const d = Math.hypot(x0 + c * cell - s.x, y0 + r * cell - s.y);
          const h = s.floor + Math.max(0, d - 2.5) * 1.5;
          if (h < out.data[k]) out.data[k] = h;
        }
      }
    }
  }
}

/** Offsets to look around a point under the paving: a ring at 3 m and a cross at 6 m. */
const AROUND: [number, number][] = [
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((k): [number, number] => [Math.cos((k * Math.PI) / 4) * 3, Math.sin((k * Math.PI) / 4) * 3]),
  [6, 0],
  [-6, 0],
  [0, 6],
  [0, -6],
];

/** How far past a carriageway's edge the ground stays level with it. */
const SHELF = 2.5;

/** How far outside an intersection's edge the ground is brought to its level. */
const VERGE = 3;

const smoothstep = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * Returns a copy of the ground where every road on the ground has a flat bed under it and
 * the surrounding terrain is blended up or down to meet it. Bridges and tunnels leave the ground alone.
 */
export function gradeTerrain(ground: Heightfield, net: Network, p: RoadParams, paths: Path[] = []): Heightfield {
  const { junctions, pavement } = net;
  const tracks = net.tracks.values();
  const out = ground.clone();
  const { cols, rows, cell, x0, y0 } = out;
  const weight = new Float32Array(cols * rows);
  const target = new Float32Array(cols * rows);
  const ceiling = new Float32Array(cols * rows).fill(Infinity);
  const all = [...tracks];
  // Between roads the ground is a blend of their heights, each counting for more the nearer it is, so
  // the bank from one road down to another is a slope rather than a step wherever the nearer road
  // changes. Under a carriageway and for a little way beside it, the lowest road there wins outright.
  const sumW = new Float32Array(cols * rows);
  const sumWH = new Float32Array(cols * rows);
  const under = new Float32Array(cols * rows).fill(Infinity);

  for (const t of all) {
    const extra = (t.road.footpath ? p.footpathWidth : 0) + 1.2;
    for (let i = 0; i < t.n - 1; i++) {
      if (t.level[i] < 0 || t.level[i + 1] < 0) continue;
      const elevated = t.level[i] > 0 || t.level[i + 1] > 0;
      const hw = Math.max(halfWidth(t, i), halfWidth(t, i + 1));
      const core = hw + extra;
      const reach = core + p.gradeBlend;
      const [ax, ay, bx, by] = [t.x[i], t.y[i], t.x[i + 1], t.y[i + 1]];
      const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - x0) / cell));
      const c1 = Math.min(cols - 1, Math.ceil((Math.max(ax, bx) + reach - x0) / cell));
      const r0 = Math.max(0, Math.floor((Math.min(ay, by) - reach - y0) / cell));
      const r1 = Math.min(rows - 1, Math.ceil((Math.max(ay, by) + reach - y0) / cell));
      const len2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const px = x0 + c * cell;
          const py = y0 + r * cell;
          const u = Math.min(1, Math.max(0, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2));
          const d = Math.hypot(px - (ax + (bx - ax) * u), py - (ay + (by - ay) * u));
          if (d >= reach) continue;
          const w = d <= core ? 1 : 1 - smoothstep((d - core) / p.gradeBlend);
          const k = r * cols + c;
          const h = t.h[i] + (t.h[i + 1] - t.h[i]) * u - SINK;
          if (elevated) {
            // A deck: the ground only needs to stay out of its way.
            if (d <= core) ceiling[k] = Math.min(ceiling[k], h - 0.6);
          } else {
            if (w > weight[k]) weight[k] = w;
            // Level for a little way past the edge, further than one cell of the ground's grid, so the
            // slope never starts under the carriageway.
            const near = 1 / (Math.max(0, d - hw - SHELF) + 0.25) ** 2;
            sumW[k] += near;
            sumWH[k] += near * h;
            // Two road beds overlap (the halves of a divided road on a cross slope): the lower one
            // wins, so the ground can never stand above either surface.
            if (d <= hw + SHELF) under[k] = Math.min(under[k], h - deepen(hw - d));
          }
        }
      }
    }
  }

  for (let k = 0; k < weight.length; k++) if (sumW[k] > 0) target[k] = under[k] < Infinity ? under[k] : sumWH[k] / sumW[k];

  // Junction interiors: just under the junction's own surface, which is flat triangles between the
  // points of its outline. The same triangles are found here, so the ground follows them exactly:
  // on a slope they can dip well below any smooth estimate from the outline's heights.
  for (const j of junctions) for (const piece of j.pieces) {
    const ring: Pt[] = piece.outer.map((q) => [q.x, q.y]);
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of ring) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const v2 = (pts: { x: number; y: number }[]) => pts.map((q) => new THREE.Vector2(q.x, q.y));
    const verts = [piece.outer, ...piece.holes].flat();
    const faces = THREE.ShapeUtils.triangulateShape(v2(piece.outer), piece.holes.map(v2));
    const onFace = (px: number, py: number): number | undefined => {
      for (const [ia, ib, ic] of faces) {
        const [a, b, c] = [verts[ia], verts[ib], verts[ic]];
        const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
        if (Math.abs(det) < 1e-9) continue;
        const u = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / det;
        const v = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / det;
        if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
        return u * a.h + v * b.h + (1 - u - v) * c.h;
      }
      return undefined;
    };
    for (let r = Math.max(0, Math.ceil((minY - VERGE - y0) / cell)); r <= Math.min(rows - 1, Math.floor((maxY + VERGE - y0) / cell)); r++) {
      for (let c = Math.max(0, Math.ceil((minX - VERGE - x0) / cell)); c <= Math.min(cols - 1, Math.floor((maxX + VERGE - x0) / cell)); c++) {
        const px = x0 + c * cell;
        const py = y0 + r * cell;
        const within = pointInRing(px, py, ring);
        let sum = 0;
        let wsum = 0;
        let inside = Infinity;
        piece.outer.forEach((q, i) => {
          const w = 1 / ((q.x - px) ** 2 + (q.y - py) ** 2 + 0.01);
          sum += q.h * w;
          wsum += w;
          const b = piece.outer[(i + 1) % piece.outer.length];
          const len2 = (b.x - q.x) ** 2 + (b.y - q.y) ** 2 || 1;
          const u = Math.min(1, Math.max(0, ((px - q.x) * (b.x - q.x) + (py - q.y) * (b.y - q.y)) / len2));
          inside = Math.min(inside, Math.hypot(px - (q.x + (b.x - q.x) * u), py - (q.y + (b.y - q.y) * u)));
        });
        const k = r * cols + c;
        if (!within) {
          // Just outside, where no road or footpath borders it: the ground comes level with the edge, as
          // it does beside a road, so a slope cannot stand over the surface there.
          const w = 1 - smoothstep((inside - VERGE / 2) / (VERGE / 2));
          if (w > weight[k] && !j.deck) [weight[k], target[k]] = [w, sum / wsum - SINK];
          continue;
        }
        const h = (onFace(px, py) ?? sum / wsum) - SINK;
        if (weight[k] > 0 && target[k] < h - 1.5) {
          // Another road's bed runs underneath: this part of the junction is on a structure.
          ceiling[k] = Math.min(ceiling[k], h - 0.6);
        } else if (!j.deck || Math.abs(h - out.data[k]) < 4 || weight[k] > 0) {
          // Only where the ground is on this junction's level; a junction on a viaduct has open air under it.
          // Where a road bed is already here, the lower surface wins, as it does between two roads.
          target[k] = (weight[k] >= 1 ? Math.min(target[k], h) : h) - deepen(inside);
          weight[k] = 1;
        }
      }
    }
  }

  // Under the pavement: never above the road it sits a kerb over.
  const paved = new Uint8Array(cols * rows);
  for (const piece of [...pavement.paved, ...pavement.sealed, ...pavement.banks]) {
    const ring: Pt[] = piece.outer.pts.map((q) => [q.x, q.y]);
    const holes: Pt[][] = piece.holes.map((h) => h.pts.map((q) => [q.x, q.y]));
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of ring) [minX, minY, maxX, maxY] = [Math.min(minX, x), Math.min(minY, y), Math.max(maxX, x), Math.max(maxY, y)];
    for (let r = Math.max(0, Math.ceil((minY - y0) / cell)); r <= Math.min(rows - 1, Math.floor((maxY - y0) / cell)); r++) {
      for (let c = Math.max(0, Math.ceil((minX - x0) / cell)); c <= Math.min(cols - 1, Math.floor((maxX - x0) / cell)); c++) {
        const [px, py] = [x0 + c * cell, y0 + r * cell];
        if (!pointInRing(px, py, ring) || holes.some((h) => pointInRing(px, py, h))) continue;
        const k = r * cols + c;
        // The paving spans between roads that may sit at different heights, in flat facets of its own: the
        // ground stays under the lowest road surface nearby, so it cannot come up through any of them.
        let h = pavement.surfaceAt(px, py);
        for (const [dx, dy] of AROUND) h = Math.min(h, pavement.surfaceAt(px + dx, py + dy));
        h -= SINK;
        target[k] = weight[k] >= 1 ? Math.min(target[k], h) : h;
        weight[k] = 1;
        paved[k] = 1;
      }
    }
  }

  for (let k = 0; k < weight.length; k++) {
    if (weight[k] > 0) out.data[k] += (target[k] - out.data[k]) * weight[k];
    if (out.data[k] > ceiling[k]) out.data[k] = ceiling[k];
  }
  // The ground beside the paving starts level with it and climbs from there: a bank that began under
  // the paving's edge would come up through it.
  const before = out.data.slice();
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const k = r * cols + c;
      if (paved[k]) continue;
      for (const n of [k - 1, k + 1, k - cols, k + cols, k - cols - 1, k - cols + 1, k + cols - 1, k + cols + 1]) {
        if (paved[n] && before[n] < out.data[k]) out.data[k] = before[n];
      }
    }
  }
  cutUnderpasses(out, weight, ceiling, all, paths);
  return out;
}

export function buildTerrainGeometry(hf: Heightfield): THREE.BufferGeometry {
  const { cols, rows, cell, x0, y0, data } = hf;
  const pos = new Float32Array(cols * rows * 3);
  const uv = new Float32Array(cols * rows * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      pos[k * 3] = x0 + c * cell;
      pos[k * 3 + 1] = data[k];
      pos[k * 3 + 2] = -(y0 + r * cell);
      uv[k * 2] = c / (cols - 1);
      uv[k * 2 + 1] = r / (rows - 1);
    }
  }
  const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let n = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const k = r * cols + c;
      idx[n++] = k;
      idx[n++] = k + 1;
      idx[n++] = k + cols;
      idx[n++] = k + 1;
      idx[n++] = k + cols + 1;
      idx[n++] = k + cols;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

/** Walls down each edge of the tile to `bottom`, so the ground reads as a solid block and nothing shows underneath it. */
export function buildTerrainSkirt(hf: Heightfield, bottom: number): THREE.BufferGeometry {
  const { cols, rows, cell, x0, y0, data } = hf;
  const pos: number[] = [];
  const edge = (cells: [number, number][]) => {
    for (let i = 1; i < cells.length; i++) {
      const [[c0, r0], [c1, r1]] = [cells[i - 1], cells[i]];
      const [ax, ay, ah] = [x0 + c0 * cell, y0 + r0 * cell, data[r0 * cols + c0]];
      const [bx, by, bh] = [x0 + c1 * cell, y0 + r1 * cell, data[r1 * cols + c1]];
      pos.push(ax, ah, -ay, ax, bottom, -ay, bx, bh, -by, bx, bh, -by, ax, bottom, -ay, bx, bottom, -by);
    }
  };
  const run = (n: number, f: (i: number) => [number, number]) => Array.from({ length: n }, (_, i) => f(i));
  edge(run(cols, (c) => [c, 0]));
  edge(run(rows, (r) => [cols - 1, r]));
  edge(run(cols, (c) => [cols - 1 - c, rows - 1]));
  edge(run(rows, (r) => [0, rows - 1 - r]));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export const AREA_COLOURS: Record<Area['kind'], string> = {
  park: '#86b867',
  cemetery: '#6f9a6a',
  campus: '#b3bd92',
  water: '#6fb0d8',
  wood: '#4f8a55',
  pitch: '#74c06a',
  parking: '#8d9096',
  plaza: '#cfc6b4',
  beach: '#ecdcae',
  rock: '#8a8478',
};

export type MapMode = 'generated' | 'profiles' | 'zoning';

/** Zone families on the zoning map, by the first word of the zone's name. */
export const ZONE_COLOURS: Record<string, string> = {
  Business: '#5b8fd9',
  Residential: '#e8c766',
  'Open Space': '#7cc26a',
  'Special Purpose': '#d77aa0',
  Rural: '#3d7f52',
  Coastal: '#d9cf9a',
  'Future Urban': '#c9a6e0',
  Water: '#6fb0d8',
  Green: '#9ad07a',
};

export const zoneFamily = (zone: string): string => Object.keys(ZONE_COLOURS).find((k) => zone.startsWith(k)) ?? 'Other';

const css = (n: number): string => '#' + n.toString(16).padStart(6, '0');

/**
 * Paints land use and footpaths into one texture draped over the terrain. With a profile context,
 * each place's profile picks its ground colours; the map modes paint the profile map or the raw
 * zoning instead, for checking what the generators were told.
 */
export function paintGround(model: TileModel, pxPerMetre = 1.5, ctx?: ProfileContext, mode: MapMode = 'generated'): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = Math.round(model.size.x * pxPerMetre);
  cv.height = Math.round(model.size.y * pxPerMetre);
  const g = cv.getContext('2d')!;
  g.fillStyle = '#a9ad98';
  g.fillRect(0, 0, cv.width, cv.height);
  // Canvas y runs down; tile y runs north.
  const toTile = () => g.setTransform(pxPerMetre, 0, 0, -pxPerMetre, cv.width / 2, cv.height / 2);
  toTile();
  const trace = (pts: Pt[], close: boolean) => {
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    if (close) g.closePath();
  };

  if (ctx && mode !== 'zoning') {
    // One pixel per profile cell, scaled up: smoothed for real ground so districts blend, sharp for the map.
    const grid = ctx.grid;
    const small = document.createElement('canvas');
    small.width = grid.cols;
    small.height = grid.rows;
    const sg = small.getContext('2d')!;
    const img = sg.createImageData(grid.cols, grid.rows);
    for (let c = 0; c < grid.size; c++) {
      const p = ctx.profiles[ctx.cells[c]];
      const col = mode === 'profiles' ? p.top.swatch : p.value.ground.base;
      const row = grid.rows - 1 - Math.floor(c / grid.cols);
      const k = (row * grid.cols + (c % grid.cols)) * 4;
      img.data[k] = (col >> 16) & 255;
      img.data[k + 1] = (col >> 8) & 255;
      img.data[k + 2] = col & 255;
      img.data[k + 3] = 255;
    }
    sg.putImageData(img, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.imageSmoothingEnabled = mode !== 'profiles';
    g.drawImage(small, 0, 0, cv.width, cv.height);
    toTile();
  }

  if (mode === 'zoning') {
    for (const z of model.zones ?? []) {
      trace(z.ring, true);
      g.fillStyle = ZONE_COLOURS[zoneFamily(z.zone)] ?? '#bbbbbb';
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.lineWidth = 1.2;
      g.stroke();
    }
  } else if (mode === 'profiles' && ctx) {
    // The things profiles were assigned from, outlined over the map.
    g.lineWidth = 1.5;
    g.strokeStyle = 'rgba(20,20,30,0.45)';
    for (const z of model.zones ?? []) {
      trace(z.ring, true);
      g.stroke();
    }
    g.lineWidth = 2.5;
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    for (const p of ctx.places) {
      trace(p.ring, true);
      g.stroke();
    }
  } else {
    for (const a of model.areas) {
      trace(a.ring, true);
      g.fillStyle = ctx ? css(ctx.at(...ctx.interior(a.ring)).value.ground.cover[a.kind]) : AREA_COLOURS[a.kind];
      g.fill();
    }
  }

  g.lineCap = g.lineJoin = 'round';
  if (mode === 'generated') {
    for (const s of model.streams ?? []) {
      trace(s.pts, false);
      g.strokeStyle = css(ctx ? ctx.at(...s.pts[s.pts.length >> 1]).value.ground.stream : 0x6fb0d8);
      g.lineWidth = s.kind === 'river' ? 6 : s.kind === 'stream' ? 2.2 : 1.2;
      g.stroke();
    }
  }
  const pathStyle: Record<Path['kind'], [string, number]> = { foot: ['#d9cfb8', 2.2], steps: ['#bfb39a', 2.2], cycle: ['#c9b9a0', 2.6] };
  for (const path of model.paths) {
    if (path.level !== 0) continue;
    trace(path.pts, false);
    [g.strokeStyle, g.lineWidth] = pathStyle[path.kind];
    if (ctx && path.kind !== 'cycle') {
      const ps = ctx.at(...path.pts[path.pts.length >> 1]).value.ground.path;
      [g.strokeStyle, g.lineWidth] = [css(path.kind === 'steps' ? ps.colour - 0x111111 : ps.colour), ps.width];
    }
    if (mode !== 'generated') {
      g.strokeStyle = 'rgba(255,255,255,0.5)';
      g.lineWidth = 1.2;
    }
    g.stroke();
  }
  return cv;
}
