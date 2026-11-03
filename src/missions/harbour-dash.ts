import { defineMission, formatTime } from './runtime/mission.ts';
import type { Place } from './runtime/places.ts';

// A boat race: borrow one from the Viaduct pontoons, out of the basin,
// round the end of Princes Wharf, in between the wharves, round Queens Wharf
// and into the ferry basin, against your best time on this device. Short and
// twisty: about 1.5 km, so even the launch (13 m/s flat out) makes it. The
// checkpoints are out on the water, so they're made here, not the gazetteer.

/** A buoy to round: a point on the water (map metres). */
const buoy = (id: string, name: string, x: number, z: number): Place => ({ id, name, kind: 'buoy', street: '', x, z, at: { x, z } });

const COURSE: Place[] = [
  buoy('viaduct-buoy', 'the buoy outside the Viaduct', -560, -420),
  buoy('wynyard-buoy', 'the buoy off Wynyard', -450, -570),
  buoy('princes-wharf-buoy', 'the end of Princes Wharf', -225, -605),
  buoy('between-wharves', 'the buoy between the wharves', -120, -330),
  buoy('queens-wharf-buoy', 'the end of Queens Wharf', 10, -520),
  buoy('ferry-basin', 'the ferry basin', 110, -300),
];
/** Checkpoints are big: you're steering a boat. */
const RADIUS = 28;

export default defineMission({
  id: 'harbour-dash',
  title: 'Harbour Dash',
  blurb: 'Borrow a boat, round the wharves, into the ferry basin. Beat your best.',
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
    m.timer(240, "The tide's turned. Bring it back another day.");
    const watch = m.stopwatch();
    for (const [i, cp] of COURSE.entries()) {
      const last = i === COURSE.length - 1;
      await m.goTo(cp, { radius: RADIUS, inCar: true, label: last ? 'Into the ferry basin' : `Round ${cp.name} (${i + 1} of ${COURSE.length - 1})` });
      if (!last) m.say(`${i + 1}: ${formatTime(watch.seconds, true)}`, 2);
    }
    const time = watch.seconds;
    const { best, isNew } = m.record(time);
    m.succeed(isNew ? `${formatTime(time, true)}. A new best! Tie her up nicely.` : `${formatTime(time, true)}. Your best is ${formatTime(best, true)}.`);
  },
});
