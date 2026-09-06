import type {
  Bunny, BunnyPlace, Card, CardAction, GameState, HouseRules, Move, MoveEffect, Rank, Suit,
} from './types.ts';
import {
  BURROW_SLOTS, DEFAULT_RULES, HAND_SIZE, SPAWN_INDEX, TEAM_OF, TEAMMATE_OF, TRACK_LEN,
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

export function createGame(seed: number, rules?: Partial<HouseRules>): GameState {
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
    effects: [],
    lastPlay: null,
    stats: { stomps: [0, 0, 0, 0], folds: [0, 0, 0, 0] },
    rules: { ...DEFAULT_RULES, ...rules },
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
    state.log.push({ t: 'reshuffle' });
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
  state.log.push({ t: 'deal', round: state.round, dealer: state.dealer });
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
export interface BunnyField { bunnies: Bunny[]; rules?: HouseRules }

function rulesOf(state: BunnyField): HouseRules {
  return state.rules ?? DEFAULT_RULES;
}

/** With friendly fire off, landing on your own team's bunny is illegal. */
function landingBlocked(state: BunnyField, mover: Bunny, index: number): boolean {
  if (rulesOf(state).friendlyFire) return false;
  const occupant = bunnyAtTrack(state, index);
  return occupant !== undefined && occupant.id !== mover.id &&
    TEAM_OF(occupant.player) === TEAM_OF(mover.player);
}

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
  const jump = rulesOf(state).burrowJump;
  if (bunny.place.kind === 'track') {
    const total = distOf(bunny) + steps;
    if (total < TRACK_LEN) {
      const index = (bunny.place.index + steps) % TRACK_LEN;
      if (landingBlocked(state, bunny, index)) return null;
      return { kind: 'track', index };
    }
    const slot = total - TRACK_LEN;
    if (slot >= BURROW_SLOTS) return null; // overshoots the burrow
    if (!burrowSlotsFree(state, bunny.player, jump ? slot : 0, slot)) return null;
    return { kind: 'burrow', slot };
  }
  if (bunny.place.kind === 'burrow') {
    const slot = bunny.place.slot + steps;
    if (slot >= BURROW_SLOTS) return null;
    if (!burrowSlotsFree(state, bunny.player, jump ? slot : bunny.place.slot + 1, slot)) return null;
    return { kind: 'burrow', slot };
  }
  return null;
}

/** Destination of a backward-4: four spaces back along the track (never the burrow). */
export function backwardDest(state: BunnyField, bunny: Bunny): BunnyPlace | null {
  if (bunny.place.kind !== 'track') return null;
  const index = (bunny.place.index - 4 + TRACK_LEN) % TRACK_LEN;
  if (landingBlocked(state, bunny, index)) return null;
  return { kind: 'track', index };
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
  const bunny = reserveBunny(state, ctrl);
  if (!bunny) return [];
  if (landingBlocked(state, bunny, SPAWN_INDEX(ctrl))) return [];
  return [{ kind: 'spawn' }];
}

function backwardActions(state: GameState, ctrl: number): CardAction[] {
  // Moving backward stays on the track (stomping any occupant); the burrow is
  // only entered by completing a lap forward.
  return state.bunnies
    .filter(b => b.player === ctrl && b.place.kind === 'track' && backwardDest(state, b) !== null)
    .map(b => ({ kind: 'backward', bunny: b.id }) as CardAction);
}

/** Enumerate valid 7-splits (deduplicated by their part multiset). */
function sevenActions(state: GameState, ctrl: number): CardAction[] {
  // Track AND burrow bunnies: part of a 7 may shuffle a bunny deeper into
  // the burrow (exact-count and no-jumping rules still apply).
  const movable = state.bunnies.filter(
    b => b.player === ctrl && b.place.kind !== 'reserve',
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
    if (used.length >= rulesOf(state).sevenMaxBunnies) return;
    for (const b of movable) {
      if (used.includes(b.id)) continue;
      const simBunny = sim.bunnies.find(x => x.id === b.id)!;
      if (simBunny.place.kind === 'reserve') continue; // got stomped mid-split
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
  // Spawn from reserve onto any other player's track bunny (teammates only
  // when friendly fire is on).
  const rules = rulesOf(state);
  return state.bunnies
    .filter(
      b =>
        b.player !== ctrl &&
        b.place.kind === 'track' &&
        (rules.friendlyFire || TEAM_OF(b.player) !== TEAM_OF(ctrl)),
    )
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
    state.effects.push({
      bunny: victim.id, from: victim.place, to: { kind: 'reserve' }, kind: 'stomped',
    });
    state.stats.stomps[mover.player]++;
    victim.place = { kind: 'reserve' };
    state.log.push({ t: 'stomp', by: mover.player, victim: victim.player });
  }
}

function moveBunnyTo(
  state: GameState,
  bunnyId: number,
  dest: BunnyPlace,
  kind: MoveEffect['kind'] = 'jump',
): void {
  const bunny = state.bunnies.find(b => b.id === bunnyId)!;
  if (dest.kind === 'track') stompAt(state, dest.index, bunny);
  state.effects.push({ bunny: bunny.id, from: bunny.place, to: dest, kind });
  bunny.place = dest;
}

function applyAction(state: GameState, seat: number, action: CardAction): void {
  const ctrl = controlledPlayer(state, seat);
  switch (action.kind) {
    case 'spawn': {
      const bunny = reserveBunny(state, ctrl);
      if (!bunny) throw new Error('no bunny in reserve');
      if (landingBlocked(state, bunny, SPAWN_INDEX(ctrl))) {
        throw new Error('a teammate holds your spawn space');
      }
      moveBunnyTo(state, bunny.id, { kind: 'track', index: SPAWN_INDEX(ctrl) }, 'jump');
      state.log.push({ t: 'spawn', seat: ctrl });
      break;
    }
    case 'forward': {
      const bunny = state.bunnies.find(b => b.id === action.bunny)!;
      if (bunny.player !== ctrl) throw new Error('not your bunny');
      const dest = forwardDest(state, bunny, action.steps);
      if (!dest) throw new Error('illegal forward move');
      moveBunnyTo(state, bunny.id, dest, 'forward');
      if (dest.kind === 'burrow') state.log.push({ t: 'home', seat: ctrl });
      break;
    }
    case 'backward': {
      const bunny = state.bunnies.find(b => b.id === action.bunny)!;
      if (bunny.player !== ctrl) throw new Error('not your bunny');
      const dest = backwardDest(state, bunny);
      if (!dest) throw new Error('illegal backward move');
      moveBunnyTo(state, bunny.id, dest, 'backward');
      break;
    }
    case 'seven': {
      const total = action.parts.reduce((s, p) => s + p.steps, 0);
      if (total !== 7 || action.parts.some(p => p.steps < 1)) {
        throw new Error('seven must split exactly 7 forward steps');
      }
      const ids = action.parts.map(p => p.bunny);
      if (new Set(ids).size !== ids.length) throw new Error('seven parts must use distinct bunnies');
      if (ids.length > rulesOf(state).sevenMaxBunnies) {
        throw new Error('seven split across too many bunnies');
      }
      for (const part of action.parts) {
        const bunny = state.bunnies.find(b => b.id === part.bunny)!;
        if (bunny.player !== ctrl || bunny.place.kind === 'reserve') {
          throw new Error('seven may only move your active bunnies');
        }
        const dest = forwardDest(state, bunny, part.steps);
        if (!dest) throw new Error('illegal seven part');
        moveBunnyTo(state, bunny.id, dest, 'forward');
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
      state.effects.push({ bunny: a.id, from: a.place, to: b.place, kind: 'jump' });
      state.effects.push({ bunny: b.id, from: b.place, to: tmp, kind: 'jump' });
      a.place = b.place;
      b.place = tmp;
      state.log.push({ t: 'swap', seat: ctrl, other: b.player });
      break;
    }
    case 'kingSpawn': {
      const target = state.bunnies.find(b => b.id === action.target)!;
      if (target.place.kind !== 'track' || target.player === ctrl) {
        throw new Error('king must stomp another player\'s track bunny');
      }
      if (!rulesOf(state).friendlyFire && TEAM_OF(target.player) === TEAM_OF(ctrl)) {
        throw new Error('friendly fire is off: king cannot stomp a teammate');
      }
      const bunny = reserveBunny(state, ctrl);
      if (!bunny) throw new Error('no bunny in reserve');
      const index = target.place.index;
      state.stats.stomps[ctrl]++;
      state.effects.push({ bunny: target.id, from: target.place, to: { kind: 'reserve' }, kind: 'stomped' });
      state.effects.push({ bunny: bunny.id, from: bunny.place, to: { kind: 'track', index }, kind: 'jump' });
      target.place = { kind: 'reserve' };
      bunny.place = { kind: 'track', index };
      state.log.push({ t: 'king', seat: ctrl, victim: target.player });
      break;
    }
  }
}

/**
 * A human-readable summary of what a card play is about to do, computed
 * against the pre-move state (so stomp victims are still on their spaces).
 */
function describeAction(state: GameState, seat: number, action: CardAction): string {
  try {
    const ctrl = controlledPlayer(state, seat);
    const whose = ctrl === seat ? 'a bunny' : `${PLAYER_NAMES[ctrl]}'s bunny`;
    const victimAt = (index: number): string | null => {
      const v = bunnyAtTrack(state, index);
      return v ? PLAYER_NAMES[v.player] : null;
    };
    switch (action.kind) {
      case 'spawn': {
        const v = victimAt(SPAWN_INDEX(ctrl));
        return `brought ${whose} out of the reserve${v ? `, stomping ${v}` : ''}`;
      }
      case 'forward': {
        const bunny = state.bunnies.find(b => b.id === action.bunny)!;
        const dest = forwardDest(state, bunny, action.steps);
        if (dest?.kind === 'burrow') {
          return `moved ${whose} ${action.steps} forward, into the burrow!`;
        }
        const v = dest?.kind === 'track' ? victimAt(dest.index) : null;
        return `moved ${whose} ${action.steps} forward${v ? `, stomping ${v}` : ''}`;
      }
      case 'backward': {
        const bunny = state.bunnies.find(b => b.id === action.bunny)!;
        const dest = backwardDest(state, bunny);
        const v = dest?.kind === 'track' ? victimAt(dest.index) : null;
        return `moved ${whose} 4 backward${v ? `, stomping ${v}` : ''}`;
      }
      case 'seven': {
        if (action.parts.length === 1) return `moved ${whose} all 7 forward`;
        const [a, b] = action.parts;
        return `split the 7 (${a.steps}+${b.steps}) between two bunnies`;
      }
      case 'swap': {
        const other = state.bunnies.find(b => b.id === action.other)!;
        return `swapped ${whose} with ${PLAYER_NAMES[other.player]}'s bunny`;
      }
      case 'kingSpawn': {
        const target = state.bunnies.find(b => b.id === action.target)!;
        return `spawned from the reserve onto ${PLAYER_NAMES[target.player]}, stomping them!`;
      }
    }
  } catch {
    /* invalid actions get validated (and rejected) in applyAction */
  }
  return 'played';
}

function checkWinner(state: GameState): void {
  for (const team of [0, 1]) {
    if (allHome(state, team) && allHome(state, team + 2)) {
      state.winner = team;
      state.log.push({ t: 'win', team });
    }
  }
}

/** After a 2 resolves: flip the top draw card; if playable, it becomes pending. */
function flipBonus(state: GameState, seat: number): void {
  const card = drawCard(state);
  if (!card) return;
  state.log.push({ t: 'flip', seat, rank: card.rank, suit: card.suit });
  if (actionsForCard(state, seat, card.rank).length > 0) {
    state.pendingFlip = card;
  } else {
    state.discard.push(card);
    state.log.push({ t: 'noflip' });
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
  state.effects = [];
  const seat = state.current;

  if (move.type === 'discardHand') {
    if (state.pendingFlip) throw new Error('must resolve the flipped card');
    const player = state.players[seat];
    state.discard.push(...player.hand);
    player.hand = [];
    player.out = true;
    state.stats.folds[seat]++;
    state.lastPlay = { seat, fold: true };
    state.log.push({ t: 'fold', seat });
    advanceTurn(state);
    return state;
  }

  if (move.type === 'flip') {
    const card = state.pendingFlip;
    if (!card) throw new Error('no pending flipped card');
    state.pendingFlip = null;
    state.discard.push(card);
    state.lastPlay = {
      seat, card: { ...card }, desc: describeAction(state, seat, move.action), bonus: true,
    };
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
  state.lastPlay = { seat, card: { ...card }, desc: describeAction(state, seat, move.action) };
  state.log.push({ t: 'play', seat, rank: card.rank, suit: card.suit });
  applyAction(state, seat, move.action);
  checkWinner(state);
  if (state.winner === null && card.rank === '2') flipBonus(state, seat);
  advanceTurn(state);
  return state;
}
