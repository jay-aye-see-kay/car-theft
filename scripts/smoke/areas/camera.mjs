// The chase camera by hand: look round (and up) in a car; parked it stays
// where you left it, on the move it waits LOOK.recentreDelay and then eases
// back behind. C looks behind while held; the wheel zooms; M opens the map.

/** Smallest difference between two angles, radians. */
const turn = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

export default {
  name: 'camera',
  core: false,
  page: 'auckland',
  async run(t) {
    const { page, check, game, step, run, getIn } = t;
    await game('knob', 'traffic.on', false);
    await game('knob', 'parked.on', false);
    await game('knob', 'cops.on', false);

    check((await getIn()).mode === 'car', 'gets in to look round');
    // Customs St East, heading east along it (drive.mjs drives it too).
    await game('teleportCar', 0, -90, 51, Math.atan2(-81, 228));
    let s = await step(60);
    const behindAt = (x) => turn(x.cam.yaw, x.cam.target);
    check(behindAt(s) < 0.1, `starts behind the car (${behindAt(s).toFixed(2)} rad off)`);

    // Parked: look right and up, and it stays turned.
    await game('look', 1.2, -0.3);
    s = await step(2);
    check(Math.abs(behindAt(s) - 1.2) < 0.1 && s.cam.pitch < -0.2, `the mouse turns the camera in a car (${behindAt(s).toFixed(2)} rad round, pitch ${s.cam.pitch.toFixed(2)})`);
    const camLow = s.cam.pos[1] - s.cars[0][1];
    s = await step(240);
    check(Math.abs(behindAt(s) - 1.2) < 0.1, `parked, it stays where you turned it after 4 s (${behindAt(s).toFixed(2)} rad round)`);

    // On the move: hands off the mouse, it waits a moment then comes back behind.
    await run({ keys: ['KeyW'], max: 60 });
    await game('look', 1.0, 0);
    let r = await run({ keys: ['KeyW'], max: 30 });
    check(behindAt(r.s) > 0.8, `driving, it holds where you looked for a moment (${behindAt(r.s).toFixed(2)} rad round after 0.5 s)`);
    r = await run({ keys: ['KeyW'], max: 240, until: (x) => x.cam.follow >= 1 && behindAt(x) < 0.08 });
    check(behindAt(r.s) < 0.08 && Math.abs(r.s.cam.pitch) < 0.05,
      `left alone, it comes back behind (${behindAt(r.s).toFixed(2)} rad off, pitch ${r.s.cam.pitch.toFixed(2)}, after ${((r.ticks + 30) / 60).toFixed(1)} s, ${r.s.speedKmh.toFixed(0)} km/h)`);
    const camLevel = r.s.cam.pos[1] - r.s.cars[0][1];
    check(camLow < camLevel - 0.3, `looking up lowers the camera (${camLow.toFixed(2)} m over the car, ${camLevel.toFixed(2)} m level)`);

    // C held: straight back past the car; let go and it's behind again.
    await page.keyboard.down('KeyC');
    s = await step(2);
    await page.keyboard.up('KeyC');
    check(turn(s.cam.yaw, s.cam.target + Math.PI) < 0.05, `C looks behind (${turn(s.cam.yaw, s.cam.target).toFixed(2)} rad round)`);
    s = await step(2);
    check(behindAt(s) < 0.1, `letting go of C looks forward again (${behindAt(s).toFixed(2)} rad off)`);

    // Wheel: further out.
    const box = await page.locator('canvas').first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6);
    const near = Math.hypot(s.cam.pos[0] - s.cars[0][0], s.cam.pos[2] - s.cars[0][2]);
    await page.mouse.wheel(0, 500);
    s = await step(120);
    const far = Math.hypot(s.cam.pos[0] - s.cars[0][0], s.cam.pos[2] - s.cars[0][2]);
    check(s.cam.zoom > 1.3 && far > near + 2, `the wheel pulls the camera back (zoom ${s.cam.zoom.toFixed(2)}, ${near.toFixed(1)} -> ${far.toFixed(1)} m)`);

    // M is the map (N mutes now).
    await page.keyboard.press('KeyM');
    check((await game('mapState')).open, 'M opens the full map');
    await page.keyboard.press('KeyM');
    check(!(await game('mapState')).open, 'M again closes it');
  },
};
