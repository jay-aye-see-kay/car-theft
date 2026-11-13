# Place profiles: findings so far

Lab 5 (`labs/profiles/`) tests one idea from the handover brief: *encode the vibe, generate the rest*. The vibe of a
place is a small authored **profile**, and every generator reads the resolved profile at a point instead of having
its own idea of what goes where.

## How it works

- **Schema** (`src/profile/schema.ts`). Fields are grouped by the generator that reads them: `buildings`
  (style rules and palettes), `street` (lamps, street trees, extras), `ground` (colours) and `cover` (what
  grows or stands on each kind of ground). A profile is a partial patch of that shape and can `extend` another.
- **Layers** (`src/profile/resolve.ts`). The profile at a point is the base profile with each covering layer merged on
  top, in order: base → region → district (planning zone) → place → override. The resolver records which layer
  set each field, and the inspector shows that record.
- **Assignment** (`src/profile/places.ts`). Each layer is a short list of rules. Regions are coarse hand-drawn boxes.
  Auckland Unitary Plan zones pick district profiles. Mapped OSM areas pick place profiles by kind or name.
  Hand-drawn outlines cover places no dataset knows about, such as the University heritage core. Overrides are
  keyed by stable IDs (`building:rel12509358`, `road:Symonds Street`), so a fix survives regenerating everything else.
- **Library** (`src/profile/library.ts`). There are 19 profiles, from `auckland` and `isthmus` down to
  `victorian-cemetery`, `heritage-campus` and `coastal-settlement`.

The lab can turn any layer off, swap one profile for another everywhere it applies
(`?swap=victorian-cemetery:formal-park`), colour the map by profile or by zone, and explain any clicked point or
building.

## Findings

1. **Zoning is the right backbone for districts, but it misses some places.** The Unitary Plan picks out a city
   centre, a suburb or a coastal settlement well. It doesn't single out Symonds Street Cemetery or the old university:
   at Old Government House, in the heritage core, the zone is just Open Space – Conservation. OSM areas and
   hand-drawn places have to fill those in, so the *place* layer carries most of the character.
2. **Building rules have to stack, with child rules before parent rules.** If a place's rules replace its district's,
   the heritage core loses every rule it didn't restate. Concatenating them, place first, lets a place add "gothic for
   institutions" while still inheriting everything else. `rules` is the only list that concatenates; mixes
   (`kit`, `style`, `tone`, `near`) are replaced whole, because merging weights key by key gives mixes nobody wrote.
3. **What grows somewhere depends on the ground cover *and* the place, not on one profile alone.** A cemetery inside
   the city-centre district and one in the ranges should differ, and grass inside a cemetery differs from the
   cemetery's paths. So `cover` is keyed by cover kind within each profile, and the resolved profile picks the layer
   for the ground actually under the point.
4. **Within one city, the region level is nearly empty.** The isthmus region only sets a street-tree mix, because the
   zones already say everything else. Regions earn their place where the zones say little: on the west coast the
   Waitākere region carries the whole look (native bush, black sand, unlit roads), so the zones under it only
   need to say what's settlement and what's bush. At the brief's scale (Pūhoi to the Bombay Hills) the region level
   will matter more, and it can stay a few coarse outlines.
5. **Stamps find their own spot.** The Kitekite Falls stamp is given an anchor and a radius, not an exact position. It
   picks the steepest 20 m of mapped stream nearby (a 29 m drop on the Piha tile), carves a plunge pool and keeps
   trees clear of it. Hand-placed features that snap to the data like this should survive rebakes better than fixed
   coordinates.

## Costs and loose ends

- The Piha tile places about 316,000 instances, most of them bush shrub. They're now generated in 200 m cells
  around the view rather than all at once (see `docs/cells.md`), which cut a frame near the falls from 55M
  triangles to 10M.
- Swaps and layer toggles regenerate the whole tile; that's fine for a lab but not for a game.
- Region outlines are rough rectangles.

## Data

The zones come from the Auckland Unitary Plan base zone layer, from Plans and Places, Auckland Council (CC BY 4.0). Their terms also
ask for consent before republishing any substantial amount, so each tile keeps only the zones it covers.
