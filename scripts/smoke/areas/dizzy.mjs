// Dizzy (#53): a hard landing, a car hitting you on foot and a big crash
// make you dizzy: slower, with stars over your head, then you come round
// and are immune for a bit. Wiggling shakes it off sooner. And the ? panel
// really turns it off.

/** Off a 6 m drop where the player stands: lands at ~16 m/s, over the 13 m/s threshold. */
const DROP = 6;

export default {
  name: 'dizzy',
  core: false,
  page: 'auckland',
  async run(t) {
    const { page, check, game, state, step, run, getIn, shot, dist } = t;
    const fall = async () => {
      await game('dropPlayer', DROP);
      await run({ max: 120, every: 2, until: (s) => s.playerGrounded });
      return game('dizzy');
    };
    const walk = async (ticks) => {
      const a = (await state()).player;
      const { s } = await run({ keys: ['KeyW'], max: ticks });
      return dist(a, s.player);
    };

    // Fall, walk while dizzy, come round, walk again.
    let d = await fall();
    check(d.dizzy && d.cause === 'fall' && d.total >= 2 && d.total <= 5, `a ${DROP} m fall makes you dizzy (for ${d.total.toFixed(2)} s)`);
    const p = await game('peds');
    check(p.stars >= 1, `stars over your head (${p.stars} rings drawn)`);
    await shot('20-dizzy-fall');
    const dizzyWalk = await walk(60);
    await run({ max: 600, until: (s) => !s.dizzy });
    d = await game('dizzy');
    check(!d.dizzy && d.immune, `recovers, then immune for a bit (${JSON.stringify({ dizzy: d.dizzy, immune: d.immune })})`);
    const normalWalk = await walk(60);
    check(dizzyWalk < normalWalk * 0.75, `slower while dizzy (${dizzyWalk.toFixed(2)} m in a second, ${normalWalk.toFixed(2)} m after)`);

    // Immune: the same fall straight away does nothing.
    d = await fall();
    check(!d.dizzy && d.count === 1, `immunity holds: falling again straight after doesn't make you dizzy (${d.count} times so far)`);

    // Once immunity's worn off, the same fall works again; wiggling the stick shakes it off sooner.
    await run({ max: 240, until: () => false });
    d = await fall();
    check(d.dizzy && d.count === 2, 'dizzy again once immunity wears off');
    const total = d.total;
    let ticks = 0;
    for (let i = 0; i < 40 && (await state()).dizzy; i++) {
      const key = i % 2 ? 'KeyA' : 'KeyD';
      await page.keyboard.down(key);
      await step(4);
      await page.keyboard.up(key);
      ticks += 4;
    }
    d = await game('dizzy');
    check(!d.dizzy && ticks / 60 < total * 0.7, `wiggling shakes it off sooner (${(ticks / 60).toFixed(2)} s of ${total.toFixed(2)}, ${d.wiggles} wiggles)`);

    // A car (here a parked one, shoved at you) hitting you on foot: knocked up and dizzy.
    await game('reset');
    await step(10);
    const y0 = (await state()).player[1];
    let top = y0;
    await game('hitPlayer', 1, 9);
    await run({ max: 90, every: 1, sample: (s) => (top = Math.max(top, s.player[1])) });
    d = await game('dizzy');
    check(d.dizzy && d.cause === 'hit' && top - y0 > 0.4, `hit by a car at 9 m/s: knocked ${(top - y0).toFixed(2)} m up and dizzy (${d.cause})`);

    // A big crash, driving: from the west kerb of lower Queen St across into the shopfronts on the east side.
    await game('reset');
    await getIn();
    await game('teleportCar', 0, -190.3, 257.1, Math.atan2(-0.25, 0.97));
    await step(30);
    let kmh = 0;
    await run({ keys: ['KeyW'], max: 300, every: 2, sample: (s) => (kmh = Math.max(kmh, s.speedKmh)), until: (s) => s.dizzy });
    d = await game('dizzy');
    check(d.dizzy && d.cause === 'crash' && d.total < 4, `a crash at ${kmh.toFixed(0)} km/h into a wall makes the driver dizzy for a short while (${d.total.toFixed(1)} s)`);
    await shot('21-dizzy-crash');

    // Flat out (180 km/h) into the same shopfronts: 10 s or more, full strength for the first 5,
    // and steering left and right to get going again doesn't shake it off.
    await game('reset');
    await getIn();
    await game('teleportCar', 0, -190.3, 257.1, Math.atan2(-0.25, 0.97));
    await step(30);
    await game('launchCar', 0, 180 / 3.6);
    await run({ max: 60, every: 1, until: (s) => s.dizzy });
    const big = await game('dizzy');
    const amountAt = async (seconds) => {
      for (let done = 0; done < seconds * 60; done += 12) {
        const key = (done / 12) % 2 ? 'KeyA' : 'KeyD';
        await page.keyboard.down(key);
        await step(12);
        await page.keyboard.up(key);
      }
      return game('dizzy');
    };
    const at4 = await amountAt(4.5);
    const at6 = await amountAt(1.5);
    const at9 = await amountAt(3);
    check(big.cause === 'crash' && big.total >= 10 && big.total <= 15, `a 180 km/h crash makes the driver dizzy for ${big.total.toFixed(1)} s`);
    check(at4.amount === 1 && at6.amount < 1 && at9.dizzy && at9.amount > 0, `full strength for 5 s, then fading (${at4.amount.toFixed(2)} at 4.5 s, ${at6.amount.toFixed(2)} at 6 s, ${at9.amount.toFixed(2)} at 9 s)`);
    check(at9.wiggles === 0, `steering side to side while driving doesn't shake it off (${at9.wiggles} wiggles counted)`);

    // A knob: with the fall threshold past what a 6 m drop reaches, it's no longer a dizzy fall.
    await game('reset');
    await game('knob', 'dizzy.fallSpeed', 30);
    d = await fall();
    check(!d.dizzy, 'raising the fall threshold knob: the same fall is fine');

    // Off on the ? panel, through the real buttons: nothing makes you dizzy.
    await game('reset');
    await page.click('#tweaks-btn');
    const open = await state();
    check(open.paused && (await page.locator('#tweaks-panel').isVisible()), 'the ? button opens the panel and pauses the game');
    await page.click('[data-toggle="dizzy"]');
    check((await game('knobs')).dizzy.on === false && (await page.locator('[data-toggle="dizzy"]').innerText()) === 'OFF', 'the panel switch turns dizzy off');
    await shot('22-panel');
    await page.click('#tweaks-panel [data-close]');
    check(!(await state()).paused, 'closing the panel unpauses');
    d = await fall();
    await game('hitPlayer', 1, 9);
    await run({ max: 60 });
    d = await game('dizzy');
    check(!d.dizzy && d.count === 0, 'with dizzy off, neither a fall nor a car hit makes you dizzy');
  },
};
