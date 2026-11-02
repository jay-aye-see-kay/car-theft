import { defineMission, formatTime } from './runtime/mission.ts';
import type { Place } from './runtime/places.ts';

// A boat race: borrow one from the Viaduct pontoons, out past the wharves,
// along the front of the container port, round the end of it and in to
// Mechanics Bay below Parnell, against your best time on this device. The
// checkpoints are out on the water, so they're made here, not the gazetteer.

/** A buoy to round: a point on the water (map metres). */
const buoy = (id: string, name: string, x: number, z: number): Place => ({ id, name, kind: 'buoy', street: '', x, z, at: { x, z } });

const COURSE: Place[] = [
  buoy('princes-wharf-buoy', 'the buoy off Princes Wharf', -300, -560),
  buoy('port-buoy', 'the buoy off the container port', 1500, -585),
  buoy('fergusson-buoy', 'the buoy off Fergusson Wharf', 2010, -150),
  buoy('mechanics-bay', 'Mechanics Bay', 1890, 250),
];
/** Checkpoints are big: you're steering a boat. */
const RADIUS = 28;

export default defineMission({
  id: 'harbour-dash',
  title: 'Harbour Dash',
  blurb: 'Borrow a boat, round the port and into Mechanics Bay. Beat your best.',
  start: 'the-lookout',

  async run(m) {
    if (!m.player.boat) {
      m.say("Nick one of the boats off the pontoons. They won't mind. Probably.", 4);
      m.objective("Get in a boat (they're right here)");
      await m.waitFor(() => !!m.player.boat, 'Get in a boat');
    }
    for (const n of ['3', '2', '1']) {
      m.say(n, 1);
      await m.wait(1);
    }
    m.say('Go!', 1.5);
    m.failIf(() => !m.player.boat, 'Swimming for it? That rules you out.');
    m.timer(300, "The tide's turned. Bring it back another day.");
    const watch = m.stopwatch();
    for (const [i, cp] of COURSE.entries()) {
      const last = i === COURSE.length - 1;
      await m.goTo(cp, { radius: RADIUS, inCar: true, label: last ? 'Into Mechanics Bay' : `Round ${cp.name} (${i + 1} of ${COURSE.length - 1})` });
      if (!last) m.say(`${i + 1}: ${formatTime(watch.seconds, true)}`, 2);
    }
    const time = watch.seconds;
    const { best, isNew } = m.record(time);
    m.succeed(isNew ? `${formatTime(time, true)}. A new best! Tie her up nicely.` : `${formatTime(time, true)}. Your best is ${formatTime(best, true)}.`);
  },
});
