import { defineMission } from './runtime/mission.ts';
import { along, every } from './runtime/kit.ts';

// Odd jobs, solo (Paperboy): the morning papers down Parnell Road. A
// letterbox every so often on one side or the other; drive past close on
// that side (cross over if you must) and the paper's in. A minute and a half.

const FROM = { x: 1038, z: 1147 };
const TO = { x: 1050, z: 2137 };
const BOXES = 20;
/** Letterboxes stand this far off the road's centreline, m, and take a paper within this. */
const SIDE = 5;
const REACH = 4;

export default defineMission({
  id: 'paper-round',
  title: 'Paper Round',
  blurb: 'Twenty letterboxes down Parnell Road. Both sides. Ninety seconds.',
  start: 'heard-park',
  needsCar: true,

  async run(m) {
    const line = m.route(FROM, TO);
    if (!line) return m.fail('Parnell Road has gone. Bad news for the papers.');
    const total = line.reduce((s, p, i) => (i ? s + Math.hypot(p.x - line[i - 1].x, p.z - line[i - 1].z) : 0), 0);
    const spots = along(line, (total - 60) / BOXES, 40).slice(0, BOXES);
    const boxes = spots.map((p, i) => {
      // Alternate sides, with the odd double on one side to keep you honest.
      const side = (i % 2 === 0) !== (i % 7 === 3) ? 1 : -1;
      // Right of the direction of travel is (-dz, dx) with z south and x east.
      const at = { x: p.x - p.dz * SIDE * side, z: p.z + p.dx * SIDE * side };
      return { prop: m.prop(at, { style: 'gem', radius: REACH, colour: '#f2efe6', onFoot: false }), got: false };
    });
    m.say('Morning papers, all the way down Parnell Road. Pass close to each letterbox. Both sides of the road!', 5);
    for (const n of ['3', '2', '1']) {
      m.say(n, 1);
      await m.wait(1);
    }
    m.say('Go!', 1.5);
    const clock = m.countdown(90);
    let got = 0;
    every(m, 1 / 30, () => {
      for (const b of boxes) {
        if (b.got || !b.prop.who().some((p) => p.speedKmh > 8)) continue;
        b.got = true;
        got++;
        b.prop.remove();
      }
      m.board([{ title: 'Papers', rows: [{ text: 'Delivered', note: `${got} of ${BOXES}`, colour: '#f2efe6' }] }]);
    });
    m.beam({ id: 'paper-end', name: 'the end of the round', kind: 'spot', street: '', x: spots[spots.length - 1].x, z: spots[spots.length - 1].z, at: spots[spots.length - 1] });
    await m.waitFor(() => clock.seconds <= 0 || got === BOXES, 'Deliver the papers: pass close to each letterbox');
    clock.stop();
    if (got === BOXES) m.succeed(`Every paper in, ${Math.round(90 - clock.seconds)} s. The neighbourhood is informed.`);
    if (got >= 15) m.succeed(`${got} of ${BOXES}. Mrs Patel will ring about hers.`);
    m.fail(`${got} of ${BOXES}. Parnell will be getting its news from the radio.`);
  },
});
