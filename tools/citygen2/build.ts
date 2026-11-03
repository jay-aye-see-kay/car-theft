// World gen v2 (#58): runs the stages for an area and draws each one.
//
//   npm run citygen2 [-- --only=inputs,terrain]
//
// Pictures go to .cache/citygen2/<area>@<snapshot>/debug/: an overview of
// the whole area and close-ups of the places v1 got wrong.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { collectRoads } from '../citygen/roads.ts';
import { lonLatToLocal, type Local } from '../citygen/project.ts';
import { sampleLocal, type Raster } from '../citygen/raster.ts';
import { AUCKLAND_10K, type Area } from './area.ts';
import { Canvas, hillshade, hypsometric, shaded, view, type Rgb, type View } from './debug.ts';
import { areaCache, loadInputs } from './inputs.ts';
import { carveCoast, fieldFromRaster, roadProfiles, sampleField, shapeToRoads, type Field } from './terrain.ts';

/** Close-ups, 600 m across at 0.5 m per pixel. */
const SPOTS: Record<string, [number, number]> = {
  viaduct: [174.7605, -36.8435],
  'parnell-rise': [174.7775, -36.851],
  'tamaki-drive': [174.806, -36.8505],
  'bridge-north': [174.7445, -36.827],
};

function areaView(area: Area, mpp: number): View {
  const [w, s, e, n] = area.bbox;
  const nw = lonLatToLocal(w, n), se = lonLatToLocal(e, s);
  return view(nw.x, nw.z, se.x, se.z, mpp);
}

function spotView(lonlat: [number, number], size = 600, mpp = 0.5): View {
  const c = lonLatToLocal(lonlat[0], lonlat[1]);
  return view(c.x - size / 2, c.z - size / 2, c.x + size / 2, c.z + size / 2, mpp);
}

const ROAD: Rgb = [40, 40, 45];
const COAST: Rgb = [230, 30, 30];

function drawHeights(cv: Canvas, r: Raster) {
  const h = (x: number, z: number) => sampleLocal(r, x, z);
  const d = Math.max(1, cv.v.mpp);
  cv.fill((x, z) => shaded(hypsometric(h(x, z)), hillshade(h, x, z, d)));
}

function drawField(cv: Canvas, f: Field) {
  const h = (x: number, z: number) => sampleField(f, x, z);
  const d = Math.max(1, cv.v.mpp);
  cv.fill((x, z) => {
    const y = h(x, z);
    // Water drawn at the waterline (0 m) so the shoreline reads; the floor below shows as darker blue.
    const col: Rgb = y < 0 ? [60 + 10 * Math.max(-4, y), 100 + 8 * Math.max(-6, y), 165 + 4 * y] : hypsometric(y);
    return shaded(col, y < 0 ? 0.6 : hillshade(h, x, z, d));
  });
}

async function main() {
  const area = AUCKLAND_10K;
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');
  const run = (stage: string) => !only || only.includes(stage);
  const debug = join(areaCache(area), 'debug');
  mkdirSync(debug, { recursive: true });

  console.log(`v2 ${area.id}`);
  const inputs = await loadInputs(area);
  const roads = collectRoads(inputs.osm);
  const coast: Local[][] = [...inputs.osm.ways.values()]
    .filter((w) => w.tags.natural === 'coastline')
    .map((w) => w.nodes.map((id) => inputs.osm.nodes.get(id)!).filter(Boolean).map((n) => lonLatToLocal(n.lon, n.lat)));

  if (run('inputs')) {
    // Stage 0, the raw inputs together: the DEM, OSM's roads and OSM's coastline, to see where they disagree.
    const draw = (v: View, name: string) => {
      const cv = new Canvas(v);
      drawHeights(cv, inputs.dem);
      for (const r of roads) cv.line(r.pts, ROAD, r.width, 0.8);
      for (const c of coast) cv.line(c, COAST, v.mpp * 2);
      cv.save(join(debug, `0-inputs-${name}.png`));
    };
    draw(areaView(area, 4), 'overview');
    for (const [name, ll] of Object.entries(SPOTS)) draw(spotView(ll), name);
    console.log(`  0-inputs: ${roads.length} roads, ${coast.length} coastline ways`);
  }
  if (run('terrain')) {
    // Stage 1: ground shaped to the roads, then carved to the coastline.
    let t = Date.now();
    const dem = fieldFromRaster(inputs.dem);
    const prof = roadProfiles(roads, dem);
    const lap = (what: string) => { console.log(`  1-terrain: ${what}, ${((Date.now() - t) / 1000).toFixed(1)} s`); t = Date.now(); };
    lap(`${prof.samples} road profile samples`);
    const shaped = shapeToRoads(dem, roads, prof);
    lap('shaped to roads');
    const coastInfo = carveCoast(shaped.field, coast);
    lap(`coast: ${coastInfo.regions} regions, ${((coastInfo.seaCells / dem.h.length) * 100).toFixed(0)}% sea`);
    const f = shaped.field;
    const draw = (v: View, name: string) => {
      const cv = new Canvas(v);
      drawField(cv, f);
      cv.save(join(debug, `1-terrain-${name}.png`));
      // How far the ground moved from the DEM: red raised, blue lowered, full colour at 2 m.
      const diff = new Canvas(v);
      diff.fill((x, z) => {
        const d = sampleField(f, x, z) - sampleField(dem, x, z);
        const a = Math.min(1, Math.abs(d) / 2);
        const g = 235 - a * 200;
        return d > 0 ? [235, g, g] : [g, g, 235];
      });
      for (const c of coast) diff.line(c, [0, 0, 0], v.mpp);
      diff.save(join(debug, `1-moved-${name}.png`));
    };
    draw(areaView(area, 4), 'overview');
    for (const [name, ll] of Object.entries(SPOTS)) draw(spotView(ll), name);
    lap('pictures');
  }
  console.log(`  pictures in ${debug}`);
}

await main();
