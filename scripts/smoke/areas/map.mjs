// The map (#14, src/map/): the minimap is up in the corner, no screen-edge
// arrows any more; tapping the minimap opens the full map and pauses; a tap
// on the map sets a waypoint with a road route to it, a tap on a mission
// heads for it, a tap on the waypoint clears it; the route follows you and
// the waypoint clears when you get there. On a mission the route goes to its goal.

export default {
  name: 'map',
  core: false,
  page: 'auckland',
  async run({ page, check, game, state, step, shot }) {
    const map = () => game('mapState');
    await step(5);
    let m = await map();
    const box = await page.locator('#minimap').boundingBox();
    check(m.minimap && box && box.x < 40 && box.y < 40 && box.width >= 100, `the minimap is up, top left (${JSON.stringify(box && { x: Math.round(box.x), y: Math.round(box.y), w: box.width })})`);
    check((await page.locator('.mission-arrow').count()) === 0, 'no screen-edge arrow');
    check(!m.waypoint && !m.destination && m.routePoints === 0, 'nowhere to go at the start: no waypoint, no route');
    await shot('80-minimap');

    // Tap the minimap: the full map, paused.
    await page.locator('#minimap').click();
    m = await map();
    check(m.open && (await state()).paused && (await page.locator('#map-full').isVisible()), 'clicking the minimap opens the full map and pauses the game');

    // Tap a few blocks down the hill: a waypoint there (on the nearest road), and a road route longer than as the crow flies.
    const you = (await state()).player;
    const hall = { x: you[0] + 120, z: you[2] - 260 };
    let at = await game('mapPoint', hall.x, hall.z);
    await page.mouse.click(at.x, at.y);
    m = await map();
    const crow = Math.hypot(hall.x - you[0], hall.z - you[2]);
    check(m.waypoint && Math.hypot(m.waypoint.x - hall.x, m.waypoint.z - hall.z) < 45 && m.destination?.kind === 'waypoint',
      `clicking the map puts a waypoint there (${JSON.stringify(m.waypoint)})`);
    check(m.routePoints > 3 && m.routeLeft > crow * 0.95 && m.routeLeft < crow * 4, `with a road route to it (round the one-ways): ${m.routeLeft} m over ${m.routePoints} points (${Math.round(crow)} m as the crow flies)`);
    await page.waitForTimeout(100); // the full map redraws on the next animation frame
    await shot('81-full-map-waypoint');

    // Tap the waypoint again: gone.
    at = await game('mapPoint', m.waypoint.x, m.waypoint.z);
    await page.mouse.click(at.x, at.y);
    m = await map();
    check(!m.waypoint && m.routePoints === 0, 'clicking the waypoint again clears it');

    // Zoom out (−) and tap a mission's blip: the waypoint goes on its start marker.
    const start = (await game('missions')).nearest;
    await page.locator('#map-full [aria-label="Zoom out"]').click();
    at = await game('mapPoint', start.x, start.z);
    await page.mouse.click(at.x + 4, at.y - 3);
    m = await map();
    check(m.waypoint && Math.hypot(m.waypoint.x - start.x, m.waypoint.z - start.z) < 1, `clicking a mission's blip heads for its start (${JSON.stringify(m.waypoint)}, ${start.id} at ${Math.round(start.x)}, ${Math.round(start.z)})`);

    // Drag pans, and a drag isn't a tap.
    const before = await game('mapPoint', start.x, start.z);
    await page.mouse.move(640, 360);
    await page.mouse.down();
    await page.mouse.move(540, 320, { steps: 5 });
    await page.mouse.up();
    const after = await game('mapPoint', start.x, start.z);
    m = await map();
    check(Math.abs(after.x - before.x + 100) < 2 && Math.abs(after.y - before.y + 40) < 2 && m.waypoint && Math.hypot(m.waypoint.x - start.x, m.waypoint.z - start.z) < 1,
      `dragging pans the map (${Math.round(after.x - before.x)}, ${Math.round(after.y - before.y)} px) and leaves the waypoint`);

    // Escape closes it and play carries on.
    await page.keyboard.press('Escape');
    m = await map();
    check(!m.open && !(await state()).paused, 'Escape closes the map and carries on');
    await page.keyboard.press('Tab');
    check((await map()).open, 'Tab opens it');
    await page.keyboard.press('Tab');
    check(!(await map()).open, 'and Tab again closes it');

    // Walking away from the route: it's worked out again from where you are.
    const left = m.routeLeft;
    await game('placePlayer', you[0] - 200, you[2] + 150, 0);
    await step(70);
    m = await map();
    check(m.routePoints > 2 && Math.abs(m.routeLeft - left) > 50, `off the route, it's worked out again from there (${left} → ${m.routeLeft} m)`);
    await shot('82-minimap-route');

    // Getting there clears the waypoint (one of your own, not on a mission's marker).
    await game('waypoint', hall.x, hall.z);
    const wp = (await map()).waypoint;
    await game('placePlayer', wp.x + 5, wp.z + 5, 0);
    await step(5);
    m = await map();
    check(!m.waypoint, 'arriving at the waypoint clears it');

    // On a mission, the route goes to its goal.
    await game('reset');
    const dairy = await game('place', 'k-road-dairy');
    const ferry = await game('place', 'ferry-building');
    await game('placePlayer', dairy.x, dairy.z, 0);
    await step(60);
    m = await map();
    check(m.destination?.kind === 'goal' && Math.hypot(m.destination.x - ferry.x, m.destination.z - ferry.z) < 2 && m.routePoints > 3,
      `on the milk run the route goes to the Ferry Building (${m.routeLeft} m)`);
    await shot('83-minimap-goal');
    // A waypoint of your own wins until you clear it.
    await game('waypoint', dairy.x + 300, dairy.z);
    m = await map();
    check(m.destination?.kind === 'waypoint', 'a waypoint of your own takes over');
    await game('waypoint');
    m = await map();
    check(m.destination?.kind === 'goal', 'and clearing it goes back to the goal');
  },
};
