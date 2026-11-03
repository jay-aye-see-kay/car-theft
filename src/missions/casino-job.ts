import { defineMission, formatTime } from './runtime/mission.ts';
import { dist, every, spot } from './runtime/kit.ts';

// Heists & getaways, for two or more (It Takes Two by way of GTA). The chips
// on Federal Street can only be lifted while the cameras are off, and the
// cameras are only off while someone stands on the switch. Halfway through
// the guard moves the switch to the other end of the street. Grab a chip
// with the cameras on and you're wanted. Then everyone to the getaway spot,
// with no cops on anyone.

/** Up Federal Street, the footpath under the casino. */
const CHIPS = [
  { x: -511, z: 473 },
  { x: -518, z: 494 },
  { x: -525, z: 522 },
  { x: -532, z: 543 },
  { x: -539, z: 564 },
  { x: -504, z: 452 },
];
/** The switch: at the top of the street, then the bottom. */
const SWITCHES = [spot('switch-top', 'the security switch', -507, 440), spot('switch-bottom', 'the security switch', -544, 585)];
const GETAWAY = spot('casino-getaway', 'the getaway spot', -470, 562);
const ON = '#ff4040';
const OFF = '#6aff7a';

export default defineMission({
  id: 'casino-job',
  title: 'The Casino Job',
  blurb: 'One on the switch, the rest on the chips. Cameras off, hands in.',
  players: { min: 2, max: 4 },
  start: 'casino',

  async run(m) {
    const pad = m.prop(SWITCHES[0], { style: 'pad', colour: '#ffc23d', label: 'Security switch', radius: 2.5, onFoot: true });
    const chips = CHIPS.map((c) => ({ ...c, prop: m.prop(c, { style: 'gem', colour: ON, radius: 2.2, label: 'Chip' }), by: '' }));
    let off = false;
    let alarms = 0;
    m.say('Somebody stand on the security switch to turn the cameras off. Everyone else, lift the chips. Only while the lights are green!', 7);
    m.timer(240, 'Security change shift. The new lot actually pay attention.');
    const left = () => chips.filter((c) => !c.by);
    every(m, 0.1, () => {
      const was = off;
      off = pad.who().length > 0;
      if (off !== was) for (const c of left()) c.prop.setColour(off ? OFF : ON);
      // Lift a chip: anyone on foot, not the one holding the switch.
      for (const c of left()) {
        const who = c.prop.who().find((p) => !p.driving && !pad.who().some((q) => q.id === p.id));
        if (!who) continue;
        c.by = who.name;
        c.prop.remove();
        if (!off) {
          alarms++;
          m.setHeat(Math.min(3, 1 + alarms), [who]);
          m.say(`Smile, ${who.name}! The cameras were on. Hope you like sirens.`, 4);
        } else m.say(`${who.name} lifted a chip. ${left().length} to go.`, 3);
      }
      m.board([{
        title: off ? 'Cameras: OFF' : 'Cameras: ON',
        rows: [
          { text: 'Switch', note: pad.who()[0]?.name ?? 'nobody', colour: off ? OFF : ON },
          ...chips.map((c, i) => ({ text: `Chip ${i + 1}`, note: c.by || undefined, done: !!c.by })),
        ],
      }]);
    });
    await m.waitFor(() => left().length <= CHIPS.length / 2, 'Lift the chips (cameras off!)');
    pad.move(SWITCHES[1].x, SWITCHES[1].z);
    m.say("The guard's moved the switch to the other end of the street! Someone get on it.", 5);
    await m.waitFor(() => left().length === 0, 'Lift the rest (the switch moved)');
    pad.remove();
    const wanted = () => m.players.filter((p) => (p.heat ?? 0) > 0);
    m.say(alarms ? 'All the chips! Now lose any cops and meet at the getaway spot.' : 'All the chips, and not one camera saw you. Now to the getaway spot.', 5);
    for (;;) {
      await m.goTo(GETAWAY, { radius: 8, everyone: m.players, label: wanted().length ? 'Lose the cops, then everyone to the getaway spot' : 'Everyone to the getaway spot' });
      if (!wanted().length) break;
      m.say('Not with the cops in tow! Lose them first.', 3);
      await m.waitFor(() => !wanted().length || m.players.some((p) => dist(p, GETAWAY) > 12), 'Lose the cops');
    }
    m.succeed(alarms ? `Six chips, ${alarms} alarm${alarms > 1 ? 's' : ''}. ${formatTime(m.elapsed)}. Sloppy, but rich.` : `Six chips, no alarms. ${formatTime(m.elapsed)}. Professionals.`);
  },
});
