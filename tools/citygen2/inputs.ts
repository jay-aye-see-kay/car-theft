// Everything v2 reads, from the frozen snapshot only (#46): OSM clipped to
// the area, and the LiDAR DEM/DSM tiles stitched into one 1 m raster each.
// Decoding is slow (pbf ~7 s, LERC tiles ~10 s), so the results are cached in
// .cache/citygen2/<area>/ keyed by the snapshot id; delete it to redo them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { fileURLToPath } from 'node:url';
import { fromFile } from 'geotiff';
import type { OsmData } from '../citygen/osm.ts';
import { bboxToNztmExtent } from '../citygen/project.ts';
import { loadRaster, saveRaster, type Raster, type RasterKind } from '../citygen/raster.ts';
import { loadManifest, snapshotFile } from '../snapshot/files.ts';
import { SNAPSHOT_ID } from '../snapshot/sources.ts';
import type { Area } from './area.ts';
import { readPbf } from './pbf.ts';

export const CACHE2 = fileURLToPath(new URL('../../.cache/citygen2/', import.meta.url));

export type Inputs = { area: Area; osm: OsmData; dem: Raster; dsm: Raster };

/** Rasters reach this far past the area, so stages can sample (and blur) across its edge. */
const RASTER_PAD = 100;
const OSM_PBF = 'osm/bbbike-auckland-2026-10-31.osm.pbf';

export const areaCache = (area: Area) => join(CACHE2, `${area.id}@${SNAPSHOT_ID}`);

async function loadOsm(area: Area, dir: string): Promise<OsmData> {
  const file = join(dir, 'osm.v8');
  if (existsSync(file)) return deserialize(readFileSync(file)) as OsmData;
  const [w, s, e, n] = area.bbox, p = area.osmPad;
  const t = Date.now();
  const { osm, stats } = readPbf(await snapshotFile(OSM_PBF), [w - p, s - p, e + p, n + p]);
  console.log(`  OSM: ${stats.ways} ways, ${stats.relations} relations, ${stats.nodes} nodes (of ${stats.nodesInFile} in the extract), ${((Date.now() - t) / 1000).toFixed(1)} s`);
  writeFileSync(file, serialize(osm));
  return osm;
}

/** Stitches every snapshot tile of a layer that overlaps the area into one raster (NaN where none). */
async function loadLayer(kind: RasterKind, area: Area, dir: string): Promise<Raster> {
  const path = join(dir, kind);
  if (existsSync(`${path}.f32`)) return loadRaster(path);
  const ext = bboxToNztmExtent(area.bbox, RASTER_PAD);
  const res = 1;
  const west = Math.floor(ext.minE), north = Math.ceil(ext.maxN);
  const width = Math.ceil(ext.maxE) - west, height = north - Math.floor(ext.minN);
  const data = new Float32Array(width * height).fill(NaN);
  const tiles = Object.keys(loadManifest().files).filter((p) => p.includes(`/${kind}_1m/`) && p.endsWith('.tiff'));
  const t = Date.now();
  for (const p of tiles) {
    const image = await (await fromFile(await snapshotFile(p))).getImage(0);
    const [oe, on] = image.getOrigin();
    // Window of this tile inside the area, in tile pixels (tiles are on whole metres, as is the area grid).
    const x0 = Math.max(0, west - oe), x1 = Math.min(image.getWidth(), west + width - oe);
    const y0 = Math.max(0, on - north), y1 = Math.min(image.getHeight(), on - (north - height));
    if (x1 <= x0 || y1 <= y0) continue;
    const r = (await image.readRasters({ window: [x0, y0, x1, y1], samples: [0], interleave: true })) as unknown as Float32Array;
    const nodata = image.getGDALNoData();
    const w = x1 - x0;
    for (let y = y0; y < y1; y++) {
      const row = north - (on - y); // the area row with the same northing as tile row y
      for (let x = x0; x < x1; x++) {
        const v = r[(y - y0) * w + (x - x0)];
        if (v !== nodata) data[row * width + (oe + x - west)] = v;
      }
    }
  }
  console.log(`  ${kind.toUpperCase()}: ${width} x ${height} m from ${tiles.length} tiles, ${((Date.now() - t) / 1000).toFixed(1)} s`);
  const raster: Raster = { kind, west, north, res, width, height, data, source: `snapshot ${SNAPSHOT_ID}: ${tiles.length} LINZ 2024 tiles` };
  saveRaster(path, raster);
  return raster;
}

export async function loadInputs(area: Area): Promise<Inputs> {
  const dir = areaCache(area);
  mkdirSync(dir, { recursive: true });
  const osm = await loadOsm(area, dir);
  const dem = await loadLayer('dem', area, dir);
  const dsm = await loadLayer('dsm', area, dir);
  return { area, osm, dem, dsm };
}
