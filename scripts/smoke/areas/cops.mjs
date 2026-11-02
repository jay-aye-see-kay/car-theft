// The cops (#54, src/cops/): heat only from what a cop sees, a patrol car
// that comes along the road graph and tails you with its siren, being
// tackled or boxed in (a ticket, heat cleared), heat dropping out of sight
// and when you swap cars unseen, and spikes on the road ahead. Traffic is off
// and the ambient cops (on the beat, patrolling) are put out by hand, so
// every run reads the same.

/** Lower Queen St, heading up from Customs St (as in peds.mjs). */
const A = [-147, 113];
const B = [-245, 494];
const LEN = Math.hypot(B[0] - A[0], B[1] - A[1]);
const U = [(B[0] - A[0]) / LEN, (B[1] - A[1]) / LEN];
const HEADING = Math.atan2(-U[1], U[0]);
const along = (m, left = 0) => [A[0] + U[0] * m + U[1] * left, A[1] + U[1] * m - U[0] * left];

export default {
  name: 'cops',
  core: false,
  page: 'auckland',
  async run(t) {
    const { page, check, game, state, step, run, getIn, shot, dist } = t;
    /** Just the cops we put out (and no traffic to get in the way of the drive up Queen St). */
    const quiet = async () => {
      await game('knob', 'traffic.on', false);
      await game('knob', 'cops.beat', 0);
      await game('knob', 'cops.patrols', 0);
    };
    const cops = () => game('cops');

    /** Into the purple car on lower Queen St and up the road into someone standing in the lane. */
    const hitSomeone = async (before = async () => {}) => {
      await getIn();
      const [cx, cz] = along(40);
      await game('teleportCar', 0, cx, cz, HEADING);
      await step(30);
      await before();
      const id = await game('spawnPed', ...along(75), HEADING + Math.PI / 2);
      let flew = false;
      for (let i = 0; i < 120 && !flew; i++) {
        await page.keyboard.down('KeyW');
        await step(3);
        flew = (await game('peds')).list.find((p) => p.id === id)?.state === 'fly';
      }
      await page.keyboard.up('KeyW');
      await step(6);
      return flew;
    };

    // Unseen: nobody about, nobody minds.
    await quiet();
    let hit = await hitSomeone();
    let c = await cops();
    check(hit && c.heat === 0 && c.level === 0 && c.stats.unseenOffences >= 1 && c.stats.offences === 0,
      `hitting someone with no cop in sight: no heat (${c.heat.toFixed(2)}, ${c.stats.unseenOffences} unseen)`);

    // Seen: an officer on the footpath across the road, watching.
    await game('reset');
    await quiet();
    hit = await hitSomeone(async () => {
      const [ox, oz] = along(88, -9);
      check(await game('spawnCop', 'foot', ox, oz, HEADING + Math.PI, false), 'an officer stands watching on the footpath up the road');
    });
    c = await cops();
    check(hit && c.level >= 1 && c.stats.offences >= 1 && c.offence === 'ped',
      `the same hit in view of a cop: heat ${c.heat.toFixed(2)} (level ${c.level}, for "${c.offence}")`);
    await step(30);
    c = await cops();
    check(c.officers.some((o) => o.chasing), `and they come after you (${c.officers.map((o) => `${o.state}${o.bike ? ' on a bike' : ''}`).join(', ')})`);
    await shot('40-cop-sees');

    // Level 2 with nobody about: a patrol car comes from out of view along the roads to you on foot at the spawn.
    await game('reset');
    await quiet();
    await game('knob', 'cops.foot', 0);
    await step(5);
    check((await game('setHeat', 2)) === 2, 'heat straight to level 2');
    let first = null;
    let offRoad = 0;
    let closest = Infinity;
    let siren = false;
    let budget = null;
    let samples = 0;
    let s = await state();
    for (let i = 0; i < 270 && closest >= 15 && !s.caught; i++) {
      s = await step(10);
      c = await cops();
      const car = c.cars[0];
      if (!car) continue;
      samples++;
      first ??= { pos: car.pos, d: dist(car.pos, s.player), inView: await game('inView', [car.pos[0], car.pos[1] + 0.6, car.pos[2]]) };
      const road = await game('roadAt', car.pos[0], car.pos[2], 40);
      if (!road || road.dist - road.width / 2 > 2.5) offRoad++;
      closest = Math.min(closest, dist(car.pos, s.player));
      siren ||= car.siren;
    }
    check(!!first && first.d > 60 && !first.inView, `a patrol car appears out of view, ${first?.d.toFixed(0)} m off`);
    check(closest < 15 && offRoad <= 2 && siren, `it drives the roads to you with its siren on (${closest.toFixed(1)} m away; ${offRoad} of ${samples} samples off the road)`);

    // The chase in view on the street (from behind you, looking at the car): still inside the phone budget.
    await step(20);
    c = await cops();
    s = await state();
    const car = c.cars[0].pos;
    const back = [s.player[0] + (s.player[0] - car[0]) * 0.6, s.player[1] + 3, s.player[2] + (s.player[2] - car[2]) * 0.6];
    await game('lookFrom', back, car);
    await step(1);
    await game('draw');
    const b = await state();
    const parts = await game('breakdown');
    budget = { tris: b.triangles, calls: b.drawCalls };
    check(parts.police?.tris > 0 && budget.tris < 150000 && budget.calls < 60,
      `level-2 chase in view: ${(budget.tris / 1000).toFixed(0)}k triangles (< 150k), ${budget.calls} draw calls (< 60), its light bar drawn (${parts.police?.tris} triangles)`);
    await shot('41-patrol-car');
    await game('lookFrom', null, [0, 0, 0]);

    // On foot, it pulls up, out gets the officer, and you're tackled: caught.
    let tickets = (await cops()).tickets;
    ({ s } = await run({ max: 60 * 20, every: 5, until: (x) => x.caught }));
    c = await cops();
    const tackled = c.stats.tackles > 0;
    const line = c.scene?.line ?? '';
    check(s.caught && tackled && c.tickets === tickets + 1 && s.ticketShown && s.dizzy,
      `the officer gets out and tackles you: caught, dizzy, ticket ${c.tickets} ("${line}"; ${c.scene?.ticket})`);
    await shot('42-ticket');
    ({ s } = await run({ max: 60 * 15, every: 10, until: (x) => !x.caught }));
    c = await cops();
    check(!s.caught && !s.ticketShown && c.level === 0 && c.heat === 0 && c.cars.every((k) => !k.siren), `the talking-to ends: heat cleared, the slip gone, sirens off`);

    // In a car, stopped with a chase car alongside: boxed in.
    await game('reset');
    await quiet();
    await game('knob', 'cops.foot', 0);
    await getIn();
    await step(5);
    tickets = (await cops()).tickets;
    await game('setHeat', 2);
    // Pulled over on the handbrake (the spawn's on a slope).
    ({ s } = await run({ keys: ['Space'], max: 60 * 60, every: 10, until: (x) => x.caught }));
    c = await cops();
    check(s.caught && c.stats.boxedIn + c.stats.pulledOut === 1 && c.tickets === tickets + 1 && s.mode === 'foot',
      `sat in the car, a patrol car pulls up: caught (${c.stats.boxedIn ? 'boxed in' : 'pulled out'}), out of the car, ticket ${c.tickets}`);
    const note = await page.textContent('#ticket .ticket-note');
    check(note === '', `your own car isn't taken ("${note}")`);
    await step(40);
    await game('skipCaught');
    await step(5);
    s = await state();
    check(!s.caught && s.heat === 0, 'tap the slip to carry on: heat cleared');

    // Out of sight: down a level every `decay` seconds.
    await game('reset');
    await quiet();
    await game('knob', 'cops.foot', 0);
    await game('knob', 'cops.cars2', 0);
    await game('knob', 'cops.decay', 3);
    await game('setHeat', 2.5);
    const levels = [];
    ({ s } = await run({ max: 60 * 12, every: 15, until: (x) => x.heat === 0, sample: (x) => levels[levels.length - 1] !== x.heat && levels.push(x.heat) }));
    c = await cops();
    check(s.heat === 0 && levels.join(',') === '2,1,0' && c.stats.decayed === 2 && !c.seen, `nobody sees you: heat ${levels.join(' → ')} (${c.stats.decayed} drops)`);

    // Swap cars unseen: they lose you a level.
    await game('reset');
    await quiet();
    await game('knob', 'cops.foot', 0);
    await game('knob', 'cops.cars2', 0);
    await game('setHeat', 2);
    await getIn();
    c = await cops();
    check(c.level === 1 && c.stats.swapped === 1, `into a car unseen: down to level ${c.level}`);

    // Level 3: spikes and cones ahead on the road; drive over the spikes and the tyres go flat.
    await game('reset');
    await quiet();
    await getIn();
    await game('teleportCar', 0, ...along(30), HEADING);
    await step(30);
    await game('knob', 'cops.cars3', 0);
    await game('knob', 'cops.foot', 0);
    await run({ keys: ['KeyW'], max: 120, until: (x) => x.speedKmh > 35 });
    await game('setHeat', 3);
    const block = await game('roadblock');
    c = await cops();
    check(!!block && block.cones >= 2 && c.drawn.spikes === 0, `a roadblock up the road: spikes across ${Math.abs(block?.spikes[1] - block?.spikes[0]).toFixed(1)} m, ${block?.cones} cones`);
    // Steer for the spikes' half (your side of the road, mostly).
    let flat = 0;
    let topAfter = 0;
    ({ s } = await run({ keys: ['KeyW'], max: 60 * 8, every: 5, until: (x) => x.flat > 0 }));
    flat = s.flat;
    const spikedAt = s.speedKmh;
    ({ s } = await run({ keys: ['KeyW'], max: 60 * 4, every: 10, sample: (x) => (topAfter = Math.max(topAfter, x.speedKmh)) }));
    c = await cops();
    check(flat > 0 && c.stats.spiked >= 1, `over the spikes at ${spikedAt.toFixed(0)} km/h: flat tyres for ${flat.toFixed(0)} s`);
    check(topAfter < 110, `flat tyres are slow (${topAfter.toFixed(0)} km/h at most, flat out)`);
    await game('knob', 'cops.on', false);
    await step(5);
    c = await cops();
    s = await state();
    check(s.heat === 0 && c.officers.length === 0 && c.cars.length === 0 && c.roadblocks.length === 0, 'switched off on the ? panel: no heat, no cops');
  },
};
