// The map's look, shared by the generator (tools/citygen/map.ts, which bakes
// the ground picture) and the game (which draws roads, the route and blips
// over it). Plain flat colours, a dark radar like the old top-down games.

/** Metres per pixel of map.png: 1.5 keeps the picture (and the canvas it's drawn into) near 6.5 MP for phones. */
export const MAP_PX = 1.5;

/** map.png's palette, by index. */
export const MAP_COLOURS = ['#2c3036', '#3a3f46', '#2f5a35', '#264a2c', '#a8966a', '#1d4a73', '#5d6470'] as const;
/** Palette index of each kind of ground. */
export const MAP_SHADES = { land: 0, paving: 1, park: 2, woods: 3, sand: 4, water: 5, building: 6 } as const;

/** Roads drawn over the picture: fill and edge. */
export const ROAD_FILL = '#c9ccd2';
export const ROAD_EDGE = '#14161a';
/** The planned route. */
export const ROUTE = '#c79bff';
/** Blips. */
export const BLIP = { player: '#ffffff', mission: '#ffc23d', goal: '#ff5fc8', waypoint: '#c79bff', remote: '#5fd3ff', boat: '#7fe8c4' } as const;
