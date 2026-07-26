/**
 * Display names for actors.
 *
 * The simulation identifies bots as `bot-07`, which is the right thing for an
 * event payload and the wrong thing to put in a killfeed. Callsigns are
 * assigned by index rather than drawn from the RNG, so the same bot is the
 * same name in every run and a capture stays reproducible.
 */

const CALLSIGNS = [
  'ALPHA',
  'BRAVO',
  'CHARLIE',
  'DELTA',
  'ECHO',
  'FOXTROT',
  'GOLF',
  'HOTEL',
  'INDIA',
  'JULIET',
  'KILO',
  'LIMA',
  'MIKE',
  'NOVEMBER',
  'OSCAR',
  'PAPA',
  'QUEBEC',
  'ROMEO',
  'SIERRA',
  'TANGO',
  'UNIFORM',
  'VICTOR',
  'WHISKEY',
  'XRAY',
  'YANKEE',
  'ZULU',
] as const;

export const PLAYER_NAME = 'YOU';

export function actorName(id: string | null): string {
  if (id === null || id === 'world') return 'WORLD';
  if (id === 'player' || id === PLAYER_NAME) return PLAYER_NAME;

  const match = /^bot-(\d+)$/.exec(id);
  if (!match) return id.toUpperCase();
  const index = Number(match[1]);
  const callsign = CALLSIGNS[index % CALLSIGNS.length] as string;
  // A roster larger than the alphabet numbers the repeats rather than
  // producing two bots with the same name.
  const wrap = Math.floor(index / CALLSIGNS.length);
  return wrap === 0 ? callsign : `${callsign}-${wrap + 1}`;
}
