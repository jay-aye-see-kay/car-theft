// Stamps: hand-authored pieces dropped into the generated world. A stamp is anchored only roughly
// by hand; it finds its exact spot from the data (here, the steepest drop on a stream near the
// anchor), edits the terrain it sits in, and adds its own geometry.
import * as THREE from 'three';
import { toNztm } from '../geo/nztm.ts';
import type { Heightfield } from '../model/load.ts';
import type { Pt, TileModel } from '../model/types.ts';

export interface StampSpec {
  id: string;
  name: string;
  kind: 'falls';
  /** Latitude and longitude within `radius` metres of the real spot. */
  anchor: [number, number];
  radius: number;
}

export const STAMPS: StampSpec[] = [{ id: 'kitekite-falls', name: 'Kitekite Falls', kind: 'falls', anchor: [-36.9446, 174.4932], radius: 250 }];

export interface PlacedStamp {
  spec: StampSpec;
  /** Points down the drop, top first. */
  run: Pt[];
}

/** Finds each stamp's spot in this tile: for falls, the 20 m of stream that drops the most. */
export function placeStamps(model: TileModel, ground: Heightfield): PlacedStamp[] {
  const out: PlacedStamp[] = [];
  for (const spec of STAMPS) {
    const [e, n] = toNztm(...spec.anchor);
    const [ax, ay] = [e - model.origin.e, n - model.origin.n];
    if (Math.abs(ax) > model.size.x / 2 || Math.abs(ay) > model.size.y / 2) continue;
    let best: { drop: number; run: Pt[] } | undefined;
    for (const s of model.streams ?? []) {
      const pts: Pt[] = [];
      for (let i = 1; i < s.pts.length; i++) {
        const [a, b] = [s.pts[i - 1], s.pts[i]];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        for (let t = 0; t < len; t += 2) pts.push([a[0] + ((b[0] - a[0]) * t) / len, a[1] + ((b[1] - a[1]) * t) / len]);
      }
      for (let i = 0; i + 10 < pts.length; i++) {
        if (Math.hypot(pts[i][0] - ax, pts[i][1] - ay) > spec.radius) continue;
        const drop = Math.abs(ground.at(...pts[i]) - ground.at(...pts[i + 10]));
        if (!best || drop > best.drop) {
          let run = pts.slice(Math.max(0, i - 3), i + 14);
          if (ground.at(...run[0]) < ground.at(...run[run.length - 1])) run = run.reverse();
          best = { drop, run };
        }
      }
    }
    if (best && best.drop > 6) out.push({ spec, run: best.run });
  }
  return out;
}

/** Carves a plunge pool under each waterfall into the ground, blended over a few metres. */
export function carveStamps(placed: PlacedStamp[], ground: Heightfield): void {
  for (const { run } of placed) {
    const [px, py] = run[run.length - 1];
    const floor = ground.at(px, py) - 1.4;
    const [r0, r1] = [5, 10];
    for (let r = 0; r < ground.rows; r++) {
      for (let c = 0; c < ground.cols; c++) {
        const x = ground.x0 + c * ground.cell;
        const y = ground.y0 + r * ground.cell;
        const d = Math.hypot(x - px, y - py);
        if (d >= r1) continue;
        const k = r * ground.cols + c;
        const w = d <= r0 ? 1 : 1 - (d - r0) / (r1 - r0);
        ground.data[k] = Math.min(ground.data[k], ground.data[k] + (floor - ground.data[k]) * w * w * (3 - 2 * w));
      }
    }
  }
}

export interface StampMesh {
  geometry: THREE.BufferGeometry;
  material: 'falls' | 'rock';
}

/** A sheet of white water down the drop, and a pool at its foot. */
export function buildStamps(model: TileModel, ground: Heightfield, _hillScale: number, placed = placeStamps(model, ground)): StampMesh[] {
  const out: StampMesh[] = [];
  for (const { run } of placed) {
    const pos: number[] = [];
    const idx: number[] = [];
    run.forEach(([x, y], i) => {
      const [nx, ny] = run[Math.min(run.length - 1, i + 1)];
      const [bx, by] = run[Math.max(0, i - 1)];
      const [tx, ty] = [nx - bx, ny - by];
      const l = Math.hypot(tx, ty) || 1;
      // Narrow at the lip, spreading as it falls.
      const half = 1.2 + (i / run.length) * 2.2;
      const h = ground.at(x, y) + 0.5;
      pos.push(x - (ty / l) * half, h, -(y + (tx / l) * half), x + (ty / l) * half, h, -(y - (tx / l) * half));
      if (i) idx.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
    });
    const sheet = new THREE.BufferGeometry();
    sheet.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    sheet.setIndex(idx);
    sheet.computeVertexNormals();
    out.push({ geometry: sheet, material: 'falls' });
    const [px, py] = run[run.length - 1];
    out.push({ geometry: new THREE.CircleGeometry(6.5, 18).rotateX(-Math.PI / 2).translate(px, ground.at(px, py) + 0.9, -py), material: 'falls' });
  }
  return out;
}
