// The area v2 builds (#58). The first is a 10 x 10 km square picked to fit
// the 2026-11-03 snapshot (#46): Herne Bay to Ōrākei, Northcote Point (the
// Harbour Bridge) to One Tree Hill. Bigger areas wait for the whole-region
// snapshot.
import type { BBox } from '../citygen/project.ts';

export type Area = {
  id: string;
  /** What's built, [minLon, minLat, maxLon, maxLat]. */
  bbox: BBox;
  /** OSM is read this far past bbox (degrees), so roads and outlines crossing the edge are whole. */
  osmPad: number;
};

export const AUCKLAND_10K: Area = {
  id: 'auckland-10k',
  bbox: [174.72, -36.91, 174.83, -36.82],
  osmPad: 0.003,
};
