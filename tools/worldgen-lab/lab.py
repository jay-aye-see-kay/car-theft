"""Shared loading for the world-gen lab (exploration only, not the generator).

Reads the v1 input cache (.cache/citygen/<bbox>/: OSM API tiles, LiDAR DEM/DSM
windows), unpacked from the frozen snapshot's v1/citygen-cache-v1.tar.zst, and
puts everything on one local 2 m grid in the game's frame (origin Britomart,
x east, z south).
"""
import glob, json, math, os, xml.etree.ElementTree as ET
import numpy as np
from pyproj import Transformer

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
CACHE = glob.glob(os.path.join(ROOT, '.cache/citygen/174.7515_-36.8673_174.8013_-36.8383/'))[0]
OUT = os.path.join(ROOT, 'docs/worldgen')
os.makedirs(OUT, exist_ok=True)

_tm = Transformer.from_crs('EPSG:4326', 'EPSG:2193', always_xy=True)
E0, N0 = _tm.transform(174.768, -36.8443)

CELL = 2.0
X0, Z0, X1, Z1 = -1494.0, -624.0, 3006.0, 2626.0
NX, NZ = int((X1 - X0) / CELL), int((Z1 - Z0) / CELL)

DRIVE = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary',
         'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service'}
# Rough carriageway widths by class, m (the lab doesn't need OSM's lane tags).
WIDTH = {'motorway': 14, 'trunk': 12, 'primary': 12, 'secondary': 10, 'tertiary': 9, 'unclassified': 7,
         'residential': 7, 'living_street': 6, 'service': 5}
RANK = {'motorway': 6, 'trunk': 5, 'primary': 4, 'secondary': 3, 'tertiary': 2, 'unclassified': 1,
        'residential': 1, 'living_street': 0, 'service': 0}


def to_local(lon, lat):
    e, n = _tm.transform(lon, lat)
    return e - E0, -(n - N0)


def cls(hw):
    return hw.replace('_link', '')


def load_osm():
    nodes, ways, rels = {}, {}, []
    for f in sorted(glob.glob(CACHE + 'osm/*.osm')):
        for el in ET.parse(f).getroot():
            if el.tag == 'node':
                nodes[el.get('id')] = (float(el.get('lon')), float(el.get('lat')))
            elif el.tag == 'way':
                ways[el.get('id')] = ([nd.get('ref') for nd in el.findall('nd')],
                                      {t.get('k'): t.get('v') for t in el.findall('tag')})
            elif el.tag == 'relation':
                rels.append(({t.get('k'): t.get('v') for t in el.findall('tag')},
                             [(m.get('type'), m.get('ref'), m.get('role')) for m in el.findall('member')]))
    ids = list(nodes)
    lon = np.array([nodes[i][0] for i in ids]); lat = np.array([nodes[i][1] for i in ids])
    e, n = _tm.transform(lon, lat)
    xy = {i: (float(a - E0), float(-(b - N0))) for i, a, b in zip(ids, e, n)}
    return xy, ways, rels


def load_raster(kind='dem'):
    """The LiDAR raster resampled (2x2 mean) onto the local 2 m grid."""
    m = json.load(open(CACHE + f'{kind}.json'))
    a = np.fromfile(CACHE + f'{kind}.f32', dtype='<f4').reshape(m['height'], m['width'])
    # Local cell (r, c) covers x in [X0 + 2c, +2), z in [Z0 + 2r, +2) -> NZTM e, n.
    c0 = int(round(X0 + E0 - m['west']))
    r0 = int(round(m['north'] - (N0 - Z0)))
    out = np.full((NZ, NX), np.nan, np.float32)
    sub = a[max(r0, 0):r0 + 2 * NZ, max(c0, 0):c0 + 2 * NX]
    h, w = sub.shape[0] // 2, sub.shape[1] // 2
    blk = sub[:2 * h, :2 * w].reshape(h, 2, w, 2).mean(axis=(1, 3))
    out[max(-r0, 0) // 2:max(-r0, 0) // 2 + h, max(-c0, 0) // 2:max(-c0, 0) // 2 + w] = blk
    return out


def cell_of(x, z):
    return (z - Z0) / CELL, (x - X0) / CELL


def hillshade(h, az=315, alt=40, z=2.0):
    gy, gx = np.gradient(h * z, CELL)
    slope = np.pi / 2 - np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    a, b = math.radians(az), math.radians(alt)
    s = np.sin(b) * np.sin(slope) + np.cos(b) * np.cos(slope) * np.cos(a - aspect)
    return np.clip(s, 0, 1)
