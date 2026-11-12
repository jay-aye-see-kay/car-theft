// Downloads the raw source data for a tile into .cache/<tile>/ (not committed).
//   node tools/fetch.ts [tile-id]
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { fromUrl } from 'geotiff';
import { fromNztm } from '../src/geo/nztm.ts';
import { findTile, type TileSpec } from './tiles.ts';

// Node gives each address 250 ms to connect by default, which Overpass (in Germany) misses from NZ.
net.setDefaultAutoSelectFamilyAttemptTimeout(5000);

const OSM_MARGIN = 150;

async function fetchOsm(t: TileSpec): Promise<string> {
  const [s, w] = fromNztm(t.e - t.sizeX / 2 - OSM_MARGIN, t.n - t.sizeY / 2 - OSM_MARGIN);
  const [n, e] = fromNztm(t.e + t.sizeX / 2 + OSM_MARGIN, t.n + t.sizeY / 2 + OSM_MARGIN);
  const bbox = [s, w, n, e].map((v) => v.toFixed(6)).join(',');
  const kinds = ['highway', 'building', 'leisure', 'landuse', 'natural', 'amenity', 'waterway', 'railway'];
  const q =
    `[out:json][timeout:120][bbox:${bbox}];(` +
    kinds.map((k) => `way[${k}];`).join('') +
    ['building', 'leisure', 'landuse', 'natural', 'amenity'].map((k) => `relation[${k}][type=multipolygon];`).join('') +
    `);out body;>;out skel qt;`;
  // Overpass is a shared free service and often answers 429 or 504 when busy.
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'User-Agent': 'procgen-labs/0.1', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q),
    });
    if (res.ok) return res.text();
    if (attempt === 4) throw new Error(`Overpass returned ${res.status}`);
    console.log(`  Overpass returned ${res.status}, retrying…`);
    await new Promise((r) => setTimeout(r, 15000 * attempt));
  }
}

/** Reads the tile's window of a 1 m raster as float32, row 0 at the north edge. */
async function fetchRaster(url: string, t: TileSpec): Promise<Float32Array> {
  const img = await (await fromUrl(url)).getImage();
  const [ox, oy] = img.getOrigin();
  const [rx, ry] = img.getResolution();
  if (rx !== 1 || ry !== -1) throw new Error(`Expected a 1 m north-up raster, got ${rx} x ${ry}`);
  const x0 = t.e - t.sizeX / 2 - ox;
  const y0 = oy - (t.n + t.sizeY / 2);
  const window = [x0, y0, x0 + t.sizeX + 1, y0 + t.sizeY + 1];
  if (x0 < 0 || y0 < 0 || window[2] > img.getWidth() || window[3] > img.getHeight()) {
    throw new Error(`Tile ${t.id} is not fully inside ${url}`);
  }
  const [band] = await img.readRasters({ window });
  return Float32Array.from(band as ArrayLike<number>);
}

const t = findTile(process.argv[2]);
const dir = `.cache/${t.id}`;
await mkdir(dir, { recursive: true });

console.log(`OpenStreetMap…`);
await writeFile(`${dir}/osm.json`, await fetchOsm(t));
for (const kind of ['dem', 'dsm'] as const) {
  console.log(`LINZ ${kind.toUpperCase()}…`);
  const data = await fetchRaster(t[kind], t);
  await writeFile(`${dir}/${kind}.f32`, new Uint8Array(data.buffer));
}
console.log(`Saved to ${dir}`);
