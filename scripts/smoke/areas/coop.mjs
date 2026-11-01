// Missions in a room (#27): the host runs a shared mission for everyone and
// the guest sees it. The milk run as a race the guest wins, Last Orders
// (two bars at once, then everyone back), and the host leaving mid-mission.
// Two tabs stepped in turn, so like rooms.mjs these aren't exactly repeatable.

import { openGuest } from '../game.mjs';

const loose = { stable: false };

export default {
  name: 'coop',
  core: false,
  page: 'auckland',
  async run({ page, context, check, game, step }) {
    const guest = await openGuest(context, page);
    const { g, step: gStep } = guest;
    check(guest.joined, 'a second tab joins the room');
    const place = (id) => game('place', id);
    const missions = () => game('missions');
    const gMissions = () => g('missions');
    /** Each page sends poses and mission state only while stepped. */
    const settle = async (n = 30) => {
      await gStep(n);
      await step(n);
      await gStep(n);
    };
    // Members aren't listed in any fixed order: find the guest by its own id.
    const groom = await g('room');
    const guestName = groom.members.find((x) => x.id === groom.myId).name;

    // Milk run: the host on the marker waits for the guest, then it starts for both.
    const dairy = await place('k-road-dairy');
    const ferry = await place('ferry-building');
    await game('placePlayer', dairy.x, dairy.z, 0);
    await g('placePlayer', dairy.x + 200, dairy.z, 0);
    await settle();
    let m = await missions();
    check(!m.active && /get everyone here \(1 of 2\)/.test(m.hint), `on the marker alone: "${m.hint}"`, loose);
    await g('placePlayer', dairy.x + 15, dairy.z, 0);
    await settle();
    m = await missions();
    let gm = await gMissions();
    check(m.active === 'milk-run' && gm.active === 'milk-run' && gm.banner?.title === 'Milk Run', `with the guest there it starts for both (host ${m.active}, guest "${gm.banner?.title}")`, loose);
    await step(60 * 8); // countdown
    await gStep(30);
    gm = await gMissions();
    check(gm.clock?.down && gm.clock.seconds > 80 && gm.target?.label === 'the Ferry Building', `the guest sees the clock (${gm.clock?.seconds.toFixed(0)} s) and the beam on ${gm.target?.label}`, loose);
    await g('placePlayer', ferry.x, ferry.z, 0);
    await settle();
    await step(30);
    await gStep(30);
    m = await missions();
    gm = await gMissions();
    check(m.last?.id === 'milk-run' && m.last.result === 'passed' && m.last.message.startsWith(guestName), `the guest gets to Nan first: "${m.last?.message}" (the guest is ${guestName})`, loose);
    check(gm.last?.result === 'passed' && gm.banner?.kind === 'passed', `and the guest sees Mission passed ("${gm.last?.message}")`, loose);

    // Last Orders: two or more; the guest starts it, one to each bar, then both back.
    const home = await place('shouts-on-you');
    const [west, east] = [await place('the-salty-sheep'), await place('the-tipsy-weka')];
    await game('placePlayer', home.x + 12, home.z, 0);
    await g('placePlayer', home.x + 20, home.z, 0);
    await settle(60);
    m = await missions();
    check(m.starts.some((s) => s.id === 'last-orders'), `Last Orders shows with two in the room (${m.starts.map((s) => s.id).join(', ')})`, loose);
    await g('placePlayer', home.x, home.z, 0);
    await settle();
    await step(30);
    await gStep(30);
    m = await missions();
    gm = await gMissions();
    check(m.active === 'last-orders' && gm.active === 'last-orders', `the guest steps in and the host starts it (host ${m.active}, guest ${gm.active})`, loose);
    check(gm.targets.length === 2, `two beams for the guest: ${gm.targets.map((t) => t.label).join(', ')}`, loose);
    await game('placePlayer', west.x, west.z, 0);
    await g('placePlayer', east.x, east.z, 0);
    await settle();
    await step(30);
    m = await missions();
    check(m.said.filter((s) => /got a jug in/.test(s)).length === 2 && m.targets.length === 1 && m.target?.label === home.name, `a jug at each bar, then back to ${m.target?.label}`, loose);
    await game('placePlayer', home.x, home.z + 4, 0);
    await settle();
    m = await missions();
    check(m.active === 'last-orders', 'the host back alone: still waiting on the guest', loose);
    await g('placePlayer', home.x + 4, home.z, 0);
    await settle();
    await step(30);
    await gStep(30);
    m = await missions();
    gm = await gMissions();
    check(m.last?.id === 'last-orders' && m.last.result === 'passed' && gm.last?.id === 'last-orders' && gm.last.result === 'passed', `both back: passed for both ("${m.last?.message}")`, loose);

    // Grandad's Riddles together: the guest sees everyone's hot/cold reading and can solve one.
    const queen = await place('lower-queen-st');
    await game('placePlayer', queen.x + 10, queen.z, 0);
    await g('placePlayer', queen.x + 14, queen.z, 0);
    await settle(60);
    await game('placePlayer', queen.x, queen.z, 0);
    await g('placePlayer', queen.x + 4, queen.z, 0);
    await settle();
    await step(30);
    await gStep(30);
    gm = await gMissions();
    const hostName = groom.members.find((x) => x.host).name;
    const heat = gm.board?.[1]?.rows ?? [];
    check(gm.active === 'grandads-riddles' && gm.board?.[0]?.rows.length === 5 && heat.some((r) => r.text === hostName) && heat.some((r) => r.text === guestName) && gm.targets.length === 0,
      `riddles for both, no beams; the guest's board: ${heat.map((r) => `${r.text} ${r.note}`).join(', ')}`, loose);
    const steep = await place('aucklands-steepest-street');
    await g('placePlayer', steep.x, steep.z, 0);
    await settle();
    await step(30);
    m = await missions();
    check(m.said.some((s) => s.startsWith(`${guestName} solved one`)), `the guest solves the steepest street: "${m.said.find((s) => /solved one/.test(s))}"`, loose);
    // Starting another mission abandons the riddles; the host-leaves check below wants a milk run going anyway.
    await game('startMission', 'milk-run');
    await settle();

    // The host leaves mid-mission: it ends for the guest.
    await g('placePlayer', dairy.x + 15, dairy.z, 0);
    await game('placePlayer', dairy.x + 10, dairy.z, 0);
    await settle(60);
    await game('placePlayer', dairy.x, dairy.z, 0);
    await settle();
    gm = await gMissions();
    const running = gm.active === 'milk-run';
    await game('leaveRoom');
    await guest.page.waitForFunction(() => window.__game.room().role === 'solo', null, { timeout: 5000 }).catch(() => {});
    await gStep(10);
    gm = await gMissions();
    check(running && !gm.active && gm.last?.result === 'failed' && /went home/.test(gm.last.message), `the host leaves: "${gm.last?.message}" for the guest`, loose);

    check(guest.errors.length === 0, `no console errors on the guest's page${guest.errors.length ? ': ' + guest.errors.join(' | ') : ''}`);
    await guest.page.close();
    await game('reset');
  },
};
