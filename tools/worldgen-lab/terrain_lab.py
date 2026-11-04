"""Roads first, ground second: a prototype of designed terrain (exploration).

Instead of draping roads on the LiDAR, the road network is *designed* and the
ground is built around it:

  1. Macro relief: the bare-earth DEM, heavily smoothed (sigma MACRO m), so only
     the shape of the land survives (ridges, gullies, the Queen St valley).
  2. Road profiles: every road-graph vertex (junctions, plus one every STEP m
     along each way) gets a height from one sparse least-squares solve:
     stay near the macro relief, vertical curves smooth (second differences),
     junctions are tilted planes the arms leave tangentially. Bridges get no
     ground term at all, so they span straight between their abutments.
     Then grade is clamped to GRADE_MAX by relaxation.
  3. Road surface: zero cross-slope along each way (a level cross-section),
     junction plates are planes, blended into the arms over RUNOFF m.
  4. Ground: either (A) eased from the nearest road over a verge (a smooth
     "beard" like Minecraft's terrain adapting to structures), or (B) terraces:
     each city block is a few level platforms with retaining walls.

Writes docs/worldgen/terrain-*.png and prints numbers.
  python3 tools/worldgen-lab/terrain_lab.py
"""
import math, sys
from collections import defaultdict
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage, sparse
from scipy.sparse.linalg import lsqr
from lab import *

MACRO = 22.0       # m, sigma of the relief kept from the LiDAR
STEP = 8.0         # m between profile vertices
GRADE_MAX = 0.12   # steepest road
ROAD_SIGMA = 4.0   # m, roads aim for the LiDAR under them (lightly smoothed), not the macro relief
LOT = 18.0         # m, option B: frontage per plinth
FOOTPATH = 3.0
RUNOFF = 10.0      # m over which a junction's tilt blends into level arms
VERGE = 14.0       # m, option A: distance over which ground eases to the macro relief
TERRACE = 2.5      # m, option B: step between terraces in a block

xy, ways, rels = load_osm()
dem = load_raster('dem')
land = dem > 0.2
print(f'grid {NX}x{NZ} at {CELL} m, land {land.mean():.0%}')

# 1. Macro relief: normalised convolution over land only, so the sea doesn't drag the coast down.
s = MACRO / CELL
num = ndimage.gaussian_filter(np.where(land, dem, 0), s)
den = ndimage.gaussian_filter(land.astype(np.float32), s)
macro = np.where(den > 0.05, num / np.maximum(den, 1e-6), 0)


def sample(f, x, z):
    r, c = cell_of(x, z)
    r = min(max(r - 0.5, 0), NZ - 1.001); c = min(max(c - 0.5, 0), NX - 1.001)
    r0, c0 = int(r), int(c); u, v = c - c0, r - r0
    return (f[r0, c0] * (1 - u) + f[r0, c0 + 1] * u) * (1 - v) + (f[r0 + 1, c0] * (1 - u) + f[r0 + 1, c0 + 1] * u) * v


# 2. The graph: driveable ways split at shared nodes.
road_ways = []
for wid, (refs, t) in ways.items():
    hw = t.get('highway')
    if hw not in DRIVE or t.get('area') == 'yes' or t.get('tunnel') in ('yes', 'building_passage'):
        continue
    if t.get('service') in ('parking_aisle', 'driveway', 'drive-through'):
        continue
    refs = [r for r in refs if r in xy]
    if len(refs) >= 2:
        road_ways.append((wid, refs, t))
use = defaultdict(int)
for _, refs, _ in road_ways:
    for k, r in enumerate(refs):
        use[r] += 2 if k in (0, len(refs) - 1) else 1
junction = {r for r, n in use.items() if n >= 2}

verts = []          # (x, z)
vid = {}            # osm node id -> vertex index (junctions and way ends only)
edges = []          # dict(chain=[vertex...], cls, width, bridge)


def vertex(x, z):
    verts.append((x, z)); return len(verts) - 1


for wid, refs, t in road_ways:
    c = cls(t['highway'])
    w = WIDTH.get(c, 7)
    bridge = t.get('bridge') not in (None, 'no')
    start = 0
    for k in range(1, len(refs)):
        if refs[k] in junction or k == len(refs) - 1:
            pts = [xy[r] for r in refs[start:k + 1]]
            a = vid.setdefault(refs[start], vertex(*pts[0]))
            b = vid.setdefault(refs[k], vertex(*pts[-1]))
            if a == b and len(pts) < 3:
                start = k; continue
            # Resample the polyline every ~STEP m (interior vertices are new).
            seg = np.hypot(np.diff([p[0] for p in pts]), np.diff([p[1] for p in pts]))
            L = float(seg.sum())
            n = max(1, int(round(L / STEP)))
            cum = np.concatenate([[0], np.cumsum(seg)])
            px = np.interp(np.linspace(0, L, n + 1), cum, [p[0] for p in pts])
            pz = np.interp(np.linspace(0, L, n + 1), cum, [p[1] for p in pts])
            chain = [a] + [vertex(px[i], pz[i]) for i in range(1, n)] + [b]
            edges.append(dict(chain=chain, cls=c, width=w, bridge=bridge, rank=RANK.get(c, 0), way=wid,
                              poly=list(zip(px, pz))))
            start = k
V = np.array(verts)
nV = len(V)
bridge_v = np.zeros(nV, bool)
for e in edges:
    if e['bridge']:
        bridge_v[e['chain'][1:-1]] = True
# Bridge ends that touch only bridges are on the deck too.
touch = defaultdict(set)
for e in edges:
    for v in (e['chain'][0], e['chain'][-1]):
        touch[v].add(e['bridge'])
for v, kinds in touch.items():
    if kinds == {True}:
        bridge_v[v] = True
arms = defaultdict(list)    # junction vertex -> [(next vertex, edge)]
for e in edges:
    ch = e['chain']
    arms[ch[0]].append((ch[1], e)); arms[ch[-1]].append((ch[-2], e))
J = [v for v, a in arms.items() if len(a) >= 3]
print(f'{len(edges)} edges, {nV} profile vertices, {len(J)} junctions, {int(bridge_v.sum())} on bridges')

# 3. One sparse least-squares solve for every vertex height plus each junction's tilt (gx, gz).
jcol = {v: nV + 2 * k for k, v in enumerate(J)}
nvar = nV + 2 * len(J)
rows, cols, vals, rhs = [], [], [], []


def eq(terms, b, w):
    r = len(rhs)
    for c, a in terms:
        rows.append(r); cols.append(c); vals.append(a * w)
    rhs.append(b * w)


# Roads aim for the bare earth under them (the LiDAR measures roads well: they're
# where the ground is cleared); the solve then evens them out. Off-road ground uses the macro relief.
road_ground = ndimage.gaussian_filter(np.where(land, dem, macro), ROAD_SIGMA / CELL)
target = np.array([sample(road_ground, x, z) for x, z in V])
for v in range(nV):
    # Stay near the land (decks barely: only so a deck that touches no road still has a height).
    eq([(v, 1)], target[v], 0.002 if bridge_v[v] else 1.0)
for e in edges:
    ch = e['chain']
    for i in range(1, len(ch) - 1):                         # vertical curves
        eq([(ch[i - 1], 1), (ch[i], -2), (ch[i + 1], 1)], 0, 6.0 if e['bridge'] else 2.0)
for j in J:
    gx, gz = jcol[j], jcol[j] + 1
    x0, z0 = V[j]
    for nb, e in arms[j]:                                   # arms leave the plate on its plane
        dx, dz = V[nb] - V[j]
        eq([(nb, 1), (j, -1), (gx, -dx), (gz, -dz)], 0, 3.0)
    eq([(gx, 1)], 0, 8.0); eq([(gz, 1)], 0, 8.0)            # prefer level junctions
base = (rows[:], cols[:], vals[:], rhs[:])
pairs = [(e['chain'][i], e['chain'][i + 1]) for e in edges for i in range(len(e['chain']) - 1)]
P = np.array(pairs)
dist = np.hypot(*(V[P[:, 0]] - V[P[:, 1]]).T)
# Grade cap by active set: solve, pin each too-steep step at the cap (a stiff
# equation), solve again, until none are over. The ground term stays in every
# solve, so capping a steep street can't drag its whole neighbourhood away.
active = {}
from scipy.sparse.linalg import spsolve
for it in range(25):
    rows[:], cols[:], vals[:], rhs[:] = (list(x) for x in base)   # last round's caps go
    for k, sgn in active.items():
        a_, b_ = P[k]
        eq([(b_, 1), (a_, -1)], sgn * GRADE_MAX * dist[k], 20.0)
    A = sparse.csr_matrix((vals, (rows, cols)), shape=(len(rhs), nvar))
    sol = spsolve((A.T @ A).tocsc(), A.T @ np.array(rhs))
    H = sol[:nV].copy()
    d = H[P[:, 1]] - H[P[:, 0]]
    over = np.flatnonzero(np.abs(d) > GRADE_MAX * dist * 1.02 + 0.02)
    new = [k for k in over if k not in active]
    if not new:
        break
    for k in new:
        active[k] = float(np.sign(d[k]))
G = {j: (sol[jcol[j]], sol[jcol[j] + 1]) for j in J}
grade = np.abs(H[P[:, 1]] - H[P[:, 0]]) / np.maximum(dist, 0.1)
print(f'grade cap: {it + 1} solves, {len(active)} steps capped; max {grade.max():.1%}, p95 {np.percentile(grade, 95):.1%}; '
      f'|road - macro| p50 {np.median(np.abs(H - target)[~bridge_v]):.2f} m, p99 {np.percentile(np.abs(H - target)[~bridge_v], 99):.2f} m')

# 4. Rasterise the road surface: level cross-sections, highest rank wins; junction plates over them.
road_h = np.full((NZ, NX), np.nan, np.float32)
road_rank = np.full((NZ, NX), -1, np.int8)
road_d = np.full((NZ, NX), np.inf, np.float32)
road_e = np.full((NZ, NX), -1, np.int32)
road_s = np.zeros((NZ, NX), np.float32)
road_side = np.zeros((NZ, NX), np.int8)
carriage = np.zeros((NZ, NX), bool)
deck = np.zeros((NZ, NX), bool)
deck_h = np.full((NZ, NX), np.nan, np.float32)
gr = np.arange(NZ)[:, None] * CELL + Z0 + CELL / 2
gc = np.arange(NX)[None, :] * CELL + X0 + CELL / 2


def paint_segment(a, b, ha, hb, half, rank, is_bridge, ei=-1, s0=0.0):
    (ax, az), (bx, bz) = a, b
    pad = half + 1
    c0 = max(int((min(ax, bx) - pad - X0) / CELL), 0); c1 = min(int((max(ax, bx) + pad - X0) / CELL) + 1, NX)
    r0 = max(int((min(az, bz) - pad - Z0) / CELL), 0); r1 = min(int((max(az, bz) + pad - Z0) / CELL) + 1, NZ)
    if c0 >= c1 or r0 >= r1:
        return
    X = gc[:, c0:c1]; Z = gr[r0:r1, :]
    dx, dz = bx - ax, bz - az
    L2 = dx * dx + dz * dz or 1e-9
    t = np.clip(((X - ax) * dx + (Z - az) * dz) / L2, 0, 1)
    d = np.hypot(X - (ax + t * dx), Z - (az + t * dz))
    if is_bridge:
        on = d <= half + FOOTPATH
        deck[r0:r1, c0:c1] |= d <= half
        deck_h[r0:r1, c0:c1][on] = (ha + (hb - ha) * t)[on]
        return
    h = ha + (hb - ha) * t
    win = (d <= half + FOOTPATH) & ((rank > road_rank[r0:r1, c0:c1]) | ((rank == road_rank[r0:r1, c0:c1]) & (d < road_d[r0:r1, c0:c1])))
    road_h[r0:r1, c0:c1][win] = h[win]
    road_rank[r0:r1, c0:c1][win] = rank
    road_d[r0:r1, c0:c1][win] = d[win]
    road_e[r0:r1, c0:c1][win] = ei
    road_s[r0:r1, c0:c1][win] = (s0 + t * math.sqrt(L2))[win]
    road_side[r0:r1, c0:c1][win] = np.sign((X - ax) * dz - (Z - az) * dx)[win]
    carriage[r0:r1, c0:c1] |= d <= half


for ei, e in sorted(enumerate(edges), key=lambda p: p[1]['rank']):
    ch = e['chain']; s0 = 0.0
    e['s'] = [0.0]
    for i in range(len(ch) - 1):
        paint_segment(V[ch[i]], V[ch[i + 1]], H[ch[i]], H[ch[i + 1]], e['width'] / 2, e['rank'], e['bridge'], ei, s0)
        s0 += float(np.hypot(*(V[ch[i + 1]] - V[ch[i]]))); e['s'].append(s0)

# Junction plates: the plane, full strength within the plate, fading over RUNOFF.
blend_w = np.zeros((NZ, NX), np.float32); blend_h = np.zeros((NZ, NX), np.float32)
for j in J:
    if bridge_v[j]:
        continue
    x0, z0 = V[j]
    rad = max(e['width'] for _, e in arms[j]) / 2 + FOOTPATH
    R = rad + RUNOFF
    c0 = max(int((x0 - R - X0) / CELL), 0); c1 = min(int((x0 + R - X0) / CELL) + 1, NX)
    r0 = max(int((z0 - R - Z0) / CELL), 0); r1 = min(int((z0 + R - Z0) / CELL) + 1, NZ)
    X = gc[:, c0:c1]; Z = gr[r0:r1, :]
    d = np.hypot(X - x0, Z - z0)
    w = np.clip(1 - (d - rad) / RUNOFF, 0, 1)
    w = w * w * (3 - 2 * w)
    gx, gz = G[j]
    plane = H[j] + gx * (X - x0) + gz * (Z - z0)
    blend_w[r0:r1, c0:c1] += w; blend_h[r0:r1, c0:c1] += w * plane
onroad = ~np.isnan(road_h)
wsum = np.clip(blend_w, 0, 1)
road_h = np.where(onroad & (blend_w > 0), road_h * (1 - wsum) + (blend_h / np.maximum(blend_w, 1e-6)) * wsum, road_h)

# 5a. Ground eased from the nearest road over a verge.
dist_px, (ir, ic) = ndimage.distance_transform_edt(~onroad, return_indices=True)
near_h = road_h[ir, ic]
dd = dist_px * CELL
k = np.clip(dd / VERGE, 0, 1); k = k * k * (3 - 2 * k)
ground_a = np.where(onroad, road_h, near_h + (macro - near_h) * k)

# 5b. Plinths: every LOT m of frontage, each side of each street, is a level
# platform at the kerb height of its middle, out to the back of the lot, so
# buildings stand level and steep streets read as stepped shopfronts.
ne, ns, nside = road_e[ir, ic], road_s[ir, ic], road_side[ir, ic]
lot_mid = (np.floor(ns / LOT) + 0.5) * LOT
lot_h = np.zeros((NZ, NX), np.float32)
for ei, e in enumerate(edges):
    m = ne == ei
    if not m.any() or e['bridge']:
        continue
    lot_h[m] = np.interp(lot_mid[m], e['s'], H[e['chain']])
lot_key = (ne.astype(np.int64) * 4096 + np.floor(ns / LOT).astype(np.int64)) * 3 + nside + 1
inlot = ~onroad & land & (dd <= 40) & (ne >= 0)
k2 = np.clip((dd - FOOTPATH) / 1.0, 0, 1)
ground_b = np.where(onroad, road_h, np.where(inlot, near_h + (lot_h + 0.15 - near_h) * k2, ground_a))
# Retaining walls: where two lots meet with a step (not where eased ground is merely steep).
walls = np.zeros((NZ, NX), bool)
key = np.where(inlot, lot_key, -1)
for sl_a, sl_b in (((slice(1, None), slice(None)), (slice(None, -1), slice(None))),
                   ((slice(None), slice(1, None)), (slice(None), slice(None, -1)))):
    step = (key[sl_a] != key[sl_b]) & (key[sl_a] >= 0) & (np.abs(ground_b[sl_a] - ground_b[sl_b]) > 0.5)
    walls[sl_a] |= step
plate_tilt = np.array([math.hypot(*G[j]) for j in J if not bridge_v[j]])
print(f'junction plate tilt: p50 {np.median(plate_tilt):.1%}  p90 {np.percentile(plate_tilt, 90):.1%}  max {plate_tilt.max():.1%}')

# Numbers: cross-slope of the drivable surface across each carriageway.
def cross_stats(surf, own=False):
    out = []
    for e in edges:
        if e['bridge']:
            continue
        ch = e['chain']; half = e['width'] / 2 - 0.5
        for i in range(len(ch) - 1):
            (ax, az), (bx, bz) = V[ch[i]], V[ch[i + 1]]
            L = math.hypot(bx - ax, bz - az)
            if L < 1:
                continue
            ux, uz = (bx - ax) / L, (bz - az) / L
            mx, mz = (ax + bx) / 2, (az + bz) / 2
            l = sample(surf, mx - uz * half, mz + ux * half); r = sample(surf, mx + uz * half, mz - ux * half)
            if own:
                ok = True
                for px_, pz_ in ((mx - uz * half, mz + ux * half), (mx + uz * half, mz - ux * half)):
                    rr, cc = cell_of(px_, pz_); rr, cc = int(rr), int(cc)
                    if not (0 <= rr < NZ and 0 <= cc < NX) or road_e[rr, cc] != e['i'] or blend_w[rr, cc] > 0:
                        ok = False
                if not ok:
                    continue
            out.append(abs(l - r) / (2 * half))
    return np.array(out)


raw_cross = cross_stats(np.where(land, dem, 0).astype(np.float32))
for i_, e_ in enumerate(edges): e_['i'] = i_
new_cross = cross_stats(ground_a.astype(np.float32), own=True)
for name, cs in (('LiDAR DEM', raw_cross), ('designed', new_cross)):
    print(f'cross-slope {name:10s}: p50 {np.median(cs):.1%}  p90 {np.percentile(cs, 90):.1%}  p99 {np.percentile(cs, 99):.1%}  >6%: {(cs > .06).mean():.1%}')

# Pictures.
SEA = np.array([70, 110, 140], float)


def shade(h, tint=None, walls_=None, roads=True, decks=True):
    hs = hillshade(h)
    lo, hi = 0, 90
    t = np.clip((h - lo) / (hi - lo), 0, 1)[..., None]
    col = (1 - t) * np.array([196, 214, 168]) + t * np.array([214, 190, 150])
    if tint is not None:
        col = tint
    img = col * (0.35 + 0.75 * hs[..., None])
    if roads:
        img = np.where(carriage[..., None], img * 0.55 + np.array([60, 60, 66]) * 0.45, img)
    if walls_ is not None:
        img = np.where(walls_[..., None], np.array([120, 60, 40]), img)
    img = np.where(land[..., None], img, SEA * (0.8 + 0.2 * hs[..., None]))
    if decks:
        img = np.where(deck[..., None], np.array([235, 120, 40]), img)
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))


TILES = os.path.join(ROOT, '.cache/worldgen-lab'); os.makedirs(TILES, exist_ok=True)


def save(img, name, crop=None, scale=1.0):
    if crop:
        (x0, z0, x1, z1) = crop
        img = img.crop((int((x0 - X0) / CELL), int((z0 - Z0) / CELL), int((x1 - X0) / CELL), int((z1 - Z0) / CELL)))
    if scale != 1:
        img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
    img.save(f'{TILES}/{name}.png')


raw = np.where(land, dem, 0).astype(np.float32)
imgs = {'lidar': shade(raw), 'eased': shade(ground_a), 'terraced': shade(ground_b, walls_=walls)}
# Grade map of the designed roads.
CROPS = {
    'grafton': (-560, 1250, 240, 1850),   # Grafton gully, the bridge, Symonds St
    'queen': (-760, 250, 40, 850),        # Queen St valley up to K Rd
}
for k, im in imgs.items():
    for c, box in CROPS.items():
        save(im, f'terrain-{k}-{c}', crop=box)

# Side by side for the doc: LiDAR | eased | terraced, one crop.
for c, box in CROPS.items():
    tiles = [Image.open(f'{TILES}/terrain-{k}-{c}.png') for k in ('lidar', 'eased', 'terraced')]
    w, h = tiles[0].size
    sheet = Image.new('RGB', (w * 3 + 20, h + 28), (255, 255, 255))
    d = ImageDraw.Draw(sheet)
    for i, (t, lab) in enumerate(zip(tiles, ('LiDAR as is', 'A: eased verges', 'B: level plinth per lot'))):
        sheet.paste(t, (i * (w + 10), 28)); d.text((i * (w + 10) + 6, 8), lab, fill=(0, 0, 0))
    sheet.save(f'{OUT}/terrain-compare-{c}.png', optimize=True)
    print('wrote', f'terrain-compare-{c}', sheet.size)

# For the 3D preview (preview.mjs) and districts_lab.py: the ground, masks and bridge decks.
cache = TILES
np.savez_compressed(f'{cache}/terrain.npz', eased=ground_a.astype(np.float32), plinths=ground_b.astype(np.float32),
                    carriage=carriage, deck=deck, walls=walls, land=land, footpath=onroad & ~carriage)
decks = []
for e in edges:
    if e['bridge']:
        ch = e['chain']
        decks.append(dict(width=e['width'], pts=[[round(float(V[v][0]), 2), round(float(H[v]), 2), round(float(V[v][1]), 2)] for v in ch]))
json.dump(decks, open(f'{cache}/decks.json', 'w'))
np.save(f'{cache}/deck_h.npy', deck_h)
json.dump([dict(width=e['width'], bridge=e['bridge'], cls=e['cls'], pts=[[float(V[v][0]), float(V[v][1])] for v in e['chain']])
           for e in edges], open(f'{cache}/edges.json', 'w'))
print('saved', cache)
