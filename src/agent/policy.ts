// What a keen but literal player does next in a mission: head for the goal
// (or the nearest prop it hasn't just been to), in a car if the mission says
// so or it's far, on foot if the prop only counts on foot, in a boat if it
// says boat; stop at props if the mission's words say stop, else go through.
// Shared by the paper playtest (scripts/agent/paper.ts, no browser) and the
// `play` bot (scripts/agent/commands.ts, the real game), so the two can be
// compared. It reads only what the player sees: objective, subtitles, goals.

export type Mode = 'foot' | 'car' | 'boat';

export interface PolicyView {
  objective: string;
  /** Everything the mission has said so far. */
  said: readonly string[];
  target: { x: number; z: number; label?: string } | null;
  props: readonly { x: number; z: number; radius: number; onFoot?: boolean; carried: boolean }[];
}

export interface Decision {
  /** How to get about: change to this first. */
  want: Mode;
  goal: { x: number; z: number; label: string } | null;
  /** The goal is a prop: drive through it unless `stop`. */
  prop: { radius: number } | null;
  stop: boolean;
}

/** Further than this on foot: find a car, m. */
const WALK = 120;
/** Don't go back to a prop for this long after being on it, s. */
const REVISIT = 30;

export class MissionPolicy {
  private readonly visited = new Map<string, number>();

  /** Give up on a prop for a while (can't get to it): go for others first. */
  skip(q: { x: number; z: number }, clock: number): void {
    this.visited.set(`${Math.round(q.x)},${Math.round(q.z)}`, clock);
  }

  decide(v: PolicyView, me: { x: number; z: number; mode: Mode }, clock: number): Decision {
    const key = (q: { x: number; z: number }) => `${Math.round(q.x)},${Math.round(q.z)}`;
    for (const q of v.props) if (Math.hypot(q.x - me.x, q.z - me.z) < q.radius) this.visited.set(key(q), clock);
    const fresh = (q: { x: number; z: number }) => clock - (this.visited.get(key(q)) ?? -Infinity) >= REVISIT;
    const d = (q: { x: number; z: number }) => Math.hypot(q.x - me.x, q.z - me.z);
    const props = v.props.filter((q) => !q.carried).sort((a, b) => Number(fresh(b)) - Number(fresh(a)) || d(a) - d(b));
    const prop = v.target ? null : (props[0] ?? null);
    const goal = v.target ? { x: v.target.x, z: v.target.z, label: v.target.label || 'the goal' } : prop ? { x: prop.x, z: prop.z, label: 'a prop' } : null;
    const far = goal ? d(goal) : 0;
    const want: Mode = /boat/i.test(v.objective) ? 'boat'
      : prop?.onFoot === true ? 'foot'
      : prop?.onFoot === false || /\b(car|drive|wheels|cab)\b/i.test(v.objective) ? 'car'
      : me.mode === 'foot' && far > WALK ? 'car' : me.mode;
    // Read what it asks, as a player would: stop at them, or go through?
    const stop = /\b(stop|pull up|serve|wait|hold)\b/i.test(`${v.objective} ${v.said.join(' ')}`);
    return { want, goal, prop: prop && { radius: prop.radius }, stop };
  }
}
