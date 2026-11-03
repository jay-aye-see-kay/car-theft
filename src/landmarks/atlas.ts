import type * as THREE from 'three';
import { bakeLayers, grey, rgb, TINT_GREY, type Ctx, type Painter } from '../city/atlas.ts';

// The landmarks' own texture atlas: the Edwardian stonework, clock faces,
// neon letters and the Sky Tower's glazing that the city's generic facade
// layers can't draw. Same scheme as the city atlas (src/city/atlas.ts):
// colour plus a tint mask in alpha (masked areas take the vertex colour),
// except cut-out layers (CUTOUT), whose alpha is coverage. 256 px layers: a
// layer here is one bay of one building (~5 m), so that's as sharp as the
// city's 512 px four-bay layers, at a quarter of the memory.

const R = 256;

/** Layer indices (the order of PAINTERS). */
export const L = {
  concrete: 0, // Sky Tower shaft and legs: smooth concrete with formwork lifts (tinted)
  podGlass: 1, // Sky Tower pod: one tilted pane per repeat round, one band up
  stone: 2, // sandstone ashlar (tinted)
  ferryArcade: 3, // Ferry Building ground floor: one rusticated arch, 4.6 x 5.5 m
  ferryUpper: 4, // Ferry Building upper floors: brick bay with stone dressings, 4.6 x 7 m
  decal: 5, // cut-out: clock face, neon letters, arched window (see DECAL)
  cpoBase: 6, // Chief Post Office ground floor: granite with an arched window, 5 x 5.5 m
  cpoUpper: 7, // CPO upper floors: sandstone bay between columns, 5 x 12 m
  civic: 8, // Civic Theatre: rendered bay with arched windows and frieze, 5 x 8 m
  roofTiles: 9, // flat clay tiles (tinted), 3 m
  slate: 10, // fish-scale slate / copper for domes and spires (tinted), 2 m
  glass: 11, // modern glazing grid, 3 m
  lattice: 12, // cut-out: steel lattice panel, 2 x 2 m
  balustrade: 13, // cut-out: stone balusters and rail, 2 x 1.2 m
  civicGround: 14, // Civic ground floor: entrance doors and poster cases, 6 x 4 m
  signs: 15, // cut-out: lettered signs, one per 64 px row (see SIGN)
  roundel: 16, // cut-out: the Hard Luck Café's round logo
  townHall: 17, // Town Hall upper floors: Oamaru stone bay, two arched windows over a balcony, 5 x 9 m
  shopfront: 18, // St Kevin's Arcade: Edwardian shopfront (tinted timber), leadlight transom, tiled stallriser, 4.9 x 3.9 m
  sashes: 19, // rendered wall (tinted) with a pair of sash windows under leadlight top lights, 4.9 x 3.4 m
  tiles: 20, // floor tiles: a chequer of four by four, the light ones tinted, 1 m
  plaster: 21, // smooth painted render (tinted), 4 m
  signs2: 22, // cut-out: lettered signs, one per 32 px row (see SIGN2)
  signs3: 23, // cut-out: more of them (see SIGN3)
} as const;

/** Layers whose alpha is coverage (cityMaterial's `cutout` bits). */
export const CUTOUT = (1 << L.decal) | (1 << L.lattice) | (1 << L.balustrade) | (1 << L.signs) | (1 << L.roundel) | (1 << L.signs2) | (1 << L.signs3);

/** Rows of the signs layer, as [u0, v0, u1, v1] (v up): each 4:1. */
const signRow = (row: number): [number, number, number, number] => [0, 1 - (row + 1) / 4, 1, 1 - row / 4];
export const SIGN = {
  minimax: signRow(0),
  aotea: signRow(1),
  carPark: signRow(2),
  highWorld: signRow(3),
} as const;

/**
 * The narrow sign layers (signs2, signs3): eight rows of 32 px, each 8:1,
 * for shop fascias and lettering along a parapet. Words and colours are in
 * SIGN_WORDS; a row's cell is [u0, v0, u1, v1] (v up).
 */
const narrowRow = (row: number): [number, number, number, number] => [0, 1 - (row + 1) / 8, 1, 1 - row / 8];
/** [text, fill, outline, font] per row: serif for the old lettering, sans for shops, script-ish italics for the bars. */
const SIGN_WORDS: [string, string, string, string][][] = [
  [
    ["ST KEVIN'S ARCADE", '#f3ead2', '#22392c', 'Georgia, Times New Roman, serif'],
    ['MYERS PARK', '#f1cf6a', '#1d2a22', 'Georgia, Times New Roman, serif'],
    ['RECORDS', '#ffe9c2', '#8f1d1d', 'Arial Black, Arial, sans-serif'],
    ['VINTAGE', '#fdf5e4', '#1f6f6a', 'Georgia, Times New Roman, serif'],
    ['BOOKS & ZINES', '#fff8e8', '#24345e', 'Georgia, Times New Roman, serif'],
    ['TATTOO', '#fbe6e6', '#151515', 'Arial Black, Arial, sans-serif'],
    ['ESPRESSO', '#fff3dc', '#5a3520', 'Georgia, Times New Roman, serif'],
    ['BAR', '#ffd6f4', '#e0279b', 'Arial Black, Arial, sans-serif'],
  ],
  [
    ['BARBER', '#ffffff', '#1e4e9c', 'Georgia, Times New Roman, serif'],
    ['WINE BAR', '#fbe7c6', '#5c1730', 'Georgia, Times New Roman, serif'],
    ['BURGERS', '#ffe680', '#a8321c', 'Arial Black, Arial, sans-serif'],
    ['OP SHOP', '#ffffff', '#4a7a2a', 'Arial Black, Arial, sans-serif'],
    ['COCKTAILS', '#c8fbff', '#0aa6c9', 'Arial Black, Arial, sans-serif'],
    ['VINYL', '#fff4d6', '#3a2a6e', 'Arial Black, Arial, sans-serif'],
    ['PLANTS', '#f2ffe6', '#2f6b2a', 'Georgia, Times New Roman, serif'],
    ['1924', '#f3ead2', '#22392c', 'Georgia, Times New Roman, serif'],
  ],
];
export const SIGN2 = {
  stKevins: narrowRow(0),
  myersPark: narrowRow(1),
  records: narrowRow(2),
  vintage: narrowRow(3),
  books: narrowRow(4),
  tattoo: narrowRow(5),
  espresso: narrowRow(6),
  bar: narrowRow(7),
} as const;
export const SIGN3 = {
  barber: narrowRow(0),
  wineBar: narrowRow(1),
  burgers: narrowRow(2),
  opShop: narrowRow(3),
  cocktails: narrowRow(4),
  vinyl: narrowRow(5),
  plants: narrowRow(6),
  year: narrowRow(7),
} as const;

/**
 * Cells of the decal layer, as [u0, v0, u1, v1] (v up). The layer is a 4 x 4
 * grid of 64 px cells; the clock takes 2 x 2.
 */
const cellUv = (col: number, row: number, w = 1, h = 1): [number, number, number, number] => [col / 4, 1 - (row + h) / 4, (col + w) / 4, 1 - row / 4];
export const DECAL = {
  clock: cellUv(0, 0, 2, 2),
  T: cellUv(2, 0),
  H: cellUv(3, 0),
  E: cellUv(2, 1),
  C: cellUv(3, 1),
  I: cellUv(0, 2),
  V: cellUv(1, 2),
  archWindow: cellUv(2, 2),
  louvre: cellUv(3, 2),
  cartouche: cellUv(0, 3),
  oculus: cellUv(1, 3),
  parking: cellUv(2, 3),
  guitar: cellUv(3, 3),
} as const;

function fill(c: Ctx, m: Ctx, x: number, y: number, w: number, h: number, colour: string, mask: number) {
  c.fillStyle = colour;
  c.fillRect(x, y, w, h);
  m.fillStyle = grey(mask * 255);
  m.fillRect(x, y, w, h);
}

/** Fine grain over a rect (colour only). */
function grain(c: Ctx, rnd: () => number, n: number, alpha: number, x0 = 0, y0 = 0, w = R, h = R, size = 1.5) {
  for (let k = 0; k < n; k++) {
    c.fillStyle = grey(128 + (rnd() - 0.5) * 255, alpha * rnd());
    c.fillRect(x0 + rnd() * w, y0 + rnd() * h, size, size);
  }
}

/** Ashlar coursing: joints every `course` px, blocks `block` px long, each block a touch different. */
function ashlar(c: Ctx, rnd: () => number, x0: number, y0: number, w: number, h: number, course: number, block: number, joint = 0.2) {
  for (let y = y0, row = 0; y < y0 + h; y += course, row++) {
    const off = row % 2 ? block / 2 : 0;
    for (let x = x0 - off; x < x0 + w; x += block) {
      c.fillStyle = `rgba(${rnd() < 0.5 ? '0,0,0' : '255,255,255'},${rnd() * 0.06})`;
      c.fillRect(Math.max(x, x0), y, Math.min(block, x0 + w - x), Math.min(course, y0 + h - y));
      c.fillStyle = `rgba(0,0,0,${joint})`;
      if (x > x0) c.fillRect(x, y, 1.5, Math.min(course, y0 + h - y));
    }
    c.fillStyle = `rgba(0,0,0,${joint})`;
    c.fillRect(x0, y, w, 1.5);
  }
}

/** Glass in a window opening: sky at the top, dark inside, a sheen. */
function pane(c: Ctx, m: Ctx, rnd: () => number, x: number, y: number, w: number, h: number, dark = 0) {
  const k = 0.9 + rnd() * 0.2 - dark;
  const g = c.createLinearGradient(x, y, x + w * 0.4, y + h);
  g.addColorStop(0, rgb(140 * k, 165 * k, 185 * k));
  g.addColorStop(0.5, rgb(70 * k, 90 * k, 108 * k));
  g.addColorStop(1, rgb(34 * k, 44 * k, 56 * k));
  c.fillStyle = g;
  c.fillRect(x, y, w, h);
  c.fillStyle = `rgba(255,255,255,${0.05 + rnd() * 0.08})`;
  c.beginPath();
  c.moveTo(x + w * 0.25, y);
  c.lineTo(x + w * 0.6, y);
  c.lineTo(x + w * 0.2, y + h);
  c.lineTo(x, y + h);
  c.closePath();
  c.fill();
  m.fillStyle = grey(0);
  m.fillRect(x, y, w, h);
}

/** Sash bars over a window. */
function sashes(c: Ctx, x: number, y: number, w: number, h: number, cols: number, rows: number, colour = '#ece6da', lw = 2.5) {
  c.strokeStyle = colour;
  c.lineWidth = lw;
  c.beginPath();
  for (let i = 1; i < cols; i++) {
    c.moveTo(x + (w * i) / cols, y);
    c.lineTo(x + (w * i) / cols, y + h);
  }
  for (let j = 1; j < rows; j++) {
    c.moveTo(x, y + (h * j) / rows);
    c.lineTo(x + w, y + (h * j) / rows);
  }
  c.stroke();
  c.lineWidth = lw * 1.6;
  c.strokeRect(x + lw * 0.8, y + lw * 0.8, w - lw * 1.6, h - lw * 1.6);
}

/** A round-headed opening path: sides from `bottom` up to the spring line, semicircle over. */
function archPath(c: Ctx, x: number, w: number, spring: number, bottom: number) {
  const r = w / 2;
  c.beginPath();
  c.moveTo(x, bottom);
  c.lineTo(x, spring);
  c.arc(x + r, spring, r, Math.PI, 0);
  c.lineTo(x + w, bottom);
  c.closePath();
}

/** Voussoirs round an arch: lighter wedge stones, radial joints, a keystone. */
function voussoirs(c: Ctx, m: Ctx, cx: number, spring: number, r: number, depth: number, colour: string, mask: number, n = 11) {
  c.fillStyle = colour;
  c.beginPath();
  c.arc(cx, spring, r + depth, Math.PI, 0);
  c.arc(cx, spring, r, 0, Math.PI, true);
  c.closePath();
  c.fill();
  m.fillStyle = grey(mask * 255);
  m.fill();
  c.strokeStyle = 'rgba(0,0,0,0.3)';
  c.lineWidth = 1.5;
  for (let k = 1; k < n; k++) {
    const a = Math.PI + (k / n) * Math.PI;
    c.beginPath();
    c.moveTo(cx + Math.cos(a) * r, spring + Math.sin(a) * r);
    c.lineTo(cx + Math.cos(a) * (r + depth), spring + Math.sin(a) * (r + depth));
    c.stroke();
  }
  // Keystone, proud of the arch.
  const kw = depth * 0.9;
  c.fillStyle = colour;
  c.fillRect(cx - kw / 2, spring - r - depth - 3, kw, depth + 6);
  m.fillRect(cx - kw / 2, spring - r - depth - 3, kw, depth + 6);
  c.fillStyle = 'rgba(0,0,0,0.25)';
  c.fillRect(cx + kw / 2, spring - r - depth - 3, 2, depth + 6);
}

/** Soft shadow under a projecting band (a cornice or sill). */
function shadowBelow(c: Ctx, x: number, y: number, w: number, h: number, a = 0.35) {
  const g = c.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, `rgba(0,0,0,${a})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g;
  c.fillRect(x, y, w, h);
}

/** A raised band: light top edge, shadow under. */
function band(c: Ctx, m: Ctx, y: number, h: number, colour: string, mask: number, x = 0, w = R) {
  fill(c, m, x, y, w, h, colour, mask);
  c.fillStyle = 'rgba(255,255,255,0.18)';
  c.fillRect(x, y, w, 1.5);
  shadowBelow(c, x, y + h, w, 6, 0.3);
}

const PAINTERS: Painter[] = [
  // concrete
  (c, m, rnd) => {
    fill(c, m, 0, 0, R, R, grey(TINT_GREY), 1);
    grain(c, rnd, 5000, 0.12);
    // Slip-formed: faint lifts every metre (32 px at 8 m), and a few stains.
    for (let y = 0; y < R; y += 32) {
      c.fillStyle = 'rgba(0,0,0,0.05)';
      c.fillRect(0, y, R, 1);
    }
    for (let k = 0; k < 18; k++) {
      const x = rnd() * R;
      const g = c.createLinearGradient(0, 0, 0, R);
      g.addColorStop(0, `rgba(0,0,0,${0.03 + rnd() * 0.04})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(x, rnd() * R * 0.5, 3 + rnd() * 6, R);
    }
  },
  // podGlass: one pane per repeat round, the band's full height up
  (c, m, rnd) => {
    fill(c, m, 0, 0, R, R, '#c4c8cb', 0);
    const g = c.createLinearGradient(0, 0, 0, R);
    g.addColorStop(0, '#a9c0d2');
    g.addColorStop(0.35, '#5f7c92');
    g.addColorStop(0.7, '#2d4252');
    g.addColorStop(1, '#22323e');
    c.fillStyle = g;
    c.fillRect(10, 6, R - 20, R - 12);
    // People and lights inside, low down.
    for (let k = 0; k < 24; k++) {
      c.fillStyle = `rgba(255,${200 + rnd() * 50},${150 + rnd() * 60},${0.15 + rnd() * 0.25})`;
      c.fillRect(14 + rnd() * (R - 40), R * 0.62 + rnd() * R * 0.28, 3 + rnd() * 8, 4 + rnd() * 14);
    }
    c.fillStyle = 'rgba(255,255,255,0.10)';
    c.beginPath();
    c.moveTo(60, 6);
    c.lineTo(120, 6);
    c.lineTo(40, R - 6);
    c.lineTo(10, R - 6);
    c.closePath();
    c.fill();
    // A transom and the mullions either side.
    c.fillStyle = '#b8bec2';
    c.fillRect(10, R * 0.55, R - 20, 4);
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.fillRect(10, 6, 3, R - 12);
  },
  // stone: sandstone ashlar, 0.5 m courses at 4 m a repeat
  (c, m, rnd) => {
    fill(c, m, 0, 0, R, R, grey(TINT_GREY), 1);
    grain(c, rnd, 6000, 0.14);
    ashlar(c, rnd, 0, 0, R, R, 32, 80, 0.16);
  },
  // ferryArcade: one round arch in rusticated sandstone, shopfront inside
  (c, m, rnd) => {
    fill(c, m, 0, 0, R, R, grey(TINT_GREY), 1);
    grain(c, rnd, 4000, 0.14);
    // Rusticated piers: deep horizontal channels.
    for (let y = 18; y < R; y += 26) {
      c.fillStyle = 'rgba(0,0,0,0.28)';
      c.fillRect(0, y, R, 3);
      c.fillStyle = 'rgba(255,255,255,0.12)';
      c.fillRect(0, y + 3, R, 1.5);
    }
    const x = 52;
    const w = R - 104;
    const spring = 112;
    voussoirs(c, m, R / 2, spring, w / 2, 20, grey(234), 1, 13);
    archPath(c, x, w, spring, R);
    c.fillStyle = '#1b1f23';
    c.fill();
    m.fillStyle = grey(0);
    m.fill();
    // Shopfront in the arch: fanlight and two glazed bays with a door.
    c.save();
    m.save();
    for (const ctx of [c, m]) {
      archPath(ctx, x + 8, w - 16, spring, R - 14);
      ctx.clip();
    }
    pane(c, m, rnd, x + 8, spring - w / 2, w - 16, R, 0.15);
    c.strokeStyle = '#3c2f27';
    c.lineWidth = 4;
    c.beginPath();
    c.moveTo(x, spring + 6);
    c.lineTo(x + w, spring + 6);
    c.moveTo(R / 2, spring + 6);
    c.lineTo(R / 2, R);
    for (let k = 1; k < 5; k++) {
      const a = Math.PI + (k / 5) * Math.PI;
      c.moveTo(R / 2, spring + 6);
      c.lineTo(R / 2 + Math.cos(a) * w, spring + 6 + Math.sin(a) * w);
    }
    c.stroke();
    // Warm light from the café inside.
    c.fillStyle = 'rgba(255,214,150,0.18)';
    c.fillRect(x, spring + 40, w, R);
    c.restore();
    m.restore();
    // Stallriser and plinth.
    fill(c, m, 0, R - 14, R, 14, grey(200), 1);
    c.fillStyle = 'rgba(255,255,255,0.15)';
    c.fillRect(0, R - 14, R, 2);
  },
  // ferryUpper: red brick, two floors, stone dressings (tinted)
  (c, m, rnd) => {
    fill(c, m, 0, 0, R, R, '#8f4532', 0);
    for (let y = 0; y < R; y += 3) {
      const off = (y / 3) % 2 ? 4 : 0;
      for (let x = -off; x < R; x += 8) {
        c.fillStyle = rgb(130 + rnd() * 40, 58 + rnd() * 22, 42 + rnd() * 16, 0.9);
        c.fillRect(x, y, 7.2, 2.4);
      }
    }
    c.fillStyle = 'rgba(205,190,170,0.12)';
    for (let y = 2.4; y < R; y += 3) c.fillRect(0, y, R, 0.6);
    // Quoins at the bay edges (pilasters between bays).
    for (let y = 0, k = 0; y < R; y += 16, k++) {
      const w = k % 2 ? 14 : 22;
      fill(c, m, 0, y, w, 15, grey(TINT_GREY), 1);
      fill(c, m, R - w, y, w, 15, grey(TINT_GREY), 1);
      c.fillStyle = 'rgba(0,0,0,0.25)';
      c.fillRect(0, y + 15, w, 1);
      c.fillRect(R - w, y + 15, w, 1);
    }
    // String course at each floor line, cornice band at the top.
    band(c, m, 0, 8, grey(TINT_GREY), 1);
    band(c, m, 124, 10, grey(TINT_GREY), 1);
    // Upper floor: window with a stone surround and a little cornice.
    const wx = 78;
    const ww = R - 156;
    fill(c, m, wx - 9, 26, ww + 18, 88, grey(TINT_GREY), 1);
    band(c, m, 20, 8, grey(236), 1, wx - 14, ww + 28);
    pane(c, m, rnd, wx, 32, ww, 74);
    sashes(c, wx, 32, ww, 74, 2, 2);
    fill(c, m, wx - 12, 108, ww + 24, 6, grey(236), 1);
    shadowBelow(c, wx - 12, 114, ww + 24, 5);
    // Lower floor: taller window with a segmental arch head and keystone.
    fill(c, m, wx - 10, 146, ww + 20, 100, grey(TINT_GREY), 1);
    c.save();
    m.save();
    for (const ctx of [c, m]) {
      ctx.beginPath();
      ctx.moveTo(wx, 244);
      ctx.lineTo(wx, 166);
      ctx.quadraticCurveTo(wx + ww / 2, 146, wx + ww, 166);
      ctx.lineTo(wx + ww, 244);
      ctx.closePath();
      ctx.clip();
    }
    pane(c, m, rnd, wx, 146, ww, 100);
    sashes(c, wx, 150, ww, 94, 2, 3);
    c.restore();
    m.restore();
    fill(c, m, R / 2 - 7, 140, 14, 18, grey(240), 1);
    fill(c, m, wx - 12, 244, ww + 24, 7, grey(236), 1);
    shadowBelow(c, wx - 12, 251, ww + 24, 5);
  },
  // decal: clock, neon letters, arched window, louvres, cartouche, oculus
  (c, m) => {
    c.clearRect(0, 0, R, R);
    m.fillStyle = '#000';
    m.fillRect(0, 0, R, R);
    // Clock face (128 px cell): stone ring, cream dial, black hands and ticks.
    const cx = 64;
    const cy = 64;
    const disc = (r: number, colour: string) => {
      c.fillStyle = colour;
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.fill();
    };
    disc(62, '#d9c9a8');
    m.fillStyle = '#fff';
    m.beginPath();
    m.arc(cx, cy, 62, 0, Math.PI * 2);
    m.fill();
    disc(55, '#2a2622');
    disc(51, '#f3eee0');
    c.strokeStyle = '#1d1a17';
    for (let k = 0; k < 60; k++) {
      const a = (k / 60) * Math.PI * 2;
      const big = k % 5 === 0;
      c.lineWidth = big ? 4 : 1.2;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * (big ? 38 : 45), cy + Math.sin(a) * (big ? 38 : 45));
      c.lineTo(cx + Math.cos(a) * 49, cy + Math.sin(a) * 49);
      c.stroke();
    }
    const hand = (a: number, len: number, w: number) => {
      c.lineWidth = w;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(cx, cy);
      c.lineTo(cx + Math.sin(a) * len, cy - Math.cos(a) * len);
      c.stroke();
    };
    // Ten past ten.
    hand((10 / 12) * Math.PI * 2 + (10 / 60) * (Math.PI / 6), 26, 5);
    hand((10 / 60) * Math.PI * 2, 40, 3.5);
    disc(4, '#1d1a17');
    // Neon letters (64 px cells): red channel letters with a hot tube down the middle.
    const glyph = (ch: string, col: number, row: number) => {
      const x = col * 64 + 32;
      const y = row * 64 + 34;
      for (const [ctx, colour, w] of [[c, '#8a1414', 13], [c, '#ff3b2a', 7], [c, '#ffd9c8', 2.5], [m, '#fff', 13]] as const) {
        ctx.save();
        ctx.font = 'bold 54px Arial, Helvetica, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = colour;
        ctx.lineWidth = w;
        ctx.strokeText(ch, x, y);
        if (ctx === m) ctx.fillStyle = '#fff', ctx.fillText(ch, x, y);
        ctx.restore();
      }
    };
    glyph('T', 2, 0);
    glyph('H', 3, 0);
    glyph('E', 2, 1);
    glyph('C', 3, 1);
    glyph('I', 0, 2);
    glyph('V', 1, 2);
    // Arched window (stone surround, glazing bars) on a transparent ground.
    {
      const x0 = 128 + 12;
      const w = 40;
      archPath(c, x0 - 6, w + 12, 128 + 26, 128 + 62);
      c.fillStyle = '#d8cbb0';
      c.fill();
      archPath(m, x0 - 6, w + 12, 128 + 26, 128 + 62);
      m.fillStyle = '#fff';
      m.fill();
      archPath(c, x0, w, 128 + 26, 128 + 58);
      c.fillStyle = '#2b3440';
      c.fill();
      c.strokeStyle = '#e8e2d6';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(x0 + w / 2, 128 + 6);
      c.lineTo(x0 + w / 2, 128 + 58);
      c.moveTo(x0, 128 + 30);
      c.lineTo(x0 + w, 128 + 30);
      c.moveTo(x0, 128 + 44);
      c.lineTo(x0 + w, 128 + 44);
      c.stroke();
    }
    // Louvred opening (belfry, tower vents).
    {
      const x0 = 192 + 12;
      const w = 40;
      archPath(c, x0 - 6, w + 12, 128 + 26, 128 + 62);
      c.fillStyle = '#d8cbb0';
      c.fill();
      archPath(m, x0 - 6, w + 12, 128 + 26, 128 + 62);
      m.fillStyle = '#fff';
      m.fill();
      archPath(c, x0, w, 128 + 26, 128 + 58);
      c.fillStyle = '#1d1f22';
      c.fill();
      for (let y = 128 + 14; y < 128 + 58; y += 5) {
        c.fillStyle = '#5a5650';
        c.fillRect(x0 + 2, y, w - 4, 2.5);
      }
    }
    // Cartouche: a carved oval wreath for pediments.
    {
      const x = 32;
      const y = 192 + 32;
      c.fillStyle = '#d6c6a4';
      c.beginPath();
      c.ellipse(x, y, 26, 30, 0, 0, Math.PI * 2);
      c.fill();
      m.fillStyle = '#fff';
      m.beginPath();
      m.ellipse(x, y, 26, 30, 0, 0, Math.PI * 2);
      m.fill();
      c.strokeStyle = 'rgba(70,55,35,0.6)';
      c.lineWidth = 3;
      c.beginPath();
      c.ellipse(x, y, 18, 22, 0, 0, Math.PI * 2);
      c.stroke();
      c.lineWidth = 1.5;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        c.beginPath();
        c.ellipse(x + Math.cos(a) * 22, y + Math.sin(a) * 26, 3, 5, a, 0, Math.PI * 2);
        c.stroke();
      }
    }
    // Oculus: round window in a stone ring.
    {
      const x = 96;
      const y = 192 + 32;
      c.fillStyle = '#d8cbb0';
      c.beginPath();
      c.arc(x, y, 28, 0, Math.PI * 2);
      c.fill();
      m.fillStyle = '#fff';
      m.beginPath();
      m.arc(x, y, 28, 0, Math.PI * 2);
      m.fill();
      c.fillStyle = '#2b3440';
      c.beginPath();
      c.arc(x, y, 19, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = '#e8e2d6';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(x - 19, y);
      c.lineTo(x + 19, y);
      c.moveTo(x, y - 19);
      c.lineTo(x, y + 19);
      c.stroke();
    }
    // Parking sign: a white P on a blue square with a white border.
    {
      const x0 = 128;
      const y0 = 192;
      for (const [ctx, colour] of [[c, '#ffffff'], [m, '#ffffff']] as const) {
        ctx.fillStyle = colour;
        ctx.fillRect(x0 + 2, y0 + 2, 60, 60);
      }
      c.fillStyle = '#1d4fa3';
      c.fillRect(x0 + 6, y0 + 6, 52, 52);
      c.fillStyle = '#ffffff';
      c.font = 'bold 50px Arial, Helvetica, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('P', x0 + 32, y0 + 35);
    }
    // An electric guitar, body down, for the café's wall.
    {
      const x0 = 192 + 32;
      const y0 = 192;
      const guitar = (ctx: Ctx, body: string, neck: string) => {
        ctx.fillStyle = neck;
        ctx.fillRect(x0 - 3, y0 + 4, 6, 34);
        ctx.fillRect(x0 - 5, y0 + 2, 10, 7);
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.ellipse(x0 - 6, y0 + 46, 12, 13, -0.3, 0, Math.PI * 2);
        ctx.ellipse(x0 + 5, y0 + 50, 13, 11, 0.2, 0, Math.PI * 2);
        ctx.fill();
      };
      guitar(m, '#ffffff', '#ffffff');
      guitar(c, '#c0281e', '#4a2f1d');
      c.fillStyle = '#f2f2f2';
      c.fillRect(x0 - 8, y0 + 44, 16, 3);
      c.fillRect(x0 - 8, y0 + 50, 16, 3);
      c.fillStyle = '#e8e2d6';
      c.fillRect(x0 - 0.5, y0 + 6, 1, 42);
    }
  },
  // cpoBase: Coromandel granite, rusticated, round-arched window
  (c, m, rnd) => {
    fill(c, m, 0, 0, R, R, '#8d8984', 0);
    for (let k = 0; k < 9000; k++) {
      const v = rnd();
      c.fillStyle = v < 0.3 ? 'rgba(40,36,36,0.5)' : v < 0.55 ? 'rgba(190,150,140,0.45)' : 'rgba(225,222,215,0.35)';
      c.fillRect(rnd() * R, rnd() * R, 1.5, 1.5);
    }
    // Deep channelled joints.
    for (let y = 0, row = 0; y < R; y += 30, row++) {
      c.fillStyle = 'rgba(0,0,0,0.4)';
      c.fillRect(0, y, R, 4);
      c.fillStyle = 'rgba(255,255,255,0.12)';
      c.fillRect(0, y + 4, R, 1.5);
      const off = row % 2 ? 0 : 60;
      for (let x = off; x < R; x += 120) {
        c.fillStyle = 'rgba(0,0,0,0.3)';
        c.fillRect(x, y, 2, 30);
      }
    }
    const x = 70;
    const w = R - 140;
    const spring = 108;
    voussoirs(c, m, R / 2, spring, w / 2, 22, '#9b9792', 0, 9);
    c.save();
    m.save();
    for (const ctx of [c, m]) {
      archPath(ctx, x, w, spring, 222);
      ctx.clip();
    }
    pane(c, m, rnd, x, spring - w / 2, w, 222 - spring + w / 2, 0.1);
    c.restore();
    m.restore();
    sashes(c, x, spring, w, 222 - spring, 2, 3, '#e6e1d6', 2.5);
    c.strokeStyle = '#e6e1d6';
    c.lineWidth = 2.5;
    c.beginPath();
    for (let k = 1; k < 4; k++) {
      const a = Math.PI + (k / 4) * Math.PI;
      c.moveTo(R / 2, spring);
      c.lineTo(R / 2 + Math.cos(a) * (w / 2), spring + Math.sin(a) * (w / 2));
    }
    c.stroke();
    // Sill and a plain plinth.
    fill(c, m, x - 12, 222, w + 24, 8, '#a5a19b', 0);
    shadowBelow(c, x - 12, 230, w + 24, 5);
    fill(c, m, 0, R - 18, R, 18, '#7a7671', 0);
  },
  // cpoUpper: sandstone bay between engaged columns, two tall floors
  (c, m, rnd) => {
    fill(c, m, 0, 0, R, R, grey(TINT_GREY), 1);
    grain(c, rnd, 5000, 0.12);
    // Banded rustication on the wall behind the columns.
    for (let y = 10; y < R; y += 21) {
      c.fillStyle = 'rgba(0,0,0,0.12)';
      c.fillRect(0, y, R, 1.5);
    }
    // Columns at the bay edges: rounded shading, flutes, capitals and bases.
    for (const x0 of [-20, R - 20]) {
      const g = c.createLinearGradient(x0, 0, x0 + 40, 0);
      g.addColorStop(0, 'rgba(0,0,0,0.25)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.12)');
      g.addColorStop(0.7, 'rgba(0,0,0,0.05)');
      g.addColorStop(1, 'rgba(0,0,0,0.3)');
      fill(c, m, x0, 0, 40, R, grey(232), 1);
      c.fillStyle = g;
      c.fillRect(x0, 0, 40, R);
      c.fillStyle = 'rgba(0,0,0,0.12)';
      for (let f = 4; f < 40; f += 6) c.fillRect(x0 + f, 22, 1.5, R - 36);
      // Ionic capital: a wide abacus and two scrolls.
      fill(c, m, x0 - 6, 0, 52, 8, grey(240), 1);
      c.strokeStyle = 'rgba(60,50,35,0.6)';
      c.lineWidth = 2;
      for (const sx of [x0 + 2, x0 + 38]) {
        c.beginPath();
        c.arc(sx, 14, 5, 0, Math.PI * 2);
        c.stroke();
      }
      shadowBelow(c, x0 - 6, 8, 52, 6, 0.3);
      fill(c, m, x0 - 4, R - 12, 48, 12, grey(236), 1);
    }
    // Lower floor: window with a segmental pediment.
    const wx = 84;
    const ww = R - 168;
    fill(c, m, wx - 8, 152, ww + 16, 92, grey(236), 1);
    pane(c, m, rnd, wx, 158, ww, 80);
    sashes(c, wx, 158, ww, 80, 2, 3);
    c.fillStyle = grey(240);
    c.beginPath();
    c.moveTo(wx - 16, 150);
    c.quadraticCurveTo(R / 2, 118, wx + ww + 16, 150);
    c.closePath();
    c.fill();
    m.fillStyle = '#fff';
    m.fill();
    shadowBelow(c, wx - 16, 150, ww + 32, 6, 0.35);
    fill(c, m, wx - 12, 244, ww + 24, 6, grey(240), 1);
    // Apron panel with a garland between the floors.
    c.strokeStyle = 'rgba(60,50,35,0.4)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(wx, 112);
    c.quadraticCurveTo(R / 2, 132, wx + ww, 112);
    c.stroke();
    c.strokeRect(wx - 4, 104, ww + 8, 30);
    // Upper floor: window with a plain surround and cornice.
    fill(c, m, wx - 8, 18, ww + 16, 80, grey(236), 1);
    pane(c, m, rnd, wx, 24, ww, 68);
    sashes(c, wx, 24, ww, 68, 2, 2);
    band(c, m, 12, 6, grey(242), 1, wx - 14, ww + 28);
    fill(c, m, wx - 12, 96, ww + 24, 5, grey(240), 1);
  },
  // civic: cream render, pilasters, paired arched windows, Moorish frieze
  (c, m, rnd) => {
    fill(c, m, 0, 0, R, R, grey(TINT_GREY), 1);
    grain(c, rnd, 4500, 0.1);
    // Pilasters with stepped caps.
    for (const x0 of [0, R - 18]) {
      fill(c, m, x0, 0, 18, R, grey(236), 1);
      c.fillStyle = 'rgba(0,0,0,0.18)';
      c.fillRect(x0 === 0 ? 17 : x0, 0, 1.5, R);
      for (let k = 0; k < 3; k++) fill(c, m, x0 - 2 + k * 0, 18 + k * 6, 22 - k * 4, 4, grey(244 - k * 8), 1);
    }
    // Frieze: a row of little pointed arches with rosettes.
    fill(c, m, 18, 30, R - 36, 30, grey(214), 1);
    for (let x = 22; x < R - 30; x += 18) {
      c.strokeStyle = 'rgba(80,60,40,0.45)';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(x, 58);
      c.lineTo(x, 44);
      c.quadraticCurveTo(x + 8, 32, x + 8, 32);
      c.quadraticCurveTo(x + 8, 32, x + 16, 44);
      c.lineTo(x + 16, 58);
      c.stroke();
      c.fillStyle = 'rgba(150,70,50,0.45)';
      c.beginPath();
      c.arc(x + 8, 50, 3, 0, Math.PI * 2);
      c.fill();
    }
    shadowBelow(c, 18, 60, R - 36, 6, 0.25);
    // Paired tall windows with ogee heads and diamond leading.
    for (const x0 of [68, 140]) {
      const w = 48;
      const ogee = (ctx: Ctx) => {
        ctx.beginPath();
        ctx.moveTo(x0, 230);
        ctx.lineTo(x0, 100);
        ctx.bezierCurveTo(x0, 84, x0 + w / 2, 88, x0 + w / 2, 72);
        ctx.bezierCurveTo(x0 + w / 2, 88, x0 + w, 84, x0 + w, 100);
        ctx.lineTo(x0 + w, 230);
        ctx.closePath();
      };
      ogee(c);
      c.lineWidth = 10;
      c.strokeStyle = grey(240);
      c.stroke();
      c.save();
      m.save();
      for (const ctx of [c, m]) {
        ogee(ctx);
        ctx.clip();
      }
      pane(c, m, rnd, x0, 72, w, 160, 0.2);
      c.strokeStyle = 'rgba(40,40,40,0.55)';
      c.lineWidth = 1.2;
      c.beginPath();
      for (let d = -200; d < 260; d += 12) {
        c.moveTo(x0 + d, 72);
        c.lineTo(x0 + d + 160, 232);
        c.moveTo(x0 + d, 232);
        c.lineTo(x0 + d + 160, 72);
      }
      c.stroke();
      c.restore();
      m.restore();
    }
    // Sill band and a spandrel panel.
    band(c, m, 232, 8, grey(240), 1, 18, R - 36);
    c.strokeStyle = 'rgba(80,60,40,0.3)';
    c.lineWidth = 2;
    c.strokeRect(40, 244, R - 80, 10);
  },
  // roofTiles: flat clay tiles in courses (tinted)
  (c, m, rnd) => {
    fill(c, m, 0, 0, R, R, grey(TINT_GREY), 1);
    for (let y = 0, row = 0; y < R; y += 16, row++) {
      const off = row % 2 ? 10 : 0;
      for (let x = -off; x < R; x += 20) {
        c.fillStyle = grey(TINT_GREY - 20 + rnd() * 40);
        c.fillRect(x + 1, y + 1, 18, 14);
      }
      shadowBelow(c, 0, y + 12, R, 4, 0.3);
    }
  },
  // slate: fish-scale shingles (tinted, for domes, spires and copper)
  (c, m, rnd) => {
    fill(c, m, 0, 0, R, R, grey(TINT_GREY - 10), 1);
    for (let y = 0, row = 0; y < R + 16; y += 14, row++) {
      const off = row % 2 ? 8 : 0;
      for (let x = -off; x < R + 16; x += 16) {
        c.fillStyle = grey(TINT_GREY - 30 + rnd() * 50);
        c.beginPath();
        c.moveTo(x, y);
        c.lineTo(x + 16, y);
        c.lineTo(x + 16, y + 8);
        c.arc(x + 8, y + 8, 8, 0, Math.PI);
        c.closePath();
        c.fill();
        c.strokeStyle = 'rgba(0,0,0,0.3)';
        c.lineWidth = 1;
        c.beginPath();
        c.arc(x + 8, y + 8, 8, 0, Math.PI);
        c.stroke();
      }
    }
  },
  // glass: modern glazing, 2 x 2 panes on slim mullions
  (c, m, rnd) => {
    fill(c, m, 0, 0, R, R, '#cfd3d6', 0);
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        pane(c, m, rnd, i * 128 + 4, j * 128 + 4, 120, 120, -0.05);
        m.fillStyle = grey(70);
        m.fillRect(i * 128 + 4, j * 128 + 4, 120, 120);
      }
    }
  },
  // lattice: steel frame with cross bracing, cut out
  (c, m) => {
    c.clearRect(0, 0, R, R);
    m.fillStyle = '#000';
    m.fillRect(0, 0, R, R);
    for (const ctx of [c, m]) {
      ctx.strokeStyle = ctx === c ? '#46494c' : '#fff';
      ctx.lineCap = 'square';
      ctx.lineWidth = 18;
      ctx.strokeRect(0, 0, R, R);
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(R, R);
      ctx.moveTo(R, 0);
      ctx.lineTo(0, R);
      ctx.stroke();
    }
    c.strokeStyle = 'rgba(255,255,255,0.18)';
    c.lineWidth = 2;
    c.strokeRect(5, 5, R - 10, R - 10);
  },
  // balustrade: rail, plinth and six vase balusters per 2 m, cut out
  (c, m) => {
    c.clearRect(0, 0, R, R);
    m.fillStyle = '#000';
    m.fillRect(0, 0, R, R);
    const stone = '#ddd0b2';
    const solid = (x: number, y: number, w: number, h: number) => {
      c.fillStyle = stone;
      c.fillRect(x, y, w, h);
      m.fillStyle = '#fff';
      m.fillRect(x, y, w, h);
    };
    solid(0, 0, R, 40);
    c.fillStyle = 'rgba(255,255,255,0.2)';
    c.fillRect(0, 0, R, 4);
    shadowBelow(c, 0, 32, R, 8, 0.3);
    solid(0, R - 40, R, 40);
    for (let k = 0; k < 6; k++) {
      const cx = (k + 0.5) * (R / 6);
      for (const ctx of [c, m]) {
        ctx.fillStyle = ctx === c ? stone : '#fff';
        ctx.beginPath();
        ctx.moveTo(cx - 9, 40);
        ctx.lineTo(cx + 9, 40);
        ctx.quadraticCurveTo(cx + 6, 90, cx + 17, 150);
        ctx.quadraticCurveTo(cx + 20, 190, cx + 12, R - 40);
        ctx.lineTo(cx - 12, R - 40);
        ctx.quadraticCurveTo(cx - 20, 190, cx - 17, 150);
        ctx.quadraticCurveTo(cx - 6, 90, cx - 9, 40);
        ctx.fill();
      }
      const g = c.createLinearGradient(cx - 18, 0, cx + 18, 0);
      g.addColorStop(0, 'rgba(0,0,0,0.3)');
      g.addColorStop(0.4, 'rgba(255,255,255,0.1)');
      g.addColorStop(1, 'rgba(0,0,0,0.35)');
      c.fillStyle = g;
      c.globalCompositeOperation = 'source-atop';
      c.fillRect(cx - 20, 40, 40, R - 80);
      c.globalCompositeOperation = 'source-over';
    }
  },
  // civicGround: theatre entrance under the verandah: doors, poster cases
  (c, m, rnd) => {
    fill(c, m, 0, 0, R, R, '#d8cdb8', 0);
    grain(c, rnd, 2000, 0.1);
    // Terrazzo stallriser.
    fill(c, m, 0, R - 26, R, 26, '#6b4a3e', 0);
    // Two glazed doors in bronze frames, a poster case either side.
    for (const [x, w] of [[86, 40], [130, 40]]) {
      fill(c, m, x - 4, 60, w + 8, R - 60, '#5a4630', 0);
      pane(c, m, rnd, x, 66, w, R - 70, 0.1);
      c.fillStyle = 'rgba(255,215,150,0.22)';
      c.fillRect(x, 120, w, R - 124);
      c.fillStyle = '#c8a46a';
      c.fillRect(x + w - 8, 150, 3, 30);
    }
    const posters = [[150, 30, 40], [30, 60, 120], [200, 140, 40], [90, 30, 110]];
    for (const [k, x] of [[0, 12], [1, 46], [2, 186], [3, 220]] as const) {
      fill(c, m, x - 3, 70, 30, 120, '#3b2e22', 0);
      const [r, g, b] = posters[k];
      const grad = c.createLinearGradient(0, 74, 0, 186);
      grad.addColorStop(0, rgb(r, g, b));
      grad.addColorStop(1, rgb(r * 0.4, g * 0.4, b * 0.4));
      c.fillStyle = grad;
      c.fillRect(x, 74, 24, 112);
      c.fillStyle = 'rgba(255,255,240,0.8)';
      c.fillRect(x + 3, 80, 18, 5);
      c.fillRect(x + 5, 170, 14, 3);
    }
    // Transom with a lit sign panel (blank).
    fill(c, m, 0, 20, R, 34, '#2c2a28', 0);
    c.fillStyle = 'rgba(255,236,190,0.85)';
    for (let x = 20; x < R - 20; x += 14) c.fillRect(x, 30, 8, 14);
  },
  // signs: one lettered sign per 64 px row, cut out round the letters
  (c, m) => {
    c.clearRect(0, 0, R, R);
    m.fillStyle = '#000';
    m.fillRect(0, 0, R, R);
    /** Words centred in a row, squeezed to fit, outlined so they read against anything. */
    const word = (row: number, text: string, fillColour: string, edge: string, px: number, font = 'Arial Black, Arial, Helvetica, sans-serif') => {
      const y = row * 64 + 34;
      for (const ctx of [c, m]) {
        ctx.save();
        ctx.font = `900 ${px}px ${font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        const w = ctx.measureText(text).width;
        const squeeze = Math.min(1, (R - 12) / w);
        ctx.translate(R / 2, y);
        ctx.scale(squeeze, 1);
        ctx.lineWidth = 7;
        ctx.strokeStyle = ctx === m ? '#fff' : edge;
        ctx.strokeText(text, 0, 0);
        ctx.fillStyle = ctx === m ? '#fff' : fillColour;
        ctx.fillText(text, 0, 0);
        ctx.restore();
      }
    };
    word(0, 'MINIMAX', '#eaf4ff', '#1b5fd1', 52);
    word(1, 'AOTEA CENTRE', '#ffffff', '#3a3a3a', 34);
    word(2, 'CIVIC CAR PARK', '#ffffff', '#1d4fa3', 32);
    word(3, 'HIGH WORLD', '#ffd23a', '#7a1fa8', 44);
  },
  // roundel: the Hard Luck Café's round logo (a parody), cut out
  (c, m) => {
    c.clearRect(0, 0, R, R);
    m.fillStyle = '#000';
    m.fillRect(0, 0, R, R);
    const cx = R / 2;
    const cy = R / 2;
    m.fillStyle = '#fff';
    m.beginPath();
    m.arc(cx, cy, 124, 0, Math.PI * 2);
    m.fill();
    m.fillRect(0, cy - 30, R, 60);
    const disc = (r: number, colour: string) => {
      c.fillStyle = colour;
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.fill();
    };
    disc(124, '#f2c230');
    disc(116, '#c8202a');
    disc(100, '#f6e7c1');
    // Lettering round the top and bottom of the ring.
    const arc = (text: string, start: number, bottom: boolean) => {
      c.save();
      c.font = '900 26px Arial Black, Arial, Helvetica, sans-serif';
      c.fillStyle = '#f6e7c1';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      const step = 0.2;
      for (let k = 0; k < text.length; k++) {
        const a = start + (bottom ? -1 : 1) * (k - (text.length - 1) / 2) * step;
        c.save();
        c.translate(cx + Math.cos(a) * 108, cy + Math.sin(a) * 108);
        c.rotate(a + (bottom ? -Math.PI / 2 : Math.PI / 2));
        c.fillText(text[k], 0, 1);
        c.restore();
      }
      c.restore();
    };
    arc('HARD LUCK', -Math.PI / 2, false);
    arc('AUCKLAND', Math.PI / 2, true);
    // The banner across the middle.
    c.fillStyle = '#c8202a';
    c.fillRect(0, cy - 30, R, 60);
    c.fillStyle = '#f2c230';
    c.fillRect(0, cy - 30, R, 4);
    c.fillRect(0, cy + 26, R, 4);
    c.save();
    c.font = 'italic 900 50px Georgia, Times New Roman, serif';
    c.fillStyle = '#ffffff';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('Café', cx, cy + 2);
    c.restore();
    // A star over the middle, under the top lettering.
    c.fillStyle = '#c8202a';
    c.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 5;
      const r = k % 2 ? 9 : 22;
      c.lineTo(cx + Math.cos(a) * r, cy - 62 + Math.sin(a) * r);
    }
    c.fill();
  },
  // townHall: Oamaru stone bay with a pair of round-arched windows over a balustraded balcony, 5 x 9 m
  (c, m, rnd) => {
    fill(c, m, 0, 0, R, R, grey(TINT_GREY), 1);
    grain(c, rnd, 5000, 0.1);
    ashlar(c, rnd, 0, 0, R, R, 14, 60, 0.08);
    // Pilasters at the bay edges with simple capitals.
    for (const x0 of [0, R - 22]) {
      fill(c, m, x0, 0, 22, R, grey(238), 1);
      c.fillStyle = 'rgba(0,0,0,0.16)';
      c.fillRect(x0 === 0 ? 21 : x0, 0, 1.5, R);
      fill(c, m, x0 - 3, 14, 28, 8, grey(246), 1);
      shadowBelow(c, x0 - 3, 22, 28, 5, 0.25);
    }
    // Entablature band at the top.
    band(c, m, 0, 12, grey(244), 1);
    shadowBelow(c, 0, 12, R, 6, 0.3);
    // Two arched windows with keystones.
    for (const x0 of [50, 136]) {
      const w = 70;
      const spring = 92;
      voussoirs(c, m, x0 + w / 2, spring, w / 2, 10, grey(242), 1, 9);
      c.save();
      m.save();
      for (const ctx of [c, m]) {
        archPath(ctx, x0, w, spring, 200);
        ctx.clip();
      }
      pane(c, m, rnd, x0, spring - w / 2, w, 200 - spring + w / 2, 0.05);
      c.restore();
      m.restore();
      sashes(c, x0, spring, w, 108, 2, 3, '#ece6da', 2.5);
      fill(c, m, x0 + w / 2 - 6, spring - w / 2 - 8, 12, 14, grey(248), 1);
    }
    // Balcony: a rail and balusters across the bay at the sill.
    fill(c, m, 30, 200, R - 60, 7, grey(246), 1);
    for (let x = 36; x < R - 36; x += 11) fill(c, m, x, 207, 5, 30, grey(236), 1);
    fill(c, m, 30, 236, R - 60, 8, grey(244), 1);
    shadowBelow(c, 30, 244, R - 60, 8, 0.35);
  },
  // shopfront: an Edwardian arcade shop, 4.9 x 3.9 m (52 px/m across, 66 up)
  (c, m, rnd) => {
    const timber = grey(TINT_GREY);
    fill(c, m, 0, 0, R, R, timber, 1);
    grain(c, rnd, 1500, 0.08);
    // Fascia (the sign goes over it) and the moulded rail under it.
    band(c, m, 0, 32, grey(TINT_GREY), 1);
    c.fillStyle = 'rgba(0,0,0,0.18)';
    c.fillRect(6, 4, R - 12, 1.5);
    c.fillRect(6, 27, R - 12, 1.5);
    band(c, m, 32, 7, grey(240), 1);
    // Leadlight transom: amber glass, a coloured diamond in each light, lead cames.
    const lights = 7;
    const lw = (R - 16) / lights;
    for (let k = 0; k < lights; k++) {
      const x = 8 + k * lw + 3;
      const w = lw - 6;
      fill(c, m, x, 44, w, 36, '#e3b765', 0);
      const g = c.createLinearGradient(0, 44, 0, 80);
      g.addColorStop(0, 'rgba(255,240,200,0.35)');
      g.addColorStop(1, 'rgba(120,70,20,0.25)');
      c.fillStyle = g;
      c.fillRect(x, 44, w, 36);
      const hue = ['#3f8f5a', '#b2344a', '#2f5fa8', '#3f8f5a', '#b2344a', '#2f5fa8', '#3f8f5a'][k];
      c.fillStyle = hue;
      c.beginPath();
      c.moveTo(x + w / 2, 48);
      c.lineTo(x + w - 5, 62);
      c.lineTo(x + w / 2, 76);
      c.lineTo(x + 5, 62);
      c.closePath();
      c.fill();
      c.strokeStyle = 'rgba(40,36,32,0.85)';
      c.lineWidth = 1.5;
      c.stroke();
      c.beginPath();
      c.moveTo(x, 62);
      c.lineTo(x + 5, 62);
      c.moveTo(x + w - 5, 62);
      c.lineTo(x + w, 62);
      c.moveTo(x + w / 2, 44);
      c.lineTo(x + w / 2, 48);
      c.moveTo(x + w / 2, 76);
      c.lineTo(x + w / 2, 80);
      c.stroke();
    }
    band(c, m, 82, 6, grey(236), 1);
    // Display windows either side of a recessed door.
    const doorX = 150;
    const doorW = 50;
    const display = (x: number, w: number) => {
      // Lit inside: warm back wall, shelves and stock, then the glass over it.
      fill(c, m, x, 92, w, 134, '#4a3a2c', 0);
      const glow = c.createLinearGradient(0, 92, 0, 226);
      glow.addColorStop(0, 'rgba(255,214,150,0.35)');
      glow.addColorStop(1, 'rgba(255,190,120,0.1)');
      c.fillStyle = glow;
      c.fillRect(x, 92, w, 134);
      for (const y of [140, 186]) {
        c.fillStyle = 'rgba(30,20,12,0.9)';
        c.fillRect(x, y, w, 4);
      }
      for (const y of [104, 150, 196]) {
        for (let px = x + 4; px < x + w - 10; ) {
          const iw = 6 + rnd() * 14;
          const ih = 12 + rnd() * 20;
          c.fillStyle = rgb(80 + rnd() * 175, 60 + rnd() * 160, 60 + rnd() * 170);
          c.fillRect(px, y + 32 - ih, Math.min(iw, x + w - 4 - px), ih);
          px += iw + 2 + rnd() * 6;
        }
      }
      // Reflections.
      c.fillStyle = 'rgba(255,255,255,0.12)';
      c.beginPath();
      c.moveTo(x + w * 0.2, 92);
      c.lineTo(x + w * 0.45, 92);
      c.lineTo(x + w * 0.15, 226);
      c.lineTo(x, 226);
      c.lineTo(x, 160);
      c.closePath();
      c.fill();
      // Glazing bars.
      c.fillStyle = timber;
      m.fillStyle = '#fff';
      for (let k = 1; k < Math.round(w / 48); k++) {
        const bx = x + (w * k) / Math.round(w / 48) - 2;
        c.fillRect(bx, 92, 4, 134);
        m.fillRect(bx, 92, 4, 134);
      }
    };
    display(10, doorX - 18);
    display(doorX + doorW + 8, R - (doorX + doorW + 8) - 8);
    // The door: a shadowed recess, a glazed door with a kick panel and a brass handle.
    fill(c, m, doorX - 4, 88, doorW + 8, R - 88, '#2b241d', 0);
    fill(c, m, doorX + 2, 94, doorW - 4, R - 94, timber, 1);
    c.fillStyle = 'rgba(0,0,0,0.25)';
    c.fillRect(doorX + 2, 94, doorW - 4, R - 94);
    pane(c, m, rnd, doorX + 8, 100, doorW - 16, 100, -0.2);
    c.fillStyle = 'rgba(255,214,150,0.3)';
    c.fillRect(doorX + 8, 100, doorW - 16, 100);
    c.fillStyle = '#c9a24e';
    c.fillRect(doorX + doorW - 14, 170, 4, 18);
    // Stallrisers of glazed green tiles.
    for (const [x, w] of [[10, doorX - 18], [doorX + doorW + 8, R - (doorX + doorW + 8) - 8]] as const) {
      fill(c, m, x, 228, w, 28, '#2f5a46', 0);
      c.strokeStyle = 'rgba(0,0,0,0.35)';
      c.lineWidth = 1;
      for (let tx = x; tx < x + w; tx += 14) {
        c.beginPath();
        c.moveTo(tx, 228);
        c.lineTo(tx, 256);
        c.stroke();
      }
      c.beginPath();
      c.moveTo(x, 242);
      c.lineTo(x + w, 242);
      c.stroke();
      c.fillStyle = 'rgba(255,255,255,0.18)';
      c.fillRect(x, 229, w, 2);
    }
    band(c, m, 224, 5, grey(244), 1, 8, R - 16);
    // Pilasters at the edges.
    for (const x0 of [0, R - 8]) {
      fill(c, m, x0, 0, 8, R, grey(232), 1);
      c.fillStyle = 'rgba(0,0,0,0.2)';
      c.fillRect(x0 === 0 ? 7 : x0, 0, 1.5, R);
    }
  },
  // sashes: rendered wall with a pair of sash windows, 4.9 x 3.4 m (52 px/m across, 75 up)
  (c, m, rnd) => {
    fill(c, m, 0, 0, R, R, grey(TINT_GREY), 1);
    grain(c, rnd, 4000, 0.08);
    for (let k = 0; k < 6; k++) {
      c.fillStyle = `rgba(0,0,0,${0.02 + rnd() * 0.03})`;
      c.fillRect(rnd() * R, rnd() * R, 30 + rnd() * 60, 20 + rnd() * 40);
    }
    // A string course along the top.
    band(c, m, 0, 12, grey(244), 1);
    for (const x0 of [34, 146]) {
      const w = 76;
      const top = 44;
      const bottom = 214;
      // Moulded architrave, then the frame.
      fill(c, m, x0 - 7, top - 7, w + 14, bottom - top + 7, grey(246), 1);
      shadowBelow(c, x0 - 7, bottom, w + 14, 6, 0.25);
      fill(c, m, x0, top, w, bottom - top, '#ece6da', 0);
      // Top light: leadlight in small panes.
      pane(c, m, rnd, x0 + 5, top + 5, w - 10, 34, 0.05);
      c.fillStyle = 'rgba(214,170,90,0.35)';
      c.fillRect(x0 + 5, top + 5, w - 10, 34);
      c.strokeStyle = 'rgba(50,44,38,0.7)';
      c.lineWidth = 1.2;
      c.beginPath();
      for (let k = 1; k < 4; k++) {
        c.moveTo(x0 + 5 + ((w - 10) * k) / 4, top + 5);
        c.lineTo(x0 + 5 + ((w - 10) * k) / 4, top + 39);
      }
      c.moveTo(x0 + 5, top + 22);
      c.lineTo(x0 + w - 5, top + 22);
      c.stroke();
      // Two sashes.
      pane(c, m, rnd, x0 + 5, top + 45, w - 10, bottom - top - 50, 0);
      sashes(c, x0 + 5, top + 45, w - 10, bottom - top - 50, 2, 2, '#ece6da', 3);
      // Sill.
      fill(c, m, x0 - 10, bottom, w + 20, 8, grey(248), 1);
      shadowBelow(c, x0 - 10, bottom + 8, w + 20, 8, 0.3);
    }
  },
  // tiles: a chequer of four by four 25 cm tiles, 1 m (the light ones tinted)
  (c, m, rnd) => {
    const t = R / 4;
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        const light = (i + j) % 2 === 0;
        fill(c, m, i * t, j * t, t, t, light ? grey(TINT_GREY - rnd() * 10) : rgb(30 + rnd() * 8, 30 + rnd() * 8, 32 + rnd() * 8), light ? 1 : 0);
        // A soft polish: lighter in the middle.
        const g = c.createRadialGradient(i * t + t / 2, j * t + t / 2, 2, i * t + t / 2, j * t + t / 2, t * 0.7);
        g.addColorStop(0, 'rgba(255,255,255,0.08)');
        g.addColorStop(1, 'rgba(0,0,0,0.06)');
        c.fillStyle = g;
        c.fillRect(i * t, j * t, t, t);
      }
    }
    grain(c, rnd, 1500, 0.08);
    c.fillStyle = 'rgba(110,104,96,0.9)';
    for (let k = 0; k <= 4; k++) {
      c.fillRect(k * t - 1, 0, 2, R);
      c.fillRect(0, k * t - 1, R, 2);
    }
  },
  // plaster: smooth painted render, 4 m
  (c, m, rnd) => {
    fill(c, m, 0, 0, R, R, grey(TINT_GREY), 1);
    grain(c, rnd, 5000, 0.07);
    // Faint patches of touched-up paint.
    for (let k = 0; k < 8; k++) {
      c.fillStyle = `rgba(${rnd() < 0.5 ? '0,0,0' : '255,255,255'},${0.008 + rnd() * 0.012})`;
      c.beginPath();
      c.ellipse(rnd() * R, rnd() * R, 30 + rnd() * 60, 20 + rnd() * 40, rnd() * 3, 0, Math.PI * 2);
      c.fill();
    }
  },
  // signs2, signs3: eight narrow lettered rows each, cut out round the letters
  ...SIGN_WORDS.map((rows): Painter => (c, m) => {
    c.clearRect(0, 0, R, R);
    m.fillStyle = '#000';
    m.fillRect(0, 0, R, R);
    rows.forEach(([text, fillColour, edge, font], row) => {
      const y = row * 32 + 17;
      for (const ctx of [c, m]) {
        ctx.save();
        ctx.font = `bold 24px ${font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        const w = ctx.measureText(text).width;
        const squeeze = Math.min(1, (R - 10) / w);
        ctx.translate(R / 2, y);
        ctx.scale(squeeze, 1);
        ctx.lineWidth = 5;
        ctx.strokeStyle = ctx === m ? '#fff' : edge;
        ctx.strokeText(text, 0, 0);
        ctx.fillStyle = ctx === m ? '#fff' : fillColour;
        ctx.fillText(text, 0, 0);
        ctx.restore();
      }
    });
  }),
];

export function buildLandmarkAtlas(maxAnisotropy = 1): THREE.DataArrayTexture {
  return bakeLayers('landmark-atlas', PAINTERS, maxAnisotropy, 7000, R);
}

