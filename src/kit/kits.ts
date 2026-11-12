// The kit: every small thing a profile can ask for by name, as low-poly geometry built in code.
// Stand-ins for an artist's kit; profiles only know the names, so real models can replace these.
// Everything stands on y = 0, faces +x, and is about life size at size 1.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Tone } from '../profile/schema.ts';

export interface Kit {
  id: string;
  /** Shapes of the same thing; each instance takes one by its tint. */
  variants: THREE.BufferGeometry[];
  /** How an instance is coloured: by a tone (multiplying the shape's own colours), or as modelled. */
  tone?: Tone;
  /** Stretch upward by up to this much, by tint, so a row of trees is not a row of clones. */
  stretch?: number;
  /** A lamp: draws a glowing head and a pool of light at these offsets. */
  lamp?: { head: THREE.BufferGeometry; pool: THREE.BufferGeometry };
  shadow: boolean;
}

const C = (hex: number) => new THREE.Color(hex);

function paint(g: THREE.BufferGeometry, colour: number): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const c = C(colour);
  const a = new Float32Array(geo.getAttribute('position').count * 3);
  for (let i = 0; i < a.length; i += 3) c.toArray(a, i);
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  geo.deleteAttribute('uv');
  return geo;
}

const merge = (...parts: THREE.BufferGeometry[]) => mergeGeometries(parts)!;
const box = (w: number, h: number, d: number, x: number, y: number, z: number, c: number) => paint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), c);
const blob = (sx: number, sy: number, sz: number, x: number, y: number, z: number, c: number, rot = 0) =>
  paint(new THREE.IcosahedronGeometry(1, 0).scale(sx, sy, sz).rotateY(rot).translate(x, y, z), c);
const trunk = (r0: number, r1: number, h: number, c = 0x7a6a55, sides = 5) => paint(new THREE.CylinderGeometry(r1, r0, h, sides).translate(0, h / 2, 0), c);

/** A frond: a thin tapering blade from the crown, out and drooping. */
function frond(len: number, width: number, yaw: number, rise: number, droop: number, y: number, c: number): THREE.BufferGeometry {
  const inner = new THREE.BoxGeometry(len * 0.55, 0.05, width).translate(len * 0.275, 0, 0).rotateZ(rise);
  const tip = new THREE.BoxGeometry(len * 0.5, 0.04, width * 0.55)
    .translate(len * 0.25, 0, 0)
    .rotateZ(rise - droop)
    .translate(Math.cos(rise) * len * 0.55, Math.sin(rise) * len * 0.55, 0);
  return paint(merge(inner.toNonIndexed(), tip.toNonIndexed()).rotateY(yaw).translate(0, y, 0), c);
}

function crown(n: number, len: number, width: number, rise: number, droop: number, y: number, c: number, twist = 0): THREE.BufferGeometry[] {
  return Array.from({ length: n }, (_, i) => frond(len, width, (i / n) * Math.PI * 2 + twist, rise + (i % 2) * 0.25, droop, y, c));
}

const WHITE = 0xffffff;

function build(): Kit[] {
  const kits: Kit[] = [];
  const add = (k: Partial<Kit> & Pick<Kit, 'id' | 'variants'>) => kits.push({ shadow: true, ...k });

  // Trees. Crowns are modelled white so the tone gives them their colour.
  add({
    id: 'broadleaf',
    variants: [merge(trunk(0.34, 0.22, 3.2), blob(2.7, 2.5, 2.7, 0, 4.6, 0, WHITE), blob(1.8, 1.7, 1.8, 0.5, 6.4, 0.3, 0xf2f2f2, 1))],
    tone: { h: [0.27, 0.37], s: 0.42, l: [0.3, 0.44], flower: 0.032 },
    stretch: 0.4,
  });
  add({
    id: 'oak',
    variants: [
      merge(trunk(0.6, 0.4, 3.6, 0x6d5c48), blob(3.6, 2.6, 3.4, 0, 5.4, 0, WHITE), blob(2.6, 2.1, 2.4, 1.9, 6.2, 0.8, 0xf0f0f0, 1), blob(2.4, 2.0, 2.6, -1.6, 6.0, -1.2, 0xf6f6f6, 2)),
      merge(trunk(0.55, 0.38, 3.2, 0x6d5c48), blob(3.2, 2.8, 3.6, 0.4, 5.6, 0, WHITE, 0.6), blob(2.4, 2.2, 2.2, -1.8, 6.6, 0.9, 0xf2f2f2, 1.7)),
    ],
    tone: { h: [0.2, 0.28], s: 0.45, l: [0.34, 0.46] },
    stretch: 0.2,
  });
  add({
    id: 'plane',
    variants: [merge(trunk(0.32, 0.22, 5, 0xa49a86), blob(2.2, 3.4, 2.2, 0, 7.4, 0, WHITE), blob(1.5, 1.8, 1.5, 0.4, 9.6, -0.2, 0xf2f2f2, 1))],
    tone: { h: [0.2, 0.27], s: 0.42, l: [0.4, 0.5] },
    stretch: 0.3,
  });
  add({
    id: 'pohutukawa',
    variants: [
      merge(
        paint(new THREE.CylinderGeometry(0.22, 0.38, 2.6, 5).translate(0, 1.3, 0).rotateZ(0.35), 0x5f5245),
        paint(new THREE.CylinderGeometry(0.2, 0.34, 2.4, 5).translate(0, 1.2, 0).rotateZ(-0.4), 0x5f5245),
        blob(3.2, 1.5, 3.0, -0.9, 2.9, 0.3, WHITE),
        blob(3.0, 1.4, 2.8, 1.4, 3.1, -0.5, 0xf4f4f4, 1),
        blob(2.4, 1.3, 2.4, 0.2, 3.9, 0.9, 0xeeeeee, 2),
      ),
    ],
    tone: { h: [0.22, 0.29], s: 0.36, l: [0.22, 0.3], flower: 0.22 },
    stretch: 0.15,
  });
  add({
    id: 'kauri',
    variants: [
      merge(
        trunk(0.75, 0.6, 15, 0xa39d90, 7),
        blob(2.2, 1.3, 2.0, 1.6, 15.2, 0.4, WHITE),
        blob(2.4, 1.4, 2.2, -1.5, 15.8, -0.6, 0xf2f2f2, 1),
        blob(2.0, 1.3, 2.0, 0.2, 17, 1.2, 0xf6f6f6, 2),
        blob(1.8, 1.1, 1.8, -0.3, 16.4, -1.8, WHITE, 3),
        box(3.6, 0.3, 0.3, 0.2, 14.6, 0, 0x8f897d),
        box(0.3, 0.3, 3.4, -0.3, 15.1, 0, 0x8f897d),
      ),
    ],
    tone: { h: [0.24, 0.3], s: 0.3, l: [0.22, 0.3] },
    stretch: 0.25,
  });
  add({
    id: 'nikau',
    variants: [
      merge(trunk(0.2, 0.15, 6.2, 0x9a9384, 6), paint(new THREE.CylinderGeometry(0.24, 0.24, 1.2, 6).translate(0, 6.6, 0), 0xb7d0a0), ...crown(9, 3.2, 0.5, 0.75, 1.5, 7.1, WHITE)),
    ],
    tone: { h: [0.24, 0.3], s: 0.5, l: [0.3, 0.38] },
    stretch: 0.35,
  });
  add({
    id: 'palm',
    variants: [merge(trunk(0.45, 0.38, 5.5, 0x8b7356, 7), blob(0.8, 0.6, 0.8, 0, 5.7, 0, 0x8b7356), ...crown(12, 4.2, 0.7, 0.6, 1.4, 5.9, WHITE))],
    tone: { h: [0.2, 0.26], s: 0.45, l: [0.3, 0.38] },
    stretch: 0.2,
  });
  add({
    id: 'ponga',
    variants: [
      merge(trunk(0.24, 0.2, 3.4, 0x4d3c2e, 6), ...crown(8, 2.6, 0.7, 0.35, 0.8, 3.4, WHITE)),
      merge(trunk(0.22, 0.2, 2.2, 0x4d3c2e, 6), ...crown(7, 2.3, 0.65, 0.4, 0.8, 2.2, WHITE, 0.4)),
    ],
    tone: { h: [0.24, 0.3], s: 0.42, l: [0.32, 0.42] },
    stretch: 0.3,
  });
  add({
    id: 'cabbage',
    variants: [
      merge(
        trunk(0.22, 0.18, 3.4, 0x7a6e5e),
        paint(new THREE.CylinderGeometry(0.1, 0.14, 1.4, 5).translate(0, 0.7, 0).rotateZ(0.5).translate(0.05, 3.3, 0), 0x7a6e5e),
        paint(new THREE.CylinderGeometry(0.1, 0.14, 1.3, 5).translate(0, 0.65, 0).rotateZ(-0.55).translate(-0.05, 3.3, 0), 0x7a6e5e),
        paint(new THREE.OctahedronGeometry(1, 0).scale(0.9, 0.7, 0.9).translate(0.65, 4.6, 0), WHITE),
        paint(new THREE.OctahedronGeometry(1, 0).scale(0.85, 0.65, 0.85).rotateY(0.6).translate(-0.7, 4.5, 0), WHITE),
      ),
    ],
    tone: { h: [0.18, 0.24], s: 0.35, l: [0.42, 0.52] },
    stretch: 0.3,
  });
  add({
    id: 'shrub',
    variants: [merge(blob(1.0, 0.75, 1.0, 0, 0.55, 0, WHITE), blob(0.7, 0.55, 0.7, 0.6, 0.45, 0.3, 0xf0f0f0, 1)), blob(0.8, 0.9, 0.8, 0, 0.7, 0, WHITE, 0.5)],
    tone: { h: [0.26, 0.33], s: 0.38, l: [0.22, 0.34] },
    stretch: 0.3,
    shadow: false,
  });
  add({
    id: 'flax',
    variants: [
      merge(
        ...Array.from({ length: 9 }, (_, i) =>
          paint(new THREE.BoxGeometry(0.12, 1.7, 0.03).translate(0, 0.85, 0).rotateZ(0.12 + (i % 3) * 0.14).rotateY((i / 9) * Math.PI * 2), WHITE),
        ),
      ),
    ],
    tone: { h: [0.2, 0.26], s: 0.3, l: [0.26, 0.34] },
    stretch: 0.3,
    shadow: false,
  });
  add({
    id: 'tussock',
    variants: [merge(...Array.from({ length: 6 }, (_, i) => paint(new THREE.ConeGeometry(0.12, 0.8, 3).translate(0, 0.4, 0).rotateZ(0.3).rotateY((i / 6) * Math.PI * 2), WHITE)))],
    tone: { h: [0.13, 0.17], s: 0.35, l: [0.52, 0.64] },
    stretch: 0.4,
    shadow: false,
  });

  // Ground things.
  add({
    id: 'rock',
    variants: [
      paint(new THREE.IcosahedronGeometry(1, 0).scale(1.2, 0.7, 1.0).translate(0, 0.3, 0), WHITE),
      paint(new THREE.DodecahedronGeometry(1, 0).scale(0.9, 0.6, 1.3).translate(0, 0.25, 0), WHITE),
    ],
    tone: { h: [0.08, 0.12], s: 0.06, l: [0.28, 0.42] },
  });
  add({
    id: 'driftwood',
    variants: [
      merge(paint(new THREE.CylinderGeometry(0.16, 0.22, 3.2, 5).rotateZ(Math.PI / 2).translate(0, 0.15, 0), WHITE), paint(new THREE.CylinderGeometry(0.07, 0.1, 1.1, 4).rotateZ(Math.PI / 2).rotateY(0.7).translate(0.9, 0.18, 0.3), WHITE)),
    ],
    tone: { h: [0.07, 0.1], s: 0.15, l: [0.6, 0.75] },
    shadow: false,
  });
  add({
    id: 'flowerbed',
    variants: [
      merge(
        paint(new THREE.CylinderGeometry(2.2, 2.3, 0.2, 10).scale(1.4, 1, 1).translate(0, 0.08, 0), 0x6a4e38),
        ...Array.from({ length: 10 }, (_, i) => {
          const a = (i / 10) * Math.PI * 2;
          const r = i % 2 ? 1.6 : 0.8;
          return blob(0.45, 0.35, 0.45, Math.cos(a) * r * 1.4, 0.35, Math.sin(a) * r, [0xd8403a, 0xf0c040, 0xe07aa8, 0xf4f0e8][i % 4]);
        }),
      ),
    ],
    shadow: false,
  });

  // Cemetery. Headstones face +x (their inscription side), so 'face: path' turns them to the path.
  const stone = (g: THREE.BufferGeometry) => paint(g, WHITE);
  add({
    id: 'headstone',
    variants: [
      // Slab.
      merge(stone(new THREE.BoxGeometry(0.12, 0.95, 0.62).translate(0, 0.42, 0)), stone(new THREE.BoxGeometry(0.3, 0.12, 0.8).translate(0, 0.04, 0))),
      // Round-topped.
      merge(stone(new THREE.BoxGeometry(0.12, 0.7, 0.6).translate(0, 0.35, 0)), stone(new THREE.CylinderGeometry(0.3, 0.3, 0.12, 8, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateY(Math.PI / 2).rotateX(Math.PI / 2).translate(0, 0.7, 0))),
      // Cross.
      merge(stone(new THREE.BoxGeometry(0.12, 1.2, 0.16).translate(0, 0.6, 0)), stone(new THREE.BoxGeometry(0.12, 0.16, 0.66).translate(0, 0.86, 0)), stone(new THREE.BoxGeometry(0.4, 0.2, 0.5).translate(0, 0.1, 0))),
      // Obelisk on a plinth.
      merge(stone(new THREE.BoxGeometry(0.6, 0.45, 0.6).translate(0, 0.22, 0)), stone(new THREE.CylinderGeometry(0.12, 0.22, 1.5, 4).rotateY(Math.PI / 4).translate(0, 1.2, 0)), stone(new THREE.ConeGeometry(0.16, 0.3, 4).rotateY(Math.PI / 4).translate(0, 2.1, 0))),
      // Ledger: a slab lying flat over the grave.
      stone(new THREE.BoxGeometry(1.9, 0.2, 0.85).translate(-0.6, 0.1, 0)),
    ],
    tone: { h: [0.08, 0.14], s: 0.08, l: [0.55, 0.78] },
    shadow: true,
  });
  {
    const rail = 0x2c3034;
    const parts: THREE.BufferGeometry[] = [];
    const [w, d, h] = [1.6, 2.6, 0.75];
    for (const [x, z, len, rot] of [[-w / 2, 0, d, 0], [w / 2, 0, d, 0], [0, -d / 2, w, Math.PI / 2], [0, d / 2, w, Math.PI / 2]] as const) {
      parts.push(paint(new THREE.BoxGeometry(0.05, 0.05, len).rotateY(rot).translate(x, h, z), rail));
      parts.push(paint(new THREE.BoxGeometry(0.05, 0.05, len).rotateY(rot).translate(x, 0.12, z), rail));
      const n = Math.round(len / 0.22);
      for (let i = 0; i <= n; i++) {
        const t = -len / 2 + (i / n) * len;
        parts.push(paint(new THREE.BoxGeometry(0.025, h + 0.12, 0.025).translate(rot ? t : x, (h + 0.12) / 2, rot ? z : t), rail));
      }
    }
    for (const [x, z] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]]) parts.push(paint(new THREE.BoxGeometry(0.1, h + 0.25, 0.1).translate(x, (h + 0.25) / 2, z), rail));
    parts.push(paint(new THREE.BoxGeometry(0.14, 1.1, 1.0).translate(-w / 2 + 0.2, 0.55, 0), 0xc9c2b2));
    parts.push(paint(new THREE.BoxGeometry(w - 0.2, 0.12, d - 0.2).translate(0, 0.06, 0), 0x6f7a5a));
    add({ id: 'plot', variants: [merge(...parts).rotateY(Math.PI / 2)], shadow: true });
  }

  // Street furniture.
  const lampPole = merge(box(0.16, 8, 0.16, 0, 4, 0, 0x5c6470), box(1.9, 0.1, 0.1, 0.9, 7.95, 0, 0x5c6470));
  const lampHead = box(0.75, 0.14, 0.32, 1.75, 7.84, 0, WHITE);
  const pool = new THREE.CircleGeometry(10, 20).rotateX(-Math.PI / 2).translate(1.75, 0.1, 0);
  add({ id: 'lamp', variants: [lampPole], lamp: { head: lampHead, pool } });
  add({ id: 'mast', variants: [lampPole], lamp: { head: lampHead, pool } });
  add({
    id: 'lamp.heritage',
    variants: [
      merge(
        box(0.36, 0.5, 0.36, 0, 0.25, 0, 0x22302a),
        paint(new THREE.CylinderGeometry(0.07, 0.11, 3.6, 6).translate(0, 2.1, 0), 0x22302a),
        box(0.34, 0.06, 0.34, 0, 3.92, 0, 0x22302a),
        paint(new THREE.ConeGeometry(0.32, 0.3, 4).rotateY(Math.PI / 4).translate(0, 4.62, 0), 0x22302a),
      ),
    ],
    lamp: { head: box(0.3, 0.5, 0.3, 0, 4.2, 0, WHITE), pool: new THREE.CircleGeometry(6, 16).rotateX(-Math.PI / 2).translate(0, 0.1, 0) },
  });
  add({
    id: 'signal',
    variants: [
      merge(
        box(0.14, 3.3, 0.14, 0, 1.65, 0, 0x4b5058),
        box(0.3, 1.05, 0.36, 0, 3.8, 0, 0x23262b),
        box(0.06, 0.22, 0.22, 0.17, 4.12, 0, 0xd8402f),
        box(0.06, 0.22, 0.22, 0.17, 3.8, 0, 0xe0a020),
        box(0.06, 0.22, 0.22, 0.17, 3.48, 0, 0x35b05a),
      ),
    ],
  });
  add({
    id: 'bench',
    variants: [
      merge(
        box(0.45, 0.06, 1.8, 0, 0.45, 0, 0x9a6b42),
        box(0.06, 0.4, 1.8, -0.22, 0.75, 0, 0x9a6b42),
        box(0.4, 0.45, 0.06, 0, 0.22, -0.8, 0x2c3034),
        box(0.4, 0.45, 0.06, 0, 0.22, 0.8, 0x2c3034),
      ),
    ],
  });
  add({ id: 'bin', variants: [merge(paint(new THREE.CylinderGeometry(0.28, 0.25, 0.95, 8).translate(0, 0.48, 0), 0x2f4d3a), paint(new THREE.CylinderGeometry(0.31, 0.31, 0.08, 8).translate(0, 0.98, 0), 0x22302a))] });
  return kits;
}

let built: Map<string, Kit> | undefined;

export function kits(): Map<string, Kit> {
  built ??= new Map(build().map((k) => [k.id, k]));
  return built;
}

/** The colour an instance of a kit takes, from a tone and a 0..1 tint. */
export function toneColour(tone: Tone, tint: number, out: THREE.Color): THREE.Color {
  if (tone.flower && ((tint * 13.37) % 1) < tone.flower) return out.setHex(0xc63d3d);
  return out.setHSL(tone.h[0] + (tone.h[1] - tone.h[0]) * tint, tone.s, tone.l[0] + (tone.l[1] - tone.l[0]) * ((tint * 7) % 1));
}
