import { defineMission, formatTime } from './runtime/mission.ts';
import { every, spot } from './runtime/kit.ts';

// Co-op puzzles, solo: Lights Out on the Silo Park lawn. Stepping on a light
// flips it and its neighbours. Get them all lit for the night market. A ring
// of five first, then the classic three by three. Each starts from all lit
// with some flips made, so it can always be solved.

const C = { x: -1085, z: -490 };
const LIT = '#ffe58a';
const DARK = '#4a5599';

interface Puzzle {
  name: string;
  at: { x: number; z: number }[];
  /** Which lights stepping on light i flips (itself included). */
  flips: number[][];
  scramble: number;
}

const ring = (n: number, r: number): Puzzle => ({
  name: 'The ring',
  at: Array.from({ length: n }, (_, i) => ({ x: C.x + r * Math.sin((i / n) * Math.PI * 2), z: C.z - r * Math.cos((i / n) * Math.PI * 2) })),
  flips: Array.from({ length: n }, (_, i) => [(i + n - 1) % n, i, (i + 1) % n]),
  scramble: 2,
});

const grid = (step: number): Puzzle => {
  const at: { x: number; z: number }[] = [];
  const flips: number[][] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      at.push({ x: C.x + (c - 1) * step, z: C.z + (r - 1) * step });
      flips.push([[r, c], [r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].filter(([a, b]) => a >= 0 && a < 3 && b >= 0 && b < 3).map(([a, b]) => a * 3 + b));
    }
  }
  return { name: 'The grid', at, flips, scramble: 3 };
};

const PUZZLES = [ring(5, 10), grid(8)];

export default defineMission({
  id: 'fairy-lights',
  title: 'Fairy Lights',
  blurb: 'Step on a light, it flips its neighbours. Light them all.',
  start: spot('fairy-lights-start', 'the Silo Park lawn', C.x, C.z + 26),

  async run(m) {
    m.say("The night market's lights are on the blink. Stepping on one flips it and the ones next to it. Get them all lit.", 6);
    let steps = 0;
    for (const [k, pz] of PUZZLES.entries()) {
      const lit = pz.at.map(() => true);
      const flip = (i: number) => {
        for (const j of pz.flips[i]) lit[j] = !lit[j];
      };
      // Scramble from solved with distinct presses, never landing solved.
      do {
        const pressed = new Set<number>();
        while (pressed.size < pz.scramble) pressed.add(Math.floor(m.rand() * pz.at.length));
        for (const i of pressed) flip(i);
      } while (lit.every(Boolean));
      const pads = pz.at.map((p) => m.prop(p, { style: 'pad', radius: 2.4, colour: DARK, onFoot: true }));
      const on = new Set<number>();
      every(m, 1 / 20, () => {
        if (pads[0].removed) return;
        for (const [i, p] of pads.entries()) {
          if (!p.who().length) on.delete(i);
          else if (!on.has(i)) {
            on.add(i);
            flip(i);
            steps++;
          }
        }
        pads.forEach((p, i) => p.setColour(lit[i] ? LIT : DARK));
        m.board([{ title: `Fairy Lights: ${pz.name}`, rows: [{ text: 'Lit', note: `${lit.filter(Boolean).length} of ${lit.length}`, colour: LIT }, { text: 'Steps', note: String(steps) }] }]);
      });
      if (k) m.say('Now the big one.', 3);
      await m.waitFor(() => lit.every(Boolean), `${pz.name}: light them all`);
      await m.wait(1.2);
      for (const p of pads) p.remove();
    }
    const { best, isNew } = m.record(m.elapsed);
    m.succeed(`The night market glows. ${steps} steps, ${formatTime(m.elapsed)}${isNew ? ', a new best!' : `. Best ${formatTime(best)}.`}`);
  },
});
