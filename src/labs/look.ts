// Lab 3: the same generated tile under different looks. Tests how much of "feels like its
// own place" comes from shading, palette, light and a little exaggeration, not from generation.
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import '../ui/lab.css';
import { toNztm } from '../geo/nztm.ts';
import { buildMassing } from '../gen/buildings.ts';
import { buildCovers } from '../gen/covers.ts';
import { buildFacades } from '../gen/facade.ts';
import { solveJunctions } from '../gen/junctions.ts';
import { buildRoadMeshes } from '../gen/roadMesh.ts';
import { occupancy, scatterTrees } from '../gen/scatter.ts';
import { buildTerrainGeometry, gradeTerrain, paintGround } from '../gen/terrain.ts';
import { DEFAULT_PARAMS, buildTrack, solveElevations } from '../gen/tracks.ts';
import { centroid } from '../geo/poly.ts';
import { type Heightfield, loadTile } from '../model/load.ts';

interface Look {
  about: string;
  /** Steps of light on a surface. 0 is ordinary smooth shading. */
  bands: number;
  outline: number;
  shadows: boolean;
  trees: boolean;
  palette: 'grey' | 'toy';
  windows: number;
  glow: number;
  /** Where the sun is: compass bearing and height above the horizon, in degrees. */
  sunBearing: number;
  sunHeight: number;
  sun: number;
  sunPower: number;
  skyLight: number;
  groundLight: number;
  ambientPower: number;
  skyTop: number;
  horizon: number;
  ink: number;
}

const LOOKS: Record<string, Look> = {
  'Toy city': {
    about: 'Three steps of light, ink outlines, a made-up building palette and a northern midday sun.',
    bands: 3, outline: 0.7, shadows: true, trees: true, palette: 'toy', windows: 0.75, glow: 0,
    sunBearing: 35, sunHeight: 50, sun: 0xfff1d6, sunPower: 2.7, skyLight: 0xc4dcff, groundLight: 0x8f8470, ambientPower: 1.35,
    skyTop: 0x3f9be6, horizon: 0xd3ecf8, ink: 0x2a2f45,
  },
  'Golden hour': {
    about: 'Low western sun, long violet shadows, the first windows lit.',
    bands: 3, outline: 0.6, shadows: true, trees: true, palette: 'toy', windows: 0.75, glow: 0.35,
    sunBearing: 292, sunHeight: 13, sun: 0xffa85c, sunPower: 3.2, skyLight: 0x8f9be6, groundLight: 0x7d5c4c, ambientPower: 1.05,
    skyTop: 0x4f78d0, horizon: 0xffd0a0, ink: 0x3a2a4a,
  },
  Dusk: {
    about: 'Sun nearly gone. The city reads by its lit windows.',
    bands: 3, outline: 0.35, shadows: true, trees: true, palette: 'toy', windows: 0.9, glow: 1.5,
    sunBearing: 285, sunHeight: 5, sun: 0xff7a55, sunPower: 0.9, skyLight: 0x4a5aa8, groundLight: 0x2c2c4a, ambientPower: 1.25,
    skyTop: 0x161d48, horizon: 0xe8866a, ink: 0x10122a,
  },
  'Ink and paper': {
    about: 'Two steps of light and heavy outlines on a paper sky. Closest to a drawn map.',
    bands: 2, outline: 1, shadows: false, trees: true, palette: 'toy', windows: 0.4, glow: 0,
    sunBearing: 35, sunHeight: 45, sun: 0xffffff, sunPower: 2.2, skyLight: 0xffffff, groundLight: 0xc9c0ae, ambientPower: 1.6,
    skyTop: 0xe6dfcd, horizon: 0xf3eee0, ink: 0x1d2030,
  },
  'Plain model': {
    about: 'No styling at all: what lab 2 shows. Here for comparison.',
    bands: 0, outline: 0, shadows: false, trees: false, palette: 'grey', windows: 0, glow: 0,
    sunBearing: 330, sunHeight: 55, sun: 0xfff2dd, sunPower: 2.0, skyLight: 0xdcecff, groundLight: 0x6b6a5c, ambientPower: 1.5,
    skyTop: 0xbfd9ea, horizon: 0xbfd9ea, ink: 0x000000,
  },
};

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
// The buildings lab is this page with the facade grammar switched on and a street-level start.
const lab = document.body.dataset.lab === 'buildings' ? 'buildings' : 'look';
const TITLE = lab === 'buildings' ? 'Building grammar' : 'Look study';
hud.innerHTML = `<a class="back" href="../../">← labs</a><h1>${TITLE}</h1><p>Loading…</p>`;

const query = new URLSearchParams(location.search);
const state = {
  look: query.get('look') && query.get('look')! in LOOKS ? query.get('look')! : 'Toy city',
  hillScale: Number(query.get('hills')) || 1,
  driving: false,
  /** Build real facades for buildings near the view; the rest stay as boxes with shader windows. */
  detail: lab === 'buildings',
  detailRadius: 260,
};
const look: Look = { ...LOOKS[state.look] };

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xffffff, 600, 3600);
const camera = new THREE.PerspectiveCamera(50, 1, 1, 7000);
const controls = new MapControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 6;
controls.maxDistance = 2500;

const hemi = new THREE.HemisphereLight();
const sun = new THREE.DirectionalLight();
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -420, right: 420, top: 420, bottom: -420, near: 1, far: 2600 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.6;
scene.add(hemi, sun, sun.target);

// Sky: a gradient dome that follows the camera.
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(6000, 24, 12),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() } },
    vertexShader: `varying vec3 dir; void main() { dir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; varying vec3 dir;
      void main() { gl_FragColor = vec4(mix(horizon, top, smoothstep(0.0, 0.55, dir.y)), 1.0); }`,
  }),
);
sky.renderOrder = -1;
scene.add(sky);

/** The ramp a toon material looks light up in. Its left half is surfaces facing away from the sun. */
function ramp(bands: number): THREE.DataTexture {
  const n = 256;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const facing = Math.max(0, (i / (n - 1)) * 2 - 1);
    const v = bands ? Math.min(bands - 1, Math.floor(facing * bands)) / (bands - 1) : facing;
    data.fill(Math.round((0.42 + 0.58 * v) * 255), i * 4, i * 4 + 3);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, 1);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

const { model, ground } = await loadTile('central');
const groundPaint = new THREE.CanvasTexture(paintGround(model));
groundPaint.colorSpace = THREE.SRGBColorSpace;
groundPaint.anisotropy = renderer.capabilities.getMaxAnisotropy();

const facade = { uWindows: { value: 0 }, uGlow: { value: 0 } };
const mats = {
  terrain: new THREE.MeshToonMaterial({ map: groundPaint }),
  surface: new THREE.MeshToonMaterial({ vertexColors: true, side: THREE.DoubleSide }),
  buildings: new THREE.MeshToonMaterial({ vertexColors: true }),
  facades: new THREE.MeshToonMaterial({ vertexColors: true, side: THREE.DoubleSide }),
  trees: new THREE.MeshToonMaterial({ vertexColors: true }),
  car: new THREE.MeshToonMaterial({ vertexColors: true }),
  covers: new THREE.MeshToonMaterial({ vertexColors: true, side: THREE.DoubleSide }),
  glass: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.42, depthWrite: false }),
  markings: new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
};
const toons = [mats.terrain, mats.surface, mats.buildings, mats.facades, mats.trees, mats.car, mats.covers];

// Windows are drawn by the shader from the wall's bay grid: bays across, floors up. The grid
// comes from the building's real width and height, which is what an interior would also use.
mats.buildings.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, facade);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec4 wall;\nvarying vec4 vWall;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWall = wall;');
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      varying vec4 vWall;
      uniform float uWindows;
      uniform float uGlow;
      float wallHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`,
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      float litWindow = 0.0;
      if (vWall.z > 2.5 && vWall.y > 0.0) {
        float bays = max(1.0, floor(vWall.z / 3.4));
        float floors = max(1.0, floor(vWall.w / 3.3 + 0.5));
        vec2 cell = vec2(vWall.x / vWall.z * bays, vWall.y / vWall.w * floors);
        vec2 f = fract(cell);
        float pane = step(0.2, f.x) * step(f.x, 0.8) * step(0.3, f.y) * step(f.y, 0.82);
        // Fade the grid out once windows are smaller than a pixel, so far towers do not shimmer.
        pane *= 1.0 - smoothstep(0.25, 0.6, max(fwidth(cell.x), fwidth(cell.y)));
        float pick = wallHash(floor(cell) + vWall.zw);
        diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.13, 0.2, 0.3), vec3(0.3, 0.44, 0.55), pick), pane * uWindows);
        litWindow = pane * step(0.62, pick);
      }`,
    )
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.74, 0.38) * litWindow * uGlow;');
};

// Built facades carry a per-vertex `glow` so the same windows can light up at dusk.
mats.facades.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, facade);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float glow;\nvarying float vGlow;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = glow;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vGlow;\nuniform float uGlow;')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.74, 0.38) * vGlow * uGlow;');
};

// One low-poly tree, instanced for every scattered position.
function treeGeometry(): THREE.BufferGeometry {
  const paint = (g: THREE.BufferGeometry, c: number): THREE.BufferGeometry => {
    const col = new THREE.Color(c);
    const n = g.getAttribute('position').count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.toArray(a, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g.index ? g.toNonIndexed() : g;
  };
  const trunk = paint(new THREE.CylinderGeometry(0.22, 0.34, 3.2, 5).translate(0, 1.6, 0), 0x7a6a55);
  const crown = paint(new THREE.IcosahedronGeometry(1, 0).scale(2.7, 2.5, 2.7).translate(0, 4.6, 0), 0xffffff);
  const top = paint(new THREE.IcosahedronGeometry(1, 0).scale(1.8, 1.7, 1.8).rotateY(1).translate(0.5, 6.4, 0.3), 0xf2f2f2);
  return mergeGeometries([trunk, crown, top])!;
}
const treeShape = treeGeometry();

const world = new THREE.Group();
scene.add(world);
let surfaceAt: Heightfield = ground;
let land: Heightfield = ground;
let nearRoad: (x: number, y: number) => boolean = () => false;
const built = new THREE.Group();
scene.add(built);
const focus = new THREE.Vector3(Infinity, 0, 0);
let detailCount = 0;
// Canopies and screens are not buildings; they have their own generator.
const solid = model.buildings.filter((b) => !b.cover);
const centres = solid.map((b) => centroid(b.ring));

/** Splits buildings into near (full facades) and far (boxes), around what the camera is looking at. */
function rebuildBuildings(): void {
  for (const child of built.children) (child as THREE.Mesh).geometry.dispose();
  built.clear();
  focus.copy(controls.target);
  const near = (i: number) => state.detail && Math.hypot(centres[i][0] - focus.x, centres[i][1] + focus.z) < state.detailRadius;
  const far = solid.filter((_, i) => !near(i));
  const close = solid.filter((_, i) => near(i));
  detailCount = close.length;
  for (const [geometry, material] of [
    [buildMassing(far, land, { palette: look.palette, hillScale: state.hillScale }), mats.buildings],
    [buildFacades(close, land, { hillScale: state.hillScale, nearRoad }), mats.facades],
  ] as const) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = mesh.receiveShadow = true;
    built.add(mesh);
  }
  renderHud();
}

function generate(): void {
  for (const child of world.children) if ((child as THREE.Mesh).geometry !== treeShape) (child as THREE.Mesh).geometry.dispose();
  world.clear();

  // Exaggeration happens to the input, so roads, banks and buildings all follow it.
  land = ground.clone();
  for (let i = 0; i < land.data.length; i++) land.data[i] *= state.hillScale;

  const tracks = new Map(model.roads.map((r) => [r.id, buildTrack(r, DEFAULT_PARAMS)]));
  solveElevations(model, tracks, land, DEFAULT_PARAMS);
  const junctions = solveJunctions(model, tracks, DEFAULT_PARAMS);
  const graded = gradeTerrain(land, tracks.values(), junctions, DEFAULT_PARAMS);
  const roads = buildRoadMeshes(tracks.values(), junctions, DEFAULT_PARAMS, { tintJunctions: false });
  surfaceAt = graded;
  nearRoad = occupancy(model, tracks.values(), 'roads');

  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, cast: boolean, receive: boolean): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    world.add(mesh);
    return mesh;
  };
  add(buildTerrainGeometry(graded), mats.terrain, false, true);
  add(roads.surface, mats.surface, true, true);
  add(roads.markings, mats.markings, false, false);
  const covers = buildCovers(model.buildings, graded, tracks.values());
  add(covers.frame, mats.covers, true, true);
  add(covers.glass, mats.glass, false, false);
  rebuildBuildings();

  if (look.trees) {
    const trees = scatterTrees(model, graded, occupancy(model, tracks.values()));
    const mesh = new THREE.InstancedMesh(treeShape, mats.trees, trees.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const c = new THREE.Color();
    trees.forEach((t, i) => {
      q.setFromAxisAngle(up, t.tint * 40);
      m.compose(new THREE.Vector3(t.x, t.h - 0.2, -t.y), q, new THREE.Vector3(t.size, t.size * (0.85 + t.tint * 0.4), t.size));
      mesh.setMatrixAt(i, m);
      // Mostly bush greens; about one in thirty is a pōhutukawa in flower.
      mesh.setColorAt(i, t.tint > 0.968 ? c.setHex(0xc63d3d) : c.setHSL(0.27 + t.tint * 0.1, 0.42, 0.3 + ((t.tint * 7) % 1) * 0.14));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    world.add(mesh);
    treeCount = trees.length;
  } else treeCount = 0;
}
let treeCount = 0;

// Outlines: draw the scene to a texture, then ink wherever depth breaks or creases.
const target = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
target.depthTexture = new THREE.DepthTexture(1, 1);
const post = new THREE.ShaderMaterial({
  depthTest: false,
  uniforms: {
    tColor: { value: target.texture },
    tDepth: { value: target.depthTexture },
    texel: { value: new THREE.Vector2() },
    near: { value: camera.near },
    far: { value: camera.far },
    strength: { value: 0 },
    ink: { value: new THREE.Color() },
  },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `
    varying vec2 vUv;
    uniform sampler2D tColor; uniform sampler2D tDepth;
    uniform vec2 texel; uniform float near; uniform float far; uniform float strength; uniform vec3 ink;
    // 1/distance is linear across a flat surface on screen, so its second difference is zero on
    // any plane and non-zero exactly at silhouettes and creases.
    float inv(vec2 uv) {
      float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
      return (far + near - z * (far - near)) / (2.0 * near * far);
    }
    void main() {
      vec4 c = texture2D(tColor, vUv);
      float i0 = inv(vUv);
      float bend = abs(inv(vUv + vec2(texel.x, 0.0)) + inv(vUv - vec2(texel.x, 0.0)) - 2.0 * i0)
                 + abs(inv(vUv + vec2(0.0, texel.y)) + inv(vUv - vec2(0.0, texel.y)) - 2.0 * i0);
      float dist = 1.0 / i0;
      float edge = smoothstep(0.004, 0.02, bend / i0) * (1.0 - smoothstep(350.0, 1500.0, dist));
      gl_FragColor = vec4(mix(c.rgb, ink, edge * strength), 1.0);
      #include <colorspace_fragment>
    }`,
});
const postScene = new THREE.Scene();
postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), post));
const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

let gradient = ramp(look.bands);
function applyLook(): void {
  gradient.dispose();
  gradient = ramp(look.bands);
  for (const m of toons) m.gradientMap = gradient;
  hemi.color.setHex(look.skyLight);
  hemi.groundColor.setHex(look.groundLight);
  hemi.intensity = look.ambientPower;
  sun.color.setHex(look.sun);
  sun.intensity = look.sunPower;
  sun.castShadow = look.shadows;
  (sky.material.uniforms.top.value as THREE.Color).setHex(look.skyTop);
  (sky.material.uniforms.horizon.value as THREE.Color).setHex(look.horizon);
  scene.fog!.color.setHex(look.horizon);
  facade.uWindows.value = look.windows;
  facade.uGlow.value = look.glow;
  post.uniforms.strength.value = look.outline;
  (post.uniforms.ink.value as THREE.Color).setHex(look.ink);
}

function renderHud(): void {
  hud.innerHTML = `
    <a class="back" href="../../">← labs</a>
    <h1>${TITLE}</h1>
    <p>${lab === 'buildings' ? 'Every building within reach of the view is grown from its footprint and height by one small grammar: walls, floors, bays, then windows, shopfronts, awnings and roofs. Farther ones stay as boxes on the same grid.' : look.about}</p>
    <p class="detail">${state.detail ? `${detailCount} buildings with built facades right now. ` : ''}${treeCount.toLocaleString()} trees placed by land type.
    ${state.driving ? '<b>Driving:</b> WASD or arrows, or drag on a touch screen. Shift is faster.' : 'Drag to pan, right-drag or two fingers to orbit.'}</p>`;
}

// A stand-in car and a chase camera at about the height a third-person driving game uses.
function carMesh(): THREE.Mesh {
  const box = (w: number, h: number, l: number, x: number, y: number, z: number, c: number): THREE.BufferGeometry => {
    const g = new THREE.BoxGeometry(w, h, l).translate(x, y, z).toNonIndexed();
    const col = new THREE.Color(c);
    const a = new Float32Array(g.getAttribute('position').count * 3);
    for (let i = 0; i < a.length; i += 3) col.toArray(a, i);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  };
  const parts = [box(1.9, 0.7, 4.3, 0, 0.75, 0, 0xe8503a), box(1.7, 0.65, 2.2, 0, 1.4, -0.2, 0xf4e9d8)];
  for (const [x, z] of [[-0.95, 1.4], [0.95, 1.4], [-0.95, -1.4], [0.95, -1.4]]) parts.push(box(0.35, 0.75, 0.75, x, 0.38, z, 0x24262c));
  const mesh = new THREE.Mesh(mergeGeometries(parts)!, mats.car);
  mesh.castShadow = true;
  return mesh;
}
const car = carMesh();
car.visible = false;
scene.add(car);
// Tile coordinates, heading as a compass bearing in radians.
const drive = { x: 0, y: 0, heading: 0, speed: 0, steer: 0, throttle: 0, fast: false };
const keys = new Set<string>();
addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
let stick: { id: number; x: number; y: number } | undefined;
canvas.addEventListener('pointerdown', (e) => {
  if (state.driving && e.pointerType !== 'mouse') stick = { id: e.pointerId, x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointermove', (e) => {
  if (!stick || e.pointerId !== stick.id) return;
  drive.steer = Math.max(-1, Math.min(1, (e.clientX - stick.x) / 70));
  drive.throttle = Math.max(-1, Math.min(1, (stick.y - e.clientY) / 70));
});
const dropStick = (e: PointerEvent) => {
  if (stick?.id !== e.pointerId) return;
  stick = undefined;
  drive.steer = drive.throttle = 0;
};
canvas.addEventListener('pointerup', dropStick);
canvas.addEventListener('pointercancel', dropStick);

const roadHeight = (x: number, y: number): number => surfaceAt.at(x, y) + 0.15;

function stepDrive(dt: number): void {
  const key = (...names: string[]) => names.some((n) => keys.has(n));
  const throttle = stick ? drive.throttle : (key('w', 'arrowup') ? 1 : 0) - (key('s', 'arrowdown') ? 1 : 0);
  const steer = stick ? drive.steer : (key('d', 'arrowright') ? 1 : 0) - (key('a', 'arrowleft') ? 1 : 0);
  const top = keys.has('shift') ? 55 : 28;
  drive.speed += throttle * 16 * dt;
  drive.speed -= drive.speed * (throttle ? 0.25 : 1.2) * dt;
  drive.speed = Math.max(-10, Math.min(top, drive.speed));
  drive.heading += steer * dt * 1.6 * Math.min(1, Math.abs(drive.speed) / 6) * Math.sign(drive.speed || 1);
  const [fx, fy] = [Math.sin(drive.heading), Math.cos(drive.heading)];
  const half = { x: model.size.x / 2 - 5, y: model.size.y / 2 - 5 };
  drive.x = Math.max(-half.x, Math.min(half.x, drive.x + fx * drive.speed * dt));
  drive.y = Math.max(-half.y, Math.min(half.y, drive.y + fy * drive.speed * dt));
  const h = roadHeight(drive.x, drive.y);
  const pitch = Math.atan2(roadHeight(drive.x + fx * 2, drive.y + fy * 2) - roadHeight(drive.x - fx * 2, drive.y - fy * 2), 4);
  car.position.set(drive.x, h, -drive.y);
  car.rotation.set(-pitch, -drive.heading + Math.PI, 0, 'YXZ');
  // Camera sits behind and above, looking a little ahead of the car.
  const want = new THREE.Vector3(drive.x - fx * 9.5, h + 4.2, -(drive.y - fy * 9.5));
  want.y = Math.max(want.y, roadHeight(want.x, -want.z) + 1.5);
  camera.position.lerp(want, 1 - Math.exp(-dt * 5));
  camera.lookAt(drive.x + fx * 5, h + 1.6, -(drive.y + fy * 5));
  controls.target.set(drive.x, h, -drive.y);
}

function setDriving(on: boolean): void {
  state.driving = on;
  controls.enabled = !on;
  car.visible = on;
  if (on) {
    // Start where the camera is looking, facing the way it faces.
    drive.x = controls.target.x;
    drive.y = -controls.target.z;
    drive.heading = Math.atan2(controls.target.x - camera.position.x, -(controls.target.z - camera.position.z));
    drive.speed = 0;
    // Snap straight to the chase position instead of swooping down from the orbit view.
    const h = roadHeight(drive.x, drive.y);
    camera.position.set(drive.x - Math.sin(drive.heading) * 9.5, h + 4.2, -(drive.y - Math.cos(drive.heading) * 9.5));
  } else {
    camera.position.set(drive.x - Math.sin(drive.heading) * 120, roadHeight(drive.x, drive.y) + 90, -(drive.y - Math.cos(drive.heading) * 120));
  }
  renderHud();
}

function lookAt(lat: number, lon: number, distance: number, bearing: number, pitch = 35): void {
  const [e, n] = toNztm(lat, lon);
  const x = e - model.origin.e;
  const y = n - model.origin.n;
  const h = surfaceAt.at(x, y);
  const b = (bearing * Math.PI) / 180;
  controls.target.set(x, h, -y);
  const flat = Math.cos((pitch * Math.PI) / 180) * distance;
  camera.position.set(x - Math.sin(b) * flat, h + Math.sin((pitch * Math.PI) / 180) * distance, -y + Math.cos(b) * flat);
  controls.update();
}
const PLACES: [string, number, number, number, number][] = [
  ['Grafton Bridge', -36.8592, 174.7662, 260, 300],
  ['Queen St / Wellesley St', -36.8512, 174.7642, 190, 180],
  ['University / Albert Park', -36.8512, 174.7692, 320, 250],
  ['Symonds Street Cemetery', -36.8593, 174.7648, 170, 90],
  ['Auckland Domain', -36.8598, 174.7742, 420, 40],
  ['Overview', -36.854, 174.769, 1500, 0],
];

applyLook();
generate();
const at = query.get('at')?.split(',').map(Number);
if (at && at.length >= 4 && at.every(Number.isFinite)) lookAt(at[0], at[1], at[2], at[3], at[4]);
else if (lab === 'buildings') lookAt(-36.8578, 174.7617, 95, 75);
else lookAt(...(PLACES[0].slice(1) as [number, number, number, number]));
if (query.has('drive')) setDriving(true);
renderHud();

const gui = new GUI({ title: 'Look' });
if (innerWidth < 700) gui.close();
const style = gui.addFolder('Style');
const light = gui.addFolder('Light');
const refresh = () => {
  for (const c of gui.controllersRecursive()) c.updateDisplay();
};
gui
  .add(state, 'look', Object.keys(LOOKS))
  .name('Preset')
  .onChange((name: string) => {
    const rebuild = LOOKS[name].palette !== look.palette || LOOKS[name].trees !== look.trees;
    Object.assign(look, LOOKS[name]);
    applyLook();
    if (rebuild) generate();
    refresh();
    renderHud();
  });
gui.add({ drive: () => setDriving(!state.driving) }, 'drive').name('Drive / stop driving');
style.add(look, 'bands', 0, 5, 1).name('Light steps (0 = smooth)').onChange(applyLook);
style.add(look, 'outline', 0, 1, 0.05).name('Outlines').onChange(applyLook);
style.add(look, 'windows', 0, 1, 0.05).name('Windows').onChange(applyLook);
style.add(look, 'glow', 0, 2, 0.05).name('Lit windows').onChange(applyLook);
style.add(look, 'palette', ['toy', 'grey']).name('Building colours').onChange(generate);
style.add(state, 'detail').name('Built facades nearby').onChange(rebuildBuildings);
style.add(state, 'detailRadius', 80, 600, 10).name('Facade reach (m)').onFinishChange(rebuildBuildings);
style.add(look, 'trees').name('Trees').onChange(() => (generate(), renderHud()));
style.add(state, 'hillScale', 1, 2.5, 0.1).name('Hill exaggeration').onFinishChange(generate);
light.add(look, 'sunBearing', 0, 360, 1).name('Sun bearing');
light.add(look, 'sunHeight', 2, 85, 1).name('Sun height');
light.add(look, 'shadows').name('Shadows').onChange(applyLook);
light.close();
const jump = gui.addFolder('Jump to');
for (const [name, ...rest] of PLACES) jump.add({ go: () => (setDriving(false), lookAt(...rest)) }, 'go').name(name);
jump.close();

function resize(): void {
  renderer.setSize(innerWidth, innerHeight, false);
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  target.setSize(size.x, size.y);
  // Sample a little more than a pixel apart so lines keep some weight on dense screens.
  post.uniforms.texel.value.set(1.3 / innerWidth, 1.3 / innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let last = performance.now();
renderer.setAnimationLoop((now: number) => {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (state.driving) stepDrive(dt);
  else controls.update();
  if (state.detail && Math.hypot(controls.target.x - focus.x, controls.target.z - focus.z) > state.detailRadius * 0.3) rebuildBuildings();

  // The sun and its shadow box follow whatever the camera is looking at.
  const b = (look.sunBearing * Math.PI) / 180;
  const el = (look.sunHeight * Math.PI) / 180;
  sun.target.position.copy(controls.target);
  sun.position.set(Math.sin(b) * Math.cos(el), Math.sin(el), -Math.cos(b) * Math.cos(el)).multiplyScalar(1200).add(controls.target);
  sky.position.copy(camera.position);

  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  renderer.render(postScene, postCamera);
});
