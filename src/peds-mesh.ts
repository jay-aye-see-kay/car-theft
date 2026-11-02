import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PARTS, PIVOTS, partGeometry } from './player.ts';
import type { Ped } from './peds.ts';

// Everyone on the footpaths in one instanced draw call (plus one for their
// blob shadows). The player's body plan with every part in one geometry:
// the vertex shader swings each part about its pivot by a per-person pose,
// and colours each box from that person's outfit.

const MAX = 48;
/** Not drawn past this from the camera, m. */
const DRAW = 160;
/** Lying on their back: the torso is this thick, so lift it clear of the ground, m. */
const LIE_LIFT = 0.14;
/** On a bicycle: feet up on the pedals, m. */
const RIDE_LIFT = 0.3;
/** Officers' tackles: flat out forward this far, rad. */
const DIVE = 1.25;

// Palettes the shader picks from (indices in peds.ts's Look).
// The last "hair" is a police cap (peds.ts COP_HAT).
const HAIR = [0x16100b, 0x3b2414, 0x6b4423, 0xc9a35a, 0x9a9a98, 0x9c4a1e, 0x161c30];
const SHOES = [0x1c1c1f, 0xeeeeea, 0x2a6fd6, 0x6b4a2e];

const glslColours = (name: string, list: number[]) =>
  `const vec3 ${name}[${list.length}] = vec3[](${list.map((c) => {
    const k = new THREE.Color(c);
    return `vec3(${k.r.toFixed(4)}, ${k.g.toFixed(4)}, ${k.b.toFixed(4)})`;
  }).join(', ')});`;

function bodyGeometry(): THREE.BufferGeometry {
  const parts = PARTS.map((part, i) => {
    const g = partGeometry(part);
    // Model space from the feet: arms hang off the torso's pivot.
    const [x, y, z] = PIVOTS[part];
    const lift = part === 'armL' || part === 'armR' ? PIVOTS.torso[1] : 0;
    g.translate(x, y + lift, z);
    g.setAttribute('part', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(i), 1));
    return g;
  });
  return mergeGeometries(parts);
}

function material(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial();
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = `
      attribute float part;
      attribute float slot;
      attribute vec4 pose;
      attribute vec4 skin;
      attribute vec4 top;
      attribute vec4 bottom;
      varying vec3 vPedColor;
      ${glslColours('HAIR', HAIR)}
      ${glslColours('SHOES', SHOES)}
      vec2 rotz(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(p.x * c - p.y * s, p.x * s + p.y * c); }
      ${shader.vertexShader}`
      .replace('#include <beginnormal_vertex>', `
        vec3 objectNormal = normal;
        vec3 pedP = position;
        // Legs from the hips; arms from the shoulders, then with the torso.
        if (part > 0.5 && part < 2.5) {
          float a = part < 1.5 ? pose.x : -pose.x;
          vec2 piv = vec2(0.0, ${PIVOTS.legL[1].toFixed(3)});
          pedP.xy = rotz(pedP.xy - piv, a) + piv;
          objectNormal.xy = rotz(objectNormal.xy, a);
        } else if (part > 2.5) {
          float a = part < 3.5 ? pose.y : pose.z;
          vec2 piv = vec2(0.0, ${(PIVOTS.torso[1] + PIVOTS.armL[1]).toFixed(3)});
          pedP.xy = rotz(pedP.xy - piv, a) + piv;
          objectNormal.xy = rotz(objectNormal.xy, a);
        }
        if (part < 0.5 || part > 2.5) {
          vec2 piv = vec2(0.0, ${PIVOTS.torso[1].toFixed(3)});
          pedP.xy = rotz(pedP.xy - piv, pose.w) + piv;
          objectNormal.xy = rotz(objectNormal.xy, pose.w);
        }
        // Slots: skin, top, bottom, hair, shoes, shin, forearm (player.ts SLOTS).
        vPedColor = skin.rgb;
        if (slot > 0.5 && slot < 1.5) vPedColor = top.rgb;
        else if (slot > 1.5 && slot < 2.5) vPedColor = bottom.rgb;
        else if (slot > 2.5 && slot < 3.5) vPedColor = HAIR[int(bottom.a + 0.5)];
        else if (slot > 3.5 && slot < 4.5) vPedColor = SHOES[int(skin.a + 0.5)];
        else if (slot > 4.5 && slot < 5.5) vPedColor = top.a > 1.5 ? bottom.rgb : skin.rgb;
        else if (slot > 5.5) vPedColor = mod(top.a, 2.0) > 0.5 ? top.rgb : skin.rgb;
      `)
      .replace('#include <begin_vertex>', 'vec3 transformed = pedP;');
    shader.fragmentShader = `varying vec3 vPedColor;\n${shader.fragmentShader}`.replace(
      '#include <color_fragment>',
      'diffuseColor.rgb *= vPedColor;',
    );
  };
  return m;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _side = new THREE.Vector3(0, 0, 1);
/** Lying on their back, feet where they stood: rotated about their own left-right axis. */
const LYING = new THREE.Quaternion().setFromAxisAngle(_side, Math.PI / 2);
/** The middle of the body, which tumbling spins about, m above the feet. */
const MIDDLE = 0.9;

export class PedsMesh {
  readonly mesh: THREE.InstancedMesh;
  readonly shadows: THREE.InstancedMesh;
  private readonly pose: THREE.InstancedBufferAttribute;
  private readonly skin: THREE.InstancedBufferAttribute;
  private readonly top: THREE.InstancedBufferAttribute;
  private readonly bottom: THREE.InstancedBufferAttribute;
  private time = 0;

  constructor(shadowMat: THREE.Material) {
    const g = bodyGeometry();
    const inst = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(MAX * n), n).setUsage(THREE.DynamicDrawUsage);
    this.pose = inst(4);
    this.skin = inst(4);
    this.top = inst(4);
    this.bottom = inst(4);
    g.setAttribute('pose', this.pose);
    g.setAttribute('skin', this.skin);
    g.setAttribute('top', this.top);
    g.setAttribute('bottom', this.bottom);
    this.mesh = new THREE.InstancedMesh(g, material(), MAX);
    this.mesh.name = 'peds';
    // They move every frame: the cached bounding sphere would be stale.
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;

    this.shadows = new THREE.InstancedMesh(new THREE.CircleGeometry(0.38, 10).rotateX(-Math.PI / 2), shadowMat, MAX);
    this.shadows.name = 'shadow peds';
    this.shadows.frustumCulled = false;
    this.shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shadows.count = 0;
  }

  /** Draw everyone near the camera, `alpha` of the way from last tick's pose to this one's. */
  update(peds: readonly Ped[], alpha: number, dt: number, camera: THREE.Vector3, stars: (x: number, y: number, z: number, amount: number, time: number) => void): void {
    this.time += dt;
    let n = 0;
    for (const p of peds) {
      if (n >= MAX) break;
      _p.set(p.px + (p.x - p.px) * alpha, p.py + (p.y - p.py) * alpha, p.pz + (p.z - p.pz) * alpha);
      if (_p.distanceTo(camera) > DRAW) continue;
      const k = p.look.height;
      _s.set(p.look.build, k, p.look.build);
      const facing = _q2.setFromAxisAngle(_up, p.heading);
      let lift = 0;
      if (p.state === 'fly') {
        // Tumbling about the middle of the body.
        _q.slerpQuaternions(p.pq, p.q, alpha).multiply(facing);
        _c.set(0, MIDDLE * k, 0).applyQuaternion(_q);
        _p.y += MIDDLE * k;
        _p.sub(_c);
      } else if (p.state === 'down') {
        // Settle from however they landed onto their back.
        _q.copy(facing).multiply(LYING);
        if (p.t < 0.2) _q.slerpQuaternions(p.q.clone().multiply(facing), _q, p.t / 0.2);
        lift = LIE_LIFT;
      } else if (p.state === 'getup') {
        const f = Math.min(1, p.t / 0.6);
        _q.copy(facing).multiply(_q3.identity().slerp(LYING, 1 - f * f));
        lift = LIE_LIFT * (1 - f);
      } else if (p.state === 'tackle') {
        // Diving at you: pitched forward about the hips.
        _q.copy(facing).multiply(_q3.setFromAxisAngle(_side, -DIVE * Math.min(1, p.t / 0.22)));
        lift = 0.25 * Math.min(1, p.t / 0.22);
      } else {
        _q.copy(facing);
        if (p.bike && (p.state === 'walk' || p.state === 'cop' || p.state === 'wait')) lift = RIDE_LIFT;
        if (p.dazed > 0 || p.state === 'stumble') {
          // Wobbling: the same drunken lean as the player.
          const w = p.state === 'stumble' ? 1 : Math.min(1, p.dazed);
          _q.multiply(_q3.setFromEuler(_e.set(Math.sin(this.time * 4.3 + p.id) * 0.16 * w, 0, Math.sin(this.time * 3.1 + p.id) * 0.12 * w)));
        }
      }
      _p.y += lift;
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(n, _m);
      this.pose.setXYZW(n, ...this.limbs(p));
      const l = p.look;
      this.skin.setXYZW(n, l.skin.r, l.skin.g, l.skin.b, l.shoes);
      this.top.setXYZW(n, l.top.r, l.top.g, l.top.b, (l.trousers ? 2 : 0) + (l.sleeves ? 1 : 0));
      this.bottom.setXYZW(n, l.bottom.r, l.bottom.g, l.bottom.b, l.hair);

      // A blob on the ground under them, smaller the higher they fly; long when they're lying down.
      const shrink = Math.max(0.35, 1 - (p.y - p.floor) / 6);
      _c.set(_p.x, p.floor + 0.04, _p.z);
      if (p.state === 'down') {
        _c.x -= Math.cos(p.heading) * 0.8;
        _c.z += Math.sin(p.heading) * 0.8;
        _m.compose(_c, facing, _s.set(2.4, 1, 1));
      } else _m.compose(_c, _q3.identity(), _s.set(shrink, 1, shrink));
      this.shadows.setMatrixAt(n, _m);

      if (p.dazed > 0) {
        // Over the head: at the top when standing, beyond it when lying on their back.
        const head = p.state === 'down' ? [_p.x - Math.cos(p.heading) * 1.7 * k, p.y + 0.45, _p.z + Math.sin(p.heading) * 1.7 * k] : [_p.x, _p.y + 1.95 * k, _p.z];
        stars(head[0], head[1], head[2], Math.min(1, p.dazed), this.time + p.id);
      }
      n++;
    }
    this.mesh.count = this.shadows.count = n;
    this.mesh.visible = this.shadows.visible = n > 0;
    if (!n) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.shadows.instanceMatrix.needsUpdate = true;
    for (const a of [this.pose, this.skin, this.top, this.bottom]) a.needsUpdate = true;
  }

  /** Leg swing, left and right arm, torso lean (rad) for what they're doing. */
  private limbs(p: Ped): [number, number, number, number] {
    const t = this.time + p.id * 0.37;
    if (p.bike && (p.state === 'walk' || p.state === 'cop' || p.state === 'wait')) {
      // Pedalling, leaning on the handlebars.
      return [Math.sin(p.phase) * 0.55, 0.95, 0.95, -0.3];
    }
    switch (p.state) {
      case 'cop': {
        // Running after you (or standing, when they've stopped).
        const run = Math.min(1, Math.hypot(p.vx, p.vz) / 5);
        const sw = Math.sin(p.phase) * (0.25 + 0.75 * run);
        return [sw, -sw * 0.9, sw * 0.9, -0.3 * run];
      }
      case 'tackle':
        return [-0.5, 2.6, 2.6, 0];
      case 'scold':
        // Wagging a finger at you.
        return [0, -0.1, 1.5 + Math.sin(t * 14) * 0.25, 0.05];
      case 'walk':
      case 'chase': {
        const amp = p.state === 'chase' ? 0.9 : 0.45;
        const sw = Math.sin(p.phase) * amp;
        return [sw, -sw * 0.9, sw * 0.9, p.state === 'chase' ? -0.25 : 0];
      }
      case 'fly':
        // Limbs everywhere.
        return [0.6 + Math.sin(t * 9) * 0.4, -2.4 + Math.sin(t * 7) * 0.5, 2.2 + Math.sin(t * 8) * 0.5, 0];
      case 'down':
        return [0.15, -1.3, 1.4, 0];
      case 'getup':
        return [0.3, -0.6, 0.6, -0.4];
      case 'stumble':
        return [Math.sin(t * 14) * 0.4, -1.6, 1.8, 0.2];
      case 'react':
        if (p.reaction === 'shrug') {
          // Dusting themselves off.
          return [0, 0.7 + Math.sin(t * 13) * 0.35, 0.5 + Math.sin(t * 13 + 1.5) * 0.35, -0.45];
        }
        // Shaking a fist overhead.
        return [0, -0.15, 2.7 + Math.sin(t * 20) * 0.3, 0.08];
      default:
        return [0, Math.sin(t * 1.3) * 0.05, -Math.sin(t * 1.3) * 0.05, 0];
    }
  }
}
