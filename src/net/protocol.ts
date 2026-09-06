import { formatLog } from '../engine/log.ts';
import type { Bunny, Card, Difficulty, GameState, HouseRules, Move, MoveEffect } from '../engine/types.ts';
import { legalMoves } from '../engine/game.ts';

/** Everything a client is allowed to see, plus its legal moves when acting. */
export interface View {
  bunnies: Bunny[];
  handCounts: number[];
  folded: boolean[];
  /** Hand of the seat this client acts for (empty when spectating/CPU turn). */
  myHand: Card[];
  /** Seat this client is acting for right now, or null. */
  mySeat: number | null;
  current: number;
  dealer: number;
  round: number;
  pendingFlip: Card | null;
  drawCount: number;
  discardTop: Card | null;
  winner: number | null;
  log: string[];
  canAct: boolean;
  legal: Move[];
  seatNames: string[];
  /** Bunny movements from the last applied move, for animation. */
  effects: MoveEffect[];
  /** The most recent play (fold = discarded hand), for display. */
  lastPlay: { seat: number; card?: Card; desc?: string; bonus?: boolean; fold?: boolean } | null;
  stats: { stomps: number[]; folds: number[] };
  rules: HouseRules;
}

export function makeView(
  state: GameState,
  seat: number | null,
  seatNames: string[],
  canAct: boolean,
): View {
  return {
    bunnies: structuredClone(state.bunnies),
    handCounts: state.players.map(p => p.hand.length),
    folded: state.players.map(p => p.out),
    myHand: seat === null ? [] : structuredClone(state.players[seat].hand),
    mySeat: seat,
    current: state.current,
    dealer: state.dealer,
    round: state.round,
    pendingFlip: state.pendingFlip ? { ...state.pendingFlip } : null,
    drawCount: state.drawPile.length,
    discardTop: state.discard.length ? { ...state.discard[state.discard.length - 1] } : null,
    winner: state.winner,
    log: state.log.slice(-40).map(formatLog),
    canAct: canAct && state.winner === null,
    legal: canAct && state.winner === null ? structuredClone(legalMoves(state)) : [],
    seatNames,
    effects: structuredClone(state.effects),
    lastPlay: structuredClone(state.lastPlay),
    stats: structuredClone(state.stats),
    rules: { ...state.rules },
  };
}

// --- WebSocket messages -----------------------------------------------------

export type ClientMsg =
  | { t: 'create'; name: string; token?: string }
  | { t: 'join'; code: string; name: string; token?: string }
  | { t: 'sit'; seat: number }
  | { t: 'cpu'; seat: number; on: boolean; difficulty?: Difficulty }
  | { t: 'start'; rules?: Partial<HouseRules> }
  | { t: 'again' }
  | { t: 'rename'; name: string }
  | { t: 'rules'; rules?: Partial<HouseRules> }
  | { t: 'emote'; emoji: string }
  | { t: 'move'; move: Move };

export interface RoomInfo {
  code: string;
  seats: ({ name: string; cpu: boolean; difficulty?: Difficulty } | null)[];
  youAreHost: boolean;
  yourSeat: number | null;
  started: boolean;
  /** The host's chosen house rules for the upcoming game (lobby only). */
  rules?: HouseRules;
}

export type ServerMsg =
  | { t: 'room'; room: RoomInfo }
  | { t: 'state'; view: View }
  | { t: 'emote'; seat: number; emoji: string }
  | { t: 'err'; msg: string };

/** The reactions players may fling at each other. */
/** Reaction ids, drawn as bunnies by the client (see ui/emotes.ts). */
export const EMOTES = ['wahoo', 'lol', 'gasp', 'smug', 'finger'];
