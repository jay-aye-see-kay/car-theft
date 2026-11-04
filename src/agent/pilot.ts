import type { Route, RoadEdge, RoadGraph } from '../city/road-graph.ts';
import type { Input } from '../input.ts';
import { PathFollower, type Obstacle, type PathPoint } from './autopilot.ts';

// The game end of the autopilot (?debug `__game.pilot()`): takes the wheel
// (or the stick, on foot) through Input, as a player's hands would, so
// everything downstream (dizzy mush, flat tyres, crashes, cops) sees an
// ordinary player. Driving follows the road route on the left; walking and
// boats head straight there (walking follows the road too, past `WALK_DIRECT`).

/**
 * Walk this far inside the kerb, m: along the edge of the road, not the
 * footpath, which is narrow in places and runs into walls and trees (traffic
 * stops for people on foot).
 */
const ROADSIDE = 1;
/** Walking: less than a metre nearer in this long is stuck, s. */
const WALK_STALL = 3;
/** Driving this much nearer the centreline than the lane's middle, m. */
const CLEAR = 0.4;
/** Points along the route every this many m. */
const SPACING = 4;
/** On foot, beyond this follow the roads (walls are in the way), m. */
const WALK_DIRECT = 60;
/** Lost the route by this much: route again from here, this many times before giving up. */
const REROUTES = 6;

export interface PilotGoal {
  to: [number, number];
  /** 'road' (default for cars, and long walks) or 'direct'. */
  via?: 'road' | 'direct';
  /** Top speed, km/h (driving). */
  kmh?: number;
  /** How close counts as there, m. */
  arrive?: number;
  /** Don't brake for people or cars in the way. */
  careless?: boolean;
  /** Drive through the goal rather than stopping at it. */
  through?: boolean;
}

export interface PilotPose {
  mode: 'car' | 'foot' | 'boat';
  x: number;
  z: number;
  heading: number;
  speed: number;
}

export interface PilotView {
  status: 'off' | 'driving' | 'arrived' | 'stuck' | 'lost';
  mode: PilotPose['mode'] | null;
  /** Metres of route left, and its whole length. */
  left: number;
  length: number;
  reroutes: number;
  unsticks: number;
  /** Seconds since it was set. */
  time: number;
  /** Braking for something in the way. */
  waiting: boolean;
}

export class Pilot {
  private goal: PilotGoal | null = null;
  private follower: PathFollower | null = null;
  private mode: PilotPose['mode'] | null = null;
  private reroutes = 0;
  private unsticks = 0;
  private time = 0;
  /** Walking: route left at the last check, and how long since it last went down a metre. */
  private bestLeft = Infinity;
  private stalled = 0;
  /** Walking direct got stuck: go by road from now on. */
  private viaRoad = false;
  private status: PilotView['status'] = 'off';
  private readonly roads: RoadGraph | null;
  private readonly pose: () => PilotPose;
  private readonly cameraYaw: () => number;
  private readonly obstacles: (x: number, z: number) => Obstacle[];

  constructor(roads: RoadGraph | null, pose: () => PilotPose, cameraYaw: () => number, obstacles: (x: number, z: number) => Obstacle[] = () => []) {
    this.roads = roads;
    this.pose = pose;
    this.cameraYaw = cameraYaw;
    this.obstacles = obstacles;
  }

  /** Head somewhere, or null to let go of the controls. */
  set(goal: PilotGoal | null): PilotView {
    this.goal = goal;
    this.follower = null;
    this.reroutes = this.unsticks = 0;
    this.time = 0;
    this.bestLeft = Infinity;
    this.stalled = 0;
    this.viaRoad = false;
    this.status = goal ? 'driving' : 'off';
    if (goal) this.plan();
    return this.view();
  }

  get active(): boolean {
    return this.status === 'driving';
  }

  view(): PilotView {
    const f = this.follower;
    return {
      status: this.status,
      mode: this.mode,
      left: Math.round(f?.left ?? 0),
      length: Math.round(f?.length ?? 0),
      reroutes: this.reroutes,
      unsticks: this.unsticks + (f?.unsticks ?? 0),
      time: Math.round(this.time * 10) / 10,
      waiting: f?.waiting ?? false,
    };
  }

  /** Called from Input.update(): overwrite the controls for this frame. */
  control(input: Input, dt: number): void {
    if (!this.goal || this.status !== 'driving') return;
    this.time += dt;
    const p = this.pose();
    // Got in or out of something: the old route was for the other mode.
    if (p.mode !== this.mode) this.plan();
    const f = this.follower;
    if (!f) return;
    if (p.mode === 'foot') {
      const dir = f.walk(p);
      if (!dir) return this.finish('arrived', input);
      // Into a wall: straight there was a mistake, try the roads; by road too, give up.
      if (f.left < this.bestLeft - 1) [this.bestLeft, this.stalled] = [f.left, 0];
      else if ((this.stalled += dt) > WALK_STALL) {
        if (this.viaRoad || !this.roads) return this.finish('stuck', input);
        this.viaRoad = true;
        this.plan();
        return;
      }
      // Stick up walks away from the camera (main.ts): undo that turn.
      const cy = this.cameraYaw();
      input.moveY = Math.cos(cy) * dir.x + Math.sin(cy) * dir.z;
      input.moveX = -Math.sin(cy) * dir.x + Math.cos(cy) * dir.z;
      input.sprint = true;
      return;
    }
    Object.assign(input.drive, f.drive(p, dt, this.goal.careless || p.mode !== 'car' ? [] : this.obstacles(p.x, p.z)));
    // So the dizzy mush (which eases moveX into steer) and anything else reading the stick agree.
    input.moveX = input.drive.steer;
    if (f.status === 'lost') {
      if (this.reroutes++ >= REROUTES) return this.finish('lost', input);
      this.unsticks += f.unsticks;
      this.plan();
    } else if (f.status === 'arrived' || f.status === 'stuck') {
      // Arrived: keep braking until stopped, then let go.
      if (f.status === 'arrived' && f.stop && Math.abs(p.speed) > 0.5) return;
      this.finish(f.status, input);
    }
  }

  private finish(status: PilotView['status'], input: Input): void {
    this.status = status;
    Object.assign(input.drive, { throttle: 0, brake: 0, steer: 0, handbrake: false });
    input.moveX = input.moveY = 0;
  }

  private plan(): void {
    const goal = this.goal!;
    const p = this.pose();
    this.mode = p.mode;
    const to = { x: goal.to[0], z: goal.to[1] };
    const far = Math.hypot(to.x - p.x, to.z - p.z);
    const byRoad = p.mode === 'car' ? goal.via !== 'direct' : p.mode === 'foot' ? this.viaRoad || goal.via === 'road' || (goal.via !== 'direct' && far > WALK_DIRECT) : false;
    this.bestLeft = Infinity;
    this.stalled = 0;
    const path = byRoad && this.roads ? routePath(this.roads, { x: p.x, z: p.z }, to, p.mode === 'car', goal.through ? 4 : 0) : [{ x: p.x, z: p.z }, to];
    const kmh = goal.kmh ?? (p.mode === 'boat' ? 40 : 50);
    this.follower = new PathFollower(path, kmh / 3.6, goal.arrive ?? (p.mode === 'foot' ? 2 : 6), !goal.through);
  }
}

/**
 * From here to there by road, on the left (alongRoute), or straight if
 * there's no route. The goal is the last point unless it's within `reach` of
 * the lane already: a sideways jog onto it at the end would read as a bend
 * and slow a drive-through goal to a crawl.
 */
export function routePath(roads: RoadGraph, from: PathPoint, to: PathPoint, driving: boolean, reach = 0): PathPoint[] {
  const r = roads.route(from, to);
  if (!r || r.points.length < 2) return [from, to];
  const lane = alongRoute(roads, r, driving);
  const end = lane[lane.length - 1];
  return Math.hypot(end.x - to.x, end.z - to.z) <= reach ? [from, ...lane] : [from, ...lane, to];
}

/**
 * The route as a line to follow: driving, in the lane furthest from the kerb
 * (clear of cars parked half on it and people on the footpath); walking, at
 * the left edge of the road.
 */
export function alongRoute(roads: RoadGraph, r: Route, driving: boolean): PathPoint[] {
  const out: PathPoint[] = [];
  const at = (e: RoadEdge, dir: 1 | -1, s: number) => {
    const lanes = Math.max(1, dir > 0 ? e.fw : e.bw);
    const w = e.width / Math.max(1, e.fw + e.bw);
    // Left of the way we're going, from the centreline (RoadGraph.lane's sum, for the inside lane).
    // A little towards the centreline: cars parked half up on the kerb stick into the lane.
    const left = driving ? e.width / 2 - (lanes - 0.5) * w - CLEAR : e.width / 2 - ROADSIDE;
    const p = roads.pointAt(e, dir > 0 ? s : e.length - s);
    const h = dir > 0 ? p.heading : p.heading + Math.PI;
    out.push({ x: p.x - Math.sin(h) * left, z: p.z - Math.cos(h) * left });
  };
  r.legs.forEach(({ edge: e, dir }, k) => {
    const L = e.length;
    const s0 = k === 0 ? (dir > 0 ? r.from.s : L - r.from.s) : 0;
    const s1 = k === r.legs.length - 1 ? (dir > 0 ? r.to.s : L - r.to.s) : L;
    for (let s = s0; s < s1; s += SPACING) at(e, dir, s);
    at(e, dir, s1);
  });
  return out;
}
