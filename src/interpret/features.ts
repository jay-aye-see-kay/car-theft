// Buildings, land areas and footpaths from OpenStreetMap, for the semantic model.
import { type Rect, centroid, clipRing, inRect, ringArea, simplify, simplifyRing } from '../geo/poly.ts';
import type { Area, Building, Path, Pt } from '../model/types.ts';
import { type OsmData, type Tags, stitchRings } from './osm.ts';

const round = (v: number): number => Math.round(v * 100) / 100;
const roundRing = (ring: Pt[]): Pt[] => ring.map((p): Pt => [round(p[0]), round(p[1])]);

interface Outline {
  id: string;
  tags: Tags;
  ring: Pt[];
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
    if (w.nodes.length > 3 && w.nodes[0] === w.nodes[w.nodes.length - 1]) found.push({ id: `w${w.id}`, tags: w.tags, ring: toRing(w.nodes) });
  }
  for (const r of data.relations) {
    // Tags may sit on the relation or, in older mapping, on its outer way.
    const tags = Object.keys(r.tags).length > 1 ? r.tags : { ...data.ways.get(r.outers[0])?.tags, ...r.tags };
    stitchRings(r.outers, data).forEach((ids, i) => found.push({ id: `rel${r.id}${i ? '.' + i : ''}`, tags, ring: toRing(ids) }));
  }
  return found;
}

export interface Measured {
  /** Height above ground from LiDAR, or undefined if the footprint had no usable samples. */
  h?: number;
  ground: number;
}

export function interpretBuildings(
  data: OsmData,
  bounds: Rect,
  measure: (ring: Pt[]) => Measured,
): { buildings: Building[]; report: Record<string, number> } {
  const report: Record<string, number> = {};
  const bump = (k: string) => (report[k] = (report[k] ?? 0) + 1);
  const buildings: Building[] = [];
  for (const o of outlines(data)) {
    const t = o.tags;
    // A bridge mapped as a building is already a road with a bridge level; do not build it twice.
    if (!t.building || t.building === 'no' || t.building === 'bridge' || t.location === 'underground') continue;
    if (o.ring.length < 3 || !inRect(centroid(o.ring), bounds)) continue;
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
    bump(`buildings.height.${hSource}`);
    buildings.push({
      id: o.id,
      ring: roundRing(simplifyRing(o.ring, 0.2)),
      h: Math.round(h * 10) / 10,
      hSource,
      ground: Math.round(m.ground * 10) / 10,
      kind: t.building === 'yes' ? (t.amenity ?? t.shop ?? t.office ?? 'yes') : t.building,
      name: t.name,
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
  if (t.highway === 'pedestrian' && t.area === 'yes') return 'plaza';
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

export function interpretPaths(data: OsmData, bounds: Rect): { paths: Path[]; report: Record<string, number> } {
  const report: Record<string, number> = {};
  const paths: Path[] = [];
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
      if (run.length > 1) paths.push({ id: `w${w.id}${part ? '.' + part : ''}`, kind, pts: roundRing(simplify(run, 0.2)), level });
      if (run.length > 1) part++;
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
