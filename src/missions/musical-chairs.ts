import { defineMission, type MissionPlayer } from './runtime/mission.ts';
import { every, shuffle, spot } from './runtime/kit.ts';

// Party games, two or more: musical chairs on the Silo Park lawn. While the
// music plays, keep moving inside the ring of chairs (stand still and you're
// out). When it stops, the chairs light up: one fewer than there are of you.
// First on a chair keeps it; whoever's left standing is out. Last one in wins.

const C = { x: -1190, z: -505 };
const SEATS = 8;
const R = 10;
const SEAT_R = 1.6;

export default defineMission({
  id: 'musical-chairs',
  title: 'Musical Chairs',
  blurb: 'The music stops. Find a chair. Don\'t be last.',
  players: { min: 2, max: 6 },
  start: spot('chairs-start', 'Silo Park', C.x + 30, C.z - 5),

  async run(m) {
    const ring = Array.from({ length: SEATS }, (_, i) => ({ x: C.x + R * Math.cos((i / SEATS) * Math.PI * 2), z: C.z + R * Math.sin((i / SEATS) * Math.PI * 2) }));
    const circle = m.prop(C, { style: 'pad', radius: R + 4, colour: '#4a3a6a', label: 'Musical chairs' });
    let alive: MissionPlayer[] = [...m.players];
    let round = 0;
    const still = new Map<number, number>();
    m.say('Into the circle! Keep moving while the music plays. When it stops, grab a chair.', 5);
    await m.waitFor(() => alive.every((p) => circle.who().some((q) => q.id === p.id)), 'Everyone into the circle');
    while (alive.length > 1) {
      round++;
      // The music: keep moving. Players who left the room drop out.
      const music = 6 + m.rand() * 6;
      const until = m.elapsed + music;
      still.clear();
      m.say('♪ ♫ la la la ♪ ♫', music);
      m.objective('Keep moving!');
      let lazy: MissionPlayer | null = null;
      let prev = m.elapsed;
      await m.waitFor(() => {
        const dt = m.elapsed - prev;
        prev = m.elapsed;
        alive = alive.filter((p) => m.players.some((q) => q.id === p.id));
        for (const p of m.players.filter((q) => alive.some((a) => a.id === q.id))) {
          still.set(p.id, p.speedKmh < 3 ? (still.get(p.id) ?? 0) + dt : 0);
          if ((still.get(p.id) ?? 0) > 3) lazy = p;
        }
        return m.elapsed >= until || !!lazy || alive.length < 2;
      });
      if (alive.length < 2) break;
      if (lazy) {
        const l: MissionPlayer = lazy;
        alive = alive.filter((p) => p.id !== l.id);
        m.say(`${l.name} stood still during the music. Out!`, 3);
        await m.wait(2);
        continue;
      }
      // The music stops: chairs for all but one.
      const seats = shuffle(ring, m.rand).slice(0, alive.length - 1).map((s) => ({ prop: m.prop(s, { style: 'pad', radius: SEAT_R, colour: '#ffc23d', onFoot: true }), by: -1 }));
      m.say('The music stops! SIT!', 2);
      const sat = () => seats.filter((s) => s.by >= 0).length;
      const watcher = { done: false };
      every(m, 1 / 30, () => {
        if (watcher.done) return;
        for (const s of seats) {
          const p = s.prop.who(alive).find((q) => !seats.some((t) => t.by === q.id));
          if (s.by < 0 && p) {
            s.by = p.id;
            s.prop.setColour('#6aff7a');
          }
        }
      });
      await m.waitFor(() => sat() >= seats.length, 'Grab a chair!');
      watcher.done = true;
      const loser = alive.find((p) => !seats.some((s) => s.by === p.id))!;
      alive = alive.filter((p) => p.id !== loser.id);
      m.say(`${loser.name} is left standing. Out!`, 3);
      for (const s of seats) s.prop.remove();
      m.board([{ title: `Round ${round}`, rows: m.players.map((p) => ({ text: p.name, note: alive.some((a) => a.id === p.id) ? 'in' : 'out', done: !alive.some((a) => a.id === p.id) })) }]);
      await m.wait(2.5);
    }
    const winner = alive[0];
    m.succeed(winner ? `${winner.name} wins Musical Chairs! The prize: a chair.` : 'Everyone left. The chairs win.');
  },
});
