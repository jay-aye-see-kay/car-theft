import * as THREE from 'three';

// Cartoon stars circling a dizzy head: the player's, or a pedestrian's who's
// been bowled over. One instanced mesh for everyone, so it's a single draw
// call (none when nobody's dizzy).

const MAX = 32;
const STARS = 5;
const RING = 0.32; // m
const SPIN = 4; // rad/s

function starRing(): THREE.BufferGeometry {
  const pts: number[] = [];
  const star = (cx: number, cz: number, facing: number) => {
    // A flat five-pointed star standing up, facing out of the ring: a fan of 10 triangles.
    const r = (k: number) => (k % 2 ? 0.035 : 0.085);
    const ox = Math.cos(facing);
    const oz = Math.sin(facing);
    const at = (k: number) => {
      const a = (k / 10) * Math.PI * 2;
      // Across the star (perpendicular to `facing`) and up.
      const u = Math.sin(a) * r(k);
      const v = Math.cos(a) * r(k);
      return [cx - oz * u, v, cz + ox * u];
    };
    for (let k = 0; k < 10; k++) pts.push(cx, 0, cz, ...at(k), ...at(k + 1));
  };
  for (let i = 0; i < STARS; i++) {
    const a = (i / STARS) * Math.PI * 2;
    star(Math.cos(a) * RING, Math.sin(a) * RING, a);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class DizzyStars {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;

  constructor() {
    // Unlit and double-sided: they read as bright yellow from any angle.
    const mat = new THREE.MeshBasicMaterial({ color: 0xffe14a, side: THREE.DoubleSide, fog: true });
    this.mesh = new THREE.InstancedMesh(starRing(), mat, MAX);
    this.mesh.name = 'dizzy-stars';
    this.mesh.count = 0;
    this.mesh.visible = false;
    // Instances move every frame: skip the cached bounding sphere.
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  /** Start a frame's worth of rings. */
  begin(): void {
    this.n = 0;
  }

  /** A ring over a head at (x, y, z), `amount` 0..1 (shrinks as it wears off), spinning from `time`. */
  add(x: number, y: number, z: number, amount: number, time: number): void {
    if (this.n >= MAX || amount <= 0.01) return;
    const k = 0.4 + 0.6 * amount;
    _q.setFromAxisAngle(_up, time * SPIN);
    _m.compose(_p.set(x, y + Math.sin(time * 6) * 0.03, z), _q, _s.set(k, k, k));
    this.mesh.setMatrixAt(this.n++, _m);
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n) this.mesh.instanceMatrix.needsUpdate = true;
  }

  get drawn(): number {
    return this.n;
  }
}
