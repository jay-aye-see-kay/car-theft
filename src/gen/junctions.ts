// Step 2 of road generation: give every junction a shape.
//
// Arms are sorted around the junction. Each neighbouring pair of arms is cut back to where
// their kerb lines cross, plus a little, and the gap between them is closed with a curve.
// The same rule covers a T, a crossroads, a five-way and a merged dual-carriageway crossing.
import { distanceToTrack } from './roadIndex.ts';
import type { JunctionPlan } from './seams.ts';
import { type RoadParams, type Track, halfWidth, sampleAt } from './tracks.ts';

export interface P3 {
  x: number;
  y: number;
  h: number;
}

export type JunctionStatus = 'ok' | 'squeezed' | 'merge';

export interface JunctionShape {
  id: string;
  /** Boundary, anticlockwise. */
  ring: P3[];
  /** The curved kerbs between arms. `corner` is false where two arms are simply bridged. */
  /** `deck` is true where both arms are on a structure, so the edge between them is too. */
  fillets: { pts: P3[]; corner: boolean; footpath: boolean; deck: boolean }[];
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

/** Convex hull, anticlockwise. */
function hull(pts: P3[]): P3[] {
  const sorted = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const turn = (o: P3, a: P3, b: P3): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (list: P3[]): P3[] => {
    const out: P3[] = [];
    for (const q of list) {
      while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
      out.push(q);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half(sorted.reverse())];
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

    const radius = (a: Arm, b: Arm): number => (a.t.cls === 'lane' || b.t.cls === 'lane' ? p.kerbRadius * 0.5 : p.kerbRadius);

    // Cut each arm back to where its kerb crosses each neighbour's. At a seam the arms already sit
    // side by side and are not cut back at all.
    for (let i = 0; i < arms.length && !plan.seam; i++) {
      const a = arms[i];
      const b = arms[(i + 1) % arms.length];
      if (a === b) continue;
      // a's anticlockwise kerb line and b's clockwise kerb line.
      const ax = a.px - a.dy * a.hw;
      const ay = a.py + a.dx * a.hw;
      const bx = b.px + b.dy * b.hw;
      const by = b.py - b.dx * b.hw;
      const cross = a.dx * b.dy - a.dy * b.dx;
      const dot = a.dx * b.dx + a.dy * b.dy;
      // Arms that leave side by side are not cut back to where they part, which can be a long way off:
      // they overlap, and the lesser one gives way.
      if (Math.abs(cross) < PARALLEL || (dot > 0 && Math.abs(cross) < ALONGSIDE)) {
        if (Math.hypot(a.px - b.px, a.py - b.py) < 3 && dot > 0) status = 'merge';
        continue;
      }
      const t = ((bx - ax) * b.dy - (by - ay) * b.dx) / cross;
      const u = ((bx - ax) * a.dy - (by - ay) * a.dx) / cross;
      const r = radius(a, b);
      // A shallow angle means a long merge; note it, since it deserves a purpose-built generator.
      if (a.dx * b.dx + a.dy * b.dy > Math.cos((30 * Math.PI) / 180) && Math.max(t, u) > 20) status = 'merge';
      for (const [arm, along] of [
        [a, t],
        [b, u],
      ] as const) {
        const want = Math.max(0, along) + r;
        if (want > arm.maxCut && status === 'ok') status = 'squeezed';
        arm.cut = Math.max(arm.cut, Math.min(want, arm.maxCut));
      }
    }

    // Corner points of each arm's mouth.
    const mouths = arms.map((arm) => {
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
      let corner = false;
      if (Math.abs(cross) >= PARALLEL) {
        const t = ((B.x - A.x) * next.dy - (B.y - A.y) * next.dx) / cross;
        const u = ((B.x - A.x) * m.dy - (B.y - A.y) * m.dx) / cross;
        if (t < 0 && u < 0 && t > -90 && u > -90) {
          ka = -t * 0.55;
          kb = -u * 0.55;
          corner = true;
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
      fillets.push({ pts, corner, footpath: m.pathCcw && next.pathCw, deck: m.deck && next.deck });
    }
    // Arms that overlap can tie the outline in a knot. The hull of the same points is a sound surface:
    // anything it adds lies between arms that were already touching.
    if (!isSimple(ring)) {
      ring = hull(ring);
      if (status === 'ok') status = 'squeezed';
    }

    shapes.push({
      id: j.id,
      ring,
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
