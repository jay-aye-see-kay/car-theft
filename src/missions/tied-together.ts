import { defineMission, formatTime } from './runtime/mission.ts';
import { dist, every } from './runtime/kit.ts';
import type { PlaceId } from './runtime/places.ts';

// Driving, for two or more (It Takes Two's tethers): an invisible tow rope
// between every car. Drive the course as a convoy; get too far from each
// other and the rope strains, and strain for too long and it snaps. Each
// checkpoint needs the whole convoy through it.

const COURSE: PlaceId[] = ['the-civic', 'town-hall', 'aut-library', 'auckland-high-court', 'emily-place-reserve'];
/** The rope: slack within this spread (the furthest any two are apart), m... */
const SLACK = 30;
/** ...snaps at once past this... */
const SNAP = 70;
/** ...and over the slack, strain builds by (metres over / this) per second, snapping at 1. */
const STRAIN = 40;
/** Strain eases off this fast once you're close again, per s. */
const EASE = 0.25;

export default defineMission({
  id: 'tied-together',
  title: 'Tied Together',
  blurb: 'An invisible rope between your cars. Stay close.',
  players: { min: 2, max: 4 },
  start: 'mid-queen-st',
  needsCar: true,

  async run(m) {
    m.say("There's an invisible tow rope between all your cars. Don't ask how. Stay close or it snaps.", 5);
    await m.waitFor(() => m.players.every((p) => p.driving), 'Everyone in a car');
    for (const n of ['3', '2', '1']) {
      m.say(n, 1);
      await m.wait(1);
    }
    m.say('Go! Together!', 2);
    let strain = 0;
    let worst = 0;
    const spread = () => {
      let s = 0;
      for (const a of m.players) for (const b of m.players) s = Math.max(s, dist(a, b));
      return s;
    };
    m.timer(360, 'The convoy took so long the rope rotted.');
    m.failIf(() => m.players.some((p) => !p.driving), 'Someone got out. The rope went with them.');
    every(m, 0.1, (dt) => {
      const s = spread();
      worst = Math.max(worst, s);
      if (s > SNAP) strain = 1;
      strain = s > SLACK ? strain + ((s - SLACK) / STRAIN) * dt : Math.max(0, strain - EASE * dt);
      if (strain >= 1) m.fail(`SNAP! The rope went at ${Math.round(s)} m apart.`);
      const bar = Math.round(strain * 10);
      m.board([{ title: 'Tow rope', rows: [
        { text: 'Spread', note: `${Math.round(s)} m`, colour: s > SLACK ? '#ff6b6b' : '#8dff6a' },
        { text: 'Strain', note: '█'.repeat(bar) + '░'.repeat(10 - bar), colour: strain > 0.6 ? '#ff4040' : '#ffd23d' },
      ] }]);
    });
    for (const [i, id] of COURSE.entries()) {
      const cp = m.place(id);
      await m.goTo(cp, { radius: 14, inCar: true, everyone: m.players, label: `All of you through ${cp.name} (${i + 1} of ${COURSE.length})` });
      if (i < COURSE.length - 1) m.say(`Convoy through ${cp.name}. ${formatTime(m.elapsed)}`, 2);
    }
    m.succeed(`Convoy home in ${formatTime(m.elapsed)}. Widest you got: ${Math.round(worst)} m.`);
  },
});
