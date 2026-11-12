// Lab 5: place profiles. The same generators as the buildings lab, but every point resolves a
// stack of profiles (base → region → district → place → override) and the generators read it.
import * as THREE from 'three';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import '../ui/lab.css';
import { centroid, pointInRing } from '../geo/poly.ts';
import { useOf } from '../gen/styles.ts';
import { loadTile } from '../model/load.ts';
import { ProfileContext } from '../profile/context.ts';
import { PROFILES } from '../profile/library.ts';
import { type Level, clearResolved, leaves } from '../profile/resolve.ts';
import { fromNztm } from '../geo/nztm.ts';
import { createDrive, createStage, lookAtLatLon } from '../view/stage.ts';
import { World } from '../view/world.ts';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const panel = document.getElementById('inspector')!;
hud.innerHTML = `<a class="back" href="../../">← labs</a><h1>Place profiles</h1><p>Loading…</p>`;

const query = new URLSearchParams(location.search);
const tile = query.get('tile') === 'piha' ? 'piha' : 'central';
const stage = createStage(canvas, query.get('look') ?? 'Toy city');
const { model, ground } = await loadTile(tile);

const layers: Record<Level, boolean> = { base: true, region: true, district: true, place: true, override: true };
const swaps: Record<string, string> = {};
for (const s of query.getAll('swap')) {
  const [a, b] = s.split(':');
  if (a && b) swaps[a] = b;
}
const makeCtx = () => new ProfileContext(model, ground, { levels: (Object.keys(layers) as Level[]).filter((l) => layers[l]), swaps });
const map = query.get('map');
const world = new World(stage, model, ground, makeCtx(), {
  hillScale: 1, trees: true, furniture: true, detail: true, detailRadius: 260, palette: 'toy',
  map: map === 'profiles' || map === 'zoning' ? map : 'generated',
});
const drive = createDrive(stage, model, () => world.surface, () => renderHud());

function renderHud(): void {
  const ctx = world.ctx;
  const counts = new Map<string, { title: string; swatch: number; n: number }>();
  for (const b of model.buildings) {
    if (b.cover) continue;
    const t = ctx.forBuilding(b).top;
    const e = counts.get(t.id) ?? { title: t.title, swatch: t.swatch, n: 0 };
    e.n++;
    counts.set(t.id, e);
  }
  const legend = [...counts.values()].sort((a, b) => b.n - a.n).map((e) => `<div><span class="swatch" style="background:#${e.swatch.toString(16).padStart(6, '0')}"></span>${e.title} ${e.n}</div>`).join('');
  const kits = Object.entries(world.stats.kits).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n.toLocaleString()}`).join(', ');
  hud.innerHTML = `
    <a class="back" href="../../">← labs</a>
    <h1>Place profiles · ${model.title}</h1>
    <p>Each point resolves base → region → district (planning zone) → place → override, and every generator reads the result. Click anything to see why it is the way it is.</p>
    <p class="detail">${ctx.profiles.length} distinct resolved profiles. Placed: ${kits}.</p>
    ${world.stamps.map(({ spec, run }) => `<p class="detail">Stamp: ${spec.name}, a ${(world.surface.at(...run[0]) - world.surface.at(...run[run.length - 1])).toFixed(0)} m drop.</p>`).join('')}
    <div class="legend">${legend}</div>
    <p class="detail">${drive.on ? '<b>Driving:</b> WASD or arrows.' : 'Drag to pan, right-drag to orbit, click to inspect.'}</p>`;
}

function regenerate(): void {
  clearResolved();
  world.ctx = makeCtx();
  world.generate();
  renderHud();
}

// Inspector: click (without dragging) to see the stack and what it decided.
const ray = new THREE.Raycaster();
let down: [number, number] | undefined;
canvas.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
canvas.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || drive.on) return;
  ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), stage.camera);
  const targets = [world.terrainMesh!, ...world.buildingMeshes.map((m) => m.mesh)];
  const hit = ray.intersectObjects(targets, false)[0];
  if (hit) inspect(hit.point.x - (hit.face?.normal.x ?? 0) * 0.4, -hit.point.z + (hit.face?.normal.z ?? 0) * 0.4);
});

function inspect(x: number, y: number): void {
  const ctx = world.ctx;
  const info = ctx.describe(x, y);
  const b = model.buildings.find((q) => !q.cover && pointInRing(x, y, q.ring));
  const near = world.placed.filter((p) => Math.hypot(p.x - x, p.y - y) < 3).slice(0, 3);
  let html = `<button class="close" id="close">×</button><h2>${info.profile.top.title}</h2><p>${info.profile.top.about}</p><ul class="stack">
    <li><b>region</b> ${info.region ? `${info.region.id} → ${info.region.profile}` : '—'}</li>
    <li><b>zone</b> ${info.zone ? `${info.zone.zone} → ${info.district ?? 'no profile'}` : '—'}</li>
    <li><b>place</b> ${info.place ? `${info.place.name} → ${info.place.profile}` : '—'}</li>
    <li><b>cover</b> ${info.cover}${info.coverArea?.name ? ` (${info.coverArea.name})` : ''}</li></ul>`;
  if (b) {
    const c = ctx.chooseStyle(b);
    const o = ctx.overrideFor(`building:${b.id}`);
    html += `<h2>${b.name ?? 'Building'} <code>${b.id}</code></h2><p>${b.kind} (${useOf(b.kind)}), ${b.h} m, ${Math.max(1, Math.round(b.h / 3.3))} floors. Style <b>${c.style.name}</b>: “${c.rule.why}” <span class="src">from ${c.ruleFrom}</span>${o && !c.ruleFrom.startsWith('override') ? ` Override: ${o.note}` : ''}</p>`;
  }
  for (const p of near) html += `<p>Placed <b>${p.kit}</b> by ${ctx.profiles[p.profile]?.top.title ?? 'street rules'}.</p>`;
  const rows = [...leaves(b ? ctx.forBuilding(b) : info.profile)].map(([k, v, from]) => `<div><code>${k}</code> = ${JSON.stringify(v).slice(0, 80)} <span class="src">${from}</span></div>`).join('');
  html += `<details><summary>Every resolved field and where it came from</summary>${rows}</details>`;
  panel.innerHTML = html;
  panel.hidden = false;
  document.getElementById('close')!.onclick = () => (panel.hidden = true);
}

const PLACES: Record<string, [string, number, number, number, number][]> = {
  central: [
    ['Queen Street (city centre)', -36.8512, 174.7642, 190, 180],
    ['University heritage core', -36.8500, 174.7700, 170, 220],
    ['Symonds Street Cemetery', -36.8593, 174.7648, 140, 90],
    ['Albert Park', -36.8510, 174.7675, 180, 200],
    ['Auckland Domain', -36.8598, 174.7742, 420, 40],
    ['Overview', -36.854, 174.769, 1500, 0],
  ],
  piha: [
    ['Piha beach and Lion Rock', -36.9536, 174.4697, 420, 250],
    ['Piha village', -36.9540, 174.4760, 260, 280],
    ['Kitekite Falls', -36.9446, 174.4932, 120, 200],
    ['Glen Esk valley bush', -36.9480, 174.4880, 300, 60],
    ['Overview', -36.9505, 174.4795, 2200, 0],
  ],
};
const go = (lat: number, lon: number, d: number, b: number, p?: number) => lookAtLatLon(stage, model, world.surface, lat, lon, d, b, p);

stage.applyLook();
world.generate();
// Stamps find their own spot, so jump to where each one actually landed rather than its anchor.
for (const { spec, run } of world.stamps) {
  const entry = PLACES[tile].find((p) => p[0] === spec.name);
  if (!entry) continue;
  // Aim at the middle of the drop, looking upstream from below it.
  const [[tx, ty], [bx, by]] = [run[0], run[run.length - 1]];
  [entry[1], entry[2]] = fromNztm((tx + bx) / 2 + model.origin.e, (ty + by) / 2 + model.origin.n);
  [entry[3], entry[4]] = [80, (Math.atan2(tx - bx, ty - by) * 180) / Math.PI];
}
const at = query.get('at')?.split(',').map(Number);
if (at && at.length >= 4 && at.every(Number.isFinite)) go(at[0], at[1], at[2], at[3], at[4]);
else {
  const want = query.get('jump')?.toLowerCase();
  const place = PLACES[tile].find((p) => want && p[0].toLowerCase().startsWith(want)) ?? PLACES[tile][0];
  go(...(place.slice(1) as [number, number, number, number]));
}
world.rebuildBuildings();
renderHud();
stage.onFrame(() => world.follow());

const gui = new GUI({ title: 'Profiles' });
if (innerWidth < 700) gui.close();
gui.add({ tile }, 'tile', ['central', 'piha']).name('Tile').onChange((t: string) => (location.search = `?tile=${t}`));
gui.add(world.opts, 'map', ['generated', 'profiles', 'zoning']).name('Show').onChange(() => (world.generate(), renderHud()));
const lf = gui.addFolder('Layers');
for (const l of ['region', 'district', 'place', 'override'] as Level[]) lf.add(layers, l).onChange(regenerate);
const swap = { from: 'victorian-cemetery', to: 'formal-park' };
const sf = gui.addFolder('Swap a profile');
const ids = PROFILES.map((p) => p.id);
sf.add(swap, 'from', ids).name('Wherever');
sf.add(swap, 'to', ids).name('use instead');
sf.add({ apply: () => ((swaps[swap.from] = swap.to), regenerate()) }, 'apply').name('Apply swap');
sf.add({ clear: () => { for (const k of Object.keys(swaps)) delete swaps[k]; regenerate(); } }, 'clear').name('Clear swaps');
sf.close();
gui.add({ drive: () => drive.set(!drive.on) }, 'drive').name('Drive / stop driving');
const jump = gui.addFolder('Jump to');
for (const [name, ...rest] of PLACES[tile]) jump.add({ go: () => (drive.set(false), go(...(rest as [number, number, number, number]))) }, 'go').name(name);
void centroid;
