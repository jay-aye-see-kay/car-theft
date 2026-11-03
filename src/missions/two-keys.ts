import { defineMission, formatTime } from './runtime/mission.ts';
import { every, spot } from './runtime/kit.ts';

// Co-op puzzles, for two or more (It Takes Two, Portal 2's co-op): two keys
// in a vault door, too far apart for one pair of hands. Pads on the Domain's
// big lawn that only count when they're all stood on at once. Each lock is
// meaner: further apart, then drifting in circles, then one pad for everyone
// in the room, held together.

const C = { x: 632, z: 1540 };
/** A lock: where its pads are at time t (s since the lock began), how long they must all be held at once, s. */
interface Lock {
  name: string;
  pads: (n: number, t: number) => { x: number; z: number }[];
  hold: number;
}
const LOCKS: Lock[] = [
  { name: 'First lock', hold: 0.1, pads: () => [{ x: C.x - 20, z: C.z - 40 }, { x: C.x + 20, z: C.z - 40 }] },
  { name: 'Second lock', hold: 0.1, pads: () => [{ x: C.x - 30, z: C.z - 70 }, { x: C.x + 35, z: C.z + 70 }] },
  {
    name: 'Drifting lock', hold: 3,
    pads: (_n, t) => [
      { x: C.x - 22 + 14 * Math.cos(t * 0.25), z: C.z + 14 * Math.sin(t * 0.25) },
      { x: C.x + 22 + 14 * Math.cos(-t * 0.25 + 1), z: C.z + 14 * Math.sin(-t * 0.25 + 1) },
    ],
  },
  {
    name: 'The big one', hold: 5,
    pads: (n) => Array.from({ length: n }, (_, i) => ({ x: C.x + 36 * Math.cos((i / n) * Math.PI * 2), z: C.z + 20 + 36 * Math.sin((i / n) * Math.PI * 2) })),
  },
];

export default defineMission({
  id: 'two-keys',
  title: 'Two Keys',
  blurb: 'Pads that only work when they all do. Find a friend.',
  players: { min: 2, max: 6 },
  start: spot('two-keys-start', 'the Domain lawn', C.x, C.z + 75),

  async run(m) {
    m.say('Old vault, two keys, one door. Stand on every gold pad at the same time.', 5);
    m.timer(300, 'The vault rusted shut. Try again with fewer arguments.');
    for (const [k, lock] of LOCKS.entries()) {
      const begun = m.elapsed;
      const n = Math.max(2, m.players.length);
      const pads = lock.pads(n, 0).map((p) => m.prop(p, { style: 'pad', radius: 2.5, label: 'Key pad', onFoot: true }));
      let held = 0;
      let prev = m.elapsed;
      m.say(k === 3 ? 'The big one: a pad for each of you. Hold them all together.' : k === 2 ? "This one won't sit still. Hold both for three seconds." : `${lock.name}: both pads at once.`, 4);
      every(m, 0.1, () => {
        if (pads[0].removed) return;
        const at = lock.pads(n, m.elapsed - begun);
        pads.forEach((p, i) => p.move(at[i].x, at[i].z));
      });
      await m.waitFor(() => {
        const on = pads.map((p) => p.who());
        const all = on.every((w) => w.length > 0) && new Set(on.flatMap((w) => w.map((p) => p.id))).size >= pads.length;
        held = all ? held + (m.elapsed - prev) : 0;
        prev = m.elapsed;
        pads.forEach((p, i) => p.setColour(on[i].length ? '#6aff7a' : '#ffc23d'));
        m.board([{ title: 'Vault', rows: LOCKS.map((l, i) => ({ text: l.name, done: i < k, note: i === k ? (l.hold > 0.5 ? `${Math.min(held, l.hold).toFixed(1)} / ${l.hold} s` : `${on.filter((w) => w.length).length} of ${pads.length} pads`) : undefined })) }]);
        return held >= lock.hold;
      }, `${lock.name}: stand on all the pads at once`);
      for (const p of pads) p.remove();
      m.say(k < LOCKS.length - 1 ? 'Clunk!' : 'CLUNK. The vault swings open.', 2);
      await m.wait(1.5);
    }
    m.succeed(`Inside: a 1974 tea towel and $6 in two-cent coins. ${formatTime(m.elapsed)}.`);
  },
});
