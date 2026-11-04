// Missions played on paper: every mission script, in Node, against a ghost
// player on the road graph. No browser, no physics, no traffic: just "a player
// who heads straight for each goal at this speed", in a second or two for the
// lot. What it answers: can each mission be finished by going where it says,
// and with how much time to spare at a careful, typical or flat-out pace?
// What it can't: anything about handling, crashes, cops or people (play those
// with `npm run play`). See docs/AGENT-PLAYTEST.md.
//
//   npm run playtest [-- mission-id ...] [--pace=careful,typical,fast] [--verbose]
import { readdirSync, readFileSync } from 'node:fs';
import { RoadGraph } from '../../src/city/road-graph.ts';
import { Gazetteer } from '../../src/missions/runtime/places.ts';
import { MissionRunner } from '../../src/missions/runtime/runner.ts';
import type { Mission } from '../../src/missions/runtime/mission.ts';
import { AUTOPILOT, PathFollower, type PathPoint } from '../../src/agent/autopilot.ts';
import { routePath } from '../../src/agent/pilot.ts';
import { MissionPolicy, type Mode } from '../../src/agent/policy.ts';

const DATA = new URL('../../public/city/cbd/', import.meta.url);
const MISSION_DIR = new URL('../../src/missions/', import.meta.url);
const DT = 1 / 30;
/** As main.ts: microtask hops a script gets after each tick. */
const SCRIPT_HOPS = 8;
/** Running, m/s (src/player.ts MOVE.sprint). */
const SPRINT = 7.2;

/** How the ghost drives: top speed, and how long finding a car takes when it needs one. */
const PACES = {
  careful: { kmh: 40, carDelay: 10, lateral: 4 },
  typical: { kmh: 60, carDelay: 6, lateral: 5.5 },
  fast: { kmh: 90, carDelay: 4, lateral: 7 },
} as const;
type Pace = keyof typeof PACES;

const args = process.argv.slice(2);
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const verbose = args.includes('--verbose');
const only = args.filter((a) => !a.startsWith('--'));
const paces = (opt('pace')?.split(',') ?? Object.keys(PACES)) as Pace[];

const roads = new RoadGraph(JSON.parse(readFileSync(new URL('roadgraph.json', DATA), 'utf8')));
const places = new Gazetteer(JSON.parse(readFileSync(new URL('places.json', DATA), 'utf8')));
const missions: Mission[] = [];
for (const f of readdirSync(MISSION_DIR).filter((f) => f.endsWith('.ts') && f !== 'index.ts').sort()) {
  missions.push((await import(new URL(f, MISSION_DIR).href)).default);
}

interface Result {
  id: string;
  pace: Pace;
  result: 'passed' | 'failed' | 'timeout' | 'skipped' | 'crashed';
  time: number;
  /** Seconds left on a countdown when it ended, or null. */
  spare: number | null;
  message: string;
  /** Distance covered, m, and how much of it driving. */
  metres: number;
  driven: number;
  log: string[];
}

/** A car with no tyres to speak of: accelerates, brakes, and turns as the autopilot asks. */
class PaperCar {
  x: number;
  z: number;
  heading: number;
  speed = 0;
  constructor(x: number, z: number, heading: number) {
    this.x = x;
    this.z = z;
    this.heading = heading;
  }
  step(c: { throttle: number; brake: number; steer: number }, dt: number) {
    // Roughly the real car (npm run sim): ~3.5 m/s² off the line, fading towards top speed; brakes ~8.
    const accel = c.throttle * 4.2 * Math.max(0, 1 - this.speed / AUTOPILOT.topSpeed) - c.brake * 8 * Math.sign(this.speed);
    this.speed = Math.max(this.speed > 0 ? 0 : -6, this.speed + accel * dt);
    if (c.brake > 0 && this.speed <= 0.2 && c.throttle === 0) this.speed = Math.max(-4, this.speed - 3 * dt);
    const f = Math.min(Math.abs(this.speed) / AUTOPILOT.topSpeed, 1);
    const lock = AUTOPILOT.maxSteer + (AUTOPILOT.minSteer - AUTOPILOT.maxSteer) * Math.sqrt(f);
    this.heading += (this.speed / AUTOPILOT.wheelbase) * Math.tan(-c.steer * lock) * dt;
    this.x += Math.cos(this.heading) * this.speed * dt;
    this.z -= Math.sin(this.heading) * this.speed * dt;
  }
}

async function play(mission: Mission, pace: Pace, inCar = false): Promise<Result> {
  const p = PACES[pace];
  AUTOPILOT.lateral = p.lateral;
  const log: string[] = [];
  const base = { id: mission.id, pace, spare: null, metres: 0, driven: 0, log };
  if ((mission.players?.min ?? 1) > 1) return { ...base, result: 'skipped', time: 0, message: `needs ${mission.players!.min}+ players` };
  const runner = new MissionRunner(missions, places, () => 0, null, roads);
  const start = typeof mission.start === 'string' ? places.get(mission.start) : mission.start;
  // A step from the marker, on foot (or in a car on the nearest road, for missions that start in one).
  let mode = 'foot' as Mode;
  let car: PaperCar | null = null;
  let x = start.x + 3;
  let z = start.z;
  const intoCar = () => {
    const r = roads.nearest(x, z);
    const pose = r ? roads.pointAt(r.edge, r.s) : { x, z, heading: 0 };
    car = new PaperCar(pose.x, pose.z, pose.heading);
    [x, z, mode] = [car.x, car.z, 'car'];
  };
  if (inCar) intoCar();
  let clock = 0;
  let speed = 0;
  let follower: PathFollower | null = null;
  let goalKey = '';
  /** Seconds spent so far changing how we're getting about (finding a car, a boat, getting out). */
  let changing = 0;
  let lastObjective = '';
  const policy = new MissionPolicy();
  const seen = new Set<string>();
  const tick = async () => {
    runner.tick({ clock, x, y: 0, z, driving: mode !== 'foot', boat: mode === 'boat', speedKmh: Math.abs(speed) * 3.6, crash: 0, id: 0, name: 'You', heat: 0, caught: false, others: [], guest: false });
    for (let k = 0; k < SCRIPT_HOPS; k++) await null;
    clock += DT;
  };
  const say = (s: string) => verbose && log.push(`${(clock - t0).toFixed(1)} ${s}`);
  runner.start(mission.id);
  await tick();
  const t0 = clock;
  let clockLeft: number | null = null;
  while (clock - t0 < 600) {
    const v = runner.view();
    if (v.clock?.down) clockLeft = v.clock.seconds;
    if (!v.active) break;
    if (v.objective !== lastObjective) say(`objective: ${(lastObjective = v.objective)}`);
    for (const q of v.props) {
      const k = `${Math.round(q.x)},${Math.round(q.z)}`;
      if (Math.hypot(q.x - x, q.z - z) < q.radius && !seen.has(k)) {
        seen.add(k);
        say(`at a ${q.style}${q.label ? ` "${q.label}"` : ''} at ${(Math.abs(speed) * 3.6).toFixed(0)} km/h`);
      }
    }
    const { want, goal, prop, stop: stopAtProps } = policy.decide(
      { objective: v.objective, said: runner.spoken, target: v.target, props: v.props.map((q) => ({ ...q, carried: q.carrier !== null })) },
      { x, z, mode },
      clock,
    );
    const far = goal ? Math.hypot(goal.x - x, goal.z - z) : 0;
    if (want !== mode) {
      speed = 0;
      changing += DT;
      const takes = want === 'foot' ? 1 : p.carDelay;
      if (changing >= takes) {
        changing = 0;
        follower = null;
        if (want === 'car') intoCar();
        else mode = want;
        say(want === 'car' ? 'got a car' : want === 'boat' ? 'got a boat' : 'got out');
      }
      await tick();
      continue;
    }
    if (!goal) {
      speed = 0;
      await tick();
      continue;
    }
    // A new goal (or the old one moved): route to it.
    const key = `${Math.round(goal.x / 3)},${Math.round(goal.z / 3)},${mode}`;
    if (key !== goalKey || !follower || follower.status !== 'driving') {
      goalKey = key;
      const from = { x, z };
      const byRoad = mode === 'car' || (mode === 'foot' && far > 60);
      const path: PathPoint[] = byRoad ? routePath(roads, from, goal, mode === 'car', prop && !stopAtProps ? prop.radius * 0.7 : 0) : [from, goal];
      // Through props (cameras, paper boxes want speed); stop at goals.
      follower = new PathFollower(path, (mode === 'boat' ? 40 : p.kmh) / 3.6, prop ? Math.min(2, prop.radius * 0.5) : mode === 'foot' ? 1 : 3, !prop || stopAtProps);
    }
    const before = { x, z };
    if (prop && stopAtProps && follower.status === 'arrived') {
      speed = 0;
      if (car) (car as PaperCar).speed = 0;
      await tick();
      continue;
    }
    if (mode === 'car' && car) {
      const c: PaperCar = car;
      c.step(follower.drive({ x: c.x, z: c.z, heading: c.heading, speed: c.speed }, DT), DT);
      [x, z, speed] = [c.x, c.z, c.speed];
    } else {
      // On foot or in a boat: straight there at a steady speed.
      const pace = mode === 'boat' ? 11 : SPRINT;
      const dir = follower.walk({ x, z });
      speed = dir ? pace : 0;
      if (dir) [x, z] = [x + dir.x * pace * DT, z + dir.z * pace * DT];
    }
    const step = Math.hypot(x - before.x, z - before.z);
    base.metres += step;
    if (mode !== 'foot') base.driven += step;
    await tick();
  }
  const time = clock - t0;
  const last = runner.debugState().last;
  const goalAt = runner.view().target;
  const short = goalAt ? ` (${(Math.hypot(goalAt.x - x, goalAt.z - z) / 1000).toFixed(2)} km short)` : '';
  if (!last || last.id !== mission.id) return { ...base, result: 'timeout', time, message: `still "${runner.view().objective}" after ${time.toFixed(0)} s` };
  // Failed straight away on foot: it wants you in a car from the start.
  if (last.result === 'failed' && time < 5 && !inCar) return play(mission, pace, true);
  return { ...base, result: last.result as Result['result'], time, spare: last.result === 'passed' ? clockLeft : null, message: (last.message ?? '') + (last.result === 'failed' ? short : '') };
}

const t0 = Date.now();
const results: Result[] = [];
for (const m of missions.filter((q) => !only.length || only.includes(q.id))) {
  for (const pace of paces) {
    const r = await play(m, pace);
    results.push(r);
    if (r.result === 'skipped') break;
  }
}

// One row per mission: each pace's result, time and spare seconds.
const ids = [...new Set(results.map((r) => r.id))];
const cell = (r?: Result) => {
  if (!r) return '';
  if (r.result === 'skipped') return 'skipped';
  const mark = r.result === 'passed' ? 'pass' : r.result === 'failed' ? 'FAIL' : r.result === 'timeout' ? 'stuck' : r.result;
  return `${mark} ${r.time.toFixed(0)}s${r.spare !== null ? ` (+${r.spare.toFixed(0)})` : ''}`;
};
const w = Math.max(...ids.map((i) => i.length));
console.log(`${'mission'.padEnd(w)}  ${paces.map((p) => p.padEnd(16)).join('')}notes`);
for (const id of ids) {
  const rs = results.filter((r) => r.id === id);
  const bad = rs.find((r) => r.result !== 'passed');
  const note = rs[0].result === 'skipped' ? rs[0].message : bad ? `${bad.pace}: ${bad.message}` : `${(rs[rs.length - 1].metres / 1000).toFixed(1)} km`;
  console.log(`${id.padEnd(w)}  ${paces.map((p) => cell(rs.find((r) => r.pace === p)).padEnd(16)).join('')}${note.slice(0, 90)}`);
  if (verbose) for (const r of rs) for (const l of r.log) console.log(`    ${r.pace}: ${l}`);
}
console.log(`\n${results.filter((r) => r.result !== 'skipped').length} runs in ${((Date.now() - t0) / 1000).toFixed(1)} s. Paces: ${paces.map((p) => `${p} ${PACES[p].kmh} km/h, a car in ${PACES[p].carDelay} s`).join('; ')}. (+n) = seconds left on the clock.`);
