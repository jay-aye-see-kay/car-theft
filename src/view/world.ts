// Builds a tile into the stage in two stages. The tile stage, all at once: graded terrain, roads,
// covers, stamps and buildings (facades near the view, boxes beyond). The cell stage, around the view
// as it moves: street furniture and everything the profiles scatter (see gen/cells.ts). Shared by the
// look, buildings and profiles labs; they differ only in the profile context they pass in.
import * as THREE from 'three';
import { buildMassing } from '../gen/buildings.ts';
import { buildCovers } from '../gen/covers.ts';
import { buildFacades } from '../gen/facade.ts';
import { buildNetwork } from '../gen/network.ts';
import { buildRoadMeshes } from '../gen/roadMesh.ts';
import { type Instance, occupancy } from '../gen/scatter.ts';
import type { Site } from '../gen/site.ts';
import { type MapMode, buildTerrainGeometry, buildTerrainSkirt, gradeTerrain, paintGround } from '../gen/terrain.ts';
import { DEFAULT_PARAMS, type Track, buildTrack } from '../gen/tracks.ts';
import { centroid, pointInRing } from '../geo/poly.ts';
import { kits } from '../kit/kits.ts';
import type { Heightfield } from '../model/load.ts';
import type { Building, TileModel } from '../model/types.ts';
import type { ProfileContext } from '../profile/context.ts';
import { CellView } from './cells.ts';
import type { Stage } from './stage.ts';
import { type PlacedStamp, buildStamps, carveStamps, placeStamps } from './stamps.ts';

export interface WorldOptions {
  hillScale: number;
  trees: boolean;
  furniture: boolean;
  /** Build real facades for buildings near the view; the rest stay as boxes with shader windows. */
  detail: boolean;
  detailRadius: number;
  palette: 'grey' | 'toy';
  map: MapMode;
}

export interface WorldStats {
  trees: number;
  props: number;
  detail: number;
  /** Cells generated right now, of the tile's total. */
  cells: { loaded: number; total: number };
  /** Things placed, per kit. */
  kits: Record<string, number>;
  ms: Record<string, number>;
}

export class World {
  readonly stage: Stage;
  readonly model: TileModel;
  readonly ground: Heightfield;
  ctx: ProfileContext;
  opts: WorldOptions;
  /** Ground as graded for the roads, for driving and picking. */
  surface: Heightfield;
  readonly group = new THREE.Group();
  readonly built = new THREE.Group();
  readonly focus = new THREE.Vector3(Infinity, 0, 0);
  stats: WorldStats = { trees: 0, props: 0, detail: 0, cells: { loaded: 0, total: 0 }, kits: {}, ms: {} };
  readonly cells: CellView;
  /** The tile stage's results, which the cells read. */
  site?: Site;
  terrainMesh?: THREE.Mesh;
  stamps: PlacedStamp[] = [];
  buildingMeshes: { mesh: THREE.Mesh; buildings: Building[]; facades: boolean }[] = [];
  private land: Heightfield;
  private nearRoad: (x: number, y: number) => boolean = () => false;
  private covered: (x: number, y: number) => boolean;
  private solid: Building[];
  private centres: [number, number][];
  private disposable: { dispose(): void }[] = [];

  constructor(stage: Stage, model: TileModel, ground: Heightfield, ctx: ProfileContext, opts: WorldOptions) {
    this.stage = stage;
    this.model = model;
    this.ground = ground;
    this.ctx = ctx;
    this.opts = opts;
    this.surface = this.land = ground;
    // Canopies and screens are not buildings; they have their own generator.
    this.solid = model.buildings.filter((b) => !b.cover);
    this.centres = this.solid.map((b) => centroid(b.ring));
    const covers = model.buildings.filter((b) => b.cover === 'ground');
    this.covered = (x, y) => covers.some((b) => pointInRing(x, y, b.ring));
    stage.scene.add(this.group, this.built);
    this.cells = new CellView(stage);
  }

  /** Everything placed in the cells generated so far, for the inspector. */
  get placed(): Instance[] {
    return this.cells.placed();
  }

  /** Calls back whenever cells load or drop, e.g. to refresh a HUD. */
  set onCells(f: () => void) {
    this.cells.onChange = () => {
      this.syncStats();
      f();
    };
  }

  private syncStats(): void {
    const c = this.cells.stats;
    Object.assign(this.stats, { trees: c.trees, props: c.props, kits: c.kits, cells: { loaded: c.loaded, total: c.total } });
  }

  /** Splits buildings into near (full facades) and far (boxes), around what the camera is looking at. */
  rebuildBuildings(): void {
    for (const { mesh } of this.buildingMeshes) mesh.geometry.dispose();
    this.built.clear();
    this.buildingMeshes = [];
    const t = this.stage.controls.target;
    this.focus.copy(t);
    const o = this.opts;
    const near = (i: number) => o.detail && Math.hypot(this.centres[i][0] - t.x, this.centres[i][1] + t.z) < o.detailRadius;
    const far = this.solid.filter((_, i) => !near(i));
    const close = o.map === 'generated' ? this.solid.filter((_, i) => near(i)) : [];
    if (o.map !== 'generated') far.push(...this.solid.filter((_, i) => near(i)));
    this.stats.detail = close.length;
    const tint = o.map === 'profiles' ? (b: Building) => this.ctx.forBuilding(b).top.swatch : o.map === 'zoning' ? () => 0xeeeeee : undefined;
    const styleOf = this.ctx.styleOf;
    for (const [geometry, material, list, facades] of [
      [buildMassing(far, this.land, { palette: o.palette, hillScale: o.hillScale, styleOf, tint }), this.stage.mats.buildings, far, false],
      [buildFacades(close, this.land, { hillScale: o.hillScale, nearRoad: this.nearRoad, styleOf, covered: this.covered }), this.stage.mats.facades, close, true],
    ] as const) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = mesh.receiveShadow = true;
      this.built.add(mesh);
      this.buildingMeshes.push({ mesh, buildings: list, facades });
    }
  }

  /** Rebuilds the buildings when the view has moved far enough, and generates the cells it now reaches. Call every frame. */
  follow(): void {
    const t = this.stage.controls.target;
    if (this.opts.detail && Math.hypot(t.x - this.focus.x, t.z - this.focus.z) > this.opts.detailRadius * 0.3) this.rebuildBuildings();
    this.cells.update();
    if (!this.cells.onChange) this.syncStats();
  }

  generate(): void {
    const ms: Record<string, number> = {};
    let t0 = performance.now();
    const lap = (name: string) => {
      const t = performance.now();
      ms[name] = Math.round(t - t0);
      t0 = t;
    };
    for (const d of this.disposable) d.dispose();
    this.disposable = [];
    const shared = new Set<THREE.BufferGeometry>();
    for (const k of kits().values()) for (const g of [...k.variants, k.lamp?.head, k.lamp?.pool]) if (g) shared.add(g);
    for (const child of this.group.children) {
      const g = (child as THREE.Mesh).geometry;
      if (g && !shared.has(g)) g.dispose();
    }
    this.group.clear();
    const { model, stage, opts } = this;
    const mats = stage.mats;

    // Exaggeration happens to the input, so roads, banks and buildings all follow it.
    const land = this.ground.clone();
    for (let i = 0; i < land.data.length; i++) land.data[i] *= opts.hillScale;
    this.land = land;

    const net = buildNetwork(model, land, DEFAULT_PARAMS);
    const { tracks, junctions } = net;
    const graded = gradeTerrain(land, net, DEFAULT_PARAMS, model.paths);
    const roads = buildRoadMeshes(net, DEFAULT_PARAMS, { tintJunctions: false });
    this.stamps = placeStamps(model, land);
    carveStamps(this.stamps, graded);
    this.surface = graded;
    this.nearRoad = occupancy(model, tracks.values(), 'roads');
    lap('roads');

    const paint = new THREE.CanvasTexture(paintGround(model, 1.5, this.ctx, opts.map));
    paint.colorSpace = THREE.SRGBColorSpace;
    paint.anisotropy = stage.renderer.capabilities.getMaxAnisotropy();
    this.disposable.push(paint);
    mats.terrain.map = paint;
    mats.terrain.needsUpdate = true;
    lap('ground');

    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, cast: boolean, receive: boolean): THREE.Mesh => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      this.group.add(mesh);
      return mesh;
    };
    this.terrainMesh = add(buildTerrainGeometry(graded), mats.terrain, false, true);
    add(buildTerrainSkirt(graded, -30), mats.skirt, false, false);
    add(roads.surface, mats.surface, true, true);
    add(roads.markings, mats.markings, false, false);
    const covers = buildCovers(model.buildings, graded, tracks.values());
    add(covers.frame, mats.covers, true, true);
    add(covers.glass, mats.glass, false, false);
    if (model.sea) {
      // The sea: one flat sheet at sea level, under which the LiDAR's flattened water was pushed down.
      // It only runs on past the tile's edges where those edges are mostly at sea, so inland edges don't read as an island.
      const [hx, hy] = [model.size.x / 2, model.size.y / 2];
      const wet = (sample: (t: number) => [number, number]) => {
        let n = 0;
        for (let i = 0; i <= 40; i++) if (graded.at(...sample(i / 40)) < 1) n++;
        return n > 20 ? 3000 : -4;
      };
      const [w, e, s, n] = [wet((t) => [-hx + 1, -hy + t * 2 * hy]), wet((t) => [hx - 1, -hy + t * 2 * hy]), wet((t) => [-hx + t * 2 * hx, -hy + 1]), wet((t) => [-hx + t * 2 * hx, hy - 1])];
      const sheet = new THREE.PlaneGeometry(2 * hx + w + e, 2 * hy + s + n).rotateX(-Math.PI / 2).translate((e - w) / 2, 0.05, -(n - s) / 2);
      const sea = add(sheet, mats.water, false, true);
      sea.renderOrder = 1;
    }
    for (const s of buildStamps(model, graded, opts.hillScale, this.stamps)) add(s.geometry, s.material === 'falls' ? mats.falls : mats.covers, false, true);
    this.rebuildBuildings();
    lap('buildings');

    // The cell stage reads all of this; cells are generated around the view by follow().
    const clearings = this.stamps.map(({ run }) => run);
    this.site = {
      model,
      ground: graded,
      ctx: this.ctx,
      roadCtx: this.ctx,
      tracks: [...tracks.values()],
      junctions,
      occupied: occupancy(model, tracks.values()),
      walls: occupancy(model, [], 'buildings'),
      // Trees stay out of the stamps (the falls and their pool) so they can be seen.
      clear: (x, y) => clearings.some((run) => run.some((p) => Math.hypot(p[0] - x, p[1] - y) < 14)),
      trees: opts.trees,
      furniture: opts.furniture,
    };
    this.cells.reset(this.site);
    this.syncStats();
    lap('site');
    this.stats.ms = ms;
  }
}

export function tracksOf(model: TileModel): Map<string, Track> {
  return new Map(model.roads.map((r) => [r.id, buildTrack(r, DEFAULT_PARAMS)]));
}
