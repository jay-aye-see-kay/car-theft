// Lab 2: roads generated from the semantic model, in context.
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import '../ui/lab.css';
import { toNztm } from '../geo/nztm.ts';
import { buildMassing } from '../gen/buildings.ts';
import { buildCovers } from '../gen/covers.ts';
import { type JunctionShape, solveJunctions } from '../gen/junctions.ts';
import { buildRoadMeshes } from '../gen/roadMesh.ts';
import { buildTerrainGeometry, gradeTerrain, paintGround } from '../gen/terrain.ts';
import { DEFAULT_PARAMS, type RoadParams, type Track, buildTrack, solveElevations } from '../gen/tracks.ts';
import { loadTile } from '../model/load.ts';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
hud.innerHTML = `<a class="back" href="../../">← labs</a><h1>Road builder</h1><p>Loading…</p>`;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbfd9ea);
scene.fog = new THREE.Fog(0xbfd9ea, 900, 3200);
const camera = new THREE.PerspectiveCamera(50, 1, 1, 6000);
const controls = new MapControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 8;
controls.maxDistance = 2500;

scene.add(new THREE.HemisphereLight(0xdcecff, 0x6b6a5c, 1.5));
const sun = new THREE.DirectionalLight(0xfff2dd, 2.0);
sun.position.set(-0.5, 1, 0.35);
scene.add(sun);

const { model, ground } = await loadTile('central');

const params: RoadParams = structuredClone(DEFAULT_PARAMS);
const view = { tintJunctions: false, buildings: true, markings: true, wireframe: false };

const mats = {
  terrain: new THREE.MeshLambertMaterial({ map: new THREE.CanvasTexture(paintGround(model)) }),
  surface: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
  markings: new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  buildings: new THREE.MeshLambertMaterial({ vertexColors: true }),
  covers: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
  glass: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.42, depthWrite: false }),
};
mats.terrain.map!.colorSpace = THREE.SRGBColorSpace;
mats.terrain.map!.anisotropy = renderer.capabilities.getMaxAnisotropy();

const world = new THREE.Group();
scene.add(world);
const buildings = new THREE.Mesh(buildMassing(
  model.buildings.filter((b) => !b.cover),
  ground,
), mats.buildings);
scene.add(buildings);

let tracks = new Map<string, Track>();
let shapes: JunctionShape[] = [];

function generate(): void {
  const t0 = performance.now();
  for (const child of world.children) (child as THREE.Mesh).geometry.dispose();
  world.clear();

  tracks = new Map(model.roads.map((r) => [r.id, buildTrack(r, params)]));
  solveElevations(model, tracks, ground, params);
  shapes = solveJunctions(model, tracks, params);
  const graded = gradeTerrain(ground, tracks.values(), shapes, params);
  const roads = buildRoadMeshes(tracks.values(), shapes, params, { tintJunctions: view.tintJunctions });

  world.add(new THREE.Mesh(buildTerrainGeometry(graded), mats.terrain));
  world.add(new THREE.Mesh(roads.surface, mats.surface));
  const markings = new THREE.Mesh(roads.markings, mats.markings);
  markings.visible = view.markings;
  markings.name = 'markings';
  world.add(markings);
  const covers = buildCovers(model.buildings, graded, tracks.values());
  world.add(new THREE.Mesh(covers.frame, mats.covers), new THREE.Mesh(covers.glass, mats.glass));

  const count = (s: JunctionShape['status']) => shapes.filter((j) => j.status === s).length;
  const tapers = model.report['roads.withLaneChanges'];
  hud.innerHTML = `
    <a class="back" href="../../">← labs</a>
    <h1>Road builder</h1>
    <p class="detail">Every road here is generated from the model with no manual overrides. Drag to pan, right-drag or two fingers to orbit, scroll to zoom.</p>
    <table>
      <tr><td>Roads</td><td>${model.roads.length} · ${model.report['roads.km']} km</td></tr>
      <tr><td>Roads with a lane-count taper</td><td>${tapers}</td></tr>
      <tr><td><span class="swatch" style="background:#3d8f5f"></span>Junctions solved cleanly</td><td>${count('ok')}</td></tr>
      <tr><td><span class="swatch" style="background:#d9862b"></span>Squeezed (arms too short)</td><td>${count('squeezed')}</td></tr>
      <tr><td><span class="swatch" style="background:#b04bd1"></span>Shallow merges</td><td>${count('merge')}</td></tr>
      <tr><td>Generated in</td><td>${Math.round(performance.now() - t0)} ms</td></tr>
    </table>`;
}

// Places worth looking at, as [name, lat, lon, camera distance, compass bearing the camera looks along].
const PLACES: [string, number, number, number, number][] = [
  ['Overview', -36.854, 174.769, 1500, 0],
  ['Grafton Gully motorway', -36.8562, 174.7712, 420, 340],
  ['Symonds St / Karangahape Rd', -36.8582, 174.7632, 160, 20],
  ['Grafton Bridge', -36.8592, 174.7662, 260, 300],
  ['Central Motorway Junction', -36.8615, 174.7625, 520, 30],
  ['Queen St / Wellesley St', -36.8512, 174.7642, 170, 180],
  ['University / Albert Park', -36.8512, 174.7692, 320, 250],
];

function lookAt(lat: number, lon: number, distance: number, bearing: number): void {
  const [e, n] = toNztm(lat, lon);
  const x = e - model.origin.e;
  const y = n - model.origin.n;
  const h = ground.at(x, y);
  const b = (bearing * Math.PI) / 180;
  controls.target.set(x, h, -y);
  // Sit behind the target, opposite the bearing, looking down at about 35 degrees.
  camera.position.set(x - Math.sin(b) * distance * 0.8, h + distance * 0.57, -y + Math.cos(b) * distance * 0.8);
  controls.update();
}

function laneDrop(): void {
  // The biggest change in lane count on a motorway or ramp: the prototype's failing case.
  let best: { t: Track; s: number; drop: number } | undefined;
  for (const t of tracks.values()) {
    if (t.cls !== 'motorway' && t.cls !== 'ramp') continue;
    const k = t.length / (t.road.sections[t.road.sections.length - 1].s1 || 1);
    t.road.sections.forEach((sec, i) => {
      if (!i) return;
      const drop = Math.abs(sec.lanesF - t.road.sections[i - 1].lanesF);
      if (drop && (!best || drop > best.drop || (drop === best.drop && t.length > best.t.length))) best = { t, s: sec.s0 * k, drop };
    });
  }
  if (!best) return;
  const { t, s } = best;
  const i = Math.min(t.n - 1, Math.round((s / t.length) * (t.n - 1)));
  controls.target.set(t.x[i], t.h[i], -t.y[i]);
  camera.position.set(t.x[i] - t.tx[i] * 90, t.h[i] + 55, -t.y[i] + t.ty[i] * 90);
  controls.update();
}

// ?at=lat,lon,distance,bearing opens on a specific view, and ?health=1 turns on junction tinting, for sharing.
const query = new URLSearchParams(location.search);
view.tintJunctions = query.has('health');
generate();
const at = query.get('at')?.split(',').map(Number);
if (at?.length === 4 && at.every(Number.isFinite)) lookAt(at[0], at[1], at[2], at[3]);
else if (query.has('lanedrop')) laneDrop();
else lookAt(...(PLACES[1].slice(1) as [number, number, number, number]));

const gui = new GUI({ title: 'Generator' });
if (innerWidth < 700) gui.close();
const go: Record<string, () => void> = { 'Motorway lane change': laneDrop };
for (const [name, ...rest] of PLACES) go[name] = () => lookAt(...rest);
const jump = gui.addFolder('Jump to');
for (const name of Object.keys(go)) jump.add(go, name);
const shape = gui.addFolder('Shape');
shape.add(params, 'taperStreet', 2, 30, 1).name('Taper, streets (m per m)');
shape.add(params, 'taperMotorway', 10, 80, 1).name('Taper, motorway (m per m)');
shape.add(params, 'kerbRadius', 1, 14, 0.5).name('Kerb radius (m)');
shape.add(params, 'footpathWidth', 1, 5, 0.1).name('Footpath width (m)');
shape.add(params, 'profileSmoothing', 0, 120, 1).name('Hill smoothing');
shape.add(params, 'gradeBlend', 2, 25, 1).name('Bank width (m)');
shape.onFinishChange(generate);
const show = gui.addFolder('Show');
show.add(view, 'tintJunctions').name('Junction health').onChange(generate);
show.add(view, 'markings').name('Markings').onChange((v: boolean) => (world.getObjectByName('markings')!.visible = v));
show.add(view, 'buildings').name('Buildings').onChange((v: boolean) => (buildings.visible = v));
show.add(view, 'wireframe').name('Wireframe').onChange((v: boolean) => (mats.surface.wireframe = v));

function resize(): void {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
