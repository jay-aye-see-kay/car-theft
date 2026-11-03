import { defineMission } from './runtime/mission.ts';
import { every, scoreRows, spot } from './runtime/kit.ts';

// Party games, two or more (Halo's King of the Hill): a gold ring in Aotea
// Square that moves every so often. A second for every second you're on it
// alone; two or more on it and nobody scores. Cars are allowed. So is ramming.
// First to a minute, or the most when the clock runs out.

const HILLS = [
  { x: -455, z: 905 },
  { x: -492, z: 876 },
  { x: -438, z: 930 },
  { x: -498, z: 936 },
  { x: -462, z: 862 },
];
const MOVE_EVERY = 20;
const WIN = 60;
const SECONDS = 180;

export default defineMission({
  id: 'king-of-the-hill',
  title: 'King of the Square',
  blurb: 'Hold the ring alone. Shove. Ram. Rule.',
  players: { min: 2, max: 6 },
  start: spot('koth-start', 'Aotea Square', -470, 960),

  async run(m) {
    let at = 0;
    const ring = m.prop(HILLS[0], { style: 'pad', radius: 6, label: 'The ring' });
    const score = new Map<number, number>();
    let moveAt = m.elapsed + MOVE_EVERY;
    let king = -1;
    m.say('Stand in the gold ring alone to score. Anything goes. Yes, cars.', 4);
    const clock = m.countdown(SECONDS);
    every(m, 0.1, (dt) => {
      if (m.elapsed >= moveAt) {
        at = (at + 1 + Math.floor(m.rand() * (HILLS.length - 1))) % HILLS.length;
        ring.move(HILLS[at].x, HILLS[at].z);
        moveAt = m.elapsed + MOVE_EVERY;
        m.say('The ring moved!', 2);
      }
      const on = ring.who();
      if (on.length === 1) {
        const p = on[0];
        score.set(p.id, (score.get(p.id) ?? 0) + dt);
        if (king !== p.id) m.say(`${p.name} holds the ring!`, 2);
        king = p.id;
      } else king = -1;
      ring.setColour(on.length === 1 ? '#6aff7a' : on.length > 1 ? '#ff5050' : '#ffc23d');
      m.board([{ title: `King of the Square (first to ${WIN})`, rows: scoreRows(m.players, (p) => score.get(p.id) ?? 0, ' s') }, { rows: [{ text: 'Ring moves in', note: `${Math.ceil(moveAt - m.elapsed)} s` }] }]);
    });
    await m.waitFor(() => clock.seconds <= 0 || m.players.some((p) => (score.get(p.id) ?? 0) >= WIN), 'Hold the ring alone');
    clock.stop();
    const best = [...m.players].sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0))[0];
    m.succeed(`${best.name} is King of the Square with ${Math.round(score.get(best.id) ?? 0)} s. Long may they reign (till the next round).`);
  },
});
