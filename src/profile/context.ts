// The profile map for one tile: which layers cover every point, the resolved profile there, and
// the terrain fields scatter rules read (distance to paths, streams and the coast; slope; relief).
import { toNztm } from '../geo/nztm.ts';
import { centroid, pointInRing, ringArea } from '../geo/poly.ts';
import { type Bounds, Grid, boxBlur, distanceField, fillRing, strokeLine } from '../geo/raster.ts';
import { boundsOf } from '../gen/cells.ts';
import { type Style, styleByName, useOf } from '../gen/styles.ts';
import type { Heightfield } from '../model/load.ts';
import type { Area, Building, Pt, Road, TileModel, Zone } from '../model/types.ts';
import { AREA_RULES, HAND_PLACES, type LatLon, OVERRIDES, type Override, REGIONS, type Region, ZONE_RULES } from './places.ts';
import { type Layer, type Level, LEVELS, type ResolvedProfile, resolve, ruleSource } from './resolve.ts';
import type { BuildingRule, Cover, Mix } from './schema.ts';

export interface ContextOptions {
  /** Layers that take part. The base is always there; with nothing else, everything is the base profile. */
  levels?: Iterable<Level>;
  /** Replace one profile with another wherever it is assigned. */
  swaps?: Record<string, string>;
  /**
   * Where to read the fields that reach too far for a crop to compute: distance to the coast. A context
   * built on a crop passes the whole tile's context here, standing in for a field baked for the region.
   */
  regional?: ProfileContext;
}

interface PlaceSource {
  kind: 'area' | 'hand';
  id: string;
  name: string;
  profile: string;
  ring: Pt[];
  override?: Override;
}

export interface PlaceInfo {
  region?: Region;
  zone?: Zone;
  district?: string;
  place?: PlaceSource;
  cover: Cover;
  coverArea?: Area;
  profile: ResolvedProfile;
}

export interface StyleChoice {
  style: Style;
  rule: BuildingRule;
  ruleFrom: string;
  profile: ResolvedProfile;
}

export type FieldName = 'path' | 'stream' | 'coast' | 'road' | 'slope' | 'relief';

/** Picks a key from a weighted mix with a 0..1 value. */
export function pick(mix: Mix, u: number): string {
  const entries = Object.entries(mix).filter(([, w]) => w > 0);
  let total = 0;
  for (const [, w] of entries) total += w;
  let at = u * total;
  for (const [k, w] of entries) {
    if ((at -= w) < 0) return k;
  }
  return entries[entries.length - 1]?.[0] ?? Object.keys(mix)[0];
}

export function hash01(id: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class ProfileContext {
  readonly model: TileModel;
  readonly ground: Heightfield;
  readonly levels: Set<Level>;
  readonly swaps: Record<string, string>;
  /** 4 m cells for the profile map. */
  readonly grid: Grid;
  /** Every distinct resolved profile in the tile. */
  readonly profiles: ResolvedProfile[] = [];
  readonly places: PlaceSource[] = [];
  readonly regions: (Region & { ring: Pt[] })[];
  /** The resolved profile index of every 4 m cell. */
  readonly cells: Int32Array;
  private readonly regionAt: Int8Array;
  private readonly zoneAt: Int32Array;
  private readonly placeAt: Int32Array;
  private readonly coverAt_: Int32Array;
  private readonly byKey = new Map<string, number>();
  private readonly overrides = new Map<string, Override>();
  private readonly fieldGrid: Grid;
  private readonly fields = new Map<FieldName, Float32Array>();
  private readonly choices = new Map<string, StyleChoice>();
  private readonly regional?: ProfileContext;

  constructor(model: TileModel, ground: Heightfield, opts: ContextOptions = {}) {
    this.model = model;
    this.ground = ground;
    this.levels = new Set(opts.levels ?? []);
    this.levels.add('base');
    this.swaps = opts.swaps ?? {};
    this.regional = opts.regional;
    if (this.levels.has('override')) for (const o of OVERRIDES) this.overrides.set(o.target, o);
    const bounds = boundsOf(model);
    const g = (this.grid = Grid.over(bounds, 4, model.origin));
    this.fieldGrid = Grid.over(bounds, 2, model.origin);
    this.cells = new Int32Array(g.size);
    this.regionAt = new Int8Array(g.size).fill(-1);
    this.zoneAt = new Int32Array(g.size).fill(-1);
    this.placeAt = new Int32Array(g.size).fill(-1);
    this.coverAt_ = new Int32Array(g.size).fill(-1);

    const local = (ll: LatLon[]): Pt[] =>
      ll.map(([lat, lon]) => {
        const [e, n] = toNztm(lat, lon);
        return [e - model.origin.e, n - model.origin.n];
      });
    this.regions = REGIONS.map((r) => ({ ...r, ring: local(r.outline) }));
    if (this.levels.has('region')) this.regions.forEach((r, i) => fillRing(g, r.ring, (c) => (this.regionAt[c] = i)));
    if (this.levels.has('district')) {
      // Zones overlap at their edges and where the coastal marine zone runs over land: the smaller one
      // wins, whatever order the data came in.
      const zones = (model.zones ?? []).map((z, i) => ({ z, i, size: Math.abs(ringArea(z.ring)) }));
      zones.sort((p, q) => q.size - p.size || (p.z.id < q.z.id ? -1 : 1));
      for (const { z, i } of zones) fillRing(g, z.ring, (c) => (this.zoneAt[c] = i));
    }
    // Where mapped areas overlap, the smaller one is the ground cover (a pitch in a park, a wood in a
    // reserve). Filling largest first makes that so whatever order the data came in.
    const bySize = model.areas.map((a, i) => ({ a, i, size: Math.abs(ringArea(a.ring)) }));
    bySize.sort((p, q) => q.size - p.size || (p.a.id < q.a.id ? -1 : 1));
    for (const { a, i } of bySize) fillRing(g, a.ring, (c) => (this.coverAt_[c] = i));

    if (this.levels.has('place')) {
      // Places too: smaller mapped places win over the ones they sit in, and hand-drawn places win over all.
      for (const { a } of bySize) {
        const forced = this.overrides.get(`area:${a.id}`);
        const region = this.regionOf(this.interior(a.ring));
        const rule = AREA_RULES.find((r) => r.kind === a.kind && (!r.name || r.name.test(a.name ?? '')) && (!r.region || r.region === region?.id));
        const profile = forced?.profile ?? rule?.profile;
        if (profile) this.places.push({ kind: 'area', id: a.id, name: a.name ?? a.kind, profile, ring: a.ring, override: forced });
      }
      for (const h of HAND_PLACES) this.places.push({ kind: 'hand', id: h.id, name: h.name, profile: h.profile, ring: local(h.outline) });
      this.places.forEach((p, i) => fillRing(g, p.ring, (c) => (this.placeAt[c] = i)));
    }

    for (let c = 0; c < g.size; c++) this.cells[c] = this.indexFor(this.stackAt(c));
  }

  /** A point inside a ring: its centroid if that is inside, else any cell centre that is. */
  interior(ring: Pt[]): Pt {
    const c = centroid(ring);
    if (pointInRing(c[0], c[1], ring)) return c;
    let found: Pt = ring[0];
    fillRing(this.grid, ring, (i) => (found = this.grid.centre(i)));
    return found;
  }

  private regionOf(p: Pt): Region | undefined {
    return this.levels.has('region') ? this.regions.find((r) => pointInRing(p[0], p[1], r.ring)) : undefined;
  }

  private districtFor(zone: Zone | undefined, region: Region | undefined): string | undefined {
    if (!zone) return undefined;
    const forced = this.overrides.get(`zone:${zone.id}`);
    if (forced?.profile) return forced.profile;
    return ZONE_RULES.find((r) => r.zones.includes(zone.zone) && (!r.region || r.region === region?.id))?.profile;
  }

  private stackAt(c: number): Layer[] {
    const stack: Layer[] = [{ level: 'base', source: 'base', profile: 'auckland' }];
    const region = this.regionAt[c] >= 0 ? this.regions[this.regionAt[c]] : undefined;
    if (region) stack.push({ level: 'region', source: region.id, profile: region.profile });
    const zone = this.zoneAt[c] >= 0 ? this.model.zones![this.zoneAt[c]] : undefined;
    const district = this.districtFor(zone, region);
    if (district) stack.push({ level: 'district', source: zone!.zone, profile: district });
    const place = this.placeAt[c] >= 0 ? this.places[this.placeAt[c]] : undefined;
    if (place) stack.push({ level: 'place', source: place.name, profile: place.profile });
    return stack;
  }

  private indexFor(stack: Layer[]): number {
    const key = stack.map((l) => `${l.level}:${l.profile}`).join('|') + (stack.some((l) => l.patch) ? '#' + stack.map((l) => l.source).join('|') : '');
    let i = this.byKey.get(key);
    if (i === undefined) {
      i = this.profiles.length;
      this.profiles.push(resolve(stack, this.swaps));
      this.byKey.set(key, i);
    }
    return i;
  }

  private cellAt(x: number, y: number): number {
    const g = this.grid;
    const c = g.index(x, y);
    if (c >= 0) return c;
    const cx = Math.max(0, Math.min(g.cols - 1, Math.floor((x - g.x0) / g.cell)));
    const cy = Math.max(0, Math.min(g.rows - 1, Math.floor((y - g.y0) / g.cell)));
    return cy * g.cols + cx;
  }

  indexAt(x: number, y: number): number {
    return this.cells[this.cellAt(x, y)];
  }

  at(x: number, y: number): ResolvedProfile {
    return this.profiles[this.indexAt(x, y)];
  }

  /** The mapped area that is the ground cover here, if any. */
  areaAt(x: number, y: number): Area | undefined {
    const a = this.coverAt_[this.cellAt(x, y)];
    return a < 0 ? undefined : this.model.areas[a];
  }

  coverAt(x: number, y: number): Cover {
    const a = this.coverAt_[this.cellAt(x, y)];
    return a < 0 ? 'open' : this.model.areas[a].kind;
  }

  describe(x: number, y: number): PlaceInfo {
    const c = this.cellAt(x, y);
    const region = this.regionAt[c] >= 0 ? this.regions[this.regionAt[c]] : undefined;
    const zone = this.zoneAt[c] >= 0 ? this.model.zones![this.zoneAt[c]] : undefined;
    const a = this.coverAt_[c];
    return {
      region,
      zone,
      district: this.districtFor(zone, region),
      place: this.placeAt[c] >= 0 ? this.places[this.placeAt[c]] : undefined,
      cover: a < 0 ? 'open' : this.model.areas[a].kind,
      coverArea: a < 0 ? undefined : this.model.areas[a],
      profile: this.profiles[this.cells[c]],
    };
  }

  /** The resolved profiles found anywhere in a rectangle. */
  profilesIn(b: Bounds): number[] {
    const g = this.grid;
    const found = new Set<number>();
    const [c0, c1] = [Math.max(0, Math.floor((b.x0 - g.x0) / g.cell)), Math.min(g.cols - 1, Math.floor((b.x1 - g.x0) / g.cell))];
    const [r0, r1] = [Math.max(0, Math.floor((b.y0 - g.y0) / g.cell)), Math.min(g.rows - 1, Math.floor((b.y1 - g.y0) / g.cell))];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) found.add(this.cells[r * g.cols + c]);
    return [...found];
  }

  /** A thing's own stack: the stack where it stands, plus any override pinned to its id. */
  private withOverride(x: number, y: number, target: string): ResolvedProfile {
    const o = this.overrides.get(target);
    if (!o) return this.at(x, y);
    const stack = [...this.at(x, y).stack, { level: 'override' as const, source: o.note, profile: o.profile, patch: o.patch }];
    return resolve(stack, this.swaps);
  }

  forBuilding(b: Building): ResolvedProfile {
    const [x, y] = centroid(b.ring);
    return this.withOverride(x, y, `building:${b.id}`);
  }

  forRoad(road: Road, at: Pt): ResolvedProfile {
    const name = road.sections.find((s) => s.name)?.name;
    return this.withOverride(at[0], at[1], `road:${name}`);
  }

  overrideFor(target: string): Override | undefined {
    return this.overrides.get(target);
  }

  chooseStyle(b: Building): StyleChoice {
    const hit = this.choices.get(b.id);
    if (hit) return hit;
    const profile = this.forBuilding(b);
    const use = useOf(b.kind);
    const rules = profile.value.buildings.rules;
    const rule =
      rules.find((r) => (!r.use || r.use.includes(use)) && (r.minH === undefined || b.h > r.minH) && (r.maxH === undefined || b.h <= r.maxH)) ?? rules[rules.length - 1];
    const name = pick(rule.style, hash01(b.id, 7));
    const base = styleByName(name);
    const palette = profile.value.buildings.palettes[name];
    const style = palette ? { ...base, ...palette } : base;
    const choice = { style, rule, ruleFrom: ruleSource.get(rule) ?? '?', profile };
    this.choices.set(b.id, choice);
    return choice;
  }

  readonly styleOf = (b: Building): Style => this.chooseStyle(b).style;

  // Terrain fields, built on first use.

  field(name: FieldName): Float32Array {
    let f = this.fields.get(name);
    if (f) return f;
    const g = this.fieldGrid;
    const m = this.model;
    const mask = new Uint8Array(g.size);
    if (name === 'path') for (const p of m.paths) if (p.level === 0) strokeLine(g, p.pts, 0.5, mask);
    if (name === 'stream') {
      for (const s of m.streams ?? []) strokeLine(g, s.pts, s.kind === 'river' ? 3 : 1, mask);
      for (const a of m.areas) if (a.kind === 'water') fillRing(g, a.ring, (c) => (mask[c] = 1));
    }
    if (name === 'road') for (const r of m.roads) strokeLine(g, r.pts, ((r.sections[0].lanesF + r.sections[0].lanesB) * 3.4) / 2, mask);
    if (name === 'coast' && m.sea) for (let c = 0; c < g.size; c++) mask[c] = this.ground.at(...g.centre(c)) < 0.3 ? 1 : 0;
    if (name === 'slope' || name === 'relief') {
      const h = new Float32Array(g.size);
      for (let c = 0; c < g.size; c++) h[c] = this.ground.at(...g.centre(c));
      if (name === 'relief') {
        const blur = boxBlur(g, h, 30);
        f = h.map((v, i) => v - blur[i]);
      } else {
        f = new Float32Array(g.size);
        for (let c = 0; c < g.size; c++) {
          const [x, y] = g.centre(c);
          const dx = (this.ground.at(x + 2, y) - this.ground.at(x - 2, y)) / 4;
          const dy = (this.ground.at(x, y + 2) - this.ground.at(x, y - 2)) / 4;
          f[c] = (Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI;
        }
      }
    } else {
      f = distanceField(g, mask);
    }
    this.fields.set(name, f);
    return f;
  }

  sample(name: FieldName, x: number, y: number): number {
    if (name === 'coast' && this.regional) return this.regional.sample(name, x, y);
    return this.fieldGrid.sample(this.field(name), x, y);
  }

  /** Unit vector pointing toward the nearest path. */
  towardPath(x: number, y: number): Pt {
    const dx = this.sample('path', x + 1.5, y) - this.sample('path', x - 1.5, y);
    const dy = this.sample('path', x, y + 1.5) - this.sample('path', x, y - 1.5);
    const l = Math.hypot(dx, dy) || 1;
    return [-dx / l, -dy / l];
  }
}

/** Everything is the base profile: what the look and buildings labs use. */
export function baseContext(model: TileModel, ground: Heightfield): ProfileContext {
  return new ProfileContext(model, ground, { levels: [] });
}

export { LEVELS };
