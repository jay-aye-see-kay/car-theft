import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Low-poly 1995 (E100-generation) Corolla sedan, built from extruded side
// profiles so it has the right silhouette without any external assets.
// Local frame: +x is forward, +y is up, +z is the car's right side.
// y = 0 is the underside of the body; the car's origin sits at mid-length.

export const COROLLA = {
  length: 4.27,
  width: 1.685,
  height: 1.385,
  wheelbase: 2.465,
  track: 1.46,
  wheelRadius: 0.3,
  wheelWidth: 0.19,
  paint: 0x7a3db8, // purple mica
};

const L = COROLLA.length / 2;

// Lower body (bumpers, doors, bonnet, boot) side profile, front at +x.
const bodyProfile: [number, number][] = [
  [-L + 0.02, 0.0],
  [L - 0.04, 0.0],
  [L + 0.02, 0.28],
  [L - 0.02, 0.5],
  [L - 0.18, 0.62], // nose
  [0.9, 0.72], // base of windscreen
  [-1.4, 0.76], // base of rear window
  [-L + 0.06, 0.74], // boot lid
  [-L, 0.5],
  [-L + 0.02, 0.28],
];

// Glasshouse profile, sitting on the belt line.
const cabinProfile: [number, number][] = [
  [0.92, 0.71],
  [-1.42, 0.75],
  [-0.82, 1.14],
  [0.22, 1.16],
];

function extrude(points: [number, number][], depth: number, bevel = true): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel,
    bevelThickness: 0.04,
    bevelSize: 0.04,
    bevelSegments: 1,
  });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

function box(
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

export interface CorollaGeometry {
  /**
   * Everything but the lamps, in the car's frame with y = 0 at the underside.
   * Vertex colours, and a `paint` attribute (1 on painted panels) so one
   * instanced mesh can paint every car its own colour.
   */
  body: THREE.BufferGeometry;
  /** Head, indicator and tail lamps; `paint` is 1 on the tail lamps, which light up when braking. */
  lamps: THREE.BufferGeometry;
}

const PAINT = new THREE.MeshStandardMaterial();
const BRAKE = new THREE.MeshStandardMaterial({ color: 0xb01010 });

/** The car built once and baked for instancing (src/car-fleet.ts draws every car from it). */
export function buildCorolla(): CorollaGeometry {
  const root = new THREE.Group();
  root.name = 'corolla';

  // The paint is the instance's colour; white here, so painted parts read as such before it's applied.
  const paint = PAINT;
  const glass = new THREE.MeshStandardMaterial({ color: 0x1b2430 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x1a1a1a });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xcfd3d6 });
  const headlight = new THREE.MeshStandardMaterial({ color: 0xfff6d8 });
  const amber = new THREE.MeshStandardMaterial({ color: 0xffa020 });
  const brakeLights = BRAKE;
  const lamps = [headlight, amber, brakeLights];
  const halfW = COROLLA.width / 2;

  // Body and glasshouse. The cabin is narrower than the body (tumblehome).
  root.add(new THREE.Mesh(extrude(bodyProfile, COROLLA.width - 0.08), paint));
  root.add(new THREE.Mesh(extrude(cabinProfile, COROLLA.width - 0.34), glass));

  // Painted roof skin and B-pillars over the glass.
  const roof = box(1.0, 0.04, COROLLA.width - 0.36, paint, -0.3, 1.19, 0);
  root.add(roof);
  for (const side of [-1, 1]) {
    const pillar = box(0.1, 0.42, 0.04, paint, -0.25, 0.94, side * (halfW - 0.13));
    root.add(pillar);
  }

  // Black rubbing strips down the doors and across the bumpers.
  for (const side of [-1, 1]) {
    root.add(box(3.2, 0.06, 0.03, trim, -0.1, 0.38, side * (halfW + 0.01)));
  }
  root.add(box(0.04, 0.08, COROLLA.width - 0.2, trim, L + 0.03, 0.3, 0));
  root.add(box(0.04, 0.08, COROLLA.width - 0.2, trim, -L - 0.01, 0.3, 0));

  // Front: wide slim headlights, small grille, amber corners.
  for (const side of [-1, 1]) {
    root.add(box(0.06, 0.13, 0.42, headlight, L - 0.06, 0.5, side * 0.5));
    root.add(box(0.06, 0.1, 0.1, amber, L - 0.1, 0.5, side * (halfW - 0.08)));
  }
  root.add(box(0.05, 0.1, 0.5, trim, L - 0.02, 0.5, 0));
  root.add(box(0.03, 0.02, 0.12, chrome, L + 0.0, 0.5, 0)); // badge

  // Rear: full-width tail light band with a garnish panel in the middle.
  for (const side of [-1, 1]) {
    root.add(box(0.05, 0.16, 0.48, brakeLights, -L + 0.02, 0.6, side * 0.55));
  }
  root.add(box(0.05, 0.12, 0.6, trim, -L + 0.02, 0.6, 0));

  // Mirrors and door handles.
  for (const side of [-1, 1]) {
    root.add(box(0.12, 0.1, 0.12, trim, 0.72, 0.84, side * (halfW + 0.04)));
    root.add(box(0.12, 0.03, 0.02, trim, 0.25, 0.62, side * (halfW + 0.01)));
    root.add(box(0.12, 0.03, 0.02, trim, -0.75, 0.62, side * (halfW + 0.01)));
  }

  // Wheel arches: dark boxes so the wheels read against the body.
  for (const x of [COROLLA.wheelbase / 2, -COROLLA.wheelbase / 2]) {
    for (const side of [-1, 1]) {
      root.add(box(0.72, 0.38, 0.06, trim, x, 0.17, side * (halfW - 0.05)));
    }
  }

  // ~35 parts would be ~35 draw calls per car; bake them down to two
  // geometries that every car shares, instanced.
  return {
    body: bakeGeometry(root, (m) => !lamps.includes(m as THREE.MeshStandardMaterial), (m) => (m === paint ? 1 : 0)),
    lamps: bakeGeometry(root, (m) => lamps.includes(m as THREE.MeshStandardMaterial), (m) => (m === brakeLights ? 1 : 0)),
  };
}

/**
 * The same silhouette for cars far off, ~50 triangles instead of ~350: the
 * body and glasshouse with no bevels, trim or lamps, and dark boxes where
 * the wheels are.
 */
export function buildCorollaFar(): THREE.BufferGeometry {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(extrude(bodyProfile, COROLLA.width - 0.04, false), PAINT));
  root.add(new THREE.Mesh(extrude(cabinProfile, COROLLA.width - 0.3, false), new THREE.MeshStandardMaterial({ color: 0x1b2430 })));
  return bakeGeometry(root, () => true, (m) => (m === PAINT ? 1 : 0));
}

/** One wheel: tyre plus hubcap, spinning about its local z axis. */
export function buildWheel(): THREE.BufferGeometry {
  const wheel = new THREE.Group();
  const tyre = new THREE.Mesh(
    new THREE.CylinderGeometry(COROLLA.wheelRadius, COROLLA.wheelRadius, COROLLA.wheelWidth, 14),
    new THREE.MeshStandardMaterial({ color: 0x151515 }),
  );
  tyre.rotation.x = Math.PI / 2;
  wheel.add(tyre);
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.19, 0.19, COROLLA.wheelWidth + 0.02, 8),
    new THREE.MeshStandardMaterial({ color: 0xb8bcc0 }),
  );
  hub.rotation.x = Math.PI / 2;
  wheel.add(hub);
  // A spoke so you can see the wheels turn.
  const spoke = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.05, COROLLA.wheelWidth + 0.04),
    new THREE.MeshStandardMaterial({ color: 0x55595d }),
  );
  wheel.add(spoke);
  return bakeGeometry(wheel, () => true, () => 0);
}

/**
 * Merge the group's meshes whose material passes `take` into one geometry,
 * with each part's colour baked into vertex colours and `paint` per vertex.
 */
function bakeGeometry(group: THREE.Group, take: (m: THREE.Material) => boolean, paint: (m: THREE.Material) => number): THREE.BufferGeometry {
  group.updateMatrixWorld(true);
  const geos: THREE.BufferGeometry[] = [];
  group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const mat = o.material as THREE.MeshStandardMaterial;
    if (!take(mat)) return;
    let g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    g.deleteAttribute('uv');
    const n = g.attributes.position.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < colors.length; i += 3) mat.color.toArray(colors, i);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.setAttribute('paint', new THREE.BufferAttribute(new Float32Array(n).fill(paint(mat)), 1));
    geos.push(g);
  });
  return mergeGeometries(geos);
}
