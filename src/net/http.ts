// Session for the PHP relay server (server/wahoo-php): plain HTTPS polling
// instead of WebSockets, so it runs on ordinary shared hosting. The rules
// engine runs client-side; the server stores state and enforces seats, turn
// order, and versioning. CPU turns are computed lazily by whichever polling
// client notices one is due (the server arbitrates races by version).
import { applyMove, cloneState, createGame } from '../engine/game.ts';
import { chooseMove } from '../engine/ai.ts';
import { makeView } from './protocol.ts';
import type { Difficulty, GameState, HouseRules, Move } from '../engine/types.ts';
import { PLAYER_NAMES } from '../engine/types.ts';
import type { OnlineHandlers } from './client.ts';

const POLL_MS = 1200;
const CPU_DELAY_MS = 4000;
/** Test override, mirroring the local/WS sessions. */
const cpuDelayMs = () => window.__wahooCpuDelay ?? CPU_DELAY_MS;

interface Snapshot {
  code: string;
  version: number;
  ageMs: number;
  seats: ({ name: string; cpu: boolean; difficulty?: Difficulty | null } | null)[];
  yourSeat: number | null;
  hostIsYou: boolean;
  started: boolean;
  rules?: HouseRules | null;
  game: GameState | null;
  emote?: { seat: number; emoji: string } | null;
  emoteN?: number;
}

/** What an unchanged poll returns: just enough to keep clocks and emotes fresh. */
interface Heartbeat {
  version: number;
  ageMs: number;
  emote?: { seat: number; emoji: string } | null;
  emoteN?: number;
}

export class HttpSession {
  private base: string;
  private code: string | null = null;
  private clientId: string | null = null;
  private version = -1;
  private last: Snapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private closed = false;
  private missedPolls = 0;
  private lastEmoteN = 0;

  constructor(url: string, private handlers: OnlineHandlers, onOpen: () => void) {
    this.base = url.replace(/\/+$/, '');
    setTimeout(onOpen, 0);
  }

  private async api<T = Snapshot & { clientId?: string }>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    // no-store: shared hosts often inject long cache lifetimes, and a cached
    // snapshot would freeze the poll loop at a stale version.
    // The clientId travels in a header, not the query string, so the seat
    // credential never lands in server access logs.
    const auth: Record<string, string> = this.clientId
      ? { 'x-wahoo-client': this.clientId }
      : {};
    const response = await fetch(`${this.base}${path}`, {
      cache: 'no-store',
      ...(body === undefined
        ? { headers: auth }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...auth },
            body: JSON.stringify(body),
          }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error((data as { error?: string }).error ?? `HTTP ${response.status}`);
      (err as Error & { status?: number }).status = response.status;
      throw err;
    }
    return data as T;
  }

  private fail(err: unknown) {
    if (!this.closed) this.handlers.onError((err as Error).message);
  }

  create(name: string, token?: string) {
    void this.api('/api/rooms', { name, token })
      .then(d => this.enter(d))
      .catch(e => this.fail(e));
  }

  join(code: string, name: string, token?: string) {
    void this.api(`/api/rooms/${encodeURIComponent(code)}/join`, { name, token })
      .then(d => this.enter(d))
      .catch(e => this.fail(e));
  }

  private enter(d: Snapshot & { clientId?: string }) {
    this.code = d.code;
    this.clientId = d.clientId ?? null;
    this.lastEmoteN = d.emoteN ?? 0;
    this.accept(d);
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  private async poll() {
    if (this.closed || !this.code || this.busy) return;
    this.busy = true;
    const started = Date.now();
    try {
      // wait=1 asks a new server to hold the request until something changes
      // (a long poll); an old server ignores it and answers immediately.
      const d = await this.api<Snapshot | Heartbeat>(
        `/api/rooms/${this.code}?since=${this.version}&emoteN=${this.lastEmoteN}&wait=1`,
      );
      this.missedPolls = 0;
      this.acceptEmote(d);
      if (!('seats' in d)) {
        // Unchanged: a tiny heartbeat — refresh the CPU-turn clock only.
        if (this.last) {
          this.last.ageMs = d.ageMs;
          await this.maybePlayCpu(this.last);
        }
        return;
      }
      this.accept(d);
      await this.maybePlayCpu(d);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404 && !this.closed) {
        this.closed = true;
        if (this.timer) clearInterval(this.timer);
        this.handlers.onClose();
      } else if (++this.missedPolls >= 5 && !this.closed) {
        // Transient network errors are tolerated; a stretch of them is not.
        this.closed = true;
        if (this.timer) clearInterval(this.timer);
        this.handlers.onClose();
      }
    } finally {
      this.busy = false;
      // A response that took a while means the server held it (long poll):
      // chain the next one immediately. Fast responses mean an old server —
      // let the interval pace us so we don't hammer it.
      if (!this.closed && Date.now() - started > 2000) void this.poll();
    }
  }

  private seatNames(d: Snapshot): string[] {
    return d.seats.map((seat, i) =>
      seat ? (seat.cpu ? `CPU ${seat.name}` : seat.name) : `CPU ${PLAYER_NAMES[i]}`,
    );
  }

  private acceptEmote(d: { emote?: { seat: number; emoji: string } | null; emoteN?: number }) {
    if (typeof d.emoteN === 'number' && d.emoteN > this.lastEmoteN) {
      this.lastEmoteN = d.emoteN;
      if (d.emote) this.handlers.onEmote?.(d.emote.seat, d.emote.emoji);
    }
  }

  private cpuTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * When a CPU is to act, fire locally once its thinking pause elapses —
   * long polls hold until something changes, and the CPU's move IS the
   * change, so waiting for a poll would stall the game.
   */
  private scheduleCpu(d: Snapshot) {
    if (this.cpuTimer) clearTimeout(this.cpuTimer);
    this.cpuTimer = null;
    const game = d.game;
    if (!game || game.winner !== null) return;
    const seat = d.seats[game.current];
    if (seat && !seat.cpu) return;
    // A little jitter so several clients rarely race (the version check on
    // the POST settles it harmlessly when they do).
    const wait = Math.max(0, cpuDelayMs() - d.ageMs) + Math.random() * 400;
    this.cpuTimer = setTimeout(() => {
      if (this.closed || !this.last) return;
      void this.maybePlayCpu({ ...this.last, ageMs: Math.max(this.last.ageMs, cpuDelayMs()) });
    }, wait);
  }

  private accept(d: Snapshot) {
    const changed = d.version !== this.version;
    this.version = d.version;
    this.last = d;
    this.scheduleCpu(d);
    if (!changed || this.closed) return;
    this.handlers.onRoom({
      code: d.code,
      seats: d.seats.map(s =>
        s ? { name: s.name, cpu: s.cpu, difficulty: s.difficulty ?? undefined } : null,
      ),
      youAreHost: d.hostIsYou,
      yourSeat: d.yourSeat,
      started: d.started,
      rules: d.rules ?? undefined,
    });
    if (d.game) {
      const canAct =
        d.yourSeat !== null &&
        d.game.winner === null &&
        d.game.current === d.yourSeat &&
        !d.seats[d.yourSeat]?.cpu;
      this.handlers.onView(makeView(d.game, d.yourSeat, this.seatNames(d), canAct));
    }
  }

  /** Whoever notices a due CPU turn computes it; the server arbitrates races. */
  private async maybePlayCpu(d: Snapshot) {
    const game = d.game;
    if (!game || game.winner !== null) return;
    const seat = d.seats[game.current];
    if (seat && !seat.cpu) return;
    if (d.ageMs < cpuDelayMs()) return;
    const sim = cloneState(game);
    try {
      applyMove(sim, chooseMove(sim, (seat?.difficulty as Difficulty) ?? 'medium'));
    } catch {
      return;
    }
    try {
      const next = await this.api(`/api/rooms/${this.code}/state`, {
        clientId: this.clientId,
        expectedVersion: d.version,
        state: sim,
        cpu: true,
      });
      this.accept(next);
    } catch {
      /* another client got there first — the next poll catches us up */
    }
  }

  // ---- session interface (mirrors OnlineSession) ----

  sit(seat: number) {
    void this.api(`/api/rooms/${this.code}/sit`, { clientId: this.clientId, seat })
      .then(d => this.accept(d))
      .catch(e => this.fail(e));
  }

  cpu(seat: number, on: boolean, difficulty?: Difficulty) {
    void this.api(`/api/rooms/${this.code}/cpu`, { clientId: this.clientId, seat, on, difficulty })
      .then(d => this.accept(d))
      .catch(e => this.fail(e));
  }

  startGame(rules?: Partial<HouseRules>) {
    const state = createGame(Math.floor(Math.random() * 2 ** 31), rules);
    void this.api(`/api/rooms/${this.code}/start`, { clientId: this.clientId, state })
      .then(d => this.accept(d))
      .catch(e => this.fail(e));
  }

  playAgain() {
    const state = createGame(Math.floor(Math.random() * 2 ** 31), this.last?.game?.rules);
    void this.api(`/api/rooms/${this.code}/again`, { clientId: this.clientId, state })
      .then(d => this.accept(d))
      .catch(e => this.fail(e));
  }

  setRules(rules: Partial<HouseRules>) {
    if (this.closed) return;
    void this.api<Snapshot>(`/api/rooms/${this.code}/rules`, { clientId: this.clientId, rules })
      .then(d => this.accept(d))
      .catch(() => { /* display-only; old servers lack the route */ });
  }

  rename(name: string) {
    if (this.closed) return;
    void this.api<Snapshot>(`/api/rooms/${this.code}/rename`, { clientId: this.clientId, name })
      .then(d => this.accept(d))
      .catch(() => { /* stale name is cosmetic; the next poll reconciles */ });
  }

  emote(emoji: string) {
    const seat = this.last?.yourSeat;
    if (seat === null || seat === undefined || this.closed) return;
    // Show our own reaction immediately; skip the echo when it polls back.
    this.handlers.onEmote?.(seat, emoji);
    void this.api<{ emoteN?: number }>(`/api/rooms/${this.code}/emote`, {
      clientId: this.clientId,
      emoji,
    })
      .then(d => {
        if (typeof d.emoteN === 'number') this.lastEmoteN = d.emoteN;
      })
      .catch(() => {});
  }

  /** Applies the move locally (throws on illegal) and posts the result. */
  submit(move: Move) {
    const d = this.last;
    if (!d?.game || this.closed) return;
    const sim = cloneState(d.game);
    applyMove(sim, move);
    void this.api(`/api/rooms/${this.code}/state`, {
      clientId: this.clientId,
      expectedVersion: d.version,
      state: sim,
    })
      .then(next => this.accept(next))
      .catch(e => {
        if ((e as { status?: number }).status === 409) {
          // Someone else's action landed first: quietly catch up instead of
          // alarming the player — their turn state refreshes on the next view.
          void this.poll();
          return;
        }
        this.fail(e);
      });
  }

  leave() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.cpuTimer) clearTimeout(this.cpuTimer);
    if (this.code && this.clientId) {
      void fetch(`${this.base}/api/rooms/${this.code}/leave`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: this.clientId }),
        keepalive: true,
      }).catch(() => {});
    }
  }
}
