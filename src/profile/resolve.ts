// Merging profiles. A resolved profile is the base with each layer's patch applied in order,
// and it remembers which layer set every field, so the inspector can say why a thing is so.
import { LIBRARY } from './library.ts';
import { ATOMIC, type BuildingRule, type Profile, type Resolved } from './schema.ts';

export type Level = 'base' | 'region' | 'district' | 'place' | 'override';
export const LEVELS: Level[] = ['base', 'region', 'district', 'place', 'override'];

export interface Layer {
  level: Level;
  /** What put this layer here, e.g. "Business - City Centre Zone". */
  source: string;
  profile?: string;
  patch?: Partial<Profile>;
}

export interface ResolvedProfile {
  value: Resolved;
  /** Field path → the layer that set it, e.g. "street.lamp" → "place: victorian-cemetery". */
  from: Map<string, string>;
  stack: Layer[];
  key: string;
  /** The most specific profile in the stack: what this place is called on the map. */
  top: Profile;
}

const META = new Set(['id', 'title', 'about', 'extends', 'swatch']);
/** Lists that stack rather than replace: a place's rules are tried before its district's. */
const CONCAT = new Set(['rules']);

/** Which layer each building rule came from. */
export const ruleSource = new WeakMap<BuildingRule, string>();

export function profileChain(id: string, swaps: Record<string, string> = {}): Profile[] {
  const p = LIBRARY.get(swaps[id] ?? id);
  if (!p) throw new Error(`No profile "${id}"`);
  return p.extends ? [...profileChain(p.extends, swaps), p] : [p];
}

function apply(target: Record<string, unknown>, patch: Record<string, unknown>, label: string, from: Map<string, string>, path: string): void {
  for (const [k, v] of Object.entries(patch)) {
    if ((!path && META.has(k)) || v === undefined) continue;
    const at = path ? `${path}.${k}` : k;
    if (CONCAT.has(k) && Array.isArray(v)) {
      for (const rule of v) if (!ruleSource.has(rule)) ruleSource.set(rule, label);
      target[k] = [...v, ...((target[k] as unknown[]) ?? [])];
      from.set(at, from.has(at) ? `${label} + ${from.get(at)}` : label);
    } else if (Array.isArray(v) || typeof v !== 'object' || v === null || ATOMIC.has(k)) {
      target[k] = v;
      for (const key of [...from.keys()]) if (key.startsWith(at + '.')) from.delete(key);
      from.set(at, label);
    } else {
      const prev = target[k];
      target[k] = prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...(prev as object) } : {};
      apply(target[k] as Record<string, unknown>, v as Record<string, unknown>, label, from, at);
    }
  }
}

const cache = new Map<string, ResolvedProfile>();

export function layerKey(stack: Layer[]): string {
  return stack.map((l) => `${l.level}:${l.profile ?? ''}:${l.patch ? l.source : ''}`).join('|');
}

/** Resolves a stack of layers. `swaps` replaces one profile by another everywhere, for comparisons. */
export function resolve(stack: Layer[], swaps: Record<string, string> = {}): ResolvedProfile {
  const key = layerKey(stack) + '#' + JSON.stringify(swaps);
  const hit = cache.get(key);
  if (hit) return hit;
  const value = {} as Record<string, unknown>;
  const from = new Map<string, string>();
  let top = LIBRARY.get('auckland')!;
  for (const layer of stack) {
    if (layer.profile) {
      for (const p of profileChain(layer.profile, swaps)) {
        apply(value, p as unknown as Record<string, unknown>, `${layer.level}: ${p.id}`, from, '');
        top = p;
      }
    }
    if (layer.patch) apply(value, layer.patch as unknown as Record<string, unknown>, `${layer.level}: ${layer.source}`, from, '');
  }
  const r: ResolvedProfile = { value: value as unknown as Resolved, from, stack, key, top };
  cache.set(key, r);
  return r;
}

/** Walks a resolved value's leaves with their provenance, for the inspector. */
export function* leaves(r: ResolvedProfile): Generator<[string, unknown, string]> {
  for (const [path, label] of [...r.from.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let v: unknown = r.value;
    for (const k of path.split('.')) v = (v as Record<string, unknown>)?.[k];
    yield [path, v, label];
  }
}
