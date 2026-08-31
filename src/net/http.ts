// Session for the PHP relay server (server/wahoo-php): plain HTTPS polling
// instead of WebSockets, so it runs on ordinary shared hosting. The rules
// engine runs client-side; the server stores state and enforces seats, turn
// order, and versioning. CPU turns are computed lazily by whichever polling
// client notices one is due (the server arbitrates races by version).
import { applyMove, cloneState, createGame } from '../engine/game.ts';
import { chooseMove } from '../engine/ai.ts';
import { makeView } from './protocol.ts';
import type { Difficulty, GameState, Move } from '../engine/types.ts';
import { PLAYER_NAMES } from '../engine/types.ts';
import type { OnlineHandlers } from './client.ts';

const POLL_MS = 1200;
const CPU_DELAY_MS = 4000;

interface Snapshot {
  code: string;
  version: number;
  ageMs: number;
  seats: ({ name: string; cpu: boolean; difficulty?: Difficulty | null } | null)[];
  yourSeat: number | null;
  hostIsYou: boolean;
  started: boolean;
  game: GameState | null;
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
    const response = await fetch(`${this.base}${path}`, {
      cache: 'no-store',
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
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
    this.accept(d);
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  private async poll() {
    if (this.closed || !this.code || this.busy) return;
    this.busy = true;
    try {
      const d = await this.api(`/api/rooms/${this.code}?clientId=${this.clientId}`);
      this.missedPolls = 0;
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
    }
  }

  private seatNames(d: Snapshot): string[] {
    return d.seats.map((seat, i) =>
      seat ? (seat.cpu ? `CPU ${seat.name}` : seat.name) : `CPU ${PLAYER_NAMES[i]}`,
    );
  }

  private accept(d: Snapshot) {
    const changed = d.version !== this.version;
    this.version = d.version;
    this.last = d;
    if (!changed || this.closed) return;
    this.handlers.onRoom({
      code: d.code,
      seats: d.seats.map(s =>
        s ? { name: s.name, cpu: s.cpu, difficulty: s.difficulty ?? undefined } : null,
      ),
      youAreHost: d.hostIsYou,
      yourSeat: d.yourSeat,
      started: d.started,
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
    if (d.ageMs < CPU_DELAY_MS) return;
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

  startGame() {
    const state = createGame(Math.floor(Math.random() * 2 ** 31));
    void this.api(`/api/rooms/${this.code}/start`, { clientId: this.clientId, state })
      .then(d => this.accept(d))
      .catch(e => this.fail(e));
  }

  playAgain() {
    const state = createGame(Math.floor(Math.random() * 2 ** 31));
    void this.api(`/api/rooms/${this.code}/again`, { clientId: this.clientId, state })
      .then(d => this.accept(d))
      .catch(e => this.fail(e));
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
      .catch(e => this.fail(e));
  }

  leave() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
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
