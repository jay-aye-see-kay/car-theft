import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// On-foot player: a kinematic capsule moved by Rapier's character controller
// (steps up kerbs, slides along walls, pushes crates) and a low-poly person
// with a procedural walk cycle. Same heading convention as the car: local +x
// is forward, heading rotates about +y.

const RADIUS = 0.3;
const HALF_HEIGHT = 0.6; // capsule cylinder half-length; total height 1.8 m
const CENTRE_Y = HALF_HEIGHT + RADIUS;

const MOVE = {
  jog: 4.6, // m/s, full stick or keyboard
  sprint: 7.2,
  accel: 12, // how quickly velocity reaches the target, 1/s
  turnRate: 12, // rad/s the body turns to face movement
  gravity: 22,
  jumpSpeed: 6,
};

// Flying (a cheat) is for sightseeing: fast, straight through buildings, no
// gravity. Sprint is quick enough to cross the CBD in half a minute.
const FLY = {
  speed: 25, // m/s
  sprint: 90,
  climb: 15,
  climbSprint: 45,
  accel: 3,
  ceiling: 600, // m above sea level: higher than anything worth seeing
};

export interface FootControls {
  /** Desired move direction in world space (x, z), length 0..1. */
  moveX: number;
  moveZ: number;
  sprint: boolean;
  jump: boolean;
  /** Flying: climb (+1) or descend (-1). */
  rise?: number;
  /** Flying: lowest the feet may go (the ground here), or NaN if unknown. */
  floor?: number;
}

const _move = new THREE.Vector3();

export class Player {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly object = new THREE.Group();
  heading = 0;
  /** Horizontal speed, m/s. */
  speed = 0;
  /** Set on each footfall, for footstep sounds. */
  stepped = false;
  /** Flying (cheat): see setFlying(). */
  flying = false;
  /** Fastest downward speed at a landing since last read, m/s (falls make you dizzy). Reset it after reading. */
  landed = 0;
  /** Dizzy: how much the body sways, 0..1. */
  wobble = 0;

  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly velocity = new THREE.Vector3();
  private grounded = true;
  private walkPhase = 0;
  private wobbleTime = 0;
  /** Knocked about (hit by a car, a shoulder charge): no control for this long, s. */
  private stunned = 0;
  private readonly prevPos = new THREE.Vector3();
  private readonly currPos = new THREE.Vector3();
  private readonly limbs: { legL: THREE.Object3D; legR: THREE.Object3D; armL: THREE.Object3D; armR: THREE.Object3D; torso: THREE.Object3D };

  constructor(world: RAPIER.World, feet: THREE.Vector3, heading = 0) {
    this.heading = heading;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(feet.x, feet.y + CENTRE_Y, feet.z),
    );
    this.collider = world.createCollider(RAPIER.ColliderDesc.capsule(HALF_HEIGHT, RADIUS), this.body);

    this.controller = world.createCharacterController(0.02);
    this.controller.enableAutostep(0.4, 0.15, false); // kerbs are 0.15 m
    this.controller.enableSnapToGround(0.4);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.controller.setCharacterMass(80);

    // The model's origin is at its feet, and so is this.object (see syncPose).
    const model = buildPerson();
    this.object.add(model.root);
    this.limbs = model;

    this.syncPose();
    this.prevPos.copy(this.currPos);
  }

  /** Move for one fixed step. Call before world.step(). */
  update(c: FootControls, dt: number): void {
    if (this.flying) return this.fly(c, dt);
    // Knocked flying: the stick does nothing until it wears off; on the ground you skid to a stop.
    const stunned = this.stunned > 0;
    this.stunned = Math.max(0, this.stunned - dt);
    const len = stunned ? 0 : Math.min(1, Math.hypot(c.moveX, c.moveZ));
    const target = len > 0.05 ? (c.sprint ? MOVE.sprint : MOVE.jog) * len : 0;
    const tx = len > 0.05 ? (c.moveX / Math.max(len, 1e-6)) * target : 0;
    const tz = len > 0.05 ? (c.moveZ / Math.max(len, 1e-6)) * target : 0;
    const k = 1 - Math.exp(-MOVE.accel * dt * (this.grounded ? (stunned ? 0.35 : 1) : stunned ? 0 : 0.25));
    this.velocity.x += (tx - this.velocity.x) * k;
    this.velocity.z += (tz - this.velocity.z) * k;

    if (this.grounded) {
      this.velocity.y = c.jump && !stunned ? MOVE.jumpSpeed : -1;
    } else {
      this.velocity.y -= MOVE.gravity * dt;
    }

    // Face the way we're going.
    if (len > 0.05) {
      const want = Math.atan2(-c.moveZ, c.moveX);
      let d = want - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += d * Math.min(1, MOVE.turnRate * dt);
    }

    // Ground snapping would cancel the start of a jump.
    if (this.velocity.y > 0) this.controller.disableSnapToGround();
    else this.controller.enableSnapToGround(0.4);
    // Knocked flying by a car: don't let the car that's still touching you hold you down.
    const flags = stunned ? RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC : undefined;
    this.controller.computeColliderMovement(this.collider, _move.copy(this.velocity).multiplyScalar(dt), flags);
    const m = this.controller.computedMovement();
    const wasGrounded = this.grounded;
    this.grounded = this.controller.computedGrounded();
    if (!wasGrounded && this.grounded) {
      this.stepped = true; // landing thud
      this.landed = Math.max(this.landed, -this.velocity.y);
    }
    if (this.grounded && this.velocity.y < 0) this.velocity.y = -1;
    // Hitting a ceiling (or a car roof from below) kills upward speed.
    if (this.velocity.y > 0 && m.y < this.velocity.y * dt * 0.5) this.velocity.y = 0;

    const t = this.body.translation();
    this.body.setNextKinematicTranslation({ x: t.x + m.x, y: t.y + m.y, z: t.z + m.z });
    this.speed = Math.hypot(m.x, m.z) / dt;
  }

  /** Shoved: this velocity now (m/s, world), and no control for `stun` seconds. */
  knock(vx: number, vy: number, vz: number, stun: number): void {
    if (this.flying) return;
    this.velocity.set(vx, vy, vz);
    if (vy > 0) this.grounded = false;
    this.stunned = Math.max(this.stunned, stun);
  }

  /** Moving under our own control (not knocked about). */
  get inControl(): boolean {
    return this.stunned <= 0;
  }

  /**
   * Fly or land. Flying turns off the capsule's collisions (so the camera can
   * get anywhere), and landing turns them back on and drops from where you are.
   */
  setFlying(on: boolean): void {
    if (on === this.flying) return;
    this.flying = on;
    this.collider.setEnabled(!on);
    this.velocity.y = 0;
    this.grounded = false;
  }

  private fly(c: FootControls, dt: number): void {
    const len = Math.min(1, Math.hypot(c.moveX, c.moveZ));
    const speed = c.sprint ? FLY.sprint : FLY.speed;
    const k = 1 - Math.exp(-FLY.accel * dt);
    this.velocity.x += (c.moveX * speed - this.velocity.x) * k;
    this.velocity.z += (c.moveZ * speed - this.velocity.z) * k;
    this.velocity.y += ((c.rise ?? 0) * (c.sprint ? FLY.climbSprint : FLY.climb) - this.velocity.y) * k * 2;
    if (len > 0.05) {
      const want = Math.atan2(-c.moveZ, c.moveX);
      const d = Math.atan2(Math.sin(want - this.heading), Math.cos(want - this.heading));
      this.heading += d * Math.min(1, MOVE.turnRate * 0.5 * dt);
    }
    const t = this.body.translation();
    let y = t.y + this.velocity.y * dt;
    const floor = (c.floor ?? NaN) + CENTRE_Y;
    if (y < floor) {
      y = floor;
      this.velocity.y = Math.max(0, this.velocity.y);
    }
    if (y > FLY.ceiling) {
      y = FLY.ceiling;
      this.velocity.y = Math.min(0, this.velocity.y);
    }
    this.body.setNextKinematicTranslation({ x: t.x + this.velocity.x * dt, y, z: t.z + this.velocity.z * dt });
    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Call after world.step(). */
  afterStep(): void {
    this.prevPos.copy(this.currPos);
    this.syncPose();
  }

  render(alpha: number, dt: number): void {
    this.object.position.lerpVectors(this.prevPos, this.currPos, alpha);
    // Dizzy: a drunken lean, round and round (heading first, then the tilt).
    this.wobbleTime += dt;
    const w = this.wobble;
    this.object.rotation.set(Math.sin(this.wobbleTime * 4.3) * 0.16 * w, this.heading, Math.sin(this.wobbleTime * 3.1) * 0.12 * w, 'YXZ');

    // Walk cycle: swing limbs in proportion to speed; tuck when airborne.
    const { legL, legR, armL, armR, torso } = this.limbs;
    const prev = this.walkPhase;
    this.walkPhase += dt * (2 + this.speed * 1.6);
    if (this.grounded && this.speed > 0.5 && Math.floor(prev / Math.PI) !== Math.floor(this.walkPhase / Math.PI)) {
      this.stepped = true;
    }
    const amp = this.grounded ? Math.min(this.speed / MOVE.jog, 1.3) * 0.7 : 0.4;
    const swing = this.grounded ? Math.sin(this.walkPhase) * amp : 0;
    legL.rotation.z = swing;
    legR.rotation.z = -swing;
    armL.rotation.z = -swing * 0.9;
    armR.rotation.z = swing * 0.9;
    if (!this.grounded) {
      legL.rotation.z = 0.5;
      legR.rotation.z = -0.2;
      armL.rotation.z = armR.rotation.z = -0.6;
    }
    torso.rotation.z = -Math.min(this.speed / MOVE.sprint, 1) * 0.2; // lean into a run
  }

  /** Feet position (interpolated), for the camera and enter-car checks. */
  get position(): THREE.Vector3 {
    return this.object.position;
  }

  get isGrounded(): boolean {
    return this.grounded;
  }

  /** Teleport, e.g. when stepping out of a car. Position is at the feet. */
  place(feet: THREE.Vector3, heading: number): void {
    this.body.setTranslation({ x: feet.x, y: feet.y + CENTRE_Y, z: feet.z }, true);
    this.body.setNextKinematicTranslation({ x: feet.x, y: feet.y + CENTRE_Y, z: feet.z });
    this.heading = heading;
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    this.grounded = false;
    this.stunned = 0;
    this.landed = 0;
    this.syncPose();
    this.prevPos.copy(this.currPos);
  }

  /**
   * Someone else's player (multiplayer): move the capsule to where they are
   * for the next step, instead of walking it under our own controls.
   */
  follow(x: number, y: number, z: number, heading: number, speed: number, grounded: boolean): void {
    this.body.setNextKinematicTranslation({ x, y: y + CENTRE_Y, z });
    this.heading = heading;
    this.speed = speed;
    this.grounded = grounded;
  }

  /** Remove from the physics world (someone else's player who left). */
  dispose(world: RAPIER.World): void {
    world.removeCharacterController(this.controller);
    world.removeRigidBody(this.body);
  }

  /** Hide and disable collisions while driving. */
  setActive(active: boolean): void {
    this.object.visible = active;
    this.collider.setEnabled(active && !this.flying);
  }

  private syncPose(): void {
    const t = this.body.translation();
    this.currPos.set(t.x, t.y - CENTRE_Y, t.z);
  }
}

// The body plan, shared with the pedestrians (peds.ts draws them instanced):
// boxes on five moving parts, each coloured by slot. Origin at the feet,
// facing +x; legs swing from the hips, arms from the shoulders, which ride
// on the torso.

export type Part = 'torso' | 'legL' | 'legR' | 'armL' | 'armR';
export const PARTS: readonly Part[] = ['torso', 'legL', 'legR', 'armL', 'armR'];
/** What colours each box: shins and forearms are skin or clothes, by outfit. */
export type Slot = 'skin' | 'top' | 'bottom' | 'hair' | 'shoes' | 'shin' | 'forearm';
export const SLOTS: readonly Slot[] = ['skin', 'top', 'bottom', 'hair', 'shoes', 'shin', 'forearm'];
/** Pivots, from the feet (arms' from the torso's pivot). */
export const PIVOTS: Record<Part, [number, number, number]> = {
  torso: [0, 0.86, 0],
  legL: [0, 0.86, -0.11],
  legR: [0, 0.86, 0.11],
  armL: [0, 0.54, -0.28],
  armR: [0, 0.54, 0.28],
};
type Box = [w: number, h: number, d: number, slot: Slot, x: number, y: number, z: number];
const LEG: Box[] = [
  [0.17, 0.36, 0.17, 'bottom', 0, -0.16, 0],
  [0.13, 0.46, 0.13, 'shin', 0, -0.56, 0],
  [0.26, 0.04, 0.12, 'shoes', 0.04, -0.84, 0],
];
const ARM: Box[] = [[0.13, 0.22, 0.13, 'top', 0, -0.08, 0], [0.1, 0.4, 0.1, 'forearm', 0, -0.38, 0]];
/** Boxes relative to their part's pivot. */
export const BODY: Record<Part, Box[]> = {
  torso: [
    [0.26, 0.56, 0.44, 'top', 0, 0.3, 0],
    [0.12, 0.08, 0.12, 'skin', 0, 0.62, 0], // neck
    [0.24, 0.26, 0.22, 'skin', 0.01, 0.78, 0], // head
    [0.26, 0.08, 0.24, 'hair', -0.01, 0.92, 0],
  ],
  legL: LEG,
  legR: LEG,
  armL: ARM,
  armR: ARM,
};

/** One part's boxes merged, with a slot index per vertex (for colouring). */
export function partGeometry(part: Part): THREE.BufferGeometry {
  const geos = BODY[part].map(([w, h, d, slot, x, y, z]) => {
    const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed();
    g.deleteAttribute('uv');
    g.setAttribute('slot', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(SLOTS.indexOf(slot)), 1));
    return g;
  });
  return mergeGeometries(geos);
}

// The player: shorts, a black tee and jandals. Each moving part is one
// vertex-coloured mesh, so the whole person is 5 draw calls.
function buildPerson() {
  const root = new THREE.Group();
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const skin = new THREE.Color(0xc68a62);
  const top = new THREE.Color(0x1d1d22);
  const bottom = new THREE.Color(0x2f4f7a);
  const colours: Record<Slot, THREE.Color> = { skin, top, bottom, hair: new THREE.Color(0x1a120c), shoes: new THREE.Color(0x2a6fd6), shin: skin, forearm: skin };

  const mesh = (part: Part) => {
    const g = partGeometry(part);
    const slot = g.attributes.slot.array;
    const c = new Float32Array(slot.length * 3);
    for (let i = 0; i < slot.length; i++) colours[SLOTS[slot[i]]].toArray(c, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.deleteAttribute('slot');
    return new THREE.Mesh(g, material);
  };
  // Limbs hang from pivots at the hip and shoulder so they can swing.
  const pivot = (part: Part) => {
    const p = new THREE.Group();
    p.position.fromArray(PIVOTS[part]);
    p.add(mesh(part));
    return p;
  };
  const legL = pivot('legL');
  const legR = pivot('legR');
  const torso = pivot('torso');
  const armL = pivot('armL');
  const armR = pivot('armR');
  torso.add(armL, armR);
  root.add(legL, legR, torso);
  return { root, legL, legR, armL, armR, torso };
}
