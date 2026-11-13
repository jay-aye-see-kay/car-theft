// Lab 3: the same generated tile under different looks. Tests how much of "feels like its
// own place" comes from shading, palette, light and a little exaggeration, not from generation.
// Lab 4 (buildings) is this page with the facade grammar switched on and a street-level start.
// Both use the base profile everywhere; the profiles lab is where places differ.
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import '../ui/lab.css';
import { loadTile } from '../model/load.ts';
import { baseContext } from '../profile/context.ts';
import { LOOKS, createDrive, createStage, lookAtLatLon } from '../view/stage.ts';
import { World } from '../view/world.ts';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const lab = document.body.dataset.lab === 'buildings' ? 'buildings' : 'look';
const TITLE = lab === 'buildings' ? 'Building grammar' : 'Look study';
hud.innerHTML = `<a class="back" href="../../">← labs</a><h1>${TITLE}</h1><p>Loading…</p>`;

const query = new URLSearchParams(location.search);
const state = { look: query.get('look') && query.get('look')! in LOOKS ? query.get('look')! : 'Toy city' };
const stage = createStage(canvas, state.look);
const { look } = stage;

const { model, ground } = await loadTile('central');
const world = new World(stage, model, ground, baseContext(model, ground), {
  hillScale: Number(query.get('hills')) || 1,
  trees: look.trees,
  furniture: !query.has('bare'),
  detail: lab === 'buildings',
  detailRadius: 260,
  palette: look.palette,
  map: 'generated',
});
const opts = world.opts;
const drive = createDrive(stage, model, () => world.surface, () => renderHud());

function renderHud(): void {
  const s = world.stats;
  hud.innerHTML = `
    <a class="back" href="../../">← labs</a>
    <h1>${TITLE}</h1>
    <p>${lab === 'buildings' ? 'Every building within reach of the view is grown from its footprint and height by one small grammar: walls, floors, bays, then windows, shopfronts, awnings and roofs. Farther ones stay as boxes on the same grid.' : look.about}</p>
    <p class="detail">${opts.detail ? `${s.detail} buildings with built facades right now. ` : ''}${s.trees.toLocaleString()} trees placed by land type in the ${s.cells.loaded} cells around the view${s.props ? `, ${s.props.toLocaleString()} lamps, street trees and signals by street type` : ''}.
    ${drive.on ? '<b>Driving:</b> WASD or arrows, or drag on a touch screen. Shift is faster.' : 'Drag to pan, right-drag or two fingers to orbit.'}</p>`;
}

const generate = () => {
  opts.trees = look.trees;
  opts.palette = look.palette;
  world.generate();
  renderHud();
};

const PLACES: [string, number, number, number, number][] = [
  ['Grafton Bridge', -36.8592, 174.7662, 260, 300],
  ['Queen St / Wellesley St', -36.8512, 174.7642, 190, 180],
  ['University / Albert Park', -36.8512, 174.7692, 320, 250],
  ['Symonds Street Cemetery', -36.8593, 174.7648, 170, 90],
  ['Auckland Domain', -36.8598, 174.7742, 420, 40],
  ['Overview', -36.854, 174.769, 1500, 0],
];
const go = (lat: number, lon: number, d: number, b: number, p?: number) => lookAtLatLon(stage, model, world.surface, lat, lon, d, b, p);

stage.applyLook();
generate();
const at = query.get('at')?.split(',').map(Number);
if (at && at.length >= 4 && at.every(Number.isFinite)) go(at[0], at[1], at[2], at[3], at[4]);
else if (lab === 'buildings') go(-36.8578, 174.7617, 95, 75);
else go(...(PLACES[0].slice(1) as [number, number, number, number]));
world.rebuildBuildings();
if (query.has('drive')) drive.set(true);
renderHud();
world.onCells = renderHud;
stage.onFrame(() => {
  const before = world.stats.detail;
  world.follow();
  if (world.stats.detail !== before) renderHud();
});

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
    stage.applyLook();
    if (rebuild) generate();
    refresh();
    renderHud();
  });
gui.add({ drive: () => drive.set(!drive.on) }, 'drive').name('Drive / stop driving');
style.add(look, 'bands', 0, 5, 1).name('Light steps (0 = smooth)').onChange(stage.applyLook);
style.add(look, 'outline', 0, 1, 0.05).name('Outlines').onChange(stage.applyLook);
style.add(look, 'windows', 0, 1, 0.05).name('Windows').onChange(stage.applyLook);
style.add(look, 'glow', 0, 2, 0.05).name('Lit windows').onChange(stage.applyLook);
style.add(look, 'palette', ['toy', 'grey']).name('Building colours').onChange(generate);
style.add(opts, 'detail').name('Built facades nearby').onChange(() => (world.rebuildBuildings(), renderHud()));
style.add(opts, 'detailRadius', 80, 600, 10).name('Facade reach (m)').onFinishChange(() => (world.rebuildBuildings(), renderHud()));
style.add(look, 'trees').name('Trees').onChange(generate);
style.add(opts, 'furniture').name('Street furniture').onChange(generate);
style.add(opts, 'hillScale', 1, 2.5, 0.1).name('Hill exaggeration').onFinishChange(generate);
light.add(look, 'sunBearing', 0, 360, 1).name('Sun bearing');
light.add(look, 'sunHeight', 2, 85, 1).name('Sun height');
light.add(look, 'shadows').name('Shadows').onChange(stage.applyLook);
light.close();
const jump = gui.addFolder('Jump to');
for (const [name, ...rest] of PLACES) jump.add({ go: () => (drive.set(false), go(...(rest as [number, number, number, number]))) }, 'go').name(name);
jump.close();
