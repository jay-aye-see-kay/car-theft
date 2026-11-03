// Everything the world generator is built from, frozen at a date (#46).
//
// A snapshot is a folder of files that never changes once made: the
// generator reads only from it, so a rebuild gives the same city whatever
// happens upstream. Locally it lives in .snapshot/<id>/; the same layout is
// mirrored to R2 at SNAPSHOT_BASE/<id>/. Its manifest (path, size, sha256,
// source, licence) is committed beside this file as <id>.json, which is what
// pins the generator to it. A newer snapshot is a new id, never an edit.
//
// 2026-11-03 is the 10 x 10 km subset (#58) picked while on slow internet:
// the six LINZ 2024 LiDAR tiles under V2_AREA, BBBike's Auckland OSM extract,
// and v1's inputs. The whole region (all 281 tiles, Geofabrik NZ) comes in a
// later snapshot on a fast connection (see #46).

// TODO(#46): not yet in R2 (made on a slow connection). On good internet run
// `npm run snapshot -- upload`; until then the files exist only on the laptop
// that made them, and cloud sessions can't build v2.
export const SNAPSHOT_ID = '2026-11-03';

/** Public read-only mirror (R2 bucket SNAPSHOT_BUCKET on a custom domain). */
export const SNAPSHOT_BASE = 'https://data.cartheft.net';
export const SNAPSHOT_BUCKET = 'cartheft-data';

export type Source = {
  /** Path inside the snapshot, also its key under <bucket>/<id>/. */
  path: string;
  /** Where it was fetched from (empty for files made locally, e.g. the v1 cache tarball). */
  url: string;
  licence: string;
  note?: string;
};

const OSM = 'ODbL 1.0: © OpenStreetMap contributors';
const LINZ = 'CC BY 4.0: contains data sourced from the LINZ Data Service';

const LINZ_S3 = 'https://nz-elevation.s3.ap-southeast-2.amazonaws.com/auckland/auckland-part-1_2024';
/** 1:10k sheets (4.8 x 7.2 km) under the 10 x 10 km area, all in Auckland Part 1 (2024). */
const LINZ_TILES = ['BA31_10000_0405', 'BA31_10000_0505', 'BA32_10000_0401', 'BA32_10000_0402', 'BA32_10000_0501', 'BA32_10000_0502'];

function linz(): Source[] {
  const out: Source[] = [];
  for (const layer of ['dem_1m', 'dsm_1m']) {
    const dir = `auckland-part-1_2024/${layer}/2193`;
    out.push({ path: `linz/${dir}/collection.json`, url: `${LINZ_S3}/${layer}/2193/collection.json`, licence: LINZ });
    for (const t of LINZ_TILES) {
      // Kept byte for byte: LERC-compressed float32 COGs are already the smallest lossless form (#46).
      out.push({ path: `linz/${dir}/${t}.tiff`, url: `${LINZ_S3}/${layer}/2193/${t}.tiff`, licence: LINZ });
      out.push({ path: `linz/${dir}/${t}.json`, url: `${LINZ_S3}/${layer}/2193/${t}.json`, licence: LINZ });
    }
  }
  return out;
}

export const SOURCES: Source[] = [
  {
    path: 'osm/bbbike-auckland-2026-10-31.osm.pbf',
    url: 'https://download.bbbike.org/osm/bbbike/Auckland/Auckland.osm.pbf',
    licence: OSM,
    note: "BBBike's Auckland extract (urban area), dated by its Last-Modified",
  },
  ...linz(),
  {
    path: 'v1/citygen-cache-v1.tar.zst',
    url: '',
    licence: `${OSM}; ${LINZ}`,
    note: "v1 citygen's .cache/citygen (OSM API tiles, DEM/DSM windows for the CBD), so v1 can still be rebuilt: tar -xf with --zstd at the repo root",
  },
  {
    path: 'v1/wikidata-cbd.json',
    url: 'https://query.wikidata.org/sparql',
    licence: 'CC0: Wikidata',
    note: 'tools/citygen/data/wikidata-cbd.json as of this snapshot',
  },
];
