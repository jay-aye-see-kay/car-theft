// Place profiles: small authored specs that parameterise every generator, so "the vibe" of a
// place is data. A profile is a patch; the resolved profile at any point is the base profile
// with the patches of every layer that covers that point merged on top, in this order:
//
//   base → region → district (planning zone) → place (mapped area or hand-drawn) → override
//
// Each group of fields belongs to the generator that reads it. Nothing else reads a profile.
import type { Area, RoadClass } from '../model/types.ts';

/** A weighted choice, e.g. { plane: 2, nikau: 1 }. Picked per thing by its stable id. */
export type Mix = Record<string, number>;

/**
 * Density by distance to something, in metres: full strength at the first distance or nearer,
 * fading to nothing at the second. If the first is the larger, it is the other way round.
 */
export type Falloff = [number, number];

/** What a building is for, from its OSM tags. Rules match on this, not on raw tags. */
export type Use = 'house' | 'apartments' | 'institution' | 'retail' | 'shed' | 'other';

/** What covers the ground: a mapped area kind, or 'open' where nothing is mapped (yards, verges, unmapped bush). */
export type Cover = Area['kind'] | 'open';

/** Hue, saturation and lightness ranges a kit's colour is picked from, per instance. */
export interface Tone {
  h: [number, number];
  s: number;
  l: [number, number];
  /** Chance an instance is in flower instead (pōhutukawa red). */
  flower?: number;
}

export interface BuildingRule {
  /** Said in the inspector when this rule picks a building's style. */
  why: string;
  use?: Use[];
  minH?: number;
  maxH?: number;
  style: Mix;
}

export interface Palette {
  walls?: number[];
  trim?: number;
  roof?: number[];
}

export interface ScatterLayer {
  kit: string;
  /** Jittered grid spacing in metres, and the chance each grid cell holds one. */
  spacing: number;
  chance: number;
  size: [number, number];
  /** Density by distance to paths, streams, the coast or roads. */
  near?: Partial<Record<'path' | 'stream' | 'coast' | 'road', Falloff>>;
  /** Ground slope in degrees where this grows. */
  slope?: [number, number];
  /** Height above (+) or below (−) the ground 60 m around: ridges and gullies. */
  relief?: [number, number];
  /** Most an instance leans, in degrees. */
  lean?: number;
  /** 'path' turns each instance to face the nearest path. */
  face?: 'random' | 'path';
  tone?: Tone;
}

export interface StreetExtra {
  kit: string;
  /** Metres between them, on roads of these classes with a footpath. */
  every: number;
  classes: RoadClass[];
}

export interface Resolved {
  buildings: {
    /** First match wins. */
    rules: BuildingRule[];
    /** Colours a style takes in this place, by style name. */
    palettes: Record<string, Palette>;
  };
  street: {
    lamp: 'modern' | 'heritage' | 'none';
    /** Metres between lamps, by road class. */
    lampEvery: Record<RoadClass, number>;
    lampSides: Record<RoadClass, 'both' | 'alternate' | 'left'>;
    trees: {
      /** How many streets have no trees, some, or an avenue. Each street draws once. */
      mix: { none: number; some: number; avenue: number };
      spacing: { some: number; avenue: number };
      kit: Mix;
      size: [number, number];
      tone: Tone;
    };
    extras: StreetExtra[];
  };
  ground: {
    base: number;
    cover: Record<Cover, number>;
    path: { colour: number; width: number };
    stream: number;
  };
  /** What grows or stands on each kind of ground cover. */
  cover: Partial<Record<Cover, ScatterLayer[]>>;
}

type Patch<T> = { [K in keyof T]?: T[K] extends unknown[] ? T[K] : T[K] extends object ? Patch<T[K]> : T[K] };

export interface Profile extends Patch<Resolved> {
  id: string;
  title: string;
  /** What place this is meant to evoke, in a sentence. */
  about: string;
  /** Another profile whose fields this one starts from. */
  extends?: string;
  /** Colour on the profile map. */
  swatch: number;
}

/** Fields replaced whole rather than merged key by key: a weighted mix, or a set of distances. */
export const ATOMIC = new Set(['kit', 'mix', 'near', 'tone', 'style']);
