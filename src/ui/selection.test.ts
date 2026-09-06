import { describe, expect, it } from 'vitest';
import { actionsForCard, createGame } from '../engine/game.ts';
import type { BunnyPlace, GameState } from '../engine/types.ts';
import { playableSevenParts } from './selection.ts';

const put = (state: GameState, id: number, place: BunnyPlace) => {
  state.bunnies.find(b => b.id === id)!.place = place;
};

describe('playableSevenParts', () => {
  it('steers an order-dependent split through its only valid order', () => {
    // Bunny 1 sits in burrow slot 0; bunny 0 is 4 short of the burrow.
    // Every valid 7-split must deepen bunny 1 FIRST to clear the slot.
    const state = createGame(1);
    put(state, 0, { kind: 'track', index: 76 });
    put(state, 1, { kind: 'burrow', slot: 0 });
    const actions = actionsForCard(state, 0, '7');
    const view = { bunnies: state.bunnies, rules: state.rules } as never;

    // Nothing chosen yet: only the burrow bunny is offered, never bunny 0
    // (whose destinations are all blocked until bunny 1 moves).
    const first = playableSevenParts(view, actions, []);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every(p => p.bunny === 1)).toBe(true);

    // Once bunny 1 deepens by 3, bunny 0's 4-step finish opens up.
    const rest = playableSevenParts(view, actions, [{ bunny: 1, steps: 3 }]);
    expect(rest).toEqual([{ bunny: 0, steps: 4 }]);
  });

  it('offers every bunny of an order-free split, without duplicates', () => {
    const state = createGame(2);
    put(state, 0, { kind: 'track', index: 5 });
    put(state, 1, { kind: 'track', index: 40 });
    const actions = actionsForCard(state, 0, '7');
    const view = { bunnies: state.bunnies, rules: state.rules } as never;

    const parts = playableSevenParts(view, actions, []);
    expect(new Set(parts.map(p => p.bunny))).toEqual(new Set([0, 1]));
    const keys = parts.map(p => `${p.bunny}:${p.steps}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
