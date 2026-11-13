// Open-sided covers: canopies and shelters on posts, and the glazed screens that line some bridges.
// The model says only "a cover stands here"; everything else is generated.
import * as THREE from 'three';
import { centroid, dist, pointInRing, ringArea } from '../geo/poly.ts';
import type { Heightfield } from '../model/load.ts';
import type { Building, Pt } from '../model/types.ts';
import type { Track } from './tracks.ts';

type P3 = [number, number, number];

/** Loose triangles in tile coordinates (x east, y north, h up), flat shaded. */
class Soup {
  private pos: number[] = [];
  private col: number[] = [];
  private c = new THREE.Color();

  tri(a: P3, b: P3, c: P3, colour: number): void {
    this.c.setHex(colour);
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[2], -p[1]);
      this.col.push(this.c.r, this.c.g, this.c.b);
    }
  }

  quad(a: P3, b: P3, c: P3, d: P3, colour: number): void {
    this.tri(a, b, c, colour);
    this.tri(a, c, d, colour);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }
}

const COLOURS = { roof: 0xdcd8cc, fascia: 0x9da1a6, post: 0x7f858c, frame: 0x59616b, plinth: 0xb9b6ae, glass: 0xbfe6f2 };

/** A glazed screen in section: metres in from the bridge's edge (as a share of its depth) and metres up. */
const SCREEN: [number, number][] = [
  [0, 0.35],
  [0, 1.7],
  [0.08, 2.2],
  [0.3, 2.65],
  [0.62, 2.92],
  [1, 3.0],
];

export interface CoverMeshes {
  /** Posts, roofs and framing. */
  frame: THREE.BufferGeometry;
  /** Glazing, meant for a see-through material. */
  glass: THREE.BufferGeometry;
}

/** Top of a shop verandah above the footpath, and of a bus or park shelter. */
const VERANDAH = 3.6;
const SHELTER = 2.7;
/** A cover at least this deep, front to back, is more than a verandah. */
const PORTICO_DEPTH = 8;
const PORTICO_MAX = 12;

/** The ring's extent across its longest edge. */
function depthOf(ring: Pt[]): number {
  let [len, ux, uy] = [0, 1, 0];
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length];
    const l = dist(p, q);
    if (l > len) [len, ux, uy] = [l, (q[0] - p[0]) / l, (q[1] - p[1]) / l];
  });
  const across = ring.map(([x, y]) => -x * uy + y * ux);
  return Math.max(...across) - Math.min(...across);
}

const boxes = new WeakMap<Building, [number, number, number, number]>();
function boxOf(b: Building): [number, number, number, number] {
  let box = boxes.get(b);
  if (!box) {
    box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of b.ring) box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
    boxes.set(b, box);
  }
  return box;
}

/** True if any corner or edge midpoint of the cover is in or hard against a walled building. */
function attached(cover: Building, walled: Building[]): boolean {
  const probes: Pt[] = [];
  cover.ring.forEach((p, i) => {
    const q = cover.ring[(i + 1) % cover.ring.length];
    probes.push(p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
  });
  const [x0, y0, x1, y1] = boxOf(cover);
  return walled.some((b) => {
    const box = boxOf(b);
    if (box[0] > x1 + 2 || box[2] < x0 - 2 || box[1] > y1 + 2 || box[3] < y0 - 2) return false;
    return probes.some(([x, y]) => {
      if (pointInRing(x, y, b.ring)) return true;
      return b.ring.some((a, i) => {
        const c = b.ring[(i + 1) % b.ring.length];
        const len2 = (c[0] - a[0]) ** 2 + (c[1] - a[1]) ** 2 || 1;
        const u = Math.min(1, Math.max(0, ((x - a[0]) * (c[0] - a[0]) + (y - a[1]) * (c[1] - a[1])) / len2));
        return Math.hypot(x - a[0] - (c[0] - a[0]) * u, y - a[1] - (c[1] - a[1]) * u) < 1.5;
      });
    });
  });
}

/**
 * How tall a ground-level cover stands. Its measured height is only trusted where a profile says so:
 * from the air, a verandah reads as the building behind it and a bus shelter as the tree over it.
 */
export function coverHeight(b: Building, walled: Building[]): number {
  if (b.kind === 'shelter') return SHELTER;
  // A deep roof is a portico or a forecourt canopy, and big enough for its own height to have been
  // measured. A shallow one hard against a building is a verandah over the footpath.
  if (depthOf(b.ring) >= PORTICO_DEPTH) return Math.min(Math.max(VERANDAH, b.h), PORTICO_MAX);
  if (attached(b, walled)) return VERANDAH;
  // Free-standing: a small one is a shelter or carport, a big one a forecourt canopy.
  return Math.abs(ringArea(b.ring)) < 40 ? Math.min(b.h, 3.2) : Math.min(b.h, 6.5);
}

export function buildCovers(buildings: Building[], ground: Heightfield, tracks: Iterable<Track>): CoverMeshes {
  const walled = buildings.filter((b) => !b.cover);
  const frame = new Soup();
  const glass = new Soup();

  // Every sample of every deck, for finding the bridge a cover stands on.
  const decks: { x: number; y: number; h: number }[] = [];
  for (const t of tracks) for (let i = 0; i < t.n; i++) if (t.level[i] > 0) decks.push({ x: t.x[i], y: t.y[i], h: t.h[i] });
  const deckAt = (p: Pt): { h: number; d: number } => {
    let best = { h: ground.at(p[0], p[1]), d: Infinity };
    for (const s of decks) {
      const d = Math.hypot(s.x - p[0], s.y - p[1]);
      if (d < best.d) best = { h: s.h, d };
    }
    return best;
  };

  for (const b of buildings) {
    if (b.cover === 'deck' && decks.length) screen(b);
    else if (b.cover) canopy(b);
  }
  return { frame: frame.build(), glass: glass.build() };

  /** A roof slab on posts. */
  function canopy(b: Building): void {
    const ring = b.ring;
    const c = centroid(ring);
    const base = Math.max(...ring.map((p) => ground.at(p[0], p[1])));
    const top = base + Math.max(2.6, coverHeight(b, walled));
    const under = top - 0.3;
    const faces = THREE.ShapeUtils.triangulateShape(ring.map((p) => new THREE.Vector2(p[0], p[1])), []);
    for (const [i, j, k] of faces) {
      frame.tri([...ring[i], top], [...ring[j], top], [...ring[k], top], COLOURS.roof);
      frame.tri([...ring[i], under], [...ring[k], under], [...ring[j], under], COLOURS.fascia);
    }
    ring.forEach((p, i) => {
      const q = ring[(i + 1) % ring.length];
      frame.quad([...p, under], [...q, under], [...q, top], [...p, top], COLOURS.fascia);
      // A post at each corner and along long edges, set in a little from the roof's edge.
      const len = dist(p, q);
      // Taller roofs stand on fewer, heavier posts.
      const n = Math.max(1, Math.ceil(len / Math.max(6, (top - base) * 1.5)));
      if (len < 1.2 && ring.length > 4) return;
      for (let s = 0; s < n; s++) {
        const u = s / n;
        const x = p[0] + (q[0] - p[0]) * u;
        const y = p[1] + (q[1] - p[1]) * u;
        const pull = Math.min(0.4, Math.hypot(c[0] - x, c[1] - y) * 0.3) / (Math.hypot(c[0] - x, c[1] - y) || 1);
        post(x + (c[0] - x) * pull, y + (c[1] - y) * pull, under, Math.max(0.11, (top - base) * 0.035));
      }
    });
  }

  function post(x: number, y: number, top: number, r: number): void {
    const foot = ground.at(x, y) - 0.4;
    const corners: Pt[] = [
      [x - r, y - r],
      [x + r, y - r],
      [x + r, y + r],
      [x - r, y + r],
    ];
    corners.forEach((p, i) => {
      const q = corners[(i + 1) % 4];
      frame.quad([...p, foot], [...q, foot], [...q, top], [...p, top], COLOURS.post);
    });
  }

  /** Glazing along a bridge's outer edge that curves in over the footpath. */
  function screen(b: Building): void {
    const ring = b.ring;
    const c = centroid(ring);
    const fromDeck = deckAt(c).d;
    const edges = ring.map((p, i) => ({ p, q: ring[(i + 1) % ring.length] }));
    const mid = (e: { p: Pt; q: Pt }): Pt => [(e.p[0] + e.q[0]) / 2, (e.p[1] + e.q[1]) / 2];
    // The sides facing away from the carriageway get the glass; the side facing it stays open.
    let outer = edges.filter((e) => dist(e.p, e.q) > 2 && deckAt(mid(e)).d > fromDeck + 0.4);
    if (!outer.length) outer = edges.filter((e) => dist(e.p, e.q) > 4);
    for (const e of outer) {
      const len = dist(e.p, e.q);
      const [ux, uy] = [(e.q[0] - e.p[0]) / len, (e.q[1] - e.p[1]) / len];
      // Rings run anticlockwise, so the left-hand normal points inwards.
      const [nx, ny] = [-uy, ux];
      const m = mid(e);
      const depth = Math.min(2.4, Math.max(0.8, Math.abs((c[0] - m[0]) * nx + (c[1] - m[1]) * ny) * 2));
      const panels = Math.max(1, Math.round(len / 3));
      const at = (k: number, j: number, along = 0, out = 0): P3 => {
        const s = (k / panels) * len + along;
        const x = e.p[0] + ux * s;
        const y = e.p[1] + uy * s;
        const o = SCREEN[j][0] * depth - out;
        return [x + nx * o, y + ny * o, deckAt([x, y]).h + 0.15 + SCREEN[j][1]];
      };
      const last = SCREEN.length - 1;
      for (let k = 0; k < panels; k++) {
        for (let j = 0; j < last; j++) glass.quad(at(k, j), at(k + 1, j), at(k + 1, j + 1), at(k, j + 1), COLOURS.glass);
        // A low plinth under the glass, and rails where the wall turns into roof and along its lip.
        const foot = (kk: number, z: number): P3 => {
          const p = at(kk, 0);
          return [p[0], p[1], p[2] - SCREEN[0][1] + z];
        };
        frame.quad(foot(k, -0.2), foot(k + 1, -0.2), foot(k + 1, SCREEN[0][1]), foot(k, SCREEN[0][1]), COLOURS.plinth);
        for (const j of [1, last]) {
          const lift = (p: P3): P3 => [p[0], p[1], p[2] + 0.09];
          frame.quad(at(k, j, 0, 0.03), at(k + 1, j, 0, 0.03), lift(at(k + 1, j, 0, 0.03)), lift(at(k, j, 0, 0.03)), COLOURS.frame);
        }
      }
      // Ribs follow the same curve at every panel joint.
      for (let k = 0; k <= panels; k++) {
        for (let j = 0; j < last; j++) frame.quad(at(k, j, -0.07, 0.03), at(k, j, 0.07, 0.03), at(k, j + 1, 0.07, 0.03), at(k, j + 1, -0.07, 0.03), COLOURS.frame);
      }
    }
  }
}
