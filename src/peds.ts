import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Dir, RoadEdge, RoadGraph } from './city/road-graph.ts';
import { crowd } from './graphics.ts';
import { knob, mechanic } from './tweaks.ts';

// Pedestrians: a handful of people walking the footpaths near the player,
// following the road graph offset out to the kerb. They spawn out of sight
// and go when you're far away. No colliders: a car that reaches one launches
// them on a scripted arc (bounce, rest, get up, react), and walking into one
// nudges them aside. Seeded randomness and fixed ticks, so smoke runs repeat.
// Each client runs its own (they aren't shared in rooms).

export const PEDS = mechanic('peds', 'Pedestrians', true, {
  count: knob(23, 'How many', 0, 40, 1),
  spawnRadius: knob(50, 'Spawn within', 25, 200, 5, 'm'),
  walkSpeed: knob(1.5, 'Walking pace', 0.5, 3, 0.05, 'm/s'),
  stumbleSpeed: knob(6, 'Running into them knocks you both over above', 2, 12, 0.25, 'm/s'),
});

export const HITS = mechanic('hits', 'Bouncy hits', true, {
  minSpeed: knob(2.5, 'Car faster than', 0.5, 15, 0.5, 'm/s'),
  launch: knob(0.85, 'Launch (share of car speed)', 0, 3, 0.05),
  upBoost: knob(6, 'Up boost', 0, 20, 0.5, 'm/s'),
  spin: knob(7, 'Spin', 0, 30, 0.5, 'rad/s'),
  bounce: knob(0.45, 'Bounciness', 0, 0.95, 0.05),
  timeDown: knob(1.4, 'Time lying down', 0, 8, 0.1, 's'),
  oi: knob(1, 'Reaction: shake a fist, "Oi!"', 0, 1, 0.05),
  chase: knob(0.6, 'Reaction: chase you', 0, 1, 0.05),
  shrug: knob(0.5, 'Reaction: dust off, carry on', 0, 1, 0.05),
});

/** Footpaths are this far out from the kerb (the carriageway's edge), m: clear of cars parked half up on it (src/traffic.ts). */
const KERB_GAP = 2;
/** Never spawn closer than this, m. */
const MIN_SPAWN = 22;
/** In the camera's view: within this angle of where it looks (wider than half the FOV). */
const VIEW_HALF_ANGLE = (65 * Math.PI) / 180;
/** Past this, spawning in view is fine: a few pixels in the distance. */
const VIEW_FAR = 50;
/** Go once this many spawn radii away. */
const DESPAWN = 1.4;
const GRAVITY = 18; // a little floaty: it's a cartoon
const CHASE_SPEED = 4.3;
const CHASE_TIME = 3;
const GETUP_TIME = 0.6;
/** Stars after getting up (and after a stumble), s. */
const DAZED = 3;
const STUMBLE_DAZED = 1.4;
/** A body is this far from its centre to the edge (for car tests), m. */
const BODY_RADIUS = 0.3;
const PERSON_RADIUS = 0.55;
/** Not hit again by the same car for this long, s (it's still overlapping). */
const HIT_COOLDOWN = 0.8;
/** No footpaths on these. */
const NO_WALK = new Set(['motorway', 'motorway_link', 'trunk_link']);
const WALKABLE = new Set(['footpath', 'paving', 'path', 'urban']);

/** 'cop', 'tackle' and 'scold' are police officers' (src/cops/cops.ts moves them; here they only keep to the ground). */
export type PedState = 'walk' | 'wait' | 'fly' | 'down' | 'getup' | 'react' | 'chase' | 'stumble' | 'cop' | 'tackle' | 'scold';
export type Reaction = 'oi' | 'chase' | 'shrug';

export interface Look {
  skin: THREE.Color;
  top: THREE.Color;
  bottom: THREE.Color;
  hair: number;
  shoes: number;
  trousers: boolean;
  sleeves: boolean;
  height: number;
  build: number;
}

export interface Ped {
  id: number;
  x: number;
  y: number;
  z: number;
  /** Where it was a tick ago, for drawing between ticks. */
  px: number;
  py: number;
  pz: number;
  heading: number;
  /** Ground height under them (for the shadow while they fly). */
  floor: number;
  state: PedState;
  /** Time in this state, s. */
  t: number;
  /** Walking: the edge, which way, metres along it in that direction, and which side (1: left of travel). */
  edge: RoadEdge;
  dir: Dir;
  s: number;
  side: 1 | -1;
  offset: number;
  pace: number;
  vx: number;
  vy: number;
  vz: number;
  /** Tumbling: orientation, and the spin axis and rate. */
  q: THREE.Quaternion;
  pq: THREE.Quaternion;
  spinAxis: THREE.Vector3;
  spinRate: number;
  reaction: Reaction;
  /** Stars over the head, s left. */
  dazed: number;
  /** Walk cycle, rad. */
  phase: number;
  look: Look;
  /** What they're saying, and for how much longer. */
  says: string;
  saysFor: number;
  /** A test ped (?debug spawnPed): stands still, never despawns. */
  pinned: boolean;
  /** A police officer (src/cops/): kept by the cops, not culled or counted here. */
  role: 'ped' | 'cop';
  kept: boolean;
  /** Riding a bicycle (officers): quicker, and knocked off it by a car. */
  bike: boolean;
  hitBy: number;
  hitAt: number;
  bounces: number;
  /** Highest it went above the ground this flight (?debug). */
  peak: number;
}

export type PedEvent =
  | { kind: 'hit'; x: number; y: number; z: number; speed: number; byPlayer: boolean; cop: boolean }
  | { kind: 'unseated'; x: number; y: number; z: number; heading: number }
  | { kind: 'bounce'; x: number; y: number; z: number; strength: number }
  | { kind: 'bark'; x: number; y: number; z: number; pitch: number };

/** A car as the peds see it: body, chassis half-size, whether it's the player's. */
export interface CarLike {
  body: RAPIER.RigidBody;
  half: { x: number; y: number; z: number };
  player: boolean;
}

export interface CarVelocity {
  vx: number;
  vy: number;
  vz: number;
  speed: number;
}

/**
 * How fast each car moved over the last tick, from where it was: works for
 * kinematic ones too (someone else driving it), whose bodies report no velocity.
 */
export class CarSpeeds {
  private readonly prev = new Map<RAPIER.RigidBody, { x: number; y: number; z: number }>();

  /** Call once per tick, after world.step(). Null for a car seen for the first time, or teleported. */
  measure(cars: readonly CarLike[], dt: number): (CarVelocity | null)[] {
    return cars.map((c) => {
      const t = c.body.translation();
      const prev = this.prev.get(c.body);
      this.prev.set(c.body, { x: t.x, y: t.y, z: t.z });
      if (!prev) return null;
      const vx = (t.x - prev.x) / dt;
      const vy = (t.y - prev.y) / dt;
      const vz = (t.z - prev.z) / dt;
      const speed = Math.hypot(vx, vy, vz);
      // A teleport (reset, rescue) isn't a speed.
      return speed > 80 ? null : { vx, vy, vz, speed };
    });
  }

  reset(): void {
    this.prev.clear();
  }
}

/** Small, fast and seedable (mulberry32), so the same seed gives the same crowd. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Skin from pale to deep brown; 90s clothes; a few hair colours (peds-mesh.ts has the palettes for hair and shoes).
const SKINS = [0xf1d0b5, 0xe0b48f, 0xc68a62, 0xa86d47, 0x8d5a3b, 0x6b4029, 0x4a2c1d];
const TOPS = [0x1d1d22, 0xf3f0e6, 0x2a8c8c, 0x6a3d9a, 0xd8a22b, 0xc0392b, 0x22355e, 0xe86a1c, 0x3d7a3a, 0xd46a9a, 0x7f8c8d];
const BOTTOMS = [0x30486e, 0x23262c, 0xb5a27a, 0x6b6e73, 0x4a3b2a, 0x1c2b4a];
export const HAIR_COUNT = 6;
export const SHOE_COUNT = 4;

const pick = <T,>(r: () => number, list: readonly T[]) => list[Math.floor(r() * list.length) % list.length];

function makeLook(r: () => number): Look {
  return {
    skin: new THREE.Color(pick(r, SKINS)),
    top: new THREE.Color(pick(r, TOPS)),
    bottom: new THREE.Color(pick(r, BOTTOMS)),
    hair: Math.floor(r() * HAIR_COUNT),
    shoes: Math.floor(r() * SHOE_COUNT),
    trousers: r() < 0.6,
    sleeves: r() < 0.35,
    height: 0.92 + r() * 0.16,
    build: 0.9 + r() * 0.25,
  };
}

const SAY: Record<Reaction, string[]> = {
  oi: ['Oi!', 'Oi! Watch it!', 'Oi, egg!', 'Far out!'],
  chase: ['Oi! Come back here!', 'Get back here!', 'Oi! You!'],
  shrug: ['…sweet as.', 'All good.', 'She\'ll be right.'],
};
const STUMBLE_SAY = ['Oof!', 'Watch it!', 'Steady on!', 'Oi!'];
const COP_HIT_SAY = ['Right. That\'s assault, that is.', 'Oi! I\'m the police!', 'You\'ll keep, mate.', 'Not the uniform!'];

/** Police blue shirt, navy trousers and cap (the cap is the "hair": HAIR[6] in peds-mesh.ts). */
export const COP_HAT = 6;
export function copLook(r: () => number): Look {
  return {
    skin: new THREE.Color(pick(r, SKINS)), top: new THREE.Color(0x9cc0e2), bottom: new THREE.Color(0x1b2238),
    hair: COP_HAT, shoes: 0, trousers: true, sleeves: true, height: 1 + r() * 0.08, build: 1 + r() * 0.12,
  };
}

const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

export interface PedWorld {
  roads: RoadGraph;
  world: RAPIER.World;
  heightAt(x: number, z: number): number;
  surfaceAt?(x: number, z: number): string | null;
}

export class Peds {
  readonly list: Ped[] = [];
  readonly events: PedEvent[] = [];
  private readonly w: PedWorld;
  /** Walkable edges at each node. */
  private readonly at = new Map<number, RoadEdge[]>();
  private readonly walkable: RoadEdge[];
  private readonly boxes: Float32Array;
  private readonly nearBy = new Map<number, { x: number; z: number; list: RoadEdge[]; total: number }>();
  private rand = rng(1);
  private nextId = 1;
  private clock = 0;
  /** ?debug: hits and how many got back up. */
  stats = { spawned: 0, hits: 0, bumps: 0, stumbles: 0, gotUp: 0 };

  constructor(w: PedWorld) {
    this.w = w;
    this.walkable = w.roads.edges.filter((e) => !e.bridge && !NO_WALK.has(e.highway));
    for (const e of this.walkable) {
      for (const n of [e.a, e.b]) {
        let l = this.at.get(n);
        if (!l) this.at.set(n, (l = []));
        l.push(e);
      }
    }
    this.boxes = new Float32Array(this.walkable.length * 4);
    for (const [i, e] of this.walkable.entries()) {
      let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let k = 0; k < e.pts.length; k += 3) {
        x0 = Math.min(x0, e.pts[k]);
        z0 = Math.min(z0, e.pts[k + 1]);
        x1 = Math.max(x1, e.pts[k]);
        z1 = Math.max(z1, e.pts[k + 1]);
      }
      this.boxes.set([x0, z0, x1, z1], i * 4);
    }
  }

  /** Everyone gone and the dice back to `seed` (?debug reset, so smoke areas repeat). */
  reset(seed = 1): void {
    this.list.length = 0;
    this.events.length = 0;
    this.rand = rng(seed);
    this.nextId = 1;
    this.clock = 0;
    this.nearBy.clear();
    this.stats = { spawned: 0, hits: 0, bumps: 0, stumbles: 0, gotUp: 0 };
  }

  /**
   * One fixed tick, after world.step(). `focus` is where the player is
   * (on foot or in a car), `yaw` where the camera looks (atan2(z, x)).
   * `onFoot` is the player's capsule when walking, for nudges and stumbles.
   */
  step(dt: number, focus: { x: number; z: number }, yaw: number, cars: readonly CarLike[], speeds: readonly (CarVelocity | null)[], onFoot: { x: number; y: number; z: number; vx: number; vz: number; speed: number } | null): { stumble: { x: number; z: number } | null } {
    this.clock += dt;
    let stumble: { x: number; z: number } | null = null;
    if (!PEDS.on) {
      // Nobody about, but the police (src/cops/) keep theirs.
      for (let i = this.list.length - 1; i >= 0; i--) if (!this.list[i].kept) this.list.splice(i, 1);
    } else {
      this.cull(focus);
      this.spawn(focus, yaw);
    }

    for (const p of this.list) {
      p.px = p.x;
      p.py = p.y;
      p.pz = p.z;
      p.pq.copy(p.q);
      p.t += dt;
      p.saysFor = Math.max(0, p.saysFor - dt);
      p.dazed = Math.max(0, p.dazed - dt);
      if (p.state === 'fly') this.fly(p, dt);
      else this.onGround(p, dt, focus);

      if (p.state !== 'fly') {
        for (const [i, c] of cars.entries()) {
          const v = speeds[i];
          if (!v || !HITS.on || v.speed < HITS.minSpeed) continue;
          if (p.hitBy === i && this.clock - p.hitAt < HIT_COOLDOWN) continue;
          if (inside(c, p.x, p.y + 0.9, p.z, BODY_RADIUS)) this.launch(p, c, v, i);
        }
      }
      if (onFoot && p.state !== 'fly' && p.state !== 'down') {
        const dx = p.x - onFoot.x;
        const dz = p.z - onFoot.z;
        const d = Math.hypot(dx, dz);
        if (d < PERSON_RADIUS * 2 && Math.abs(p.y + 0.9 - onFoot.y) < 1.5) {
          const nx = d > 1e-4 ? dx / d : Math.cos(p.heading + Math.PI / 2);
          const nz = d > 1e-4 ? dz / d : -Math.sin(p.heading + Math.PI / 2);
          if (onFoot.speed > PEDS.stumbleSpeed && p.state !== 'stumble' && p.state !== 'getup') {
            this.stumble(p, onFoot.vx, onFoot.vz);
            stumble = { x: -nx, z: -nz };
          } else {
            // Step aside: out of the way, and they carry on.
            p.x = onFoot.x + nx * PERSON_RADIUS * 2;
            p.z = onFoot.z + nz * PERSON_RADIUS * 2;
            this.stats.bumps++;
          }
        }
      }
    }
    return { stumble };
  }

  /** ?debug: put someone standing still at (x, z), facing `heading`. */
  spawnAt(x: number, z: number, heading = 0): Ped | null {
    const snap = this.w.roads.nearest(x, z, { within: 80, open: false });
    if (!snap) return null;
    const p = this.make(snap.edge, 1, 0, snap.left ? 1 : -1, x, z);
    p.heading = heading;
    p.state = 'wait';
    p.t = 0;
    p.pinned = true;
    this.relink(p);
    this.list.push(p);
    return p;
  }

  /**
   * A driver turfed out of their car (you took it): standing on the road at
   * (x, z), facing `heading`, and they have something to say about it.
   */
  turfOut(x: number, z: number, heading: number, player: { x: number; z: number }): Ped | null {
    if (!PEDS.on) return null;
    const snap = this.w.roads.nearest(x, z, { within: 80, open: false });
    if (!snap) return null;
    const p = this.make(snap.edge, 1, 0, snap.left ? 1 : -1, x, z);
    p.heading = heading;
    this.relink(p);
    this.list.push(p);
    this.react(p, player);
    return p;
  }

  private launch(p: Ped, c: CarLike, v: CarVelocity, index: number): void {
    const t = c.body.translation();
    // Mostly along the car, a little away from its middle (a glancing blow throws you sideways).
    let ax = p.x - t.x;
    let az = p.z - t.z;
    const al = Math.hypot(ax, az) || 1;
    ax /= al;
    az /= al;
    const k = HITS.launch;
    p.vx = v.vx * k + ax * (1 + v.speed * 0.1);
    p.vz = v.vz * k + az * (1 + v.speed * 0.1);
    p.vy = HITS.upBoost + v.speed * 0.25 * k;
    // Head over heels along the way they're going, with a bit of cartwheel.
    _axis.set(p.vz, 0, -p.vx);
    if (_axis.lengthSq() < 1e-6) _axis.set(0, 0, 1);
    _axis.normalize();
    _axis.y += (this.rand() - 0.5) * 0.8;
    p.spinAxis.copy(_axis.normalize());
    p.spinRate = HITS.spin * (0.6 + this.rand() * 0.8) * Math.min(1.5, 0.4 + v.speed / 12);
    this.setState(p, 'fly');
    p.hitBy = index;
    p.hitAt = this.clock;
    p.bounces = 0;
    p.peak = 0;
    p.y += 0.05;
    this.stats.hits++;
    this.events.push({ kind: 'hit', x: p.x, y: p.y, z: p.z, speed: v.speed, byPlayer: c.player, cop: p.role === 'cop' });
    if (p.bike) {
      // Off the bike, which stays where it fell.
      p.bike = false;
      this.events.push({ kind: 'unseated', x: p.x, y: p.y, z: p.z, heading: p.heading });
    }
  }

  private stumble(p: Ped, vx: number, vz: number): void {
    p.vx = vx * 0.5;
    p.vz = vz * 0.5;
    p.vy = 2;
    this.setState(p, 'stumble');
    p.dazed = STUMBLE_DAZED;
    this.say(p, pick(this.rand, STUMBLE_SAY), 1.4);
    this.stats.stumbles++;
  }

  private fly(p: Ped, dt: number): void {
    p.vy -= GRAVITY * dt;
    let nx = p.x + p.vx * dt;
    let nz = p.z + p.vz * dt;
    // Into a wall: bounce back off it.
    const len = Math.hypot(nx - p.x, nz - p.z);
    if (len > 1e-4) {
      _ray.origin = { x: p.x, y: p.y + 0.9, z: p.z };
      _ray.dir = { x: (nx - p.x) / len, y: 0, z: (nz - p.z) / len };
      const hit = this.w.world.castRayAndGetNormal(_ray, len + 0.3, true, RAPIER.QueryFilterFlags.ONLY_FIXED);
      if (hit && Math.abs(hit.normal.y) < 0.6) {
        const dot = p.vx * hit.normal.x + p.vz * hit.normal.z;
        p.vx = (p.vx - 2 * dot * hit.normal.x) * HITS.bounce;
        p.vz = (p.vz - 2 * dot * hit.normal.z) * HITS.bounce;
        nx = p.x;
        nz = p.z;
        this.events.push({ kind: 'bounce', x: p.x, y: p.y, z: p.z, strength: Math.min(1, Math.abs(dot) / 10) });
      }
    }
    p.x = nx;
    p.z = nz;
    p.y += p.vy * dt;
    _q.setFromAxisAngle(p.spinAxis, p.spinRate * dt);
    p.q.premultiply(_q).normalize();
    const g = this.ground(p);
    p.floor = g;
    p.peak = Math.max(p.peak, p.y - g);
    if (p.y > g) return;
    p.y = g;
    if (p.vy < -2.5 && p.bounces < 6) {
      // Bounce: up again, slower each time.
      this.events.push({ kind: 'bounce', x: p.x, y: p.y, z: p.z, strength: Math.min(1, -p.vy / 12) });
      p.vy = -p.vy * HITS.bounce;
      p.vx *= 0.65;
      p.vz *= 0.65;
      p.spinRate *= 0.6;
      p.bounces++;
      if (p.vy > 1.2) return;
    }
    p.vx = p.vy = p.vz = 0;
    this.setState(p, 'down');
    p.dazed = HITS.timeDown + GETUP_TIME + DAZED;
  }

  private onGround(p: Ped, dt: number, player: { x: number; z: number } | null): void {
    switch (p.state) {
      case 'stumble': {
        // A short stagger backwards, then on their way.
        p.x += p.vx * dt;
        p.z += p.vz * dt;
        p.vx *= Math.exp(-dt * 4);
        p.vz *= Math.exp(-dt * 4);
        if (p.t > 0.9) this.resume(p);
        break;
      }
      case 'down':
        if (p.t > HITS.timeDown) this.setState(p, 'getup');
        break;
      case 'getup':
        if (p.t > GETUP_TIME) {
          this.stats.gotUp++;
          this.react(p, player);
        }
        break;
      case 'react':
        if (player && p.reaction === 'oi') p.heading = Math.atan2(-(player.z - p.z), player.x - p.x);
        if (p.t > (p.reaction === 'shrug' ? 1.6 : 2)) this.resume(p);
        break;
      case 'chase': {
        if (!player || p.t > CHASE_TIME) {
          this.resume(p);
          break;
        }
        const dx = player.x - p.x;
        const dz = player.z - p.z;
        const d = Math.hypot(dx, dz);
        p.heading = Math.atan2(-dz, dx);
        if (d < 1.4) {
          // Caught up: give them a piece of their mind instead.
          p.reaction = 'oi';
          this.setState(p, 'react');
          this.say(p, pick(this.rand, SAY.oi), 1.8);
          break;
        }
        const step = Math.min(d, CHASE_SPEED * (p.dazed > 0 ? 0.7 : 1) * dt);
        p.x += (dx / d) * step;
        p.z += (dz / d) * step;
        p.phase += dt * 11;
        break;
      }
      case 'wait':
        if (!p.pinned && p.t > 2.5) this.setState(p, 'walk');
        break;
      case 'cop':
      case 'tackle':
      case 'scold':
        // Moved by the cops; the ground below is all that's done here.
        break;
      case 'walk':
        this.walk(p, dt);
        break;
    }
    p.y = p.floor = this.ground(p);
  }

  private walk(p: Ped, dt: number): void {
    const pace = p.pace * PEDS.walkSpeed * (p.dazed > 0 ? 0.55 : 1) * (p.bike ? 2.6 : 1);
    p.s += pace * dt;
    if (p.s >= p.edge.length) {
      if (!this.turn(p)) return;
    }
    this.pathPoint(p);
    const dx = this.pathX - p.x;
    const dz = this.pathZ - p.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.02) {
      // Catch up with the point on the path, a little quicker than it moves (corners, and back after a nudge).
      const step = Math.min(d, (pace * 1.5 + 0.3) * dt);
      p.x += (dx / d) * step;
      p.z += (dz / d) * step;
      const want = Math.atan2(-dz, dx);
      const turn = Math.atan2(Math.sin(want - p.heading), Math.cos(want - p.heading));
      p.heading += turn * Math.min(1, dt * 8);
    }
    p.phase += dt * (3 + pace * 3.2);
  }

  /** At the end of the edge: on to another one from that junction (back the way they came at a dead end). */
  private turn(p: Ped): boolean {
    const node = p.dir > 0 ? p.edge.b : p.edge.a;
    const options = (this.at.get(node) ?? []).filter((e) => e !== p.edge);
    const next = options.length ? pick(this.rand, options) : p.edge;
    p.dir = next.a === node ? 1 : -1;
    // A loop edge (both ends the same node) goes either way: dir 1 is fine.
    p.edge = next;
    p.s = 0;
    p.offset = next.width / 2 + KERB_GAP;
    // Now and then, wait at the corner for a moment (to cross).
    if (this.rand() < 0.25) this.setState(p, 'wait');
    return true;
  }

  private pathX = 0;
  private pathZ = 0;

  /** The point on the footpath they're heading for: `s` along their edge, out to their side. */
  private pathPoint(p: Pick<Ped, 'edge' | 'dir' | 's' | 'side' | 'offset'>): void {
    const c = this.w.roads.pointAt(p.edge, p.dir > 0 ? p.s : p.edge.length - p.s);
    const h = p.dir > 0 ? c.heading : c.heading + Math.PI;
    // Left of the way they walk is (-sin h, -cos h), as in RoadGraph.lane().
    this.pathX = c.x - Math.sin(h) * p.offset * p.side;
    this.pathZ = c.z - Math.cos(h) * p.offset * p.side;
  }

  /** Back to walking from wherever they've ended up: onto the nearest road's footpath, either way along it. */
  private resume(p: Ped): void {
    this.relink(p);
    this.setState(p, 'walk');
  }

  private relink(p: Ped): void {
    const snap = this.w.roads.nearest(p.x, p.z, { within: 120, open: false });
    if (!snap || !this.walkable.includes(snap.edge)) return;
    const dir: Dir = this.rand() < 0.5 ? 1 : -1;
    p.edge = snap.edge;
    p.dir = dir;
    p.s = dir > 0 ? snap.s : snap.edge.length - snap.s;
    p.side = ((snap.left ? 1 : -1) * dir) as 1 | -1;
    p.offset = snap.edge.width / 2 + KERB_GAP;
  }

  private react(p: Ped, player: { x: number; z: number } | null): void {
    if (p.role === 'cop') {
      // Officers don't chase off in a huff: they tell you off, then get back to it (the cops take over again).
      p.reaction = 'oi';
      this.setState(p, 'react');
      this.say(p, pick(this.rand, COP_HIT_SAY), 2);
      this.events.push({ kind: 'bark', x: p.x, y: p.y, z: p.z, pitch: 0.75 });
      return;
    }
    const w = { oi: HITS.oi, chase: player ? HITS.chase : 0, shrug: HITS.shrug };
    const total = w.oi + w.chase + w.shrug;
    let r = this.rand() * total;
    let reaction: Reaction = 'shrug';
    for (const k of ['oi', 'chase', 'shrug'] as Reaction[]) {
      if (r < w[k]) {
        reaction = k;
        break;
      }
      r -= w[k];
    }
    if (total <= 0) return this.resume(p);
    p.reaction = reaction;
    this.setState(p, reaction === 'chase' ? 'chase' : 'react');
    this.say(p, pick(this.rand, SAY[reaction]), reaction === 'shrug' ? 1.6 : 2);
    if (reaction !== 'shrug') this.events.push({ kind: 'bark', x: p.x, y: p.y, z: p.z, pitch: 0.8 + this.rand() * 0.5 });
  }

  private say(p: Ped, text: string, time: number): void {
    p.says = text;
    p.saysFor = time;
  }

  private setState(p: Ped, s: PedState): void {
    p.state = s;
    p.t = 0;
  }

  private ground(p: Ped): number {
    const h = this.w.heightAt(p.x, p.z);
    return Number.isNaN(h) ? p.y : h;
  }

  /** Too far away (or too many after the count went down): gone. */
  private cull(focus: { x: number; z: number }): void {
    const far = PEDS.spawnRadius * DESPAWN;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      if (!p.pinned && !p.kept && Math.hypot(p.x - focus.x, p.z - focus.z) > far) this.list.splice(i, 1);
    }
    while (this.list.filter((p) => !p.kept).length > crowd(PEDS.count)) {
      // The furthest first.
      let worst = -1;
      let worstD = -1;
      for (const [i, p] of this.list.entries()) {
        const d = Math.hypot(p.x - focus.x, p.z - focus.z);
        if (!p.pinned && !p.kept && d > worstD) {
          worst = i;
          worstD = d;
        }
      }
      if (worst < 0) break;
      this.list.splice(worst, 1);
    }
  }

  /** Up to the count, one a tick: on a footpath near the focus, out of the camera's view (or far off). */
  private spawn(focus: { x: number; z: number }, yaw: number): void {
    if (this.list.filter((p) => !p.pinned && !p.kept).length >= crowd(PEDS.count)) return;
    const spot = this.pickSpot(focus, yaw, MIN_SPAWN, PEDS.spawnRadius, VIEW_FAR);
    if (!spot) return;
    const p = this.make(spot.edge, spot.dir, spot.s, spot.side, spot.x, spot.z);
    p.heading = spot.heading;
    this.list.push(p);
    this.stats.spawned++;
  }

  /**
   * A police officer on the footpath between `min` and `max` from the focus,
   * out of the camera's view (inside `viewFar`): on foot, or on a bicycle.
   * Kept: the cops decide when they go (remove()).
   */
  spawnOfficer(focus: { x: number; z: number }, yaw: number, min: number, max: number, bike: boolean, viewFar = 120): Ped | null {
    const spot = this.pickSpot(focus, yaw, min, max, viewFar, max);
    if (!spot) return null;
    return this.officerAt(spot.x, spot.z, spot.heading, bike, spot);
  }

  /** An officer standing at (x, z) (getting out of a car, or ?debug spawnCop). */
  officerAt(x: number, z: number, heading: number, bike: boolean, at?: { edge: RoadEdge; dir: Dir; s: number; side: number }): Ped | null {
    const snap = at ?? (() => {
      const n = this.w.roads.nearest(x, z, { within: 80, open: false });
      return n && { edge: n.edge, dir: 1 as Dir, s: n.s, side: n.left ? 1 : -1 };
    })();
    if (!snap) return null;
    const p = this.make(snap.edge, snap.dir, snap.s, snap.side, x, z);
    p.look = copLook(this.rand);
    p.role = 'cop';
    p.kept = true;
    p.bike = bike;
    p.heading = heading;
    p.pace = 0.95 + this.rand() * 0.1;
    this.list.push(p);
    return p;
  }

  remove(p: Ped): void {
    const i = this.list.indexOf(p);
    if (i >= 0) this.list.splice(i, 1);
  }

  /** Back to walking the footpath from where they are (an officer off duty again). */
  release(p: Ped): void {
    this.resume(p);
  }

  /** The dice, for the cops' own choices (so a seed repeats everything). */
  random(): number {
    return this.rand();
  }

  /** A walkable spot on a footpath near the focus, out of view inside `viewFar`, between `min` and `max` away. */
  private pickSpot(focus: { x: number; z: number }, yaw: number, min: number, max: number, viewFar: number, searchRadius = PEDS.spawnRadius): { edge: RoadEdge; dir: Dir; s: number; side: number; x: number; z: number; heading: number } | null {
    const r = Math.max(searchRadius, max);
    // The edges round here, kept per radius (the crowd's and the officers' differ) until the focus moves on.
    let cache = this.nearBy.get(r);
    if (!cache || Math.hypot(focus.x - cache.x, focus.z - cache.z) > 20) {
      const list = this.walkable.filter((_, i) => {
        const b = this.boxes;
        const dx = Math.max(b[i * 4] - focus.x, 0, focus.x - b[i * 4 + 2]);
        const dz = Math.max(b[i * 4 + 1] - focus.z, 0, focus.z - b[i * 4 + 3]);
        return Math.hypot(dx, dz) < r + 20;
      });
      this.nearBy.set(r, (cache = { x: focus.x, z: focus.z, list, total: list.reduce((n, e) => n + e.length, 0) }));
    }
    const near = cache.list;
    const total = cache.total;
    if (!total) return null;
    for (let attempt = 0; attempt < 4; attempt++) {
      let pickLen = this.rand() * total;
      let edge = near[near.length - 1];
      for (const e of near) {
        if (pickLen < e.length) {
          edge = e;
          break;
        }
        pickLen -= e.length;
      }
      const dir: Dir = this.rand() < 0.5 ? 1 : -1;
      const side = this.rand() < 0.5 ? 1 : -1;
      const s = this.rand() * edge.length;
      this.pathPoint({ edge, dir, s, side, offset: edge.width / 2 + KERB_GAP });
      const x = this.pathX;
      const z = this.pathZ;
      const dx = x - focus.x;
      const dz = z - focus.z;
      const d = Math.hypot(dx, dz);
      if (d < min || d > max) continue;
      const off = Math.acos(Math.max(-1, Math.min(1, (dx * Math.cos(yaw) + dz * Math.sin(yaw)) / d)));
      if (off < VIEW_HALF_ANGLE && d < viewFar) continue;
      if (Number.isNaN(this.w.heightAt(x, z))) continue;
      const surface = this.w.surfaceAt?.(x, z);
      if (surface !== undefined && !WALKABLE.has(surface ?? '')) continue;
      const heading = edge.length ? this.w.roads.pointAt(edge, dir > 0 ? s : edge.length - s).heading + (dir > 0 ? 0 : Math.PI) : 0;
      return { edge, dir, s, side, x, z, heading };
    }
    return null;
  }

  private make(edge: RoadEdge, dir: Dir, s: number, side: number, x: number, z: number): Ped {
    const y = this.w.heightAt(x, z);
    return {
      id: this.nextId++, x, y: Number.isNaN(y) ? 0 : y, z, px: x, py: Number.isNaN(y) ? 0 : y, pz: z, heading: 0, floor: Number.isNaN(y) ? 0 : y, state: 'walk', t: 0,
      edge, dir, s, side: side > 0 ? 1 : -1, offset: edge.width / 2 + KERB_GAP, pace: 0.8 + this.rand() * 0.4,
      vx: 0, vy: 0, vz: 0, q: new THREE.Quaternion(), pq: new THREE.Quaternion(), spinAxis: new THREE.Vector3(1, 0, 0), spinRate: 0,
      reaction: 'oi', dazed: 0, phase: this.rand() * Math.PI * 2, look: makeLook(this.rand), says: '', saysFor: 0,
      pinned: false, role: 'ped', kept: false, bike: false, hitBy: -1, hitAt: -Infinity, bounces: 0, peak: 0,
    };
  }

  /** For ?debug. */
  debug() {
    return this.list.map((p) => ({
      id: p.id, state: p.state, pos: [p.x, p.y, p.z], ground: this.ground(p), heading: p.heading, dazed: p.dazed > 0, says: p.saysFor > 0 ? p.says : '',
      reaction: p.reaction, peak: p.peak, bounces: p.bounces, pinned: p.pinned, role: p.role, bike: p.bike, surface: this.w.surfaceAt?.(p.x, p.z) ?? null,
    }));
  }
}

const _local = new THREE.Vector3();
const _rot = new THREE.Quaternion();

/** Is (x, y, z) within `margin` of the car's chassis box? */
export function inside(c: CarLike, x: number, y: number, z: number, margin: number): boolean {
  const t = c.body.translation();
  const r = c.body.rotation();
  _local.set(x - t.x, y - t.y, z - t.z).applyQuaternion(_rot.set(-r.x, -r.y, -r.z, r.w));
  return Math.abs(_local.x) < c.half.x + margin && Math.abs(_local.z) < c.half.z + margin && Math.abs(_local.y) < c.half.y + 1.1;
}
