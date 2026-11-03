import { defineMission, formatTime } from './runtime/mission.ts';
import { every } from './runtime/kit.ts';

// Heists & getaways (GTA). Grab a tray of pies, and every cop in town wants a
// word: the whole crew gets two stars at once. Lose them (everyone at zero),
// then fence the pies at the rival bakery, still clean. Anyone caught and the
// pies are confiscated.

const LOCKUP = 'jonos-bakery';

export default defineMission({
  id: 'pie-heist',
  title: 'The Great Pie Heist',
  blurb: "Nick the steak 'n' cheese. Lose the cops. Fence them at Jono's.",
  players: { min: 1, max: 4 },
  start: 'honest-hones-pies',

  async run(m) {
    const shop = m.place('honest-hones-pies');
    const crew = m.players.length > 1;
    m.say(crew ? 'Hone keeps a tray of pies on the counter. One of you grab it. The rest of you, look innocent.' : 'Hone keeps a tray of pies on the counter. Grab it and run.', 5);
    m.objective('Grab the pies');
    // On the counter by the door: the shop itself is indoors, the marker out on the road.
    const counter = { x: shop.x + (shop.at.x - shop.x) * 0.4, z: shop.z + (shop.at.z - shop.z) * 0.4 };
    const grabber = await m.pickup(counter, { colour: '#ffb347', label: 'The pies', radius: 1.5 });
    m.setHeat(2);
    // The game gives the stars on the next tick (or not at all with the cops switched off).
    const grabbed = m.elapsed;
    await m.waitFor(() => m.players.some((p) => (p.heat ?? 0) > 0) || m.elapsed - grabbed > 1);
    m.say(crew ? `${grabber.name} has the pies! Every cop in town wants a word with all of you.` : 'Pies acquired. Every cop in town wants a word.', 4);
    m.timer(300, 'The pies went cold. Nobody fences a cold pie.');
    m.failIf(() => m.players.some((p) => p.caught), 'Caught! The pies are evidence now. Someone at the station is eating them.');
    const wanted = () => m.players.filter((p) => (p.heat ?? 0) > 0);
    const board = () => m.board([{ title: 'Wanted', rows: m.players.map((p) => ({ text: crew ? p.name : 'You', note: (p.heat ?? 0) > 0 ? '★'.repeat(p.heat ?? 0) : 'clean', colour: (p.heat ?? 0) > 0 ? '#ff6b6b' : '#8dff6a' })) }]);
    every(m, 0.25, board);
    while (wanted().length) {
      m.objective(crew ? `Lose the cops: ${wanted().length} of you still wanted` : 'Lose the cops');
      await m.wait(0.25);
    }
    const lockup = m.place(LOCKUP);
    m.say(`They've lost you. Now get those pies to ${lockup.name}. Quietly.`, 4);
    // Arriving with heat doesn't count: Jono won't open the back door with sirens outside.
    for (;;) {
      await m.goTo(lockup, { radius: 8, label: `Take the pies to ${lockup.name}` });
      if (!wanted().length) break;
      m.say("Jono won't open up with the cops about. Lose them first!", 4);
      await m.waitFor(() => !wanted().length, `Lose the cops, then back to ${lockup.name}`);
    }
    m.succeed(`Pies fenced for $40 and a free sausage roll. ${formatTime(m.elapsed)}.`);
  },
});
