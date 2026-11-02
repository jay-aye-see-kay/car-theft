import * as THREE from 'three';
import { TUNING, type Car, type DriveControls } from './car.ts';
import { COROLLA } from './corolla.ts';
import type { Dir, RoadEdge, RoadGraph } from './city/road-graph.ts';
import { rng } from './peds.ts';
import { knob, mechanic } from './tweaks.ts';

// The town's own cars (#29): traffic driving the road graph, and more cars
// parked at the kerb, so there's always another one to grab. Both come from
// fixed pools of ordinary cars (src/car.ts: you can ram them, push them,
// drive them), put out of view near the player and taken away again once
// they're far off and out of sight. Get into one that's driving and its
// driver is turfed out onto the road, and none too pleased about it.
//
// Traffic keeps to the left, in the outside lane of a multi-lane road, picks
// a way at each junction (mostly straight on), slows for corners, keeps its
// distance from whatever's ahead (other cars, you on foot) and pulls out
// round cars stopped in its lane. No traffic lights: it obeys junctions
// loosely, which is to say not at all, but it does brake.
//
// Each client runs its own, like the pedestrians. The pools are a fixed size,
// so in a room every car has the same index everywhere: someone driving one
// takes over that car on everyone's screen, wherever it was (src/net/remotes.ts).

/** Cars in each pool: the most the knobs go up to. */
export const TRAFFIC_POOL = 24;
export const PARKED_POOL = 32;
/** Police cars (src/cops/): they drive about like traffic until the cops hold one for a chase. */
export const PATROL_POOL = 6;

export const TRAFFIC = mechanic('traffic', 'Traffic', true, {
  count: knob(12, 'How many', 0, TRAFFIC_POOL, 1),
  speed: knob(11, 'Cruising speed (main roads)', 3, 25, 0.5, 'm/s'),
  spawnRadius: knob(170, 'Appear within', 60, 250, 10, 'm'),
  gap: knob(5, 'Gap to the car ahead, stopped', 2, 20, 0.5, 'm'),
});

export const PARKED = mechanic('parked', 'Parked cars', true, {
  count: knob(20, 'How many (plus the fixed ones)', 0, PARKED_POOL, 1),
  spawnRadius: knob(150, 'Within', 40, 250, 10, 'm'),
});

/** Never appear closer than this, m (and only out of view inside VIEW_FAR). */
const MIN_SPAWN = { traffic: 70, parked: 35 };
const VIEW_HALF_ANGLE = (65 * Math.PI) / 180;
const VIEW_FAR = 160;
/** Taken away past this many times the spawn radius, once out of view (or past FORGET regardless), m. */
const DESPAWN = 1.35;
const FORGET = 420;
/** Kerbside spots every this many metres along a street. */
const SPOT_EVERY = 8;
/** Clear of junctions by this much, m. */
const SPOT_CLEAR = 9;
/** Gap from the kerb to the car's side, m. */
const KERB_GAP = 0.3;
/**
 * Half up on the kerb: the car's centre this far past the kerb, onto the
 * footpath, m. Where the lane by the kerb is one traffic drives in (one lane
 * that way, or the right-hand side of a one-way street), a car parked in the
 * road would block it; up here it leaves the lane clear (and the footpath
 * walkers keep further out, src/peds.ts).
 */
const ON_KERB = 0.5;
const MAX_GRADE = 0.2;
/** Chassis centre above the ground at rest, m (as in tools/citygen/parking.ts). */
const RIDE_HEIGHT = 0.68;
/** Streets cars park on and traffic prefers. */
const STREETS = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street']);
/** Speed on each class of road, as a share of TRAFFIC.speed. */
const CLASS_SPEED: Partial<Record<string, number>> = { motorway: 1.6, motorway_link: 1.1, trunk: 1.3, trunk_link: 1, residential: 0.75, living_street: 0.45, service: 0.5, unclassified: 0.75 };
/** Moving cars look this far ahead for something in the way, m. */
const SCAN = 40;
/** Pull out this far to pass a car stopped in the lane, m. */
const PASS_SHIFT = 2.3;
/** Wanting to go but not getting anywhere for this long: give up (left where it is, taken away later), s. */
const GIVE_UP = 8;

/** Police cars are white (with a blue band and a light bar: src/car-fleet.ts). */
const POLICE_PAINT = 0xf4f4f0;
/** Period colours for the town's cars. */
const PAINTS = [0xe9e9e4, 0x9a9da1, 0x1b1b1d, 0x2b4f7e, 0x8c1d1d, 0x5d7a4a, 0xc9c2b4, 0x3a6ea5, 0xd8c25a, 0x6e1a24, 0x2f6d6a, 0xb7b9bb, 0x1d2c55, 0xa9adb3, 0x7b2e2a, 0xc8b48a];

/** `held`: the cops have it (src/cops/cops.ts drives it; it's left alone here). */
type Kind = 'idle' | 'parked' | 'driving' | 'loose' | 'held';
type Pool = 'traffic' | 'parked' | 'patrol';

interface Leg {
  edge: RoadEdge;
  dir: Dir;
  lane: number;
}

interface TownCar {
  car: Car;
  pool: Pool;
  kind: Kind;
  /** Where it's going: the leg it's on, then the next couple. */
  legs: Leg[];
  /** How far along the first leg, in its direction, m. */
  s: number;
  /** Pulled out towards the middle of the road to pass something, m. */
  shift: number;
  /** Wanting to go and not moving, s. */
  stuck: number;
  /** Waiting behind something stopped in the lane, s: after a bit it pulls out anyway. */
  waited: number;
  /** Cruising speed for this one (a little different for each), share. */
  pace: number;
  controls: DriveControls;
  /** What stopped it last (?debug). */
  blocked: string;
}

interface Spot {
  x: number;
  y: number;
  z: number;
  heading: number;
  pitch: number;
  /** Half up on the kerb (so it must be clear of buildings and street furniture). */
  kerb: boolean;
}

export interface TownWorld {
  roads: RoadGraph;
  /** Ground height, NaN where it isn't loaded. */
  heightAt(x: number, z: number): number;
  /** The ground here has collision. */
  hasGround(x: number, z: number): boolean;
  /** Something solid (a wall, a pole) where a car would stand here, facing `heading`? */
  blocked?(x: number, y: number, z: number, heading: number): boolean;
}

/** What the town's drivers keep clear of: every car, and you on foot. */
export interface Obstacles {
  cars: readonly Car[];
  /** Cars not in the world (idle, frozen): ignored. */
  absent: (car: Car) => boolean;
  walker: { x: number; z: number } | null;
}

const _fwd = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Town {
  readonly list: TownCar[];
  private readonly byCar = new Map<Car, TownCar>();
  private readonly w: TownWorld;
  private readonly spots: Spot[] = [];
  private near: Spot[] = [];
  private nearAt = { x: Infinity, z: Infinity, r: 0 };
  private rand = rng(7);
  /** Police cars to keep driving about (set by the cops each frame; -1 when they're off, and all go). */
  patrols = -1;
  /** ?debug counts. */
  stats = { spawned: { traffic: 0, parked: 0 }, removed: 0, carjacked: 0, gaveUp: 0, why: [] as string[] };

  /** `cars`: TRAFFIC_POOL for traffic, then PARKED_POOL to park, then PATROL_POOL police cars. */
  constructor(w: TownWorld, cars: readonly Car[]) {
    this.w = w;
    this.list = cars.map((car, i) => ({
      car, pool: i < TRAFFIC_POOL ? 'traffic' : i < TRAFFIC_POOL + PARKED_POOL ? 'parked' : 'patrol', kind: 'idle', legs: [], s: 0, shift: 0, stuck: 0, waited: 0, pace: 1,
      controls: { throttle: 0, brake: 0, steer: 0, handbrake: false }, blocked: '',
    }));
    for (const t of this.list) this.byCar.set(t.car, t);
    this.findSpots();
  }

  /** Every car taken away and the dice back to `seed` (?debug reset, so smoke areas repeat). */
  reset(seed = 7): void {
    this.rand = rng(seed);
    for (const t of this.list) this.remove(t);
    this.stats = { spawned: { traffic: 0, parked: 0 }, removed: 0, carjacked: 0, gaveUp: 0, why: [] as string[] };
    this.nearAt = { x: Infinity, z: Infinity, r: 0 };
  }

  /** Not in the world right now: no physics, not drawn. */
  idle(car: Car): boolean {
    return this.byCar.get(car)?.kind === 'idle';
  }

  /** Is this one of the town's cars? */
  owns(car: Car): boolean {
    return this.byCar.has(car);
  }

  /** Controls for a town car with nobody in it this tick; null means brakes on. */
  controlsFor(car: Car): DriveControls | null {
    const t = this.byCar.get(car);
    return t?.kind === 'driving' ? t.controls : null;
  }

  /** Is it driving itself? */
  driving(car: Car): boolean {
    return this.byCar.get(car)?.kind === 'driving';
  }

  /** One of the police cars? */
  isPatrol(car: Car): boolean {
    return this.byCar.get(car)?.pool === 'patrol';
  }

  /** The police cars out and driving about (not held for a chase). */
  patrolling(): Car[] {
    return this.list.filter((t) => t.pool === 'patrol' && t.kind === 'driving').map((t) => t.car);
  }

  /** The cops take this one over (from patrolling, or just put out): it's theirs to drive. */
  hold(car: Car): void {
    const t = this.byCar.get(car);
    if (t && t.kind !== 'idle') t.kind = 'held';
  }

  /**
   * Back to driving about from wherever it is (a chase over): into the
   * nearest lane going the way it faces, or left be if it's off the roads.
   */
  release(car: Car): void {
    const t = this.byCar.get(car);
    if (!t || t.kind !== 'held') return;
    const p = car.body.translation();
    const f = _fwd.set(1, 0, 0).applyQuaternion(rotation(car));
    const heading = Math.atan2(-f.z, f.x);
    const n = this.w.roads.nearest(p.x, p.z, { within: 12, main: true });
    if (!n || n.edge.restricted || car.isUpsideDown()) {
      t.kind = 'loose';
      return;
    }
    const along = Math.cos(heading - this.w.roads.pointAt(n.edge, n.s).heading) > 0;
    let dir: Dir = along ? 1 : -1;
    if ((dir > 0 ? n.edge.fw : n.edge.bw) === 0) dir = (-dir) as Dir;
    t.kind = 'driving';
    t.legs = [{ edge: n.edge, dir, lane: outerLane(dir > 0 ? n.edge.fw : n.edge.bw) }];
    t.s = dir > 0 ? n.s : n.edge.length - n.s;
    t.shift = t.stuck = t.waited = 0;
    this.plan(t);
  }

  /** ?debug: a police car on the lane nearest (x, z), facing about `heading`, held for the cops. */
  patrolAt(x: number, z: number, heading: number): Car | null {
    const t = this.free('patrol');
    const n = this.w.roads.nearest(x, z, { within: 40, open: false });
    if (!t || !n) return null;
    const along = Math.cos(heading - this.w.roads.pointAt(n.edge, n.s).heading) > 0;
    let dir: Dir = along ? 1 : -1;
    if ((dir > 0 ? n.edge.fw : n.edge.bw) === 0) dir = (-dir) as Dir;
    const pose = this.w.roads.lane(n.edge, dir, outerLane(dir > 0 ? n.edge.fw : n.edge.bw), dir > 0 ? n.s : n.edge.length - n.s);
    const ground = this.w.heightAt(pose.x, pose.z);
    if (Number.isNaN(ground)) return null;
    t.kind = 'held';
    t.legs = [];
    t.car.paint.setHex(POLICE_PAINT);
    t.car.place(new THREE.Vector3(pose.x, ground + RIDE_HEIGHT + 0.05, pose.z), pose.heading);
    return t.car;
  }

  /** Taken away (a chase car the cops are done with, out of sight). */
  dismiss(car: Car): void {
    const t = this.byCar.get(car);
    if (t) this.remove(t);
  }

  /**
   * A police car put out on a lane between `min` and `max` from the focus,
   * out of view, already held for the cops (they'll drive it). Null if
   * there's none free or nowhere suitable this time.
   */
  spawnPatrol(focus: { x: number; z: number }, yaw: number, obstacles: Obstacles, min: number, max: number): Car | null {
    const t = this.spawnOn('patrol', focus, yaw, obstacles, min, max);
    if (!t) return null;
    t.kind = 'held';
    return t.car;
  }

  /**
   * Someone's got in (you, or someone in the room): it's theirs now, and
   * stays where they leave it until it's out of sight. Returns where its
   * driver was, if it had one (they get out on the road side).
   */
  take(car: Car): { x: number; z: number; heading: number } | null {
    const t = this.byCar.get(car);
    if (!t || t.kind === 'idle') return null;
    const had = t.kind === 'driving';
    t.kind = 'loose';
    if (!had) return null;
    this.stats.carjacked++;
    const p = car.body.translation();
    const f = _fwd.set(1, 0, 0).applyQuaternion(rotation(car));
    const heading = Math.atan2(-f.z, f.x);
    // The driver's door is on the right (local +z), and they step out past it.
    return { x: p.x + Math.sin(heading) * 1.9, z: p.z + Math.cos(heading) * 1.9, heading: heading - Math.PI / 2 };
  }

  /**
   * Once a frame, before the physics: take far cars away, put new ones out,
   * and work out what every driver does. `focus` is the player, `yaw` where
   * the camera looks (atan2(z, x)), `claimed` whether someone's in a car.
   */
  step(dt: number, focus: { x: number; z: number }, yaw: number, obstacles: Obstacles, claimed: (car: Car) => boolean): void {
    for (const t of this.list) {
      if (t.kind === 'idle' || t.kind === 'held') continue;
      if (claimed(t.car)) {
        t.kind = 'loose';
        continue;
      }
      const p = t.car.body.translation();
      const d = Math.hypot(p.x - focus.x, p.z - focus.z);
      const radius = t.pool === 'parked' ? PARKED.spawnRadius : TRAFFIC.spawnRadius;
      const off = (t.pool === 'traffic' ? !TRAFFIC.on : t.pool === 'parked' ? !PARKED.on : this.patrols < 0) && t.kind !== 'loose';
      if (off || d > FORGET || (d > radius * DESPAWN && !inView(p.x - focus.x, p.z - focus.z, yaw))) this.remove(t);
    }
    this.trim('traffic', TRAFFIC.on ? TRAFFIC.count : 0, focus, yaw);
    this.trim('parked', PARKED.on ? PARKED.count : 0, focus, yaw);
    this.trim('patrol', Math.max(0, this.patrols), focus, yaw);
    if (TRAFFIC.on) this.spawnTraffic('traffic', TRAFFIC.count, focus, yaw, obstacles);
    if (this.patrols > 0) this.spawnTraffic('patrol', this.patrols, focus, yaw, obstacles);
    if (PARKED.on) this.spawnParked(focus, yaw, obstacles);
    for (const t of this.list) if (t.kind === 'driving') this.drive(t, dt, obstacles);
  }

  /** For ?debug. */
  debug() {
    return this.list.filter((t) => t.kind !== 'idle').map((t) => {
      const p = t.car.body.translation();
      const leg = t.legs[0];
      const f = _fwd.set(1, 0, 0).applyQuaternion(rotation(t.car));
      const ahead = leg ? this.target(t, 25) : null;
      return {
        index: this.list.indexOf(t), pool: t.pool, kind: t.kind, pos: [p.x, p.y, p.z], heading: Math.atan2(-f.z, f.x), speed: t.car.forwardSpeed(),
        upright: !t.car.isUpsideDown(), edge: leg?.edge.index ?? -1, street: leg?.edge.name ?? '', dir: leg?.dir ?? 0, s: t.s,
        left: leg ? leg.edge.length - t.s : 0, blocked: t.blocked, shift: t.shift,
        /** From the centreline of the road it's on, and that road's half-width, m. */
        offRoad: leg ? this.w.roads.snapTo(leg.edge, p.x, p.z).dist : -1, halfWidth: leg ? leg.edge.width / 2 : 0,
        /** Past the edge of the nearest carriageway (any road, so cutting a corner counts as on the road), m. */
        pastKerb: (() => {
          const n = this.w.roads.nearest(p.x, p.z, { within: 60, open: false });
          return n ? n.dist - n.edge.width / 2 : 60;
        })(),
        /** Its lane 25 m on. */
        ahead: ahead && [ahead.x, ahead.z],
      };
    });
  }

  // --- the pools ---------------------------------------------------------

  private remove(t: TownCar): void {
    if (t.kind === 'idle') return;
    t.kind = 'idle';
    t.legs = [];
    this.stats.removed++;
  }

  /** Over the count (it went down): the furthest out of view go first. */
  private trim(pool: Pool, count: number, focus: { x: number; z: number }, yaw: number): void {
    const live = this.list.filter((t) => t.pool === pool && t.kind !== 'idle' && t.kind !== 'loose' && t.kind !== 'held');
    while (live.length > count) {
      let worst = -1;
      let worstD = -1;
      for (const [i, t] of live.entries()) {
        const p = t.car.body.translation();
        const d = Math.hypot(p.x - focus.x, p.z - focus.z) + (inView(p.x - focus.x, p.z - focus.z, yaw) ? 0 : 1000);
        if (d > worstD) {
          worst = i;
          worstD = d;
        }
      }
      // Police cars a chase just let go drive off: only out of sight are they taken away.
      if (pool === 'patrol' && worstD < 1000) break;
      this.remove(live[worst]);
      live.splice(worst, 1);
    }
  }

  private free(pool: Pool): TownCar | undefined {
    return this.list.find((t) => t.pool === pool && t.kind === 'idle');
  }

  /** Nothing within `r` of (x, z)? */
  private clear(x: number, z: number, r: number, obstacles: Obstacles): boolean {
    for (const car of obstacles.cars) {
      if (obstacles.absent(car)) continue;
      const p = car.body.translation();
      if (Math.hypot(p.x - x, p.z - z) < r) return false;
    }
    return !obstacles.walker || Math.hypot(obstacles.walker.x - x, obstacles.walker.z - z) > r;
  }

  private spawnTraffic(pool: Pool, count: number, focus: { x: number; z: number }, yaw: number, obstacles: Obstacles): void {
    const live = this.list.filter((t) => t.pool === pool && (t.kind === 'driving' || t.kind === 'parked')).length;
    if (live >= count) return;
    this.spawnOn(pool, focus, yaw, obstacles, MIN_SPAWN.traffic, TRAFFIC.spawnRadius);
  }

  /** One car from `pool` out on a lane between `min` and `r` from the focus (out of view inside VIEW_FAR), driving. */
  private spawnOn(pool: Pool, focus: { x: number; z: number }, yaw: number, obstacles: Obstacles, min: number, r: number): TownCar | null {
    const t = this.free(pool);
    if (!t) return null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const at = this.w.roads.randomLane(this.rand, { near: focus, within: r });
      if (!at || at.edge.bridge || at.edge.roundabout) continue;
      if (pool === 'patrol') {
        // A police car comes your way where the road allows (no U-turn to start a chase with).
        const c = this.w.roads.pointAt(at.edge, at.dir > 0 ? at.s : at.edge.length - at.s);
        const h = at.dir > 0 ? c.heading : c.heading + Math.PI;
        const towards = Math.cos(h) * (focus.x - c.x) - Math.sin(h) * (focus.z - c.z) > 0;
        if (!towards && (at.dir > 0 ? at.edge.bw : at.edge.fw) > 0) {
          at.dir = (-at.dir) as Dir;
          at.s = at.edge.length - at.s;
        }
      }
      const lanes = at.dir > 0 ? at.edge.fw : at.edge.bw;
      const lane = outerLane(lanes);
      const pose = this.w.roads.lane(at.edge, at.dir, lane, at.s);
      const dx = pose.x - focus.x;
      const dz = pose.z - focus.z;
      const d = Math.hypot(dx, dz);
      if (d < min || d > r || (inView(dx, dz, yaw) && d < VIEW_FAR)) continue;
      if (!this.w.hasGround(pose.x, pose.z) || !this.clear(pose.x, pose.z, 12, obstacles)) continue;
      const ground = this.w.heightAt(pose.x, pose.z);
      if (Number.isNaN(ground)) continue;
      t.kind = 'driving';
      t.legs = [{ edge: at.edge, dir: at.dir, lane }];
      t.s = at.s;
      t.shift = 0;
      t.stuck = 0;
      t.waited = 0;
      t.pace = 0.85 + this.rand() * 0.3;
      t.car.paint.setHex(pool === 'patrol' ? POLICE_PAINT : PAINTS[Math.floor(this.rand() * PAINTS.length)]);
      t.car.place(new THREE.Vector3(pose.x, ground + RIDE_HEIGHT + 0.05, pose.z), pose.heading);
      // Already going: cars don't pull away from a standstill out of nowhere.
      const v = this.speedFor(t, at.edge) * 0.8;
      t.car.body.setLinvel({ x: Math.cos(pose.heading) * v, y: 0, z: -Math.sin(pose.heading) * v }, true);
      this.plan(t);
      this.stats.spawned.traffic++;
      return t;
    }
    return null;
  }

  private spawnParked(focus: { x: number; z: number }, yaw: number, obstacles: Obstacles): void {
    const live = this.list.filter((t) => t.pool === 'parked' && t.kind === 'parked').length;
    if (live >= PARKED.count) return;
    const t = this.free('parked');
    if (!t) return;
    const r = PARKED.spawnRadius;
    if (Math.hypot(focus.x - this.nearAt.x, focus.z - this.nearAt.z) > 20 || this.nearAt.r !== r) {
      this.nearAt = { x: focus.x, z: focus.z, r };
      this.near = this.spots.filter((s) => Math.hypot(s.x - focus.x, s.z - focus.z) < r + 20);
    }
    if (!this.near.length) return;
    for (let attempt = 0; attempt < 12; attempt++) {
      const s = this.near[Math.floor(this.rand() * this.near.length)];
      const dx = s.x - focus.x;
      const dz = s.z - focus.z;
      const d = Math.hypot(dx, dz);
      if (d < MIN_SPAWN.parked || d > r || (inView(dx, dz, yaw) && d < VIEW_FAR)) continue;
      if (!this.w.hasGround(s.x, s.z) || !this.clear(s.x, s.z, 6, obstacles)) continue;
      const ground = this.w.heightAt(s.x, s.z);
      if (Number.isNaN(ground)) continue;
      // Up on the footpath, where a shopfront or a lamp post may already be.
      if (s.kerb && this.w.blocked?.(s.x, ground, s.z, s.heading)) continue;
      t.kind = 'parked';
      t.legs = [];
      t.car.paint.setHex(PAINTS[Math.floor(this.rand() * PAINTS.length)]);
      t.car.place(new THREE.Vector3(s.x, ground + RIDE_HEIGHT / Math.cos(s.pitch), s.z), s.heading, s.pitch);
      this.stats.spawned.parked++;
      return;
    }
  }

  /**
   * Kerbside spots along the streets (not motorways, lanes or bridges), clear
   * of junctions and not too steep: on the left of each way you can drive,
   * and on both sides of a one-way street.
   */
  private findSpots(): void {
    const roads = this.w.roads;
    for (const e of roads.edges) {
      if (!STREETS.has(e.highway) || e.bridge || e.roundabout || e.restricted || !e.main || e.length < 2 * SPOT_CLEAR + 4) continue;
      // Room for a parked car and someone driving past it.
      if (e.width < (e.bw === 0 ? 6 : 7)) continue;
      const sides: { dir: Dir; side: number }[] = [];
      if (e.fw) sides.push({ dir: 1, side: 1 });
      if (e.bw) sides.push({ dir: -1, side: 1 });
      if (!e.bw && e.width >= 7) sides.push({ dir: 1, side: -1 });
      for (const { dir, side } of sides) {
        // Traffic keeps to lane 1 where there are two or more (outerLane), so lane 0 is free to park in.
        const kerb = side < 0 || (dir > 0 ? e.fw : e.bw) < 2;
        const out = kerb ? e.width / 2 + ON_KERB : e.width / 2 - KERB_GAP - COROLLA.width / 2;
        const from = (dir > 0 ? e.stopA : e.stopB) + SPOT_CLEAR;
        const to = e.length - (dir > 0 ? e.stopB : e.stopA) - SPOT_CLEAR;
        for (let s = from; s <= to; s += SPOT_EVERY) {
          const c = roads.pointAt(e, dir > 0 ? s : e.length - s);
          const h = dir > 0 ? c.heading : c.heading + Math.PI;
          const back = roads.pointAt(e, dir > 0 ? s - 1.5 : e.length - s + 1.5);
          const ahead = roads.pointAt(e, dir > 0 ? s + 1.5 : e.length - s - 1.5);
          const pitch = Math.atan2(ahead.y - back.y, 3);
          if (Math.abs(Math.tan(pitch)) > MAX_GRADE) continue;
          // Left of the way it faces is (-sin h, -cos h), as in RoadGraph.lane().
          this.spots.push({ x: c.x - Math.sin(h) * out * side, y: c.y, z: c.z - Math.cos(h) * out * side, heading: Math.atan2(Math.sin(h), Math.cos(h)), pitch, kerb });
        }
      }
    }
  }

  // --- driving -----------------------------------------------------------

  private speedFor(t: TownCar, e: RoadEdge): number {
    return TRAFFIC.speed * (CLASS_SPEED[e.highway] ?? 1) * t.pace;
  }

  /** Keep two legs queued past the current one, choosing at each junction. */
  private plan(t: TownCar): void {
    const roads = this.w.roads;
    while (t.legs.length < 3) {
      const last = t.legs[t.legs.length - 1];
      const node = roads.nodes[last.dir > 0 ? last.edge.b : last.edge.a];
      const inHeading = this.headingAt(last, last.edge.length);
      let options = node.out.filter((o) => o.edge.main && !o.edge.restricted && o.edge !== last.edge);
      if (!options.length) options = node.out.filter((o) => o.edge.main && !o.edge.restricted);
      if (!options.length) return;
      // Mostly straight on, sometimes a turn, rarely down a service lane.
      const weights = options.map((o) => {
        const h = this.headingAt({ edge: o.edge, dir: o.dir, lane: 0 }, 0);
        const turn = Math.abs(Math.atan2(Math.sin(h - inHeading), Math.cos(h - inHeading)));
        const kind = STREETS.has(o.edge.highway) || o.edge.highway.startsWith('motorway') || o.edge.highway.startsWith('trunk') ? 1 : 0.15;
        return kind * (turn < 0.5 ? 3 : turn < 2.2 ? 1 : 0.05);
      });
      const total = weights.reduce((a, b) => a + b, 0);
      let r = this.rand() * total;
      let pick = options[options.length - 1];
      for (const [i, o] of options.entries()) {
        if (r < weights[i]) {
          pick = o;
          break;
        }
        r -= weights[i];
      }
      t.legs.push({ edge: pick.edge, dir: pick.dir, lane: outerLane(pick.dir > 0 ? pick.edge.fw : pick.edge.bw) });
    }
  }

  /** Heading driving `leg` at `s` along it. */
  private headingAt(leg: Leg, s: number): number {
    const p = this.w.roads.pointAt(leg.edge, leg.dir > 0 ? s : leg.edge.length - s);
    return leg.dir > 0 ? p.heading : p.heading + Math.PI;
  }

  /** The lane `ahead` metres on from where it is, across legs, pulled out by `shift`. */
  private target(t: TownCar, ahead: number): { x: number; z: number; heading: number } {
    let s = t.s + ahead;
    let i = 0;
    while (i < t.legs.length - 1 && s > t.legs[i].edge.length) {
      s -= t.legs[i].edge.length;
      i++;
    }
    const leg = t.legs[i];
    const p = this.w.roads.lane(leg.edge, leg.dir, leg.lane, Math.min(s, leg.edge.length));
    // Towards the middle of the road is the right of the way it's going: (sin h, cos h).
    return { x: p.x + Math.sin(p.heading) * t.shift, z: p.z + Math.cos(p.heading) * t.shift, heading: p.heading };
  }

  private drive(t: TownCar, dt: number, obstacles: Obstacles): void {
    const car = t.car;
    const pos = car.body.translation();
    const rot = rotation(car);
    const fwd = _fwd.set(1, 0, 0).applyQuaternion(rot);
    const heading = Math.atan2(-fwd.z, fwd.x);
    const speed = car.forwardSpeed();

    // How far along: onto the next leg once past the end of this one.
    let leg = t.legs[0];
    let snap = this.w.roads.snapTo(leg.edge, pos.x, pos.z);
    t.s = leg.dir > 0 ? snap.s : leg.edge.length - snap.s;
    while (t.legs.length > 1 && t.s >= leg.edge.length - 0.5) {
      const next = t.legs[1];
      const ns = this.w.roads.snapTo(next.edge, pos.x, pos.z);
      // Only once it's closer to the next one (corners cut short count).
      if (ns.dist > snap.dist + 0.5 && t.s < leg.edge.length + 2) break;
      t.legs.shift();
      leg = next;
      snap = ns;
      t.s = leg.dir > 0 ? ns.s : leg.edge.length - ns.s;
      this.plan(t);
    }

    // Cruising speed for the road, less for the corner coming up.
    let want = this.speedFor(t, leg.edge);
    const far = this.target(t, 12 + Math.max(speed, 0) * 1.2);
    const bend = Math.abs(Math.atan2(Math.sin(far.heading - heading), Math.cos(far.heading - heading)));
    want = Math.min(want, 3.5 + 12 * Math.max(0, 1 - bend / 1.6));

    // Anything in the way: the nearest thing ahead in our path.
    const right = { x: Math.sin(heading), z: Math.cos(heading) };
    let ahead = Infinity;
    let aheadSpeed = 0;
    let stoppedInLane = false;
    t.blocked = '';
    const look = SCAN + Math.max(0, speed) * 1.5;
    const check = (x: number, z: number, halfLong: number, halfWide: number, v: number, what: string, parkedLike: boolean) => {
      const dx = x - pos.x;
      const dz = z - pos.z;
      const along = dx * fwd.x + dz * fwd.z;
      if (along < 1 || along > look) return;
      // Across from our path, which bends towards where we're steering.
      const across = dx * right.x + dz * right.z - this.curveOffset(t, along, pos, heading);
      if (Math.abs(across) > COROLLA.width / 2 + halfWide + 0.35) return;
      const gap = along - COROLLA.length / 2 - halfLong;
      if (gap < ahead) {
        ahead = gap;
        aheadSpeed = v;
        stoppedInLane = parkedLike;
        t.blocked = what;
      }
    };
    for (const other of obstacles.cars) {
      if (other === car || obstacles.absent(other)) continue;
      const p = other.body.translation();
      const lv = other.body.linvel();
      const v = lv.x * fwd.x + lv.z * fwd.z;
      const o = this.byCar.get(other);
      const still = Math.hypot(lv.x, lv.z) < 0.5 && (!o || o.kind !== 'driving');
      check(p.x, p.z, COROLLA.length / 2, COROLLA.width / 2 + 0.2, v, still ? 'stopped car' : 'car', still);
    }
    if (obstacles.walker) check(obstacles.walker.x, obstacles.walker.z, 0.4, 0.6, 0, 'you', false);

    // Pass a car stopped in the lane (parked, or abandoned) by pulling out, if the way out is clear.
    // No further out than keeps the car on the carriageway.
    const laneLeft = leg.edge.width / 2 - (Math.min(leg.lane, (leg.dir > 0 ? leg.edge.fw : leg.edge.bw) - 1) + 0.5) * (leg.edge.width / Math.max(1, leg.edge.fw + leg.edge.bw));
    const room = Math.max(0, leg.edge.width / 2 + laneLeft - COROLLA.width / 2 - 0.2);
    const wantShift = stoppedInLane && ahead < 25 ? Math.min(PASS_SHIFT, room) : 0;
    if (wantShift > t.shift) {
      const saved = t.shift;
      t.shift = wantShift;
      // Look again along the pulled-out path; stay put if that's blocked too.
      let blocked = false;
      for (const other of obstacles.cars) {
        if (other === car || obstacles.absent(other)) continue;
        const p = other.body.translation();
        const dx = p.x - pos.x;
        const dz = p.z - pos.z;
        const along = dx * fwd.x + dz * fwd.z;
        if (along < -3 || along > 30) continue;
        const across = dx * right.x + dz * right.z - wantShift;
        const o = this.byCar.get(other);
        const moving = Math.hypot(other.body.linvel().x, other.body.linvel().z) > 0.5 || o?.kind === 'driving';
        if (moving && Math.abs(across) < COROLLA.width + 0.5) blocked = true;
      }
      // Someone coming: wait for them, though not for ever (they'll make room).
      if (blocked && t.waited < 2.5) t.shift = saved;
      else ahead = Infinity;
    } else if (wantShift < t.shift && (ahead > 10 || !stoppedInLane)) {
      t.shift = Math.max(0, t.shift - dt * 0.8);
    }
    if (t.shift > 0 && stoppedInLane) ahead = Infinity;

    t.waited = stoppedInLane && Math.abs(speed) < 0.5 ? t.waited + dt : 0;
    if (ahead < Infinity) {
      // Stop TRAFFIC.gap short of it; follow a moving one a second or so behind.
      const room = ahead - TRAFFIC.gap;
      const follow = Math.max(0, aheadSpeed) + room * 0.6;
      want = Math.min(want, Math.max(0, follow), room > 0 ? Math.sqrt(2 * 4 * room) : 0);
    }

    // Steering: pure pursuit on a point down the lane.
    const lookAhead = 5 + Math.max(0, speed) * 0.5;
    const aim = this.target(t, lookAhead);
    const ax = aim.x - pos.x;
    const az = aim.z - pos.z;
    const alpha = Math.atan2(ax * right.x + az * right.z, ax * fwd.x + az * fwd.z);
    const ld = Math.max(2, Math.hypot(ax, az));
    const delta = Math.atan((2 * COROLLA.wheelbase * Math.sin(alpha)) / ld);
    const lock = THREE.MathUtils.lerp(TUNING.maxSteer, TUNING.minSteer, Math.sqrt(Math.min(Math.abs(speed) / TUNING.topSpeed, 1)));
    const c = t.controls;
    c.steer = THREE.MathUtils.clamp(delta / lock, -1, 1);
    c.handbrake = false;
    // Gentle on the pedals; the brakes reverse once stopped, so hold it with the handbrake instead.
    const err = want - speed;
    if (want < 0.3 && speed < 1) {
      c.throttle = 0;
      c.brake = 0;
      c.handbrake = true;
    } else if (err > 0) {
      c.throttle = Math.min(1, err * 0.25 + 0.15);
      c.brake = 0;
    } else {
      c.throttle = 0;
      c.brake = err < -0.8 ? Math.min(1, -err * 0.2) : 0;
    }

    // Wanting to go and getting nowhere (wedged, on its side): it's someone else's problem now.
    t.stuck = want > 2 && Math.abs(speed) < 0.5 ? t.stuck + dt : 0;
    if (t.stuck > GIVE_UP || car.isUpsideDown() || snap.dist > 25) {
      t.kind = 'loose';
      this.stats.gaveUp++;
      this.stats.why.push(`${leg.edge.name || leg.edge.index}: ${t.stuck > GIVE_UP ? `stuck (${t.blocked || 'nothing ahead'})` : car.isUpsideDown() ? 'upside down' : 'lost the road'}`);
    }
  }

  /** How far the lane bends right of straight ahead after `along` m (so cars round the corner count as ahead). */
  private curveOffset(t: TownCar, along: number, pos: { x: number; z: number }, heading: number): number {
    const p = this.target(t, along);
    return (p.x - pos.x) * Math.sin(heading) + (p.z - pos.z) * Math.cos(heading);
  }
}

/**
 * The map's own parked cars (parking.json) were put at the kerb in the road;
 * where that blocks the lane traffic drives in, they go half up on the kerb
 * like the town's. Returns where to put one, or null to leave it be.
 */
export function onKerb(roads: RoadGraph, x: number, z: number, heading: number): { x: number; z: number } | null {
  const n = roads.nearest(x, z, { within: 15, open: false });
  if (!n || !STREETS.has(n.edge.highway) || n.dist < 0.5) return null;
  const e = n.edge;
  const p = roads.pointAt(e, n.s);
  // Facing the way the edge runs (dir 1) or against it, and on its left or right.
  const along = Math.cos(heading - p.heading) > 0;
  const dir: Dir = along ? 1 : -1;
  const leftOfTravel = n.left === along;
  const lanes = dir > 0 ? e.fw : e.bw;
  const kerb = !leftOfTravel || (lanes < 2 && lanes > 0) || e.fw + e.bw < 2;
  if (!kerb) return null;
  const out = e.width / 2 + ON_KERB;
  return { x: n.x + ((x - n.x) / n.dist) * out, z: n.z + ((z - n.z) / n.dist) * out };
}

/** The lane to keep to: the outside one (lane 1) on a multi-lane road, clear of parked cars. */
function outerLane(lanes: number): number {
  return lanes >= 2 ? 1 : 0;
}

/** Inside the camera's rough view cone, looking along `yaw` (atan2(z, x))? */
function inView(dx: number, dz: number, yaw: number): boolean {
  const d = Math.hypot(dx, dz);
  if (d < 1e-3) return true;
  const off = Math.acos(Math.max(-1, Math.min(1, (dx * Math.cos(yaw) + dz * Math.sin(yaw)) / d)));
  return off < VIEW_HALF_ANGLE;
}

function rotation(car: Car): THREE.Quaternion {
  const r = car.body.rotation();
  return _q.set(r.x, r.y, r.z, r.w);
}
