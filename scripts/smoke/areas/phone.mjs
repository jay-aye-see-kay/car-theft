// Phone, touch: the on-foot and driving layouts, the stick walks, the enter
// button gets in, the minimap keeps clear of the controls and a tap opens
// the map. Touches go through CDP, so they reach the game the same way a
// finger does.

export default {
  name: 'phone',
  core: false,
  page: 'phone',
  async run({ page, context, check, game, state, step, run, shot, dist }) {
    await step(30);
    const footButtons = await page.locator('.touch .btn:visible').count();
    check((await page.locator('.btn-sprint').isVisible()) && !(await page.locator('.btn-gas').isVisible()), `on-foot touch layout (${footButtons} buttons)`);
    check(await page.locator('.btn-enter.ready').isVisible(), 'enter button lights up near a car');
    await shot('6-foot');

    // Drag the stick upwards (walk forward) for a second.
    const box = await page.locator('.stick').boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const cdp = await context.newCDPSession(page);
    const touch = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: cx, y }] });
    const before = (await state()).player;
    await touch('touchStart', cy);
    await touch('touchMove', cy - 50);
    const { s: walked } = await run({ max: 60 });
    await touch('touchEnd');
    check(dist(before, walked.player) > 1, `touch stick walks (moved ${dist(before, walked.player).toFixed(1)} m)`);

    // Walk back until the car is in reach and get in with the button.
    await touch('touchStart', cy);
    await touch('touchMove', cy + 50);
    await run({ max: 600, every: 2, until: (x) => x.nearCar });
    await touch('touchEnd');
    await page.locator('.btn-enter').tap({ force: true }); // it pulses, so never "stable"
    const s = await step(2);
    check(s.mode === 'car', 'touch enter button gets in');
    check(await page.locator('.btn-gas').isVisible(), 'driving touch layout');
    await shot('7-car');

    // Rotate to portrait and back: the canvas buffer must follow its on-screen
    // box, or the picture stretches (iOS reports stale sizes mid-rotation).
    const rotate = async (size) => {
      await page.setViewportSize(size);
      // Leaving fullscreen can restore the old window size late: wait for ours, then a frame for the ResizeObserver.
      await page.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, [size.width, size.height]);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      return page.evaluate(() => {
        const c = document.querySelector('canvas');
        const r = c.getBoundingClientRect();
        return Math.abs(c.width / c.height - r.width / r.height) < 0.01 && r.width === innerWidth && r.height === innerHeight;
      });
    };
    await page.evaluate(() => document.fullscreenElement && document.exitFullscreen()); // tap-to-play went fullscreen
    const landscape = page.viewportSize();
    const portraitFits = await rotate({ width: landscape.height, height: landscape.width });
    check(portraitFits && (await rotate(landscape)), 'canvas fills the screen unstretched after rotating');

    // The minimap: top left, clear of the stick and buttons; a tap opens the map, a tap there sets a waypoint.
    const overlaps = await page.evaluate(() => {
      const m = document.querySelector('#minimap').getBoundingClientRect();
      return [...document.querySelectorAll('.touch .stick, .touch .btn, #mute, #tweaks-btn, #room-btn')]
        .filter((e) => e.offsetParent)
        .map((e) => [e.className || e.id, e.getBoundingClientRect()])
        .filter(([, r]) => r.left < m.right && r.right > m.left && r.top < m.bottom && r.bottom > m.top)
        .map(([n]) => n);
    });
    const mini = await page.locator('#minimap').boundingBox();
    check(mini && mini.width >= 100 && overlaps.length === 0, `the minimap (${mini?.width} px) is clear of the touch controls${overlaps.length ? ': overlaps ' + overlaps.join(', ') : ''}`);
    await page.locator('#minimap').tap();
    check((await game('mapState')).open && !(await page.locator('.touch .stick').isVisible()), 'tapping the minimap opens the map, touch controls out of the way');
    const size2 = page.viewportSize();
    await page.touchscreen.tap(size2.width / 2 + 80, size2.height / 2 - 60);
    check(!!(await game('mapState')).waypoint, 'a tap on the map sets a waypoint');
    await shot('7-map');
    await page.locator('#map-full [aria-label="Close map"]').tap();
    const after = await game('mapState');
    check(!after.open && after.routePoints > 1 && (await page.locator('.minimap-label').isVisible()), `✕ closes it; the route and distance are on the minimap (${after.routeLeft} m)`);
  },
};
