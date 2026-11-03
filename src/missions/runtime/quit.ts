// Calling a mission off: a "Quit mission" pill in the top bar while one of
// ours is running (Q on a keyboard), then "Are you sure?" before it goes.
// The game pauses while the question's up. An in-page dialog, not
// window.confirm(), which drops pointer lock and full screen on phones.

export class QuitMission {
  private readonly button: HTMLButtonElement;
  private readonly dialog: HTMLElement;
  /** Whether there's a mission to call off right now (the game sets this each frame). */
  private can = false;
  /** Asking opened or closed (the game pauses while it's open). */
  onToggle: (open: boolean) => void = () => {};
  /** Yes: call it off. */
  onQuit: () => void = () => {};

  constructor(hud: HTMLElement) {
    this.button = document.createElement('button');
    this.button.id = 'quit-mission';
    this.button.className = 'hidden';
    this.button.setAttribute('aria-label', 'Quit mission');
    // Just "Quit" on narrow screens (style.css), so it stays clear of the screen's edge.
    this.button.innerHTML = '✕ Quit<span class="quit-long"> mission</span>';
    hud.appendChild(this.button);

    this.dialog = document.createElement('div');
    this.dialog.id = 'quit-confirm';
    this.dialog.className = 'hidden';
    this.dialog.setAttribute('role', 'alertdialog');
    this.dialog.setAttribute('aria-label', 'Quit mission');
    this.dialog.innerHTML = `
      <div class="quit-box">
        <b>Quit this mission?</b>
        <p>Are you sure? It counts as failed.</p>
        <div class="quit-buttons">
          <button data-no>Keep going</button>
          <button data-yes>Quit</button>
        </div>
      </div>`;
    hud.appendChild(this.dialog);

    this.button.addEventListener('click', () => this.ask(true));
    this.dialog.querySelector('[data-yes]')!.addEventListener('click', () => this.answer(true));
    this.dialog.querySelector('[data-no]')!.addEventListener('click', () => this.answer(false));
    // Tapping outside the box is "no".
    this.dialog.addEventListener('click', (e) => e.target === this.dialog && this.answer(false));
    // Capture, so while asking these keys don't also reach the game (Enter gets out of the car)
    // or the other panels' Escape handlers.
    addEventListener(
      'keydown',
      (e) => {
        if (this.isOpen) {
          if (e.code === 'KeyY' || e.code === 'Enter') this.answer(true);
          else if (e.code === 'KeyN' || e.code === 'Escape' || e.code === 'KeyQ') this.answer(false);
          else return;
          e.preventDefault();
          e.stopImmediatePropagation();
        } else if (e.code === 'KeyQ' && !e.repeat && this.can && this.button.offsetParent) this.ask(true);
      },
      true,
    );
  }

  get isOpen(): boolean {
    return !this.dialog.classList.contains('hidden');
  }

  /** Each frame: show the pill only while there's something to quit (and close the question if it's gone). */
  update(can: boolean): void {
    this.can = can;
    if (this.button.classList.contains('hidden') === can) this.button.classList.toggle('hidden', !can);
    if (!can && this.isOpen) this.ask(false);
  }

  ask(open: boolean): void {
    if (open === this.isOpen || (open && !this.can)) return;
    this.dialog.classList.toggle('hidden', !open);
    // Nothing focused, so Space (handbrake, jump) can't press a button in it.
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.onToggle(open);
  }

  private answer(quit: boolean): void {
    this.ask(false);
    if (quit) this.onQuit();
  }
}
