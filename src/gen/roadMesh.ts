// Step 3 of road generation: meshes from tracks and junction shapes.
import * as THREE from 'three';
import type { JunctionShape, JunctionStatus, P3 } from './junctions.ts';
import { RoadIndex } from './roadIndex.ts';
import type { Network } from './network.ts';
import type { PavePiece } from './pavement.ts';
import { offset, stations } from './stations.ts';
import { DECK_DEPTH, type RoadParams, type Track, sampleAt } from './tracks.ts';

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
  /** Vertices lit as if level, whatever their triangles' tilt. */
  private level: number[] = [];

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

  /**
   * A polygon with holes. `level` lights it as flat ground: paving is cut into long thin triangles
   * between edges at slightly different heights, and lit by their own tilt they show as streaks.
   */
  polygon(ring: P3[], c: RGB, holes: P3[][] = [], level = false): void {
    const base = this.pos.length / 3;
    for (const p of [ring, ...holes].flat()) {
      const v = this.vertex(p, c);
      if (level) this.level.push(v);
    }
    const v2 = (r: P3[]) => r.map((p) => new THREE.Vector2(p.x, p.y));
    const faces = THREE.ShapeUtils.triangulateShape(v2(ring), holes.map(v2));
    for (const f of faces) this.idx.push(base + f[0], base + f[1], base + f[2]);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    const normal = g.getAttribute('normal');
    for (const v of this.level) normal.setXYZ(v, 0, 1, 0);
    return g;
  }
}

export interface RoadMeshOptions {
  /** Colour junctions by how well the generator coped, instead of as asphalt. */
  tintJunctions: boolean;
}

export function buildRoadMeshes(net: Network, p: RoadParams, opts: RoadMeshOptions): { surface: THREE.BufferGeometry; markings: THREE.BufferGeometry } {
  const b = new Builder();
  const m = new Builder();
  const all = [...net.tracks.values()];
  const junctions: JunctionShape[] = net.junctions;
  const index = new RoadIndex(all);
  const C = ROAD_COLOURS;
  const white: RGB = [0.93, 0.93, 0.9];
  const LIFT = 0.04;
  const kh = p.kerbHeight;

  // Ends of roads that have right of way through an intersection: their lines run up to it.
  const free = new Set<string>();
  for (const j of junctions) if (j.groups >= 3) for (const mo of j.mouths) if (!mo.stop) free.add(mo.track.road.id + mo.end);

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
      // Nothing is built along an edge that lies against another road.
      const open = (i: number) => Math.max(room[i], room[i + 1]) > 0.05;
      // On the ground, a road's footpath is part of the shared pavement; only a bare edge gets a bank here.
      if (!t.road.footpath) b.ribbon(edge, sts.map((st, i) => offset(st, side * (half[i] + 1.0), -1.0)), C.bank, (i) => onGround(i) && open(i));
      // On a structure the road carries its own kerb and footpath, and ends in a deck edge with a barrier.
      const paved = (i: number) => elevated(i) && Math.max(path[i], path[i + 1]) > 0.3;
      const whole = (i: number) => !t.road.footpath || Math.min(path[i], path[i + 1]) > p.footpathWidth - 0.05;
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

    markRoad(m, t, white, LIFT, index, free.has(t.road.id + 'a'), free.has(t.road.id + 'b'));
  }

  for (const j of junctions) {
    // Between motorway carriageways the join is motorway too, so a merge shows no patch.
    const fast = j.mouths.length > 0 && j.mouths.every((m) => m.track.cls === 'motorway' || m.track.cls === 'ramp');
    const down = (r: P3[]) => r.map((pt) => ({ ...pt, h: pt.h - DECK_DEPTH }));
    for (const piece of j.pieces) {
      b.polygon(piece.outer, opts.tintJunctions ? STATUS_TINT[j.status] : fast ? C.motorway : C.junction, piece.holes);
      if (j.deck) b.polygon(down(piece.outer), C.structure, piece.holes.map(down));
    }
    for (const f of j.fillets) {
      if (f.deck && !f.footpath && f.pts.length >= 2) {
        b.ribbon(f.pts, f.pts.map((pt) => ({ ...pt, h: pt.h - DECK_DEPTH })), C.structure);
        b.ribbon(f.pts, f.pts.map((pt) => ({ ...pt, h: pt.h + 1.0 })), C.barrier);
      }
      // On the ground the corner's footpath is part of the shared pavement.
      if (!f.footpath || !f.deck || f.pts.length < 2) continue;
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
      b.ribbon(far, far.map((pt) => ({ ...pt, h: pt.h - kh - DECK_DEPTH })), C.structure);
      b.ribbon(far, far.map((pt) => ({ ...pt, h: pt.h + 1.0 })), C.barrier);
    }
    centreThrough(m, j, white, LIFT);
    // Only a real intersection stops anyone: three or more ways out.
    if (j.groups >= 3) for (const mouth of j.mouths) if (mouth.stop) stopLine(m, mouth.track, mouth.end, white, LIFT);
  }

  for (const piece of net.pavement.paved) pave(b, piece, kh);
  for (const piece of net.pavement.sealed) b.polygon(piece.outer.pts, C.asphalt, piece.holes.map((h) => h.pts));
  for (const piece of net.pavement.banks) b.polygon(piece.outer.pts, C.bank, piece.holes.map((h) => h.pts), true);
  // Just proud of the driveway it lies across, so the two surfaces never fight.
  const proud = (r: P3[]) => r.map((q) => ({ ...q, h: q.h + 0.03 }));
  for (const piece of net.pavement.crossings) b.polygon(proud(piece.outer.pts), C.footpath, piece.holes.map((h) => proud(h.pts)), true);

  return { surface: b.build(), markings: m.build() };
}

/** A piece of the shared pavement: its top a kerb above the road, a kerb face to each road it meets, a bank elsewhere. */
function pave(b: Builder, piece: PavePiece, kh: number): void {
  const C = ROAD_COLOURS;
  const up = (r: P3[]) => r.map((q) => ({ ...q, h: q.h + kh }));
  b.polygon(up(piece.outer.pts), C.footpath, piece.holes.map((h) => up(h.pts)), true);
  for (const ring of [piece.outer, ...piece.holes]) {
    const n = ring.pts.length;
    const at = (k: number) => ring.pts[(k + n) % n];
    // Outward is to the right: the paving lies to the left of its boundary.
    const out = ring.pts.map((_, k) => {
      const [a, c] = [at(k - 1), at(k + 1)];
      const d = Math.hypot(c.x - a.x, c.y - a.y) || 1;
      return { x: (c.y - a.y) / d, y: -(c.x - a.x) / d };
    });
    for (let k = 0; k < n; k++) {
      const [a, c] = [at(k), at(k + 1)];
      if (ring.edge[k] === 'seam') continue;
      if (ring.edge[k] === 'kerb') {
        b.ribbon([a, c], [{ ...a, h: a.h + kh }, { ...c, h: c.h + kh }], C.kerb);
      } else {
        const [oa, oc] = [out[k], out[(k + 1) % n]];
        b.ribbon(
          [{ ...a, h: a.h + kh }, { ...c, h: c.h + kh }],
          [
            { x: a.x + oa.x, y: a.y + oa.y, h: a.h - 1 },
            { x: c.x + oc.x, y: c.y + oc.y, h: c.h - 1 },
          ],
          C.bank,
        );
      }
    }
  }
}

/** Lateral position of a point at distance `s`, `lateral` metres left of the centreline. */
function place(t: Track, s: number, lateral: (c: ReturnType<typeof sampleAt>) => number, lift: number): P3 & { c: ReturnType<typeof sampleAt> } {
  const c = sampleAt(t, s);
  const d = Math.hypot(c.tx, c.ty) || 1;
  const l = lateral(c);
  return { x: c.x - (c.ty / d) * l, y: c.y + (c.tx / d) * l, h: c.h + lift, c };
}

function markRoad(m: Builder, t: Track, white: RGB, lift: number, index: RoadIndex, freeA: boolean, freeB: boolean): void {
  if (t.cls === 'lane') return;
  // Lines stop short of an intersection and run straight through a seam.
  const from = t.thruA ? 0 : t.cutA + (freeA ? 0 : 1.5);
  const to = t.thruB ? t.length : t.length - t.cutB - (freeB ? 0 : 1.5);
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

/** Where one two-way road has right of way through an intersection, its centre line carries on across. */
function centreThrough(m: Builder, j: JunctionShape, white: RGB, lift: number): void {
  const through = j.mouths.filter((mo) => !mo.stop);
  if (j.groups < 3 || through.length !== 2) return;
  if (through.some((mo) => mo.track.oneWay || mo.track.cls === 'lane' || mo.track.cls === 'motorway' || mo.track.cls === 'ramp')) return;
  const ends = through.map((mo) => {
    const t = mo.track;
    const q = place(t, mo.end === 'a' ? t.cutA : t.length - t.cutB, (c) => (c.wB - c.wF) / 2, lift);
    const d = Math.hypot(q.c.tx, q.c.ty) || 1;
    // Heading into the junction.
    const sign = mo.end === 'a' ? -1 : 1;
    return { q, dx: (q.c.tx / d) * sign, dy: (q.c.ty / d) * sign };
  });
  const [a, b] = ends;
  const gap = Math.hypot(b.q.x - a.q.x, b.q.y - a.q.y);
  if (gap < 1 || gap > 80) return;
  const k = gap * 0.35;
  const at = (v: number): P3 => {
    const w = 1 - v;
    const [c1x, c1y, c2x, c2y] = [a.q.x + a.dx * k, a.q.y + a.dy * k, b.q.x + b.dx * k, b.q.y + b.dy * k];
    return {
      x: w * w * w * a.q.x + 3 * w * w * v * c1x + 3 * w * v * v * c2x + v * v * v * b.q.x,
      y: w * w * w * a.q.y + 3 * w * w * v * c1y + 3 * w * v * v * c2y + v * v * v * b.q.y,
      h: a.q.h + (b.q.h - a.q.h) * v,
    };
  };
  const n = Math.max(2, Math.ceil(gap / 1.5));
  const pts = Array.from({ length: n + 1 }, (_, i) => at(i / n));
  const W = 0.14;
  const side = (s: number): P3[] =>
    pts.map((q, i) => {
      const [p0, p1] = [pts[Math.max(0, i - 1)], pts[Math.min(n, i + 1)]];
      const d = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
      return { x: q.x - ((p1.y - p0.y) / d) * s, y: q.y + ((p1.x - p0.x) / d) * s, h: q.h };
    });
  const dashed = through.every((mo) => mo.track.cls === 'street');
  // Dashes of two segments in every six, about 3 m in 9.
  m.ribbon(side(W / 2), side(-W / 2), white, dashed ? (i) => i % 6 < 2 : undefined);
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
