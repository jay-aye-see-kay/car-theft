// Downloads the raw source data for a tile into .cache/<tile>/ (not committed).
//   node tools/fetch.ts [tile-id] [osm|zoning|lidar …]
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
    `node[waterway=waterfall];node[natural=peak];` +
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

const NODATA = -9999;

/** Reads the tile's window of 1 m rasters as float32, row 0 at the north edge. Several sheets are mosaicked. */
async function fetchRaster(urls: string[], t: TileSpec): Promise<Float32Array> {
  const W = t.sizeX + 1;
  const H = t.sizeY + 1;
  const out = new Float32Array(W * H).fill(NODATA);
  // The tile's corner in NZTM: west edge and north edge.
  const [west, north] = [t.e - t.sizeX / 2, t.n + t.sizeY / 2];
  for (const url of urls) {
    const img = await (await fromUrl(url)).getImage();
    const [ox, oy] = img.getOrigin();
    const [rx, ry] = img.getResolution();
    if (rx !== 1 || ry !== -1) throw new Error(`Expected a 1 m north-up raster, got ${rx} x ${ry}`);
    const noData = img.getGDALNoData();
    // The part of the tile this sheet covers, in sheet pixels.
    const x0 = Math.max(0, west - ox);
    const y0 = Math.max(0, oy - north);
    const x1 = Math.min(img.getWidth(), west - ox + W);
    const y1 = Math.min(img.getHeight(), oy - north + H);
    if (x1 <= x0 || y1 <= y0) {
      console.log(`  ${url.split('/').pop()} does not overlap the tile`);
      continue;
    }
    const [band] = await img.readRasters({ window: [x0, y0, x1, y1] });
    const src = band as ArrayLike<number>;
    const w = x1 - x0;
    let filled = 0;
    for (let r = 0; r < y1 - y0; r++) {
      for (let c = 0; c < w; c++) {
        const v = src[r * w + c];
        if (v === noData || !(v > -1000)) continue;
        out[(y0 + r - (oy - north)) * W + (x0 + c - (west - ox))] = v;
        filled++;
      }
    }
    console.log(`  ${url.split('/').pop()}: ${filled.toLocaleString()} samples`);
  }
  return out;
}

const ZONING = 'https://services1.arcgis.com/n4yPwebTjJCmXB6W/arcgis/rest/services/Unitary_Plan_Base_Zone/FeatureServer/0';

/** Auckland Unitary Plan base zones over the tile, as GeoJSON in NZTM, with the zone code names. */
async function fetchZoning(t: TileSpec): Promise<string> {
  const meta = await (await fetch(`${ZONING}?f=json`)).json();
  const names: Record<string, string> = {};
  for (const f of meta.fields) {
    if (f.name === 'ZONE') for (const c of f.domain.codedValues) names[c.code] = c.name;
  }
  const env = [t.e - t.sizeX / 2 - OSM_MARGIN, t.n - t.sizeY / 2 - OSM_MARGIN, t.e + t.sizeX / 2 + OSM_MARGIN, t.n + t.sizeY / 2 + OSM_MARGIN].join(',');
  const features: unknown[] = [];
  for (let offset = 0; ; offset += 1000) {
    const q = new URLSearchParams({
      where: '1=1',
      geometry: env,
      geometryType: 'esriGeometryEnvelope',
      inSR: '2193',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'OBJECTID,ZONE,NAME',
      returnGeometry: 'true',
      outSR: '2193',
      resultOffset: String(offset),
      resultRecordCount: '1000',
      f: 'geojson',
    });
    const page = await (await fetch(`${ZONING}/query?${q}`)).json();
    features.push(...page.features);
    if (!page.features.length || !(page.exceededTransferLimit || page.properties?.exceededTransferLimit)) break;
  }
  return JSON.stringify({ names, features });
}

const t = findTile(process.argv[2]);
// Optionally only some sources: node tools/fetch.ts central zoning
const only = new Set(process.argv.slice(3));
const want = (part: string) => !only.size || only.has(part);
const dir = `.cache/${t.id}`;
await mkdir(dir, { recursive: true });

if (want('osm')) {
  console.log(`OpenStreetMap…`);
  await writeFile(`${dir}/osm.json`, await fetchOsm(t));
}
if (want('zoning')) {
  console.log(`Auckland Unitary Plan zoning…`);
  await writeFile(`${dir}/zoning.json`, await fetchZoning(t));
}
for (const kind of ['dem', 'dsm'] as const) {
  if (!want('lidar')) break;
  console.log(`LINZ ${kind.toUpperCase()}…`);
  const data = await fetchRaster(t[kind], t);
  await writeFile(`${dir}/${kind}.f32`, new Uint8Array(data.buffer));
}
console.log(`Saved to ${dir}`);
