# Agent playtesting

How an agent (Claude Code, or a script) can play the game to judge whether something works, plays well, and is fun,
cheaply enough to do it on every change. Until now the only way in was Playwright against the `?debug` hooks: thorough
end to end, but every question meant a fresh browser (6–15 s), a hand-written script, and reading back raw JSON
(`state()` alone is ~1k tokens of unrounded floats, `missions()` ~3k) or full-size screenshots (~1.2k tokens each).

This is an exploration: three ways in, built far enough to compare, with what each found on its first runs.

| | **Paper playtest** `npm run playtest` | **Bot in the real game** `npm run play -- play <id>` | **Agent at the wheel** `npm run play -- <cmd>` |
|---|---|---|---|
| What runs | Mission scripts in Node against a ghost on the road graph | The built game in headless Chromium (kept warm), autopilot + mission policy | Same game; the agent decides, a command at a time |
| Physics, traffic, cops, people | none | all of it | all of it |
| Cost | ~2 s for every mission × 3 paces, no browser | ~1–3 min wall per mission | ~1 s per command once warm; tokens are what you read |
| Answers | Can it be finished by going where it says? With how much time to spare at a careful / typical / fast pace? | Does it hold up with real driving: crashes, jams, unreachable spots, heat? | Puzzles, clues, "is this fun", anything needing judgement |
| Blind to | walls, handling, other people | judgement (reads words with a regex) | nothing, but it's the slowest per question |

They share one brain: `src/agent/autopilot.ts` (a path follower: pure pursuit, slows for bends it can see and for the
end, brakes for people and cars in its path, backs out when stuck) and `src/agent/policy.ts` (what a literal player
does next in a mission). So when paper and the real game disagree, the difference is the world, not the driver.

## What it found on the first runs

Real leads, each from a few commands, none from reading code:

- **Victoria St East wedge**: the autopilot stuck every time at Victoria St East / Kitchener St, (-130, 562). The car sits at
  32° (`up` 0.85); the collision ground there rises ~1 m per 2 m east to west (x -130 → -128) and a ray straight down
  misses the terrain collider along x = -132 entirely. Worth a look in citygen's ground smoothing or the terrain tiles.
- **Upper Queen St traffic black spot**: by K Road, 16 of 57 traffic cars gave up within 90 s (`town().stats.why`:
  5 "stuck (stopped car)", 7 "stuck (nothing ahead)", 3 "lost the road"). Given-up cars are left `loose` in the
  carriageway and box everyone in, the bot included.
- **Milk Run can't be won legally**: the road graph's legal route from the K Road dairy to the Ferry Building is
  2.15 km (Mayoral Dr, Kitchener St, Bacon's Lane, Fields Lane...) against 1.7 km straight; 90 s needs 86 km/h average.
  It fails on paper at every pace, flat out included. Only straight down Queen St against the one-ways wins, which the
  mission's comment hints at; fine if that's the joke, worth knowing if not.
- **Lower Queen St to the Ferry Building** is 816 m by road for a 200 m hop (one-ways and the closed bit).
- **Pavlova is tight**: fails at a careful 40 km/h, passes with 10 s to spare at 60, 27 s at 90.
- **Ice Cream Van punishes speed as designed**: passes careful and typical, fails fast ("Only 6 served").
- **Speed Trap** passes only at the fast pace, with no time to spare: as intended for a speed-camera run, but the
  margin is zero.
- **Kererū Seeds** passes on paper in 88 s, but in the real game the bot couldn't walk to seeds at (560, 1530) and
  (520, 1560) by the Domain service road, and walking into the start marker didn't start it. A seed may sit behind a
  building or a knot of people on a narrow path; worth a human look before blaming the bot. (The bot now skips a prop
  after two legs that get no nearer, and says so.)
- **Pie Heist** passes on paper (no cops there), but in the real game the mission sets heat 2 the moment you grab the
  pies on foot, and the bot was tackled 9 s later. Fine if the plan is "have a car waiting"; harsh if not.
- **Harbour Dash** passes on paper; in the real game the boat bot hit wharves 45 times in a straight line. Boats need
  a route over water before a bot can judge this one.
- Missions that need searching or clues (Grandad's Riddles, Here Boy, Metal Detector, Fairy Lights, Cabbie's fares)
  stump both scripted players. That's the point of the third way: an agent solved **Grandad's Riddles** end to end
  through the CLI (five riddles from local knowledge, down the Aotea Square car park ramp for the loot) in 18
  commands, ~9k tokens of text and four small images.

Paper (typical pace, 60 km/h) beside the bot in the real game, solo missions, first runs:

| Mission | Paper | Real game (bot) | Why they differ |
|---|---|---|---|
| ice-cream-van | pass 144 s | pass 126 s | they agree |
| sky-tower-sprint | pass 121 s | pass 167 s | real driving: traffic, kerbs, a car to find |
| pavlova | pass 146 s (+10) | fail 154 s | the margin's thin; real driving loses it |
| kereru-seeds | pass 88 s | stuck | seeds the bot can't walk to |
| pie-heist | pass 66 s | caught at 11 s | cops |
| harbour-dash | pass 129 s | fail, 45 crashes | boats drive straight into wharves |
| milk-run | fail | fail | legal route too long |
| speed-trap | fail (pass at fast) | fail | needs 70+ through every camera |
| paper-round, cabbie, here-boy, metal-detector, fairy-lights, grandads-riddles | fail / stuck | fail / stuck | need searching, clues or a technique: agent territory |

## What it costs to look

Measured at the spawn on foot and while driving a mission, with the same hooks and commands (
tokens estimated as words, number groups and punctuation, images as w×h/750):

| Observation | Spawn | Driving, mission on |
|---|---|---|
| raw `state()` JSON | ~1.1k tokens | ~1.1k |
| raw `state + missions + peds + cops + town` | ~6.1k | ~13.3k |
| `__game.agent(40)` (one rounded call) | ~830 | ~1.4k |
| **`look`** (text) | **~150** | **~220** |
| `map 90 6` (ASCII, 31×31) | ~940 | ~950 |
| **`mapshot 150 256`** (PNG) | **~90 (image)** | **~90** |
| screenshot 1280×720 / 960×540 / 480×270 / 320×180 | ~1230 / 690 / 170 / 77 (image) | same |

Lessons:

- **Words beat JSON** by 7–60×: `look` says "car #3 parked 12 m SE (left)", not three floats to 13 places.
- **ASCII maps are a trap**: a 31×31 grid costs as much as a 960×540 screenshot (grids tokenise badly) and is harder
  to read. A 256 px top-down picture costs a tenth and shows the street layout at a glance; at 128 px (~22 tokens) it
  still reads. Keep `map` for agents that can't take images.
- **Small screenshots are cheap and useful**: 480×270 (~170 tokens) was enough to see "walking into a brick wall"
  and "two cars blocking the car park ramp". Full-size screenshots are rarely worth it.
- **Events beat polling**: the journal records crashes, hits, props knocked down, heat, mission lines, with where they
  happened (`@x,z`, to `tp` back). Stepping 10 s and reading 3 journal lines replaces 600 polls.
- **Intent beats keys**: `go sky-tower` is one command. Driving there by holding keys needs a controller written in
  the test, every time.
- **Warm beats cold**: the daemon keeps the page open, so a command is ~1 s (mostly npm and Node starting), not
  6–15 s of page load. Game time only moves inside commands, so nothing happens while the agent thinks.

## How to use it

```sh
npm run build                         # the daemon serves dist/
npm run play -- look                  # first call starts the daemon (~6-15 s), later ones ~1 s
npm run play -- "enter; go sky-tower" # several commands with ;   (eval takes the rest of the line)
npm run play -- play pie-heist        # the bot plays a mission through and reports
npm run play -- help
npm run play -- stop
npm run play -- --port=4480 look      # a second game alongside (each port its own daemon)
npm run playtest                      # every mission on paper, 3 paces, ~2 s
npm run playtest -- pavlova --pace=fast --verbose
npm run sim:pilot                     # the autopilot on flat ground in Node (after touching it or car TUNING)
```

Commands (`help` lists them): `look [r]`, `map [r] [cell]`, `mapshot [r] [px]`, `shot [w]`, `go <where> [kmh= max=
arrive= direct|road]`, `enter`/`exit`, `tp <where> [N|E|S|W]`, `wait [s]`, `hold <keys> [s]`, `press <key>`,
`mission [list|start <id>|quit]`, `play <id>`, `places <kind|name> [r]`, `heat <n>`, `knob [path [value]]`,
`journal`, `reset`, `eval <js>`. Destinations: `x,z`, `goal` (the mission's, else the nearest prop), `start`,
`start:<mission>`, `car` (nearest free), `#n` (car n), or a place id or name from the gazetteer.

In the game (`?debug`): `__game.agent(r)` (one rounded look: you, street, heat, mission, autopilot, what's within r),
`__game.pilot({ to: [x, z], via?, kmh?, arrive?, careless?, through? } | null)`, `__game.pilotState()`,
`__game.journal()` (lines since last call). Smoke: `scripts/smoke/areas/agent.mjs`.

## Options considered and not built (yet)

- **A pure-Node game** (physics, traffic, peds and cops without a browser). The mission runtime already runs in Node
  and the car does (`npm run sim`), but `main.ts` is one 2000-line closure wiring rendering, DOM and simulation
  together. Splitting a `World` (simulation only) out of it would give a headless game at maybe 20× real time with no
  Chromium, and would be the biggest win for running many bot games. It's a real refactor, so not done here: the warm
  browser gets most of the benefit for one agent at a time, and step() already doesn't draw.
- **An MCP server** in place of the CLI: typed tools and no shell quoting, but it needs `.mcp.json` and a session
  restart to pick up, and every command here is already one Bash call with plain text back. Wrapping `COMMANDS` in an
  MCP server is ~60 lines if it's wanted; the CLI is the thing to keep.
- **Vision-first play** (screenshots each step): workable at 320–480 px, but text plus an occasional picture
  carries the same information for a fraction of the tokens. Kept as `shot` for when an agent needs to see.
- **Fun metrics**: the journal's events (near misses, crashes, heat, peds, props) are the raw material for "how lively
  was that minute"; a summary score per mission run is an easy next step once we agree what fun looks like.

## Where to take it next

1. Fix or file the leads above (the wedge, the K Road jam, the Milk Run route).
2. Run `npm run playtest` in CI (2 s, no browser) and fail on a mission that stops passing at the typical pace; it
   catches broken place ids, unreachable goals and timing regressions as missions are added.
3. Split the simulation out of `main.ts` (above) so bots can run many games in Node.
4. Boats: route over water (the bot drives a straight line into wharves).
5. A mission-author loop: write the mission, `npm run playtest -- <id> --verbose`, then `npm run play -- play <id>`,
   then have an agent play it and say what was unclear or dull.
