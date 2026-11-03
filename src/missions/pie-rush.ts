import { defineMission, type MissionPlayer } from './runtime/mission.ts';
import type { Place } from './runtime/places.ts';
import { dist, every, scoreRows } from './runtime/kit.ts';

// Odd jobs, for two or more (Overcooked): Big Kev's lunch rush. Orders come
// in from round about; each wants a pie before it goes cold. Pick one up at
// the counter (one pie each, you've only got two hands), run or drive it
// over. Too many cold orders and Kev sacks the lot of you.

const SHOP = 'big-kevs-loaves';
const PIES = ['mince', 'steak and cheese', 'butter chicken', 'mince and cheese', 'potato top', 'vege (for Craig)', 'bacon and egg', 'pepper steak'];
/** An order waits this long, s; a new one every so often while there are fewer than MAX. */
const PATIENCE = 75;
const EVERY = 14;
const MAX = 3;
const SECONDS = 180;
const STRIKES = 3;

interface Order {
  at: Place;
  pie: string;
  until: number;
  done: boolean;
}

export default defineMission({
  id: 'pie-rush',
  title: 'Pie Rush',
  blurb: "Big Kev's lunch rush. One pie each. Go go go.",
  players: { min: 2, max: 4 },
  start: SHOP,

  async run(m) {
    const shop = m.place(SHOP);
    const counter = m.prop(shop, { style: 'pad', radius: 3, colour: '#ffb347', label: "Kev's counter" });
    const carrying = new Map<number, { pie: string; prop: ReturnType<typeof m.prop> }>();
    const orders: Order[] = [];
    const served = new Map<number, number>();
    let strikes = 0;
    let nextAt = m.elapsed;
    let delivered = 0;
    const beams = new Map<Order, () => void>();
    m.say("Lunch rush! Orders come in, grab a pie from Kev's counter, take it over before it goes cold. One pie each.", 6);
    const clock = m.countdown(SECONDS);
    every(m, 0.1, () => {
      const now = m.elapsed;
      const open = orders.filter((o) => !o.done);
      if (open.length < MAX && now >= nextAt) {
        const at = m.random('cafe', { near: shop, within: 320, except: [shop, ...open.map((o) => o.at)] }) ?? m.random('restaurant', { near: shop, within: 400 })!;
        const o = { at, pie: PIES[Math.floor(m.rand() * PIES.length)], until: now + PATIENCE, done: false };
        orders.push(o);
        beams.set(o, m.beam(at));
        nextAt = now + EVERY;
        m.say(`Order in: a ${o.pie} for ${at.name}!`, 3);
      }
      // Pies from the counter: one each.
      for (const p of counter.who()) {
        if (carrying.has(p.id)) continue;
        const want = open.find((o) => ![...carrying.values()].some((c) => c.pie === o.pie)) ?? open[0];
        const pie = want?.pie ?? PIES[0];
        const prop = m.prop(shop, { style: 'gem', colour: '#ffb347', radius: 2 });
        prop.carry(p);
        carrying.set(p.id, { pie, prop });
      }
      // Deliveries: any pie does, Kev's customers aren't fussy.
      for (const o of open) {
        const p = m.players.find((q) => carrying.has(q.id) && dist(q, o.at) < 8);
        if (p) {
          o.done = true;
          delivered++;
          served.set(p.id, (served.get(p.id) ?? 0) + 1);
          carrying.get(p.id)!.prop.remove();
          carrying.delete(p.id);
          beams.get(o)?.();
          m.say(`${p.name} delivered to ${o.at.name}. "Ta, bro."`, 2.5);
        } else if (now > o.until) {
          o.done = true;
          strikes++;
          beams.get(o)?.();
          if (strikes >= STRIKES) m.fail(`Three cold orders. Kev sacks the lot of you. "And don't come back!"`);
          m.say(`Too slow! ${o.at.name} cancelled. Strike ${strikes} of ${STRIKES}.`, 3);
        }
      }
      for (const [id, c] of carrying) if (!m.players.some((p) => p.id === id)) {
        c.prop.remove();
        carrying.delete(id);
      }
      m.board([
        { title: `Orders (${delivered} delivered)`, rows: orders.filter((o) => !o.done).map((o) => ({ text: `${o.pie}: ${o.at.name}`, note: `${Math.ceil(o.until - now)} s`, colour: o.until - now < 20 ? '#ff5050' : '#ffd23d' })) },
        { title: 'Delivered', rows: scoreRows(m.players, (p: MissionPlayer) => served.get(p.id) ?? 0) },
        { rows: [{ text: 'Strikes', note: '✖'.repeat(strikes) || 'none', colour: '#ff6b6b' }] },
      ]);
    });
    await m.waitFor(() => clock.seconds <= 0, 'Pies from the counter to the orders');
    clock.stop();
    if (delivered >= 5) m.succeed(`${delivered} pies delivered. Kev nods. That's as good as it gets from Kev.`);
    m.fail(`${delivered} pies. Kev's seen faster pigeons.`);
  },
});
