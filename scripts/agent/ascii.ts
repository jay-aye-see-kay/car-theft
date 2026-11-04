// A text map for agents: the ground classes from map.png (the same picture
// the minimap draws), the road graph on top, then whatever's about. North up,
// one character per cell. Cheaper to read than a screenshot, and it's the
// layout an agent wants for "which way's the road".
import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { BLIP, MAP_COLOURS, MAP_PX, MAP_SHADES, ROAD_FILL } from '../../src/map/style.ts';
import { RoadGraph } from '../../src/city/road-graph.ts';

const DIR = new URL('../../public/city/cbd/', import.meta.url);

/** Ground class by map.png palette index. */
const GLYPH: Record<number, string> = {
  [MAP_SHADES.land]: '.',
  [MAP_SHADES.paving]: '.',
  [MAP_SHADES.park]: '"',
  [MAP_SHADES.woods]: 'T',
  [MAP_SHADES.sand]: ':',
  [MAP_SHADES.water]: '~',
  [MAP_SHADES.building]: '#',
};
/** Over everything else, in this order (later wins). */
const MARKS = { route: 'o', boat: 'B', ped: 'p', cop: 'K', parked: 'c', traffic: 't', police: 'C', purple: 'P', start: 'M', prop: '*', target: 'X' } as const;
export type Mark = keyof typeof MARKS;
export const LEGEND = '# building  . open ground  " park  T trees  : sand  ~ water  (space) road  o route  @ you (arrow: facing)  P purple car  c parked  t traffic  C police  p person  K cop on foot  B boat  M mission start  * mission prop  X goal';

interface Picture {
  w: number;
  h: number;
  px: Uint8Array;
}

/** An 8-bit palette PNG (tools/citygen/map.ts writes nothing else): the palette index of each pixel. */
export function decodePalettePng(buf: Buffer): Picture {
  let o = 8;
  let w = 0;
  let h = 0;
  const idat: Buffer[] = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 3) throw new Error('map.png: expected an 8-bit palette PNG');
    } else if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(w * h);
  const stride = w + 1;
  for (let y = 0; y < h; y++) {
    const f = raw[y * stride];
    for (let x = 0; x < w; x++) {
      const v = raw[y * stride + 1 + x];
      const a = x ? px[y * w + x - 1] : 0;
      const b = y ? px[(y - 1) * w + x] : 0;
      const c = x && y ? px[(y - 1) * w + x - 1] : 0;
      let out = v;
      if (f === 1) out = v + a;
      else if (f === 2) out = v + b;
      else if (f === 3) out = v + ((a + b) >> 1);
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[y * w + x] = out & 255;
    }
  }
  return { w, h, px };
}

export interface Overlay {
  x: number;
  z: number;
  mark: Mark;
}

export class TextMap {
  readonly roads: RoadGraph;
  private readonly pic: Picture;
  private readonly bounds: { minX: number; minZ: number };

  constructor() {
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8'));
    this.bounds = manifest.bounds;
    this.pic = decodePalettePng(readFileSync(new URL('map.png', DIR)));
    this.roads = new RoadGraph(JSON.parse(readFileSync(new URL('roadgraph.json', DIR), 'utf8')));
  }

  /**
   * The map round (cx, cz), `radius` m each way, `cell` m per character,
   * with `you` (heading in radians) in the middle and `marks` over it.
   * Returns the lines and the streets in view.
   */
  render(cx: number, cz: number, radius: number, cell: number, heading: number | null, marks: readonly Overlay[]): { lines: string[]; streets: string[] } {
    const n = Math.round(radius / cell);
    const size = 2 * n + 1;
    const grid: string[][] = [];
    const x0 = cx - n * cell;
    const z0 = cz - n * cell;
    for (let r = 0; r < size; r++) {
      const row: string[] = [];
      for (let c = 0; c < size; c++) row.push(this.ground(x0 + c * cell, z0 + r * cell));
      grid.push(row);
    }
    // Roads: every edge near the view, each cell its carriageway covers.
    const streets = new Map<string, number>();
    for (const e of this.roads.edges) {
      for (let k = 1; k < e.s.length; k++) {
        const ax = e.pts[3 * (k - 1)];
        const az = e.pts[3 * (k - 1) + 1];
        const bx = e.pts[3 * k];
        const bz = e.pts[3 * k + 1];
        if (Math.max(ax, bx) < x0 - 20 || Math.min(ax, bx) > x0 + size * cell + 20) continue;
        if (Math.max(az, bz) < z0 - 20 || Math.min(az, bz) > z0 + size * cell + 20) continue;
        const len = Math.hypot(bx - ax, bz - az);
        const half = Math.max(e.width / 2, cell / 2);
        for (let d = 0; d <= len; d += cell / 2) {
          const u = len ? d / len : 0;
          const px = ax + (bx - ax) * u;
          const pz = az + (bz - az) * u;
          let any = false;
          // Cells whose centres are on the carriageway (at least the line itself).
          const reach = Math.ceil(half / cell);
          for (let dr = -reach; dr <= reach; dr++) {
            for (let dc = -reach; dc <= reach; dc++) {
              const c = Math.round((px - x0) / cell) + dc;
              const r = Math.round((pz - z0) / cell) + dr;
              if (r < 0 || c < 0 || r >= size || c >= size) continue;
              const ex = x0 + c * cell - px;
              const ez = z0 + r * cell - pz;
              if ((dr === 0 && dc === 0) || Math.hypot(ex, ez) <= half) {
                grid[r][c] = ' ';
                any = true;
              }
            }
          }
          if (any && e.name) streets.set(e.name, Math.min(streets.get(e.name) ?? Infinity, Math.hypot(px - cx, pz - cz)));
        }
      }
    }
    const order = Object.keys(MARKS) as Mark[];
    for (const m of [...marks].sort((a, b) => order.indexOf(a.mark) - order.indexOf(b.mark))) {
      let c = Math.round((m.x - x0) / cell);
      let r = Math.round((m.z - z0) / cell);
      // Off the edge: the goal and mission starts cling to the rim, like the minimap.
      if (r < 0 || c < 0 || r >= size || c >= size) {
        if (m.mark !== 'target' && m.mark !== 'start') continue;
        const k = n / Math.max(Math.abs(c - n), Math.abs(r - n));
        c = Math.round(n + (c - n) * k);
        r = Math.round(n + (r - n) * k);
      }
      grid[r][c] = MARKS[m.mark];
    }
    grid[n][n] = heading === null ? '@' : arrow(heading);
    const lines = grid.map((row) => row.join('').replace(/\s+$/, ''));
    return { lines, streets: [...streets.entries()].sort((a, b) => a[1] - b[1]).map(([s]) => s) };
  }

  /** map.png's palette index under a point (MAP_SHADES). */
  shade(x: number, z: number): number {
    const c = Math.floor((x - this.bounds.minX) / MAP_PX);
    const r = Math.floor((z - this.bounds.minZ) / MAP_PX);
    if (c < 0 || r < 0 || c >= this.pic.w || r >= this.pic.h) return MAP_SHADES.water;
    return this.pic.px[r * this.pic.w + c];
  }

  private ground(x: number, z: number): string {
    const c = Math.floor((x - this.bounds.minX) / MAP_PX);
    const r = Math.floor((z - this.bounds.minZ) / MAP_PX);
    if (c < 0 || r < 0 || c >= this.pic.w || r >= this.pic.h) return '?';
    return GLYPH[this.pic.px[r * this.pic.w + c]] ?? '?';
  }
}

/** Blip colours for the picture (the minimap's where it has one). */
const DOT: Record<Mark, string> = {
  route: BLIP.waypoint, boat: BLIP.boat, ped: '#f7e3c4', cop: '#3b6cff', parked: '#8a8f99', traffic: '#ff8c1a', police: '#3b6cff',
  purple: '#a64dff', start: BLIP.mission, prop: BLIP.prop, target: BLIP.goal,
};

export interface PictureOptions {
  /** Metres each way from the middle. */
  radius: number;
  /** Image size, px (square). */
  size: number;
}

/**
 * The same view as a small PNG, north up: ground from map.png, roads from
 * the road graph, dots for what's about, a white arrow for you. A 256 px
 * picture costs an agent ~90 image tokens, a tenth of the text map, and shows
 * far more of the layout.
 */
export function picture(map: TextMap, cx: number, cz: number, heading: number | null, marks: readonly Overlay[], o: PictureOptions): Buffer {
  const n = o.size;
  const mpp = (2 * o.radius) / n;
  const rgb = new Uint8Array(n * n * 3);
  const set = (c: number, r: number, hex: string) => {
    if (c < 0 || r < 0 || c >= n || r >= n) return;
    const v = parseInt(hex.slice(1), 16);
    const k = (r * n + c) * 3;
    rgb[k] = v >> 16;
    rgb[k + 1] = (v >> 8) & 255;
    rgb[k + 2] = v & 255;
  };
  const x0 = cx - o.radius;
  const z0 = cz - o.radius;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) set(c, r, MAP_COLOURS[map.shade(x0 + (c + 0.5) * mpp, z0 + (r + 0.5) * mpp)] ?? '#000000');
  // Roads: fill each carriageway (at least a pixel wide).
  for (const e of map.roads.edges) {
    const half = Math.max(e.width / 2, mpp * 0.6);
    for (let k = 1; k < e.s.length; k++) {
      const ax = e.pts[3 * (k - 1)];
      const az = e.pts[3 * (k - 1) + 1];
      const bx = e.pts[3 * k];
      const bz = e.pts[3 * k + 1];
      if (Math.max(ax, bx) < x0 - 20 || Math.min(ax, bx) > x0 + 2 * o.radius + 20 || Math.max(az, bz) < z0 - 20 || Math.min(az, bz) > z0 + 2 * o.radius + 20) continue;
      const len = Math.hypot(bx - ax, bz - az);
      const reach = Math.ceil(half / mpp);
      for (let d = 0; d <= len; d += mpp * 0.7) {
        const u = len ? d / len : 0;
        const px = ax + (bx - ax) * u;
        const pz = az + (bz - az) * u;
        const pc = (px - x0) / mpp;
        const pr = (pz - z0) / mpp;
        for (let dr = -reach; dr <= reach; dr++) {
          for (let dc = -reach; dc <= reach; dc++) {
            if (Math.hypot(dc, dr) * mpp <= half) set(Math.floor(pc + dc), Math.floor(pr + dr), ROAD_FILL);
          }
        }
      }
    }
  }
  const dot = (x: number, z: number, rad: number, hex: string) => {
    let c = (x - x0) / mpp;
    let r = (z - z0) / mpp;
    // Off the edge: goals and mission starts cling to the rim, like the minimap.
    if (c < 0 || r < 0 || c >= n || r >= n) {
      const m = n / 2 - rad - 1;
      const k = m / Math.max(Math.abs(c - n / 2), Math.abs(r - n / 2));
      c = n / 2 + (c - n / 2) * k;
      r = n / 2 + (r - n / 2) * k;
    }
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) if (dc * dc + dr * dr <= rad * rad + 1) set(Math.round(c + dc), Math.round(r + dr), hex);
  };
  const order = Object.keys(MARKS) as Mark[];
  const big = Math.max(2, Math.round(n / 90));
  for (const m of [...marks].sort((a, b) => order.indexOf(a.mark) - order.indexOf(b.mark))) {
    const onRim = m.mark === 'target' || m.mark === 'start';
    const c = (m.x - x0) / mpp;
    const r = (m.z - z0) / mpp;
    if (!onRim && (c < 0 || r < 0 || c >= n || r >= n)) continue;
    dot(m.x, m.z, m.mark === 'ped' || m.mark === 'cop' ? Math.max(1, big - 1) : onRim || m.mark === 'prop' ? big + 1 : big, DOT[m.mark]);
  }
  // You: a white wedge with a black edge, pointing the way you face.
  const h = heading ?? Math.PI / 2;
  const fx = Math.cos(h);
  const fz = -Math.sin(h);
  const wedge = (L: number, hex: string) => {
    for (let t = -L * 2; t <= L * 2; t += 0.5) {
      for (let w = -L * 2; w <= L * 2; w += 0.5) {
        const along = t / L;
        if (along >= -1 && along <= 1 && Math.abs(w) <= (1 - (along + 1) / 2) * L * 0.8 + 0.5) set(Math.round(n / 2 + fx * t - fz * w), Math.round(n / 2 + fz * t + fx * w), hex);
      }
    }
  };
  wedge(big * 4 + 2, '#000000');
  wedge(big * 4, BLIP.player);
  return encodePng(n, n, rgb);
}

/** An RGB PNG, no dependency. */
function encodePng(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgb.buffer, y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

let CRC: Uint32Array | null = null;
function crc32(b: Buffer): number {
  if (!CRC) {
    CRC = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Which way you face, as an arrow (north up). */
function arrow(h: number): string {
  // heading 0 faces +x (east); north is -z, which heading π/2 faces.
  const k = Math.round(((h % (2 * Math.PI)) + 2 * Math.PI) / (Math.PI / 4)) % 8;
  return ['>', '/', '^', '\\', '<', '/', 'v', '\\'][k];
}
