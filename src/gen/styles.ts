// Facade styles: the building kit. A style is a handful of numbers and colours the split grammar
// in facade.ts reads. Profiles pick styles by name and may recolour them for their place.
import type { Use } from '../profile/schema.ts';

export interface Style {
  name: string;
  walls: number[];
  trim: number;
  roof: number[];
  /** Window size as a fraction of its cell. A width of 1 makes a continuous ribbon. */
  winW: number;
  winH: number;
  /** Height of the sill above the floor, as a fraction of the floor height. */
  sill: number;
  shopfront: boolean;
  awning: boolean;
  cornice: boolean;
  balcony: boolean;
  parapet: number;
  roofForm: 'flat' | 'hip';
  plant: boolean;
  /** How deep windows sit in the wall, in metres. */
  inset?: number;
  /** Multiplies the rise of a hip roof: steep slate roofs, low iron ones. */
  roofPitch?: number;
  /** Pointed window heads. */
  lancet?: boolean;
}

export const STYLES: Record<string, Style> = {
  tower: {
    name: 'tower', walls: [0xe4e9ec, 0xd2dbe2, 0xc9d3d0, 0xe9e2d6], trim: 0x8794a0, roof: [0x9aa3aa],
    winW: 1, winH: 0.62, sill: 0.24, shopfront: true, awning: false, cornice: false, balcony: false, parapet: 1.2, roofForm: 'flat', plant: true,
  },
  office: {
    name: 'office', walls: [0xf2e3c6, 0xe8b08a, 0x8fbfb0, 0xe9c46a, 0x9db4d6, 0xf7f1e3, 0xd9c2a8], trim: 0xf4efe6, roof: [0xa7a39b],
    winW: 0.62, winH: 0.52, sill: 0.3, shopfront: true, awning: false, cornice: false, balcony: false, parapet: 0.9, roofForm: 'flat', plant: false,
  },
  shop: {
    name: 'shop', walls: [0xf2e3c6, 0xf0c9c0, 0xd9785a, 0xc9d6a3, 0xe9c46a, 0x9bc4c9, 0xf7f1e3], trim: 0xfaf6ee, roof: [0xa7a39b],
    winW: 0.5, winH: 0.5, sill: 0.3, shopfront: true, awning: true, cornice: true, balcony: false, parapet: 1.1, roofForm: 'flat', plant: false,
  },
  apartments: {
    name: 'apartments', walls: [0xf7f1e3, 0xe8d5c0, 0xcfd8dc, 0xf0c9c0, 0xd6e2c8], trim: 0x6f7780, roof: [0xa7a39b],
    winW: 0.66, winH: 0.6, sill: 0.14, shopfront: false, awning: false, cornice: false, balcony: true, parapet: 0.8, roofForm: 'flat', plant: false,
  },
  heritage: {
    name: 'heritage', walls: [0xb8674c, 0xa85a44, 0xcdbf9f, 0xc4b18c], trim: 0xe9dfc8, roof: [0x6f7a80, 0x5d6a63],
    winW: 0.36, winH: 0.66, sill: 0.2, shopfront: false, awning: false, cornice: true, balcony: false, parapet: 0.9, roofForm: 'flat', plant: false,
  },
  house: {
    name: 'house', walls: [0xfaf6ee, 0xf2e3c6, 0xd6e2c8, 0xcfe0e8, 0xf0c9c0, 0xf3e2a9], trim: 0xffffff, roof: [0xb5533c, 0x7d8a8f, 0x5f7f6a, 0x8a5a4a],
    winW: 0.42, winH: 0.42, sill: 0.3, shopfront: false, awning: false, cornice: false, balcony: false, parapet: 0, roofForm: 'hip', plant: false,
  },
  shed: {
    name: 'shed', walls: [0xb9bcc0, 0xa9b0a6, 0xc9c2b4], trim: 0x8f9499, roof: [0x8f9499],
    winW: 0, winH: 0, sill: 0, shopfront: false, awning: false, cornice: false, balcony: false, parapet: 0, roofForm: 'flat', plant: false,
  },
  // Added for profiles.
  gothic: {
    name: 'gothic', walls: [0xd8cfb8, 0xcfc3a6, 0xc2b594, 0xe2dccb], trim: 0xf1ece0, roof: [0x56606b, 0x4d5862, 0x6f9a8a],
    winW: 0.3, winH: 0.62, sill: 0.22, shopfront: false, awning: false, cornice: true, balcony: false, parapet: 0, roofForm: 'hip', plant: false,
    inset: 0.32, roofPitch: 2.4, lancet: true,
  },
  brutalist: {
    name: 'brutalist', walls: [0xbdb9b0, 0xaeaba2, 0xc9c4b8, 0xb3ada0], trim: 0x8f8c84, roof: [0x8e8c86],
    winW: 0.8, winH: 0.42, sill: 0.34, shopfront: false, awning: false, cornice: true, balcony: false, parapet: 1.4, roofForm: 'flat', plant: true,
    inset: 0.55,
  },
  glass: {
    name: 'glass', walls: [0x7fa3b8, 0x6f95a8, 0x8db3c2, 0x9fb7c4], trim: 0x5d6f7c, roof: [0x8e979e],
    winW: 1, winH: 0.84, sill: 0.08, shopfront: true, awning: false, cornice: false, balcony: false, parapet: 0.6, roofForm: 'flat', plant: true,
    inset: 0.08,
  },
  villa: {
    name: 'villa', walls: [0xfbf7ee, 0xf4ecd8, 0xe9efe6, 0xf2e6cf], trim: 0xffffff, roof: [0xb04a37, 0x8a9499, 0x6f7f72, 0xa8a49a],
    winW: 0.34, winH: 0.58, sill: 0.22, shopfront: false, awning: true, cornice: false, balcony: false, parapet: 0, roofForm: 'hip', plant: false,
    roofPitch: 1.3,
  },
  bach: {
    name: 'bach', walls: [0xe8c547, 0x4f8fbf, 0xd8553f, 0x6fae8f, 0xf4efe6, 0x2f3b45, 0x8a5a3c, 0x9fc9d6], trim: 0xf6f2ea, roof: [0xb5533c, 0x5f7f6a, 0x7d8a8f, 0x3f4a52],
    winW: 0.52, winH: 0.5, sill: 0.28, shopfront: false, awning: false, cornice: false, balcony: true, parapet: 0, roofForm: 'hip', plant: false,
    roofPitch: 0.7,
  },
};

export function styleByName(name: string): Style {
  return STYLES[name] ?? STYLES.office;
}

/** What a building is for, from its OSM building or amenity tag. */
const KIND_USE: Record<string, Use> = {
  house: 'house', detached: 'house', terrace: 'house', bungalow: 'house', residential: 'house', semidetached_house: 'house',
  apartments: 'apartments', dormitory: 'apartments', hotel: 'apartments',
  university: 'institution', church: 'institution', cathedral: 'institution', civic: 'institution', public: 'institution', school: 'institution', college: 'institution', synagogue: 'institution', religious: 'institution',
  retail: 'retail', restaurant: 'retail', cafe: 'retail', bar: 'retail', fast_food: 'retail',
  roof: 'shed', carport: 'shed', garage: 'shed', garages: 'shed', shed: 'shed', service: 'shed', container: 'shed', canopy: 'shed', warehouse: 'shed', industrial: 'shed', parking: 'shed',
};

export const useOf = (kind: string): Use => KIND_USE[kind] ?? 'other';
