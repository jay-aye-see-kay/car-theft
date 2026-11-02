import * as THREE from 'three';

// Speech bubbles over people's heads ("Oi!"): a few HUD elements reused,
// placed each frame by projecting the head into the screen.

const POOL = 6;
/** Not shown past this from the camera, m. */
const RANGE = 60;

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export class Bubbles {
  private readonly els: HTMLElement[] = [];

  constructor(hud: HTMLElement) {
    const box = document.createElement('div');
    box.className = 'bubbles';
    hud.appendChild(box);
    for (let i = 0; i < POOL; i++) {
      const el = document.createElement('div');
      el.className = 'bubble hidden';
      box.appendChild(el);
      this.els.push(el);
    }
  }

  /** Everyone speaking right now: where their head is and what they say. Nearest first get the bubbles. */
  update(speakers: { x: number; y: number; z: number; text: string }[], camera: THREE.PerspectiveCamera): void {
    const w = document.documentElement.clientWidth;
    const h = document.documentElement.clientHeight;
    camera.getWorldDirection(_fwd);
    const shown = speakers
      .map((s) => ({ s, d: _v.set(s.x, s.y, s.z).distanceTo(camera.position) }))
      .filter(({ s, d }) => d < RANGE && _v.set(s.x, s.y, s.z).sub(camera.position).dot(_fwd) > 0)
      .sort((a, b) => a.d - b.d);
    for (const [i, el] of this.els.entries()) {
      const item = shown[i];
      el.classList.toggle('hidden', !item);
      if (!item) continue;
      if (el.textContent !== item.s.text) el.textContent = item.s.text;
      _v.set(item.s.x, item.s.y, item.s.z).project(camera);
      el.style.transform = `translate(${(((_v.x + 1) / 2) * w).toFixed(0)}px, ${(((1 - _v.y) / 2) * h).toFixed(0)}px) translate(-50%, -100%)`;
    }
  }
}
