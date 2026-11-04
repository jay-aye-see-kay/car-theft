"""Exports the whole lab city for the fly-around viewer (lab.html, src/lab/).

Reads terrain_lab.py's outputs (.cache/worldgen-lab/) and runs the district,
lot and WFC stages (districts_lab.py) over the whole map, then writes
public/lab/:
  meta.json      grid, landmarks, start view
  ground.bin     designed ground, 4 m grid, u16 cm above -10 m (roads sit a little below their strips)
  deck.bin       bridge deck heights on the same grid (0 = none), for walking
  ground.png     ground colours, 2 m per pixel
  roads.json     road strips: per way, samples [x, z, outer-left, left, right, outer-right heights]
  decks.json     bridge decks (the kit is built in the browser)
  lots.json      generated buildings: footprint, foot, base, top, tile
  real.json      the real OSM footprints at LiDAR heights, for comparison
  python3 tools/worldgen-lab/export_world.py   (after terrain_lab.py)
"""
import json, math, os, random, sys
from collections import defaultdict
import numpy as np
from PIL import Image
import shapely
from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union
sys.path.insert(0, os.path.dirname(__file__))
import districts_lab as DL
from lab import *

DEST = os.path.join(ROOT, 'public/lab'); os.makedirs(DEST, exist_ok=True)
cache = os.path.join(ROOT, '.cache/worldgen-lab')
T = np.load(f'{cache}/terrain.npz')
eased, land, carriage, footpath = T['eased'], T['land'], T['carriage'], T['footpath']
deck_h = np.load(f'{cache}/deck_h.npy')
edges = json.load(open(f'{cache}/edges.json'))


def bil(f, x, z):
    r, c = cell_of(x, z)
    r = min(max(r - 0.5, 0), NZ - 1.001); c = min(max(c - 0.5, 0), NX - 1.001)
    r0, c0 = int(r), int(c); u, v = c - c0, r - r0
    return float((f[r0, c0] * (1 - u) + f[r0, c0 + 1] * u) * (1 - v) + (f[r0 + 1, c0] * (1 - u) + f[r0 + 1, c0 + 1] * u) * v)


# Ground, 4 m: block means, but the lowest sample where there's road, so strips always sit on top.
g = np.where(land, eased, -4.0)
E = (NZ // 2) * 2  # NZ is odd: drop the last row
blk = g[:E].reshape(NZ // 2, 2, NX // 2, 2)
paved = (carriage | footpath)[:E].reshape(NZ // 2, 2, NX // 2, 2).any(axis=(1, 3))
g4 = np.where(paved, blk.min(axis=(1, 3)) - 0.08, blk.mean(axis=(1, 3)))
# Sample at the 4 m cell corners' positions as vertices: vertex (r, c) at x = X0 + 4c + 2, z = Z0 + 4r + 2.
np.clip((g4 + 10) * 100, 0, 65535).astype('<u2').tofile(f'{DEST}/ground.bin')
d4 = np.nan_to_num(deck_h, nan=-10)[:E].reshape(NZ // 2, 2, NX // 2, 2).max(axis=(1, 3))
np.clip((d4 + 10) * 100, 0, 65535).astype('<u2').tofile(f'{DEST}/deck.bin')

# Ground colours by district, with parks green and paving pale.
dist2 = np.kron(DL.cls_, np.ones((25, 25), np.int8))[:NZ, :NX]
pad = np.zeros((NZ, NX), np.int8); pad[:dist2.shape[0], :dist2.shape[1]] = dist2
BASE = {'sea': (60, 100, 130), 'park': (112, 150, 82), 'port': (150, 148, 140), 'towers': (168, 162, 150),
        'midrise': (160, 156, 140), 'mainstreet': (150, 150, 120), 'villas': (118, 146, 86)}
pal = np.array([BASE[n] for n in DL.NAMES], np.float32)
col = pal[pad]
gcov, _ = DL.cover(DL.greens)
col = np.where(gcov[..., None] > 0.5, np.array([104, 148, 78], np.float32), col)
rng = np.random.default_rng(3)

col = np.where(footpath[..., None], np.array([186, 182, 172], np.float32), col)
col = np.where(carriage[..., None], np.array([70, 70, 74], np.float32), col)
col = np.where(land[..., None], col, np.array([44, 84, 110], np.float32))
Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)).save(f'{DEST}/ground.png', optimize=True)

# Road strips, sampled every 3 m from the designed ground (so junction plates tilt, ways stay level).
roads = []
for e in edges:
    if e['bridge']:
        continue
    pts = np.array(e['pts'])
    seg = np.hypot(*np.diff(pts, axis=0).T)
    L = float(seg.sum())
    if L < 1:
        continue
    n = max(1, int(math.ceil(L / 3)))
    cum = np.concatenate([[0], np.cumsum(seg)])
    s = np.linspace(0, L, n + 1)
    xs, zs = np.interp(s, cum, pts[:, 0]), np.interp(s, cum, pts[:, 1])
    half = e['width'] / 2
    fp = 0 if e['cls'] == 'service' else 3.0
    out = []
    for i in range(n + 1):
        a, b = max(i - 1, 0), min(i + 1, n)
        dx, dz = xs[b] - xs[a], zs[b] - zs[a]
        l = math.hypot(dx, dz) or 1
        nx, nz = -dz / l, dx / l
        hs = [bil(eased, xs[i] + nx * o, zs[i] + nz * o) for o in (-(half + fp), -half, half, half + fp)]
        out += [round(xs[i], 2), round(zs[i], 2)] + [round(h, 2) for h in hs]
    roads.append(dict(w=half, f=fp, c=e['cls'], p=out))
json.dump(roads, open(f'{DEST}/roads.json', 'w'), separators=(',', ':'))
decks = json.load(open(f'{cache}/decks.json'))
json.dump(decks, open(f'{DEST}/decks.json', 'w'), separators=(',', ':'))

# Generated buildings over the whole map, WFC block by block (blocks never neighbour across a street).
SKY = to_local(174.76225, -36.84846)
random.seed(5)
area = box(X0 + 4, Z0 + 4, X1 - 4, Z1 - 4)
blocks, lots, nbrs, corner, block_of, district, real_h = DL.lots_for(area, 'all')
print(f'{len(blocks)} blocks, {len(lots)} lots')
by_block = defaultdict(list)
for i, b in enumerate(block_of):
    by_block[b].append(i)
fixed = {}
for b, ids in by_block.items():
    loc = {g: k for k, g in enumerate(ids)}
    f, _ = DL.wfc([lots[i] for i in ids], [{loc[j] for j in nbrs[i] if j in loc} for i in ids],
                  [corner[i] for i in ids], [0] * len(ids), [district[i] for i in ids], [real_h[i] for i in ids])
    for k, name in f.items():
        fixed[ids[k]] = name
spec = {t[0]: t for ts in DL.TILES.values() for t in ts}
KINDS = sorted(spec)
xs_ = (np.arange(NX) * CELL + X0 + CELL / 2); zs_ = (np.arange(NZ) * CELL + Z0 + CELL / 2)


def under(p, f):
    """Values of raster f inside polygon p (cell centres), or its bbox window if it's tiny."""
    x0, z0, x1, z1 = p.bounds
    c0, c1 = max(int((x0 - X0) / CELL), 0), min(int((x1 - X0) / CELL) + 1, NX)
    r0, r1 = max(int((z0 - Z0) / CELL), 0), min(int((z1 - Z0) / CELL) + 1, NZ)
    win = f[r0:r1, c0:c1]
    if win.size == 0:
        return np.array([0.0])
    X, Z = np.meshgrid(xs_[c0:c1], zs_[r0:r1])
    m = shapely.contains_xy(p, X, Z)
    return win[m] if m.any() else win.ravel()


# Nothing generated hard against a bridge: the deck is in the air, the lot would be down in the gully.
near_decks = unary_union([LineString([(q[0], q[2]) for q in d['pts']]).buffer(d['width'] / 2 + 10) for d in decks])
out = []
for i, p in enumerate(lots):
    name, _, (s0, s1), _c = spec[fixed[i]]
    if p.distance(shapely.Point(*SKY)) < 22:
        continue  # the Sky Tower's lot
    storeys = random.randint(s0, s1)
    if name == 'tower':
        storeys = max(storeys, min(int(real_h[i] / 3.4), 55))
    inset = p.buffer(-3.0 if name in ('villa', 'bungalow') else -0.6 if storeys else -0.2, join_style='mitre')
    if inset.is_empty:
        continue
    inset = max(getattr(inset, 'geoms', [inset]), key=lambda q: q.area).simplify(0.3)
    if inset.area < 12 or inset.intersects(near_decks):
        continue
    h = under(inset, eased)
    base, foot = float(np.median(h)), float(h.min())
    top = base + (storeys * 3.4 if storeys else 0.25)
    pts = [v for xy_ in inset.exterior.coords[:-1] for v in (round(xy_[0], 2), round(xy_[1], 2))]
    out.append([KINDS.index(name), round(foot - 0.3, 2), round(base, 2), round(top, 2), pts])
print('generated buildings', len(out))
json.dump(dict(kinds=KINDS, colours=[spec[k][3] for k in KINDS], lots=out), open(f'{DEST}/lots.json', 'w'), separators=(',', ':'))

# The real footprints, at LiDAR heights, on the designed ground.
real = []
for p in DL.buildings:
    p = max(getattr(p, 'geoms', [p]), key=lambda q: q.area)
    if p.area < 15 or not area.contains(p.centroid) or p.distance(shapely.Point(*SKY)) < 12:
        continue
    q = p.simplify(0.4)
    hh = under(q, DL.ndsm)
    top_h = float(np.percentile(hh, 85))
    if top_h < 2.5:
        top_h = 3.0
    h = under(q, eased)
    base, foot = float(np.median(h)), float(h.min())
    real.append([round(foot - 0.3, 2), round(base + top_h, 2),
                 [v for xy_ in q.exterior.coords[:-1] for v in (round(xy_[0], 2), round(xy_[1], 2))]])
print('real buildings', len(real))
json.dump(real, open(f'{DEST}/real.json', 'w'), separators=(',', ':'))

json.dump(dict(x0=X0 + 2, z0=Z0 + 2, cell=4, nx=NX // 2, nz=NZ // 2, texX0=X0, texZ0=Z0, texCell=CELL,
               skyTower=dict(x=round(SKY[0], 1), z=round(SKY[1], 1), y=round(bil(eased, *SKY), 1)),
               start=dict(x=-240, y=140, z=-160, yaw=-2.6, pitch=-0.35)),
          open(f'{DEST}/meta.json', 'w'), indent=1)
for f in sorted(os.listdir(DEST)):
    print(f'{f:12s} {os.path.getsize(f"{DEST}/{f}") / 1e6:6.2f} MB')
