// The viewer's side of cells: generate the cells around the view, nearest first and a few per frame,
// and let go of the ones left far behind. Each cell is its own set of instanced meshes, so three.js skips
// the ones outside the camera (and outside the shadow camera) without being told.
import * as THREE from 'three';
import { type Cell, cellsOf } from '../gen/cells.ts';
import type { Instance } from '../gen/scatter.ts';
import { type Site, TREE_KITS, generateCell } from '../gen/site.ts';
import { type Kit, kits, toneColour } from '../kit/kits.ts';
import type { Stage } from './stage.ts';

/** Small things worth drawing only close up. Everything else is drawn as far as cells are loaded. */
const SMALL_KITS = new Set(['shrub', 'tussock', 'flax', 'rock', 'driftwood', 'headstone', 'plot', 'flowerbed', 'bench', 'bin']);

interface Loaded {
  cell: Cell;
  placed: Instance[];
  group: THREE.Group;
  small: THREE.Object3D[];
}

export interface CellStats {
  loaded: number;
  total: number;
  /** Instances placed in the loaded cells, per kit. */
  kits: Record<string, number>;
  trees: number;
  props: number;
}

export class CellView {
  readonly group = new THREE.Group();
  stats: CellStats = { loaded: 0, total: 0, kits: {}, trees: 0, props: 0 };
  /** Called after a frame that loaded or dropped cells. */
  onChange?: () => void;
  private site?: Site;
  private cells: Cell[] = [];
  private loaded = new Map<string, Loaded>();
  private readonly stage: Stage;

  constructor(stage: Stage) {
    this.stage = stage;
    stage.scene.add(this.group);
  }

  /** Starts again from a new tile stage: drops every cell. */
  reset(site: Site): void {
    for (const l of this.loaded.values()) this.drop(l);
    this.loaded.clear();
    this.site = site;
    this.cells = cellsOf(site.model);
    this.count();
  }

  /** How far cells are kept, and how far small things are drawn, for a camera this far from what it looks at. */
  static reach(cameraDistance: number): { far: number; small: number } {
    return { far: Math.min(1800, Math.max(500, cameraDistance * 1.4 + 300)), small: Math.min(350, Math.max(150, cameraDistance + 100)) };
  }

  /** Call every frame: loads cells within reach of the view's target, for up to `budgetMs`, and drops far ones. */
  update(budgetMs = 10): void {
    if (!this.site) return;
    const t = this.stage.controls.target;
    const [x, y] = [t.x, -t.z];
    const { far, small } = CellView.reach(this.stage.camera.position.distanceTo(t));
    const dist = (c: Cell) => Math.hypot(Math.max(c.x0 - x, 0, x - c.x1), Math.max(c.y0 - y, 0, y - c.y1));
    let changed = false;
    for (const l of this.loaded.values()) {
      const d = dist(l.cell);
      // Some slack before letting go, so moving back and forth over a boundary doesn't regenerate.
      if (d > far + 300) {
        this.drop(l);
        this.loaded.delete(l.cell.key);
        changed = true;
        continue;
      }
      for (const o of l.small) o.visible = d < small;
    }
    const wanted = this.cells.filter((c) => !this.loaded.has(c.key) && dist(c) < far).sort((a, b) => dist(a) - dist(b));
    const start = performance.now();
    for (const cell of wanted) {
      if (performance.now() - start > budgetMs) break;
      const l = this.build(cell);
      for (const o of l.small) o.visible = dist(cell) < small;
      this.loaded.set(cell.key, l);
      changed = true;
    }
    if (changed) {
      this.count();
      this.onChange?.();
    }
  }

  /** Everything placed in the loaded cells, for the inspector. */
  placed(): Instance[] {
    return [...this.loaded.values()].flatMap((l) => l.placed);
  }

  private count(): void {
    const s: CellStats = { loaded: this.loaded.size, total: this.cells.length, kits: {}, trees: 0, props: 0 };
    for (const l of this.loaded.values()) {
      for (const p of l.placed) {
        s.kits[p.kit] = (s.kits[p.kit] ?? 0) + 1;
        if (TREE_KITS.has(p.kit)) s.trees++;
        else s.props++;
      }
    }
    this.stats = s;
  }

  private drop(l: Loaded): void {
    // Kit geometry is shared by every cell; only the instance buffers belong to this one.
    for (const m of l.group.children) (m as THREE.InstancedMesh).dispose();
    this.group.remove(l.group);
  }

  /** One instanced mesh per kit shape in the cell, with lamp heads and pools alongside. */
  private build(cell: Cell): Loaded {
    const placed = generateCell(this.site!, cell);
    const library = kits();
    const groups = new Map<string, { kit: Kit; variant: number; list: Instance[] }>();
    for (const p of placed) {
      const kit = library.get(p.kit);
      if (!kit) continue;
      const variant = Math.floor(((p.tint * 9.17) % 1) * kit.variants.length);
      const key = `${p.kit}#${variant}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { kit, variant, list: [] }));
      g.list.push(p);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const tilt = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const axis = new THREE.Vector3();
    const c = new THREE.Color();
    const mats = this.stage.mats;
    const group = new THREE.Group();
    const small: THREE.Object3D[] = [];
    for (const { kit, variant, list } of groups.values()) {
      const shapes: [THREE.BufferGeometry, THREE.Material, boolean][] = [[kit.variants[variant], kit.tone ? mats.trees : mats.covers, kit.shadow]];
      if (kit.lamp && variant === 0) shapes.push([kit.lamp.head, mats.lampHeads, false], [kit.lamp.pool, mats.lampPools, false]);
      for (const [geometry, material, shadow] of shapes) {
        const mesh = new THREE.InstancedMesh(geometry, material, list.length);
        list.forEach((p, i) => {
          q.setFromAxisAngle(up, p.yaw);
          if (p.lean) {
            axis.set(Math.cos(p.leanDir), 0, -Math.sin(p.leanDir));
            q.premultiply(tilt.setFromAxisAngle(axis, p.lean));
          }
          const stretch = 1 + (kit.stretch ?? 0) * (p.tint - 0.5);
          // Things on a slope sink a little so their downhill side does not float.
          m.compose(new THREE.Vector3(p.x, p.h - 0.2 * p.size, -p.y), q, new THREE.Vector3(p.size, p.size * stretch, p.size));
          mesh.setMatrixAt(i, m);
          if (kit.tone && material === mats.trees) mesh.setColorAt(i, toneColour(p.tone ?? kit.tone, p.tint, c));
        });
        // Bounds of this cell's instances, so frustum culling can skip the whole mesh.
        mesh.computeBoundingSphere();
        mesh.castShadow = shadow;
        mesh.receiveShadow = shadow;
        group.add(mesh);
        if (SMALL_KITS.has(kit.id)) small.push(mesh);
      }
    }
    this.group.add(group);
    return { cell, placed, group, small };
  }
}
