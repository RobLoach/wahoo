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
  log: string[];
}

export const TRACK_LEN = 80;
export const SIDE_LEN = 20;
export const BURROW_SLOTS = 4;
export const HAND_SIZE = 4;

export const PLAYER_NAMES = ['Red', 'Blue', 'Green', 'Yellow'];
export const TEAM_OF = (seat: number) => seat % 2;
export const TEAMMATE_OF = (seat: number) => (seat + 2) % 4;
export const SPAWN_INDEX = (seat: number) => seat * SIDE_LEN;
