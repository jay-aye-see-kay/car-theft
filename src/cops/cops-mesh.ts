import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Ped } from '../peds.ts';

// The cops' props, each in one instanced draw call and only drawn when
// there's one about: police bicycles (ridden, or lying where their riders
// came off), spike strips and road cones. The officers are pedestrians
// (peds-mesh.ts) and the cars are the fleet's (car-fleet.ts light bars).

const MAX_BIKES = 12;
const MAX_SPIKES = 8;
const MAX_CONES = 16;
/** Not drawn past this from the camera, m. */
const DRAW = 150;

/** Non-indexed, no UVs, one colour: so every part merges with every other. */
function coloured(g: THREE.BufferGeometry, colour: number): THREE.BufferGeometry {
  const c = new THREE.Color(colour);
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute('uv');
  out.setAttribute('color', new THREE.BufferAttribute(new Float32Array(out.attributes.position.count * 3).map((_, i) => [c.r, c.g, c.b][i % 3]), 3));
  return out;
}

/** A bicycle along +x, wheels on the ground at y = 0: two rings, a frame, bars and a seat. */
function bikeGeometry(): THREE.BufferGeometry {
  const wheel = (x: number) => coloured(new THREE.TorusGeometry(0.33, 0.035, 4, 12).translate(x, 0.34, 0), 0x18181a);
  const bar = (len: number, x: number, y: number, rot: number, colour = 0x1f4fae, thick = 0.045) =>
    coloured(new THREE.BoxGeometry(len, thick, thick).rotateZ(rot).translate(x, y, 0), colour);
  return mergeGeometries([
    wheel(-0.52), wheel(0.52),
    bar(0.75, 0, 0.62, 0), // top tube
    bar(0.8, -0.05, 0.47, -0.62), // down tube
    bar(0.42, -0.3, 0.52, 1.25), // seat tube
    bar(0.5, -0.3, 0.34, 0), // chain stay
    bar(0.42, 0.45, 0.5, -1.2), // fork
    coloured(new THREE.BoxGeometry(0.06, 0.04, 0.5).translate(0.4, 0.86, 0), 0x2a2a2a), // handlebars
    coloured(new THREE.BoxGeometry(0.24, 0.05, 0.12).translate(-0.36, 0.78, 0), 0x111111), // seat
    coloured(new THREE.BoxGeometry(0.2, 0.18, 0.24).translate(-0.62, 0.62, 0), 0xf2f2ee), // pannier
  ]);
}

/** A spike strip one metre across (scaled to the road), along z, lying flat. */
function spikeGeometry(): THREE.BufferGeometry {
  // Yellow and black blocks (seen from a way off), with two rows of steel teeth.
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) parts.push(coloured(new THREE.BoxGeometry(0.5, 0.06, 0.2).translate(0, 0.03, -0.4 + i * 0.2), i % 2 ? 0x1c1c1e : 0xf0c419));
  for (let i = 0; i < 5; i++) {
    for (const x of [-0.13, 0.13]) parts.push(coloured(new THREE.ConeGeometry(0.035, 0.12, 4).translate(x, 0.11, -0.4 + i * 0.2), 0xc8ccd2));
  }
  return mergeGeometries(parts);
}

/** A road cone, its middle at y = 0 (as its collider: half-height 0.35). */
function coneGeometry(): THREE.BufferGeometry {
  return mergeGeometries([
    coloured(new THREE.CylinderGeometry(0.03, 0.2, 0.7, 8, 1, true).translate(0, 0, 0), 0xff5a14),
    coloured(new THREE.CylinderGeometry(0.11, 0.15, 0.14, 8, 1, true).scale(1.02, 1, 1.02).translate(0, -0.05, 0), 0xf4f4f0),
    coloured(new THREE.BoxGeometry(0.46, 0.04, 0.46).translate(0, -0.33, 0), 0xff5a14),
  ]);
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwdAxis = new THREE.Vector3(1, 0, 0);

export class CopsMesh {
  readonly group = new THREE.Group();
  private readonly bikes: THREE.InstancedMesh;
  private readonly spikes: THREE.InstancedMesh;
  private readonly cones: THREE.InstancedMesh;

  constructor() {
    const lambert = new THREE.MeshLambertMaterial({ vertexColors: true });
    const make = (g: THREE.BufferGeometry, n: number, name: string) => {
      const m = new THREE.InstancedMesh(g, lambert, n);
      m.name = name;
      m.count = 0;
      m.visible = false;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
      return m;
    };
    this.bikes = make(bikeGeometry(), MAX_BIKES, 'cops bikes');
    this.spikes = make(spikeGeometry(), MAX_SPIKES, 'cops spikes');
    this.cones = make(coneGeometry(), MAX_CONES, 'cops cones');
  }

  /**
   * Each frame: bikes under officers riding them (interpolated like the
   * peds), bikes lying about, spike strips and cones.
   */
  update(
    riders: readonly Ped[],
    dropped: readonly { x: number; y: number; z: number; heading: number }[],
    strips: readonly { x: number; y: number; z: number; heading: number; from: number; to: number }[],
    cones: readonly { x: number; y: number; z: number; q: { x: number; y: number; z: number; w: number } }[],
    alpha: number,
    camera: THREE.Vector3,
  ): void {
    let n = 0;
    for (const p of riders) {
      if (n >= MAX_BIKES) break;
      _p.set(p.px + (p.x - p.px) * alpha, p.py + (p.y - p.py) * alpha, p.pz + (p.z - p.pz) * alpha);
      if (_p.distanceTo(camera) > DRAW) continue;
      _q.setFromAxisAngle(_up, p.heading);
      this.bikes.setMatrixAt(n++, _m.compose(_p, _q, _s.set(1, 1, 1)));
    }
    for (const b of dropped) {
      if (n >= MAX_BIKES) break;
      _p.set(b.x, b.y + 0.04, b.z);
      if (_p.distanceTo(camera) > DRAW) continue;
      // On its side.
      _q.setFromAxisAngle(_up, b.heading).multiply(_q2.setFromAxisAngle(_fwdAxis, Math.PI / 2));
      this.bikes.setMatrixAt(n++, _m.compose(_p, _q, _s.set(1, 1, 1)));
    }
    this.finish(this.bikes, n);

    n = 0;
    for (const r of strips) {
      if (n >= MAX_SPIKES) break;
      // The strip runs across the road: from `from` to `to` left of the line, which is (-sin h, -cos h).
      const mid = (r.from + r.to) / 2;
      // Roads are draped a little above the ground the heights come from.
      _p.set(r.x - Math.sin(r.heading) * mid, r.y + 0.08, r.z - Math.cos(r.heading) * mid);
      if (_p.distanceTo(camera) > DRAW) continue;
      _q.setFromAxisAngle(_up, r.heading);
      this.spikes.setMatrixAt(n++, _m.compose(_p, _q, _s.set(1, 1, Math.max(0.5, r.to - r.from))));
    }
    this.finish(this.spikes, n);

    n = 0;
    for (const c of cones) {
      if (n >= MAX_CONES) break;
      _p.set(c.x, c.y, c.z);
      if (_p.distanceTo(camera) > DRAW) continue;
      this.cones.setMatrixAt(n++, _m.compose(_p, _q.set(c.q.x, c.q.y, c.q.z, c.q.w), _s.set(1, 1, 1)));
    }
    this.finish(this.cones, n);
  }

  /** Bikes, spike strips and cones drawn (?debug). */
  get drawn(): { bikes: number; spikes: number; cones: number } {
    return { bikes: this.bikes.count, spikes: this.spikes.count, cones: this.cones.count };
  }

  private finish(mesh: THREE.InstancedMesh, n: number): void {
    mesh.count = n;
    mesh.visible = n > 0;
    if (n) mesh.instanceMatrix.needsUpdate = true;
  }
}
