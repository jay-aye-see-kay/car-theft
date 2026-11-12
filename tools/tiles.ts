import { toNztm } from '../src/geo/nztm.ts';

export interface TileSpec {
  id: string;
  title: string;
  /** NZTM centre, snapped to whole metres. */
  e: number;
  n: number;
  sizeX: number;
  sizeY: number;
  /** LINZ 1 m elevation rasters covering the tile (public bucket, CC BY 4.0). A tile may span several sheets. */
  dem: string[];
  dsm: string[];
}

const LINZ = 'https://nz-elevation.s3.ap-southeast-2.amazonaws.com';

function tile(
  id: string,
  title: string,
  lat: number,
  lon: number,
  sizeX: number,
  sizeY: number,
  survey: string,
  sheets: string[],
): TileSpec {
  const [e, n] = toNztm(lat, lon);
  return {
    id,
    title,
    e: Math.round(e / 2) * 2,
    n: Math.round(n / 2) * 2,
    sizeX,
    sizeY,
    dem: sheets.map((s) => `${LINZ}/${survey}/dem_1m/2193/${s}.tiff`),
    dsm: sheets.map((s) => `${LINZ}/${survey}/dsm_1m/2193/${s}.tiff`),
  };
}

export const TILES: TileSpec[] = [
  // Albert Park, the university, Symonds Street Cemetery, Grafton Gully motorway, upper Queen Street.
  tile('central', 'Central: Albert Park to Grafton', -36.854, 174.769, 1800, 2200, 'auckland/auckland-part-1_2024', ['BA32_10000_0401']),
  // Piha beach and Lion Rock, the village, Glen Esk valley and the Kitekite Falls track. Four sheets meet here.
  tile('piha', 'West coast: Piha to Kitekite Falls', -36.9505, 174.4795, 3000, 1800, 'auckland/auckland-part-1_2024', [
    'BB30_10000_0105',
    'BA31_10000_0501',
    'BA30_10000_0505',
    'BB31_10000_0101',
  ]),
];

export function findTile(id: string | undefined): TileSpec {
  const t = TILES.find((x) => x.id === (id ?? TILES[0].id));
  if (!t) throw new Error(`Unknown tile "${id}". Known: ${TILES.map((x) => x.id).join(', ')}`);
  return t;
}
