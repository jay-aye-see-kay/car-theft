import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Car } from '../car.ts';
import { copLook, rng, type Ped } from '../peds.ts';
import type { Pose } from '../net/protocol.ts';

// Other players' cops, as we see them in a room: their client runs them
// (src/cops/cops.ts) and sends the chase cars and officers in its pose. The
// cars are kinematic stand-ins here, so our car bumps into them (and they
// into us: friends can get in the way); the officers are drawn with the
// pedestrians, nothing more.

/** Police cars we can show for others (five others, a few cars each). */
export const REMOTE_COP_CARS = 15;

interface Puppet {
  car: Car;
  /** Whose and which of theirs, or '' when it's not in use. */
  key: string;
}

const POLICE_PAINT = 0xf4f4f0;
const _far = new THREE.Vector3(0, -400, 0);

export class RemoteCops {
  readonly puppets: Puppet[] = [];
  private readonly officers = new Map<string, Ped>();
  private readonly world: RAPIER.World;
  private readonly rand = rng(26);
  private nextId = 100000;

  constructor(world: RAPIER.World) {
    this.world = world;
  }

  /** The cars to draw (in use only). */
  cars(): Car[] {
    return this.puppets.filter((p) => p.key).map((p) => p.car);
  }

  /** Every stand-in car (for the fleet's capacity). */
  get capacity(): number {
    return REMOTE_COP_CARS;
  }

  /** Each tick, before world.step(): the cars to where their owners have them. */
  beforeStep(remote: { id: number; k: NonNullable<Pose['k']> }[]): void {
    const want = new Set<string>();
    for (const r of remote) for (let i = 0; i < r.k.length; i++) want.add(`${r.id}:${i}`);
    // Let go of ones that aren't wanted any more.
    for (const p of this.puppets) {
      if (p.key && !want.has(p.key)) {
        p.key = '';
        p.car.siren = false;
        p.car.body.setEnabled(false);
        p.car.place(_far, 0);
      }
    }
    for (const r of remote) {
      for (const [i, k] of r.k.entries()) {
        const key = `${r.id}:${i}`;
        let p = this.puppets.find((q) => q.key === key);
        if (!p) {
          p = this.puppets.find((q) => !q.key) ?? this.make() ?? undefined;
          if (!p) continue;
          p.key = key;
          p.car.body.setEnabled(true);
          p.car.place(new THREE.Vector3(k[0], k[1], k[2]), 0);
          p.car.body.setRotation({ x: k[3], y: k[4], z: k[5], w: k[6] }, true);
        }
        p.car.body.setNextKinematicTranslation({ x: k[0], y: k[1], z: k[2] });
        p.car.body.setNextKinematicRotation({ x: k[3], y: k[4], z: k[5], w: k[6] });
        p.car.siren = k[7] > 0;
      }
    }
  }

  afterStep(dt: number): void {
    for (const p of this.puppets) if (p.key) p.car.afterStep(dt);
  }

  render(alpha: number): void {
    for (const p of this.puppets) if (p.key) p.car.render(alpha);
  }

  /** Their officers as pedestrians to draw (posed each frame from the latest we have). */
  people(remote: { id: number; u: NonNullable<Pose['u']> }[], dt: number): Ped[] {
    const out: Ped[] = [];
    const keep = new Set<string>();
    for (const r of remote) {
      for (const [i, u] of r.u.entries()) {
        const key = `${r.id}:${i}`;
        keep.add(key);
        let p = this.officers.get(key);
        if (!p) {
          p = puppet(this.nextId++, copLook(this.rand));
          this.officers.set(key, p);
          p.px = u[0];
          p.py = u[1];
          p.pz = u[2];
        } else {
          p.px = p.x;
          p.py = p.y;
          p.pz = p.z;
        }
        p.x = u[0];
        p.y = u[1];
        p.z = u[2];
        p.floor = u[1];
        p.heading = u[3];
        p.bike = u[4] > 0;
        const running = u[5] > 0;
        p.vx = running ? 5 : 0;
        p.vz = 0;
        if (running) p.phase += dt * (p.bike ? 8 : 12);
        out.push(p);
      }
    }
    for (const key of [...this.officers.keys()]) if (!keep.has(key)) this.officers.delete(key);
    return out;
  }

  private make(): Puppet | null {
    if (this.puppets.length >= REMOTE_COP_CARS) return null;
    const car = new Car(this.world, _far.clone(), 0, POLICE_PAINT);
    car.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    car.police = true;
    const p = { car, key: '' };
    this.puppets.push(p);
    return p;
  }
}

/** A pedestrian-shaped stand-in for someone else's officer (only drawn). */
function puppet(id: number, look: Ped['look']): Ped {
  return {
    id, x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0, heading: 0, floor: 0, state: 'cop', t: 0,
    edge: null as unknown as Ped['edge'], dir: 1, s: 0, side: 1, offset: 0, pace: 1, vx: 0, vy: 0, vz: 0,
    q: new THREE.Quaternion(), pq: new THREE.Quaternion(), spinAxis: new THREE.Vector3(1, 0, 0), spinRate: 0,
    reaction: 'oi', dazed: 0, phase: 0, look, says: '', saysFor: 0, pinned: true, role: 'cop', kept: true, bike: false,
    hitBy: -1, hitAt: -Infinity, bounces: 0, peak: 0,
  };
}
