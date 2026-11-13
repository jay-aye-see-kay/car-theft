// The semantic model: what the real data *means*, with no geometry decisions in it.
// Generators read only this. Coordinates are metres from the tile centre, x east, y north.

export type Pt = [number, number];

export type RoadClass = 'motorway' | 'ramp' | 'arterial' | 'collector' | 'street' | 'lane';

/** A stretch of road with constant attributes. A road is a run of these end to end. */
export interface RoadSection {
  /** Distance along the road where this section starts and ends, in metres. */
  s0: number;
  s1: number;
  cls: RoadClass;
  /** Lanes travelling in the direction the road's points run, and against it. */
  lanesF: number;
  lanesB: number;
  /** 0 on the ground, above 0 on a bridge, below 0 in a tunnel. */
  level: number;
  name?: string;
}

/** A road runs between two junctions (or dead ends) and never passes through one. */
export interface Road {
  id: string;
  a: string;
  b: string;
  pts: Pt[];
  sections: RoadSection[];
  footpath: boolean;
  /**
   * Where the road is carried on a structure and its surface could be measured: [distance along,
   * height] pairs, a few metres apart. It can reach past the sections with a level above 0, because
   * a structure is often longer than the span the map calls a bridge. Runs are separated by a gap in
   * distance of more than 10 m.
   */
  deck?: [number, number][];
}

export interface Junction {
  id: string;
  x: number;
  y: number;
  /** Roads meeting here, and which end of each ('a' is the start of its points). */
  arms: { road: string; end: 'a' | 'b' }[];
  /**
   * Short stretches of road that lay wholly inside the intersection when its nodes were merged.
   * They are no longer roads, but they say where the intersection's surface is.
   */
  links?: { pts: Pt[]; cls: RoadClass; lanes: number }[];
}

export interface Building {
  id: string;
  ring: Pt[];
  /** Height above ground in metres, measured from LiDAR where possible. */
  h: number;
  hSource: 'lidar' | 'tag' | 'levels' | 'default';
  ground: number;
  kind: string;
  name?: string;
  /**
   * Set when this is an open-sided cover (a canopy, shelter or screen) rather than a walled building:
   * 'ground' if it stands on the ground, 'deck' if it stands on a bridge, where `h` and `ground`
   * were measured to the land far below and mean nothing.
   */
  cover?: 'ground' | 'deck';
}

export interface Area {
  id: string;
  kind: 'park' | 'cemetery' | 'campus' | 'water' | 'wood' | 'pitch' | 'parking' | 'plaza' | 'beach' | 'rock';
  ring: Pt[];
  name?: string;
}

export interface Path {
  id: string;
  kind: 'foot' | 'steps' | 'cycle';
  pts: Pt[];
  level: number;
}

/** A named spot: a waterfall, a summit. */
export interface Landmark {
  id: string;
  kind: 'waterfall' | 'peak';
  x: number;
  y: number;
  name?: string;
}

/** A watercourse, as a centreline. */
export interface Stream {
  id: string;
  kind: 'river' | 'stream' | 'drain';
  pts: Pt[];
  name?: string;
}

/**
 * A planning zone: what the council says the land is for (Auckland Unitary Plan base zones).
 * It describes intent and density, not what is built there today.
 */
export interface Zone {
  id: string;
  /** The plan's own zone name, e.g. "Business - City Centre Zone". */
  zone: string;
  ring: Pt[];
}

export interface HeightInfo {
  cols: number;
  rows: number;
  /** Metres between samples. Sample (0,0) is the south-west corner. */
  cell: number;
  /** Stored as uint16: metres = min + value * scale. */
  min: number;
  scale: number;
}

export interface TileModel {
  id: string;
  title: string;
  /** NZTM easting and northing of the tile centre. */
  origin: { e: number; n: number };
  size: { x: number; y: number };
  /**
   * The part of the tile this model covers, if less than all of it: a crop keeps the tile's origin and
   * coordinates, and only the features that reach into these bounds. See `cropModel`.
   */
  bounds?: { x0: number; y0: number; x1: number; y1: number };
  height: HeightInfo;
  roads: Road[];
  junctions: Junction[];
  buildings: Building[];
  areas: Area[];
  paths: Path[];
  /** Missing from tiles baked before zoning and streams were added. */
  streams?: Stream[];
  landmarks?: Landmark[];
  zones?: Zone[];
  /** True where the tile reaches the sea: ground below 0 m is under water. */
  sea?: boolean;
  /** Notes from the interpreter about what it changed or could not resolve. */
  report: Record<string, number>;
}
