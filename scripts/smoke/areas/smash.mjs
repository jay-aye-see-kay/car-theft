// Knocking things down (src/smash.ts, #48): street furniture and trees have
// colliders, give way to a car going fast enough into them (a big tree
// ~75 km/h, a lamp 25, a bin anything) and take a share of its speed, fall
// over, and stand back up once you're far off. Slower than that they stop it.

/** A big tree (~19 m) on Albert Park's lawn, open lawn west of it (as trees.mjs). */
const TREE = [-46.6, 638.4];
/** Lower Queen St: lamps, bins and street trees along both kerbs. */
const STREET = [-190, 257];

export default {
  name: 'smash',
  core: false,
  page: 'auckland',
  async run(t) {
    const { check, game, state, step, getIn, shot } = t;
    const quiet = async () => {
      // Scripted runs at things: nobody else on the road, no cops.
      await game('knob', 'traffic.on', false);
      await game('knob', 'parked.on', false);
      await game('knob', 'cops.on', false);
    };
    /** Puts the car `back` m short of (x, z) heading at it, launches it at `kmh`, and coasts `ticks`; returns speeds and positions along the way. */
    const ram = async (x, z, dx, dz, back, kmh, ticks) => {
      const len = Math.hypot(dx, dz);
      dx /= len;
      dz /= len;
      await game('teleportCar', 0, x - dx * back, z - dz * back, Math.atan2(-dz, dx));
      await step(30);
      await game('launchCar', 0, kmh / 3.6);
      const trace = [];
      for (let i = 0; i < ticks; i += 3) {
        const s = await step(3);
        const c = s.cars[0];
        // How far along the line it's got past the target, and its speed.
        trace.push({ past: (c[0] - x) * dx + (c[2] - z) * dz, kmh: s.speedKmh });
      }
      return trace;
    };

    await quiet();
    check((await getIn()).mode === 'car', 'gets in to go knocking things down');

    // The big tree: it says 75 km/h, and at 50 it stops the car dead.
    await game('teleportCar', 0, TREE[0] - 12, TREE[1], 0);
    await step(10);
    const [tree] = await game('props', TREE[0], TREE[1], 2);
    check(tree?.collider && tree.height > 16 && tree.kmh === 75, `the Albert Park tree has a collider of its own and gives way above 75 km/h (${tree && `${tree.kind}, ${tree.height.toFixed(1)} m, ${tree.kmh} km/h`})`);
    let trace = await ram(TREE[0], TREE[1], 1, 0, 5, 50, 90);
    let last = trace[trace.length - 1];
    let sm = await game('smashed');
    // It bounces back off the trunk a little: what matters is it never gets by.
    let furthest = Math.max(...trace.map((p) => p.past));
    check(sm.down === 0 && furthest < -1 && last.kmh < 10, `at 50 km/h a big tree stops the car (got within ${(-furthest).toFixed(1)} m of its middle, ${last.kmh.toFixed(0)} km/h after, ${sm.down} down)`);

    // At 100 km/h it goes over, and the car keeps going, slowed.
    await game('reset');
    await quiet();
    await getIn();
    trace = await ram(TREE[0], TREE[1], 1, 0, 5, 100, 60);
    sm = await game('smashed');
    const after = trace.find((p) => p.past > 3);
    const before = trace.filter((p) => p.past < -3).pop();
    check(sm.tally.broadleaf === 1 && sm.down === 1, `at 100 km/h the tree goes over (${JSON.stringify(sm.tally)})`);
    check(!!after && !!before && after.kmh > 35 && after.kmh < before.kmh * 0.75, `...and the car carries on through, slowed (${before?.kmh.toFixed(0)} km/h before, ${after?.kmh.toFixed(0)} after)`);
    check((await game('props', TREE[0], TREE[1], 2)).length === 0, 'a fallen tree is no longer in the way (no collider)');
    await step(120);
    sm = await game('smashed');
    check(sm.pieces[0]?.settled && sm.drawn, `it falls and settles, drawn lying there (${JSON.stringify(sm.pieces[0])})`);
    await game('lookFrom', [TREE[0] - 15, 60, TREE[1] + 15], [TREE[0] + 8, 48, TREE[1]]);
    await shot('smash-tree-down');
    await game('lookFrom', null, [0, 0, 0]);

    // Far off and looking away, it stands back up (and has its collider again when you're back).
    await game('teleportCar', 0, STREET[0], STREET[1], 0);
    await step(60 * 10);
    sm = await game('smashed');
    check(sm.down === 0, `back up once you're far away (${sm.down} still down)`);
    await game('teleportCar', 0, TREE[0] - 12, TREE[1], 0);
    await step(10);
    check((await game('props', TREE[0], TREE[1], 2))[0]?.collider, 'and solid again');

    // A lamp on Queen St, hit square from the road at 50 km/h: down, hardly slowed.
    await game('reset');
    await quiet();
    await getIn();
    await game('teleportCar', 0, STREET[0], STREET[1], 0);
    await step(10);
    const lamps = await game('props', STREET[0], STREET[1], 120, 'lamp');
    // One with nothing else close by, so it's the only thing hit.
    const all = await game('props', STREET[0], STREET[1], 140);
    const lamp = lamps.find((l) => all.every((p) => p === l || (p.x === l.x && p.z === l.z) || Math.hypot(p.x - l.x, p.z - l.z) > 6));
    check(!!lamp && lamp.collider && lamp.kmh === 25, `a lamp has a collider and gives way above 25 km/h (${lamp && `at ${lamp.x.toFixed(1)}, ${lamp.z.toFixed(1)}`})`);
    if (lamp) {
      // Lamps face the road: come at it from there.
      trace = await ram(lamp.x, lamp.z, -Math.cos(lamp.heading), -Math.sin(lamp.heading), 6, 50, 45);
      sm = await game('smashed');
      const hit = trace.filter((p) => p.past < -2.5).pop();
      const through = trace.find((p) => p.past > 0);
      check(sm.tally.lamp === 1, `a lamp at 50 km/h goes down (${JSON.stringify(sm.tally)})`);
      check(!!hit && !!through && through.kmh > hit.kmh * 0.75, `...taking only a little speed (${hit?.kmh.toFixed(0)} km/h before, ${through?.kmh.toFixed(0)} after)`);
      await step(60);
      await shot('smash-lamp-down');

      // Under the threshold, the next lamp stops you.
      const next = lamps.find((l) => l !== lamp && all.every((p) => (p.x === l.x && p.z === l.z) || Math.hypot(p.x - l.x, p.z - l.z) > 6));
      if (next) {
        trace = await ram(next.x, next.z, -Math.cos(next.heading), -Math.sin(next.heading), 6, 15, 90);
        last = trace[trace.length - 1];
        sm = await game('smashed');
        check(sm.tally.lamp === 1 && last.past < 0 && last.kmh < 5, `a lamp at 15 km/h stands and stops the car (${(-last.past).toFixed(1)} m short, ${last.kmh.toFixed(0)} km/h)`);
      }
    }

    // A bin at 20 km/h: flung, hardly noticed.
    const bins = await game('props', STREET[0], STREET[1], 120, 'bin');
    const bin = bins.find((l) => all.every((p) => (p.x === l.x && p.z === l.z) || Math.hypot(p.x - l.x, p.z - l.z) > 3));
    if (bin) {
      trace = await ram(bin.x, bin.z, -Math.cos(bin.heading), -Math.sin(bin.heading), 6, 25, 45);
      sm = await game('smashed');
      check(sm.tally.bin === 1, `a bin at 25 km/h goes flying (${JSON.stringify(sm.tally)})`);
    } else check(false, 'a bin to hit on Queen St');

    // Switched off on the ? panel: nothing gives way, the big tree stops you at 100.
    await game('reset');
    await quiet();
    await game('knob', 'smash.on', false);
    await getIn();
    trace = await ram(TREE[0], TREE[1], 1, 0, 5, 100, 60);
    furthest = Math.max(...trace.map((p) => p.past));
    sm = await game('smashed');
    check(sm.down === 0 && furthest < -1, `with smashing off, a tree at 100 km/h stops the car (${sm.down} down, got within ${(-furthest).toFixed(1)} m)`);
    const s = await state();
    check(Number.isFinite(s.speedKmh), 'still driving afterwards');
  },
};
