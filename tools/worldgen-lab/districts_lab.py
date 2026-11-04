"""Districts, blocks, lots and a graph WFC (exploration).

  1. District map (the "biomes"): real data distilled to a few channels on a
     50 m grid (building cover, LiDAR building height, green, industry,
     houses), classified, then cleaned up (majority filter) so districts are
     cohesive patches rather than a building-by-building copy.
  2. Blocks: the faces between the real road centrelines (kept exactly).
  3. Lots: each block split recursively across its longest side, to a lot
     width per district, keeping only pieces that touch a street.
  4. Graph WFC: each lot picks a building type from its district's tile set.
     Neighbours (lots sharing an edge) must be compatible; corners and real
     data bias the weights (a lot where the LiDAR sees a tower prefers a tower).
     Landmarks are pre-collapsed lots.

Writes docs/worldgen/districts*.png, lots-*.png.
  python3 tools/worldgen-lab/districts_lab.py
"""
import json, math, os, random
from collections import defaultdict, Counter
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from shapely import STRtree
from shapely.geometry import LineString, Polygon, MultiPolygon, box
from shapely.ops import unary_union, polygonize
from lab import *

random.seed(7)
xy, ways, rels = load_osm()
dem = load_raster('dem'); dsm = load_raster('dsm')
land = dem > 0.2
ndsm = np.where(land, np.clip(dsm - dem, 0, 200), 0)

# --- 1. Districts -----------------------------------------------------------
D = 50.0
dn_x, dn_z = int((X1 - X0) / D), int((Z1 - Z0) / D)


def poly_of(refs):
    pts = [xy[r] for r in refs if r in xy]
    if len(pts) < 4 or refs[0] != refs[-1]:
        return None
    p = Polygon(pts)
    return p if p.is_valid and p.area > 1 else p.buffer(0) if p.area > 1 else None


GREEN = {'park', 'garden', 'recreation_ground', 'grass', 'wood', 'forest', 'cemetery', 'pitch', 'golf_course', 'nature_reserve', 'meadow', 'scrub'}
INDUSTRY = {'industrial', 'port', 'railway', 'commercial_port', 'harbour'}
buildings, greens, industry, houses = [], [], [], []
for wid, (refs, t) in ways.items():
    if 'building' in t:
        p = poly_of(refs)
        if p is not None:
            buildings.append(p)
            if t['building'] in ('house', 'detached', 'semidetached_house', 'terrace', 'residential'):
                houses.append(p)
    elif t.get('leisure') in GREEN or t.get('landuse') in GREEN or t.get('natural') in GREEN:
        p = poly_of(refs)
        if p is not None:
            greens.append(p)
    elif t.get('landuse') in INDUSTRY:
        p = poly_of(refs)
        if p is not None:
            industry.append(p)
for t, members in rels:
    if t.get('type') == 'multipolygon' and (t.get('leisure') in GREEN or t.get('landuse') in GREEN or t.get('landuse') in INDUSTRY):
        lines = []
        for typ, ref, role in members:
            if typ == 'way' and role in ('outer', '') and ref in ways:
                pts = [xy[r] for r in ways[ref][0] if r in xy]
                if len(pts) >= 2:
                    lines.append(LineString(pts))
        polys = list(polygonize(unary_union(lines))) if lines else []
        (industry if t.get('landuse') in INDUSTRY else greens).extend(p for p in polys if p.area > 100)


def cover(polys):
    """Share of each 50 m cell covered, by rasterising at 2 m then averaging."""
    img = Image.new('L', (NX, NZ), 0)
    d = ImageDraw.Draw(img)
    for p in polys:
        for g in getattr(p, 'geoms', [p]):
            d.polygon([((x - X0) / CELL, (z - Z0) / CELL) for x, z in g.exterior.coords], fill=255)
    a = np.asarray(img, np.float32) / 255
    return a, block_mean(a)


k = int(D / CELL)


def block_mean(a):
    return a[:dn_z * k, :dn_x * k].reshape(dn_z, k, dn_x, k).mean(axis=(1, 3))


bmask, bcov = cover(buildings)
_, gcov = cover(greens)
_, icov = cover(industry)
_, hcov = cover(houses)
landcov = block_mean(land.astype(np.float32))
# Typical height of what's built in each cell (LiDAR, over building pixels only).
hsum = block_mean(ndsm * bmask); hcnt = block_mean(bmask)
bh = np.where(hcnt > 0.02, hsum / np.maximum(hcnt, 1e-6), 0)
bh = ndimage.maximum_filter(bh, 2) * 0.5 + bh * 0.5

NAMES = ['sea', 'park', 'port', 'towers', 'midrise', 'mainstreet', 'villas']
COL = {'sea': (78, 120, 150), 'park': (120, 170, 100), 'port': (150, 150, 160), 'towers': (60, 70, 110),
       'midrise': (120, 110, 160), 'mainstreet': (210, 150, 90), 'villas': (230, 210, 150)}
cls_ = np.zeros((dn_z, dn_x), np.int8)
for r in range(dn_z):
    for c in range(dn_x):
        if landcov[r, c] < 0.4:
            n = 'sea'
        elif gcov[r, c] > 0.45:
            n = 'park'
        elif icov[r, c] > 0.4:
            n = 'port'
        elif bh[r, c] > 32:
            n = 'towers'
        elif bh[r, c] > 13:
            n = 'midrise'
        elif hcov[r, c] > 0.08 or (bcov[r, c] < 0.3 and bh[r, c] < 9):
            n = 'villas'
        else:
            n = 'mainstreet'
        cls_[r, c] = NAMES.index(n)
raw_cls = cls_.copy()


def majority(a, passes=3, keep=(0,)):
    """Cohesion: each land cell takes its 3x3 neighbourhood's most common district."""
    for _ in range(passes):
        out = a.copy()
        for r in range(1, a.shape[0] - 1):
            for c in range(1, a.shape[1] - 1):
                if a[r, c] in keep:
                    continue
                win = [v for v in a[r - 1:r + 2, c - 1:c + 2].ravel() if v not in keep]
                best, n = Counter(win).most_common(1)[0]
                if n >= 4:
                    out[r, c] = best
        a = out
    return a


cls_ = majority(cls_)


def district_img(a, scale=10):
    rgb = np.array([COL[n] for n in NAMES], np.uint8)[a]
    return Image.fromarray(rgb).resize((a.shape[1] * scale, a.shape[0] * scale), Image.NEAREST)


# Roads, for drawing and for blocks.
road_lines, road_w = [], []
for wid, (refs, t) in ways.items():
    hw = t.get('highway')
    if hw in DRIVE and t.get('area') != 'yes' and t.get('service') not in ('parking_aisle', 'driveway') and t.get('tunnel') != 'yes':
        pts = [xy[r] for r in refs if r in xy]
        if len(pts) >= 2:
            road_lines.append(LineString(pts)); road_w.append(WIDTH.get(cls(hw), 7))


SEGS = [LineString(l.coords[k:k + 2]) for l in road_lines for k in range(len(l.coords) - 1)]
SEG_TREE = STRtree(SEGS)
ROAD_TREE = STRtree(road_lines)


def draw_roads(img, scale_m_per_px, x0=X0, z0=Z0, width=2, col=(255, 255, 255)):
    d = ImageDraw.Draw(img)
    for l in road_lines:
        d.line([((x - x0) / scale_m_per_px, (z - z0) / scale_m_per_px) for x, z in l.coords], fill=col, width=width)
    return img


legend_h = 26
for name, arr in (('districts-raw', raw_cls), ('districts', cls_)):
    im = draw_roads(district_img(arr, 10), D / 10, width=1, col=(250, 250, 250))
    sheet = Image.new('RGB', (im.width, im.height + legend_h), (255, 255, 255))
    sheet.paste(im, (0, legend_h))
    d = ImageDraw.Draw(sheet)
    x = 6
    for n in NAMES:
        d.rectangle((x, 7, x + 12, 19), fill=COL[n]); d.text((x + 16, 7), n, fill=(0, 0, 0)); x += 24 + 7 * len(n)
    sheet.save(f'{OUT}/{name}.png', optimize=True)
    print('wrote', name, sheet.size, Counter(NAMES[v] for v in arr.ravel()).most_common())


def district_at(x, z):
    r, c = int((z - Z0) / D), int((x - X0) / D)
    return NAMES[cls_[min(max(r, 0), dn_z - 1), min(max(c, 0), dn_x - 1)]]


# --- 2. Blocks and 3. lots ----------------------------------------------------
LOT_W = {'towers': 40, 'midrise': 28, 'mainstreet': 11, 'villas': 16, 'port': 60, 'park': 9999}
LOT_D = {'towers': 50, 'midrise': 35, 'mainstreet': 30, 'villas': 35, 'port': 80, 'park': 9999}


def blocks_in(area):
    lines = [l for l in road_lines if l.intersects(area)]
    merged = unary_union(lines + [area.exterior])
    out = []
    for f in polygonize(merged):
        if not f.within(area.buffer(1)):
            continue
        # Shrink by half the road plus a footpath: what's left is buildable.
        near = [road_lines[k].buffer(road_w[k] / 2 + 3, cap_style='flat') for k in ROAD_TREE.query(f.buffer(20))]
        b = f.difference(unary_union(near)) if near else f
        for g in getattr(b, 'geoms', [b]):
            if g.area > 150 and g.geom_type == 'Polygon':
                out.append(g)
    return out


def split(poly, w, depth, street, out, lvl=0):
    """Recursive split across the longest side of the oriented box until lots are about w by depth."""
    mrr = poly.minimum_rotated_rectangle
    cs = list(mrr.exterior.coords)[:4]
    e0 = np.subtract(cs[1], cs[0]); e1 = np.subtract(cs[2], cs[1])
    L0, L1 = np.linalg.norm(e0), np.linalg.norm(e1)
    long_e, long_L, short_L = (e0, L0, L1) if L0 >= L1 else (e1, L1, L0)
    if lvl > 12 or (long_L <= w * 1.6 and short_L <= depth * 1.6) or poly.area < w * depth * 0.6:
        if poly.boundary.distance(street) < 0.5 or poly.intersects(street.buffer(0.5)):
            out.append(poly)
        return
    u = long_e / long_L
    c = np.array(poly.centroid.coords[0])
    t = random.uniform(-0.12, 0.12) * long_L
    n = np.array([-u[1], u[0]])
    m = c + u * t
    big = 1e4
    half_a = Polygon([m + n * big, m + n * big + u * big, m - n * big + u * big, m - n * big])
    for part in (poly.intersection(half_a), poly.difference(half_a)):
        for g in getattr(part, 'geoms', [part]):
            if g.geom_type == 'Polygon' and g.area > 20:
                split(g, w, depth, street, out, lvl + 1)


# --- 4. Graph WFC -------------------------------------------------------------
# Tiles per district: (name, weight, storeys range, colour). Rules below.
TILES = {
    'towers': [('tower', 1.2, (20, 50), (40, 50, 90)), ('podium', 2, (8, 18), (70, 80, 130)), ('heritage', 2, (3, 6), (170, 120, 90)),
               ('office', 3, (6, 12), (100, 100, 150)),
               ('plaza', 1, (0, 0), (190, 190, 170)), ('carpark', 1, (4, 8), (130, 130, 130))],
    'midrise': [('office', 4, (6, 12), (100, 100, 150)), ('heritage', 3, (3, 5), (170, 120, 90)), ('apartments', 3, (5, 10), (150, 120, 160)),
                ('carpark', 1, (3, 6), (130, 130, 130)), ('plaza', 1, (0, 0), (190, 190, 170))],
    'mainstreet': [('shopfront', 6, (2, 3), (215, 140, 80)), ('corner-pub', 2, (2, 3), (160, 70, 50)), ('laneway', 1, (0, 0), (200, 200, 190)),
                   ('church', 0.4, (3, 4), (230, 230, 230)), ('carpark', 1, (0, 0), (150, 150, 150)), ('flats', 1.5, (3, 4), (180, 150, 170))],
    'villas': [('villa', 6, (1, 1), (240, 215, 160)), ('bungalow', 3, (1, 1), (220, 200, 140)), ('flats', 1, (2, 3), (180, 150, 170)),
               ('dairy', 1, (1, 2), (230, 110, 90)), ('pocket-park', 0.5, (0, 0), (120, 175, 100))],
    'port': [('shed', 4, (2, 3), (160, 160, 170)), ('containers', 3, (1, 3), (190, 100, 70)), ('yard', 2, (0, 0), (175, 175, 175))],
}
CORNER_ONLY = {'corner-pub', 'dairy'}
NOT_CORNER = {'laneway'}
NO_SELF = {'laneway', 'carpark', 'plaza', 'church', 'dairy', 'corner-pub', 'pocket-park'}   # never side by side
ONE_PER_BLOCK = {'dairy', 'church', 'pocket-park'}


def compatible(a, b):
    if a == b and a in NO_SELF:
        return False
    if a == b == 'tower':
        return False          # towers stand apart, so the skyline reads as separate towers
    if {a, b} == {'tower', 'heritage'}:
        return True
    return True


def wfc(lots, nbrs, corner, block_of, district, real_h):
    """Min-entropy collapse with forward checking; restarts on contradiction."""
    for attempt in range(30):
        dom = []
        for i in range(len(lots)):
            opts = []
            for name, w, st, col in TILES[district[i]]:
                if name in CORNER_ONLY and not corner[i]:
                    continue
                if name in NOT_CORNER and corner[i]:
                    continue
                # Real data as a soft prior: what the LiDAR sees on this lot.
                h = real_h[i]
                if name == 'tower':
                    w *= 0.1 if h < 30 else 4 if h > 50 else 1.5
                if name in ('heritage', 'shopfront', 'villa') and h > 30:
                    w *= 0.3
                if name in ('plaza', 'yard', 'carpark', 'laneway', 'pocket-park') and h > 6:
                    w *= 0.3
                opts.append((name, w))
            dom.append(dict(opts))
        fixed = {}
        used_in_block = defaultdict(set)
        ok = True
        order = list(range(len(lots)))
        while len(fixed) < len(lots):
            # Lowest entropy first (fewest options, ties random), corners first since they're most constrained.
            free = [i for i in order if i not in fixed]
            i = min(free, key=lambda i: (len(dom[i]), not corner[i], random.random()))
            if not dom[i]:
                ok = False; break
            names, ws = zip(*dom[i].items())
            pick = random.choices(names, ws)[0]
            fixed[i] = pick
            if pick in ONE_PER_BLOCK:
                used_in_block[block_of[i]].add(pick)
                for j in range(len(lots)):
                    if block_of[j] == block_of[i] and j not in fixed:
                        dom[j].pop(pick, None)
            for j in nbrs[i]:
                if j in fixed:
                    continue
                for n in list(dom[j]):
                    if not compatible(pick, n):
                        dom[j].pop(n)
        if ok:
            return fixed, attempt
    raise RuntimeError('wfc: no solution')


def lots_for(area, name):
    blocks = blocks_in(area)
    lots, block_of, district = [], [], []
    for bi, b in enumerate(blocks):
        dname = district_at(*b.centroid.coords[0])
        if dname in ('park', 'sea'):
            continue
        out = []
        streets = unary_union([road_lines[k] for k in ROAD_TREE.query(b.buffer(16))]).buffer(14)
        street_edge = b.exterior.intersection(streets) if b.exterior.intersects(streets) else b.exterior
        split(b, LOT_W[dname], LOT_D[dname], street_edge, out)
        if not out:
            out = [b]
        lots += out; block_of += [bi] * len(out); district += [dname] * len(out)
    tree = STRtree(lots)
    nbrs = [set() for _ in lots]
    for i, p in enumerate(lots):
        for j in tree.query(p.buffer(0.3)):
            if j != i and p.buffer(0.3).intersection(lots[j]).area > 0.5:
                nbrs[i].add(int(j))
    # Corners: lots touching streets on two sides that point different ways.
    corner = []
    for p in lots:
        dirs = []
        for k in SEG_TREE.query(p.buffer(14)):
            (ax, az), (bx, bz) = SEGS[k].coords
            if SEGS[k].distance(p) < 14:
                dirs.append(math.atan2(bz - az, bx - ax) % math.pi)
        corner.append(any(min(abs(a - b), math.pi - abs(a - b)) > 0.6 for a in dirs for b in dirs))
    real_h = []
    for p in lots:
        x0, z0, x1, z1 = p.bounds
        r0, r1 = int((z0 - Z0) / CELL), int((z1 - Z0) / CELL) + 1
        c0, c1 = int((x0 - X0) / CELL), int((x1 - X0) / CELL) + 1
        win = ndsm[max(r0, 0):r1, max(c0, 0):c1]
        real_h.append(float(np.percentile(win, 90)) if win.size else 0)
    return blocks, lots, nbrs, corner, block_of, district, real_h


def render(area, name, seed=7, px=1.0):
    random.seed(seed)
    blocks, lots, nbrs, corner, block_of, district, real_h = lots_for(area, name)
    fixed, attempts = wfc(lots, nbrs, corner, block_of, district, real_h)
    x0, z0, x1, z1 = area.bounds
    W, Hh = int((x1 - x0) / px), int((z1 - z0) / px)
    img = Image.new('RGB', (W, Hh), (226, 226, 220))
    d = ImageDraw.Draw(img)
    to = lambda pts: [((x - x0) / px, (z - z0) / px) for x, z in pts]
    # District wash underneath.
    for r in range(dn_z):
        for c in range(dn_x):
            cx, cz = X0 + c * D, Z0 + r * D
            if cx + D < x0 or cx > x1 or cz + D < z0 or cz > z1:
                continue
            col = COL[NAMES[cls_[r, c]]]
            d.rectangle(to([(cx, cz), (cx + D, cz + D)]), fill=tuple(int(v * 0.35 + 255 * 0.65) for v in col))
    for l, w in zip(road_lines, road_w):
        if l.intersects(area):
            d.line(to(l.coords), fill=(90, 90, 96), width=max(1, int(w / px)))
    colours = {t[0]: t[3] for ts in TILES.values() for t in ts}
    for i, p in enumerate(lots):
        d.polygon(to(p.exterior.coords), fill=colours[fixed[i]], outline=(255, 255, 255))
    # The real thing, same window: OSM footprints shaded by LiDAR height.
    real = Image.new('RGB', (W, Hh), (226, 226, 220))
    dr = ImageDraw.Draw(real)
    for l, w in zip(road_lines, road_w):
        if l.intersects(area):
            dr.line(to(l.coords), fill=(90, 90, 96), width=max(1, int(w / px)))
    for p in buildings:
        if p.intersects(area):
            g = p if p.geom_type == 'Polygon' else max(p.geoms, key=lambda q: q.area)
            cx, cz = g.representative_point().coords[0]
            r_, c_ = int((cz - Z0) / CELL), int((cx - X0) / CELL)
            h = float(ndsm[min(max(r_, 0), NZ - 1), min(max(c_, 0), NX - 1)])
            t = min(h / 80, 1)
            dr.polygon(to(g.exterior.coords), fill=(int(235 - 180 * t), int(215 - 160 * t), int(170 - 60 * t)), outline=(255, 255, 255))
    sheet = Image.new('RGB', (W * 2 + 10, Hh + 24), (255, 255, 255))
    sheet.paste(real, (0, 24)); sheet.paste(img, (W + 10, 24))
    ds = ImageDraw.Draw(sheet)
    ds.text((4, 6), 'Real: OSM footprints, darker = taller (LiDAR)', fill=(0, 0, 0))
    ds.text((W + 14, 6), 'Generated: real streets, lots split per district, graph WFC fill', fill=(0, 0, 0))
    sheet.save(f'{OUT}/{name}.png', optimize=True)
    used = Counter(fixed.values())
    print(f'wrote {name} {img.size}: {len(blocks)} blocks, {len(lots)} lots, {sum(corner)} corners, WFC attempts {attempts + 1}; {used.most_common()}')
    return colours, used


if __name__ == '__main__':
    AREAS = {
        'lots-kroad': box(-1150, 1350, -400, 1800),      # K Rd: main street on the ridge, villas and motorway south
        'lots-cbd': box(-750, 150, 0, 600),              # towers round Sky Tower down to Queen St
    }
    allcols = {}
    for n, a in AREAS.items():
        cols, used = render(a, n)
        allcols.update(cols)
    # Legend of tiles.
    items = sorted(allcols.items())
    leg = Image.new('RGB', (180, 18 * len(items) + 8), (255, 255, 255))
    d = ImageDraw.Draw(leg)
    for k, (n, c) in enumerate(items):
        d.rectangle((6, 6 + k * 18, 18, 18 + k * 18), fill=c); d.text((24, 6 + k * 18), n, fill=(0, 0, 0))
    leg.save(f'{OUT}/lots-legend.png')

    # For the 3D preview (preview.mjs): lots in one window, with their tile, storeys and the ground under them.
    PREVIEW = box(-700, 1330, 100, 1830)
    cache = os.path.join(ROOT, '.cache/worldgen-lab')
    T = np.load(f'{cache}/terrain.npz')
    random.seed(11)
    _, plots, pn, pc, pb, pd, ph = lots_for(PREVIEW, 'preview')
    pfix, _ = wfc(plots, pn, pc, pb, pd, ph)
    spec = {t[0]: t for ts in TILES.values() for t in ts}
    out = []
    for i, p in enumerate(plots):
        if not p.intersects(PREVIEW):
            continue
        p = p.intersection(PREVIEW)
        if p.geom_type != 'Polygon' or p.area < 20:
            continue
        name, _, (s0, s1), col = spec[pfix[i]]
        storeys = random.randint(s0, s1)
        if name == 'tower':
            storeys = max(storeys, min(int(ph[i] / 3.5), 50))
        x0, z0, x1, z1 = p.bounds
        win = T['plinths'][int((z0 - Z0) / CELL):int((z1 - Z0) / CELL) + 1, int((x0 - X0) / CELL):int((x1 - X0) / CELL) + 1]
        inset = p.buffer(-1.0 if name not in ('villa', 'bungalow', 'dairy') else -3.0)
        if inset.is_empty or inset.geom_type != 'Polygon':
            continue
        out.append(dict(kind=name, colour=col, storeys=storeys, base=float(np.median(win)), foot=float(win.min()),
                        pts=[[round(x, 2), round(z, 2)] for x, z in inset.exterior.coords[:-1]]))
    json.dump(dict(bounds=PREVIEW.bounds, lots=out), open(f'{cache}/lots.json', 'w'))
    print('preview lots', len(out))
