// Before junctions are shaped: decide what kind of place each one is.
//
// A node where three ways meet is not always an intersection. A slip lane leaving a motorway, a road
// splitting into the two halves of a divided road and a lane count changing are all one stream of
// traffic carrying on: a "seam". At a seam nothing stops, the lines run through, and the arms are
// laid side by side across the road they came from instead of fanning out of a single point.
//
// A service lane meeting a street is not an intersection either: the street runs past it unbroken
// and the lane ends at the back of the footpath.
import type { Junction, TileModel } from '../model/types.ts';
import { type RoadParams, type Track, sampleAt } from './tracks.ts';

export interface ArmPlan {
  t: Track;
  end: 'a' | 'b';
  /** Unit vector pointing away from the junction along the arm, taken over a long baseline. */
  dx: number;
  dy: number;
  /** A lane that ends at the kerb of the roads it meets and takes no part in the junction. */
  minor: boolean;
  /** Arms that leave the junction the same way share a group. */
  group: number;
}

export interface JunctionPlan {
  junction: Junction;
  arms: ArmPlan[];
  /** How many ways traffic can leave by: three or more makes it a real intersection. */
  groups: number;
  seam: boolean;
}

const deg = (d: number): number => (d * Math.PI) / 180;

/** Which way traffic on a one-way arm is heading at the junction, or 0 for a two-way arm. */
function flow(a: ArmPlan): number {
  const sec = a.end === 'a' ? a.t.road.sections[0] : a.t.road.sections[a.t.road.sections.length - 1];
  if (sec.lanesF > 0 && sec.lanesB > 0) return 0;
  const leaving = a.end === 'a' ? sec.lanesB === 0 : sec.lanesF === 0;
  return leaving ? 1 : -1;
}

const nameOf = (a: ArmPlan): string | undefined => a.t.road.sections.find((s) => s.name)?.name;

export function planJunctions(model: TileModel, tracks: Map<string, Track>): Map<string, JunctionPlan> {
  const plans = new Map<string, JunctionPlan>();
  for (const j of model.junctions) {
    const arms: ArmPlan[] = j.arms.map((a) => {
      const t = tracks.get(a.road)!;
      const i = a.end === 'a' ? 0 : t.n - 1;
      const reach = Math.min(25, t.length / 2);
      const far = sampleAt(t, a.end === 'a' ? reach : t.length - reach);
      const d = Math.hypot(far.x - t.x[i], far.y - t.y[i]) || 1;
      return { t, end: a.end, dx: (far.x - t.x[i]) / d, dy: (far.y - t.y[i]) / d, minor: false, group: 0 };
    });
    if (arms.filter((a) => a.t.cls !== 'lane').length >= 2) for (const a of arms) a.minor = a.t.cls === 'lane';

    const main = arms.filter((a) => !a.minor).sort((a, b) => Math.atan2(a.dy, a.dx) - Math.atan2(b.dy, b.dx));
    // Neighbours around the junction join a group if they leave it the same way. The two halves of
    // a divided road count as leaving together however sharply the map has them part.
    const major = (a: ArmPlan): boolean => a.t.cls === 'motorway' || a.t.cls === 'ramp';
    const together = (a: ArmPlan, b: ArmPlan): boolean => {
      const cos = a.dx * b.dx + a.dy * b.dy;
      const [na, nb] = [nameOf(a), nameOf(b)];
      // Two streets with different names that part at a narrow angle are still a fork, not one road.
      if (cos > Math.cos(deg(40))) return na === nb || na === undefined || nb === undefined || (major(a) && major(b));
      return cos > Math.cos(deg(75)) && flow(a) * flow(b) < 0 && na !== undefined && na === nb;
    };
    let groups = main.length ? 1 : 0;
    for (let i = 1; i < main.length; i++) {
      if (!together(main[i - 1], main[i])) groups++;
      main[i].group = groups - 1;
    }
    if (groups > 1 && together(main[main.length - 1], main[0])) {
      // The last group wraps round into the first.
      for (const a of main) if (a.group === groups - 1) a.group = 0;
      groups--;
    }

    let seam = false;
    if (groups === 2) {
      const mean = (g: number) => {
        const of = main.filter((a) => a.group === g);
        const [x, y] = [of.reduce((s, a) => s + a.dx, 0), of.reduce((s, a) => s + a.dy, 0)];
        const d = Math.hypot(x, y) || 1;
        return [x / d, y / d];
      };
      const [p, q] = [mean(0), mean(1)];
      seam = p[0] * q[0] + p[1] * q[1] < Math.cos(deg(135));
    }
    plans.set(j.id, { junction: j, arms, groups, seam });
  }
  return plans;
}

const smoothstep = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * Where one road becomes several, the map has them all start at the centre of the road they came
 * from. This moves each to where its lanes really are: the leftmost against the left edge, the
 * rightmost against the right, easing back to the mapped line over a taper.
 */
export function alignSeams(plans: JunctionPlan[], p: RoadParams): void {
  /** Each track's displacement, as x and y per sample. */
  const shifts = new Map<Track, Float32Array>();
  for (const plan of plans) {
    if (!plan.seam) continue;
    const main = plan.arms.filter((a) => !a.minor);
    for (const g of [0, 1]) {
      const single = main.filter((a) => a.group === g);
      const many = main.filter((a) => a.group !== g);
      if (single.length !== 1 || many.length < 2) continue;
      const from = single[0];
      const width = (a: ArmPlan): number => {
        const i = a.end === 'a' ? 0 : a.t.n - 1;
        return a.t.wF[i] + a.t.wB[i];
      };
      // Looking along the road as it carries on: positive is to the left.
      const [ux, uy] = [-from.dx, -from.dy];
      many.sort((a, b) => ux * b.dy - uy * b.dx - (ux * a.dy - uy * a.dx));
      many.forEach((arm, k) => {
        const centre = k === 0 ? (width(from) - width(arm)) / 2 : k === many.length - 1 ? -(width(from) - width(arm)) / 2 : 0;
        if (Math.abs(centre) < 0.05) return;
        const t = arm.t;
        const shift = arm.end === 'a' ? centre : -centre;
        const major = t.cls === 'motorway' || t.cls === 'ramp';
        const taper = Math.min(Math.max(15, Math.abs(shift) * (major ? p.taperMotorway : p.taperStreet)), 120, t.length * 0.8);
        let by = shifts.get(t);
        if (!by) shifts.set(t, (by = new Float32Array(t.n * 2)));
        // Square across the road it came from at the start, so every arm still starts on that road's end
        // line; along its own normal by the end of the taper.
        const [fx, fy] = [-uy * centre, ux * centre];
        for (let i = 0; i < t.n; i++) {
          const d = arm.end === 'a' ? t.s[i] : t.length - t.s[i];
          const w = 1 - smoothstep(d / taper);
          if (w <= 0) continue;
          const [ox, oy] = [-t.ty[i] * shift, t.tx[i] * shift];
          const v = Math.min(1, w * 1.5);
          by[2 * i] += w * (fx * v + ox * (1 - v));
          by[2 * i + 1] += w * (fy * v + oy * (1 - v));
        }
      });
    }
  }
  taperSeams(plans, p);
  for (const [t, by] of shifts) {
    for (let i = 0; i < t.n; i++) {
      t.x[i] += by[2 * i];
      t.y[i] += by[2 * i + 1];
    }
    for (let i = 0; i < t.n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(t.n - 1, i + 1);
      const d = Math.hypot(t.x[b] - t.x[a], t.y[b] - t.y[a]) || 1;
      t.tx[i] = (t.x[b] - t.x[a]) / d;
      t.ty[i] = (t.y[b] - t.y[a]) / d;
    }
  }
}

/**
 * Where one road simply carries on as another of a different width, the map changes the lane count
 * at the node. Both ends ease to meet at the mean width over a taper centred on it, as a change of
 * width within one road does.
 */
function taperSeams(plans: JunctionPlan[], p: RoadParams): void {
  for (const plan of plans) {
    const main = plan.arms.filter((a) => !a.minor);
    if (!plan.seam || main.length !== 2) continue;
    const ends = main.map((arm) => {
      const i = arm.end === 'a' ? 0 : arm.t.n - 1;
      // Forward and back as traffic heads out of the junction along this arm.
      return arm.end === 'a' ? [arm.t.wF[i], arm.t.wB[i]] : [arm.t.wB[i], arm.t.wF[i]];
    });
    // Out along one arm is in along the other: its outward forward lanes meet the other's outward back ones.
    const target = [(ends[0][0] + ends[1][1]) / 2, (ends[0][1] + ends[1][0]) / 2];
    const goal = [target, [target[1], target[0]]];
    main.forEach((arm, k) => {
      const t = arm.t;
      const [dOut, dBack] = [goal[k][0] - ends[k][0], goal[k][1] - ends[k][1]];
      const change = Math.max(Math.abs(dOut), Math.abs(dBack)) * 2;
      if (change < 0.05) return;
      const major = t.cls === 'motorway' || t.cls === 'ramp';
      const len = Math.min(Math.max(6, change * (major ? p.taperMotorway : p.taperStreet)), t.length);
      for (let i = 0; i < t.n; i++) {
        const d = arm.end === 'a' ? t.s[i] : t.length - t.s[i];
        // Half the change at the node, none by half a taper out.
        const w = 1 - smoothstep(d / len + 0.5);
        if (w <= 0) continue;
        if (arm.end === 'a') {
          t.wF[i] += dOut * w * 2;
          t.wB[i] += dBack * w * 2;
        } else {
          t.wB[i] += dOut * w * 2;
          t.wF[i] += dBack * w * 2;
        }
      }
    });
  }
}
