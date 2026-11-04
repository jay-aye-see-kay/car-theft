// A quick 3D look at a lab slice: designed terrain (level roads, lot plinths),
// kit-built bridge decks (footpaths, parapets, piers) and the WFC lots
// extruded. Plain three.js in headless Chromium; nothing here is game code.
//   node tools/worldgen-lab/preview.mjs   (after terrain_lab.py and districts_lab.py)
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CACHE = ROOT + '.cache/worldgen-lab/';
const OUT = ROOT + 'docs/worldgen/';
const X0 = -1494, Z0 = -624, CELL = 2, NX = 2250;

// numpy .npz is a zip of .npy files; read the few arrays we need.
function npz(file) {
  const buf = readFileSync(file);
  const out = {};
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    let csize = buf.readUInt32LE(p + 18);
    const nlen = buf.readUInt16LE(p + 26), xlen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 30, p + 30 + nlen);
    let start = p + 30 + nlen + xlen;
    if (csize === 0xffffffff) csize = Number(buf.readBigUInt64LE(p + 30 + nlen + 4 + 8));
    const raw = method === 8 ? inflateRawSync(buf.subarray(start, start + csize)) : buf.subarray(start, start + csize);
    const hl = raw.readUInt16LE(8);
    const header = raw.toString('latin1', 10, 10 + hl);
    const shape = header.match(/\((\d+), (\d+)\)/).slice(1).map(Number);
    const data = raw.subarray(10 + hl);
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    out[name.replace('.npy', '')] = { shape, data: header.includes("'<f4'") ? new Float32Array(ab) : new Uint8Array(ab) };
    p = start + csize;
  }
  return out;
}

const T = npz(CACHE + 'terrain.npz');
const lots = JSON.parse(readFileSync(CACHE + 'lots.json', 'utf8'));
const decks = JSON.parse(readFileSync(CACHE + 'decks.json', 'utf8'));
const [bx0, bz0, bx1, bz1] = lots.bounds;
const c0 = Math.floor((bx0 - X0) / CELL), c1 = Math.ceil((bx1 - X0) / CELL);
const r0 = Math.floor((bz0 - Z0) / CELL), r1 = Math.ceil((bz1 - Z0) / CELL);
const w = c1 - c0, h = r1 - r0;
const heights = [], kinds = [];
for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
  const k = r * NX + c;
  heights.push(Math.round(T.eased.data[k] * 100) / 100);
  kinds.push(T.deck.data[k] ? 4 : T.carriage.data[k] ? 1 : T.footpath.data[k] ? 2 : T.land.data[k] ? 0 : 5);
}
const inBox = (d) => d.pts.some(([x, , z]) => x > bx0 && x < bx1 && z > bz0 && z < bz1);
const scene = { x0: X0 + c0 * CELL + 1, z0: Z0 + r0 * CELL + 1, w, h, cell: CELL, heights, kinds, lots: lots.lots, decks: decks.filter(inBox) };

const page = `<!doctype html><body style="margin:0"><script type="importmap">{"imports":{"three":"http://lab/three.js"}}</script>
<script type="module">
import * as THREE from 'three';
const S = await (await fetch('http://lab/scene.json')).json();
const R = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
R.setSize(1600, 900); R.shadowMap.enabled = true; R.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(R.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0xbfd6e6); scene.fog = new THREE.Fog(0xbfd6e6, 600, 1600);
scene.add(new THREE.HemisphereLight(0xdfefff, 0x6a6050, 1.6));
const sun = new THREE.DirectionalLight(0xfff2dd, 2.4); sun.position.set(-300, 400, -200); sun.castShadow = true;
const cx = S.x0 + S.w, cz = S.z0 + S.h;
sun.target.position.set(cx, 0, cz); scene.add(sun.target); sun.position.add(new THREE.Vector3(cx, 0, cz));
Object.assign(sun.shadow.camera, { left: -500, right: 500, top: 500, bottom: -500, far: 1500 });
sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0005; scene.add(sun);

// Ground: one grid mesh, coloured per cell kind.
const KC = [[0.58, 0.66, 0.44], [0.30, 0.30, 0.32], [0.70, 0.69, 0.66], [0.55, 0.42, 0.33], [0.30, 0.42, 0.25], [0.25, 0.40, 0.55]];
const g = new THREE.PlaneGeometry(S.w * S.cell, S.h * S.cell, S.w - 1, S.h - 1); g.rotateX(-Math.PI / 2);
const pos = g.attributes.position, col = new Float32Array(pos.count * 3);
for (let i = 0; i < pos.count; i++) {
  const c = i % S.w, r = Math.floor(i / S.w);
  pos.setXYZ(i, S.x0 + c * S.cell, S.kinds[i] === 5 ? -2 : S.heights[i], S.z0 + r * S.cell);
  const k = KC[S.kinds[i]]; col.set(k, i * 3);
}
g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.computeVertexNormals();
const ground = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true })); ground.receiveShadow = true; scene.add(ground);

const hAt = (x, z) => { const c = Math.round((x - S.x0) / S.cell), r = Math.round((z - S.z0) / S.cell);
  return S.heights[Math.min(Math.max(r, 0), S.h - 1) * S.w + Math.min(Math.max(c, 0), S.w - 1)]; };

// Lots: extruded from the lowest ground under them (a foundation) to the plinth plus storeys.
for (const L of S.lots) {
  let foot = L.base;
  for (const [x, z] of L.pts) foot = Math.min(foot, hAt(x, z));
  L.foot = foot;
  const shape = new THREE.Shape(L.pts.map(([x, z]) => new THREE.Vector2(x, -z)));
  const top = L.base + Math.max(L.storeys * 3.4, 0.25);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: top - L.foot + 0.05, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2); geo.translate(0, L.foot - 0.05, 0);
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: new THREE.Color(...L.colour.map((v) => v / 255)) }));
  m.castShadow = m.receiveShadow = true; scene.add(m);
}

// Bridge kit: one cross-section swept along the deck; piers to the ground.
const deckMat = new THREE.MeshLambertMaterial({ color: 0x4a4a50 }), pathMat = new THREE.MeshLambertMaterial({ color: 0xb8b4aa }),
  wallMat = new THREE.MeshLambertMaterial({ color: 0xd8d4c8 }), pierMat = new THREE.MeshLambertMaterial({ color: 0xa8a49a });
const FOOT = 2.5;
function box(mat, len, wid, hgt, a, b, off, lift) {
  const geo = new THREE.BoxGeometry(len, hgt, wid);
  const m = new THREE.Mesh(geo, mat);
  const dx = b[0] - a[0], dz = b[2] - a[2], L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L;
  m.position.set((a[0] + b[0]) / 2 - uz * off, (a[1] + b[1]) / 2 + lift, (a[2] + b[2]) / 2 + ux * off);
  m.rotation.order = 'YZX'; m.rotation.y = -Math.atan2(dz, dx); m.rotation.z = Math.atan2(b[1] - a[1], L);
  m.castShadow = m.receiveShadow = true; scene.add(m);
}
for (const D of S.decks) {
  const half = D.width / 2; let run = 0;
  for (let i = 0; i + 1 < D.pts.length; i++) {
    const a = D.pts[i], b = D.pts[i + 1], L = Math.hypot(b[0] - a[0], b[2] - a[2]) + 0.3;
    box(deckMat, L, D.width + 2 * FOOT + 0.6, 1.2, a, b, 0, -0.6);
    for (const s of [-1, 1]) {
      box(pathMat, L, FOOT, 0.15, a, b, s * (half + FOOT / 2), 0.075);
      box(wallMat, L, 0.3, 1.1, a, b, s * (half + FOOT + 0.15), 0.55);
    }
    run += L;
    if (run > 22) {
      run = 0; const y = hAt(b[0], b[2]);
      if (b[1] - y > 3) { const p = new THREE.Mesh(new THREE.BoxGeometry(2.2, b[1] - 1.2 - y, D.width * 0.6), pierMat);
        p.position.set(b[0], (b[1] - 1.2 + y) / 2, b[2]); p.rotation.y = -Math.atan2(b[2] - a[2], b[0] - a[0]); p.castShadow = true; scene.add(p); }
    }
  }
}
const cam = new THREE.PerspectiveCamera(40, 16 / 9, 1, 4000);
window.shot = (p, t) => { cam.position.set(...p); cam.lookAt(...t); R.render(scene, cam); return R.domElement.toDataURL('image/png'); };
window.ready = true;
</script>`;

const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('console', (m) => console.log('page:', m.text()));
p.on('pageerror', (e) => console.log('error:', e.message));
await p.route('http://lab/**', (route) => {
  const u = route.request().url();
  if (u.endsWith('three.js')) return route.fulfill({ contentType: 'text/javascript', body: readFileSync(ROOT + 'node_modules/three/build/three.module.js') });
  if (u.endsWith('three.core.js')) return route.fulfill({ contentType: 'text/javascript', body: readFileSync(ROOT + 'node_modules/three/build/three.core.js') });
  if (u.endsWith('scene.json')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(scene) });
  if (u.endsWith('index.html')) return route.fulfill({ contentType: 'text/html', body: page });
  return route.fulfill({ status: 404 });
});
await p.goto('http://lab/index.html');
await p.waitForFunction(() => window.ready, null, { timeout: 120000 });
const views = {
  'preview-overview': [[60, 230, 2000], [-330, 30, 1560]],
  'preview-bridge': [[-380, 58, 1790], [-280, 45, 1660]],
  'preview-deck': [[-392, 70, 1580], [-200, 66.5, 1730]],
};
for (const [name, [pos, tgt]] of Object.entries(views)) {
  const url = await p.evaluate(([a, b]) => window.shot(a, b), [pos, tgt]);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUT + name + '.png', Buffer.from(url.split(',')[1], 'base64'));
  console.log('wrote', name);
}
await b.close();
