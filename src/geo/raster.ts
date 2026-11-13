// Small raster tools over a regular grid in tile coordinates: polygon fill, thick lines,
// distance fields, slope and relief. No canvas, so they run anywhere.
import type { Pt } from '../model/types.ts';

/** A rectangle in tile coordinates: metres from the tile centre, x east, y north. */
export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class Grid {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  /** South-west corner of cell (0,0). */
  readonly x0: number;
  readonly y0: number;

  constructor(x0: number, y0: number, cols: number, rows: number, cell: number) {
    this.cell = cell;
    this.cols = cols;
    this.rows = rows;
    this.x0 = x0;
    this.y0 = y0;
  }

  /**
   * A grid covering `b`, with its cell edges on whole multiples of `cell` in NZTM rather than in tile
   * coordinates. So any two grids of the same cell size, from different tiles or from a crop of one,
   * put their cells in the same places and rasterise the same data to the same values.
   */
  static over(b: Bounds, cell: number, origin: { e: number; n: number }): Grid {
    const x0 = Math.floor((b.x0 + origin.e) / cell) * cell - origin.e;
    const y0 = Math.floor((b.y0 + origin.n) / cell) * cell - origin.n;
    return new Grid(x0, y0, Math.ceil((b.x1 - x0) / cell), Math.ceil((b.y1 - y0) / cell), cell);
  }

  get size(): number {
    return this.cols * this.rows;
  }

  /** The cell a point falls in, or -1 outside the grid. */
  index(x: number, y: number): number {
    const c = Math.floor((x - this.x0) / this.cell);
    const r = Math.floor((y - this.y0) / this.cell);
    return c < 0 || r < 0 || c >= this.cols || r >= this.rows ? -1 : r * this.cols + c;
  }

  centre(i: number): Pt {
    return [this.x0 + ((i % this.cols) + 0.5) * this.cell, this.y0 + (Math.floor(i / this.cols) + 0.5) * this.cell];
  }

  /** Bilinear sample of a field on this grid, sampled at cell centres. */
  sample(field: Float32Array, x: number, y: number): number {
    const fx = Math.min(this.cols - 1.001, Math.max(0, (x - this.x0) / this.cell - 0.5));
    const fy = Math.min(this.rows - 1.001, Math.max(0, (y - this.y0) / this.cell - 0.5));
    const c = Math.floor(fx);
    const r = Math.floor(fy);
    const [u, v] = [fx - c, fy - r];
    const i = r * this.cols + c;
    return (field[i] * (1 - u) + field[i + 1] * u) * (1 - v) + (field[i + this.cols] * (1 - u) + field[i + this.cols + 1] * u) * v;
  }
}

/** Calls back with every cell whose centre is inside the ring (even-odd scanline). */
export function fillRing(g: Grid, ring: Pt[], cb: (i: number) => void): void {
  let [y0, y1] = [Infinity, -Infinity];
  for (const [, y] of ring) [y0, y1] = [Math.min(y0, y), Math.max(y1, y)];
  const r0 = Math.max(0, Math.ceil((y0 - g.y0) / g.cell - 0.5));
  const r1 = Math.min(g.rows - 1, Math.floor((y1 - g.y0) / g.cell - 0.5));
  const xs: number[] = [];
  for (let r = r0; r <= r1; r++) {
    const y = g.y0 + (r + 0.5) * g.cell;
    xs.length = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j];
      const [bx, by] = ring[i];
      if (ay > y !== by > y) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - g.x0) / g.cell - 0.5));
      const c1 = Math.min(g.cols - 1, Math.floor((xs[k + 1] - g.x0) / g.cell - 0.5));
      for (let c = c0; c <= c1; c++) cb(r * g.cols + c);
    }
  }
}

/** Marks every cell within `half` metres of a polyline. */
export function strokeLine(g: Grid, pts: Pt[], half: number, mask: Uint8Array): void {
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - half - g.x0) / g.cell));
    const c1 = Math.min(g.cols - 1, Math.floor((Math.max(ax, bx) + half - g.x0) / g.cell));
    const r0 = Math.max(0, Math.floor((Math.min(ay, by) - half - g.y0) / g.cell));
    const r1 = Math.min(g.rows - 1, Math.floor((Math.max(ay, by) + half - g.y0) / g.cell));
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const px = g.x0 + (c + 0.5) * g.cell;
        const py = g.y0 + (r + 0.5) * g.cell;
        const u = Math.min(1, Math.max(0, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2));
        if (Math.hypot(px - (ax + (bx - ax) * u), py - (ay + (by - ay) * u)) <= half + g.cell * 0.5) mask[r * g.cols + c] = 1;
      }
    }
  }
}

/** Distance standing in for "nothing marked anywhere": finite, so bilinear sampling never makes NaN of it (Infinity × 0). */
export const FAR = 1e9;

/** Metres from each cell to the nearest marked cell (two-pass chamfer). Unmarked grids give FAR. */
export function distanceField(g: Grid, seeds: Uint8Array): Float32Array {
  const { cols, rows, cell } = g;
  const d = new Float32Array(cols * rows);
  for (let i = 0; i < d.length; i++) d[i] = seeds[i] ? 0 : FAR;
  const [a, b] = [cell, cell * Math.SQRT2];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      let v = d[i];
      if (c > 0) v = Math.min(v, d[i - 1] + a);
      if (r > 0) {
        v = Math.min(v, d[i - cols] + a);
        if (c > 0) v = Math.min(v, d[i - cols - 1] + b);
        if (c < cols - 1) v = Math.min(v, d[i - cols + 1] + b);
      }
      d[i] = v;
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      let v = d[i];
      if (c < cols - 1) v = Math.min(v, d[i + 1] + a);
      if (r < rows - 1) {
        v = Math.min(v, d[i + cols] + a);
        if (c < cols - 1) v = Math.min(v, d[i + cols + 1] + b);
        if (c > 0) v = Math.min(v, d[i + cols - 1] + b);
      }
      d[i] = v;
    }
  }
  return d;
}

/** A box blur of radius `r` cells, from a summed-area table. */
export function boxBlur(g: Grid, f: Float32Array, r: number): Float32Array {
  const { cols, rows } = g;
  const sat = new Float64Array((cols + 1) * (rows + 1));
  for (let y = 0; y < rows; y++) {
    let run = 0;
    for (let x = 0; x < cols; x++) {
      run += f[y * cols + x];
      sat[(y + 1) * (cols + 1) + x + 1] = sat[y * (cols + 1) + x + 1] + run;
    }
  }
  const out = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    const [ya, yb] = [Math.max(0, y - r), Math.min(rows, y + r + 1)];
    for (let x = 0; x < cols; x++) {
      const [xa, xb] = [Math.max(0, x - r), Math.min(cols, x + r + 1)];
      const s = sat[yb * (cols + 1) + xb] - sat[ya * (cols + 1) + xb] - sat[yb * (cols + 1) + xa] + sat[ya * (cols + 1) + xa];
      out[y * cols + x] = s / ((yb - ya) * (xb - xa));
    }
  }
  return out;
}
