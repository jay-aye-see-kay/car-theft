// Grey-box massing: each footprint pushed up to its measured height. A stand-in until
// there is a facade generator; it is here so roads and looks can be judged in context.
import * as THREE from 'three';
import type { Heightfield } from '../model/load.ts';
import type { Building } from '../model/types.ts';
import { hashOf, styleFor } from './facade.ts';

export interface MassingOptions {
  /** 'grey' is neutral; 'toy' picks from a small saturated palette, ignoring real colours. */
  palette: 'grey' | 'toy';
  /** Multiplier already applied to terrain heights, so building bases follow. */
  hillScale: number;
}

function tone(b: Building, palette: MassingOptions['palette']): THREE.Color {
  // A stable pseudo-random choice per building, from its id.
  const hash = hashOf(b.id);
  const r = (hash % 1000) / 1000;
  const c = new THREE.Color();
  if (palette === 'toy') {
    // The same wall colour the facade grammar will pick, so a building keeps its colour as it gains detail.
    const walls = styleFor(b).walls;
    return c.setHex(walls[hash % walls.length]);
  }
  if (b.h > 40) return c.setHSL(0.58, 0.14, 0.62 + r * 0.14);
  if (b.kind === 'university' || b.kind === 'church' || b.kind === 'cathedral') return c.setHSL(0.07, 0.3, 0.6 + r * 0.1);
  if (b.kind === 'house' || b.kind === 'detached' || b.kind === 'terrace') return c.setHSL(0.09 + r * 0.05, 0.3, 0.74 + r * 0.1);
  return c.setHSL(0.08 + r * 0.06, 0.12, 0.66 + r * 0.14);
}

/**
 * Besides position and colour, each wall vertex carries `wall` = (metres along the wall,
 * metres above the base, wall length, wall height) so a shader can lay a bay grid on it.
 * Roof vertices have a wall length of 0.
 */
export function buildMassing(buildings: Building[], ground: Heightfield, opts: MassingOptions = { palette: 'grey', hillScale: 1 }): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const wall: number[] = [];
  const idx: number[] = [];
  for (const b of buildings) {
    const n = b.ring.length;
    if (n < 3) continue;
    // Sit the base at the lowest corner so nothing floats on a slope.
    let base = Infinity;
    for (const [x, y] of b.ring) base = Math.min(base, ground.at(x, y));
    base -= 0.5;
    const floor = b.ground * opts.hillScale;
    const top = floor + b.h;
    const c = tone(b, opts.palette);
    const roofs = styleFor(b).roof;
    const roof = opts.palette === 'toy' ? new THREE.Color(roofs[(hashOf(b.id) >>> 4) % roofs.length]) : c.clone().multiplyScalar(0.82);
    const seed = (hashOf(b.id) % 997) / 997;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = b.ring[i];
      const [bx, by] = b.ring[(i + 1) % n];
      const len = Math.hypot(bx - ax, by - ay);
      const v = pos.length / 3;
      pos.push(ax, base, -ay, bx, base, -by, bx, top, -by, ax, top, -ay);
      // Heights are measured from the building's own floor level, so floors line up around it.
      wall.push(0, base - floor, len, b.h, len, base - floor, len, b.h, len, b.h, len, b.h, 0, b.h, len, b.h);
      for (let k = 0; k < 4; k++) col.push(c.r, c.g, c.b);
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
    const v = pos.length / 3;
    for (const [x, y] of b.ring) {
      pos.push(x, top, -y);
      col.push(roof.r, roof.g, roof.b);
      wall.push(seed, 0, 0, b.h);
    }
    for (const f of THREE.ShapeUtils.triangulateShape(b.ring.map(([x, y]) => new THREE.Vector2(x, y)), [])) idx.push(v + f[0], v + f[1], v + f[2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('wall', new THREE.Float32BufferAttribute(wall, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
