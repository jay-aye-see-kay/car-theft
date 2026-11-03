import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MissionView, PropView } from './runner.ts';

// Glowing rings on the street with a beam of light rising out of them, GTA
// III style: gold where a mission starts, pink for where to go. One mesh
// (one draw call) each, additive so they glow without lighting. Start
// markers show only nearby; the goal's beam is tall and ignores the fog so
// it reads over the rooftops from across the CBD.

const START = { colour: 0xffc23d, radius: 1.6, height: 5, draw: 300 };
const GOAL = { colour: 0xff5fc8, radius: 3, height: 220, draw: Infinity };
/** The goal widens with distance past this, so it's never a hairline across the city, m. */
const GOAL_WIDEN = 120;
/**
 * Before the ground under a far goal has streamed in, stand its beam this
 * far below the camera: the CBD's hills are within it, and the foot of the
 * beam is behind buildings at that range anyway, m.
 */
const UNKNOWN_GROUND = 40;

function beaconGeometry(radius: number, height: number): THREE.BufferGeometry {
  const ring = new THREE.RingGeometry(radius - 0.22, radius, 40, 1).rotateX(-Math.PI / 2).translate(0, 0.06, 0);
  const floor = new THREE.CircleGeometry(radius - 0.22, 40).rotateX(-Math.PI / 2).translate(0, 0.05, 0);
  const beam = new THREE.CylinderGeometry(radius * 0.92, radius * 0.92, height, 32, 8, true).translate(0, height / 2, 0);
  const parts = [ring, floor, beam].map((g) => g.toNonIndexed());
  const geo = mergeGeometries(parts.map((g) => {
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    return g;
  }))!;
  // Alpha by part and height: a bright rim, a faint floor, a beam fading upwards.
  const pos = geo.attributes.position;
  const colours = new Float32Array(pos.count * 4);
  const counts = parts.map((g) => g.attributes.position.count);
  for (let i = 0; i < pos.count; i++) {
    const part = i < counts[0] ? 0 : i < counts[0] + counts[1] ? 1 : 2;
    const h = pos.getY(i) / height;
    colours.set([1, 1, 1, part === 0 ? 1 : part === 1 ? 0.18 : 0.7 * (1 - h)], i * 4);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 4));
  return geo;
}

class Beacon {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;

  constructor(name: string, kind: typeof START, geometry: THREE.BufferGeometry) {
    this.material = new THREE.MeshBasicMaterial({
      color: kind.colour,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: kind === START,
      // Additive, so drawing order doesn't matter: one pass, not three's two for double-sided transparency.
      forceSinglePass: true,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = name;
    this.mesh.renderOrder = 2; // over the water and skid marks
    this.mesh.visible = false;
  }

  /** On the ground at (x, z), pulsing; hidden where the ground isn't known. */
  show(x: number, z: number, ground: number, clock: number, width = 1): void {
    this.mesh.visible = !Number.isNaN(ground);
    this.mesh.position.set(x, ground, z);
    this.mesh.scale.set(width, 1, width);
    this.material.opacity = 0.75 + 0.25 * Math.sin(clock * 4);
  }
}

/** Most props of each kind drawn at once. */
const MAX_PROPS = 96;
/** A gem floats this high, and spins this fast (rad/s). */
const GEM = { lift: 1.3, size: 0.55, beam: 7, spin: 2.2 };

/** A pad: a unit ring (rim and faint floor) to scale by its radius, plus a low glowing wall. */
function padGeometry(): THREE.BufferGeometry {
  const rim = new THREE.RingGeometry(0.9, 1, 40, 1).rotateX(-Math.PI / 2).translate(0, 0.07, 0);
  const floor = new THREE.CircleGeometry(0.9, 40).rotateX(-Math.PI / 2).translate(0, 0.06, 0);
  const wall = new THREE.CylinderGeometry(1, 1, 0.8, 40, 1, true).translate(0, 0.4, 0);
  return alphaParts([rim, floor, wall], (part, y) => (part === 0 ? 1 : part === 1 ? 0.22 : 0.55 * (1 - y / 0.8)));
}

/** A gem: an octahedron with a thin beam under it. */
function gemGeometry(): THREE.BufferGeometry {
  const gem = new THREE.OctahedronGeometry(GEM.size, 0).scale(1, 1.5, 1).translate(0, GEM.lift, 0);
  const beam = new THREE.CylinderGeometry(0.12, 0.12, GEM.beam, 8, 1, true).translate(0, GEM.beam / 2, 0);
  return alphaParts([gem, beam], (part, y) => (part === 0 ? 1 : 0.5 * (1 - y / GEM.beam)));
}

function alphaParts(parts: THREE.BufferGeometry[], alpha: (part: number, y: number) => number): THREE.BufferGeometry {
  const flat = parts.map((g) => {
    const n = g.toNonIndexed();
    n.deleteAttribute('uv');
    n.deleteAttribute('normal');
    return n;
  });
  const geo = mergeGeometries(flat)!;
  const pos = geo.attributes.position;
  const colours = new Float32Array(pos.count * 4);
  let part = 0;
  let end = flat[0].attributes.position.count;
  for (let i = 0; i < pos.count; i++) {
    while (i >= end) end += flat[++part].attributes.position.count;
    colours.set([1, 1, 1, alpha(part, pos.getY(i))], i * 4);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 4));
  return geo;
}

/** Props of one shape, one instanced draw call (hidden when there are none). */
class PropKind {
  readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicMaterial;

  constructor(name: string, geometry: THREE.BufferGeometry) {
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true,
    });
    this.mesh = new THREE.InstancedMesh(geometry, this.material, MAX_PROPS);
    this.mesh.name = name;
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PROPS * 3), 3);
  }

  begin(clock: number): void {
    this.mesh.count = 0;
    this.material.opacity = 0.8 + 0.2 * Math.sin(clock * 5);
  }

  add(m: THREE.Matrix4, colour: THREE.Color): void {
    const i = this.mesh.count;
    if (i >= MAX_PROPS) return;
    this.mesh.setMatrixAt(i, m);
    this.mesh.setColorAt(i, colour);
    this.mesh.count = i + 1;
  }

  end(): void {
    this.mesh.visible = this.mesh.count > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _c = new THREE.Color();
const _blue = new THREE.Color(0x3b6bff);

export class MissionMarkers {
  readonly group = new THREE.Group();
  /** One per goal showing (a mission can mark a few places at once). */
  private readonly goals: Beacon[] = [];
  private readonly starts = new Map<string, Beacon>();
  private readonly startGeometry = beaconGeometry(START.radius, START.height);
  private readonly goalGeometry = beaconGeometry(GOAL.radius, GOAL.height);
  /** Ground under goals once it has streamed in: it may stream out again behind you. */
  private readonly heights = new Map<string, number>();
  private readonly pads = new PropKind('mission pads', padGeometry());
  private readonly gems = new PropKind('mission gems', gemGeometry());

  constructor() {
    this.group.name = 'markers';
    this.group.add(this.pads.mesh, this.gems.mesh);
  }

  private drawProps(props: readonly PropView[], heightAt: (x: number, z: number) => number, from: THREE.Vector3, clock: number): void {
    this.pads.begin(clock);
    this.gems.begin(clock);
    for (const [i, p] of props.entries()) {
      if (Math.hypot(p.x - from.x, p.z - from.z) > p.draw) continue;
      let y = p.y;
      if (y === null) {
        const h = heightAt(p.x, p.z);
        if (Number.isNaN(h)) continue;
        y = h;
      }
      _c.set(p.colour);
      if (p.style === 'pad') {
        _m.compose(_v.set(p.x, y, p.z), _q.identity(), _s.set(p.radius, 1, p.radius));
        this.pads.add(_m, _c);
        continue;
      }
      // Sirens are big and flash red and blue; gems bob and spin. Carried ones ride over the head, no beam to the ground.
      const siren = p.style === 'siren';
      const size = siren ? 2.2 : p.carrier !== null ? 0.8 : 1;
      if (siren && Math.sin(clock * 12) > 0) _c.copy(_blue);
      const bob = p.carrier !== null ? -GEM.lift : 0.15 * Math.sin(clock * 3 + i);
      _q.setFromAxisAngle(_up, clock * GEM.spin + i);
      _m.compose(_v.set(p.x, y + bob, p.z), _q, _s.set(size, size, size));
      this.gems.add(_m, _c);
    }
    this.pads.end();
    this.gems.end();
  }

  update(view: MissionView, heightAt: (x: number, z: number) => number, from: THREE.Vector3, clock: number): void {
    this.drawProps(view.props, heightAt, from, clock);
    for (const [i, { x, z }] of view.targets.entries()) {
      let goal = this.goals[i];
      if (!goal) {
        goal = this.goals[i] = new Beacon(`marker goal ${i}`, GOAL, this.goalGeometry);
        this.group.add(goal.mesh);
      }
      const key = `${x},${z}`;
      const h = heightAt(x, z);
      if (!Number.isNaN(h)) this.heights.set(key, h);
      const ground = this.heights.get(key) ?? from.y - UNKNOWN_GROUND;
      goal.show(x, z, ground, clock, Math.max(1, Math.hypot(x - from.x, z - from.z) / GOAL_WIDEN));
    }
    for (const goal of this.goals.slice(view.targets.length)) goal.mesh.visible = false;
    for (const b of this.starts.values()) b.mesh.visible = false;
    for (const s of view.starts) {
      if (Math.hypot(s.x - from.x, s.z - from.z) > START.draw) continue;
      let b = this.starts.get(s.id);
      if (!b) {
        b = new Beacon(`marker start ${s.id}`, START, this.startGeometry);
        this.starts.set(s.id, b);
        this.group.add(b.mesh);
      }
      b.show(s.x, s.z, heightAt(s.x, s.z), clock);
    }
  }
}
