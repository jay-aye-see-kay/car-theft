// Interprets a tile's cached raw data into the semantic model the labs load.
//   node tools/bake.ts [tile-id]      (run tools/fetch.ts first)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pointInRing } from '../src/geo/poly.ts';
import { interpretAreas, interpretBuildings, interpretPaths, type Measured } from '../src/interpret/features.ts';
import { parseOsm } from '../src/interpret/osm.ts';
import { interpretRoads } from '../src/interpret/roads.ts';
import type { Pt, TileModel } from '../src/model/types.ts';
import { findTile } from './tiles.ts';

const HEIGHT_CELL = 2;
const NODATA = -9999;

const t = findTile(process.argv[2]);
const dir = `.cache/${t.id}`;
const readF32 = async (name: string) => {
  const buf = await readFile(`${dir}/${name}.f32`);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};
const [dem, dsm] = [await readF32('dem'), await readF32('dsm')];
const W = t.sizeX + 1;
const H = t.sizeY + 1;
if (dem.length !== W * H) throw new Error('Cached rasters do not match the tile size; re-run tools/fetch.ts');

// Raster row 0 is the north edge; local y runs north from the tile centre.
// (Pixel centres sit half a metre off the grid lines. That is well inside the map data's own error.)
const px = (x: number, y: number): number => {
  const c = Math.min(W - 1, Math.max(0, Math.round(x + t.sizeX / 2)));
  const r = Math.min(H - 1, Math.max(0, Math.round(t.sizeY / 2 - y)));
  return r * W + c;
};

/** Building height: LiDAR's first-return surface minus bare earth, over the footprint. */
function measure(ring: Pt[]): Measured {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const above: number[] = [];
  const ground: number[] = [];
  for (let y = Math.ceil(y0); y <= y1; y++) {
    for (let x = Math.ceil(x0); x <= x1; x++) {
      if (!pointInRing(x, y, ring)) continue;
      const i = px(x, y);
      if (dem[i] === NODATA || dsm[i] === NODATA) continue;
      ground.push(dem[i]);
      above.push(dsm[i] - dem[i]);
    }
  }
  if (ground.length < 4) return { ground: Math.max(0, dem[px((x0 + x1) / 2, (y0 + y1) / 2)]) };
  above.sort((a, b) => a - b);
  ground.sort((a, b) => a - b);
  // The 80th percentile is the main roof: above podiums and setbacks, below masts and plant rooms.
  return { h: above[Math.floor(above.length * 0.8)], ground: ground[Math.floor(ground.length / 2)] };
}

const osm = parseOsm(JSON.parse(await readFile(`${dir}/osm.json`, 'utf8')), t.e, t.n);
const bounds = { x0: -t.sizeX / 2, y0: -t.sizeY / 2, x1: t.sizeX / 2, y1: t.sizeY / 2 };

const roads = interpretRoads(osm, bounds, { clusterDist: 20 });
const buildings = interpretBuildings(osm, bounds, measure);
const paths = interpretPaths(osm, bounds);

// Heightmap: bare earth at 2 m, sample (0,0) at the south-west corner.
const cols = t.sizeX / HEIGHT_CELL + 1;
const rows = t.sizeY / HEIGHT_CELL + 1;
let min = Infinity;
for (const v of dem) if (v !== NODATA && v < min) min = v;
min = Math.floor(min) - 1;
const scale = 0.01;
const heights = new Uint16Array(cols * rows);
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const v = dem[(H - 1 - r * HEIGHT_CELL) * W + c * HEIGHT_CELL];
    heights[r * cols + c] = Math.round(((v === NODATA ? 0 : v) - min) / scale);
  }
}

const model: TileModel = {
  id: t.id,
  title: t.title,
  origin: { e: t.e, n: t.n },
  size: { x: t.sizeX, y: t.sizeY },
  height: { cols, rows, cell: HEIGHT_CELL, min, scale },
  roads: roads.roads,
  junctions: roads.junctions,
  buildings: buildings.buildings,
  areas: interpretAreas(osm, bounds),
  paths: paths.paths,
  report: { ...roads.report, ...buildings.report, ...paths.report },
};

const outDir = `public/tiles/${t.id}`;
await mkdir(outDir, { recursive: true });
const json = JSON.stringify(model);
await writeFile(`${outDir}/model.json`, json);
await writeFile(`${outDir}/height.bin`, new Uint8Array(heights.buffer));
console.log(`${outDir}: model.json ${(json.length / 1e6).toFixed(2)} MB, height.bin ${(heights.byteLength / 1e6).toFixed(2)} MB`);
console.table(model.report);
