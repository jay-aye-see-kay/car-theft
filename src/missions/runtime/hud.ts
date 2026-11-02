import { formatTime } from './mission.ts';
import type { MissionView } from './runner.ts';

// The mission HUD, drawn in the DOM over the game: title cards and MISSION
// PASSED banners, subtitles, the timer, the objective line and the board.
// Where to go is on the map (src/map/): mission blips, the goal and the route.

const el = (parent: HTMLElement, cls: string, html = '') => {
  const e = document.createElement('div');
  e.className = cls;
  e.innerHTML = html;
  parent.appendChild(e);
  return e;
};

export class MissionHud {
  private readonly banner: HTMLElement;
  private readonly bannerTitle: HTMLElement;
  private readonly bannerText: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly objective: HTMLElement;
  private readonly board: HTMLElement;
  private boardKey = '';
  /** Last text written to each element, so unchanged frames don't touch the DOM. */
  private readonly written = new Map<HTMLElement, string>();

  constructor(hud: HTMLElement) {
    const root = el(hud, 'mission');
    this.banner = el(root, 'mission-banner hidden');
    this.bannerTitle = el(this.banner, 'mission-banner-title');
    this.bannerText = el(this.banner, 'mission-banner-text');
    this.clock = el(root, 'mission-clock hidden');
    this.objective = el(root, 'mission-objective hidden');
    this.subtitle = el(root, 'mission-subtitle hidden');
    this.board = el(root, 'mission-board hidden');
  }

  update(view: MissionView): void {
    const b = view.banner;
    this.show(this.banner, !!b);
    if (b) {
      this.banner.dataset.kind = b.kind;
      this.text(this.bannerTitle, b.title);
      this.text(this.bannerText, b.text);
    }
    this.show(this.subtitle, !!view.subtitle);
    this.text(this.subtitle, view.subtitle ?? '');
    this.show(this.objective, !!view.objective);
    this.text(this.objective, view.objective);
    this.drawBoard(view.board);
    const c = view.clock;
    this.show(this.clock, !!c);
    if (c) {
      this.text(this.clock, formatTime(c.seconds, !c.down));
      this.clock.classList.toggle('urgent', c.down && c.seconds < 10.5);
    }
  }

  /** Rebuilt only when something on it changes (a few times a second at most). */
  private drawBoard(sections: MissionView['board']): void {
    const key = JSON.stringify(sections);
    if (key === this.boardKey) return;
    this.boardKey = key;
    this.show(this.board, sections.length > 0);
    this.board.replaceChildren();
    for (const s of sections) {
      if (s.title) this.text(el(this.board, 'mission-board-title'), s.title);
      for (const r of s.rows) {
        const row = el(this.board, `mission-board-row${r.done ? ' done' : ''}`);
        this.text(el(row, 'mission-board-text'), r.text);
        if (r.note) {
          const note = el(row, 'mission-board-note');
          this.text(note, r.note);
          if (r.colour) note.style.color = r.colour;
        }
      }
    }
  }

  private show(e: HTMLElement, on: boolean): void {
    if (e.classList.contains('hidden') === on) e.classList.toggle('hidden', !on);
  }

  private text(e: HTMLElement, t: string): void {
    if (this.written.get(e) === t) return;
    this.written.set(e, t);
    e.textContent = t;
  }
}
