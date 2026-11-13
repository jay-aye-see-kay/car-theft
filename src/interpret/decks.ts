// How high a bridge's deck really is.
//
// Bare-earth LiDAR has every bridge taken out of it, and usually more than the bridge: the abutments
// and the retaining walls go too, so the ground reads as a dip tens of metres longer than the span the
// map tags. A road drawn on that ground sags into the gap it was built to cross. The first-return
// surface still has the deck in it, so along a tagged bridge the deck is measured from that, and
// followed outward for as long as the road stays clear of the ground.
//
// Only tagged bridges are measured. Away from one, a surface above the road is as likely to be a
// bridge over it, a building or a tree.
import type { Pt, Road } from '../model/types.ts';

/** Height at a point, or NaN where there is no data. */
export type Sampler = (x: number, y: number) => number;

const STEP = 3;
/** The deck is this far above the bare earth where there is a gap under it. */
const GAP = 1;
/** It is followed out past the tagged span until it is this close to the ground. */
const LANDED = 0.5;
/** No road climbs faster than this; a steeper change in the surface is something else. */
const MAX_SLOPE = 0.2;
const LANE = 3.2;

const median = (v: number[]): number => {
  const s = v.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
};

export function measureDecks(roads: Road[], surface: Sampler, ground: Sampler): Record<string, number> {
  let measured = 0;
  let lifted = 0;
  let extended = 0;
  for (const road of roads) {
    delete road.deck;
    if (!road.sections.some((s) => s.level > 0)) continue;
    const cum = [0];
    for (let i = 1; i < road.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(road.pts[i][0] - road.pts[i - 1][0], road.pts[i][1] - road.pts[i - 1][1]));
    const length = cum[cum.length - 1];
    const n = Math.max(2, Math.round(length / STEP) + 1);
    const at = (s: number): { p: Pt; nx: number; ny: number } => {
      let k = 0;
      while (k < cum.length - 2 && cum[k + 1] < s) k++;
      const [a, b] = [road.pts[k], road.pts[k + 1]];
      const len = cum[k + 1] - cum[k] || 1;
      const u = (s - cum[k]) / len;
      return { p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], nx: -(b[1] - a[1]) / len, ny: (b[0] - a[0]) / len };
    };
    const ss: number[] = [];
    const top: number[] = [];
    const earth: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = (length * i) / (n - 1);
      const sec = road.sections.find((x) => s <= x.s1) ?? road.sections[road.sections.length - 1];
      // Across the middle of the carriageway: clear of the barriers, and of whatever is below a narrow deck.
      const reach = Math.max(1, ((sec.lanesF + sec.lanesB) * LANE) / 2 - 1.5);
      const { p, nx, ny } = at(s);
      const across: number[] = [];
      for (let o = -reach; o <= reach; o += 1) across.push(surface(p[0] + nx * o, p[1] + ny * o));
      ss.push(s);
      top.push(median(across));
      earth.push(ground(p[0], p[1]));
    }
    // Vehicles, gantries and bridges overhead only ever add height, so each sample is checked against
    // the lowest of its neighbours either side, a lane-length or so away.
    const calm = top.map((_, i) => median(top.slice(Math.max(0, i - 2), i + 3)));
    const level = (s: number): number => (road.sections.find((x) => s <= x.s1) ?? road.sections[road.sections.length - 1]).level;
    const clear = (i: number, by: number): boolean => calm[i] - earth[i] > by;

    const deck: [number, number][] = [];
    let i = 0;
    while (i < n) {
      if (level(ss[i]) <= 0) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < n && level(ss[j + 1]) > 0) j++;
      const tagged = j - i + 1;
      let seen = 0;
      for (let k = i; k <= j; k++) if (clear(k, GAP)) seen++;
      // Mostly on the ground: a culvert, or a deck hidden under something. Nothing to measure.
      if (seen >= tagged * 0.6) {
        let [a, b] = [i, j];
        const follows = (k: number, from: number): boolean => clear(k, LANDED) && Math.abs(calm[k] - calm[from]) <= MAX_SLOPE * Math.abs(ss[k] - ss[from]) + 0.3;
        while (a > 0 && level(ss[a - 1]) === 0 && follows(a - 1, a)) a--;
        while (b < n - 1 && level(ss[b + 1]) === 0 && follows(b + 1, b)) b++;
        // Drop what stands proud of a line through its neighbours, then fill those from either side.
        const h = calm.slice(a, b + 1);
        for (let pass = 0; pass < 3; pass++) {
          for (let k = 0; k < h.length; k++) {
            const base = median(h.slice(Math.max(0, k - 7), k + 8));
            if (Number.isNaN(h[k]) || h[k] > base + 1.2 || h[k] < base - 1.2) h[k] = NaN;
          }
          for (let k = 0; k < h.length; k++) {
            if (!Number.isNaN(h[k])) continue;
            let [l, r] = [k - 1, k + 1];
            while (l >= 0 && Number.isNaN(h[l])) l--;
            while (r < h.length && Number.isNaN(h[r])) r++;
            if (l < 0 && r >= h.length) break;
            h[k] = l < 0 ? h[r] : r >= h.length ? h[l] : h[l] + ((h[r] - h[l]) * (k - l)) / (r - l);
          }
        }
        if (!h.some((v) => Number.isNaN(v))) {
          for (let k = 0; k < h.length; k++) deck.push([Math.round(ss[a + k] * 10) / 10, Math.round(h[k] * 100) / 100]);
          measured++;
          if (b - a + 1 > tagged) extended++;
          if (h.some((v, k) => v - earth[a + k] > 3)) lifted++;
          j = Math.max(j, b);
        }
      }
      i = j + 1;
    }
    if (deck.length) road.deck = deck;
  }
  return { 'roads.decksMeasured': measured, 'roads.decksLongerThanTagged': extended, 'roads.decksClearOfGround': lifted };
}
