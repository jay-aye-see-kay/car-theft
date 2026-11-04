// World-gen lab viewer (lab.html): fly or walk round the prototype city from
// tools/worldgen-lab/ (designed ground, level roads, kit bridges, WFC lots).
// Standalone: nothing here is game code, and the game doesn't load it.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type Meta = {
  x0: number; z0: number; cell: number; nx: number; nz: number; texX0: number; texZ0: number; texCell: number;
  skyTower: { x: number; z: number; y: number };
};
type Road = { w: number; f: number; c: string; p: number[] };
type Deck = { width: number; pts: [number, number, number][] };
type Lots = { kinds: string[]; colours: [number, number, number][]; lots: [number, number, number, number, number[]][] };
type Real = [number, number, number[]][];

const BASE = './lab/';
const get = (f: string) => fetch(BASE + f);
const meta: Meta = await (await get('meta.json')).json();
const [groundBuf, deckBuf, roads, decks, lots] = await Promise.all([
  get('ground.bin').then((r) => r.arrayBuffer()),
  get('deck.bin').then((r) => r.arrayBuffer()),
  get('roads.json').then((r) => r.json() as Promise<Road[]>),
  get('decks.json').then((r) => r.json() as Promise<Deck[]>),
  get('lots.json').then((r) => r.json() as Promise<Lots>),
]);
const G = new Uint16Array(groundBuf), D = new Uint16Array(deckBuf);
const { nx, nz, cell } = meta;
const gAt = (r: number, c: number) => G[Math.min(Math.max(r, 0), nz - 1) * nx + Math.min(Math.max(c, 0), nx - 1)] / 100 - 10;
function sample(arr: (r: number, c: number) => number, x: number, z: number) {
  const fc = (x - meta.x0) / cell, fr = (z - meta.z0) / cell;
  const c = Math.floor(fc), r = Math.floor(fr), u = fc - c, v = fr - r;
  return (arr(r, c) * (1 - u) + arr(r, c + 1) * u) * (1 - v) + (arr(r + 1, c) * (1 - u) + arr(r + 1, c + 1) * u) * v;
}
const groundAt = (x: number, z: number) => sample(gAt, x, z);
function deckAt(x: number, z: number) {
  const c = Math.round((x - meta.x0) / cell), r = Math.round((z - meta.z0) / cell);
  if (r < 0 || c < 0 || r >= nz || c >= nx) return -Infinity;
  const v = D[r * nx + c] / 100 - 10;
  return v > -9 ? v : -Infinity;
}

// --- Renderer, scene, light ---------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
const SKY = new THREE.Color(0xbcd4e6);
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 500, 3200);
scene.add(new THREE.HemisphereLight(0xe4eef8, 0x5e5545, 1.5));
const SUN_DIR = new THREE.Vector3(-0.45, 0.75, -0.35).normalize();
const sun = new THREE.DirectionalLight(0xfff1dc, 1.9);
sun.position.copy(SUN_DIR);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.3, 6000);
camera.rotation.order = 'YXZ';

// --- Ground: tiles of the 4 m grid, coloured by the 2 m ground texture --------
const tex = await new THREE.TextureLoader().loadAsync(BASE + 'ground.png');
tex.colorSpace = THREE.SRGBColorSpace;
tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
const texW = tex.image.width * meta.texCell, texH = tex.image.height * meta.texCell;
const groundMat = new THREE.MeshLambertMaterial({ map: tex });
const TILE = 64;
// Each tile at full detail (4 m) near, every 4th vertex (16 m) beyond 700 m: phones can't draw 1.8M ground triangles.
function groundTile(tr: number, tc: number, step: number) {
  const rows = Math.floor(Math.min(TILE, nz - 1 - tr) / step) + 1, cols = Math.floor(Math.min(TILE, nx - 1 - tc) / step) + 1;
  const pos = new Float32Array(rows * cols * 3), uv = new Float32Array(rows * cols * 2);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const k = r * cols + c, x = meta.x0 + (tc + c * step) * cell, z = meta.z0 + (tr + r * step) * cell;
    pos.set([x, gAt(tr + r * step, tc + c * step), z], k * 3);
    uv.set([(x - meta.texX0) / texW, 1 - (z - meta.texZ0) / texH], k * 2);
  }
  const idx: number[] = [];
  for (let r = 0; r + 1 < rows; r++) for (let c = 0; c + 1 < cols; c++) {
    const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
    idx.push(a, d, b, b, d, e);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(g, groundMat);
}
for (let tr = 0; tr < nz - 1; tr += TILE) {
  for (let tc = 0; tc < nx - 1; tc += TILE) {
    const lod = new THREE.LOD();
    lod.addLevel(groundTile(tr, tc, 1), 0);
    lod.addLevel(groundTile(tr, tc, 4), 700);
    // LOD measures from its own position: put it at the tile's middle (geometry stays in world space).
    const cx = meta.x0 + (tc + TILE / 2) * cell, cz = meta.z0 + (tr + TILE / 2) * cell;
    lod.position.set(cx, 0, cz);
    for (const l of lod.levels) l.object.position.set(-cx, 0, -cz);
    scene.add(lod);
  }
}
const water = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), new THREE.MeshLambertMaterial({ color: 0x3f7a98 }));
water.rotation.x = -Math.PI / 2;
water.position.y = 0.05;
scene.add(water);

// --- Roads: level strips from the designed profiles ---------------------------
// Texture: left half has a dashed centre line and edge lines, right half is plain (service lanes).
const rc = document.createElement('canvas');
rc.width = 128; rc.height = 64;
const rx = rc.getContext('2d')!;
rx.fillStyle = '#4a4a4f'; rx.fillRect(0, 0, 128, 64);
rx.fillStyle = '#e8e4d8';
rx.fillRect(2, 0, 2, 64); rx.fillRect(60, 0, 2, 64);
rx.fillRect(31, 0, 2, 30);
const roadTex = new THREE.CanvasTexture(rc);
roadTex.wrapT = THREE.RepeatWrapping;
roadTex.colorSpace = THREE.SRGBColorSpace;
roadTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
{
  const rp: number[] = [], ruv: number[] = [], ri: number[] = [];
  const fp: number[] = [], fi: number[] = [];
  for (const R of roads) {
    const p = R.p, n = p.length / 6;
    const u0 = R.c === 'service' ? 0.5 : 0, u1 = R.c === 'service' ? 1 : 0.5;
    let dist = 0;
    for (let i = 0; i < n; i++) {
      const x = p[i * 6], z = p[i * 6 + 1];
      if (i) dist += Math.hypot(x - p[(i - 1) * 6], z - p[(i - 1) * 6 + 1]);
      const a = Math.max(i - 1, 0), b = Math.min(i + 1, n - 1);
      let dx = p[b * 6] - p[a * 6], dz = p[b * 6 + 1] - p[a * 6 + 1];
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const nxv = -dz, nzv = dx;
      const [hOL, hL, hR, hOR] = [p[i * 6 + 2], p[i * 6 + 3], p[i * 6 + 4], p[i * 6 + 5]];
      const base = rp.length / 3;
      rp.push(x - nxv * R.w, hL + 0.07, z - nzv * R.w, x + nxv * R.w, hR + 0.07, z + nzv * R.w);
      ruv.push(u0, dist / 12, u1, dist / 12);
      if (i) ri.push(base - 2, base, base - 1, base - 1, base, base + 1);
      if (R.f > 0) {
        // Footpaths: outer edge, inner edge, then a kerb face down to the road.
        const fb = fp.length / 3, o = R.w + R.f;
        fp.push(x - nxv * o, hOL + 0.2, z - nzv * o, x - nxv * R.w, hL + 0.2, z - nzv * R.w, x - nxv * R.w, hL + 0.07, z - nzv * R.w);
        fp.push(x + nxv * o, hOR + 0.2, z + nzv * o, x + nxv * R.w, hR + 0.2, z + nzv * R.w, x + nxv * R.w, hR + 0.07, z + nzv * R.w);
        if (i) {
          const q = fb - 6;
          for (const s of [0, 3]) {
            fi.push(q + s, fb + s, q + s + 1, q + s + 1, fb + s, fb + s + 1);
            fi.push(q + s + 1, fb + s + 1, q + s + 2, q + s + 2, fb + s + 1, fb + s + 2);
          }
        }
      }
    }
  }
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3));
  rg.setAttribute('uv', new THREE.Float32BufferAttribute(ruv, 2));
  rg.setIndex(ri); rg.computeVertexNormals();
  const roadMat = new THREE.MeshLambertMaterial({ map: roadTex, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  scene.add(new THREE.Mesh(rg, roadMat));
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
  fg.setIndex(fi); fg.computeVertexNormals();
  scene.add(new THREE.Mesh(fg, new THREE.MeshLambertMaterial({ color: 0xbdb8ab, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })));
}

// --- Bridge kit: deck, footpaths, parapets and piers, merged into one mesh -----
{
  const parts: THREE.BufferGeometry[] = [];
  const colour = (g: THREE.BufferGeometry, hex: number) => {
    const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    g.deleteAttribute('uv');
    return g;
  };
  const FOOT = 2.5;
  const piece = (hex: number, len: number, wid: number, hgt: number, a: number[], b: number[], off: number, lift: number) => {
    const g = new THREE.BoxGeometry(len, hgt, wid);
    const dx = b[0] - a[0], dz = b[2] - a[2], L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3((a[0] + b[0]) / 2 - uz * off, (a[1] + b[1]) / 2 + lift, (a[2] + b[2]) / 2 + ux * off),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -Math.atan2(dz, dx), Math.atan2(b[1] - a[1], L), 'YZX')),
      new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(m);
    parts.push(colour(g, hex));
  };
  for (const Dk of decks) {
    const half = Dk.width / 2;
    let run = 0;
    for (let i = 0; i + 1 < Dk.pts.length; i++) {
      const a = Dk.pts[i], b = Dk.pts[i + 1], L = Math.hypot(b[0] - a[0], b[2] - a[2]) + 0.4;
      piece(0x4a4a4f, L, Dk.width + 2 * FOOT + 0.6, 1.4, a, b, 0, -0.62);
      for (const s of [-1, 1]) {
        piece(0xbdb8ab, L, FOOT, 0.2, a, b, s * (half + FOOT / 2), 0.18);
        piece(0xd9d5c9, L, 0.35, 1.15, a, b, s * (half + FOOT + 0.17), 0.6);
      }
      run += L;
      if (run > 24) {
        run = 0;
        const y = groundAt(b[0], b[2]);
        if (b[1] - y > 3) {
          const p = new THREE.BoxGeometry(2.2, b[1] - 1.3 - y, Dk.width * 0.55);
          p.rotateY(-Math.atan2(b[2] - a[2], b[0] - a[0]));
          p.translate(b[0], (b[1] - 1.3 + y) / 2, b[2]);
          parts.push(colour(p, 0xa9a59b));
        }
      }
    }
  }
  if (parts.length) scene.add(new THREE.Mesh(mergeGeometries(parts), new THREE.MeshLambertMaterial({ vertexColors: true })));
}

// --- Buildings: extruded footprints, windows drawn in the shader ---------------
const buildingMat = new THREE.ShaderMaterial({
  uniforms: { sunDir: { value: SUN_DIR }, fogColor: { value: SKY }, fogNear: { value: 500 }, fogFar: { value: 3200 } },
  vertexShader: /* glsl */ `
    attribute vec3 color; attribute float aBase; attribute float aWin;
    varying vec3 vColor; varying vec3 vWorld; varying vec3 vNormal; varying float vBase; varying float vWin; varying float vDist;
    void main() {
      vColor = color; vBase = aBase; vWin = aWin; vNormal = normal; vWorld = position;
      vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 sunDir; uniform vec3 fogColor; uniform float fogNear; uniform float fogFar;
    varying vec3 vColor; varying vec3 vWorld; varying vec3 vNormal; varying float vBase; varying float vWin; varying float vDist;
    void main() {
      vec3 n = normalize(vNormal);
      float light = 0.55 + 0.35 * (n.y * 0.5 + 0.5) + 0.5 * max(dot(n, sunDir), 0.0);
      vec3 c = vColor;
      float above = vWorld.y - vBase;
      if (above < 0.0) c *= 0.62;                              // foundation below the plinth
      else if (abs(n.y) < 0.5 && vWin > 0.5) {
        float along = dot(vWorld.xz, vec2(-n.z, n.x));
        float fx = fract(along / 3.2), fy = above / 3.4, ry = fract(fy);
        float glass = 0.0;
        if (vWin > 1.5 && fy < 1.0) glass = step(0.06, fract(along / 6.0)) * step(fract(along / 6.0), 0.94) * step(0.04, fy) * step(fy, 0.78);
        else glass = step(0.22, fx) * step(fx, 0.78) * step(0.3, ry) * step(ry, 0.84);
        float fade = smoothstep(900.0, 250.0, vDist);
        vec3 g = mix(vec3(0.20, 0.25, 0.32), vec3(0.55, 0.65, 0.75), clamp(0.4 + 0.5 * n.z, 0.0, 1.0) * 0.6);
        c = mix(c, mix(c * 0.75, g, glass), fade * 0.95 + 0.05);
        if (vWin > 1.5 && fy >= 1.0 && fy < 1.12) c = mix(c, vec3(0.25, 0.22, 0.2), fade); // verandah line
      }
      vec3 col = c * light;
      float f = smoothstep(fogNear, fogFar, vDist);
      gl_FragColor = vec4(mix(col, fogColor, f), 1.0);
      #include <colorspace_fragment>
    }`,
});

function buildingMesh(items: { pts: number[]; foot: number; base: number; top: number; colour: THREE.Color; win: number; roof: number }[]) {
  const P: number[] = [], N: number[] = [], C: number[] = [], B: number[] = [], W: number[] = [];
  const push = (x: number, y: number, z: number, n: THREE.Vector3, c: THREE.Color, base: number, win: number) => {
    P.push(x, y, z); N.push(n.x, n.y, n.z); C.push(c.r, c.g, c.b); B.push(base); W.push(win);
  };
  const up = new THREE.Vector3(0, 1, 0), nv = new THREE.Vector3();
  for (const it of items) {
    let ring: THREE.Vector2[] = [];
    for (let i = 0; i < it.pts.length; i += 2) ring.push(new THREE.Vector2(it.pts[i], it.pts[i + 1]));
    if (ring.length < 3) continue;
    if (THREE.ShapeUtils.isClockWise(ring)) ring = ring.reverse();
    const roofCol = it.colour.clone().multiplyScalar(0.8);
    // Walls (counter-clockwise in x/z means the outward normal is (dz, -dx)).
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x, dz = b.y - a.y, l = Math.hypot(dx, dz) || 1;
      nv.set(-dz / l, 0, dx / l);
      const q = [[a.x, it.foot, a.y], [b.x, it.foot, b.y], [b.x, it.top, b.y], [a.x, it.top, a.y]];
      for (const k of [0, 2, 1, 0, 3, 2]) push(q[k][0], q[k][1], q[k][2], nv, it.colour, it.base, it.win);
    }
    if (it.roof > 0) {
      // Hipped roof for houses: every edge up to a ridge point over the middle.
      let cx = 0, cz = 0;
      for (const p of ring) { cx += p.x; cz += p.y; }
      cx /= ring.length; cz /= ring.length;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const va = new THREE.Vector3(a.x, it.top, a.y), vb = new THREE.Vector3(b.x, it.top, b.y), vc = new THREE.Vector3(cx, it.top + it.roof, cz);
        const n = new THREE.Vector3().crossVectors(vc.clone().sub(va), vb.clone().sub(va)).normalize();
        for (const v of [va, vc, vb]) push(v.x, v.y, v.z, n, new THREE.Color(0x8a4b3c), it.base, 0);
      }
    } else {
      for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(ring, [])) {
        for (const v of [ring[i], ring[k], ring[j]]) push(v.x, it.top, v.y, up, roofCol, it.base, 0);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setAttribute('aBase', new THREE.Float32BufferAttribute(B, 1));
  g.setAttribute('aWin', new THREE.Float32BufferAttribute(W, 1));
  return new THREE.Mesh(g, buildingMat);
}

const SHOP = new Set(['shopfront', 'corner-pub', 'dairy']);
const HOUSE = new Set(['villa', 'bungalow']);
const FLAT = new Set(['plaza', 'laneway', 'yard', 'pocket-park']);
const generated = buildingMesh(lots.lots.map(([k, foot, base, top, pts]) => {
  const kind = lots.kinds[k];
  const [r, g, b] = lots.colours[k];
  // Lab colours are a key, too saturated for a city: wash them toward stone.
  const c = new THREE.Color(r / 255, g / 255, b / 255).lerp(new THREE.Color(0.78, 0.75, 0.7), 0.45).convertSRGBToLinear();
  return { pts, foot, base, top, colour: c, win: FLAT.has(kind) || top - base < 1 ? 0 : SHOP.has(kind) ? 2 : 1, roof: HOUSE.has(kind) ? 2.6 : 0 };
}));
scene.add(generated);
let real: THREE.Mesh | null = null;
async function loadReal() {
  const data: Real = await (await get('real.json')).json();
  const palette = [0xd8cbb5, 0xc9b9a0, 0xb8b4ac, 0x9fa6ad, 0x8c97a3].map((h) => new THREE.Color(h).convertSRGBToLinear());
  real = buildingMesh(data.map(([foot, top, pts], i) => ({
    pts, foot, base: foot + 0.3, top, colour: palette[(i * 7) % palette.length].clone().multiplyScalar(0.92 + 0.08 * ((i * 13) % 5) / 4),
    win: 1, roof: 0,
  })));
  real.visible = false;
  scene.add(real);
}

// --- The one landmark: a stand-in Sky Tower ------------------------------------
{
  const s = meta.skyTower;
  const prof: [number, number][] = [[7.5, 0], [6, 12], [6, 180], [17, 186], [20, 192], [20, 196], [14, 202], [11, 214], [9, 222], [4, 226], [2, 236], [1.2, 328], [0, 328]];
  const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 24);
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xe2e0da }));
  m.position.set(s.x, s.y, s.z);
  scene.add(m);
}

// --- Controls -------------------------------------------------------------------
const VIEWS = [
  { name: 'Harbour', pos: [-120, 130, -420], at: [-480, 60, 420], walk: false },
  { name: 'Grafton Bridge', pos: [-392, 0, 1580], at: [-200, 66, 1730], walk: true },
  { name: 'Queen St', pos: [-302, 0, 650], at: [-170, 20, 180], walk: true },
  { name: 'Over the Domain', pos: [1150, 260, 2050], at: [400, 40, 1300], walk: false },
];
let yaw = 0, pitch = 0, walk = false, speedMul = 1, viewIdx = 0;
function goView(i: number) {
  viewIdx = (i + VIEWS.length) % VIEWS.length;
  const v = VIEWS[viewIdx];
  camera.position.set(v.pos[0], v.pos[1], v.pos[2]);
  setWalk(v.walk);
  if (walk) camera.position.y = surfaceAt(v.pos[0], v.pos[2]) + 1.7;
  const dx = v.at[0] - camera.position.x, dy = v.at[1] - camera.position.y, dz = v.at[2] - camera.position.z;
  yaw = Math.atan2(-dx, -dz);
  pitch = Math.atan2(dy, Math.hypot(dx, dz));
}
const surfaceAt = (x: number, z: number) => {
  const g = groundAt(x, z), d = deckAt(x, z);
  return Math.max(g < 0.2 ? 0.3 : g, d > -Infinity && Math.abs(d - camera.position.y) < 6 ? d + 0.2 : -Infinity);
};
const walkBtn = document.getElementById('walk')!, realBtn = document.getElementById('real')!;
function setWalk(on: boolean) { walk = on; walkBtn.classList.toggle('on', on); }
async function toggleReal() {
  if (!real) await loadReal();
  real!.visible = !real!.visible;
  generated.visible = !real!.visible;
  realBtn.classList.toggle('on', real!.visible);
  realBtn.textContent = real!.visible ? 'Generated' : 'Real';
}
walkBtn.onclick = () => setWalk(!walk);
realBtn.onclick = () => void toggleReal();
document.getElementById('next')!.onclick = () => goView(viewIdx + 1);

const keys = new Set<string>();
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyG') setWalk(!walk);
  if (e.code === 'KeyB') void toggleReal();
  if (/^Digit[1-4]$/.test(e.code)) goView(Number(e.code.slice(5)) - 1);
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const canvas = renderer.domElement;
canvas.addEventListener('click', () => { if (!matchMedia('(pointer: coarse)').matches) canvas.requestPointerLock?.(); });
let dragging = false;
canvas.addEventListener('mousedown', () => { dragging = true; });
addEventListener('mouseup', () => { dragging = false; });
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas || dragging) look(e.movementX, e.movementY, 0.0025);
});
addEventListener('wheel', (e) => { speedMul = Math.min(Math.max(speedMul * (e.deltaY > 0 ? 0.85 : 1.18), 0.2), 8); }, { passive: true });
function look(dx: number, dy: number, k: number) {
  yaw -= dx * k;
  pitch = Math.min(Math.max(pitch - dy * k, -1.5), 1.5);
}

// Touch: a stick on the left to move, drag anywhere else to look, buttons for up/down.
const stick = { id: -1, x: 0, y: 0, cx: 0, cy: 0 };
const lookTouch = { id: -1, x: 0, y: 0 };
const knob = document.getElementById('knob')!;
let vert = 0;
addEventListener('touchstart', (e) => {
  document.body.classList.add('touch');
  for (const t of Array.from(e.changedTouches)) {
    if ((t.target as HTMLElement).tagName === 'BUTTON') continue;
    if (t.clientX < innerWidth * 0.4 && t.clientY > innerHeight * 0.4 && stick.id < 0) {
      Object.assign(stick, { id: t.identifier, cx: t.clientX, cy: t.clientY, x: 0, y: 0 });
    } else if (lookTouch.id < 0) Object.assign(lookTouch, { id: t.identifier, x: t.clientX, y: t.clientY });
  }
}, { passive: true });
addEventListener('touchmove', (e) => {
  for (const t of Array.from(e.changedTouches)) {
    if (t.identifier === stick.id) {
      const dx = t.clientX - stick.cx, dy = t.clientY - stick.cy, l = Math.hypot(dx, dy), m = Math.min(l, 50) / (l || 1);
      stick.x = (dx * m) / 50; stick.y = (dy * m) / 50;
      knob.style.transform = `translate(${dx * m}px, ${dy * m}px)`;
    } else if (t.identifier === lookTouch.id) {
      look(t.clientX - lookTouch.x, t.clientY - lookTouch.y, 0.005);
      lookTouch.x = t.clientX; lookTouch.y = t.clientY;
    }
  }
}, { passive: true });
const endTouch = (e: TouchEvent) => {
  for (const t of Array.from(e.changedTouches)) {
    if (t.identifier === stick.id) { stick.id = -1; stick.x = stick.y = 0; knob.style.transform = ''; }
    if (t.identifier === lookTouch.id) lookTouch.id = -1;
  }
};
addEventListener('touchend', endTouch);
addEventListener('touchcancel', endTouch);
for (const [id, v] of [['up', 1], ['down', -1]] as const) {
  const b = document.getElementById(id)!;
  b.addEventListener('touchstart', (e) => { e.preventDefault(); vert = v; });
  b.addEventListener('touchend', () => { vert = 0; });
}
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// --- Loop -------------------------------------------------------------------------
const hud = document.getElementById('hud')!;
document.getElementById('loading')!.remove();
goView(0);
let last = performance.now(), frames = 0, fpsT = last, fps = 0;
const fwd = new THREE.Vector3(), right = new THREE.Vector3();
function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  let mx = stick.x, mz = -stick.y, my = vert;
  if (keys.has('KeyW') || keys.has('ArrowUp')) mz += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) mz -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
  if (keys.has('Space') || keys.has('KeyE')) my += 1;
  if (keys.has('KeyQ') || keys.has('KeyC')) my -= 1;
  const fast = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1;
  const p = camera.position;
  if (walk) {
    const sp = 7 * fast * speedMul;
    fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    p.addScaledVector(fwd, mz * sp * dt).addScaledVector(right, mx * sp * dt);
    p.y = surfaceAt(p.x, p.z) + 1.7;
    if (my > 0) setWalk(false);
  } else {
    const alt = Math.max(p.y - groundAt(p.x, p.z), 0);
    const sp = (25 + alt * 0.6) * fast * speedMul;
    fwd.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    p.addScaledVector(fwd, mz * sp * dt).addScaledVector(right, mx * sp * dt);
    p.y += my * sp * dt;
    p.y = Math.max(p.y, surfaceAt(p.x, p.z) + 1.2);
  }
  camera.rotation.set(pitch, yaw, 0);
  renderer.render(scene, camera);
  frames++;
  if (now - fpsT > 500) { fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now; }
  hud.textContent = `${walk ? 'Walking' : 'Flying'} · ${VIEWS[viewIdx].name} · ${Math.round(fps)} fps\n` +
    `x ${p.x.toFixed(0)}  z ${p.z.toFixed(0)}  height ${p.y.toFixed(0)} m · ${real?.visible ? 'real buildings' : 'generated buildings'}`;
    if (!STILL) requestAnimationFrame(frame);
}
// ?still: no loop, for headless screenshots (software GL is far too slow to animate).
const STILL = new URLSearchParams(location.search).has('still');
(window as unknown as { lab: object }).lab = {
  view: (i: number) => { goView(i); frame(performance.now()); },
  real: async () => { await toggleReal(); frame(performance.now()); },
};
requestAnimationFrame(frame);
