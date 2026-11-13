// Buildings, land areas and footpaths from OpenStreetMap, for the semantic model.
import { type Rect, centroid, clipRing, inRect, ringArea, simplify, simplifyRing } from '../geo/poly.ts';
import type { Area, Building, Landmark, Path, Pt, Road, Stream, Zone } from '../model/types.ts';
import { type OsmData, type Tags, stitchRings } from './osm.ts';

const round = (v: number): number => Math.round(v * 100) / 100;
const roundRing = (ring: Pt[]): Pt[] => ring.map((p): Pt => [round(p[0]), round(p[1])]);

interface Outline {
  id: string;
  tags: Tags;
  ring: Pt[];
  /** For one ring of a many-part outline: its area as a share of the largest part's. */
  share: number;
}

/** Every closed outline carrying tags: closed ways, plus the outer rings of multipolygons. */
function outlines(data: OsmData): Outline[] {
  const toRing = (ids: number[]): Pt[] => {
    const pts = ids.map((i) => data.nodes.get(i)).filter((p): p is Pt => !!p);
    pts.pop(); // The closing node repeats the first.
    return ringArea(pts) < 0 ? pts.reverse() : pts;
  };
  const found: Outline[] = [];
  for (const w of data.ways.values()) {
    if (w.nodes.length > 3 && w.nodes[0] === w.nodes[w.nodes.length - 1]) found.push({ id: `w${w.id}`, tags: w.tags, ring: toRing(w.nodes), share: 1 });
  }
  for (const r of data.relations) {
    // Tags may sit on the relation or, in older mapping, on its outer way.
    const tags = Object.keys(r.tags).length > 1 ? r.tags : { ...data.ways.get(r.outers[0])?.tags, ...r.tags };
    const rings = stitchRings(r.outers, data).map(toRing);
    const largest = Math.max(1e-6, ...rings.map((ring) => Math.abs(ringArea(ring))));
    rings.forEach((ring, i) => found.push({ id: `rel${r.id}${i ? '.' + i : ''}`, tags, ring, share: Math.abs(ringArea(ring)) / largest }));
  }
  return found;
}

export interface Measured {
  /** Height above ground from LiDAR, or undefined if the footprint had no usable samples. */
  h?: number;
  ground: number;
}

/** Roofs lower than this that are tagged as open-sided are canopies; taller ones are the tops of real buildings. */
const COVER_MAX_HEIGHT = 15;

/** Tests whether a point is on, or right beside, the deck of a bridge. */
function deckTest(roads: Road[]): (p: Pt) => boolean {
  const spans: { a: Pt; b: Pt; reach: number }[] = [];
  for (const r of roads) {
    let s = 0;
    for (let i = 1; i < r.pts.length; i++) {
      const [a, b] = [r.pts[i - 1], r.pts[i]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const sec = r.sections.find((x) => s + len / 2 <= x.s1) ?? r.sections[r.sections.length - 1];
      // Half the carriageway, a footpath, and a little slack for how loosely these things are drawn.
      if (sec.level > 0) spans.push({ a, b, reach: ((sec.lanesF + sec.lanesB) * 3.4) / 2 + 5 });
      s += len;
    }
  }
  return (p) =>
    spans.some(({ a, b, reach }) => {
      const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 || 1;
      const u = Math.min(1, Math.max(0, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / len2));
      return Math.hypot(p[0] - (a[0] + (b[0] - a[0]) * u), p[1] - (a[1] + (b[1] - a[1]) * u)) < reach;
    });
}

export function interpretBuildings(
  data: OsmData,
  bounds: Rect,
  measure: (ring: Pt[]) => Measured,
  roads: Road[] = [],
): { buildings: Building[]; report: Record<string, number> } {
  const onDeck = deckTest(roads);
  const report: Record<string, number> = {};
  const bump = (k: string) => (report[k] = (report[k] ?? 0) + 1);
  const buildings: Building[] = [];
  for (const o of outlines(data)) {
    const t = o.tags;
    // A bridge mapped as a building is already a road with a bridge level; do not build it twice.
    if (!t.building || t.building === 'no' || t.building === 'bridge' || t.location === 'underground') continue;
    if (o.ring.length < 3 || !inRect(centroid(o.ring), bounds)) continue;
    const footprint = Math.abs(ringArea(o.ring));
    // A scrap of a many-part outline is a mapping leftover, not a building of its own.
    if (o.share < 0.1 && footprint < 25) {
      bump('buildings.skippedScraps');
      continue;
    }
    const m = measure(o.ring);
    const tagged = parseFloat(t.height ?? '');
    const levels = parseFloat(t['building:levels'] ?? '');
    let h: number;
    let hSource: Building['hSource'];
    // LiDAR sees tree canopy over small sheds and nothing useful on demolished sites, so sanity-check it.
    if (m.h !== undefined && m.h >= 2.2) [h, hSource] = [m.h, 'lidar'];
    else if (tagged > 0) [h, hSource] = [tagged, 'tag'];
    else if (levels > 0) [h, hSource] = [levels * 3.3, 'levels'];
    else [h, hSource] = [4, 'default'];
    // A footprint the size of a kiosk cannot be measured from the air: the height found is its neighbour's.
    if (hSource === 'lidar' && footprint < 12 && h > 6) {
      h = tagged > 0 ? tagged : 3;
      bump('buildings.height.kioskCapped');
    }
    bump(`buildings.height.${hSource}`);
    // A roof with no walls is not a building. One beside a bridge deck stands on the bridge: the
    // height measured for it runs all the way down to whatever the bridge crosses.
    const open = t.building === 'roof' || t.building === 'shelter' || t.building === 'carport' || t.building === 'canopy' || t.amenity === 'shelter';
    const deck = open && (onDeck(centroid(o.ring)) || o.ring.some(onDeck));
    const cover: Building['cover'] = deck ? 'deck' : open && h <= COVER_MAX_HEIGHT ? 'ground' : undefined;
    if (cover) bump(`buildings.covers.${cover}`);
    buildings.push({
      id: o.id,
      ring: roundRing(simplifyRing(o.ring, 0.2)),
      h: Math.round(h * 10) / 10,
      hSource,
      ground: Math.round(m.ground * 10) / 10,
      kind: t.building === 'yes' ? (t.amenity ?? t.shop ?? t.office ?? 'yes') : t.building,
      name: t.name,
      cover,
    });
  }
  report['buildings.count'] = buildings.length;
  return { buildings, report };
}

function areaKind(t: Tags): Area['kind'] | undefined {
  if (t.building) return undefined;
  if (t.landuse === 'cemetery' || t.amenity === 'grave_yard') return 'cemetery';
  if (t.natural === 'water' || t.leisure === 'swimming_pool') return 'water';
  if (t.natural === 'wood' || t.landuse === 'forest' || t.natural === 'scrub') return 'wood';
  if (t.leisure === 'pitch') return 'pitch';
  if (t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'grass' || t.landuse === 'village_green' || t.landuse === 'recreation_ground') return 'park';
  if (t.amenity === 'university' || t.amenity === 'college') return 'campus';
  if (t.amenity === 'parking' && t.parking !== 'underground' && t.parking !== 'multi-storey') return 'parking';
  // A site being built on, or cleared and waiting: a sealed yard, which is what a car park is too.
  if (t.landuse === 'construction' || t.landuse === 'brownfield') return 'parking';
  if (t.highway === 'pedestrian' && t.area === 'yes') return 'plaza';
  if (t.natural === 'beach' || t.natural === 'sand') return 'beach';
  if (t.natural === 'bare_rock') return 'rock';
  return undefined;
}

export function interpretAreas(data: OsmData, bounds: Rect): Area[] {
  const areas: Area[] = [];
  for (const o of outlines(data)) {
    const kind = areaKind(o.tags);
    if (!kind) continue;
    const ring = clipRing(o.ring, bounds);
    if (ring.length < 3 || Math.abs(ringArea(ring)) < 20) continue;
    areas.push({ id: o.id, kind, ring: roundRing(ring), name: o.tags.name });
  }
  // Big areas first, so small ones (a pitch in a park) draw on top.
  return areas.sort((a, b) => Math.abs(ringArea(b.ring)) - Math.abs(ringArea(a.ring)));
}

/** A path keeps to a road's side for at least this far before it counts as that road's footpath. */
const ROADSIDE_RUN = 15;

/**
 * For a point on a path heading (dx, dy): the nearest spot on the centreline of a road that has its
 * own footpath, if the path is running along beside that road, close enough to be its footpath.
 */
function roadsideTest(roads: Road[]): (p: Pt, dx: number, dy: number) => Pt | undefined {
  const CELL = 24;
  const cells = new Map<number, { a: Pt; b: Pt; reach: number }[]>();
  for (const r of roads) {
    if (!r.footpath) continue;
    let s = 0;
    for (let i = 1; i < r.pts.length; i++) {
      const [a, b] = [r.pts[i - 1], r.pts[i]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const sec = r.sections.find((x) => s + len / 2 <= x.s1) ?? r.sections[r.sections.length - 1];
      s += len;
      if (!sec || sec.level !== 0) continue;
      // Half the carriageway, its footpath, and the width of a verge beyond.
      const seg = { a, b, reach: ((sec.lanesF + sec.lanesB) * 3.3) / 2 + 1 + 2.6 + 3 };
      for (let cx = Math.floor((Math.min(a[0], b[0]) - seg.reach) / CELL); cx <= Math.floor((Math.max(a[0], b[0]) + seg.reach) / CELL); cx++)
        for (let cy = Math.floor((Math.min(a[1], b[1]) - seg.reach) / CELL); cy <= Math.floor((Math.max(a[1], b[1]) + seg.reach) / CELL); cy++) {
          const k = cx * 65536 + cy;
          let list = cells.get(k);
          if (!list) cells.set(k, (list = []));
          list.push(seg);
        }
    }
  }
  return (p, dx, dy) => {
    let best: Pt | undefined;
    let bestD = Infinity;
    for (const { a, b, reach } of cells.get(Math.floor(p[0] / CELL) * 65536 + Math.floor(p[1] / CELL)) ?? []) {
      const [ex, ey] = [b[0] - a[0], b[1] - a[1]];
      const len = Math.hypot(ex, ey) || 1;
      // Within about 30 degrees of the road's own heading.
      if (Math.abs(ex * dx + ey * dy) / len < 0.87) continue;
      const u = Math.min(1, Math.max(0, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / len / len));
      const q: Pt = [a[0] + ex * u, a[1] + ey * u];
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (d < reach && d < bestD) [best, bestD] = [q, d];
    }
    return best;
  };
}

/**
 * The parts of a path that are not just a road's footpath drawn a second time. Many roadside
 * footpaths are mapped as paths of their own with nothing to say so; the road generator already lays
 * one there. Where the path leaves the roadside, it starts from the road.
 */
function awayFromRoads(run: Pt[], roadside: (p: Pt, dx: number, dy: number) => Pt | undefined): Pt[][] {
  // The path at steps of two metres or less, each with the road it is beside, if any.
  const pts: Pt[] = [];
  const road: (Pt | undefined)[] = [];
  for (let i = 0; i < run.length; i++) {
    const [a, b] = [run[Math.max(0, i - 1)], run[i]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / 2));
    for (let k = i ? 1 : n; k <= n; k++) {
      const q: Pt = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
      pts.push(q);
      road.push(len > 0.01 ? roadside(q, (b[0] - a[0]) / len, (b[1] - a[1]) / len) : undefined);
    }
  }
  if (pts.length > 1) road[0] = road[1] && roadside(pts[0], (pts[1][0] - pts[0][0]) / (Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) || 1), (pts[1][1] - pts[0][1]) / (Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) || 1));
  // Only a long enough stretch beside a road is its footpath: a path that meets a road, or cuts a corner, is not.
  const drop = pts.map(() => false);
  for (let i = 0; i < pts.length; i++) {
    if (!road[i]) continue;
    let j = i;
    let len = 0;
    while (j + 1 < pts.length && road[j + 1]) {
      len += Math.hypot(pts[j + 1][0] - pts[j][0], pts[j + 1][1] - pts[j][1]);
      j++;
    }
    if (len >= ROADSIDE_RUN) for (let k = i; k <= j; k++) drop[k] = true;
    i = j;
  }
  if (!drop.includes(true)) return [run];
  const out: Pt[][] = [];
  let piece: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (drop[i]) {
      if (piece.length) out.push([...piece, pts[i], road[i]!]);
      piece = [];
    } else {
      if (!piece.length && i > 0) piece.push(road[i - 1]!, pts[i - 1]);
      piece.push(pts[i]);
    }
  }
  if (piece.length > 1) out.push(piece);
  return out;
}

export function interpretPaths(data: OsmData, bounds: Rect, roads: Road[] = []): { paths: Path[]; report: Record<string, number> } {
  const report: Record<string, number> = {};
  const paths: Path[] = [];
  const roadside = roadsideTest(roads);
  for (const w of data.ways.values()) {
    const t = w.tags;
    const hw = t.highway;
    if (!(hw === 'footway' || hw === 'path' || hw === 'steps' || hw === 'cycleway' || hw === 'pedestrian') || t.area === 'yes') continue;
    // Footpaths beside roads and crossings come from the road generator, not from the map.
    if (t.footway === 'sidewalk' || t.footway === 'crossing' || t.cycleway === 'crossing') {
      report['paths.skippedRoadsideAndCrossings'] = (report['paths.skippedRoadsideAndCrossings'] ?? 0) + 1;
      continue;
    }
    if (t.tunnel === 'building_passage' || t.indoor === 'yes') continue;
    const layer = parseInt(t.layer ?? '', 10) || 0;
    const level = t.bridge && t.bridge !== 'no' ? Math.max(1, layer) : t.tunnel === 'yes' ? Math.min(-1, layer) : 0;
    const kind: Path['kind'] = hw === 'steps' ? 'steps' : hw === 'cycleway' ? 'cycle' : 'foot';
    let run: Pt[] = [];
    let part = 0;
    const flush = () => {
      const pieces = run.length > 1 ? (level === 0 && kind !== 'steps' ? awayFromRoads(run, roadside) : [run]) : [];
      if (run.length > 1 && (pieces.length !== 1 || pieces[0] !== run)) report['paths.roadsideStretchesDropped'] = (report['paths.roadsideStretchesDropped'] ?? 0) + 1;
      for (const piece of pieces) paths.push({ id: `w${w.id}${part ? '.' + part : ''}`, kind, pts: roundRing(simplify(piece, 0.2)), level }), part++;
      run = [];
    };
    for (const id of w.nodes) {
      const p = data.nodes.get(id);
      if (p && inRect(p, bounds)) run.push(p);
      else flush();
    }
    flush();
  }
  report['paths.count'] = paths.length;
  return { paths, report };
}

export function interpretStreams(data: OsmData, bounds: Rect): Stream[] {
  const streams: Stream[] = [];
  for (const w of data.ways.values()) {
    const ww = w.tags.waterway;
    const kind: Stream['kind'] | undefined = ww === 'river' ? 'river' : ww === 'stream' ? 'stream' : ww === 'drain' || ww === 'ditch' ? 'drain' : undefined;
    if (!kind || w.tags.tunnel === 'culvert' || w.tags.location === 'underground') continue;
    let run: Pt[] = [];
    let part = 0;
    const flush = () => {
      if (run.length > 1) streams.push({ id: `w${w.id}${part++ ? '.' + part : ''}`, kind, pts: roundRing(simplify(run, 0.5)), name: w.tags.name });
      run = [];
    };
    for (const id of w.nodes) {
      const p = data.nodes.get(id);
      if (p && inRect(p, bounds)) run.push(p);
      else flush();
    }
    flush();
  }
  return streams;
}

/** Zones that are only the land under roads say nothing a road does not; they are left out. */
const SKIP_ZONES = new Set(['Road', 'Strategic Transport Corridor Zone', 'DELETED']);

/** Unitary Plan base zones (GeoJSON in NZTM) clipped to the tile, smallest last so a lookup can take the last match. */
export function interpretZones(
  json: { names: Record<string, string>; features: { properties: { OBJECTID: number; ZONE: number }; geometry: { type: string; coordinates: number[][][] | number[][][][] } | null }[] },
  originE: number,
  originN: number,
  bounds: Rect,
): { zones: Zone[]; report: Record<string, number> } {
  const report: Record<string, number> = {};
  const zones: Zone[] = [];
  for (const f of json.features) {
    const name = json.names[f.properties.ZONE] ?? `Zone ${f.properties.ZONE}`;
    if (SKIP_ZONES.has(name) || !f.geometry) {
      report['zones.skippedRoad'] = (report['zones.skippedRoad'] ?? 0) + 1;
      continue;
    }
    const polys = f.geometry.type === 'MultiPolygon' ? (f.geometry.coordinates as number[][][][]) : [f.geometry.coordinates as number[][][]];
    polys.forEach((poly, i) => {
      // Holes are left out: whatever fills a hole is its own, smaller zone, and smaller zones win.
      let ring = poly[0].map(([e, n]): Pt => [e - originE, n - originN]);
      ring.pop();
      if (ringArea(ring) < 0) ring.reverse();
      ring = clipRing(simplifyRing(ring, 0.5), bounds);
      if (ring.length < 3 || Math.abs(ringArea(ring)) < 30) return;
      zones.push({ id: `z${f.properties.OBJECTID}${i ? '.' + i : ''}`, zone: name, ring: roundRing(ring) });
    });
  }
  zones.sort((a, b) => Math.abs(ringArea(b.ring)) - Math.abs(ringArea(a.ring)));
  report['zones.count'] = zones.length;
  return { zones, report };
}

export function interpretLandmarks(data: OsmData, bounds: Rect): Landmark[] {
  const out: Landmark[] = [];
  for (const n of data.tagged) {
    const kind: Landmark['kind'] | undefined = n.tags.waterway === 'waterfall' ? 'waterfall' : n.tags.natural === 'peak' ? 'peak' : undefined;
    if (kind && inRect(n.at, bounds)) out.push({ id: `n${n.id}`, kind, x: round(n.at[0]), y: round(n.at[1]), name: n.tags.name });
  }
  return out;
}
