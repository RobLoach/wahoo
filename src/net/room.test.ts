import { describe, expect, it } from 'vitest';
import { GameRoom, sanitizeName } from './room.ts';
import { ROOM_WORDS, randomRoomCode } from './words.ts';
import type { ServerMsg } from './protocol.ts';

/** A room with a message collector per client id. */
function makeRoom(cpuDelay = 1) {
  const inbox = new Map<string, ServerMsg[]>();
  const send = (id: string, msg: ServerMsg) => {
    if (!inbox.has(id)) inbox.set(id, []);
    inbox.get(id)!.push(msg);
  };
  const room = new GameRoom('TEST', send, cpuDelay);
  const last = (id: string, t: ServerMsg['t']) => {
    const msgs = inbox.get(id) ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].t === t) return msgs[i] as any;
    return null;
  };
  return { room, inbox, last };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('lobby', () => {
  it('seats clients in order and reports host status', () => {
    const { room, last } = makeRoom();
    room.addClient('a', 'Alice', 'tok-a');
    room.addClient('b', 'Bob', 'tok-b');
    expect(last('a', 'room').room).toMatchObject({ youAreHost: true, yourSeat: 0 });
    expect(last('b', 'room').room).toMatchObject({ youAreHost: false, yourSeat: 1 });
  });

  it('sanitizes player names', () => {
    expect(sanitizeName('<script>alert(1)</script>')).toBe('scriptalert(');
    expect(sanitizeName('')).toBe('Player');
    expect(sanitizeName(undefined)).toBe('Player');
  });

  it('lets a client change seats before the game starts', () => {
    const { room, last } = makeRoom();
    room.addClient('a', 'Alice', 'tok-a');
    room.handle('a', { t: 'sit', seat: 3 });
    expect(last('a', 'room').room.yourSeat).toBe(3);
    expect(room.seats[0]).toBeNull();
    expect(room.seats[3]).toMatchObject({ name: 'Alice', token: 'tok-a' });
  });

  it('only the host can add CPUs, with a difficulty', () => {
    const { room } = makeRoom();
    room.addClient('a', 'Alice');
    room.addClient('b', 'Bob');
    room.handle('b', { t: 'cpu', seat: 2, on: true, difficulty: 'hard' });
    expect(room.seats[2]).toBeNull();
    room.handle('a', { t: 'cpu', seat: 2, on: true, difficulty: 'hard' });
    expect(room.seats[2]).toMatchObject({ cpu: true, difficulty: 'hard' });
    room.handle('a', { t: 'cpu', seat: 2, on: false });
    expect(room.seats[2]).toBeNull();
  });
});

describe('game flow', () => {
  it('start fills empty seats with medium CPUs and deals a game', () => {
    const { room, last } = makeRoom();
    room.addClient('a', 'Alice');
    room.handle('a', { t: 'start' });
    expect(room.game).not.toBeNull();
    for (let i = 1; i < 4; i++) {
      expect(room.seats[i]).toMatchObject({ cpu: true, difficulty: 'medium' });
    }
    const view = last('a', 'state').view;
    expect(view.handCounts).toEqual([4, 4, 4, 4]);
    expect(view.myHand.length).toBe(4);
  });

  it('rejects moves out of turn and illegal moves', () => {
    const { room, last } = makeRoom(60_000); // long delay: CPUs stay frozen
    room.addClient('a', 'Alice');
    room.addClient('b', 'Bob');
    room.handle('a', { t: 'start' });
    const game = room.game!;
    const actor = game.current === 0 ? 'a' : 'b';
    const other = actor === 'a' ? 'b' : 'a';
    room.handle(other, { t: 'move', move: { type: 'discardHand' } });
    expect(last(other, 'err')?.msg).toContain('Not your turn');
    room.handle(actor, {
      t: 'move',
      move: { type: 'play', card: 999, action: { kind: 'spawn' } },
    });
    expect(last(actor, 'err')?.msg).toContain('Illegal move');
    room.dispose();
  });

  it('applies a legal move and broadcasts fresh views to everyone', () => {
    const { room, last } = makeRoom(60_000);
    room.addClient('a', 'Alice');
    room.addClient('b', 'Bob');
    room.handle('a', { t: 'start' });
    const game = room.game!;
    const actor = game.current === 0 ? 'a' : 'b';
    const view = last(actor, 'state').view;
    room.handle(actor, { t: 'move', move: view.legal[0] });
    expect(last(actor, 'err')).toBeNull();
    expect(last('a', 'state').view.log.length).toBeGreaterThan(1);
    room.dispose();
  });

  it('CPU seats play automatically', async () => {
    const { room } = makeRoom(1);
    room.addClient('a', 'Alice');
    room.handle('a', { t: 'start' });
    const before = room.game!.turn;
    // If it's Alice's turn, fold to hand the turn to the CPUs.
    if (room.game!.current === 0) room.handle('a', { t: 'move', move: { type: 'discardHand' } });
    await sleep(50);
    expect(room.game!.turn).toBeGreaterThan(before);
    room.dispose();
  });

  it('host rematch starts a fresh game with the same seats', () => {
    const { room } = makeRoom(60_000);
    room.addClient('a', 'Alice');
    room.handle('a', { t: 'start' });
    room.game!.winner = 1; // force game over
    room.handle('a', { t: 'again' });
    expect(room.game!.winner).toBeNull();
    expect(room.game!.round).toBe(1);
    expect(room.seats[0]).toMatchObject({ name: 'Alice', cpu: false });
    room.dispose();
  });

  it('ignores rematch requests from non-hosts and unfinished games', () => {
    const { room } = makeRoom(60_000);
    room.addClient('a', 'Alice');
    room.addClient('b', 'Bob');
    room.handle('a', { t: 'start' });
    const game = room.game!;
    room.handle('a', { t: 'again' }); // not finished yet
    expect(room.game).toBe(game);
    game.winner = 0;
    room.handle('b', { t: 'again' }); // not the host
    expect(room.game).toBe(game);
    room.dispose();
  });
});

describe('reconnection', () => {
  it('a disconnected seat becomes a CPU and can be reclaimed by token', () => {
    const { room, last } = makeRoom(60_000);
    room.addClient('a', 'Alice', 'tok-a');
    room.addClient('b', 'Bob', 'tok-b');
    room.handle('a', { t: 'start' });
    expect(room.removeClient('b')).toBe(false);
    expect(room.seats[1]).toMatchObject({ cpu: true, name: 'Bob', token: 'tok-b' });
    room.addClient('b2', 'Bob', 'tok-b');
    expect(room.seats[1]).toMatchObject({ cpu: false, clientId: 'b2' });
    expect(last('b2', 'room').room.yourSeat).toBe(1);
    expect(last('b2', 'state').view.myHand.length).toBeGreaterThan(0);
    room.dispose();
  });

  it('a joiner without a matching token spectates mid-game', () => {
    const { room, last } = makeRoom(60_000);
    room.addClient('a', 'Alice');
    room.handle('a', { t: 'start' });
    room.addClient('c', 'Carol', 'tok-c');
    expect(last('c', 'room').room.yourSeat).toBeNull();
    expect(last('c', 'state').view.myHand).toEqual([]);
    room.dispose();
  });

  it('reports empty when the last human leaves', () => {
    const { room } = makeRoom();
    room.addClient('a', 'Alice');
    expect(room.removeClient('a')).toBe(true);
  });

  it('snapshot/restore preserves the game and lets the host reclaim', () => {
    const { room } = makeRoom(60_000);
    room.addClient('a', 'Alice', 'tok-a');
    room.handle('a', { t: 'cpu', seat: 1, on: true, difficulty: 'hard' });
    room.handle('a', { t: 'start' });
    const round = room.game!.round;
    const snap = room.snapshot();
    room.dispose();

    const inbox2 = new Map<string, ServerMsg[]>();
    const restored = GameRoom.restore(
      'TEST',
      (id, msg) => {
        if (!inbox2.has(id)) inbox2.set(id, []);
        inbox2.get(id)!.push(msg);
      },
      snap,
      60_000,
    );
    const last2 = (id: string, t: ServerMsg['t']) => {
      const msgs = inbox2.get(id) ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].t === t) return msgs[i] as any;
      return null;
    };
    expect(restored.game!.round).toBe(round);
    expect(restored.seats[1]).toMatchObject({ cpu: true, difficulty: 'hard' });
    // Host seat runs as a CPU until reclaimed via token.
    expect(restored.seats[0]).toMatchObject({ cpu: true, token: 'tok-a' });
    restored.addClient('a2', 'Alice', 'tok-a');
    expect(restored.seats[0]).toMatchObject({ cpu: false, clientId: 'a2' });
    expect(last2('a2', 'state').view.myHand.length).toBeGreaterThan(0);
    restored.dispose();
  });
});

describe('room codes', () => {
  it('draws from a large list of clean four-letter words', () => {
    expect(ROOM_WORDS.length).toBeGreaterThanOrEqual(200);
    expect(new Set(ROOM_WORDS).size).toBe(ROOM_WORDS.length);
    for (const word of ROOM_WORDS) expect(word).toMatch(/^[A-Z]{4}$/);
    expect(ROOM_WORDS).toContain(randomRoomCode());
  });
});
