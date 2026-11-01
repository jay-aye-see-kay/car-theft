import { defineMission, formatTime, type BoardRow, type MissionPlayer } from './runtime/mission.ts';
import type { Place, PlaceId } from './runtime/places.ts';

// Exploring, not errands: Grandad's riddles describe places you can see in
// the game, with no beams or arrows. All five are live at once, so a room can
// split up. Instead of an arrow, everyone gets a hot/cold reading towards
// the nearest riddle nobody has solved yet (and then the loot). Stuck for long
// enough, and beams come on one at a time as a fallback. The loot is under
// Aotea Square, in the car park down the ramp from Greys Ave, which nothing
// else in the game points you to. The riddles and readings are on the board,
// one line each; the objective line just says what's left.

const RIDDLES: { at: PlaceId; text: string }[] = [
  { at: 'ferry-building', text: 'Brick and sandstone, a clock on top, and boats to the islands out the back.' },
  { at: 'waharoa', text: 'A carved gateway stands in the big square. Walk through it.' },
  { at: 'aucklands-steepest-street', text: 'Just off K Road, the steepest street in town. Mind your handbrake.' },
  { at: 'silo-park', text: 'West along the water, over the bridge that lifts, to the park by the old silos.' },
  { at: 'temperate-house', text: 'Glasshouses in the big park on the hill, east of town. My ferns live there.' },
];
/** How close counts as solving a riddle, m: the spot, not just the street. */
const RADIUS = 18;
/** No beams until this long has gone by, s... */
const FIRST_BEAM = 240;
/** ...then another riddle gets one this often, s. */
const NEXT_BEAM = 75;
/** The loot: the car park under the square (floor at 16 m, the square on top at 20-22 m). */
const LOOT = { x: -509, z: 935, within: 60, below: 19 };
/** No hint about the ramp for this long, s. */
const LOOT_HINT = 90;
/** Hot/cold bands: within this far of the nearest unsolved riddle, m, and the colour on the board. */
const BANDS: [number, string, string][] = [
  [50, 'hot!', '#ff5a3c'],
  [150, 'warm', '#ffa040'],
  [350, 'cool', '#bfe6ff'],
  [700, 'cold', '#7fb8ff'],
  [Infinity, 'freezing', '#9aa8ff'],
];

type Riddle = { place: Place; text: string; solved: boolean; beam: boolean; by?: string };

const band = (d: number) => BANDS.find(([m]) => d < m)!;

export default defineMission({
  id: 'grandads-riddles',
  title: "Grandad's Riddles",
  blurb: 'Five riddles, no map, no arrows. Somewhere under town, the loot.',
  players: { min: 1, max: 6 },
  start: 'lower-queen-st',

  async run(m) {
    const riddles: Riddle[] = RIDDLES.map((r) => ({ place: m.place(r.at), text: r.text, solved: false, beam: false }));
    const finds = new Map<number, { name: string; n: number }>();
    const open = () => riddles.filter((r) => !r.solved);
    const dist = (a: { x: number; z: number }, p: MissionPlayer) => Math.hypot(a.x - p.x, a.z - p.z);
    const together = m.players.length > 1;
    const watch = m.stopwatch();
    let looting = false;
    let found: MissionPlayer | undefined;
    m.say(together
      ? "Grandad hid his winnings in '87 and left five riddles. No maps, no arrows. Split up!"
      : "Grandad hid his winnings in '87 and left five riddles. No maps, no arrows. Have a look around.", 6);

    // The board: every riddle (solved ones shrink to where it was and who got it), then everyone's reading.
    const draw = () => {
      const goals: { x: number; z: number }[] = looting ? [LOOT] : open().map((r) => r.place);
      const rows: BoardRow[] = riddles.map((r) => r.solved
        ? { text: r.place.name, note: together ? r.by : undefined, done: true }
        : { text: r.text, note: r.beam ? 'beam on' : undefined, colour: '#ff8fd0' });
      if (looting) rows.push({ text: 'Under the square where the city parties. Down the ramp, mind your head.', note: 'the loot', colour: '#ffd98a' });
      m.board([
        { title: "Grandad's riddles", rows },
        {
          title: 'Hot or cold',
          rows: m.players.map((p) => {
            const [, word, colour] = band(Math.min(...goals.map((g) => dist(g, p))));
            return { text: together ? p.name : 'You', note: word, colour };
          }),
        },
      ]);
      m.objective(looting ? 'Find the loot' : `Solve Grandad's riddles: ${open().length} of ${riddles.length} left`);
    };
    // Past FIRST_BEAM, every NEXT_BEAM one more unsolved riddle gets a beam: the one nearest anyone.
    let beams = 0;
    const tick = async () => {
      while (!found) {
        const due = looting || m.elapsed < FIRST_BEAM ? 0 : 1 + Math.floor((m.elapsed - FIRST_BEAM) / NEXT_BEAM);
        if (beams < due) {
          const closest = (r: Riddle) => Math.min(...m.players.map((p) => dist(r.place, p)));
          const next = open().filter((r) => !r.beam).sort((a, b) => closest(a) - closest(b))[0];
          if (next) {
            next.beam = true;
            m.say(`Grandad's handwriting is hard to read. Here's a hint: ${next.place.name}.`, 4);
          }
          beams = due;
        }
        draw();
        await m.wait(0.25);
      }
    };
    const solve = async (r: Riddle) => {
      const hit: { who?: MissionPlayer } = {};
      await m.waitFor(() => !!(hit.who = m.players.find((p) => dist(r.place, p) < RADIUS)) || r.beam);
      const who = hit.who ?? (await m.goTo(r.place, { radius: RADIUS, label: "Solve Grandad's riddles" }));
      r.solved = true;
      r.by = who.name;
      const f = finds.get(who.id) ?? { name: who.name, n: 0 };
      f.n++;
      finds.set(who.id, f);
      const left = open().length;
      m.say(`${together ? `${who.name} solved one: ` : 'Solved: '}${r.place.name}. ${left ? `${left} to go.` : 'That was the last riddle.'}`, 4);
    };
    // The fifth riddle's back says where the loot is. No beam for this one.
    const loot = async () => {
      await Promise.all(riddles.map(solve));
      looting = true;
      m.say("On the back of the last riddle: 'Under the square where the city parties. Down the ramp, mind your head.'", 7);
      const from = m.elapsed;
      let hinted = false;
      const under = (p: MissionPlayer) => dist(LOOT, p) < LOOT.within && p.y < LOOT.below;
      await m.waitFor(() => {
        if (!hinted && m.elapsed - from > LOOT_HINT) {
          hinted = true;
          m.say('Another scribble: "The ramp is at the end of Greys Ave."', 6);
        }
        return !!(found = m.players.find(under));
      });
    };
    await Promise.all([tick(), loot()]);

    const time = watch.seconds;
    watch.stop();
    const { best, isNew } = m.record(time);
    const board = [...finds.values()].sort((a, b) => b.n - a.n).map((f) => `${f.name} ${f.n}`).join(', ');
    const record = isNew ? 'A new best!' : `Best ${formatTime(best)}.`;
    m.succeed(together
      ? `${found!.name} found Grandad's loot: $43.50 and a lotto ticket. ${formatTime(time)}. Riddles: ${board}. ${record}`
      : `Grandad's loot: $43.50 and a lotto ticket. ${formatTime(time)}. ${record}`);
  },
});
