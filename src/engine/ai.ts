import type { GameState, Move } from './types.ts';
import { TEAM_OF, TRACK_LEN } from './types.ts';
import { cloneState, applyMove, legalMoves } from './game.ts';

/**
 * Score a game state from `seat`'s team's perspective. Progress toward home
 * counts for both teams; bunnies in the burrow are worth a full lap plus a
 * safety bonus; bunnies in reserve are worth nothing.
 */
function evaluate(state: GameState, seat: number): number {
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

/** Pick a move for the current seat: greedy one-ply search with a tiny jitter. */
export function chooseMove(state: GameState, rand: () => number = Math.random): Move {
  const moves = legalMoves(state);
  if (moves.length === 1) return moves[0];
  const seat = state.current;
  let best = moves[0];
  let bestScore = -Infinity;
  for (const move of moves) {
    const sim = cloneState(state);
    try {
      applyMove(sim, move);
    } catch {
      continue;
    }
    let score = evaluate(sim, seat);
    // If this play leaves a flipped card pending, assume we resolve it well.
    if (sim.pendingFlip) {
      let flipBest = -Infinity;
      for (const flipMove of legalMoves(sim)) {
        const sim2 = cloneState(sim);
        try {
          applyMove(sim2, flipMove);
          flipBest = Math.max(flipBest, evaluate(sim2, seat));
        } catch {
          /* skip */
        }
      }
      if (flipBest > -Infinity) score = flipBest;
    }
    score += rand() * 0.5; // tie-break jitter so games vary
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  return best;
}
