import { toNztm } from '../geo/nztm.ts';
import type { Pt } from '../model/types.ts';

export type Tags = Record<string, string>;

export interface OsmWay {
  id: number;
  nodes: number[];
  tags: Tags;
}

export interface OsmRelation {
  id: number;
  tags: Tags;
  outers: number[];
  inners: number[];
}

export interface OsmData {
  /** Node positions in local metres (x east, y north of the tile centre). */
  nodes: Map<number, Pt>;
  /** Nodes that carry tags of their own. */
  tagged: { id: number; at: Pt; tags: Tags }[];
  ways: Map<number, OsmWay>;
  relations: OsmRelation[];
}

interface RawElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  tags?: Tags;
  members?: { type: string; ref: number; role: string }[];
}

export function parseOsm(json: { elements: RawElement[] }, originE: number, originN: number): OsmData {
  const data: OsmData = { nodes: new Map(), tagged: [], ways: new Map(), relations: [] };
  for (const el of json.elements) {
    if (el.type === 'node') {
      const [e, n] = toNztm(el.lat!, el.lon!);
      data.nodes.set(el.id, [e - originE, n - originN]);
      if (el.tags) data.tagged.push({ id: el.id, at: [e - originE, n - originN], tags: el.tags });
    } else if (el.type === 'way') {
      data.ways.set(el.id, { id: el.id, nodes: el.nodes ?? [], tags: el.tags ?? {} });
    } else {
      const ways = (el.members ?? []).filter((m) => m.type === 'way');
      data.relations.push({
        id: el.id,
        tags: el.tags ?? {},
        outers: ways.filter((m) => m.role !== 'inner').map((m) => m.ref),
        inners: ways.filter((m) => m.role === 'inner').map((m) => m.ref),
      });
    }
  }
  return data;
}

/** Joins a relation's member ways end to end into closed rings of node ids. */
export function stitchRings(wayIds: number[], data: OsmData): number[][] {
  const open = wayIds.map((id) => data.ways.get(id)?.nodes.slice()).filter((n): n is number[] => !!n && n.length > 1);
  const rings: number[][] = [];
  while (open.length) {
    const ring = open.pop()!;
    while (ring[0] !== ring[ring.length - 1]) {
      const tail = ring[ring.length - 1];
      const i = open.findIndex((w) => w[0] === tail || w[w.length - 1] === tail);
      if (i < 0) break;
      const next = open.splice(i, 1)[0];
      if (next[0] !== tail) next.reverse();
      ring.push(...next.slice(1));
    }
    if (ring[0] === ring[ring.length - 1] && ring.length > 3) rings.push(ring);
  }
  return rings;
}
