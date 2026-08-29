import type {
  Bunny, BunnyPlace, Card, CardAction, GameState, Move, Rank, Suit,
} from './types.ts';
import {
  BURROW_SLOTS, HAND_SIZE, SPAWN_INDEX, TEAMMATE_OF, TRACK_LEN,
  PLAYER_NAMES,
} from './types.ts';

// ---------------------------------------------------------------------------
// RNG (mulberry32) — deterministic given a numeric seed, state kept in GameState
// ---------------------------------------------------------------------------

function nextRandom(state: GameState): number {
  state.rng = (state.rng + 0x6d2b79f5) | 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function shuffle<T>(state: GameState, arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom(state) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const RANKS: Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS: Suit[] = ['♠', '♥', '♦', '♣'];

export function buildDeck(): Card[] {
  const cards: Card[] = [];
  let id = 0;
  for (const suit of SUITS) for (const rank of RANKS) cards.push({ id: id++, rank, suit });
  return cards;
}

export function createGame(seed: number): GameState {
  const bunnies: Bunny[] = [];
  for (let p = 0; p < 4; p++) {
    for (let n = 0; n < 4; n++) {
      bunnies.push({ id: p * 4 + n, player: p, place: { kind: 'reserve' } });
    }
  }
  const state: GameState = {
    bunnies,
    players: [0, 1, 2, 3].map(() => ({ hand: [], out: false })),
    drawPile: buildDeck(),
    discard: [],
    dealer: 3, // so seat 0 (left of dealer) takes the first turn
    current: 0,
    pendingFlip: null,
    round: 0,
    turn: 0,
    winner: null,
    rng: seed | 0,
    log: [],
  };
  shuffle(state, state.drawPile);
  startRound(state);
  return state;
}

function drawCard(state: GameState): Card | null {
  if (state.drawPile.length === 0) {
    if (state.discard.length === 0) return null;
    state.drawPile = state.discard;
    state.discard = [];
    shuffle(state, state.drawPile);
    state.log.push('Discard pile reshuffled into a new draw pile.');
  }
  return state.drawPile.pop()!;
}

function startRound(state: GameState): void {
  state.round++;
  for (const p of state.players) p.out = false;
  for (let i = 0; i < HAND_SIZE; i++) {
    for (let s = 0; s < 4; s++) {
      const seat = (state.dealer + 1 + s) % 4;
      const card = drawCard(state);
      if (card) state.players[seat].hand.push(card);
    }
  }
  state.current = (state.dealer + 1) % 4;
  state.log.push(`Round ${state.round}: ${PLAYER_NAMES[state.dealer]} deals.`);
}

// ---------------------------------------------------------------------------
// Position helpers
// ---------------------------------------------------------------------------

/** Forward distance travelled from the owner's spawn space (0..79). */
export function distOf(bunny: Bunny): number {
  if (bunny.place.kind !== 'track') throw new Error('not on track');
  return (bunny.place.index - SPAWN_INDEX(bunny.player) + TRACK_LEN) % TRACK_LEN;
}

/** Minimal state slice needed for pure position queries (View satisfies it). */
export interface BunnyField { bunnies: Bunny[] }

export function bunnyAtTrack(state: BunnyField, index: number): Bunny | undefined {
  return state.bunnies.find(b => b.place.kind === 'track' && b.place.index === index);
}

function burrowSlotOccupied(state: BunnyField, player: number, slot: number): boolean {
  return state.bunnies.some(
    b => b.player === player && b.place.kind === 'burrow' && b.place.slot === slot,
  );
}

/** No jumping inside the burrow: every slot in [lo, hi] must be open. */
function burrowSlotsFree(state: BunnyField, player: number, lo: number, hi: number): boolean {
  for (let s = lo; s <= hi; s++) {
    if (burrowSlotOccupied(state, player, s)) return false;
  }
  return true;
}

export function allHome(state: GameState, player: number): boolean {
  return state.bunnies
    .filter(b => b.player === player)
    .every(b => b.place.kind === 'burrow');
}

/**
 * The player whose bunnies `seat` currently controls: their own, or their
 * teammate's once all four of their own bunnies are safely home.
 */
export function controlledPlayer(state: GameState, seat: number): number {
  return allHome(state, seat) ? TEAMMATE_OF(seat) : seat;
}

function reserveBunny(state: GameState, player: number): Bunny | undefined {
  return state.bunnies.find(b => b.player === player && b.place.kind === 'reserve');
}

// ---------------------------------------------------------------------------
// Legal move generation
// ---------------------------------------------------------------------------

/**
 * Destination of a forward move of `steps` for `bunny`, or null if illegal.
 * Track -> track always lands (stomping any occupant). Track -> burrow and
 * burrow -> burrow need an exact count, and no jumping: every burrow slot
 * passed through as well as the landing slot must be open.
 */
export function forwardDest(state: BunnyField, bunny: Bunny, steps: number): BunnyPlace | null {
  if (bunny.place.kind === 'track') {
    const total = distOf(bunny) + steps;
    if (total < TRACK_LEN) {
      return { kind: 'track', index: (bunny.place.index + steps) % TRACK_LEN };
    }
    const slot = total - TRACK_LEN;
    if (slot >= BURROW_SLOTS) return null; // overshoots the burrow
    if (!burrowSlotsFree(state, bunny.player, 0, slot)) return null;
    return { kind: 'burrow', slot };
  }
  if (bunny.place.kind === 'burrow') {
    const slot = bunny.place.slot + steps;
    if (slot >= BURROW_SLOTS) return null;
    if (!burrowSlotsFree(state, bunny.player, bunny.place.slot + 1, slot)) return null;
    return { kind: 'burrow', slot };
  }
  return null;
}

/** Destinations for a backward-4: the wrapped track space, plus the burrow slot when reachable. */
export function backwardDests(state: BunnyField, bunny: Bunny): { toBurrow: boolean; place: BunnyPlace }[] {
  if (bunny.place.kind !== 'track') return [];
  const out: { toBurrow: boolean; place: BunnyPlace }[] = [
    { toBurrow: false, place: { kind: 'track', index: (bunny.place.index - 4 + TRACK_LEN) % TRACK_LEN } },
  ];
  const d = distOf(bunny);
  if (d <= 3 && burrowSlotsFree(state, bunny.player, 0, 3 - d)) {
    out.push({ toBurrow: true, place: { kind: 'burrow', slot: 3 - d } });
  }
  return out;
}

function forwardActions(state: GameState, ctrl: number, steps: number): CardAction[] {
  const out: CardAction[] = [];
  for (const b of state.bunnies) {
    if (b.player !== ctrl || b.place.kind === 'reserve') continue;
    if (forwardDest(state, b, steps)) out.push({ kind: 'forward', bunny: b.id, steps });
  }
  return out;
}

function spawnAction(state: GameState, ctrl: number): CardAction[] {
  return reserveBunny(state, ctrl) ? [{ kind: 'spawn' }] : [];
}

function backwardActions(state: GameState, ctrl: number): CardAction[] {
  const out: CardAction[] = [];
  for (const b of state.bunnies) {
    if (b.player !== ctrl || b.place.kind !== 'track') continue;
    // Wrapping backward around the track is always possible (stomps occupant).
    out.push({ kind: 'backward', bunny: b.id, toBurrow: false });
    // Backing across the burrow entrance: from distance d (0..3), four steps
    // back cross the entrance and reach slot 3-d through open slots only.
    const d = distOf(b);
    if (d <= 3 && burrowSlotsFree(state, ctrl, 0, 3 - d)) {
      out.push({ kind: 'backward', bunny: b.id, toBurrow: true });
    }
  }
  return out;
}

/** Enumerate valid 7-splits (deduplicated by their part multiset). */
function sevenActions(state: GameState, ctrl: number): CardAction[] {
  const movable = state.bunnies.filter(
    b => b.player === ctrl && b.place.kind === 'track',
  );
  const results: CardAction[] = [];
  const seen = new Set<string>();

  const recurse = (sim: GameState, remaining: number, used: number[], parts: { bunny: number; steps: number }[]) => {
    if (remaining === 0) {
      const key = parts
        .map(p => `${p.bunny}:${p.steps}`)
        .sort()
        .join(',');
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ kind: 'seven', parts: parts.map(p => ({ ...p })) });
      }
      return;
    }
    for (const b of movable) {
      if (used.includes(b.id)) continue;
      const simBunny = sim.bunnies.find(x => x.id === b.id)!;
      if (simBunny.place.kind !== 'track') continue; // got stomped mid-split
      for (let steps = 1; steps <= remaining; steps++) {
        const dest = forwardDest(sim, simBunny, steps);
        if (!dest) continue;
        const next = cloneState(sim);
        moveBunnyTo(next, b.id, dest);
        recurse(next, remaining - steps, [...used, b.id], [...parts, { bunny: b.id, steps }]);
      }
    }
  };

  recurse(cloneState(state), 7, [], []);
  return results;
}

function swapActions(state: GameState, ctrl: number): CardAction[] {
  const mine = state.bunnies.filter(b => b.player === ctrl && b.place.kind === 'track');
  const others = state.bunnies.filter(b => b.player !== ctrl && b.place.kind === 'track');
  const out: CardAction[] = [];
  for (const m of mine) for (const o of others) out.push({ kind: 'swap', bunny: m.id, other: o.id });
  return out;
}

function kingSpawnActions(state: GameState, ctrl: number): CardAction[] {
  if (!reserveBunny(state, ctrl)) return [];
  // Any other player's track bunny may be stomped — teammates included.
  return state.bunnies
    .filter(b => b.player !== ctrl && b.place.kind === 'track')
    .map(b => ({ kind: 'kingSpawn', target: b.id }) as CardAction);
}

/** All legal actions for a given card rank, for the acting seat. */
export function actionsForCard(state: GameState, seat: number, rank: Rank): CardAction[] {
  const ctrl = controlledPlayer(state, seat);
  switch (rank) {
    case 'A':
      return [...spawnAction(state, ctrl), ...forwardActions(state, ctrl, 1)];
    case '2':
      return [...spawnAction(state, ctrl), ...forwardActions(state, ctrl, 2)];
    case '4':
      return backwardActions(state, ctrl);
    case '7':
      return sevenActions(state, ctrl);
    case 'J':
      return swapActions(state, ctrl);
    case 'Q':
      return forwardActions(state, ctrl, 12);
    case 'K':
      return [...kingSpawnActions(state, ctrl), ...forwardActions(state, ctrl, 13)];
    default:
      return forwardActions(state, ctrl, parseInt(rank, 10));
  }
}

/** Every legal move for the seat currently to act. */
export function legalMoves(state: GameState): Move[] {
  if (state.winner !== null) return [];
  const seat = state.current;
  if (state.pendingFlip) {
    return actionsForCard(state, seat, state.pendingFlip.rank).map(
      action => ({ type: 'flip', action }) as Move,
    );
  }
  const moves: Move[] = [];
  for (const card of state.players[seat].hand) {
    for (const action of actionsForCard(state, seat, card.rank)) {
      moves.push({ type: 'play', card: card.id, action });
    }
  }
  if (moves.length === 0) return [{ type: 'discardHand' }];
  return moves;
}

// ---------------------------------------------------------------------------
// Applying moves
// ---------------------------------------------------------------------------

export function cloneState(state: GameState): GameState {
  return structuredClone(state);
}

function stompAt(state: GameState, index: number, mover: Bunny): void {
  const victim = bunnyAtTrack(state, index);
  if (victim && victim.id !== mover.id) {
    victim.place = { kind: 'reserve' };
    state.log.push(
      `${PLAYER_NAMES[mover.player]} stomps ${PLAYER_NAMES[victim.player]}'s bunny!`,
    );
  }
}

function moveBunnyTo(state: GameState, bunnyId: number, dest: BunnyPlace): void {
  const bunny = state.bunnies.find(b => b.id === bunnyId)!;
  if (dest.kind === 'track') stompAt(state, dest.index, bunny);
  bunny.place = dest;
}

function applyAction(state: GameState, seat: number, action: CardAction): void {
  const ctrl = controlledPlayer(state, seat);
  const name = PLAYER_NAMES[ctrl];
  switch (action.kind) {
    case 'spawn': {
      const bunny = reserveBunny(state, ctrl);
      if (!bunny) throw new Error('no bunny in reserve');
      moveBunnyTo(state, bunny.id, { kind: 'track', index: SPAWN_INDEX(ctrl) });
      state.log.push(`${name} spawns a bunny.`);
      break;
    }
    case 'forward': {
      const bunny = state.bunnies.find(b => b.id === action.bunny)!;
      if (bunny.player !== ctrl) throw new Error('not your bunny');
      const dest = forwardDest(state, bunny, action.steps);
      if (!dest) throw new Error('illegal forward move');
      moveBunnyTo(state, bunny.id, dest);
      if (dest.kind === 'burrow') state.log.push(`${name} tucks a bunny into the burrow!`);
      break;
    }
    case 'backward': {
      const bunny = state.bunnies.find(b => b.id === action.bunny)!;
      if (bunny.player !== ctrl) throw new Error('not your bunny');
      if (bunny.place.kind !== 'track') throw new Error('bunny not on track');
      if (action.toBurrow) {
        const d = distOf(bunny);
        if (d > 3 || !burrowSlotsFree(state, bunny.player, 0, 3 - d)) {
          throw new Error('illegal backward burrow entry');
        }
        moveBunnyTo(state, bunny.id, { kind: 'burrow', slot: 3 - d });
        state.log.push(`${name} backs a bunny into the burrow!`);
      } else {
        const index = (bunny.place.index - 4 + TRACK_LEN) % TRACK_LEN;
        moveBunnyTo(state, bunny.id, { kind: 'track', index });
      }
      break;
    }
    case 'seven': {
      const total = action.parts.reduce((s, p) => s + p.steps, 0);
      if (total !== 7 || action.parts.some(p => p.steps < 1)) {
        throw new Error('seven must split exactly 7 forward steps');
      }
      const ids = action.parts.map(p => p.bunny);
      if (new Set(ids).size !== ids.length) throw new Error('seven parts must use distinct bunnies');
      for (const part of action.parts) {
        const bunny = state.bunnies.find(b => b.id === part.bunny)!;
        if (bunny.player !== ctrl || bunny.place.kind !== 'track') {
          throw new Error('seven may only move your active track bunnies');
        }
        const dest = forwardDest(state, bunny, part.steps);
        if (!dest) throw new Error('illegal seven part');
        moveBunnyTo(state, bunny.id, dest);
      }
      break;
    }
    case 'swap': {
      const a = state.bunnies.find(b => b.id === action.bunny)!;
      const b = state.bunnies.find(x => x.id === action.other)!;
      if (a.place.kind !== 'track' || b.place.kind !== 'track') {
        throw new Error('swap requires both bunnies on the track');
      }
      if (a.player !== ctrl) throw new Error('must swap one of your own bunnies');
      const tmp = a.place;
      a.place = b.place;
      b.place = tmp;
      state.log.push(`${name} swaps with ${PLAYER_NAMES[b.player]}.`);
      break;
    }
    case 'kingSpawn': {
      const target = state.bunnies.find(b => b.id === action.target)!;
      if (target.place.kind !== 'track' || target.player === ctrl) {
        throw new Error('king spawn must stomp another player\'s track bunny');
      }
      const bunny = reserveBunny(state, ctrl);
      if (!bunny) throw new Error('no bunny in reserve');
      const index = target.place.index;
      target.place = { kind: 'reserve' };
      state.bunnies.find(b => b.id === bunny.id)!.place = { kind: 'track', index };
      state.log.push(`${name} spawns with a King, stomping ${PLAYER_NAMES[target.player]}!`);
      break;
    }
  }
}

function checkWinner(state: GameState): void {
  for (const team of [0, 1]) {
    if (allHome(state, team) && allHome(state, team + 2)) {
      state.winner = team;
      state.log.push(
        `Team ${PLAYER_NAMES[team]} & ${PLAYER_NAMES[team + 2]} wins!`,
      );
    }
  }
}

/** After a 2 resolves: flip the top draw card; if playable, it becomes pending. */
function flipBonus(state: GameState, seat: number): void {
  const card = drawCard(state);
  if (!card) return;
  state.log.push(`${PLAYER_NAMES[seat]} flips the ${card.rank}${card.suit}.`);
  if (actionsForCard(state, seat, card.rank).length > 0) {
    state.pendingFlip = card;
  } else {
    state.discard.push(card);
    state.log.push('The flipped card has no legal move.');
  }
}

function advanceTurn(state: GameState): void {
  if (state.winner !== null || state.pendingFlip) return;
  state.turn++;
  for (let s = 1; s <= 4; s++) {
    const seat = (state.current + s) % 4;
    if (state.players[seat].hand.length > 0 && !state.players[seat].out) {
      state.current = seat;
      return;
    }
  }
  // Every hand is empty or folded: the round ends.
  for (const p of state.players) {
    state.discard.push(...p.hand);
    p.hand = [];
  }
  state.dealer = (state.dealer + 1) % 4;
  startRound(state);
}

/** Validate and apply a move for the current seat. Mutates and returns state. */
export function applyMove(state: GameState, move: Move): GameState {
  if (state.winner !== null) throw new Error('game is over');
  const seat = state.current;

  if (move.type === 'discardHand') {
    if (state.pendingFlip) throw new Error('must resolve the flipped card');
    const player = state.players[seat];
    state.discard.push(...player.hand);
    player.hand = [];
    player.out = true;
    state.log.push(`${PLAYER_NAMES[seat]} has no legal move and folds.`);
    advanceTurn(state);
    return state;
  }

  if (move.type === 'flip') {
    const card = state.pendingFlip;
    if (!card) throw new Error('no pending flipped card');
    state.pendingFlip = null;
    state.discard.push(card);
    applyAction(state, seat, move.action);
    checkWinner(state);
    if (state.winner === null && card.rank === '2') flipBonus(state, seat);
    advanceTurn(state);
    return state;
  }

  // move.type === 'play'
  if (state.pendingFlip) throw new Error('must resolve the flipped card first');
  const player = state.players[seat];
  const idx = player.hand.findIndex(c => c.id === move.card);
  if (idx === -1) throw new Error('card not in hand');
  const card = player.hand[idx];
  player.hand.splice(idx, 1);
  state.discard.push(card);
  state.log.push(`${PLAYER_NAMES[seat]} plays ${card.rank}${card.suit}.`);
  applyAction(state, seat, move.action);
  checkWinner(state);
  if (state.winner === null && card.rank === '2') flipBonus(state, seat);
  advanceTurn(state);
  return state;
}
