// What happened, as short lines with the game time (?debug `__game.journal()`):
// for agents and playtest bots, which step the game in big jumps and would
// otherwise miss a crash or a hit between two looks. Fed once a frame with
// counters and states, it writes a line whenever one changes. Lines like
// "41.2 crash 9 m/s (32 km/h)", "52.0 heat 0→1: hit a pedestrian".

/** Lines kept until taken. */
const KEEP = 300;
/** A knock this hard (m/s of sudden speed change) is a crash worth a line. */
const CRASH = 5;

export interface JournalSample {
  clock: number;
  /** Where you are (or the car you're in). */
  x: number;
  z: number;
  mode: 'foot' | 'car' | 'boat';
  /** The car you're in (index), or -1. */
  car: number;
  /** How the car you're in is listed: 'purple', 'parked', 'traffic', 'police' (asked only when you get in). */
  carKind: () => string;
  speedKmh: number;
  /** The driven car's knock this frame, m/s. */
  crash: number;
  heat: number;
  seen: boolean;
  caught: boolean;
  dizzy: boolean;
  dizzyCause: string;
  flat: boolean;
  soaked: boolean;
  pedHits: number;
  pedBumps: number;
  /** Total knocked down, and by kind. */
  smashed: Readonly<Record<string, number>>;
  tickets: number;
  /** Cops' offence log (src/cops/cops.ts stats.log). */
  offences: readonly string[];
  mission: string | null;
  banner: string | null;
  objective: string;
  said: readonly string[];
  /** The autopilot's status. */
  pilot: string;
}

/** The last sample, with the growing lists kept as their lengths. */
type Last = Omit<JournalSample, 'offences' | 'said'> & { offences: number; said: number };

export class Journal {
  private lines: string[] = [];
  private last: Last | null = null;
  /** Lines dropped because nobody took them. */
  dropped = 0;

  tick(s: JournalSample): void {
    const p = this.last;
    this.last = { ...s, smashed: { ...s.smashed }, offences: s.offences.length, said: s.said.length };
    if (!p) return;
    const t = s.clock;
    const at = ` @${Math.round(s.x)},${Math.round(s.z)}`;
    if (s.mode !== p.mode) {
      if (s.mode === 'car') this.add(t, `got in car #${s.car} (${s.carKind()})`);
      else if (s.mode === 'boat') this.add(t, 'took the helm of a boat');
      else this.add(t, p.mode === 'car' ? `got out of car #${p.car}` : 'stepped off the boat');
    }
    if (s.crash > CRASH) this.add(t, `crash ${s.crash.toFixed(0)} m/s at ${p.speedKmh.toFixed(0)} km/h${at}`);
    if (s.pedHits > p.pedHits) this.add(t, `hit a pedestrian at ${p.speedKmh.toFixed(0)} km/h${at}`);
    if (s.pedBumps > p.pedBumps) this.add(t, `bumped into a pedestrian${at}`);
    for (const [k, n] of Object.entries(s.smashed)) {
      const was = p.smashed[k] ?? 0;
      if (n > was) this.add(t, `knocked down a ${k}${n - was > 1 ? ` (×${n - was})` : ''}${at}`);
    }
    for (const o of s.offences.slice(p.offences)) this.add(t, `cops noted: ${o.replace(/^[\d.]+ s: /, '')}`);
    if (s.heat !== p.heat) this.add(t, `heat ${p.heat}→${s.heat}${s.seen ? ' (seen)' : ''}`);
    if (s.caught && !p.caught) this.add(t, 'caught by the cops');
    if (s.tickets > p.tickets) this.add(t, `ticket #${s.tickets}`);
    if (s.dizzy && !p.dizzy) this.add(t, `dizzy (${s.dizzyCause || '?'})`);
    if (s.flat && !p.flat) this.add(t, 'flat tyres');
    if (s.soaked && !p.soaked) this.add(t, 'in the water');
    if (s.mission !== p.mission) this.add(t, s.mission ? `mission ${s.mission} started` : `mission ${p.mission} ended`);
    if (s.banner && s.banner !== p.banner) this.add(t, `banner: ${s.banner}`);
    if (s.objective && s.objective !== p.objective) this.add(t, `objective: ${s.objective}`);
    // `said` is everything said since the reset; a reset shortens it.
    const from = s.said.length >= p.said ? p.said : 0;
    for (const line of s.said.slice(from)) this.add(t, `"${line}"`);
    if (s.pilot !== p.pilot && s.pilot !== 'driving' && s.pilot !== 'off') this.add(t, `autopilot ${s.pilot}`);
  }

  /** Everything since the last take, oldest first. */
  take(): string[] {
    const out = this.dropped ? [`(${this.dropped} earlier lines dropped)`, ...this.lines] : this.lines;
    this.lines = [];
    this.dropped = 0;
    return out;
  }

  reset(): void {
    this.lines = [];
    this.last = null;
    this.dropped = 0;
  }

  private add(t: number, text: string): void {
    if (this.lines.length >= KEEP) {
      this.lines.shift();
      this.dropped++;
    }
    this.lines.push(`${t.toFixed(1)} ${text}`);
  }
}
