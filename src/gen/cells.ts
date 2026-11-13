// Cells: the unit of local generation. The world is cut into 200 m squares on the NZTM grid, so the
// cuts fall in the same places in every tile. Generation has two stages:
//
//   tile stage   needs the whole network or a wide area: graded terrain, road heights and junctions,
//                stamps, the profile map, distance to the coast. In the game this is baked offline.
//   cell stage   scatter and street furniture. A cell's output depends only on the tile stage's results
//                and on the model's features within MARGIN of the cell, never on what other cells did,
//                which order things were generated in, or how the tile was cut.
//
// So a cell can be generated alone, on demand, and comes out the same every time. `checkCells` tests it.
import type { Bounds } from '../geo/raster.ts';
import type { Pt, TileModel } from '../model/types.ts';

/** Cell size in metres. */
export const CELL = 200;

/**
 * How far past its edges a cell's inputs reach: the widest local rule reads distance to a stream 70 m out,
 * and relief compares the ground with the 60 m around it. Anything wider (distance to the coast) is a
 * tile-stage field.
 */
export const MARGIN = 100;

export interface Cell extends Bounds {
  /** NZTM cell indices, e.g. "8652_29547": the same cell in any tile. */
  key: string;
  ce: number;
  cn: number;
}

export function boundsOf(model: TileModel): Bounds {
  return model.bounds ?? { x0: -model.size.x / 2, y0: -model.size.y / 2, x1: model.size.x / 2, y1: model.size.y / 2 };
}

/** The cells a model covers, clipped to its bounds. */
export function cellsOf(model: TileModel): Cell[] {
  const b = boundsOf(model);
  const { e, n } = model.origin;
  const out: Cell[] = [];
  for (let cn = Math.floor((b.y0 + n) / CELL); cn * CELL - n < b.y1; cn++) {
    for (let ce = Math.floor((b.x0 + e) / CELL); ce * CELL - e < b.x1; ce++) {
      const [x0, y0] = [ce * CELL - e, cn * CELL - n];
      out.push({ key: `${ce}_${cn}`, ce, cn, x0: Math.max(b.x0, x0), y0: Math.max(b.y0, y0), x1: Math.min(b.x1, x0 + CELL), y1: Math.min(b.y1, y0 + CELL) });
    }
  }
  return out;
}

export const grow = (b: Bounds, d: number): Bounds => ({ x0: b.x0 - d, y0: b.y0 - d, x1: b.x1 + d, y1: b.y1 + d });

export const inBounds = (b: Bounds, x: number, y: number): boolean => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1;

const boxes = new WeakMap<Pt[], Bounds>();
/** The bounding box of a ring or line, cached. */
export function boxOf(pts: Pt[]): Bounds {
  let b = boxes.get(pts);
  if (!b) {
    b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const [x, y] of pts) [b.x0, b.y0, b.x1, b.y1] = [Math.min(b.x0, x), Math.min(b.y0, y), Math.max(b.x1, x), Math.max(b.y1, y)];
    boxes.set(pts, b);
  }
  return b;
}

export const overlaps = (a: Bounds, b: Bounds): boolean => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

/** The model as if only `b` (within the tile) had been fetched: every feature that reaches into it, whole, and nothing else. */
export function cropModel(model: TileModel, want: Bounds): TileModel {
  const t = boundsOf(model);
  const b = { x0: Math.max(t.x0, want.x0), y0: Math.max(t.y0, want.y0), x1: Math.min(t.x1, want.x1), y1: Math.min(t.y1, want.y1) };
  const keep = <T>(list: T[] | undefined, pts: (t: T) => Pt[]) => list?.filter((t) => overlaps(boxOf(pts(t)), b));
  return {
    ...model,
    bounds: b,
    roads: keep(model.roads, (r) => r.pts)!,
    buildings: keep(model.buildings, (x) => x.ring)!,
    areas: keep(model.areas, (a) => a.ring)!,
    paths: keep(model.paths, (p) => p.pts)!,
    streams: keep(model.streams, (s) => s.pts),
    zones: keep(model.zones, (z) => z.ring),
  };
}
