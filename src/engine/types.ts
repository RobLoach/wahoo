export type Rank =
  | 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10'
  | 'J' | 'Q' | 'K';
export type Suit = '♠' | '♥' | '♦' | '♣';

export interface Card {
  id: number; // unique 0..51
  rank: Rank;
  suit: Suit;
}

export type BunnyPlace =
  | { kind: 'reserve' }
  | { kind: 'track'; index: number } // absolute track index 0..79
  | { kind: 'burrow'; slot: number }; // 0 = shallowest, 3 = deepest

export interface Bunny {
  id: number; // player * 4 + n
  player: number; // owner seat 0..3
  place: BunnyPlace;
}

export interface PlayerState {
  hand: Card[];
  /** True if the player discarded their hand and sits out the rest of the round. */
  out: boolean;
}

/** How one bunny moved during the last applied move (drives UI animation). */
export interface MoveEffect {
  bunny: number;
  from: BunnyPlace;
  to: BunnyPlace;
  /** forward/backward hop along the track; jump = teleport (spawn, swap, king); stomped = sent home. */
  kind: 'forward' | 'backward' | 'jump' | 'stomped';
}

/** A concrete effect chosen for a card. */
export type CardAction =
  | { kind: 'spawn' } // A or 2: reserve -> Position 1
  | { kind: 'forward'; bunny: number; steps: number }
  | { kind: 'backward'; bunny: number } // 4: four spaces back along the track
  | { kind: 'seven'; parts: { bunny: number; steps: number }[] }
  | { kind: 'swap'; bunny: number; other: number } // J
  | { kind: 'kingSpawn'; target: number }; // K: spawn from reserve onto another player's bunny, stomping it

export type Move =
  | { type: 'play'; card: number; action: CardAction } // card = card id in hand
  | { type: 'flip'; action: CardAction } // resolve a pending flipped card
  | { type: 'discardHand' }; // no legal card play: fold for the round

export interface GameState {
  bunnies: Bunny[]; // 16
  players: PlayerState[]; // 4
  drawPile: Card[]; // top = last element
  discard: Card[];
  dealer: number;
  current: number; // seat to act
  /** Set while a flipped card (from a played 2) awaits resolution by `current`. */
  pendingFlip: Card | null;
  round: number;
  turn: number;
  winner: number | null; // team 0 (seats 0&2) or 1 (seats 1&3)
  rng: number; // mulberry32 state, used for reshuffles
  log: import('./log.ts').LogEvent[];
  /** Bunny movements caused by the most recently applied move. */
  effects: MoveEffect[];
  /** The most recent play (bonus = flipped by a 2; fold = discarded hand). */
  lastPlay: { seat: number; card?: Card; desc?: string; bonus?: boolean; fold?: boolean } | null;
  /** Running tallies per seat, for the victory screen. */
  stats: { stomps: number[]; folds: number[] };
  /** The variants this game was started with. */
  rules: HouseRules;
}

/** Optional variants the host can toggle before a game starts. */
export interface HouseRules {
  /** May you stomp your own team — by landing on them or King-spawning onto them? */
  friendlyFire: boolean;
  /** How many bunnies a 7 may split across. */
  sevenMaxBunnies: 1 | 2 | 4;
  /** May bunnies jump over occupied burrow slots? */
  burrowJump: boolean;
  /** Table manners, not gameplay: is the finger reaction allowed at this table? */
  finger: boolean;
}

export const DEFAULT_RULES: HouseRules = {
  friendlyFire: true,
  sevenMaxBunnies: 2,
  burrowJump: false,
  finger: true,
};

export const TRACK_LEN = 80;
export const SIDE_LEN = 20;
export const BURROW_SLOTS = 4;
export const HAND_SIZE = 4;

/**
 * CPU strength: easy always picks the worst move, medium picks randomly,
 * hard greedily picks the best, insane also anticipates the next player's reply.
 */
export type Difficulty = 'easy' | 'medium' | 'hard' | 'insane';

export const PLAYER_NAMES = ['Red', 'Blue', 'Green', 'Yellow'];
export const TEAM_OF = (seat: number) => seat % 2;
export const TEAMMATE_OF = (seat: number) => (seat + 2) % 4;
export const SPAWN_INDEX = (seat: number) => seat * SIDE_LEN;
