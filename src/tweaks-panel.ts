import { allSections, changedValues, onTweak, resetValues, setValue, type Section } from './tweaks.ts';

// The ? button and its panel: every registered mechanic (an on/off switch
// and sliders) and tuning table (the car, the cameras), for playtesting on a
// phone. The game pauses while it's open. Sliders have − / + buttons for
// thumbs; changed values are highlighted, kept in localStorage, and Copy puts
// them on the clipboard as JSON to paste into an issue. ? opens it on a
// keyboard, Esc closes.

const decimals = (step: number) => Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));

export class TweaksPanel {
  private readonly button: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly copyOut: HTMLTextAreaElement;
  /** Redraws each control from the live values. */
  private readonly refreshers: (() => void)[] = [];
  /** Opened or closed (the game pauses while open). */
  onToggle: (open: boolean) => void = () => {};
  /** A short message ("Copied"). */
  toast: (text: string) => void = () => {};

  constructor(hud: HTMLElement) {
    this.button = document.createElement('button');
    this.button.id = 'tweaks-btn';
    this.button.setAttribute('aria-label', 'Tuning');
    this.button.textContent = '?';
    hud.appendChild(this.button);

    this.panel = document.createElement('div');
    this.panel.id = 'tweaks-panel';
    this.panel.className = 'hidden';
    this.panel.innerHTML = `
      <div class="tw-head">
        <b>Tuning</b><span class="tw-paused">paused</span>
        <span class="tw-count" data-count></span>
        <button data-copy>Copy</button>
        <button data-reset>Reset</button>
        <button class="tw-close" data-close aria-label="Close">✕</button>
      </div>
      <textarea class="tw-out hidden" data-out readonly></textarea>
      <div class="tw-body" data-body></div>`;
    hud.appendChild(this.panel);
    const q = <T extends HTMLElement>(s: string) => this.panel.querySelector(s) as T;
    this.body = q('[data-body]');
    this.countEl = q('[data-count]');
    this.copyOut = q('[data-out]');
    for (const s of allSections()) this.body.appendChild(this.section(s));

    this.button.addEventListener('pointerup', () => this.toggle());
    q('[data-close]').addEventListener('click', () => this.toggle(false));
    q('[data-copy]').addEventListener('click', () => void this.copy());
    q('[data-reset]').addEventListener('click', () => resetValues());
    addEventListener('keydown', (e) => {
      // Only once the game's started (the HUD is up).
      if (!this.button.offsetParent) return;
      if (e.key === '?') this.toggle();
      else if (e.code === 'Escape') this.toggle(false);
    });
    onTweak(() => this.refresh());
    this.refresh();
  }

  get isOpen(): boolean {
    return !this.panel.classList.contains('hidden');
  }

  toggle(open = !this.isOpen): void {
    if (open === this.isOpen) return;
    this.panel.classList.toggle('hidden', !open);
    this.button.classList.toggle('on', open);
    if (!open) this.copyOut.classList.add('hidden');
    // Keys pressed on the panel (arrows on a slider) shouldn't still be driving once it closes.
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.onToggle(open);
  }

  private refresh(): void {
    for (const r of this.refreshers) r();
    const n = Object.values(changedValues()).reduce((k, v) => k + Object.keys(v).length, 0);
    this.countEl.textContent = n ? `${n} changed` : '';
  }

  private section(s: Section): HTMLElement {
    const box = document.createElement('details');
    box.className = 'tw-section';
    box.dataset.section = s.id;
    box.open = s.kind === 'mechanic';
    const summary = document.createElement('summary');
    summary.innerHTML = `<span class="tw-title"></span>`;
    summary.querySelector('.tw-title')!.textContent = s.title;
    box.appendChild(summary);

    if (typeof s.defaults.on === 'boolean') {
      const sw = document.createElement('button');
      sw.className = 'tw-switch';
      sw.setAttribute('role', 'switch');
      sw.dataset.toggle = s.id;
      // In the summary, so it shows when folded; it mustn't also fold the section.
      sw.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setValue(s.id, 'on', !s.values.on);
      });
      summary.appendChild(sw);
      this.refreshers.push(() => {
        const on = !!s.values.on;
        sw.setAttribute('aria-checked', String(on));
        sw.textContent = on ? 'ON' : 'OFF';
        box.classList.toggle('off', !on);
      });
    }

    for (const [key, spec] of Object.entries(s.specs)) {
      const row = document.createElement('div');
      row.className = 'tw-knob';
      const dp = decimals(spec.step);
      row.innerHTML = `
        <div class="tw-label"><span></span><output></output></div>
        <div class="tw-control">
          <button class="tw-step" data-dir="-1" aria-label="Less">−</button>
          <input type="range" />
          <button class="tw-step" data-dir="1" aria-label="More">+</button>
        </div>`;
      row.querySelector('span')!.textContent = spec.label;
      const out = row.querySelector('output')!;
      const range = row.querySelector('input')!;
      range.min = String(spec.min);
      range.max = String(spec.max);
      range.step = String(spec.step);
      range.dataset.knob = `${s.id}.${key}`;
      range.addEventListener('input', () => setValue(s.id, key, Number(range.value)));
      // Game keys on a focused slider shouldn't reach the game (input.ts listens on window).
      range.addEventListener('keydown', (e) => e.code !== 'Escape' && e.stopPropagation());
      for (const b of row.querySelectorAll<HTMLButtonElement>('.tw-step')) {
        b.addEventListener('click', () => {
          const v = (s.values[key] as number) + Number(b.dataset.dir) * spec.step;
          setValue(s.id, key, Number(v.toFixed(dp)));
        });
      }
      this.refreshers.push(() => {
        const v = s.values[key] as number;
        if (Number(range.value) !== v) range.value = String(v);
        out.textContent = `${v.toFixed(dp)}${spec.unit ? ` ${spec.unit}` : ''}`;
        row.classList.toggle('changed', v !== s.defaults[key]);
      });
      box.appendChild(row);
    }

    const reset = document.createElement('button');
    reset.className = 'tw-reset-section';
    reset.textContent = `Reset ${s.title.toLowerCase()}`;
    reset.addEventListener('click', () => resetValues(s.id));
    box.appendChild(reset);
    return box;
  }

  private async copy(): Promise<void> {
    const json = JSON.stringify(changedValues(), null, 2);
    try {
      await navigator.clipboard.writeText(json);
      this.toast(json === '{}' ? 'Nothing changed yet' : 'Changed values copied');
    } catch {
      // No clipboard (insecure context, or refused): show it to copy by hand.
      this.copyOut.value = json;
      this.copyOut.classList.remove('hidden');
      this.copyOut.select();
    }
  }
}
