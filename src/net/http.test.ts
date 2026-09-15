import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpSession } from './http.ts';
import type { OnlineHandlers } from './client.ts';
import { createGame } from '../engine/game.ts';
import { DEFAULT_RULES } from '../engine/types.ts';
import type { GameState, HouseRules } from '../engine/types.ts';

// The session schedules CPU turns and turn-timer takeovers with real timers
// and talks over fetch: both are faked here so scheduling is deterministic.

interface Call { url: string; body: any; headers: Record<string, string> }

let calls: Call[] = [];
let handlers: OnlineHandlers;
let events: string[] = [];

/** Routes answered by the fake relay; matched by substring. */
let routes: [string, () => { status?: number; data: unknown }][] = [];

function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  calls.push({ url, body, headers: (init?.headers as Record<string, string>) ?? {} });
  const route = routes.find(([m]) => url.includes(m));
  const { status = 200, data } = route ? route[1]() : { data: {} };
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(data),
  } as Response);
}

function snap(over: Partial<Record<string, unknown>> = {}, rules?: Partial<HouseRules>) {
  const game: GameState = createGame(1, rules);
  return {
    clientId: 'cid-1',
    code: 'TEST',
    version: 1,
    ageMs: 0,
    seats: [
      { name: 'Me', cpu: false },
      { name: 'Blue', cpu: true, difficulty: 'easy' },
      { name: 'Green', cpu: true, difficulty: 'easy' },
      { name: 'Yellow', cpu: true, difficulty: 'easy' },
    ],
    yourSeat: 0,
    hostIsYou: true,
    started: true,
    rules: { ...DEFAULT_RULES },
    game,
    emote: null,
    emoteN: 0,
    ...over,
  };
}

async function connect(joinData: unknown): Promise<HttpSession> {
  routes = [
    ['/join', () => ({ data: joinData })],
    // Idle heartbeats: nothing changed, no time passed on the server clock.
    ['?since=', () => ({ data: { version: 1, ageMs: 0, emoteN: 0 } })],
    ['/state', () => ({ data: snap({ version: 2 }) })],
  ];
  const session = new HttpSession('http://relay.test', handlers, () => {});
  session.join('TEST', 'Me');
  await vi.advanceTimersByTimeAsync(1);
  return session;
}

const statePosts = () => calls.filter(c => c.url.includes('/state'));

beforeEach(() => {
  calls = [];
  events = [];
  handlers = {
    onView: () => events.push('view'),
    onRoom: () => events.push('room'),
    onError: m => events.push(`error:${m}`),
    onClose: () => events.push('close'),
  };
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('fetch', fakeFetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('HttpSession scheduling', () => {
  it('computes a due CPU turn after the thinking pause', async () => {
    const d = snap();
    (d.game as GameState).current = 1; // a CPU seat is up
    const session = await connect(d);
    expect(statePosts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(4600); // 4s pause + jitter
    const posts = statePosts();
    expect(posts.length).toBeGreaterThanOrEqual(1);
    expect(posts[0].body.cpu).toBe(true);
    expect(posts[0].body.expectedVersion).toBe(1);
    expect(posts[0].headers['x-wahoo-client']).toBe('cid-1');
    session.leave();
  });

  it('honors the snappy house rule for CPU pacing', async () => {
    const d = snap({}, { cpuSnappy: true });
    (d.game as GameState).current = 1;
    d.rules = { ...DEFAULT_RULES, cpuSnappy: true };
    const session = await connect(d);
    await vi.advanceTimersByTimeAsync(1800); // 1.2s pause + jitter
    expect(statePosts().length).toBeGreaterThanOrEqual(1);
    session.leave();
  });

  it('plays for an out-of-time human when the turn timer is on', async () => {
    const d = snap({}, { turnTimer: 30 });
    (d.game as GameState).current = 0; // the human's own turn
    const session = await connect(d);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(statePosts()).toHaveLength(0); // still their turn
    await vi.advanceTimersByTimeAsync(2_500);
    const posts = statePosts();
    expect(posts.length).toBeGreaterThanOrEqual(1);
    expect(posts[0].body.cpu).toBe(true);
    session.leave();
  });

  it('never touches a human turn without the timer rule', async () => {
    const d = snap();
    (d.game as GameState).current = 0;
    const session = await connect(d);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(statePosts()).toHaveLength(0);
    session.leave();
  });

  it('polls again quickly when no hold slot was offered mid-game', async () => {
    const d = snap();
    (d.game as GameState).current = 0; // a human is thinking: no CPU posts
    const session = await connect(d);
    const polls = () => calls.filter(c => c.url.includes('?since=')).length;
    await vi.advanceTimersByTimeAsync(1250); // first interval poll: instant heartbeat
    const afterFirst = polls();
    expect(afterFirst).toBeGreaterThanOrEqual(1);
    // The 500ms follow-up lands well before the next 1200ms interval.
    await vi.advanceTimersByTimeAsync(600);
    expect(polls()).toBeGreaterThan(afterFirst);
    session.leave();
  });

  it('shrugs off a version conflict when another client won the race', async () => {
    const d = snap();
    (d.game as GameState).current = 1;
    const session = await connect(d);
    routes = routes.map(([m, r]): [string, () => { status?: number; data: unknown }] =>
      m === '/state' ? [m, () => ({ status: 409, data: { error: 'Version conflict.' } })] : [m, r],
    );
    await vi.advanceTimersByTimeAsync(4600);
    expect(statePosts().length).toBeGreaterThanOrEqual(1);
    expect(events.filter(e => e.startsWith('error') || e === 'close')).toEqual([]);
    session.leave();
  });
});
