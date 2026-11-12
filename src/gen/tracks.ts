// Step 1 of road generation: turn each road in the model into a "track", a smooth
// centreline sampled every few metres carrying width, lane layout and elevation.
import { dist } from '../geo/poly.ts';
import type { Heightfield } from '../model/load.ts';
import type { Pt, Road, RoadClass, TileModel } from '../model/types.ts';

export interface RoadParams {
  /** Metres between samples along a road. */
  step: number;
  /** Largest corner rounding applied to map kinks, in metres, by class. */
  cornerCut: Record<RoadClass, number>;
  laneWidth: Record<RoadClass, number>;
  shoulder: Record<RoadClass, number>;
  /** Metres of road length used per metre of width change, on streets and on motorways. */
  taperStreet: number;
  taperMotorway: number;
  footpathWidth: number;
  kerbHeight: number;
  /** How far the kerb runs past a corner before the curve starts. Roughly the kerb radius at a right angle. */
  kerbRadius: number;
  /** Longest distance a junction may eat into an arm. */
  maxCut: number;
  /** Passes of smoothing on the road's height profile. More passes iron out more of the real bumps. */
  profileSmoothing: number;
  /** How far beyond the road the terrain is graded to meet it. */
  gradeBlend: number;
}

export const DEFAULT_PARAMS: RoadParams = {
  step: 3,
  cornerCut: { motorway: 30, ramp: 14, arterial: 8, collector: 6, street: 5, lane: 3 },
  laneWidth: { motorway: 3.6, ramp: 4, arterial: 3.3, collector: 3.2, street: 3.1, lane: 2.9 },
  shoulder: { motorway: 2.2, ramp: 1.2, arterial: 0.4, collector: 0.4, street: 0.9, lane: 0.3 },
  taperStreet: 10,
  taperMotorway: 35,
  footpathWidth: 2.6,
  kerbHeight: 0.16,
  kerbRadius: 6,
  maxCut: 60,
  profileSmoothing: 30,
  gradeBlend: 9,
};

export interface Track {
  road: Road;
  /** The class covering most of the road's length; it sets lane width and furniture. */
  cls: RoadClass;
  n: number;
  length: number;
  x: Float32Array;
  y: Float32Array;
  /** Unit tangent. The left-hand normal is (-ty, tx). */
  tx: Float32Array;
  ty: Float32Array;
  s: Float32Array;
  /** Width of the lanes running with and against the track direction. */
  wF: Float32Array;
  wB: Float32Array;
  shoulder: number;
  laneWidth: number;
  oneWay: boolean;
  level: Int8Array;
  h: Float32Array;
  /** Set by the junction solver: the track is only built between these distances. */
  cutA: number;
  cutB: number;
}

export const halfWidth = (t: Track, i: number): number => (t.wF[i] + t.wB[i]) / 2 + t.shoulder;

/** Rounds corners by cutting each one back up to `cap` metres, twice. Straight runs are untouched. */
function roundCorners(pts: Pt[], cap: number): Pt[] {
  let cur = pts;
  for (const limit of [cap, cap / 2.5]) {
    if (cur.length < 3) break;
    const next: Pt[] = [cur[0]];
    for (let i = 1; i < cur.length - 1; i++) {
      const [a, b, c] = [cur[i - 1], cur[i], cur[i + 1]];
      const la = dist(a, b);
      const lc = dist(b, c);
      // Leave near-straight vertices alone so long straights stay straight.
      const turn = Math.abs(Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])));
      if (turn < 0.02 || la < 1e-6 || lc < 1e-6) {
        next.push(b);
        continue;
      }
      const da = Math.min(la * 0.3, limit);
      const dc = Math.min(lc * 0.3, limit);
      next.push([b[0] + ((a[0] - b[0]) * da) / la, b[1] + ((a[1] - b[1]) * da) / la]);
      next.push([b[0] + ((c[0] - b[0]) * dc) / lc, b[1] + ((c[1] - b[1]) * dc) / lc]);
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

const smoothstep = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export function buildTrack(road: Road, p: RoadParams): Track {
  const byClass = new Map<RoadClass, number>();
  for (const sec of road.sections) byClass.set(sec.cls, (byClass.get(sec.cls) ?? 0) + sec.s1 - sec.s0);
  const cls = [...byClass].sort((a, b) => b[1] - a[1])[0][0];

  const line = roundCorners(road.pts, p.cornerCut[cls]);
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + dist(line[i - 1], line[i]));
  const length = cum[cum.length - 1];
  const n = Math.max(2, Math.round(length / p.step) + 1);

  const t: Track = {
    road,
    cls,
    n,
    length,
    x: new Float32Array(n),
    y: new Float32Array(n),
    tx: new Float32Array(n),
    ty: new Float32Array(n),
    s: new Float32Array(n),
    wF: new Float32Array(n),
    wB: new Float32Array(n),
    shoulder: p.shoulder[cls],
    laneWidth: p.laneWidth[cls],
    oneWay: road.sections.every((sec) => sec.lanesB === 0),
    level: new Int8Array(n),
    h: new Float32Array(n),
    cutA: 0,
    cutB: 0,
  };

  let seg = 0;
  for (let i = 0; i < n; i++) {
    const s = (i / (n - 1)) * length;
    while (seg < line.length - 2 && cum[seg + 1] < s) seg++;
    const u = cum[seg + 1] > cum[seg] ? (s - cum[seg]) / (cum[seg + 1] - cum[seg]) : 0;
    t.s[i] = s;
    t.x[i] = line[seg][0] + (line[seg + 1][0] - line[seg][0]) * u;
    t.y[i] = line[seg][1] + (line[seg + 1][1] - line[seg][1]) * u;
  }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const d = Math.hypot(t.x[b] - t.x[a], t.y[b] - t.y[a]) || 1;
    t.tx[i] = (t.x[b] - t.x[a]) / d;
    t.ty[i] = (t.y[b] - t.y[a]) / d;
  }

  // Sections were measured along the raw map line; rounding corners shortens it slightly.
  const rawLength = road.sections[road.sections.length - 1].s1 || 1;
  const k = length / rawLength;
  const lw = t.laneWidth;
  const taper = cls === 'motorway' || cls === 'ramp' ? p.taperMotorway : p.taperStreet;
  for (let i = 0; i < n; i++) {
    const s = t.s[i];
    // Width is the first section's, plus each later change eased in over a taper centred on
    // the point where the map says the lane count changes. No hard cuts are possible.
    let wF = road.sections[0].lanesF * lw;
    let wB = road.sections[0].lanesB * lw;
    for (let j = 1; j < road.sections.length; j++) {
      const prev = road.sections[j - 1];
      const sec = road.sections[j];
      const dF = (sec.lanesF - prev.lanesF) * lw;
      const dB = (sec.lanesB - prev.lanesB) * lw;
      if (dF === 0 && dB === 0) continue;
      const len = Math.max(6, Math.max(Math.abs(dF), Math.abs(dB)) * taper);
      const e = smoothstep((s - sec.s0 * k) / len + 0.5);
      wF += dF * e;
      wB += dB * e;
    }
    t.wF[i] = wF;
    t.wB[i] = wB;
    const sec = road.sections.find((x) => s <= x.s1 * k) ?? road.sections[road.sections.length - 1];
    t.level[i] = sec.level;
  }
  return t;
}

/** Linear interpolation of a per-sample quantity at distance `s` along the track. */
export function sampleAt(t: Track, s: number): { x: number; y: number; tx: number; ty: number; h: number; wF: number; wB: number; i: number } {
  const f = Math.min(t.n - 1, Math.max(0, (s / t.length) * (t.n - 1)));
  const i = Math.min(t.n - 2, Math.floor(f));
  const u = f - i;
  const mix = (a: Float32Array) => a[i] + (a[i + 1] - a[i]) * u;
  return { x: mix(t.x), y: mix(t.y), tx: mix(t.tx), ty: mix(t.ty), h: mix(t.h), wF: mix(t.wF), wB: mix(t.wB), i };
}

/**
 * Gives every track a height profile. Roads on the ground follow a smoothed version of the
 * terrain; bridges and tunnels ignore the terrain and run straight between their ends.
 * Returns the height chosen for each junction.
 */
export function solveElevations(model: TileModel, tracks: Map<string, Track>, ground: Heightfield, p: RoadParams): Map<string, number> {
  const jh = new Map<string, number>();
  const free = new Set<string>();
  for (const j of model.junctions) {
    const onGround = j.arms.filter((a) => {
      const t = tracks.get(a.road)!;
      return t.level[a.end === 'a' ? 0 : t.n - 1] === 0;
    });
    if (onGround.length) {
      // Sample at the arm ends rather than the junction centre, which may sit on a median or a bank.
      let sum = 0;
      for (const a of onGround) {
        const t = tracks.get(a.road)!;
        const i = a.end === 'a' ? 0 : t.n - 1;
        sum += ground.at(t.x[i], t.y[i]);
      }
      jh.set(j.id, sum / onGround.length);
    } else {
      free.add(j.id);
      jh.set(j.id, ground.at(j.x, j.y));
    }
  }

  const all = [...tracks.values()];
  for (const t of all) for (let i = 0; i < t.n; i++) t.h[i] = ground.at(t.x[i], t.y[i]);

  // Elevated or buried runs: straight lines between the nearest grounded points. A junction
  // that sits on a structure takes the distance-weighted mean of what its arms connect to.
  const fillRuns = (): void => {
    for (const t of all) {
      t.h[0] = jh.get(t.road.a)!;
      t.h[t.n - 1] = jh.get(t.road.b)!;
      let i = 0;
      while (i < t.n) {
        if (t.level[i] === 0) {
          i++;
          continue;
        }
        let j = i;
        while (j < t.n && t.level[j] !== 0) j++;
        const lo = Math.max(0, i - 1);
        const hi = Math.min(t.n - 1, j);
        for (let k = lo + 1; k < hi; k++) t.h[k] = t.h[lo] + ((t.h[hi] - t.h[lo]) * (t.s[k] - t.s[lo])) / (t.s[hi] - t.s[lo] || 1);
        i = j;
      }
    }
  };
  for (let round = 0; round < (free.size ? 40 : 1); round++) {
    fillRuns();
    for (const j of model.junctions) {
      if (!free.has(j.id)) continue;
      let sum = 0;
      let weight = 0;
      for (const a of j.arms) {
        const t = tracks.get(a.road)!;
        // Walk out along the arm to the first grounded sample (or the far junction).
        let i = a.end === 'a' ? 0 : t.n - 1;
        const dir = a.end === 'a' ? 1 : -1;
        const start = t.s[i];
        do i += dir;
        while (i > 0 && i < t.n - 1 && t.level[i] !== 0);
        const w = 1 / Math.max(1, Math.abs(t.s[i] - start));
        sum += t.h[i] * w;
        weight += w;
      }
      if (weight) jh.set(j.id, sum / weight);
    }
  }
  fillRuns();

  // Real ground is lumpy at the 1 m scale. Smooth along the road, keeping junctions fixed.
  for (const t of all) {
    const tmp = new Float32Array(t.n);
    for (let pass = 0; pass < p.profileSmoothing; pass++) {
      tmp.set(t.h);
      for (let i = 1; i < t.n - 1; i++) t.h[i] = 0.25 * tmp[i - 1] + 0.5 * tmp[i] + 0.25 * tmp[i + 1];
    }
  }
  markSpans(all);
  liftForHeadroom(model, tracks, all);
  markSpans(all);
  return jh;
}

type Sample = { t: Track; i: number };

/** Buckets every sample on the ground so the roads near a point can be found quickly. */
function groundGrid(all: Track[]): (x: number, y: number) => Sample[] {
  const CELL = 16;
  const grid = new Map<number, Sample[]>();
  const key = (x: number, y: number): number => Math.floor(x / CELL) * 8192 + Math.floor(y / CELL);
  for (const t of all) {
    for (let i = 0; i < t.n; i++) {
      if (t.level[i] !== 0) continue;
      const k = key(t.x[i], t.y[i]);
      let list = grid.get(k);
      if (!list) grid.set(k, (list = []));
      list.push({ t, i });
    }
  }
  return (x, y) => {
    const found: Sample[] = [];
    for (let dx = -CELL; dx <= CELL; dx += CELL) for (let dy = -CELL; dy <= CELL; dy += CELL) found.push(...(grid.get(key(x + dx, y + dy)) ?? []));
    return found;
  };
}

/** Road surface to road surface where one crosses over another: room for a deck and a truck. */
export const HEADROOM = 6;

/**
 * A bridge's height comes from the ground at its two ends, which can leave it skimming the road it
 * crosses. Where that happens the deck is lifted to give headroom, and the lift is eased out along
 * the road and through its junctions so the approaches climb to meet it.
 */
function liftForHeadroom(model: TileModel, tracks: Map<string, Track>, all: Track[]): void {
  const near = groundGrid(all);
  const need = new Map<Track, Float32Array>();
  let any = false;
  for (const t of all) {
    const want = new Float32Array(t.n);
    need.set(t, want);
    for (let i = 0; i < t.n; i++) {
      if (t.level[i] <= 0) continue;
      for (const o of near(t.x[i], t.y[i])) {
        if (o.t === t || o.t.h[o.i] > t.h[i] - 1.5) continue;
        // Only a true crossing counts: a ramp peeling away from the road beside it is not passing over it.
        if (Math.abs(t.tx[i] * o.t.ty[o.i] - t.ty[i] * o.t.tx[o.i]) < 0.4) continue;
        if (Math.hypot(o.t.x[o.i] - t.x[i], o.t.y[o.i] - t.y[i]) > halfWidth(o.t, o.i) + 1) continue;
        want[i] = Math.max(want[i], o.t.h[o.i] + HEADROOM - t.h[i]);
      }
      if (want[i] > 0) any = true;
    }
  }
  if (!any) return;

  const lift = new Map<Track, Float32Array>(all.map((t) => [t, need.get(t)!.slice()]));
  for (let round = 0; round < 250; round++) {
    for (const t of all) {
      const d = lift.get(t)!;
      const want = need.get(t)!;
      let prev = d[0];
      for (let i = 1; i < t.n - 1; i++) {
        const next = Math.max(want[i], 0.25 * prev + 0.5 * d[i] + 0.25 * d[i + 1]);
        prev = d[i];
        d[i] = next;
      }
    }
    // Every arm of a junction shares one height, so they share one lift.
    for (const j of model.junctions) {
      let sum = 0;
      let most = 0;
      for (const a of j.arms) {
        const t = tracks.get(a.road)!;
        sum += lift.get(t)![a.end === 'a' ? Math.min(1, t.n - 1) : Math.max(0, t.n - 2)];
        most = Math.max(most, need.get(t)![a.end === 'a' ? 0 : t.n - 1]);
      }
      const v = Math.max(most, sum / j.arms.length);
      for (const a of j.arms) {
        const t = tracks.get(a.road)!;
        lift.get(t)![a.end === 'a' ? 0 : t.n - 1] = v;
      }
    }
  }
  for (const t of all) {
    const d = lift.get(t)!;
    for (let i = 0; i < t.n; i++) t.h[i] += d[i];
  }
}

/** Headroom that makes one road count as passing over another rather than meeting it. */
export const CLEARANCE = 4;

/**
 * The map tags a bridge only between its abutments, which is often shorter than the gap it has to
 * clear. Wherever a road on the ground runs well above another road's carriageway it must be on a
 * structure, whatever the tags say, so those stretches become deck too.
 */
function markSpans(all: Track[]): void {
  const near = groundGrid(all);
  const raise: [Track, number][] = [];
  for (const t of all) {
    for (let i = 0; i < t.n; i++) {
      if (t.level[i] !== 0) continue;
      const over = near(t.x[i], t.y[i]).some((o) => {
        if (o.t === t || o.t.h[o.i] > t.h[i] - CLEARANCE) return false;
        const reach = halfWidth(o.t, o.i) + halfWidth(t, i) * 0.6 + 1.5;
        return Math.hypot(o.t.x[o.i] - t.x[i], o.t.y[o.i] - t.y[i]) < reach;
      });
      if (over) raise.push([t, i]);
    }
  }
  for (const [t, i] of raise) t.level[i] = 1;
}
