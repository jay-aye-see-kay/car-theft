import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { TUNING, type Car, type DriveControls } from '../car.ts';
import type { Dir, RoadEdge, RoadGraph } from '../city/road-graph.ts';
import { COROLLA } from '../corolla.ts';
import { rng, type Ped, type PedEvent, type Peds } from '../peds.ts';
import type { Obstacles, Town } from '../traffic.ts';
import { knob, mechanic } from '../tweaks.ts';
import { LOUDSPEAKER, OFFENCES, SHOUT, TALKING_TO, syllables } from './lines.ts';

// The police (#54): they can't hurt you and you can't die. They want to
// catch you and give you a talking-to, and getting caught costs a ticket and
// someone else's car, nothing more.
//
// Heat only rises from what a cop sees: a line of sight within range and
// inside their view cone (no witnesses, no phone calls). It drops a level
// after a while out of everyone's sight, or when you swap cars unseen.
//
//   level 1: an officer on foot or on a bicycle comes after you (tackles you)
//   level 2: a patrol car tails you, siren going, and tries to cut in front
//   level 3: more cars boxing you in, and spikes and cones on the road ahead
//
// Officers are pedestrians (src/peds.ts) the cops steer; patrol cars are the
// town's police pool (src/traffic.ts PATROL_POOL), driving about like traffic
// until they're held for a chase, then driven from here: along a road route
// when far off or out of sight, straight at you when close. They're ordinary
// cars and take no damage. Everything is in fixed ticks with its own seeded
// dice, so smoke runs repeat.
//
// In a room each client runs the cops chasing its own player, and shares the
// chase cars and officers in its pose so the others see them (remote-cops.ts).

export const COPS = mechanic('cops', 'Cops', true, {
  sightRange: knob(70, 'Sight range', 10, 200, 5, 'm'),
  sightAngle: knob(150, 'Sight angle (whole cone)', 30, 360, 10, '°'),
  heatPed: knob(1, 'Heat: hitting someone', 0, 3, 0.05),
  heatCop: knob(1.5, 'Heat: hitting a cop or their car', 0, 3, 0.05),
  heatCar: knob(1, 'Heat: taking a car', 0, 3, 0.05),
  hoonSpeed: knob(75, 'Hooning: faster than', 20, 200, 5, 'km/h'),
  heatHoon: knob(0.45, 'Heat: hooning (or skids), per second seen', 0, 3, 0.05),
  heatFlee: knob(0.06, 'Heat: getting away, per second seen', 0, 1, 0.01),
  decay: knob(12, 'Drops a level after, out of sight', 2, 60, 1, 's'),
  beat: knob(1, 'Cops walking the beat', 0, 4, 1),
  bikes: knob(0.4, 'Share of them on bikes', 0, 1, 0.05),
  patrols: knob(2, 'Patrol cars driving about', 0, 4, 1),
  spawnDistance: knob(110, 'Chase cars come from', 50, 250, 10, 'm'),
  foot: knob(1, 'Level 1+: officers after you', 0, 3, 1),
  cars2: knob(1, 'Level 2: cars after you', 0, 4, 1),
  cars3: knob(3, 'Level 3: cars after you', 0, 5, 1),
  topSpeed: knob(26, 'Cop car top speed', 8, 50, 1, 'm/s'),
  aggression: knob(0.5, 'Aggression (cut in, nudge)', 0, 1, 0.05),
  runSpeed: knob(6.4, 'Running speed (bikes 1.5x)', 2, 10, 0.1, 'm/s'),
  tackleRange: knob(1.4, 'Tackle range', 0.5, 4, 0.1, 'm'),
  boxTime: knob(2, 'Boxed in: stopped by them for', 0.5, 8, 0.1, 's'),
  roadblocks: knob(1, 'Level 3: spikes and cones (1 on, 0 off)', 0, 1, 1),
  roadblockEvery: knob(16, 'A roadblock every', 5, 60, 1, 's'),
  spikeSlow: knob(0.5, 'Spikes: power lost', 0, 0.9, 0.05),
  flatTime: knob(25, 'Spikes: flat for', 3, 120, 1, 's'),
  sceneTime: knob(4.5, 'Talking-to lasts', 1, 12, 0.5, 's'),
  maxChase: knob(0, 'Longest chase (0: no limit)', 0, 300, 10, 's'),
});

export const MAX_LEVEL = 3;
/** Always seen this close (they hear you), m. */
const NEAR_SIGHT = 10;
/** Look again (a ray each) this often, s. */
const LOOK_EVERY = 0.2;
/** Officers walking the beat stay within this, and go past it (out of view), m. */
const BEAT_NEAR = { min: 45, max: 110, gone: 190 };
/** New chasing officers come from this far, m. */
const CHASER_FROM = { min: 35, max: 80 };
/** Officers and chase cars beyond this (and out of view) are let go, m. */
const LET_GO = 260;
/** Within this of you, with a clear view, a car drives straight at you instead of along the roads, m. */
const DIRECT = 45;
/** On foot within this, a chase car stops and its officer gets out, m. */
const GET_OUT = 13;
/** An officer this close to a stopped car you're in pulls you out, m. */
const DOOR = 2.8;
/** You count as stopped below this, m/s (crawling, or rolling down a hill with your foot off). */
const STOPPED = 2.5;
/** A chase car this close (centre to centre) to you, stopped, has you boxed in, m. */
const BOXED = 7.5;
/** Re-plan a road route this often, s. */
const REROUTE = 1.5;
/** Loudspeaker lines every this long or so, s, within this range, m. */
const SPEAKER_EVERY = 7;
const SPEAKER_RANGE = 60;
/** Not caught again (and no heat) for this long after a talking-to, s. */
const IMMUNE = 5;
/** The talking-to can be skipped after this long, s. */
const SKIP_AFTER = 0.6;
/** A tackle: the dive, then you're caught, s. */
const TACKLE_TIME = 0.4;
/** Bumping a cop car: not again for this long, s. */
const BUMP_COOLDOWN = 1.5;
/** Roadblock cones in the pool, and how long a roadblock stays, s. */
const CONE_POOL = 16;
const ROADBLOCK_LIFE = 45;
/** Spike strip: depth along the road, m. */
const SPIKE_DEPTH = 0.55;
const VIEW_HALF_ANGLE = (65 * Math.PI) / 180;
const VIEW_FAR = 160;

export type Offence = 'ped' | 'cop' | 'car' | 'hoon' | 'flee';

interface Officer {
  ped: Ped;
  chasing: boolean;
  /** The chase car they got out of (they go back to it). */
  car: CopCar | null;
  sees: boolean;
  lookAt: number;
  path: { x: number; z: number }[];
  pathAt: number;
  shoutAt: number;
}

interface CopCar {
  car: Car;
  /** Where to be round you: behind you, alongside then in front, ahead. */
  role: 'tail' | 'front' | 'back' | 'side';
  sees: boolean;
  lookAt: number;
  path: { x: number; z: number }[];
  pathAt: number;
  /** Alongside you for this long (then cut in), s. */
  alongside: number;
  stuck: number;
  /** Getting nowhere, on and off, for this long, s (out of view, it's replaced). */
  wedged: number;
  reversing: number;
  /** No backing round again before this (game s). */
  turnAt: number;
  /** Where it was steering for, last tick (?debug). */
  aim: { x: number; z: number; alpha: number; want: number } | null;
  upsideDown: number;
  speakAt: number;
  says: string;
  saysFor: number;
  /** Its officer, out chasing you on foot. */
  officer: Officer | null;
  controls: DriveControls;
}

interface Roadblock {
  x: number;
  y: number;
  z: number;
  /** Along the road the way you're going. */
  heading: number;
  /** The spike strip: from `spikeFrom` to `spikeTo` across the road (left of travel positive), m. */
  spikeFrom: number;
  spikeTo: number;
  cones: number[];
  born: number;
  used: boolean;
}

interface Cone {
  body: RAPIER.RigidBody;
  busy: boolean;
}

export interface CopWorld {
  roads: RoadGraph;
  world: RAPIER.World;
  peds: Peds;
  town: Town;
  heightAt(x: number, z: number): number;
}

/** You, as the cops see you this frame. */
export interface Suspect {
  /** Feet on foot, the car's centre driving. */
  x: number;
  y: number;
  z: number;
  /** Facing (cars and people face local +x). */
  heading: number;
  vx: number;
  vz: number;
  /** The car you're in, or null on foot. */
  car: Car | null;
  flying: boolean;
  /** Tyres sliding (skids, burnouts, handbrake turns), 0..1. */
  skid: number;
}

export type CopEvent =
  | { kind: 'tackle'; vx: number; vz: number }
  | { kind: 'caught'; car: Car | null; line: string; ticket: string; tickets: number }
  | { kind: 'released'; car: Car | null }
  | { kind: 'megaphone'; x: number; y: number; z: number; syllables: number }
  | { kind: 'shout'; x: number; y: number; z: number }
  | { kind: 'spiked'; car: Car }
  | { kind: 'level'; level: number; from: number }
  | { kind: 'gave-up' };

export interface Scene {
  t: number;
  line: string;
  ticket: string;
  car: Car | null;
  officer: Officer | null;
}

/** What we tell the room: our level, chase cars [pose, rotation, siren], chasing officers [x, y, z, heading, bike, running]. */
export interface CopsShare {
  w: number;
  k: [number, number, number, number, number, number, number, number][];
  u: [number, number, number, number, number, number][];
}

const _fwd = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
const _p = new THREE.Vector3();
const _a = new THREE.Vector3();

export class Cops {
  private readonly w: CopWorld;
  private rand = rng(54);
  heat = 0;
  /** Seen by any cop right now. */
  seen = false;
  unseenFor = 0;
  chaseTime = 0;
  lastSeen: { x: number; z: number } | null = null;
  /** The last thing they saw you do (for the ticket). */
  offence: Offence | null = null;
  tickets = 0;
  scene: Scene | null = null;
  immune = 0;
  readonly officers: Officer[] = [];
  readonly cars: CopCar[] = [];
  readonly roadblocks: Roadblock[] = [];
  readonly cones: Cone[] = [];
  readonly events: CopEvent[] = [];
  /** Bikes lying where their riders came off. */
  readonly dropped: { x: number; y: number; z: number; heading: number; t: number }[] = [];
  private clock = 0;
  /** Where you were last step (?debug). */
  private you = { x: 0, z: 0, car: false };
  private boxed = 0;
  private bumpedAt = -Infinity;
  private roadblockAt = 0;
  private tackleAt = -1;
  private tackler: Officer | null = null;
  /** ?debug counts. */
  stats = { offences: 0, unseenOffences: 0, carsSpawned: 0, officersSpawned: 0, tackles: 0, boxedIn: 0, pulledOut: 0, caught: 0, decayed: 0, swapped: 0, roadblocks: 0, spiked: 0, maxLevel: 0, log: [] as string[] };

  constructor(w: CopWorld) {
    this.w = w;
  }

  get level(): number {
    return this.heat < 1 ? 0 : Math.min(MAX_LEVEL, Math.floor(this.heat));
  }

  /** Chase cars out (held from the town's police pool). */
  isChaseCar(car: Car): boolean {
    return this.cars.some((c) => c.car === car);
  }

  /** Controls for a chase car this tick (null: not one of ours). */
  controlsFor(car: Car): DriveControls | null {
    return this.cars.find((c) => c.car === car)?.controls ?? null;
  }

  /** A police car with someone in it can't be got into. */
  occupied(car: Car): boolean {
    if (!this.w.town.isPatrol(car)) return false;
    const c = this.cars.find((c) => c.car === car);
    return !c || !c.officer;
  }

  /** Everyone gone and the dice back to `seed` (?debug reset). */
  reset(seed = 54): void {
    for (const o of [...this.officers]) this.dropOfficer(o);
    for (const c of [...this.cars]) this.w.town.dismiss(c.car);
    this.cars.length = 0;
    for (const r of [...this.roadblocks]) this.clearRoadblock(r);
    this.rand = rng(seed);
    this.heat = 0;
    this.seen = false;
    this.unseenFor = this.chaseTime = 0;
    this.lastSeen = null;
    this.offence = null;
    this.tickets = 0;
    this.scene = null;
    this.immune = 0;
    this.events.length = 0;
    this.dropped.length = 0;
    this.clock = 0;
    this.boxed = 0;
    this.bumpedAt = -Infinity;
    this.roadblockAt = 0;
    this.tackleAt = -1;
    this.tackler = null;
    this.stats = { offences: 0, unseenOffences: 0, carsSpawned: 0, officersSpawned: 0, tackles: 0, boxedIn: 0, pulledOut: 0, caught: 0, decayed: 0, swapped: 0, roadblocks: 0, spiked: 0, maxLevel: 0, log: [] as string[] };
  }

  /** ?debug: straight to this much heat (as if seen just now). */
  setHeat(heat: number, at?: { x: number; z: number }): void {
    const from = this.level;
    this.heat = Math.max(0, Math.min(MAX_LEVEL + 0.99, heat));
    this.unseenFor = 0;
    if (at) this.lastSeen = { x: at.x, z: at.z };
    this.offence ??= 'none' as Offence;
    if (this.level !== from) this.events.push({ kind: 'level', level: this.level, from });
  }

  /**
   * Something they might have seen you do. Counts only if a cop sees you
   * (`witness`: one who certainly did, being the one you hit).
   */
  report(offence: Offence, amount: number, witness = false): boolean {
    if (!COPS.on || this.scene || this.immune > 0) return false;
    if (!witness && !this.seen) {
      this.stats.unseenOffences++;
      return false;
    }
    this.stats.offences++;
    if (this.stats.log.length < 20) this.stats.log.push(`${this.clock.toFixed(1)} s: ${offence}${witness ? ' (to their face)' : ''}`);
    this.raise(amount, offence);
    return true;
  }

  /** Pedestrian events this tick: you hitting someone (an officer counts double, and they saw it). */
  pedEvents(events: readonly PedEvent[]): void {
    for (const e of events) {
      if (e.kind === 'hit' && e.byPlayer) {
        if (e.cop) this.report('cop', COPS.heatCop, true);
        else this.report('ped', COPS.heatPed);
      } else if (e.kind === 'unseated') this.dropped.push({ x: e.x, y: e.y, z: e.z, heading: e.heading, t: this.clock });
    }
  }

  /**
   * You got into a car. Someone else's in view of a cop is an offence;
   * any swap unseen while they're after you drops a level (they're looking
   * for the old one).
   */
  enteredCar(yours: boolean): void {
    if (!COPS.on || this.scene) return;
    if (this.seen) {
      if (!yours) this.report('car', COPS.heatCar);
      return;
    }
    if (this.level >= 1) {
      const from = this.level;
      this.heat = Math.max(0, Math.floor(this.heat) - 1);
      this.stats.swapped++;
      this.events.push({ kind: 'level', level: this.level, from });
    }
  }

  /** You got into one of their cars (its officer's out after you): it's yours now, and they saw that. */
  stolen(car: Car): void {
    const c = this.cars.find((c) => c.car === car);
    if (!c) return;
    car.siren = false;
    if (c.officer) c.officer.car = null;
    this.cars.splice(this.cars.indexOf(c), 1);
    this.report('cop', COPS.heatCop, true);
  }

  /** The talking-to: tap to get on with it. */
  skip(): void {
    if (this.scene && this.scene.t > SKIP_AFTER) this.scene.t = Infinity;
  }

  /**
   * Once a frame, before the physics (like the town's traffic): who sees
   * you, heat, cops in and out, and what each one does.
   */
  step(dt: number, you: Suspect, yaw: number, obstacles: Obstacles): void {
    this.clock += dt;
    this.you = { x: you.x, z: you.z, car: !!you.car };
    this.immune = Math.max(0, this.immune - dt);
    for (let i = this.dropped.length - 1; i >= 0; i--) {
      const b = this.dropped[i];
      if (this.clock - b.t > 40 || Math.hypot(b.x - you.x, b.z - you.z) > 200) this.dropped.splice(i, 1);
    }
    const town = this.w.town;
    town.patrols = COPS.on ? COPS.patrols : -1;
    if (!COPS.on) {
      if (this.officers.length || this.cars.length || this.heat > 0 || this.scene) this.standDown(true);
      return;
    }
    const prevLevel = this.level;

    this.look(you);
    if (this.scene) {
      this.runScene(dt, you);
      this.drive(dt, you, true);
      return;
    }

    // Hooning in view: fast, or sliding about.
    const speed = Math.hypot(you.vx, you.vz);
    if (this.seen && you.car && this.immune <= 0) {
      if (speed * 3.6 > COPS.hoonSpeed || (you.skid > 0.6 && speed > 4)) this.raise(COPS.heatHoon * dt, 'hoon');
      if (this.level >= 1 && speed > 8) this.raise(COPS.heatFlee * dt, 'flee');
    }
    this.bumps(you);

    // Out of sight long enough: down a level, and again after as long.
    if (this.seen) {
      this.unseenFor = 0;
      this.lastSeen = { x: you.x, z: you.z };
    } else if (this.level >= 1) {
      this.unseenFor += dt;
      if (this.unseenFor > COPS.decay) {
        this.heat = Math.max(0, Math.floor(this.heat) - 1);
        this.unseenFor = 0;
        this.stats.decayed++;
      }
    } else this.heat = Math.max(0, this.heat - dt * 0.05); // a little bit of heat below level 1 fades quietly
    if (this.level >= 1) {
      this.chaseTime += dt;
      if (COPS.maxChase > 0 && this.chaseTime > COPS.maxChase) {
        this.events.push({ kind: 'gave-up' });
        this.standDown(false);
      }
    } else this.chaseTime = 0;
    if (this.level !== prevLevel) this.events.push({ kind: 'level', level: this.level, from: prevLevel });
    this.stats.maxLevel = Math.max(this.stats.maxLevel, this.level);

    this.manage(you, yaw, obstacles);
    this.runOfficers(dt, you);
    this.drive(dt, you, false);
    this.roadblockStep(dt, you);
    this.caughtCheck(dt, you);
  }

  // --- heat --------------------------------------------------------------

  private raise(amount: number, offence: Offence): void {
    if (this.immune > 0 || amount <= 0) return;
    this.heat = Math.min(MAX_LEVEL + 0.99, this.heat + amount);
    // The ticket's for the worst of it: hooning and running only if that's all you did.
    const mild = offence === 'hoon' || offence === 'flee';
    if (!mild || !this.offence || this.offence === ('none' as Offence) || this.offence === 'hoon') this.offence = offence;
  }

  /** Ramming a police car (or being rammed hard while hooning): they saw that. */
  private bumps(you: Suspect): void {
    if (!you.car || this.clock - this.bumpedAt < BUMP_COOLDOWN) return;
    const p = you.car.body.translation();
    const v = you.car.body.linvel();
    for (const car of [...this.cars.map((c) => c.car), ...this.w.town.patrolling()]) {
      const q = car.body.translation();
      if (Math.hypot(q.x - p.x, q.z - p.z) > COROLLA.length + 0.3) continue;
      const u = car.body.linvel();
      const closing = Math.hypot(v.x - u.x, v.z - u.z);
      // A real knock, and you hitting them, not the other way round.
      if (closing < 5 || Math.hypot(v.x, v.z) < 4 || Math.hypot(v.x, v.z) < Math.hypot(u.x, u.z) - 1) continue;
      if (!touching(you.car, car)) continue;
      this.bumpedAt = this.clock;
      this.report('cop', COPS.heatCop, true);
      return;
    }
  }

  /** Who can see you: each cop looks every LOOK_EVERY s (a ray against walls and hills). */
  private look(you: Suspect): void {
    const eye = { x: you.x, y: you.car ? you.y + 0.5 : you.y + 1.2, z: you.z };
    let seen = false;
    for (const o of this.officers) {
      if (this.clock >= o.lookAt) {
        o.lookAt = this.clock + LOOK_EVERY;
        const p = o.ped;
        const down = p.state === 'fly' || p.state === 'down' || p.state === 'getup';
        o.sees = !down && this.sight(p.x, p.y + 1.6, p.z, p.heading, eye, o.chasing);
      }
      seen ||= o.sees;
    }
    const watchers: { car: Car; c?: CopCar }[] = [...this.cars.map((c) => ({ car: c.car, c })), ...this.w.town.patrolling().map((car) => ({ car }))];
    for (const { car, c } of watchers) {
      if (c?.officer) continue; // nobody in it
      const p = car.body.translation();
      if (c) {
        if (this.clock >= c.lookAt) {
          c.lookAt = this.clock + LOOK_EVERY;
          c.sees = this.sight(p.x, p.y + 0.8, p.z, headingOf(car), eye, true, car.collider);
        }
        seen ||= c.sees;
      } else if (!seen && this.sight(p.x, p.y + 0.8, p.z, headingOf(car), eye, false, car.collider)) seen = true;
    }
    this.seen = seen;
  }

  /** Can a cop at (x, y, z) facing `heading` see `eye`? Chasing ones look all round. */
  private sight(x: number, y: number, z: number, heading: number, eye: { x: number; y: number; z: number }, chasing: boolean, exclude?: RAPIER.Collider): boolean {
    const dx = eye.x - x;
    const dy = eye.y - y;
    const dz = eye.z - z;
    const d = Math.hypot(dx, dz);
    if (d > COPS.sightRange) return false;
    if (d > NEAR_SIGHT && !chasing) {
      const off = Math.abs(Math.atan2(Math.sin(Math.atan2(-dz, dx) - heading), Math.cos(Math.atan2(-dz, dx) - heading)));
      if (off > (COPS.sightAngle * Math.PI) / 360) return false;
    }
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.5) return true;
    _ray.origin = { x, y, z };
    _ray.dir = { x: dx / len, y: dy / len, z: dz / len };
    return !this.w.world.castRay(_ray, len - 0.3, true, RAPIER.QueryFilterFlags.ONLY_FIXED, undefined, exclude);
  }

  // --- who's out ---------------------------------------------------------

  private manage(you: Suspect, yaw: number, obstacles: Obstacles): void {
    const level = this.level;
    const peds = this.w.peds;
    // Officers: the beat ones walk about; chasers come after you.
    for (const o of [...this.officers]) {
      const p = o.ped;
      const d = Math.hypot(p.x - you.x, p.z - you.z);
      const away = !inView(p.x - you.x, p.z - you.z, yaw) || d > VIEW_FAR;
      if (p.pinned) continue; // a test officer stays where ?debug put them
      if (!peds.list.includes(p) || d > LET_GO * 1.6 || (away && d > (o.chasing ? LET_GO : BEAT_NEAR.gone))) this.dropOfficer(o);
    }
    const chasers = this.officers.filter((o) => o.chasing && !o.car);
    const want = level >= 1 ? COPS.foot : 0;
    if (chasers.length > want) {
      for (const o of chasers.slice(want)) this.offDuty(o);
    } else if (chasers.length < want) {
      // The nearest beat cop who can see you joins in; else one comes from out of view.
      const beat = this.officers.filter((o) => !o.chasing).sort((a, b) => dist(a.ped, you) - dist(b.ped, you));
      const join = beat.find((o) => o.sees) ?? beat.find((o) => dist(o.ped, you) < 90);
      if (join) this.startChasing(join);
      else {
        const ped = peds.spawnOfficer(you, yaw, CHASER_FROM.min, CHASER_FROM.max, this.rand() < COPS.bikes);
        if (ped) this.startChasing(this.addOfficer(ped));
      }
    }
    // (Test officers, standing where ?debug put them, don't count.)
    const beat = this.officers.filter((o) => !o.chasing && !o.ped.pinned).length;
    if (beat < COPS.beat) {
      const ped = peds.spawnOfficer(you, yaw, BEAT_NEAR.min, BEAT_NEAR.max, this.rand() < COPS.bikes);
      if (ped) this.addOfficer(ped);
    } else if (beat > COPS.beat) {
      // One too many (the one who gave you a talking-to, back on the beat): the furthest goes, once out of sight.
      const far = this.officers
        .filter((o) => !o.chasing && !o.ped.pinned && (!inView(o.ped.x - you.x, o.ped.z - you.z, yaw) || dist(o.ped, you) > VIEW_FAR))
        .sort((a, b) => dist(b.ped, you) - dist(a.ped, you))[0];
      if (far) this.dropOfficer(far);
    }

    // Chase cars: patrol cars that see you join in first, then more from out of view.
    const town = this.w.town;
    const wantCars = level >= 3 ? COPS.cars3 : level >= 2 ? COPS.cars2 : 0;
    for (const c of [...this.cars]) {
      const p = c.car.body.translation();
      const d = Math.hypot(p.x - you.x, p.z - you.z);
      const unseen = !inView(p.x - you.x, p.z - you.z, yaw) || d > VIEW_FAR;
      // Too far behind, or wedged somewhere out of sight: another one will come.
      if (d > LET_GO * 1.6 || (d > LET_GO && unseen && !c.sees) || (c.wedged > 6 && unseen && d > 30)) this.dropCar(c, true);
    }
    while (this.cars.length > wantCars) this.dropCar(this.cars[this.cars.length - 1], false);
    if (this.cars.length < wantCars) {
      const join = town.patrolling().map((car) => ({ car, d: Math.hypot(car.body.translation().x - you.x, car.body.translation().z - you.z) }))
        .filter((c) => c.d < COPS.sightRange * 1.5).sort((a, b) => a.d - b.d)[0];
      let car: Car | null = join?.car ?? null;
      if (car) town.hold(car);
      else car = town.spawnPatrol(you, yaw, obstacles, COPS.spawnDistance * 0.75, COPS.spawnDistance);
      if (car) {
        this.stats.carsSpawned++;
        this.cars.push(this.chaseCar(car));
      }
    }
    for (const c of this.cars) c.car.siren = true;
  }

  private chaseCar(car: Car): CopCar {
    const roles: CopCar['role'][] = ['tail', 'front', 'back', 'side', 'back'];
    return {
      car, role: roles[this.cars.length] ?? 'back', sees: false, lookAt: 0, path: [], pathAt: -Infinity, alongside: 0, stuck: 0, wedged: 0, reversing: 0, turnAt: 0, aim: null, upsideDown: 0,
      speakAt: this.clock + 2 + this.rand() * 3, says: '', saysFor: 0, officer: null, controls: { throttle: 0, brake: 0, steer: 0, handbrake: false },
    };
  }

  private addOfficer(ped: Ped): Officer {
    const o: Officer = { ped, chasing: false, car: null, sees: false, lookAt: 0, path: [], pathAt: -Infinity, shoutAt: 0 };
    this.officers.push(o);
    this.stats.officersSpawned++;
    return o;
  }

  private startChasing(o: Officer): void {
    o.chasing = true;
    o.ped.pinned = false;
    o.shoutAt = this.clock;
    o.path = [];
    o.pathAt = -Infinity;
    if (o.ped.state === 'walk' || o.ped.state === 'wait') setState(o.ped, 'cop');
  }

  /** Back to walking the beat. */
  private offDuty(o: Officer): void {
    o.chasing = false;
    if (o.car) {
      o.car.officer = null;
      o.car = null;
    }
    if (o.ped.state === 'cop' || o.ped.state === 'scold' || o.ped.state === 'tackle') this.w.peds.release(o.ped);
  }

  private dropOfficer(o: Officer): void {
    if (o.car) o.car.officer = null;
    this.w.peds.remove(o.ped);
    const i = this.officers.indexOf(o);
    if (i >= 0) this.officers.splice(i, 1);
  }

  /** Done with a chase car: back to patrolling (drives off), or taken away if it's far off. */
  private dropCar(c: CopCar, away: boolean): void {
    c.car.siren = false;
    if (c.officer) this.offDuty(c.officer);
    if (away) this.w.town.dismiss(c.car);
    else this.w.town.release(c.car);
    const i = this.cars.indexOf(c);
    if (i >= 0) this.cars.splice(i, 1);
  }

  /** Everyone stops chasing (caught, given up, switched off). */
  private standDown(gone: boolean): void {
    for (const o of [...this.officers]) {
      if (gone) this.dropOfficer(o);
      else if (o.chasing) this.offDuty(o);
    }
    for (const c of [...this.cars]) this.dropCar(c, gone);
    for (const r of [...this.roadblocks]) if (gone) this.clearRoadblock(r);
    this.heat = 0;
    this.unseenFor = this.chaseTime = 0;
    this.boxed = 0;
    this.scene = null;
  }

  // --- officers ------------------------------------------------------------

  private runOfficers(dt: number, you: Suspect): void {
    for (const o of this.officers) {
      const p = o.ped;
      if (!o.chasing) continue;
      // Back on their feet after a knock: on with the chase.
      if (p.state === 'walk' || p.state === 'wait') setState(p, 'cop');
      if (p.state !== 'cop') continue;
      // Your car's driving off: back to theirs, if they came in one.
      const target = o.car && you.car && Math.hypot(you.x - p.x, you.z - p.z) > 18 ? doorOf(o.car.car) : this.chaseTarget(you, o.sees);
      const dx = target.x - p.x;
      const dz = target.z - p.z;
      const d = Math.hypot(dx, dz);
      if (o.car && you.car && d < 1.6 && Math.hypot(you.x - p.x, you.z - p.z) > 18) {
        // Back in: the car carries on.
        this.dropOfficer(o);
        continue;
      }
      let aim = target;
      if (!(d < 30 && o.sees)) aim = this.follow(o, p, target, 2.5);
      const ax = aim.x - p.x;
      const az = aim.z - p.z;
      const ad = Math.hypot(ax, az);
      const speed = COPS.runSpeed * (p.bike ? 1.5 : 1) * (p.dazed > 0 ? 0.6 : 1);
      if (ad > 0.3) {
        const step = Math.min(ad, speed * dt);
        p.x += (ax / ad) * step;
        p.z += (az / ad) * step;
        p.vx = (ax / ad) * speed;
        p.vz = (az / ad) * speed;
        const want = Math.atan2(-az, ax);
        p.heading += Math.atan2(Math.sin(want - p.heading), Math.cos(want - p.heading)) * Math.min(1, dt * 10);
        p.phase += dt * (p.bike ? 8 : 12);
      } else p.vx = p.vz = 0;
      if (o.sees && this.clock - o.shoutAt > 5 + this.rand() * 4 && d < 40) {
        o.shoutAt = this.clock;
        p.says = pick(this.rand, SHOUT);
        p.saysFor = 2;
        this.events.push({ kind: 'shout', x: p.x, y: p.y, z: p.z });
      }
      if (this.immune > 0) continue;
      const feetY = you.car ? you.y - 0.5 : you.y;
      const near = Math.hypot(you.x - p.x, you.z - p.z);
      if (!you.car && !you.flying && near < COPS.tackleRange + (p.bike ? 0.6 : 0) && Math.abs(feetY - p.y) < 1.4) {
        // The tackle: off the bike if on one, and a dive.
        if (p.bike) {
          p.bike = false;
          this.dropped.push({ x: p.x, y: p.y, z: p.z, heading: p.heading, t: this.clock });
        }
        setState(p, 'tackle');
        p.heading = Math.atan2(-(you.z - p.z), you.x - p.x);
        this.tackleAt = this.clock;
        this.tackler = o;
        this.stats.tackles++;
        this.events.push({ kind: 'tackle', vx: Math.cos(p.heading) * 4, vz: -Math.sin(p.heading) * 4 });
        return;
      }
      if (you.car && near < DOOR + 1 && Math.hypot(you.vx, you.vz) < STOPPED) {
        // At your door with you sat there: out you come.
        this.stats.pulledOut++;
        this.begin(you, o);
        return;
      }
    }
  }

  /** Where they head for: you, if they can see you (or someone else can), else where you were last seen. */
  private chaseTarget(you: Suspect, sees: boolean): { x: number; z: number } {
    return sees || this.seen || !this.lastSeen ? { x: you.x, z: you.z } : this.lastSeen;
  }

  /**
   * A point `ahead` m along a road route to `target` from the nearest point
   * on it (a carrot to steer at, so corners are taken round, not cut through
   * the buildings), re-planned every so often.
   */
  private follow(o: { path: { x: number; z: number }[]; pathAt: number }, at: { x: number; z: number }, target: { x: number; z: number }, ahead = 2): { x: number; z: number } {
    if (this.clock - o.pathAt > REROUTE || !o.path.length) {
      o.pathAt = this.clock;
      const r = this.w.roads.route(at, target, { within: 60 });
      o.path = r ? [...r.points, target] : [target];
    }
    const path = o.path;
    // Drop what's behind: up to the segment nearest us (looking a few on).
    let best = 0;
    let bestD = Infinity;
    let bestF = 0;
    for (let i = 0; i < Math.min(path.length - 1, 6); i++) {
      const a = path[i];
      const b = path[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz || 1;
      const f = Math.min(1, Math.max(0, ((at.x - a.x) * dx + (at.z - a.z) * dz) / len2));
      const d = Math.hypot(a.x + dx * f - at.x, a.z + dz * f - at.z);
      if (d < bestD) {
        bestD = d;
        best = i;
        bestF = f;
      }
    }
    if (path.length === 1) return path[0];
    path.splice(0, best);
    // Then `ahead` m on from there.
    let left = ahead;
    let from = { x: path[0].x + (path[1].x - path[0].x) * bestF, z: path[0].z + (path[1].z - path[0].z) * bestF };
    for (let i = 1; i < path.length; i++) {
      const seg = Math.hypot(path[i].x - from.x, path[i].z - from.z);
      if (seg >= left) return { x: from.x + ((path[i].x - from.x) * left) / seg, z: from.z + ((path[i].z - from.z) * left) / seg };
      left -= seg;
      from = path[i];
    }
    return path[path.length - 1];
  }

  /** How sharp the route turns between `near` and `far` m on, rad (for slowing down). */
  private bendAhead(o: { path: { x: number; z: number }[]; pathAt: number }, at: { x: number; z: number }, heading: number, far: number): number {
    const p = this.follow(o, at, o.path[o.path.length - 1] ?? at, far);
    return Math.abs(angleTo(heading, at, p));
  }

  // --- chase cars ----------------------------------------------------------

  private drive(dt: number, you: Suspect, parked: boolean): void {
    const yourSpeed = Math.hypot(you.vx, you.vz);
    const fx = Math.cos(you.heading);
    const fz = -Math.sin(you.heading);
    for (const [index, c] of this.cars.entries()) {
      const car = c.car;
      const ctl = c.controls;
      c.saysFor = Math.max(0, c.saysFor - dt);
      const pos = car.body.translation();
      const rot = car.body.rotation();
      const fwd = _fwd.set(1, 0, 0).applyQuaternion(_q.set(rot.x, rot.y, rot.z, rot.w));
      const heading = Math.atan2(-fwd.z, fwd.x);
      const speed = car.forwardSpeed();
      c.upsideDown = car.isUpsideDown() ? c.upsideDown + dt : 0;
      if (c.upsideDown > 2) {
        car.reset(this.w.heightAt(pos.x, pos.z) || pos.y);
        c.upsideDown = 0;
      }
      const toYou = Math.hypot(you.x - pos.x, you.z - pos.z);
      // Its officer's out, or the talking-to's on: parked, lights going.
      if (parked || c.officer) {
        hold(ctl);
        continue;
      }
      // You're on foot and close: pull up, and out they get.
      if (!you.car && toYou < GET_OUT && Math.abs(speed) < 2 && !this.scene) {
        hold(ctl);
        const door = doorOf(car);
        const ped = this.w.peds.officerAt(door.x, door.z, heading - Math.PI / 2, false);
        if (ped) {
          const o = this.addOfficer(ped);
          o.car = c;
          c.officer = o;
          this.startChasing(o);
        }
        continue;
      }

      // Where to aim: along the roads when far or out of sight, else round you by role.
      const sees = c.sees || toYou < 12;
      const target = this.chaseTarget(you, sees);
      let aim: { x: number; z: number };
      let want = 0;
      if (toYou > DIRECT || !sees) {
        aim = this.follow(c, pos, target, 5 + Math.max(0, speed) * 0.45);
        // Further along the path for the corner coming up.
        const bend = this.bendAhead(c, pos, heading, 12 + Math.max(0, speed) * 1.3);
        want = Math.min(COPS.topSpeed, 5 + 21 * Math.max(0, 1 - bend / 1.2));
        if (!sees && Math.hypot(target.x - pos.x, target.z - pos.z) < 10) want = 2; // where you were: nobody here
      } else if (!you.car) {
        aim = { x: you.x, z: you.z };
        want = Math.max(0, (toYou - GET_OUT + 3) * 0.8);
      } else {
        // Round your car: behind you, alongside then cutting in front, or ahead.
        const rx = -fz;
        const rz = fx;
        const lead = Math.min(1.2, 0.4 + yourSpeed / 30);
        const px = you.x + you.vx * lead;
        const pz = you.z + you.vz * lead;
        const along = (pos.x - you.x) * fx + (pos.z - you.z) * fz;
        const across = (pos.x - you.x) * rx + (pos.z - you.z) * rz;
        const ag = COPS.aggression;
        let gap = 6;
        if (yourSpeed < 3) {
          // You've stopped: pull up round you (beside, in front, behind) and that's you boxed in.
          const spot = { tail: [0.5, 2.9], side: [0.5, -2.9], front: [6.2, 0], back: [-6.2, 0] }[c.role];
          aim = { x: you.x + fx * spot[0] + rx * spot[1], z: you.z + fz * spot[0] + rz * spot[1] };
          const toAim = Math.hypot(aim.x - pos.x, aim.z - pos.z);
          want = toAim < 1.5 ? 0 : Math.min(COPS.topSpeed, 1.5 + toAim * 0.6);
        } else if (c.role === 'tail' || c.role === 'side') {
          // Pull up alongside (on your right, or left), then cut in.
          const side = c.role === 'tail' ? 1 : -1;
          c.alongside = Math.abs(along) < 3 && Math.abs(across) < 4.5 ? c.alongside + dt : Math.max(0, c.alongside - dt);
          if (c.alongside > 1.6 - ag) {
            aim = { x: px + fx * 9, z: pz + fz * 9 };
            gap = 0;
          } else aim = { x: px + rx * 2.8 * side + fx * 2, z: pz + rz * 2.8 * side + fz * 2 };
        } else if (c.role === 'front') {
          aim = { x: px + fx * 16, z: pz + fz * 16 };
          gap = 0;
        } else {
          aim = { x: px - fx * 7, z: pz - fz * 7 };
        }
        if (yourSpeed >= 3) {
          const toAim = Math.hypot(aim.x - pos.x, aim.z - pos.z);
          want = Math.min(COPS.topSpeed, yourSpeed + (toAim - gap) * 0.9 + 1);
          // Ahead of you: ease off and make you stop (a box in).
          if (along > 3 && Math.abs(across) < 3) want = Math.min(want, yourSpeed * (0.85 - 0.5 * ag));
          // Close: only a gentle nudge.
          if (toYou < 6) want = Math.min(want, yourSpeed + 1.5 + ag * 3);
        }
      }
      if (index > 0 && !you.car) want = Math.min(want, 6);

      // Steer by pure pursuit at the aim point.
      const alpha = angleTo(heading, pos, aim);
      c.aim = { x: aim.x, z: aim.z, alpha, want };
      const ld = Math.max(3, Math.hypot(aim.x - pos.x, aim.z - pos.z));
      const delta = Math.atan((2 * COROLLA.wheelbase * Math.sin(alpha)) / ld);
      const lock = THREE.MathUtils.lerp(TUNING.maxSteer, TUNING.minSteer, Math.sqrt(Math.min(Math.abs(speed) / TUNING.topSpeed, 1)));
      // (Pure pursuit only works for points ahead: anything behind is full lock that way.)
      ctl.steer = Math.abs(alpha) > Math.PI / 2 ? Math.sign(alpha) : THREE.MathUtils.clamp(delta / lock, -1, 1);
      ctl.handbrake = false;
      // Behind it: back round (wheel the other way), then off.
      if (Math.abs(alpha) > 2.2 && Math.abs(speed) < 6 && this.clock > c.turnAt && c.reversing <= 0) {
        c.reversing = 1.3;
        c.turnAt = this.clock + 3.5;
      }
      if (Math.abs(alpha) > 1.9) want = Math.min(want, 5);

      // Stuck against something: back up a bit, wheel the other way.
      c.stuck = want > 3 && Math.abs(speed) < 0.8 ? c.stuck + dt : 0;
      c.wedged = want > 3 && Math.abs(speed) < 2 ? c.wedged + dt : Math.max(0, c.wedged - dt * 0.5);
      if (c.stuck > 1.2) {
        c.reversing = 1.1;
        c.stuck = 0;
        c.pathAt = -Infinity; // and think again about the way
      }
      if (c.reversing > 0) {
        c.reversing -= dt;
        ctl.throttle = 0;
        ctl.brake = 1;
        ctl.steer = -ctl.steer;
        continue;
      }
      const err = want - speed;
      if (want < 0.3 && Math.abs(speed) < 1) hold(ctl);
      else if (err > 0) {
        ctl.throttle = Math.min(1, err * 0.3 + 0.2);
        ctl.brake = 0;
      } else {
        ctl.throttle = 0;
        ctl.brake = err < -0.6 ? Math.min(1, -err * 0.25) : 0;
      }

      // The loudspeaker, now and then.
      if (sees && toYou < SPEAKER_RANGE && this.clock > c.speakAt) {
        c.speakAt = this.clock + SPEAKER_EVERY + this.rand() * 4;
        c.says = pick(this.rand, LOUDSPEAKER);
        c.saysFor = 2.6;
        this.events.push({ kind: 'megaphone', x: pos.x, y: pos.y, z: pos.z, syllables: syllables(c.says) });
      }
    }
  }

  // --- caught --------------------------------------------------------------

  private caughtCheck(dt: number, you: Suspect): void {
    if (this.immune > 0 || this.level < 1) {
      this.boxed = 0;
      return;
    }
    if (this.tackleAt >= 0 && this.clock - this.tackleAt > TACKLE_TIME) {
      const o = this.tackler;
      this.tackleAt = -1;
      this.tackler = null;
      this.begin(you, o);
      return;
    }
    // Stopped with a chase car right by you: boxed in.
    if (you.car && Math.hypot(you.vx, you.vz) < STOPPED) {
      const near = this.cars.some((c) => {
        const p = c.car.body.translation();
        return Math.hypot(p.x - you.x, p.z - you.z) < BOXED;
      });
      this.boxed = near ? this.boxed + dt : 0;
      if (this.boxed > COPS.boxTime) {
        this.stats.boxedIn++;
        this.begin(you, null);
      }
    } else this.boxed = 0;
  }

  /** Caught: a ticket, a talking-to, and (after) the car if it isn't yours. */
  private begin(you: Suspect, officer: Officer | null): void {
    this.boxed = 0;
    this.tickets++;
    this.stats.caught++;
    const line = pick(this.rand, TALKING_TO);
    const ticket = pick(this.rand, OFFENCES[this.offence ?? 'none'] ?? OFFENCES.none);
    // Someone to give it: the officer who caught you, else one out of the nearest car.
    let o = officer;
    if (!o) {
      const near = this.cars.map((c) => ({ c, d: dist(c.car.body.translation(), you) })).sort((a, b) => a.d - b.d)[0];
      const from = near && near.d < 30 ? doorOf(near.c.car) : { x: you.x + 2, z: you.z };
      const ped = this.w.peds.officerAt(from.x, from.z, 0, false);
      if (ped) {
        o = this.addOfficer(ped);
        o.chasing = true;
        if (near && near.d < 30) {
          o.car = near.c;
          near.c.officer = o;
        }
      }
    }
    this.scene = { t: 0, line, ticket, car: you.car, officer: o };
    this.events.push({ kind: 'caught', car: you.car, line, ticket, tickets: this.tickets });
  }

  private runScene(dt: number, you: Suspect): void {
    const s = this.scene!;
    s.t += dt;
    const o = s.officer;
    if (o && this.officers.includes(o)) {
      const p = o.ped;
      if (p.state !== 'fly' && p.state !== 'down' && p.state !== 'getup') {
        // Walk up to a couple of metres away, then the finger wagging.
        const dx = you.x - p.x;
        const dz = you.z - p.z;
        const d = Math.hypot(dx, dz);
        p.heading = Math.atan2(-dz, dx);
        if (d > 1.8 && p.state !== 'tackle') {
          if (p.state !== 'cop') setState(p, 'cop');
          const step = Math.min(d - 1.8, 3 * dt);
          p.x += (dx / d) * step;
          p.z += (dz / d) * step;
          p.vx = (dx / d) * 3;
          p.vz = (dz / d) * 3;
          p.phase += dt * 9;
        } else if (p.state !== 'scold' && (p.state !== 'tackle' || p.t > 0.8)) {
          setState(p, 'scold');
          p.vx = p.vz = 0;
        }
        p.says = s.line;
        p.saysFor = 0.5;
      }
    }
    if (s.t < COPS.sceneTime) return;
    // Done: heat cleared, everyone back to their rounds, and you're free to go (on foot).
    const car = s.car;
    if (o && this.officers.includes(o)) say(o.ped, '');
    this.standDown(false);
    this.offence = null;
    this.immune = IMMUNE;
    this.events.push({ kind: 'released', car });
  }

  // --- roadblocks ------------------------------------------------------------

  private roadblockStep(dt: number, you: Suspect): void {
    // Old ones go.
    for (const r of [...this.roadblocks]) {
      if (this.clock - r.born > ROADBLOCK_LIFE || (Math.hypot(r.x - you.x, r.z - you.z) > 250 && this.clock - r.born > 10)) this.clearRoadblock(r);
    }
    // Spikes under anyone's wheels: yours and the chase cars' own.
    for (const r of this.roadblocks) {
      for (const car of [you.car, ...this.cars.map((c) => c.car)]) {
        if (!car || car.flat > 0) continue;
        if (this.onSpikes(r, car)) {
          car.flat = COPS.flatTime;
          car.flatSlow = COPS.spikeSlow;
          car.flatWobble = 0.6;
          r.used = true;
          this.stats.spiked++;
          this.events.push({ kind: 'spiked', car });
        }
      }
    }
    this.roadblockAt -= dt;
    if (this.level < 3 || !COPS.roadblocks || !you.car || this.roadblockAt > 0) return;
    const speed = Math.hypot(you.vx, you.vz);
    if (speed < 6) return;
    this.roadblockAt = COPS.roadblockEvery;
    this.placeRoadblock(you, speed);
  }

  /** Spikes on one half of the road ahead of you, cones across the other half. */
  placeRoadblock(you: { x: number; z: number; heading: number }, speed: number): Roadblock | null {
    const roads = this.w.roads;
    const n = roads.nearest(you.x, you.z, { within: 15, open: false });
    if (!n) return null;
    let edge: RoadEdge = n.edge;
    const p0 = roads.pointAt(edge, n.s);
    let dir: Dir = Math.cos(you.heading - p0.heading) > 0 ? 1 : -1;
    let s = dir > 0 ? n.s : edge.length - n.s;
    let ahead = Math.min(140, 50 + speed * 2.2);
    // Along the road the way you're going, straight on at each junction.
    for (let hops = 0; hops < 6 && s + ahead > edge.length - 4; hops++) {
      ahead -= edge.length - s;
      const node = roads.nodes[dir > 0 ? edge.b : edge.a];
      const inH = headingAlong(roads, edge, dir, edge.length);
      let best: { edge: RoadEdge; dir: Dir } | null = null;
      let bestTurn = 0.6;
      for (const o of node.out) {
        if (o.edge === edge || o.edge.bridge) continue;
        const h = headingAlong(roads, o.edge, o.dir, 0);
        const turn = Math.abs(Math.atan2(Math.sin(h - inH), Math.cos(h - inH)));
        if (turn < bestTurn) {
          bestTurn = turn;
          best = o;
        }
      }
      if (!best) return null;
      edge = best.edge;
      dir = best.dir;
      s = 0;
    }
    s = Math.min(edge.length - 4, Math.max(4, s + ahead));
    const c = roads.pointAt(edge, dir > 0 ? s : edge.length - s);
    const heading = dir > 0 ? c.heading : c.heading + Math.PI;
    const y = this.w.heightAt(c.x, c.z);
    if (Number.isNaN(y)) return null;
    const half = edge.width / 2;
    // Your side (the left) gets the spikes, mostly; the cones are the way round, if you'll knock them over.
    const spikesLeft = this.rand() < 0.7;
    const r: Roadblock = {
      x: c.x, y, z: c.z, heading, spikeFrom: spikesLeft ? 0 : -half + 0.2, spikeTo: spikesLeft ? half - 0.2 : 0, cones: [], born: this.clock, used: false,
    };
    // Cones across the other half, 1.4 m apart, a couple of metres past the spikes.
    const from = spikesLeft ? -half + 0.6 : 0.6;
    const to = spikesLeft ? -0.6 : half - 0.6;
    for (let off = from; off <= to + 1e-3; off += 1.4) {
      const k = this.cone();
      if (k < 0) break;
      const q = sideways(r, off, 2);
      const g = this.w.heightAt(q.x, q.z);
      const body = this.cones[k].body;
      body.setEnabled(true);
      body.setTranslation({ x: q.x, y: (Number.isNaN(g) ? y : g) + 0.36, z: q.z }, true);
      body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      r.cones.push(k);
    }
    this.roadblocks.push(r);
    this.stats.roadblocks++;
    return r;
  }

  private cone(): number {
    let k = this.cones.findIndex((c) => !c.busy);
    if (k < 0 && this.cones.length < CONE_POOL) {
      const world = this.w.world;
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setCanSleep(true).setAngularDamping(0.8).setLinearDamping(0.3));
      // A traffic cone: light, bouncy enough to go flying.
      world.createCollider(RAPIER.ColliderDesc.cone(0.35, 0.2).setDensity(60).setFriction(0.7).setRestitution(0.3), body);
      this.cones.push({ body, busy: false });
      k = this.cones.length - 1;
    }
    if (k >= 0) this.cones[k].busy = true;
    return k;
  }

  private clearRoadblock(r: Roadblock): void {
    for (const k of r.cones) {
      this.cones[k].busy = false;
      this.cones[k].body.setEnabled(false);
    }
    const i = this.roadblocks.indexOf(r);
    if (i >= 0) this.roadblocks.splice(i, 1);
  }

  private onSpikes(r: Roadblock, car: Car): boolean {
    const fx = Math.cos(r.heading);
    const fz = -Math.sin(r.heading);
    for (let i = 0; i < 4; i++) {
      if (!car.wheelContact(i, _p, _a)) continue;
      const dx = _p.x - r.x;
      const dz = _p.z - r.z;
      const along = dx * fx + dz * fz;
      // Left of travel is (-sin h, -cos h).
      const left = dx * -Math.sin(r.heading) + dz * -Math.cos(r.heading);
      if (Math.abs(along) < SPIKE_DEPTH / 2 + 0.15 && left >= r.spikeFrom - 0.2 && left <= r.spikeTo + 0.2) return true;
    }
    return false;
  }

  // --- sharing and drawing -----------------------------------------------

  /** What's said over heads: officers are pedestrians (their bubbles come with them); the cars' loudspeakers. */
  speakers(): { x: number; y: number; z: number; text: string }[] {
    return this.cars.filter((c) => c.saysFor > 0).map((c) => {
      const p = c.car.object.position;
      return { x: p.x, y: p.y + 1.9, z: p.z, text: `📢 ${c.says}` };
    });
  }

  /** The nearest siren to `at`, m (Infinity for none). */
  sirenDistance(at: { x: number; z: number }): number {
    let best = Infinity;
    for (const c of this.cars) {
      const p = c.car.object.position;
      best = Math.min(best, Math.hypot(p.x - at.x, p.z - at.z));
    }
    return best;
  }

  share(): CopsShare | null {
    if (!COPS.on || (!this.cars.length && this.level === 0 && !this.officers.some((o) => o.chasing))) return null;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const r4 = (n: number) => Math.round(n * 10000) / 10000;
    return {
      w: this.level,
      k: this.cars.map((c) => {
        const t = c.car.body.translation();
        const q = c.car.body.rotation();
        return [r2(t.x), r2(t.y), r2(t.z), r4(q.x), r4(q.y), r4(q.z), r4(q.w), c.car.siren ? 1 : 0];
      }),
      u: this.officers.filter((o) => o.chasing).map((o) => {
        const p = o.ped;
        return [r2(p.x), r2(p.y), r2(p.z), r2(p.heading), p.bike ? 1 : 0, Math.hypot(p.vx, p.vz) > 0.5 ? 1 : 0];
      }),
    };
  }

  /** For ?debug. */
  debug() {
    return {
      on: COPS.on, heat: this.heat, level: this.level, seen: this.seen, unseenFor: this.unseenFor, chaseTime: this.chaseTime, offence: this.offence,
      tickets: this.tickets, immune: this.immune, boxed: this.boxed, you: this.you, lastSeen: this.lastSeen,
      scene: this.scene && { t: this.scene.t, line: this.scene.line, ticket: this.scene.ticket, car: !!this.scene.car },
      officers: this.officers.map((o) => ({ pos: [o.ped.x, o.ped.y, o.ped.z], state: o.ped.state, chasing: o.chasing, bike: o.ped.bike, sees: o.sees, fromCar: !!o.car })),
      cars: this.cars.map((c) => {
        const p = c.car.body.translation();
        return {
          pos: [p.x, p.y, p.z], role: c.role, sees: c.sees, speed: c.car.forwardSpeed(), siren: c.car.siren, officerOut: !!c.officer, flat: c.car.flat > 0,
          heading: headingOf(c.car), path: c.path.slice(0, 4).map((q) => [q.x, q.z]), controls: { ...c.controls }, reversing: c.reversing > 0, aim: c.aim,
        };
      }),
      patrolling: this.w.town.patrolling().length,
      roadblocks: this.roadblocks.map((r) => ({ pos: [r.x, r.y, r.z], heading: r.heading, spikes: [r.spikeFrom, r.spikeTo], cones: r.cones.length, used: r.used })),
      stats: this.stats,
    };
  }

  /** ?debug: an officer (foot or bike) or a chase car at (x, z). */
  spawnAt(kind: 'foot' | 'bike' | 'car', x: number, z: number, heading: number, chasing: boolean): boolean {
    if (kind === 'car') {
      const car = this.w.town.patrolAt(x, z, heading);
      if (!car) return false;
      if (!chasing) return true;
      this.stats.carsSpawned++;
      this.cars.push(this.chaseCar(car));
      return true;
    }
    const ped = this.w.peds.officerAt(x, z, heading, kind === 'bike');
    if (!ped) return false;
    setState(ped, 'wait');
    ped.pinned = !chasing;
    const o = this.addOfficer(ped);
    if (chasing) this.startChasing(o);
    return true;
  }
}

/** A spike strip's or cone's spot: `left` m left of the road's line, `ahead` m on. */
function sideways(r: { x: number; z: number; heading: number }, left: number, ahead: number): { x: number; z: number } {
  return {
    x: r.x - Math.sin(r.heading) * left + Math.cos(r.heading) * ahead,
    z: r.z - Math.cos(r.heading) * left - Math.sin(r.heading) * ahead,
  };
}

function headingAlong(roads: RoadGraph, e: RoadEdge, dir: Dir, s: number): number {
  const p = roads.pointAt(e, dir > 0 ? s : e.length - s);
  return dir > 0 ? p.heading : p.heading + Math.PI;
}

/** The driver's door (right side, local +z), just outside it. */
function doorOf(car: Car): { x: number; z: number } {
  const p = car.body.translation();
  const h = headingOf(car);
  return { x: p.x + Math.sin(h) * 1.7, z: p.z + Math.cos(h) * 1.7 };
}

function headingOf(car: Car): number {
  const r = car.body.rotation();
  const f = _fwd.set(1, 0, 0).applyQuaternion(_q.set(r.x, r.y, r.z, r.w));
  return Math.atan2(-f.z, f.x);
}

/** How far the point is off the way it's heading, rad (positive: to the right). */
function angleTo(heading: number, from: { x: number; z: number }, to: { x: number; z: number }): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const fwd = dx * Math.cos(heading) + dz * -Math.sin(heading);
  const right = dx * Math.sin(heading) + dz * Math.cos(heading);
  return Math.atan2(right, fwd);
}

/** Chassis boxes close enough to be touching (a little margin)? */
function touching(a: Car, b: Car): boolean {
  const pa = a.body.translation();
  const pb = b.body.translation();
  const ha = headingOf(a);
  const hb = headingOf(b);
  // Each one's corners against the other's box.
  for (const [h1, h2, p1, p2] of [[ha, hb, pa, pb], [hb, ha, pb, pa]] as const) {
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const cx = p1.x + Math.cos(h1) * sx * (COROLLA.length / 2) + Math.sin(h1) * sz * (COROLLA.width / 2);
        const cz = p1.z - Math.sin(h1) * sx * (COROLLA.length / 2) + Math.cos(h1) * sz * (COROLLA.width / 2);
        const dx = cx - p2.x;
        const dz = cz - p2.z;
        const along = dx * Math.cos(h2) - dz * Math.sin(h2);
        const across = dx * Math.sin(h2) + dz * Math.cos(h2);
        if (Math.abs(along) < COROLLA.length / 2 + 0.25 && Math.abs(across) < COROLLA.width / 2 + 0.25) return true;
      }
    }
  }
  return false;
}

function hold(c: DriveControls): void {
  c.throttle = 0;
  c.brake = 0;
  c.steer = 0;
  c.handbrake = true;
}

function setState(p: Ped, s: Ped['state']): void {
  p.state = s;
  p.t = 0;
}

function say(p: Ped, text: string): void {
  p.says = text;
  p.saysFor = text ? 2 : 0;
}

function dist(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function inView(dx: number, dz: number, yaw: number): boolean {
  const d = Math.hypot(dx, dz);
  if (d < 1e-3) return true;
  const off = Math.acos(Math.max(-1, Math.min(1, (dx * Math.cos(yaw) + dz * Math.sin(yaw)) / d)));
  return off < VIEW_HALF_ANGLE;
}

const pick = <T,>(r: () => number, list: readonly T[]) => list[Math.floor(r() * list.length) % list.length];
