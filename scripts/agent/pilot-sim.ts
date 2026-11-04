// The autopilot (src/agent/autopilot.ts) on the real car, on flat ground, in
// Node: node --experimental-strip-types scripts/agent/pilot-sim.ts
// Prints how it does on a few shapes of road: time, worst miss off the line,
// top speed. A quick check after touching the controller or the car's TUNING.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Car } from '../../src/car.ts';
import { AUTOPILOT, PathFollower, type PathPoint } from '../../src/agent/autopilot.ts';

const DT = 1 / 60;
await RAPIER.init();

function course(name: string, path: PathPoint[], maxKmh = 80) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(2000, 0.5, 2000).setTranslation(0, -0.5, 0), ground);
  const h0 = Math.atan2(-(path[1].z - path[0].z), path[1].x - path[0].x);
  const car = new Car(world, new THREE.Vector3(path[0].x, 1, path[0].z), h0);
  const pilot = new PathFollower(path, maxKmh / 3.6, 6);
  const e = new THREE.Euler();
  let worst = 0;
  let top = 0;
  let t = 0;
  for (; t < 120 && pilot.status === 'driving'; t += DT) {
    const p = car.body.translation();
    const heading = e.setFromQuaternion(car.rotation(), 'YXZ').y;
    const speed = car.forwardSpeed();
    const c = pilot.drive({ x: p.x, z: p.z, heading, speed }, DT);
    car.update(c, DT);
    world.step();
    car.afterStep(DT);
    if (t > 1) worst = Math.max(worst, pilot.offPath);
    top = Math.max(top, speed * 3.6);
  }
  const ok = pilot.status === 'arrived';
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(24)} ${pilot.length.toFixed(0).padStart(4)} m in ${t.toFixed(1).padStart(5)} s  worst ${worst.toFixed(1)} m off  top ${top.toFixed(0)} km/h  unstuck ${pilot.unsticks}  (${pilot.status})`);
  return ok;
}

const line = (pts: [number, number][]) => pts.map(([x, z]) => ({ x, z }));
const arc = (r: number, turns: number, n = 64): PathPoint[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * turns * Math.PI * 2;
    return { x: r * Math.sin(a), z: r - r * Math.cos(a) };
  });

let fails = 0;
fails += +!course('straight 300 m', line([[0, 0], [300, 0]]), 120);
fails += +!course('right-angle left', line([[0, 0], [120, 0], [120, -120]]));
fails += +!course('right-angle right', line([[0, 0], [120, 0], [120, 120]]));
fails += +!course('hairpin (U-turn 12 m)', line([[0, 0], [100, 0], [106, -6], [100, -12], [0, -12]]));
fails += +!course('zigzag blocks', line([[0, 0], [80, 0], [80, -60], [160, -60], [160, 0], [240, 0], [240, 80]]));
fails += +!course('roundabout r=20', arc(20, 0.9));
fails += +!course('long sweep r=150', arc(150, 0.4), 120);
console.log(`AUTOPILOT lateral ${AUTOPILOT.lateral} m/s², decel ${AUTOPILOT.decel} m/s²`);
process.exit(fails ? 1 : 0);
