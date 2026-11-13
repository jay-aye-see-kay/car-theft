// A small split grammar for building exteriors.
//
//   footprint → walls → floors × bays → cells → window / shopfront / door
//
// Every building gets a bay grid from its own dimensions: bays along each wall, floors up.
// The grid is the same one the distant-building shader draws, so near and far agree, and it
// is what a floor-plan generator would use to put rooms behind windows.
import * as THREE from 'three';
import type { Heightfield } from '../model/load.ts';
import type { Building } from '../model/types.ts';

export const BAY = 3.4;
export const FLOOR = 3.3;

type RGB = [number, number, number];
const rgb = (c: number): RGB => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

import type { Style } from './styles.ts';

export type { Style };

export function hashOf(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619) >>> 0;
  return hash;
}

const cellHash = (seed: number, a: number, b: number, c: number): number => {
  let h = seed ^ Math.imul(a + 1, 374761393) ^ Math.imul(b + 1, 668265263) ^ Math.imul(c + 1, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export interface FacadeOptions {
  hillScale: number;
  /** Which style each building gets. Profiles decide; the default is the base profile's rules. */
  styleOf: (b: Building) => Style;
  /** True where a point is on or beside a road; walls facing one get shopfronts and awnings. */
  nearRoad: (x: number, y: number) => boolean;
  /** True under a mapped canopy or verandah: a wall there already has its awning. */
  covered?: (x: number, y: number) => boolean;
}

export function buildFacades(buildings: Building[], ground: Heightfield, opts: FacadeOptions): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const glow: number[] = [];
  const idx: number[] = [];
  const GLASS: RGB[] = [rgb(0x21344d), rgb(0x34526b), rgb(0x4d708c)];

  for (const b of buildings) {
    const n = b.ring.length;
    if (n < 3) continue;
    const style = opts.styleOf(b);
    const seed = hashOf(b.id);
    const wallC = rgb(style.walls[seed % style.walls.length]);
    const trimC = rgb(style.trim);
    const roofC = rgb(style.roof[(seed >>> 4) % style.roof.length]);
    let base = Infinity;
    for (const [x, y] of b.ring) base = Math.min(base, ground.at(x, y));
    base -= 0.5;
    const floor0 = b.ground * opts.hillScale;
    const top = floor0 + b.h;
    const floors = Math.max(1, Math.floor(b.h / FLOOR + 0.5));
    const fh = b.h / floors;
    const inset = style.inset ?? 0.2;

    const quad = (p0: number[], p1: number[], p2: number[], p3: number[], c: RGB, lit = 0): void => {
      const v = pos.length / 3;
      pos.push(...p0, ...p1, ...p2, ...p3);
      for (let k = 0; k < 4; k++) {
        col.push(c[0], c[1], c[2]);
        glow.push(lit);
      }
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    };

    // Group edges into facades. A facade carries on around gentle bends, so a curved wall is one
    // facade with bays along its whole length, not a row of slivers each too short for a window.
    interface Seg {
      ax: number;
      ay: number;
      dx: number;
      dy: number;
      len: number;
      /** Distance from the start of the facade to the start of this segment. */
      at: number;
    }
    const edge = (i: number): Seg => {
      const [ax, ay] = b.ring[i];
      const [bx, by] = b.ring[(i + 1) % n];
      const len = Math.hypot(bx - ax, by - ay) || 1e-6;
      return { ax, ay, dx: (bx - ax) / len, dy: (by - ay) / len, len, at: 0 };
    };
    const edges = b.ring.map((_, i) => edge(i));
    const corner = (i: number): boolean => {
      const [p, q] = [edges[(i + n - 1) % n], edges[i]];
      return p.dx * q.dx + p.dy * q.dy < 0.82; // A turn of more than about 35 degrees.
    };
    let start = 0;
    while (start < n && !corner(start)) start++;
    const facades: Seg[][] = [];
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      if (k === 0 || corner(i)) facades.push([]);
      const run = facades[facades.length - 1];
      const prev = run[run.length - 1];
      run.push({ ...edges[i], at: prev ? prev.at + prev.len : 0 });
    }
    const lengthOf = (run: Seg[]): number => run[run.length - 1].at + run[run.length - 1].len;
    const facesRoad = facades.map((run) => {
      const mid = run[run.length >> 1];
      const [mx, my] = [mid.ax + (mid.dx * mid.len) / 2, mid.ay + (mid.dy * mid.len) / 2];
      return lengthOf(run) > BAY && opts.nearRoad(mx + mid.dy * 5, my - mid.dx * 5);
    });
    const underCover = facades.map((run) => {
      const mid = run[run.length >> 1];
      const [mx, my] = [mid.ax + (mid.dx * mid.len) / 2, mid.ay + (mid.dy * mid.len) / 2];
      return !!opts.covered?.(mx + mid.dy * 1.2, my - mid.dx * 1.2);
    });
    // The door goes on the longest facade that faces a road.
    let doorFacade = -1;
    facades.forEach((run, i) => {
      if (facesRoad[i] && (doorFacade < 0 || lengthOf(run) > lengthOf(facades[doorFacade]))) doorFacade = i;
    });

    facades.forEach((run, fi) => {
      const len = lengthOf(run);
      /** A point on the facade: t metres along a segment, at height v, d metres out from the wall. */
      const P = (s: Seg, t: number, v: number, d: number): [number, number, number] => [s.ax + s.dx * t + s.dy * d, v, -(s.ay + s.dy * t - s.dx * d)];
      const segAt = (u: number): Seg => run.find((s) => u <= s.at + s.len) ?? run[run.length - 1];
      /** A surface swept along the facade from u0 to u1, between two (height, depth) edges. Follows bends. */
      const sweep = (u0: number, u1: number, va: number, da: number, vb: number, db: number, c: RGB, lit = 0): void => {
        for (const s of run) {
          const t0 = Math.max(u0, s.at) - s.at;
          const t1 = Math.min(u1, s.at + s.len) - s.at;
          if (t1 - t0 > 1e-3) quad(P(s, t0, va, da), P(s, t1, va, da), P(s, t1, vb, db), P(s, t0, vb, db), c, lit);
        }
      };
      const panel = (u0: number, u1: number, v0: number, v1: number, c: RGB, d = 0, lit = 0): void => {
        if (v1 - v0 > 1e-3) sweep(u0, u1, v0, d, v1, d, c, lit);
      };
      /** A flat piece closing off the end of something that sticks out or in. */
      const cap = (u: number, v0: number, v1: number, d0: number, d1: number, c: RGB): void => {
        const s = segAt(u);
        const t = u - s.at;
        quad(P(s, t, v0, d0), P(s, t, v0, d1), P(s, t, v1, d1), P(s, t, v1, d0), c);
      };
      /** A box standing proud of the wall. */
      const box = (u0: number, u1: number, v0: number, v1: number, depth: number, c: RGB): void => {
        panel(u0, u1, v0, v1, c, depth);
        sweep(u0, u1, v1, 0, v1, depth, shade(c, 1.08));
        sweep(u0, u1, v0, 0, v0, depth, shade(c, 0.7));
        cap(u0, v0, v1, 0, depth, shade(c, 0.85));
        cap(u1, v0, v1, 0, depth, shade(c, 0.85));
      };
      /** A recessed opening: glass set back, with the reveal around it. */
      const opening = (u0: number, u1: number, v0: number, v1: number, glass: RGB, lit: number): void => {
        panel(u0, u1, v0, v1, glass, -inset, lit);
        sweep(u0, u1, v0, 0, v0, -inset, trimC);
        sweep(u0, u1, v1, 0, v1, -inset, shade(wallC, 0.7));
        cap(u0, v0, v1, 0, -inset, shade(wallC, 0.82));
        cap(u1, v0, v1, 0, -inset, shade(wallC, 0.82));
      };

      // Below the building's floor level, on sloping ground: a plain plinth.
      panel(0, len, base, floor0, shade(wallC, 0.72));

      const bays = Math.floor(len / BAY);
      if (bays < 1 || style.winW === 0) {
        panel(0, len, floor0, top + style.parapet, wallC);
        return;
      }
      const bw = len / bays;
      for (let f = 0; f < floors; f++) {
        const v0 = floor0 + f * fh;
        const shop = f === 0 && style.shopfront && facesRoad[fi];
        const w = shop ? 0.84 : style.winW;
        const lo = v0 + fh * (shop ? 0.12 : style.sill);
        const hi = shop ? v0 + fh * 0.8 : lo + fh * style.winH;
        // Solid bands below and above the row of windows, then a pier between each pair.
        panel(0, len, v0, lo, wallC);
        panel(0, len, hi, v0 + fh, wallC);
        if (w >= 1) {
          // Ribbon glazing: one strip of glass with a mullion at every bay line.
          opening(0.3, len - 0.3, lo, hi, GLASS[(seed + f) % 3], cellHash(seed, fi, f, 0) > 0.55 ? 0.6 : 0);
          panel(0, 0.3, lo, hi, wallC);
          panel(len - 0.3, len, lo, hi, wallC);
          for (let k = 1; k < bays; k++) panel(k * bw - 0.06, k * bw + 0.06, lo, hi, trimC, -inset * 0.5);
          continue;
        }
        const margin = (bw * (1 - w)) / 2;
        const doorBay = f === 0 && fi === doorFacade ? Math.floor(bays / 2) : -1;
        for (let k = 0; k < bays; k++) {
          const u0 = k * bw + margin;
          const u1 = (k + 1) * bw - margin;
          panel(k * bw, u0, lo, hi, wallC);
          panel(u1, (k + 1) * bw, lo, hi, wallC);
          const pick = cellHash(seed, fi, f, k);
          if (k === doorBay) {
            // A door: a dark leaf from the floor up, faintly lit at dusk.
            panel(u0, u1, v0, hi, shade(trimC, 0.4), 0.04, 0.35);
            continue;
          }
          opening(u0, u1, lo, hi, GLASS[Math.floor(pick * 3)], pick > 0.62 ? 1 : 0);
          if (style.lancet) {
            // A pointed head over the window, standing just proud of the wall like carved stone.
            const peak = Math.min(hi + (u1 - u0) * 0.75, v0 + fh - 0.12);
            const mid = (u0 + u1) / 2;
            const s = segAt(mid);
            const at = (u: number) => u - s.at;
            if (peak > hi + 0.1) {
              quad(P(s, at(u0 - 0.08), hi, 0.03), P(s, at(u1 + 0.08), hi, 0.03), P(s, at(mid), peak + 0.1, 0.03), P(s, at(mid), peak + 0.1, 0.03), trimC);
              quad(P(s, at(u0), hi, 0.05), P(s, at(u1), hi, 0.05), P(s, at(mid), peak, 0.05), P(s, at(mid), peak, 0.05), GLASS[Math.floor(pick * 3)], pick > 0.62 ? 1 : 0);
            }
          }
          if (style.balcony && f > 0) box(u0 - 0.15, u1 + 0.15, v0 + 0.02, lo + fh * 0.22, 1.1, trimC);
        }
      }

      // Things that run the length of the facade.
      if (style.awning && facesRoad[fi] && !underCover[fi]) box(0.2, len - 0.2, floor0 + fh * 0.84, floor0 + fh * 0.84 + 0.22, 2.3, shade(rgb(style.walls[(seed >>> 8) % style.walls.length]), 0.8));
      if (style.cornice) box(0, len, top - 0.15, top + 0.3, 0.3, trimC);
      if (style.parapet) panel(0, len, top, top + style.parapet, wallC);
    });

    // Roof.
    const ring3 = (pts: [number, number][], h: number): number => {
      const v = pos.length / 3;
      for (const [x, y] of pts) {
        pos.push(x, h, -y);
        glow.push(0);
      }
      return v;
    };
    if (style.roofForm === 'hip') {
      // Eaves overhang the walls; the roof rises to a short ridge by shrinking the outline.
      let [cx, cy] = [0, 0];
      for (const [x, y] of b.ring) [cx, cy] = [cx + x / n, cy + y / n];
      let span = Infinity;
      for (const [x, y] of b.ring) span = Math.min(span, Math.hypot(x - cx, y - cy));
      const pitch = style.roofPitch ?? 1;
      const rise = Math.min(3.2 * pitch, Math.max(1.2, span * 0.6 * pitch));
      const eave = b.ring.map(([x, y]): [number, number] => [cx + (x - cx) * 1.08, cy + (y - cy) * 1.08]);
      const ridge = b.ring.map(([x, y]): [number, number] => [cx + (x - cx) * 0.18, cy + (y - cy) * 0.18]);
      for (let i = 0; i < n; i++) {
        const k = (i + 1) % n;
        const v = pos.length / 3;
        pos.push(eave[i][0], top, -eave[i][1], eave[k][0], top, -eave[k][1], ridge[k][0], top + rise, -ridge[k][1], ridge[i][0], top + rise, -ridge[i][1]);
        const c = shade(roofC, i % 2 ? 1 : 0.9);
        for (let q = 0; q < 4; q++) {
          col.push(c[0], c[1], c[2]);
          glow.push(0);
        }
        idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      }
      const v = ring3(ridge, top + rise);
      for (let q = 0; q < n; q++) col.push(roofC[0], roofC[1], roofC[2]);
      for (const f of THREE.ShapeUtils.triangulateShape(ridge.map(([x, y]) => new THREE.Vector2(x, y)), [])) idx.push(v + f[0], v + f[1], v + f[2]);
    } else {
      const v = ring3(b.ring, top);
      for (let q = 0; q < n; q++) col.push(roofC[0], roofC[1], roofC[2]);
      const faces = THREE.ShapeUtils.triangulateShape(b.ring.map(([x, y]) => new THREE.Vector2(x, y)), []);
      for (const f of faces) idx.push(v + f[0], v + f[1], v + f[2]);
      if (style.plant) {
        // A plant room: the footprint again at a third of the size, one storey up.
        let [cx, cy] = [0, 0];
        for (const [x, y] of b.ring) [cx, cy] = [cx + x / n, cy + y / n];
        const small = b.ring.map(([x, y]): [number, number] => [cx + (x - cx) * 0.38, cy + (y - cy) * 0.38]);
        const c = shade(wallC, 0.85);
        for (let i = 0; i < n; i++) {
          const k = (i + 1) % n;
          const w = pos.length / 3;
          pos.push(small[i][0], top, -small[i][1], small[k][0], top, -small[k][1], small[k][0], top + 3.5, -small[k][1], small[i][0], top + 3.5, -small[i][1]);
          for (let q = 0; q < 4; q++) {
            col.push(c[0], c[1], c[2]);
            glow.push(0);
          }
          idx.push(w, w + 1, w + 2, w, w + 2, w + 3);
        }
        const w = ring3(small, top + 3.5);
        for (let q = 0; q < n; q++) col.push(roofC[0], roofC[1], roofC[2]);
        for (const f of faces) idx.push(w + f[0], w + f[1], w + f[2]);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('glow', new THREE.Float32BufferAttribute(glow, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
