// Polygon booleans and offsets in metres, on top of Clipper's integer geometry.
import * as ns from 'clipper-lib';

type Lib = typeof ns;
// The package is CommonJS: a bundler hands over its exports, Node a default holding them.
const C: Lib = (ns as unknown as { default?: Lib }).default ?? ns;

/** Clipper works in integers: millimetres here. */
const SCALE = 1000;

export interface XY {
  x: number;
  y: number;
}

/** A polygon with holes. The outer ring runs anticlockwise and holes clockwise: the filled side is always on the left. */
export interface Shape {
  outer: XY[];
  holes: XY[][];
}

type Path = ns.Path;

function toPath(ring: XY[]): Path {
  const path = ring.map((q) => ({ X: Math.round(q.x * SCALE), Y: Math.round(q.y * SCALE) }));
  // Every input ring counts the same way, so overlapping pieces add up instead of cancelling.
  if (C.Clipper.Area(path) < 0) path.reverse();
  return path;
}

const fromPath = (path: Path): XY[] => path.map((q) => ({ x: q.X / SCALE, y: q.Y / SCALE }));

/** A set of rings in Clipper's form: anything covered by at least one of them. */
export class Region {
  readonly paths: Path[];

  constructor(paths: Path[]) {
    this.paths = paths;
  }

  static of(rings: XY[][]): Region {
    return new Region(rings.filter((r) => r.length >= 3).map(toPath));
  }

  private static run(type: ns.ClipType, a: Path[], b: Path[]): Region {
    const c = new C.Clipper();
    c.AddPaths(a, C.PolyType.ptSubject, true);
    c.AddPaths(b, C.PolyType.ptClip, true);
    const out: Path[] = [];
    c.Execute(type, out, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
    return new Region(out);
  }

  union(other?: Region): Region {
    return Region.run(C.ClipType.ctUnion, this.paths, other?.paths ?? []);
  }

  minus(other: Region): Region {
    return Region.run(C.ClipType.ctDifference, this.paths, other.paths);
  }

  within(other: Region): Region {
    return Region.run(C.ClipType.ctIntersection, this.paths, other.paths);
  }

  /** Grown then shrunk back: every gap narrower than twice `d` is filled, and inside corners take that radius. */
  close(d: number): Region {
    return this.offset(d).offset(-d);
  }

  /** True if the point is covered. */
  contains(x: number, y: number): boolean {
    const pt = { X: Math.round(x * SCALE), Y: Math.round(y * SCALE) };
    let winding = 0;
    for (const path of this.paths) if (C.Clipper.PointInPolygon(pt, path) !== 0) winding += C.Clipper.Area(path) > 0 ? 1 : -1;
    return winding !== 0;
  }

  get empty(): boolean {
    return this.paths.length === 0;
  }

  /** Grown (or shrunk, for a negative distance) by `d` metres, with rounded or mitred corners. */
  offset(d: number, round = true): Region {
    const o = new C.ClipperOffset(2.5, 0.05 * SCALE);
    o.AddPaths(this.paths, round ? C.JoinType.jtRound : C.JoinType.jtMiter, C.EndType.etClosedPolygon);
    const out: Path[] = [];
    o.Execute(out, d * SCALE);
    return new Region(out);
  }

  /** Shrunk then grown back: everything narrower than twice `d` is gone. Corners stay sharp unless `round`. */
  open(d: number, round = false): Region {
    return this.offset(-d, round).offset(d, round);
  }

  /** As polygons with holes, dropping any piece smaller than `minArea` square metres. */
  shapes(minArea = 0): Shape[] {
    const c = new C.Clipper();
    c.AddPaths(this.paths, C.PolyType.ptSubject, true);
    const tree = new C.PolyTree();
    c.Execute(C.ClipType.ctUnion, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
    const min = minArea * SCALE * SCALE;
    return C.JS.PolyTreeToExPolygons(tree)
      .filter((e) => Math.abs(C.Clipper.Area(e.outer)) >= min)
      .map((e) => ({ outer: fromPath(e.outer), holes: e.holes.filter((h) => Math.abs(C.Clipper.Area(h)) >= min / 4).map(fromPath) }));
  }
}
