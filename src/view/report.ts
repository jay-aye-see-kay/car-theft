// Defect reports: click "?" then click the thing that's wrong and say why. Each report records the
// exact point, what the model has there, and the camera, so whoever fixes it can go straight to it.
// Reports live in this browser's localStorage until copied out. The view is also kept in the URL
// (#view=…), so a link or a screenshot of the address bar is enough to find a spot again.
import * as THREE from 'three';
import type { TileModel } from '../model/types.ts';
import type { Stage } from './stage.ts';

declare const __BUILD__: string;

export interface Report {
  id: number;
  tile: string;
  lab: string;
  build: string;
  comment: string;
  /** The clicked point: metres from the tile centre (x east, y north), height, and NZTM. */
  at: { x: number; y: number; h: number; e: number; n: number };
  /** Which kind of surface the click landed on (a key of the stage's materials). */
  hit: string;
  /** What the model and the generators have there. */
  context: Record<string, unknown>;
  /** Camera position then target, in scene coordinates (x east, y up, z south). */
  view: number[];
  url: string;
}

interface Options {
  lab: string;
  model: TileModel;
  /** Anything more the lab knows about a point: profile, placed props and so on. */
  describe?: (x: number, y: number) => Record<string, unknown>;
}

const KEY = 'cartheft-reports';
const r1 = (v: number) => Math.round(v * 10) / 10;

function load(): Report[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Report[];
  } catch {
    return [];
  }
}

function parseView(): number[] | undefined {
  const v = new URLSearchParams(location.hash.slice(1)).get('view')?.split(',').map(Number);
  return v && v.length === 6 && v.every(Number.isFinite) ? v : undefined;
}

function setView(stage: Stage, v: number[]): void {
  stage.camera.position.set(v[0], v[1], v[2]);
  stage.controls.target.set(v[3], v[4], v[5]);
  stage.controls.update();
}

/** Puts the camera where the URL's #view says, if it says. Returns whether it did. */
export function restoreView(stage: Stage): boolean {
  const v = parseView();
  if (v) setView(stage, v);
  return !!v;
}

/** The nearest road to a point, and the section of it alongside. */
function nearestRoad(model: TileModel, x: number, y: number): Record<string, unknown> | undefined {
  let best: { d: number; s: number; road: TileModel['roads'][number] } | undefined;
  for (const road of model.roads) {
    let s = 0;
    for (let i = 1; i < road.pts.length; i++) {
      const [ax, ay] = road.pts[i - 1];
      const [bx, by] = road.pts[i];
      const len = Math.hypot(bx - ax, by - ay);
      const t = len ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / (len * len))) : 0;
      const d = Math.hypot(x - ax - (bx - ax) * t, y - ay - (by - ay) * t);
      if (!best || d < best.d) best = { d, s: s + len * t, road };
      s += len;
    }
  }
  if (!best || best.d > 60) return undefined;
  const { road, s, d } = best;
  const sec = road.sections.find((q) => s >= q.s0 && s <= q.s1) ?? road.sections[0];
  return { id: road.id, name: sec?.name, cls: sec?.cls, lanesF: sec?.lanesF, lanesB: sec?.lanesB, level: sec?.level, s: r1(s), offset: r1(d), from: road.a, to: road.b };
}

function nearestJunction(model: TileModel, x: number, y: number): Record<string, unknown> | undefined {
  let best: TileModel['junctions'][number] | undefined;
  let bd = 40;
  for (const j of model.junctions) {
    const d = Math.hypot(j.x - x, j.y - y);
    if (d < bd) [best, bd] = [j, d];
  }
  return best && { id: best.id, distance: r1(bd), arms: best.arms.map((a) => a.road) };
}

export function createReports(stage: Stage, opts: Options) {
  const { model, lab } = opts;
  const canvas = stage.renderer.domElement;
  let reports = load();
  let picking = false;
  let draft: Report | undefined;

  const box = document.createElement('div');
  box.className = 'hud reports';
  document.body.append(box);

  // Numbered pins that stay the same size on screen and show through whatever is in front.
  const pins = new THREE.Group();
  stage.scene.add(pins);
  function pin(r: Report, colour: string): THREE.Sprite {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d')!;
    g.fillStyle = colour;
    g.beginPath();
    g.arc(32, 32, 28, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 5;
    g.strokeStyle = '#14171c';
    g.stroke();
    g.fillStyle = '#14171c';
    g.font = 'bold 34px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(r.id), 32, 35);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, depthWrite: false, fog: false }));
    s.scale.setScalar(0.045);
    s.position.set(r.at.x, r.at.h + 0.5, -r.at.y);
    s.renderOrder = 10;
    return s;
  }

  const mine = () => reports.filter((r) => r.tile === model.id);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

  function render(): void {
    for (const s of pins.children as THREE.Sprite[]) (s.material.map?.dispose(), s.material.dispose());
    pins.clear();
    for (const r of mine()) pins.add(pin(r, '#f2b544'));
    if (draft) pins.add(pin(draft, '#ff6b5a'));
    canvas.style.cursor = picking ? 'crosshair' : '';

    const others = reports.length - mine().length;
    let html = `<button id="rp-toggle" class="${picking ? 'on' : ''}" title="Report a defect (?)">${picking ? 'Click the thing that’s wrong · Esc' : '? Report a defect'}</button>`;
    if (draft) {
      const c = draft.context as { road?: { name?: string; id: string }; building?: { name?: string; id: string } };
      const what = c.building ? `building ${c.building.name ?? c.building.id}` : c.road ? `${c.road.name ?? 'road'} ${c.road.id}` : draft.hit;
      html += `<p>#${draft.id} on <b>${esc(draft.hit)}</b>, ${esc(what)}</p>
        <textarea id="rp-text" rows="3" placeholder="What’s wrong here?"></textarea>
        <div class="row"><button id="rp-save">Save (⌘↵)</button><button id="rp-cancel">Cancel</button></div>`;
    }
    if (reports.length) {
      html += `<ol>${mine().map((r) => `<li value="${r.id}"><a href="#" data-go="${r.id}">${esc(r.comment) || '(no comment)'}</a> <button data-del="${r.id}" title="Delete">×</button></li>`).join('')}</ol>`;
      if (others) html += `<p>${others} more on other tiles.</p>`;
      html += `<div class="row"><button id="rp-copy">Copy ${reports.length} for Claude</button><button id="rp-clear">Clear all</button></div>`;
    }
    box.innerHTML = html;

    box.querySelector<HTMLButtonElement>('#rp-toggle')!.onclick = () => setPicking(!picking);
    const text = box.querySelector<HTMLTextAreaElement>('#rp-text');
    if (text) {
      text.focus();
      text.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(text.value);
        if (e.key === 'Escape') cancel();
      };
      text.onkeyup = (e) => e.stopPropagation();
      box.querySelector<HTMLButtonElement>('#rp-save')!.onclick = () => save(text.value);
      box.querySelector<HTMLButtonElement>('#rp-cancel')!.onclick = cancel;
    }
    for (const a of box.querySelectorAll<HTMLElement>('[data-go]')) {
      a.onclick = (e) => {
        e.preventDefault();
        const r = reports.find((q) => q.id === Number(a.dataset.go));
        if (r) setView(stage, r.view);
      };
    }
    for (const b of box.querySelectorAll<HTMLElement>('[data-del]')) {
      b.onclick = () => {
        reports = reports.filter((q) => q.id !== Number(b.dataset.del));
        store();
      };
    }
    const copy = box.querySelector<HTMLButtonElement>('#rp-copy');
    if (copy) {
      copy.onclick = async () => {
        const out = `Car Theft labs defect reports\n${reports.map((r) => JSON.stringify(r)).join('\n')}\n`;
        try {
          await navigator.clipboard.writeText(out);
          copy.textContent = 'Copied. Paste it to Claude.';
        } catch {
          // No clipboard access (an insecure origin, say): show the text to copy by hand.
          const ta = document.createElement('textarea');
          ta.value = out;
          ta.rows = 6;
          box.append(ta);
          ta.select();
        }
      };
    }
    const clear = box.querySelector<HTMLButtonElement>('#rp-clear');
    if (clear) {
      clear.onclick = () => {
        if (!confirm(`Delete all ${reports.length} reports?`)) return;
        reports = [];
        store();
      };
    }
  }

  function store(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(reports));
    } catch {
      // Private windows may refuse storage; the reports still last until the page closes.
    }
    render();
  }

  function setPicking(on: boolean): void {
    picking = on;
    if (!on) draft = undefined;
    render();
  }

  function save(comment: string): void {
    if (!draft) return;
    reports.push({ ...draft, comment: comment.trim() });
    draft = undefined;
    picking = false;
    store();
  }

  function cancel(): void {
    draft = undefined;
    picking = false;
    render();
  }

  const viewNow = () => [...stage.camera.position.toArray(), ...stage.controls.target.toArray()].map(r1);
  const urlFor = (view: number[]) => `${location.origin}${location.pathname}${location.search}#view=${view.join(',')}`;

  const ray = new THREE.Raycaster();
  const shown = (o: THREE.Object3D | null): boolean => {
    for (; o; o = o.parent) if (!o.visible) return false;
    return true;
  };
  function pick(clientX: number, clientY: number): void {
    ray.setFromCamera(new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1), stage.camera);
    const solid = (o: THREE.Object3D): o is THREE.Mesh => o instanceof THREE.Mesh && o.material !== stage.mats.lampPools && shown(o);
    const targets: THREE.Object3D[] = [];
    stage.scene.traverse((o) => {
      if (solid(o)) targets.push(o);
    });
    // The sky dome is a mesh too, thousands of metres out.
    const hit = ray.intersectObjects(targets, false).find((h) => h.distance < 5000);
    if (!hit) return;
    const [x, y, h] = [hit.point.x, -hit.point.z, hit.point.y];
    const material = (hit.object as THREE.Mesh).material;
    const view = viewNow();
    const b = model.buildings.find((q) => {
      let inside = false;
      for (let i = 0, j = q.ring.length - 1; i < q.ring.length; j = i++) {
        const [xi, yi] = q.ring[i];
        const [xj, yj] = q.ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    });
    draft = {
      id: Math.max(0, ...reports.map((r) => r.id)) + 1,
      tile: model.id,
      lab,
      build: __BUILD__,
      comment: '',
      at: { x: r1(x), y: r1(y), h: r1(h), e: r1(x + model.origin.e), n: r1(y + model.origin.n) },
      hit: Object.entries(stage.mats).find(([, m]) => m === material)?.[0] ?? 'other',
      context: {
        road: nearestRoad(model, x, y),
        junction: nearestJunction(model, x, y),
        building: b && { id: b.id, name: b.name, kind: b.kind, h: b.h, cover: b.cover },
        ...opts.describe?.(x, y),
      },
      view,
      url: urlFor(view),
    };
    render();
  }

  let down: [number, number] | undefined;
  canvas.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
  canvas.addEventListener('pointerup', (e) => {
    if (picking && down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) <= 4) pick(e.clientX, e.clientY);
  });
  addEventListener('keydown', (e) => {
    if (e.key === '?') setPicking(!picking);
    else if (e.key === 'Escape' && picking) cancel();
  });

  // Keep the view in the URL, written at most twice a second and only when it has changed.
  let written = '';
  let wait = 0;
  stage.onFrame((dt) => {
    if ((wait -= dt) > 0) return;
    wait = 0.5;
    const hash = `#view=${viewNow().join(',')}`;
    if (hash === written) return;
    written = hash;
    history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  });
  addEventListener('hashchange', () => restoreView(stage));

  render();
  return {
    /** True while the next click reports a defect, so labs can skip their own click handling. */
    get picking() {
      return picking;
    },
  };
}
