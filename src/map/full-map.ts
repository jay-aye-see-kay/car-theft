import type { Blip, Chart, ChartView } from './chart.ts';
import type { Navigator } from './navigator.ts';
import { BLIP } from './style.ts';

// The full-screen map (tap the minimap, or M or Tab): north up, drag to pan,
// pinch or scroll to zoom. Tap the map to put a waypoint there (and the
// route to it on both maps), tap a mission to head for it, tap the waypoint
// again or Clear to drop it. The game pauses while it's open.

/** Taps move less than this, px. */
const TAP_SLOP = 10;
/** A tap this close to a blip picks it, px. */
const PICK = 26;
/** Zoom limits, px per metre. */
const MAX_SCALE = 4;

export interface MapScene {
  /** Where you are and which way you face (bearing). */
  you: { x: number; z: number; facing: number };
  route: readonly { x: number; z: number }[] | null;
  /** Everything but you and the waypoint. */
  blips: readonly Blip[];
}

export class FullMap {
  open = false;
  /** Off until the game has started (Tab does nothing on the title screen). */
  enabled = false;
  onToggle: ((open: boolean) => void) | null = null;
  private readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly clear: HTMLButtonElement;
  private readonly chart: Chart;
  private readonly nav: Navigator;
  private readonly scene: () => MapScene;
  private view: ChartView = { x: 0, z: 0, turn: 0, scale: 0.5, w: 1, h: 1 };
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private gesture: { moved: number; start: number; pinch: number; scale: number } | null = null;
  private dirty = false;

  constructor(hud: HTMLElement, chart: Chart, nav: Navigator, scene: () => MapScene) {
    this.chart = chart;
    this.nav = nav;
    this.scene = scene;
    this.el = document.createElement('div');
    this.el.id = 'map-full';
    this.el.className = 'hidden';
    this.canvas = document.createElement('canvas');
    this.el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    const bar = document.createElement('div');
    bar.className = 'map-bar';
    const button = (text: string, label: string, act: () => void) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        act();
      });
      bar.appendChild(b);
      return b;
    };
    button('−', 'Zoom out', () => this.zoom(1 / 1.6));
    button('+', 'Zoom in', () => this.zoom(1.6));
    button('◎', 'Back to you', () => this.centre());
    this.clear = button('Clear waypoint', 'Clear waypoint', () => {
      this.nav.waypoint = null;
      this.redraw();
    });
    button('✕', 'Close map', () => this.toggle(false));
    this.clear.className = 'map-clear';
    this.el.appendChild(bar);

    const legend = document.createElement('div');
    legend.className = 'map-legend';
    const coarse = matchMedia('(pointer: coarse)').matches;
    legend.innerHTML =
      `<span style="--c:${BLIP.player}">You</span><span style="--c:${BLIP.mission}">Mission</span>` +
      `<span style="--c:${BLIP.goal}">Goal</span><span style="--c:${BLIP.waypoint}">Waypoint</span>` +
      `<em>${coarse ? 'Tap' : 'Click'} to set a waypoint</em>`;
    this.el.appendChild(legend);
    hud.appendChild(this.el);

    this.canvas.addEventListener('pointerdown', (e) => this.down(e));
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    this.canvas.addEventListener('pointerup', (e) => this.up(e));
    this.canvas.addEventListener('pointercancel', (e) => {
      this.pointers.delete(e.pointerId);
      this.gesture = null;
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      this.zoom(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if ((e.code === 'Tab' || e.code === 'KeyM') && this.enabled && !e.repeat) {
        e.preventDefault();
        this.toggle();
      } else if (e.code === 'Escape' && this.open) this.toggle(false);
    });
    addEventListener('resize', () => this.open && this.redraw());
  }

  toggle(open = !this.open): void {
    if (open === this.open || (open && !this.enabled)) return;
    this.open = open;
    this.el.classList.toggle('hidden', !open);
    this.pointers.clear();
    this.gesture = null;
    if (open) {
      this.view.scale = 0;
      this.centre();
    }
    this.onToggle?.(open);
  }

  /** Back on you, at a zoom that shows the streets round about (or the whole map on a big screen). */
  private centre(): void {
    const { you } = this.scene();
    this.view.x = you.x;
    this.view.z = you.z;
    if (!this.view.scale) this.view.scale = Math.min(this.size().w, this.size().h) / 900;
    this.redraw();
  }

  /** A world point on the map, as the canvas sees it (for tests). */
  screenOf(x: number, z: number): { x: number; y: number } {
    const p = this.chart.project(this.view, x, z);
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }

  private size() {
    return { w: this.canvas.clientWidth || innerWidth, h: this.canvas.clientHeight || innerHeight };
  }

  private zoom(k: number, px?: number, py?: number): void {
    const { w, h } = this.size();
    const b = this.chart.bounds;
    // Out no further than the whole map fits.
    const min = Math.min(w / (b.maxX - b.minX), h / (b.maxZ - b.minZ)) * 0.9;
    const scale = Math.max(min, Math.min(MAX_SCALE, this.view.scale * k));
    // Keep the point under the cursor (or the middle) where it is.
    const at = this.chart.unproject({ ...this.view, w, h }, px ?? w / 2, py ?? h / 2);
    this.view.scale = scale;
    const after = this.chart.unproject({ ...this.view, w, h }, px ?? w / 2, py ?? h / 2);
    this.view.x += at.x - after.x;
    this.view.z += at.z - after.z;
    this.redraw();
  }

  private down(e: PointerEvent): void {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...this.pointers.values()];
    this.gesture = {
      moved: this.pointers.size > 1 ? Infinity : 0,
      start: performance.now(),
      pinch: pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0,
      scale: this.view.scale,
    };
  }

  private move(e: PointerEvent): void {
    const last = this.pointers.get(e.pointerId);
    if (!last || !this.gesture) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size > 1) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.gesture.pinch > 0) {
        const r = this.canvas.getBoundingClientRect();
        this.zoom((this.gesture.scale * d) / this.gesture.pinch / this.view.scale, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      }
      return;
    }
    this.gesture.moved += Math.hypot(dx, dy);
    this.view.x -= dx / this.view.scale;
    this.view.z -= dy / this.view.scale;
    this.redraw();
  }

  private up(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (this.pointers.size) {
      // A finger still down after a pinch: it's no tap.
      if (g) g.moved = Infinity;
      return;
    }
    this.gesture = null;
    if (!g || g.moved > TAP_SLOP) return;
    const r = this.canvas.getBoundingClientRect();
    this.tap(e.clientX - r.left, e.clientY - r.top);
  }

  /** Tap on the map: the waypoint off, a mission's start as the waypoint, or a new waypoint here. */
  tap(px: number, py: number): void {
    const v = { ...this.view, ...this.size() };
    const near = (x: number, z: number) => {
      const p = this.chart.project(v, x, z);
      return Math.hypot(p.x - px, p.y - py) < PICK;
    };
    const wp = this.nav.waypoint;
    if (wp && near(wp.x, wp.z)) this.nav.waypoint = null;
    else {
      const blip = this.scene().blips.find((b) => (b.kind === 'mission' || b.kind === 'goal') && near(b.x, b.z));
      if (blip) this.nav.waypoint = { x: blip.x, z: blip.z };
      else {
        const at = this.chart.unproject(v, px, py);
        this.nav.setWaypoint(at.x, at.z);
      }
    }
    this.redraw();
  }

  /** Redrawn on the next animation frame (the game loop is paused while the map is open). */
  redraw(): void {
    if (this.dirty) return;
    this.dirty = true;
    requestAnimationFrame(() => {
      this.dirty = false;
      if (this.open) this.draw();
    });
  }

  private draw(): void {
    const { w, h } = this.size();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const scene = this.scene();
    const wp = this.nav.waypoint;
    const blips: Blip[] = [...scene.blips];
    if (wp) blips.push({ kind: 'waypoint', x: wp.x, z: wp.z, label: 'Waypoint' });
    blips.push({ kind: 'player', x: scene.you.x, z: scene.you.z, facing: scene.you.facing });
    this.view.w = w;
    this.view.h = h;
    this.chart.draw(ctx, this.view, scene.route, blips);
    this.clear.classList.toggle('hidden', !wp);
  }
}
