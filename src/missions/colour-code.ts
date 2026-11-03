import { defineMission, formatTime, type MissionPlayer } from './runtime/mission.ts';
import { every, shuffle, spot } from './runtime/kit.ts';

// Co-op puzzles, for two or more (Keep Talking and Nobody Explodes): the
// code shows only to whoever stands on the reader in Wynyard's plaza, and
// only while they stay on it. The coloured pads are over on the Silo Park
// lawn, round the corner, out of sight. Someone reads, someone runs, and you
// shout at each other. A wrong pad scrambles the code.

const READER = spot('code-reader', 'the code reader', -1213, -435);
const PADS = [
  { name: 'RED', colour: '#ff4646', x: -1186, z: -534 },
  { name: 'GREEN', colour: '#5dff6a', x: -1168, z: -534 },
  { name: 'BLUE', colour: '#4f8bff', x: -1195, z: -507 },
  { name: 'YELLOW', colour: '#ffe23d', x: -1177, z: -507 },
] as const;
/** Code lengths, one per round. */
const ROUNDS = [3, 4, 5];

export default defineMission({
  id: 'colour-code',
  title: 'Colour Code',
  blurb: 'One reads, one runs. Shout a lot.',
  players: { min: 2, max: 4 },
  start: spot('colour-code-start', 'Wynyard plaza', -1205, -425),

  async run(m) {
    const reader = m.prop(READER, { style: 'pad', colour: '#ffffff', radius: 2.2, label: 'Code reader', onFoot: true });
    const pads = PADS.map((p) => ({ ...p, prop: m.prop(p, { style: 'pad', colour: p.colour, radius: 2.2, label: `${p.name[0]}${p.name.slice(1).toLowerCase()} pad`, onFoot: true }) }));
    m.say('The code shows only to whoever stands on the white reader. The coloured pads are on the lawn round the corner. Talk to each other!', 7);
    m.timer(300, 'The safe locked itself for the night.');
    let scrambles = 0;
    for (const [round, length] of ROUNDS.entries()) {
      const code = () => Array.from({ length }, () => pads[Math.floor(m.rand() * pads.length)]);
      let want = shuffle(code(), m.rand);
      let got = 0;
      /** Who's on the reader: they see the code on their own board while they stay on. */
      let reading: MissionPlayer | null = null;
      /** Pads stood on: each counts once on stepping on. */
      const on = new Set<number>();
      const show = () => {
        const r = reader.who()[0] ?? null;
        if (reading && reading.id !== r?.id) m.secret(reading, null);
        reading = r;
        if (r) m.secret(r, { title: 'The code (only you can see it)', rows: want.map((p, i) => ({ text: `${i + 1}. ${p.name}`, colour: p.colour, done: i < got })) });
      };
      m.say(`Round ${round + 1}: ${length} colours.`, 3);
      every(m, 1 / 20, () => {
        if (got >= length) return;
        show();
        for (const [i, p] of pads.entries()) {
          const there = p.prop.who().filter((q) => q.id !== reading?.id);
          if (!there.length) {
            on.delete(i);
            continue;
          }
          if (on.has(i)) continue;
          on.add(i);
          if (!reading) {
            m.say('Nothing happens. Nobody is on the reader.', 2);
            continue;
          }
          if (p === want[got]) {
            got++;
            m.say(`${p.name}. ${got} of ${length}.`, 2);
          } else {
            scrambles++;
            got = 0;
            want = shuffle(code(), m.rand);
            m.say(`${p.name}? Wrong! The code scrambles.`, 3);
          }
        }
        m.board([{ title: `Colour Code: round ${round + 1} of ${ROUNDS.length}`, rows: [
          { text: 'Reader', note: reading?.name ?? 'nobody', colour: '#ffffff' },
          { text: 'Entered', note: '●'.repeat(got) + '○'.repeat(length - got), colour: '#ffe23d' },
          { text: 'Scrambles', note: String(scrambles) },
        ] }]);
      });
      await m.waitFor(() => got >= length, 'Read the code, enter the code');
      if (reading) m.secret(reading, null);
      await m.wait(1);
    }
    m.succeed(`Safe cracked in ${formatTime(m.elapsed)} with ${scrambles} scramble${scrambles === 1 ? '' : 's'}. Inside: the wifi password.`);
  },
});
