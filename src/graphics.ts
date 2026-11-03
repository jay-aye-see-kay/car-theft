// Graphics presets, a player setting (not a playtest knob, so the ? panel's
// Reset and Copy leave it alone): Low power for older laptops and hot phones,
// Auto (the default, what the phone budget in AGENTS.md is measured at) and
// High for desktops with GPU to spare. QUALITY is the live table: the frame
// loop, the chunk streamer and the town read it each time, so switching takes
// effect at once, except antialiasing, which a WebGL context only takes when
// it's made (next load). Plain TypeScript, no DOM, so it runs in Node too.

export type Preset = 'low' | 'auto' | 'high';
export const PRESETS: readonly Preset[] = ['low', 'auto', 'high'];

export interface Quality {
  /** Frames drawn per second at most; 0 for the display's own rate. Physics stays 60 Hz either way. */
  maxFps: number;
  /** Adaptive resolution's range, as a pixel ratio (the top is capped at the screen's own). */
  minRatio: number;
  maxRatio: number;
  /** MSAA: always, never, or only on screens under 1.5x (past that the pixels already hide jaggies). */
  msaa: 'on' | 'off' | 'low-dpi';
  /** Chunk meshes: roads drawn within, buildings' small and finest detail within, trees and park edges within, m. */
  roadDraw: number;
  buildingDetail: number;
  buildingFine: number;
  treeDraw: number;
  /** Scales how many pedestrians, driving and parked cars the town keeps about. */
  crowd: number;
  /** Minimap redraws per second; 0 for every frame. */
  minimapHz: number;
}

const TABLE: Record<Preset, Quality> = {
  // A quarter of Auto's pixels at half the frames: the fans' favourite.
  low: { maxFps: 30, minRatio: 0.75, maxRatio: 1, msaa: 'off', roadDraw: 300, buildingDetail: 150, buildingFine: 60, treeDraw: 120, crowd: 0.5, minimapHz: 10 },
  auto: { maxFps: 60, minRatio: 0.75, maxRatio: 2, msaa: 'low-dpi', roadDraw: 500, buildingDetail: 250, buildingFine: 120, treeDraw: 200, crowd: 1, minimapHz: 0 },
  high: { maxFps: 0, minRatio: 1, maxRatio: 2, msaa: 'on', roadDraw: 700, buildingDetail: 350, buildingFine: 180, treeDraw: 300, crowd: 1, minimapHz: 0 },
};

export const LABELS: Record<Preset, { title: string; note: string }> = {
  low: { title: 'Low power', note: '30 fps, lower resolution, less detail and fewer people about. Cooler and quieter on older laptops.' },
  auto: { title: 'Auto', note: '60 fps, resolution adapts to keep it smooth.' },
  high: { title: 'High', note: "Your screen's full frame rate and resolution, more detail further out." },
};

/** The live settings: the preset's table, which preset it is, and the fps readout. */
export const QUALITY: Quality & { preset: Preset; showFps: boolean } = { ...TABLE.auto, preset: 'auto', showFps: false };

const STORAGE_KEY = 'gta.graphics';
let storage: Storage | null = null;
const listeners: (() => void)[] = [];

export function onGraphics(fn: () => void): void {
  listeners.push(fn);
}

export function setPreset(preset: Preset): void {
  if (!PRESETS.includes(preset)) throw new Error(`graphics: no preset ${preset}`);
  Object.assign(QUALITY, TABLE[preset], { preset });
  changed();
}

export function setShowFps(on: boolean): void {
  QUALITY.showFps = on;
  changed();
}

/** Start persisting, and apply what was saved last time. */
export function useGraphicsStorage(s: Storage | null): void {
  storage = s;
  try {
    const saved = JSON.parse(s?.getItem(STORAGE_KEY) ?? '{}') ?? {};
    if (PRESETS.includes(saved.preset)) Object.assign(QUALITY, TABLE[saved.preset as Preset], { preset: saved.preset });
    if (typeof saved.showFps === 'boolean') QUALITY.showFps = saved.showFps;
  } catch {
    // unreadable: defaults
  }
}

function changed(): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ preset: QUALITY.preset, showFps: QUALITY.showFps }));
  } catch {
    // full or blocked: the setting just isn't kept
  }
  for (const fn of listeners) fn();
}

/** A crowd knob (pedestrians, cars) scaled by the preset: at least one if the knob's any. */
export function crowd(count: number): number {
  return count > 0 ? Math.max(1, Math.round(count * QUALITY.crowd)) : 0;
}
