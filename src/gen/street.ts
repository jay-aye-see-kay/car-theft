// Street furniture by placement rules: lamps, street trees, signals, benches and bins.
// Nothing here is in the map. Each rule reads the road's class, width and junctions, and the
// profile of the place the road runs through, and decides what a street of that kind would have
// there. Positions are measured from the road's own start so they come out the same every time.
import type { JunctionShape } from './junctions.ts';
import { hashOf } from './facade.ts';
import { outranks } from './roadIndex.ts';
import { type RoadParams, type Track, sampleAt } from './tracks.ts';
import type { ProfileContext } from '../profile/context.ts';
import { pick } from '../profile/context.ts';
import type { Tone } from '../profile/schema.ts';

export interface Prop {
  /** A kit name: 'lamp', 'mast', 'lamp.heritage', 'signal', a tree kit, 'bench', 'bin'. */
  kind: string;
  x: number;
  y: number;
  h: number;
  /** Direction the prop faces, as an angle in tile space (anticlockwise from east). */
  yaw: number;
  size: number;
  /** 0..1, for colour variation. */
  tint: number;
  tone?: Tone;
}

const unit = (n: number): number => (n % 1000) / 1000;

export function furnishStreets(
  tracks: Iterable<Track>,
  junctions: JunctionShape[],
  p: RoadParams,
  /** True where a prop would stand inside a building. */
  blocked: (x: number, y: number) => boolean,
  ctx: ProfileContext,
): Prop[] {
  const props: Prop[] = [];

  /**
   * A point `lateral` metres left of the road's edge at distance `s`, or nothing if that spot will not do:
   * in a building, in a tunnel, or with less than `needs` metres before the next carriageway.
   */
  const spot = (t: Track, s: number, lateral: number, allowDeck: boolean, needs = 1.2) => {
    const c = sampleAt(t, s);
    const level = Math.max(t.level[c.i], t.level[Math.min(t.n - 1, c.i + 1)]);
    const low = Math.min(t.level[c.i], t.level[Math.min(t.n - 1, c.i + 1)]);
    if (low < 0 || (level > 0 && !allowDeck)) return undefined;
    const d = Math.hypot(c.tx, c.ty) || 1;
    const half = (c.wF + c.wB) / 2 + t.shoulder;
    const side = Math.sign(lateral);
    const room = t.room[side > 0 ? 0 : 1];
    if (Math.min(room[c.i], room[Math.min(t.n - 1, c.i + 1)]) < needs) return undefined;
    const off = side * (half + Math.abs(lateral));
    const x = c.x - (c.ty / d) * off;
    const y = c.y + (c.tx / d) * off;
    if (blocked(x, y)) return undefined;
    // Facing the carriageway.
    return { x, y, h: c.h + (t.road.footpath ? p.kerbHeight : 0), yaw: Math.atan2((c.tx / d) * -side, (-c.ty / d) * -side) };
  };

  const all = [...tracks];
  const lamps: { t: Track; prop: Prop }[] = [];

  for (const t of all) {
    const from = t.cutA + 5;
    const to = t.length - t.cutB - 5;
    const run = to - from;
    if (run < 18) continue;
    const hash = hashOf(t.road.id);
    const major = t.cls === 'motorway' || t.cls === 'ramp';
    const mid = sampleAt(t, (from + to) / 2);
    const street = ctx.forRoad(t.road, [mid.x, mid.y]).value.street;

    // Lamps: evenly spaced over the run so the first and last sit the same distance from their junctions.
    // Motorways keep their masts whatever the place; elsewhere the place decides the lamp, or none.
    const lampKind = major ? 'mast' : street.lamp === 'heritage' ? 'lamp.heritage' : street.lamp === 'none' ? '' : 'lamp';
    const lampAt: number[] = [];
    if (lampKind) {
      const every = street.lampEvery[t.cls];
      const sidesRule = street.lampSides[t.cls];
      const count = Math.max(1, Math.round(run / every));
      for (let k = 0; k < count; k++) {
        const s = from + ((k + 0.5) / count) * run;
        // A one-way road keeps its lamps on the left of travel; the divided road's other half lights the other side.
        // Where the left is hard against another carriageway the lamp crosses to the right, or is left out.
        const wide = mid.wF + mid.wB > t.laneWidth * 2.5;
        const sides = sidesRule === 'both' && wide ? [[1], [-1]] : sidesRule !== 'left' ? [[k % 2 ? 1 : -1]] : [[1, -1]];
        for (const choice of sides) {
          for (const side of choice) {
            const at = spot(t, s, side * 0.55, true, major ? p.footpathWidth - 0.05 : 1.2);
            if (!at) continue;
            lamps.push({ t, prop: { kind: lampKind, ...at, size: major ? 1.45 : t.cls === 'lane' ? 0.8 : 1, tint: 0 } });
            lampAt.push(s);
            break;
          }
        }
      }
    }

    // Street trees: some streets have none, some a few, some an avenue. The street decides, not the tree.
    const busy = (s: number) => lampAt.some((l) => Math.abs(l - s) < 3.5);
    if (!major && t.cls !== 'lane' && t.road.footpath) {
      const name = t.road.sections[0].name;
      const character = unit(name ? hashOf(name) : hash);
      const trees = street.trees;
      const mix = trees.mix;
      const total = mix.none + mix.some + mix.avenue || 1;
      const every = character < mix.none / total ? 0 : character < (mix.none + mix.some) / total ? trees.spacing.some : trees.spacing.avenue;
      if (every) {
        const n = Math.floor(run / every);
        const kit = pick(trees.kit, unit(Math.imul(hash, 2246822519) >>> 4));
        for (let k = 0; k < n; k++) {
          const s = from + ((k + 0.5) / n) * run;
          if (busy(s)) continue;
          for (const side of [1, -1]) {
            const r = unit(Math.imul(hash + k * 7919 + (side > 0 ? 13 : 31), 2654435761) >>> 8);
            // A gap now and then: a driveway, a dead tree, a bus stop.
            if (r < 0.18) continue;
            const at = spot(t, s + (r - 0.5) * 2.5, side * 0.95, false);
            // The crown needs room too: skip where a wall stands right behind the trunk.
            if (!at || blocked(at.x - Math.cos(at.yaw) * 1.6, at.y - Math.sin(at.yaw) * 1.6)) continue;
            const size = trees.size[0] + (trees.size[1] - trees.size[0]) * ((r - 0.18) / 0.82);
            props.push({ kind: kit, ...at, size, tint: unit(Math.imul(hash + k, 40503) >>> 4), tone: trees.tone });
          }
        }
      }
    }

    // Benches and bins: on footpaths of the classes the place says, between the lamps and trees.
    if (!major && t.road.footpath) {
      street.extras.forEach((extra, ei) => {
        if (!extra.classes.includes(t.cls)) return;
        const n = Math.floor(run / extra.every);
        for (let k = 0; k < n; k++) {
          const s = from + ((k + 0.5) / n) * run + (ei * 5 - 2.5);
          if (busy(s)) continue;
          const side = (k + ei) % 2 ? 1 : -1;
          const at = spot(t, s, side * 0.4, false);
          if (at) props.push({ kind: extra.kit, ...at, size: 1, tint: 0 });
        }
      });
    }
  }

  // Roads that run together would each bring their own row of lamps. Where two rows crowd each other
  // the lesser road's lamp goes; the other row lights both.
  for (const l of lamps) {
    const crowd = l.prop.kind === 'mast' ? 16 : 9;
    if (!lamps.some((o) => o.t !== l.t && outranks(o.t, l.t) && Math.hypot(o.prop.x - l.prop.x, o.prop.y - l.prop.y) < crowd)) props.push(l.prop);
  }

  // Signals: where traffic can leave three or more ways and at least two of the arms are main roads.
  for (const j of junctions) {
    if (j.status === 'merge' || j.groups < 3) continue;
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
