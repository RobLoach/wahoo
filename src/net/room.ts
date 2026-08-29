import { applyMove, createGame } from '../engine/game.ts';
import { chooseMove } from '../engine/ai.ts';
import { makeView } from './protocol.ts';
import type { ClientMsg, RoomInfo, ServerMsg } from './protocol.ts';
import type { GameState } from '../engine/types.ts';
import { PLAYER_NAMES } from '../engine/types.ts';

interface Seat {
  name: string;
  cpu: boolean;
  clientId: string | null;
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
  private cpuTimer: ReturnType<typeof setTimeout> | null = null;

  readonly code: string;
  private send: (clientId: string, msg: ServerMsg) => void;
  private cpuDelay: number;

  // No constructor parameter properties: this file also runs under Node's
  // strip-only TypeScript mode, which cannot transform them.
  constructor(code: string, send: (clientId: string, msg: ServerMsg) => void, cpuDelay = 900) {
    this.code = code;
    this.send = send;
    this.cpuDelay = cpuDelay;
  }

  /** Add a connection: takes the first free seat, or spectates mid-game. */
  addClient(id: string, rawName: string): void {
    const name = sanitizeName(rawName);
    if (this.hostId === null) this.hostId = id;
    const seat = this.game ? -1 : this.seats.findIndex(s => s === null);
    if (seat === -1) {
      this.clients.set(id, null);
    } else {
      this.seats[seat] = { name, cpu: false, clientId: id };
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
        this.seats[target] = { name, cpu: false, clientId: id };
        this.clients.set(id, target);
        this.broadcastRoom();
        break;
      }
      case 'cpu': {
        if (this.hostId !== id || this.game) return;
        const target = msg.seat | 0;
        if (target < 0 || target > 3) return;
        if (msg.on && this.seats[target] === null) {
          this.seats[target] = { name: PLAYER_NAMES[target], cpu: true, clientId: null };
        } else if (!msg.on && this.seats[target]?.cpu) {
          this.seats[target] = null;
        }
        this.broadcastRoom();
        break;
      }
      case 'start': {
        if (this.hostId !== id || this.game) return;
        for (let i = 0; i < 4; i++) {
          if (!this.seats[i]) this.seats[i] = { name: PLAYER_NAMES[i], cpu: true, clientId: null };
        }
        this.game = createGame(Math.floor(Math.random() * 2 ** 31));
        this.broadcastRoom();
        this.broadcastState();
        this.scheduleCpu();
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
    if (seat !== null && seat !== undefined && this.seats[seat]?.clientId === id) {
      if (this.game && this.game.winner === null) {
        // Keep the game going: the seat becomes a CPU.
        this.seats[seat] = { name: this.seats[seat]!.name, cpu: true, clientId: null };
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

  private roomInfo(clientId: string): RoomInfo {
    return {
      code: this.code,
      seats: this.seats.map(s => (s ? { name: s.name, cpu: s.cpu } : null)),
      youAreHost: this.hostId === clientId,
      yourSeat: this.clients.get(clientId) ?? null,
      started: this.game !== null,
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
      try {
        applyMove(this.game, chooseMove(this.game));
      } catch (err) {
        console.error('CPU move failed:', err);
        return;
      }
      this.broadcastState();
      this.scheduleCpu();
    }, this.cpuDelay);
  }
}
