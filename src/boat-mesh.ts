import * as THREE from 'three';
import { BOAT_SPECS, BOATING, type Boat, type BoatKind } from './boat.ts';
import { paintable } from './car-fleet.ts';

// The boats, each kind built once from a lofted hull and a few boxes, baked
// to one geometry with vertex colours (and `paint` where the instance's
// colour goes), and drawn instanced: one call per kind with any in view.
// Local frame as Boat: +x forward, +z right, y = 0 at the waterline at rest.

/** Boats beyond this from the camera aren't drawn, m. */
const DRAW = 700;

/** Triangles with a colour and a paint flag each, flat shaded. */
class Builder {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly paint: number[] = [];

  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, colour: THREE.Color, paint = 0): void {
    for (const p of [a, b, c]) {
      this.pos.push(p.x, p.y, p.z);
      this.col.push(colour.r, colour.g, colour.b);
      this.paint.push(paint);
    }
  }

  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, colour: THREE.Color, paint = 0): void {
    this.tri(a, b, c, colour, paint);
    this.tri(a, c, d, colour, paint);
  }

  /** An axis-aligned box (then tilted `pitch` about z, round its centre). */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, colour: number, paint = 0, pitch = 0): void {
    const g = new THREE.BoxGeometry(sx, sy, sz).rotateZ(pitch).translate(cx, cy, cz).toNonIndexed();
    const p = g.attributes.position;
    const c = new THREE.Color(colour);
    for (let i = 0; i < p.count; i++) {
      this.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      this.col.push(c.r, c.g, c.b);
      this.paint.push(paint);
    }
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('paint', new THREE.Float32BufferAttribute(this.paint, 1));
    g.computeVertexNormals();
    return g;
  }
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * A planing hull lofted through cross-sections from transom to stem: keel,
 * chine and gunwale each side. Topsides take the paint, the bottom `bottom`.
 * Returns the gunwale points, for decks.
 */
function hull(b: Builder, kind: BoatKind, bottom: number, inside: number): THREE.Vector3[][] {
  const { length: L, beam: B, depth: D } = BOAT_SPECS[kind];
  const keelY = -BOATING.draught;
  const N = 12;
  const sections: THREE.Vector3[][] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = -L / 2 + t * L;
    // Full width aft, sweeping in to the stem over the front 45%.
    const taper = t < 0.5 ? 1 : Math.sqrt(Math.max(0, 1 - ((t - 0.5) / 0.5) ** 2));
    const w = (B / 2) * (t < 0.5 ? 0.94 + 0.06 * (t / 0.5) : taper);
    // The forefoot rises towards the bow; the sheer lifts a little too.
    const keel = keelY + 0.04 + (t > 0.55 ? D * 0.55 * ((t - 0.55) / 0.45) ** 1.6 : 0);
    const sheer = keelY + D + 0.12 * t * t;
    const chineY = Math.min(sheer - 0.05, keel + (keelY + D * 0.32 - keel) * (t > 0.55 ? 0.5 : 1) + 0.0);
    const wc = w * 0.78;
    const tip = Math.max(w, 0.02);
    sections.push([v3(x, sheer, -tip), v3(x, chineY, -Math.max(wc, 0.015)), v3(x, keel, 0), v3(x, chineY, Math.max(wc, 0.015)), v3(x, sheer, tip)]);
  }
  const paint = new THREE.Color(0xffffff);
  const bot = new THREE.Color(bottom);
  for (let i = 0; i < N; i++) {
    const a = sections[i];
    const c = sections[i + 1];
    for (let k = 0; k < 4; k++) {
      const topside = k === 0 || k === 3;
      b.quad(a[k], c[k], c[k + 1], a[k + 1], topside ? paint : bot, topside ? 1 : 0);
    }
  }
  // Transom.
  const s = sections[0];
  b.quad(s[0], s[1], s[3], s[4], paint, 1);
  b.tri(s[1], s[2], s[3], bot);
  // The floor inside, just above the waterline.
  const floorY = keelY + D * 0.38;
  const fl = (t: number) => {
    const sec = sections[Math.round(t * N)];
    return [v3(sec[0].x, floorY, sec[0].z * 0.86), v3(sec[0].x, floorY, sec[4].z * 0.86)];
  };
  const [aL, aR] = fl(0);
  const [bL, bR] = fl(0.75);
  b.quad(aL, bL, bR, aR, new THREE.Color(inside));
  return sections.map((sec) => [sec[0], sec[4]]);
}

/** A deck over the bow from section `from` (0..12) to the stem. */
function foredeck(b: Builder, gunwale: THREE.Vector3[][], from: number, colour: number, paint = 0): void {
  const c = new THREE.Color(colour);
  for (let i = from; i < gunwale.length - 1; i++) {
    const [aL, aR] = gunwale[i];
    const [bL, bR] = gunwale[i + 1];
    b.quad(aL, bL, bR, aR, c, paint);
  }
}

function buildTinny(): THREE.BufferGeometry {
  const b = new Builder();
  const { length: L, beam: B, depth: D } = BOAT_SPECS.tinny;
  const top = -BOATING.draught + D;
  const g = hull(b, 'tinny', 0x8c949a, 0x9aa1a6);
  foredeck(b, g, 10, 0x9aa1a6, 1);
  // Thwarts (bench seats) across.
  for (const x of [-L * 0.32, 0.05, L * 0.25]) b.box(x, top - 0.22, 0, 0.3, 0.05, B * 0.86, 0xa7aeb3);
  // The outboard on the transom: cowling, leg, skeg.
  const sx = -L / 2 - 0.12;
  b.box(sx, top + 0.18, 0, 0.42, 0.36, 0.32, 0x22262a);
  b.box(sx - 0.02, top - 0.25, 0, 0.12, 0.6, 0.1, 0x2b2f33);
  b.box(sx - 0.02, top - 0.6, 0, 0.26, 0.1, 0.06, 0x2b2f33);
  // Tiller.
  b.box(sx + 0.38, top + 0.12, 0, 0.5, 0.05, 0.05, 0x1a1a1a);
  return b.geometry();
}

function buildRunabout(): THREE.BufferGeometry {
  const b = new Builder();
  const { length: L, beam: B, depth: D } = BOAT_SPECS.runabout;
  const top = -BOATING.draught + D;
  const g = hull(b, 'runabout', 0xf1f1ee, 0xe7e3d8);
  foredeck(b, g, 7, 0xf4f4f0);
  // Rubbing strake along the gunwale.
  b.box(-0.2, top - 0.02, -B / 2 + 0.03, L * 0.72, 0.06, 0.06, 0x202224);
  b.box(-0.2, top - 0.02, B / 2 - 0.03, L * 0.72, 0.06, 0.06, 0x202224);
  // Windscreen across the front of the cockpit, raked back.
  const wx = L * 0.08;
  b.box(wx, top + 0.22, 0, 0.05, 0.45, B * 0.84, 0x2a3a48, 0, 0.5);
  b.box(wx - 0.05, top + 0.45, 0, 0.06, 0.05, B * 0.86, 0xcfd3d6, 0, 0.5);
  // Helm console (right-hand side, like the cars) and seats.
  b.box(wx - 0.45, top - 0.12, B * 0.22, 0.5, 0.5, 0.55, 0xe2ded3);
  b.box(wx - 0.3, top + 0.15, B * 0.22, 0.05, 0.28, 0.28, 0x111111, 0, 0.6);
  for (const z of [-B * 0.22, B * 0.22]) {
    b.box(-0.9, top - 0.3, z, 0.6, 0.35, 0.6, 0xdcd6c8);
    b.box(-1.15, top - 0.02, z, 0.12, 0.5, 0.6, 0xdcd6c8, 0, 0.15);
  }
  // Rear bench.
  b.box(-L / 2 + 0.55, top - 0.28, 0, 0.6, 0.35, B * 0.86, 0xdcd6c8);
  // A big outboard.
  const sx = -L / 2 - 0.2;
  b.box(sx, top + 0.25, 0, 0.6, 0.55, 0.45, 0x15171a);
  b.box(sx + 0.02, top - 0.3, 0, 0.16, 0.75, 0.12, 0x2b2f33);
  b.box(sx, top - 0.75, 0, 0.36, 0.12, 0.08, 0x2b2f33);
  // Bow rail.
  b.box(L * 0.32, top + 0.25, 0, L * 0.3, 0.04, 0.04, 0xcfd3d6);
  return b.geometry();
}

function buildLaunch(): THREE.BufferGeometry {
  const b = new Builder();
  const { length: L, beam: B, depth: D } = BOAT_SPECS.launch;
  const top = -BOATING.draught + D;
  const g = hull(b, 'launch', 0x7a1c1c, 0xb8925a);
  // Varnished teak foredeck.
  foredeck(b, g, 8, 0xa8794a);
  // Boot-top stripe along the waterline.
  b.box(-0.6, 0.02, -B * 0.47, L * 0.62, 0.08, 0.04, 0xf2efe6);
  b.box(-0.6, 0.02, B * 0.47, L * 0.62, 0.08, 0.04, 0xf2efe6);
  // The cabin: varnished sides, white roof, dark windows, then the wheelhouse aft.
  const cx = L * 0.06;
  const cl = L * 0.42;
  const cw = B * 0.7;
  b.box(cx, top + 0.45, 0, cl, 0.9, cw, 0x8a5a2b);
  b.box(cx, top + 0.93, 0, cl + 0.15, 0.08, cw + 0.15, 0xf2efe6);
  for (const z of [-cw / 2 - 0.01, cw / 2 + 0.01]) {
    for (let k = 0; k < 3; k++) b.box(cx - cl * 0.32 + k * cl * 0.32, top + 0.6, z, cl * 0.22, 0.3, 0.02, 0x1d2630);
  }
  b.box(cx + cl / 2 + 0.01, top + 0.6, 0, 0.02, 0.3, cw * 0.7, 0x1d2630);
  // Wheelhouse roof on posts over the cockpit.
  const rx = cx - cl / 2 - 0.8;
  b.box(rx, top + 1.42, 0, 1.6, 0.06, cw + 0.15, 0xf2efe6);
  for (const z of [-cw / 2, cw / 2]) b.box(rx - 0.75, top + 0.7, z, 0.07, 1.4, 0.07, 0xf2efe6);
  // Cockpit seats and the transom.
  b.box(-L / 2 + 0.5, top - 0.25, 0, 0.6, 0.4, B * 0.8, 0xa8794a);
  // Mast with a flag at the top (mostly for spotting it from afar).
  b.box(cx + 0.3, top + 1.9, 0, 0.06, 1.9, 0.06, 0xf2efe6);
  b.box(cx + 0.1, top + 2.7, 0, 0.4, 0.25, 0.02, 0xd21f2b);
  return b.geometry();
}

const BUILDERS: Record<BoatKind, () => THREE.BufferGeometry> = { tinny: buildTinny, runabout: buildRunabout, launch: buildLaunch };

const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

export class BoatsMesh {
  readonly group = new THREE.Group();
  private readonly meshes = new Map<BoatKind, THREE.InstancedMesh>();
  /** Boats drawn last frame (?debug). */
  drawn = 0;

  constructor(boats: readonly Boat[]) {
    const material = paintable(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide }));
    for (const kind of Object.keys(BUILDERS) as BoatKind[]) {
      const n = boats.filter((b) => b.kind === kind).length;
      if (!n) continue;
      const mesh = new THREE.InstancedMesh(BUILDERS[kind](), material, n);
      // The shader is compiled with instance colours only if they exist from the start.
      for (let i = 0; i < n; i++) mesh.setColorAt(i, new THREE.Color(0xffffff));
      mesh.name = 'boat';
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.meshes.set(kind, mesh);
      this.group.add(mesh);
    }
  }

  /** Every boat in view (after boat.render()). */
  update(boats: readonly Boat[], camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (const m of this.meshes.values()) m.count = 0;
    this.drawn = 0;
    for (const boat of boats) {
      const p = boat.object.position;
      if (boat.frozen || p.distanceTo(camera.position) > DRAW) continue;
      if (!_frustum.intersectsSphere(_sphere.set(p, boat.spec.length * 0.6 + 1))) continue;
      const mesh = this.meshes.get(boat.kind)!;
      const i = mesh.count++;
      mesh.setMatrixAt(i, boat.visual.matrixWorld);
      mesh.setColorAt(i, boat.paint);
      this.drawn++;
    }
    for (const m of this.meshes.values()) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }
}
