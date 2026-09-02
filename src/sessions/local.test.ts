import { describe, expect, it } from 'vitest';
import { LocalSession } from './local.ts';
import type { SeatKind } from './local.ts';
import { createGame } from '../engine/game.ts';
import type { View } from '../net/protocol.ts';

/** A session resumed from a known state so the current seat is deterministic. */
function sessionAt(seats: SeatKind[], current: number) {
  const state = createGame(1);
  state.current = current;
  const views: View[] = [];
  const session = new LocalSession(seats, v => views.push(v), 60_000, state);
  session.start();
  return { session, view: () => views[views.length - 1] };
}

describe('custom names', () => {
  it('humans use their entered name; CPU seats keep colour names', () => {
    const state = createGame(1);
    state.current = 0;
    const views: View[] = [];
    const session = new LocalSession(
      ['human', 'cpu-medium', 'cpu-medium', 'cpu-medium'],
      v => views.push(v),
      60_000,
      state,
      undefined,
      ['Rob', 'ignored', '  ', 'ignored'],
    );
    session.start();
    expect(views[views.length - 1].seatNames).toEqual([
      'Rob', 'CPU Blue', 'CPU Green', 'CPU Yellow',
    ]);
    session.leave();
  });
});

describe('local hand visibility', () => {
  it('a lone human keeps seeing their hand during CPU turns', () => {
    const { session, view } = sessionAt(['human', 'cpu-medium', 'cpu-medium', 'cpu-medium'], 1);
    const v = view();
    expect(v.canAct).toBe(false);
    expect(v.mySeat).toBe(0);
    expect(v.myHand.length).toBe(4);
    session.leave();
  });

  it('hot-seat humans still get no hand between their turns', () => {
    const { session, view } = sessionAt(['human', 'human', 'cpu-medium', 'cpu-medium'], 2);
    const v = view();
    expect(v.canAct).toBe(false);
    expect(v.mySeat).toBeNull();
    expect(v.myHand).toEqual([]);
    session.leave();
  });

  it('the acting human sees their hand as before', () => {
    const { session, view } = sessionAt(['human', 'cpu-medium', 'cpu-medium', 'cpu-medium'], 0);
    const v = view();
    expect(v.canAct).toBe(true);
    expect(v.mySeat).toBe(0);
    expect(v.myHand.length).toBe(4);
    session.leave();
  });
});
