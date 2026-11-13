// The whole road pipeline in order: tracks, what kind of place each junction is, heights, junction
// shapes, how much room each road has beside it, and the footpaths.
import type { Heightfield } from '../model/load.ts';
import type { TileModel } from '../model/types.ts';
import { type JunctionShape, solveJunctions } from './junctions.ts';
import { type Pavement, buildPavement } from './pavement.ts';
import { measureSides } from './roadIndex.ts';
import { alignSeams, planJunctions } from './seams.ts';
import { type RoadParams, type Track, buildTrack, solveElevations } from './tracks.ts';

export interface Network {
  tracks: Map<string, Track>;
  junctions: JunctionShape[];
  pavement: Pavement;
}

export function buildNetwork(model: TileModel, ground: Heightfield, p: RoadParams): Network {
  const tracks = new Map(model.roads.map((r) => [r.id, buildTrack(r, p)]));
  const plans = planJunctions(model, tracks);
  alignSeams([...plans.values()], p);
  solveElevations(model, tracks, ground, p);
  measureSides(tracks.values(), p);
  const junctions = solveJunctions(plans, p);
  const pavement = buildPavement(tracks.values(), junctions, p);
  return { tracks, junctions, pavement };
}
