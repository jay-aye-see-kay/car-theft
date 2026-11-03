import { defineMission } from './runtime/mission.ts';
import { along, every } from './runtime/kit.ts';

// Odd jobs, one to four (the slow-down levels every racing game sneaks in): an
// ice cream round through Freemans Bay. Kids wait on the kerb ahead; pull up
// beside one and stop for a moment to serve them. Too fast with the freezer
// open and the stock melts. Each kid only waits so long.

const FROM = { x: -836, z: 1830 };
const TO = { x: -1005, z: 2258 };
const KIDS = 10;
/** Kids stand this far off the centreline, m; serve within this, stopped (under this, km/h) for this long, s. */
const SIDE = 6;
const SERVE = { reach: 8, stopped: 4, hold: 1.2 };
/** Faster than this and the ice cream melts, a cone every this many seconds over it. */
const MELT = { kmh: 45, every: 3 };
const STOCK = 14;
const PATIENCE = 50;

export default defineMission({
  id: 'ice-cream-van',
  title: 'Hokey Pokey Run',
  blurb: 'Kids on the kerb. Stop, serve, go. Don\'t melt the stock.',
  players: { min: 1, max: 4 },
  start: 'dacre-reserve',
  needsCar: true,

  async run(m) {
    const line = m.route(FROM, TO) ?? m.route(TO, FROM);
    if (!line) return m.fail('No road for the van. The kids cry.');
    const total = line.reduce((s, p, i) => (i ? s + Math.hypot(p.x - line[i - 1].x, p.z - line[i - 1].z) : 0), 0);
    const spots = along(line, Math.max(30, (total - 40) / KIDS), 30).slice(0, KIDS);
    // Kids on the left kerb (we drive on the left): left of travel is (dz, -dx).
    const kids = spots.map((p) => ({ x: p.x + p.dz * SIDE, z: p.z - p.dx * SIDE, prop: null as ReturnType<typeof m.prop> | null, from: 0, wait: 0, done: false }));
    let stock = STOCK;
    let served = 0;
    let missed = 0;
    let fast = 0;
    let next = 0;
    const solo = m.players.length === 1;
    m.say(`${STOCK} cones in the freezer, kids all down the road. Pull up next to each one and stop to serve. Gently: speed melts the stock.`, 6);
    every(m, 0.1, (dt) => {
      const now = m.elapsed;
      // Two kids waiting at a time, in order down the road.
      while (next < kids.length && kids.filter((k) => k.prop).length < 2) {
        const k = kids[next++];
        k.prop = m.prop(k, { style: 'gem', radius: SERVE.reach, colour: '#ff9bd2', label: 'A kid', onFoot: false });
        k.from = now;
      }
      for (const k of kids) {
        if (!k.prop) continue;
        const stopped = k.prop.who().some((p) => p.speedKmh < SERVE.stopped);
        k.wait = stopped ? k.wait + dt : 0;
        if (k.wait >= SERVE.hold && stock > 0) {
          k.prop.remove();
          k.prop = null;
          k.done = true;
          stock--;
          served++;
          m.say(['"Hokey pokey please!"', '"Can I have sprinkles?"', '"Mum said I can have TWO."', '"Is it free?"', '"Strawberry. No. Chocolate. No..."'][served % 5], 2);
        } else if (now - k.from > PATIENCE) {
          k.prop.remove();
          k.prop = null;
          k.done = true;
          missed++;
          m.say('A kid gave up and went home.', 2);
        }
      }
      if (m.players.some((p) => p.driving && p.speedKmh > MELT.kmh)) {
        fast += dt;
        if (fast >= MELT.every) {
          fast = 0;
          stock = Math.max(0, stock - 1);
          m.say('Too fast! A cone melted.', 2);
        }
      } else fast = 0;
      m.board([{ title: 'Ice cream round', rows: [
        { text: 'Served', note: `${served} of ${KIDS}`, colour: '#ff9bd2' },
        { text: 'In the freezer', note: String(stock), colour: stock < 3 ? '#ff5050' : '#bfe6ff' },
        { text: 'Gave up', note: String(missed) },
      ] }]);
    });
    await m.waitFor(() => kids.every((k) => k.done) || (stock === 0 && served + missed < KIDS), solo ? 'Serve the kids along the road' : 'Serve the kids (any van will do)');
    if (served >= 7) m.succeed(`${served} kids served, ${stock} cones left. You're a legend on this street.`);
    m.fail(stock === 0 ? 'Out of ice cream. The kids turn on you.' : `Only ${served} served. Word gets round: the van's no good.`);
  },
});
