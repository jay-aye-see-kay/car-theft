// Live-tunable numbers for playtesting: the ? panel (tweaks-panel.ts) draws
// one section per registered object, with a slider per knob and, for
// mechanics, an on/off switch. Sliders write straight into the object, so
// code that reads it every step needs nothing else; anything baked in at
// construction passes `onChange` to re-apply.
//
// A mechanic registers its own knobs where it's defined:
//
//   export const DIZZY = mechanic('dizzy', 'Dizzy', true, {
//     fallSpeed: knob(12, 'Fall threshold', 6, 30, 0.5, 'm/s'),
//   });
//   if (DIZZY.on && v > DIZZY.fallSpeed) ...
//
// Existing tables (the car's TUNING, the camera profiles) are bound in place
// with tune(). Changed values persist in localStorage; plain TypeScript, no
// DOM, so it runs in Node too (sim-car.ts).

export interface KnobSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
}

/** A slider: its default value and range. */
export interface Knob extends KnobSpec {
  value: number;
}

export function knob(value: number, label: string, min: number, max: number, step: number, unit?: string): Knob {
  return { value, label, min, max, step, unit };
}

type Values = Record<string, number | boolean>;

export interface Section {
  id: string;
  title: string;
  /** Mechanics (with an on/off switch) come first in the panel, then tuning tables. */
  kind: 'mechanic' | 'tuning';
  values: Values;
  defaults: Values;
  specs: Record<string, KnobSpec>;
  onChange?: () => void;
}

const STORAGE_KEY = 'gta.tweaks';
const sections: Section[] = [];
let storage: Storage | null = null;
/** Called after any change (the panel redraws). */
const listeners: (() => void)[] = [];

/**
 * A mechanic: its on/off switch (`on`, default as given) and sliders.
 * Returns the live values, which the panel and storage write into.
 */
export function mechanic<T extends Record<string, Knob>>(id: string, title: string, on: boolean, knobs: T): { on: boolean } & { [K in keyof T]: number } {
  const values: Values = { on };
  const specs: Record<string, KnobSpec> = {};
  for (const [k, { value, ...spec }] of Object.entries(knobs)) {
    values[k] = value;
    specs[k] = spec;
  }
  add({ id, title, kind: 'mechanic', values, defaults: { ...values }, specs });
  return values as { on: boolean } & { [K in keyof T]: number };
}

/** Bind an existing table of numbers in place: only the keys given get sliders. */
export function tune<T extends object>(id: string, title: string, target: T, specs: Partial<Record<keyof T & string, KnobSpec>>, onChange?: () => void): void {
  const values = target as unknown as Values;
  const defaults: Values = {};
  for (const k of Object.keys(specs)) defaults[k] = values[k];
  add({ id, title, kind: 'tuning', values, defaults, specs: specs as Record<string, KnobSpec>, onChange });
}

function add(s: Section): void {
  if (sections.some((o) => o.id === s.id)) throw new Error(`tweaks: section ${s.id} registered twice`);
  sections.push(s);
  if (storage) applySaved(s);
}

export function allSections(): readonly Section[] {
  // Mechanics, then the car's handling (the main thing to tune), then the rest as registered.
  const rank = (s: Section) => (s.kind === 'mechanic' ? 0 : s.id === 'car' ? 1 : 2);
  return [...sections].sort((a, b) => rank(a) - rank(b));
}

/** Start persisting, and apply what was saved last time. */
export function useStorage(s: Storage | null): void {
  storage = s;
  for (const sec of sections) applySaved(sec);
}

export function onTweak(fn: () => void): void {
  listeners.push(fn);
}

/** Set one value by section and key; numbers are clamped to the knob's range. */
export function setValue(id: string, key: string, value: number | boolean): void {
  const s = sections.find((o) => o.id === id);
  if (!s || !(key in s.defaults)) throw new Error(`tweaks: no ${id}.${key}`);
  write(s, key, value);
  changed(s);
}

/** Back to the defaults: one section, or everything. */
export function resetValues(id?: string): void {
  for (const s of sections) {
    if (id && s.id !== id) continue;
    for (const [k, v] of Object.entries(s.defaults)) s.values[k] = v;
    changed(s);
  }
}

/** Only what differs from the defaults, by section: what Copy puts on the clipboard. */
export function changedValues(): Record<string, Values> {
  const out: Record<string, Values> = {};
  for (const s of sections) {
    for (const [k, v] of Object.entries(s.defaults)) {
      if (s.values[k] !== v) (out[s.id] ??= {})[k] = s.values[k];
    }
  }
  return out;
}

/** Every value, for ?debug. */
export function allValues(): Record<string, Values> {
  const out: Record<string, Values> = {};
  for (const s of sections) out[s.id] = Object.fromEntries(Object.keys(s.defaults).map((k) => [k, s.values[k]]));
  return out;
}

function write(s: Section, key: string, value: number | boolean): void {
  const spec = s.specs[key];
  if (typeof s.defaults[key] === 'boolean') s.values[key] = !!value;
  else if (spec && typeof value === 'number' && Number.isFinite(value)) s.values[key] = Math.min(spec.max, Math.max(spec.min, value));
}

function changed(s: Section): void {
  s.onChange?.();
  save();
  for (const fn of listeners) fn();
}

function save(): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(changedValues()));
  } catch {
    // full or blocked: tuning just isn't kept
  }
}

function applySaved(s: Section): void {
  let saved: Record<string, Values> = {};
  try {
    saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}') ?? {};
  } catch {
    return;
  }
  const mine = saved[s.id];
  if (!mine || typeof mine !== 'object') return;
  // Keys that no longer exist, or the wrong type, are dropped quietly.
  for (const [k, v] of Object.entries(mine)) if (k in s.defaults && typeof v === typeof s.defaults[k]) write(s, k, v);
  s.onChange?.();
}
