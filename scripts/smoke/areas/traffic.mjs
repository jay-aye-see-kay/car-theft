// Traffic and the town's parked cars (#29, src/traffic.ts): they come out
// round you out of view, drive the road graph on the left and stay on the
// road, stop for you on foot, and you can take one (its driver gets out,
// cross). Every car, however many, is drawn in a handful of instanced calls.

export default {
  name: 'traffic',
  core: false,
  page: 'auckland',
  async run({ page, check, game, state, step, press, shot }) {
    const knobs = await game('knobs');
    const near = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

    // Out round the spawn, none appearing in view.
    let popped = 0;
    const seen = new Set();
    for (let i = 0; i < 60; i++) {
      await step(5);
      const s = await state();
      for (const c of (await game('town')).cars) {
        if (seen.has(c.index)) continue;
        seen.add(c.index);
        if (near(c.pos, s.player) < 60 && (await game('inView', [c.pos[0], c.pos[1] + 0.5, c.pos[2]]))) popped++;
      }
    }
    let town = await game('town');
    const driving = () => town.cars.filter((c) => c.kind === 'driving');
    const parked = town.cars.filter((c) => c.kind === 'parked');
    check(driving().length === knobs.traffic.count && parked.length === knobs.parked.count && popped === 0,
      `${driving().length} cars driving (count ${knobs.traffic.count}) and ${parked.length} more parked (count ${knobs.parked.count}) come out round you, none in view (${popped})`);

    // Ten seconds on: they've driven on, on the road, the right way up.
    const before = new Map(driving().map((c) => [c.index, c.pos]));
    await step(600);
    town = await game('town');
    const still = driving().filter((c) => before.has(c.index));
    const moved = still.filter((c) => near(c.pos, before.get(c.index)) > 30).length;
    const offRoad = driving().filter((c) => c.pastKerb > 1 || !c.upright);
    check(moved >= still.length * 0.6 && offRoad.length === 0 && town.stats.gaveUp <= 2,
      `they drive on (${moved} of ${still.length} went 30 m+ in 10 s), on the road and upright (${offRoad.map((c) => `${c.street || c.edge} ${c.pastKerb.toFixed(1)} m past the kerb`).join(', ') || 'all'}), ${town.stats.gaveUp} gave up${town.stats.why.length ? ` (${town.stats.why.join('; ')})` : ''}`);
    const parts = await game('breakdown');
    const s = await state();
    check(parts.car?.meshes === 4 && s.carsDrawn >= 1, `every car in four instanced draw calls plus one for shadows (${s.carsDrawn} cars drawn, ${parts.car?.tris ?? 0} triangles)`);
    await shot('30-traffic');

    // Stand in the road in front of one: it stops short of you.
    const pick = driving().filter((c) => c.left > 50 && c.speed > 4 && c.ahead).sort((a, b) => a.index - b.index)[0];
    check(!!pick, `a car with a straight run ahead to stand in front of (${pick?.street || pick?.edge})`);
    if (!pick) return;
    await game('placePlayer', pick.ahead[0], pick.ahead[1], pick.heading + Math.PI);
    let me = pick;
    let gap = Infinity;
    for (let i = 0; i < 60; i++) {
      const x = await step(5);
      me = (await game('town')).cars.find((c) => c.index === pick.index);
      gap = near(me.pos, x.player);
      if (Math.abs(me.speed) < 0.3) break;
    }
    check(Math.abs(me.speed) < 0.3 && gap > 2.5 && gap < 15 && s.dizzy === false, `it stops for you on foot (${gap.toFixed(1)} m away, ${me.blocked})`);

    // Take it: in at the driver's door, and the driver's out on the road, not happy.
    const right = [Math.sin(me.heading), Math.cos(me.heading)];
    await game('placePlayer', me.pos[0] + right[0] * 1.8, me.pos[2] + right[1] * 1.8, me.heading);
    await step(2);
    const inCar = await press('KeyF');
    town = await game('town');
    const peds = (await game('peds')).list;
    const driver = peds.find((p) => near(p.pos, me.pos) < 6 && p.says);
    check(inCar.mode === 'car' && inCar.drivingIndex === town.first + pick.index && town.stats.carjacked === 1 && !!driver,
      `carjacked: driving it (${inCar.mode}, car ${inCar.drivingIndex}), its driver turfed out saying "${driver?.says ?? ''}"`);
    const { s: away } = await (async () => {
      await page.keyboard.down('KeyW');
      const x = await step(120);
      await page.keyboard.up('KeyW');
      return { s: x };
    })();
    check(away.speedKmh > 20 && town.cars.find((c) => c.index === pick.index)?.kind === 'loose', `and drive off in it (${away.speedKmh.toFixed(0)} km/h)`);
    await shot('31-carjacked');
  },
};
