// Debug pictures for each v2 stage: an RGB canvas over a window of the local
// frame, hillshaded heights, lines drawn on top, written as PNG with no
// dependency. They go to .cache/citygen2/<area>/debug/ to look at between runs.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import type { Local } from '../citygen/project.ts';

export type View = { x0: number; z0: number; mpp: number; w: number; h: number };

/** A view of local rect [x0, x1] x [z0, z1] at mpp metres per pixel. */
export const view = (x0: number, z0: number, x1: number, z1: number, mpp: number): View =>
  ({ x0, z0, mpp, w: Math.round((x1 - x0) / mpp), h: Math.round((z1 - z0) / mpp) });

export type Rgb = [number, number, number];

export class Canvas {
  readonly v: View;
  readonly px: Uint8Array;
  constructor(v: View) {
    this.v = v;
    this.px = new Uint8Array(v.w * v.h * 3);
  }

  /** Fills every pixel from a function of its centre in local metres. */
  fill(f: (x: number, z: number) => Rgb) {
    const { x0, z0, mpp, w, h } = this.v;
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const [R, G, B] = f(x0 + (c + 0.5) * mpp, z0 + (r + 0.5) * mpp);
      const i = (r * w + c) * 3;
      this.px[i] = R; this.px[i + 1] = G; this.px[i + 2] = B;
    }
  }

  /** Blends a colour into the pixel containing a point. */
  dot(x: number, z: number, col: Rgb, a = 1) {
    const c = Math.floor((x - this.v.x0) / this.v.mpp), r = Math.floor((z - this.v.z0) / this.v.mpp);
    if (c < 0 || r < 0 || c >= this.v.w || r >= this.v.h) return;
    const i = (r * this.v.w + c) * 3;
    for (let k = 0; k < 3; k++) this.px[i + k] = Math.round(this.px[i + k] * (1 - a) + col[k] * a);
  }

  /** A polyline, `width` metres wide (at least a pixel). */
  line(pts: Local[], col: Rgb, width = 0, a = 1) {
    const half = Math.max(width / 2, this.v.mpp / 2);
    const step = this.v.mpp / 2;
    for (let k = 0; k + 1 < pts.length; k++) {
      const p = pts[k], q = pts[k + 1];
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      const nx = -(q.z - p.z) / (len || 1), nz = (q.x - p.x) / (len || 1);
      for (let s = 0; s <= len; s += step) for (let o = -half; o <= half; o += step) {
        const t = s / (len || 1);
        this.dot(p.x + (q.x - p.x) * t + nx * o, p.z + (q.z - p.z) * t + nz * o, col, a);
      }
    }
  }

  save(path: string) {
    writeFileSync(path, encodeRgbPng(this.v.w, this.v.h, this.px));
  }
}

/** Light from the north-west, as on paper maps; z is south, so north-west is (-x, -z). */
export function hillshade(height: (x: number, z: number) => number, x: number, z: number, d: number, exaggerate = 2): number {
  const dx = (height(x + d, z) - height(x - d, z)) / (2 * d) * exaggerate;
  const dz = (height(x, z + d) - height(x, z - d)) / (2 * d) * exaggerate;
  // Normal (-dx, 1, -dz), light towards (-1, 1, -1)/sqrt3.
  const shade = (dx + 1 + dz) / Math.sqrt(3) / Math.hypot(dx, 1, dz);
  return Number.isFinite(shade) ? Math.max(0, Math.min(1, shade)) : 0;
}

/** Height tint: sea blue below 0, then green to brown to pale with height. */
export function hypsometric(y: number): Rgb {
  if (!Number.isFinite(y)) return [255, 0, 255];
  if (y < 0) return [70, 110, 160];
  const stops: [number, Rgb][] = [[0, [150, 180, 120]], [30, [190, 190, 130]], [80, [180, 150, 110]], [200, [230, 225, 215]]];
  for (let k = 1; k < stops.length; k++) {
    if (y <= stops[k][0]) {
      const [h0, c0] = stops[k - 1], [h1, c1] = stops[k];
      const t = (y - h0) / (h1 - h0);
      return [0, 1, 2].map((i) => c0[i] + (c1[i] - c0[i]) * t) as Rgb;
    }
  }
  return stops[stops.length - 1][1];
}

export const shaded = (c: Rgb, s: number): Rgb => c.map((v) => Math.round(v * (0.35 + 0.75 * s))) .map((v) => Math.min(255, v)) as Rgb;

function encodeRgbPng(w: number, h: number, px: Uint8Array): Uint8Array {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const v of b) c = table[(c ^ v) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array(h * (w * 3 + 1));
  for (let r = 0; r < h; r++) raw.set(px.subarray(r * w * 3, (r + 1) * w * 3), r * (w * 3 + 1) + 1);
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
