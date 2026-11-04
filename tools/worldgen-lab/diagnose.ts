// How tilted are today's roads? Samples the shipped terrain heightfield (what
// the car actually drives on) across and along every road-graph edge.
//   node --experimental-strip-types tools/worldgen-lab/diagnose.ts
import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { decodeTerrain } from '../../src/city/format.ts';

const DIR = new URL('../../public/city/cbd/', import.meta.url).pathname;
const man = JSON.parse(readFileSync(DIR + 'manifest.json', 'utf8'));
const { x0, z0, nx, nz } = man.grid;
const S = man.chunkSize, C = man.terrain.cellSize, A = man.terrain.apron;
const chunks = new Map<string, { n: number; heights: Float32Array }>();
for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
  const f = `${DIR}terrain/${i}_${j}.bin`;
  if (existsSync(f)) chunks.set(`${i},${j}`, decodeTerrain(inflateSync(readFileSync(f))));
}
function h(x: number, z: number): number {
  const i = Math.floor((x - x0) / S), j = Math.floor((z - z0) / S);
  const t = chunks.get(`${i},${j}`);
  if (!t) return NaN;
  const fx = (x - (x0 + i * S)) / C + A, fz = (z - (z0 + j * S)) / C + A;
  const c = Math.floor(fx), r = Math.floor(fz), u = fx - c, v = fz - r;
  const H = (rr: number, cc: number) => t.heights[rr * t.n + cc];
  return (H(r, c) * (1 - u) + H(r, c + 1) * u) * (1 - v) + (H(r + 1, c) * (1 - u) + H(r + 1, c + 1) * u) * v;
}
const g = JSON.parse(readFileSync(DIR + 'roadgraph.json', 'utf8'));
const cross: number[] = [], grade: number[] = [], twist: number[] = [];
let total = 0;
const bins = [0.02, 0.04, 0.06, 0.08, 0.12];
const crossLen = new Array(bins.length + 1).fill(0);
const gradeLen = new Array(bins.length + 1).fill(0);
for (const e of g.edges) {
  if (e[7] & 1) continue; // bridges are decks, not terrain
  const p = e[12] as number[];
  const half = Math.max(2, (e[6] as number) / 2 - 0.5);
  let prevCross = NaN;
  for (let k = 0; k + 3 < p.length; k += 3) {
    const ax = p[k], az = p[k + 2], bx = p[k + 3], bz = p[k + 5];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.5) continue;
    const dx = (bx - ax) / L, dz = (bz - az) / L;
    for (let s = 1; s < L; s += 2) {
      const x = ax + dx * s, z = az + dz * s;
      const l = h(x - dz * half, z + dx * half), r = h(x + dz * half, z - dx * half);
      const f = h(x + dx, z + dz), b = h(x - dx, z - dz);
      if ([l, r, f, b].some(Number.isNaN)) continue;
      const cs = Math.abs(l - r) / (2 * half), gr = Math.abs(f - b) / 2;
      const cb = bins.findIndex((v) => cs < v), gb = bins.findIndex((v) => gr < v);
      crossLen[cb < 0 ? bins.length : cb] += 2; gradeLen[gb < 0 ? bins.length : gb] += 2;
      total += 2; cross.push(cs); grade.push(gr);
      const c2 = (l - r) / (2 * half);
      if (!Number.isNaN(prevCross)) twist.push(Math.abs(c2 - prevCross) / 2);
      prevCross = c2;
    }
  }
}
const pct = (a: number[]) => a.map((v) => ((100 * v) / total).toFixed(1).padStart(5) + '%').join(' ');
const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];
console.log(`road length sampled: ${(total / 1000).toFixed(1)} km (bridges excluded)`);
console.log(`slope bands:          <2%    2-4%   4-6%   6-8%  8-12%  >12%`);
console.log(`cross-slope share: ${pct(crossLen)}`);
console.log(`grade share:       ${pct(gradeLen)}`);
console.log(`cross-slope p50 ${(q(cross, 0.5) * 100).toFixed(1)}%  p90 ${(q(cross, 0.9) * 100).toFixed(1)}%  p99 ${(q(cross, 0.99) * 100).toFixed(1)}%`);
console.log(`twist (change of cross-slope per m) p90 ${(q(twist, 0.9) * 100).toFixed(2)}%/m  p99 ${(q(twist, 0.99) * 100).toFixed(2)}%/m`);
