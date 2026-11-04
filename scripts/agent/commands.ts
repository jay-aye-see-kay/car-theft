// The agent's commands: each takes words and gives back a few lines of text.
// They're thin over the ?debug hooks (src/main.ts `__game`): `agent()` for one
// rounded look at everything, `pilot()` to drive, `journal()` for what
// happened. Long runs (driving somewhere, playing a mission) loop inside the
// page so they cost one round trip, not one per tick.
import type { Page } from 'playwright';
import { writeFileSync } from 'node:fs';
import { LEGEND, picture, type Mark, type Overlay, type TextMap } from './ascii.ts';
import { MissionPolicy } from '../../src/agent/policy.ts';

export interface Ctx {
  page: Page;
  errors: string[];
  textMap: TextMap | null;
  shots: string;
}

interface Command {
  usage: string;
  help: string;
  alias?: string[];
  run(ctx: Ctx, args: string[]): Promise<string>;
}

/** The rounded look from __game.agent(). */
interface View {
  t: number;
  mode: 'foot' | 'car' | 'boat';
  car: number;
  pos: [number, number, number];
  heading: number;
  kmh: number;
  street: { name: string; off: number } | null;
  surface: string | null;
  nearCar: number;
  nearBoat: boolean;
  heat: number;
  seen: boolean;
  caught: boolean;
  dizzy: boolean;
  flat: boolean;
  paused: boolean;
  mission: {
    active: string | null;
    objective: string;
    subtitle: string | null;
    banner: string | null;
    clock: { s: number; down: boolean } | null;
    target: { x: number; z: number; label: string } | null;
    targets: number;
    props: { x: number; z: number; style: string; label?: string; radius: number; onFoot?: boolean; carried: boolean }[];
    board: { title?: string; rows: { text: string; note?: string; done?: boolean }[] }[];
    hint: string;
    nearest: { id: string; title: string; x: number; z: number } | null;
  } | null;
  pilot: { status: string; mode: string | null; left: number; length: number; reroutes: number; unsticks: number; time: number };
  cars: { i: number; kind: string; x: number; z: number; heading: number; kmh: number; upright: boolean }[];
  peds: { x: number; z: number; state: string; role: string; says: string }[];
  boats: { i: number; kind: string; x: number; z: number }[];
}

const g = <T = any>(page: Page, fn: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(([f, a]) => (window as any).__game[f as string](...(a as unknown[])), [fn, args] as const);
const view = (ctx: Ctx, r = 40) => g<View>(ctx.page, 'agent', r);

// --- words for where things are ---------------------------------------

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (dx: number, dz: number) => COMPASS[Math.round(((((Math.atan2(dx, -dz) * 180) / Math.PI) + 360) % 360) / 45) % 8];
const facing = (h: number) => compass(Math.cos(h), -Math.sin(h));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** Where (dx, dz) is from someone facing h: ahead, left... */
const relative = (dx: number, dz: number, h: number) => {
  const k = Math.round(wrap(Math.atan2(-dz, dx) - h) / (Math.PI / 4));
  return ['behind', 'behind-right', 'right', 'ahead-right', 'ahead', 'ahead-left', 'left', 'behind-left', 'behind'][k + 4];
};
const m = (d: number) => (d < 10 ? `${d.toFixed(1)} m` : d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`);
/** "120 m NE (ahead-left)" from the view's position and heading. */
const where = (v: View, x: number, z: number) => {
  const dx = x - v.pos[0];
  const dz = z - v.pos[2];
  const d = Math.hypot(dx, dz);
  return d < 1.5 ? 'here' : `${m(d)} ${compass(dx, dz)} (${relative(dx, dz, v.heading)})`;
};
const dist = (v: View, x: number, z: number) => Math.hypot(x - v.pos[0], z - v.pos[2]);
const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** The look, as a few lines. `brief`: just you and the mission. */
function describe(v: View, brief = false): string {
  const out: string[] = [];
  const who = v.mode === 'car' ? `driving car #${v.car} at ${v.kmh} km/h` : v.mode === 'boat' ? `in a boat at ${v.kmh} km/h` : v.kmh > 2 ? `on foot, moving ${v.kmh} km/h` : 'on foot';
  const street = v.street ? (v.street.off <= 0.5 ? `on ${v.street.name}` : `${m(v.street.off)} off ${v.street.name}`) : 'no road near';
  const flags = [v.heat ? `HEAT ${v.heat}${v.seen ? ' (seen)' : ''}` : 'heat 0', v.caught && 'CAUGHT', v.dizzy && 'dizzy', v.flat && 'flat tyres', v.paused && 'paused'].filter(Boolean);
  out.push(`t ${v.t.toFixed(1)} s · ${who} · at (${Math.round(v.pos[0])}, ${Math.round(v.pos[2])}) facing ${facing(v.heading)} · ${street}${v.surface && v.mode === 'foot' ? ` (${v.surface})` : ''} · ${flags.join(' · ')}`);
  const ms = v.mission;
  if (ms?.active) {
    const parts = [`mission ${ms.active}`];
    if (ms.objective) parts.push(`"${ms.objective}"`);
    if (ms.clock) parts.push(`${fmtClock(ms.clock.s)}${ms.clock.down ? ' left' : ' elapsed'}`);
    if (ms.target) parts.push(`goal ${ms.target.label || '(unnamed)'} ${where(v, ms.target.x, ms.target.z)}${ms.targets > 1 ? ` (+${ms.targets - 1} more)` : ''}`);
    out.push(parts.join(' · '));
    if (ms.subtitle) out.push(`  says: "${ms.subtitle}"`);
    const props = ms.props.filter((p) => !p.carried);
    if (props.length) {
      const near = props.map((p) => ({ p, d: dist(v, p.x, p.z) })).sort((a, b) => a.d - b.d);
      out.push(`  props: ${props.length} ${near[0].p.style}s, nearest ${near[0].p.label ? `"${near[0].p.label}" ` : ''}${where(v, near[0].p.x, near[0].p.z)}${ms.props.some((p) => p.carried) ? '; carrying one' : ''}`);
    }
    for (const b of ms.board) {
      out.push(`  ${b.title ?? 'board'}:`);
      for (const r of b.rows) out.push(`    ${r.done ? '[x]' : '[ ]'} ${r.text}${r.note ? ` (${r.note})` : ''}`);
    }
  } else if (ms) {
    if (ms.banner) out.push(`banner: ${ms.banner}`);
    if (ms.nearest) out.push(`no mission running · nearest start: ${ms.nearest.title} (${ms.nearest.id}) ${where(v, ms.nearest.x, ms.nearest.z)}${ms.hint ? ` · ${ms.hint}` : ''}`);
  }
  if (v.pilot.status === 'driving') out.push(`autopilot ${v.pilot.status} (${v.pilot.mode}): ${m(v.pilot.left)} of ${m(v.pilot.length)} left, ${v.pilot.time} s${v.pilot.unsticks ? `, backed out ${v.pilot.unsticks}×` : ''}`);
  if (brief) return out.join('\n');
  if (v.nearCar >= 0) out.push(`can get in: car #${v.nearCar} ("enter")`);
  else if (v.nearBoat) out.push('can board: a boat ("enter")');
  const cars = v.cars.map((c) => ({ c, d: dist(v, c.x, c.z) })).sort((a, b) => a.d - b.d);
  if (cars.length) out.push(`cars: ${cars.slice(0, 6).map(({ c }) => `#${c.i} ${c.kind}${c.kmh > 3 ? ` ${c.kmh} km/h` : ''}${c.upright ? '' : ' upside-down'} ${where(v, c.x, c.z)}`).join(' · ')}${cars.length > 6 ? ` · +${cars.length - 6} more` : ''}`);
  const cops = v.peds.filter((p) => p.role === 'cop');
  const people = v.peds.filter((p) => p.role !== 'cop');
  if (people.length) {
    const near = people.map((p) => ({ p, d: dist(v, p.x, p.z) })).sort((a, b) => a.d - b.d)[0].p;
    const states = Object.entries(people.reduce<Record<string, number>>((o, p) => ((o[p.state] = (o[p.state] ?? 0) + 1), o), {})).map(([k, n]) => `${n} ${k}`);
    out.push(`people: ${states.join(', ')}; nearest ${where(v, near.x, near.z)}`);
  }
  if (cops.length) out.push(`cops on foot: ${cops.map((c) => `${c.state} ${where(v, c.x, c.z)}`).join(' · ')}`);
  const said = v.peds.filter((p) => p.says).map((p) => `"${p.says}"`);
  if (said.length) out.push(`heard: ${said.join(' ')}`);
  if (v.boats.length) out.push(`boats: ${v.boats.map((b) => `${b.kind} ${where(v, b.x, b.z)}`).join(' · ')}`);
  return out.join('\n');
}

/** What to draw over a map: cars, people, boats, props, the goal, the next mission. */
function overlay(v: View): Overlay[] {
  const marks: Overlay[] = [];
  for (const c of v.cars) marks.push({ x: c.x, z: c.z, mark: (c.kind === 'cop-chasing' ? 'police' : c.kind) as Mark });
  for (const p of v.peds) marks.push({ x: p.x, z: p.z, mark: p.role === 'cop' ? 'cop' : 'ped' });
  for (const b of v.boats) marks.push({ x: b.x, z: b.z, mark: 'boat' });
  for (const p of v.mission?.props ?? []) if (!p.carried) marks.push({ x: p.x, z: p.z, mark: 'prop' });
  if (v.mission?.target) marks.push({ ...v.mission.target, mark: 'target' });
  if (v.mission?.nearest && !v.mission.active) marks.push({ ...v.mission.nearest, mark: 'start' });
  return marks;
}

// --- where to -------------------------------------------------------------

/** A destination from a word: "x,z", "goal", "start", "start:<id>", "#3", "car", or a place id or name. */
async function resolve(ctx: Ctx, word: string, v: View): Promise<{ x: number; z: number; label: string }> {
  const xy = word.match(/^(-?[\d.]+),(-?[\d.]+)$/);
  if (xy) return { x: +xy[1], z: +xy[2], label: word };
  if (word === 'goal' || word === 'target') {
    const t = v.mission?.target;
    if (t) return { ...t, label: t.label || 'the goal' };
    const p = v.mission?.props.filter((q) => !q.carried).sort((a, b) => dist(v, a.x, a.z) - dist(v, b.x, b.z))[0];
    if (p) return { x: p.x, z: p.z, label: p.label ?? `a ${p.style}` };
    throw new Error('no mission goal right now');
  }
  if (word === 'start' || word.startsWith('start:')) {
    const id = word.slice(6);
    const ms = await g(ctx.page, 'missions');
    const s = id ? ms.missions.find((q: any) => q.id === id)?.start : ms.nearest;
    if (!s) throw new Error(id ? `no mission ${id}` : 'no mission start near');
    return { x: s.x, z: s.z, label: `the start of ${id || s.id}` };
  }
  const car = word.match(/^#(\d+)$/);
  if (car || word === 'car') {
    const all = await view(ctx, 400);
    const c = car ? all.cars.find((q) => q.i === +car[1]) : all.cars.filter((q) => q.kmh < 3 && !q.kind.startsWith('cop') && q.kind !== 'police').sort((a, b) => dist(v, a.x, a.z) - dist(v, b.x, b.z))[0];
    if (!c) throw new Error(car ? `car #${car[1]} isn't within 400 m` : 'no free car within 400 m');
    return { x: c.x, z: c.z, label: `car #${c.i}` };
  }
  const p = (await g(ctx.page, 'place', word)) ?? (await findPlace(ctx, word, v))[0];
  if (!p) throw new Error(`no place "${word}" (try: places ${word})`);
  return { x: p.x, z: p.z, label: p.name };
}

async function findPlace(ctx: Ctx, q: string, v: View, within?: number) {
  const all: any[] = await g(ctx.page, 'places', undefined, { near: [v.pos[0], v.pos[2]], within });
  const kinds = new Set(all.map((p) => p.kind));
  if (kinds.has(q)) return all.filter((p) => p.kind === q);
  const re = new RegExp(q.replace(/[-_]/g, '.?'), 'i');
  return all.filter((p) => re.test(p.id) || re.test(p.name));
}

const KEYS: Record<string, string> = { w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', space: 'Space', shift: 'ShiftLeft', f: 'KeyF', c: 'KeyC', r: 'KeyR', q: 'KeyQ', tab: 'Tab', enter: 'Enter', esc: 'Escape' };
const key = (k: string) => KEYS[k.toLowerCase()] ?? k;
const named = (args: string[], name: string) => args.find((a) => a.startsWith(`${name}=`))?.split('=')[1];
const plain = (args: string[]) => args.filter((a) => !a.includes('='));

/** Steps `seconds`, half a second at a time, until `stop` (a string of JS over `v`, the agent view) is true. Inside the page. */
async function stepUntil(ctx: Ctx, seconds: number, stop: string): Promise<{ t: number; reason: string }> {
  return ctx.page.evaluate(async ({ seconds, stop }) => {
    const game = (window as any).__game;
    const test = new Function('v', `return (${stop})`) as (v: unknown) => string | false;
    for (let t = 0; t < seconds; t += 0.5) {
      await game.step(30);
      const why = test(game.agent(0));
      if (why) return { t: t + 0.5, reason: why };
    }
    return { t: seconds, reason: 'time' };
  }, { seconds, stop });
}

/** Lines the journal has gathered, indented, or nothing. */
async function happened(ctx: Ctx, max = 25): Promise<string> {
  const lines: string[] = await g(ctx.page, 'journal');
  if (!lines.length) return '';
  const shown = lines.length > max ? [...lines.slice(0, 5), `… ${lines.length - max} more …`, ...lines.slice(-(max - 5))] : lines;
  return '\n' + shown.map((l) => `  ${l}`).join('\n');
}

/** A stop condition for runs: the mission ending, being caught. */
const ENDED = `(v.mission && v.mission.banner && /^(passed|failed)/.test(v.mission.banner) && 'mission over') || (v.caught && 'caught')`;

async function go(ctx: Ctx, args: string[]): Promise<string> {
  const [word] = plain(args);
  if (!word) throw new Error('go where?');
  const v = await view(ctx);
  const to = await resolve(ctx, word, v);
  const max = Number(named(args, 'max') ?? 120);
  const goal = { to: [to.x, to.z], kmh: named(args, 'kmh') ? Number(named(args, 'kmh')) : undefined, via: args.includes('direct') ? 'direct' : args.includes('road') ? 'road' : undefined, arrive: named(args, 'arrive') ? Number(named(args, 'arrive')) : undefined };
  const started = await g(ctx.page, 'pilot', goal);
  const missionWas = v.mission?.active;
  const { t, reason } = await stepUntil(ctx, max, `v.pilot.status !== 'driving' && v.pilot.status${missionWas ? ` || ${ENDED}` : ` || (v.caught && 'caught')`}`);
  const p = await g(ctx.page, 'pilotState');
  if (p.status === 'driving') await g(ctx.page, 'pilot', null);
  const after = await view(ctx);
  const head = `${reason === 'time' ? `still going after ${max} s (stopped)` : reason === 'arrived' ? 'arrived' : reason} at ${to.label}: ${t} s, ${m(started.length)} by ${started.mode === 'car' ? 'road' : started.mode === 'foot' && started.length > 70 ? 'footpath' : 'line'}, ${where(after, to.x, to.z)} from it`;
  return `${head}${await happened(ctx)}\n${describe(after, true)}`;
}

// --- the commands ---------------------------------------------------------

export const COMMANDS: Record<string, Command> = {
  help: {
    usage: 'help',
    help: 'this list',
    async run() {
      const w = Math.max(...Object.values(COMMANDS).map((c) => c.usage.length));
      return Object.values(COMMANDS).map((c) => `${c.usage.padEnd(w)}  ${c.help}`).join('\n') + '\n\nDestinations: x,z · goal (mission goal or nearest prop) · start · start:<mission> · car (nearest free) · #n (car n) · place id or name. Several commands: "a; b".';
    },
  },
  look: {
    usage: 'look [r=40]',
    alias: ['l', 'status'],
    help: 'you, the street, heat, mission, and cars/people/boats within r m (compass, and ahead/left/... from where you face)',
    async run(ctx, [r]) {
      const v = await view(ctx, Number(r ?? 40));
      return describe(v) + (await happened(ctx));
    },
  },
  mapshot: {
    usage: 'mapshot [r=150] [px=256] [name]',
    alias: ['picture'],
    help: 'the same map as a small north-up PNG (path printed; read it to see): ~90 image tokens at 256 px',
    async run(ctx, [r = '150', px = '256', name = `map-${Date.now()}`]) {
      if (!ctx.textMap) return 'no map picture on this map';
      const v = await view(ctx, Number(r) * 1.5);
      const path = `${ctx.shots}${name}.png`;
      writeFileSync(path, picture(ctx.textMap, v.pos[0], v.pos[2], v.heading, overlay(v), { radius: Number(r), size: Number(px) }));
      return `${path}
${Math.round((2 * Number(r)) / Number(px) * 10) / 10} m per px, north up, you the white wedge. Grey roads; dark grey buildings; greens parks; blue water. Dots: pink goal, yellow mission start (on the rim if further), cyan props, purple the purple car, grey parked, orange traffic, blue police/cops, pale people, teal boats.`;
    },
  },
  map: {
    usage: 'map [r=90] [cell=6]',
    help: 'north-up text map round you: ground, roads, cars, people, goal (on the rim if further)',
    async run(ctx, [r = '90', cell = '6']) {
      if (!ctx.textMap) return 'no text map on this map';
      const v = await view(ctx, Number(r) * 1.5);
      const marks = overlay(v);
      const { lines, streets } = ctx.textMap.render(v.pos[0], v.pos[2], Number(r), Number(cell), v.heading, marks);
      return `${lines.join('\n')}\n${cell} m per character, north up, you in the middle facing ${facing(v.heading)}. Streets: ${streets.slice(0, 8).join(', ') || 'none'}\nKey: ${LEGEND}`;
    },
  },
  wait: {
    usage: 'wait [s=1]',
    alias: ['step'],
    help: 'let game time pass (stops early if a mission ends or you are caught)',
    async run(ctx, [s = '1']) {
      const { t, reason } = await stepUntil(ctx, Number(s), ENDED);
      return `${reason === 'time' ? `waited ${t} s` : `${reason} after ${t} s`}${await happened(ctx)}\n${describe(await view(ctx), true)}`;
    },
  },
  hold: {
    usage: 'hold <keys> [s=1]',
    help: 'hold keys (w+a, space, shift, up...) for s seconds of game time',
    async run(ctx, [keys = '', s = '1']) {
      const codes = keys.split(/[+,]/).filter(Boolean).map(key);
      for (const k of codes) await ctx.page.keyboard.down(k);
      try {
        await stepUntil(ctx, Number(s), 'false');
      } finally {
        for (const k of codes) await ctx.page.keyboard.up(k);
      }
      return `held ${codes.join('+')} for ${s} s${await happened(ctx)}\n${describe(await view(ctx), true)}`;
    },
  },
  press: {
    usage: 'press <key>',
    help: 'tap a key once (f: in/out, r: flip car, q: quit mission, tab: map, enter: skip ticket)',
    async run(ctx, [k]) {
      await ctx.page.keyboard.press(key(k));
      await g(ctx.page, 'step', 2);
      return `pressed ${key(k)}${await happened(ctx)}\n${describe(await view(ctx), true)}`;
    },
  },
  enter: {
    usage: 'enter',
    alias: ['exit', 'in', 'out'],
    help: 'get in the car or boat within reach, or out of the one you are in (brakes first)',
    async run(ctx) {
      const before = await view(ctx);
      await ctx.page.keyboard.press('KeyF');
      await stepUntil(ctx, 6, `v.mode !== '${before.mode}' && 'done'`);
      const after = await view(ctx);
      const what = after.mode === before.mode ? (before.mode === 'foot' ? 'nothing within reach to get into' : "couldn't get out") : after.mode === 'foot' ? 'got out' : `got in car #${after.car}`;
      return `${what}${await happened(ctx)}\n${describe(after, true)}`;
    },
  },
  go: {
    usage: 'go <where> [kmh=80] [max=120] [arrive=6] [direct|road]',
    alias: ['drive', 'walk'],
    help: 'autopilot there as you are (driving on the left by road; walking direct, or by footpath if far); returns what happened on the way',
    run: go,
  },
  tp: {
    usage: 'tp <where> [heading N|E|S|W|radians]',
    alias: ['teleport'],
    help: 'teleport you (or the car you are in) there',
    async run(ctx, [word, h = '0']) {
      const v = await view(ctx);
      const to = await resolve(ctx, word, v);
      const heading = { N: Math.PI / 2, E: 0, S: -Math.PI / 2, W: Math.PI }[h.toUpperCase()] ?? Number(h);
      if (v.mode === 'car') await g(ctx.page, 'teleportCar', v.car, to.x, to.z, heading);
      else await g(ctx.page, 'placePlayer', to.x, to.z, heading);
      await g(ctx.page, 'step', 10);
      return `at ${to.label}${await happened(ctx)}\n${describe(await view(ctx), true)}`;
    },
  },
  mission: {
    usage: 'mission [list | start <id> | quit]',
    alias: ['missions'],
    help: 'the running mission, the list (with where each starts), start one where you stand, or quit',
    async run(ctx, [what, id]) {
      const ms = await g(ctx.page, 'missions');
      const v = await view(ctx);
      if (what === 'list') {
        return ms.missions.map((q: any) => `${q.id.padEnd(20)} ${q.title.padEnd(26)} ${q.min > 1 ? `${q.min}+ players` : 'solo     '}  start ${q.start.name} ${where(v, q.start.x, q.start.z)}`).join('\n');
      }
      if (what === 'start') {
        await g(ctx.page, 'startMission', id);
        await g(ctx.page, 'step', 30);
        return `${await happened(ctx)}\n${describe(await view(ctx), true)}`.trim();
      }
      if (what === 'quit') {
        await ctx.page.keyboard.press('KeyQ');
        await g(ctx.page, 'step', 2);
        await ctx.page.locator('#quit-confirm button', { hasText: /quit/i }).first().click({ force: true }).catch(() => {});
        await g(ctx.page, 'step', 10);
        return `${await happened(ctx)}\n${describe(await view(ctx), true)}`.trim();
      }
      const last = ms.last ? `last: ${ms.last.id} ${ms.last.result}${ms.last.message ? ` ("${ms.last.message}")` : ''}` : '';
      return [describe(v, true), last].filter(Boolean).join('\n');
    },
  },
  play: {
    usage: 'play <mission> [max=240]',
    help: 'a bot plays the mission through: to its start, into a car if it needs one, after each goal; prints what happened',
    run: playMission,
  },
  places: {
    usage: 'places <kind|name> [r=300]',
    help: 'places of a kind (bar, cafe, park...) or matching a name, nearest first',
    async run(ctx, [q, r = '300']) {
      const v = await view(ctx);
      const found = q ? await findPlace(ctx, q, v, Number(r)) : [];
      if (!q) {
        const all: any[] = await g(ctx.page, 'places');
        const kinds = all.reduce<Record<string, number>>((o, p) => ((o[p.kind] = (o[p.kind] ?? 0) + 1), o), {});
        return `kinds: ${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`;
      }
      return found.slice(0, 12).map((p) => `${p.id} · ${p.name} (${p.kind}) ${where(v, p.x, p.z)}`).join('\n') || `none within ${r} m`;
    },
  },
  heat: {
    usage: 'heat <0-3>',
    help: 'set the wanted level',
    async run(ctx, [n]) {
      await g(ctx.page, 'setHeat', Number(n));
      await g(ctx.page, 'step', 2);
      return describe(await view(ctx), true);
    },
  },
  knob: {
    usage: 'knob [section[.key] [value]]',
    alias: ['knobs'],
    help: 'read the ? panel knobs (all, a section, one), or set one: knob cops.on false',
    async run(ctx, [path, value]) {
      if (path && value !== undefined) {
        const v = value === 'true' ? true : value === 'false' ? false : Number(value);
        return JSON.stringify(await g(ctx.page, 'knob', path, v));
      }
      const all = await g(ctx.page, 'knobs');
      if (!path) return Object.entries(all).map(([k, o]) => `${k}: ${Object.keys(o as object).join(' ')}`).join('\n');
      const [sec, k] = path.split('.');
      return JSON.stringify(k ? all[sec]?.[k] : all[sec]);
    },
  },
  shot: {
    usage: 'shot [width=480] [name]',
    help: 'a screenshot (file path printed; read it to see). Small is cheap: 480 px wide is ~200 image tokens',
    async run(ctx, [w = '480', name = `shot-${Date.now()}`]) {
      const vp = ctx.page.viewportSize()!;
      const width = Number(w);
      await ctx.page.setViewportSize({ width, height: Math.round((width * 9) / 16) });
      await g(ctx.page, 'draw');
      await g(ctx.page, 'draw');
      const path = `${ctx.shots}${name}.png`;
      await ctx.page.screenshot({ path });
      await ctx.page.setViewportSize(vp);
      return path;
    },
  },
  journal: {
    usage: 'journal',
    alias: ['events'],
    help: 'what has happened since you last looked',
    async run(ctx) {
      return (await happened(ctx, 100)).trim() || 'nothing new';
    },
  },
  reset: {
    usage: 'reset',
    help: 'back to the start: on foot at the spawn, every knob default, no mission',
    async run(ctx) {
      await g(ctx.page, 'reset');
      return describe(await view(ctx));
    },
  },
  eval: {
    usage: 'eval <js>',
    help: 'run JS in the page (g is window.__game), JSON back (cut at 3000 chars)',
    async run(ctx, words) {
      const out = await ctx.page.evaluate(async (src) => {
        const g = (window as any).__game;
        const r = await new Function('g', `return (async () => (${src}))()`)(g);
        return JSON.stringify(r);
      }, words.join(' '));
      return (out ?? 'undefined').slice(0, 3000);
    },
  },
};

// --- the mission bot ------------------------------------------------------

/**
 * Plays a mission the way a keen but not clever player would: walk into its
 * marker, take the nearest car if it wants one or the goal's far, then head
 * for each goal (or the nearest prop) in turn, looking again every few
 * seconds because goals move. It's a baseline: what an agent playing by
 * hand should beat, and a quick "can this be finished at all".
 */
async function playMission(ctx: Ctx, args: string[]): Promise<string> {
  const first = await playOnce(ctx, args, false);
  if (!/FAILED in [0-4]\.\d s/.test(first)) return first;
  // Failed at once on foot: it wants you in a car from the start. Again, from one.
  return `${first.split('\n')[0]}\n(failed straight away on foot: again, starting in a car)\n${await playOnce(ctx, args, true)}`;
}

async function playOnce(ctx: Ctx, args: string[], inCar: boolean): Promise<string> {
  const [id] = plain(args);
  const max = Number(named(args, 'max') ?? 240);
  const ms = await g(ctx.page, 'missions');
  const mission = ms.missions.find((q: any) => q.id === id);
  if (!mission) return `no mission "${id}". Missions: ${ms.missions.map((q: any) => q.id).join(', ')}`;
  const log: string[] = [];
  const note = (s: string) => log.push(s);
  let v = await view(ctx);
  // To the marker: drop in nearby and walk in, as a player arriving would.
  if (!v.mission?.active || v.mission.active !== id) {
    await g(ctx.page, 'placePlayer', mission.start.x + 8, mission.start.z, Math.PI);
    await g(ctx.page, 'step', 10);
    if (inCar) {
      // The nearest free car, brought to the marker's road, and in.
      const near = (await view(ctx, 200)).cars.filter((c) => c.kmh < 3 && !/police|cop/.test(c.kind)).sort((a, b) => Math.hypot(a.x - mission.start.x, a.z - mission.start.z) - Math.hypot(b.x - mission.start.x, b.z - mission.start.z))[0];
      if (near) {
        await g(ctx.page, 'teleportCar', near.i, mission.start.x + 12, mission.start.z, Math.PI);
        await g(ctx.page, 'placePlayer', mission.start.x + 12, mission.start.z + 1.8, Math.PI);
        await g(ctx.page, 'step', 4);
        await ctx.page.keyboard.press('KeyF');
        await stepUntil(ctx, 2, `v.mode === 'car' && 'in'`);
      }
    }
    await g(ctx.page, 'journal');
    await g(ctx.page, 'pilot', { to: [mission.start.x, mission.start.z], via: 'direct', arrive: 0.5 });
    await stepUntil(ctx, 8, `v.mission && v.mission.active && 'started'`);
    await g(ctx.page, 'pilot', null);
    v = await view(ctx);
    if (v.mission?.active !== id) {
      note(`walking into the marker didn't start it (${v.mission?.active ?? 'nothing'} running); starting it by hand`);
      await g(ctx.page, 'startMission', id);
      await g(ctx.page, 'step', 30);
    }
  }
  const t0 = (await view(ctx)).t;
  const pull = async () => {
    const lines: string[] = await g(ctx.page, 'journal');
    log.push(...lines);
  };
  const policy = new MissionPolicy();
  let tries = 0;
  /** Legs in a row that got no nearer the same goal. */
  let stalls = 0;
  let lastGoal = '';
  while (true) {
    v = await view(ctx, 60);
    await pull();
    if (!v.mission?.active || v.t - t0 > max) break;
    const ms = v.mission;
    const said: string[] = (await g(ctx.page, 'missions')).said;
    const d = policy.decide({ objective: ms.objective, said, target: ms.target, props: ms.props }, { x: v.pos[0], z: v.pos[2], mode: v.mode }, v.t);
    if (d.want !== v.mode && tries < 3) {
      tries++;
      if (v.mode !== 'foot') {
        note(`${v.t.toFixed(1)} bot: getting out (wants ${d.want})`);
        await ctx.page.keyboard.press('KeyF');
        await stepUntil(ctx, 4, `v.mode === 'foot' && 'out'`);
      } else if (d.want === 'car') {
        const all = await view(ctx, 150);
        const car = all.cars.filter((c) => c.kmh < 3 && c.upright && !/police|cop/.test(c.kind)).sort((a, b) => dist(v, a.x, a.z) - dist(v, b.x, b.z))[0];
        if (!car) {
          note(`${v.t.toFixed(1)} bot: no free car within 150 m, going on foot`);
          continue;
        }
        note(`${v.t.toFixed(1)} bot: walking to car #${car.i} (${car.kind}) ${where(v, car.x, car.z)}`);
        await g(ctx.page, 'pilot', { to: [car.x, car.z], arrive: 2 });
        await stepUntil(ctx, 30, `(v.pilot.status !== 'driving' && v.pilot.status) || ${ENDED}`);
        await g(ctx.page, 'pilot', null);
        await ctx.page.keyboard.press('KeyF');
        await stepUntil(ctx, 2, `v.mode === 'car' && 'in'`);
      } else if (d.want === 'boat') {
        const boats: { index: number; pos: number[] }[] = await g(ctx.page, 'boats');
        const b = boats.sort((a, c) => dist(v, a.pos[0], a.pos[2]) - dist(v, c.pos[0], c.pos[2]))[0];
        note(`${v.t.toFixed(1)} bot: to the nearest boat ${where(v, b.pos[0], b.pos[2])} (teleported to its wharf)`);
        await g(ctx.page, 'besideBoat', b.index);
        await ctx.page.keyboard.press('KeyF');
        await stepUntil(ctx, 2, `v.mode === 'boat' && 'in'`);
      }
      continue;
    }
    tries = 0;
    if (!d.goal) {
      await stepUntil(ctx, 1, ENDED);
      continue;
    }
    // A leg: towards the goal for up to 8 s, then look again (goals move, props get picked up).
    const far = dist(v, d.goal.x, d.goal.z);
    const through = !!d.prop && !d.stop;
    await g(ctx.page, 'pilot', { to: [d.goal.x, d.goal.z], through, arrive: d.prop ? Math.min(2, d.prop.radius * 0.5) : v.mode === 'foot' ? 1 : 3 });
    await stepUntil(ctx, 8, `(v.pilot.status !== 'driving' && v.pilot.status) || ${ENDED}`);
    const p = await g(ctx.page, 'pilotState');
    const w = await view(ctx, 0);
    const gk = `${Math.round(d.goal.x)},${Math.round(d.goal.z)}`;
    stalls = gk === lastGoal && dist(w, d.goal.x, d.goal.z) > far - 2 ? stalls + 1 : 0;
    lastGoal = gk;
    if (stalls >= 2 && d.prop) {
      note(`${w.t.toFixed(1)} bot: can't get to the prop at ${gk} (${m(dist(w, d.goal.x, d.goal.z))} away, ${w.mode}); trying others`);
      policy.skip(d.goal, w.t);
      stalls = 0;
    }
    note(`${w.t.toFixed(1)} bot: ${m(dist(w, d.goal.x, d.goal.z))} to ${d.goal.label} (was ${m(far)}), ${w.kmh} km/h on ${w.street?.name ?? '?'}${p.waiting ? ', waiting for something in the way' : ''}${p.status === 'stuck' || p.status === 'lost' ? `, autopilot ${p.status}` : ''}`);
    // There and nothing happened: hold still a moment (some goals want you to stop).
    if (p.status === 'arrived' && !through) {
      await g(ctx.page, 'pilot', null);
      await stepUntil(ctx, 2, ENDED);
    }
  }
  await g(ctx.page, 'pilot', null);
  await stepUntil(ctx, 1, 'false');
  await pull();
  const end = await g(ctx.page, 'missions');
  const last = end.last && end.last.id === id ? end.last : null;
  const after = await view(ctx);
  const result = last ? `${last.result.toUpperCase()} in ${(after.t - t0).toFixed(1)} s: "${last.message}"` : `still running after ${max} s (gave up)`;
  const counts = {
    crashes: log.filter((l) => / crash /.test(l)).length,
    peds: log.filter((l) => /hit a pedestrian/.test(l)).length,
    smashed: log.filter((l) => /knocked down/.test(l)).length,
    heat: Math.max(0, ...log.map((l) => Number(l.match(/heat \d→(\d)/)?.[1] ?? 0))),
  };
  return `${id}: ${result}\n${counts.crashes} crashes, ${counts.peds} people hit, ${counts.smashed} things knocked down, top heat ${counts.heat}\n${log.map((l) => `  ${l}`).join('\n')}`;
}
