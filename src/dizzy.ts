import { knob, mechanic } from './tweaks.ts';

// Dizzy instead of damage: a hard landing, a car hitting you on foot or (for
// the driver) a big crash leaves you seeing stars for a few seconds: slow,
// drifting controls, a swaying camera and a wobbling body, at full strength
// for a few seconds and then fading. On foot, wiggling the stick or mashing
// buttons shakes it off sooner (not while driving: steering out of a crash
// isn't shaking it off). A few seconds' immunity after you come round means
// you can't be chain-stunned. Game time throughout, so
// stepped smoke tests repeat exactly.

export const DIZZY = mechanic('dizzy', 'Dizzy', true, {
  fallSpeed: knob(13, 'Fall: landing faster than', 5, 40, 0.5, 'm/s'),
  hitSpeed: knob(4, 'Hit by a car faster than', 1, 20, 0.5, 'm/s'),
  minTime: knob(2, 'Shortest', 0.5, 10, 0.1, 's'),
  maxTime: knob(5, 'Longest (a big hit)', 0.5, 15, 0.1, 's'),
  full: knob(5, 'Full strength for, then fades', 0.5, 15, 0.5, 's'),
  slowdown: knob(0.5, 'Slowdown', 0, 0.95, 0.05),
  mush: knob(0.6, 'Steering / walking mush', 0, 1, 0.05),
  sway: knob(0.5, 'Camera sway', 0, 1.5, 0.05),
  immunity: knob(3, 'Immune after, for', 0, 15, 0.5, 's'),
  mash: knob(0.25, 'On foot, each wiggle or mash saves', 0, 1, 0.05, 's'),
});

/** The driver going dizzy after a big crash: its own switch, since it's the riskiest for fun. */
// A head-on knock is about the speed you hit at: 13.5 m/s is ~50 km/h, 50 m/s is ~180 km/h.
export const CRASH_DIZZY = mechanic('crash-dizzy', 'Dizzy: big crashes', true, {
  impact: knob(13.5, 'Crash harder than', 4, 40, 0.5, 'm/s'),
  fullImpact: knob(50, 'Longest at a crash of', 10, 80, 1, 'm/s'),
  minTime: knob(2, 'Shortest', 0.5, 10, 0.1, 's'),
  maxTime: knob(12, 'Longest', 0.5, 30, 0.5, 's'),
});

/** How hard a hit was, 0..1, from how far past its threshold it went (full at 2.5x, or at `full`). */
export function severity(value: number, threshold: number, full = threshold * 2.5): number {
  return Math.min(1, Math.max(0, (value - threshold) / Math.max(full - threshold, 1e-6)));
}

/** The last stretch fades out rather than snapping back to normal, s. */
const FADE = 0.6;
/** Stick past this counts as pushed one way (for wiggle detection). */
const WIGGLE = 0.5;

export type DizzyCause = 'fall' | 'hit' | 'crash' | 'bump';

export class Dizzy {
  /** Seconds of dizziness left, and how long it was when it started. */
  left = 0;
  total = 0;
  /** Game time it wears off, after which you're immune for a bit. */
  private immuneUntil = -Infinity;
  private clock = 0;
  private lastX = 0;
  private lastY = 0;
  /** What did it, and how many wiggles cut it short (?debug). */
  cause: DizzyCause | null = null;
  /** Seconds since it started: the drift and sway follow this, so they don't depend on how long the game's been running. */
  time = 0;
  wiggles = 0;
  count = 0;

  /** 0..1: full for the first `full` seconds, then fading to nothing (over FADE s at least). */
  get amount(): number {
    if (this.left <= 0) return 0;
    return Math.min(1, this.left / Math.max(FADE, this.total - DIZZY.full));
  }

  get active(): boolean {
    return this.left > 0;
  }

  get immune(): boolean {
    return !this.active && this.clock < this.immuneUntil;
  }

  /**
   * Go dizzy for between `min` and `max` seconds (the knobs: 2–5 s on foot)
   * by `strength` 0..1. Ignored when the mechanic is off or you've only just
   * come round; a harder hit while already dizzy tops it up.
   */
  trigger(strength: number, cause: DizzyCause, min = DIZZY.minTime, max = DIZZY.maxTime): boolean {
    if (!DIZZY.on || this.immune) return false;
    const s = Math.min(1, Math.max(0, strength));
    const time = min + (Math.max(min, max) - min) * s;
    if (time <= this.left) return false;
    if (!this.active) {
      this.count++;
      this.wiggles = 0;
      this.time = 0;
    }
    this.left = this.total = time;
    this.cause = cause;
    return true;
  }

  /**
   * Each frame: the clock runs down, on foot faster for every flick of the
   * stick from one side to the other and every button mashed.
   */
  update(dt: number, stickX: number, stickY: number, mashed: number, driving: boolean): void {
    this.clock += dt;
    this.time += dt;
    if (!DIZZY.on) this.left = 0;
    if (!this.active || driving) {
      this.lastX = this.lastY = 0;
      if (this.active) this.countDown(dt, 0);
      return;
    }
    let wiggles = mashed;
    const sx = Math.abs(stickX) > WIGGLE ? Math.sign(stickX) : 0;
    const sy = Math.abs(stickY) > WIGGLE ? Math.sign(stickY) : 0;
    if (sx && sx !== this.lastX) wiggles += this.lastX ? 1 : 0;
    if (sy && sy !== this.lastY) wiggles += this.lastY ? 1 : 0;
    if (sx) this.lastX = sx;
    if (sy) this.lastY = sy;
    this.countDown(dt, wiggles);
  }

  private countDown(dt: number, wiggles: number): void {
    this.wiggles += wiggles;
    this.left -= dt + wiggles * DIZZY.mash;
    if (this.left <= 0) {
      this.left = 0;
      this.immuneUntil = this.clock + DIZZY.immunity;
    }
  }

  reset(): void {
    this.left = this.total = 0;
    this.immuneUntil = -Infinity;
    this.cause = null;
    this.wiggles = this.count = 0;
    this.time = 0;
    this.lastX = this.lastY = 0;
  }

  /**
   * Which way the dizzy drift pulls, radians-ish (times the mush): at its
   * strongest the moment it starts, then wandering. Alternate spells pull
   * opposite ways.
   */
  drift(): number {
    const t = this.time;
    const side = this.count % 2 ? 1 : -1;
    return side * (Math.cos(t * 2.3) * 0.9 + Math.cos(t * 0.83) * 0.6);
  }

  /** For ?debug and the smoke tests. */
  debug() {
    return { dizzy: this.active, left: this.left, total: this.total, amount: this.amount, immune: this.immune, cause: this.cause, wiggles: this.wiggles, count: this.count };
  }
}
