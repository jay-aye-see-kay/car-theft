// The ? panel (#53) on a phone: opens with a tap and pauses, every mechanic
// and tuning table has a section, the controls are thumb-sized, − / + change
// a value, changes are kept in localStorage, Copy gives JSON, Reset undoes.

export default {
  name: 'tweaks',
  core: false,
  page: 'phone',
  async run({ page, check, game, state, step, shot }) {
    await step(5);
    await page.locator('#tweaks-btn').tap();
    const s = await state();
    const panel = page.locator('#tweaks-panel');
    check(s.paused && (await panel.isVisible()) && !(await page.locator('.touch .stick').isVisible()), 'tapping ? opens the panel and pauses the game, touch controls out of the way');
    const sections = await page.locator('#tweaks-panel [data-section]').evaluateAll((els) => els.map((e) => e.dataset.section));
    const want = ['dizzy', 'crash-dizzy', 'peds', 'hits', 'car', 'camera-driving', 'camera-foot'];
    check(want.every((w) => sections.includes(w)), `a section for each mechanic and tuning table (${sections.join(', ')})`);
    const sizes = await page.evaluate(() => {
      const box = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect());
      const min = (rs, k) => Math.min(...rs.map((r) => r[k]));
      const sw = box('#tweaks-panel .tw-switch');
      const steps = box('#tweaks-panel .tw-step');
      const ranges = box('#tweaks-panel input[type=range]');
      return { switchH: min(sw, 'height'), stepW: min(steps, 'width'), stepH: min(steps, 'height'), rangeH: min(ranges, 'height') };
    });
    check(sizes.switchH >= 36 && sizes.stepW >= 36 && sizes.stepH >= 32 && sizes.rangeH >= 30, `thumb-sized controls (${JSON.stringify(sizes)})`);
    await shot('25-panel');

    // + on the fall threshold, twice: the value, the highlight, storage.
    const plus = page.locator('[data-section="dizzy"] .tw-knob').first().locator('.tw-step[data-dir="1"]');
    await plus.tap();
    await plus.tap();
    const v = (await game('knobs')).dizzy.fallSpeed;
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('gta.tweaks') ?? '{}'));
    const changed = await page.locator('[data-section="dizzy"] .tw-knob.changed').count();
    check(v === 14 && saved.dizzy?.fallSpeed === 14 && changed === 1, `+ steps a value (fall threshold 13 → ${v}), highlighted and saved (${JSON.stringify(saved)})`);
    await page.locator('#tweaks-panel [data-copy]').tap();
    const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => document.querySelector('[data-out]').value));
    check(/"fallSpeed": 14/.test(copied), `Copy gives the changed values as JSON (${copied.replace(/\s+/g, ' ')})`);
    await page.locator('#tweaks-panel [data-reset]').tap();
    const after = (await game('knobs')).dizzy.fallSpeed;
    check(after === 13 && (await page.evaluate(() => localStorage.getItem('gta.tweaks'))) === '{}', `Reset puts it back (${after})`);
    await page.locator('#tweaks-panel [data-close]').tap();
    check(!(await state()).paused && !(await panel.isVisible()), 'closing it carries on playing');
  },
};
