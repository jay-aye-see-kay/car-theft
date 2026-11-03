import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { LOOK } from './input.ts';
import { tune, type KnobSpec } from './tweaks.ts';

// GTA III-style follow camera: sits behind the target's heading, swings round
// lazily, pulls back and widens the FOV with speed, and ducks in front of
// walls instead of clipping through them. Profiles switch between driving and
// on-foot framing; the smoothing makes the switch a glide rather than a cut.
// You can look round it (mouse, drag, right stick), up and down too; once you
// leave it alone for LOOK.recentreDelay it eases back behind (GTA V on PC).

export interface CameraProfile {
  distance: number;
  height: number;
  lookHeight: number;
  lookAhead: number;
  followRate: number; // how quickly the camera swings behind, 1/s
  speedPullback: number; // extra distance per m/s
}

export const DRIVING: CameraProfile = { distance: 6.5, height: 2.4, lookHeight: 1.1, lookAhead: 2, followRate: 3.5, speedPullback: 0.07 };
export const ON_FOOT: CameraProfile = { distance: 4.2, height: 1.9, lookHeight: 1.55, lookAhead: 0.6, followRate: 1.6, speedPullback: 0.05 };
/** At a boat's helm: further back and higher, to see the swell and the wharves coming. */
export const BOATING_CAM: CameraProfile = { distance: 9, height: 3.2, lookHeight: 1.2, lookAhead: 4, followRate: 2.4, speedPullback: 0.08 };
/** Flying (cheat): further back and a little above, to take in whole buildings. */
export const FLYING: CameraProfile = { distance: 12, height: 3.5, lookHeight: 1, lookAhead: 2, followRate: 1.2, speedPullback: 0.04 };

const PROFILE_KNOBS: Record<keyof CameraProfile, KnobSpec> = {
  distance: { label: 'Distance behind', min: 1.5, max: 25, step: 0.1, unit: 'm' },
  height: { label: 'Height', min: 0.3, max: 10, step: 0.1, unit: 'm' },
  lookHeight: { label: 'Looks at, above', min: 0, max: 4, step: 0.05, unit: 'm' },
  lookAhead: { label: 'Looks ahead', min: 0, max: 10, step: 0.1, unit: 'm' },
  followRate: { label: 'Swings behind', min: 0.1, max: 10, step: 0.1, unit: '/s' },
  speedPullback: { label: 'Pulls back with speed', min: 0, max: 0.3, step: 0.005, unit: 'm per m/s' },
};
tune('camera-driving', 'Camera: driving', DRIVING, PROFILE_KNOBS);
tune('camera-foot', 'Camera: on foot', ON_FOOT, PROFILE_KNOBS);
tune('camera-flying', 'Camera: flying', FLYING, PROFILE_KNOBS);
tune('camera-boat', 'Camera: boat', BOATING_CAM, PROFILE_KNOBS);

/**
 * Field of view. A fixed vertical FOV makes the horizontal one grow with the
 * screen's width: ~87° on a 16:10 laptop but ~105° on a phone in landscape
 * (~2.2:1), which looks fish-eyed. So the horizontal FOV is capped at about
 * what a 16:10 laptop gets (playtested), and wider screens get a narrower vertical one.
 */
export const LENS = { fov: 62, maxWide: 86 };
tune('camera-lens', 'Camera: lens', LENS, {
  fov: { label: 'Field of view (vertical)', min: 30, max: 100, step: 1, unit: '°' },
  maxWide: { label: 'Widest across', min: 50, max: 140, step: 1, unit: '°' },
});

/** Vertical FOV, degrees, for a screen of this width / height. */
export function fitFov(aspect: number): number {
  const half = THREE.MathUtils.degToRad(LENS.fov / 2);
  const maxHalf = THREE.MathUtils.degToRad(LENS.maxWide / 2);
  const capped = Math.atan(Math.tan(maxHalf) / aspect);
  return THREE.MathUtils.radToDeg(2 * Math.min(half, capped));
}

const _fwd = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _from = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _up = { x: 0, y: 1, z: 0 };
/** How far under a ceiling the camera keeps, m (well past the near plane). */
const CEILING_GAP = 0.6;
/** Camera elevation about the target, radians: from just under it (looking up) to well above. */
const MIN_ELEVATION = -0.2;
const MAX_ELEVATION = 1.1;
/** Past MIN_ELEVATION, looking further up tilts the view instead of lowering the camera. */
const MAX_TILT = 0.75;

export class ChaseCamera {
  private yawAngle: number | null = null;
  private readonly smoothedPos = new THREE.Vector3();
  private readonly smoothedLook = new THREE.Vector3();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly world: RAPIER.World;
  private shakeAmount = 0;
  /** Dizzy: how far the view sways, 0..1, and its own clock (game time, so stepped tests repeat). */
  private swayAmount = 0;
  private swayTime = 0;
  private distance = DRIVING.distance;
  /** Look up (-) or down (+) from the profile's framing, radians. */
  private pitch = 0;
  /** Seconds since you last looked round by hand. */
  private sinceLook = Infinity;
  /** How far the follow is back on: 0 just after you look, 1 fully following. */
  private follow = 1;
  private wasBehind = false;
  private viewYaw = 0;
  /** Wheel zoom: multiplies the profile's distance behind. */
  zoom = 1;

  constructor(camera: THREE.PerspectiveCamera, world: RAPIER.World) {
    this.camera = camera;
    this.world = world;
  }

  /** Direction the camera faces, as atan2(z, x). Used for camera-relative walking. */
  get yaw(): number {
    if (this.yawAngle === null) return 0;
    return this.wasBehind ? this.viewYaw : this.yawAngle;
  }

  /** Looked round by hand and not yet fully back behind. */
  get looking(): boolean {
    return this.follow < 1;
  }

  /** ?debug: the look state. */
  debug(): { yaw: number; pitch: number; follow: number; sinceLook: number } {
    return { yaw: this.yaw, pitch: this.pitch, follow: this.follow, sinceLook: this.sinceLook };
  }

  /**
   * `follow`: whether the camera may swing in behind the target now (it
   * still waits for LOOK.recentreDelay after you last looked). `behind`:
   * look back over your shoulder (snaps there and back).
   */
  update(
    dt: number,
    profile: CameraProfile,
    target: THREE.Vector3,
    heading: number,
    speed: number,
    ignore: RAPIER.Collider,
    follow = true,
    behind = false,
  ): void {
    // heading rotates local +x about +y, so forward is (cos h, 0, -sin h).
    const targetYaw = Math.atan2(-Math.sin(heading), Math.cos(heading));
    if (this.yawAngle === null) this.yawAngle = targetYaw;
    this.sinceLook += dt;
    if (follow && LOOK.recentreDelay > 0 && this.sinceLook >= LOOK.recentreDelay) {
      this.follow = Math.min(1, this.follow + dt / Math.max(LOOK.recentreTime, 0.01));
    }
    // Ease in (smoothstep) so it starts back gently rather than with a jerk.
    const f = this.follow * this.follow * (3 - 2 * this.follow);
    if (follow && f > 0) {
      const delta = Math.atan2(Math.sin(targetYaw - this.yawAngle), Math.cos(targetYaw - this.yawAngle));
      this.yawAngle += delta * (1 - Math.exp(-dt * profile.followRate * f));
    }
    if (f > 0) this.pitch *= Math.exp(-dt * 3 * f);

    // Looking behind: straight back past the target, level, and a cut both ways
    // (swinging round would pass through the car).
    if (behind !== this.wasBehind) this.smoothedPos.set(0, 0, 0);
    this.wasBehind = behind;
    const yaw = behind ? targetYaw + Math.PI : this.yawAngle;
    this.viewYaw = yaw;

    const s = Math.abs(speed);
    const wantDistance = profile.distance * this.zoom + Math.min(s * profile.speedPullback, 3.5);
    this.distance += (wantDistance - this.distance) * (1 - Math.exp(-dt * 3));
    const height = profile.height + Math.min(s * 0.02, 1);
    // Orbit about a point above the target: the profile's framing is one
    // elevation; looking up or down moves the camera round from there.
    const rise = height - profile.lookHeight;
    const reach = Math.hypot(this.distance, rise);
    const framing = Math.atan2(rise, this.distance);
    // Keep the pitch within what shows, so looking back the other way answers at once.
    this.pitch = Math.max(MIN_ELEVATION - MAX_TILT - framing, Math.min(MAX_ELEVATION - framing, this.pitch));
    const wanted = framing + (behind ? 0 : this.pitch);
    const elevation = Math.min(MAX_ELEVATION, Math.max(MIN_ELEVATION, wanted));
    const tilt = Math.min(MAX_TILT, Math.max(0, MIN_ELEVATION - wanted));
    const dir = _fwd.set(Math.cos(yaw), 0, Math.sin(yaw));
    const back = reach * Math.cos(elevation);
    const up = reach * Math.sin(elevation);
    _look.copy(target).addScaledVector(dir, profile.lookAhead).y += profile.lookHeight + Math.tan(tilt) * (back + profile.lookAhead);
    _desired.copy(target).addScaledVector(dir, -back).y += profile.lookHeight + up;

    // Pull in if a building is between the target and the camera.
    _from.set(target.x, target.y + profile.lookHeight, target.z);
    // Under a low ceiling (the car park under Aotea Square), stay well below
    // it: pulled in along a near-level ray, the camera would sit just under
    // it, closer than the near plane, and see through.
    const roof = this.world.castRay(new RAPIER.Ray(_from, _up), Math.max(up, 0) + 1, true, undefined, undefined, ignore);
    if (roof) _desired.y = Math.min(_desired.y, _from.y + Math.max(roof.timeOfImpact - CEILING_GAP, 0));
    _toCam.copy(_desired).sub(_from);
    const len = _toCam.length();
    _toCam.divideScalar(len);
    const hit = this.world.castRay(new RAPIER.Ray(_from, _toCam), len, true, undefined, undefined, ignore);
    if (hit) _desired.copy(_from).addScaledVector(_toCam, Math.max(hit.timeOfImpact - 0.4, 1.2));

    const first = this.smoothedPos.lengthSq() === 0;
    this.smoothedPos.lerp(_desired, first ? 1 : 1 - Math.exp(-dt * 10));
    this.smoothedLook.lerp(_look, first ? 1 : 1 - Math.exp(-dt * 14));
    this.camera.position.copy(this.smoothedPos);
    this.camera.lookAt(this.smoothedLook);

    // Dizzy: a slow drunken lean and drift, no randomness.
    this.swayTime += dt;
    if (this.swayAmount > 0.001) {
      const a = this.swayAmount;
      const t = this.swayTime;
      _toCam.set(Math.cos(yaw), 0, Math.sin(yaw));
      this.camera.position.x += -_toCam.z * Math.sin(t * 1.3) * a * 0.9;
      this.camera.position.z += _toCam.x * Math.sin(t * 1.3) * a * 0.9;
      this.camera.position.y += Math.sin(t * 2.1) * a * 0.25;
      this.camera.rotateZ(Math.sin(t * 1.7) * a * 0.22);
    }

    if (this.shakeAmount > 0.01) {
      const a = this.shakeAmount;
      this.camera.position.x += (Math.random() - 0.5) * a;
      this.camera.position.y += (Math.random() - 0.5) * a;
      this.camera.rotation.z += (Math.random() - 0.5) * a * 0.05;
      this.shakeAmount *= Math.exp(-dt * 9);
    }

    // Widen with speed, in proportion, so a narrowed (landscape phone) lens widens no more across.
    const base = fitFov(this.camera.aspect);
    const fov = base * (1 + Math.min(s * 0.3, 14) / 62);
    if (Math.abs(fov - this.camera.fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-dt * 3));
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Turn the camera by hand, radians: x right, y down. Holds off following
   * for LOOK.recentreDelay, then it eases back behind.
   */
  look(x: number, y: number): void {
    if (x === 0 && y === 0) return;
    if (this.yawAngle !== null) this.yawAngle += x;
    this.pitch += y; // bounded in update()
    this.sinceLook = 0;
    this.follow = 0;
  }

  /** Jolt the camera, e.g. on a crash. Strength ~0..1. */
  shake(strength: number): void {
    this.shakeAmount = Math.min(1, Math.max(this.shakeAmount, strength));
  }

  /** Dizzy: sway the view this much (0..1) from now on; 0 stops. */
  sway(amount: number): void {
    this.swayAmount = amount;
  }

  /**
   * Snap straight behind the target on the next update (after a reset).
   * Given the target's new heading, the yaw is set now: on-foot movement
   * reads it before the next update, and with the old yaw (or none, which
   * reads as east) the first frame's steps go the wrong way and the camera
   * then follows them.
   */
  snap(heading?: number): void {
    this.yawAngle = heading === undefined ? null : Math.atan2(-Math.sin(heading), Math.cos(heading));
    this.viewYaw = this.yawAngle ?? 0;
    this.smoothedPos.set(0, 0, 0);
    this.pitch = 0;
    this.sinceLook = Infinity;
    this.follow = 1;
  }
}
