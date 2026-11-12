# Handover: Procedural World Generation for an Auckland Open-World Game

## Purpose of this document

This is a starting brief for exploring **procedural generation approaches** for this game. It describes what the project is, what we learned from a first prototype, the full range of techniques worth considering, their trade-offs, and where the thinking currently leans.

**None of this is prescriptive.** The "current leaning" sections are hypotheses to test, not decisions. You're encouraged to challenge them, prototype alternatives, find approaches not listed here, and come back with evidence. The only scope for now is *how the world gets generated*. Art style, hosting, file sizes, GPU budgets and gameplay systems are out of scope unless they directly affect a generation decision.

---

## 1. Project brief (approximate)

### The game
- An open-world game set in **Auckland, New Zealand**, playable **in a web browser**.
- Tone: casual, bouncy, fun. Think a Nintendo Switch title. Roughly **30–50% GTA-inspired** (open-world freedom, vehicles, missions, getting into places), but **no guns, no death, no starting over**.
- Visual style: **low-poly, cartoonish, intentionally stylised**. Breath of the Wild is a key inspiration: the world and gameplay carry it, not fidelity. Minecraft-style chunkiness and odd character shapes (e.g. flat-faced, prism-like people) are on the table as character-giving choices.

### The world
- **Scale is deliberately, unreasonably huge:** roughly from the motorway tunnels north of Auckland (Pūhoi area) down to the Bombay Hills, plus the west coast (e.g. Piha, the Waitākere Ranges, the Kitekite Falls walk). That's on the order of a 2-hour drive end to end and several thousand km².
- **Recognisable, not exact:** street layout, terrain and general feel should be right enough that a local knows where they are. Building colours and exact building designs don't need to match reality. **Landmarks should** (Sky Tower, Ferry Building, Harbour Bridge, University Clock Tower, etc.). We estimate there are at most a few hundred hand-built landmark assets across the whole region.
- **"Encode the vibe, generate the rest."** Example: Symonds Street Cemetery is distinctive, but individual headstones and trees don't matter. The *character* of the place should be captured and the details generated.
- **Most buildings should be enterable**, with plausible interiors. Interiors can load behind a door transition (no need to hold the whole world in memory), but **interior dimensions must match the exterior** (footprint, floor count).
- Buildings need **types / uses**: bank, apartments, mixed office floors, retail ground floors, university buildings, etc.
- Some content will be **hand-authored**. Notably, **tunnels under Albert Park** are planned as a mission space and may be partly or fully manual.

### Preferences
- Prefer **established techniques**, ideally a combination of two or three existing approaches, over anything novel or research-grade.

---

## 2. Lessons from the first prototype

- **Data used:** a NZ government source for ground and building heights (likely LINZ LiDAR elevation data) merged with **OpenStreetMap** for everything else. The merge worked surprisingly well.
- **Problems:**
  - Too tied to reality. It felt like a data visualisation rather than a game world.
  - Roads needed **a lot of manual overrides**.
  - **Lane-count transitions were hard cuts** (e.g. 4 lanes → 3 lanes with no taper), and junctions lacked curves.
  - The **University of Auckland came out badly**. Generic generation lost its heritage character.
  - Parts of the gameplay were surprisingly fun; others got old fast. That's expected for a first pass.

**A diagnosis to test:** the prototype seems to have converted real data *directly into geometry*. Real data is noisy and inconsistent and was never meant to be walked around in. An alternative is to treat data as **constraints and parameters** (topology, lane counts, heights, zoning) that feed generators, which then build clean geometry. Section 5 covers this; please check whether it holds up.

---

## 3. Candidate data sources (verify coverage, licences and quality)

These are worth investigating. Please confirm what's actually available, the licensing terms and the resolution.

| Source | What it might give | Notes / questions |
|---|---|---|
| LINZ LiDAR (DEM / DSM) | Ground terrain; surface heights → building heights | Likely what the prototype used. Check coverage of rural and west-coast areas. |
| LINZ building outlines | Building footprints | Compare quality against OSM footprints. |
| LINZ property parcels (cadastre) | Lot boundaries | OSM generally lacks this. Could give natural lot structure. |
| LINZ address points | Addresses per building/parcel | Useful for building identity and naming. |
| Auckland Unitary Plan zoning | Zone types (residential variants, centres, business, open space…) | Potentially a ready-made building-type and density map. |
| NZ Land Cover Database (LCDB) | Bush / pasture / scrub / urban etc. | Vegetation and biome assignment outside the city. |
| OpenStreetMap | Road graph, lane tags, paths, POIs, landuse, waterways | Treat as topology and metadata rather than final geometry? |
| DOC / OSM tracks | Walking tracks (e.g. Kitekite Falls) | — |
| Heritage NZ list / council heritage data | Heritage buildings and areas | Could flag where to use heritage kits or hand-built assets. |

---

## 4. The option space: technique families

Each family lists what it is, known users, strengths, weaknesses and possible roles in this project. The roles are suggestions only.

### 4.1 Noise fields (Perlin, simplex, fractal, domain warping)
- **What:** continuous pseudo-random functions sampled over space.
- **Used in:** Minecraft terrain, No Man's Sky, most games as a base layer.
- **Pros:** cheap, infinite, deterministic, easy to tune, and fine at any scale.
- **Cons:** no notion of structure, so it can't make streets, buildings or meaning. Pure noise worlds feel samey.
- **Possible roles:** micro-variation such as terrain detail on top of LiDAR, colour and weathering jitter, vegetation density, wind and clouds, procedural textures.
- **Questions:** how much detail does LiDAR already give at our target style? Is noise needed at all for terrain?

### 4.2 Data-driven / geotypical generation
- **What:** real-world data (footprints, roads, land use) feeds procedural builders that make *plausible* rather than exact geometry.
- **Used in:** Microsoft Flight Simulator (whole-planet procedural buildings from map data), Insomniac's Spider-Man Manhattan, Esri CityEngine workflows.
- **Pros:** gives recognisability almost for free and scales to a whole region. NZ has unusually good open data.
- **Cons:** inherits the data's mess unless there's a robust "interpretation / cleanup" layer. Can feel too real, which was the prototype's complaint.
- **Possible role:** the overall spine, deciding *what goes where*.
- **Questions:** where should the line be between "follow the data" and "ignore the data and generate"? Should that line move by region (e.g. CBD close to data, rural loosely inspired)?

### 4.3 Grammars
**L-systems**
- Rewrite rules that grow branching structures.
- Classic for plants and trees. The foundational procedural-city paper (Parish & Müller, 2001) also used them to grow road networks.
- **Pros:** compact and expressive. **Cons:** hard to steer toward a specific target layout.

**Shape grammars / split grammars (CGA shape, as in CityEngine)**
- A footprint is extruded, split into floors, then bays, then windows and doors, then a roof is chosen, and so on.
- **Used in:** CityEngine and many production city pipelines.
- **Pros:** an industry standard for building exteriors, highly controllable, style-driven, and naturally supports level of detail.
- **Cons:** writing good rule sets takes effort, and bad rules make repetitive buildings.
- **Possible role:** all generic building exteriors, possibly continuing down into floor plans.

**Graph grammars**
- Generate logical structure first (rooms, locks, keys, shortcuts), then lay it out in space.
- **Used in:** *Unexplored* (Joris Dormans' cyclic dungeon generation) and mission-generation research.
- **Pros:** guarantees gameplay logic. **Cons:** a separate layout step is needed to make it spatial.
- **Possible roles:** interior gameplay structure (lockpick routes, secret rooms), mission generation, tunnel networks.

### 4.4 Road-network generation and road geometry
**Network generation**
- Tensor fields (Chen et al., 2008, *Interactive Procedural Street Modeling*) and agent-based road growth.
- **Pros:** natural-looking networks that follow terrain and coastlines.
- **Cons:** largely redundant where we want Auckland's real layout.
- **Possible role:** fallback for areas with sparse or messy data, and minor streets and driveways.

**Road geometry building** (from a graph to meshes)
- Splines with lane metadata, junction solving (fillet radii, kerbs, crossings), lane-count tapers, merges, on/off ramps, footpaths, medians.
- **Used in:** Cities: Skylines, CityEngine, and many racing and driving games.
- **Pros:** directly addresses the prototype's hard lane cuts and missing curves, and may remove most manual overrides.
- **Cons:** junction solving for complex intersections (motorway interchanges, odd 5-way junctions) is genuinely hard.
- **Questions:** existing libraries or approaches to reuse? How do motorway interchanges get handled (generated, or hand-built as stamps)?

### 4.5 Lot / parcel subdivision
- **What:** splitting blocks into lots with straight skeletons, recursive oriented-bounding-box splits, or Voronoi cells (e.g. Vanegas et al., 2012).
- **Pros:** well understood and produces plausible urban fabric.
- **Cons:** may be unnecessary where real parcels exist.
- **Possible roles:** gap-filling where parcel data is missing, and arranging each lot's contents (house, yard, driveway, shed, fence).

### 4.6 Constraint-based generation
**Wave Function Collapse (WFC) / Model Synthesis**
- Fills a grid so every tile is compatible with its neighbours, with rules often learned from an example. Paul Merrell's model synthesis is the 3D precursor. *Townscaper* (Oskar Stålberg) is a well-known 3D use on an irregular grid.
- **Pros:** excellent local coherence and charming, organic-looking results. Great for tile-like content.
- **Cons:** weak global structure (it can't guarantee connectivity or exits), it can hit contradictions and need backtracking, and it gets slow over large areas.
- **Possible roles:** facade detailing, rooftops, cemetery plot arrangement, gardens, tunnel or cave tiles, interior decoration patterns.

**Placement and spacing rules**
- **Examples:** Age of Empires II random map scripts (land percentages, base sizes, clumping, minimum distances), Minecraft structure spacing/separation, Poisson-disc sampling.
- **Pros:** simple, robust, scalable, easy to reason about, and "random but consistent."
- **Possible roles:** trees, street props, NPC spawns, collectibles, side-mission locations, points of interest.

**Formal constraint solving** (CSP, answer-set programming)
- Declare the rules and a solver finds a valid solution. Adam Smith's work applies answer-set programming to procedural content.
- **Pros:** guarantees (every room reachable, plumbing adjacency). **Cons:** slow, needs careful scoping, and probably only works for small problems like a single floor.

**Generate-and-test / search-based PCG**
- Generate many candidates, score them with a fitness function, keep the best (or evolve them).
- **Pros:** robust and can optimise fuzzy goals like fun or traversability. **Cons:** costly, and fitness functions are hard to design.

### 4.7 Simulation-based generation
- **Examples:** hydraulic and thermal erosion, Dwarf Fortress history simulation, vegetation competition and growth, settlement growth.
- **Pros:** emergent realism and natural-looking results.
- **Cons:** slow, hard to control, and partly redundant because reality already did the simulating.
- **Possible roles:** bush and forest composition (e.g. kauri, nīkau and ponga by slope, aspect and stream distance), surface wear and grime, maybe NPC routines.

### 4.8 Modular kits
- **What:** artists build small sets of snapping pieces per style. Generators choose and assemble them.
- **Used in:** Bethesda games (Skyrim, Fallout), Breath of the Wild, most open worlds.
- **Pros:** makes procedural output look *authored*. The low-poly cartoon style makes kits cheap and hides seams and repetition.
- **Cons:** variety is capped by kit size, and repetition is visible if kits are too small.
- **Possible role:** the visual vocabulary for almost everything generated. For example: villa, bungalow, state house, terrace, brutalist office, glass tower, heritage brick/stone, Victorian cemetery.

### 4.9 Interior generation
Known approaches, which can be combined:
- **Program-first:** the building type sets the room list (e.g. bank = lobby, counters, vault, offices, staff room).
- **Core placement:** stairs, lifts and services per floor.
- **Room adjacency graph:** what connects to what (could come from a graph grammar, §4.3).
- **Layout methods:**
  - BSP splitting
  - squarified treemaps (Marson & Musse, 2010)
  - constrained growth (rooms expand from seed points, Lopes et al., 2010)
  - grid-based solvers
- **Furniture layout:** guideline- or constraint-based optimisation (Merrell et al., 2011; Yu et al., 2011, "Make it Home").
- **Clutter:** rules plus scatter.

Key considerations:
- **Exterior and interior consistency:** windows should line up with rooms, not walls. One idea is a shared "bay grid" per building that both the facade grammar and floor-plan generator respect.
- **Mixed-use stacking:** retail ground floor, offices middle, apartments top.
- **Very large buildings** (malls, hospitals, campus buildings) may need different strategies from houses.

### 4.10 Machine learning / generative models
- **Examples:** diffusion or GAN terrain detail, learned style transfer, LLMs that turn a description into a structured layout spec (e.g. the Holodeck research system for 3D indoor scenes, LayoutGPT).
- **Pros:** can speed up authoring and capture fuzzy "vibes."
- **Cons:** least predictable, newest and hardest to make deterministic. It also conflicts with the "nothing too new" preference.
- **Possible role (if any):** **offline, authoring-time help only**, such as drafting district profiles or room programs for human review. Probably not runtime geometry. Worth weighing honestly rather than ruling out.

### 4.11 Hand-authored content as "stamps"
- **What:** hand-built pieces dropped into the generated world, overriding generation locally, with blending at the edges.
- **Candidates:** Sky Tower, Ferry Building, Harbour Bridge, University Clock Tower, Albert Park tunnels (real WWII tunnels, planned as a mission space), complex motorway interchanges, Kitekite Falls itself.
- **Pros:** quality exactly where it matters. **Cons:** expensive per asset, and edges need careful blending into generated surroundings.
- **Questions:** how are stamps blended (terrain, roads, adjacent lots)? Can stamps be "semi-procedural," e.g. hand-made core tunnels with WFC side passages?

---

## 5. Cross-cutting systems

These probably matter as much as the choice of technique.

- **Deterministic hierarchical seeding:** world seed → region → block → parcel → building → floor → room. Any building interior can then be regenerated identically on demand from a stable ID instead of being stored. This may be what makes "enter almost any building" feasible at this scale.
- **Lazy / chunked generation:** exteriors stream by distance, and interiors generate during the door transition. How much is pre-baked versus generated at runtime is open.
- **Non-destructive override layer:** manual fixes stored as patches keyed to stable IDs (e.g. "road segment X: force 2 lanes", "parcel Y: use cemetery profile") so they survive regeneration, like Houdini-style procedural pipelines. The prototype's overrides were painful; this may be why.
- **Place / district profiles (the "vibe" encoding):** small authored specs that parameterise all the generators. This could be the central data structure of the whole system. Its design is a strong candidate for early exploration.
- **Levels of detail:** the same generator can emit a simple box far away and full detail up close.
- **Stable IDs:** needed for seeding, overrides, missions and saves. What happens to IDs when source data updates?
- **Validation and debugging tools:** heatmaps of profiles, detecting failed generations, connectivity checks.

---

## 6. Worked examples (illustrative, to test any approach against)

**Symonds Street Cemetery** — data gives the boundary, slope, paths and gully edge. A "Victorian cemetery" profile defines a leaning, mossy headstone kit, high density near paths thinning into bush, heavy dark canopy, narrow crumbling paths and occasional railed family plots. Placement rules or WFC fill it. Success means it *feels* right with no real headstone modelled.

**University of Auckland** — the prototype got this wrong. Possible approach: the Clock Tower as a stamp, plus a "heritage campus" profile with a neo-gothic / brick-and-stone kit, courtyard-forming placement rules, lecture-theatre and office interior programs, and mature trees on lawns. Question: is the charm in the kit, the layout rules, or both?

**Piha → Kitekite Falls** — terrain from LiDAR, the track from OSM/DOC, bush from land cover. A "Waitākere rainforest" profile scatters native species by slope and stream distance. The falls are a small stamp. Tests how the generator handles non-urban, large-scale nature.

**A CBD tower** (e.g. a generic office tower on Queen Street) — footprint from data, height → floor count, a profile sets retail ground floor plus offices, and the interior is generated on entry. Tests exterior/interior consistency and mixed use.

**A motorway lane drop / interchange** (e.g. a 4 → 3 lane transition) — directly tests the road-geometry problem the prototype failed on.

**Albert Park tunnels** — tests how hand-authored and procedural content combine.

---

## 7. Evaluation criteria

Suggested criteria for comparing approaches. Add or reweight as needed.

| Criterion | Tends to score well | Tends to score poorly |
|---|---|---|
| Recognisability (feels like Auckland) | Data-driven, stamps | Noise, pure WFC |
| Controllability / art direction | Grammars, profiles, kits | ML, simulation |
| Scale (thousands of km²) | Noise, grammars, seeded lazy gen | Formal solvers over large areas, simulation |
| Local coherence / charm | Kits, WFC, grammars | Noise |
| Gameplay guarantees (reachability etc.) | Constraint solvers, graph grammars | WFC, ML |
| Authoring cost | Profiles + kits (pay once, reuse) | Hand-authored assets |
| Determinism / reproducibility | Most classical methods | ML |
| Maturity / implementation risk | Grammars, kits, Poisson, data-driven | ML, formal solvers at scale |
| Fixing prototype failures (roads, overrides) | Road geometry builder, override layer | — |

---

## 8. Current leaning (a hypothesis, not a decision)

The working idea is a layered combination of established approaches:

1. **Data as skeleton** (geotypical, Flight Simulator style): real data decides *what goes where* and is interpreted as constraints, plus a proper **road geometry builder** (splines, lane tapers, junction solving).
2. **Hierarchical shape/split grammars over modular kits**, selected by **district/building profiles** (possibly derived from zoning), continuing from facade → floors → room graph → interior so exterior and interior stay consistent.
3. **Local constraint filling:** placement rules and Poisson scatter for distributions, WFC for tile-like detail, generate-and-test where fun or traversability matter.

All of this is wrapped in **hand-authored stamps** for landmarks and mission spaces, **deterministic hierarchical seeding**, and a **non-destructive override layer**.

Things that currently seem *less* promising (open to challenge):
- Pure WFC for the whole city (weak global structure).
- Pure noise-based worlds (no recognisability).
- Heavy simulation (reality already did it).
- ML-generated geometry at runtime (unpredictable, new).

---

## 9. Open questions to explore

- Where exactly should the "follow the data / generate freely" line sit, and should it vary by region?
- What does a **profile schema** look like? What fields, how inherited (region → district → block → building), how overridden?
- How many profiles and kits are needed to cover the region convincingly? Tens? Hundreds?
- How do we handle **motorway interchanges** and complex junctions: generated or stamped?
- How are hand-built stamps **blended** into generated terrain and roads?
- What's the best interior layout method for houses vs offices vs very large buildings?
- How do we keep **windows and rooms aligned**?
- Pre-bake vs runtime generation: which layers go where?
- How are stable IDs maintained when source datasets update?
- How do we detect and recover from generation failures at scale (thousands of km², hundreds of thousands of buildings)?
- Are there existing open-source tools or libraries (road builders, CGA-like grammar engines, WFC implementations, straight-skeleton libraries) worth reusing?
- Are there techniques or precedents missing from this document?

---

## 10. Possible first experiments (pick, change or replace)

- **Road geometry spike:** take a small OSM area with lane changes and a few junctions and build clean meshes with tapers and curved kerbs. Measure how many manual overrides are still needed.
- **Profile schema draft:** write profiles for 3–4 contrasting places (cemetery, CBD block, heritage campus, west-coast bush) and see what fields they actually need.
- **One-block vertical slice:** a single city block, data → parcels → grammar exteriors → generated interiors on entry, with deterministic seeds.
- **WFC vs placement rules bake-off:** generate the same cemetery or park both ways and compare.
- **Interior method comparison:** BSP vs treemap vs constrained growth on the same footprint and program.
- **Stamp blending test:** drop a hand-built landmark into generated surroundings and evaluate the seams.

---

## References and precedents to look up

- Parish & Müller (2001), *Procedural Modeling of Cities*
- Müller et al. (2006), *Procedural Modeling of Buildings* (CGA shape)
- Chen et al. (2008), *Interactive Procedural Street Modeling* (tensor fields)
- Vanegas et al. (2012), *Procedural Generation of Parcels in Urban Modeling*
- Merrell (2007+), *Model Synthesis*; Maxim Gumin's WaveFunctionCollapse
- Oskar Stålberg, *Townscaper* / *Bad North* (irregular-grid WFC talks)
- Marson & Musse (2010), squarified-treemap floor plans; Lopes et al. (2010), constrained-growth floor plans
- Merrell et al. (2011), *Interactive Furniture Layout Using Interior Design Guidelines*; Yu et al. (2011), *Make it Home*
- Joris Dormans, cyclic dungeon generation (*Unexplored*)
- Adam Smith, answer-set programming for PCG
- Microsoft Flight Simulator (2020) / Blackshark.ai procedural world buildings
- Esri CityEngine
- Minecraft world generation (noise, biomes, structure spacing, jigsaw structures)
- Age of Empires II random map scripts
- Houdini procedural pipelines in open-world production (e.g. Ghost Recon Wildlands, Far Cry 5)
- Holodeck (2024) and LayoutGPT, LLM-driven 3D layout (for the ML discussion)

*Citations are from memory. Verify details before relying on them.*
