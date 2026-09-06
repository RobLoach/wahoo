// ---------------------------------------------------------------------------
// Structured log events. The engine records WHAT happened; turning that into
// English lives in one place here, so richer rendering (or translations)
// never needs to re-parse strings.
// ---------------------------------------------------------------------------
import { PLAYER_NAMES } from './types.ts';
import type { Rank, Suit } from './types.ts';

export type LogEvent =
  | string // legacy: resumed saves from before events existed
  | { t: 'reshuffle' }
  | { t: 'deal'; round: number; dealer: number }
  | { t: 'play'; seat: number; rank: Rank; suit: Suit }
  | { t: 'spawn'; seat: number }
  | { t: 'home'; seat: number }
  | { t: 'stomp'; by: number; victim: number }
  | { t: 'swap'; seat: number; other: number }
  | { t: 'king'; seat: number; victim: number }
  | { t: 'flip'; seat: number; rank: Rank; suit: Suit }
  | { t: 'noflip' }
  | { t: 'fold'; seat: number }
  | { t: 'win'; team: number };

const P = PLAYER_NAMES;

export function formatLog(e: LogEvent): string {
  if (typeof e === 'string') return e;
  switch (e.t) {
    case 'reshuffle': return 'Discard pile reshuffled into a new draw pile.';
    case 'deal': return `Round ${e.round}: ${P[e.dealer]} deals.`;
    case 'play': return `${P[e.seat]} plays ${e.rank}${e.suit}.`;
    case 'spawn': return `${P[e.seat]} spawns a bunny.`;
    case 'home': return `${P[e.seat]} tucks a bunny into the burrow!`;
    case 'stomp': return `${P[e.by]} stomps ${P[e.victim]}'s bunny!`;
    case 'swap': return `${P[e.seat]} swaps with ${P[e.other]}.`;
    case 'king': return `${P[e.seat]} spawns with a King, stomping ${P[e.victim]}!`;
    case 'flip': return `${P[e.seat]} flips the ${e.rank}${e.suit}.`;
    case 'noflip': return 'The flipped card has no legal move.';
    case 'fold': return `${P[e.seat]} has no legal move and folds.`;
    case 'win': return `Team ${P[e.team]} & ${P[e.team + 2]} wins!`;
    default: return '';
  }
}
