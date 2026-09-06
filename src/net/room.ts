import { applyMove, createGame } from '../engine/game.ts';
import { chooseMove } from '../engine/ai.ts';
import { EMOTES, makeView } from './protocol.ts';
import type { ClientMsg, RoomInfo, ServerMsg } from './protocol.ts';
import type { Difficulty, GameState, HouseRules } from '../engine/types.ts';
import { DEFAULT_RULES, PLAYER_NAMES } from '../engine/types.ts';

/** Keep only known, well-typed rule overrides from a client. */
export function sanitizeRules(raw: unknown): Partial<HouseRules> {
  const rules: Partial<HouseRules> = {};
  if (typeof raw !== 'object' || raw === null) return rules;
  const r = raw as Record<string, unknown>;
  if (typeof r.friendlyFire === 'boolean') rules.friendlyFire = r.friendlyFire;
  if (r.sevenMaxBunnies === 1 || r.sevenMaxBunnies === 2 || r.sevenMaxBunnies === 4) {
    rules.sevenMaxBunnies = r.sevenMaxBunnies;
  }
  if (typeof r.burrowJump === 'boolean') rules.burrowJump = r.burrowJump;
  if (typeof r.finger === 'boolean') rules.finger = r.finger;
  return rules;
}

interface Seat {
  name: string;
  cpu: boolean;
  difficulty?: Difficulty;
  clientId: string | null;
  /** Persistent client token so a disconnected player can reclaim the seat. */
  token: string | null;
}

export interface RoomSnapshot {
  seats: ({ name: string; cpu: boolean; difficulty?: Difficulty; token: string | null } | null)[];
  game: GameState | null;
}

export function sanitizeName(name: unknown): string {
  return String(name ?? 'Player').replace(/[<>&"']/g, '').slice(0, 12) || 'Player';
}

/**
 * One authoritative game room, independent of transport. The Node WebSocket
 * server and the in-browser P2P host both drive it; outbound messages go
 * through the injected `send` callback keyed by opaque client ids.
 */
export class GameRoom {
  seats: (Seat | null)[] = [null, null, null, null];
  game: GameState | null = null;
  hostId: string | null = null;
  /** clientId -> seat index (null while spectating). */
  private clients = new Map<string, number | null>();
  private tokens = new Map<string, string | null>();
  private lastAction = new Map<string, number>();
  /** Host's chosen rules for the next game, shown to everyone in the lobby. */
  private pendingRules: HouseRules = { ...DEFAULT_RULES };
  private cpuTimer: ReturnType<typeof setTimeout> | null = null;

  readonly code: string;
  private send: (clientId: string, msg: ServerMsg) => void;
  private cpuDelay: number;
  private actionCooldownMs: number;

  // No constructor parameter properties: this file also runs under Node's
  // strip-only TypeScript mode, which cannot transform them.
  constructor(
    code: string,
    send: (clientId: string, msg: ServerMsg) => void,
    cpuDelay = 4000,
    actionCooldownMs = 600,
  ) {
    this.code = code;
    this.send = send;
    this.cpuDelay = cpuDelay;
    this.actionCooldownMs = actionCooldownMs;
  }

  /** Rate limit for chatty actions (emotes, renames) so a client can't flood. */
  private throttled(id: string, action: string): boolean {
    const key = `${id}:${action}`;
    const now = Date.now();
    if (now - (this.lastAction.get(key) ?? 0) < this.actionCooldownMs) return true;
    this.lastAction.set(key, now);
    return false;
  }

  /** Add a connection: reclaims a seat by token, takes a free seat, or spectates. */
  addClient(id: string, rawName: string, token?: string): void {
    const name = sanitizeName(rawName);
    this.tokens.set(id, token ?? null);
    if (this.hostId === null) this.hostId = id;
    // Reclaim: a seat previously held by this client (now vacated or CPU-run).
    const reclaim = token
      ? this.seats.findIndex(s => s !== null && s.clientId === null && s.token === token)
      : -1;
    const seat = reclaim !== -1
      ? reclaim
      : this.game ? -1 : this.seats.findIndex(s => s === null);
    if (seat === -1) {
      this.clients.set(id, null);
    } else {
      this.seats[seat] = { name, cpu: false, clientId: id, token: token ?? null };
      this.clients.set(id, seat);
    }
    this.broadcastRoom();
    if (this.game) this.broadcastState();
  }

  handle(id: string, msg: ClientMsg): void {
    if (!this.clients.has(id)) return;
    switch (msg.t) {
      case 'sit': {
        if (this.game) return;
        const target = msg.seat | 0;
        const current = this.clients.get(id) ?? null;
        if (target < 0 || target > 3 || this.seats[target]) return;
        const name = current !== null ? this.seats[current]?.name ?? 'Player' : 'Player';
        if (current !== null) this.seats[current] = null;
        this.seats[target] = { name, cpu: false, clientId: id, token: this.tokens.get(id) ?? null };
        this.clients.set(id, target);
        this.broadcastRoom();
        break;
      }
      case 'cpu': {
        if (this.hostId !== id || this.game) return;
        const target = msg.seat | 0;
        if (target < 0 || target > 3) return;
        if (msg.on && this.seats[target] === null) {
          this.seats[target] = {
            name: PLAYER_NAMES[target],
            cpu: true,
            difficulty: msg.difficulty ?? 'medium',
            clientId: null,
            token: null,
          };
        } else if (!msg.on && this.seats[target]?.cpu) {
          this.seats[target] = null;
        }
        this.broadcastRoom();
        break;
      }
      case 'start': {
        if (this.hostId !== id || this.game) return;
        for (let i = 0; i < 4; i++) {
          if (!this.seats[i]) {
            this.seats[i] = {
              name: PLAYER_NAMES[i], cpu: true, difficulty: 'medium', clientId: null, token: null,
            };
          }
        }
        this.game = createGame(Math.floor(Math.random() * 2 ** 31), sanitizeRules(msg.rules));
        this.broadcastRoom();
        this.broadcastState();
        this.scheduleCpu();
        break;
      }
      case 'again': {
        // Host starts a rematch with the same seats and rules.
        if (this.hostId !== id || !this.game || this.game.winner === null) return;
        this.game = createGame(Math.floor(Math.random() * 2 ** 31), this.game.rules);
        this.broadcastRoom();
        this.broadcastState();
        this.scheduleCpu();
        break;
      }
      case 'rules': {
        if (this.hostId !== id || this.game) return;
        this.pendingRules = { ...DEFAULT_RULES, ...sanitizeRules(msg.rules) };
        this.broadcastRoom();
        break;
      }
      case 'rename': {
        const seat = this.clients.get(id);
        if (seat === null || seat === undefined || !this.seats[seat]) return;
        if (this.throttled(id, 'rename')) return;
        this.seats[seat]!.name = sanitizeName(msg.name);
        this.broadcastRoom();
        if (this.game) this.broadcastState(); // views carry player names
        break;
      }
      case 'emote': {
        const seat = this.clients.get(id);
        if (seat === null || seat === undefined) return;
        if (!EMOTES.includes(msg.emoji)) return;
        // The finger can be banned from the table via house rules.
        const tableRules = this.game?.rules ?? this.pendingRules;
        if (msg.emoji === 'finger' && tableRules.finger === false) return;
        if (this.throttled(id, 'emote')) return;
        for (const clientId of this.clients.keys()) {
          this.send(clientId, { t: 'emote', seat, emoji: msg.emoji });
        }
        break;
      }
      case 'move': {
        const seat = this.clients.get(id);
        const game = this.game;
        if (seat === null || seat === undefined || !game || game.winner !== null) return;
        if (game.current !== seat) return this.send(id, { t: 'err', msg: 'Not your turn.' });
        try {
          applyMove(game, msg.move);
        } catch (err) {
          return this.send(id, { t: 'err', msg: `Illegal move: ${(err as Error).message}` });
        }
        this.broadcastState();
        this.scheduleCpu();
        break;
      }
    }
  }

  /** Drop a connection. Returns true when no human clients remain. */
  removeClient(id: string): boolean {
    const seat = this.clients.get(id);
    this.clients.delete(id);
    this.tokens.delete(id);
    for (const key of this.lastAction.keys()) {
      if (key.startsWith(`${id}:`)) this.lastAction.delete(key);
    }
    if (seat !== null && seat !== undefined && this.seats[seat]?.clientId === id) {
      if (this.game && this.game.winner === null) {
        // Keep the game going: a CPU takes over, but the token stays so the
        // player can reconnect and reclaim the seat.
        const old = this.seats[seat]!;
        this.seats[seat] = {
          name: old.name, cpu: true, difficulty: 'medium', clientId: null, token: old.token,
        };
        this.scheduleCpu();
      } else {
        this.seats[seat] = null;
      }
    }
    if (this.hostId === id) {
      this.hostId = this.clients.keys().next().value ?? null;
    }
    if (this.clients.size === 0) {
      this.dispose();
      return true;
    }
    this.broadcastRoom();
    if (this.game) this.broadcastState();
    return false;
  }

  dispose(): void {
    if (this.cpuTimer) clearTimeout(this.cpuTimer);
    this.cpuTimer = null;
  }

  /** Serializable state for persisting a room across a page reload. */
  snapshot(): RoomSnapshot {
    return structuredClone({
      seats: this.seats.map(s =>
        s ? { name: s.name, cpu: s.cpu, difficulty: s.difficulty, token: s.token } : null,
      ),
      game: this.game,
    });
  }

  /** Rebuild a room from a snapshot; offline human seats run as CPUs until reclaimed. */
  static restore(
    code: string,
    send: (clientId: string, msg: ServerMsg) => void,
    snap: RoomSnapshot,
    cpuDelay = 4000,
  ): GameRoom {
    const room = new GameRoom(code, send, cpuDelay);
    room.seats = snap.seats.map(s =>
      s
        ? {
            name: s.name,
            cpu: true,
            difficulty: s.difficulty ?? 'medium',
            clientId: null,
            token: s.token ?? null,
          }
        : null,
    );
    room.game = structuredClone(snap.game);
    if (room.game && room.game.winner === null) room.scheduleCpu();
    return room;
  }

  private roomInfo(clientId: string): RoomInfo {
    return {
      code: this.code,
      seats: this.seats.map(s =>
        s ? { name: s.name, cpu: s.cpu, difficulty: s.difficulty } : null,
      ),
      youAreHost: this.hostId === clientId,
      yourSeat: this.clients.get(clientId) ?? null,
      started: this.game !== null,
      rules: this.pendingRules,
    };
  }

  private broadcastRoom(): void {
    for (const id of this.clients.keys()) this.send(id, { t: 'room', room: this.roomInfo(id) });
  }

  private seatNames(): string[] {
    return this.seats.map((s, i) =>
      s ? (s.cpu ? `CPU ${s.name}` : s.name) : `CPU ${PLAYER_NAMES[i]}`,
    );
  }

  private broadcastState(): void {
    const game = this.game;
    if (!game) return;
    const names = this.seatNames();
    for (const [id, seat] of this.clients) {
      const canAct =
        seat !== null &&
        game.current === seat &&
        this.seats[seat] !== null &&
        !this.seats[seat]!.cpu;
      this.send(id, { t: 'state', view: makeView(game, seat, names, canAct) });
    }
  }

  private scheduleCpu(): void {
    const game = this.game;
    if (!game || game.winner !== null) return;
    const seat = this.seats[game.current];
    if (seat && !seat.cpu) return;
    if (this.cpuTimer) clearTimeout(this.cpuTimer);
    this.cpuTimer = setTimeout(() => {
      this.cpuTimer = null;
      if (!this.game || this.game.winner !== null) return;
      const acting = this.seats[this.game.current];
      try {
        applyMove(this.game, chooseMove(this.game, acting?.difficulty ?? 'medium'));
      } catch (err) {
        console.error('CPU move failed:', err);
        return;
      }
      this.broadcastState();
      this.scheduleCpu();
    }, this.cpuDelay);
  }
}
