# Grand Theft Auckland

GTA III-flavoured driving game set in the real Auckland CBD (and Parnell, out to Hobson Bay), in the browser on
phones and desktop. Three.js + Rapier (WASM physics) + TypeScript + Vite,
deployed to Cloudflare Pages. Goal and data sources: `docs/BRIEF.md`.

**Backlog is GitHub issues** on `jay-aye-see-kay/grand-theft-auckland`
(labels: `next`, `later`, `parked`, `needs-owner`, `blocked`, plus areas). Read
the issue you're working on, leave short progress notes there as comments if
you stop partway, and close it with `closes #N` in the commit or PR. Live:
https://cartheft.net/ (`?debug` for perf overlay and test hooks).

## Commands

```sh
npm ci
npm run build   # tsc typecheck + vite build into dist/
npm run sim     # headless car handling report (Node, no browser)
npm run smoke   # after build: core checks in headless Chromium (~30 s)
npm run smoke:full   # every area (a few min); `npm run smoke -- --only=harbour,fly`
npm run dev     # dev server with --host, for phones on the LAN
npm run citygen:build   # regenerate public/city/cbd/ (fetches OSM + LiDAR into .cache/)
npm run citygen:places  # just the gazetteer (places.json), e.g. after editing names or overrides
npm run citygen:roadgraph  # just the road graph (roadgraph.json)
npm run citygen:map     # just the map picture (map.png), from the committed chunks
```

CI (`.github/workflows/cloudflare.yml`) builds and deploys every pushed branch to
Cloudflare Pages: `main` to https://cartheft.net/, others to a preview at
`https://<branch>.cartheft.pages.dev` (slashes become dashes; the URL is in the run
summary). It does not run sim or smoke, so run them before pushing. New features
get a check in an area under `scripts/smoke/areas/` (core ones only if quick).

## Layout

- `src/main.ts`: game loop (fixed 60 Hz physics, render interpolation), enter/exit, HUD, `?debug` hooks
- `src/car.ts` (`TUNING`; parked cars sleep until knocked), `src/corolla.ts` (model, baked to shared geometry),
  `src/car-fleet.ts` (every car drawn in five instanced calls: bodies with per-car paint, lamps, wheels, a
  ~50-triangle stand-in past 80 m, blob shadows; culled per car on the CPU), `src/player.ts` (also the body plan
  pedestrians share), `src/camera.ts` (chase camera: look round and up by hand, eases back behind after
  `LOOK.recentreDelay`, on the move only in a car or boat; C looks behind; wheel zooms),
  `src/input.ts` (touch/keyboard/gamepad; `LOOK`; a click locks the mouse for looking, released while paused;
  M/Tab map, N mute; `?debug` `__game.look(x, y)`, `state().cam`; smoke: `camera.mjs`), `src/cheats.ts` (stick-flick codes: ↑↑↓↓←→←→ flies),
  `src/audio.ts` (synthesised), `src/skids.ts`
- `src/map/` (#14): `chart.ts` (map.png with the road graph stroked over it once, into one 2D canvas; draws
  views of it, the route and blips), `minimap.ts` (round, top left, turns with the camera, zooms out with speed;
  goal, waypoint and nearest mission cling to its rim; tap for the full map), `full-map.ts` (north up, drag/pinch/
  wheel, tap sets a waypoint or picks a mission, Tab / Esc; pauses the game), `navigator.ts` (destination: your
  waypoint, else the mission's goal; road route, re-routed off it, trimmed behind you), `style.ts` (colours,
  shared with citygen). 2D canvas, so no WebGL draw calls. `?debug`: `__game.mapState()`, `waypoint(x, z)`
  (none to clear), `openMap(open)`, `mapPoint(x, z)` (page px on the open map, to click).
- `src/boat.ts` (`BOAT_SPECS`: tinny, runabout, launch; `BOATING` on the ? panel), `src/boat-mesh.ts` (lofted hulls,
  one instanced call per kind in view): boats to borrow from the map's `moorings` (`src/maps/auckland.ts`). A rigid
  body held up by buoyancy springs at five hull points under a game-time swell, an outboard at the stern, a keel
  across; nose-up planing and banking are drawn only. At load each is settled (`settleBoats` in main.ts, a step after
  its ground's colliders arrive) at the nearest deep, clear spot alongside dry ground, side-on, then `moor()`ed on soft
  lines until someone takes it (and wherever they leave it). Get in from the wharf edge (`BOARD_RANGE` from the hull's
  side); getting out steps onto dry ground within `LAND_REACH`, else over the side (fished out). Cops can't reach you
  afloat (`flying` to them). Each client has its own; in a room others see you standing at the helm. Map blips: teal
  hulls. `?debug`: `__game.boats()`, `besideBoat(i)`, `boardBoat(i, x?, z?, heading?)`; `state()` has `mode: 'boat'`,
  `nearBoat`. Smoke: `boats.mjs`.
- `src/sky.ts`, `src/sun.ts`, `src/splash.ts` (title screen with data credits)
- `src/graphics.ts` (`QUALITY`): the graphics preset, a player setting at the top of the ? panel (`graphics-panel.ts`),
  kept apart from the knobs (`gta.graphics`; Reset and Copy leave it). Low power: 30 fps cap, 0.75–1x resolution, no
  MSAA, shorter road/detail/tree distances, half the crowd (`crowd()`), minimap at 10 Hz. Auto (default, what the phone
  budget is measured at): 60 fps cap, adaptive 0.75–2x, MSAA only under 1.5x. High: uncapped, further detail. Read
  live except MSAA (next load). Auto hints at Low power after 10 s slow at the lowest resolution. Show FPS puts the
  readout by the minimap. `?debug`: `__game.graphics(preset?, showFps?)`; `state()` has `graphics`, `pixelRatio`.
- **Experiments** (#53 on): v1 is a lab for finding out what's fun. Tone: cheeky, not violent (`docs/BRIEF.md`).
  - `src/tweaks.ts` + `src/tweaks-panel.ts`: the **? panel** (button by mute, `?` key), the playtest
    tool. The game pauses while it's open. A mechanic registers its own section where it's defined:
    `export const FOO = mechanic('foo', 'Foo', true, { speed: knob(4, 'Label', min, max, step, 'm/s') })`
    gives a live `{ on, speed }` object to read each tick (the panel writes into it); an existing table is
    bound in place with `tune(id, title, obj, specs, onChange?)` (car `TUNING`, camera profiles; `onChange`
    re-applies anything baked in at construction). Changed values persist in localStorage (`gta.tweaks`);
    Copy gives them as JSON to paste into an issue and make the defaults. No query parameters for knobs.
  - `src/dizzy.ts` (`DIZZY`, `CRASH_DIZZY`): falls, car hits on foot and big crashes (driver) make you dizzy:
    slow, mushy, drifting controls, camera sway (`ChaseCamera.sway`), wobble, `src/stars.ts` overhead
    (instanced, shared with pedestrians). Full strength for `full` s, then fading; crashes scale 2–12 s
    with the knock (~50 to ~180 km/h); on foot (not driving) wiggling shakes it off; immune for a bit after.
  - `src/peds.ts` (`PEDS`, `HITS`): pedestrians on the road graph's footpaths (`KERB_GAP` past the
    carriageway), seeded (`reset(seed)`), spawned out of view; no colliders: a car within reach launches
    them on a scripted arc (bounce, lie, get up, react: fist and "Oi!", chase, dust off). `src/peds-mesh.ts`
    draws everyone in one instanced call (limbs swung in the vertex shader) plus one for shadows;
    `src/bubbles.ts` speech bubbles; `audio.bark()`. `CarSpeeds` measures cars per tick (kinematic ones too).
    Each client runs its own (not shared in rooms).
  - `src/traffic.ts` (`TRAFFIC`, `PARKED`, #29): the town's cars, from fixed pools appended to the map's parked
    cars (so indices match in rooms; someone driving one takes it over everywhere). Traffic drives the road
    graph on the left (outside lane on multi-lane roads), mostly straight on at junctions, slows for corners,
    keeps a gap, stops for you on foot, pulls out round stopped cars; no lights. More parked cars on kerbside
    spots found from the road graph: half up on the kerb (`ON_KERB`) wherever the kerbside lane is one traffic
    drives in (one lane that way, or the right of a one-way), checked clear of walls and posts; the map's own
    parked cars are moved the same way at load (`onKerb`), and pedestrians walk further out (`KERB_GAP` 2 m).
    Both appear out of view and go once far off and out of sight. Get into a driving one and its driver is
    turfed out (`Peds.turfOut`). Each client runs its own. A third pool, `PATROL_POOL`, is the police cars
    (white, light bar): they drive about like traffic until the cops `hold()` one for a chase, then `release()` it.
  - `src/cops/` (`COPS`, #54): cops who catch and annoy you, never hurt you. `cops.ts`: heat only from what a cop
    sees (a ray against fixed colliders within `sightRange`, inside `sightAngle` unless chasing, always within
    10 m): hitting someone (`heatPed`), hitting a cop or ramming their car (`heatCop`), taking a car that isn't
    the purple one (`heatCar`), hooning or skids (`heatHoon`/s), running from them (`heatFlee`/s). Level = whole
    heat, 0–3 (`MAX_LEVEL`). Out of everyone's sight for `decay` s drops a level; swapping cars unseen drops one;
    `maxChase` (0 off) ends it. Level 1: `foot` officers chase you (pedestrians with `role: 'cop'`, kept by the
    cops; `bikes` share on bicycles), tackling within `tackleRange` (dizzy, then caught). Level 2: `cars2` patrol
    cars, level 3: `cars3`, each with a role (tail: alongside then cut in; front; back; side), along a road
    route when far or out of sight, straight at you when close; pull up round you when you stop; their officer
    gets out if you're on foot; siren and loudspeaker lines. Level 3 also lays roadblocks every `roadblockEvery`
    s on the road ahead: spikes on one half (flat tyres: `Car.flat`, `spikeSlow`, `flatTime`), knockable cones
    (`ColliderDesc.cone`, pooled) on the other. Caught (tackled, an officer at the door of your stopped car, or
    boxed in: stopped within 7.5 m of a chase car for `boxTime`): a talking-to (`lines.ts`, Kiwi), a ticket
    (tally in localStorage `gta.tickets`), someone else's car towed, heat cleared, `IMMUNE` 5 s. Ambient: `beat`
    officers walking the footpaths and `patrols` cars driving about. `hud.ts`: beacons under the speedo (flash
    while seen), "Tickets: n", the ticket slip (tap or Enter to skip). `cops-mesh.ts`: bikes, spike strips,
    cones (an instanced call each, only when there's one). `audio.setSiren()` / `megaphone()`. Rooms: each
    client runs the cops after its own player and sends them in its pose (`w` level, `k` chase cars, `u`
    officers; `PROTOCOL` 3); `remote-cops.ts` shows others' as kinematic cars (they block ours) and officers.
    `?debug`: `__game.cops()`, `setHeat(n)`, `spawnCop('foot' | 'bike' | 'car', x, z, heading, chasing)`,
    `roadblock()`, `skipCaught()`, `remoteCopCars()`, `parking()`; `state()` has `heat`, `seen`, `caught`, `flat`.
  - `src/smash.ts` (`SMASH`, #48): street furniture and trees a car can knock down. citygen records each lamp, signal,
    stop, shelter, bench, bin and tree as a prop in its buildings chunk (kind, foot, height, trunk radius and its
    contiguous run of vertices; `MeshBuilder.prop`, format flag bit 6); `BuildingChunk` gives each a small fixed
    collider (`PROP_SHAPES`; trunks are no longer in the chunk's trimesh). Before each physics step, every moving car's
    next two ticks are checked against props near it: faster *into* one than its break speed (`toughness`: bins and
    benches 10 km/h, lamps and stops 25, signals 35, shelters 40, trees 30 small to 75 at `bigTree` m) and its collider
    goes, the car loses a share of that speed (`Car.knocked`, not an impact) and the prop's vertices are collapsed in
    the chunk mesh while a copy topples from its foot (bins and benches are flung). Slower and it's a wall. Fallen
    copies are one mesh with the city material (one draw call while any are down), not solid, and stand back up past
    `respawn` m when out of view (or when their chunk unloads). Any car knocks things down, the cops don't care, each
    client runs its own. `audio.smash()`. `?debug`: `__game.smashed()`, `props(x, z, r?, kind?)`. Smoke: `smash.mjs`.
- `src/maps/`: `auckland.ts` (default) and `test-town.ts` (`?map=test`)
- `src/missions/`: one file per mission (`defineMission`, picked up by `import.meta.glob`).
  `runtime/`: `mission.ts` (the script API), `runner.ts` (runs scripts in game time; a mission
  with `players.max > 1` is shared: the room gathers at its marker, the host runs it with everyone as `players`,
  and guests mirror its `share()` state; solo ones run wherever they're started), `places.ts` (the gazetteer: `places.json` ids,
  typechecked, plus `nearest`/`random` by kind), `markers.ts` (start rings, goal beam),
  `hud.ts` (banner, timer, objective, board; where to go is on the map), `quit.ts` (✕ Quit pill in the top bar or Q,
  "are you sure?" with the game paused; `MissionRunner.cancel()` fails it, for the room too if you host it; guests can't). To add a mission: pick places from
  `public/city/cbd/places.json` or `__game.places('bar', { near: [x, z], within: 200 })`
  (pin a nicer id or name with `place` in the overrides), write the file, and play it
  through by teleporting in `scripts/smoke/areas/missions.mjs` (shared ones in `coop.mjs`, two tabs).
  The mission lab (`docs/MISSIONS.md`: six kinds, three each, mostly for rooms; no knowing the city, nothing long
  and straight): props (`m.prop`: pads, gems, sirens; `who()`, `carry(player)`; two instanced calls in `markers.ts`,
  only when there are any), `pickup`, `beam`, `tell`/`secret` (one player's subtitle or board), `setHeat` for anyone
  in the room (`MissionPlayer.heat`, `caught`), `countdown`, `route`, `rand`; helpers in `runtime/kit.ts` (`every`
  for loops beside a script, `hotCold`, `spot` for a start of its own). Smoke: `lab-missions.mjs`, `lab-coop.mjs`.
- `src/net/`: rooms (#26) over PeerJS (its free broker and TURN; `?turn=off` for STUN only). `room.ts`
  (host/guest star: the host relays, poses at 15 Hz, host leaving dissolves the room), `remotes.ts` (others
  drawn ~0.12 s behind, interpolated; a parked car someone else drives turns kinematic and follows them),
  `panel.ts` (👥 / P: code, link, names, route and ping per player), `transport.ts` (PeerJS, or a
  BroadcastChannel between tabs with `?net=local`, which `scripts/smoke/areas/rooms.mjs` uses).
  Join with `?room=CODE`. `?debug`: `__game.room()`, `host()`, `join(code)`, `leaveRoom()`, `remoteCars()`.
- `src/city/`: chunk streaming (`streamer.ts`), one merged mesh per chunk (`chunk-mesh.ts`),
  terrain, buildings, facade atlas, skyline LOD, water. `cavity.ts`: ground dug out at run time
  (the car park under Aotea Square): the heightfield is lowered to the floor, the original ground
  becomes a trimesh roof, openings (on the 10 m grid) are drawn at the dug heights; pass `y` to
  `heightAt(x, z, y)` to get the floor rather than the ground on top.
- `src/landmarks/`: hand-made models placed from manifest `landmark` records (`overrides/cbd.json`),
  one mesh each with its own atlas (`atlas.ts`): Sky Tower, Ferry Building, Chief Post Office, Civic,
  Town Hall, Sky World ("High World": MINIMAX, the Hard Luck Café), Aotea Square (Waharoa, car park),
  St Kevin's Arcade and the Myers Park steps (`st-kevins.ts`: walk or drive from K Road through the shops and down
  its stairs to Poynton Tce; 79 steps fitted to the bank, Moses at the foot; smoke: `st-kevins.mjs`). A model with
  an inside sets `close`: in full (`Builder.close`) only that near, a plain inside to `near`; `placedBy`/`at` hang a
  second model (the steps) on another's record, measured from its own middle. Colliders may be convex hulls (ramps).
- `src/city/road-graph.ts`: the drivable network (`roadgraph.json`) for routing, traffic and police:
  `nearest`, `route` (A*, one-ways respected), `lane` (a pose in a lane, driving on the left),
  `randomLane` (only where a car can always drive on: the main strongly connected part).
  `?debug`: `__game.roadAt(x, z)`, `__game.route([x, z], [x, z])`, `__game.roadGraph()`.
- `tools/citygen/`: offline generator. OSM + LINZ LiDAR → projected (origin Britomart) →
  terrain, buildings, roads, ground, piers, sea walls, parking → `public/city/cbd/` (committed,
  deterministic). Hand fixes in `overrides/cbd.json` keyed by OSM id (see `overrides/README.md`).
  Buildings: `roofs.ts` (pitched roofs fitted to the DSM), `rooftops.ts` (towers on podiums,
  rooftop plant), `eras.ts` (facade family, colours and cornices per architectural era).
  Road graph: `roadgraph.ts` (junction-to-junction edges with lanes each way, heights from the
  smoothed ground or the deck → `roadgraph.json`; `prepare.ts` is the ground smoothing it shares with `build.ts`).
  Coast: `piers.ts` (pier decks burnt into the DEM; narrow piers and pontoons also built as decks from their OSM
  outlines, left out of the coastline, the terrain cells under them undrawn), `seawalls.ts` (walls and caps along the
  traced coastline). In the game the 10 m grid's waterline follows the 2 m ground's (`shoreline` in `terrain-mesh.ts`).
  Map: `map.ts` (map.png, `MAP_PX` 1.5 m per pixel to keep it ~6.5 MP for phones: ground classes, water, roofs, from the chunk files, no OSM needed).
  Places: `places.ts` (OSM POIs → `places.json`, marker on the kerb outside), `names.ts` (parody
  names: brand table, hand-written lists per kind, templates; no real business name may leak).
  Parks: `ground.ts` (land use, park paths, canopy cover: shade near, canopy tint far), `trees.ts` (OSM trees plus
  LiDAR treetops on green ground and tree-shaped ones over footpaths; each a prop, see `src/smash.ts`), `barriers.ts` (park edges: walls, fences,
  hedges, retaining walls, and a default low hedge where a park meets a footpath).
- `scripts/smoke/` (Playwright: `run.mjs`, one file per area; the map in `map.mjs`), `scripts/sim-car.ts`. Experiments:
  `dizzy.mjs`, `peds.mjs`, `traffic.mjs`, `cops.mjs`, `tweaks.mjs` (the panel on the phone page); hooks `__game.dizzy()`, `peds()`, `town()`,
  `spawnPed(x, z)`, `knobs()`, `knob('dizzy.on', false)`, `dropPlayer(m)`, `hitPlayer(car, speed)`.
  `__game.reset()` also resets every knob, reseeds the pedestrians and takes the town's cars away (and the
  cops: heat, officers, chase cars, tickets). Areas that drive scripted routes turn traffic off
  (`knob('traffic.on', false)`, as `drive.mjs` does); areas that count people or cars turn the cops off
  (`knob('cops.on', false)`: officers are pedestrians, patrol cars drive like traffic).

## Conventions

- TypeScript with `erasableSyntaxOnly`: no enums, no constructor parameter
  properties. Relative imports keep the `.ts` extension so the same files run
  in Node via `--experimental-strip-types`.
- Import `@dimforge/rapier3d-compat`; `vite.config.ts` aliases it to
  `@dimforge/rapier3d` for the browser. `RAPIER.init` exists only on compat,
  so call `init?.()`.
- **Axes:** +y up. Cars and player face local +x; forward is
  `(cos h, 0, -sin h)`; local +z is the right-hand side. North is -z.
- **NZ:** drive on the left; right-hand drive, so you get out on the right.
- **Physics step order:** `car.update()` → `player.update()` → `world.step()` → `afterStep()`.
- **No real brand names or logos** in game text (GTA parody). "Corolla" only in identifiers.
- Comments explain *why*. Small modules, one class per concern.

## Phone budget

Measured at `__game.view('spawn' | 'queen-st' | 'aerial')` with `?debug`
(`__game.state()`, `__game.breakdown()`). `smoke:full` fails past:

| View | Triangles | Draw calls |
|---|---|---|
| Street (`spawn`, `queen-st`) | < 150k | < 60 |
| Aerial | < 300k | < 100 |

Street view is ~140–148k / ~40 today (a visible mission marker is one call; pedestrians are
two calls and ~170 triangles each, dizzy stars one call when anyone's dizzy; police light bars one call when a
police car's in view, bikes, spike strips and cones one each when there are any, knocked-down props one while any are down; cars are five calls however many,
~820 triangles each within 40 m, ~350 to 80 m, ~50 beyond; street view varies a few k with traffic in it). Each chunk is one draw call: put new static
geometry into `ChunkMesh` (vertex colours, shared materials/atlas), not new
meshes. Small building detail goes in `MeshBuilder.detail()`: near-only
(within 250 m: verandahs, parapets) or fine (120 m: cornices, plant, eaves).
Trees and park edges are grouped by 50 m tile in the building chunks
(`MeshBuilder.group`) and drawn only within `TREE_DRAW` (200 m). Bake
multi-part models, instance repeated props, LOD by distance, blob
shadows only. 2 m ground within 90 m, 10 m beyond; colliders within ~300 m.

## Gotchas

- **Ground collision:** never one giant thin cuboid (the character controller
  sinks). Use heightfields or tiles ≤ 120 m.
- **Draped geometry** must sit ~1 cm above the collision surface. Roads are
  safe: citygen smooths ground under streets and park paths, and the game
  draws the fine (2 m grid) ground `PAVED_SINK` (5 cm) lower under road strips.
- **Skid marks** are double-sided (strips laid sliding backwards face down).
- **Smoke:** headless Chromium renders in software (~10–20 fps), so checks
  never wait on the clock: `__game.step(n)` pauses real time and runs n fixed
  ticks without drawing (keys held by Playwright still count), and areas
  loop on `run({ keys, max, until })`. Then results repeat exactly; keep it
  that way (`--repeat=3`), and mark checks that read wall-clock numbers
  `{ stable: false }`. Each area starts from `__game.reset()`. Its fps means
  nothing for phones. Tap pulsing buttons with `{ force: true }`.
- **Playwright** is pinned to 1.63.0 to match `/opt/pw-browsers`. Don't run
  `playwright install`.

## Network (Claude cloud sandbox)

- Reachable: OSM API `api.openstreetmap.org/api/0.6/map?bbox=…` (≤ 0.25 deg²,
  50k nodes per call), LINZ S3 (`nz-elevation`, `nz-imagery`), npm, PyPI.
- Blocked: Overpass, Geofabrik.

## Attribution

Title screen and README must credit "© OpenStreetMap contributors" (ODbL) and
"Contains data sourced from the LINZ Data Service, CC BY 4.0".
