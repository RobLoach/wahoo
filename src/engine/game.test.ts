import { describe, expect, it } from 'vitest';
import {
  actionsForCard, applyMove, buildDeck, createGame, forwardDest, legalMoves,
} from './game.ts';
import { chooseMove } from './ai.ts';
import type { CardAction, GameState, Move } from './types.ts';
import { SPAWN_INDEX } from './types.ts';

function bunny(state: GameState, id: number) {
  return state.bunnies.find(b => b.id === id)!;
}

/** Place a bunny directly for test setup. */
function put(state: GameState, id: number, place: GameState['bunnies'][0]['place']) {
  bunny(state, id).place = structuredClone(place);
}

function giveHand(state: GameState, seat: number, ranks: string[]) {
  const deck = buildDeck();
  state.players[seat].hand = ranks.map((rank, i) => ({
    ...deck.filter(c => c.rank === rank)[i % 4],
  }));
}

describe('setup', () => {
  it('deals 4 cards to each player and starts left of the dealer', () => {
    const g = createGame(42);
    for (const p of g.players) expect(p.hand.length).toBe(4);
    expect(g.drawPile.length).toBe(52 - 16);
    expect(g.current).toBe((g.dealer + 1) % 4);
  });
});

describe('spawning and movement', () => {
  it('spawns at Position 1 with an ace', () => {
    const g = createGame(1);
    giveHand(g, g.current, ['A']);
    const seat = g.current;
    const moves = legalMoves(g).filter(m => m.type === 'play' && m.action.kind === 'spawn');
    expect(moves.length).toBe(1);
    applyMove(g, moves[0]);
    const spawned = g.bunnies.find(b => b.player === seat && b.place.kind === 'track')!;
    expect(spawned.place).toEqual({ kind: 'track', index: SPAWN_INDEX(seat) });
  });

  it('stomps any bunny it lands on, sending it to reserve', () => {
    const g = createGame(2);
    g.current = 0;
    put(g, 0, { kind: 'track', index: 5 });
    put(g, 4, { kind: 'track', index: 8 }); // Blue bunny 3 ahead
    giveHand(g, 0, ['3']);
    const move = legalMoves(g).find(
      m => m.type === 'play' && m.action.kind === 'forward' && m.action.bunny === 0,
    )!;
    applyMove(g, move);
    expect(bunny(g, 0).place).toEqual({ kind: 'track', index: 8 });
    expect(bunny(g, 4).place).toEqual({ kind: 'reserve' });
  });

  it('passes through occupied spaces without stomping', () => {
    const g = createGame(3);
    g.current = 0;
    put(g, 0, { kind: 'track', index: 5 });
    put(g, 4, { kind: 'track', index: 6 });
    giveHand(g, 0, ['3']);
    const move = legalMoves(g).find(
      m => m.type === 'play' && m.action.kind === 'forward' && m.action.bunny === 0,
    )!;
    applyMove(g, move);
    expect(bunny(g, 4).place).toEqual({ kind: 'track', index: 6 });
  });
});

describe('burrow', () => {
  it('enters the burrow with an exact count after a lap', () => {
    const g = createGame(4);
    g.current = 0;
    put(g, 0, { kind: 'track', index: 78 }); // distance 78, needs 2..5 to slot 0..3
    giveHand(g, 0, ['3']);
    const move = legalMoves(g).find(
      m => m.type === 'play' && m.action.kind === 'forward' && m.action.bunny === 0,
    )!;
    applyMove(g, move);
    expect(bunny(g, 0).place).toEqual({ kind: 'burrow', slot: 1 });
  });

  it('cannot overshoot the burrow', () => {
    const g = createGame(5);
    g.current = 0;
    put(g, 0, { kind: 'track', index: 79 }); // distance 79: a 6 overshoots
    giveHand(g, 0, ['6']);
    const forward = legalMoves(g).filter(m => m.type === 'play' && m.action.kind === 'forward');
    expect(forward.length).toBe(0);
  });

  it('cannot jump over an occupied shallower slot when entering', () => {
    const g = createGame(6);
    g.current = 0;
    put(g, 1, { kind: 'burrow', slot: 0 });
    put(g, 0, { kind: 'track', index: 79 }); // a 3 would land on slot 2, passing occupied slot 0
    const forward = actionsForCard(g, 0, '3').filter(
      a => a.kind === 'forward' && a.bunny === 0,
    );
    expect(forward.length).toBe(0);
  });

  it('enters a shallow slot even when deeper slots are occupied', () => {
    const g = createGame(60);
    g.current = 0;
    put(g, 1, { kind: 'burrow', slot: 3 });
    put(g, 0, { kind: 'track', index: 79 }); // a 3 lands on slot 2, passing open slots 0 and 1
    giveHand(g, 0, ['3']);
    const move = legalMoves(g).find(
      m => m.type === 'play' && m.action.kind === 'forward' && m.action.bunny === 0,
    )!;
    applyMove(g, move);
    expect(bunny(g, 0).place).toEqual({ kind: 'burrow', slot: 2 });
  });

  it('advances deeper inside the burrow only through open slots', () => {
    const g = createGame(61);
    g.current = 0;
    put(g, 0, { kind: 'burrow', slot: 0 });
    put(g, 1, { kind: 'burrow', slot: 2 });
    const actions = actionsForCard(g, 0, 'A').filter(a => a.kind === 'forward');
    // Bunny 0 can step to slot 1; bunny 1 can step to slot 3.
    expect(actions).toEqual([
      { kind: 'forward', bunny: 0, steps: 1 },
      { kind: 'forward', bunny: 1, steps: 1 },
    ]);
    const two = actionsForCard(g, 0, '2').filter(a => a.kind === 'forward');
    // Bunny 0 cannot move 2 to slot 2 (occupied); bunny 1 would overshoot.
    expect(two.filter(a => a.kind === 'forward' && a.bunny === 0).length).toBe(0);
  });

  it('a 4 stays on the track: no backing into the burrow', () => {
    const g = createGame(7);
    g.current = 0;
    put(g, 0, { kind: 'track', index: SPAWN_INDEX(0) }); // even right beside the entrance
    const backs = actionsForCard(g, 0, '4').filter(a => a.kind === 'backward');
    expect(backs).toEqual([{ kind: 'backward', bunny: 0 }]);
    giveHand(g, 0, ['4']);
    applyMove(g, legalMoves(g).find(m => m.type === 'play' && m.action.kind === 'backward')!);
    expect(bunny(g, 0).place).toEqual({ kind: 'track', index: 76 });
  });

  it('moves backward 4 around the track, wrapping past spawn', () => {
    const g = createGame(8);
    g.current = 0;
    put(g, 0, { kind: 'track', index: 1 });
    giveHand(g, 0, ['4']);
    const move = legalMoves(g).find(
      m => m.type === 'play' && m.action.kind === 'backward',
    )!;
    applyMove(g, move);
    expect(bunny(g, 0).place).toEqual({ kind: 'track', index: 77 });
  });

  it('burrowed bunnies are immune to jacks and kings', () => {
    const g = createGame(9);
    g.current = 0;
    put(g, 0, { kind: 'track', index: 10 });
    put(g, 4, { kind: 'burrow', slot: 0 }); // Blue safe at home
    const swaps = actionsForCard(g, 0, 'J');
    expect(swaps.length).toBe(0);
    const kings = actionsForCard(g, 0, 'K').filter(a => a.kind === 'kingSpawn');
    expect(kings.length).toBe(0);
  });
});

describe('special cards', () => {
  it('splits a 7 across two bunnies but never more', () => {
    const g = createGame(10);
    g.current = 0;
    put(g, 0, { kind: 'track', index: 5 });
    put(g, 1, { kind: 'track', index: 30 });
    put(g, 2, { kind: 'track', index: 60 });
    const sevens = actionsForCard(g, 0, '7').filter(
      (a): a is Extract<CardAction, { kind: 'seven' }> => a.kind === 'seven',
    );
    const split = sevens.find(a => a.parts.length === 2);
    expect(split).toBeTruthy();
    expect(split!.parts.reduce((s, p) => s + p.steps, 0)).toBe(7);
    expect(sevens.some(a => a.parts.length === 1)).toBe(true); // one bunny, all 7
    expect(sevens.every(a => a.parts.length <= 2)).toBe(true); // 3-way splits are illegal
  });

  it('swaps with an opponent using a jack', () => {
    const g = createGame(11);
    g.current = 0;
    put(g, 0, { kind: 'track', index: 3 });
    put(g, 4, { kind: 'track', index: 55 });
    giveHand(g, 0, ['J']);
    const move = legalMoves(g).find(m => m.type === 'play' && m.action.kind === 'swap')!;
    applyMove(g, move);
    expect(bunny(g, 0).place).toEqual({ kind: 'track', index: 55 });
    expect(bunny(g, 4).place).toEqual({ kind: 'track', index: 3 });
  });

  it('king spawns from reserve onto an opponent anywhere on the track', () => {
    const g = createGame(12);
    g.current = 0;
    put(g, 4, { kind: 'track', index: 47 });
    giveHand(g, 0, ['K']);
    const move = legalMoves(g).find(m => m.type === 'play' && m.action.kind === 'kingSpawn')!;
    applyMove(g, move);
    expect(bunny(g, 4).place).toEqual({ kind: 'reserve' });
    const mine = g.bunnies.find(b => b.player === 0 && b.place.kind === 'track')!;
    expect(mine.place).toEqual({ kind: 'track', index: 47 });
  });

  it('king can stomp-spawn onto a teammate', () => {
    const g = createGame(13);
    g.current = 0;
    put(g, 8, { kind: 'track', index: 47 }); // seat 2 = teammate
    giveHand(g, 0, ['K']);
    const move = legalMoves(g).find(m => m.type === 'play' && m.action.kind === 'kingSpawn')!;
    applyMove(g, move);
    expect(bunny(g, 8).place).toEqual({ kind: 'reserve' });
    const mine = g.bunnies.find(b => b.player === 0 && b.place.kind === 'track')!;
    expect(mine.place).toEqual({ kind: 'track', index: 47 });
  });

  it('king cannot target your own bunny and needs a bunny in reserve', () => {
    const g = createGame(130);
    g.current = 0;
    put(g, 0, { kind: 'track', index: 3 });
    put(g, 1, { kind: 'track', index: 47 }); // both mine: no targets
    expect(actionsForCard(g, 0, 'K').filter(a => a.kind === 'kingSpawn').length).toBe(0);
    // Opponent on the track but my reserve is empty: no king spawn.
    const g2 = createGame(131);
    g2.current = 0;
    for (let i = 0; i < 4; i++) put(g2, i, { kind: 'track', index: 1 + i });
    put(g2, 4, { kind: 'track', index: 47 });
    expect(actionsForCard(g2, 0, 'K').filter(a => a.kind === 'kingSpawn').length).toBe(0);
  });

  it('a 2 flips a bonus card that the acting player resolves', () => {
    const g = createGame(14);
    g.current = 0;
    giveHand(g, 0, ['2']);
    const move = legalMoves(g).find(m => m.type === 'play' && m.action.kind === 'spawn')!;
    applyMove(g, move);
    // Either the flip is pending for seat 0 or it had no legal move.
    if (g.pendingFlip) {
      expect(g.current).toBe(0);
      const flips = legalMoves(g);
      expect(flips.every(m => m.type === 'flip')).toBe(true);
      applyMove(g, flips[0]);
      expect(g.pendingFlip === null || g.pendingFlip.rank !== undefined).toBe(true);
    }
  });
});

describe('round flow', () => {
  it('folds the hand when no legal move exists', () => {
    const g = createGame(15);
    g.current = 0;
    // No bunnies anywhere, hand with no spawn cards: nothing is playable.
    giveHand(g, 0, ['3', '5', 'Q', 'J']);
    const moves = legalMoves(g);
    expect(moves).toEqual([{ type: 'discardHand' }]);
    applyMove(g, moves[0]);
    expect(g.players[0].hand.length).toBe(0);
    expect(g.players[0].out).toBe(true);
    expect(g.current).not.toBe(0);
  });

  it('controls the teammate once all four bunnies are home', () => {
    const g = createGame(16);
    g.current = 0;
    for (let i = 0; i < 4; i++) put(g, i, { kind: 'burrow', slot: i });
    put(g, 8, { kind: 'track', index: 50 }); // teammate bunny
    const actions = actionsForCard(g, 0, '3');
    expect(actions).toEqual([{ kind: 'forward', bunny: 8, steps: 3 }]);
  });

  it('declares a winner when all eight team bunnies are home', () => {
    const g = createGame(17);
    g.current = 0;
    for (let i = 0; i < 4; i++) put(g, i, { kind: 'burrow', slot: i });
    // Teammate's deep slots are filled; the last bunny takes the open slot 0.
    for (let i = 8; i < 11; i++) put(g, i, { kind: 'burrow', slot: i - 7 });
    put(g, 11, { kind: 'track', index: 35 }); // distance 75 from seat 2's spawn: a 5 reaches slot 0
    giveHand(g, 0, ['5']);
    const move = legalMoves(g).find(m => m.type === 'play' && m.action.kind === 'forward')!;
    applyMove(g, move);
    expect(g.winner).toBe(0);
  });
});

describe('play descriptions', () => {
  it('describes a jack swap', () => {
    const g = createGame(200);
    g.current = 0;
    put(g, 0, { kind: 'track', index: 3 });
    put(g, 4, { kind: 'track', index: 55 });
    giveHand(g, 0, ['J']);
    applyMove(g, legalMoves(g).find(m => m.type === 'play' && m.action.kind === 'swap')!);
    expect(g.lastPlay?.desc).toBe("swapped a bunny with Blue's bunny");
  });

  it('describes a forward move that stomps', () => {
    const g = createGame(201);
    g.current = 0;
    put(g, 0, { kind: 'track', index: 5 });
    put(g, 4, { kind: 'track', index: 8 });
    giveHand(g, 0, ['3']);
    applyMove(g, legalMoves(g).find(m => m.type === 'play' && m.action.kind === 'forward')!);
    expect(g.lastPlay?.desc).toBe('moved a bunny 3 forward, stomping Blue');
  });

  it('describes entering the burrow', () => {
    const g = createGame(202);
    g.current = 0;
    put(g, 0, { kind: 'track', index: 78 });
    giveHand(g, 0, ['3']);
    applyMove(g, legalMoves(g).find(m => m.type === 'play' && m.action.kind === 'forward')!);
    expect(g.lastPlay?.desc).toBe('moved a bunny 3 forward, into the burrow!');
  });

  it('describes a fold', () => {
    const g = createGame(203);
    g.current = 0;
    giveHand(g, 0, ['3']);
    applyMove(g, { type: 'discardHand' });
    expect(g.lastPlay).toMatchObject({ seat: 0, fold: true });
  });
});

describe('full games', () => {
  it('CPU vs CPU games finish with a winner', () => {
    for (const seed of [1, 99, 12345]) {
      const g = createGame(seed);
      let guard = 0;
      while (g.winner === null && guard++ < 5000) {
        const move: Move = chooseMove(g, 'hard', () => 0.5);
        applyMove(g, move);
      }
      expect(g.winner).not.toBeNull();
    }
  });
});

describe('seven with burrow bunnies', () => {
  it('a 7 can split between a burrow bunny and a track bunny', () => {
    const state = createGame(1);
    put(state, 0, { kind: 'burrow', slot: 0 });
    put(state, 1, { kind: 'track', index: 5 });
    const sevens = actionsForCard(state, 0, '7') as Extract<CardAction, { kind: 'seven' }>[];
    // Deepening the burrow bunny 3 (slot 0 -> 3) plus 4 on the track bunny.
    const combo = sevens.find(a =>
      a.parts.some(p => p.bunny === 0 && p.steps === 3) &&
      a.parts.some(p => p.bunny === 1 && p.steps === 4));
    expect(combo).toBeTruthy();
    applyMove(state, { type: 'play', card: state.players[0].hand[0].id, action: combo! });
    expect(bunny(state, 0).place).toEqual({ kind: 'burrow', slot: 3 });
    expect(bunny(state, 1).place).toEqual({ kind: 'track', index: 9 });
  });

  it('burrow parts still obey no-jumping and exact-count limits', () => {
    const state = createGame(2);
    put(state, 0, { kind: 'burrow', slot: 0 });
    put(state, 1, { kind: 'burrow', slot: 2 }); // blocks slot 2
    put(state, 2, { kind: 'track', index: 10 });
    const sevens = actionsForCard(state, 0, '7') as Extract<CardAction, { kind: 'seven' }>[];
    // Bunny 0 can only advance 1 (slot 1): slots 2/3 are blocked or beyond.
    for (const a of sevens) {
      for (const p of a.parts) {
        if (p.bunny === 0) expect(p.steps).toBe(1);
        if (p.bunny === 1) expect(p.steps).toBe(1); // slot 2 -> 3 only
      }
    }
  });
});

describe('house rules', () => {
  it('blocks landing on a teammate when friendly fire is off', () => {
    const strict = createGame(1, { friendlyFire: false });
    expect(strict.rules.friendlyFire).toBe(false);
    put(strict, 0, { kind: 'track', index: 0 });
    put(strict, 8, { kind: 'track', index: 3 }); // Green, Red's teammate
    expect(actionsForCard(strict, 0, '3')).toEqual([]);

    const open = createGame(1); // default: friendly fire allowed
    put(open, 0, { kind: 'track', index: 0 });
    put(open, 8, { kind: 'track', index: 3 });
    expect(actionsForCard(open, 0, '3')).toHaveLength(1);
  });

  it('excludes teammates from King stomps when friendly fire is off', () => {
    const state = createGame(2, { friendlyFire: false });
    put(state, 8, { kind: 'track', index: 10 }); // teammate
    put(state, 4, { kind: 'track', index: 30 }); // Blue: enemy
    const targets = actionsForCard(state, 0, 'K')
      .filter(a => a.kind === 'kingSpawn')
      .map(a => (a as { target: number }).target);
    expect(targets).toEqual([4]);
  });

  it('blocks spawning onto a protected teammate', () => {
    const state = createGame(3, { friendlyFire: false });
    put(state, 8, { kind: 'track', index: SPAWN_INDEX(0) }); // parked on Red's spawn
    expect(actionsForCard(state, 0, 'A')).toEqual([]);
  });

  it('lets bunnies jump occupied burrow slots when enabled', () => {
    const jump = createGame(4, { burrowJump: true });
    put(jump, 0, { kind: 'track', index: 78 });
    put(jump, 1, { kind: 'burrow', slot: 0 });
    expect(forwardDest(jump, bunny(jump, 0), 4)).toEqual({ kind: 'burrow', slot: 2 });

    const strict = createGame(4); // default: no jumping in the burrow
    put(strict, 0, { kind: 'track', index: 78 });
    put(strict, 1, { kind: 'burrow', slot: 0 });
    expect(forwardDest(strict, bunny(strict, 0), 4)).toBeNull();
  });

  it('honors the seven-split bunny limit', () => {
    const partCounts = (max: 1 | 2 | 4) => {
      const state = createGame(5, { sevenMaxBunnies: max });
      put(state, 0, { kind: 'track', index: 5 });
      put(state, 1, { kind: 'track', index: 40 });
      put(state, 2, { kind: 'track', index: 60 });
      return actionsForCard(state, 0, '7').map(
        a => (a as { parts: unknown[] }).parts.length,
      );
    };
    expect(Math.max(...partCounts(1))).toBe(1);
    expect(Math.max(...partCounts(2))).toBe(2);
    expect(Math.max(...partCounts(4))).toBe(3); // 7 split across all three
  });
});

describe('log events', () => {
  it('formats every event exactly as the log used to read', async () => {
    const { formatLog } = await import('./log.ts');
    expect(formatLog({ t: 'deal', round: 2, dealer: 1 })).toBe('Round 2: Blue deals.');
    expect(formatLog({ t: 'spawn', seat: 0 })).toBe('Red spawns a bunny.');
    expect(formatLog({ t: 'stomp', by: 0, victim: 3 })).toBe("Red stomps Yellow's bunny!");
    expect(formatLog({ t: 'fold', seat: 2 })).toBe('Green has no legal move and folds.');
    expect(formatLog({ t: 'win', team: 1 })).toBe('Team Blue & Yellow wins!');
    expect(formatLog('legacy string')).toBe('legacy string'); // old saves
  });

  it('the engine emits structured events that render through the view', () => {
    const state = createGame(1);
    const dealLine = state.log.find(e => typeof e !== 'string' && e.t === 'deal');
    expect(dealLine).toBeTruthy();
  });
});
