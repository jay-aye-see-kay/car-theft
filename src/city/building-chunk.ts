import RAPIER from '@dimforge/rapier3d-compat';
import type { BuildingMesh, PropKind } from './format.ts';

// One chunk's buildings (or roads, same format): the render arrays, which
// ChunkMesh merges with the chunk's terrain into one draw call, and one
// static trimesh collider (walls and roofs; for roads, bridge decks), which
// only chunks near the player have. Roads carry a per-vertex draw layer
// (see cityMaterial).

/**
 * Collision groups (membership << 16 | filter). Buildings are in group 1 and
 * collide with everything; queries that want bare terrain (the debug probe)
 * filter on group 0, which buildings aren't in.
 */
export const BUILDING_GROUPS = (0x0002 << 16) | 0xffff;
export const TERRAIN_ONLY_QUERY = (0xffff << 16) | 0x0001;

/** Footprint of a prop for its collider and hit tests: a circle (`r`), or a box (`w` across its facing, `d` along it). */
export const PROP_SHAPES: Record<PropKind, { r?: number; w?: number; d?: number }> = {
  lamp: { r: 0.14 }, signal: { r: 0.14 }, stop: { r: 0.1 }, bin: { r: 0.3 },
  shelter: { w: 3.8, d: 1.7 }, bench: { w: 1.8, d: 0.55 },
  // Trees: their trunk radius from the file (at least this).
  broadleaf: { r: 0.2 }, palm: { r: 0.15 }, conifer: { r: 0.2 }, pohutukawa: { r: 0.25 },
};

/**
 * Something a car can knock down (src/smash.ts), standing in a chunk: world
 * position of its foot, its footprint, and its run of the chunk's vertices.
 */
export class Prop {
  readonly kind: PropKind;
  readonly chunk: BuildingChunk;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly heading: number;
  readonly height: number;
  /** Half-extents of its footprint across (along (-sin, cos) of its heading) and along its heading; equal for round ones. */
  readonly halfW: number;
  readonly halfD: number;
  readonly round: boolean;
  readonly first: number;
  readonly count: number;
  /** Knocked down (hidden, no collider) until restored. */
  down = false;
  collider: RAPIER.Collider | null = null;
  /** Its vertex positions while it's hidden, to put back. */
  saved: Float32Array | null = null;

  constructor(chunk: BuildingChunk, kind: PropKind, x: number, y: number, z: number, heading: number, height: number, radius: number, first: number, count: number) {
    this.chunk = chunk;
    this.kind = kind;
    this.x = x;
    this.y = y;
    this.z = z;
    this.heading = heading;
    this.height = height;
    this.first = first;
    this.count = count;
    const shape = PROP_SHAPES[kind];
    this.round = shape.r !== undefined;
    this.halfW = this.round ? Math.max(shape.r!, radius) : shape.w! / 2;
    this.halfD = this.round ? this.halfW : shape.d! / 2;
  }
}

/**
 * Does a prop's footprint overlap a box at (x, z), `halfL` along its heading
 * and `halfW` across (game convention: heading h faces (cos h, -sin h))?
 * Separating axes in 2D.
 */
export function propOverlaps(p: Prop, x: number, z: number, heading: number, halfL: number, halfW: number): boolean {
  const fx = Math.cos(heading);
  const fz = -Math.sin(heading);
  const gx = Math.cos(p.heading);
  const gz = Math.sin(p.heading);
  const dx = p.x - x;
  const dz = p.z - z;
  for (const [ux, uz] of [[fx, fz], [-fz, fx], [gx, gz], [-gz, gx]]) {
    const a = halfL * Math.abs(fx * ux + fz * uz) + halfW * Math.abs(-fz * ux + fx * uz);
    const b = p.halfD * Math.abs(gx * ux + gz * uz) + p.halfW * Math.abs(-gz * ux + gx * uz);
    if (Math.abs(dx * ux + dz * uz) > a + b) return false;
  }
  return true;
}

/** Props are bucketed by this many metres for lookups. */
const PROP_CELL = 16;

export class BuildingChunk {
  /** Render vertices, relative to the chunk centre. */
  readonly pos: Float32Array;
  readonly normals: Int8Array;
  readonly colours: Uint8Array;
  readonly layers: Uint8Array | undefined;
  /** Surface detail (see facades.ts), or undefined for plain vertex colour. */
  readonly detail: BuildingMesh['detail'];
  readonly indices: Uint32Array;
  /** Indices from here on are near-only detail (verandahs, parapets, rooftop plant). */
  readonly nearOnly: number;
  /** Indices from here on are fine detail, drawn nearer still (cornices, rooftop plant, eaves). */
  readonly fineFrom: number;
  /** Indices from here on are grouped by tile (trees), each drawn only near the player; see BuildingMesh.groups. */
  readonly groups: BuildingMesh['groups'];
  /** Where the grouped indices start (the end of the rest). */
  readonly groupsFrom: number;
  private collider: RAPIER.Collider | null = null;
  private readonly vertices: Float32Array;
  private readonly colliderIndices: Uint32Array;
  /** Things a car can knock down, and a coarse grid of them (cell key -> props). */
  readonly props: Prop[] = [];
  private readonly propCells = new Map<number, Prop[]>();
  private world: RAPIER.World | null = null;
  private body: RAPIER.RigidBody | null = null;
  /** Told when a run of vertices changed (a prop hidden or put back), so the drawn mesh can follow. */
  onVertices: ((first: number, count: number) => void) | null = null;
  readonly cx: number;
  readonly cz: number;
  /** Thrown away by the streamer (its props with it). */
  unloaded = false;

  /** @param cx, cz the chunk centre in local metres (the file's origin) */
  constructor(data: BuildingMesh, cx: number, cz: number) {
    const n = data.xCm.length;
    const pos = new Float32Array(n * 3);
    const base = data.baseCm / 100;
    for (let k = 0; k < n; k++) {
      pos[k * 3] = data.xCm[k] / 100;
      pos[k * 3 + 1] = base + data.yCm[k] / 100;
      pos[k * 3 + 2] = data.zCm[k] / 100;
    }
    this.pos = pos;
    this.normals = data.normals;
    this.colours = data.colours;
    this.layers = data.layers;
    this.detail = data.detail;
    this.indices = data.indices;
    this.groups = data.groups;
    this.groupsFrom = data.groups ? data.groups.from[0] : data.indices.length;
    this.nearOnly = data.nearOnly ?? this.groupsFrom;
    this.fineFrom = data.fineFrom ?? this.groupsFrom;

    // The collider lives on the shared fixed body, so it needs world positions.
    this.vertices = new Float32Array(pos);
    for (let k = 0; k < n; k++) {
      this.vertices[k * 3] += cx;
      this.vertices[k * 3 + 2] += cz;
    }
    this.colliderIndices = data.colliderIndices;
    this.cx = cx;
    this.cz = cz;
    for (const r of data.props ?? []) {
      const p = new Prop(this, r.kind, cx + r.xCm / 100, base + r.yCm / 100, cz + r.zCm / 100, r.heading, r.heightCm / 100, r.radiusCm / 100, r.first, r.count);
      this.props.push(p);
      const key = this.cellKey(p.x, p.z);
      (this.propCells.get(key) ?? this.propCells.set(key, []).get(key)!).push(p);
    }
  }

  private cellKey(x: number, z: number): number {
    return (Math.floor((x - this.cx) / PROP_CELL) + 64) * 256 + Math.floor((z - this.cz) / PROP_CELL) + 64;
  }

  /** Calls `f` for every standing prop that may be within `r` of (x, z) (whole cells: check the distance yourself). */
  propsNear(x: number, z: number, r: number, f: (p: Prop) => void): void {
    if (!this.props.length) return;
    const i0 = Math.floor((x - r - this.cx) / PROP_CELL);
    const i1 = Math.floor((x + r - this.cx) / PROP_CELL);
    const j0 = Math.floor((z - r - this.cz) / PROP_CELL);
    const j1 = Math.floor((z + r - this.cz) / PROP_CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const list = this.propCells.get((i + 64) * 256 + j + 64);
        if (list) for (const p of list) if (!p.down) f(p);
      }
    }
  }

  /** Copies of a prop's vertices as they stand (relative to the chunk centre), and its triangles renumbered from 0. */
  propModel(p: Prop): { pos: Float32Array; normals: Int8Array; colours: Uint8Array; shade: Uint8Array | null; u: Int16Array | null; v: Int16Array | null; tile: Uint8Array | null; indices: Uint32Array } {
    const a = p.first;
    const b = p.first + p.count;
    const out: number[] = [];
    const idx = this.indices;
    for (let k = 0; k + 2 < idx.length; k += 3) {
      const i0 = idx[k];
      if (i0 < a || i0 >= b) continue;
      out.push(i0 - a, idx[k + 1] - a, idx[k + 2] - a);
    }
    const d = this.detail;
    return {
      pos: (p.saved ?? this.pos).slice(p.saved ? 0 : a * 3, p.saved ? p.count * 3 : b * 3),
      normals: this.normals.slice(a * 3, b * 3),
      colours: this.colours.slice(a * 3, b * 3),
      shade: d ? d.shade.slice(a, b) : null,
      u: d ? Int16Array.from(d.u.subarray(a, b)) : null,
      v: d ? Int16Array.from(d.v.subarray(a, b)) : null,
      tile: d ? d.tile.slice(a, b) : null,
      indices: Uint32Array.from(out),
    };
  }

  /** Knocks a prop down here: hides its vertices (collapsed to one point, so its triangles draw nothing) and drops its collider. */
  hideProp(p: Prop): void {
    if (p.down) return;
    p.down = true;
    this.dropPropCollider(p);
    const a = p.first * 3;
    p.saved = this.pos.slice(a, a + p.count * 3);
    for (let k = 1; k < p.count; k++) this.pos.set(p.saved.subarray(0, 3), a + k * 3);
    this.onVertices?.(p.first, p.count);
  }

  /** Stands a knocked-down prop back up. */
  restoreProp(p: Prop): void {
    if (!p.down) return;
    p.down = false;
    if (p.saved) this.pos.set(p.saved, p.first * 3);
    p.saved = null;
    this.onVertices?.(p.first, p.count);
    if (this.world && this.body) this.addPropCollider(p, this.world, this.body);
  }

  private addPropCollider(p: Prop, world: RAPIER.World, body: RAPIER.RigidBody): void {
    if (p.collider || p.down) return;
    // Tall enough for anything driving or walking into it; the top of a lamp is never reached.
    const half = Math.min(p.height, 3) / 2;
    const desc = p.round
      ? RAPIER.ColliderDesc.cylinder(half, p.halfW)
      : RAPIER.ColliderDesc.cuboid(p.halfD, half, p.halfW).setRotation({ x: 0, y: -Math.sin(p.heading / 2), z: 0, w: Math.cos(p.heading / 2) });
    p.collider = world.createCollider(
      desc.setTranslation(p.x, p.y + half, p.z).setCollisionGroups(BUILDING_GROUPS).setFriction(0.5).setRestitution(0.05),
      body,
    );
  }

  private dropPropCollider(p: Prop): void {
    if (p.collider && this.world) this.world.removeCollider(p.collider, false);
    p.collider = null;
  }

  get count(): number {
    return this.pos.length / 3;
  }

  get hasCollider(): boolean {
    return this.world !== null;
  }

  addCollider(world: RAPIER.World, body: RAPIER.RigidBody): void {
    if (this.world) return;
    this.world = world;
    this.body = body;
    for (const p of this.props) this.addPropCollider(p, world, body);
    if (!this.colliderIndices.length) return;
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.trimesh(this.vertices, this.colliderIndices)
        .setCollisionGroups(BUILDING_GROUPS)
        .setFriction(0.5)
        .setRestitution(0.05),
      body,
    );
  }

  removeCollider(world: RAPIER.World): void {
    for (const p of this.props) this.dropPropCollider(p);
    if (this.collider) world.removeCollider(this.collider, false);
    this.collider = null;
    this.world = this.body = null;
  }
}

