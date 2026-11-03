import { defineMission, type MissionPlayer } from './runtime/mission.ts';
import { along, every, scoreRows } from './runtime/kit.ts';

// Driving, one or more (Burnout's speed cameras, Forza's speed traps): a line
// of speed cameras along Quay Street and out Tāmaki Drive. Through each at
// 70 or more and it flashes: a point, for each of you once per camera. Most
// flashes when the clock runs out wins. The cops do notice.

const FROM = { x: 100, z: -40 };
const TO = { x: 1700, z: 400 };
const LIMIT = 70;
const CAMERAS = 12;
const SECONDS = 150;

export default defineMission({
  id: 'speed-trap',
  title: 'Speed Trap',
  blurb: 'Speed cameras. Flash them all. 70 or it doesn\'t count.',
  players: { min: 1, max: 6 },
  start: 'new-zealand-post',
  needsCar: true,

  async run(m) {
    const line = m.route(FROM, TO);
    if (!line) return m.fail('The road went missing. Blame the council.');
    const total = line.reduce((s, p, i) => (i ? s + Math.hypot(p.x - line[i - 1].x, p.z - line[i - 1].z) : 0), 0);
    const spots = along(line, (total - 120) / (CAMERAS - 1), 80).slice(0, CAMERAS);
    const cams = spots.map((p) => ({ prop: m.prop(p, { style: 'pad', radius: 8, colour: '#ff5050', label: 'Speed camera', onFoot: false }), flashed: new Set<number>() }));
    const flashes = new Map<number, number>();
    const together = m.players.length > 1;
    m.say(`${CAMERAS} speed cameras along the waterfront. Through each at ${LIMIT}+ for a flash.`, 5);
    for (const n of ['3', '2', '1']) {
      m.say(n, 1);
      await m.wait(1);
    }
    m.say('Go!', 1.5);
    const clock = m.countdown(SECONDS);
    every(m, 1 / 30, () => {
      for (const c of cams) {
        for (const p of c.prop.who()) {
          if (c.flashed.has(p.id)) continue;
          if (p.speedKmh < LIMIT) continue;
          c.flashed.add(p.id);
          flashes.set(p.id, (flashes.get(p.id) ?? 0) + 1);
          m.say(`FLASH! ${together ? p.name + ' at ' : ''}${Math.round(p.speedKmh)} km/h.`, 1.5);
          if ((p.heat ?? 0) < 1) m.setHeat(1, [p]);
        }
      }
      // Each camera dims once everyone has flashed it.
      for (const c of cams) if (m.players.every((p) => c.flashed.has(p.id))) c.prop.setColour('#552222');
      m.board([{ title: 'Flashes', rows: scoreRows(m.players, (p) => flashes.get(p.id) ?? 0, ` of ${CAMERAS}`) }]);
    });
    const done = () => m.players.every((p) => (flashes.get(p.id) ?? 0) >= CAMERAS);
    await m.waitFor(() => clock.seconds <= 0 || done(), `Flash the speed cameras (${LIMIT}+ km/h)`);
    clock.stop();
    const score = (p: MissionPlayer) => flashes.get(p.id) ?? 0;
    const best = [...m.players].sort((a, b) => score(b) - score(a))[0];
    if (together) m.succeed(`${best.name} wins with ${score(best)} flashes. Expect the fines in the post.`);
    if (score(best) >= CAMERAS / 2) m.succeed(`${score(best)} of ${CAMERAS} flashed. The fines will be framed.`);
    m.fail(`Only ${score(best)} of ${CAMERAS}. Was that a bus lane, or were you just slow?`);
  },
});
