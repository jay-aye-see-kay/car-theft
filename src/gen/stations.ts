// Cross-sections along the built part of a track, for everything that is laid out across a road.
import type { P3 } from './junctions.ts';
import { type Track, deckDepth, sampleAt } from './tracks.ts';

export interface Station {
  x: number;
  y: number;
  h: number;
  /** Left-hand normal. */
  nx: number;
  ny: number;
  wF: number;
  wB: number;
  level: number;
  /** Room for a footpath or verge on the left and on the right. */
  room: [number, number];
  /** Depth of the deck here, if this is on a structure. */
  deck: number;
}

/** A station at every sample between the junction cuts, and one at each cut. */
export function stations(t: Track): Station[] {
  const from = t.cutA;
  const to = t.length - t.cutB;
  if (to - from < 0.2) return [];
  const at = [from];
  for (let i = 0; i < t.n; i++) if (t.s[i] > from + 0.5 && t.s[i] < to - 0.5) at.push(t.s[i]);
  at.push(to);
  return at.map((s) => {
    const c = sampleAt(t, s);
    const d = Math.hypot(c.tx, c.ty) || 1;
    // A station counts as elevated only if both samples around it are, so decks end cleanly on the ground.
    const level = t.level[c.i] !== 0 && t.level[c.i + 1] !== 0 ? t.level[c.i] : 0;
    const u = Math.min(1, Math.max(0, (s - t.s[c.i]) / (t.s[c.i + 1] - t.s[c.i] || 1)));
    const room = (side: 0 | 1): number => t.room[side][c.i] + (t.room[side][c.i + 1] - t.room[side][c.i]) * u;
    const deck = Math.min(deckDepth(t, c.i), deckDepth(t, Math.min(t.n - 1, c.i + 1)));
    return { x: c.x, y: c.y, h: c.h, nx: -c.ty / d, ny: c.tx / d, wF: c.wF, wB: c.wB, level, room: [room(0), room(1)], deck };
  });
}

export const offset = (st: Station, lateral: number, dh = 0): P3 => ({ x: st.x + st.nx * lateral, y: st.y + st.ny * lateral, h: st.h + dh });

/** Half the width of the paved carriageway at a station, shoulders included. */
export const carriageway = (t: Track, st: Station): number => (st.wF + st.wB) / 2 + t.shoulder;
