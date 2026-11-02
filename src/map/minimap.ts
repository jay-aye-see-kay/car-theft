import type { Blip, Chart, ChartView } from './chart.ts';

// The radar in the top-left corner: round, turning with the camera so ahead
// is up, zooming out as you speed up. Mission blips, your goal and your
// waypoint cling to its rim when they're further off. Tap or click it for
// the full-screen map. Drawn on a 2D canvas: one drawImage of the map and a
// few paths a frame, on the CPU side of the browser, no WebGL draw calls.

export class Minimap {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly label: HTMLElement;
  private readonly north: HTMLElement;
  private readonly chart: Chart;
  private labelText = '';
  /** Opens the full map. */
  onOpen: (() => void) | null = null;

  constructor(hud: HTMLElement, chart: Chart) {
    this.chart = chart;
    this.el = document.createElement('div');
    this.el.id = 'minimap';
    this.el.setAttribute('role', 'button');
    this.el.setAttribute('aria-label', 'Map');
    this.canvas = document.createElement('canvas');
    this.el.appendChild(this.canvas);
    this.north = document.createElement('div');
    this.north.className = 'minimap-north';
    this.north.textContent = 'N';
    this.el.appendChild(this.north);
    this.label = document.createElement('div');
    this.label.className = 'minimap-label hidden';
    this.el.appendChild(this.label);
    hud.appendChild(this.el);
    this.ctx = this.canvas.getContext('2d')!;
    this.el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onOpen?.();
    });
  }

  /** Centred on (x, z), with bearing `turn` up, `radius` metres to the rim. */
  draw(x: number, z: number, turn: number, radius: number, route: readonly { x: number; z: number }[] | null, blips: readonly Blip[], label: string): void {
    const size = this.canvas.clientWidth;
    if (!size) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const px = Math.round(size * dpr);
    if (this.canvas.width !== px) {
      this.canvas.width = px;
      this.canvas.height = px;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const view: ChartView = { x, z, turn, scale: size / 2 / radius, w: size, h: size };
    this.chart.draw(ctx, view, route, blips, { r: size / 2 });
    // The N on the rim, turned with the map.
    const r = size / 2 - 1;
    this.north.style.transform = `translate(${(Math.sin(-turn) * r).toFixed(1)}px, ${(-Math.cos(-turn) * r).toFixed(1)}px)`;
    if (label !== this.labelText) {
      this.labelText = label;
      this.label.textContent = label;
      this.label.classList.toggle('hidden', !label);
    }
  }
}
