import { defineMission, formatTime } from './runtime/mission.ts';
import { every, hotCold, nearestOf, scoreRows } from './runtime/kit.ts';

// Exploring, one or more (Animal Crossing's fossils, Zelda's dowsing): five
// things buried at Judges Bay, nothing to see. Each of you has a detector on
// the board that beeps hotter as you near the closest one left; stand still
// right on top of it to dig it up. What turns up is the reward.

const BURIED = [
  { x: 1860, z: 675, what: 'a jandal (left foot only)' },
  { x: 1902, z: 670, what: "a 1987 lotto ticket. Grandad's?" },
  { x: 1940, z: 686, what: 'a pāua shell the size of a hubcap' },
  { x: 1877, z: 700, what: 'car keys. Not yours. Probably.' },
  { x: 1925, z: 699, what: 'a sausage roll, still warm, somehow' },
];
/** Dig within this of the spot, m, standing still (slower than this, km/h) for this long, s. */
const DIG = { reach: 3, still: 2, hold: 2 };

export default defineMission({
  id: 'metal-detector',
  title: 'Metal Detector',
  blurb: 'Five things buried at Judges Bay. Beep, beep, dig.',
  players: { min: 1, max: 6 },
  start: 'judges-bay-reserve',

  async run(m) {
    const finds = BURIED.map((b) => ({ ...b, by: '' }));
    const digs = new Map<number, number>();
    const dug = new Map<number, number>();
    const together = m.players.length > 1;
    m.say('Five things buried in Judges Bay Reserve. Your detector beeps hotter as you get close. Stand still on the spot to dig.', 6);
    m.timer(300, 'Council rangers. Detectorists move along.');
    const left = () => finds.filter((f) => !f.by);
    every(m, 0.1, (dt) => {
      for (const p of m.players) {
        const { it, d } = nearestOf(p, left());
        const digging = !!it && d < DIG.reach && !p.driving && p.speedKmh < DIG.still;
        digs.set(p.id, digging ? (digs.get(p.id) ?? 0) + dt : 0);
        if (it && (digs.get(p.id) ?? 0) >= DIG.hold) {
          it.by = p.name;
          digs.set(p.id, 0);
          dug.set(p.id, (dug.get(p.id) ?? 0) + 1);
          m.say(`${together ? p.name + ' dug up' : 'You dig up'} ${it.what}`, 4);
        }
      }
      m.board([
        { title: `Finds: ${finds.length - left().length} of ${finds.length}`, rows: finds.filter((f) => f.by).map((f) => ({ text: f.what, note: together ? f.by : undefined, done: true })) },
        {
          title: 'Detector',
          rows: m.players.map((p) => {
            const { d } = nearestOf(p, left());
            const h = hotCold(d);
            const digging = (digs.get(p.id) ?? 0) > 0;
            return { text: together ? p.name : 'Beep', note: digging ? 'digging…' : h.word, colour: h.colour };
          }),
        },
        ...(together ? [{ title: 'Diggers', rows: scoreRows(m.players, (p) => dug.get(p.id) ?? 0) }] : []),
      ]);
    });
    await m.waitFor(() => !left().length, 'Find what is buried (stand still to dig)');
    m.succeed(`All five dug up in ${formatTime(m.elapsed)}. The museum is not interested.`);
  },
});
