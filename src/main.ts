import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { GameAudio } from './audio.ts';
import { ChaseCamera, DRIVING, FLYING, ON_FOOT, fitFov } from './camera.ts';
import { FLY_CODE, StickCode } from './cheats.ts';
import { TERRAIN_ONLY_QUERY } from './city/building-chunk.ts';
import { Bubbles } from './bubbles.ts';
import { Car, CHASSIS_HALF, MESH_OFFSET_Y } from './car.ts';
import { CarFleet } from './car-fleet.ts';
import { CRASH_DIZZY, DIZZY, Dizzy, severity } from './dizzy.ts';
import { Input } from './input.ts';
import { CarSpeeds, HITS, inside, Peds, type CarLike } from './peds.ts';
import { PedsMesh } from './peds-mesh.ts';
import { Player } from './player.ts';
import { SkidMarks } from './skids.ts';
import { DizzyStars } from './stars.ts';
import { allValues, resetValues, setValue, useStorage } from './tweaks.ts';
import { TweaksPanel } from './tweaks-panel.ts';
import { Sky } from './sky.ts';
import { SUN_DIRECTION } from './sun.ts';
import { Splash } from './splash.ts';
import { PARKED_POOL, Town, TRAFFIC_POOL } from './traffic.ts';
import { Water } from './city/water.ts';
import { loadMap } from './maps/index.ts';
import { MISSIONS } from './missions/index.ts';
import { MissionHud } from './missions/runtime/hud.ts';
import { MissionMarkers } from './missions/runtime/markers.ts';
import { MissionRunner } from './missions/runtime/runner.ts';
import { RoomPanel } from './net/panel.ts';
import { roundQuat, roundVec, round2, type Pose } from './net/protocol.ts';
import { Remotes } from './net/remotes.ts';
import { cleanName, Room, type PoseBody } from './net/room.ts';
import { bearing, Chart, type Blip } from './map/chart.ts';
import { FullMap } from './map/full-map.ts';
import { Minimap } from './map/minimap.ts';
import { Navigator } from './map/navigator.ts';
import './style.css';

const FIXED_DT = 1 / 60;
const MAX_STEPS = 5;
/** ?debug step(): ticks run between waits for streaming (1 s of game time). */
const STEP_BATCH = 60;
/** step(): promise hops a mission script gets to run between ticks. */
const SCRIPT_HOPS = 8;
const ENTER_RANGE = 3.6; // m from the car's centre
/** Send the shared mission to guests this often, s (the channel drops some; each is complete). */
const SHARE_EVERY = 0.2;
const params = new URLSearchParams(location.search);
const debug = params.has('debug');
/** Cars that fall this far below sea level (off the map edge) get put back. */
const FALL_LIMIT = -30;
/** Anything this far below the terrain has fallen through it and gets put back on top. */
const UNDERGROUND = 2;
/** Anything that wanders this far outside the map gets brought back in. */
const OUT_OF_BOUNDS = 40;
/** In the water once a car's centre (or the player's feet) is this far under the surface, m. */
const SUBMERGED = 0.3;
/** How long a car or the player stays in the water before being fished out onto dry land, s. */
const SOAK_CAR = 1.8;
const SOAK_PLAYER = 1.2;
/** How far to look for dry land to put them back on, m. */
const SHORE_SEARCH = 300;
/** Cars beyond this from the camera lose their blob shadows, m. */
const CAR_DETAIL = 120;
/** And beyond this they're drawn as just their body: the wheels are half a car's triangles, and a few pixels by here, m. */
const CAR_WHEELS = 40;
/** Beyond this, a low-poly stand-in with the same silhouette, m. */
const CAR_FAR = 80;
/** Cars beyond this are not drawn at all (a few pixels in the haze), m. */
const CAR_DRAW = 600;
/** Default names in a room, with a number on the end. */
const NICKNAMES = ['Kūmara', 'Pūkeko', 'Jandal', 'Pavlova', 'Tui', 'Kea', 'Chur', 'Cuz', 'Hokey Pokey', 'Pineapple Lump', 'Sweet As', 'Hard Out'];
const NAME_KEY = 'gta.name';
/** A car hitting you on foot: not again for this long, s (it's still touching). */
const HIT_COOLDOWN = 1;
/** Speech bubbles sit this far above the feet, m. */
const BUBBLE_LIFT = 2.25;
/** "Oi!" fades out by this far from the camera, m. */
const BARK_RANGE = 60;
/** The minimap shows this far to its rim on foot, m, and this much more per m/s, up to the most. */
const MAP_RADIUS = 160;
const MAP_RADIUS_PER_MS = 6;
const MAP_RADIUS_MAX = 380;

async function main() {
  const app = document.getElementById('app')!;
  const hud = document.getElementById('hud')!;
  const speedoBox = document.getElementById('speedo')!;
  const speedo = document.getElementById('speed')!;
  const prompt = document.getElementById('prompt')!;
  const fpsEl = document.getElementById('fps')!;
  const muteBtn = document.getElementById('mute')!;
  const splash = document.getElementById('splash')!;
  const status = document.getElementById('status')!;
  const blurb = document.getElementById('blurb')!;

  // Only the -compat build needs init(); the browser build (see vite.config.ts) is ready on import.
  await (RAPIER as { init?: () => Promise<void> }).init?.();

  // Renderer: start at a modest pixel ratio on phones and adapt from there.
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  const coarse = matchMedia('(pointer: coarse)').matches;
  // Past 2x the extra pixels cost far more fill rate than they show.
  const maxRatio = Math.min(devicePixelRatio, 2);
  let pixelRatio = Math.min(devicePixelRatio, coarse ? 1.5 : 2);
  renderer.setPixelRatio(pixelRatio);
  // Sized from #app's box, not innerWidth/innerHeight: iOS Safari reports
  // stale ones for a moment after rotating, which stretched the picture.
  // `false`: CSS keeps the canvas filling #app; we only size the buffer.
  renderer.setSize(app.clientWidth, app.clientHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Filmic tone mapping: bright sunlit walls roll off instead of clipping,
  // which is most of the step from flat PS1 shading to a PS2/PS3 look.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  app.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  // Blue sky above, warm sunlit pavement bouncing light from below.
  scene.add(new THREE.HemisphereLight(0xb8cbe4, 0x868074, 1.9));
  // Afternoon sun in the north-north-west (southern hemisphere), see sun.ts.
  const sun = new THREE.DirectionalLight(0xffecd6, 3.1);
  sun.position.fromArray(SUN_DIRECTION).multiplyScalar(300);
  scene.add(sun);

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;
  const map = await loadMap(params.get('map'), scene, world, renderer.capabilities.getMaxAnisotropy());
  blurb.textContent = map.blurb;

  const { atmosphere } = map;
  const sky = new THREE.Color(atmosphere.sky);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, atmosphere.fogNear, atmosphere.fogFar);
  const camera = new THREE.PerspectiveCamera(fitFov(app.clientWidth / app.clientHeight), app.clientWidth / app.clientHeight, 0.3, atmosphere.far);
  const skyDome = new Sky(sky, atmosphere.far * 0.9, atmosphere.zenith, sun.position);
  scene.add(skyDome.mesh);

  // The harbour (Auckland only), reflecting a sky a little bluer than the haze.
  const water = map.water
    ? new Water(map.water.level, sky.clone().lerp(new THREE.Color(0x8fb0cc), 0.35), sun.position, map.water.bounds, map.water.seaSouth)
    : null;
  if (water) scene.add(water.mesh);
  const splashes = new Splash();
  scene.add(splashes.points);

  const storage = (() => {
    try {
      return localStorage;
    } catch {
      return null; // blocked (some private modes): best times and tuning just aren't kept
    }
  })();
  // The ? panel's tuning from last time, before anything is built from it.
  useStorage(storage);

  // Cheap blob shadows instead of real-time shadow maps.
  const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false });
  const carShadow = new THREE.PlaneGeometry(4.6, 2.1).rotateX(-Math.PI / 2);

  // The map's parked cars, then (with a road graph) the town's pools: traffic
  // and more parked cars (src/traffic.ts), put out and taken away round the player.
  const spots = [...map.parking];
  const fixedCars = spots.length;
  if (map.roads) {
    for (let i = 0; i < TRAFFIC_POOL + PARKED_POOL; i++) spots.push({ pos: new THREE.Vector3(i * 6, -300, 0), heading: 0, pitch: 0, roll: 0, paint: 0xffffff });
  }
  const cars = spots.map((spot) => {
    const car = new Car(world, spot.pos, spot.heading, spot.paint, spot.pitch, spot.roll);
    /** Game time it went into the water, or null if it's dry. */
    return { car, frozen: false, soaked: null as number | null };
  });
  const town = map.roads ? new Town({ roads: map.roads, heightAt: (x, z) => map.heightAt(x, z), hasGround: (x, z) => map.hasGround(x, z) }, cars.slice(fixedCars).map((c) => c.car)) : null;
  // Every car in four draw calls (bodies, lamps, wheels, shadows), and a stand-in to pose each shadow.
  const fleet = new CarFleet(cars.length, shadowMat, carShadow, MESH_OFFSET_Y);
  scene.add(fleet.group);
  const shadowPose = new THREE.Object3D();
  const carList = cars.map((c) => c.car);
  const carEntry = new Map(cars.map((c) => [c.car, c]));
  /** Not in the world this frame: frozen until the ground streams in, or one of the town's not out. */
  const frozenCar = (car: Car) => carEntry.get(car)!.frozen || !!town?.idle(car);

  // Start on foot by the driver's door (right-hand drive) of the purple Corolla.
  const player = new Player(world, map.spawn.feet, map.spawn.heading);
  scene.add(player.object);
  const playerShadow = new THREE.Mesh(new THREE.CircleGeometry(0.4, 12).rotateX(-Math.PI / 2), shadowMat);
  playerShadow.name = 'shadow';
  scene.add(playerShadow);
  player.object.traverse((o) => (o.name = 'player'));

  const skids = new SkidMarks();
  scene.add(skids.mesh);

  // Dizzy (src/dizzy.ts) with stars over the head, and the pedestrians
  // (Auckland only: they walk the road graph's footpaths).
  const dizzy = new Dizzy();
  const stars = new DizzyStars();
  scene.add(stars.mesh);
  const peds = map.roads ? new Peds({ roads: map.roads, world, heightAt: (x, z) => map.heightAt(x, z), surfaceAt: map.surfaceAt && ((x, z) => map.surfaceAt!(x, z)) }) : null;
  const pedsMesh = new PedsMesh(shadowMat);
  scene.add(pedsMesh.mesh, pedsMesh.shadows);
  const carSpeeds = new CarSpeeds();
  const carLikes: CarLike[] = cars.map(({ car }) => ({ body: car.body, half: CHASSIS_HALF, player: false }));
  /** When each car last hit the player on foot, game s. */
  const hitPlayerAt = cars.map(() => -Infinity);
  /** On-foot stick and the steering, eased (dizzy makes them mushy). */
  const eased = { x: 0, z: 0, steer: 0 };
  const dizzyDrive = { throttle: 0, brake: 0, steer: 0, handbrake: false };

  // Missions: Auckland only, since their places are real streets (the map's gazetteer).
  const missions = map.places ? new MissionRunner(MISSIONS, map.places, (x, z) => map.heightAt(x, z), storage) : null;
  const markers = new MissionMarkers();
  scene.add(markers.group);
  const missionHud = new MissionHud(hud);
  // The map (#14): the minimap, the full-screen map, your waypoint and the route
  // there. Only where there's a picture of the map (Auckland: tools/citygen/map.ts).
  const nav = new Navigator(map.roads ?? null);
  const chart = map.chart ? await Chart.load(map.chart.url, map.chart.bounds, map.roads ?? null) : null;
  const minimap = chart ? new Minimap(hud, chart) : null;

  // Rooms (#26): other players, the 👥 panel, and the link to them.
  const remotes = new Remotes(world, scene, cars.map((c) => c.car), hud);
  /** Someone with a better claim got into the car we're in (both got in at once). */
  let evicted = false;
  remotes.onEvicted = () => (evicted = true);
  const savedName = cleanName(storage?.getItem(NAME_KEY) ?? '');
  const room = new Room({
    map: map.name,
    // Cleaned like everyone else's, or "Pineapple Lump 58" is one name here and another to the host.
    name: savedName || cleanName(`${NICKNAMES[Math.floor(Math.random() * NICKNAMES.length)]} ${10 + Math.floor(Math.random() * 90)}`),
    local: params.get('net') === 'local',
    turn: params.get('turn') !== 'off',
    localPose: () => localPose(),
    events: {
      welcomed: (at) => void spawnNear(at),
      joined: (m) => remotes.add(m.id, m.name),
      renamed: (m) => remotes.rename(m.id, m.name),
      pose: (id, pose) => remotes.receive(id, pose, clock),
      left: (id) => remotes.remove(id),
      mission: (st) => missions?.mirror(st),
      missionRequest: (id) => missions?.request(id),
      toast: (text) => roomPanel.toast(text),
      changed: () => {
        roomPanel.refresh();
        if (!started) roomNote.textContent = room.role === 'guest' ? `In room ${room.code}` : room.busy && room.code ? `Joining room ${room.code}…` : room.error;
      },
    },
  });
  const roomPanel = new RoomPanel(hud, room);
  roomPanel.onRename = (name) => storage?.setItem(NAME_KEY, name);
  const bubbles = new Bubbles(hud);
  // The ? panel and the full map: the game pauses while either is open.
  let paused = false;
  const tweaksPanel = new TweaksPanel(hud);
  tweaksPanel.toast = (text) => roomPanel.toast(text);
  const fullMap = chart ? new FullMap(hud, chart, nav, () => mapScene()) : null;
  const pause = () => {
    paused = tweaksPanel.isOpen || !!fullMap?.open;
    audio.setPaused(paused);
    input.clearPresses();
  };
  tweaksPanel.onToggle = pause;
  if (fullMap) fullMap.onToggle = pause;
  if (minimap) minimap.onOpen = () => fullMap?.toggle(true);
  const roomNote = document.createElement('p');
  roomNote.className = 'sub';
  status.after(roomNote);

  const chase = new ChaseCamera(camera, world);
  const input = new Input(app);
  input.attachLook(renderer.domElement);
  const audio = new GameAudio();

  let driving: Car | null = null;
  let exitRequested = false;
  /** When the shared mission last went to the guests, game s. */
  let lastShared = -Infinity;
  let upsideDownTime = 0;

  const nearestCar = (): Car | null => {
    let best: Car | null = null;
    let bestD = ENTER_RANGE;
    for (const { car } of cars) {
      if (remotes.drives(car) || town?.idle(car)) continue;
      const d = car.object.position.distanceTo(player.position);
      if (d < bestD && Math.abs(car.forwardSpeed()) < 3) {
        best = car;
        bestD = d;
      }
    }
    return best;
  };

  // Cheat: flick the stick up, up, down, down, left, right, left, right to fly.
  const flyCode = new StickCode(FLY_CODE);
  const setFlying = (on: boolean) => {
    player.setFlying(on);
    input.setFlying(on);
    if (on) return;
    // Landing inside a building would leave the capsule stuck in its
    // collider: step out onto the roof instead.
    const p = player.position;
    let inside = false;
    world.intersectionsWithPoint({ x: p.x, y: p.y + 0.9, z: p.z }, () => !(inside = true), RAPIER.QueryFilterFlags.ONLY_FIXED);
    if (!inside) return;
    const hit = world.castRay(new RAPIER.Ray({ x: p.x, y: 1000, z: p.z }, down), 2000, true, RAPIER.QueryFilterFlags.ONLY_FIXED);
    if (hit) player.place(new THREE.Vector3(p.x, 1000 - hit.timeOfImpact + 0.05, p.z), player.heading);
  };

  const enter = (car: Car) => {
    setFlying(false);
    // One of the town's cars: it's yours now, and if someone was driving it they're out on the road.
    const driver = town?.take(car);
    if (driver && peds) peds.turfOut(driver.x, driver.z, driver.heading, player.position);
    driving = car;
    exitRequested = false;
    player.setActive(false);
    input.setMode('car');
    car.impact = 0;
  };

  // Step out of the driver's door (right side), or the passenger side or
  // roof if something's in the way.
  const exit = (car: Car) => {
    const pos = car.object.position;
    const rot = car.object.quaternion;
    const heading = new THREE.Euler().setFromQuaternion(rot, 'YXZ').y;
    const options = [new THREE.Vector3(0.3, 0, 1.6), new THREE.Vector3(0.3, 0, -1.6), new THREE.Vector3(0, 1.2, 0)];
    let spot = options[options.length - 1].clone().applyQuaternion(rot).add(pos);
    for (const local of options.slice(0, 2)) {
      const offset = local.clone().applyQuaternion(rot);
      offset.y = 0;
      const dir = offset.clone().normalize();
      const from = { x: pos.x, y: pos.y + 0.3, z: pos.z };
      const hit = world.castRay(new RAPIER.Ray(from, dir), offset.length() + 0.4, true, undefined, undefined, car.collider);
      if (!hit) {
        spot = pos.clone().add(offset);
        break;
      }
    }
    const ground = map.heightAt(spot.x, spot.z, spot.y);
    spot.y = Math.max(spot.y - 0.6, (Number.isNaN(ground) ? 0 : ground) + 0.05);
    player.place(spot, heading);
    player.setActive(true);
    driving = null;
    exitRequested = false;
    input.setMode('foot');
    for (let i = 0; i < 4; i++) skids.lift(`${cars.findIndex((c) => c.car === car)}:${i}`);
  };

  /** Back on its wheels where it is, never below the ground. */
  const resetCar = (car: Car) => {
    const t = car.body.translation();
    const ground = map.heightAt(t.x, t.z, t.y);
    car.reset(Number.isNaN(ground) ? 0 : ground);
  };

  /** Below the world, under the terrain or well off the map: needs putting back. */
  const lost = (p: { x: number; y: number; z: number }) => {
    if (p.y < FALL_LIMIT) return true;
    const c = map.clamp(p.x, p.z);
    if (Math.hypot(c.x - p.x, c.z - p.z) > OUT_OF_BOUNDS) return true;
    const ground = map.heightAt(p.x, p.z, p.y);
    return !Number.isNaN(ground) && p.y < ground - UNDERGROUND;
  };

  // ---- In the harbour: splash, sink for a moment, then back on dry land.
  let clock = 0;
  let playerSoaked: number | null = null;

  /** Under the water surface, over ground that's under it too (not a low spot inland). */
  const inWater = (x: number, y: number, z: number) => {
    if (!water || y > water.level - SUBMERGED) return false;
    const ground = map.heightAt(x, z);
    return !Number.isNaN(ground) && water.covers(ground);
  };

  const makeSplash = (x: number, z: number, strength: number, loud: boolean) => {
    if (!water) return;
    splashes.burst(_p.set(x, water.level, z), strength);
    // Only the one you're driving (or yourself) is loud; others are heard faintly.
    audio.splash(loud ? strength : strength * 0.3);
  };

  /** Dry, level, open ground (no building on it), above the water. */
  const dryGround = (x: number, z: number, h: number, minAbove: number) => {
    if (!water || Number.isNaN(h) || h < water.level + minAbove) return false;
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const n = map.heightAt(x + dx, z + dz);
      if (Number.isNaN(n) || Math.abs(n - h) > 0.6) return false;
    }
    const hit = world.castRay(new RAPIER.Ray({ x, y: h + 40, z }, down), 80, true, RAPIER.QueryFilterFlags.ONLY_FIXED);
    return !hit || Math.abs(h + 40 - hit.timeOfImpact - h) < 0.4;
  };

  /** Which way along the road at (x, z): the longest run of road, preferring to face away from `from`. */
  const roadHeading = (x: number, z: number, from: { x: number; z: number }) => {
    const ax = x - from.x;
    const az = z - from.z;
    const al = Math.hypot(ax, az) || 1;
    let best = Math.atan2(-az, ax);
    let bestScore = -Infinity;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      let run = 0;
      while (run < 8 && map.surfaceAt?.(x + dx * 2 * (run + 1), z + dz * 2 * (run + 1)) === 'road') run++;
      const score = run + 0.5 * ((dx * ax + dz * az) / al);
      if (score > bestScore) {
        bestScore = score;
        best = Math.atan2(-dz, dx);
      }
    }
    return best;
  };

  /** Out of the water onto the nearest road (or any dry ground), facing along it. */
  const fishOutCar = (c: (typeof cars)[number]) => {
    const t = c.car.body.translation();
    const road = map.nearest?.(t.x, t.z, SHORE_SEARCH, (x, z, surface, h) => surface === 'road' && dryGround(x, z, h, 0.5));
    const spot = road ?? map.nearest?.(t.x, t.z, SHORE_SEARCH, (x, z, _s, h) => dryGround(x, z, h, 0.5)) ?? map.spawn.feet;
    const ground = map.heightAt(spot.x, spot.z);
    c.car.place(new THREE.Vector3(spot.x, (Number.isNaN(ground) ? 0 : ground) + 1, spot.z), roadHeading(spot.x, spot.z, t));
    c.car.body.setLinearDamping(0.05);
    c.car.body.setAngularDamping(0.6);
    c.soaked = null;
    if (c.car === driving) chase.snap();
  };

  const fishOutPlayer = () => {
    const p = player.position;
    const spot = map.nearest?.(p.x, p.z, SHORE_SEARCH, (x, z, _s, h) => dryGround(x, z, h, 0.3)) ?? map.spawn.feet;
    const ground = map.heightAt(spot.x, spot.z);
    // Face inland: away from where they went in.
    const heading = Math.atan2(-(spot.z - p.z), spot.x - p.x);
    player.place(new THREE.Vector3(spot.x, (Number.isNaN(ground) ? 0 : ground) + 0.05, spot.z), heading);
    playerSoaked = null;
    chase.snap(heading);
  };

  /** Fell out of the world: put it back on the ground, just inside the map. */
  const rescue = (car: Car) => {
    const t = car.body.translation();
    const { x, z } = map.clamp(t.x, t.z);
    const ground = map.heightAt(x, z);
    const heading = new THREE.Euler().setFromQuaternion(car.object.quaternion, 'YXZ').y;
    car.place(new THREE.Vector3(x, (Number.isNaN(ground) ? 0 : ground) + 1.5, z), heading);
    if (car === driving) chase.snap();
  };

  /** What we send the room ~15 times a second. */
  const localPose = (): PoseBody => {
    if (driving) {
      const t = driving.body.translation();
      const r = driving.body.rotation();
      const v = driving.body.linvel();
      const d = input.drive;
      return {
        c: cars.findIndex((c) => c.car === driving),
        p: roundVec(t.x, t.y, t.z),
        q: roundQuat(r.x, r.y, r.z, r.w),
        v: roundVec(v.x, v.y, v.z),
        d: exitRequested ? [0, 0, 1, 0] : [round2(d.steer), round2(d.throttle), round2(d.brake), d.handbrake ? 1 : 0],
      };
    }
    const p = player.position;
    const h = player.heading;
    return {
      c: -1,
      p: roundVec(p.x, p.y, p.z),
      h: round2(h),
      v: roundVec(Math.cos(h) * player.speed, 0, -Math.sin(h) * player.speed),
      g: player.isGrounded ? 1 : 0,
      f: player.flying ? 1 : 0,
    };
  };

  /** Just joined a friend's room: out of any car and onto the ground beside them (their passenger side). */
  const spawnNear = async (at: Pose | null) => {
    if (!at) return;
    if (driving) exit(driving);
    setFlying(false);
    const [x, y, z] = at.p;
    await map.ensureLoaded(x, z);
    const inCar = at.c >= 0 && !!at.q;
    const heading = inCar ? new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...at.q!), 'YXZ').y : (at.h ?? 0);
    const from = { x, y: inCar ? y : y + 1, z };
    const reach = inCar ? 3 : 1.6;
    const exclude = inCar ? cars[at.c]?.car.collider : undefined;
    let spot = new THREE.Vector3(x, y, z);
    for (const turn of [Math.PI / 2, -Math.PI / 2, Math.PI, 0]) {
      const dir = { x: Math.cos(heading + turn), y: 0, z: -Math.sin(heading + turn) };
      if (world.castRay(new RAPIER.Ray(from, dir), reach + 0.5, true, undefined, undefined, exclude)) continue;
      spot = new THREE.Vector3(x + dir.x * reach, y, z + dir.z * reach);
      break;
    }
    const ground = map.heightAt(spot.x, spot.z, spot.y);
    spot.y = Number.isNaN(ground) ? spot.y + 0.5 : ground + 0.05;
    player.place(spot, heading);
    chase.snap(heading);
  };

  // Blob shadows lie on whatever is underneath, tilted to match slopes.
  const down = { x: 0, y: -1, z: 0 };
  const up = new THREE.Vector3(0, 1, 0);
  const _n = new THREE.Vector3();
  const _yawQ = new THREE.Quaternion();
  const shadowRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, down);
  const placeShadow = (shadow: THREE.Object3D, from: THREE.Vector3, yaw: number, exclude: RAPIER.Collider, reach: number) => {
    shadowRay.origin = { x: from.x, y: from.y, z: from.z };
    const hit = world.castRayAndGetNormal(shadowRay, reach, true, undefined, undefined, exclude);
    shadow.visible = !!hit;
    if (!hit) return;
    _n.set(hit.normal.x, hit.normal.y, hit.normal.z);
    shadow.position.set(from.x, from.y - hit.timeOfImpact, from.z).addScaledVector(_n, 0.04);
    shadow.quaternion.setFromUnitVectors(up, _n).multiply(_yawQ.setFromAxisAngle(up, yaw));
  };

  // A ResizeObserver fires after layout, so it sees the settled size after a rotation.
  new ResizeObserver(() => {
    const w = app.clientWidth;
    const h = app.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.fov = fitFov(w / h);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }).observe(app);

  const setMuteIcon = () => (muteBtn.textContent = audio.isMuted ? '🔇' : '🔊');
  setMuteIcon();
  muteBtn.addEventListener('pointerup', () => {
    audio.toggleMute();
    setMuteIcon();
  });

  // iPhone Safari has no fullscreen for pages and keeps its bars; only a
  // Home Screen launch (navigator.standalone true) gets the whole screen.
  if ((navigator as { standalone?: boolean }).standalone === false && coarse) {
    document.getElementById('install')!.classList.remove('hidden');
  }

  // Tap/click to start: unlock audio, go fullscreen and landscape where the browser allows.
  status.textContent = coarse ? 'Tap to play' : 'Click or press any key to play';
  let started = false;
  const start = async () => {
    if (started) return;
    started = true;
    input.clearPresses(); // the key that started the game shouldn't also do something
    audio.unlock();
    splash.classList.add('hidden');
    hud.classList.remove('hidden');
    if (fullMap) fullMap.enabled = true;
    if (coarse) {
      try {
        await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
        await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape');
      } catch {
        // iOS Safari and desktop browsers say no; that's fine.
      }
    }
  };
  splash.addEventListener('pointerup', (e) => {
    // The data credits are links: following one shouldn't also start the game.
    if (!(e.target instanceof Element && e.target.closest('a'))) start();
  });
  addEventListener('keydown', start, { once: true });
  // A shared link (?room=CODE): join while the title screen is up.
  const linked = params.get('room');
  if (linked) void room.join(linked);
  // Some mobile browsers suspend audio when backgrounded; any touch brings it back.
  addEventListener('pointerdown', () => started && audio.unlock());

  /** ?debug fixed viewpoint (screenshots), overriding the chase camera. */
  let debugView: { from: number[]; at: number[] } | null = null;
  // ?debug timing: JS ms per frame, smoothed (physics steps, render submit, whole frame).
  const perf = { physicsMs: 0, renderMs: 0, frameMs: 0 };
  const smooth = (prev: number, v: number) => prev + (v - prev) * 0.1;
  const _euler = new THREE.Euler();
  const _look = new THREE.Vector3();
  let accumulator = 0;
  let last = performance.now();
  let fpsFrames = 0;
  let fpsTime = 0;
  let fps = 60;
  const _p = new THREE.Vector3();
  const _a = new THREE.Vector3();

  /**
   * ?debug manual clock (scripts/smoke): the simulation only advances
   * through __game.step(), a fixed tick at a time, so tests don't depend on
   * how fast this machine renders. The animation loop then just draws.
   */
  let manual = false;
  /** Manual mode: draw on the next animation frame (for a screenshot). */
  let drawRequested = false;

  /**
   * Every fixed tick after the physics step: landings and car hits make you
   * dizzy (and knock you flying), and the pedestrians walk, get hit and react.
   */
  const afterTick = (drivingIndex: number) => {
    const speeds = carSpeeds.measure(carLikes, FIXED_DT);
    const onFoot = !driving && !player.flying;
    const body = player.body.translation();
    if (onFoot && player.landed > 0) {
      if (player.landed > DIZZY.fallSpeed) dizzy.trigger(severity(player.landed, DIZZY.fallSpeed), 'fall');
      player.landed = 0;
    }
    if (onFoot) {
      // A moving car (someone else's, or one rolling on its own) reaching you on foot.
      for (const [i, c] of carLikes.entries()) {
        const v = speeds[i];
        if (!v || cars[i].frozen || tickClock - hitPlayerAt[i] < HIT_COOLDOWN) continue;
        if (v.speed < Math.min(DIZZY.hitSpeed, HITS.minSpeed) || !inside(c, body.x, body.y, body.z, 0.35)) continue;
        hitPlayerAt[i] = tickClock;
        if (HITS.on) {
          const t = c.body.translation();
          const ax = body.x - t.x;
          const az = body.z - t.z;
          const al = Math.hypot(ax, az) || 1;
          // Like the pedestrians, a bit gentler: along the car, away from its middle, and up.
          player.knock(v.vx * HITS.launch * 0.7 + (ax / al) * 2, Math.min(12, HITS.upBoost + v.speed * 0.15), v.vz * HITS.launch * 0.7 + (az / al) * 2, 0.9);
        }
        if (v.speed > DIZZY.hitSpeed) dizzy.trigger(severity(v.speed, DIZZY.hitSpeed), 'hit');
        audio.impact(Math.min(0.7, 0.2 + v.speed / 25));
        chase.shake(0.4);
      }
    }
    if (peds) {
      for (const [i, c] of carLikes.entries()) c.player = i === drivingIndex;
      const focus = driving ? driving.body.translation() : body;
      const h = player.heading;
      const walker = onFoot ? { x: body.x, y: body.y, z: body.z, vx: Math.cos(h) * player.speed, vz: -Math.sin(h) * player.speed, speed: player.inControl ? player.speed : 0 } : null;
      const { stumble } = peds.step(FIXED_DT, focus, chase.yaw, carLikes, speeds.map((v, i) => (cars[i].frozen ? null : v)), walker);
      // Ran into someone: you bounce off them too.
      if (stumble && onFoot) player.knock(stumble.x * 2.5, 2.2, stumble.z * 2.5, 0.6);
    }
    tickClock += FIXED_DT;
  };
  /** Game time in fixed ticks (afterTick's clock). */
  let tickClock = 0;
  /** ?debug lastImpact(): the hardest knock the driven car's had. */
  let biggestImpact = 0;

  /**
   * One frame of game logic: input, physics steps for `frameDt` of game
   * time, then interpolation, camera, audio and HUD (everything but the
   * draw). `alpha` overrides the interpolation between physics poses.
   */
  const frame = (frameDt: number, alpha?: number) => {
    clock += frameDt;
    input.update();
    if (!started) input.clearPresses();
    // Game time, not wall time: a stalled frame shouldn't spoil a code.
    if (started && !driving && flyCode.feed(input.moveX, input.moveY, clock)) setFlying(!player.flying);
    if (input.consume('mute')) {
      audio.toggleMute();
      setMuteIcon();
    }
    const nearby = driving ? null : nearestCar();
    if (input.consume('enterExit')) {
      if (driving) exitRequested = true;
      else if (nearby) enter(nearby);
    }
    if (input.consume('reset') && driving) {
      resetCar(driving);
      chase.snap();
    }
    const jump = input.consume('jump');

    // Dizzy: wiggling the stick or mashing jump / handbrake shakes it off sooner.
    dizzy.update(frameDt, input.moveX, input.moveY, jump ? 1 : 0, !!driving);
    const daze = dizzy.amount;
    // Mush: the controls lag and drift, more the dizzier you are.
    const ease = 1 - Math.exp(-frameDt * THREE.MathUtils.lerp(40, 2.5, daze * DIZZY.mush));
    const dizzyT = dizzy.time;
    const drift = daze * DIZZY.mush * dizzy.drift();
    const slow = 1 - DIZZY.slowdown * daze;

    // Camera-relative movement on foot: stick up walks away from the camera.
    const cy = chase.yaw + drift;
    let moveX = (Math.cos(cy) * input.moveY - Math.sin(cy) * input.moveX) * slow;
    let moveZ = (Math.sin(cy) * input.moveY + Math.cos(cy) * input.moveX) * slow;
    if (daze > 0) {
      // Staggering about even with hands off the stick.
      moveX += Math.cos(dizzyT * 0.9) * 0.3 * daze * DIZZY.mush;
      moveZ += Math.sin(dizzyT * 1.3) * 0.3 * daze * DIZZY.mush;
    }
    eased.x += (moveX - eased.x) * ease;
    eased.z += (moveZ - eased.z) * ease;
    moveX = eased.x;
    moveZ = eased.z;
    const sprint = input.sprint && daze === 0;
    eased.steer += (input.drive.steer - eased.steer) * ease;
    Object.assign(dizzyDrive, input.drive, {
      steer: THREE.MathUtils.clamp(eased.steer + drift * 0.6, -1, 1),
      throttle: input.drive.throttle * (1 - DIZZY.slowdown * daze * 0.6),
    });

    map.update(debugView ? _p.fromArray(debugView.from) : driving ? driving.object.position : player.position);
    // Into the harbour: a splash, a moment sinking (heavily damped, like
    // water), then back on the nearest road.
    for (const c of cars) {
      // Someone else's car on our screen: their game puts it back, not ours.
      if (c.frozen || remotes.drives(c.car)) continue;
      const p = c.car.body.translation();
      if (c.soaked === null && inWater(p.x, p.y, p.z)) {
        c.soaked = clock;
        const v = c.car.body.linvel();
        makeSplash(p.x, p.z, Math.hypot(v.x, v.y, v.z) / 12, c.car === driving);
        c.car.body.setLinearDamping(2.5);
        c.car.body.setAngularDamping(3);
      } else if (c.soaked !== null && clock - c.soaked > SOAK_CAR) fishOutCar(c);
    }
    if (!driving && !player.flying) {
      const p = player.position;
      // Feet just under the surface is enough: they may be stuck on the drop by the sea wall.
      if (playerSoaked === null && inWater(p.x, p.y + SUBMERGED - 0.15, p.z)) {
        playerSoaked = clock;
        makeSplash(p.x, p.z, 0.5, true);
      } else if (playerSoaked !== null && clock - playerSoaked > SOAK_PLAYER) fishOutPlayer();
    } else if (driving) playerSoaked = null;
    // The town's traffic and parked cars: out of sight ones come and go, and the drivers decide what to do.
    if (town) {
      const focus = debugView ? _p.fromArray(debugView.from) : driving ? driving.object.position : player.position;
      const walker = !driving && !player.flying ? player.position : null;
      town.step(frameDt, focus, chase.yaw, { cars: carList, absent: (car) => frozenCar(car), walker }, (car) => car === driving || remotes.drives(car));
    }
    // Freeze anything standing on ground that hasn't streamed in yet, rather
    // than let it fall through the world (and the town's cars not out right now).
    for (const c of cars) {
      const p = c.car.body.translation();
      const remote = remotes.drives(c.car);
      const idle = !remote && !!town?.idle(c.car);
      const frozen = !remote && (idle || !map.hasGround(p.x, p.z));
      if (frozen !== c.frozen) c.car.body.setEnabled(!frozen);
      c.frozen = frozen;
      if (!remote && !idle && lost(p)) rescue(c.car);
    }
    // The physics body, not the interpolated model, which sits at the origin until the first render.
    const feet = player.body.translation();
    if (!driving && lost(feet)) {
      const { x, z } = map.clamp(feet.x, feet.z);
      const ground = map.heightAt(x, z);
      player.place(new THREE.Vector3(x, (Number.isNaN(ground) ? 0 : ground) + 0.5, z), player.heading);
      chase.snap(player.heading);
    }
    // Flying outruns the streaming sometimes, and there's no ground to fall through.
    const playerFrozen = !driving && !player.flying && !map.hasGround(player.position.x, player.position.z);
    // Fly over the harbour, not along its floor.
    const floor = player.flying ? Math.max(map.heightAt(feet.x, feet.z, feet.y), water ? water.level : -Infinity) : NaN;

    accumulator += frameDt;
    const tPhys = performance.now();
    let steps = 0;
    const drivingIndex = cars.findIndex((c) => c.car === driving);
    while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
      // Game time at the end of this step.
      remotes.beforeStep(clock - accumulator + FIXED_DT, drivingIndex, room.myId, !driving);
      for (const { car, frozen } of cars) {
        if (frozen) continue;
        // Parked, or someone else driving it on our screen (their controls just turn its wheels).
        if (car !== driving) car.update(remotes.controlsFor(car) ?? town?.controlsFor(car) ?? null, FIXED_DT);
        // Like GTA III: asking to get out at speed brakes to a stop first.
        else if (exitRequested) car.update({ throttle: 0, brake: Math.abs(car.forwardSpeed()) > 1 ? 1 : 0, steer: 0, handbrake: false }, FIXED_DT);
        else car.update(dizzyDrive, FIXED_DT);
      }
      if (!driving && !playerFrozen) player.update({ moveX, moveZ, sprint, jump: jump && steps === 0, rise: input.rise, floor }, FIXED_DT);
      world.step();
      for (const { car, frozen } of cars) if (!frozen) car.afterStep(FIXED_DT);
      if (!driving) player.afterStep();
      remotes.afterStep();
      afterTick(drivingIndex);
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS) accumulator = 0;
    perf.physicsMs = smooth(perf.physicsMs, performance.now() - tPhys);

    if (driving && exitRequested && Math.abs(driving.forwardSpeed()) < 1.5) exit(driving);
    if (evicted && driving) {
      exit(driving);
      roomPanel.toast('Someone else got in first');
    }
    evicted = false;

    // Stuck on its roof for a couple of seconds: flip it back over.
    upsideDownTime = driving && driving.isUpsideDown() && Math.abs(driving.forwardSpeed()) < 1 ? upsideDownTime + frameDt : 0;
    if (driving && upsideDownTime > 2) {
      resetCar(driving);
      upsideDownTime = 0;
    }

    map.sync();
    alpha ??= accumulator / FIXED_DT;
    /** The driven car's knock this frame, for missions. */
    let crash = 0;
    for (const [n, { car, frozen }] of cars.entries()) {
      if (frozen && town?.idle(car)) continue;
      car.render(alpha);

      // Skid marks from any sliding car, not just the one we're in.
      for (let i = 0; i < 4; i++) {
        const id = `${n}:${i}`;
        const rearOrHard = i >= 2 || car.skid > 0.6;
        if (car.skid > 0.25 && rearOrHard && car.wheelContact(i, _p, _a)) skids.add(id, _p, _a, car.skid);
        else skids.lift(id);
      }
      if (car.impact > 4 && car === driving) {
        const strength = Math.min(1, (car.impact - 4) / 12);
        audio.impact(strength);
        chase.shake(strength * 0.6);
      }
      if (car === driving) {
        crash = car.impact;
        biggestImpact = Math.max(biggestImpact, car.impact);
        if (CRASH_DIZZY.on && car.impact > CRASH_DIZZY.impact) {
          dizzy.trigger(severity(car.impact, CRASH_DIZZY.impact, CRASH_DIZZY.fullImpact), 'crash', CRASH_DIZZY.minTime, CRASH_DIZZY.maxTime);
        }
      }
      car.impact = 0;
    }
    skids.flush();
    splashes.update(frameDt);

    if (driving) {
      input.consumeLook(frameDt); // camera stays behind the car
      const speed = driving.forwardSpeed();
      const heading = _euler.setFromQuaternion(driving.object.quaternion, 'YXZ').y;
      chase.update(frameDt, DRIVING, driving.object.position, heading, speed, driving.collider);
      speedo.textContent = `${Math.round(Math.abs(speed) * 3.6)}`;
      audio.setEngine(true, speed, driving.throttle);
      audio.setSkid(driving.skid, speed);
    } else {
      player.render(alpha, frameDt);
      placeShadow(playerShadow, _p.copy(player.position).setY(player.position.y + 0.9), 0, player.collider, 3);
      // Swing in behind only while heading away from the camera, so walking
      // sideways or towards the camera doesn't send it spinning.
      const awayFromCamera = input.moveY > 0.3 && input.moveY > Math.abs(input.moveX) * 0.5;
      chase.rotate(input.consumeLook(frameDt) * 0.006);
      chase.update(frameDt, player.flying ? FLYING : ON_FOOT, player.position, player.heading, player.speed, player.collider, player.speed > 0.5 && awayFromCamera);
      audio.setEngine(false, 0, 0);
      audio.setSkid(0, 0);
      if (player.stepped && !player.flying) audio.footstep();
    }
    player.stepped = false;

    // Seeing stars: over your head, or over the car if you're driving.
    player.wobble = driving ? 0 : daze;
    chase.sway(daze * DIZZY.sway);
    stars.begin();
    if (daze > 0) {
      const at = driving ? driving.object.position : player.position;
      stars.add(at.x, at.y + (driving ? 1.25 : 1.95), at.z, daze, clock);
    }
    if (peds) {
      pedsMesh.update(peds.list, alpha, frameDt, camera.position, (x, y, z, a, t) => stars.add(x, y, z, a, t));
      for (const e of peds.events) {
        const near = 1 - _p.set(e.x, e.y, e.z).distanceTo(camera.position) / BARK_RANGE;
        if (e.kind === 'hit') {
          audio.impact(Math.min(0.6, 0.15 + e.speed / 30) * (e.byPlayer ? 1 : Math.max(0, near)));
          if (e.byPlayer) chase.shake(0.25);
        } else if (e.kind === 'bounce' && near > 0) audio.impact(e.strength * 0.2 * near);
        else if (e.kind === 'bark') audio.bark(near, e.pitch);
      }
      peds.events.length = 0;
    } else pedsMesh.update([], alpha, frameDt, camera.position, () => {});
    stars.end();

    // Missions run on physics poses, not interpolated ones, so stepped tests replay exactly.
    if (missions && started) {
      const at = driving ? driving.body.translation() : player.body.translation();
      const alone = room.role === 'solo';
      missions.tick({
        clock, x: at.x, y: at.y, z: at.z, driving: !!driving, speedKmh: driving ? Math.abs(driving.forwardSpeed()) * 3.6 : 0, crash,
        id: room.myId, name: alone ? 'You' : room.name, others: alone ? [] : remotes.players(), guest: room.role === 'guest',
      });
      for (const cue of missions.takeCues()) audio.cue(cue);
      for (const id of missions.takeRequests()) room.requestMission(id);
      // The shared mission to the guests, a few times a second (game time, so stepped tests send it too).
      if (clock < lastShared) lastShared = -Infinity;
      if (room.role === 'host' && clock - lastShared >= SHARE_EVERY) {
        lastShared = clock;
        const st = missions.share();
        if (st) room.sendMission(st);
      }
    }
    // On foot the camera is always close; this only hides them from far debug views.
    player.object.visible = !driving && player.position.distanceTo(camera.position) < CAR_DETAIL;
    playerShadow.visible = player.object.visible;
    speedoBox.classList.toggle('hidden', !driving);
    input.setCanEnter(!!nearby);
    prompt.textContent = nearby
      ? (coarse ? 'Tap 🚗 to get in' : 'Press F to get in')
      : player.flying && !driving
        ? (coarse ? 'Flying: UP / DOWN to climb, the same code to land' : 'Flying: Space / C to climb, Shift for speed, the same code to land')
        : (missions?.view().hint ?? '');

    // Don't follow a sinking car under the water: watch from just above it.
    if (water && camera.position.y < water.level + 0.6) {
      const ground = map.heightAt(camera.position.x, camera.position.z);
      if (!Number.isNaN(ground) && water.covers(ground)) camera.position.y = water.level + 0.6;
    }
    applyDebugView();
    skyDome.follow(camera);
    water?.update(camera, clock);
    camera.updateMatrixWorld();
    drawCars();
    remotes.render(alpha, frameDt, camera);
    bubbles.update(peds ? peds.list.filter((p) => p.saysFor > 0).map((p) => ({ x: p.x, y: p.y + BUBBLE_LIFT, z: p.z, text: p.says })) : [], camera);
    room.tick(clock);
    if (missions) {
      const view = missions.view();
      markers.update(view, map.heightAt, camera.position, clock);
      missionHud.update(view);
    }
    // Stepped tests (manual) keep the route up to date but only draw the minimap when they draw a frame.
    if (minimap && !manual) drawMinimap(frameDt);
    else if (minimap) navigate();
  };

  /** Minimap radius, m: wider the faster you go. */
  let mapRadius = MAP_RADIUS;
  const _dir = new THREE.Vector3();
  /** The bearing something faces (cars and people face local +x). */
  const facingOf = (o: THREE.Object3D) => {
    const h = _euler.setFromQuaternion(o.quaternion, 'YXZ').y;
    return bearing(Math.cos(h), -Math.sin(h));
  };
  /** Missions to start, goals and others in the room, for both maps (names on the full one). */
  const mapBlips = (full: boolean): Blip[] => {
    const out: Blip[] = [];
    const view = missions?.view();
    if (view) {
      for (const s of view.starts) out.push({ kind: 'mission', x: s.x, z: s.z, label: full ? s.title : undefined, edge: s === view.nearest });
      for (const t of view.targets) out.push({ kind: 'goal', x: t.x, z: t.z, label: full ? t.label : undefined, edge: true });
    }
    if (room.role !== 'solo') for (const p of remotes.players()) out.push({ kind: 'remote', x: p.x, z: p.z, label: full ? p.name : undefined });
    return out;
  };
  /** Routes from where you are to your waypoint, else the mission's goal. */
  const navigate = () => {
    const you = (driving ? driving.object : player.object).position;
    nav.update(you, missions?.view().target ?? null, clock);
    return you;
  };
  const mapScene = () => {
    const you = navigate();
    return { you: { x: you.x, z: you.z, facing: facingOf(driving ? driving.object : player.object) }, route: nav.route, blips: mapBlips(true) };
  };
  const drawMinimap = (dt: number) => {
    const you = navigate();
    const speed = driving ? Math.abs(driving.forwardSpeed()) : 0;
    mapRadius += (Math.min(MAP_RADIUS_MAX, MAP_RADIUS + speed * MAP_RADIUS_PER_MS) - mapRadius) * Math.min(1, dt * 1.5);
    camera.getWorldDirection(_dir);
    const blips = mapBlips(false);
    if (nav.waypoint) blips.push({ kind: 'waypoint', x: nav.waypoint.x, z: nav.waypoint.z, edge: true });
    blips.push({ kind: 'player', x: you.x, z: you.z, facing: facingOf(driving ? driving.object : player.object) });
    const dest = nav.destination(missions?.view().target ?? null);
    const d = nav.left;
    const label = dest ? `${dest.kind === 'waypoint' ? '' : `${dest.label} · `}${d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`}` : '';
    minimap!.draw(you.x, you.z, bearing(_dir.x, _dir.z), mapRadius, nav.route, blips, label);
  };

  /** Every car in view into the fleet's instanced meshes: the whole car near, just the body further out, shadows within CAR_DETAIL. */
  const drawCars = () => {
    fleet.begin(camera);
    for (const { car, frozen } of cars) {
      if (frozen && town?.idle(car)) continue;
      const seen = car.object.position.distanceTo(camera.position);
      if (seen > CAR_DRAW || !fleet.inView(car.object.position)) continue;
      let shadow: THREE.Object3D | null = null;
      if (seen < CAR_DETAIL) {
        const yaw = _euler.setFromQuaternion(car.object.quaternion, 'YXZ').y;
        placeShadow(shadowPose, car.object.position, yaw, car.collider, 2.6);
        if (shadowPose.visible) shadow = shadowPose;
      }
      fleet.add(car, seen < CAR_WHEELS ? 2 : seen < CAR_FAR ? 1 : 0, shadow);
    }
    fleet.end();
  };

  const applyDebugView = () => {
    if (!debugView) return;
    camera.position.fromArray(debugView.from);
    camera.lookAt(_look.fromArray(debugView.at));
  };

  renderer.setAnimationLoop((now) => {
    const t0 = performance.now();
    const frameDt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (!manual) {
      if (!paused) frame(frameDt);
    } else {
      // Paused: fixed viewpoints still stream the city round them, but
      // nothing is drawn until a test asks (software rendering is slow).
      if (debugView) {
        map.update(_p.fromArray(debugView.from));
        map.sync();
        applyDebugView();
        skyDome.follow(camera);
      }
      if (!drawRequested) return;
      drawRequested = false;
      if (minimap) drawMinimap(0);
    }
    const tRender = performance.now();
    renderer.render(scene, camera);
    const tEnd = performance.now();
    perf.renderMs = smooth(perf.renderMs, tEnd - tRender);
    perf.frameMs = smooth(perf.frameMs, tEnd - t0);

    // Adaptive resolution: trade sharpness for frame rate on slower phones.
    fpsFrames++;
    fpsTime += frameDt;
    if (fpsTime >= 1) {
      fps = fpsFrames / fpsTime;
      if (fps < 45 && pixelRatio > 0.75) pixelRatio = Math.max(0.75, pixelRatio - 0.25);
      else if (fps > 58 && pixelRatio < maxRatio) pixelRatio = Math.min(maxRatio, pixelRatio + 0.25);
      if (renderer.getPixelRatio() !== pixelRatio) renderer.setPixelRatio(pixelRatio);
      if (debug) {
        const { render, memory } = renderer.info;
        fpsEl.textContent =
          `${fps.toFixed(0)} fps · ${pixelRatio.toFixed(2)}x · ${render.calls} calls · ${(render.triangles / 1000).toFixed(0)}k tris · ` +
          `${memory.geometries} geo ${memory.textures} tex · js ${perf.frameMs.toFixed(1)} ms (phys ${perf.physicsMs.toFixed(1)}, ` +
          `render ${perf.renderMs.toFixed(1)}) · ${map.debugInfo().loaded ?? 0} chunks`;
      }
      fpsFrames = 0;
      fpsTime = 0;
    }
  });

  /**
   * ?debug: pauses real time (see `manual`) and advances the game `n` fixed
   * ticks of 1/60 s, without drawing. Between batches it waits for the
   * ground round the player (or car, or debug view) to finish streaming,
   * so chunks arrive at the same game time on any machine.
   */
  const step = async (n = 1) => {
    if (!manual) accumulator = 0; // each frame below is then exactly one physics step
    manual = true;
    for (let done = 0; done < n; ) {
      const p = debugView ? _p.fromArray(debugView.from) : driving ? driving.object.position : player.position;
      await map.ensureLoaded(p.x, p.z);
      // Everything the streamer wants from here, not just what a frame happened to start.
      for (map.update(p); map.debugInfo().inFlight; map.update(p)) {
        while (map.debugInfo().inFlight) await new Promise((r) => setTimeout(r, 10));
      }
      const batch = Math.min(STEP_BATCH, n - done);
      // alpha 1: show the latest physics pose, the one the test just stepped to.
      for (let i = 0; i < batch; i++) {
        frame(FIXED_DT, 1);
        // Let mission scripts carry on from this tick before the next, as
        // they would between real frames (a few promise hops deep; microtasks
        // only, so nothing else gets in).
        if (missions?.active) for (let k = 0; k < SCRIPT_HOPS; k++) await null;
      }
      done += batch;
    }
  };

  // State and test hooks for automated tests (scripts/smoke). Only with ?debug.
  if (debug) {
    (window as unknown as { __game: unknown }).__game = {
      state: () => ({
        started,
        mode: driving ? 'car' : 'foot',
        drivingIndex: cars.findIndex((c) => c.car === driving),
        player: player.position.toArray(),
        playerGrounded: player.isGrounded,
        flying: player.flying,
        speedKmh: driving ? Math.abs(driving.forwardSpeed()) * 3.6 : 0,
        skid: driving?.skid ?? 0,
        skidQuads: skids.laid,
        nearCar: !!nearestCar(),
        /** The ? panel or the full map is open (the game is paused). */
        paused,
        dizzy: dizzy.active,
        peds: peds?.list.length ?? 0,
        /** The map's parked cars (the town's are in town()). */
        cars: cars.slice(0, fixedCars).map(({ car }) => car.object.position.toArray()),
        /** The town's cars out: driving themselves, and parked or left about. */
        traffic: town ? town.list.filter((t) => t.kind === 'driving').length : 0,
        townCars: town ? town.list.filter((t) => t.kind !== 'idle').length : 0,
        carsDrawn: fleet.drawn,
        audio: audio.state,
        fps,
        /** Draw calls and triangles in the last rendered frame. */
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        /** Smoothed JS ms per frame: physics steps, render submission, the whole frame. */
        ...perf,
        map: map.name,
        /** Unit vector towards the sun (north is -z). */
        sun: sun.position.clone().normalize().toArray(),
        /** Sea level, or null if the map has no water. */
        water: water ? water.level : null,
        /** Splashes so far, and whether the player or any car is in the water right now. */
        splashes: splashes.count,
        soaked: playerSoaked !== null || cars.some((c) => c.soaked !== null),
        /** Ground height under the player, or under the car being driven. */
        ground: (() => {
          const p = driving ? driving.object.position : player.position;
          return map.heightAt(p.x, p.z, p.y);
        })(),
        /** Surface under the player, or under the car being driven. */
        surface: (() => {
          const p = driving ? driving.object.position : player.position;
          return map.surfaceAt?.(p.x, p.z) ?? null;
        })(),
        ...map.debugInfo(),
      }),
      groundHeight: (x: number, z: number) => map.heightAt(x, z),
      /** Hand-made landmarks loaded: id, position, base and height, detail level drawn. */
      landmarks: () => map.landmarks?.() ?? [],
      /** Fix the camera at `from` looking at `at` ([x, y, z]); pass null to go back to the chase camera. */
      lookFrom: (from: number[] | null, at: number[]) => (debugView = from ? { from, at } : null),
      /**
       * Triangles and meshes in the camera's view by kind (the first word of
       * each mesh's name: terrain, buildings, roads...), for finding what
       * eats the budget.
       */
      breakdown: () => {
        const frustum = new THREE.Frustum().setFromProjectionMatrix(
          new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
        );
        const out: Record<string, { meshes: number; tris: number }> = {};
        scene.traverseVisible((o) => {
          if (!(o instanceof THREE.Mesh) || (o.frustumCulled && !frustum.intersectsObject(o))) return;
          const g = o.geometry as THREE.BufferGeometry;
          // Instanced meshes (every car is one) draw their geometry once per instance.
          const count = Math.min(g.index ? g.index.count : g.attributes.position.count, g.drawRange.count) * (o instanceof THREE.InstancedMesh ? o.count : 1);
          const kind = (o.name || 'unnamed').split(' ')[0];
          const e = (out[kind] ??= { meshes: 0, tris: 0 });
          e.meshes++;
          e.tris += Math.floor(count / 3);
          // Merged chunk meshes say how much of each layer they hold.
          for (const [k, v] of Object.entries((o.userData.parts ?? {}) as Record<string, number>)) {
            const p = (out[`${kind}.${k}`] ??= { meshes: 0, tris: 0 });
            p.meshes++;
            p.tris += v;
          }
        });
        return out;
      },
      /**
       * Distance along a ray to the first drawn city surface (chunk meshes:
       * ground, roads, buildings and verandahs, which have no colliders, the
       * landmarks and the far skyline), or null.
       */
      renderHit: (from: number[], dir: number[], far = 50) => {
        scene.updateMatrixWorld(); // paused (manual mode), nothing may have been drawn since chunks arrived
        const ray = new THREE.Raycaster(new THREE.Vector3().fromArray(from), new THREE.Vector3().fromArray(dir).normalize(), 0, far);
        const chunks = scene.children.filter((o) => o.visible && (o.name.startsWith('chunk') || o.name.startsWith('landmark') || o.name === 'skyline'));
        return ray.intersectObjects(chunks, false)[0]?.distance ?? null;
      },
      /** Whether a point is inside the camera's view frustum (not whether something hides it). */
      inView: (p: number[]) => {
        camera.updateMatrixWorld();
        const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        return new THREE.Frustum().setFromProjectionMatrix(m).containsPoint(new THREE.Vector3().fromArray(p));
      },
      /** Camera position. */
      camera: () => camera.position.toArray(),
      /** Names of the map's fixed views (performance budgets are measured from them). */
      views: () => Object.keys(map.views ?? {}),
      /** Fix the camera on one of the map's named views, its heights above the ground there. */
      view: async (name: string) => {
        const v = map.views?.[name];
        if (!v) throw new Error(`no view ${name}`);
        const lift = async ([x, y, z]: number[]) => {
          await map.ensureLoaded(x, z);
          const g = map.heightAt(x, z);
          return [x, (Number.isNaN(g) ? 0 : g) + y, z];
        };
        debugView = { from: await lift(v.from), at: await lift(v.at) };
        return debugView;
      },
      /**
       * Loads the ground at (x, z), then returns the sampled terrain height,
       * the height of the terrain collider straight down from 1 km up (null if
       * none) and of the first fixed collider of any kind (a roof, if there's
       * a building there), plus the surface class there ('road', 'footpath', ...).
       */
      probe: async (x: number, z: number) => {
        await map.ensureLoaded(x, z);
        // New colliders only join scene queries on the next physics step.
        if (manual) await step(2);
        else for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame);
        const ray = new RAPIER.Ray({ x, y: 1000, z }, down);
        const hit = world.castRay(ray, 2000, true, RAPIER.QueryFilterFlags.ONLY_FIXED, TERRAIN_ONLY_QUERY);
        const top = world.castRay(ray, 2000, true, RAPIER.QueryFilterFlags.ONLY_FIXED);
        return {
          ground: map.heightAt(x, z),
          ray: hit ? 1000 - hit.timeOfImpact : null,
          top: top ? 1000 - top.timeOfImpact : null,
          surface: map.surfaceAt?.(x, z) ?? null,
          canopy: map.canopyAt?.(x, z) ?? null,
        };
      },
      /** Put the player (on foot) at (x, z) on the ground, facing `heading`, with the camera behind. */
      placePlayer: async (x: number, z: number, heading: number) => {
        await map.ensureLoaded(x, z);
        player.place(new THREE.Vector3(x, map.heightAt(x, z) + 0.05, z), heading);
        chase.snap(heading);
      },
      /** Drop the player (index -1) or a car this far below the terrain, to test the fall-out-of-world rescue. */
      sink: async (index: number, depth: number) => {
        const p = index < 0 ? player.position.clone() : cars[index].car.object.position.clone();
        await map.ensureLoaded(p.x, p.z);
        p.y = map.heightAt(p.x, p.z) - depth;
        if (index < 0) player.place(p, player.heading);
        else cars[index].car.place(p, 0);
      },
      /** Parked cars' poses: position and up vector's y (1 = level). */
      carPoses: () => cars.map(({ car, frozen }) => ({
        pos: car.object.position.toArray(),
        up: new THREE.Vector3(0, 1, 0).applyQuaternion(car.object.quaternion).y,
        frozen,
      })),
      /** Rooms: our role, code and id, who's here, and where we see the others (and which car they're in). */
      room: () => ({ role: room.role, code: room.code, busy: room.busy, error: room.error, myId: room.myId, members: room.list().map(({ id, name, host, rate, stats }) => ({ id, name, host, rate, stats })), remotes: remotes.debug() }),
      /** Start hosting; `local`: over a BroadcastChannel to other tabs (smoke tests), not PeerJS. */
      host: (local = false) => {
        room.local ||= local;
        return room.host();
      },
      join: (code: string, local = false) => {
        room.local ||= local;
        return room.join(code);
      },
      leaveRoom: () => room.leave(),
      /** Whether each parked car is being driven by someone else in the room (kinematic on our screen). */
      remoteCars: () => cars.map(({ car }) => remotes.drives(car)),
      /** The town's cars that are out (src/traffic.ts): `index` is into the pools, which start at car `first`. */
      town: () => ({ first: fixedCars, cars: town?.debug() ?? [], stats: town?.stats ?? null }),
      /** Missions: what's on screen (banner, subtitle, timer, goal, start markers), how the last one ended, everything said. */
      missions: () => missions?.debugState() ?? null,
      /** Start a mission by id where the player is, abandoning any running one. */
      startMission: (id: string) => missions?.start(id),
      /**
       * The gazetteer: places of a kind (or all), nearest first with `near`, e.g.
       * places('bar', { near: [x, z], within: 200 }). Mission authors find ids here.
       */
      places: (kind?: string, q: { near?: [number, number]; within?: number } = {}) =>
        map.places?.find(kind, { near: q.near && { x: q.near[0], z: q.near[1] }, within: q.within }) ?? [],
      /** One place by id. */
      place: (id: string) => map.places?.get(id) ?? null,
      /** The road graph's size: nodes, edges, km (and km where traffic can always drive on), one-ways, signals. */
      roadGraph: () => map.roads?.stats() ?? null,
      /** The nearest road to (x, z): its edge, how far along, which side, and the street's lanes. */
      roadAt: (x: number, z: number, within?: number) => {
        const r = map.roads?.nearest(x, z, { within, open: false });
        if (!r) return null;
        const { edge: e, ...at } = r;
        return { ...at, edge: e.index, name: e.name, highway: e.highway, fw: e.fw, bw: e.bw, width: e.width, length: e.length, stops: [e.stopA, e.stopB], main: e.main, restricted: e.restricted };
      },
      /**
       * The shortest legal drive between two points: metres, the centreline,
       * and each leg (edge, direction, street, whether it was driven with the
       * traffic, which is always true unless routing is broken, and its midpoint).
       */
      route: (from: [number, number], to: [number, number]) => {
        const r = map.roads?.route({ x: from[0], z: from[1] }, { x: to[0], z: to[1] });
        if (!r) return null;
        return {
          length: r.length,
          points: r.points.map((p) => [p.x, p.z]),
          legs: r.legs.map((l) => {
            const mid = map.roads!.pointAt(l.edge, l.edge.length / 2);
            return { edge: l.edge.index, dir: l.dir, name: l.edge.name, bridge: l.edge.bridge, legal: (l.dir > 0 ? l.edge.fw : l.edge.bw) > 0, mid: [mid.x, mid.y, mid.z] };
          }),
        };
      },
      /** Dizzy: whether you are, for how much longer, immune, what did it, wiggles that cut it short. */
      dizzy: () => dizzy.debug(),
      /** Pedestrians near the player: each one's state, position and what they're saying, plus totals. */
      peds: () => ({ list: peds?.debug() ?? [], stats: peds?.stats ?? null, drawn: pedsMesh.mesh.count, stars: stars.drawn }),
      /** Someone standing still at (x, z) (a test target); returns their id. */
      spawnPed: async (x: number, z: number, heading = 0) => {
        await map.ensureLoaded(x, z);
        return peds?.spawnAt(x, z, heading)?.id ?? null;
      },
      /** Every ? panel value by section, or set one: knob('dizzy.on', false), knob('peds.count', 4). */
      knobs: () => allValues(),
      knob: (path: string, value: number | boolean) => {
        const [id, key] = path.split('.');
        setValue(id, key, value);
        return allValues()[id];
      },
      /** Lift the player (on foot) this high above the ground where they stand, to fall. */
      dropPlayer: (height: number) => {
        const p = player.body.translation();
        const g = map.heightAt(p.x, p.z, p.y - 0.9);
        player.place(new THREE.Vector3(p.x, (Number.isNaN(g) ? p.y : g) + height, p.z), player.heading);
      },
      /**
       * Send car `index` at the player on foot at `speed` m/s from `from` m
       * away (behind them), to test being hit.
       */
      hitPlayer: (index: number, speed: number, from = 6) => {
        const p = player.body.translation();
        const h = player.heading;
        const x = p.x - Math.cos(h) * from;
        const z = p.z + Math.sin(h) * from;
        const car = cars[index].car;
        const g = map.heightAt(x, z);
        car.place(new THREE.Vector3(x, (Number.isNaN(g) ? p.y : g) + 0.9, z), h);
        car.body.setLinvel({ x: Math.cos(h) * speed, y: 0, z: -Math.sin(h) * speed }, true);
      },
      /** Set car `index` moving at `speed` m/s the way it faces (to test a crash at a given speed). */
      launchCar: (index: number, speed: number) => {
        const car = cars[index].car;
        const h = _euler.setFromQuaternion(car.object.quaternion, 'YXZ').y;
        car.body.setLinvel({ x: Math.cos(h) * speed, y: 0, z: -Math.sin(h) * speed }, true);
      },
      /** The largest crash impact (m/s of sudden speed change) the driven car has had since the last call. */
      lastImpact: () => {
        const v = biggestImpact;
        biggestImpact = 0;
        return v;
      },
      step,
      /** Manual mode: draw a frame (for a screenshot); resolves once it's on screen. */
      draw: async () => {
        drawRequested = true;
        for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame);
      },
      /** Back to real time after step(). */
      realtime: () => {
        manual = false;
      },
      /**
       * Back to the start: on foot at the spawn, not flying, every car on its
       * parking spot and out of the water, the chase camera behind, the
       * clock paused (manual). For smoke areas that run on their own (--only).
       */
      reset: async () => {
        debugView = null;
        room.leave(true);
        if (driving) exit(driving);
        setFlying(false);
        for (const [i, c] of cars.entries()) {
          const spot = spots[i];
          c.car.place(spot.pos.clone(), spot.heading, spot.pitch, spot.roll);
          c.car.body.setLinearDamping(0.05);
          c.car.body.setAngularDamping(0.6);
          c.soaked = null;
        }
        await map.ensureLoaded(map.spawn.feet.x, map.spawn.feet.z);
        player.place(map.spawn.feet.clone(), map.spawn.heading);
        playerSoaked = null;
        upsideDownTime = 0;
        missions?.reset();
        tweaksPanel.toggle(false);
        fullMap?.toggle(false);
        nav.reset();
        mapRadius = MAP_RADIUS;
        resetValues();
        dizzy.reset();
        peds?.reset(1);
        town?.reset();
        carSpeeds.reset();
        hitPlayerAt.fill(-Infinity);
        eased.x = eased.z = eased.steer = 0;
        tickClock = 0;
        input.clearPresses();
        chase.snap(map.spawn.heading);
        await step(2); // and stays paused: what follows is stepped from here
      },
      /** The map: whether the minimap's up and the full map open, the waypoint, where you're headed and the route there. */
      mapState: () => {
        navigate();
        const dest = nav.destination(missions?.view().target ?? null);
        return {
          minimap: !!minimap && minimap.el.offsetWidth > 0,
          open: fullMap?.open ?? false,
          waypoint: nav.waypoint && { x: Math.round(nav.waypoint.x), z: Math.round(nav.waypoint.z) },
          destination: dest && { kind: dest.kind, x: Math.round(dest.x), z: Math.round(dest.z) },
          routePoints: nav.route?.length ?? 0,
          routeLeft: Math.round(nav.left),
        };
      },
      /** Set the waypoint (on the nearest road), or clear it with no arguments. */
      waypoint: (x?: number, z?: number) => (x === undefined || z === undefined ? (nav.waypoint = null) : nav.setWaypoint(x, z)),
      /** Open or close the full map. */
      openMap: (open = true) => fullMap?.toggle(open),
      /** Where a ground point is on the open full map, in page px (to click it). */
      mapPoint: (x: number, z: number) => fullMap?.screenOf(x, z) ?? null,
      /**
       * Move a car (default: the purple one) to (x, z) on the ground, facing
       * `heading`; give `y` to put it on a floor under the ground (a car park).
       */
      teleportCar: async (index: number, x: number, z: number, heading: number, y?: number) => {
        await map.ensureLoaded(x, z);
        const car = cars[index].car;
        car.place(new THREE.Vector3(x, map.heightAt(x, z, y) + 0.9, z), heading);
        if (car === driving) chase.snap();
      },
    };
  }
}

main().catch((err) => {
  console.error(err);
  const status = document.getElementById('status');
  if (status) status.textContent = `Couldn't start: ${err instanceof Error ? err.message : err}`;
});
