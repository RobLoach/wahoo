import type { ClientMsg, RoomInfo, ServerMsg, View } from './protocol.ts';
import type { Difficulty, Move } from '../engine/types.ts';

export interface OnlineHandlers {
  onView(view: View): void;
  onRoom(room: RoomInfo): void;
  onError(msg: string): void;
  onClose(): void;
}

export class OnlineSession {
  private ws: WebSocket;
  private closed = false;

  constructor(url: string, private handlers: OnlineHandlers, onOpen: () => void) {
    this.ws = new WebSocket(url);
    this.ws.onopen = onOpen;
    this.ws.onmessage = event => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.t === 'state') this.handlers.onView(msg.view);
      else if (msg.t === 'room') this.handlers.onRoom(msg.room);
      else if (msg.t === 'err') this.handlers.onError(msg.msg);
    };
    this.ws.onerror = () => {
      if (!this.closed) this.handlers.onError('Could not reach the server.');
    };
    this.ws.onclose = () => {
      if (!this.closed) this.handlers.onClose();
    };
  }

  private send(msg: ClientMsg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  create(name: string, token?: string) { this.send({ t: 'create', name, token }); }
  join(code: string, name: string, token?: string) { this.send({ t: 'join', code, name, token }); }
  sit(seat: number) { this.send({ t: 'sit', seat }); }
  cpu(seat: number, on: boolean, difficulty?: Difficulty) { this.send({ t: 'cpu', seat, on, difficulty }); }
  startGame() { this.send({ t: 'start' }); }
  playAgain() { this.send({ t: 'again' }); }
  submit(move: Move) { this.send({ t: 'move', move }); }

  leave() {
    this.closed = true;
    this.ws.close();
  }
}
