# Grand Theft Auckland

A GTA III–flavoured open-world driving game set in Auckland, running in the
browser on phones and desktop. Three.js + Rapier physics + TypeScript + Vite.

Drive, walk and boat round the real Auckland CBD, Parnell and the eastern
waterfront, generated from OpenStreetMap and LINZ LiDAR. Spawn on Queen St at Aotea Square next to your purple '95. Plan:
[docs/BRIEF.md](docs/BRIEF.md) and [issues](https://github.com/jay-aye-see-kay/grand-theft-auckland/issues).

## Play

https://cartheft.net/ (add `?debug` for a
performance overlay, `?map=test` for the old test town).

| | Keyboard | Touch | Gamepad |
|---|---|---|---|
| Walk / steer | WASD / arrows | left stick | left stick |
| Sprint | Shift | RUN | X |
| Jump | Space | JUMP | A |
| Get in / out | F (or E, Enter) | 🚗 | Y |
| Accelerate | W / ↑ | ▲ | RT |
| Brake / reverse | S / ↓ | ◀ | LT |
| Handbrake | Space | HB | A |
| Flip car | R | ⟲ | Back |
| Look around | mouse (click the view to capture it; Esc lets go) | drag the view | right stick |
| Look behind (car, boat) | C / middle button | | R3 |
| Zoom camera | mouse wheel | | |
| Mute | N | 🔊 | |
| Map | M / Tab | tap the minimap | |

Getting out at speed brakes to a stop first, like GTA III. You step out of
the driver's door, which is on the right (they're NZ cars).

**Boats:** tinnies, runabouts and old launches are tied up round the
waterfront (Westhaven, Wynyard, the Viaduct, between the wharves, the port,
Mechanics Bay and the Hobson Bay marina): the teal hull blips on the map.
Walk to the water's edge beside one and get in the same way as a car; the
same controls drive it (handbrake to power-slide), R rights it. Get out
alongside a wharf to step ashore, or anywhere else to go over the side and be
fished out.

**Map:** the minimap in the top left turns with you, and shows mission
blips (gold), your goal (pink) and the route there. Tap it (or press M or Tab)
for the full map: drag and pinch or scroll to look around, tap to set a
waypoint (the route on both maps takes you there), tap a mission to head for
it, tap the waypoint again to clear it.

**Missions:** walk (or drive) into a gold marker to start one. Once one is
running, the pink beam, the pink blip and the route show where to go. So far: *Handle With Care* (outside Britomart, where you
start), *Milk Run* (K Road), *High Tower Sprint* (bring a car) and *Harbour Dash* (at the Viaduct: borrow a boat).

## Develop

```sh
npm install
npm run dev     # http://localhost:5173, also on your LAN for phone testing
npm run build   # typecheck + production build into dist/
npm run sim     # headless handling report (0-100, braking, cornering)
npm run smoke   # plays the built game in headless Chromium: quick core checks
npm run smoke:full   # every check: city data, driving, harbour, budgets, phone
```

`npm run sim` drives the car through standard manoeuvres without a browser.
Run it before and after touching the numbers in `TUNING` in `src/car.ts`.

`npm run smoke` (after `npm run build`, about 30 s) starts on foot, walks,
jumps, gets in, drives, handbrakes, gets out and rams a building.
`npm run smoke:full` (a few minutes) adds the city data, driving the hills,
the harbour, the fly cheat, every mission, the test town, touch controls on a phone-sized
screen and the triangle/draw-call budgets. Both fail on any console error.
Pick areas with `npm run smoke -- --only=harbour,fly`. The game is stepped a
fixed tick at a time, so results repeat exactly: `--repeat=3` checks that.
CI only builds and deploys, so run it locally.

Project structure and conventions: [CLAUDE.md](CLAUDE.md).

## Deploying

`.github/workflows/cloudflare.yml` builds every pushed branch and uploads it to the
`cartheft` Cloudflare Pages project with `wrangler pages deploy` (no server-side
code). `main` is production at https://cartheft.net/; any other branch gets a preview
at `https://<branch>.cartheft.pages.dev`. It needs repo secrets
`CLOUDFLARE_API_TOKEN` (Account → Cloudflare Pages → Edit) and `CLOUDFLARE_ACCOUNT_ID`.

## Attribution

The Auckland map is generated from open data (see `tools/citygen/`):

- Streets, buildings and land use: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
  available under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).
- Terrain (2024 Auckland LiDAR 1 m DEM/DSM): contains data sourced from the
  [LINZ Data Service](https://data.linz.govt.nz/), licensed for reuse under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Both credits are also shown on the game's title screen.
