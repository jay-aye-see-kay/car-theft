# Missions: what they could be

The first missions (milk run, pavlova, sprint, riddles, last orders, harbour dash) proved the runtime works.
This is the lab after them: six kinds of mission, three of each, to find out which kinds are fun here. Most
are for a room (15 of 18 can be played together; the 9 marked **2+** need at least two people).

Rules we kept to:

- **No knowing the city.** Everything you need is on screen: a beam, a pad, a gem, a hot/cold reading. (Feedback on
  Grandad's Riddles: fun idea, but it asks too much of the player's own knowledge of Auckland.)
- **Short.** Nothing should ask for minutes of driving in a straight line (feedback on the Harbour Dash, now about
  1.5 km of wharves and four minutes on the clock, so even the launch can make it).
- **Cheeky, not violent** (`docs/BRIEF.md`).

## The kinds

| Kind | Borrowed from | Missions | Players |
|---|---|---|---|
| Heists & getaways | GTA | The Great Pie Heist, The Casino Job, Pass the Parcel | 1-4, **2+**, **2+** |
| Co-op puzzles | It Takes Two, Portal 2 co-op, Keep Talking and Nobody Explodes, Lights Out | Two Keys, Colour Code, Fairy Lights | **2+**, **2+**, solo |
| Driving | Crazy Taxi, It Takes Two's tethers, Burnout/Forza speed traps | Cabbie, Tied Together, Speed Trap | solo, **2+**, 1-6 |
| Exploring | Breath of the Wild (Korok seeds, catching animals), Zelda dowsing, Animal Crossing fossils | Kererū Seeds, Here Biscuit!, Metal Detector | 1-6, 1-4, 1-6 |
| Party games | the playground, Halo | You're It!, King of the Square, Musical Chairs | **2+**, **2+**, **2+** |
| Odd jobs | Overcooked, Paperboy, the slow-down level in every racer | Pie Rush, Paper Round, Hokey Pokey Run | **2+**, solo, 1-4 |

### Heists & getaways
- **The Great Pie Heist** (Honest Hone's Pies, Wyndham St): grab the pies and the whole crew gets two stars. Lose
  them, then fence the pies at Jono's, clean; anyone caught fails it. Tests: making the cops the obstacle.
- **The Casino Job** (casino, Federal St): one stands on the security switch (cameras off, chips go green), the
  rest lift the chips. Halfway, the switch moves to the other end of the street. A chip lifted on camera makes
  the lifter wanted. Tests: one player enabling another.
- **Pass the Parcel** (ferry terminal to the Viaduct): the taxman, a flashing light a touch slower than a sprint,
  homes in on whoever has the bag. Touching a mate passes it and confuses him; no cars. Tests: a relay.

### Co-op puzzles
- **Two Keys** (Domain lawn): pads that only count when all are held at once: apart, further apart, drifting in
  circles, then one per player held together for five seconds.
- **Colour Code** (Wynyard plaza and Silo Park): whoever stands on the reader sees the code on their own board,
  only while they stay on it; the coloured pads are round the corner. A wrong pad scrambles it. Tests:
  asymmetric information (shouting at each other).
- **Fairy Lights** (Silo Park lawn, solo): Lights Out with pads; a ring of five, then three by three.

### Driving
- **Cabbie** (Albert St): fares nearby, drops buy time, quick drops tip. Three fares passes.
- **Tied Together** (Queen St): an invisible rope between everyone's cars. Too far apart and it strains, then snaps.
  Every checkpoint needs the whole convoy.
- **Speed Trap** (Quay St to Tāmaki Drive): twelve cameras; through each at 70+ for a flash (and a star).

### Exploring
- **Kererū Seeds** (Domain): ten seeds under the trees, seen only within 30 m; the sensor warms as you near one.
- **Here, Biscuit!** (Victoria Park): a dog that bolts from you, tires, wriggles free if you run or get in a car.
  Corner him (easier with friends) and carry him to his owner.
- **Metal Detector** (Judges Bay): nothing to see, a beep that warms; stand still on the spot to dig.

### Party games
- **You're It!** (Victoria Park): tag, on foot, no tag-backs; in a car or out of the park counts as being it.
- **King of the Square** (Aotea Square): hold the moving ring alone; cars and shoving allowed. First to 60 s.
- **Musical Chairs** (Silo Park): keep moving while the music plays (stand still and you're out); then one chair
  fewer than players.

### Odd jobs
- **Pie Rush** (Big Kev's, Queen St): orders come in with timers; one pie each from the counter. Three cold
  orders and you're sacked; five delivered passes.
- **Paper Round** (Parnell Rd): letterboxes on both sides; pass close on that side.
- **Hokey Pokey Run** (Freemans Bay): kids on the kerb; pull up and stop to serve; over 45 km/h melts the stock.

## What the runtime grew for these

`src/missions/runtime/mission.ts`, all shared with the room like the rest:

- `prop(at, { style: 'pad' | 'gem' | 'siren', radius, colour, label, draw, onFoot })`: things in the world. `who()`
  is who's on or touching it; `move`, `setColour`, `carry(player)` (rides over their head), `remove`. Two
  instanced draw calls for all of them (`markers.ts`), and only when there are any. Labelled ones are on the map.
- `pickup(at, options)`: a gem; resolves with whoever touches it.
- `beam(place)`: a goal beam and the map's route, for goals `goTo` can't say ("whoever has the bag gets there").
- `tell(player, text)` and `secret(player, section)`: a subtitle or a board section for one player only.
- `setHeat(level, players?)`: wanted levels for anyone in the room; `MissionPlayer.heat` and `caught` read them
  back (the cops' pose carries `n` while you're getting a talking-to).
- `countdown(s)` (shows, doesn't fail), `Clock.add(s)`, `route(from, to)`, `ground(x, z)`, `rand()`.
- `runtime/kit.ts`: `every(m, s, fn)` for loops alongside a script, `hotCold`, `spot`, `along`, `scoreRows`.

Smoke: `scripts/smoke/areas/lab-missions.mjs` (solo-playable) and `lab-coop.mjs` (two tabs) play every one through.

## Ideas not built yet

- Hide and seek (needs line of sight between players: cops' `sight()` could serve).
- A tail mission: follow a traffic car without being seen (needs a scripted car from the town's pool).
- Car-park Sokoban: shunt parked cars onto pads (needs `m.cars()`).
- Stunt jumps with airtime scoring (needs ramps; the CBD's hills aren't enough).
