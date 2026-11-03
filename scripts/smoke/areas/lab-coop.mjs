// The mission lab's shared missions (lab-missions.mjs has the solo ones),
// played by a host and a guest tab in one room: pads only both can hold, a
// code only the reader sees, a bag passed between them, a convoy, party
// games with a winner. Two tabs stepped in turn, so like coop.mjs these
// aren't exactly repeatable.

import { openGuest } from '../game.mjs';

const loose = { stable: false };

export default {
  name: 'lab-coop',
  core: false,
  page: 'auckland',
  async run({ page, context, check, game, step, state, getIn }) {
    await game('knob', 'traffic.on', false);
    await game('knob', 'cops.on', false);
    const guest = await openGuest(context, page);
    const { g, step: gStep } = guest;
    check(guest.joined, 'a second tab joins the room');
    await g('knob', 'traffic.on', false);
    await g('knob', 'cops.on', false);
    const missions = () => game('missions');
    const gMissions = () => g('missions');
    const settle = async (n = 20) => {
      await gStep(n);
      await step(n);
      await gStep(n);
    };
    const host = (p) => game('placePlayer', p.x, p.z, 0);
    const guestAt = (p) => g('placePlayer', p.x, p.z, 0);
    const begin = async (id) => {
      const m0 = (await missions()).missions.find((x) => x.id === id);
      await host({ x: m0.start.x + 3, z: m0.start.z });
      await guestAt({ x: m0.start.x - 3, z: m0.start.z });
      await settle(30);
      await game('startMission', id);
      await settle(20);
      return [await missions(), await gMissions()];
    };
    const finish = async (max = 600) => {
      for (let n = 0; n < max; n += 15) {
        await settle(15);
        const m = await missions();
        if (!m.active) return m;
      }
      return missions();
    };
    const groom = await g('room');
    const guestName = groom.members.find((x) => x.id === groom.myId).name;

    // Two Keys: every pad held at once, by different people.
    let [m, gm] = await begin('two-keys');
    check(m.active === 'two-keys' && gm.active === 'two-keys' && gm.props.filter((p) => p.style === 'pad').length === 2, `Two Keys: the guest sees ${gm.props.length} pads`, loose);
    await host(m.props[0]);
    await settle(30);
    m = await missions();
    check(m.board[0]?.rows[0]?.note === '1 of 2 pads' && m.active, `one pad alone does nothing (${m.board[0]?.rows[0]?.note})`, loose);
    for (let k = 0; k < 120; k++) {
      m = await missions();
      if (!m.active) break;
      const pads = m.props.filter((p) => p.style === 'pad');
      if (pads.length < 2) {
        await settle(20);
        continue;
      }
      await host(pads[0]);
      await guestAt(pads[1]);
      await settle(12);
    }
    const keys = `${m.objective}; ${JSON.stringify(m.board)}; ${JSON.stringify(m.props.map((p) => [p.x | 0, p.z | 0]))}`;
    m = await finish(300);
    check(m.last?.id === 'two-keys' && m.last.result === 'passed', `all four locks: ${m.last?.result} ("${m.last?.message}") [${keys}]`, loose);

    // Colour Code: the guest on the reader sees the code; the host enters it.
    [m, gm] = await begin('colour-code');
    const reader = m.props.find((p) => p.label === 'Code reader');
    const pads = Object.fromEntries(m.props.filter((p) => / pad$/.test(p.label ?? '')).map((p) => [p.label.split(' ')[0].toUpperCase(), p]));
    await guestAt(reader);
    await settle(20);
    for (let round = 0; round < 3; round++) {
      await settle(20);
      gm = await gMissions();
      m = await missions();
      const secret = gm.board.find((b) => /only you/.test(b.title ?? ''));
      if (round === 0) check(!!secret && !m.board.some((b) => /only you/.test(b.title ?? '')), `the code is on the reader's board only (${secret?.rows.map((r) => r.text).join(', ')})`, loose);
      for (const r of secret?.rows ?? []) {
        const name = r.text.replace(/^\d+\. /, '');
        await host(pads[name]);
        await settle(10);
        await host({ x: pads[name].x, z: pads[name].z + 12 });
        await settle(10);
      }
      await settle(40);
    }
    m = await finish(120);
    check(m.last?.id === 'colour-code' && m.last.result === 'passed', `three codes cracked: ${m.last?.result} ("${m.last?.message}")`, loose);

    // The Casino Job: the host on the switch, the guest on the chips.
    [m] = await begin('casino-job');
    for (let half = 0; half < 2; half++) {
      m = await missions();
      await host(m.props.find((p) => p.label === 'Security switch'));
      await settle(10);
      m = await missions();
      for (const c of m.props.filter((p) => p.label === 'Chip').slice(0, 3)) {
        await guestAt(c);
        await settle(10);
      }
      await settle(20);
    }
    m = await missions();
    check(/getaway/i.test(m.objective) && m.said.every((x) => !/Smile/.test(x)), `six chips with the cameras off, then "${m.objective}"`, loose);
    await host(m.targets[0]);
    await guestAt({ x: m.targets[0].x + 2, z: m.targets[0].z });
    m = await finish(120);
    check(m.last?.id === 'casino-job' && m.last.result === 'passed', `the getaway: ${m.last?.result} ("${m.last?.message}")`, loose);

    // Pass the Parcel: the host picks up the bag, hands it to the guest, who runs it home.
    [m] = await begin('pass-the-parcel');
    const bag = m.props.find((p) => p.label === 'The bag');
    await host(bag);
    await settle(10);
    m = await missions();
    const held = m.props.find((p) => p.label === 'The bag').carrier;
    await guestAt({ x: bag.x + 1, z: bag.z });
    await settle(10);
    m = await missions();
    const passed = m.props.find((p) => p.label === 'The bag').carrier;
    check(held === 0 && passed !== 0 && passed !== null, `the host picks up the bag (${held}) and hands it to the guest (${passed})`, loose);
    await guestAt(m.targets[0]);
    m = await finish(120);
    check(m.last?.id === 'pass-the-parcel' && m.last.result === 'passed', `the guest gets it to the safehouse: ${m.last?.result} ("${m.last?.message}")`, loose);

    // You're It!: two minutes of tag; it passes on a touch.
    [m] = await begin('tag');
    const park = { x: -1135, z: 280 };
    await host(park);
    await guestAt({ x: park.x + 20, z: park.z });
    await settle(20);
    m = await missions();
    const firstIt = m.board[0].title;
    await guestAt({ x: park.x + 1, z: park.z });
    await settle(10);
    m = await missions();
    check(m.board[0].title !== firstIt && /got/.test(m.said[m.said.length - 1] ?? ''), `a touch passes it: "${firstIt}" → "${m.board[0].title}"`, loose);
    await guestAt({ x: park.x + 30, z: park.z });
    m = await finish(60 * 130);
    check(m.last?.id === 'tag' && m.last.result === 'passed' && /wins/.test(m.last.message), `tag ends: "${m.last?.message}"`, loose);

    // King of the Square: the guest alone on the ring scores; both on it, nobody does.
    [m] = await begin('king-of-the-hill');
    let ring = m.props.find((p) => p.label === 'The ring');
    await guestAt(ring);
    await host({ x: ring.x + 30, z: ring.z });
    for (let i = 0; i < 260; i++) {
      m = await missions();
      if (!m.active) break;
      ring = m.props.find((p) => p.label === 'The ring');
      await guestAt(ring);
      await settle(20);
    }
    m = await finish(300);
    check(m.last?.id === 'king-of-the-hill' && m.last.message.startsWith(guestName), `the guest holds the ring to a minute: "${m.last?.message}"`, loose);

    // Musical Chairs: into the circle, keep moving, then the guest gets the only chair.
    [m] = await begin('musical-chairs');
    const circle = m.props.find((p) => p.label === 'Musical chairs');
    await host(circle);
    await guestAt({ x: circle.x + 4, z: circle.z });
    await settle(20);
    // Both walk about (held keys count while stepped) so neither stands still while the music plays.
    await page.keyboard.down('KeyA');
    await guest.page.keyboard.down('KeyD');
    for (let i = 0; i < 200; i++) {
      await settle(6);
      m = await missions();
      const chair = m.props.find((p) => p.style === 'pad' && p.radius < 3);
      if (chair) {
        await page.keyboard.up('KeyA');
        await guest.page.keyboard.up('KeyD');
        await guestAt(chair);
        await settle(20);
        break;
      }
    }
    await page.keyboard.up('KeyA');
    await guest.page.keyboard.up('KeyD');
    const chairs = `${m.objective}; ${m.said.slice(-3).join(' / ')}; ${JSON.stringify(m.props)}`;
    m = await finish(300);
    check(m.last?.id === 'musical-chairs' && m.last.message.startsWith(guestName), `the guest gets the chair: "${m.last?.message}" [${chairs}]`, loose);

    // Pie Rush: pies from the counter to the orders, between the two of you.
    [m] = await begin('pie-rush');
    const counter = m.props.find((p) => p.label === "Kev's counter");
    let deliveries = 0;
    for (let i = 0; i < 400; i++) {
      m = await missions();
      if (!m.active) break;
      const orders = m.targets;
      if (!orders.length) {
        await settle(30);
        continue;
      }
      await host(counter);
      await guestAt(counter);
      await settle(6);
      await host(orders[0]);
      if (orders[1]) await guestAt(orders[1]);
      await settle(6);
      deliveries += orders[1] ? 2 : 1;
      await settle(60);
    }
    m = await finish(60 * 200);
    check(m.last?.id === 'pie-rush' && m.last.result === 'passed', `pie runs (${deliveries}): ${m.last?.result} ("${m.last?.message}")`, loose);

    // Tied Together: two cars, one rope; drive apart and it snaps.
    await getIn();
    const parked = (await g('state')).cars;
    await g('placePlayer', parked[1][0], parked[1][2] + 1.8, 0);
    await gStep(2);
    await guest.page.keyboard.press('KeyF');
    await gStep(4);
    const gIndex = (await g('state')).drivingIndex;
    const queen = await game('place', 'mid-queen-st');
    await game('teleportCar', 0, queen.x, queen.z, 0);
    await g('teleportCar', gIndex, queen.x + 6, queen.z, 0);
    await settle(30);
    await game('startMission', 'tied-together');
    await settle(60 * 5);
    m = await missions();
    for (let i = 0; i < 6 && m.active; i++) {
      if (!m.target) break;
      await game('teleportCar', 0, m.target.x, m.target.z, 0);
      await g('teleportCar', gIndex, m.target.x + 5, m.target.z, 0);
      await settle(30);
      m = await missions();
    }
    const convoy = `${m.objective}; ${m.said.slice(-2).join(' / ')}; guest ${(await g('state')).mode}`;
    check(m.last?.id === 'tied-together' && m.last.result === 'passed', `the convoy through every checkpoint: ${m.last?.result} ("${m.last?.message}") [${convoy}]`, loose);
    await game('startMission', 'tied-together');
    await settle(60 * 5);
    await g('teleportCar', gIndex, queen.x + 200, queen.z, 0);
    m = await finish(60);
    check(m.last?.result === 'failed' && /SNAP/.test(m.last.message), `200 m apart: "${m.last?.message}"`, loose);
    void state;

    check(guest.errors.length === 0, `no console errors on the guest's page${guest.errors.length ? ': ' + guest.errors.join(' | ') : ''}`);
    await guest.page.close();
    await game('reset');
  },
};
