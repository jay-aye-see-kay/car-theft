import type { LandmarkInfo } from '../city/format.ts';
import { DECAL, L, SIGN2, SIGN3 } from './atlas.ts';
import { Frame, type Builder, type Mat, type V2, type V3 } from './builder.ts';
import type { LandmarkModel } from './landmarks.ts';

// St Kevin's Arcade (W. A. Cumming, 1924) and the steps from it down into
// Myers Park. The arcade runs from Karangahape Road, on the ridge, north
// down the slope to Poynton Terrace: a tiled hall of shops under a glazed
// lantern at street level, then two flights of stairs down a gabled stair
// hall, and out under a big arched window that looks over the park to the
// city. Across Poynton Tce the park steps carry on down the bank on nearly
// the same line, to Michelangelo's Moses (a copy) at the bottom.
//
// Both are laid out in their own frames: the arcade along its passage (OSM
// way 162651921), the steps along theirs (way 23907681). Heights are the
// LiDAR's: the K Road verandah at ~68 m with a raised middle, the front
// block's roof at ~73.4 m with a lantern over the passage to ~75.5 m, and
// the stair hall's gable roof from 69.4 m eaves to a 73.3 m ridge. The
// steps' flights are fitted to the bank (the terrain under them is the
// smoothed LiDAR ground, which isn't dug): every tread is a little above
// it, the cheek walls hide the gap, and a landing comes where it flattens.
// The arcade is open end to end for walking (and, being GTA, driving: 4.6 m
// wide and 4.4 m high at the K Road door).

/** The arcade's frame: u metres along the passage from the K Road facade, w across (east +), from the passage's middle. */
const ARCADE = new Frame([-731.3, 1477.9], [0.18825, -0.98212], [1, 0.2]);
/** The park steps' frame: s metres down from the head of the steps on Poynton Tce, w across (east +). */
const STEPS = new Frame([-716.9, 1408.2], [0.20504, -0.97875], [1, 0.2]);

/** Passage half-width, the building's sides (w) and where the front block meets the stair hall and the back (u). */
const PW = 2.3;
const WEST = -10.6;
const EAST = 11.8;
const MIDDLE = 26;
const BACK = 56.6;
/** Floor levels: K Road (the hall), the landing halfway down, the bottom landing, and Poynton Tce at the door. */
const HALL = 64.15;
const MID = 60.6;
const LOW = 57.05;
const STREET = 56.25;
/** Roofs: the front block's flat roof and its lantern, and the stair hall's gable. */
const ROOF = 73.4;
const LANTERN = { eaves: 74.0, ridge: 75.4 };
const GABLE = { eaves: 69.4, ridge: 73.3, at: (WEST + EAST) / 2, overhang: 0.3 };
/** The K Road door's head (it's as wide as the passage). */
const FRONT_DOOR = 68.0;
/** The back: the door and the arched window over it (half-width, heights). */
const DOOR = { hw: 2.0, top: 60.4 };
const ARCH = { hw: 2.0, sill: 61.2, spring: 66.6 };
/** Shop bays along the hall (u), each 4.9 m. */
const BAYS = [1.0, 5.9, 10.8, 15.7, 20.6, 25.5];
/** Where the lantern starts, behind the K Road facade (u). */
const LANTERN_START = 0.6;
/** Skylights in the stair hall's roof over the passage, [u0, u1]. */
const SKYLIGHTS: [number, number][] = [];
for (let u = 28; u + 3 <= BACK - 1; u += 4.5) SKYLIGHTS.push([u, u + 3]);

/** A stair run along a frame: `n` risers from y0 at u0 down to y1 at u1, the first at u0; n = 0 is flat. */
interface Run {
  u0: number;
  u1: number;
  y0: number;
  y1: number;
  n: number;
}

const ARCADE_RUNS: Run[] = [
  { u0: 0, u1: MIDDLE, y0: HALL, y1: HALL, n: 0 },
  { u0: MIDDLE, u1: 36.08, y0: HALL, y1: MID, n: 24 },
  { u0: 36.08, u1: 41.42, y0: MID, y1: MID, n: 0 },
  { u0: 41.42, u1: 51.5, y0: MID, y1: LOW, n: 24 },
  { u0: 51.5, u1: 55.4, y0: LOW, y1: LOW, n: 0 },
  { u0: 55.4, u1: BACK, y0: LOW, y1: STREET, n: 4 },
];

/** The park steps: a landing at the head, then flights of [risers, tread, landing after] fitted to the bank. */
const PARK = { head: -6.6, top: 56.36, start: -3.3, riser: 0.152, hw: 1.3, wall: 0.3, flights: [[16, 0.46, 0.9], [16, 0.32, 0.9], [15, 0.28, 0.9], [16, 0.3, 0.9], [16, 0.45, 0]] };
/** Cheek walls stand this far above the line of the treads, and go this far below the lowest. */
const CHEEK = { up: 0.75, down: 1.6 };
/** Michelangelo's Moses, on a plinth by the foot of the steps (OSM node 4451119939), facing them. */
const MOSES = { at: [-703.1, 1383.7] as V2, ground: 44.6, facing: Math.PI };

function parkRuns(): Run[] {
  const runs: Run[] = [{ u0: PARK.head, u1: PARK.start, y0: PARK.top, y1: PARK.top, n: 0 }];
  let u = PARK.start;
  let y = PARK.top;
  for (const [n, tread, landing] of PARK.flights) {
    const y1 = y - n * PARK.riser;
    runs.push({ u0: u, u1: u + n * tread, y0: y, y1, n });
    u += n * tread;
    y = y1;
    if (landing > 0) {
      runs.push({ u0: u, u1: u + landing, y0: y, y1: y, n: 0 });
      u += landing;
    }
  }
  return runs;
}
const PARK_RUNS = parkRuns();

// Surfaces.
const RENDER: Mat = { layer: L.plaster, colour: 0xe9dcc0, su: 4, sv: 4 };
const RENDER_IN: Mat = { layer: L.plaster, colour: 0xf3ead6, su: 4, sv: 4, shade: 0.92 };
const RENDER_BACK: Mat = { layer: L.plaster, colour: 0xd8c7a6, su: 4, sv: 4 };
const DADO: Mat = { layer: L.plaster, colour: 0x2f5444, su: 4, sv: 4, shade: 0.9 };
const TRIM: Mat = { layer: -1, colour: 0xf7f1e2 };
const TRIM_BACK: Mat = { layer: -1, colour: 0xece2cc };
const SASH: Mat = { layer: L.sashes, colour: 0xe9dcc0, su: 4.9, sv: 3.4 };
const SASH_IN: Mat = { layer: L.sashes, colour: 0xf3ead6, su: 4.9, sv: 3.4, shade: 0.92 };
const SASH_BACK: Mat = { layer: L.sashes, colour: 0xd8c7a6, su: 4.9, sv: 3.4 };
const TILES: Mat = { layer: L.tiles, colour: 0xf1e8d2, su: 1, sv: 1 };
const BORDER: Mat = { layer: -1, colour: 0x7a2c24 };
const TERRAZZO: Mat = { layer: -1, colour: 0xd3cab9 };
const RISER: Mat = { layer: -1, colour: 0xb9ae9a };
const BRASS: Mat = { layer: -1, colour: 0xc59c48 };
const IRONWORK: Mat = { layer: -1, colour: 0xeeeae0 };
const GLASS_IN: Mat = { layer: -1, colour: 0xdcecf3, glow: 0.5 };
const GLASS_OUT: Mat = { layer: L.glass, colour: 0x7f97a3, su: 3, sv: 3 };
const WINDOW_OUT: Mat = { layer: -1, colour: 0x3e5662 };
const GLAZING_BAR: Mat = { layer: -1, colour: 0xf2ede2 };
const ROOF_FLAT: Mat = { layer: L.concrete, colour: 0x77736b, su: 8, sv: 8 };
const IRON_ROOF: Mat = { layer: L.roofTiles, colour: 0x8c4436, su: 3, sv: 3 };
const BOARDS: Mat = { layer: -1, colour: 0x8a6a48, shade: 0.85 };
const LAMP: Mat = { layer: -1, colour: 0xfff0cc, glow: 1.4 };
const SCONCE: Mat = { layer: -1, colour: 0xffd9a0, glow: 1.2 };
const VERANDAH: Mat = { layer: -1, colour: 0x6e6a62 };
const FASCIA: Mat = { layer: -1, colour: 0x24443a };
const SOFFIT: Mat = { layer: -1, colour: 0xece4d0, shade: 0.85 };
const SIGNS2: Mat = { layer: L.signs2, colour: 0xffffff };
const SIGNS3: Mat = { layer: L.signs3, colour: 0xffffff };
const NEON2: Mat = { layer: L.signs2, colour: 0xffffff, glow: 1.3 };
const NEON3: Mat = { layer: L.signs3, colour: 0xffffff, glow: 1.3 };
const OCULUS: Mat = { layer: L.decal, colour: 0xffffff };
const CONCRETE: Mat = { layer: L.concrete, colour: 0xb4ada0, su: 3, sv: 3 };
const CONCRETE_RISER: Mat = { ...CONCRETE, shade: 0.72 };
const NOSING: Mat = { layer: -1, colour: 0x6f6a62 };
const BLUESTONE: Mat = { layer: L.stone, colour: 0x6a6861, su: 2.4, sv: 2.4 };
const COPING: Mat = { layer: -1, colour: 0x8f8b82 };
const RAIL: Mat = { layer: -1, colour: 0x2a2f2d };
const PAVING: Mat = { layer: L.stone, colour: 0xa8a092, su: 1.6, sv: 1.6 };
const MARBLE: Mat = { layer: -1, colour: 0xece8df };
const PLINTH: Mat = { layer: L.stone, colour: 0xcfc8b8, su: 2, sv: 2 };

/** Shops along the arcade: timber colour and fascia sign, west side then east, front to back. */
const SHOPS: { colour: number; sign: readonly [number, number, number, number]; signs3?: boolean }[][] = [
  [
    { colour: 0x2f5d4a, sign: SIGN2.records },
    { colour: 0x7a2630, sign: SIGN2.vintage },
    { colour: 0xd6c59c, sign: SIGN2.books },
    { colour: 0x2a2a2a, sign: SIGN2.tattoo },
    { colour: 0x23395d, sign: SIGN3.plants, signs3: true },
  ],
  [
    { colour: 0x23395d, sign: SIGN3.barber, signs3: true },
    { colour: 0xb8862b, sign: SIGN3.vinyl, signs3: true },
    { colour: 0x2b6f6f, sign: SIGN2.espresso },
    { colour: 0x6a2c4a, sign: SIGN3.opShop, signs3: true },
    { colour: 0x2f5d4a, sign: SIGN3.burgers, signs3: true },
  ],
];

// Frame helpers: plan points, directions and 3D points from (u, w).
const at = (f: Frame, u: number, w: number): V2 => f.at(u, w);
const dir = (f: Frame, du: number, dw: number): V2 => [f.d[0] * du + f.n[0] * dw, f.d[1] * du + f.n[1] * dw];
const p3 = (f: Frame, u: number, y: number, w: number): V3 => f.p(u, y, w);
const out3 = (f: Frame, du: number, dy: number, dw: number): V3 => {
  const [x, z] = dir(f, du, dw);
  return [x, dy, z];
};

/** A wall across the frame at u, from w0 to w1, facing +u (side 1) or -u (side -1). */
function wallU(b: Builder, f: Frame, u: number, w0: number, w1: number, y0: number, y1: number, m: Mat, side: number, opts: { fitU?: number; vBase?: number; v1?: number } = {}): void {
  // Running to the right as seen from the side it faces, so textures read the right way round.
  const [a, c] = side > 0 ? [w1, w0] : [w0, w1];
  b.wall(at(f, u, a), at(f, u, c), y0, y1, m, { out: dir(f, side, 0), ...opts });
}

/** A wall along the frame at w, from u0 to u1, facing +w (side 1) or -w (side -1). */
function wallW(b: Builder, f: Frame, w: number, u0: number, u1: number, y0: number, y1: number, m: Mat, side: number, opts: { fitU?: number; vBase?: number; v1?: number } = {}): void {
  const [a, c] = side > 0 ? [u0, u1] : [u1, u0];
  b.wall(at(f, a, w), at(f, c, w), y0, y1, m, { out: dir(f, 0, side), ...opts });
}

/** A box in the frame: u0..u1 along, w0..w1 across. */
function boxF(b: Builder, f: Frame, u0: number, u1: number, w0: number, w1: number, y0: number, y1: number, m: Mat, top?: Mat | null): void {
  const [cx, cz] = at(f, (u0 + u1) / 2, (w0 + w1) / 2);
  b.box(cx, cz, y0, y1, u1 - u0, w1 - w0, f.heading, m, top);
}

function collideBoxF(b: Builder, f: Frame, u0: number, u1: number, w0: number, w1: number, y0: number, y1: number): void {
  const [cx, cz] = at(f, (u0 + u1) / 2, (w0 + w1) / 2);
  b.collideBox(cx, cz, y0, y1, u1 - u0, w1 - w0, f.heading);
}

/** A flat rectangle u0..u1 by w0..w1 at height y, facing up (or down). */
function capF(b: Builder, f: Frame, u0: number, u1: number, w0: number, w1: number, y: number, m: Mat, up = true): void {
  b.cap([at(f, u0, w0), at(f, u1, w0), at(f, u1, w1), at(f, u0, w1)], y, m, up);
}

/** A lettered sign on a face of the frame (at u, facing +u or -u; or at w, facing ±w with `alongW`), centred on c. */
function signF(b: Builder, f: Frame, face: { u: number; side: number } | { w: number; side: number }, c: number, y: number, width: number, height: number, uv: readonly [number, number, number, number], m: Mat, proud = 0.03): void {
  const centre = 'u' in face ? at(f, face.u, c) : at(f, c, face.w);
  const out = 'u' in face ? dir(f, face.side, 0) : dir(f, 0, face.side);
  // Its frame runs to the viewer's right: (out.z, -out.x).
  const sf = new Frame(centre, [out[1], -out[0]], out);
  b.decal(sf, 0, y, width, height, uv, m, proud);
}

/**
 * The line a foot follows down a run: the landing itself, or a ramp from
 * the landing above to the one below (a little over the treads, never under,
 * and no lip where it meets a landing for a foot to catch on).
 */
function walkLine(r: Run, u: number): number {
  return r.y0 - ((u - r.u0) / (r.u1 - r.u0)) * (r.y0 - r.y1);
}

/**
 * Treads, risers and nosings across w0..w1 for each run; flat runs get
 * `flat`. Far away a flight is one sloping quad.
 */
function stairs(b: Builder, f: Frame, runs: Run[], w0: number, w1: number, m: { tread: Mat; riser: Mat; nosing: Mat; flat: Mat }, far: boolean): void {
  for (const r of runs) {
    if (r.n === 0) {
      capF(b, f, r.u0, r.u1, w0, w1, r.y0 + 0.005, m.flat);
      continue;
    }
    if (far) {
      b.poly([p3(f, r.u0, r.y0, w0), p3(f, r.u1, r.y1, w0), p3(f, r.u1, r.y1, w1), p3(f, r.u0, r.y0, w1)], [[0, 0], [1, 0], [1, 1], [0, 1]], m.tread, [0, 1, 0]);
      continue;
    }
    const t = (r.u1 - r.u0) / r.n;
    const rise = (r.y0 - r.y1) / r.n;
    for (let k = 1; k <= r.n; k++) {
      const ua = r.u0 + (k - 1) * t;
      const y = r.y0 - k * rise;
      wallU(b, f, ua, w0, w1, y, y + rise, m.riser, 1);
      capF(b, f, ua, ua + t, w0, w1, y, m.tread);
      // A strip along the front edge, where you step off.
      capF(b, f, ua + t - 0.07, ua + t, w0, w1, y + 0.004, m.nosing);
    }
  }
}

/** Solid ramps under a run (feet follow the middle of the treads), down to `depth` below its foot. */
function collideRuns(b: Builder, f: Frame, runs: Run[], w0: number, w1: number, depth = 2.5): void {
  for (const r of runs) {
    const ya = walkLine(r, r.u0);
    const yb = walkLine(r, r.u1);
    const bottom = Math.min(ya, yb) - depth;
    const pts: V3[] = [];
    for (const w of [w0, w1]) {
      pts.push(p3(f, r.u0, ya, w), p3(f, r.u1, yb, w), p3(f, r.u0, bottom, w), p3(f, r.u1, bottom, w));
    }
    b.collideHull(pts);
  }
}

/** A lamp on a post: a black column, a scroll arm and a glowing globe. */
function lampPost(b: Builder, x: number, z: number, ground: number): void {
  const top = ground + 3.6;
  b.box(x, z, ground - 1.0, ground + 0.5, 0.32, 0.32, 0, RAIL, RAIL);
  b.box(x, z, ground + 0.5, top, 0.13, 0.13, 0, RAIL, null);
  b.lathe(x, z, [[0.1, top], [0.26, top + 0.2], [0.2, top + 0.55], [0.0, top + 0.62]], 6, LAMP);
  b.box(x, z, top + 0.55, top + 0.7, 0.18, 0.18, Math.PI / 4, RAIL);
  b.collideCylinder(x, z, ground - 0.2, top, 0.16);
}

/** The arcade: outside always; inside in full only when you're close, else a plain one to see through the doors. */
function buildArcade(b: Builder, far: boolean, _records: LandmarkInfo[]): void {
  kRoadFront(b, far);
  sides(b, far);
  roofs(b, far);
  back(b, far);
  if (far) return;
  if (!b.close) {
    plainInside(b);
    return;
  }
  hall(b);
  stairHall(b);
  arcadeColliders(b);
}

/** The park steps, and Moses at the foot of them. */
function buildSteps(b: Builder, far: boolean, _records: LandmarkInfo[]): void {
  parkSteps(b, far);
  if (!far) moses(b);
}

/** The K Road facade: shops either side of the arcade's door under a verandah, two storeys of render, a lettered parapet. */
function kRoadFront(b: Builder, far: boolean): void {
  const f = ARCADE;
  const veranda = { u: -3.4, y: 67.6, top: 67.85, mid: 2.9, midY: 68.75, midTop: 69.0 };
  b.ground = HALL;
  // Ground floor shops, their glass under the verandah, on a plinth to the footpath.
  wallU(b, f, 0, WEST, -PW, 63.4, HALL, RENDER, -1);
  wallU(b, f, 0, PW, EAST, 63.4, HALL, RENDER, -1);
  wallU(b, f, 0, WEST, -PW, HALL, veranda.y, { ...shopMat(0x2b6f6f), sv: veranda.y - HALL }, -1, { fitU: 2 });
  wallU(b, f, 0, PW, EAST, HALL, veranda.y, { ...shopMat(0x7a2630), sv: veranda.y - HALL }, -1, { fitU: 2 });
  // Upper storey: render between the pilasters, sash windows, a frieze, the parapet.
  wallU(b, f, 0, WEST, -PW, veranda.y, FRONT_DOOR, RENDER, -1);
  wallU(b, f, 0, PW, EAST, veranda.y, FRONT_DOOR, RENDER, -1);
  const bays = [WEST, -6.45, -PW, PW, 7.05, EAST];
  for (let k = 0; k + 1 < bays.length; k++) wallU(b, f, 0, bays[k], bays[k + 1], FRONT_DOOR, 71.4, SASH, -1, { fitU: 1 });
  wallU(b, f, 0, WEST, EAST, 71.4, 73.15, RENDER, -1);
  wallU(b, f, 0, WEST, -3.6, 73.15, 73.75, RENDER, -1);
  wallU(b, f, 0, 3.6, EAST, 73.15, 73.75, RENDER, -1);
  // The raised middle with a little pediment, carrying the name.
  wallU(b, f, 0, -3.6, 3.6, 73.15, 75.0, RENDER, -1);
  b.poly([p3(f, -0.02, 75.0, -3.8), p3(f, -0.02, 75.0, 3.8), p3(f, -0.02, 75.7, 0)], [[0, 0], [1.9, 0], [0.95, 0.2]], RENDER, out3(f, -1, 0, 0));
  b.poly([p3(f, -0.02, 75.0, 3.8), p3(f, 0.3, 75.0, 3.8), p3(f, 0.3, 75.7, 0), p3(f, -0.02, 75.7, 0)], [[0, 0], [0.1, 0], [0.1, 1], [0, 1]], TRIM, out3(f, 0, 1, 0.2));
  b.poly([p3(f, -0.02, 75.0, -3.8), p3(f, -0.02, 75.7, 0), p3(f, 0.3, 75.7, 0), p3(f, 0.3, 75.0, -3.8)], [[0, 0], [0.1, 0], [0.1, 1], [0, 1]], TRIM, out3(f, 0, 1, -0.2));
  signF(b, f, { u: 0, side: -1 }, 0, 73.55, 6.6, 0.82, SIGN2.stKevins, SIGNS2, 0.06);
  signF(b, f, { u: 0, side: -1 }, 0, 75.03, 1.9, 0.24, SIGN3.year, SIGNS3, 0.04);
  // Cornice and coping along the top.
  boxF(b, f, -0.45, 0, WEST, EAST, 72.95, 73.2, TRIM);
  boxF(b, f, -0.12, 0.2, WEST, -3.6, 73.75, 73.86, TRIM);
  boxF(b, f, -0.12, 0.2, 3.6, EAST, 73.75, 73.86, TRIM);
  boxF(b, f, -0.15, 0.2, -3.7, 3.7, 74.95, 75.05, TRIM);
  if (!far) {
    // Pilasters with capitals, and a dentil course under the cornice.
    for (const w of [WEST + 0.25, -6.45, -PW - 0.1, PW + 0.1, 7.05, EAST - 0.25]) {
      boxF(b, f, -0.18, 0, w - 0.25, w + 0.25, veranda.top, 72.75, TRIM, null);
      boxF(b, f, -0.28, 0, w - 0.33, w + 0.33, 72.55, 72.75, TRIM);
    }
    boxF(b, f, -0.26, 0, WEST, EAST, 72.75, 72.95, TRIM_BACK, null);
    boxF(b, f, -0.18, 0, -3.6, 3.6, 73.15, 73.3, TRIM);
  }

  // The door: open to the hall, the wall over it seen from inside.
  capF(b, f, 0, LANTERN_START, -PW, PW, FRONT_DOOR, SOFFIT, false);
  wallU(b, f, LANTERN_START, -PW, PW, FRONT_DOOR, ROOF, RENDER_IN, 1);

  // The verandah: a slab with a deep fascia, raised over the door; stays up to the facade.
  for (const [w0, w1] of [[WEST, -veranda.mid], [veranda.mid, EAST]]) {
    boxF(b, f, veranda.u, 0, w0, w1, veranda.y, veranda.top, VERANDAH);
    capF(b, f, veranda.u, 0, w0, w1, veranda.y, SOFFIT, false);
    boxF(b, f, veranda.u - 0.05, veranda.u + 0.05, w0, w1, veranda.y - 0.3, veranda.top + 0.1, FASCIA);
  }
  boxF(b, f, veranda.u, 0, -veranda.mid, veranda.mid, veranda.midY, veranda.midTop, VERANDAH);
  capF(b, f, veranda.u, 0, -veranda.mid, veranda.mid, veranda.midY, SOFFIT, false);
  boxF(b, f, veranda.u - 0.05, veranda.u + 0.05, -veranda.mid, veranda.mid, veranda.midY - 0.35, veranda.midTop + 0.12, FASCIA);
  for (const side of [-1, 1]) {
    const w = side * veranda.mid;
    wallW(b, f, w, veranda.u, 0, veranda.top, veranda.midY, FASCIA, side);
  }
  signF(b, f, { u: veranda.u - 0.05, side: -1 }, 0, veranda.midY - 0.33, 4.6, 0.575, SIGN2.stKevins, SIGNS2);
  signF(b, f, { u: veranda.u - 0.05, side: -1 }, -6.45, veranda.y - 0.27, 3.2, 0.4, SIGN2.espresso, SIGNS2);
  signF(b, f, { u: veranda.u - 0.05, side: -1 }, 7.05, veranda.y - 0.27, 3.2, 0.4, SIGN2.vintage, SIGNS2);
  if (far) return;
  for (const w of [-8.5, -4.6, 4.6, 8.9]) b.bar(p3(f, veranda.u + 0.3, veranda.top, w), p3(f, -0.05, 70.6, w), 0.05, RAIL);
  // Lamps under the verandah.
  for (const w of [-6.45, 0, 7.05]) {
    const y = w === 0 ? veranda.midY : veranda.y;
    const [x, z] = at(f, -1.6, w);
    b.lathe(x, z, [[0.0, y - 0.4], [0.18, y - 0.34], [0.2, y - 0.16], [0.06, y - 0.02]], 6, LAMP);
  }
}

function shopMat(colour: number): Mat {
  return { layer: L.shopfront, colour, su: 4.9, sv: 3.9 };
}

/** The side walls: party walls along the front block, then the stair hall's windows over the car parks. */
function sides(b: Builder, far: boolean): void {
  const f = ARCADE;
  b.ground = 57;
  for (const [w, side] of [[WEST, -1], [EAST, 1]] as const) {
    wallW(b, f, w, 0, MIDDLE, 59, ROOF, RENDER, side);
    wallW(b, f, w, 0, MIDDLE, ROOF, ROOF + 0.35, RENDER, side);
    wallW(b, f, w, MIDDLE, BACK, 55.6, 60.9, RENDER_BACK, side);
    wallW(b, f, w, MIDDLE, BACK, 60.9, 67.7, SASH_BACK, side, { fitU: 6 });
    wallW(b, f, w, MIDDLE, BACK, 67.7, GABLE.eaves, RENDER_BACK, side);
    if (!far) {
      boxF(b, f, MIDDLE, BACK, w - (side > 0 ? 0 : 0.18), w + (side > 0 ? 0.18 : 0), 60.7, 60.9, TRIM_BACK);
      boxF(b, f, MIDDLE, BACK, w - (side > 0 ? 0 : 0.3), w + (side > 0 ? 0.3 : 0), 69.2, GABLE.eaves, TRIM_BACK);
    }
  }
}

/** An end of the lantern at u, facing +u or -u: a pentagon from `bottom` up to its glass roof. */
function lanternEnd(b: Builder, u: number, side: number, bottom: number, m: Mat): void {
  const f = ARCADE;
  b.poly([p3(f, u, bottom, -PW), p3(f, u, bottom, PW), p3(f, u, LANTERN.eaves, PW), p3(f, u, LANTERN.eaves, -PW)], [[0, 0], [1.15, 0], [1.15, 0.3], [0, 0.3]], m, out3(f, side, 0, 0));
  b.poly([p3(f, u, LANTERN.eaves, -PW), p3(f, u, LANTERN.eaves, PW), p3(f, u, LANTERN.ridge, 0)], [[0, 0.3], [1.15, 0.3], [0.58, 0.65]], m, out3(f, side, 0, 0));
}

/** Roof height of the stair hall's gable at w. */
function gableY(w: number): number {
  const west = WEST - GABLE.overhang;
  const east = EAST + GABLE.overhang;
  const t = w < GABLE.at ? (w - west) / (GABLE.at - west) : (east - w) / (east - GABLE.at);
  return GABLE.eaves + (GABLE.ridge - GABLE.eaves) * t;
}

function roofs(b: Builder, far: boolean): void {
  const f = ARCADE;
  b.ground = -Infinity;
  // Front block: flat roofs either side of the lantern, a parapet round the edge.
  capF(b, f, 0, MIDDLE, WEST, -PW, ROOF, ROOF_FLAT);
  capF(b, f, 0, MIDDLE, PW, EAST, ROOF, ROOF_FLAT);
  // The front block's back wall over the stair hall's roof (over the passage, from just under the ceiling).
  wallU(b, f, MIDDLE, WEST, -PW, GABLE.eaves - 0.2, ROOF + 0.35, RENDER_BACK, 1);
  wallU(b, f, MIDDLE, PW, EAST, GABLE.eaves - 0.2, ROOF + 0.35, RENDER_BACK, 1);
  wallU(b, f, MIDDLE, -PW, PW, 72.0, ROOF + 0.35, RENDER_BACK, 1);
  // The lantern: glazed sides, a glass roof, its ends.
  for (const side of [-1, 1]) {
    wallW(b, f, side * PW, LANTERN_START, MIDDLE, ROOF, LANTERN.eaves, GLASS_OUT, side);
    const len = (MIDDLE - LANTERN_START) / 3;
    b.poly([p3(f, LANTERN_START, LANTERN.eaves, side * PW), p3(f, MIDDLE, LANTERN.eaves, side * PW), p3(f, MIDDLE, LANTERN.ridge, 0), p3(f, LANTERN_START, LANTERN.ridge, 0)], [[0, 0], [len, 0], [len, 1], [0, 1]], GLASS_OUT, out3(f, 0, 1, side * 0.6));
  }
  lanternEnd(b, LANTERN_START, -1, ROOF, RENDER);
  if (!far) {
    // A ridge cap and some plant on the flat roofs.
    boxF(b, f, LANTERN_START, MIDDLE, -0.1, 0.1, LANTERN.ridge - 0.05, LANTERN.ridge + 0.08, IRONWORK);
    boxF(b, f, 6, 8.5, -8, -5.5, ROOF, ROOF + 1.2, ROOF_FLAT);
    boxF(b, f, 15, 16.5, 6, 9, ROOF, ROOF + 0.9, ROOF_FLAT);
    for (const [w0, w1] of [[WEST, WEST + 0.2], [EAST - 0.2, EAST]]) boxF(b, f, 0, MIDDLE, w0, w1, ROOF, ROOF + 0.35, RENDER, TRIM);
  }

  // Stair hall: a long gable of painted iron with glazing down the middle over the stairs.
  const west = WEST - GABLE.overhang;
  const east = EAST + GABLE.overhang;
  const u1 = BACK + GABLE.overhang;
  for (const [w0, side] of [[west, -1], [east, 1]] as const) {
    b.poly([p3(f, MIDDLE, GABLE.eaves, w0), p3(f, u1, GABLE.eaves, w0), p3(f, u1, GABLE.ridge, GABLE.at), p3(f, MIDDLE, GABLE.ridge, GABLE.at)], [[0, 0], [(u1 - MIDDLE) / 3, 0], [(u1 - MIDDLE) / 3, 4], [0, 4]], IRON_ROOF, out3(f, 0, 1, side * 0.35));
    // Skylights over the passage, just proud of the iron.
    const wa = side < 0 ? -PW : GABLE.at;
    const wb = side < 0 ? GABLE.at : PW;
    for (const [u0, u1] of SKYLIGHTS) {
      b.poly([p3(f, u0, gableY(wa) + 0.04, wa), p3(f, u1, gableY(wa) + 0.04, wa), p3(f, u1, gableY(wb) + 0.04, wb), p3(f, u0, gableY(wb) + 0.04, wb)], [[0, 0], [1, 0], [1, 1], [0, 1]], GLASS_OUT, out3(f, 0, 1, side * 0.35));
    }
  }
  if (!far) boxF(b, f, MIDDLE, u1, GABLE.at - 0.12, GABLE.at + 0.12, GABLE.ridge - 0.05, GABLE.ridge + 0.1, IRON_ROOF);
}

/** The back on Poynton Tce: a tall gable, the door, the arched window over it, three storeys of windows either side. */
function back(b: Builder, far: boolean): void {
  const f = ARCADE;
  const u = BACK;
  b.ground = STREET;
  for (const [w0, w1] of [[WEST, -PW], [PW, EAST]]) {
    wallU(b, f, u, w0, w1, 55.6, 56.3, RENDER_BACK, 1);
    wallU(b, f, u, w0, w1, 56.3, 60.2, { ...shopMat(0x3b3a46), sv: 3.9 }, 1, { fitU: 2 });
    wallU(b, f, u, w0, w1, 60.2, 60.9, RENDER_BACK, 1);
    wallU(b, f, u, w0, w1, 60.9, 67.7, SASH_BACK, 1, { fitU: 2, vBase: 60.9 });
    wallU(b, f, u, w0, w1, 67.7, GABLE.eaves, RENDER_BACK, 1);
  }
  archWall(b, u, 1, GABLE.eaves, RENDER_BACK);
  // The gable over it all, with a round window.
  const gw = WEST - GABLE.overhang;
  const ge = EAST + GABLE.overhang;
  b.poly([p3(f, u, GABLE.eaves, ge), p3(f, u, GABLE.ridge, GABLE.at), p3(f, u, GABLE.eaves, gw)], [[0, 0], [2.8, 1], [5.6, 0]], RENDER_BACK, out3(f, 1, 0, 0));
  signF(b, f, { u, side: 1 }, GABLE.at, 70.2, 1.5, 1.5, DECAL.oculus, OCULUS, 0.03);
  signF(b, f, { u, side: 1 }, 0, DOOR.top + 0.1, 4.0, 0.5, SIGN2.stKevins, SIGNS2, 0.05);
  arch(b, u - 0.2, far);
  if (far) return;
  // Pilasters, string courses, the cornice along the eaves and up the gable.
  for (const w of [WEST + 0.25, -PW - 0.15, PW + 0.15, EAST - 0.25]) boxF(b, f, u, u + 0.2, w - 0.25, w + 0.25, 55.6, GABLE.eaves, TRIM_BACK, null);
  boxF(b, f, u, u + 0.18, WEST, -DOOR.hw, 60.2, 60.4, TRIM_BACK);
  boxF(b, f, u, u + 0.18, DOOR.hw, EAST, 60.2, 60.4, TRIM_BACK);
  boxF(b, f, u, u + 0.3, gw, ge, GABLE.eaves - 0.15, GABLE.eaves + 0.05, TRIM_BACK);
  for (const [w0, side] of [[gw, 1], [ge, -1]] as const) {
    b.bar(p3(f, u + 0.15, GABLE.eaves + 0.05, w0), p3(f, u + 0.15, GABLE.ridge + 0.05, GABLE.at + side * 0.1), 0.25, TRIM_BACK);
  }
  // The arched window's reveals: its sides and the soffit round the arch.
  for (const side of [-1, 1]) wallW(b, f, side * ARCH.hw, u - 0.4, u, ARCH.sill, ARCH.spring, RENDER_IN, -side);
  const n = 10;
  for (let k = 0; k < n; k++) {
    const a0 = Math.PI - (k / n) * Math.PI;
    const a1 = Math.PI - ((k + 1) / n) * Math.PI;
    const pa = (uu: number, a: number) => p3(f, uu, ARCH.spring + Math.sin(a) * ARCH.hw, Math.cos(a) * ARCH.hw);
    const am = (a0 + a1) / 2;
    b.poly([pa(u - 0.4, a0), pa(u, a0), pa(u, a1), pa(u - 0.4, a1)], [[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1]], RENDER_IN, out3(f, 0, -Math.sin(am), -Math.cos(am)));
  }
  // The door's reveals and head.
  for (const side of [-1, 1]) wallW(b, f, side * DOOR.hw, u - 0.4, u, STREET, DOOR.top, RENDER_IN, -side);
  capF(b, f, u - 0.4, u, -DOOR.hw, DOOR.hw, DOOR.top, RENDER_IN, false);
  // A lamp either side of the door.
  for (const side of [-1, 1]) {
    const [x, z] = at(f, u + 0.3, side * 2.9);
    b.box(x, z, 59.0, 59.5, 0.25, 0.25, f.heading, RAIL, RAIL);
    b.lathe(x, z, [[0.0, 58.6], [0.15, 58.7], [0.15, 59.0], [0.0, 59.05]], 6, LAMP);
  }
}

/**
 * The wall round the door and the arched window, across the passage at u,
 * facing +u (outside) or -u (inside): strips either side, the band between
 * door and sill, and the spandrels over the arch up to `top` (a number, or
 * the roof's underside inside).
 */
function archWall(b: Builder, u: number, side: number, top: number | ((w: number) => number), m: Mat): void {
  const f = ARCADE;
  const topY = typeof top === 'number' ? () => top : top;
  for (const s of [-1, 1]) {
    const [w0, w1] = s < 0 ? [-PW, -ARCH.hw] : [ARCH.hw, PW];
    b.poly([p3(f, u, 55.6, w0), p3(f, u, 55.6, w1), p3(f, u, topY(w1), w1), p3(f, u, topY(w0), w0)], [[0, 0], [0.1, 0], [0.1, 3], [0, 3]], m, out3(f, side, 0, 0));
  }
  wallU(b, f, u, -ARCH.hw, ARCH.hw, DOOR.top, ARCH.sill, m, side);
  // Spandrels: from each stretch of the arch up to the top.
  const n = 10;
  for (let k = 0; k < n; k++) {
    const a0 = Math.PI - (k / n) * Math.PI;
    const a1 = Math.PI - ((k + 1) / n) * Math.PI;
    const wa = Math.cos(a0) * ARCH.hw;
    const wb = Math.cos(a1) * ARCH.hw;
    const ya = ARCH.spring + Math.sin(a0) * ARCH.hw;
    const yb = ARCH.spring + Math.sin(a1) * ARCH.hw;
    b.poly([p3(f, u, ya, wa), p3(f, u, yb, wb), p3(f, u, topY(wb), wb), p3(f, u, topY(wa), wa)], [[0, 0], [0.1, 0], [0.1, 0.5], [0, 0.5]], m, out3(f, side, 0, 0));
  }
}

/** The arched window's glass at u: dark from outside, bright sky from in, glazing bars through. */
function arch(b: Builder, u: number, far: boolean): void {
  const f = ARCADE;
  const n = 10;
  const outline: [number, number][] = [[-ARCH.hw, ARCH.sill]];
  for (let k = 0; k <= n; k++) {
    const a = Math.PI - (k / n) * Math.PI;
    outline.push([Math.cos(a) * ARCH.hw, ARCH.spring + Math.sin(a) * ARCH.hw]);
  }
  outline.push([ARCH.hw, ARCH.sill]);
  // A fan from the middle of the sill.
  const hub: [number, number] = [0, ARCH.sill];
  for (let k = 0; k + 1 < outline.length; k++) {
    const tri: V3[] = [p3(f, u, hub[1], hub[0]), p3(f, u, outline[k][1], outline[k][0]), p3(f, u, outline[k + 1][1], outline[k + 1][0])];
    const uv = (q: V3, i: number): [number, number] => [i === 0 ? 0.5 : 0, q[1] / 4];
    b.poly(tri, tri.map(uv), WINDOW_OUT, out3(f, 1, 0, 0));
    b.poly(tri, tri.map(uv), GLASS_IN, out3(f, -1, 0, 0));
  }
  if (far) return;
  for (const w of [-ARCH.hw / 3, ARCH.hw / 3]) {
    b.bar(p3(f, u, ARCH.sill, w), p3(f, u, ARCH.spring + Math.sqrt(ARCH.hw * ARCH.hw - w * w), w), 0.08, GLAZING_BAR);
  }
  for (const y of [63.0, 64.8, ARCH.spring]) b.bar(p3(f, u, y, -ARCH.hw), p3(f, u, y, ARCH.hw), 0.08, GLAZING_BAR);
  for (const a of [Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4]) {
    b.bar(p3(f, u, ARCH.spring, 0), p3(f, u, ARCH.spring + Math.sin(a) * ARCH.hw, Math.cos(a) * ARCH.hw), 0.08, GLAZING_BAR);
  }
  // The arch's moulded surround, outside.
  for (let k = 0; k < 6; k++) {
    const a0 = Math.PI - (k / 6) * Math.PI;
    const a1 = Math.PI - ((k + 1) / 6) * Math.PI;
    const r = ARCH.hw + 0.12;
    b.bar(p3(f, u + 0.32, ARCH.spring + Math.sin(a0) * r, Math.cos(a0) * r), p3(f, u + 0.32, ARCH.spring + Math.sin(a1) * r, Math.cos(a1) * r), 0.22, TRIM_BACK);
  }
  boxF(b, f, u, u + 0.42, -ARCH.hw - 0.2, ARCH.hw + 0.2, ARCH.sill - 0.15, ARCH.sill, TRIM_BACK);
}

/**
 * The inside as seen from the street through the doors: the floors and
 * stairs as plain slopes, the shopfronts and offices as one wall a side,
 * the lantern's glass, the stair hall's walls and ceiling, the back wall.
 */
function plainInside(b: Builder): void {
  const f = ARCADE;
  b.ground = -Infinity;
  capF(b, f, 0, MIDDLE, -PW, PW, HALL + 0.006, TILES);
  stairs(b, f, ARCADE_RUNS.slice(1), -PW, PW, { tread: TERRAZZO, riser: RISER, nosing: BRASS, flat: TILES }, true);
  for (const side of [-1, 1]) {
    const w = side * PW;
    const face = -side;
    wallW(b, f, w, 0, BAYS[0], HALL, ROOF, RENDER_IN, face);
    wallW(b, f, w, BAYS[0], BAYS[BAYS.length - 1], HALL, HALL + 3.9, shopMat(side < 0 ? 0x2f5d4a : 0x23395d), face, { fitU: BAYS.length - 1 });
    wallW(b, f, w, BAYS[0], BAYS[BAYS.length - 1], HALL + 3.9, HALL + 7.3, SASH_IN, face, { fitU: BAYS.length - 1 });
    wallW(b, f, w, BAYS[0], MIDDLE, HALL + 7.3, ROOF, RENDER_IN, face);
    wallW(b, f, w, BAYS[BAYS.length - 1], MIDDLE, HALL, HALL + 7.3, RENDER_IN, face);
    wallW(b, f, w, LANTERN_START, MIDDLE, ROOF, LANTERN.eaves, GLASS_IN, face);
    b.poly([p3(f, LANTERN_START, LANTERN.eaves, w), p3(f, MIDDLE, LANTERN.eaves, w), p3(f, MIDDLE, LANTERN.ridge, 0), p3(f, LANTERN_START, LANTERN.ridge, 0)], [[0, 0], [1, 0], [1, 1], [0, 1]], GLASS_IN, out3(f, 0, -1, face * 0.6));
    const top = gableY(w) - 0.25;
    wallW(b, f, w, MIDDLE, BACK, 55.8, top, RENDER_IN, face);
    b.poly([p3(f, MIDDLE, top, w), p3(f, BACK - 0.4, top, w), p3(f, BACK - 0.4, gableY(GABLE.at) - 0.25, GABLE.at), p3(f, MIDDLE, gableY(GABLE.at) - 0.25, GABLE.at)], [[0, 0], [1, 0], [1, 1], [0, 1]], BOARDS, out3(f, 0, -1, face * 0.3));
  }
  lanternEnd(b, LANTERN_START + 0.02, 1, ROOF, RENDER_IN);
  lanternEnd(b, MIDDLE - 0.02, -1, gableY(GABLE.at) - 0.6, RENDER_IN);
  archWall(b, BACK - 0.4, -1, (w) => gableY(w) - 0.25, RENDER_IN);
}

/** The front hall: tiled floor, shopfronts with offices over, the lantern on its trusses, pendant lamps. */
function hall(b: Builder): void {
  const f = ARCADE;
  b.ground = HALL;
  capF(b, f, 0, MIDDLE, -PW + 0.3, PW - 0.3, HALL + 0.006, TILES);
  for (const s of [-1, 1]) capF(b, f, 0, MIDDLE, s < 0 ? -PW : PW - 0.3, s < 0 ? -PW + 0.3 : PW, HALL + 0.006, BORDER);
  for (const [k, side] of [[0, -1], [1, 1]] as const) {
    const w = side * PW;
    const face = -side; // facing into the passage
    wallW(b, f, w, 0, BAYS[0], HALL, ROOF, RENDER_IN, face);
    wallW(b, f, w, BAYS[BAYS.length - 1], MIDDLE, HALL, ROOF, RENDER_IN, face);
    for (let i = 0; i + 1 < BAYS.length; i++) {
      const shop = SHOPS[k][i];
      wallW(b, f, w, BAYS[i], BAYS[i + 1], HALL, HALL + 3.9, shopMat(shop.colour), face, { fitU: 1 });
      signF(b, f, { w: w + face * 0.02, side: face }, (BAYS[i] + BAYS[i + 1]) / 2, HALL + 3.44, 3.4, 0.425, shop.sign, shop.signs3 ? SIGNS3 : SIGNS2);
    }
    wallW(b, f, w, BAYS[0], BAYS[BAYS.length - 1], HALL + 3.9, HALL + 7.3, SASH_IN, face, { fitU: BAYS.length - 1 });
    wallW(b, f, w, BAYS[0], BAYS[BAYS.length - 1], HALL + 7.3, ROOF, RENDER_IN, face);
    // Mouldings: a rail over the shops, a cornice under the lantern; pilasters between the bays.
    const inner = (d: number): [number, number] => (side < 0 ? [w, w + d] : [w - d, w]);
    boxF(b, f, 0, MIDDLE, ...inner(0.1), HALL + 3.9, HALL + 4.05, TRIM);
    boxF(b, f, 0, MIDDLE, ...inner(0.22), ROOF - 0.3, ROOF, TRIM);
    for (const u of BAYS) boxF(b, f, u - 0.18, u + 0.18, ...inner(0.14), HALL, ROOF - 0.3, TRIM, null);
    // The lantern's glazed sides, seen from inside.
    wallW(b, f, w, LANTERN_START, MIDDLE, ROOF, LANTERN.eaves, GLASS_IN, face);
  }
  // The glass roof from below, and the end walls of the lantern.
  for (const side of [-1, 1]) {
    b.poly([p3(f, LANTERN_START, LANTERN.eaves, side * PW), p3(f, MIDDLE, LANTERN.eaves, side * PW), p3(f, MIDDLE, LANTERN.ridge, 0), p3(f, LANTERN_START, LANTERN.ridge, 0)], [[0, 0], [1, 0], [1, 1], [0, 1]], GLASS_IN, out3(f, 0, -1, -side * 0.6));
  }
  lanternEnd(b, LANTERN_START + 0.02, 1, ROOF, RENDER_IN);
  // Over the way through to the stair hall, from its lower ceiling up.
  lanternEnd(b, MIDDLE - 0.02, -1, gableY(GABLE.at) - 0.6, RENDER_IN);
  // Trusses over the pilasters: a tie and two rafters.
  for (const u of BAYS) {
    b.bar(p3(f, u, ROOF, -PW), p3(f, u, ROOF, PW), 0.1, IRONWORK);
    for (const s of [-1, 1]) b.bar(p3(f, u, LANTERN.eaves - 0.08, s * PW), p3(f, u, LANTERN.ridge - 0.08, 0), 0.1, IRONWORK);
  }
  // Pendant lamps over the middle of each bay.
  for (let i = 0; i + 1 < BAYS.length; i++) {
    const u = (BAYS[i] + BAYS[i + 1]) / 2;
    const [x, z] = at(f, u, 0);
    b.bar([x, ROOF, z], [x, 70.9, z], 0.03, RAIL);
    b.lathe(x, z, [[0.0, 70.25], [0.26, 70.45], [0.2, 70.8], [0.0, 70.9]], 6, LAMP);
  }
}

/** The stair hall: the flights and landings, walls with a dado and a brass rail, shops and bars on the landings, lamps. */
function stairHall(b: Builder): void {
  const f = ARCADE;
  b.ground = -Infinity;
  stairs(b, f, ARCADE_RUNS.slice(1), -PW, PW, { tread: TERRAZZO, riser: RISER, nosing: BRASS, flat: TILES }, false);
  // The landings get the hall's border too.
  for (const r of ARCADE_RUNS.slice(1)) {
    if (r.n) continue;
    for (const s of [-1, 1]) capF(b, f, r.u0, r.u1, s < 0 ? -PW : PW - 0.3, s < 0 ? -PW + 0.3 : PW, r.y0 + 0.008, BORDER);
  }
  const ceiling = (w: number) => gableY(w) - 0.25;
  for (const side of [-1, 1]) {
    const w = side * PW;
    const face = -side;
    const top = ceiling(w);
    b.poly(
      side < 0
        ? [p3(f, MIDDLE, 55.8, w), p3(f, BACK, 55.8, w), p3(f, BACK, top, w), p3(f, MIDDLE, top, w)]
        : [p3(f, BACK, 55.8, w), p3(f, MIDDLE, 55.8, w), p3(f, MIDDLE, top, w), p3(f, BACK, top, w)],
      side < 0 ? [[0, 0], [7.6, 0], [7.6, 4.1], [0, 4.1]] : [[0, 0], [7.6, 0], [7.6, 4.1], [0, 4.1]],
      RENDER_IN,
      out3(f, 0, 0, face),
    );
    // Office windows along the top, as in the hall.
    wallW(b, f, w + face * 0.01, MIDDLE, BACK - 0.6, HALL + 3.9, HALL + 7.3, SASH_IN, face, { fitU: 6 });
    // A green dado and a brass handrail following the stairs.
    for (const r of ARCADE_RUNS.slice(1)) {
      const ya = walkLine(r, r.u0);
      const yb = walkLine(r, r.u1);
      const wd = w + face * 0.012;
      const quad = (y0a: number, y0b: number, y1a: number, y1b: number, m: Mat, wq = wd) => {
        const pts: V3[] = [p3(f, r.u0, y0a, wq), p3(f, r.u1, y0b, wq), p3(f, r.u1, y1b, wq), p3(f, r.u0, y1a, wq)];
        b.poly(pts, [[0, 0], [(r.u1 - r.u0) / 4, 0], [(r.u1 - r.u0) / 4, 0.3], [0, 0.3]], m, out3(f, 0, 0, face));
      };
      quad(ya - 0.4, yb - 0.4, ya + 1.1, yb + 1.1, DADO);
      quad(ya + 1.1, yb + 1.1, ya + 1.18, yb + 1.18, TRIM, w + face * 0.02);
      if (r.n) {
        const wr = w + face * 0.12;
        b.bar(p3(f, r.u0, ya + 0.9, wr), p3(f, r.u1, yb + 0.9, wr), 0.06, BRASS);
        for (const u of [r.u0 + 0.3, (r.u0 + r.u1) / 2, r.u1 - 0.3]) {
          const y = walkLine(r, u) + 0.9;
          b.bar(p3(f, u, y, wr), p3(f, u, y, w), 0.04, BRASS);
        }
      }
    }
    // Sconces on the walls halfway down each flight.
    for (const u of [31, 46.5]) {
      const r = ARCADE_RUNS.find((q) => u >= q.u0 && u < q.u1)!;
      const y = walkLine(r, u) + 2.4;
      const [x, z] = at(f, u, w + face * 0.12);
      b.lathe(x, z, [[0.0, y - 0.05], [0.12, y + 0.08], [0.08, y + 0.24], [0.0, y + 0.26]], 5, SCONCE);
      boxF(b, f, u - 0.04, u + 0.04, ...((side < 0 ? [w, w + 0.12] : [w - 0.12, w]) as [number, number]), y - 0.12, y - 0.04, BRASS);
    }
  }
  // Shops off the landing halfway down, bars at the bottom with neon over their doors.
  const landing = ARCADE_RUNS[2];
  const bottom = ARCADE_RUNS[4];
  const shops: [number, number, number, number, readonly [number, number, number, number], Mat][] = [
    [-1, landing.u0 + 0.2, landing.u1 - 0.2, 0x5c1730, SIGN3.wineBar, SIGNS3],
    [1, landing.u0 + 0.2, landing.u1 - 0.2, 0x2a2a2a, SIGN3.cocktails, NEON3],
    [-1, bottom.u0 + 0.1, bottom.u1 - 0.1, 0x1c1c22, SIGN2.bar, NEON2],
    [1, bottom.u0 + 0.1, bottom.u1 - 0.1, 0x262018, SIGN2.records, SIGNS2],
  ];
  for (const [side, u0, u1, colour, sign, signMat] of shops) {
    const r = u0 < 45 ? landing : bottom;
    const w = side * PW - side * 0.03;
    wallW(b, f, w, u0, u1, r.y0, r.y0 + 3.9, shopMat(colour), -side, { fitU: 1 });
    signF(b, f, { w: w - side * 0.02, side: -side }, (u0 + u1) / 2, r.y0 + 3.44, Math.min(3.4, u1 - u0 - 0.4), Math.min(3.4, u1 - u0 - 0.4) / 8, sign, signMat);
  }
  // The roof from inside: boards between rafters, the glazing over the passage.
  for (const [wa, wb] of [[-PW, GABLE.at], [GABLE.at, PW]]) {
    const n: V3 = out3(f, 0, -1, wa < 0 ? 0.3 : -0.3);
    const quad = (q0: number, q1: number, m: Mat) =>
      b.poly([p3(f, q0, ceiling(wa), wa), p3(f, q1, ceiling(wa), wa), p3(f, q1, ceiling(wb), wb), p3(f, q0, ceiling(wb), wb)], [[0, 0], [1, 0], [1, 1], [0, 1]], m, n);
    let u = MIDDLE;
    for (const [g0, g1] of SKYLIGHTS) {
      quad(u, g0, BOARDS);
      quad(g0, g1, GLASS_IN);
      u = g1;
    }
    quad(u, BACK - 0.4, BOARDS);
  }
  for (let u = MIDDLE + 0.3; u < BACK; u += 4.5) {
    for (const s of [-1, 1]) b.bar(p3(f, u, ceiling(s * PW) - 0.08, s * PW), p3(f, u, ceiling(GABLE.at) - 0.08, GABLE.at), 0.12, BOARDS);
  }
  // The back wall from inside, the arched window looking out over the park.
  archWall(b, BACK - 0.4, -1, ceiling, RENDER_IN);
}

/** The steps down into Myers Park: concrete flights between bluestone cheek walls, rails, lamps, an iron arch at the head. */
function parkSteps(b: Builder, far: boolean): void {
  const f = STEPS;
  const hw = PARK.hw;
  b.ground = -Infinity;
  stairs(b, f, PARK_RUNS, -hw, hw, { tread: CONCRETE, riser: CONCRETE_RISER, nosing: NOSING, flat: PAVING }, far);
  const first = PARK_RUNS[0];
  const last = PARK_RUNS[PARK_RUNS.length - 1];
  const lowest = last.y1 - CHEEK.down;
  for (const side of [-1, 1]) {
    const wi = side * hw;
    const wo = side * (hw + PARK.wall);
    for (const r of PARK_RUNS) {
      const ta = walkLine(r, r.u0) + CHEEK.up;
      const tb = walkLine(r, r.u1) + CHEEK.up;
      const bottom = Math.min(r.y0, r.y1) - CHEEK.down;
      // Inner face, outer face, coping on top.
      for (const [w, face] of [[wi, -side], [wo, side]] as const) {
        const pts: V3[] = [p3(f, r.u0, bottom, w), p3(f, r.u1, bottom, w), p3(f, r.u1, tb, w), p3(f, r.u0, ta, w)];
        const len = r.u1 - r.u0;
        b.poly(pts, [[0, 0], [len / 2.4, 0], [len / 2.4, (tb - bottom) / 2.4], [0, (ta - bottom) / 2.4]], BLUESTONE, out3(f, 0, 0, face));
      }
      b.poly([p3(f, r.u0, ta, wi), p3(f, r.u1, tb, wi), p3(f, r.u1, tb, wo), p3(f, r.u0, ta, wo)], [[0, 0], [1, 0], [1, 1], [0, 1]], COPING, [0, 1, 0]);
      if (!far) {
        b.collideHull([
          p3(f, r.u0, ta, wi), p3(f, r.u1, tb, wi), p3(f, r.u0, ta, wo), p3(f, r.u1, tb, wo),
          p3(f, r.u0, bottom, wi), p3(f, r.u1, bottom, wi), p3(f, r.u0, bottom, wo), p3(f, r.u1, bottom, wo),
        ]);
        // A steel rail on posts along the top of the wall.
        const wr = side * (hw + PARK.wall / 2);
        b.bar(p3(f, r.u0, ta + 0.35, wr), p3(f, r.u1, tb + 0.35, wr), 0.05, RAIL);
        for (let u = r.u0 + 0.2; u < r.u1; u += 3) {
          const y = walkLine(r, u) + CHEEK.up;
          b.bar(p3(f, u, y, wr), p3(f, u, y + 0.35, wr), 0.04, RAIL);
        }
      }
    }
    // Ends of the walls at the head and the foot.
    wallU(b, f, first.u0, Math.min(wi, wo), Math.max(wi, wo), first.y0 - CHEEK.down, walkLine(first, first.u0) + CHEEK.up, BLUESTONE, -1);
    wallU(b, f, last.u1, Math.min(wi, wo), Math.max(wi, wo), lowest, walkLine(last, last.u1) + CHEEK.up, BLUESTONE, 1);
  }
  // Under the bottom tread, a face down to the path.
  wallU(b, f, last.u1, -hw, hw, lowest, last.y1, CONCRETE, 1);
  wallU(b, f, first.u0, -hw, hw, first.y0 - 1, first.y0, PAVING, -1);

  // The arch over the head: two posts, a lettered board both ways, a scroll over it.
  const ua = first.u0 + 0.9;
  const top = first.y0 + 3.0;
  for (const side of [-1, 1]) {
    const [x, z] = at(f, ua, side * (hw + PARK.wall / 2));
    b.box(x, z, walkLine(first, ua) + CHEEK.up, top + 0.2, 0.22, 0.22, f.heading, RAIL, RAIL);
    if (!far) b.lathe(x, z, [[0.0, top + 0.2], [0.13, top + 0.28], [0.0, top + 0.45]], 6, RAIL);
  }
  const wb = hw + PARK.wall / 2;
  boxF(b, f, ua - 0.04, ua + 0.04, -wb, wb, top - 0.62, top, FASCIA);
  signF(b, f, { u: ua - 0.04, side: -1 }, 0, top - 0.58, 2.9, 0.36, SIGN2.myersPark, SIGNS2, 0.01);
  signF(b, f, { u: ua + 0.04, side: 1 }, 0, top - 0.58, 2.9, 0.36, SIGN2.myersPark, SIGNS2, 0.01);
  if (!far) {
    const n = 8;
    for (let k = 0; k < n; k++) {
      const wa = -wb + (2 * wb * k) / n;
      const wc = -wb + (2 * wb * (k + 1)) / n;
      const arc = (w: number) => top + 0.55 * Math.cos(((w / wb) * Math.PI) / 2);
      b.bar(p3(f, ua, arc(wa), wa), p3(f, ua, arc(wc), wc), 0.06, RAIL);
    }
    for (const side of [-1, 1]) {
      const [x, z] = at(f, ua, side * wb);
      b.collideBox(x, z, first.y0, top + 0.2, 0.22, 0.22, f.heading);
    }
  }

  // Lamps: either side of the head, down the west side at each landing, either side of the foot (a few pixels from far off).
  if (far) return;
  const lamps: [number, number][] = [[-5.6, -1], [-5.6, 1]];
  for (const r of PARK_RUNS.slice(1)) if (r.n === 0) lamps.push([(r.u0 + r.u1) / 2, -1]);
  lamps.push([last.u1 + 1.2, -1], [last.u1 + 1.2, 1]);
  for (const [u, side] of lamps) {
    const r = PARK_RUNS.find((q) => u >= q.u0 && u <= q.u1);
    const y = r ? r.y0 : last.y1 - 0.15;
    const [x, z] = at(f, u, side * (hw + PARK.wall + 0.45));
    lampPost(b, x, z, r ? y - 0.3 : y);
  }
  collideRuns(b, f, PARK_RUNS, -hw, hw);
}

/** Michelangelo's Moses (a copy): seated on a block, beard to his waist, the tablets under his arm, the horns. */
function moses(b: Builder): void {
  const [mx, mz] = MOSES.at;
  const g = MOSES.ground;
  const f = new Frame(MOSES.at, [Math.cos(MOSES.facing), -Math.sin(MOSES.facing)], [0, 1]);
  const q = (u: number, w: number): V2 => f.at(u, w);
  const box = (u: number, w: number, y0: number, y1: number, along: number, across: number, m: Mat = MARBLE) => {
    const [x, z] = q(u, w);
    b.box(x, z, y0, y1, along, across, f.heading, m);
  };
  // Plinth, two steps of it.
  b.box(mx, mz, g - 0.5, g + 0.25, 2.2, 1.9, f.heading, PLINTH);
  b.box(mx, mz, g + 0.25, g + 1.35, 1.8, 1.5, f.heading, PLINTH);
  b.collideBox(mx, mz, g - 0.5, g + 1.35, 2.2, 1.9, f.heading);
  const s = g + 1.35;
  // The seat, the legs (one drawn back), the robe over the lap.
  box(-0.25, 0, s, s + 0.55, 0.8, 1.0);
  box(0.25, -0.22, s + 0.05, s + 0.5, 0.7, 0.32);
  box(0.42, -0.22, s, s + 0.12, 0.35, 0.3);
  box(0.12, 0.24, s + 0.1, s + 0.48, 0.55, 0.32);
  box(0.2, 0, s + 0.42, s + 0.6, 0.6, 0.85);
  // Torso and shoulders, arms.
  const [tx, tz] = q(-0.18, 0);
  b.lathe(tx, tz, [[0.34, s + 0.55], [0.42, s + 1.0], [0.3, s + 1.32]], 6, MARBLE);
  box(-0.1, -0.42, s + 0.6, s + 1.15, 0.2, 0.18);
  box(-0.1, 0.42, s + 0.6, s + 1.15, 0.2, 0.18);
  box(-0.02, 0.48, s + 0.6, s + 1.1, 0.4, 0.1, PLINTH);
  // Head, the long beard, the horns.
  const [hx, hz] = q(-0.15, 0);
  b.lathe(hx, hz, [[0.0, s + 1.3], [0.17, s + 1.45], [0.12, s + 1.66], [0.0, s + 1.7]], 6, MARBLE);
  box(0.2, 0, s + 0.95, s + 1.4, 0.12, 0.26);
  for (const side of [-1, 1]) {
    const [x0, z0] = q(-0.15, side * 0.08);
    const [x1, z1] = q(-0.1, side * 0.16);
    b.bar([x0, s + 1.62, z0], [x1, s + 1.82, z1], 0.05, MARBLE);
  }
}

/** The arcade's colliders: the passage floors and stairs, the solid blocks either side, its ceilings and the walls over its doors. */
function arcadeColliders(b: Builder): void {
  const f = ARCADE;
  collideRuns(b, f, ARCADE_RUNS, -PW, PW, 3);
  for (const [w0, w1] of [[WEST, -PW], [PW, EAST]]) {
    collideBoxF(b, f, 0, MIDDLE, w0, w1, 55, ROOF);
    collideBoxF(b, f, MIDDLE, BACK, w0, w1, 55, GABLE.eaves);
  }
  // The stair hall's roof (a ceiling too) and the hall's under the lantern.
  const west = WEST - GABLE.overhang;
  const east = EAST + GABLE.overhang;
  const roof: V3[] = [];
  for (const u of [MIDDLE, BACK]) roof.push(p3(f, u, GABLE.eaves, west), p3(f, u, GABLE.eaves, east), p3(f, u, GABLE.ridge, GABLE.at));
  b.collideHull(roof);
  b.collideFlat([at(f, 0, -PW), at(f, MIDDLE, -PW), at(f, MIDDLE, PW), at(f, 0, PW)], ROOF);
  // Over the doors.
  collideBoxF(b, f, 0, LANTERN_START, -PW, PW, FRONT_DOOR, 75.7);
  collideBoxF(b, f, BACK - 0.4, BACK, -PW, PW, DOOR.top, GABLE.eaves);
  collideBoxF(b, f, BACK - 0.4, BACK, -PW, -DOOR.hw, 55, DOOR.top);
  collideBoxF(b, f, BACK - 0.4, BACK, DOOR.hw, PW, 55, DOOR.top);
}

export const stKevins: LandmarkModel = {
  id: 'st-kevins',
  name: "St Kevin's Arcade",
  close: 40,
  near: 260,
  drawDistance: 900,
  height: 17.5,
  build: buildArcade,
};

/** Placed by the arcade's record, but measured from the middle of the steps: from K Road they're well off, behind it. */
export const myersParkSteps: LandmarkModel = {
  id: 'myers-park-steps',
  name: 'Myers Park steps',
  placedBy: 'st-kevins',
  at: STEPS.at(12, 0),
  near: 65,
  drawDistance: 600,
  height: 15,
  build: buildSteps,
};
