import type { RoadGraph } from '../city/road-graph.ts';
import { BLIP, MAP_COLOURS, MAP_PX, ROAD_EDGE, ROAD_FILL, ROUTE } from './style.ts';

// The map both the minimap and the full-screen map draw: map.png (ground,
// parks, water, buildings: tools/citygen/map.ts) with the road graph stroked
// over it once at load, into one canvas at MAP_PX metres per pixel. Each view
// then draws a window of it with a transform, the route as a line, and the
// blips on top in screen space so they stay upright and the same size.

export interface Bounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** Where a view looks: centre (m), turn (rad, the bearing that's up), zoom (px per m), size (px). */
export interface ChartView {
  x: number;
  z: number;
  turn: number;
  scale: number;
  w: number;
  h: number;
}

export type BlipKind = keyof typeof BLIP;

export interface Blip {
  kind: BlipKind;
  x: number;
  z: number;
  /** Player arrows: the bearing they face (rad clockwise from north). */
  facing?: number;
  /** Full map only: a name beside it. */
  label?: string;
  /** Pinned to the edge when outside the view (the minimap). */
  edge?: boolean;
  /** Instead of the kind's colour. */
  colour?: string;
}

/** The bearing of a direction in the ground plane: 0 north (-z), π/2 east (+x). */
export const bearing = (dx: number, dz: number) => Math.atan2(dx, -dz);

export class Chart {
  readonly canvas: HTMLCanvasElement;
  readonly bounds: Bounds;

  private constructor(bounds: Bounds, image: HTMLImageElement, roads: RoadGraph | null) {
    this.bounds = bounds;
    const w = Math.round((bounds.maxX - bounds.minX) / MAP_PX);
    const h = Math.round((bounds.maxZ - bounds.minZ) / MAP_PX);
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    const ctx = this.canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0, w, h);
    if (roads) {
      ctx.setTransform(1 / MAP_PX, 0, 0, 1 / MAP_PX, -bounds.minX / MAP_PX, -bounds.minZ / MAP_PX);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // Kerbs first under every road, then the asphalt, so junctions join up.
      for (const pass of [0, 1]) {
        for (const e of roads.edges) {
          const minor = e.restricted || e.highway === 'service';
          const width = Math.max(e.width, minor ? 3 : 5);
          ctx.strokeStyle = pass ? (minor ? '#8d929a' : ROAD_FILL) : ROAD_EDGE;
          ctx.lineWidth = pass ? width : width + 2.5;
          ctx.beginPath();
          for (let k = 0; k < e.s.length; k++) {
            if (k) ctx.lineTo(e.pts[3 * k], e.pts[3 * k + 1]);
            else ctx.moveTo(e.pts[0], e.pts[1]);
          }
          ctx.stroke();
        }
      }
    }
  }

  static async load(url: URL, bounds: Bounds, roads: RoadGraph | null): Promise<Chart> {
    const image = new Image();
    image.src = url.href;
    await image.decode();
    return new Chart(bounds, image, roads);
  }

  /** A world point in view space (px from the view's top left). */
  project(v: ChartView, x: number, z: number): { x: number; y: number } {
    const dx = x - v.x;
    const dz = z - v.z;
    const c = Math.cos(v.turn);
    const s = Math.sin(v.turn);
    return { x: v.w / 2 + (dx * c + dz * s) * v.scale, y: v.h / 2 + (-dx * s + dz * c) * v.scale };
  }

  /** A point in view space back on the ground. */
  unproject(v: ChartView, px: number, py: number): { x: number; z: number } {
    const sx = (px - v.w / 2) / v.scale;
    const sy = (py - v.h / 2) / v.scale;
    const c = Math.cos(v.turn);
    const s = Math.sin(v.turn);
    return { x: v.x + sx * c - sy * s, z: v.z + sx * s + sy * c };
  }

  /** The map, the route and the blips. `ctx` is in CSS px (any devicePixelRatio scale already applied). */
  draw(ctx: CanvasRenderingContext2D, v: ChartView, route: readonly { x: number; z: number }[] | null, blips: readonly Blip[], clip?: { r: number }): void {
    ctx.fillStyle = MAP_COLOURS[0];
    ctx.fillRect(0, 0, v.w, v.h);
    ctx.save();
    ctx.translate(v.w / 2, v.h / 2);
    ctx.rotate(-v.turn);
    ctx.scale(v.scale, v.scale);
    ctx.translate(-v.x, -v.z);
    const b = this.bounds;
    ctx.imageSmoothingEnabled = v.scale < 1.5 / MAP_PX;
    ctx.drawImage(this.canvas, b.minX, b.minZ, b.maxX - b.minX, b.maxZ - b.minZ);
    if (route && route.length > 1) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(route[0].x, route[0].z);
      for (let k = 1; k < route.length; k++) ctx.lineTo(route[k].x, route[k].z);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.lineWidth = 7 / v.scale;
      ctx.stroke();
      ctx.strokeStyle = ROUTE;
      ctx.lineWidth = 4 / v.scale;
      ctx.stroke();
    }
    ctx.restore();

    for (const blip of blips) {
      let p = this.project(v, blip.x, blip.z);
      let pinned = false;
      if (clip) {
        const dx = p.x - v.w / 2;
        const dy = p.y - v.h / 2;
        const d = Math.hypot(dx, dy);
        const r = clip.r - 7;
        if (d > r) {
          if (!blip.edge) continue;
          p = { x: v.w / 2 + (dx / d) * r, y: v.h / 2 + (dy / d) * r };
          pinned = true;
        }
      }
      this.drawBlip(ctx, blip, p.x, p.y, v.turn, pinned);
    }
  }

  private drawBlip(ctx: CanvasRenderingContext2D, blip: Blip, x: number, y: number, turn: number, pinned: boolean): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#000';
    ctx.fillStyle = blip.colour ?? BLIP[blip.kind];
    if (blip.kind === 'boat') {
      // A little hull, bow the way it's pointing: a boat to borrow.
      ctx.rotate((blip.facing ?? 0) - turn);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.quadraticCurveTo(4, -3, 3.5, 5);
      ctx.lineTo(-3.5, 5);
      ctx.quadraticCurveTo(-4, -3, 0, -7);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (blip.facing !== undefined) {
      // An arrowhead for people: you and the others in the room.
      ctx.rotate(blip.facing - turn);
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(7, 7);
      ctx.lineTo(0, 3);
      ctx.lineTo(-7, 7);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (blip.kind === 'waypoint') {
      // A flag-ish diamond.
      ctx.beginPath();
      ctx.moveTo(0, -8);
      ctx.lineTo(7, 0);
      ctx.lineTo(0, 8);
      ctx.lineTo(-7, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      const r = pinned ? 5 : 7;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (blip.kind === 'mission' && !pinned) {
        ctx.fillStyle = '#000';
        ctx.font = '900 9px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('!', 0, 0.5);
      }
    }
    if (blip.label) {
      ctx.font = '700 12px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.strokeText(blip.label, 11, 0);
      ctx.fillStyle = '#fff';
      ctx.fillText(blip.label, 11, 0);
    }
    ctx.restore();
  }
}
