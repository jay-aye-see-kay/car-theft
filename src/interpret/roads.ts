// Turns OpenStreetMap ways into the road part of the semantic model.
//
// The map draws roads for cartographers: a way is cut wherever any tag changes, a divided
// road is two ways, and one real intersection can be six nodes. This rebuilds what a driver
// would call a road (junction to junction, with the lane count varying along it) and what
// they would call an intersection (one place, however many nodes the map used).
import { type Rect, inRect, polylineLength, rectCrossing, simplify } from '../geo/poly.ts';
import type { Junction, Pt, Road, RoadClass, RoadSection } from '../model/types.ts';
import type { OsmData, Tags } from './osm.ts';

const CLASS: Record<string, RoadClass> = {
  motorway: 'motorway',
  motorway_link: 'ramp',
  trunk_link: 'ramp',
  trunk: 'arterial',
  primary: 'arterial',
  primary_link: 'arterial',
  secondary: 'arterial',
  secondary_link: 'arterial',
  tertiary: 'collector',
  tertiary_link: 'collector',
  unclassified: 'street',
  residential: 'street',
  living_street: 'street',
  busway: 'lane',
  service: 'lane',
};

const DEFAULT_LANES: Record<RoadClass, number> = { motorway: 3, ramp: 1, arterial: 2, collector: 2, street: 2, lane: 1 };

export interface RoadOptions {
  /** Junction nodes joined by a road shorter than this are treated as one intersection. */
  clusterDist: number;
}

interface Attrs {
  cls: RoadClass;
  lanesF: number;
  lanesB: number;
  level: number;
  name?: string;
  footpath: boolean;
}

interface Edge {
  way: number;
  ids: number[];
  pts: Pt[];
  attrs: Attrs;
}

function drivable(t: Tags): boolean {
  if (!(t.highway in CLASS) || t.area === 'yes') return false;
  if (t.highway === 'service') {
    // Driveways and car-park aisles are lot contents, for a lot generator to make later.
    if (t.service && t.service !== 'alley') return false;
    if (t.access === 'private' || t.access === 'no') return false;
    if (t.tunnel === 'building_passage') return false;
  }
  return true;
}

function readAttrs(t: Tags): { attrs: Attrs; reversed: boolean } {
  const cls = CLASS[t.highway];
  const oneway = t.oneway === 'yes' || t.oneway === '-1' || t.highway === 'motorway' || t.junction === 'roundabout';
  const int = (v: string | undefined): number | undefined => {
    const n = v === undefined ? NaN : parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 6) : undefined;
  };
  const total = int(t.lanes) ?? (oneway && cls === 'arterial' ? 2 : DEFAULT_LANES[cls]);
  let lanesF: number;
  let lanesB: number;
  if (oneway) {
    lanesF = total;
    lanesB = 0;
  } else {
    lanesF = int(t['lanes:forward']) ?? Math.max(1, Math.ceil(total / 2));
    lanesB = int(t['lanes:backward']) ?? Math.max(1, total - lanesF);
  }
  const layer = parseInt(t.layer ?? '', 10);
  let level = 0;
  if (t.bridge && t.bridge !== 'no') level = Math.max(1, layer || 1);
  else if (t.tunnel === 'yes') level = Math.min(-1, layer || -1);
  const walkable = cls === 'arterial' || cls === 'collector' || cls === 'street';
  const footpath = walkable && t.sidewalk !== 'no' && t.sidewalk !== 'none' && !t.highway.endsWith('_link');
  return { attrs: { cls, lanesF, lanesB, level, name: t.name, footpath }, reversed: t.oneway === '-1' };
}

export function interpretRoads(
  data: OsmData,
  bounds: Rect,
  opts: RoadOptions,
): { roads: Road[]; junctions: Junction[]; report: Record<string, number> } {
  const report: Record<string, number> = {};
  const bump = (k: string, n = 1) => (report[k] = (report[k] ?? 0) + n);
  const pos = new Map<number, Pt>();
  let synthetic = -1;

  // 1. Cut each way to the tile, giving pieces that lie wholly inside.
  const pieces: Edge[] = [];
  for (const way of data.ways.values()) {
    if (!way.tags.highway) continue;
    if (!drivable(way.tags)) {
      if (way.tags.highway in CLASS) bump('roads.skippedDrivewaysAndAisles');
      continue;
    }
    const { attrs, reversed } = readAttrs(way.tags);
    const ids = reversed ? way.nodes.slice().reverse() : way.nodes;
    let cur: Edge | null = null;
    for (let i = 0; i < ids.length; i++) {
      const p = data.nodes.get(ids[i]);
      if (!p) continue;
      const inside = inRect(p, bounds);
      const prev = i > 0 ? data.nodes.get(ids[i - 1]) : undefined;
      if (prev && inside !== inRect(prev, bounds)) {
        const id = synthetic--;
        pos.set(id, rectCrossing(prev, p, bounds));
        if (inside) cur = { way: way.id, ids: [id], pts: [pos.get(id)!], attrs };
        else if (cur) {
          cur.ids.push(id);
          cur.pts.push(pos.get(id)!);
          pieces.push(cur);
          cur = null;
        }
      }
      if (inside) {
        cur ??= { way: way.id, ids: [], pts: [], attrs };
        cur.ids.push(ids[i]);
        cur.pts.push(p);
        pos.set(ids[i], p);
      }
    }
    if (cur && cur.ids.length > 1) pieces.push(cur);
  }
  bump('osm.waysUsed', new Set(pieces.map((p) => p.way)).size);

  // 2. A node is a junction unless exactly two road ends/passes touch it.
  const touches = new Map<number, number>();
  for (const p of pieces) {
    p.ids.forEach((id, i) => touches.set(id, (touches.get(id) ?? 0) + (i === 0 || i === p.ids.length - 1 ? 1 : 2)));
  }
  const isJunction = (id: number) => touches.get(id) !== 2;

  // 3. Split pieces at junctions into edges.
  const edges: Edge[] = [];
  for (const p of pieces) {
    let start = 0;
    for (let i = 1; i < p.ids.length; i++) {
      if (i === p.ids.length - 1 || isJunction(p.ids[i])) {
        edges.push({ way: p.way, ids: p.ids.slice(start, i + 1), pts: simplify(p.pts.slice(start, i + 1), 0.25), attrs: p.attrs });
        start = i;
      }
    }
  }

  // 4. Chain edges through non-junction nodes. Where the map cut a way only because a tag
  //    changed (4 lanes becoming 3), the result is one road with two sections.
  const at = new Map<number, { edge: number; start: boolean }[]>();
  edges.forEach((e, i) => {
    for (const [id, start] of [
      [e.ids[0], true],
      [e.ids[e.ids.length - 1], false],
    ] as const) {
      if (!at.has(id)) at.set(id, []);
      at.get(id)!.push({ edge: i, start });
    }
  });
  const used = new Uint8Array(edges.length);

  interface Chain {
    way: number;
    a: number;
    b: number;
    pts: Pt[];
    sections: RoadSection[];
    footpath: boolean;
  }
  const chains: Chain[] = [];

  const walk = (firstEdge: number, fromStart: boolean): void => {
    const first = edges[firstEdge];
    const chain: Chain = {
      way: first.way,
      a: fromStart ? first.ids[0] : first.ids[first.ids.length - 1],
      b: 0,
      pts: [],
      sections: [],
      footpath: first.attrs.footpath,
    };
    let ei = firstEdge;
    let forward = fromStart;
    let s = 0;
    for (;;) {
      used[ei] = 1;
      const e = edges[ei];
      const pts = forward ? e.pts : e.pts.slice().reverse();
      const len = polylineLength(pts);
      chain.pts.push(...(chain.pts.length ? pts.slice(1) : pts));
      const a = e.attrs;
      const sec: RoadSection = {
        s0: s,
        s1: s + len,
        cls: a.cls,
        lanesF: forward ? a.lanesF : a.lanesB,
        lanesB: forward ? a.lanesB : a.lanesF,
        level: a.level,
        name: a.name,
      };
      const last = chain.sections[chain.sections.length - 1];
      if (
        last &&
        last.cls === sec.cls &&
        last.lanesF === sec.lanesF &&
        last.lanesB === sec.lanesB &&
        last.level === sec.level &&
        last.name === sec.name
      ) {
        last.s1 = sec.s1;
      } else chain.sections.push(sec);
      s += len;
      const end = forward ? e.ids[e.ids.length - 1] : e.ids[0];
      chain.b = end;
      if (isJunction(end)) break;
      const next = at.get(end)!.find((x) => !used[x.edge]);
      if (!next) break; // A closed loop with no junction on it.
      ei = next.edge;
      forward = next.start;
    }
    chains.push(chain);
  };

  edges.forEach((e, i) => {
    if (!used[i] && isJunction(e.ids[0])) walk(i, true);
    if (!used[i] && isJunction(e.ids[e.ids.length - 1])) walk(i, false);
  });
  edges.forEach((_, i) => {
    if (!used[i]) walk(i, true);
  });
  bump('roads.sectionChangesAbsorbed', edges.length - chains.length);

  // 5. Merge junction nodes that are really one intersection.
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    let r = id;
    while (parent.has(r)) r = parent.get(r)!;
    return r;
  };
  const armCount = new Map<number, number>();
  for (const c of chains) for (const id of [c.a, c.b]) armCount.set(id, (armCount.get(id) ?? 0) + 1);
  const length = new Map(chains.map((c) => [c, polylineLength(c.pts)]));
  const kept: Chain[] = [];
  for (const c of chains) {
    const len = length.get(c)!;
    const real = (id: number) => (armCount.get(id) ?? 0) >= 3;
    const sameLevel = c.sections[0].level === c.sections[c.sections.length - 1].level;
    if (len < opts.clusterDist && c.a !== c.b && real(c.a) && real(c.b) && sameLevel) {
      const [ra, rb] = [find(c.a), find(c.b)];
      if (ra !== rb) parent.set(ra, rb);
      bump('junctions.shortLinksCollapsed');
    } else kept.push(c);
  }
  // Slivers left wholly inside a merged intersection.
  const roadsOut = kept.filter((c) => {
    const inside = find(c.a) === find(c.b) && c.a !== c.b && length.get(c)! < opts.clusterDist * 2.5;
    if (inside) bump('junctions.shortLinksCollapsed');
    return !inside;
  });

  const members = new Map<number, number[]>();
  for (const c of roadsOut) {
    for (const id of [c.a, c.b]) {
      const root = find(id);
      if (!members.has(root)) members.set(root, []);
      if (!members.get(root)!.includes(id)) members.get(root)!.push(id);
    }
  }
  const jid = new Map<number, string>();
  const junctions = new Map<string, Junction>();
  for (const [root, ids] of members) {
    const stable = ids.filter((i) => i > 0).sort((a, b) => a - b)[0];
    const id = stable ? `j${stable}` : `jx${-ids[0]}`;
    jid.set(root, id);
    const x = ids.reduce((sum, i) => sum + pos.get(i)![0], 0) / ids.length;
    const y = ids.reduce((sum, i) => sum + pos.get(i)![1], 0) / ids.length;
    junctions.set(id, { id, x: round(x), y: round(y), arms: [] });
    if (ids.length > 1) bump('junctions.merged');
  }

  const seen = new Map<string, number>();
  const roads: Road[] = roadsOut.map((c) => {
    const a = jid.get(find(c.a))!;
    const b = jid.get(find(c.b))!;
    const base = `r${c.way}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const id = n ? `${base}.${n}` : base;
    junctions.get(a)!.arms.push({ road: id, end: 'a' });
    junctions.get(b)!.arms.push({ road: id, end: 'b' });
    return {
      id,
      a,
      b,
      pts: c.pts.map((p): Pt => [round(p[0]), round(p[1])]),
      sections: c.sections.map((s) => ({ ...s, s0: round(s.s0), s1: round(s.s1) })),
      footpath: c.footpath,
    };
  });

  report['roads.count'] = roads.length;
  report['roads.withLaneChanges'] = roads.filter((r) =>
    r.sections.some((s, i) => i > 0 && (s.lanesF !== r.sections[i - 1].lanesF || s.lanesB !== r.sections[i - 1].lanesB)),
  ).length;
  report['roads.km'] = Math.round(roads.reduce((sum, r) => sum + polylineLength(r.pts), 0) / 100) / 10;
  report['junctions.count'] = [...junctions.values()].filter((j) => j.arms.length >= 3).length;
  report['junctions.deadEnds'] = [...junctions.values()].filter((j) => j.arms.length === 1).length;
  return { roads, junctions: [...junctions.values()], report };
}

const round = (v: number): number => Math.round(v * 100) / 100;
