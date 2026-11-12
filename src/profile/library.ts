// The authored profiles. Each says what a kind of place is like, in the terms the generators use.
// The base profile is complete and reproduces the labs' original hard-coded rules; every other
// profile is a patch that only says how its place differs.
import { AREA_COLOURS } from '../gen/terrain.ts';
import type { Cover, Profile, Resolved, ScatterLayer, Tone } from './schema.ts';

const hex = (css: string): number => parseInt(css.slice(1), 16);

/** Tones a kit can be painted in. */
export const TONES = {
  bush: { h: [0.27, 0.37], s: 0.42, l: [0.3, 0.44], flower: 0.032 },
  street: { h: [0.24, 0.31], s: 0.46, l: [0.33, 0.41] },
  native: { h: [0.26, 0.33], s: 0.38, l: [0.22, 0.34] },
  canopy: { h: [0.25, 0.32], s: 0.34, l: [0.2, 0.29] },
  exotic: { h: [0.2, 0.28], s: 0.45, l: [0.34, 0.46] },
  autumn: { h: [0.08, 0.2], s: 0.55, l: [0.4, 0.52] },
  stone: { h: [0.08, 0.14], s: 0.08, l: [0.55, 0.78] },
  lichen: { h: [0.12, 0.25], s: 0.12, l: [0.45, 0.66] },
  dune: { h: [0.13, 0.17], s: 0.35, l: [0.52, 0.64] },
  driftwood: { h: [0.07, 0.1], s: 0.15, l: [0.6, 0.75] },
  iron: { h: [0.6, 0.62], s: 0.06, l: [0.18, 0.26] },
} satisfies Record<string, Tone>;

const coverColours = Object.fromEntries(Object.entries(AREA_COLOURS).map(([k, v]) => [k, hex(v)])) as Record<Cover, number>;

const BASE: Resolved = {
  buildings: {
    rules: [
      { why: 'Too low to be anything but a shed or garage', maxH: 3.1, style: { shed: 1 } },
      { why: 'A house this tall is really apartments', use: ['house'], minH: 11, style: { apartments: 1 } },
      { why: 'Tall enough to be a tower', minH: 38, use: ['house', 'apartments', 'retail', 'shed', 'other'], style: { tower: 1 } },
      { why: 'Tagged as a house', use: ['house'], style: { house: 1 } },
      { why: 'Tagged as apartments or a hotel', use: ['apartments'], style: { apartments: 1 } },
      { why: 'A public institution: university, church, civic', use: ['institution'], style: { heritage: 1 } },
      { why: 'Tagged as a shop, café or bar', use: ['retail'], style: { shop: 1 } },
      { why: 'Tagged as a shed, garage or warehouse', use: ['shed'], style: { shed: 1 } },
      { why: 'Low and untagged: a shop', maxH: 13, style: { shop: 1 } },
      { why: 'Anything else: offices', style: { office: 1 } },
    ],
    palettes: {},
  },
  street: {
    lamp: 'modern',
    lampEvery: { motorway: 55, ramp: 42, arterial: 34, collector: 30, street: 34, lane: 40 },
    lampSides: { motorway: 'left', ramp: 'left', arterial: 'both', collector: 'alternate', street: 'alternate', lane: 'left' },
    trees: { mix: { none: 0.3, some: 0.42, avenue: 0.28 }, spacing: { some: 17, avenue: 11 }, kit: { broadleaf: 1 }, size: [0.5, 0.78], tone: TONES.street },
    extras: [],
  },
  ground: { base: 0xa9ad98, cover: { ...coverColours, open: 0xa9ad98 }, path: { colour: 0xd9cfb8, width: 2.2 }, stream: 0x6fb0d8 },
  cover: {
    wood: [{ kit: 'broadleaf', spacing: 6.5, chance: 0.9, size: [0.7, 1.4], tone: TONES.bush }],
    cemetery: [{ kit: 'broadleaf', spacing: 10, chance: 0.75, size: [0.875, 1.75], tone: TONES.bush }],
    park: [{ kit: 'broadleaf', spacing: 19, chance: 0.6, size: [0.875, 1.75], tone: TONES.bush }],
    campus: [{ kit: 'broadleaf', spacing: 24, chance: 0.5, size: [0.875, 1.75], tone: TONES.bush }],
  },
};

/** Layered native forest, by where each species grows: kauri on ridges, nīkau and ponga in damp gullies. */
const NATIVE_BUSH: ScatterLayer[] = [
  { kit: 'broadleaf', spacing: 6, chance: 0.7, size: [0.75, 1.3], tone: TONES.native },
  { kit: 'kauri', spacing: 26, chance: 0.55, size: [0.9, 1.4], relief: [2, 40], slope: [0, 32] },
  { kit: 'ponga', spacing: 5, chance: 0.45, size: [0.7, 1.2], relief: [-40, 1], near: { stream: [25, 70] } },
  { kit: 'nikau', spacing: 7, chance: 0.5, size: [0.8, 1.25], near: { stream: [10, 45] }, relief: [-40, 0] },
  { kit: 'shrub', spacing: 3.2, chance: 0.5, size: [0.6, 1.2], tone: TONES.native },
];

/** Bush coming back on cleared land: kānuka-like scrub with tree ferns, thinner than old forest. */
const REGENERATING: ScatterLayer[] = [
  { kit: 'broadleaf', spacing: 7, chance: 0.55, size: [0.6, 1.0], tone: TONES.native },
  { kit: 'ponga', spacing: 7, chance: 0.4, size: [0.6, 1.0], near: { stream: [20, 60] } },
  { kit: 'cabbage', spacing: 18, chance: 0.4, size: [0.8, 1.2] },
  { kit: 'shrub', spacing: 4, chance: 0.45, size: [0.6, 1.1], tone: TONES.native },
];

export const PROFILES: Profile[] = [
  {
    id: 'auckland',
    title: 'Auckland (base)',
    about: "The labs' original rules: every field has a value here, and every other profile only says how it differs.",
    swatch: 0x9aa0a8,
    ...BASE,
  },

  // Regions: a whole stretch of country.
  {
    id: 'isthmus',
    title: 'Auckland isthmus',
    about: 'The old city on its volcanic isthmus: leafy, with as many exotic trees as native ones, and pōhutukawa on every bank.',
    swatch: 0xb9b08a,
    street: { trees: { kit: { broadleaf: 3, pohutukawa: 1 } } },
  },
  {
    id: 'waitakere',
    title: 'Waitākere Ranges and west coast',
    about: 'Rain-fed native forest on steep ranges, running right down to black iron-sand beaches. Unlit roads, no footpaths.',
    swatch: 0x3f6b4a,
    street: { lamp: 'none', trees: { mix: { none: 1, some: 0, avenue: 0 } } },
    ground: { base: 0x6d8a58, cover: { beach: 0x4a4744, rock: 0x5a5650, park: 0x7fa463, open: 0x6d8a58 }, path: { colour: 0xa08a68, width: 1.6 } },
    buildings: { palettes: { house: { walls: [0xe8c547, 0x4f8fbf, 0xf4efe6, 0x2f3b45, 0x8a5a3c] } } },
    cover: {
      wood: NATIVE_BUSH,
      open: REGENERATING,
      park: [
        { kit: 'pohutukawa', spacing: 16, chance: 0.35, size: [0.8, 1.3] },
        { kit: 'cabbage', spacing: 14, chance: 0.3, size: [0.8, 1.2] },
      ],
      beach: [
        { kit: 'driftwood', spacing: 9, chance: 0.25, size: [0.6, 1.4], near: { coast: [70, 30] }, tone: TONES.driftwood },
        { kit: 'rock', spacing: 7, chance: 0.12, size: [0.4, 1.4] },
      ],
      rock: [
        { kit: 'pohutukawa', spacing: 9, chance: 0.4, size: [0.6, 1.0], slope: [0, 38] },
        { kit: 'flax', spacing: 4, chance: 0.5, size: [0.6, 1.1], slope: [0, 50] },
      ],
    },
  },

  // Districts: what the planning zone says the land is for.
  {
    id: 'city-centre',
    title: 'City centre',
    about: 'Queen Street and the CBD grid: towers in glass and concrete, verandas over every footpath, nīkau and plane trees.',
    swatch: 0x4f7cc9,
    buildings: {
      rules: [
        { why: 'City centre: a tall building is a glass or concrete tower', minH: 30, use: ['other', 'apartments', 'retail'], style: { tower: 2, glass: 3 } },
        { why: 'City centre: mid-rise is offices or apartments over shops', minH: 13, use: ['other', 'retail'], style: { office: 3, brutalist: 1 } },
      ],
      palettes: { office: { walls: [0xe6dccb, 0xd8cdb8, 0xc9cfd2, 0xe9e2d6, 0xb9a48c, 0xd3c6b0] } },
    },
    street: {
      lampEvery: { motorway: 55, ramp: 42, arterial: 26, collector: 26, street: 28, lane: 32 },
      lampSides: { motorway: 'left', ramp: 'left', arterial: 'both', collector: 'both', street: 'alternate', lane: 'left' },
      trees: { mix: { none: 0.2, some: 0.35, avenue: 0.45 }, kit: { plane: 2, nikau: 1, pohutukawa: 1 }, tone: TONES.exotic },
      extras: [
        { kit: 'bench', every: 70, classes: ['arterial', 'collector', 'street'] },
        { kit: 'bin', every: 48, classes: ['arterial', 'collector', 'street'] },
      ],
    },
    ground: { base: 0xb7b3a8, cover: { open: 0xb7b3a8, plaza: 0xd6cbb6 } },
  },
  {
    id: 'city-fringe',
    title: 'City fringe and town centres',
    about: 'Two- and three-storey Edwardian shops and converted warehouses around the centre: brick, paint, verandas.',
    swatch: 0xc98a4f,
    buildings: {
      rules: [{ why: 'Fringe: low buildings are shops with flats over', maxH: 15, use: ['other', 'retail'], style: { shop: 3, heritage: 1 } }],
      palettes: { shop: { walls: [0xb8674c, 0xd9785a, 0xe9c46a, 0xf2e3c6, 0x9bc4c9, 0x8fa37a, 0xa85a44] } },
    },
    street: { trees: { mix: { none: 0.35, some: 0.45, avenue: 0.2 } }, extras: [{ kit: 'bin', every: 60, classes: ['arterial', 'collector'] }] },
  },
  {
    id: 'apartments',
    title: 'Terraces and apartments',
    about: 'Medium-rise apartments and terraces stepping up from the old suburbs, with small courtyards.',
    swatch: 0x9a6fc0,
    buildings: { rules: [{ why: 'Apartment zone: anything over two storeys is apartments', minH: 7, use: ['house', 'other'], style: { apartments: 1 } }] },
    cover: { open: [{ kit: 'broadleaf', spacing: 18, chance: 0.3, size: [0.7, 1.1], tone: TONES.exotic }] },
  },
  {
    id: 'suburb',
    title: 'Villa suburb',
    about: 'Villas and bungalows under big trees: white weatherboard, iron roofs, verandas and deep gardens.',
    swatch: 0xd6b84a,
    buildings: { rules: [{ why: 'Suburb: a low building is a villa', maxH: 10, use: ['house', 'other'], style: { villa: 1 } }] },
    street: { trees: { mix: { none: 0.2, some: 0.5, avenue: 0.3 } } },
    cover: {
      open: [
        { kit: 'broadleaf', spacing: 13, chance: 0.4, size: [0.8, 1.4], tone: TONES.exotic },
        { kit: 'cabbage', spacing: 24, chance: 0.3, size: [0.8, 1.1] },
      ],
    },
  },
  {
    id: 'open-space',
    title: 'Council parkland',
    about: 'Mown grass, specimen trees and a few seats.',
    swatch: 0x7fbf5a,
    ground: { cover: { open: 0x8fb86b } },
    cover: { open: [{ kit: 'broadleaf', spacing: 22, chance: 0.45, size: [0.9, 1.6], tone: TONES.bush }] },
  },
  {
    id: 'conservation',
    title: 'Conservation land',
    about: 'Bush the city kept: dense natives on steep gully sides.',
    swatch: 0x2f7a4a,
    ground: { cover: { open: 0x5f8a55 } },
    cover: { open: NATIVE_BUSH, wood: NATIVE_BUSH },
  },
  {
    id: 'tertiary',
    title: 'University campus',
    about: 'Big institutional blocks, mostly concrete from the sixties and seventies, with lawns and courtyards between.',
    swatch: 0xc0566f,
    buildings: { rules: [{ why: 'Campus: an untagged or university building is a concrete teaching block', use: ['institution', 'other'], style: { brutalist: 3, office: 1 } }] },
    street: { extras: [{ kit: 'bench', every: 45, classes: ['street', 'lane'] }] },
    cover: {
      campus: [
        { kit: 'broadleaf', spacing: 17, chance: 0.5, size: [1.0, 1.7], tone: TONES.exotic },
        { kit: 'bench', spacing: 24, chance: 0.5, size: [1, 1], near: { path: [3.5, 6] }, face: 'path' },
      ],
    },
  },
  {
    id: 'hospital',
    title: 'Hospital',
    about: 'A hospital campus: white and pale-blue blocks, car parks, few trees.',
    swatch: 0x6fc0c0,
    buildings: {
      rules: [{ why: 'Hospital: every big building is a clinical block', minH: 6, use: ['institution', 'other', 'apartments'], style: { office: 1 } }],
      palettes: { office: { walls: [0xf4f6f6, 0xe4eef2, 0xdfe8e4, 0xc9dde6] } },
    },
  },
  {
    id: 'coastal-settlement',
    title: 'West coast settlement',
    about: 'Baches on bush sections: small, bright or black-stained weatherboard, iron roofs, under the trees. Gravel verges, no kerbs.',
    swatch: 0xe0704a,
    buildings: {
      rules: [
        { why: 'Settlement: a small building is a bach', maxH: 9, use: ['house', 'other', 'apartments'], style: { bach: 4, villa: 1 } },
        { why: 'Settlement: a public building is a plain hall', use: ['institution', 'retail'], style: { bach: 1 } },
      ],
    },
    cover: {
      open: [
        { kit: 'broadleaf', spacing: 8, chance: 0.5, size: [0.7, 1.2], tone: TONES.native },
        { kit: 'pohutukawa', spacing: 16, chance: 0.4, size: [0.8, 1.3], near: { coast: [150, 400] } },
        { kit: 'cabbage', spacing: 15, chance: 0.4, size: [0.8, 1.2] },
        { kit: 'ponga', spacing: 9, chance: 0.35, size: [0.6, 1.0], near: { stream: [20, 60] } },
        { kit: 'flax', spacing: 9, chance: 0.3, size: [0.6, 1.0] },
      ],
    },
  },
  {
    id: 'ranges',
    title: 'Ranges forest',
    about: 'Unbroken native forest on steep ground: kauri on the ridges, nīkau and ponga down the gullies.',
    swatch: 0x1f5a35,
    ground: { cover: { open: 0x557a48 } },
    cover: { open: NATIVE_BUSH, wood: NATIVE_BUSH },
  },
  {
    id: 'coastal-marine',
    title: 'Dunes and foreshore',
    about: 'The edge of the sea: dune grass, flax, and driftwood above the tide line.',
    swatch: 0xd9c98a,
    cover: {
      open: [
        { kit: 'tussock', spacing: 3.5, chance: 0.5, size: [0.6, 1.2], tone: TONES.dune, near: { coast: [40, 140] } },
        { kit: 'flax', spacing: 8, chance: 0.25, size: [0.6, 1.0], near: { coast: [60, 150] } },
      ],
    },
  },

  // Places: a single named place.
  {
    id: 'victorian-cemetery',
    title: 'Victorian cemetery',
    about: 'Symonds Street: 1840s graves sinking into bush. Leaning, lichened headstones crowd the paths and thin out into a dark canopy; railed family plots here and there.',
    swatch: 0x6b5a7a,
    ground: { cover: { cemetery: 0x5d7f57, wood: 0x4a6e48 }, path: { colour: 0xb3a68a, width: 1.4 } },
    street: { lamp: 'heritage' },
    cover: {
      cemetery: [
        { kit: 'headstone', spacing: 2.6, chance: 0.85, size: [0.8, 1.25], near: { path: [5, 26] }, lean: 11, face: 'path', tone: TONES.lichen },
        { kit: 'plot', spacing: 9, chance: 0.22, size: [0.9, 1.3], near: { path: [3, 14] }, face: 'path' },
        { kit: 'broadleaf', spacing: 7.5, chance: 0.8, size: [1.0, 1.8], tone: TONES.canopy },
        { kit: 'ponga', spacing: 6, chance: 0.5, size: [0.7, 1.1], relief: [-40, -1.5] },
      ],
      wood: [
        { kit: 'broadleaf', spacing: 5.5, chance: 0.85, size: [0.9, 1.6], tone: TONES.canopy },
        { kit: 'ponga', spacing: 4.5, chance: 0.5, size: [0.7, 1.1] },
        { kit: 'headstone', spacing: 5, chance: 0.3, size: [0.8, 1.1], near: { path: [4, 12] }, lean: 18, tone: TONES.lichen },
      ],
    },
  },
  {
    id: 'heritage-campus',
    title: 'Heritage campus core',
    about: 'The old university around the Clock Tower: neo-gothic stone, steep slate roofs, pointed windows, Victorian merchant houses, oaks on lawns.',
    swatch: 0xe0a0b0,
    extends: 'tertiary',
    buildings: {
      rules: [
        { why: 'Heritage core: low and mid-rise buildings are neo-gothic stone', maxH: 24, use: ['institution', 'other', 'retail'], style: { gothic: 3, heritage: 1 } },
        { why: 'Heritage core: old houses are Victorian villas', maxH: 14, use: ['house', 'apartments'], style: { villa: 1 } },
      ],
    },
    street: { lamp: 'heritage', trees: { kit: { oak: 2, broadleaf: 1 }, tone: TONES.exotic } },
    cover: {
      campus: [
        { kit: 'oak', spacing: 15, chance: 0.6, size: [1.1, 1.8], tone: TONES.exotic },
        { kit: 'bench', spacing: 20, chance: 0.5, size: [1, 1], near: { path: [3.5, 6] }, face: 'path' },
      ],
      open: [{ kit: 'oak', spacing: 20, chance: 0.4, size: [1.0, 1.6], tone: TONES.exotic }],
    },
  },
  {
    id: 'formal-park',
    title: 'Victorian formal park',
    about: 'Albert Park: lawns, flowerbeds and huge old exotic trees, with heritage lamps along gravel paths.',
    swatch: 0x9bd06a,
    street: { lamp: 'heritage' },
    ground: { cover: { park: 0x7fc15c }, path: { colour: 0xe2d6bb, width: 2.8 } },
    cover: {
      park: [
        { kit: 'oak', spacing: 17, chance: 0.55, size: [1.2, 2.0], tone: TONES.exotic },
        { kit: 'pohutukawa', spacing: 26, chance: 0.35, size: [1.0, 1.5] },
        { kit: 'palm', spacing: 30, chance: 0.3, size: [0.9, 1.2] },
        { kit: 'lamp.heritage', spacing: 13, chance: 0.9, size: [1, 1], near: { path: [2.6, 3.6] }, face: 'path' },
        { kit: 'bench', spacing: 15, chance: 0.4, size: [1, 1], near: { path: [2.8, 3.8] }, face: 'path' },
        { kit: 'flowerbed', spacing: 21, chance: 0.35, size: [0.8, 1.3], near: { path: [5, 12] } },
      ],
    },
  },
  {
    id: 'domain',
    title: 'The Domain',
    about: 'An old volcano turned park: wide lawns, avenues of exotic giants, and native bush down the gully sides.',
    swatch: 0x5fa060,
    cover: {
      park: [
        { kit: 'oak', spacing: 28, chance: 0.5, size: [1.4, 2.2], tone: TONES.exotic },
        { kit: 'pohutukawa', spacing: 34, chance: 0.4, size: [1.2, 1.7] },
      ],
      wood: NATIVE_BUSH,
    },
  },
];

export const LIBRARY = new Map(PROFILES.map((p) => [p.id, p]));
