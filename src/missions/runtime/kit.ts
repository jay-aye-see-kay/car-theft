import type { BoardRow, MissionPlayer } from './mission.ts';
import type { Place } from './places.ts';

// Small helpers mission scripts share: distances, hot/cold readings, spots
// of their own (out on a lawn, not in the gazetteer), colours per player.

export type XZ = { readonly x: number; readonly z: number };

export const dist = (a: XZ, b: XZ) => Math.hypot(a.x - b.x, a.z - b.z);

/** A spot of a mission's own, as a Place (for goTo, race and start markers). */
export const spot = (id: string, name: string, x: number, z: number): Place => ({ id, name, kind: 'spot', street: '', x, z, at: { x, z } });

/** Hot/cold bands for sensors: within this far, the word and its colour. */
const BANDS: [number, string, string][] = [
  [8, 'right here!', '#ff2d2d'],
  [20, 'hot!', '#ff5a3c'],
  [45, 'warm', '#ffa040'],
  [90, 'cool', '#bfe6ff'],
  [Infinity, 'cold', '#7fb8ff'],
];

export const hotCold = (d: number): { word: string; colour: string } => {
  const [, word, colour] = BANDS.find(([m]) => d < m) ?? BANDS[BANDS.length - 1];
  return { word, colour };
};

/** Colours for players in party games, by place in the room. */
export const PLAYER_COLOURS = ['#ffd23d', '#5fd3ff', '#ff6fb5', '#8dff6a', '#c79bff', '#ff9b4a'];

/** The nearest of `among` to `at`, and how far. */
export function nearestOf<T extends XZ>(at: XZ, among: readonly T[]): { it: T | null; d: number } {
  let it: T | null = null;
  let d = Infinity;
  for (const a of among) {
    const k = dist(a, at);
    if (k < d) [d, it] = [k, a];
  }
  return { it, d };
}

/** Scores as board rows, best first: "Name  12 s". */
export function scoreRows(players: readonly MissionPlayer[], score: (p: MissionPlayer) => number, unit = '', lowFirst = false): BoardRow[] {
  return [...players]
    .sort((a, b) => (lowFirst ? score(a) - score(b) : score(b) - score(a)))
    .map((p) => ({ text: p.name, note: `${Math.round(score(p))}${unit}`, colour: PLAYER_COLOURS[players.indexOf(p) % PLAYER_COLOURS.length] }));
}

/** Points along a polyline every `every` metres (skipping the first `skip`), with the direction there. */
export function along(points: readonly XZ[], every: number, skip = 0): { x: number; z: number; dx: number; dz: number }[] {
  const out: { x: number; z: number; dx: number; dz: number }[] = [];
  let next = skip;
  let run = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = dist(a, b);
    if (len < 1e-6) continue;
    while (next <= run + len) {
      const t = (next - run) / len;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dx: (b.x - a.x) / len, dz: (b.z - a.z) / len });
      next += every;
    }
    run += len;
  }
  return out;
}

/** Steps a point towards another at `speed` m/s for `dt` s; whether it got there. */
export function stepTowards(p: { x: number; z: number }, to: XZ, speed: number, dt: number): boolean {
  const d = dist(p, to);
  if (d <= speed * dt) {
    p.x = to.x;
    p.z = to.z;
    return true;
  }
  p.x += ((to.x - p.x) / d) * speed * dt;
  p.z += ((to.z - p.z) / d) * speed * dt;
  return false;
}

/** Shuffled copy, with the mission's seeded random. */
export function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Runs `fn` every `seconds` (game time) alongside the script until the
 * mission ends, with the game seconds since the last call. For boards,
 * chasers and anything that moves. A bug in `fn` still ends the mission.
 */
export function every(m: { wait(s: number): Promise<void>; readonly elapsed: number; fail(message: string): never }, seconds: number, fn: (dt: number) => void): void {
  let last = m.elapsed;
  const loop = async () => {
    for (;;) {
      await m.wait(seconds);
      const now = m.elapsed;
      fn(now - last);
      last = now;
    }
  };
  loop().catch((e) => {
    if (e instanceof Error && e.message === 'mission over') return;
    console.error('mission loop:', e);
    try {
      m.fail('The mission broke. Blame the writer.');
    } catch {
      // it's over either way
    }
  });
}
