import Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import { GameRoom } from './room.ts';
import type { ClientMsg, ServerMsg } from './protocol.ts';
import type { Move } from '../engine/types.ts';
import type { OnlineHandlers } from './client.ts';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 5;
/** Namespaced PeerJS id so room codes don't collide with other apps. */
const peerIdFor = (code: string) => `wahoo-bunny-race-${code.toLowerCase()}`;

function randomCode(): string {
  return Array.from(
    { length: CODE_LEN },
    () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)],
  ).join('');
}

const HOST_ID = 'host';

/**
 * Hosts a room inside this browser tab: the authoritative GameRoom runs
 * locally, guests connect over WebRTC data channels (PeerJS handles the
 * handshake; on a shared network the traffic then flows peer-to-peer).
 */
export class P2PHostSession {
  readonly code = randomCode();
  private peer: Peer;
  private room: GameRoom;
  private conns = new Map<string, DataConnection>();

  constructor(name: string, private handlers: OnlineHandlers) {
    this.room = new GameRoom(this.code, (clientId, msg) => this.deliver(clientId, msg));
    this.peer = new Peer(peerIdFor(this.code));
    this.peer.on('open', () => this.room.addClient(HOST_ID, name));
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
      else if (msg.t === 'err') this.handlers.onError(msg.msg);
    } else {
      this.conns.get(clientId)?.send(msg);
    }
  }

  private accept(conn: DataConnection) {
    const id = conn.peer;
    conn.on('open', () => this.conns.set(id, conn));
    conn.on('data', raw => {
      const msg = raw as ClientMsg;
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'join') this.room.addClient(id, msg.name);
      else if (msg.t !== 'create') this.room.handle(id, msg);
    });
    const drop = () => {
      if (this.conns.delete(id)) this.room.removeClient(id);
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  sit(seat: number) { this.room.handle(HOST_ID, { t: 'sit', seat }); }
  cpu(seat: number, on: boolean) { this.room.handle(HOST_ID, { t: 'cpu', seat, on }); }
  startGame() { this.room.handle(HOST_ID, { t: 'start' }); }
  submit(move: Move) { this.room.handle(HOST_ID, { t: 'move', move }); }

  leave() {
    this.room.dispose();
    this.peer.destroy();
  }
}

/** Joins a browser-hosted room by code. Mirrors OnlineSession's interface. */
export class P2PGuestSession {
  private peer: Peer;
  private conn: DataConnection | null = null;
  private closed = false;

  constructor(code: string, name: string, private handlers: OnlineHandlers) {
    this.peer = new Peer();
    this.peer.on('open', () => {
      const conn = this.peer.connect(peerIdFor(code), { reliable: true });
      this.conn = conn;
      conn.on('open', () => conn.send({ t: 'join', code, name } satisfies ClientMsg));
      conn.on('data', raw => {
        const msg = raw as ServerMsg;
        if (!msg || typeof msg.t !== 'string') return;
        if (msg.t === 'state') this.handlers.onView(msg.view);
        else if (msg.t === 'room') this.handlers.onRoom(msg.room);
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
  cpu(seat: number, on: boolean) { this.send({ t: 'cpu', seat, on }); }
  startGame() { this.send({ t: 'start' }); }
  submit(move: Move) { this.send({ t: 'move', move }); }

  leave() {
    this.closed = true;
    this.peer.destroy();
  }
}
