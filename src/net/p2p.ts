import Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import { GameRoom } from './room.ts';
import { randomRoomCode } from './words.ts';
import type { RoomSnapshot } from './room.ts';
import type { ClientMsg, ServerMsg } from './protocol.ts';
import type { Difficulty, HouseRules, Move } from '../engine/types.ts';
import type { OnlineHandlers } from './client.ts';

/** Namespaced PeerJS id so room codes don't collide with other apps. */
const peerIdFor = (code: string) => `wahoo-bunny-race-${code.toLowerCase()}`;

/**
 * ICE servers: STUN discovers direct peer-to-peer routes; the free Open Relay
 * TURN servers carry (still end-to-end encrypted) traffic when strict NATs
 * block a direct connection. Relay only engages when direct fails. Swap in
 * your own TURN credentials here if the public relay proves unreliable.
 */
const PEER_OPTIONS = {
  config: {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:openrelay.metered.ca:80'] },
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443',
          'turns:openrelay.metered.ca:443?transport=tcp',
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ],
  },
};

/** How long a guest waits for the data channel before giving up. */
const CONNECT_TIMEOUT_MS = 20_000;

const SNAPSHOT_KEY = 'wahoo-host-snapshot';

const HOST_ID = 'host';

export interface HostSnapshot {
  code: string;
  name: string;
  snap: RoomSnapshot;
  savedAt: number;
}

/** The unfinished hosted game persisted by the last host session, if any. */
export function savedHostGame(): HostSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HostSnapshot;
    if (!parsed.code || !parsed.snap?.game || parsed.snap.game.winner !== null) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearHostGame(): void {
  localStorage.removeItem(SNAPSHOT_KEY);
}

/**
 * Hosts a room inside this browser tab: the authoritative GameRoom runs
 * locally, guests connect over WebRTC data channels (PeerJS handles the
 * handshake; on a shared network the traffic then flows peer-to-peer).
 * The room state is snapshotted to localStorage so a closed tab can resume.
 */
export class P2PHostSession {
  readonly code: string;
  private name: string;
  private peer: Peer;
  private room: GameRoom;
  private conns = new Map<string, DataConnection>();

  constructor(
    name: string,
    private token: string,
    private handlers: OnlineHandlers,
    resume?: HostSnapshot,
  ) {
    this.code = resume?.code ?? randomRoomCode();
    this.name = name || resume?.name || 'Player';
    this.room = resume
      ? GameRoom.restore(this.code, (cid, msg) => this.deliver(cid, msg), resume.snap)
      : new GameRoom(this.code, (cid, msg) => this.deliver(cid, msg));
    this.peer = new Peer(peerIdFor(this.code), PEER_OPTIONS);
    this.peer.on('open', () => this.room.addClient(HOST_ID, this.name, this.token));
    this.peer.on('connection', conn => this.accept(conn));
    this.peer.on('error', err => {
      const type = (err as { type?: string }).type;
      if (type === 'unavailable-id') {
        this.handlers.onError('Room code collision — try hosting again.');
      } else {
        this.handlers.onError(`Connection error: ${type ?? err}`);
      }
    });
  }

  /** Messages for the host player short-circuit straight to the UI. */
  private deliver(clientId: string, msg: ServerMsg) {
    if (clientId === HOST_ID) {
      if (msg.t === 'state') this.handlers.onView(msg.view);
      else if (msg.t === 'room') this.handlers.onRoom(msg.room);
      else if (msg.t === 'emote') this.handlers.onEmote?.(msg.seat, msg.emoji);
      else if (msg.t === 'err') this.handlers.onError(msg.msg);
    } else {
      this.conns.get(clientId)?.send(msg);
    }
    if (msg.t === 'state') this.persist();
  }

  private persist() {
    try {
      if (this.room.game && this.room.game.winner === null) {
        const data: HostSnapshot = {
          code: this.code,
          name: this.name,
          snap: this.room.snapshot(),
          savedAt: Date.now(),
        };
        localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(data));
      } else {
        clearHostGame();
      }
    } catch {
      /* storage may be unavailable; resume is best-effort */
    }
  }

  private accept(conn: DataConnection) {
    const id = conn.peer;
    conn.on('open', () => this.conns.set(id, conn));
    conn.on('data', raw => {
      const msg = raw as ClientMsg;
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'join') this.room.addClient(id, msg.name, msg.token);
      else if (msg.t !== 'create') this.room.handle(id, msg);
    });
    const drop = () => {
      if (this.conns.delete(id)) this.room.removeClient(id);
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  sit(seat: number) { this.room.handle(HOST_ID, { t: 'sit', seat }); }
  cpu(seat: number, on: boolean, difficulty?: Difficulty) { this.room.handle(HOST_ID, { t: 'cpu', seat, on, difficulty }); }
  startGame(rules?: Partial<HouseRules>) { this.room.handle(HOST_ID, { t: 'start', rules }); }
  emote(emoji: string) { this.room.handle(HOST_ID, { t: 'emote', emoji }); }
  playAgain() { this.room.handle(HOST_ID, { t: 'again' }); }
  submit(move: Move) { this.room.handle(HOST_ID, { t: 'move', move }); }

  leave() {
    clearHostGame(); // leaving on purpose: don't offer to resume
    this.room.dispose();
    this.peer.destroy();
  }
}

/** Joins a browser-hosted room by code. Mirrors OnlineSession's interface. */
export class P2PGuestSession {
  private peer: Peer;
  private conn: DataConnection | null = null;
  private closed = false;

  constructor(
    code: string,
    name: string,
    token: string,
    private handlers: OnlineHandlers,
  ) {
    this.peer = new Peer(PEER_OPTIONS);
    this.peer.on('open', () => {
      const conn = this.peer.connect(peerIdFor(code), { reliable: true });
      this.conn = conn;
      // If no route can be found (even via the TURN relay), say so instead of
      // hanging on the spinner forever.
      const connectTimer = setTimeout(() => {
        if (!this.closed && !conn.open) {
          this.handlers.onError(
            'Could not reach the host — this network may be blocking the connection. ' +
              'Try again, or use the dedicated server option.',
          );
          this.leave();
        }
      }, CONNECT_TIMEOUT_MS);
      conn.on('open', () => {
        clearTimeout(connectTimer);
        conn.send({ t: 'join', code, name, token } satisfies ClientMsg);
      });
      conn.on('data', raw => {
        const msg = raw as ServerMsg;
        if (!msg || typeof msg.t !== 'string') return;
        if (msg.t === 'state') this.handlers.onView(msg.view);
        else if (msg.t === 'room') this.handlers.onRoom(msg.room);
        else if (msg.t === 'emote') this.handlers.onEmote?.(msg.seat, msg.emoji);
        else if (msg.t === 'err') this.handlers.onError(msg.msg);
      });
      conn.on('close', () => {
        if (!this.closed) this.handlers.onClose();
      });
    });
    this.peer.on('error', err => {
      const type = (err as { type?: string }).type;
      if (this.closed) return;
      if (type === 'peer-unavailable') this.handlers.onError('Room not found — check the code.');
      else this.handlers.onError(`Connection error: ${type ?? err}`);
    });
  }

  private send(msg: ClientMsg) {
    if (this.conn?.open) this.conn.send(msg);
  }

  sit(seat: number) { this.send({ t: 'sit', seat }); }
  cpu(seat: number, on: boolean, difficulty?: Difficulty) { this.send({ t: 'cpu', seat, on, difficulty }); }
  startGame(rules?: Partial<HouseRules>) { this.send({ t: 'start', rules }); }
  emote(emoji: string) { this.send({ t: 'emote', emoji }); }
  playAgain() { this.send({ t: 'again' }); }
  submit(move: Move) { this.send({ t: 'move', move }); }

  leave() {
    this.closed = true;
    this.peer.destroy();
  }
}
