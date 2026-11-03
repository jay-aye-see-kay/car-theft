// OSM PBF reader, clipped to a box, into v1's OsmData (tools/citygen/osm.ts)
// so v1 modules can read it. No dependency: the format is zlib'd protobuf
// blocks (https://wiki.openstreetmap.org/wiki/PBF_Format) and we need only
// a small part of it.
//
// What's kept matches the OSM API's /map call, plus whole multipolygons:
// every way with a node in the box (and all its nodes), tagged nodes in the
// box, relations with a member kept, and every member way of multipolygon
// relations kept, so park, water and building outlines that cross the edge
// are still closed.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import type { OsmData, OsmMember, OsmNode, Tags } from '../citygen/osm.ts';
import { emptyOsm } from '../citygen/osm.ts';
import type { BBox } from '../citygen/project.ts';

/** Protobuf reader over a byte range: just varints, length-delimited fields and packed arrays. */
class Pb {
  pos: number;
  readonly buf: Uint8Array;
  readonly end: number;
  constructor(buf: Uint8Array, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }
  // Ids pass 2^32, so varints are summed as doubles (exact below 2^53).
  varint(): number {
    let v = 0, mul = 1, b: number;
    do {
      b = this.buf[this.pos++];
      v += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return v;
  }
  svarint(): number {
    const v = this.varint();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  }
  /** Next field: [field number, wire type], or null at the end. */
  key(): [number, number] | null {
    if (this.pos >= this.end) return null;
    const k = this.varint();
    return [Math.floor(k / 8), k & 7];
  }
  bytes(): Pb {
    const len = this.varint();
    const p = new Pb(this.buf, this.pos, this.pos + len);
    this.pos += len;
    return p;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 2) { const len = this.varint(); this.pos += len; } // not `pos += varint()`: that reads pos first
    else if (wire === 5) this.pos += 4;
    else if (wire === 1) this.pos += 8;
    else throw new Error(`pbf: wire type ${wire}`);
  }
  packed(signed: boolean): number[] {
    const p = this.bytes();
    const out: number[] = [];
    while (p.pos < p.end) out.push(signed ? p.svarint() : p.varint());
    return out;
  }
  string(): string {
    const p = this.bytes();
    return new TextDecoder().decode(p.buf.subarray(p.pos, p.end));
  }
}

/** Calls fn with each decompressed OSMData block's bytes. */
function eachBlock(file: Uint8Array, fn: (block: Uint8Array) => void) {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let pos = 0;
  while (pos < file.length) {
    const hlen = view.getInt32(pos);
    pos += 4;
    const h = new Pb(file, pos, pos + hlen);
    let type = '', size = 0;
    for (let k; (k = h.key()); ) {
      if (k[0] === 1) type = h.string();
      else if (k[0] === 3) size = h.varint();
      else h.skip(k[1]);
    }
    pos += hlen;
    const blob = new Pb(file, pos, pos + size);
    pos += size;
    if (type !== 'OSMData') continue;
    let data: Uint8Array | null = null;
    for (let k; (k = blob.key()); ) {
      if (k[0] === 1) { const b = blob.bytes(); data = b.buf.subarray(b.pos, b.end); }
      else if (k[0] === 3) { const b = blob.bytes(); data = inflateSync(b.buf.subarray(b.pos, b.end)); }
      else blob.skip(k[1]);
    }
    if (!data) throw new Error('pbf: blob without raw or zlib data (lzma/zstd not supported)');
    fn(data);
  }
}

type RawWay = { id: number; version: number; refs: number[]; tags: Tags };
type RawRel = { id: number; version: number; members: OsmMember[]; tags: Tags };
type Visitor = {
  node?: (id: number, lat: number, lon: number, tags: Tags | null) => void;
  way?: (w: RawWay) => void;
  rel?: (r: RawRel) => void;
};

const MEMBER_TYPES = ['node', 'way', 'relation'] as const;

function tagsOf(keys: number[], vals: number[], st: string[]): Tags {
  const t: Tags = {};
  for (let i = 0; i < keys.length; i++) t[st[keys[i]]] = st[vals[i]];
  return t;
}

function version(info: Pb): number {
  for (let k; (k = info.key()); ) {
    if (k[0] === 1) return info.varint();
    info.skip(k[1]);
  }
  return 0;
}

/** Decodes one PrimitiveBlock, handing each element to the visitor (skips groups it has no callback for). */
function readBlock(data: Uint8Array, v: Visitor) {
  const pb = new Pb(data);
  const st: string[] = [];
  const groups: Pb[] = [];
  let gran = 100, latOff = 0, lonOff = 0;
  for (let k; (k = pb.key()); ) {
    if (k[0] === 1) {
      const s = pb.bytes();
      for (let kk; (kk = s.key()); ) kk[0] === 1 ? st.push(s.string()) : s.skip(kk[1]);
    } else if (k[0] === 2) groups.push(pb.bytes());
    else if (k[0] === 17) gran = pb.varint();
    else if (k[0] === 19) latOff = pb.varint();
    else if (k[0] === 20) lonOff = pb.varint();
    else pb.skip(k[1]);
  }
  const deg = (raw: number, off: number) => (off + gran * raw) * 1e-9;
  for (const g of groups) {
    for (let k; (k = g.key()); ) {
      const [field, wire] = k;
      if (field === 2 && v.node) {
        // DenseNodes: delta-coded ids and coordinates, tags as one run of key,val,...,0 per node.
        const d = g.bytes();
        let ids: number[] = [], lats: number[] = [], lons: number[] = [], kv: number[] = [];
        for (let kk; (kk = d.key()); ) {
          if (kk[0] === 1) ids = d.packed(true);
          else if (kk[0] === 8) lats = d.packed(true);
          else if (kk[0] === 9) lons = d.packed(true);
          else if (kk[0] === 10) kv = d.packed(false);
          else d.skip(kk[1]);
        }
        let id = 0, lat = 0, lon = 0, j = 0;
        for (let i = 0; i < ids.length; i++) {
          id += ids[i]; lat += lats[i]; lon += lons[i];
          let tags: Tags | null = null;
          if (kv.length) {
            while (kv[j] !== 0) { (tags ??= {})[st[kv[j]]] = st[kv[j + 1]]; j += 2; }
            j++;
          }
          v.node(id, deg(lat, latOff), deg(lon, lonOff), tags);
        }
      } else if (field === 1 && v.node) {
        const n = g.bytes();
        let id = 0, lat = 0, lon = 0, keys: number[] = [], vals: number[] = [];
        for (let kk; (kk = n.key()); ) {
          if (kk[0] === 1) id = n.svarint();
          else if (kk[0] === 2) keys = n.packed(false);
          else if (kk[0] === 3) vals = n.packed(false);
          else if (kk[0] === 8) lat = n.svarint();
          else if (kk[0] === 9) lon = n.svarint();
          else n.skip(kk[1]);
        }
        v.node(id, deg(lat, latOff), deg(lon, lonOff), keys.length ? tagsOf(keys, vals, st) : null);
      } else if (field === 3 && v.way) {
        const w = g.bytes();
        let id = 0, ver = 0, keys: number[] = [], vals: number[] = [], refs: number[] = [];
        for (let kk; (kk = w.key()); ) {
          if (kk[0] === 1) id = w.varint();
          else if (kk[0] === 2) keys = w.packed(false);
          else if (kk[0] === 3) vals = w.packed(false);
          else if (kk[0] === 4) ver = version(w.bytes());
          else if (kk[0] === 8) refs = w.packed(true);
          else w.skip(kk[1]);
        }
        for (let i = 1; i < refs.length; i++) refs[i] += refs[i - 1];
        v.way({ id, version: ver, refs, tags: tagsOf(keys, vals, st) });
      } else if (field === 4 && v.rel) {
        const r = g.bytes();
        let id = 0, ver = 0, keys: number[] = [], vals: number[] = [], roles: number[] = [], mems: number[] = [], types: number[] = [];
        for (let kk; (kk = r.key()); ) {
          if (kk[0] === 1) id = r.varint();
          else if (kk[0] === 2) keys = r.packed(false);
          else if (kk[0] === 3) vals = r.packed(false);
          else if (kk[0] === 4) ver = version(r.bytes());
          else if (kk[0] === 8) roles = r.packed(false);
          else if (kk[0] === 9) mems = r.packed(true);
          else if (kk[0] === 10) types = r.packed(false);
          else r.skip(kk[1]);
        }
        let ref = 0;
        const members = mems.map((d, i) => ({ type: MEMBER_TYPES[types[i]], ref: (ref += d), role: st[roles[i]] }));
        v.rel({ id, version: ver, members, tags: tagsOf(keys, vals, st) });
      } else g.skip(wire);
    }
  }
}

/** Every node's coordinates, sorted by id for binary search (Maps of millions of nodes cost too much). */
class NodeIndex {
  ids: Float64Array;
  lat: Float64Array;
  lon: Float64Array;
  n = 0;
  constructor(cap = 1 << 20) {
    this.ids = new Float64Array(cap);
    this.lat = new Float64Array(cap);
    this.lon = new Float64Array(cap);
  }
  add(id: number, lat: number, lon: number) {
    if (this.n === this.ids.length) {
      const grow = (a: Float64Array) => { const b = new Float64Array(a.length * 2); b.set(a); return b; };
      this.ids = grow(this.ids); this.lat = grow(this.lat); this.lon = grow(this.lon);
    }
    if (this.n && id <= this.ids[this.n - 1]) throw new Error('pbf: nodes not sorted by id (need Sort.Type_then_ID)');
    this.ids[this.n] = id; this.lat[this.n] = lat; this.lon[this.n] = lon;
    this.n++;
  }
  find(id: number): number {
    let lo = 0, hi = this.n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.ids[mid];
      if (v === id) return mid;
      if (v < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
}

export type PbfStats = { nodesInFile: number; ways: number; relations: number; nodes: number };

/**
 * Reads a .osm.pbf and keeps what touches bbox (see the header). With
 * `complete` off, multipolygons aren't completed: exactly the OSM API's
 * view, which v1 was written against.
 */
export function readPbf(path: string, bbox: BBox, complete = true): { osm: OsmData; stats: PbfStats } {
  const file = readFileSync(path);
  const [w, s, e, n] = bbox;
  const inBox = (lat: number, lon: number) => lon >= w && lon <= e && lat >= s && lat <= n;
  const index = new NodeIndex();
  const osm = emptyOsm();
  const nodeTags = new Map<number, Tags>();
  const ways = new Map<number, RawWay>();
  const rels: RawRel[] = [];

  // Pass 1: all node coordinates, tagged nodes in the box, ways touching the box, every relation.
  eachBlock(file, (b) => readBlock(b, {
    node: (id, lat, lon, tags) => {
      index.add(id, lat, lon);
      if (tags && inBox(lat, lon)) nodeTags.set(id, tags);
    },
    way: (wy) => {
      for (const r of wy.refs) {
        const i = index.find(r);
        if (i >= 0 && inBox(index.lat[i], index.lon[i])) { ways.set(wy.id, wy); return; }
      }
    },
    rel: (r) => rels.push(r),
  }));

  // Relations with a kept member; then (pass 2) the rest of each kept multipolygon's ways.
  const keptRels = rels.filter((r) => r.members.some((m) => (m.type === 'way' ? ways.has(m.ref) : m.type === 'node' && nodeTags.has(m.ref))));
  const want = new Set<number>();
  for (const r of keptRels) {
    if (r.tags.type !== 'multipolygon') continue;
    for (const m of r.members) if (m.type === 'way' && !ways.has(m.ref)) want.add(m.ref);
  }
  if (complete && want.size) eachBlock(file, (b) => readBlock(b, { way: (wy) => { if (want.has(wy.id)) ways.set(wy.id, wy); } }));

  const addNode = (id: number, tags: Tags) => {
    if (osm.nodes.has(id)) return;
    const i = index.find(id);
    if (i < 0) return; // outside the extract
    const node: OsmNode = { id, version: 0, lat: index.lat[i], lon: index.lon[i], tags };
    osm.nodes.set(id, node);
  };
  for (const [id, tags] of nodeTags) addNode(id, tags);
  for (const wy of ways.values()) {
    const refs = wy.refs.filter((r) => index.find(r) >= 0);
    for (const r of refs) addNode(r, nodeTags.get(r) ?? {});
    if (refs.length >= 2) osm.ways.set(wy.id, { id: wy.id, version: wy.version, nodes: refs, tags: wy.tags });
  }
  for (const r of keptRels) osm.relations.set(r.id, { id: r.id, version: r.version, members: r.members, tags: r.tags });
  return { osm, stats: { nodesInFile: index.n, ways: osm.ways.size, relations: osm.relations.size, nodes: osm.nodes.size } };
}
