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
}

export interface Junction {
  id: string;
  x: number;
  y: number;
  /** Roads meeting here, and which end of each ('a' is the start of its points). */
  arms: { road: string; end: 'a' | 'b' }[];
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
}

export interface Area {
  id: string;
  kind: 'park' | 'cemetery' | 'campus' | 'water' | 'wood' | 'pitch' | 'parking' | 'plaza';
  ring: Pt[];
  name?: string;
}

export interface Path {
  id: string;
  kind: 'foot' | 'steps' | 'cycle';
  pts: Pt[];
  level: number;
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
  height: HeightInfo;
  roads: Road[];
  junctions: Junction[];
  buildings: Building[];
  areas: Area[];
  paths: Path[];
  /** Notes from the interpreter about what it changed or could not resolve. */
  report: Record<string, number>;
}
