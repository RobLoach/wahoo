import { describe, expect, it } from 'vitest';
import { createGame, applyMove, legalMoves } from '../engine/game.ts';
import { makeView } from './protocol.ts';

const NAMES = ['Alice', 'Bob', 'Carol', 'Dan'];

describe('makeView', () => {
  it('shows only the viewing seat its own hand', () => {
    const g = createGame(1);
    const view = makeView(g, 2, NAMES, false);
    expect(view.myHand).toEqual(g.players[2].hand);
    expect(view.handCounts).toEqual([4, 4, 4, 4]);
    expect((view as unknown as Record<string, unknown>).drawPile).toBeUndefined();
    expect(view.drawCount).toBe(52 - 16);
  });

  it('gives spectators no hand at all', () => {
    const g = createGame(2);
    const view = makeView(g, null, NAMES, false);
    expect(view.myHand).toEqual([]);
    expect(view.mySeat).toBeNull();
  });

  it('includes legal moves only for the acting client', () => {
    const g = createGame(3);
    const acting = makeView(g, g.current, NAMES, true);
    const waiting = makeView(g, (g.current + 1) % 4, NAMES, false);
    expect(acting.canAct).toBe(true);
    expect(acting.legal.length).toBeGreaterThan(0);
    expect(waiting.canAct).toBe(false);
    expect(waiting.legal).toEqual([]);
  });

  it('carries the last move effects for animation', () => {
    const g = createGame(4);
    applyMove(g, legalMoves(g)[0]);
    const view = makeView(g, 0, NAMES, false);
    expect(view.effects).toEqual(g.effects);
    expect(view.effects).not.toBe(g.effects); // cloned, not shared
  });

  it('is JSON-serializable for transport', () => {
    const g = createGame(5);
    const view = makeView(g, 0, NAMES, true);
    const roundTripped = JSON.parse(JSON.stringify(view));
    expect(roundTripped).toEqual(view);
  });
});
