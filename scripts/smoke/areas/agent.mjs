// The agents' hooks (src/agent/, scripts/agent/, docs/AGENT-PLAYTEST.md):
// the autopilot drives a car to a place by road and walks you to a spot, the
// journal says what happened, and agent() gives one rounded look at it all.

export default {
  name: 'agent',
  core: false,
  page: 'auckland',
  async run({ check, game, step, getIn, dist }) {
    // A scripted drive: nothing else on the road.
    await game('knob', 'traffic.on', false);
    await game('knob', 'cops.on', false);
    const v0 = await game('agent', 40);
    check(v0.mode === 'foot' && v0.street?.name === 'Queen Street' && v0.nearCar === 0 && v0.cars.some((c) => c.i === 0 && c.kind === 'purple'), `agent(): on foot on ${v0.street?.name}, the purple car #${v0.nearCar} in reach`);
    await game('journal');

    // Walk 15 m along the footpath and back to the car.
    const to = [v0.pos[0] + 4, v0.pos[2] - 14];
    await game('pilot', { to, via: 'direct' });
    let p;
    for (let i = 0; i < 20 && (p = await game('pilotState')).status === 'driving'; i++) await step(15);
    const walked = await game('agent', 0);
    check(p.status === 'arrived' && dist([walked.pos[0], 0, walked.pos[2]], [to[0], 0, to[1]]) < 2.5, `walked to the spot (${p.status} in ${p.time} s)`);

    // Drive to the Town Hall by road: it gets there, stops, and the journal says we got in.
    await getIn();
    const hall = await game('place', 'town-hall');
    const set = await game('pilot', { to: [hall.x, hall.z] });
    for (let i = 0; i < 60 && (p = await game('pilotState')).status === 'driving'; i++) await step(30);
    const there = await game('agent', 0);
    const lines = await game('journal');
    check(set.mode === 'car' && p.status === 'arrived' && there.kmh < 3 && dist([there.pos[0], 0, there.pos[2]], [hall.x, 0, hall.z]) < 8, `drove ${set.length} m to ${hall.name}: ${p.status} in ${p.time} s, ${there.kmh} km/h, ${p.unsticks} back-outs`);
    check(lines.some((l) => /got in car #0 \(purple\)/.test(l)) && !lines.some((l) => /crash|hit a pedestrian|knocked down/.test(l)), `journal: ${lines.map((l) => l.replace(/^[\d.]+ /, '')).join(' | ')}`);
    await game('pilot', null);
  },
};
