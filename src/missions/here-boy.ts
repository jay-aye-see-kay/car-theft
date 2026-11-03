import { defineMission, formatTime, type MissionPlayer } from './runtime/mission.ts';
import { dist, every, nearestOf, spot } from './runtime/kit.ts';

// Exploring, one to four (catching animals in Breath of the Wild, chasing the
// chicken in every game ever): Biscuit has slipped his lead in Victoria Park.
// He's a bit slower than you sprinting but turns on a dime and won't leave
// the park. Corner him (easier with friends), grab him, and carry him back
// to his owner. On foot: he hates cars.

const PARK = { x: -1135, z: 280, r: 52 };
const OWNER = spot('biscuit-owner', "Biscuit's owner", -1190, 330);
/** He bolts from anyone this close, m... */
const SCARED = 14;
/** ...at this, m/s (a sprint is 7.2)... */
const RUN = 6.4;
/** ...and otherwise trots about at this. */
const TROT = 1.6;
/** Grab him within this, m. */
const GRAB = 1.7;

export default defineMission({
  id: 'here-boy',
  title: 'Here, Biscuit!',
  blurb: 'A runaway dog, a big park, no lead. Corner him.',
  players: { min: 1, max: 4 },
  start: spot('here-boy-start', 'Victoria Park', -1080, 230),

  async run(m) {
    const dog = { x: PARK.x + 10, z: PARK.z - 20, hx: 1, hz: 0, puff: 0 };
    const biscuit = m.prop(dog, { style: 'gem', colour: '#d9a066', radius: GRAB, label: 'Biscuit', onFoot: true });
    let carrier: MissionPlayer | null = null;
    let wiggle = 0;
    /** Just wriggled free: can't be grabbed again for this long, s. */
    let free = 0;
    m.say("Biscuit's off his lead again. He won't leave the park, but he won't come either. Corner him. No cars, he hates cars.", 6);
    m.timer(240, "Biscuit found a sausage sizzle and isn't coming back.");
    every(m, 1 / 30, (dt) => {
      if (carrier) {
        const c = m.players.find((p) => p.id === carrier!.id);
        // He wriggles free from anyone who gets in a car, or now and then if you run.
        wiggle += c && !c.driving ? (c.speedKmh > 22 ? dt * 0.08 : 0) : 1;
        if (!c || wiggle >= 1 || m.rand() < wiggle * dt) {
          biscuit.carry(null);
          [dog.x, dog.z] = [biscuit.x, biscuit.z];
          carrier = null;
          dog.puff = 0;
          free = 1.5;
          m.say('Biscuit wriggled free!', 2);
        }
        return;
      }
      const { it: near, d } = nearestOf(dog, m.players.filter((p) => !p.driving));
      const cars = m.players.filter((p) => p.driving && dist(p, dog) < SCARED * 1.5);
      let tx = 0;
      let tz = 0;
      let speed = TROT;
      // Away from everyone close (cars count double), weighted by how close.
      for (const p of [...m.players.filter((q) => !q.driving && dist(q, dog) < SCARED), ...cars, ...cars]) {
        const k = Math.max(0.5, dist(p, dog));
        tx += (dog.x - p.x) / (k * k);
        tz += (dog.z - p.z) / (k * k);
        speed = RUN;
      }
      // Tired after a long run: he slows, so you can catch up.
      dog.puff = speed === RUN ? dog.puff + dt : Math.max(0, dog.puff - dt * 2);
      if (dog.puff > 8) speed = TROT * 2.2;
      if (speed === TROT) {
        // Wander: turn a little at random.
        const a = Math.atan2(dog.hz, dog.hx) + (m.rand() - 0.5) * 2.5 * dt;
        tx = Math.cos(a);
        tz = Math.sin(a);
      }
      // Keep in the park: the fence pushes back.
      const out = dist(dog, PARK) - (PARK.r - 6);
      if (out > 0) {
        tx += ((PARK.x - dog.x) / PARK.r) * out * 0.3;
        tz += ((PARK.z - dog.z) / PARK.r) * out * 0.3;
      }
      const len = Math.hypot(tx, tz) || 1;
      [dog.hx, dog.hz] = [tx / len, tz / len];
      dog.x += dog.hx * speed * dt;
      dog.z += dog.hz * speed * dt;
      const r = dist(dog, PARK);
      if (r > PARK.r) {
        dog.x = PARK.x + ((dog.x - PARK.x) / r) * PARK.r;
        dog.z = PARK.z + ((dog.z - PARK.z) / r) * PARK.r;
      }
      biscuit.move(dog.x, dog.z);
      free = Math.max(0, free - dt);
      if (near && d < GRAB && free <= 0) {
        carrier = near;
        wiggle = 0;
        biscuit.carry(near);
        m.say(`${m.players.length > 1 ? near.name + ' has' : 'Got'} him! Now walk him back. Gently.`, 3);
      }
      m.objective(carrier ? `Carry Biscuit to his owner` : 'Catch Biscuit');
    });
    m.beam(OWNER);
    await m.waitFor(() => !!biscuit.carrier && dist(biscuit.carrier, OWNER) < 6, 'Catch Biscuit');
    m.succeed(`"BISCUIT! Who's a good boy?" Not you, apparently: nobody thanks you. ${formatTime(m.elapsed)}.`);
  },
});
