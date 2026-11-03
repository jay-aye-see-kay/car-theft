import { defineMission, formatTime } from './runtime/mission.ts';
import { every, hotCold, nearestOf, scoreRows } from './runtime/kit.ts';

// Exploring, one or more (Breath of the Wild's Korok seeds): ten glowing
// seeds the kererū dropped round the Domain, mostly under the trees. Each
// only shows close up; a sensor on the board chirps hotter as you near the
// closest one left. All you need to know is on screen: no knowing the city.

const SEEDS = [
  { x: 500, z: 1470 }, { x: 530, z: 1500 }, { x: 560, z: 1530 }, { x: 520, z: 1560 }, { x: 540, z: 1610 },
  { x: 670, z: 1470 }, { x: 690, z: 1520 }, { x: 700, z: 1570 }, { x: 710, z: 1660 }, { x: 550, z: 1650 },
];
/** Seeds glint this close, m. */
const SEE = 30;
const SECONDS = 360;

export default defineMission({
  id: 'kereru-seeds',
  title: 'Kererū Seeds',
  blurb: 'Ten glowing seeds in the Domain. Follow the chirps.',
  players: { min: 1, max: 6 },
  start: 'pukekawa-auckland-domain',

  async run(m) {
    const seeds = SEEDS.map((s) => ({ ...s, prop: m.prop(s, { style: 'gem', colour: '#9dff5a', radius: 2.2, draw: SEE }), by: -1 }));
    const got = new Map<number, number>();
    const together = m.players.length > 1;
    m.say('A fat kererū dropped its seeds all over the Domain. They glint when you are close. The sensor chirps hotter as you near one.', 6);
    const clock = m.countdown(SECONDS);
    const left = () => seeds.filter((s) => s.by < 0);
    every(m, 0.1, () => {
      for (const s of left()) {
        const who = s.prop.who()[0];
        if (!who) continue;
        s.by = who.id;
        s.prop.remove();
        got.set(who.id, (got.get(who.id) ?? 0) + 1);
        m.say(`${together ? who.name + ' found a seed! ' : 'Yahaha! A seed. '}${left().length} left.`, 3);
      }
      m.board([
        { title: `Seeds: ${SEEDS.length - left().length} of ${SEEDS.length}`, rows: together ? scoreRows(m.players, (p) => got.get(p.id) ?? 0) : [] },
        {
          title: 'Sensor',
          rows: m.players.map((p) => {
            const { d } = nearestOf(p, left());
            const h = hotCold(d);
            return { text: together ? p.name : 'Chirp', note: h.word, colour: h.colour };
          }),
        },
      ]);
    });
    await m.waitFor(() => !left().length || clock.seconds <= 0, 'Find the kererū seeds');
    clock.stop();
    const n = SEEDS.length - left().length;
    if (n === SEEDS.length) {
      const { best, isNew } = m.record(m.elapsed);
      m.succeed(`All ten! The kererū gives you... a seed. ${formatTime(m.elapsed)}${isNew ? ', a new best!' : `. Best ${formatTime(best)}.`}`);
    }
    if (n >= 7) m.succeed(`${n} of ${SEEDS.length} seeds. The kererū is too full to care about the rest.`);
    m.fail(`${n} of ${SEEDS.length}. The kererū ate the rest.`);
  },
});
