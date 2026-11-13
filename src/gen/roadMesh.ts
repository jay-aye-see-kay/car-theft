// Step 3 of road generation: meshes from tracks and junction shapes.
import * as THREE from 'three';
import type { JunctionShape, JunctionStatus, P3 } from './junctions.ts';
import { RoadIndex } from './roadIndex.ts';
import { DECK_DEPTH, type RoadParams, type Track, deckDepth, sampleAt } from './tracks.ts';

type RGB = [number, number, number];

const hex = (c: number): RGB => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];

export const ROAD_COLOURS = {
  asphalt: hex(0x4a4e57),
  motorway: hex(0x3f434c),
  junction: hex(0x4a4e57),
  footpath: hex(0xb9b4a8),
  kerb: hex(0x8f8b82),
  bank: hex(0x6d7f55),
  structure: hex(0x9a9a96),
  barrier: hex(0xc9c7c0),
};

const STATUS_TINT: Record<JunctionStatus, RGB> = { ok: hex(0x3d8f5f), squeezed: hex(0xd9862b), merge: hex(0xb04bd1) };

/** Collects triangles with per-vertex colour. Tile coordinates in, Three.js coordinates out (y up, z south). */
class Builder {
  private pos: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];

  vertex(p: P3, c: RGB): number {
    this.pos.push(p.x, p.h, -p.y);
    this.col.push(c[0], c[1], c[2]);
    return this.pos.length / 3 - 1;
  }

  /** A strip of quads between two lines of equal length. `only` picks which segments to emit. */
  ribbon(a: P3[], b: P3[], c: RGB, only?: (i: number) => boolean): void {
    const base = this.pos.length / 3;
    for (let i = 0; i < a.length; i++) {
      this.vertex(a[i], c);
      this.vertex(b[i], c);
    }
    for (let i = 0; i < a.length - 1; i++) {
      if (only && !only(i)) continue;
      const v = base + i * 2;
      this.idx.push(v + 1, v + 3, v, v, v + 3, v + 2);
    }
  }

  polygon(ring: P3[], c: RGB): void {
    const base = this.pos.length / 3;
    for (const p of ring) this.vertex(p, c);
    const faces = THREE.ShapeUtils.triangulateShape(
      ring.map((p) => new THREE.Vector2(p.x, p.y)),
      [],
    );
    for (const f of faces) this.idx.push(base + f[0], base + f[1], base + f[2]);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

interface Station {
  x: number;
  y: number;
  h: number;
  /** Left-hand normal. */
  nx: number;
  ny: number;
  wF: number;
  wB: number;
  level: number;
  /** Room for a footpath or verge on the left and on the right. */
  room: [number, number];
  /** Depth of the deck here, if this is on a structure. */
  deck: number;
}

function stations(t: Track): Station[] {
  const from = t.cutA;
  const to = t.length - t.cutB;
  if (to - from < 0.2) return [];
  const at = [from];
  for (let i = 0; i < t.n; i++) if (t.s[i] > from + 0.5 && t.s[i] < to - 0.5) at.push(t.s[i]);
  at.push(to);
  return at.map((s) => {
    const c = sampleAt(t, s);
    const d = Math.hypot(c.tx, c.ty) || 1;
    // A station counts as elevated only if both samples around it are, so decks end cleanly on the ground.
    const level = t.level[c.i] !== 0 && t.level[c.i + 1] !== 0 ? t.level[c.i] : 0;
    const u = Math.min(1, Math.max(0, (s - t.s[c.i]) / (t.s[c.i + 1] - t.s[c.i] || 1)));
    const room = (side: 0 | 1): number => t.room[side][c.i] + (t.room[side][c.i + 1] - t.room[side][c.i]) * u;
    const deck = Math.min(deckDepth(t, c.i), deckDepth(t, Math.min(t.n - 1, c.i + 1)));
    return { x: c.x, y: c.y, h: c.h, nx: -c.ty / d, ny: c.tx / d, wF: c.wF, wB: c.wB, level, room: [room(0), room(1)], deck };
  });
}

const offset = (st: Station, lateral: number, dh = 0): P3 => ({ x: st.x + st.nx * lateral, y: st.y + st.ny * lateral, h: st.h + dh });

export interface RoadMeshOptions {
  /** Colour junctions by how well the generator coped, instead of as asphalt. */
  tintJunctions: boolean;
}

export function buildRoadMeshes(
  tracks: Iterable<Track>,
  junctions: JunctionShape[],
  p: RoadParams,
  opts: RoadMeshOptions,
): { surface: THREE.BufferGeometry; markings: THREE.BufferGeometry } {
  const b = new Builder();
  const m = new Builder();
  const all = [...tracks];
  const index = new RoadIndex(all);
  const C = ROAD_COLOURS;
  const white: RGB = [0.93, 0.93, 0.9];
  const LIFT = 0.04;
  const kh = p.kerbHeight;

  for (const t of all) {
    const sts = stations(t);
    if (sts.length < 2) continue;
    const half = sts.map((st) => (st.wF + st.wB) / 2 + t.shoulder);
    const elevated = (i: number) => sts[i].level > 0 && sts[i + 1].level > 0;
    const onGround = (i: number) => !elevated(i) && sts[i].level >= 0 && sts[i + 1].level >= 0;

    b.ribbon(
      sts.map((st, i) => offset(st, half[i])),
      sts.map((st, i) => offset(st, -half[i])),
      t.cls === 'motorway' || t.cls === 'ramp' ? C.motorway : C.asphalt,
    );

    for (const side of [1, -1]) {
      const edge = sts.map((st, i) => offset(st, side * half[i]));
      // How wide the footpath can be here: all of it, or as far as the carriageway next door.
      const room = sts.map((st) => st.room[side > 0 ? 0 : 1]);
      const path = sts.map((_, i) => (t.road.footpath ? Math.min(p.footpathWidth, room[i]) : 0));
      const paved = (i: number) => Math.max(path[i], path[i + 1]) > 0.3;
      // Nothing is built along an edge that lies against another road.
      const open = (i: number) => Math.max(room[i], room[i + 1]) > 0.05;
      // A footpath that stops short is a median reaching the next road: it has no bank.
      const whole = (i: number) => !t.road.footpath || Math.min(path[i], path[i + 1]) > p.footpathWidth - 0.05;
      // A gap too thin for a kerb is sealed over.
      if (t.road.footpath)
        b.ribbon(
          edge,
          sts.map((st, i) => offset(st, side * (half[i] + Math.min(room[i], 0.6)))),
          C.asphalt,
          (i) => open(i) && !paved(i),
        );
      let outer = edge;
      let outerLift = 0;
      if (t.road.footpath) {
        const kerbTop = sts.map((st, i) => offset(st, side * half[i], kh));
        outer = sts.map((st, i) => offset(st, side * (half[i] + path[i]), kh));
        outerLift = kh;
        b.ribbon(edge, kerbTop, C.kerb, paved);
        b.ribbon(kerbTop, outer, C.footpath, paved);
      }
      const reach = (i: number) => side * (half[i] + path[i]);
      // On the ground the edge runs down into the graded terrain. On a bridge it becomes a deck edge with a barrier.
      b.ribbon(
        outer,
        sts.map((st, i) => offset(st, reach(i) + side * 1.0, -1.0)),
        C.bank,
        (i) => onGround(i) && open(i) && whole(i),
      );
      b.ribbon(
        outer,
        sts.map((st, i) => offset(st, reach(i), -st.deck)),
        C.structure,
        (i) => elevated(i) && open(i),
      );
      b.ribbon(
        outer,
        sts.map((st, i) => offset(st, reach(i), outerLift + 1.0)),
        C.barrier,
        (i) => elevated(i) && open(i) && whole(i),
      );
    }
    const deckHalf = (i: number) => half[i] + (t.road.footpath ? Math.min(p.footpathWidth, Math.max(sts[i].room[0], sts[i].room[1])) : 0);
    b.ribbon(
      sts.map((st, i) => offset(st, deckHalf(i), -st.deck)),
      sts.map((st, i) => offset(st, -deckHalf(i), -st.deck)),
      C.structure,
      elevated,
    );

    markRoad(m, t, white, LIFT, index);
  }

  for (const j of junctions) {
    b.polygon(j.ring, opts.tintJunctions ? STATUS_TINT[j.status] : C.junction);
    if (j.deck) b.polygon(j.ring.map((pt) => ({ ...pt, h: pt.h - DECK_DEPTH })), C.structure);
    for (const f of j.fillets) {
      if (f.deck && !f.footpath && f.pts.length >= 2) {
        b.ribbon(f.pts, f.pts.map((pt) => ({ ...pt, h: pt.h - DECK_DEPTH })), C.structure);
        b.ribbon(f.pts, f.pts.map((pt) => ({ ...pt, h: pt.h + 1.0 })), C.barrier);
      }
      if (!f.footpath || f.pts.length < 2) continue;
      // Outward is to the right when walking the kerb anticlockwise around the junction.
      const out = f.pts.map((_, i) => {
        const a = f.pts[Math.max(0, i - 1)];
        const c = f.pts[Math.min(f.pts.length - 1, i + 1)];
        const d = Math.hypot(c.x - a.x, c.y - a.y) || 1;
        return { x: (c.y - a.y) / d, y: -(c.x - a.x) / d };
      });
      const top = f.pts.map((pt) => ({ ...pt, h: pt.h + kh }));
      const far = f.pts.map((pt, i) => ({ x: pt.x + out[i].x * p.footpathWidth, y: pt.y + out[i].y * p.footpathWidth, h: pt.h + kh }));
      b.ribbon(f.pts, top, C.kerb);
      b.ribbon(top, far, C.footpath);
      if (f.deck) {
        b.ribbon(far, far.map((pt) => ({ ...pt, h: pt.h - kh - DECK_DEPTH })), C.structure);
        b.ribbon(far, far.map((pt) => ({ ...pt, h: pt.h + 1.0 })), C.barrier);
      } else {
        b.ribbon(
          far,
          far.map((pt, i) => ({ x: pt.x + out[i].x, y: pt.y + out[i].y, h: pt.h - kh - 1 })),
          C.bank,
        );
      }
    }
    // Only a real intersection stops anyone: three or more ways out.
    if (j.groups >= 3) for (const mouth of j.mouths) stopLine(m, mouth.track, mouth.end, white, LIFT);
  }

  return { surface: b.build(), markings: m.build() };
}

/** Lateral position of a point at distance `s`, `lateral` metres left of the centreline. */
function place(t: Track, s: number, lateral: (c: ReturnType<typeof sampleAt>) => number, lift: number): P3 & { c: ReturnType<typeof sampleAt> } {
  const c = sampleAt(t, s);
  const d = Math.hypot(c.tx, c.ty) || 1;
  const l = lateral(c);
  return { x: c.x - (c.ty / d) * l, y: c.y + (c.tx / d) * l, h: c.h + lift, c };
}

function markRoad(m: Builder, t: Track, white: RGB, lift: number, index: RoadIndex): void {
  if (t.cls === 'lane') return;
  // Lines stop short of an intersection and run straight through a seam.
  const from = t.thruA ? 0 : t.cutA + 1.5;
  const to = t.thruB ? t.length : t.length - t.cutB - 1.5;
  if (to - from < 6) return;
  const lw = t.laneWidth;
  const W = 0.14;
  type C = ReturnType<typeof sampleAt>;
  // The line the lanes are counted out from: the centre divider, or the right-hand edge of a one-way road.
  const datum = (c: C) => (t.oneWay ? -(c.wF + c.wB) / 2 : (c.wB - c.wF) / 2);
  // Where roads overlap only one keeps its lane lines, and an edge line never crosses another road's lanes.
  const hidden = (q: P3, edge: boolean): boolean => index.covered(t, q.x, q.y, q.h - lift, edge ? 0.3 : 0, !edge);

  const solid = (lateral: (c: C) => number, edge: boolean) => {
    let a: P3[] = [];
    let b: P3[] = [];
    const flush = () => {
      if (a.length > 1) m.ribbon(a, b, white);
      [a, b] = [[], []];
    };
    const n = Math.max(1, Math.ceil((to - from) / 3));
    for (let i = 0; i <= n; i++) {
      const s = from + ((to - from) * i) / n;
      if (hidden(place(t, s, lateral, lift), edge)) {
        flush();
        continue;
      }
      a.push(place(t, s, (c) => lateral(c) + W / 2, lift));
      b.push(place(t, s, (c) => lateral(c) - W / 2, lift));
    }
    flush();
  };
  const dashed = (lateral: (c: C) => number, visible: (c: C) => boolean) => {
    for (let s = Math.ceil(from / 10) * 10; s + 3 <= to; s += 10) {
      if (!visible(sampleAt(t, s + 1.5)) || hidden(place(t, s + 1.5, lateral, lift), false)) continue;
      m.ribbon(
        [place(t, s, (c) => lateral(c) + W / 2, lift), place(t, s + 3, (c) => lateral(c) + W / 2, lift)],
        [place(t, s, (c) => lateral(c) - W / 2, lift), place(t, s + 3, (c) => lateral(c) - W / 2, lift)],
        white,
      );
    }
  };

  if (!t.oneWay) {
    if (t.cls === 'street') dashed(datum, () => true);
    else solid(datum, false);
  }
  // Lane lines sit at fixed lane widths from the datum. Through a taper the kerb moves in and
  // the outermost lane is pinched off, which is how a real lane drop is marked.
  for (let k = 1; k < 6; k++) {
    dashed(
      (c) => datum(c) + k * lw,
      (c) => k * lw <= c.wF - 0.6 * lw,
    );
    if (!t.oneWay)
      dashed(
        (c) => datum(c) - k * lw,
        (c) => k * lw <= c.wB - 0.6 * lw,
      );
  }
  if (t.cls === 'motorway' || t.cls === 'ramp') {
    solid((c) => (c.wF + c.wB) / 2, true);
    solid((c) => -(c.wF + c.wB) / 2, true);
  }
}

function stopLine(m: Builder, t: Track, end: 'a' | 'b', white: RGB, lift: number): void {
  if (t.cls === 'motorway' || t.cls === 'ramp' || t.cls === 'lane') return;
  if (t.length - t.cutA - t.cutB < 8) return;
  const s0 = end === 'a' ? t.cutA + 0.8 : t.length - t.cutB - 0.8;
  const s1 = end === 'a' ? s0 + 0.4 : s0 - 0.4;
  type C = ReturnType<typeof sampleAt>;
  // Traffic arriving at end 'a' is the backward group, on the right of the track direction.
  const divider = (c: C) => (t.oneWay ? -(c.wF + c.wB) / 2 : (c.wB - c.wF) / 2);
  const [lo, hi]: [(c: C) => number, (c: C) => number] =
    end === 'a' ? [(c) => -(c.wF + c.wB) / 2, divider] : [divider, (c) => (c.wF + c.wB) / 2];
  if (t.oneWay && end === 'a') return;
  m.ribbon([place(t, s0, hi, lift), place(t, s1, hi, lift)], [place(t, s0, lo, lift), place(t, s1, lo, lift)], white);
}
