import * as THREE from 'three';
import type { Car } from './car.ts';
import { CHASSIS_HALF } from './car.ts';
import type { Prop } from './city/building-chunk.ts';
import type { PropKind } from './city/format.ts';
import { SHADE_ONE } from './city/facades.ts';
import { knob, mechanic } from './tweaks.ts';

// Street furniture and trees a car can knock down (#48). Each one is baked
// into its chunk's mesh like any other detail (one draw call per chunk) and
// has a small fixed collider of its own. Before every physics step, each
// moving car's next couple of ticks are checked against the props near it:
// one it's about to hit faster than that kind's break speed (its speed *into*
// it, so a scrape doesn't count) is knocked down there and then: its
// collider goes before the step, the car loses a share of that speed, and
// the prop's triangles in the chunk are collapsed to nothing while a copy of
// them falls over. Slower than that and the collider stays: the car stops
// against it like a wall. A big tree takes ~75 km/h; a bin anything at all.
//
// Tall things (lamps, signals, signs, shelters, trees) topple over from the
// foot, the way they were hit; bins and benches are flung and tumble. The
// fallen copies are drawn together in one mesh with the city's material (one
// draw call, only while anything's down), aren't solid, and stand back up
// once you're far off and looking away. Each client runs its own (not shared
// in rooms), and the cops don't care.

export const SMASH = mechanic('smash', 'Smash: knock things down', true, {
  small: knob(10, 'Bins and benches give way above', 0, 80, 1, 'km/h'),
  pole: knob(25, 'Lamps and bus stop signs above', 0, 120, 1, 'km/h'),
  signal: knob(35, 'Traffic signals above', 0, 120, 1, 'km/h'),
  shelter: knob(40, 'Bus shelters above', 0, 120, 1, 'km/h'),
  treeSmall: knob(30, 'Small trees above', 0, 150, 1, 'km/h'),
  treeBig: knob(75, 'Big trees above', 0, 200, 1, 'km/h'),
  bigTree: knob(16, 'A big tree is this tall', 4, 30, 0.5, 'm'),
  lossSmall: knob(0.05, 'Speed lost to a bin or bench', 0, 1, 0.01),
  lossPole: knob(0.15, 'Speed lost to a lamp or sign', 0, 1, 0.01),
  lossSignal: knob(0.2, 'Speed lost to a signal', 0, 1, 0.01),
  lossShelter: knob(0.25, 'Speed lost to a shelter', 0, 1, 0.01),
  lossTreeSmall: knob(0.2, 'Speed lost to a small tree', 0, 1, 0.01),
  lossTreeBig: knob(0.5, 'Speed lost to a big tree', 0, 1, 0.01),
  respawn: knob(120, 'Stand back up once you are this far off (and looking away)', 30, 400, 10, 'm'),
  maxDown: knob(40, 'Most down at once', 5, 100, 1),
});

const TREES = new Set<PropKind>(['broadleaf', 'palm', 'conifer', 'pohutukawa']);
/** Flung and tumbling rather than toppling from the foot. */
const FLUNG = new Set<PropKind>(['bin', 'bench']);
/** The smallest trees, m: below this a tree is as easy as `treeSmall`. */
const SMALL_TREE = 4;
/** Ticks of the car's motion looked ahead for a hit (one is enough at any speed a car reaches; two is safe). */
const LOOK_TICKS = 2;
/** Down for at least this long before it can stand back up, s. */
const MIN_DOWN = 8;
const G = 9.81;

/** Speed into it (km/h) a prop gives way above, and the share of that speed the car loses. */
export function toughness(p: { kind: PropKind; height: number }): { kmh: number; loss: number } {
  const S = SMASH;
  switch (p.kind) {
    case 'bin':
    case 'bench':
      return { kmh: S.small, loss: S.lossSmall };
    case 'lamp':
    case 'stop':
      return { kmh: S.pole, loss: S.lossPole };
    case 'signal':
      return { kmh: S.signal, loss: S.lossSignal };
    case 'shelter':
      return { kmh: S.shelter, loss: S.lossShelter };
    default: {
      const f = Math.min(1, Math.max(0, (p.height - SMALL_TREE) / Math.max(0.1, S.bigTree - SMALL_TREE)));
      return { kmh: S.treeSmall + (S.treeBig - S.treeSmall) * f, loss: S.lossTreeSmall + (S.lossTreeBig - S.lossTreeSmall) * f };
    }
  }
}

/** What knocking something down sounds like: a clang for metal, a crack for wood, a crunch for the rest. */
export type SmashSound = 'metal' | 'wood' | 'glass' | 'thud';
const SOUNDS: Record<PropKind, SmashSound> = {
  lamp: 'metal', signal: 'metal', stop: 'metal', shelter: 'glass', bench: 'wood', bin: 'thud',
  broadleaf: 'wood', palm: 'wood', conifer: 'wood', pohutukawa: 'wood',
};

export type SmashEvent = { car: Car; prop: Prop; kmh: number; sound: SmashSound; strength: number };

/** Where props come from (GameMap.props). */
export interface PropSource {
  near(x: number, z: number, r: number, f: (p: Prop) => void): void;
  holds(p: Prop): boolean;
  material: THREE.Material;
}

type Model = ReturnType<Prop['chunk']['propModel']>;

/** A knocked-down prop's copy, falling or fallen. */
type Piece = {
  prop: Prop;
  model: Model;
  /** Vertex positions relative to `origin` at the moment it was hit (world axes). */
  local: Float32Array;
  normals: Float32Array;
  flung: boolean;
  /** Toppling: the point on its foot it tips over, the axis, angle, rate and resting angle; its foot sliding. */
  origin: THREE.Vector3;
  axis: THREE.Vector3;
  angle: number;
  omega: number;
  rest: number;
  slide: THREE.Vector3;
  /** Flung: its middle's velocity, spin (axis * rad/s) and turn so far; how high its middle rests off the ground. */
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  turn: THREE.Quaternion;
  lift: number;
  settled: boolean;
  /** Pose changed since last drawn. */
  dirty: boolean;
  age: number;
};

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _m = new THREE.Matrix3();
const _m4 = new THREE.Matrix4();

/** Vertices the fallen copies' mesh can hold (u16 indices). */
const MAX_VERTS = 65000;
const MAX_INDICES = MAX_VERTS * 3;

export class Smash {
  private readonly source: PropSource;
  private readonly groundAt: (x: number, z: number) => number;
  private readonly pieces: Piece[] = [];
  readonly mesh: THREE.Mesh;
  private readonly geometry = new THREE.BufferGeometry();
  private layoutDirty = false;
  /** Knocked down since the last reset, by kind (?debug). */
  readonly tally: Partial<Record<PropKind, number>> = {};

  constructor(source: PropSource, groundAt: (x: number, z: number) => number) {
    this.source = source;
    this.groundAt = groundAt;
    const g = this.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_VERTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(MAX_VERTS * 3), 3, true).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(MAX_VERTS * 3), 3, true));
    g.setAttribute('roadLayer', new THREE.BufferAttribute(new Uint8Array(MAX_VERTS), 1));
    g.setAttribute('aShade', new THREE.BufferAttribute(new Uint8Array(MAX_VERTS), 1));
    g.setAttribute('aUv', new THREE.BufferAttribute(new Int16Array(MAX_VERTS * 2), 2));
    g.setAttribute('aTile', new THREE.BufferAttribute(new Uint8Array(MAX_VERTS), 1));
    g.setIndex(new THREE.BufferAttribute(new Uint16Array(MAX_INDICES), 1));
    g.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(g, source.material);
    this.mesh.name = 'smashed';
    // World coordinates, and anything down is near the player anyway.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
  }

  /** Props down now. */
  get down(): number {
    return this.pieces.length;
  }

  /** ?debug: what's down, where, and whether it's still moving. */
  list(): { kind: PropKind; x: number; z: number; settled: boolean; age: number }[] {
    return this.pieces.map((p) => ({ kind: p.prop.kind, x: p.prop.x, z: p.prop.z, settled: p.settled, age: p.age }));
  }

  /**
   * Before the physics step: knocks down whatever a moving car is about to
   * hit hard enough, taking a share of its speed. Returns what went down.
   */
  beforeStep(cars: readonly Car[], dt: number): SmashEvent[] {
    const events: SmashEvent[] = [];
    if (!SMASH.on) return events;
    for (const car of cars) {
      const body = car.body;
      if (!body.isDynamic() || body.isSleeping()) continue;
      const lv = body.linvel();
      const speed = Math.hypot(lv.x, lv.z);
      if (speed < 1) continue;
      const t = body.translation();
      const r = body.rotation();
      // The car's footprint: forward (local +x) and right (local +z), flattened.
      _v.set(1, 0, 0).applyQuaternion(_q.set(r.x, r.y, r.z, r.w));
      const fl = Math.hypot(_v.x, _v.z) || 1;
      const fx = _v.x / fl;
      const fz = _v.z / fl;
      const ahead = speed * dt * LOOK_TICKS;
      const hx = t.x + lv.x * dt * LOOK_TICKS;
      const hz = t.z + lv.z * dt * LOOK_TICKS;
      const reach = CHASSIS_HALF.x + ahead + 2.5;
      this.source.near(t.x, t.z, reach, (p) => {
        if (p.down) return;
        // Over or under it (flying, or in the car park below).
        if (t.y < p.y - 1.5 || t.y - CHASSIS_HALF.y > p.y + Math.min(p.height, 3)) return;
        if (Math.abs(p.x - t.x) > reach || Math.abs(p.z - t.z) > reach) return;
        if (!overlaps(hx, hz, fx, fz, p, 0.05)) return;
        // Into it: along the line from the nearest point of the car's footprint now.
        const c = nearestOnCar(t.x, t.z, fx, fz, p.x, p.z);
        let nx = p.x - c.x;
        let nz = p.z - c.z;
        const nl = Math.hypot(nx, nz);
        if (nl < 1e-3) {
          nx = lv.x / speed;
          nz = lv.z / speed;
        } else {
          nx /= nl;
          nz /= nl;
        }
        const into = lv.x * nx + lv.z * nz;
        if (into <= 0) return;
        const { kmh, loss } = toughness(p);
        if (into * 3.6 < kmh) return; // too slow: it stands, and the car stops against it
        const lose = into * loss;
        car.knocked(-nx * lose, -nz * lose);
        this.knock(p, lv.x, lv.z, nx, nz, into);
        const strength = Math.min(1, 0.15 + loss * 0.9 + into / 60);
        events.push({ car, prop: p, kmh: into * 3.6, sound: SOUNDS[p.kind], strength });
      });
    }
    return events;
  }

  /**
   * Knocks a prop down: hides it in its chunk (and drops its collider) and
   * starts a copy falling, away from (nx, nz) and along the car's (vx, vz).
   */
  knock(p: Prop, vx: number, vz: number, nx: number, nz: number, into: number): void {
    if (p.down) return;
    const chunk = p.chunk;
    const model = chunk.propModel(p);
    chunk.hideProp(p);
    this.tally[p.kind] = (this.tally[p.kind] ?? 0) + 1;
    const flung = FLUNG.has(p.kind);
    const speed = Math.hypot(vx, vz) || 1;
    // Falls mostly the way the car was going, a bit away from where it was struck.
    let dx = nx * 0.4 + (vx / speed) * 0.6;
    let dz = nz * 0.4 + (vz / speed) * 0.6;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;
    const origin = new THREE.Vector3(p.x, p.y, p.z);
    if (flung) origin.y += p.height / 2;
    else {
      // Tips over the edge of its foot on the far side.
      const ch = Math.cos(p.heading);
      const sh = Math.sin(p.heading);
      const reach = Math.abs(dx * ch + dz * sh) * p.halfD + Math.abs(-dx * sh + dz * ch) * p.halfW;
      origin.x += dx * reach;
      origin.z += dz * reach;
    }
    const n = model.pos.length / 3;
    const local = new Float32Array(n * 3);
    const normals = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      local[k * 3] = model.pos[k * 3] + chunk.cx - origin.x;
      local[k * 3 + 1] = model.pos[k * 3 + 1] - origin.y;
      local[k * 3 + 2] = model.pos[k * 3 + 2] + chunk.cz - origin.z;
      normals[k * 3] = model.normals[k * 3] / 127;
      normals[k * 3 + 1] = model.normals[k * 3 + 1] / 127;
      normals[k * 3 + 2] = model.normals[k * 3 + 2] / 127;
    }
    const length = Math.max(1, p.height);
    const tree = TREES.has(p.kind);
    // A seeded wobble so each falls a little differently, the same every run.
    const wob = Math.sin(p.x * 12.9898 + p.z * 78.233) * 0.5;
    const piece: Piece = {
      prop: p,
      model,
      local,
      normals,
      flung,
      origin,
      // Tipping towards (dx, dz): up turns into (dx, dz) about (dz, 0, -dx).
      axis: new THREE.Vector3(dz, 0, -dx),
      angle: 0.02,
      omega: Math.min(4, (into * 1.1) / length),
      // A crown or a shelter's roof holds it up off the ground a little.
      rest: Math.PI / 2 - (tree ? 0.14 : p.kind === 'shelter' ? 0.25 : 0.03),
      slide: new THREE.Vector3(dx, 0, dz).multiplyScalar(Math.min(into, 30) * (tree ? 0.08 : 0.25)),
      vel: new THREE.Vector3(vx * 1.05 + nx * 2, 2 + Math.min(into, 30) * 0.12, vz * 1.05 + nz * 2),
      spin: new THREE.Vector3(dz, wob, -dx).normalize().multiplyScalar(Math.min(12, 3 + into * 0.4)),
      turn: new THREE.Quaternion(),
      lift: 0.3,
      settled: false,
      dirty: true,
      age: 0,
    };
    this.pieces.push(piece);
    this.layoutDirty = true;
    // Too many down: the oldest stands back up.
    while (this.pieces.length > SMASH.maxDown) this.restore(this.pieces[0]);
  }

  /** Every fixed tick: the falling copies fall. */
  step(dt: number): void {
    for (const piece of this.pieces) {
      piece.age += dt;
      if (piece.settled) continue;
      piece.dirty = true;
      if (piece.flung) this.fly(piece, dt);
      else topple(piece, dt);
    }
  }

  private fly(piece: Piece, dt: number): void {
    const { origin, vel, spin, turn } = piece;
    vel.y -= G * dt;
    origin.addScaledVector(vel, dt);
    const w = spin.length();
    if (w > 1e-4) {
      _dq.setFromAxisAngle(_v.copy(spin).divideScalar(w), w * dt);
      turn.premultiply(_dq);
    }
    let ground = this.groundAt(origin.x, origin.z);
    if (Number.isNaN(ground)) ground = piece.prop.y;
    if (origin.y < ground + piece.lift) {
      origin.y = ground + piece.lift;
      if (vel.y < 0) vel.y = -vel.y * 0.3;
      vel.x *= 0.6;
      vel.z *= 0.6;
      spin.multiplyScalar(0.55);
      if (vel.length() < 0.8 || piece.age > 6) piece.settled = true;
    }
  }

  /** Each frame, before the physics: stand back up what's far off and out of view (or whose chunk has gone). */
  update(focus: { x: number; z: number }, yaw: number): void {
    for (const piece of [...this.pieces]) {
      const p = piece.prop;
      if (!this.source.holds(p)) {
        this.drop(piece);
        continue;
      }
      if (piece.age < MIN_DOWN) continue;
      const dx = p.x - focus.x;
      const dz = p.z - focus.z;
      const d = Math.hypot(dx, dz);
      if (d > SMASH.respawn && (d > SMASH.respawn * 2.5 || !inView(dx, dz, yaw))) this.restore(piece);
    }
  }

  /** After the physics, each frame: redraw what moved. */
  sync(): void {
    this.draw();
  }

  /** Stands everything back up (reset, or the mechanic switched off). */
  reset(): void {
    for (const piece of [...this.pieces]) this.restore(piece);
    for (const k of Object.keys(this.tally)) delete this.tally[k as PropKind];
    this.draw();
  }

  private restore(piece: Piece): void {
    if (this.source.holds(piece.prop)) piece.prop.chunk.restoreProp(piece.prop);
    this.drop(piece);
  }

  private drop(piece: Piece): void {
    const i = this.pieces.indexOf(piece);
    if (i >= 0) this.pieces.splice(i, 1);
    this.layoutDirty = true;
  }

  /** Writes the copies into the mesh: everything when the set changed, else just the ones that moved. */
  private draw(): void {
    const g = this.geometry;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nor = g.getAttribute('normal') as THREE.BufferAttribute;
    const relayout = this.layoutDirty;
    let v = 0;
    let i = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const piece of this.pieces) {
      const n = piece.local.length / 3;
      if (v + n > MAX_VERTS || i + piece.model.indices.length > MAX_INDICES) break;
      if (relayout) {
        (g.getAttribute('color').array as Uint8Array).set(piece.model.colours, v * 3);
        const m = piece.model;
        const shade = g.getAttribute('aShade').array as Uint8Array;
        const uv = g.getAttribute('aUv').array as Int16Array;
        const tile = g.getAttribute('aTile').array as Uint8Array;
        if (m.shade && m.u && m.v && m.tile) {
          shade.set(m.shade, v);
          tile.set(m.tile, v);
          for (let k = 0; k < n; k++) {
            uv[(v + k) * 2] = m.u[k];
            uv[(v + k) * 2 + 1] = m.v[k];
          }
        } else {
          shade.fill(SHADE_ONE, v, v + n);
          tile.fill(0, v, v + n);
          uv.fill(0, v * 2, (v + n) * 2);
        }
        const index = g.index!.array as Uint16Array;
        for (let k = 0; k < m.indices.length; k++) index[i + k] = m.indices[k] + v;
      }
      if (relayout || piece.dirty) {
        pose(piece, pos.array as Float32Array, nor.array as Int8Array, v);
        piece.dirty = false;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v + n);
      }
      v += n;
      i += piece.model.indices.length;
    }
    if (relayout) {
      for (const name of ['color', 'aShade', 'aUv', 'aTile']) g.getAttribute(name).needsUpdate = true;
      g.index!.needsUpdate = true;
      g.setDrawRange(0, i);
      lo = 0;
      hi = v;
      this.layoutDirty = false;
    }
    if (hi > lo) {
      for (const a of [pos, nor]) {
        a.clearUpdateRanges();
        a.addUpdateRange(lo * 3, (hi - lo) * 3);
        a.needsUpdate = true;
      }
    }
    this.mesh.visible = i > 0;
  }
}

/** A rod tipping over about its foot: gravity speeds it up as it leans, it bounces once or twice where it lands. */
function topple(piece: Piece, dt: number): void {
  const length = Math.max(1, piece.prop.height);
  piece.omega += ((3 * G) / (2 * length)) * Math.sin(piece.angle) * dt;
  piece.angle += piece.omega * dt;
  if (piece.angle >= piece.rest) {
    piece.angle = piece.rest;
    piece.omega = -piece.omega * 0.25;
    if (Math.abs(piece.omega) < 0.35) piece.omega = 0;
  }
  // Its foot drags along the ground, slowing.
  const s = piece.slide.length();
  if (s > 0) {
    piece.origin.addScaledVector(piece.slide, dt);
    piece.slide.multiplyScalar(Math.max(0, s - 6 * dt) / s);
  }
  if (piece.angle >= piece.rest && piece.omega === 0 && piece.slide.lengthSq() < 0.01) piece.settled = true;
}

/** Writes a piece's vertices and normals, posed, into the buffers from vertex `v`. */
function pose(piece: Piece, pos: Float32Array, nor: Int8Array, v: number): void {
  if (piece.flung) _q.copy(piece.turn);
  else _q.setFromAxisAngle(piece.axis, piece.angle);
  _m.setFromMatrix4(_m4.makeRotationFromQuaternion(_q));
  const e = _m.elements;
  const { local, normals, origin } = piece;
  const n = local.length / 3;
  for (let k = 0; k < n; k++) {
    const x = local[k * 3];
    const y = local[k * 3 + 1];
    const z = local[k * 3 + 2];
    const o = (v + k) * 3;
    pos[o] = origin.x + e[0] * x + e[3] * y + e[6] * z;
    pos[o + 1] = origin.y + e[1] * x + e[4] * y + e[7] * z;
    pos[o + 2] = origin.z + e[2] * x + e[5] * y + e[8] * z;
    const a = normals[k * 3];
    const b = normals[k * 3 + 1];
    const c = normals[k * 3 + 2];
    _n.set(e[0] * a + e[3] * b + e[6] * c, e[1] * a + e[4] * b + e[7] * c, e[2] * a + e[5] * b + e[8] * c);
    nor[o] = Math.round(_n.x * 127);
    nor[o + 1] = Math.round(_n.y * 127);
    nor[o + 2] = Math.round(_n.z * 127);
  }
}

/** Does the car's footprint, centred at (cx, cz) facing (fx, fz), overlap the prop's (grown by `pad`)? Separating axes in 2D. */
function overlaps(cx: number, cz: number, fx: number, fz: number, p: Prop, pad: number): boolean {
  const ax = CHASSIS_HALF.x + pad;
  const az = CHASSIS_HALF.z + pad;
  const dx = p.x - cx;
  const dz = p.z - cz;
  if (p.round) {
    // Circle against box: the circle's centre in the car's frame, clamped.
    const u = dx * fx + dz * fz;
    const w = -dx * fz + dz * fx;
    const qu = u - Math.max(-ax, Math.min(ax, u));
    const qw = w - Math.max(-az, Math.min(az, w));
    return qu * qu + qw * qw < p.halfW * p.halfW;
  }
  // Box against box. Car axes: forward f and right r = (-fz, fx); prop: g along its heading, its right s.
  const gx = Math.cos(p.heading);
  const gz = Math.sin(p.heading);
  const axes: [number, number][] = [[fx, fz], [-fz, fx], [gx, gz], [-gz, gx]];
  for (const [ux, uz] of axes) {
    const carR = ax * Math.abs(fx * ux + fz * uz) + az * Math.abs(-fz * ux + fx * uz);
    const propR = p.halfD * Math.abs(gx * ux + gz * uz) + p.halfW * Math.abs(-gz * ux + gx * uz);
    if (Math.abs(dx * ux + dz * uz) > carR + propR) return false;
  }
  return true;
}

/** The point of the car's footprint (at (cx, cz) facing (fx, fz)) nearest (px, pz). */
function nearestOnCar(cx: number, cz: number, fx: number, fz: number, px: number, pz: number): { x: number; z: number } {
  const dx = px - cx;
  const dz = pz - cz;
  const u = Math.max(-CHASSIS_HALF.x, Math.min(CHASSIS_HALF.x, dx * fx + dz * fz));
  const w = Math.max(-CHASSIS_HALF.z, Math.min(CHASSIS_HALF.z, -dx * fz + dz * fx));
  return { x: cx + fx * u - fz * w, z: cz + fz * u + fx * w };
}

const VIEW_HALF_ANGLE = (70 * Math.PI) / 180;

/** Inside the camera's rough view cone, looking along `yaw` (atan2(z, x))? */
function inView(dx: number, dz: number, yaw: number): boolean {
  const d = Math.hypot(dx, dz);
  if (d < 1e-3) return true;
  return (dx * Math.cos(yaw) + dz * Math.sin(yaw)) / d > Math.cos(VIEW_HALF_ANGLE);
}

