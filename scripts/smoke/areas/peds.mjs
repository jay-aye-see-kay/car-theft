// Pedestrians and bouncy hits (#53): people walk the footpaths round the
// player, drawn instanced; a car launches one, who bounces, lies there a
// moment, gets up and reacts; walking into them nudges them aside and
// sprinting into them knocks you both back. The ? panel turns hits and
// pedestrians off.

/** Lower Queen St, heading up from Customs St (see drive.mjs). */
const A = [-147, 113];
const B = [-245, 494];
const LEN = Math.hypot(B[0] - A[0], B[1] - A[1]);
const U = [(B[0] - A[0]) / LEN, (B[1] - A[1]) / LEN];
const HEADING = Math.atan2(-U[1], U[0]);
const along = (m) => [A[0] + U[0] * m, A[1] + U[1] * m];

export default {
  name: 'peds',
  core: false,
  page: 'auckland',
  async run(t) {
    const { page, check, game, state, step, run, getIn, shot } = t;
    // Officers are pedestrians too; they're counted in cops.mjs.
    const noCops = () => game('knob', 'cops.on', false);
    await noCops();
    const knobs = await game('knobs');

    // A crowd round the spawn: every new face appears out of the camera's view (or far off).
    let poppedInView = 0;
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      await step(3);
      const { list } = await game('peds');
      const s = await state();
      for (const p of list) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        const d = Math.hypot(p.pos[0] - s.player[0], p.pos[2] - s.player[2]);
        if (d < 50 && (await game('inView', [p.pos[0], p.pos[1] + 1, p.pos[2]]))) poppedInView++;
      }
    }
    let { list, drawn } = await game('peds');
    check(list.length === knobs.peds.count && poppedInView === 0, `${list.length} people (count ${knobs.peds.count}) spawn round you, none popping up in view (${poppedInView})`);
    const before = new Map(list.map((p) => [p.id, p.pos]));
    await step(300);
    ({ list, drawn } = await game('peds'));
    const s = await state();
    const moved = list.filter((p) => before.has(p.id) && Math.hypot(p.pos[0] - before.get(p.id)[0], p.pos[2] - before.get(p.id)[2]) > 3).length;
    const walkable = list.filter((p) => p.surface !== 'road').length;
    const far = Math.max(...list.map((p) => Math.hypot(p.pos[0] - s.player[0], p.pos[2] - s.player[2])));
    const grounded = list.every((p) => Math.abs(p.pos[1] - p.ground) < 0.05);
    check(moved >= list.length * 0.6 && walkable >= list.length * 0.6 && grounded && far < knobs.peds.spawnRadius * 1.4,
      `they walk (${moved} of ${list.length} moved 3 m+ in 5 s), mostly off the road (${walkable} on footpaths), feet on the ground, within ${far.toFixed(0)} m`);
    const parts = await game('breakdown');
    check(parts.peds?.meshes === 1 && drawn > 0, `everyone in one instanced draw call (${drawn} drawn, ${parts.peds?.tris ?? 0} triangles)`);

    // Drive up Queen St into someone standing in the lane.
    await getIn();
    const [cx, cz] = along(40);
    await game('teleportCar', 0, cx, cz, HEADING);
    await step(30);
    const [px, pz] = along(75);
    const id = await game('spawnPed', px, pz, HEADING + Math.PI / 2);
    const me = async () => (await game('peds')).list.find((p) => p.id === id);
    let peak = 0;
    let flew = false;
    let kmh = 0;
    for (let i = 0; i < 120 && !flew; i++) {
      await page.keyboard.down('KeyW');
      const x = await step(2);
      kmh = x.speedKmh;
      const p = await me();
      flew = p?.state === 'fly';
    }
    await page.keyboard.up('KeyW');
    const states = new Set();
    let said = '';
    let dazed = false;
    for (let i = 0; i < 120; i++) {
      await step(4);
      const p = await me();
      if (!p) break;
      states.add(p.state);
      peak = Math.max(peak, p.peak);
      said ||= p.says;
      dazed ||= p.dazed && p.state === 'down';
      if (i === 8) await shot('23-ped-launched');
      if (['walk', 'chase'].includes(p.state) || (p.state === 'react' && said)) break;
    }
    const p = await me();
    check(flew && peak > 1, `hit at ${kmh.toFixed(0)} km/h, they fly (${peak.toFixed(1)} m up, ${p?.bounces} bounces)`);
    check(states.has('down') && states.has('getup') && ['react', 'chase', 'walk'].includes(p?.state), `then lie there, get up and react (${[...states].join(' → ')}; now ${p?.state} ${p?.reaction})`);
    check(dazed && said.length > 0, `seeing stars while down, and they say something ("${said}")`);
    await shot('24-ped-reacts');
    await page.keyboard.press('KeyF');
    await run({ max: 300, until: (x) => x.mode === 'foot' });

    // On foot: walk into someone and they step aside; sprint into them and you both stumble.
    await game('reset');
    await noCops();
    await step(5);
    /** Points ahead of you, away from the camera (where W walks). */
    const ahead = async (m) => {
      const me = (await state()).player;
      const c = await game('camera');
      const yaw = Math.atan2(me[2] - c[2], me[0] - c[0]);
      return [me[0] + Math.cos(yaw) * m, me[2] + Math.sin(yaw) * m];
    };
    await game('spawnPed', ...(await ahead(3)), 0);
    await run({ keys: ['KeyW'], max: 90 });
    let st = (await game('peds')).stats;
    check(st.bumps > 0 && st.stumbles === 0, `walking into someone nudges them aside (${st.bumps} nudges, no stumble)`);
    await game('spawnPed', ...(await ahead(6)), 0);
    let flung = 0;
    const y0 = (await state()).player[1];
    await run({ keys: ['KeyW', 'ShiftLeft'], max: 90, every: 1, sample: (x) => (flung = Math.max(flung, x.player[1] - y0)) });
    st = (await game('peds')).stats;
    check(st.stumbles > 0 && flung > 0.05, `sprinting into someone: they stumble (${st.stumbles}) and you bounce off (${flung.toFixed(2)} m up)`);

    // Off on the ? panel: no launch, then nobody about.
    await game('reset');
    await noCops();
    await getIn();
    await game('teleportCar', 0, cx, cz, HEADING);
    await step(30);
    await page.click('#tweaks-btn');
    await page.click('[data-toggle="hits"]');
    await page.click('#tweaks-panel [data-close]');
    const id2 = await game('spawnPed', px, pz, HEADING + Math.PI / 2);
    await run({ keys: ['KeyW'], max: 240 });
    const p2 = (await game('peds')).list.find((x) => x.id === id2);
    check(p2 && p2.state === 'wait' && (await game('peds')).stats.hits === 0, `with hits off on the panel, driving through someone doesn't launch them (${p2?.state})`);
    await page.click('#tweaks-btn');
    await page.click('[data-toggle="peds"]');
    await page.click('#tweaks-panel [data-close]');
    await step(2);
    ({ list, drawn } = await game('peds'));
    check(list.length === 0 && drawn === 0, `with pedestrians off on the panel, there's nobody (${list.length})`);
  },
};
