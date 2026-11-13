// Footpaths as one surface rather than a strip per road.
//
// Every road with a footpath, and every junction corner where one carries round, offers a strip of
// paving. Wherever any carriageway or junction lies, the paving is cut away. What is left is laid as
// one surface: a kerb wherever it meets a road, a bank wherever it meets the ground. However the
// strips overlapped, nothing is paved twice, no footpath crosses a road, and the gap between two
// close carriageways becomes one median.
import { Region, type Shape, type XY } from '../geo/clip.ts';
import { pointInRing } from '../geo/poly.ts';
import type { Pt } from '../model/types.ts';
import type { JunctionShape, P3 } from './junctions.ts';
import { type Station, carriageway, offset, stations } from './stations.ts';
import type { RoadParams, Track } from './tracks.ts';

/** What the edge of the paving meets: a road, the ground, or the next cell's paving. */
export type Edge = 'kerb' | 'bank' | 'seam';

/** A boundary ring at road-surface height. `edge[k]` is what the edge from point k to k+1 meets. */
export interface PaveRing {
  pts: P3[];
  edge: Edge[];
}

export interface PavePiece {
  outer: PaveRing;
  holes: PaveRing[];
}

export interface Pavement {
  /** Raised footpath and medians. */
  paved: PavePiece[];
  /** Slivers too thin to stand as kerbed paving, sealed flush with the road instead. */
  sealed: PavePiece[];
  /** Height of the road surface nearest a point, which the paving sits a kerb above. */
  surfaceAt(x: number, y: number): number;
}

/** Paving narrower than twice this is laid flush. */
const FLUSH = 0.45;
/** Longest boundary edge, so the paving follows the road's profile down a hill. */
const MAX_EDGE = 2;
/** Segments of track per piece of roadway. */
const CHUNK = 8;
/** How far a footpath runs on past the end of a road that carries straight on into another. */
const SEAM_RUN = 4;
/** The pavement is solved in squares this size, each looking this far beyond its edges. */
/** Bare ground between two carriageways narrower than twice this is paved as a median. */
const GAP = 3;
/** ...unless one carriageway is this much higher than the other, where the ground between is a bank. */
const GAP_STEP = 1.5;
const CELL = 100;
const MARGIN = 12;

/** Points with heights, for finding the road surface near any point. */
class HeightCloud {
  private cells = new Map<number, P3[]>();
  private static readonly CELL = 4;

  add(p: P3): void {
    const k = this.key(Math.floor(p.x / HeightCloud.CELL), Math.floor(p.y / HeightCloud.CELL));
    let list = this.cells.get(k);
    if (!list) this.cells.set(k, (list = []));
    list.push(p);
  }

  private key(cx: number, cy: number): number {
    return cx * 65536 + cy;
  }

  /** Inverse-distance mean of the nearest few points. */
  at(x: number, y: number): number {
    const cx = Math.floor(x / HeightCloud.CELL);
    const cy = Math.floor(y / HeightCloud.CELL);
    const near: [number, number][] = [];
    for (let r = 1; r <= 6 && near.length < 4; r++) {
      near.length = 0;
      for (let i = -r; i <= r; i++)
        for (let j = -r; j <= r; j++)
          for (const q of this.cells.get(this.key(cx + i, cy + j)) ?? []) near.push([(q.x - x) ** 2 + (q.y - y) ** 2, q.h]);
    }
    if (!near.length) return 0;
    near.sort((a, b) => a[0] - b[0]);
    let sum = 0;
    let weight = 0;
    for (const [d2, h] of near.slice(0, 4)) {
      const w = 1 / (d2 + 0.05);
      sum += h * w;
      weight += w;
    }
    return sum / weight;
  }
}

/** Rings indexed by area, for asking whether a point is on any of them. */
class RingIndex {
  private cells = new Map<number, Pt[][]>();
  private static readonly CELL = 8;

  add(ring: XY[]): void {
    const pts: Pt[] = ring.map((q) => [q.x, q.y]);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of pts) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    const C = RingIndex.CELL;
    for (let cx = Math.floor(x0 / C); cx <= Math.floor(x1 / C); cx++)
      for (let cy = Math.floor(y0 / C); cy <= Math.floor(y1 / C); cy++) {
        const k = cx * 65536 + cy;
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(pts);
      }
  }

  covers(x: number, y: number): boolean {
    const C = RingIndex.CELL;
    return (this.cells.get(Math.floor(x / C) * 65536 + Math.floor(y / C)) ?? []).some((r) => pointInRing(x, y, r));
  }
}

/** Splits `0..n-1` into runs where `keep` holds, none longer than `max`. */
function runs(n: number, keep: (i: number) => boolean, max: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (!keep(i)) continue;
    let j = i;
    while (j + 1 < n && keep(j + 1) && j + 1 - i < max) j++;
    out.push([i, j]);
    i = j;
  }
  return out;
}

/** The ring between two lines, the first walked forwards and the second back. */
const band = (a: XY[], b: XY[]): XY[] => [...a, ...b.slice().reverse()];

export function buildPavement(tracks: Iterable<Track>, junctions: JunctionShape[], p: RoadParams): Pavement {
  const road: XY[][] = [];
  /** Which of `road` are junctions, the only roadway an island is cut from. */
  const isJunction: boolean[] = [];
  const walk: XY[][] = [];
  const islands: XY[][] = [];
  const heights = new HeightCloud();

  for (const t of tracks) {
    const sts = stations(t);
    if (sts.length < 2) continue;
    const half = sts.map((st) => carriageway(t, st));
    // Only the stretches on the ground: a deck carries its own footpath.
    const ground = (i: number): boolean => sts[i].level === 0 && sts[i + 1].level === 0;
    sts.forEach((st, i) => {
      if (st.level !== 0) return;
      for (const l of [-half[i], 0, half[i]]) heights.add(offset(st, l));
    });
    for (const [a, b] of runs(sts.length - 1, ground, CHUNK)) {
      const at = sts.slice(a, b + 2);
      const hw = half.slice(a, b + 2);
      road.push(band(at.map((st, i) => offset(st, hw[i])), at.map((st, i) => offset(st, -hw[i]))));
    }
    if (!t.road.footpath) continue;
    for (const side of [1, -1]) {
      const path = sts.map((st) => Math.min(p.footpathWidth, st.room[side > 0 ? 0 : 1]));
      for (const [a, b] of runs(sts.length - 1, (i) => ground(i) && Math.max(path[i], path[i + 1]) > 0.05, CHUNK)) {
        const at = sts.slice(a, b + 2);
        // From just inside the kerb, so the cut along the road's edge is clean.
        const inner = at.map((st, i) => offset(st, side * (half[a + i] - 0.05)));
        const outer = at.map((st, i) => offset(st, side * (half[a + i] + path[a + i])));
        // Where the road carries straight on into another, the footpath runs on past the end, so the two
        // overlap round the outside of any bend between them. The roadway takes back whatever lands on it.
        const on = (st: Station, l: number, e: number): P3 => ({ x: st.x + st.nx * l + st.ny * e, y: st.y + st.ny * l - st.nx * e, h: st.h });
        if (a === 0 && t.thruA && path[0] > 0.05) {
          inner.unshift(on(sts[0], side * (half[0] - 0.05), -SEAM_RUN));
          outer.unshift(on(sts[0], side * (half[0] + path[0]), -SEAM_RUN));
        }
        const last = sts.length - 1;
        if (b + 1 === last && t.thruB && path[last] > 0.05) {
          inner.push(on(sts[last], side * (half[last] - 0.05), SEAM_RUN));
          outer.push(on(sts[last], side * (half[last] + path[last]), SEAM_RUN));
        }
        walk.push(band(inner, outer));
      }
    }
  }

  for (const j of junctions) {
    // A junction wholly on a structure is clear of the ground; one partly on the ground is roadway there.
    if (j.deck && j.fillets.every((f) => f.deck)) continue;
    for (const piece of j.pieces) {
      road.push(piece.outer);
      isJunction[road.length - 1] = true;
      for (const q of piece.outer) heights.add(q);
    }
    // Islands are paved, and roadway around them is not laid over them.
    islands.push(...j.islands);
    walk.push(...j.islands);
    for (const f of j.fillets) {
      if (!f.footpath || f.deck || f.pts.length < 2) continue;
      // Outward is to the right when walking the kerb anticlockwise around the junction.
      const far = f.pts.map((pt, i) => {
        const a = f.pts[Math.max(0, i - 1)];
        const c = f.pts[Math.min(f.pts.length - 1, i + 1)];
        const d = Math.hypot(c.x - a.x, c.y - a.y) || 1;
        return { x: pt.x + ((c.y - a.y) / d) * p.footpathWidth, y: pt.y - ((c.x - a.x) / d) * p.footpathWidth };
      });
      const inner = f.pts.map((pt, i) => {
        const o = far[i];
        const d = Math.hypot(o.x - pt.x, o.y - pt.y) || 1;
        return { x: pt.x - ((o.x - pt.x) / d) * 0.05, y: pt.y - ((o.y - pt.y) / d) * 0.05 };
      });
      walk.push(band(inner, far));
    }
  }

  // Pieces at a time, so no boolean has more than a few hundred rings to sort: each cell is solved
  // with a margin around it and kept only within its own square, and every cell gets the same answer
  // in the overlap.
  const box = (r: XY[]): [number, number, number, number] => {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const q of r) [x0, y0, x1, y1] = [Math.min(x0, q.x), Math.min(y0, q.y), Math.max(x1, q.x), Math.max(y1, q.y)];
    return [x0, y0, x1, y1];
  };
  const roadBoxes = road.map(box);
  const walkBoxes = walk.map(box);
  const islandBoxes = islands.map(box);
  const cells = new Set<number>();
  for (const [x0, y0, x1, y1] of [...walkBoxes, ...roadBoxes])
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) cells.add(cx * 65536 + cy);

  const edges = new RingIndex();
  for (const r of road) edges.add(r);
  const pavedShapes: { s: Shape; cell: [number, number, number, number] }[] = [];
  const sealedShapes: { s: Shape; cell: [number, number, number, number] }[] = [];
  for (const key of cells) {
    const cx = Math.round(key / 65536);
    const cy = key - cx * 65536;
    const cell: [number, number, number, number] = [cx * CELL, cy * CELL, (cx + 1) * CELL, (cy + 1) * CELL];
    const [x0, y0, x1, y1] = [cell[0] - MARGIN, cell[1] - MARGIN, cell[2] + MARGIN, cell[3] + MARGIN];
    const hits = (b: [number, number, number, number]) => b[0] <= x1 && b[2] >= x0 && b[1] <= y1 && b[3] >= y0;
    const walkHere = walk.filter((_, i) => hits(walkBoxes[i]));
    const kept = Region.of(islands.filter((_, i) => hits(islandBoxes[i])));
    const roadway = Region.of(road.filter((_, i) => !isJunction[i] && hits(roadBoxes[i]))).union(
      Region.of(road.filter((_, i) => isJunction[i] && hits(roadBoxes[i])))
        .union()
        .minus(kept),
    );
    if (roadway.empty) continue;
    // Narrow strips of ground shut in between carriageways, where the two sides are near enough level.
    const level = (sh: Shape): boolean => {
      let [n, steep] = [0, 0];
      sh.outer.forEach((a, i) => {
        const b = sh.outer[(i + 1) % sh.outer.length];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        if (d < 0.5) return;
        // The filled side is on the left of each edge: look across the strip from here.
        const [nx, ny] = [-(b.y - a.y) / d, (b.x - a.x) / d];
        const [mx, my] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
        n += d;
        if (Math.abs(heights.at(mx - nx * 0.5, my - ny * 0.5) - heights.at(mx + nx * 2 * GAP, my + ny * 2 * GAP)) > GAP_STEP) steep += d;
      });
      return steep < n * 0.25;
    };
    const medians = roadway.close(GAP).minus(roadway).open(0.6).shapes(4).filter(level);
    const raw = Region.of([...walkHere, ...medians.flatMap((sh) => [sh.outer])])
      .union()
      .minus(roadway);
    const paved = raw.open(FLUSH);
    const square = Region.of([
      [
        { x: cell[0], y: cell[1] },
        { x: cell[2], y: cell[1] },
        { x: cell[2], y: cell[3] },
        { x: cell[0], y: cell[3] },
      ],
    ]);
    for (const s of paved.within(square).shapes(0.05)) pavedShapes.push({ s, cell });
    for (const s of raw.minus(paved).within(square).shapes(0.05)) sealedShapes.push({ s, cell });
  }
  for (const { s } of sealedShapes) edges.add(s.outer);

  const surfaceAt = (x: number, y: number): number => heights.at(x, y);
  const lay = ({ s, cell }: { s: Shape; cell: [number, number, number, number] }, kerbed: boolean): PavePiece => {
    // An edge along the cell's own border is where it meets its neighbour, and nothing is built there.
    const onBorder = (a: XY, b: XY): boolean =>
      [0, 2].some((k) => Math.abs(a.x - cell[k]) < 0.002 && Math.abs(b.x - cell[k]) < 0.002) || [1, 3].some((k) => Math.abs(a.y - cell[k]) < 0.002 && Math.abs(b.y - cell[k]) < 0.002);
    const ring = (pts: XY[]): PaveRing => {
      const dense: XY[] = [];
      pts.forEach((a, i) => {
        const b = pts[(i + 1) % pts.length];
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / MAX_EDGE));
        for (let k = 0; k < n; k++) dense.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
      });
      const edge = dense.map((a, i): Edge => {
        const b = dense[(i + 1) % dense.length];
        if (onBorder(a, b)) return 'seam';
        if (!kerbed) return 'bank';
        const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        // The filled side is on the left, so a step to the right is off the paving.
        const [mx, my] = [(a.x + b.x) / 2 + ((b.y - a.y) / d) * 0.3, (a.y + b.y) / 2 - ((b.x - a.x) / d) * 0.3];
        return edges.covers(mx, my) ? 'kerb' : 'bank';
      });
      return { pts: dense.map((q) => ({ x: q.x, y: q.y, h: surfaceAt(q.x, q.y) })), edge };
    };
    return { outer: ring(s.outer), holes: s.holes.map(ring) };
  };

  return {
    paved: pavedShapes.map((s) => lay(s, true)),
    sealed: sealedShapes.map((s) => lay(s, false)),
    surfaceAt,
  };
}
