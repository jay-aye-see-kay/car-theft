// Piers over open water as walkable, drivable decks.
//
// The LiDAR DEM drops piled wharves and piers along with the water under
// them (Queens Wharf, the Viaduct's boardwalks): ground classification
// sees through the deck to the sea. Each OSM `man_made=pier` area is
// burnt back into the DEM at its deck height before anything else samples
// it, so the terrain, its collider, the buildings standing on it and the
// land-use tint all agree. Fixed piers take the height of any dry part of
// them in the DEM (where they join the land), else PIER_DECK; floating
// pontoons sit just above the water. An override `deck` sets the height,
// or `false` leaves the pier out.
//
// Narrow piers and pontoons (a marina's fingers, a metre or three across)
// are too fine for the 2 m terrain lattice and the traced coastline, which
// turn them into notched, jagged strips. Those are also built as decks of
// their own, straight from the OSM outline (buildDecks): a flat top at deck
// height and sides down into the water. Their DEM pixels are burnt as any
// pier's (so the game's ground still knows they're there), but left out of
// the coastline (`decked`), and the terrain cells that are only their
// burnt lattice aren't drawn (hideDeckCells), or they'd poke out past the
// sides.
import { assembleRings, cleanRing, inRing, MeshBuilder, nodesLocal, rgb, type Polygon } from './buildings.ts';
import type { GroundRaster } from './ground.ts';
import type { OsmData, OsmWay, Tags } from './osm.ts';
import type { Overrides } from './overrides.ts';
import { localToNztm, nztmToLocal, type Local } from './project.ts';
import type { Raster } from './raster.ts';
import { CELL_SIZE, SEA_CUTOFF, SEA_SHELF, WATER_LEVEL, type TerrainSampler } from './terrain.ts';

/** Deck of a fixed pier with no dry part to copy, m above sea level (the wharves are ~3 m). */
const PIER_DECK = 2.8;
/** Freeboard of a floating pontoon, m. */
const PONTOON = 0.5;
/** Burn the deck this far past the mapped edge, so the 2 m terrain lattice catches narrow piers. */
const GROW = 0.75;
/** Piers narrower than this on average (m: twice the area over the perimeter) get a deck of their own. */
const NARROW = 6;
/** A deck's top sits this far over the burnt ground under it, as the sea walls' caps do. */
const DECK_LIFT = 0.05;
/** Its sides reach this far under the water. */
const DECK_BOTTOM = WATER_LEVEL - 2;
const DECK_SIDE = rgb(0x57544e);
const DECK_TOP = rgb(0x9b978d);

/** A narrow pier or pontoon to build as its own deck: its outline and deck height. */
export type Deck = { key: string; polygon: Polygon; deck: number };

export type PierResult = {
  piers: number;
  pixels: number;
  decks: Deck[];
  /** DEM pixels raised under decks, 1 each: not coastline (seawalls.ts treats them as water). */
  decked: Uint8Array;
};

const isPier = (t: Tags) => t.man_made === 'pier' && t.area !== 'no';

/**
 * Raises the DEM under pier areas in place. Returns how many piers were
 * laid and DEM pixels raised, and the narrow ones to build as decks.
 */
export function layPiers(osm: OsmData, dem: Raster, overrides?: Overrides): PierResult {
  const jobs: { key: string; tags: Tags; rings: Local[][]; outline?: Polygon }[] = [];
  const viaRelation = new Set<number>();
  for (const rel of osm.relations.values()) {
    if (!isPier(rel.tags) || rel.tags.type !== 'multipolygon') continue;
    const outers: OsmWay[] = [];
    for (const m of rel.members) {
      const w = m.type === 'way' ? osm.ways.get(m.ref) : undefined;
      if (!w) continue;
      viaRelation.add(w.id);
      if (m.role !== 'inner') outers.push(w);
    }
    const rings = assembleRings(outers).map((n) => nodesLocal(osm, n)).filter((r): r is Local[] => !!r);
    if (rings.length) jobs.push({ key: `r${rel.id}`, tags: rel.tags, rings });
  }
  for (const way of osm.ways.values()) {
    if (!isPier(way.tags) || viaRelation.has(way.id)) continue;
    if (way.nodes.length < 4 || way.nodes[0] !== way.nodes[way.nodes.length - 1]) continue;
    const ring = nodesLocal(osm, way.nodes);
    if (!ring) continue;
    // Only plain closed ways can be decks: multipolygons here are the big wharves.
    const outer = cleanRing(ring, true);
    jobs.push({ key: `w${way.id}`, tags: way.tags, rings: [ring], outline: outer && narrow(outer) ? { outer, holes: [] } : undefined });
  }

  let piers = 0;
  let pixels = 0;
  const decks: Deck[] = [];
  const decked = new Uint8Array(dem.width * dem.height);
  for (const job of jobs) {
    const o = overrides?.get(job.key)?.deck;
    if (o === false) continue;
    const cells = pixelsUnder(dem, job.rings);
    if (!cells.length) continue;
    let deck: number;
    if (typeof o === 'number') deck = o;
    else if (job.tags.floating === 'yes') deck = WATER_LEVEL + PONTOON;
    else {
      const dry = cells.map((k) => dem.data[k]).filter((v) => v > WATER_LEVEL + 0.5).sort((a, b) => a - b);
      deck = dry.length >= Math.max(4, cells.length * 0.15) ? dry[Math.floor(dry.length / 2)] : PIER_DECK;
    }
    let raised = 0;
    for (const k of cells) {
      const v = dem.data[k];
      // Only fill the sea (and low spots on the deck): never cut into land.
      if (Number.isNaN(v) || v < SEA_CUTOFF || v < deck - 0.5) {
        dem.data[k] = deck;
        if (job.outline) decked[k] = 1;
        raised++;
      }
    }
    if (raised) {
      piers++;
      pixels += raised;
    }
    if (job.outline) decks.push({ key: job.key, polygon: job.outline, deck });
  }
  return { piers, pixels, decks, decked };
}

/** Whether a ring (wound positive) is narrow enough to be a deck of its own. */
function narrow(ring: Local[]): boolean {
  let area = 0;
  let perimeter = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    area += a.x * b.z - b.x * a.z;
    perimeter += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return Math.abs(area) / perimeter < NARROW;
}

/**
 * Each deck as a flat top at its height and sides from under the water,
 * solid, in the buildings layer of the chunk its middle is in. Sides that
 * end up inside the ground (where a pier meets the land) are never seen.
 */
export function buildDecks(decks: Deck[], chunkAt: (x: number, z: number) => MeshBuilder | null): number {
  let built = 0;
  for (const d of decks) {
    const r = d.polygon.outer;
    const mb = chunkAt(r.reduce((s, p) => s + p.x, 0) / r.length, r.reduce((s, p) => s + p.z, 0) / r.length);
    if (!mb) continue;
    mb.prism({ polygons: [d.polygon] }, DECK_BOTTOM, d.deck + DECK_LIFT, DECK_SIDE, DECK_TOP, true);
    built++;
  }
  return built;
}

/**
 * Hides the terrain cells that are nothing but a deck's burnt ground: every
 * corner either the harbour floor or a lattice point raised under a deck
 * (one whose box filter reads a `decked` pixel). Their ground would show as
 * lumps past the deck's sides; with them gone it's the deck over the water.
 * Cells with a corner on land (where a pier meets the shore) are kept.
 */
export function hideDeckCells(dem: Raster, decked: Uint8Array, terrain: TerrainSampler, ground: GroundRaster): number {
  const deckPixel = (x: number, z: number) => {
    const p = localToNztm(x, z);
    const c = Math.floor((p.e - dem.west) / dem.res);
    const r = Math.floor((dem.north - p.n) / dem.res);
    return c >= 0 && r >= 0 && c < dem.width && r < dem.height && decked[r * dem.width + c] === 1;
  };
  /** 0 harbour floor, 1 under a deck, 2 land. Memoised by lattice point. */
  const kinds = new Map<number, number>();
  const kind = (c: number, r: number) => {
    const key = (c + 0x8000) * 0x10000 + (r + 0x8000);
    let k = kinds.get(key);
    if (k === undefined) {
      const x = c * CELL_SIZE;
      const z = r * CELL_SIZE;
      if (terrain.lattice(c, r) <= SEA_SHELF + 0.01) k = 0;
      else k = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]].some(([dx, dz]) => deckPixel(x + dx, z + dz)) ? 1 : 2;
      kinds.set(key, k);
    }
    return k;
  };
  // Candidate cells: those round every decked pixel.
  const cells = new Set<number>();
  for (let k = 0; k < decked.length; k++) {
    if (!decked[k]) continue;
    const r = Math.floor(k / dem.width);
    const p = nztmToLocal(dem.west + (k - r * dem.width + 0.5) * dem.res, dem.north - (r + 0.5) * dem.res);
    const c0 = Math.floor(p.x / CELL_SIZE);
    const r0 = Math.floor(p.z / CELL_SIZE);
    for (let dr = -1; dr <= 0; dr++) for (let dc = -1; dc <= 0; dc++) cells.add((c0 + dc + 0x8000) * 0x10000 + (r0 + dr + 0x8000));
  }
  let hidden = 0;
  for (const key of [...cells].sort((a, b) => a - b)) {
    const c = Math.floor(key / 0x10000) - 0x8000;
    const r = (key % 0x10000) - 0x8000;
    const corners = [kind(c, r), kind(c + 1, r), kind(c, r + 1), kind(c + 1, r + 1)];
    if (corners.includes(2) || !corners.includes(1)) continue;
    ground.hideCell(c, r);
    hidden++;
  }
  return hidden;
}

/** Indices of DEM pixels whose centres are inside the rings or within GROW of their edges. */
function pixelsUnder(dem: Raster, rings: Local[][]): number[] {
  const pts = rings.flat();
  const minX = Math.min(...pts.map((p) => p.x)) - GROW;
  const maxX = Math.max(...pts.map((p) => p.x)) + GROW;
  const minZ = Math.min(...pts.map((p) => p.z)) - GROW;
  const maxZ = Math.max(...pts.map((p) => p.z)) + GROW;
  // Local axes are aligned with NZTM (x = east, z = south), so the bbox maps straight across.
  const nw = localToNztm(minX, minZ);
  const se = localToNztm(maxX, maxZ);
  const c0 = Math.max(0, Math.floor((nw.e - dem.west) / dem.res));
  const c1 = Math.min(dem.width - 1, Math.ceil((se.e - dem.west) / dem.res));
  const r0 = Math.max(0, Math.floor((dem.north - nw.n) / dem.res));
  const r1 = Math.min(dem.height - 1, Math.ceil((dem.north - se.n) / dem.res));
  const out: number[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const p = nztmToLocal(dem.west + (c + 0.5) * dem.res, dem.north - (r + 0.5) * dem.res);
      // Even-odd over all rings, so a ring inside another is a hole.
      let inside = false;
      for (const ring of rings) if (inRing(ring, p.x, p.z)) inside = !inside;
      if (inside || rings.some((ring) => nearRing(ring, p.x, p.z, GROW))) out.push(r * dem.width + c);
    }
  }
  return out;
}

function nearRing(ring: Local[], x: number, z: number, d: number): boolean {
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz || 1;
    const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / len2));
    if (Math.hypot(x - a.x - t * dx, z - a.z - t * dz) <= d) return true;
  }
  return false;
}
