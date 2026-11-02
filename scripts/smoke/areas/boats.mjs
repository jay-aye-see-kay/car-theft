// Boats: every mooring has a boat afloat in water deep enough and reachable
// from the shore; walk up to one, borrow it, open the throttle, carve a turn,
// and step back ashore at a wharf (or over the side, and get fished out).

export default {
  name: 'boats',
  core: false,
  page: 'auckland',
  async run({ check, game, state, step, run, press, shot }) {
    const quiet = async () => {
      // Scripted throttle runs: no traffic or cops to get in the way.
      await game('knob', 'traffic.on', false);
      await game('knob', 'cops.on', false);
    };
    await quiet();
    const list = await game('boats');
    check(list.length >= 10, `${list.length} boats moored round the waterfront (${[...new Set(list.map((b) => b.kind))].join(', ')})`);

    // Each one: stand on the shore beside it, and it's afloat and in reach.
    const reachable = [];
    for (const b of list) {
      const at = await game('besideBoat', b.index);
      const s = await step(90);
      const now = (await game('boats'))[b.index];
      const afloat = now.settled && !now.frozen && now.wet > 0.5 && Math.abs(now.pos[1]) < 0.6;
      if (at && afloat && s.nearBoat) reachable.push(b.index);
      check(!!at && afloat && s.nearBoat, `${b.kind} ${b.index} afloat at ${now.pos.map((v) => v.toFixed(0)).join(', ')} (wet ${now.wet.toFixed(2)}${now.settled ? "" : ", not settled"}), ` +
        `shore ${at ? at.map((v) => v.toFixed(0)).join(', ') : 'none'}${s.nearBoat ? ', in reach' : ', out of reach'}`);
    }

    // The runabout in the Viaduct: borrow it and open her up.
    const runabout = list.find((b) => b.kind === 'runabout' && reachable.includes(b.index)) ?? list[0];
    await game('besideBoat', runabout.index);
    await step(30);
    let s = await press('KeyF', 4);
    check(s.mode === 'boat', `F at the water's edge borrows the ${runabout.kind} (${s.mode})`);
    await shot('boat-1-aboard');
    const start = (await game('boats'))[runabout.index];
    let top = 0;
    ({ s } = await run({ keys: ['KeyW'], max: 240, sample: (x) => (top = Math.max(top, x.speedKmh)) }));
    const after = (await game('boats'))[runabout.index];
    const moved = Math.hypot(after.pos[0] - start.pos[0], after.pos[2] - start.pos[2]);
    check(top > 35 && after.wet > 0.3 && Math.abs(after.pos[1]) < 1, `full throttle: ${top.toFixed(0)} km/h, ${moved.toFixed(0)} m, still afloat (y ${after.pos[1].toFixed(2)})`);
    await shot('boat-2-planing');

    // Out in the open harbour north of the wharves, heading east: a hard right, then over the side.
    await game('boardBoat', runabout.index, 400, -560, 0);
    ({ s } = await run({ keys: ['KeyW'], max: 150 }));
    const open = (await game('boats'))[runabout.index];
    ({ s } = await run({ keys: ['KeyW', 'KeyD'], max: 90 }));
    const turned = (await game('boats'))[runabout.index];
    const dh = Math.atan2(Math.sin(turned.heading - open.heading), Math.cos(turned.heading - open.heading));
    check(dh < -1, `steering right carves a right turn (${dh.toFixed(2)} rad in 1.5 s at ${s.speedKmh.toFixed(0)} km/h)`);
    await shot('boat-3-turn');
    ({ s } = await run({ keys: ['KeyS'], max: 400, until: (x) => x.speedKmh < 3 }));
    await press('KeyF', 2);
    ({ s } = await run({ max: 300, until: (x) => x.mode === 'foot' && !x.soaked && x.ground > 0.3 }));
    check(s.mode === 'foot' && s.ground > 0.3, `off the boat you end up on dry land (${s.player.map((v) => v.toFixed(0)).join(', ')}, ground ${s.ground.toFixed(1)} m)`);

    // At a mooring: borrow it and step straight back onto the wharf, dry.
    const back = list.find((b) => reachable.includes(b.index) && b.kind === 'tinny') ?? runabout;
    await game('besideBoat', back.index);
    await run({ max: 120, until: (x) => x.nearBoat });
    s = await press('KeyF', 4);
    const boarded = s.mode === 'boat';
    const splashes = s.splashes;
    s = await press('KeyF', 30);
    check(boarded && s.mode === 'foot' && s.splashes === splashes && s.ground > 0.3, `get in and out of the ${back.kind} ${back.index} at its mooring without a swim (${s.mode} at ${s.speedKmh.toFixed(0)} km/h, ground ${s.ground.toFixed(1)} m)`);

    // Harbour Dash: walk into the marker at the Viaduct, borrow a boat, and round the buoys to Mechanics Bay.
    await game('reset');
    await quiet();
    const lookout = await game('place', 'the-lookout');
    await game('placePlayer', lookout.x, lookout.z, 0);
    await step(30);
    let m = await game('missions');
    check(m.active === 'harbour-dash' && /boat/i.test(m.objective), `the Viaduct marker starts Harbour Dash ("${m.objective}")`);
    const near = (await game('boats')).map((b) => ({ ...b, d: Math.hypot(b.pos[0] - lookout.x, b.pos[2] - lookout.z) })).sort((a, b) => a.d - b.d)[0];
    check(near.d < 80, `a boat to borrow ${near.d.toFixed(0)} m from the marker (${near.kind})`);
    await game('besideBoat', near.index);
    await run({ max: 120, until: (x) => x.nearBoat });
    await press('KeyF', 4);
    await step(60 * 4); // 3, 2, 1, go
    const legs = [];
    for (let i = 0; i < 5; i++) {
      m = await game('missions');
      if (!m.target) break;
      legs.push(m.target.label);
      if (i === 1) await shot('boat-4-dash');
      await game('boardBoat', near.index, m.target.x, m.target.z, 0);
      await step(60 * 3);
    }
    for (let i = 0; i < 20 && (await game('missions')).active; i++) await step(30);
    m = await game('missions');
    check(m.last?.id === 'harbour-dash' && m.last.result === 'passed', `Harbour Dash: ${legs.join(' → ')}: ${m.last?.result} ("${m.last?.message}")`);
  },
};
