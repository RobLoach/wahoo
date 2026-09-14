import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lifetimeRecord, recordGame } from './stats.ts';

/** A tiny localStorage that lives for one test. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the lifetime record', () => {
  it('starts empty and accumulates games', () => {
    expect(lifetimeRecord()).toEqual({ games: 0, wins: [0, 0], stomps: 0, rounds: 0 });
    recordGame(0, 5, 3);
    recordGame(1, 2, 4);
    recordGame(0, 0, 1);
    expect(lifetimeRecord()).toEqual({ games: 3, wins: [2, 1], stomps: 7, rounds: 8 });
  });

  it('shrugs off corrupt or hostile stored data', () => {
    localStorage.setItem('wahoo-record', 'not json {{{');
    expect(lifetimeRecord().games).toBe(0);
    localStorage.setItem(
      'wahoo-record',
      JSON.stringify({ games: '<img onerror=x>', wins: null, stomps: 1e9, rounds: -2 }),
    );
    const r = lifetimeRecord();
    expect(r.games).toBe(0); // non-numeric coerces to 0, never to markup
    expect(r.wins).toEqual([0, 0]);
    // Recording on top of garbage heals the shape.
    recordGame(1, 1, 1);
    expect(lifetimeRecord().wins).toEqual([0, 1]);
  });
});
