import type { Difficulty, GameState, Move } from './types.ts';
import { TEAM_OF, TRACK_LEN } from './types.ts';
import { cloneState, applyMove, legalMoves } from './game.ts';

/**
 * Score a game state from `seat`'s team's perspective. Progress toward home
 * counts for both teams; bunnies in the burrow are worth a full lap plus a
 * safety bonus; bunnies in reserve are worth nothing.
 */
export function evaluate(state: GameState, seat: number): number {
  const myTeam = TEAM_OF(seat);
  let score = 0;
  for (const bunny of state.bunnies) {
    let value = 0;
    if (bunny.place.kind === 'track') {
      const dist = (bunny.place.index - bunny.player * 20 + TRACK_LEN) % TRACK_LEN;
      value = 8 + dist; // being on the board at all beats reserve
    } else if (bunny.place.kind === 'burrow') {
      value = TRACK_LEN + 40 + bunny.place.slot;
    }
    score += TEAM_OF(bunny.player) === myTeam ? value : -value;
  }
  if (state.winner !== null) score += state.winner === myTeam ? 10000 : -10000;
  return score;
}

/**
 * Pick a move for the current seat.
 * - hard: one-ply greedy for the best evaluation (tiny jitter so games vary)
 * - medium: a uniformly random legal move
 * - easy: the worst-evaluated legal move, every time
 */
export function chooseMove(
  state: GameState,
  difficulty: Difficulty = 'hard',
  rand: () => number = Math.random,
): Move {
  const moves = legalMoves(state);
  if (moves.length === 1) return moves[0];
  if (difficulty === 'medium') {
    return moves[Math.min(moves.length - 1, Math.floor(rand() * moves.length))];
  }

  const sign = difficulty === 'hard' ? 1 : -1; // easy maximizes the negated score
  const seat = state.current;
  let best = moves[0];
  let bestValue = -Infinity;
  for (const move of moves) {
    const sim = cloneState(state);
    try {
      applyMove(sim, move);
    } catch {
      continue;
    }
    let value = sign * evaluate(sim, seat);
    // If this play leaves a flipped card pending, assume we resolve it in the
    // same spirit (well for hard, poorly for easy).
    if (sim.pendingFlip) {
      let flipBest = -Infinity;
      for (const flipMove of legalMoves(sim)) {
        const sim2 = cloneState(sim);
        try {
          applyMove(sim2, flipMove);
          flipBest = Math.max(flipBest, sign * evaluate(sim2, seat));
        } catch {
          /* skip */
        }
      }
      if (flipBest > -Infinity) value = flipBest;
    }
    value += rand() * 0.5; // tie-break jitter so games vary
    if (value > bestValue) {
      bestValue = value;
      best = move;
    }
  }
  return best;
}
