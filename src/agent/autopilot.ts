import type { DriveControls } from '../car.ts';

// A mediocre-but-steady driver for agents and playtest bots (`?debug`
// `__game.pilot()`, `npm run play`): follows a polyline (a road route, kept
// left) by pure pursuit, slows for the bends it can see coming and for the
// end, and backs out when it's stuck against something. Pure: no three.js,
// no Rapier, so `scripts/agent/pilot-sim.ts` runs it on the real car in Node.
//
// It doesn't see traffic or pedestrians: it drives into them the way a
// careless player would, and the game's reactions (heat, crashes) are part of
// what a playtest reads.

export interface PilotPose {
  x: number;
  z: number;
  /** Radians; forward is (cos h, -sin h) in x, z. */
  heading: number;
  /** Forward speed, m/s (negative reversing). */
  speed: number;
}

export interface PathPoint {
  x: number;
  z: number;
}

export const AUTOPILOT = {
  /** Sideways grip it plans corners with, m/s² (the car holds ~9 before sliding). */
  lateral: 5.5,
  /** Braking it plans stops with, m/s². */
  decel: 6,
  /** Lookahead: base m plus seconds of travel, clamped. */
  lookBase: 4,
  lookTime: 0.55,
  lookMax: 28,
  /** Throttle/brake gain per m/s of speed error. */
  pedal: 0.35,
  /** Stopped this long with the throttle on: stuck, back out, s. */
  stuckAfter: 1.5,
  /** And back out for this long, s. */
  reverseFor: 1.2,
  /** Brakes for people and cars in its path (a corridor this wide each side, m), unless careless. */
  corridor: 1.0,
  /** Stopped for something in the way this long: go anyway (it's a parked car, or they'll move), s. */
  patience: 4,
  wheelbase: 2.465,
  /** Matches car.ts TUNING (the steering lock, eased with speed); refreshed from it by the page. */
  maxSteer: 0.6,
  minSteer: 0.12,
  topSpeed: 50,
};

/** Something to brake for: a person or a car, and how far it reaches round its middle, m. */
export interface Obstacle {
  x: number;
  z: number;
  r: number;
}

export type PilotStatus = 'driving' | 'arrived' | 'stuck' | 'lost';

/** Follows one polyline. Make a new one for a new route. */
export class PathFollower {
  readonly path: readonly PathPoint[];
  /** Cumulative distance to each point, m. */
  private readonly along: number[];
  /** Index of the segment we're on. */
  private seg = 0;
  private stoppedFor = 0;
  private reversingFor = 0;
  private waitedFor = 0;
  /** What it's braking for now, if anything (for the view). */
  waiting = false;
  /** How many times it's backed out. */
  unsticks = 0;
  status: PilotStatus = 'driving';
  /** Distance from the path, m (the caller reroutes past a few metres). */
  offPath = 0;
  /** Metres of path left. */
  left = 0;

  /** m/s, and how close counts as there, m. */
  readonly maxSpeed: number;
  readonly arrive: number;
  /** Stop at the end (else drive through it: speed cameras, paper boxes). */
  readonly stop: boolean;

  constructor(path: readonly PathPoint[], maxSpeed = 22, arrive = 6, stop = true) {
    this.maxSpeed = maxSpeed;
    this.arrive = arrive;
    this.stop = stop;
    this.path = path.length > 1 ? path : [...path, ...path];
    this.along = [0];
    for (let i = 1; i < this.path.length; i++) {
      const a = this.path[i - 1];
      const b = this.path[i];
      this.along.push(this.along[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
    }
    this.left = this.along[this.along.length - 1];
  }

  get length(): number {
    return this.along[this.along.length - 1];
  }

  /** The controls for this tick. */
  drive(p: PilotPose, dt: number, obstacles: readonly Obstacle[] = []): DriveControls {
    const end = this.path[this.path.length - 1];
    const s = this.project(p);
    this.left = this.length - s;
    const toEnd = Math.hypot(end.x - p.x, end.z - p.z);
    if (toEnd < this.arrive || (this.left < this.arrive && toEnd < this.arrive * 2)) {
      this.status = 'arrived';
      if (!this.stop) return { throttle: 0.5, brake: 0, steer: 0, handbrake: false };
      return { throttle: 0, brake: Math.abs(p.speed) > 0.5 ? 1 : 0, steer: 0, handbrake: Math.abs(p.speed) < 3 };
    }

    // Backing out: straight back with the wheel the other way, then try again.
    if (this.reversingFor > 0) {
      this.reversingFor -= dt;
      const t = this.pointAt(s + 6);
      return { throttle: 0, brake: 1, steer: Math.sign(this.angleTo(p, t)) || 1, handbrake: false };
    }

    const speed = Math.max(0, p.speed);
    const look = Math.min(AUTOPILOT.lookMax, AUTOPILOT.lookBase + AUTOPILOT.lookTime * speed);
    const t = this.pointAt(s + look);
    const alpha = this.angleTo(p, t); // + is to the left
    const d = Math.max(1, Math.hypot(t.x - p.x, t.z - p.z));
    const want = Math.atan((2 * Math.sin(alpha) * AUTOPILOT.wheelbase) / d); // + turns left
    const f = Math.min(speed / AUTOPILOT.topSpeed, 1);
    const lock = AUTOPILOT.maxSteer + (AUTOPILOT.minSteer - AUTOPILOT.maxSteer) * Math.sqrt(f);
    const steer = clamp(-want / lock, -1, 1); // + steers right

    // How fast: the tightest bend in braking distance, the stop at the end, and pointing the wrong way.
    let target = this.maxSpeed;
    const horizon = 10 + (speed * speed) / (2 * AUTOPILOT.decel) + 10;
    for (let k = 5; k <= horizon; k += 5) {
      const bend = this.turnAt(s + k);
      if (bend < 1e-3) continue;
      const v = Math.sqrt(AUTOPILOT.lateral / bend);
      // Allowed now: that speed plus what braking between here and there takes off.
      target = Math.min(target, Math.sqrt(v * v + 2 * AUTOPILOT.decel * Math.max(0, k - 5)));
    }
    if (this.stop) target = Math.min(target, Math.sqrt(2 * AUTOPILOT.decel * Math.max(0, this.left - this.arrive * 0.5)) + 1);
    if (Math.abs(alpha) > 1.2) target = Math.min(target, 4);
    // Someone or something in the way: stop short of it, for a while.
    const block = this.blocked(p, obstacles, speed);
    this.waiting = block !== null && this.waitedFor < AUTOPILOT.patience;
    if (this.waiting) target = Math.min(target, Math.sqrt(2 * AUTOPILOT.decel * Math.max(0, block! - 3)));
    if (this.waiting && speed < 0.5) this.waitedFor += dt;
    else if (block === null) this.waitedFor = 0;
    const err = target - speed;
    const throttle = clamp(err * AUTOPILOT.pedal, 0, 1);
    const brake = clamp(-err * AUTOPILOT.pedal, 0, 1) * (speed > 1 ? 1 : 0);

    // Stuck: throttle on, going nowhere.
    if (throttle > 0.3 && Math.abs(p.speed) < 0.8 && !this.waiting) this.stoppedFor += dt;
    else this.stoppedFor = 0;
    if (this.stoppedFor > AUTOPILOT.stuckAfter) {
      this.stoppedFor = 0;
      this.reversingFor = AUTOPILOT.reverseFor;
      this.unsticks++;
      this.status = this.unsticks > 6 ? 'stuck' : 'driving';
    }
    return { throttle, brake, steer, handbrake: false };
  }

  /** How far ahead the nearest obstacle in our corridor is, m, or null. */
  private blocked(p: PilotPose, obstacles: readonly Obstacle[], speed: number): number | null {
    const reach = 8 + (speed * speed) / (2 * AUTOPILOT.decel);
    const c = Math.cos(p.heading);
    const sn = Math.sin(p.heading);
    let nearest: number | null = null;
    for (const o of obstacles) {
      const dx = o.x - p.x;
      const dz = o.z - p.z;
      const ahead = dx * c - dz * sn;
      // Local +z, the right-hand side, is (sin h, cos h).
      const side = dx * sn + dz * c;
      if (ahead > 1.5 && ahead < reach && Math.abs(side) < AUTOPILOT.corridor + o.r && (nearest === null || ahead < nearest)) nearest = ahead - o.r;
    }
    return nearest;
  }

  /** Walking: the world direction to head in (unit x, z), or null when there. */
  walk(p: { x: number; z: number }): { x: number; z: number } | null {
    const s = this.project({ ...p, heading: 0, speed: 0 });
    this.left = this.length - s;
    const end = this.path[this.path.length - 1];
    if (Math.hypot(end.x - p.x, end.z - p.z) < Math.min(this.arrive, 1.5)) {
      this.status = 'arrived';
      return null;
    }
    const t = this.pointAt(s + 3);
    const dx = t.x - p.x;
    const dz = t.z - p.z;
    const d = Math.hypot(dx, dz) || 1;
    return { x: dx / d, z: dz / d };
  }

  /** Distance along the path of the nearest point to p, searching forward from where we were. */
  private project(p: PilotPose): number {
    let best = Infinity;
    let bestS = this.along[this.seg];
    let bestSeg = this.seg;
    // Mostly forward, a little back (an overshoot), not the whole path (a route can pass itself).
    const from = Math.max(0, this.seg - 2);
    const to = Math.min(this.path.length - 1, this.seg + 25);
    for (let i = from; i < to; i++) {
      const a = this.path[i];
      const b = this.path[i + 1];
      const ex = b.x - a.x;
      const ez = b.z - a.z;
      const len2 = ex * ex + ez * ez || 1;
      const u = clamp(((p.x - a.x) * ex + (p.z - a.z) * ez) / len2, 0, 1);
      const d = Math.hypot(a.x + ex * u - p.x, a.z + ez * u - p.z);
      if (d < best) {
        best = d;
        bestS = this.along[i] + u * Math.sqrt(len2);
        bestSeg = i;
      }
    }
    this.seg = bestSeg;
    this.offPath = best;
    if (best > 25 && this.status === 'driving') this.status = 'lost';
    return bestS;
  }

  pointAt(s: number): PathPoint {
    const L = this.length;
    if (s >= L) return this.path[this.path.length - 1];
    if (s <= 0) return this.path[0];
    let i = this.seg;
    while (i > 0 && this.along[i] > s) i--;
    while (i < this.path.length - 2 && this.along[i + 1] < s) i++;
    const a = this.path[i];
    const b = this.path[i + 1];
    const seg = this.along[i + 1] - this.along[i] || 1;
    const u = (s - this.along[i]) / seg;
    return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u };
  }

  /** How sharply the path bends at s: radians turned per metre over ±5 m. */
  private turnAt(s: number): number {
    if (s > this.length) return 0;
    const a = this.pointAt(s - 5);
    const b = this.pointAt(s);
    const c = this.pointAt(s + 5);
    const h1 = Math.atan2(b.z - a.z, b.x - a.x);
    const h2 = Math.atan2(c.z - b.z, c.x - b.x);
    const span = Math.hypot(b.x - a.x, b.z - a.z) + Math.hypot(c.x - b.x, c.z - b.z);
    return span > 1 ? Math.abs(wrap(h2 - h1)) / (span / 2) : 0;
  }

  /** Angle from our heading to point t, + to the left. */
  private angleTo(p: PilotPose, t: PathPoint): number {
    const bearing = Math.atan2(-(t.z - p.z), t.x - p.x); // same sense as heading
    return wrap(bearing - p.heading);
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
