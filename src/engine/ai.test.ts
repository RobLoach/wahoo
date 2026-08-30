import { describe, expect, it } from 'vitest';
import { applyMove, buildDeck, createGame } from './game.ts';
import { chooseMove, evaluate } from './ai.ts';
import type { Difficulty, GameState } from './types.ts';

function put(state: GameState, id: number, place: GameState['bunnies'][0]['place']) {
  state.bunnies.find(b => b.id === id)!.place = structuredClone(place);
}

function giveHand(state: GameState, seat: number, ranks: string[]) {
  const deck = buildDeck();
  state.players[seat].hand = ranks.map((rank, i) => ({
    ...deck.filter(c => c.rank === rank)[i % 4],
  }));
}

/** Deterministic RNG so AI decisions are reproducible in tests. */
function seededRand(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A forced choice: bunny 0 can enter the burrow (a huge evaluation gain),
 * bunny 1 can only inch forward on the track.
 */
function burrowOrCrawl(): GameState {
  const g = createGame(100);
  g.current = 0;
  put(g, 0, { kind: 'track', index: 77 }); // distance 77: a 3 reaches slot 0
  put(g, 1, { kind: 'track', index: 10 });
  giveHand(g, 0, ['3']);
  return g;
}

describe('difficulty levels', () => {
  it('hard picks the best move (burrow entry)', () => {
    const g = burrowOrCrawl();
    const move = chooseMove(g, 'hard', () => 0);
    expect(move).toMatchObject({ type: 'play', action: { kind: 'forward', bunny: 0 } });
    applyMove(g, move);
    expect(g.bunnies[0].place).toEqual({ kind: 'burrow', slot: 0 });
  });

  it('easy picks the worst move (skips the burrow)', () => {
    const g = burrowOrCrawl();
    const move = chooseMove(g, 'easy', () => 0);
    expect(move).toMatchObject({ type: 'play', action: { kind: 'forward', bunny: 1 } });
  });

  it('easy would rather stomp its own teammate than help it', () => {
    const g = createGame(101);
    g.current = 0;
    put(g, 0, { kind: 'track', index: 5 });
    put(g, 8, { kind: 'track', index: 8 }); // teammate 3 ahead
    giveHand(g, 0, ['3']);
    // Moving lands exactly on the teammate: the only move, wiping out its progress.
    // Give an alternative: a second bunny far from anyone.
    put(g, 1, { kind: 'track', index: 40 });
    const move = chooseMove(g, 'easy', () => 0);
    expect(move).toMatchObject({ action: { kind: 'forward', bunny: 0 } });
  });

  it('medium picks uniformly at random from legal moves', () => {
    const g = burrowOrCrawl();
    const first = chooseMove(g, 'medium', () => 0);
    const last = chooseMove(g, 'medium', () => 0.999);
    expect(first).not.toEqual(last);
  });

  it('evaluate favors burrowed bunnies over track progress', () => {
    const a = createGame(102);
    put(a, 0, { kind: 'burrow', slot: 0 });
    const b = createGame(102);
    put(b, 0, { kind: 'track', index: 79 }); // distance 79, one step from home
    expect(evaluate(a, 0)).toBeGreaterThan(evaluate(b, 0));
  });

  it('a hard team beats an easy team deterministically', () => {
    const diffs: Difficulty[] = ['hard', 'easy', 'hard', 'easy'];
    for (const seed of [7, 42, 1234]) {
      const g = createGame(seed);
      const rand = seededRand(seed);
      let guard = 0;
      while (g.winner === null && guard++ < 5000) {
        applyMove(g, chooseMove(g, diffs[g.current], rand));
      }
      expect(g.winner).toBe(0); // team of seats 0 & 2 (both hard)
    }
  });
});
