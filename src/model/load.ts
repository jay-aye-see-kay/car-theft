import type { TileModel } from './types.ts';

/** Bare-earth heights on a regular grid, sample (0,0) at the tile's south-west corner. */
export class Heightfield {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly x0: number;
  readonly y0: number;
  readonly data: Float32Array;

  constructor(cols: number, rows: number, cell: number, x0: number, y0: number, data: Float32Array) {
    this.cols = cols;
    this.rows = rows;
    this.cell = cell;
    this.x0 = x0;
    this.y0 = y0;
    this.data = data;
  }

  clone(): Heightfield {
    return new Heightfield(this.cols, this.rows, this.cell, this.x0, this.y0, this.data.slice());
  }

  /** Bilinear height at a point in tile coordinates, clamped at the edges. */
  at(x: number, y: number): number {
    const fx = Math.min(this.cols - 1.001, Math.max(0, (x - this.x0) / this.cell));
    const fy = Math.min(this.rows - 1.001, Math.max(0, (y - this.y0) / this.cell));
    const c = Math.floor(fx);
    const r = Math.floor(fy);
    const u = fx - c;
    const v = fy - r;
    const i = r * this.cols + c;
    const d = this.data;
    return (d[i] * (1 - u) + d[i + 1] * u) * (1 - v) + (d[i + this.cols] * (1 - u) + d[i + this.cols + 1] * u) * v;
  }
}

export interface LoadedTile {
  model: TileModel;
  ground: Heightfield;
}

/** `root` is the path from the current page to the site root; lab pages live two folders down. */
export async function loadTile(id: string, root = '../../'): Promise<LoadedTile> {
  const base = `${root}tiles/${id}/`;
  const [model, raw] = await Promise.all([
    fetch(base + 'model.json').then((r) => r.json() as Promise<TileModel>),
    fetch(base + 'height.bin').then((r) => r.arrayBuffer()),
  ]);
  const h = model.height;
  const u16 = new Uint16Array(raw);
  const data = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) data[i] = h.min + u16[i] * h.scale;
  return { model, ground: new Heightfield(h.cols, h.rows, h.cell, -model.size.x / 2, -model.size.y / 2, data) };
}
