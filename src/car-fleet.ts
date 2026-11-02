import * as THREE from 'three';
import type { Car } from './car.ts';
import { buildCorolla, buildCorollaFar, buildWheel } from './corolla.ts';

// Every car on screen in five draw calls: bodies, lamps, wheels, far-off
// bodies (a low-poly stand-in) and blob shadows, each one instanced mesh. A car on its own was nine calls, which
// ran out of phone budget at about three cars in view; now the cost of a car
// is just its triangles. Cars are culled and given their level of detail
// here, on the CPU, each frame: only the ones in view are written.

/** Lit tail lamps, and how they look with the brakes off. */
const BRAKE_ON = new THREE.Color(0xff2a2a);
const BRAKE_OFF = new THREE.Color(0x6a0c0c);
/** Bounding radius of a car about its centre, m (frustum test). */
const RADIUS = 2.6;

/**
 * Painted parts take the instance's colour; everything else keeps its own.
 * (three's own instance colour multiplies every vertex, which would tint the
 * glass and tyres too.)
 */
function paintable<M extends THREE.Material>(m: M): M {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <color_pars_vertex>', '#include <color_pars_vertex>\nattribute float paint;')
      .replace(
        '#include <color_vertex>',
        `vColor = vec4(1.0);
#ifdef USE_INSTANCING_COLOR
  vColor.rgb = mix(color.rgb, instanceColor.rgb, paint);
#else
  vColor.rgb = color.rgb;
#endif`,
      );
  };
  m.customProgramCacheKey = () => 'paintable';
  return m;
}

const _m = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();

export class CarFleet {
  readonly group = new THREE.Group();
  private readonly bodies: THREE.InstancedMesh;
  private readonly lamps: THREE.InstancedMesh;
  private readonly wheels: THREE.InstancedMesh;
  private readonly shadows: THREE.InstancedMesh;
  private readonly far: THREE.InstancedMesh;
  private nFar = 0;
  private nBody = 0;
  private nLamp = 0;
  private nWheel = 0;
  private nShadow = 0;

  constructor(capacity: number, shadowMaterial: THREE.Material, shadowGeometry: THREE.BufferGeometry, bodyOffsetY: number) {
    const model = buildCorolla();
    model.body.translate(0, bodyOffsetY, 0);
    model.lamps.translate(0, bodyOffsetY, 0);
    const n = Math.max(1, capacity);
    this.bodies = new THREE.InstancedMesh(model.body, paintable(new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.4, roughness: 0.4 })), n);
    this.lamps = new THREE.InstancedMesh(model.lamps, paintable(new THREE.MeshBasicMaterial({ vertexColors: true })), n);
    this.wheels = new THREE.InstancedMesh(buildWheel(), new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.4, roughness: 0.6 }), n * 4);
    this.shadows = new THREE.InstancedMesh(shadowGeometry, shadowMaterial, n);
    this.far = new THREE.InstancedMesh(buildCorollaFar().translate(0, bodyOffsetY, 0), this.bodies.material, n);
    // The shaders are compiled with instance colours only if they exist from the start.
    for (let i = 0; i < n; i++) {
      this.bodies.setColorAt(i, BRAKE_OFF);
      this.lamps.setColorAt(i, BRAKE_OFF);
      this.far.setColorAt(i, BRAKE_OFF);
    }
    for (const [mesh, name] of [[this.bodies, 'car'], [this.lamps, 'car'], [this.wheels, 'car'], [this.far, 'car'], [this.shadows, 'shadow']] as const) {
      mesh.name = name;
      mesh.count = 0;
      // Culled per car below; the mesh's own bounds would be stale.
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
    }
  }

  /** Start a frame: the camera's frustum for culling. */
  begin(camera: THREE.Camera): void {
    this.nBody = this.nLamp = this.nWheel = this.nShadow = this.nFar = 0;
    camera.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  }

  /** Is a car centred here in view? */
  inView(p: THREE.Vector3): boolean {
    return _frustum.intersectsSphere(_sphere.set(p, RADIUS));
  }

  /**
   * Draw a car this frame (after car.render()): `detail` 2 is the whole car,
   * 1 just the body, 0 the low-poly stand-in; and its blob shadow if given.
   */
  add(car: Car, detail: 0 | 1 | 2, shadow: THREE.Object3D | null): void {
    if (!this.inView(car.object.position)) return;
    if (detail === 0) {
      const f = this.nFar++;
      this.far.setMatrixAt(f, car.object.matrixWorld);
      this.far.setColorAt(f, car.paint);
      return;
    }
    const detailed = detail === 2;
    const i = this.nBody++;
    this.bodies.setMatrixAt(i, car.object.matrixWorld);
    this.bodies.setColorAt(i, car.paint);
    if (detailed) {
      const l = this.nLamp++;
      this.lamps.setMatrixAt(l, car.object.matrixWorld);
      this.lamps.setColorAt(l, car.brakeLit ? BRAKE_ON : BRAKE_OFF);
      for (let w = 0; w < 4; w++) this.wheels.setMatrixAt(this.nWheel++, car.wheelMatrix(w));
    }
    if (shadow) {
      shadow.updateMatrix();
      this.shadows.setMatrixAt(this.nShadow++, _m.copy(shadow.matrix));
    }
  }

  end(): void {
    for (const [mesh, n] of [[this.bodies, this.nBody], [this.lamps, this.nLamp], [this.wheels, this.nWheel], [this.far, this.nFar], [this.shadows, this.nShadow]] as const) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Cars drawn this frame (?debug). */
  get drawn(): number {
    return this.nBody + this.nFar;
  }
}
