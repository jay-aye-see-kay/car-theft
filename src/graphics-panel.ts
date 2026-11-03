import { LABELS, onGraphics, PRESETS, QUALITY, setPreset, setShowFps } from './graphics.ts';

// The Graphics section at the top of the ? panel: Low power / Auto / High,
// and an fps readout by the minimap. Player settings, kept apart from the
// tuning knobs (Reset and Copy don't touch them).

export function graphicsSection(): HTMLElement {
  const box = document.createElement('details');
  box.className = 'tw-section tw-graphics';
  box.dataset.section = 'graphics';
  box.open = true;
  box.innerHTML = `
    <summary><span class="tw-title">Graphics</span></summary>
    <div class="tw-presets" role="radiogroup" aria-label="Graphics"></div>
    <p class="tw-note" data-note></p>
    <div class="tw-row"><span>Show FPS</span><button class="tw-switch" role="switch" data-fps></button></div>`;
  const group = box.querySelector('.tw-presets')!;
  const note = box.querySelector<HTMLElement>('[data-note]')!;
  const fps = box.querySelector<HTMLButtonElement>('[data-fps]')!;
  // The preset the page was loaded with: antialiasing only changes on the next load.
  const loadedMsaa = QUALITY.msaa;
  const buttons = PRESETS.map((p) => {
    const b = document.createElement('button');
    b.setAttribute('role', 'radio');
    b.dataset.preset = p;
    b.textContent = LABELS[p].title;
    b.addEventListener('click', () => setPreset(p));
    group.appendChild(b);
    return b;
  });
  fps.addEventListener('click', () => setShowFps(!QUALITY.showFps));
  const refresh = () => {
    for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.preset === QUALITY.preset));
    const reload = QUALITY.msaa !== loadedMsaa ? ' Antialiasing changes next time the game loads.' : '';
    note.textContent = LABELS[QUALITY.preset].note + reload;
    fps.setAttribute('aria-checked', String(QUALITY.showFps));
    fps.textContent = QUALITY.showFps ? 'ON' : 'OFF';
    fps.classList.toggle('off', !QUALITY.showFps);
  };
  onGraphics(refresh);
  refresh();
  return box;
}
