import { defineMission } from './runtime/mission.ts';
import type { PlaceKind } from './runtime/places.ts';
import { dist } from './runtime/kit.ts';

// Driving (Crazy Taxi): fares wave you down nearby; pick them up, get them
// where they're going, and every drop buys more time on the meter. Faster
// drops tip better. Play till the clock runs out; three fares passes.

const KINDS: PlaceKind[] = ['cafe', 'bar', 'hotel', 'restaurant', 'theatre', 'gym'];
const FARES = [
  'a bloke in a suit who smells of pies',
  'a nana with a suitcase full of jam',
  'a uni student who is "definitely not late"',
  'a tourist with a hobbit map',
  'a guy holding a live crayfish',
  'a bride, alone, in a hurry',
  'a magician who will not stop',
  'two rugby fans, both singing',
];

export default defineMission({
  id: 'cabbie',
  title: 'Cabbie',
  blurb: 'Fares, fast. Every drop buys time.',
  start: 'albert-st',
  needsCar: true,

  async run(m) {
    m.say("You're a cab now. Don't ask. Pick up fares, drop them off, and the meter keeps running.", 5);
    const meter = m.countdown(60);
    let fares = 0;
    let cash = 0;
    const clock = () => meter.seconds;
    m.failIf(() => !m.player.driving, 'You got out of the cab. The fares walked.');
    let used = m.place('albert-st');
    for (;;) {
      const kind = KINDS[Math.floor(m.rand() * KINDS.length)];
      const pick = m.random(kind, { within: 350, near: m.player, except: [used] }) ?? m.random('cafe', { within: 600, near: m.player })!;
      const who = FARES[Math.floor(m.rand() * FARES.length)];
      m.board([{ title: 'Cabbie', rows: [{ text: 'Fares', note: String(fares) }, { text: 'Takings', note: `$${cash}`, colour: '#8dff6a' }] }]);
      const ok = await Promise.race([
        m.goTo(pick, { radius: 7, inCar: true, label: `Pick up ${who} at ${pick.name}` }).then(() => true),
        m.waitFor(() => clock() <= 0).then(() => false),
      ]);
      if (!ok) break;
      const dropKind = KINDS[Math.floor(m.rand() * KINDS.length)];
      const drop = m.random(dropKind, { within: 900, near: pick, except: [pick] }) ?? m.random('cafe', { within: 900, near: pick, except: [pick] })!;
      const far = dist(pick, drop);
      m.say(`In hops ${who}. "${drop.name}, and step on it."`, 4);
      const from = m.elapsed;
      const arrived = await Promise.race([
        m.goTo(drop, { radius: 7, inCar: true, label: `Take them to ${drop.name}` }).then(() => true),
        m.waitFor(() => clock() <= 0).then(() => false),
      ]);
      if (!arrived) break;
      const took = m.elapsed - from;
      // A tip for beating 30 km/h door to door.
      const quick = took < far / 8.3;
      const fare = Math.round(5 + far / 40) + (quick ? 10 : 0);
      fares++;
      cash += fare;
      meter.add(15 + far / 25);
      m.say(quick ? `$${fare} with a tip! "Never been so scared." +${Math.round(15 + far / 25)} s` : `$${fare}. No tip. +${Math.round(15 + far / 25)} s`, 3);
      used = drop;
    }
    meter.stop();
    if (fares >= 3) m.succeed(`Meter's off. ${fares} fares, $${cash}. Not bad for a stolen car.`);
    m.fail(`Meter's off. ${fares} fare${fares === 1 ? '' : 's'}, $${cash}. The cab company wants its car back.`);
  },
});
