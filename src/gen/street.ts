// Street furniture by placement rules: lamps, street trees and traffic signals.
// Nothing here is in the map. Each rule reads the road's class, width and junctions and decides
// what a street of that kind would have; positions are measured from the road's own start so
// they come out the same every time.
import type { JunctionShape } from './junctions.ts';
import { hashOf } from './facade.ts';
import { type RoadParams, type Track, sampleAt } from './tracks.ts';
import type { RoadClass } from '../model/types.ts';

export interface Prop {
  kind: 'lamp' | 'mast' | 'signal' | 'tree';
  x: number;
  y: number;
  h: number;
  /** Direction the prop faces, as an angle in tile space (anticlockwise from east). */
  yaw: number;
  size: number;
  /** 0..1, for colour variation. */
  tint: number;
}

/** Metres between lamps and which sides get them, by class. */
const LAMPS: Record<RoadClass, { every: number; sides: 'both' | 'alternate' | 'left' }> = {
  motorway: { every: 55, sides: 'left' },
  ramp: { every: 42, sides: 'left' },
  arterial: { every: 34, sides: 'both' },
  collector: { every: 30, sides: 'alternate' },
  street: { every: 34, sides: 'alternate' },
  lane: { every: 40, sides: 'left' },
};

const unit = (n: number): number => (n % 1000) / 1000;

export function furnishStreets(
  tracks: Iterable<Track>,
  junctions: JunctionShape[],
  p: RoadParams,
  /** True where a prop would stand inside a building. */
  blocked: (x: number, y: number) => boolean,
): Prop[] {
  const props: Prop[] = [];

  /** A point `lateral` metres left of the centreline at distance `s`, or nothing if that spot will not do. */
  const spot = (t: Track, s: number, lateral: number, allowDeck: boolean) => {
    const c = sampleAt(t, s);
    const level = Math.max(t.level[c.i], t.level[Math.min(t.n - 1, c.i + 1)]);
    const low = Math.min(t.level[c.i], t.level[Math.min(t.n - 1, c.i + 1)]);
    if (low < 0 || (level > 0 && !allowDeck)) return undefined;
    const d = Math.hypot(c.tx, c.ty) || 1;
    const half = (c.wF + c.wB) / 2 + t.shoulder;
    const side = Math.sign(lateral);
    const off = side * (half + Math.abs(lateral));
    const x = c.x - (c.ty / d) * off;
    const y = c.y + (c.tx / d) * off;
    if (blocked(x, y)) return undefined;
    // Facing the carriageway.
    return { x, y, h: c.h + (t.road.footpath ? p.kerbHeight : 0), yaw: Math.atan2((c.tx / d) * -side, (-c.ty / d) * -side) };
  };

  for (const t of tracks) {
    const from = t.cutA + 5;
    const to = t.length - t.cutB - 5;
    const run = to - from;
    if (run < 18) continue;
    const hash = hashOf(t.road.id);
    const major = t.cls === 'motorway' || t.cls === 'ramp';

    // Lamps: evenly spaced over the run so the first and last sit the same distance from their junctions.
    const rule = LAMPS[t.cls];
    const count = Math.max(1, Math.round(run / rule.every));
    const lampAt: number[] = [];
    for (let k = 0; k < count; k++) {
      const s = from + ((k + 0.5) / count) * run;
      const sides = rule.sides === 'both' ? [1, -1] : rule.sides === 'alternate' ? [k % 2 ? 1 : -1] : [1];
      for (const side of sides) {
        // A one-way road keeps its lamps on the left of travel; the divided road's other half lights the other side.
        const at = spot(t, s, side * 0.55, true);
        if (!at) continue;
        props.push({ kind: major ? 'mast' : 'lamp', ...at, size: major ? 1.45 : t.cls === 'lane' ? 0.8 : 1, tint: 0 });
        lampAt.push(s);
      }
    }

    // Street trees: some streets have none, some a few, some an avenue. The street decides, not the tree.
    if (!major && t.cls !== 'lane' && t.road.footpath) {
      const name = t.road.sections[0].name;
      const character = unit(name ? hashOf(name) : hash);
      const every = character < 0.3 ? 0 : character < 0.72 ? 17 : 11;
      if (every) {
        const n = Math.floor(run / every);
        for (let k = 0; k < n; k++) {
          const s = from + ((k + 0.5) / n) * run;
          if (lampAt.some((l) => Math.abs(l - s) < 3.5)) continue;
          for (const side of [1, -1]) {
            const r = unit(Math.imul(hash + k * 7919 + (side > 0 ? 13 : 31), 2654435761) >>> 8);
            // A gap now and then: a driveway, a dead tree, a bus stop.
            if (r < 0.18) continue;
            const at = spot(t, s + (r - 0.5) * 2.5, side * 0.95, false);
            // The crown needs room too: skip where a wall stands right behind the trunk.
            if (!at || blocked(at.x - Math.cos(at.yaw) * 1.6, at.y - Math.sin(at.yaw) * 1.6)) continue;
            props.push({ kind: 'tree', ...at, size: 0.5 + r * 0.28, tint: unit(Math.imul(hash + k, 40503) >>> 4) });
          }
        }
      }
    }
  }

  // Signals: where three or more arms meet and at least two of them are main roads.
  for (const j of junctions) {
    if (j.status === 'merge' || j.mouths.length < 3) continue;
    const classes = j.mouths.map((m) => m.track.cls);
    if (classes.includes('motorway') || classes.filter((c) => c === 'arterial' || c === 'collector').length < 2) continue;
    for (const { track: t, end } of j.mouths) {
      if (t.length - t.cutA - t.cutB < 10) continue;
      const sec = end === 'a' ? t.road.sections[0] : t.road.sections[t.road.sections.length - 1];
      // Only arms that bring traffic in get a signal; it stands on the left of that traffic, at the stop line.
      if ((end === 'a' ? sec.lanesB : sec.lanesF) === 0) continue;
      const s = end === 'a' ? t.cutA + 0.6 : t.length - t.cutB - 0.6;
      const at = spot(t, s, (end === 'a' ? -1 : 1) * 0.5, true);
      if (!at) continue;
      const c = sampleAt(t, s);
      const away = end === 'a' ? 1 : -1;
      props.push({ kind: 'signal', ...at, yaw: Math.atan2(c.ty * away, c.tx * away), size: 1, tint: 0 });
    }
  }
  return props;
}
