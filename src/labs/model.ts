// Lab 1: a 2D inspector for the semantic model. Nothing here is generated; it shows what
// the interpreter made of the raw map and LiDAR data, which is all the generators get.
import '../ui/lab.css';
import { AREA_COLOURS } from '../gen/terrain.ts';
import { loadTile } from '../model/load.ts';
import type { Pt, Road, RoadClass } from '../model/types.ts';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const g = canvas.getContext('2d')!;
hud.innerHTML = `<a class="back" href="../../">← labs</a><h1>The semantic model</h1><p>Loading…</p>`;

const { model, ground } = await loadTile('central');

type Mode = 'class' | 'lanes' | 'level';
let mode: Mode = 'lanes';
let selected: Road | undefined;

// View: tile metres to screen pixels.
let scale = 1;
let cx = 0;
let cy = 0;
const toScreen = (x: number, y: number): [number, number] => [canvas.width / 2 + (x - cx) * scale, canvas.height / 2 - (y - cy) * scale];
const toTile = (sx: number, sy: number): Pt => [cx + (sx - canvas.width / 2) / scale, cy - (sy - canvas.height / 2) / scale];

// Hillshade of the bare-earth LiDAR, drawn once.
const shade = document.createElement('canvas');
shade.width = ground.cols;
shade.height = ground.rows;
{
  const sg = shade.getContext('2d')!;
  const img = sg.createImageData(ground.cols, ground.rows);
  for (let r = 1; r < ground.rows - 1; r++) {
    for (let c = 1; c < ground.cols - 1; c++) {
      const k = r * ground.cols + c;
      const dx = (ground.data[k + 1] - ground.data[k - 1]) / (2 * ground.cell);
      const dy = (ground.data[k + ground.cols] - ground.data[k - ground.cols]) / (2 * ground.cell);
      const light = Math.max(0, Math.min(1, 0.62 + (dy - dx) * 0.9));
      const o = ((ground.rows - 1 - r) * ground.cols + c) * 4;
      img.data[o] = 44 + light * 60;
      img.data[o + 1] = 50 + light * 62;
      img.data[o + 2] = 52 + light * 58;
      img.data[o + 3] = 255;
    }
  }
  sg.putImageData(img, 0, 0);
}

const CLASS_COLOUR: Record<RoadClass, string> = { motorway: '#e0568a', ramp: '#e88ab0', arterial: '#f2b544', collector: '#f5d98a', street: '#f0f0ea', lane: '#b7bcc4' };
const LANE_COLOUR = ['#b7bcc4', '#8fd0ff', '#5fb0f5', '#f2d544', '#f59a3a', '#ee5a3a', '#d92b6b', '#a020c0', '#a020c0'];
const LANE_WIDTH: Record<RoadClass, number> = { motorway: 3.6, ramp: 4, arterial: 3.3, collector: 3.2, street: 3.1, lane: 2.9 };

function trace(pts: Pt[], close = false): void {
  g.beginPath();
  pts.forEach(([x, y], i) => {
    const [sx, sy] = toScreen(x, y);
    if (i) g.lineTo(sx, sy);
    else g.moveTo(sx, sy);
  });
  if (close) g.closePath();
}

/** The points of a road between two distances along it. */
function slice(road: Road, s0: number, s1: number): Pt[] {
  const out: Pt[] = [];
  let s = 0;
  for (let i = 1; i < road.pts.length; i++) {
    const [a, b] = [road.pts[i - 1], road.pts[i]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const lerp = (at: number): Pt => [a[0] + ((b[0] - a[0]) * (at - s)) / (len || 1), a[1] + ((b[1] - a[1]) * (at - s)) / (len || 1)];
    if (s + len >= s0 && s <= s1) {
      if (!out.length) out.push(lerp(Math.max(s, s0)));
      out.push(lerp(Math.min(s + len, s1)));
    }
    s += len;
  }
  return out;
}

function draw(): void {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#14171c';
  g.fillRect(0, 0, canvas.width, canvas.height);
  const [x0, y0] = toScreen(-model.size.x / 2, model.size.y / 2);
  g.imageSmoothingEnabled = scale < 2;
  g.drawImage(shade, x0, y0, model.size.x * scale, model.size.y * scale);

  g.globalAlpha = 0.55;
  for (const a of model.areas) {
    trace(a.ring, true);
    g.fillStyle = AREA_COLOURS[a.kind];
    g.fill();
  }
  g.globalAlpha = 1;

  g.lineWidth = Math.max(0.6, 1.2 * scale);
  g.setLineDash([3 * scale, 3 * scale]);
  g.strokeStyle = 'rgba(232,220,190,0.55)';
  for (const p of model.paths) {
    trace(p.pts);
    g.stroke();
  }
  g.setLineDash([]);

  for (const b of model.buildings) {
    trace(b.ring, true);
    // Taller is lighter; anything not measured by LiDAR is outlined in red.
    const v = Math.min(1, Math.log2(1 + b.h) / 7.2);
    g.fillStyle = `hsl(215 14% ${24 + v * 52}%)`;
    g.fill();
    if (b.hSource !== 'lidar') {
      g.strokeStyle = '#ff6b5a';
      g.lineWidth = 1.5;
      g.stroke();
    }
  }

  g.lineCap = 'butt';
  g.lineJoin = 'round';
  for (const road of model.roads) {
    for (const sec of road.sections) {
      const lanes = sec.lanesF + sec.lanesB;
      trace(slice(road, sec.s0, sec.s1));
      g.lineWidth = Math.max(1.2, lanes * LANE_WIDTH[sec.cls] * scale);
      g.strokeStyle =
        mode === 'class' ? CLASS_COLOUR[sec.cls] : mode === 'lanes' ? LANE_COLOUR[lanes] : sec.level > 0 ? '#ffd24a' : sec.level < 0 ? '#7a5cff' : '#8d939c';
      g.globalAlpha = road === selected ? 1 : 0.85;
      g.stroke();
    }
  }
  g.globalAlpha = 1;

  if (selected) {
    trace(selected.pts);
    g.lineWidth = 2;
    g.strokeStyle = '#ffffff';
    g.stroke();
  }

  if (scale > 0.7) {
    for (const j of model.junctions) {
      if (j.arms.length < 3) continue;
      const [sx, sy] = toScreen(j.x, j.y);
      g.beginPath();
      g.arc(sx, sy, Math.max(2, 2.2 * scale), 0, Math.PI * 2);
      g.fillStyle = '#14171c';
      g.fill();
      g.lineWidth = 1.2;
      g.strokeStyle = '#ffffff';
      g.stroke();
    }
  }
}

function describe(road: Road): string {
  const rows = road.sections.map((s) => {
    const lanes = s.lanesB ? `${s.lanesF}+${s.lanesB} lanes` : `${s.lanesF} lane${s.lanesF > 1 ? 's' : ''} one-way`;
    const where = s.level > 0 ? ' · bridge' : s.level < 0 ? ' · tunnel' : '';
    return `${Math.round(s.s0).toString().padStart(4)}–${Math.round(s.s1).toString().padEnd(4)} m  ${s.cls}, ${lanes}${where}`;
  });
  const name = road.sections.find((s) => s.name)?.name ?? '(unnamed)';
  return `${name}\n${road.id}  ${road.a} → ${road.b}\n${rows.join('\n')}`;
}

function renderHud(): void {
  const r = model.report;
  const legend =
    mode === 'lanes'
      ? [1, 2, 3, 4, 5, 6].map((n) => `<span class="swatch" style="background:${LANE_COLOUR[n]}"></span>${n}`).join('&nbsp; ')
      : mode === 'class'
        ? (Object.keys(CLASS_COLOUR) as RoadClass[]).map((c) => `<span class="swatch" style="background:${CLASS_COLOUR[c]}"></span>${c}`).join('&nbsp; ')
        : `<span class="swatch" style="background:#ffd24a"></span>bridge&nbsp; <span class="swatch" style="background:#7a5cff"></span>tunnel&nbsp; <span class="swatch" style="background:#8d939c"></span>ground`;
  hud.innerHTML = `
    <a class="back" href="../../">← labs</a>
    <h1>The semantic model</h1>
    <p class="detail">What the generators are given. Drag to pan, scroll or pinch to zoom, click a road.</p>
    <label>Colour roads by
      <select id="mode">
        <option value="lanes">total lanes</option><option value="class">class</option><option value="level">bridge / tunnel</option>
      </select>
    </label>
    <p>${legend}</p>
    <table class="detail">
      <tr><td>Map ways used</td><td>${r['osm.waysUsed']}</td></tr>
      <tr><td>Roads after joining</td><td>${r['roads.count']} · ${r['roads.km']} km</td></tr>
      <tr><td>Tag-only breaks absorbed</td><td>${r['roads.sectionChangesAbsorbed']}</td></tr>
      <tr><td>Roads with lane changes</td><td>${r['roads.withLaneChanges']}</td></tr>
      <tr><td>Junctions</td><td>${r['junctions.count']}</td></tr>
      <tr><td>Short links folded into junctions</td><td>${r['junctions.shortLinksCollapsed']}</td></tr>
      <tr><td>Driveways and aisles set aside</td><td>${r['roads.skippedDrivewaysAndAisles']}</td></tr>
      <tr><td>Buildings (LiDAR height)</td><td>${r['buildings.count']} (${r['buildings.height.lidar']})</td></tr>
      <tr><td>Roadside footpaths set aside</td><td>${r['paths.skippedRoadsideAndCrossings']}</td></tr>
    </table>
    ${selected ? `<pre>${describe(selected)}</pre>` : ''}`;
  const sel = hud.querySelector<HTMLSelectElement>('#mode')!;
  sel.value = mode;
  sel.onchange = () => {
    mode = sel.value as Mode;
    renderHud();
    draw();
  };
}

function pick(x: number, y: number): Road | undefined {
  let best: Road | undefined;
  let bestD = 14 / scale + 6;
  for (const road of model.roads) {
    for (let i = 1; i < road.pts.length; i++) {
      const [a, b] = [road.pts[i - 1], road.pts[i]];
      const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 || 1;
      const u = Math.min(1, Math.max(0, ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / len2));
      const d = Math.hypot(x - (a[0] + (b[0] - a[0]) * u), y - (a[1] + (b[1] - a[1]) * u));
      if (d < bestD) [best, bestD] = [road, d];
    }
  }
  return best;
}

function resize(): void {
  const dpr = Math.min(devicePixelRatio, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  draw();
}

// Pointer handling: one finger or the mouse pans, two fingers pinch, the wheel zooms.
const pointers = new Map<number, { x: number; y: number }>();
let moved = 0;
const dprOf = () => canvas.width / innerWidth;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  moved = 0;
});
canvas.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  const dpr = dprOf();
  if (pointers.size === 1) {
    cx -= ((e.clientX - prev.x) * dpr) / scale;
    cy += ((e.clientY - prev.y) * dpr) / scale;
  } else if (pointers.size === 2) {
    const other = [...pointers.entries()].find(([id]) => id !== e.pointerId)![1];
    const before = Math.hypot(prev.x - other.x, prev.y - other.y);
    const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
    if (before > 0) scale = Math.min(40, Math.max(0.2, (scale * after) / before));
  }
  moved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  draw();
});
const release = (e: PointerEvent) => {
  if (pointers.size === 1 && moved < 5) {
    const dpr = dprOf();
    const [x, y] = toTile(e.clientX * dpr, e.clientY * dpr);
    selected = pick(x, y);
    renderHud();
    draw();
  }
  pointers.delete(e.pointerId);
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', (e) => pointers.delete(e.pointerId));
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const dpr = dprOf();
    const [x, y] = toTile(e.clientX * dpr, e.clientY * dpr);
    scale = Math.min(40, Math.max(0.2, scale * Math.exp(-e.deltaY * 0.0015)));
    // Keep the point under the cursor fixed.
    const [nx, ny] = toTile(e.clientX * dpr, e.clientY * dpr);
    cx += x - nx;
    cy += y - ny;
    draw();
  },
  { passive: false },
);

addEventListener('resize', resize);
scale = Math.min((innerWidth * Math.min(devicePixelRatio, 2)) / model.size.x, (innerHeight * Math.min(devicePixelRatio, 2)) / model.size.y) * 0.95;
renderHud();
resize();
