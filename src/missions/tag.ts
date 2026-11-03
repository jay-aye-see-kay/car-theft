import { defineMission, type MissionPlayer } from './runtime/mission.ts';
import { dist, every, PLAYER_COLOURS, scoreRows, spot } from './runtime/kit.ts';

// Party games, two or more: tag in Victoria Park. Whoever's it has a siren
// over their head; touch someone to pass it on (no tag-backs for a moment).
// On foot only: in a car or out of the park, the clock runs as if you're it.
// Two minutes; least time as it wins.

const PARK = { x: -1135, z: 280, r: 55 };
const TOUCH = 2.2;
const NO_TAG_BACKS = 3;
const SECONDS = 120;

export default defineMission({
  id: 'tag',
  title: "You're It!",
  blurb: 'Tag in Victoria Park. On foot. No tag-backs.',
  players: { min: 2, max: 6 },
  start: spot('tag-start', 'Victoria Park', -1180, 232),

  async run(m) {
    const it = { id: m.players[Math.floor(m.rand() * m.players.length)].id, since: -Infinity, from: -1 };
    const siren = m.prop({ x: 0, z: 0 }, { style: 'siren', radius: TOUCH });
    const edge = m.prop(PARK, { style: 'pad', radius: PARK.r, colour: '#2a5a3a' });
    const itTime = new Map<number, number>();
    const tags = new Map<number, number>();
    const who = (id: number) => m.players.find((p) => p.id === id);
    const out = (p: MissionPlayer) => p.driving || dist(p, PARK) > PARK.r;
    siren.carry(who(it.id) ?? null);
    m.say(`${who(it.id)?.name} is it! Everyone in the park, on foot. Run!`, 4);
    const clock = m.countdown(SECONDS);
    every(m, 1 / 30, (dt) => {
      if (!who(it.id)) {
        it.id = m.players[0].id; // they left: someone else is it
        siren.carry(who(it.id) ?? null);
      }
      for (const p of m.players) if (p.id === it.id || out(p)) itTime.set(p.id, (itTime.get(p.id) ?? 0) + dt);
      const chaser = who(it.id)!;
      if (!out(chaser)) {
        const caught = m.players.find((p) => p.id !== chaser.id && !out(p) && dist(p, chaser) < TOUCH && !(p.id === it.from && m.elapsed - it.since < NO_TAG_BACKS));
        if (caught) {
          tags.set(chaser.id, (tags.get(chaser.id) ?? 0) + 1);
          it.from = chaser.id;
          it.since = m.elapsed;
          it.id = caught.id;
          siren.carry(caught);
          m.say(`${chaser.name} got ${caught.name}! ${caught.name}'s it!`, 2.5);
        }
      }
      m.board([{ title: `It: ${who(it.id)?.name}`, rows: scoreRows(m.players, (p) => itTime.get(p.id) ?? 0, ' s it', true).map((r, i) => ({ ...r, colour: PLAYER_COLOURS[i % PLAYER_COLOURS.length] })) }]);
      edge.setColour(out(m.player) ? '#5a2a2a' : '#2a5a3a');
    });
    await m.waitFor(() => clock.seconds <= 0, 'Tag! Least time as it wins');
    clock.stop();
    const ranked = [...m.players].sort((a, b) => (itTime.get(a.id) ?? 0) - (itTime.get(b.id) ?? 0));
    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    m.succeed(`${best.name} wins, only ${Math.round(itTime.get(best.id) ?? 0)} s as it. ${worst.name} buys the ice creams.`);
  },
});
