// St Kevin's Arcade and the Myers Park steps (src/landmarks/st-kevins.ts):
// the model replaces the generated block, nothing of the ground pokes up
// through its floors or treads, and you can walk from K Road through the
// arcade, down its stairs and out onto Poynton Tce, down every flight of
// the park steps and back up, and back up through the arcade; and drive
// a car through it from K Road and out the back.

/** The arcade's frame (u along the passage from the K Road facade, w east) and the steps' (s down from their head). */
const ARCADE = { o: [-731.3, 1477.9], d: [0.18825, -0.98212] };
const STEPS = { o: [-716.9, 1408.2], d: [0.20504, -0.97875] };
/** Floor levels (st-kevins.ts): the hall, the landing halfway down, the bottom landing; the park steps' head. */
const HALL = 64.15;
const MID = 60.6;
const LOW = 57.05;
const HEAD = 56.36;

const at = (f, u, w = 0) => [f.o[0] + f.d[0] * u - f.d[1] * w, f.o[1] + f.d[1] * u + f.d[0] * w];
const along = (f, p) => (p[0] - f.o[0]) * f.d[0] + (p[2] - f.o[1]) * f.d[1];
/** The heading that faces along the frame (dir 1) or back (-1): heading h faces (cos h, -sin h). */
const facing = (f, dir) => Math.atan2(-f.d[1] * dir, f.d[0] * dir);

export default {
  name: 'st-kevins',
  core: false,
  page: 'auckland',
  async run(t) {
    const { check, game, run, step, shot, getIn } = t;
    await game('knob', 'traffic.on', false);
    await game('knob', 'peds.on', false);
    await game('knob', 'cops.on', false);

    const loaded = await game('landmarks');
    const model = loaded.find((l) => l.id === 'st-kevins');
    const steps = loaded.find((l) => l.id === 'myers-park-steps');
    check(!!model && model.replaces && model.top > 75 && model.top < 76.5,
      `St Kevin's Arcade model replaces the OSM block, up to ${model?.top.toFixed(1)} m above sea level (LiDAR ~75.8 m over the lantern)`);
    // In full only up close (inside, at its doors); from across the street a plain inside; far off, the outside.
    const tri = model?.triangles;
    check(!!tri && tri.close > 2000 && tri.near < tri.close / 2 && tri.far < tri.near / 2 && model.colliders > 10 && !!steps && steps.triangles.near > 1500 && steps.triangles.far < 300 && steps.colliders > 30,
      `St Kevin's model: ${tri?.close}/${tri?.near}/${tri?.far} tris close/near/far, ${model?.colliders} colliders; the steps ${steps?.triangles.near}/${steps?.triangles.far} near/far, ${steps?.colliders} colliders`);

    // Load the ground round it, then look straight down at the floors and
    // treads: the first thing drawn must be them, never the ground through
    // them. From over the middle of each, so it's drawn in full detail.
    const through = async (f, from, to, widths, lift) => {
      const [mx, mz] = at(f, (from + to) / 2);
      await game('lookFrom', [mx, 110, mz], [mx, 0, mz + 1]);
      await run({ max: 30 });
      await game('probe', mx, mz);
      let worst = Infinity;
      let where = null;
      let n = 0;
      for (let u = from; u <= to; u += 0.25) {
        for (const w of widths) {
          const [x, z] = at(f, u, w);
          const g = await game('groundHeight', x, z);
          const d = await game('renderHit', [x, g + lift, z], [0, -1, 0], lift + 1);
          const above = d === null ? -Infinity : lift - d;
          n++;
          if (above < worst) {
            worst = above;
            where = [u, w];
          }
        }
      }
      return { worst, where, n };
    };
    // Low enough to stay under the arcade's roof and pendant lamps and the park's tree crowns.
    const floors = await through(ARCADE, 0.2, 56.4, [-2.0, 0, 2.0], 5);
    check(floors.worst > 0.03, `the arcade's floor and stairs are above the ground everywhere (${floors.n} points; least ${floors.worst.toFixed(2)} m, at u ${floors.where[0].toFixed(2)} w ${floors.where[1]})`);
    const treads = await through(STEPS, -6.4, 28.9, [-1.1, 0, 1.1], 1.2);
    check(treads.worst > 0.03, `the park steps' treads are above the bank everywhere (${treads.n} points; least ${treads.worst.toFixed(2)} m, at s ${treads.where[0].toFixed(2)} w ${treads.where[1]})`);
    await game('lookFrom', null, [0, 0, 0]);

    // Walk in off K Road, through the hall, down both flights and out the back.
    const levels = { hall: null, mid: null, low: null };
    await game('placePlayer', ...at(ARCADE, -2.5), facing(ARCADE, 1));
    await step(20);
    const { s: out, ticks } = await run({
      keys: ['KeyW', 'ShiftLeft'], max: 2400, every: 10,
      until: (s) => along(ARCADE, s.player) > 60,
      sample: (s) => {
        const u = along(ARCADE, s.player);
        if (u > 12 && u < 15) levels.hall ??= s.player[1];
        if (u > 37.5 && u < 40) levels.mid ??= s.player[1];
        if (u > 52.5 && u < 54.5) levels.low ??= s.player[1];
      },
    });
    const near = (y, level) => y !== null && Math.abs(y - level) < 0.3;
    check(along(ARCADE, out.player) > 60 && near(levels.hall, HALL) && near(levels.mid, MID) && near(levels.low, LOW),
      `walks from K Road through St Kevin's Arcade and out onto Poynton Tce in ${(ticks / 60).toFixed(1)} s (hall ${levels.hall?.toFixed(2)}, landing ${levels.mid?.toFixed(2)}, bottom ${levels.low?.toFixed(2)}, out at ${out.player[1].toFixed(2)} m)`);

    // Down the park steps from their head to the path at the bottom, and back up.
    await game('placePlayer', ...at(STEPS, -6), facing(STEPS, 1));
    await step(20);
    // Halfway, on the fourth flight, feet should be on the treads (49.22 to 46.78 m over s 16.1 to 20.9, feet up to a riser over them), not the bank under them.
    let halfway = null;
    const { s: down, ticks: downTicks } = await run({
      keys: ['KeyW'], max: 2400, every: 10,
      until: (s) => along(STEPS, s.player) > 31,
      sample: (s) => {
        const u = along(STEPS, s.player);
        if (u > 18 && u < 19) halfway ??= [u, s.player[1]];
      },
    });
    const flight4 = halfway && 49.22 - ((halfway[0] - 16.08) / 4.8) * 2.44;
    const below = await game('groundHeight', down.player[0], down.player[2]);
    check(along(STEPS, down.player) > 31 && Math.abs(down.player[1] - below) < 0.2 && halfway && halfway[1] - flight4 > -0.05 && halfway[1] - flight4 < 0.25,
      `walks down all 79 park steps into Myers Park in ${(downTicks / 60).toFixed(1)} s (on the fourth flight at ${halfway?.[1].toFixed(2)} m, its treads ~${flight4?.toFixed(2)} m; on the path at the foot, ${down.player[1].toFixed(2)} m)`);
    await shot('st-kevins-1-steps');
    await game('placePlayer', down.player[0], down.player[2], facing(STEPS, -1));
    await step(20);
    const { s: top, ticks: topTicks } = await run({
      keys: ['KeyW'], max: 3000, every: 10,
      until: (s) => along(STEPS, s.player) < -5,
    });
    check(along(STEPS, top.player) < -5 && Math.abs(top.player[1] - HEAD) < 0.3,
      `climbs back up the park steps to Poynton Tce in ${(topTicks / 60).toFixed(1)} s (at ${top.player[1].toFixed(2)} m)`);

    // Up through the arcade from Poynton Tce to K Road.
    await game('placePlayer', ...at(ARCADE, 60), facing(ARCADE, -1));
    await step(20);
    const { s: krd, ticks: krdTicks } = await run({
      keys: ['KeyW', 'ShiftLeft'], max: 3000, every: 10,
      until: (s) => along(ARCADE, s.player) < -1.5,
    });
    check(along(ARCADE, krd.player) < -1.5 && Math.abs(krd.player[1] - HALL) < 0.4,
      `walks up through the arcade from Poynton Tce to K Road in ${(krdTicks / 60).toFixed(1)} s (at ${krd.player[1].toFixed(2)} m)`);
    await shot('st-kevins-2-k-road');

    // And in a car: in off K Road, down the stairs and out of the back door.
    check((await getIn()).mode === 'car', 'gets in to drive through the arcade');
    await game('teleportCar', 0, ...at(ARCADE, -10), facing(ARCADE, 1));
    await step(30);
    const { s: drove, ticks: driveTicks } = await run({
      keys: ['KeyW'], max: 1800, every: 10,
      until: (s) => along(ARCADE, s.cars[0]) > 62,
    });
    check(along(ARCADE, drove.cars[0]) > 62 && drove.cars[0][1] < 58,
      `drives through the arcade and down its stairs onto Poynton Tce in ${(driveTicks / 60).toFixed(1)} s (at ${drove.cars[0].map((v) => v.toFixed(1)).join(', ')})`);
    await shot('st-kevins-3-driven');
  },
};
