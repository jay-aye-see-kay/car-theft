// Which roads are near a point, and which of two overlapping roads gives way.
//
// The map draws every carriageway as its own line, so a slip lane, the two halves of a divided road
// and the arms of a merge all run beside or on top of one another. Wherever that happens one of them
// has to yield: its lines stop, its surface follows the other's, its footpath makes room.
import type { RoadClass } from '../model/types.ts';
import { type RoadParams, type Track, halfWidth } from './tracks.ts';

const CLASS_RANK: Record<RoadClass, number> = { motorway: 6, arterial: 5, collector: 4, street: 3, ramp: 2, lane: 1 };

/** True if `a` keeps its lines and surface where it overlaps `b`. Never a tie. */
export function outranks(a: Track, b: Track): boolean {
  const [ra, rb] = [CLASS_RANK[a.cls], CLASS_RANK[b.cls]];
  if (ra !== rb) return ra > rb;
  const [wa, wb] = [a.wF[a.n >> 1] + a.wB[a.n >> 1], b.wF[b.n >> 1] + b.wB[b.n >> 1]];
  if (wa !== wb) return wa > wb;
  return a.road.id < b.road.id;
}

export interface Sample {
  t: Track;
  i: number;
}

const CELL = 16;

export class RoadIndex {
  private grid = new Map<number, Sample[]>();

  constructor(tracks: Iterable<Track>) {
    for (const t of tracks) {
      for (let i = 0; i < t.n; i++) {
        const k = this.key(t.x[i], t.y[i]);
        let list = this.grid.get(k);
        if (!list) this.grid.set(k, (list = []));
        list.push({ t, i });
      }
    }
  }

  private key(x: number, y: number): number {
    return Math.floor(x / CELL) * 8192 + Math.floor(y / CELL);
  }

  /** Every sample within a cell of the point: all of those within 16 m, and some beyond. */
  near(x: number, y: number): Sample[] {
    const found: Sample[] = [];
    for (let dx = -CELL; dx <= CELL; dx += CELL) for (let dy = -CELL; dy <= CELL; dy += CELL) found.push(...(this.grid.get(this.key(x + dx, y + dy)) ?? []));
    return found;
  }

  /**
   * Whether the point lies on the lanes of a road other than `self`, at about the same height.
   * With `yielding`, only roads that outrank `self` count.
   */
  covered(self: Track, x: number, y: number, h: number, margin: number, yielding: boolean): boolean {
    for (const { t, i } of this.near(x, y)) {
      if (t === self || Math.abs(t.h[i] - h) > 2) continue;
      const reach = (t.wF[i] + t.wB[i]) / 2 + margin;
      if (Math.abs(t.x[i] - x) > reach + 3 || Math.abs(t.y[i] - y) > reach + 3) continue;
      if (yielding && !outranks(t, self)) continue;
      if (distanceToTrack(t, i, x, y) < reach) return true;
    }
    return false;
  }
}

/** Distance from a point to the track's centreline, looking only at the two segments around sample `i`. */
export function distanceToTrack(t: Track, i: number, x: number, y: number): number {
  let best = Infinity;
  for (const a of [i - 1, i]) {
    if (a < 0 || a + 1 >= t.n) continue;
    const [ax, ay, bx, by] = [t.x[a], t.y[a], t.x[a + 1], t.y[a + 1]];
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
    const u = Math.min(1, Math.max(0, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2));
    best = Math.min(best, Math.hypot(x - (ax + (bx - ax) * u), y - (ay + (by - ay) * u)));
  }
  return best;
}

/**
 * How much room each side of each road has before the next carriageway, capped at a footpath's width.
 * A road whose neighbour touches it has none on that side. Where two roads run close together the
 * footpath of each reaches only as far as the other, so the strip between them is one paved median.
 */
export function measureSides(tracks: Iterable<Track>, p: RoadParams): void {
  const all = [...tracks];
  const index = new RoadIndex(all);
  const full = p.footpathWidth;
  for (const t of all) {
    const room: [Float32Array, Float32Array] = [new Float32Array(t.n).fill(full), new Float32Array(t.n).fill(full)];
    for (let i = 0; i < t.n; i++) {
      const half = halfWidth(t, i);
      for (const o of index.near(t.x[i], t.y[i])) {
        if (o.t === t || Math.abs(o.t.h[o.i] - t.h[i]) > 3) continue;
        const [vx, vy] = [o.t.x[o.i] - t.x[i], o.t.y[o.i] - t.y[i]];
        if (Math.abs(vx * t.tx[i] + vy * t.ty[i]) > 2.5) continue;
        const lateral = -vx * t.ty[i] + vy * t.tx[i];
        const along = Math.abs(t.tx[i] * o.t.tx[o.i] + t.ty[i] * o.t.ty[o.i]);
        // A road that crosses or ends against this one only breaks the footpath where it meets it, and
        // the shared pavement cuts that gap itself.
        if (along < 0.5) continue;
        const theirs = halfWidth(o.t, o.i) / along;
        // A narrower road lying wholly within this one takes nothing from its edges.
        if (Math.abs(lateral) + theirs <= half) continue;
        const gap = Math.abs(lateral) - half - theirs;
        const side = lateral > 0 ? 0 : 1;
        room[side][i] = Math.min(room[side][i], Math.max(0, gap));
      }
    }
    t.room = room;
  }
}
