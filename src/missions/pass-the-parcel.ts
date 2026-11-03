import { defineMission, formatTime, type MissionPlayer } from './runtime/mission.ts';
import { dist, every, spot, stepTowards } from './runtime/kit.ts';

// Heists & getaways, for two or more: a relay. The taxman is after the bag of
// cash, a flashing light that homes in on whoever's carrying it, a touch
// slower than a sprint and never tired. Hand it on (run up to a mate) and he
// loses track for a moment. No cars: get in one and you drop it. Three times
// he catches the bag and it's his. Along Quay Street to the Viaduct.

const FROM = spot('parcel-start', 'the ferry terminal', -40, -150);
const SAFEHOUSE = spot('parcel-safehouse', 'the safehouse', -673, -165);
/** The taxman, m/s: between a jog (4.6) and a sprint (7.2). */
const SPEED = 6.2;
/** He catches the bag within this, m. */
const CATCH = 1.8;
/** A mate this close takes the bag, m. */
const PASS = 3;
/** After a hand-off he stands confused for this long, s; the one who passed can't take it straight back for this. */
const DAZED = 2.5;
const NO_TAKE_BACKS = 2;
const STRIKES = 3;

export default defineMission({
  id: 'pass-the-parcel',
  title: 'Pass the Parcel',
  blurb: 'The taxman wants the bag. Hand it on, keep running.',
  players: { min: 2, max: 6 },
  start: 'downtown-ferry-terminal',

  async run(m) {
    const bag = m.prop(FROM, { style: 'gem', colour: '#ffd23d', label: 'The bag', radius: 2 });
    const taxman = { x: FROM.x + 45, z: FROM.z - 15 };
    const light = m.prop(taxman, { style: 'siren', radius: CATCH, label: 'The taxman' });
    let holder: MissionPlayer | null = null;
    let dazed = 3;
    let strikes = 0;
    let passedBy = -1;
    let passedAt = -Infinity;
    const passes = new Map<string, number>();
    m.say("There's the bag. The taxman's coming for it. Grab it and hand it on before he catches you. No cars!", 6);
    m.timer(200, 'The taxman got bored and audited you instead.');
    const drop = () => {
      bag.carry(null);
      holder = null;
    };
    every(m, 1 / 30, (dt) => {
      const h = holder ? m.players.find((p) => p.id === holder!.id) : undefined;
      if (holder && !h) drop(); // they left the room
      if (h?.driving) {
        m.say(`${h.name} tried to drive off with it. It fell out the door.`, 3);
        drop();
      }
      if (!holder) {
        const who = bag.who().find((p) => !p.driving && !(p.id === passedBy && m.elapsed - passedAt < NO_TAKE_BACKS));
        if (who) {
          holder = who;
          bag.carry(who);
        }
      } else {
        const mate = m.players.find((p) => p.id !== h!.id && !p.driving && dist(p, h!) < PASS && !(p.id === passedBy && m.elapsed - passedAt < NO_TAKE_BACKS));
        if (mate) {
          passes.set(h!.name, (passes.get(h!.name) ?? 0) + 1);
          passedBy = h!.id;
          passedAt = m.elapsed;
          holder = mate;
          bag.carry(mate);
          dazed = DAZED;
        }
      }
      // The taxman: after the bag, wherever it is.
      if (dazed > 0) dazed -= dt;
      else stepTowards(taxman, bag, SPEED, dt);
      light.move(taxman.x, taxman.z);
      if (dazed <= 0 && dist(taxman, bag) < CATCH) {
        strikes++;
        const who = holder?.name;
        drop();
        if (strikes >= STRIKES) m.fail('The taxman took the bag. Three strikes. Should have filed on time.');
        m.say(`${who ? `He snatched it off ${who}` : 'He got to the bag'}! He drops it in shock. ${STRIKES - strikes} more and it's his.`, 4);
        // He's staggered back a bit.
        taxman.x += (taxman.x - SAFEHOUSE.x) > 0 ? 25 : -25;
        dazed = DAZED;
      }
      m.board([{ title: 'Pass the Parcel', rows: [
        { text: 'The bag', note: holder?.name ?? 'on the ground', colour: '#ffd23d' },
        { text: 'Taxman', note: dazed > 0 ? 'confused' : `${Math.round(dist(taxman, bag))} m behind`, colour: '#ff6b6b' },
        { text: 'Strikes', note: '✖'.repeat(strikes) || 'none', colour: '#ff6b6b' },
      ] }]);
    });
    m.beam(SAFEHOUSE);
    await m.waitFor(() => !!bag.carrier && dist(bag.carrier, SAFEHOUSE) < 7, 'Get the bag to the safehouse (no cars)');
    m.succeed(`Bag safe! ${formatTime(m.elapsed)}, ${[...passes.values()].reduce((a, b) => a + b, 0)} hand-offs, ${strikes} close shave${strikes === 1 ? '' : 's'}.`);
  },
});
