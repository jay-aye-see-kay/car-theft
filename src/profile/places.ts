// Which profile applies where. Four sources, from coarse to fine, each a short list of rules:
//
//   regions   hand-drawn, a few per city: what country this is
//   zones     the Auckland Unitary Plan zone under a point picks a district profile
//   areas     a mapped area (cemetery, park, campus) of a given kind or name picks a place profile
//   places    hand-drawn outlines for places no dataset knows about, like a heritage core
//
// and then overrides: patches keyed by stable ids, kept apart from the rules so a fix survives
// regenerating everything else.
import type { Area } from '../model/types.ts';
import type { Profile } from './schema.ts';

/** Outlines are latitude/longitude, so they hold across tiles and rebakes. */
export type LatLon = [number, number];

export interface Region {
  id: string;
  profile: string;
  outline: LatLon[];
}

export const REGIONS: Region[] = [
  // Coarse on purpose: a region is "which country is this", not a boundary anyone draws carefully.
  { id: 'isthmus', profile: 'isthmus', outline: [[-36.78, 174.66], [-36.78, 174.92], [-36.98, 174.92], [-36.98, 174.66]] },
  { id: 'west', profile: 'waitakere', outline: [[-36.80, 174.38], [-36.80, 174.62], [-37.08, 174.62], [-37.08, 174.38]] },
];

export interface ZoneRule {
  /** Plan zone names. */
  zones: string[];
  /** Only inside this region. */
  region?: string;
  profile: string;
}

/** First match wins. */
export const ZONE_RULES: ZoneRule[] = [
  { zones: ['Business - City Centre Zone'], profile: 'city-centre' },
  { zones: ['Business - Neighbourhood Centre Zone'], region: 'west', profile: 'coastal-settlement' },
  {
    zones: ['Business - Metropolitan Centre Zone', 'Business - Town Centre Zone', 'Business - Local Centre Zone', 'Business - Mixed Use Zone', 'Business - Neighbourhood Centre Zone'],
    profile: 'city-fringe',
  },
  { zones: ['Residential - Terrace Housing and Apartment Building Zone'], profile: 'apartments' },
  {
    zones: ['Residential - Mixed Housing Urban Zone', 'Residential - Mixed Housing Suburban Zone', 'Residential - Single House Zone', 'Residential - Large Lot Zone'],
    profile: 'suburb',
  },
  { zones: ['Residential - Rural and Coastal Settlement Zone'], profile: 'coastal-settlement' },
  {
    zones: ['Open Space - Informal Recreation Zone', 'Open Space - Sport and Active Recreation Zone', 'Open Space - Civic Spaces Zone', 'Open Space - Community Zone', 'Special Purpose - Major Recreation Facility Zone', 'Special Purpose - Cemetery Zone'],
    profile: 'open-space',
  },
  { zones: ['Open Space - Conservation Zone'], profile: 'conservation' },
  { zones: ['Special Purpose - Tertiary Education Zone'], profile: 'tertiary' },
  { zones: ['Special Purpose - Healthcare Facility and Hospital Zone'], profile: 'hospital' },
  { zones: ['Rural - Waitakere Ranges Zone', 'Rural - Rural Coastal Zone', 'Rural - Rural Conservation Zone', 'Rural - Waitakere Foothills Zone'], profile: 'ranges' },
  { zones: ['Coastal - General Coastal Marine Zone', 'Coastal - Coastal Transition Zone'], profile: 'coastal-marine' },
];

export interface AreaRule {
  kind: Area['kind'];
  /** Matched against the area's mapped name. */
  name?: RegExp;
  region?: string;
  profile: string;
}

export const AREA_RULES: AreaRule[] = [
  { kind: 'cemetery', profile: 'victorian-cemetery' },
  { kind: 'park', name: /^Albert Park$/, profile: 'formal-park' },
  { kind: 'park', name: /Domain/, region: 'isthmus', profile: 'domain' },
  { kind: 'campus', name: /University|Technology/, profile: 'tertiary' },
];

export interface HandPlace {
  id: string;
  name: string;
  profile: string;
  outline: LatLon[];
}

export const HAND_PLACES: HandPlace[] = [
  {
    // Old Arts and the Clock Tower, Old Government House, Old Choral Hall, the Princes Street
    // merchant houses, the High Court and St Andrew's. Nothing in the data marks this out from
    // the 1970s campus around it.
    id: 'uoa-heritage',
    name: 'University heritage core',
    profile: 'heritage-campus',
    outline: [
      [-36.8481, 174.7687],
      [-36.8484, 174.7731],
      [-36.8508, 174.7729],
      [-36.8516, 174.7712],
      [-36.8517, 174.7698],
      [-36.8509, 174.7687],
    ],
  },
];

/** A non-destructive fix: a patch or profile pinned to something by its stable id. */
export interface Override {
  /** 'building:<id>', 'area:<id>', 'zone:<id>' or 'road:<name>'. */
  target: string;
  note: string;
  profile?: string;
  patch?: Partial<Profile>;
}

export const OVERRIDES: Override[] = [
  {
    target: 'building:w23893967',
    note: 'Old Arts Building and the Clock Tower: always neo-gothic, whatever the rules say. A landmark stamp would replace it.',
    patch: { buildings: { rules: [{ why: 'Override: the Clock Tower building', style: { gothic: 1 } }] } },
  },
  {
    target: 'building:rel12509358',
    note: 'Old Government House is kauri timber carved to look like stone: a villa, not a stone block.',
    patch: { buildings: { rules: [{ why: 'Override: Old Government House, timber', style: { villa: 1 } }] } },
  },
  {
    target: 'building:w24234462',
    note: 'The High Court (1868) is gothic revival.',
    patch: { buildings: { rules: [{ why: 'Override: the High Court', style: { gothic: 1 } }] } },
  },
  {
    target: 'road:Queen Street',
    note: 'Queen Street was replanted with nīkau palms.',
    patch: { street: { trees: { mix: { none: 0, some: 0, avenue: 1 }, kit: { nikau: 1 } } } },
  },
  {
    target: 'road:Symonds Street',
    note: 'Symonds Street runs past the cemetery under big old trees.',
    patch: { street: { trees: { mix: { none: 0, some: 0.3, avenue: 0.7 }, kit: { broadleaf: 1, pohutukawa: 1 } } } },
  },
];
