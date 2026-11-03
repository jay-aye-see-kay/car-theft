import type { DriveControls } from './car.ts';
import { tune } from './tweaks.ts';

// Merges keyboard, on-screen touch controls and gamepad into one set of
// controls. The touch layout switches between on-foot and driving.
//
// Keyboard: WASD/arrows move or drive, Space jumps or handbrakes, Shift
// sprints, F/Enter gets in or out, R flips the car, N mutes (M and Tab are
// the map, see map/full-map.ts). Flying (a cheat, see cheats.ts): Space
// climbs, C or Ctrl descends, Shift goes fast. Mouse: click the view to lock
// the pointer, then it looks round (like a PC shooter; Esc lets it go);
// the wheel zooms; C or the middle button looks behind in a car or boat.
// Gamepad (standard mapping): left stick, RT/LT pedals, A jump/handbrake,
// X sprint, Y in/out, Back flips the car, right stick looks, R3 looks behind;
// flying, A climbs and B descends. Touch, flying: JUMP becomes UP and RUN
// becomes DOWN.

/** Look: how the mouse, drag and right stick turn the camera, and how soon it comes back behind you. */
export const LOOK = {
  /** Locked mouse, degrees per pixel moved. */
  sensitivity: 0.15,
  /** Drag (touch, or a mouse when the pointer can't be locked), degrees per pixel. */
  dragSensitivity: 0.34,
  /** Right stick at full tilt, degrees per second. */
  stickSpeed: 300,
  /** 1 flips up and down. */
  invertY: 0,
  /** Seconds after you last looked before the camera comes back behind you; 0 never does. */
  recentreDelay: 1.5,
  /** Seconds it takes to ease back to full follow once it starts. */
  recentreTime: 1,
};
tune('camera-look', 'Camera: look', LOOK, {
  sensitivity: { label: 'Mouse sensitivity', min: 0.02, max: 0.6, step: 0.01, unit: '°/px' },
  dragSensitivity: { label: 'Drag sensitivity', min: 0.05, max: 1, step: 0.01, unit: '°/px' },
  stickSpeed: { label: 'Stick look speed', min: 60, max: 600, step: 10, unit: '°/s' },
  invertY: { label: 'Invert up/down (1 = on)', min: 0, max: 1, step: 1 },
  recentreDelay: { label: 'Back behind after (0 = never)', min: 0, max: 6, step: 0.1, unit: 's' },
  recentreTime: { label: 'Eases back over', min: 0.1, max: 4, step: 0.1, unit: 's' },
});

const DEG = Math.PI / 180;
/** Wheel zoom range: a multiple of the profile's distance behind. */
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.5;

export type Mode = 'foot' | 'car';

const pressed = (pad: Gamepad, i: number) => !!pad.buttons[i]?.pressed;

export class Input {
  readonly drive: DriveControls = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  /** Stick/keys: x is right, y is forward, each -1..1. */
  moveX = 0;
  moveY = 0;
  sprint = false;
  /** Space / A / jump button held (jump on foot, handbrake in a car). */
  action = false;
  /** Flying: climb (+1) or descend (-1). */
  rise = 0;

  // One-shot presses, cleared by consume().
  private edges = new Set<'enterExit' | 'reset' | 'jump' | 'mute'>();

  private readonly keys = new Set<string>();
  private readonly touch = { x: 0, y: 0, gas: false, brake: false, action: false, sprint: false };
  private readonly padHeld = new Set<number>();
  private readonly root: HTMLElement;
  private ui: HTMLElement | null = null;
  private mode: Mode = 'foot';
  private flying = false;
  /** Look input since the last consumeLook(), radians. */
  private lookX = 0;
  private lookY = 0;
  private padLookX = 0;
  private padLookY = 0;
  private padBehind = false;
  private middleHeld = false;
  /** Pointer lock is allowed now (the game's running and not paused). */
  private lockAllowed = false;
  private lookEl: HTMLElement | null = null;
  /** Mouse wheel zoom: multiplies the camera's distance behind. */
  zoom = 1;

  constructor(root: HTMLElement) {
    this.root = root;
    addEventListener('keydown', (e) => {
      if (!e.repeat) {
        if (e.code === 'KeyF' || e.code === 'Enter' || e.code === 'KeyE') this.edges.add('enterExit');
        if (e.code === 'KeyR') this.edges.add('reset');
        if (e.code === 'Space') this.edges.add('jump');
        if (e.code === 'KeyN') this.edges.add('mute');
      }
      this.keys.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => {
      this.keys.clear();
      this.middleHeld = false;
    });

    const touchy = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    if (touchy) this.buildTouchUi();
    else addEventListener('touchstart', () => this.buildTouchUi(), { once: true });
  }

  /**
   * Look around: with a mouse, a click on the game view locks the pointer and
   * from then on moving it looks (no button held); touch, or a mouse whose
   * lock is refused, drags instead. The wheel zooms, the middle button looks behind.
   */
  attachLook(el: HTMLElement): void {
    this.lookEl = el;
    let active: number | null = null;
    let lastX = 0;
    let lastY = 0;
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') {
        if (e.button === 1) {
          this.middleHeld = true;
          e.preventDefault(); // no autoscroll
        }
        if (!this.locked) this.lock();
      }
      if (active !== null || this.locked) return;
      active = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== active || this.locked) return;
      this.addLook((e.clientX - lastX) * LOOK.dragSensitivity * DEG, (e.clientY - lastY) * LOOK.dragSensitivity * DEG);
      lastX = e.clientX;
      lastY = e.clientY;
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === active) active = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    addEventListener('mouseup', (e) => {
      if (e.button === 1) this.middleHeld = false;
    });
    // Locked, the pointer doesn't move, so movementX/Y is all there is.
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // Some browsers report one huge jump as the lock takes hold.
      const clamp = (v: number) => Math.max(-250, Math.min(250, v));
      this.addLook(clamp(e.movementX) * LOOK.sensitivity * DEG, clamp(e.movementY) * LOOK.sensitivity * DEG);
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      // Pixels, lines or pages: a notch is about 100 px either way.
      const dy = e.deltaMode === 0 ? e.deltaY : e.deltaY * 40;
      this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoom * Math.exp(dy * 0.0012)));
    }, { passive: false });
    el.addEventListener('auxclick', (e) => e.button === 1 && e.preventDefault());
  }

  private addLook(x: number, y: number): void {
    this.lookX += x;
    this.lookY += LOOK.invertY ? -y : y;
  }

  /** The mouse is captured by the game view. */
  get locked(): boolean {
    return !!this.lookEl && document.pointerLockElement === this.lookEl;
  }

  /**
   * Whether the game may hold the pointer: off on the title screen and while
   * paused (the ? panel, the full map), so the cursor's there to click with.
   */
  allowLock(allowed: boolean): void {
    this.lockAllowed = allowed;
    if (!allowed && this.locked) document.exitPointerLock();
  }

  /** Capture the mouse (needs a click or key press to be in progress). */
  lock(): void {
    const el = this.lookEl;
    if (!el || !this.lockAllowed || this.locked || !el.requestPointerLock) return;
    // Raw movement (no OS acceleration) where offered, else plain. Older
    // browsers return nothing rather than a promise.
    const plain = () => void el.requestPointerLock()?.catch(() => {});
    const raw = el.requestPointerLock({ unadjustedMovement: true }) as Promise<void> | undefined;
    if (raw) raw.catch(plain);
  }

  /** Radians to turn the camera (x: right, y: down) since the last call: mouse, drag and right stick. */
  consumeLook(dt: number): { x: number; y: number } {
    const stick = LOOK.stickSpeed * DEG * dt;
    const x = this.lookX + this.padLookX * stick;
    const y = this.lookY + this.padLookY * stick * (LOOK.invertY ? -1 : 1);
    this.lookX = this.lookY = 0;
    return { x, y };
  }

  /** ?debug: look as if the mouse moved this many radians. */
  injectLook(x: number, y: number): void {
    this.lookX += x;
    this.lookY += y;
  }

  /** C, the middle mouse button or R3 held: look behind (in a car or boat). */
  get lookBehind(): boolean {
    return this.keys.has('KeyC') || this.middleHeld || this.padBehind;
  }

  /** True once per press. */
  consume(edge: 'enterExit' | 'reset' | 'jump' | 'mute'): boolean {
    return this.edges.delete(edge);
  }

  /** Drop any presses queued up, e.g. the key that dismissed the title screen. */
  clearPresses(): void {
    this.edges.clear();
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.ui?.setAttribute('data-mode', mode);
  }

  /** Flying swaps the touch RUN button for DOWN (and JUMP reads UP). */
  setFlying(on: boolean): void {
    this.flying = on;
    this.ui?.toggleAttribute('data-flying', on);
  }

  /** Light up the in/out button when there's a car to get into. */
  setCanEnter(can: boolean): void {
    this.ui?.querySelector('.btn-enter')?.classList.toggle('ready', can);
  }

  update(): void {
    const k = this.keys;
    const up = k.has('KeyW') || k.has('ArrowUp');
    const down = k.has('KeyS') || k.has('ArrowDown');
    const right = k.has('KeyD') || k.has('ArrowRight');
    const left = k.has('KeyA') || k.has('ArrowLeft');

    let moveX = (right ? 1 : 0) - (left ? 1 : 0);
    let moveY = (up ? 1 : 0) - (down ? 1 : 0);
    if (moveX === 0 && moveY === 0) {
      moveX = this.touch.x;
      moveY = this.touch.y;
    }
    let throttle = up || this.touch.gas ? 1 : 0;
    let brake = down || this.touch.brake ? 1 : 0;
    let action = k.has('Space') || this.touch.action;
    let sprint = k.has('ShiftLeft') || k.has('ShiftRight') || (this.touch.sprint && !this.flying);
    let descend = k.has('KeyC') || k.has('ControlLeft') || k.has('ControlRight') || (this.touch.sprint && this.flying);

    this.padLookX = this.padLookY = 0;
    this.padBehind = false;
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad || pad.mapping !== 'standard') continue;
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      if (Math.hypot(ax, ay) > 0.15 && moveX === 0 && moveY === 0) {
        moveX = ax;
        moveY = -ay;
      }
      const rx = pad.axes[2] ?? 0;
      const ry = pad.axes[3] ?? 0;
      if (Math.hypot(rx, ry) > 0.15) {
        this.padLookX = rx;
        this.padLookY = ry;
      }
      this.padBehind = pressed(pad, 11);
      throttle = Math.max(throttle, pad.buttons[7]?.value ?? 0);
      brake = Math.max(brake, pad.buttons[6]?.value ?? 0);
      action ||= pressed(pad, 0);
      sprint ||= pressed(pad, 2);
      descend ||= pressed(pad, 1);
      const edge = (i: number, name: 'enterExit' | 'reset' | 'jump') => {
        if (pressed(pad, i) && !this.padHeld.has(i)) this.edges.add(name);
        if (pressed(pad, i)) this.padHeld.add(i);
        else this.padHeld.delete(i);
      };
      edge(3, 'enterExit');
      edge(8, 'reset');
      edge(0, 'jump');
      break;
    }

    this.moveX = moveX;
    this.moveY = moveY;
    this.action = action;
    this.sprint = sprint;
    this.rise = (action ? 1 : 0) - (descend ? 1 : 0);
    Object.assign(this.drive, { throttle, brake, steer: moveX, handbrake: action });
  }

  private buildTouchUi(): void {
    if (this.ui) return;
    const ui = document.createElement('div');
    ui.className = 'touch';
    ui.setAttribute('data-mode', this.mode);
    ui.toggleAttribute('data-flying', this.flying);
    ui.innerHTML = `
      <div class="stick"><div class="stick-knob"></div></div>
      <button class="btn btn-enter" aria-label="Get in or out">🚗</button>
      <button class="btn btn-reset car-only" aria-label="Flip car">⟲</button>
      <button class="btn btn-action" aria-label="Handbrake or jump"><span class="car-only">HB</span><span class="foot-only walk-only">JUMP</span><span class="foot-only fly-only">UP</span></button>
      <button class="btn btn-brake car-only" aria-label="Brake / reverse">◀</button>
      <button class="btn btn-gas car-only" aria-label="Accelerate">▲</button>
      <button class="btn btn-sprint foot-only" aria-label="Sprint"><span class="walk-only">RUN</span><span class="fly-only">DOWN</span></button>
    `;
    this.root.appendChild(ui);
    this.ui = ui;

    const hold = (sel: string, set: (on: boolean) => void) => {
      const el = ui.querySelector<HTMLElement>(sel)!;
      el.addEventListener('pointerdown', (e) => {
        el.setPointerCapture(e.pointerId);
        el.classList.add('down');
        set(true);
      });
      const up = () => {
        el.classList.remove('down');
        set(false);
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    };
    hold('.btn-gas', (on) => (this.touch.gas = on));
    hold('.btn-brake', (on) => (this.touch.brake = on));
    hold('.btn-sprint', (on) => (this.touch.sprint = on));
    hold('.btn-action', (on) => {
      this.touch.action = on;
      if (on) this.edges.add('jump');
    });
    hold('.btn-reset', (on) => on && this.edges.add('reset'));
    hold('.btn-enter', (on) => on && this.edges.add('enterExit'));

    // Analogue stick. Driving only uses x; on foot it's a full 2D stick.
    const stick = ui.querySelector<HTMLElement>('.stick')!;
    const knob = ui.querySelector<HTMLElement>('.stick-knob')!;
    let active: number | null = null;
    let ox = 0;
    let oy = 0;
    const radius = 56;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== active) return;
      let dx = e.clientX - ox;
      let dy = e.clientY - oy;
      if (this.mode === 'car') dy = 0;
      const d = Math.hypot(dx, dy);
      if (d > radius) {
        dx *= radius / d;
        dy *= radius / d;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const curve = (v: number) => Math.sign(v) * Math.min(1, Math.abs(v) * 1.15);
      this.touch.x = curve(dx / radius);
      this.touch.y = curve(-dy / radius);
    };
    stick.addEventListener('pointerdown', (e) => {
      active = e.pointerId;
      stick.setPointerCapture(e.pointerId);
      const r = stick.getBoundingClientRect();
      ox = r.left + r.width / 2;
      oy = r.top + r.height / 2;
      move(e);
    });
    stick.addEventListener('pointermove', move);
    const release = (e: PointerEvent) => {
      if (e.pointerId !== active) return;
      active = null;
      this.touch.x = this.touch.y = 0;
      knob.style.transform = '';
    };
    stick.addEventListener('pointerup', release);
    stick.addEventListener('pointercancel', release);
  }
}
