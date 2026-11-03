import type { Place, PlaceId, PlaceKind, PlaceQuery } from './places.ts';

// The mission format: one file per mission in src/missions/, each exporting
// `defineMission({...})` as default. A mission's `run` is an async script
// against the small API below, so jokes can have logic and `npm run build`
// typechecks them. Grow the API as missions need it (see issue #27).
//
// In a room (#26), a mission for more than one (`players.max > 1`) runs on
// the host for everyone there: `players` is the whole room, and guests see
// what the host's script shows. A solo mission runs for whoever starts it.

export interface MissionPlayer {
  /** Their id in the room (the host is 0). */
  readonly id: number;
  readonly name: string;
  /** Where they are: feet on foot, the car's centre while driving. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** In a car or at a boat's helm. */
  readonly driving: boolean;
  /** At a boat's helm (yours only: others in a room are never in one). */
  readonly boat?: boolean;
  readonly speedKmh: number;
  /** Their wanted level, 0-3 (the cops after them). */
  readonly heat?: number;
  /** Being given a talking-to by the cops right now. */
  readonly caught?: boolean;
}

/** How a prop looks: a ring on the ground, a floating gem with a short beam, a big pulsing light. */
export type PropStyle = 'pad' | 'gem' | 'siren';

export interface PropOptions {
  /** Default 'pad'. */
  style?: PropStyle;
  /** How close counts as on it or touching it, and a pad's size, m (pad 3, gem 2.5, siren 3). */
  radius?: number;
  /** A CSS hex colour, '#rrggbb' (pad gold, gem cyan, siren red). */
  colour?: string;
  /** Shown on the map with this name (unlabelled props aren't on the map). */
  label?: string;
  /** Only drawn within this distance of the camera, m: things to find (default: 300). */
  draw?: number;
  /** Only counts players on foot (true) or driving (false); default either. */
  onFoot?: boolean;
}

/** Something a mission puts in the world: a pad to stand on, a thing to pick up, something chasing you. */
export interface Prop {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly removed: boolean;
  /** Who's carrying it (drawn over their head, moving with them), or null. */
  readonly carrier: MissionPlayer | null;
  move(x: number, z: number): void;
  setColour(colour: string): void;
  setLabel(label: string | undefined): void;
  /** Ride over this player's head (null: put it down where it is). */
  carry(p: MissionPlayer | null): void;
  /** Players within its radius, on the ground (of `among`, default everyone). */
  who(among?: readonly MissionPlayer[]): MissionPlayer[];
  remove(): void;
}

export interface PickupOptions extends PropOptions {
  /** Only these can pick it up (default everyone). */
  among?: readonly MissionPlayer[];
}

/** What `available` can look at. */
export interface MissionContext {
  /** Local hour of day in the game (the sun is fixed mid-afternoon for now). */
  readonly hour: number;
  readonly players: readonly MissionPlayer[];
}

export interface GoToOptions {
  /** How close counts as there, m (default 6). */
  radius?: number;
  /** Objective line in the HUD (default "Go to <place>"). */
  label?: string;
  /** Only counts while driving. */
  inCar?: boolean;
  /**
   * Wait until all of these (those still in the room) are there at once,
   * rather than anyone; resolves with the last to arrive.
   */
  everyone?: readonly MissionPlayer[];
}

/** One line on the board: `note` sits to its right (who did it, how warm), in `colour` if given. */
export interface BoardRow {
  readonly text: string;
  readonly note?: string;
  /** Ticked off: drawn dimmed, with a tick. */
  readonly done?: boolean;
  /** A CSS colour for the note. */
  readonly colour?: string;
}

/** A titled list on the board. */
export interface BoardSection {
  readonly title?: string;
  readonly rows: readonly BoardRow[];
}

/** A countdown or stopwatch shown at the top of the screen. */
export interface Clock {
  /** Seconds left (countdown) or gone (stopwatch). */
  readonly seconds: number;
  /** Stop and hide it. */
  stop(): void;
  /** More time on a countdown (or less, negative). */
  add(seconds: number): void;
}

export interface MissionApi {
  /** Who's playing: the whole room in a mission for more than one, else just you. */
  readonly players: readonly MissionPlayer[];
  /** The player running the script (in a room, the host). */
  readonly player: MissionPlayer;
  /** Game seconds since the mission started. */
  readonly elapsed: number;
  /** A line of subtitle at the bottom of the screen. */
  say(text: string, seconds?: number): void;
  /** The objective line under the timer; '' clears it. */
  objective(text: string): void;
  /**
   * Lists in a corner of the screen (bottom left; top left on phones, clear of the stick):
   * a checklist, everyone's score. Replaces the last board; [] clears it.
   */
  board(sections: readonly BoardSection[]): void;
  /** Says `text` to one player only (on the host's own screen if it's them): asymmetric puzzles. */
  tell(player: MissionPlayer, text: string, seconds?: number): void;
  /** A board section only `player` sees, under the board (null takes it away): the code only the reader knows. */
  secret(player: MissionPlayer, section: BoardSection | null): void;
  /** Puts something in the world (see Prop). Removed when the mission ends. */
  prop(at: { x: number; z: number }, options?: PropOptions): Prop;
  /** A gem (by default) to pick up: resolves with who got it, and it's gone. */
  pickup(at: { x: number; z: number }, options?: PickupOptions): Promise<MissionPlayer>;
  /** Sets the wanted level (0-3) of these players (default everyone), as if a cop just saw them. */
  setHeat(level: number, players?: readonly MissionPlayer[]): void;
  /** Ground height at a point (NaN where it hasn't streamed in). */
  ground(x: number, z: number): number;
  /** A road route between two points (driving on the left, one-ways kept), as points every few metres; null off the roads. */
  route(from: { x: number; z: number }, to: { x: number; z: number }): { x: number; z: number }[] | null;
  /** A seeded random number, 0..1: the same mission started at the same game time rolls the same. */
  rand(): number;
  /** A place from the gazetteer by id ('k-road-dairy'). */
  place(id: PlaceId): Place;
  /** The nearest place of a kind to `near` (default: the player), or null. */
  nearest(kind: PlaceKind, near?: { x: number; z: number }, query?: Omit<PlaceQuery, 'near'>): Place | null;
  /**
   * Any place of a kind, or null: within `query.within` of the player unless
   * `query.near` says otherwise. Seeded per run, so a replay picks the same.
   */
  random(kind: PlaceKind, query?: PlaceQuery): Place | null;
  /**
   * Marks `place` (beam, arrow, objective line) and resolves with whoever
   * gets there first. Several at once (Promise.all) mark several places.
   */
  goTo(place: Place | PlaceId, options?: GoToOptions): Promise<MissionPlayer>;
  /** A beam (and the map's route) on a place until the returned function is called: for goals goTo can't express. */
  beam(place: Place | PlaceId): () => void;
  /** goTo against the clock: who got there first, or null if time ran out. */
  race(players: readonly MissionPlayer[], place: Place | PlaceId, options: GoToOptions & { seconds: number }): Promise<MissionPlayer | null>;
  /** Resolves on the first tick `test` is true, with `label` as the objective meanwhile. */
  waitFor(test: () => boolean, label?: string): Promise<void>;
  /** Game seconds. */
  wait(seconds: number): Promise<void>;
  /** A countdown that fails the mission with `message` when it runs out. */
  timer(seconds: number, message: string): Clock;
  /** A countdown that only shows: the script decides what running out means (it can go below 0). */
  countdown(seconds: number): Clock;
  /** A stopwatch counting up. */
  stopwatch(): Clock;
  /** Fails the mission with `message` on any tick `test` is true, from now until it ends. */
  failIf(test: () => boolean, message: string): void;
  /** Called on each knock to the car `player` is driving, with how hard (sudden change of speed, m/s). */
  onCrash(fn: (strength: number) => void): void;
  /** Saves a best (lowest) time on this device, s. Whether this one beat it, and the best now. */
  record(seconds: number): { best: number; isNew: boolean };
  /** Ends the mission, passed. */
  succeed(message?: string): never;
  /** Ends the mission, failed. */
  fail(message: string): never;
}

export interface Mission {
  /** Also its file name. */
  readonly id: string;
  readonly title: string;
  /** Shown under the title when it starts. */
  readonly blurb: string;
  /** How many can play (default 1 to 1). Over one, it's shared with the room, which gathers at the marker to start it. */
  readonly players?: { min: number; max: number };
  /** Whether its start marker shows (default: always). */
  available?(ctx: MissionContext): boolean;
  /** Where its start marker is (a place id, or a spot of its own): walk (or drive) into it to start. */
  readonly start: PlaceId | Place;
  /** Only starts when you drive into the marker. */
  readonly needsCar?: boolean;
  run(m: MissionApi): Promise<void>;
}

/** Identity, for type checking and editor help in mission files. */
export const defineMission = (mission: Mission): Mission => mission;

/** Mission time as m:ss, or m:ss.t with `tenths`. */
export const formatTime = (seconds: number, tenths = false): string => {
  const s = Math.max(0, seconds);
  const whole = tenths ? Math.floor(s * 10) / 10 : Math.ceil(s);
  const m = Math.floor(whole / 60);
  const rest = whole - m * 60;
  return `${m}:${rest.toFixed(tenths ? 1 : 0).padStart(tenths ? 4 : 2, '0')}`;
};
