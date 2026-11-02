import type { RoadGraph } from '../city/road-graph.ts';

// Where you're headed and the way there: your waypoint (set on the full map)
// if you have one, else the current mission's goal. The route is a drive
// along the road graph (one-ways respected), worked out again when the
// destination changes or you stray off it, and trimmed behind you as you go.

export interface Destination {
  x: number;
  z: number;
  kind: 'waypoint' | 'goal';
  label: string;
}

type Pt = { x: number; z: number };

/** Off the route by more than this and it's worked out again, m. */
const OFF_ROUTE = 25;
/** Not more often than this, game s. */
const REROUTE_EVERY = 1;
/** A waypoint this close is reached and cleared, m. */
const ARRIVED = 20;
/** The start and end may be this far from a road (in a park, on a pier). */
const SNAP = 250;

export class Navigator {
  /** Set on the full map; null for none. */
  waypoint: Pt | null = null;
  /** What's left of the route, from about where you are; null if there's no destination. */
  route: Pt[] | null = null;
  /** Metres left along it (straight-line if there's no road route). */
  left = 0;
  private readonly roads: RoadGraph | null;
  private key = '';
  private routedAt = -Infinity;

  constructor(roads: RoadGraph | null) {
    this.roads = roads;
  }

  destination(goal: { x: number; z: number; label: string } | null): Destination | null {
    if (this.waypoint) return { ...this.waypoint, kind: 'waypoint', label: 'Waypoint' };
    return goal ? { x: goal.x, z: goal.z, kind: 'goal', label: goal.label } : null;
  }

  /** Puts the waypoint on the nearest road to (x, z) if there's one close, so the blip sits where the route ends. */
  setWaypoint(x: number, z: number): void {
    const snap = this.roads?.nearest(x, z, { within: 40 });
    this.waypoint = snap ? { x: snap.x, z: snap.z } : { x, z };
  }

  /** Per frame, from where you are, at game time `now`; `byRoad` false (in a boat): straight there. */
  update(from: Pt, goal: { x: number; z: number; label: string } | null, now: number, byRoad = true): void {
    if (this.waypoint && Math.hypot(this.waypoint.x - from.x, this.waypoint.z - from.z) < ARRIVED) this.waypoint = null;
    const dest = this.destination(goal);
    if (!dest) {
      this.route = null;
      this.left = 0;
      this.key = '';
      return;
    }
    const key = `${dest.x.toFixed(1)},${dest.z.toFixed(1)},${byRoad}`;
    if (now < this.routedAt) this.routedAt = -Infinity; // the clock was reset
    const fresh = key !== this.key;
    if (fresh || (now - this.routedAt >= REROUTE_EVERY && this.offBy(from) > OFF_ROUTE)) {
      this.key = key;
      this.routedAt = now;
      const r = byRoad ? this.roads?.route(from, dest, { within: SNAP }) : null;
      this.route = r ? [from, ...r.points, dest] : [from, dest];
    }
    this.trim(from);
  }

  /** Drops the route behind you: it starts from the nearest point on it to where you are. */
  private trim(from: Pt): void {
    const r = this.route;
    if (!r || r.length < 2) return;
    const { seg, p } = closest(r, from);
    r.splice(0, seg + 1, from, p);
    let left = 0;
    for (let k = 1; k < r.length; k++) left += Math.hypot(r[k].x - r[k - 1].x, r[k].z - r[k - 1].z);
    this.left = left;
  }

  private offBy(from: Pt): number {
    if (!this.route || this.route.length < 2) return Infinity;
    const { p } = closest(this.route, from);
    return Math.hypot(p.x - from.x, p.z - from.z);
  }

  reset(): void {
    this.waypoint = null;
    this.route = null;
    this.left = 0;
    this.key = '';
    this.routedAt = -Infinity;
  }
}

/** The nearest point on a polyline (skipping its first segment, the stub from you), and which segment it's on. */
function closest(r: readonly Pt[], q: Pt): { seg: number; p: Pt } {
  let best = Infinity;
  let seg = Math.min(1, r.length - 2);
  let p = r[r.length - 1];
  for (let k = r.length > 2 ? 1 : 0; k + 1 < r.length; k++) {
    const a = r[k];
    const b = r[k + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.z - a.z) * dz) / len2)) : 0;
    const x = a.x + dx * t;
    const z = a.z + dz * t;
    const d = (x - q.x) ** 2 + (z - q.z) ** 2;
    if (d < best) {
      best = d;
      seg = k;
      p = { x, z };
    }
  }
  return { seg, p };
}
