// Step 2 of road generation: give every junction a shape.
//
// Arms are sorted around the junction. Each neighbouring pair of arms is cut back to where
// their kerb lines cross, plus a little, and the gap between them is closed with a curve.
// The same rule covers a T, a crossroads, a five-way and a merged dual-carriageway crossing.
import { Region, type XY } from '../geo/clip.ts';
import { distanceToTrack } from './roadIndex.ts';
import type { JunctionPlan } from './seams.ts';
import { type RoadParams, type Track, halfWidth, sampleAt } from './tracks.ts';

export interface P3 {
  x: number;
  y: number;
  h: number;
}

export type JunctionStatus = 'ok' | 'squeezed' | 'merge';

/** A polygon with holes: the outer ring anticlockwise, holes clockwise. */
export interface Piece {
  outer: P3[];
  holes: P3[][];
}

export interface JunctionShape {
  id: string;
  /** The roadway, usually one piece. */
  pieces: Piece[];
  /** Raised islands and median noses inside or between the arms, to be paved. */
  islands: XY[][];
  /** The kerbs between arms, each walked anticlockwise round the junction, so the road is on the left. */
  /** `deck` is true where both arms are on a structure, so the edge between them is too. */
  fillets: { pts: P3[]; footpath: boolean; deck: boolean }[];
  /** Where each arm meets the junction, for stop lines. */
  mouths: { track: Track; end: 'a' | 'b' }[];
  status: JunctionStatus;
  /** True if any of its edges is on a structure: it needs an underside. */
  deck: boolean;
  x: number;
  y: number;
  /** How many ways traffic can leave by. Fewer than three and nothing has to stop here. */
  groups: number;
  /** One stream of traffic carrying on: a merge, a split, a change of width. */
  seam: boolean;
}

interface Arm {
  t: Track;
  end: 'a' | 'b';
  group: number;
  px: number;
  py: number;
  /** Unit vector pointing away from the junction along the arm. */
  dx: number;
  dy: number;
  hw: number;
  angle: number;
  cut: number;
  maxCut: number;
}

interface Mouth {
  dx: number;
  dy: number;
  deck: boolean;
  ccw: P3;
  cw: P3;
  pathCcw: boolean;
  pathCw: boolean;
}

const PARALLEL = Math.sin((8 * Math.PI) / 180);
const ALONGSIDE = Math.sin((25 * Math.PI) / 180);
/** How little of each arm a seam takes: just enough to close the gap between them. */
const SEAM_CUT = 0.5;

/** True if no two edges of the ring cross. */
function isSimple(ring: P3[]): boolean {
  const n = ring.length;
  const side = (a: P3, b: P3, c: P3): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (let i = 0; i < n; i++) {
    const [a, b] = [ring[i], ring[(i + 1) % n]];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const [c, d] = [ring[j], ring[(j + 1) % n]];
      if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return false;
    }
  }
  return true;
}

/** The convex hull of some points, anticlockwise. */
function hull(pts: P3[]): P3[] {
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: P3, a: P3, b: P3): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (list: P3[]): P3[] => {
    const out: P3[] = [];
    for (const q of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 1e-9) out.pop();
      out.push(q);
    }
    return out.slice(0, -1);
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/** Inverse-distance height from the nearest few of a set of points. */
function heightsFrom(pts: P3[]): (x: number, y: number) => number {
  return (x, y) => {
    const near = pts.map((q) => [(q.x - x) ** 2 + (q.y - y) ** 2, q.h]).sort((a, b) => a[0] - b[0]);
    let sum = 0;
    let weight = 0;
    for (const [d2, h] of near.slice(0, 4)) {
      const w = 1 / (d2 + 1e-4);
      sum += h * w;
      weight += w;
    }
    return weight ? sum / weight : 0;
  };
}

/** An arm's centre, heading and carriageway half-width `s` metres out from the junction. Before the node it runs straight on. */
function frame(a: Arm, s: number): { x: number; y: number; h: number; dx: number; dy: number; hw: number } {
  const t = a.t;
  const on = Math.max(0, Math.min(t.length, s));
  const c = sampleAt(t, a.end === 'a' ? on : t.length - on);
  const sign = a.end === 'a' ? 1 : -1;
  const d = Math.hypot(c.tx, c.ty) || 1;
  const dx = (c.tx * sign) / d;
  const dy = (c.ty * sign) / d;
  const past = s - on;
  return { x: c.x + dx * past, y: c.y + dy * past, h: c.h, dx, dy, hw: (c.wF + c.wB) / 2 + t.shoulder };
}

/** The carriageway of an arm from `s0` to `s1` out, widened by `widen` each side. */
function strip(a: Arm, s0: number, s1: number, widen = 0): XY[] {
  const n = Math.max(1, Math.ceil((s1 - s0) / 1.5));
  const left: XY[] = [];
  const right: XY[] = [];
  for (let k = 0; k <= n; k++) {
    const f = frame(a, s0 + ((s1 - s0) * k) / n);
    const w = f.hw + widen;
    left.push({ x: f.x - f.dy * w, y: f.y + f.dx * w });
    right.push({ x: f.x + f.dy * w, y: f.y - f.dx * w });
  }
  return [...right, ...left.reverse()];
}

const alongside = (a: Arm, b: Arm): boolean => {
  const cross = Math.abs(a.dx * b.dy - a.dy * b.dx);
  return cross < PARALLEL || (a.dx * b.dx + a.dy * b.dy > 0 && cross < ALONGSIDE);
};

/** Everything a junction could be before its arms are cut back: what the cuts were measured against. */
interface Body {
  whole: Region;
  reach: number[];
  islands: XY[][];
  squeezed: boolean;
  merge: boolean;
}

/** Probes this far outside an arm's kerb must be clear of the junction for the arm to start. */
const CLEAR = 0.25;
/** A median nose reaches this far up the arms past their cuts. */
const NOSE = 6;
/** Inlets in a junction's outline narrower than twice this are paved over as islands. */
const NOTCH = 3.5;

/**
 * The junction as stubs of every arm, the area between their ends, and a kerb fillet in every corner
 * between neighbours that go different ways. Each arm is then cut where it clears all of that.
 */
function solveCuts(arms: Arm[], node: { x: number; y: number }, p: RoadParams): Body {
  const reach = arms.map((a) => a.maxCut + 2);
  // Arms do not always end at one point: where the map's node sits off a road's line, an arm is carried
  // straight back until it runs into another arm, going no further than the node or the furthest arm end behind it.
  const own = arms.map((a, i) => Region.of([strip(a, -0.5, reach[i])]));
  const starts = arms.map((a) => frame(a, 0));
  const back = arms.map((_, i) => {
    const f = starts[i];
    const behind = (q: { x: number; y: number }): number => -((q.x - f.x) * f.dx + (q.y - f.y) * f.dy);
    const limit = Math.min(15, Math.max(0.5, behind(node), ...starts.map(behind)));
    const into = (e: number): boolean => own.some((o, k) => k !== i && o.contains(f.x - f.dx * e, f.y - f.dy * e));
    for (let e = 0.5; e < limit; e += 0.5) if (into(e)) return e;
    return limit;
  });
  const stubs = arms.map((a, i) => Region.of([strip(a, -back[i], reach[i])]));
  let fill = new Region([]);
  let merge = false;
  const pairs: [number, number][] = [];
  for (let i = 0; i < arms.length; i++) {
    const k = (i + 1) % arms.length;
    if (k === i || (arms.length === 2 && i === 1)) continue;
    pairs.push([i, k]);
  }
  for (const [i, k] of pairs) {
    const [a, b] = [arms[i], arms[k]];
    if (alongside(a, b) && a.dx * b.dx + a.dy * b.dy > 0 && Math.hypot(a.px - b.px, a.py - b.py) < 3) merge = true;
    if (a.group === b.group) continue;
    let gap = b.angle - a.angle;
    while (gap <= 0) gap += 2 * Math.PI;
    // Only the inside of a corner is filled; a straight run or the outside of a bend has no kerb to round.
    if (gap > Math.PI * 0.97 && arms.length > 2) continue;
    const between = Math.acos(Math.max(-1, Math.min(1, a.dx * b.dx + a.dy * b.dy)));
    // A sharp corner takes a tight kerb, or the fillet would fill the whole wedge between the arms.
    const base = a.t.cls === 'lane' || b.t.cls === 'lane' ? p.kerbRadius * 0.5 : p.kerbRadius;
    const r = between < Math.PI / 2 ? base * Math.max(0.3, Math.sin(between)) : base;
    fill = fill.union(stubs[i].union(stubs[k]).close(r));
  }
  let whole = fill.union(Region.of(arms.map((a, i) => strip(a, -back[i], reach[i]))));

  let squeezed = false;
  arms.forEach((a, i) => {
    let others = fill;
    arms.forEach((b, k) => {
      if (k !== i && !alongside(a, b)) others = others.union(stubs[k]);
    });
    const least = Math.min(1, a.t.length * 0.3);
    let cut = -1;
    for (let s = 0; s <= a.maxCut; s += 0.5) {
      const f = frame(a, s);
      const w = f.hw + CLEAR;
      if (!others.contains(f.x - f.dy * w, f.y + f.dx * w) && !others.contains(f.x + f.dy * w, f.y - f.dx * w)) {
        cut = s;
        break;
      }
    }
    if (cut < 0) {
      cut = a.maxCut;
      squeezed = true;
      if (arms.some((b) => b !== a && a.dx * b.dx + a.dy * b.dy > Math.cos((30 * Math.PI) / 180))) merge = true;
    }
    a.cut = Math.max(least, cut);
  });

  // Between arms that leave together, such as the two halves of a divided road, the junction is roadway
  // as far as their mouths, and from there a median comes to a rounded nose.
  const together = pairs.filter(([i, k]) => arms[i].group === arms[k].group);
  for (const [i, k] of together) {
    const upTo = Region.of([strip(arms[i], -back[i], arms[i].cut), strip(arms[k], -back[k], arms[k].cut)]).union();
    whole = whole.union(upTo.close(p.kerbRadius));
  }
  const islands: XY[][] = [];
  for (const [i, k] of together) {
    const [a, b] = [arms[i], arms[k]];
    const short = Region.of([strip(a, -back[i], Math.min(reach[i], a.cut + NOSE)), strip(b, -back[k], Math.min(reach[k], b.cut + NOSE))]).union();
    // Every arm's stub is in `whole`, so the nose never reaches over a carriageway.
    const nose = short.close(p.kerbRadius).minus(whole).open(0.5, true);
    for (const sh of nose.shapes(4)) islands.push(sh.outer);
  }
  return { whole, reach, islands, squeezed, merge };
}

/** The junction's roadway: its body with each arm's own carriageway taken away past its cut. */
function outline(body: Body, arms: Arm[], mouths: Mouth[]): Pick<JunctionShape, 'pieces' | 'islands' | 'fillets'> {
  const cutaway = Region.of(arms.map((a, i) => strip(a, a.cut, body.reach[i] + 1, 0.3)));
  let roadway = body.whole.minus(cutaway);
  // A hole is a median's nose only where it meets one; anywhere else it is a gap the arms left in the
  // middle of the junction, and is driven over.
  const noses = Region.of(body.islands).offset(0.5);
  const isNose = (ring: XY[]): boolean => Region.of([ring]).within(noses).shapes(1).length > 0;
  const shapes = roadway.shapes(0.5).map((sh) => {
    const holes = sh.holes.filter(isNose);
    if (holes.length < sh.holes.length) roadway = roadway.union(Region.of(sh.holes.filter((h) => !isNose(h))));
    return { outer: sh.outer, holes };
  });
  // A narrow inlet between arms is too tight to leave as open ground: it becomes a paved island.
  const inlets = roadway.close(NOTCH).minus(roadway).minus(cutaway).open(0.3, true);

  const samples: P3[] = [];
  const ends = arms.map((a) => frame(a, a.cut));
  arms.forEach((a, i) => {
    for (let s = -0.5; s < a.cut + 2; s += 2) {
      const f = s >= a.cut ? ends[i] : frame(a, s);
      for (const l of [-f.hw, 0, f.hw]) samples.push({ x: f.x - f.dy * l, y: f.y + f.dx * l, h: f.h });
    }
  });
  const height = heightsFrom(samples);
  const lift = (q: XY): P3 => ({ x: q.x, y: q.y, h: height(q.x, q.y) });

  /** Which arm's mouth an edge lies across, or -1. */
  const mouthOf = (a: XY, b: XY): number =>
    ends.findIndex((f) => {
      const along = (q: XY) => (q.x - f.x) * f.dx + (q.y - f.y) * f.dy;
      const across = (q: XY) => -(q.x - f.x) * f.dy + (q.y - f.y) * f.dx;
      return Math.abs(along(a)) < 0.03 && Math.abs(along(b)) < 0.03 && Math.abs(across(a)) < f.hw + 0.35 && Math.abs(across(b)) < f.hw + 0.35;
    });

  const pieces: Piece[] = [];
  const fillets: JunctionShape['fillets'] = [];
  const islands = [...body.islands, ...inlets.shapes(2).map((sh) => sh.outer)];
  for (const sh of shapes) {
    const n = sh.outer.length;
    const across = sh.outer.map((q, i) => mouthOf(q, sh.outer[(i + 1) % n]));
    // A scrap that no arm opens into is left over from the cutting.
    if (!across.some((m) => m >= 0)) continue;
    const outer: P3[] = [];
    /** For each edge of the dense ring, the arm it opens into, or -1 along a kerb. */
    const edgeArm: number[] = [];
    sh.outer.forEach((q, i) => {
      const next = sh.outer[(i + 1) % n];
      const steps = across[i] >= 0 ? 1 : Math.max(1, Math.ceil(Math.hypot(next.x - q.x, next.y - q.y) / 3));
      for (let k = 0; k < steps; k++) {
        outer.push(lift({ x: q.x + ((next.x - q.x) * k) / steps, y: q.y + ((next.y - q.y) * k) / steps }));
        edgeArm.push(across[i]);
      }
    });
    pieces.push({ outer, holes: sh.holes.map((r) => r.map(lift)) });
    islands.push(...sh.holes);

    // The kerbs: each run of edges from one mouth to the next.
    const m = outer.length;
    const start = edgeArm.findIndex((x, i) => x >= 0 && edgeArm[(i + 1) % m] < 0);
    if (start < 0) continue;
    let from = edgeArm[start];
    let pts: P3[] = [outer[(start + 1) % m]];
    for (let step = 1; step <= m; step++) {
      const i = (start + step) % m;
      const arm = edgeArm[i];
      if (arm < 0) {
        pts.push(outer[(i + 1) % m]);
        continue;
      }
      if (pts.length >= 2) {
        const [ma, mb] = [mouths[from], mouths[arm]];
        fillets.push({ pts, footpath: ma.pathCcw && mb.pathCw, deck: ma.deck && mb.deck });
      }
      from = arm;
      pts = [outer[(i + 1) % m]];
    }
  }
  return { pieces, islands, fillets };
}

export function solveJunctions(plans: Map<string, JunctionPlan>, p: RoadParams): JunctionShape[] {
  const shapes: JunctionShape[] = [];
  for (const plan of plans.values()) {
    const j = plan.junction;
    if (j.arms.length < 2) continue;
    let status: JunctionStatus = plan.seam ? 'merge' : 'ok';

    const arms: Arm[] = plan.arms
      .filter((a) => !a.minor)
      .map((a) => {
        const t = a.t;
        const i = a.end === 'a' ? 0 : t.n - 1;
        // Direction from a point a little way up the arm, so one odd map vertex cannot skew it.
        const far = sampleAt(t, a.end === 'a' ? Math.min(12, t.length / 2) : t.length - Math.min(12, t.length / 2));
        const d = Math.hypot(far.x - t.x[i], far.y - t.y[i]) || 1;
        const dx = (far.x - t.x[i]) / d;
        const dy = (far.y - t.y[i]) / d;
        return {
          t,
          end: a.end,
          group: a.group,
          px: t.x[i],
          py: t.y[i],
          dx,
          dy,
          hw: halfWidth(t, i),
          angle: Math.atan2(t.y[i] + dy * 15 - j.y, t.x[i] + dx * 15 - j.x),
          cut: plan.seam ? Math.min(SEAM_CUT, t.length * 0.3) : Math.min(2, t.length * 0.3),
          // Both ends of a short road cannot each take more than half of it.
          maxCut: Math.min(p.maxCut, t.length * 0.45),
        };
      });
    arms.sort((a, b) => a.angle - b.angle);

    // A lane stops where it clears the kerb and footpath of every road it meets here.
    for (const a of plan.arms) {
      if (!a.minor) continue;
      const t = a.t;
      const limit = Math.min(p.maxCut, t.length * 0.45);
      let cut = Math.min(2, limit);
      for (; cut < limit; cut += 0.5) {
        const c = sampleAt(t, a.end === 'a' ? cut : t.length - cut);
        const clear = arms.every((arm) => {
          const o = arm.t;
          const i = arm.end === 'a' ? Math.min(o.n - 1, 1) : Math.max(0, o.n - 2);
          let d = Infinity;
          // The first stretch of the arm, which is all a lane's end could be near.
          for (let k = 0; k < Math.min(o.n, 24); k++) d = Math.min(d, distanceToTrack(o, arm.end === 'a' ? k : o.n - 1 - k, c.x, c.y));
          return d > halfWidth(o, i) + (o.road.footpath ? p.footpathWidth : 0) + 0.2;
        });
        if (clear) break;
      }
      if (a.end === 'a') t.cutA = cut;
      else t.cutB = cut;
    }
    if (arms.length < 2) continue;

    // Cut each arm back to where it clears every other arm and the kerbs that join them. At a seam the
    // arms already sit side by side and are not cut back at all.
    const body = plan.seam ? null : solveCuts(arms, j, p);
    if (body && body.squeezed && status === 'ok') status = 'squeezed';
    if (body && body.merge) status = 'merge';

    // Corner points of each arm's mouth.
    const mouths: Mouth[] = arms.map((arm) => {
      const s = arm.end === 'a' ? arm.cut : arm.t.length - arm.cut;
      if (arm.end === 'a') [arm.t.cutA, arm.t.thruA] = [arm.cut, plan.seam];
      else [arm.t.cutB, arm.t.thruB] = [arm.cut, plan.seam];
      const c = sampleAt(arm.t, s);
      const sign = arm.end === 'a' ? 1 : -1;
      const dx = c.tx * sign;
      const dy = c.ty * sign;
      const hw = (c.wF + c.wB) / 2 + arm.t.shoulder;
      // Anticlockwise of an arm is the left of its track if the track leaves the junction, the right if it arrives.
      const room = (ccw: boolean): number => arm.t.room[(arm.end === 'a') === ccw ? 0 : 1][Math.min(arm.t.n - 1, c.i + (arm.end === 'a' ? 0 : 1))];
      return {
        dx,
        dy,
        deck: arm.t.level[c.i] > 0 || arm.t.level[Math.min(arm.t.n - 1, c.i + 1)] > 0,
        ccw: { x: c.x - dy * hw, y: c.y + dx * hw, h: c.h },
        cw: { x: c.x + dy * hw, y: c.y - dx * hw, h: c.h },
        // Whether a full footpath runs down each side of the arm at its mouth.
        pathCcw: arm.t.road.footpath && room(true) > p.footpathWidth - 0.1,
        pathCw: arm.t.road.footpath && room(false) > p.footpathWidth - 0.1,
      };
    });

    if (!plan.seam) {
      const shape = outline(body!, arms, mouths);
      shapes.push({
        id: j.id,
        pieces: shape.pieces,
        islands: shape.islands,
        fillets: shape.fillets,
        mouths: arms.map((a) => ({ track: a.t, end: a.end })),
        status,
        deck: shape.fillets.some((f) => f.deck),
        x: j.x,
        y: j.y,
        groups: plan.groups,
        seam: false,
      });
      continue;
    }

    let ring: P3[] = [];
    const fillets: JunctionShape['fillets'] = [];
    for (let i = 0; i < arms.length; i++) {
      const k = (i + 1) % arms.length;
      const [m, next] = [mouths[i], mouths[k]];
      const A = m.ccw;
      const B = next.cw;
      ring.push(m.cw, A);
      const gap = Math.hypot(B.x - A.x, B.y - A.y);
      // Arms of a seam that leave together lie against each other: there is no edge between them.
      if (gap < 0.05 || (plan.seam && arms[i].group === arms[k].group && arms.length > 2)) continue;
      // Handles for a cubic Bézier leaving A back along its kerb and arriving at B along its kerb.
      const cross = m.dx * next.dy - m.dy * next.dx;
      let ka = gap * 0.35;
      let kb = gap * 0.35;
      if (Math.abs(cross) >= PARALLEL) {
        const t = ((B.x - A.x) * next.dy - (B.y - A.y) * next.dx) / cross;
        const u = ((B.x - A.x) * m.dy - (B.y - A.y) * m.dx) / cross;
        if (t < 0 && u < 0 && t > -90 && u > -90) {
          ka = -t * 0.55;
          kb = -u * 0.55;
        }
      }
      const c1 = { x: A.x - m.dx * ka, y: A.y - m.dy * ka };
      const c2 = { x: B.x - next.dx * kb, y: B.y - next.dy * kb };
      const steps = Math.max(2, Math.min(12, Math.ceil(gap / 1.5)));
      const pts: P3[] = [];
      for (let q = 0; q <= steps; q++) {
        const v = q / steps;
        const w = 1 - v;
        pts.push({
          x: w * w * w * A.x + 3 * w * w * v * c1.x + 3 * w * v * v * c2.x + v * v * v * B.x,
          y: w * w * w * A.y + 3 * w * w * v * c1.y + 3 * w * v * v * c2.y + v * v * v * B.y,
          h: A.h + (B.h - A.h) * v,
        });
      }
      ring.push(...pts.slice(1, -1));
      // The footpath carries round any edge whose two arms both bring one to it.
      fillets.push({ pts, footpath: m.pathCcw && next.pathCw, deck: m.deck && next.deck });
    }
    // Arms that leave at different angles each end square to their own heading, which can tie the outline
    // in a knot. A seam's arms lie side by side, so the hull of the same points is a sound surface:
    // anything it adds is the wedge between mouths that were already touching.
    let pieces: Piece[] = [{ outer: ring, holes: [] }];
    if (!isSimple(ring)) pieces = [{ outer: hull(ring), holes: [] }];

    shapes.push({
      id: j.id,
      pieces,
      islands: [],
      fillets,
      mouths: arms.map((a) => ({ track: a.t, end: a.end })),
      status,
      deck: fillets.some((f) => f.deck),
      x: j.x,
      y: j.y,
      groups: plan.groups,
      seam: plan.seam,
    });
  }
  return shapes;
}
