// Grey-box massing: each footprint pushed up to its measured height. A stand-in until
// there is a facade generator; it is here so roads can be judged in context.
import * as THREE from 'three';
import type { Heightfield } from '../model/load.ts';
import type { Building } from '../model/types.ts';

function tone(b: Building): THREE.Color {
  // A stable pseudo-random tint per building, from its id.
  let hash = 0;
  for (let i = 0; i < b.id.length; i++) hash = (hash * 31 + b.id.charCodeAt(i)) >>> 0;
  const r = (hash % 1000) / 1000;
  const c = new THREE.Color();
  if (b.h > 40) return c.setHSL(0.58, 0.14, 0.62 + r * 0.14);
  if (b.kind === 'university' || b.kind === 'church' || b.kind === 'cathedral') return c.setHSL(0.07, 0.3, 0.6 + r * 0.1);
  if (b.kind === 'house' || b.kind === 'detached' || b.kind === 'terrace') return c.setHSL(0.09 + r * 0.05, 0.3, 0.74 + r * 0.1);
  return c.setHSL(0.08 + r * 0.06, 0.12, 0.66 + r * 0.14);
}

export function buildMassing(buildings: Building[], ground: Heightfield): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (const b of buildings) {
    const n = b.ring.length;
    if (n < 3) continue;
    // Sit the base at the lowest corner so nothing floats on a slope.
    let base = Infinity;
    for (const [x, y] of b.ring) base = Math.min(base, ground.at(x, y));
    base -= 0.5;
    const top = b.ground + b.h;
    const wall = tone(b);
    const roof = wall.clone().multiplyScalar(0.82);
    for (let i = 0; i < n; i++) {
      const [ax, ay] = b.ring[i];
      const [bx, by] = b.ring[(i + 1) % n];
      const v = pos.length / 3;
      pos.push(ax, base, -ay, bx, base, -by, bx, top, -by, ax, top, -ay);
      for (let k = 0; k < 4; k++) col.push(wall.r, wall.g, wall.b);
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
    const v = pos.length / 3;
    for (const [x, y] of b.ring) {
      pos.push(x, top, -y);
      col.push(roof.r, roof.g, roof.b);
    }
    for (const f of THREE.ShapeUtils.triangulateShape(b.ring.map(([x, y]) => new THREE.Vector2(x, y)), [])) idx.push(v + f[0], v + f[1], v + f[2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
