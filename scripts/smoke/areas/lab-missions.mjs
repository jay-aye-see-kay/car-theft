// The mission lab (#53 on): the solo-playable missions from the categories in
// docs/MISSIONS.md, each played through by teleporting, with the pads, gems
// and goals they put out checked to be on open ground. Shared ones played by
// two tabs are in lab-coop.mjs.

const LIT = '#ffe58a';

export default {
  name: 'lab-missions',
  core: false,
  page: 'auckland',
  async run(t) {
    const { check, game, state, step, getIn } = t;
    const missions = () => game('missions');
    const place = (id) => game('place', id);
    const finish = async (max) => {
      for (let n = 0; n < max; n += 30) {
        await step(30);
        const m = await missions();
        if (!m.active) return m;
      }
      return missions();
    };
    /** Starts a mission where the player stands (driving if `car`), traffic and cops off unless `cops`. */
    const begin = async (id, { car = false, cops = false } = {}) => {
      await game('reset');
      await game('knob', 'traffic.on', false);
      if (!cops) await game('knob', 'cops.on', false);
      const m0 = (await missions()).missions.find((x) => x.id === id);
      if (car) {
        await getIn();
        await game('teleportCar', 0, m0.start.x, m0.start.z, 0);
      } else await game('placePlayer', m0.start.x + 0.5, m0.start.z, 0);
      await step(30);
      return missions();
    };
    /** Every pad, gem and goal on open ground (not inside or on a building). */
    const onGround = async (what, points, { verandah = false } = {}) => {
      const bad = [];
      for (const p of points) {
        const g = await game('probe', p.x, p.z);
        const over = g.top === null ? 0 : g.top - g.ground;
        // Under a shop verandah (3-5 m up) is still on the footpath.
        if (Number.isNaN(g.ground) || (over > 0.5 && !(verandah && over > 3 && over < 5))) bad.push(`(${p.x.toFixed(0)}, ${p.z.toFixed(0)}) top ${g.top?.toFixed(1)} over ${g.ground.toFixed(1)}`);
      }
      check(bad.length === 0, `${what}: all ${points.length} on open ground${bad.length ? ': ' + bad.join(', ') : ''}`);
    };
    const walkTo = async (p, n = 4) => {
      await game('placePlayer', p.x, p.z, 0);
      await step(n);
    };

    // The Great Pie Heist: grab the pies and you're wanted; Jono won't open up till you've lost them.
    let m = await begin('pie-heist', { cops: true });
    check(m.active === 'pie-heist' && m.props.length === 1, `the pie heist starts with the pies out (${m.props.length} prop)`);
    await onGround('the pies (under the verandah)', m.props, { verandah: true });
    await walkTo(m.props[0]);
    await step(30);
    let s = await state();
    m = await missions();
    check(s.heat === 2 && /Lose the cops/.test(m.objective), `grabbing the pies: wanted at ${s.heat} ("${m.objective}")`);
    await game('setHeat', 0);
    await step(30);
    m = await missions();
    const jono = await place('jonos-bakery');
    check(m.target?.label === jono.name, `lost them: off to ${m.target?.label}`);
    await walkTo(jono);
    m = await finish(120);
    check(m.last?.id === 'pie-heist' && m.last.result === 'passed', `pies fenced: ${m.last?.result} ("${m.last?.message}")`);

    // Fairy Lights: Lights Out on the lawn, solved by trying every set of steps.
    m = await begin('fairy-lights');
    let rounds = 0;
    for (let round = 0; round < 2; round++) {
      m = await missions();
      const pads = m.props.filter((p) => p.style === 'pad');
      if (round === 0) check(pads.length === 5, `Fairy Lights opens with a ring of ${pads.length}`);
      await onGround(`Fairy Lights round ${round + 1} pads`, pads);
      const n = pads.length;
      const lit = pads.map((p) => p.colour === LIT);
      // Neighbours as the mission has them: a ring, then a 3x3 grid.
      const flips = (i) => (n === 5 ? [(i + 4) % 5, i, (i + 1) % 5] : [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]].map(([a, b]) => [Math.floor(i / 3) + a, (i % 3) + b]).filter(([a, b]) => a >= 0 && a < 3 && b >= 0 && b < 3).map(([a, b]) => a * 3 + b));
      let press = null;
      for (let mask = 1; mask < 1 << n && !press; mask++) {
        const l = [...lit];
        for (let i = 0; i < n; i++) if (mask & (1 << i)) for (const j of flips(i)) l[j] = !l[j];
        if (l.every(Boolean)) press = [...Array(n).keys()].filter((i) => mask & (1 << i));
      }
      for (const i of press ?? []) {
        await walkTo(pads[i], 6);
        await walkTo({ x: pads[i].x, z: pads[i].z + 30 }, 6);
      }
      await step(120);
      rounds++;
    }
    m = await finish(120);
    check(m.last?.id === 'fairy-lights' && m.last.result === 'passed' && rounds === 2, `all lit, both puzzles: ${m.last?.result} ("${m.last?.message}")`);

    // Cabbie: three fares, teleporting to each pick-up and drop.
    m = await begin('cabbie', { car: true });
    check(m.active === 'cabbie' && m.clock?.down, `the cab's meter is running (${m.clock?.seconds.toFixed(0)} s)`);
    const stops = [];
    for (let i = 0; i < 6; i++) {
      m = await missions();
      if (!m.target) break;
      stops.push(m.target.label);
      await game('teleportCar', 0, m.target.x, m.target.z, 0);
      await step(20);
    }
    m = await missions();
    check(m.board[0]?.rows[0]?.note === '3' && m.clock?.seconds > 60, `three fares and the meter's up to ${m.clock?.seconds.toFixed(0)} s: ${stops.slice(0, 2).join(' → ')} …`);
    m = await finish(60 * 400);
    check(m.last?.id === 'cabbie' && m.last.result === 'passed', `meter off: ${m.last?.result} ("${m.last?.message}")`);

    // Speed Trap: cameras along the road; through each at speed.
    m = await begin('speed-trap', { car: true });
    const cams = m.props.filter((p) => p.label === 'Speed camera');
    check(cams.length === 12, `${cams.length} speed cameras on the road`);
    await onGround('speed cameras', cams);
    await step(60 * 4);
    for (const [i, c] of cams.entries()) {
      const next = cams[i + 1] ?? { x: c.x + (c.x - cams[i - 1].x), z: c.z + (c.z - cams[i - 1].z) };
      const h = Math.atan2(-(next.z - c.z), next.x - c.x);
      await game('teleportCar', 0, c.x - Math.cos(h) * 12, c.z + Math.sin(h) * 12, h);
      await game('launchCar', 0, 25);
      await step(40);
    }
    m = await finish(60 * 10);
    check(m.last?.id === 'speed-trap' && m.last.result === 'passed', `flashed them all: ${m.last?.result} ("${m.last?.message}")`);

    // Kererū Seeds: hidden seeds show only close up; the sensor warms as you near one.
    m = await begin('kereru-seeds');
    const seeds = m.props;
    const sensor = () => m.board.find((b) => b.title === 'Sensor')?.rows[0]?.note;
    check(seeds.length === 10 && seeds.every((p) => p.draw <= 40), `ten seeds, each seen only within ${seeds[0]?.draw} m`);
    await onGround('kererū seeds', seeds);
    await walkTo({ x: seeds[0].x + 15, z: seeds[0].z });
    m = await missions();
    const warm = sensor();
    for (const p of seeds) await walkTo(p, 8);
    m = await finish(120);
    check(/hot/.test(warm) && m.last?.id === 'kereru-seeds' && m.last.result === 'passed', `15 m from a seed the sensor reads "${warm}"; all ten: ${m.last?.result} ("${m.last?.message}")`);

    // Here, Biscuit!: he runs from you; walk up behind him when he's puffed, then carry him home.
    m = await begin('here-boy');
    let dog = m.props.find((p) => p.label === 'Biscuit');
    await onGround('the park Biscuit runs about', [dog, { x: -1135 + 52, z: 280 }, { x: -1135 - 52, z: 280 }, { x: -1135, z: 280 - 52 }, { x: -1135, z: 280 + 52 }]);
    let caught = false;
    for (let i = 0; i < 40 && !caught; i++) {
      m = await missions();
      dog = m.props.find((p) => p.label === 'Biscuit');
      caught = dog?.carrier !== null && dog?.carrier !== undefined;
      if (!caught) await walkTo({ x: dog.x + 0.5, z: dog.z }, 3);
    }
    check(caught, 'caught Biscuit');
    const owner = m.targets[0];
    await walkTo(owner, 10);
    m = await finish(120);
    check(m.last?.id === 'here-boy' && m.last.result === 'passed', `Biscuit home: ${m.last?.result} ("${m.last?.message}")`);

    // Metal Detector: nothing to see; stand still on the spot to dig.
    m = await begin('metal-detector');
    check(m.props.length === 0 && m.board.some((b) => b.title === 'Detector'), 'nothing showing, just the detector');
    const buried = [[1860, 675], [1902, 670], [1940, 686], [1877, 700], [1925, 699]].map(([x, z]) => ({ x, z }));
    await onGround('buried things', buried);
    for (const b of buried) await walkTo(b, 60 * 2.5);
    m = await finish(120);
    check(m.last?.id === 'metal-detector' && m.last.result === 'passed', `all dug up: ${m.last?.result} ("${m.last?.message}")`);

    // Paper Round: letterboxes both sides of Parnell Road.
    m = await begin('paper-round', { car: true });
    const boxes = m.props;
    check(boxes.length === 20, `${boxes.length} letterboxes`);
    await onGround('letterboxes', boxes);
    await step(60 * 4);
    for (const b of boxes) {
      await game('teleportCar', 0, b.x, b.z, 0);
      await game('launchCar', 0, 6);
      await step(6);
    }
    const papers = (await missions()).board[0]?.rows[0]?.note;
    m = await finish(120);
    check(m.last?.id === 'paper-round' && m.last.result === 'passed', `papers in (${papers}): ${m.last?.result} ("${m.last?.message}")`);

    // Hokey Pokey Run: pull up by each kid and stop.
    m = await begin('ice-cream-van', { car: true });
    let served = 0;
    for (let i = 0; i < 14; i++) {
      m = await missions();
      if (!m.active) break;
      const kid = m.props.find((p) => p.label === 'A kid');
      if (!kid) {
        await step(30);
        continue;
      }
      await game('teleportCar', 0, kid.x, kid.z, 0);
      await step(100);
      served++;
    }
    m = await finish(600);
    check(m.last?.id === 'ice-cream-van' && m.last.result === 'passed', `served ${served} stops: ${m.last?.result} ("${m.last?.message}")`);
    await game('reset');
  },
};
