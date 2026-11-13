# Cells: generating the world in 200 m pieces

The brief's world is thousands of km², so nothing will be generated all at once: not in the browser, and not
offline either. Every generator therefore needs to work on one piece of the world at a time, and give the same
result for that piece whenever and however it's generated. These labs now work that way.

## Two stages

The world is cut into 200 m **cells** on the NZTM grid (`src/gen/cells.ts`). The cuts land in the same places in
every tile, so neighbouring tiles share their cell edges.

| Stage | What | Why it can't be per cell |
|---|---|---|
| **Tile** (in the game: baked offline) | Graded terrain, road heights, junctions, stamps, the profile map, distance to the coast, each road's character | Each needs the whole network or a wide area: a road's grade depends on the whole road, the falls stamp searches 250 m of stream, a coastal rule reads distance to the sea 400 m out |
| **Cell** (in the game: on demand, near the player) | Scatter (trees, headstones, rocks), street furniture (lamps, street trees, signals, benches) | It doesn't need anything wider. A cell reads the tile stage's results plus the model's features within `MARGIN` (100 m) of it |

The cell stage's rule: a cell's output depends only on the tile stage and on features within the margin. It must
not depend on other cells, on the order anything was generated or listed in, or on how the data was cut. That's
`generateCell(site, cell)` in `src/gen/site.ts`.

Some decisions sit in the tile stage for less obvious reasons:

- **Road character** (lamp style, street trees, benches) is decided once per road, at its midpoint. That point can
  be kilometres from the cell, so it's a property of the road, not something a cell decides.
- **Distance to the coast** reaches 400 m, wider than any sensible margin. It's a regional field, baked with the
  terrain.
- **Which area or zone wins where two overlap.** The smaller one wins, for areas (a pitch in a park) and for zones
  (land zones over the coastal marine zone). That rule depends only on the shapes, so a rebake that lists them in
  a different order gives the same result.

## The check

`?check` (a sample of cells) or `?check=all` on the profiles lab generates each cell three ways and compares every
instance with the whole-tile run:

1. **Whole tile:** the normal run.
2. **Alone:** from a crop of the model to the cell plus its margin, with every raster rebuilt from the crop only.
3. **Reordered:** from the same data with every list reversed, as a rebake might give it.

The check found five real bugs before it passed:

- **Order-dependent seeds.** Each area's random seed was its position in the area list, so a rebake that added or
  reordered an area changed the trees in every area after it. Seeds now come from OSM IDs.
- **Order-dependent overlaps.** Where zones overlapped, the last one listed won. The smaller one wins now.
- **Canvas rasterising isn't deterministic.** The occupancy raster (where trees can't stand) was drawn with a
  browser canvas, whose antialiasing came out differently for a crop than for the whole tile. It now uses the
  project's own rasteriser on a 1 m NZTM grid, which also means it can run in a worker or in the offline bake.
- **`Infinity × 0 = NaN`.** Where no stream was in a raster at all, the distance field held `Infinity`. At a
  raster's edge, where sampling clamps and a weight is exactly zero, bilinear sampling turned that into `NaN`.
  A `NaN` density passes every test, so the plant got placed. Whole tiles had it too, along their outer metre.
  "Nothing in range" is now a large finite distance.
- **Crops reaching past the data.** A crop that ran past the tile edge saw clamped ground there.

Now the results are identical: central 28,354 instances in 120 cells, Piha 316,371 in 160 cells, all of them
matching all three ways.

Rasters snap to the NZTM grid (`Grid.over`), so any two of the same cell size, from different tiles or from a
crop, put their cells in the same places. Scatter's jitter grid also sits on NZTM. Together, these make the
same tree stand in the same spot in a neighbouring tile.

## The viewer

`src/view/cells.ts` generates the cells around the view, nearest first, about 10 ms of work per frame. It drops
cells left far behind and draws each cell as its own instanced meshes, so three.js skips any cell outside the
camera's or the shadow camera's view. Small things (shrubs, tussock, headstones, benches) are only drawn within
150–350 m of the view. How far cells load depends on how far the camera is from what it's looking at: 500 m
close in, up to 1.8 km from above. Driving moves the view's target with the car, so cells follow it.

Measured triangles a frame, including the shadow pass, before and after:

| View | Before | After |
|---|---|---|
| Piha, Kitekite Falls | 55.3M | 10.3M |
| Piha, Glen Esk bush | 55.4M | 19.4M |
| Piha, overview | 57.3M | 33.2M |
| Central | 12.0M | 6.9M |

## Open

- **Terrain** is still one full-resolution mesh per tile. Near the falls it's half of what's left (5.4M
  triangles). It's the next thing to cut into cells, with coarser terrain further out.
- **Draw calls** went up, because each cell has a mesh per kit: 48 → 276 near the falls, and 1,750 on the Piha
  overview. Phones feel that. Far cells could merge into fewer meshes.
- **Tile edges** are still tile-stage effects: relief, distances and the profile map are cut off at the tile's
  edge. With a tile stage baked over the whole region, they wouldn't be.
- **Buildings** still split into near facades and far boxes around the view, rather than by cell.
