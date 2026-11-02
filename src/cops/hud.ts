import { MAX_LEVEL } from './cops.ts';

// The cops on screen, period style: a row of little police beacons for the
// heat (lit and flashing while a cop can see you, glowing dimly while
// they're still after you out of sight), the tickets you've had, and the
// ticket slip when they catch you. No phones, no screens.

export class CopsHud {
  private readonly box: HTMLElement;
  private readonly lights: HTMLElement[] = [];
  private readonly tickets: HTMLElement;
  private readonly slip: HTMLElement;
  private readonly slipLine: HTMLElement;
  private readonly slipTicket: HTMLElement;
  private readonly slipNote: HTMLElement;
  /** Tap (or a key) on the slip: get on with it. */
  onSkip: () => void = () => {};

  constructor(hud: HTMLElement) {
    this.box = document.createElement('div');
    this.box.id = 'heat';
    this.box.className = 'heat hidden';
    for (let i = 0; i < MAX_LEVEL; i++) {
      const l = document.createElement('span');
      l.className = 'beacon';
      this.box.appendChild(l);
      this.lights.push(l);
    }
    this.tickets = document.createElement('span');
    this.tickets.className = 'tickets hidden';
    this.box.appendChild(this.tickets);
    hud.appendChild(this.box);

    this.slip = document.createElement('div');
    this.slip.id = 'ticket';
    this.slip.className = 'ticket hidden';
    this.slip.innerHTML = '<div class="ticket-head">AUCKLAND CITY POLICE · INFRINGEMENT NOTICE</div><p class="ticket-line"></p><p class="ticket-for"></p><p class="ticket-note"></p><div class="ticket-skip">Tap to carry on</div>';
    this.slipLine = this.slip.querySelector('.ticket-line')!;
    this.slipTicket = this.slip.querySelector('.ticket-for')!;
    this.slipNote = this.slip.querySelector('.ticket-note')!;
    this.slip.addEventListener('pointerup', () => this.onSkip());
    addEventListener('keydown', (e) => {
      if (!this.slip.classList.contains('hidden') && ['Enter', 'Space', 'KeyF', 'Escape'].includes(e.code)) this.onSkip();
    });
    hud.appendChild(this.slip);
  }

  /** Each frame: the heat level, whether they can see you, the ticket tally. */
  update(level: number, seen: boolean, tickets: number): void {
    const show = level > 0 || tickets > 0;
    this.box.classList.toggle('hidden', !show);
    for (const [i, l] of this.lights.entries()) {
      l.classList.toggle('on', i < level);
      l.classList.toggle('flash', i < level && seen);
    }
    this.tickets.classList.toggle('hidden', tickets === 0);
    const text = `Tickets: ${tickets}`;
    if (this.tickets.textContent !== text) this.tickets.textContent = text;
  }

  /** The slip: what the officer said, the ticket, and whether they've taken the car. */
  showTicket(line: string, ticket: string, tickets: number, impounded: boolean): void {
    this.slipLine.textContent = `“${line}”`;
    this.slipTicket.textContent = `Ticket No. ${tickets}: ${ticket}`;
    this.slipNote.textContent = impounded ? "And that car's not yours, so it's coming with us." : '';
    this.slip.classList.remove('hidden');
  }

  hideTicket(): void {
    this.slip.classList.add('hidden');
  }

  get ticketShown(): boolean {
    return !this.slip.classList.contains('hidden');
  }
}
