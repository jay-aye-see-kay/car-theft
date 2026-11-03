// v1's generator on v2's ground (#58): the stage before v2 has buildings of
// its own. tools/citygen/build.ts asks for this with CITYGEN_GROUND=v2 and
// gets the same CityData it would fetch, except that the OSM comes from the
// snapshot and the DEM is v2's ground (shaped to the roads, carved to OSM's
// coastline). Everything v1 builds on top (roads, buildings, sea walls,
// parking, the map) then sits on it, so it can be driven and compared.
import type { CityData } from '../citygen/fetch.ts';
import { bboxToNztmExtent, type BBox } from '../citygen/project.ts';
import type { Raster } from '../citygen/raster.ts';
import { collectRoads } from '../citygen/roads.ts';
import { AUCKLAND_10K } from './area.ts';
import { areaCache, loadInputs, loadOsm } from './inputs.ts';
import { carveCoast, coastLines, fieldFromRaster, roadProfiles, shapeToRoads } from './terrain.ts';

export async function v2CityData(bbox: BBox): Promise<CityData> {
  const inputs = await loadInputs(AUCKLAND_10K);
  // Ground is shaped over the whole snapshot area, so roads leaving the box agree with it at the edge.
  const roads = collectRoads(inputs.osm);
  const field = fieldFromRaster(inputs.dem);
  const shaped = shapeToRoads(field, roads, roadProfiles(roads, field));
  carveCoast(shaped.field, coastLines(inputs.osm));
  // v1 expects the OSM API's view of its own box (ways touching it, multipolygons as far as they reach), not the whole area.
  const osm = await loadOsm(bbox, areaCache(AUCKLAND_10K), `osm-api-${bbox.join('_')}`, false);
  const dem = crop({ ...inputs.dem, data: shaped.field.h, source: 'citygen2 ground' }, bbox);
  return { bbox, osm, dem, dsm: crop(inputs.dsm, bbox) };
}

/** v1 walks its whole raster in places (sea walls trace every coastline in it), so it gets the window it used to fetch: the box plus 80 m. */
function crop(r: Raster, bbox: BBox, pad = 80): Raster {
  const ext = bboxToNztmExtent(bbox, pad);
  const c0 = Math.max(0, Math.floor((ext.minE - r.west) / r.res)), c1 = Math.min(r.width, Math.ceil((ext.maxE - r.west) / r.res));
  const r0 = Math.max(0, Math.floor((r.north - ext.maxN) / r.res)), r1 = Math.min(r.height, Math.ceil((r.north - ext.minN) / r.res));
  const width = c1 - c0, height = r1 - r0, data = new Float32Array(width * height);
  for (let row = 0; row < height; row++) data.set(r.data.subarray((r0 + row) * r.width + c0, (r0 + row) * r.width + c1), row * width);
  return { ...r, west: r.west + c0 * r.res, north: r.north - r0 * r.res, width, height, data };
}
