// What the cops say. Cheeky and Kiwi, never nasty (docs/BRIEF.md): they
// want you to pull over and have a word, not to hurt you. No real people or
// brands (the GTA parody rule).

/** On the car's loudspeaker, tailing you. */
export const LOUDSPEAKER = [
  'Pull over, mate.',
  'Oi! Pull over!',
  'Come on, bro. Pull over.',
  'We can see you, you know.',
  'Easy on the gas, eh.',
  "That's not your car, champ.",
  "Righto. That's enough now.",
  'Your nan would be gutted.',
  "Pull over. It's nearly smoko.",
  'Indicate, at least!',
  "Mate. We've got all day.",
];

/** On foot (or on a bike), coming after you. */
export const SHOUT = ['Oi! Stop right there!', 'Hold up, mate!', 'Police! Stop!', "Don't make me run, bro!", 'Stop! In the name of the law!', 'Come back here, egg!'];

/** The talking-to, once they've caught you. */
export const TALKING_TO = [
  'Yeah, nah. Not on my watch, mate.',
  'Honestly. What would your mum say?',
  "You've been a right egg today, haven't you.",
  'Chur for stopping. Eventually.',
  "I've seen better driving in the supermarket car park.",
  "Settle down, cuz. This isn't the Grand Prix.",
  'Mate. Mate. Mate.',
  "You're lucky the pie cart's open. I'm in a good mood.",
  "She'll be right. You won't be, but she will.",
  'Ka pai on the running. Shocking on everything else.',
  "I'll let you off with a ticket. And a lecture. This is the lecture.",
  "Do you know how many forms this is? Heaps. Heaps of forms.",
];

/** What the ticket's for, by the last thing they saw you do. */
export const OFFENCES: Record<string, string[]> = {
  ped: ['Biffing a pedestrian', 'Skittling a local', 'Unlicensed ten-pin bowling'],
  cop: ['Pranging a police car', 'Assaulting the uniform', 'Bumper cars with the constabulary'],
  car: ['Borrowing a car without asking', 'Nicking a motor', 'Wrong car, mate'],
  hoon: ['Hooning', 'Doing skids', 'Being a boy racer'],
  flee: ['Failing to stop', 'Leading us a merry dance', 'Doing a runner'],
  none: ['General hōhā', 'Being a nuisance', 'Looking dodgy'],
};

/** Syllables in a line, roughly, for the loudspeaker's babble. */
export function syllables(line: string): number {
  return Math.max(2, (line.toLowerCase().match(/[aeiouy]+/g) ?? []).length);
}
