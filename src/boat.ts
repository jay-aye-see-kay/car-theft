import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { DriveControls } from './car.ts';
import { tune } from './tweaks.ts';

// Boats you can borrow from the wharves and marinas. Arcade, like the car:
// a rigid body held up by buoyancy at a handful of points round the hull
// (so it pitches and rolls on its own), pushed by an outboard at the stern,
// with a keel that turns sideways slide into forward carving. Nose-up when
// planing and banking into turns are only drawn (render()), not simulated,
// which keeps it steady to drive. Local frame as the car: +x forward, +z right.

export type BoatKind = 'tinny' | 'runabout' | 'launch';

export interface BoatSpec {
  /** For the HUD and the smoke test. */
  label: string;
  length: number;
  beam: number;
  /** Keel to gunwale, m. */
  depth: number;
  mass: number;
  /** Outboard at full throttle, N. */
  thrust: number;
  /** Forward water drag (sets the top speed). */
  drag: number;
  /** How hard it turns: yaw acceleration at speed, rad/s². */
  turn: number;
  /** Paints it might come in. */
  paints: number[];
}

export const BOAT_SPECS: Record<BoatKind, BoatSpec> = {
  // An aluminium dinghy with an outboard: every bach has one.
  tinny: { label: 'Tinny', length: 3.9, beam: 1.65, depth: 0.7, mass: 380, thrust: 3600, drag: 20, turn: 2.6, paints: [0xb9c0c6, 0x9aa6ad, 0x5d7f6a, 0x3c5f8a] },
  // A fizz boat: fibreglass, windscreen, big motor.
  runabout: { label: 'Runabout', length: 5.8, beam: 2.25, depth: 0.95, mass: 950, thrust: 13500, drag: 26, turn: 2.0, paints: [0xd21f2b, 0x1d5fbf, 0x111418, 0xe8c228, 0x18a0a0] },
  // A classic kauri launch with a cabin: slow and stately.
  launch: { label: 'Launch', length: 8.4, beam: 2.8, depth: 1.25, mass: 2600, thrust: 15500, drag: 95, turn: 1.1, paints: [0x1f3a5f, 0x7a2222, 0x2d5a3a, 0xf2efe6] },
};

/** On the ? panel, scaling every boat. */
export const BOATING = {
  thrust: 1,
  turn: 1,
  /** Sideways grip from the keel, per s. */
  keel: 2.2,
  /** Keel grip with the handbrake on (a power slide). */
  slideKeel: 0.5,
  /** How deep it sits at rest, m. */
  draught: 0.22,
  /** Heave damping. */
  heaveDamping: 2.6,
  /** Swell height, m. */
  swell: 0.09,
  /** How far it noses up when planing, rad. */
  planeLift: 0.09,
  /** How far it banks into a turn, rad. */
  bank: 0.16,
};
tune('boat', 'Boat handling', BOATING, {
  thrust: { label: 'Engine (x)', min: 0.2, max: 4, step: 0.05 },
  turn: { label: 'Turning (x)', min: 0.2, max: 4, step: 0.05 },
  keel: { label: 'Keel grip', min: 0, max: 8, step: 0.1, unit: '/s' },
  slideKeel: { label: 'Keel grip, handbrake', min: 0, max: 8, step: 0.1, unit: '/s' },
  draught: { label: 'Sits in the water', min: 0.05, max: 0.6, step: 0.01, unit: 'm' },
  heaveDamping: { label: 'Bob damping', min: 0.2, max: 8, step: 0.1 },
  swell: { label: 'Swell', min: 0, max: 0.5, step: 0.01, unit: 'm' },
  planeLift: { label: 'Nose up planing', min: 0, max: 0.3, step: 0.01, unit: 'rad' },
  bank: { label: 'Bank into turns', min: 0, max: 0.5, step: 0.01, unit: 'rad' },
});

/** What a boat needs to know about the world. */
export interface Waters {
  level: number;
  /** Is there water (not land) under (x, z)? */
  wet(x: number, z: number): boolean;
}

/** Sea level plus a gentle swell, in game time (so stepped tests repeat). */
export function swellAt(level: number, x: number, z: number, t: number): number {
  return level + BOATING.swell * (0.6 * Math.sin(t * 0.9 + x * 0.11) + 0.4 * Math.sin(t * 1.3 + z * 0.17 + 1.7));
}

const IDLE: DriveControls = { throttle: 0, brake: 0, steer: 0, handbrake: false };
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();

export class Boat {
  readonly kind: BoatKind;
  readonly spec: BoatSpec;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly paint: THREE.Color;
  /** The interpolated pose, for the camera and getting in and out. */
  readonly object = new THREE.Group();
  /** The drawn pose: `object` plus the nose-up and bank that are only for show. */
  readonly visual = new THREE.Object3D();
  /** Where it was moored, to put it back. */
  readonly home: { x: number; z: number; heading: number };

  /** Throttle on the last step, 0..1 (engine sound). */
  throttle = 0;
  /** Share of the hull in the water, 0..1. */
  wet = 0;
  /** Biggest bump since last read, m/s (crash sound, spray). */
  impact = 0;
  /** Not simulated (no ground streamed in under it yet). */
  frozen = false;
  /** Tied up where it was put (until someone takes it out): held there on soft lines. */
  moored = false;
  private readonly mooring = { x: 0, z: 0, heading: 0 };

  private steer = 0;
  private plane = 0;
  private readonly hull: THREE.Vector3[];
  private readonly prevPos = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private readonly currPos = new THREE.Vector3();
  private readonly currQuat = new THREE.Quaternion();
  private readonly prevVel = new THREE.Vector3();

  constructor(world: RAPIER.World, kind: BoatKind, x: number, z: number, heading: number, level: number, paint: number) {
    this.kind = kind;
    this.spec = BOAT_SPECS[kind];
    this.home = { x, z, heading };
    this.paint = new THREE.Color(paint);
    const { length: L, beam: B, depth: D } = this.spec;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    // The body's origin is at the waterline when it's floating at rest.
    const keel = -BOATING.draught;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, level, z)
        .setRotation(q)
        .setCcdEnabled(true)
        .setCanSleep(false)
        .setLinearDamping(0.1)
        .setAngularDamping(1.2),
    );
    // A pointed hull: transom, the widest part, and the bow, at the keel and at the gunwale.
    const pts: number[] = [];
    const ring = (px: number, halfW: number, y: number) => pts.push(px, y, -halfW, px, y, halfW);
    ring(-L / 2, B * 0.42, keel + 0.06);
    ring(-L / 2, B / 2, keel + D);
    ring(L * 0.1, B * 0.3, keel);
    ring(L * 0.1, B / 2, keel + D);
    ring(L / 2 - 0.05, 0.05, keel + D * 0.45);
    ring(L / 2, 0.05, keel + D + 0.05);
    const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(pts)) ?? RAPIER.ColliderDesc.cuboid(L / 2, D / 2, B / 2);
    this.collider = world.createCollider(desc.setFriction(0.3).setRestitution(0.15), this.body);
    const m = this.spec.mass;
    this.collider.setMassProperties(
      m,
      { x: -L * 0.05, y: keel + D * 0.25, z: 0 },
      { x: (m / 12) * (B * B + D * D) * 1.6, y: (m / 12) * (L * L + B * B), z: (m / 12) * (L * L + D * D) * 1.3 },
      { x: 0, y: 0, z: 0, w: 1 },
    );
    // Where buoyancy pushes: the four corners of the bottom and the forefoot.
    this.hull = [
      new THREE.Vector3(-L * 0.42, keel, -B * 0.36),
      new THREE.Vector3(-L * 0.42, keel, B * 0.36),
      new THREE.Vector3(L * 0.12, keel, -B * 0.34),
      new THREE.Vector3(L * 0.12, keel, B * 0.34),
      new THREE.Vector3(L * 0.4, keel + D * 0.3, 0),
    ];
    this.object.add(this.visual);
    this.sync();
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.render(1);
  }

  rotation(): THREE.Quaternion {
    const r = this.body.rotation();
    return _q.set(r.x, r.y, r.z, r.w);
  }

  /** Heading about +y (0 faces +x, east). */
  heading(): number {
    _fwd.set(1, 0, 0).applyQuaternion(this.rotation());
    return Math.atan2(-_fwd.z, _fwd.x);
  }

  /** Signed speed along the bow, m/s. */
  forwardSpeed(): number {
    const v = this.body.linvel();
    return _fwd.set(1, 0, 0).applyQuaternion(this.rotation()).dot(_v.set(v.x, v.y, v.z));
  }

  /** Tie it up where it is now. */
  moor(): void {
    const t = this.body.translation();
    this.mooring.x = t.x;
    this.mooring.z = t.z;
    this.mooring.heading = this.heading();
    this.moored = true;
  }

  /** Before world.step(): buoyancy, the keel, the outboard and the helm. `driver` null: drifting at its mooring. */
  update(driver: DriveControls | null, waters: Waters, t: number, dt: number): void {
    const body = this.body;
    body.resetForces(true);
    body.resetTorques(true);
    const c = driver ?? IDLE;
    const { mass: m, length: L } = this.spec;
    const rot = this.rotation();
    const pos = body.translation();
    const lv = body.linvel();
    const av = body.angvel();

    // Buoyancy: a spring per hull point on its depth under the swell, damped on its own vertical speed.
    const per = (m * 9.81) / (this.hull.length * BOATING.draught);
    let wet = 0;
    for (const p of this.hull) {
      _w.copy(p).applyQuaternion(rot).add(_v.set(pos.x, pos.y, pos.z));
      if (!waters.wet(_w.x, _w.z)) continue;
      const depth = swellAt(waters.level, _w.x, _w.z, t) - _w.y;
      if (depth <= 0) continue;
      wet++;
      // Velocity of this point: v + ω × r.
      const rx = _w.x - pos.x;
      const ry = _w.y - pos.y;
      const rz = _w.z - pos.z;
      const vy = lv.y + (av.z * rx - av.x * rz);
      const lift = per * Math.min(depth, BOATING.draught * 4) - vy * (m * BOATING.heaveDamping) / this.hull.length;
      body.addForceAtPoint({ x: 0, y: Math.max(0, lift), z: 0 }, { x: _w.x, y: _w.y, z: _w.z }, true);
      void ry;
    }
    this.wet = wet / this.hull.length;
    if (this.moored && !driver) {
      // Mooring lines: a soft pull back to where it was tied up, and to its heading.
      const k = m * 0.8;
      body.addForce({ x: (this.mooring.x - pos.x) * k - lv.x * m * 0.8, y: 0, z: (this.mooring.z - pos.z) * k - lv.z * m * 0.8 }, true);
      const dh = Math.atan2(Math.sin(this.mooring.heading - this.heading()), Math.cos(this.mooring.heading - this.heading()));
      const izz = (m / 12) * L * L;
      body.addTorque({ x: 0, y: (dh * 0.8 - av.y) * izz, z: 0 }, true);
    }

    _fwd.set(1, 0, 0).applyQuaternion(rot);
    _fwd.y = 0;
    _fwd.normalize();
    _right.set(-_fwd.z, 0, _fwd.x);
    const vf = lv.x * _fwd.x + lv.z * _fwd.z;
    const vr = lv.x * _right.x + lv.z * _right.z;
    this.throttle = 0;
    if (this.wet > 0) {
      const w = this.wet;
      // Water drag along the hull, the keel across it.
      const keel = c.handbrake ? BOATING.slideKeel : BOATING.keel;
      const fx = -this.spec.drag * vf * Math.abs(vf) * w;
      const fr = -keel * m * vr * w;
      body.addForce({ x: _fwd.x * fx + _right.x * fr, y: 0, z: _fwd.z * fx + _right.z * fr }, true);
      // The outboard: forward, or astern (which is also the brakes).
      let push = 0;
      if (c.throttle > 0) push = c.throttle;
      if (c.brake > 0) push = -c.brake * (vf > 1 ? 0.8 : 0.5);
      this.throttle = Math.abs(push);
      const stern = Math.min(1, w * 1.6);
      const f = push * this.spec.thrust * BOATING.thrust * stern;
      body.addForce({ x: _fwd.x * f, y: 0, z: _fwd.z * f }, true);
      // The helm: needs water flowing past (or the motor pushing), and turns the other way going astern.
      this.steer += (c.steer - this.steer) * Math.min(1, dt * 5);
      const flow = Math.min(1.5, 0.15 + Math.abs(vf) / 7 + this.throttle * 0.6);
      const dir = vf < -0.5 ? -1 : 1;
      const izz = (m / 12) * L * L;
      const want = -this.steer * this.spec.turn * BOATING.turn * flow * dir;
      // Yaw rate eased towards what the helm asks, so it carves rather than spins.
      body.addTorque({ x: 0, y: (want * 0.9 - av.y) * izz * 2.2 * w, z: 0 }, true);
      // Planing: the faster, the more the nose lifts (drawn only).
      this.plane += (Math.min(1, Math.max(0, vf - 3) / 9) * (0.4 + this.throttle * 0.6) - this.plane) * Math.min(1, dt * 2);
    } else {
      this.steer *= 0.9;
      this.plane *= 0.95;
    }
  }

  afterStep(dt: number): void {
    const lv = this.body.linvel();
    _v.set(lv.x, lv.y, lv.z);
    const dv = _w.copy(_v).sub(this.prevVel);
    dv.y += 9.81 * dt;
    // Bobbing isn't a bump; hitting a wharf is.
    this.impact = Math.max(this.impact, Math.hypot(dv.x, dv.z));
    this.prevVel.copy(_v);
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.sync();
  }

  render(alpha: number): void {
    this.object.position.lerpVectors(this.prevPos, this.currPos, alpha);
    this.object.quaternion.slerpQuaternions(this.prevQuat, this.currQuat, alpha);
    // Nose up when planing, leaning into the turn (pitch about local z, roll about local x).
    const speed = Math.max(0, this.forwardSpeed());
    const roll = this.steer * BOATING.bank * Math.min(1, speed / 10);
    this.visual.rotation.set(roll, 0, this.plane * BOATING.planeLift);
    this.visual.position.y = this.plane * 0.12;
    this.object.updateMatrixWorld(true);
  }

  /** Back afloat at (x, z) facing `heading`, still. */
  place(x: number, y: number, z: number, heading: number): void {
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.prevVel.set(0, 0, 0);
    this.steer = 0;
    this.plane = 0;
    this.sync();
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.render(1);
  }

  /** Upright again where it is (capsized, or beached on its side). */
  rightUp(level: number): void {
    const t = this.body.translation();
    this.place(t.x, Math.max(t.y, level) + 0.3, t.z, this.heading());
  }

  isCapsized(): boolean {
    return _v.set(0, 1, 0).applyQuaternion(this.rotation()).y < 0.2;
  }

  /** World point at the stern, just under the transom (spray, wake). */
  stern(out: THREE.Vector3, side = 0): THREE.Vector3 {
    return out.set(-this.spec.length / 2, -0.1, side * this.spec.beam * 0.45).applyMatrix4(this.object.matrixWorld);
  }

  private sync(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.currPos.set(t.x, t.y, t.z);
    this.currQuat.set(r.x, r.y, r.z, r.w);
  }
}

/** Heading of a quaternion about +y (for the camera). */
export function yawOf(q: THREE.Quaternion): number {
  return _e.setFromQuaternion(q, 'YXZ').y;
}
