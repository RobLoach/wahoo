// Wahoo authoritative game server.
//
//   npm run server            (defaults to port 8787)
//   PORT=9000 npm run server
//
// Requires Node >= 23.6 (built-in TypeScript type stripping).
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { applyMove, createGame } from '../src/engine/game.ts';
import { chooseMove } from '../src/engine/ai.ts';
import { makeView } from '../src/net/protocol.ts';
import type { ClientMsg, RoomInfo, ServerMsg } from '../src/net/protocol.ts';
import type { GameState } from '../src/engine/types.ts';

const PORT = Number(process.env.PORT ?? 8787);
const CPU_DELAY_MS = Number(process.env.CPU_DELAY_MS ?? 900);

interface Seat {
  name: string;
  cpu: boolean;
  conn: WebSocket | null;
}

interface Room {
  code: string;
  seats: (Seat | null)[];
  host: WebSocket | null;
  game: GameState | null;
  cpuTimer: NodeJS.Timeout | null;
  spectators: Set<WebSocket>;
}

const rooms = new Map<string, Room>();
const clientRoom = new Map<WebSocket, { room: Room; seat: number | null }>();

function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function makeCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function roomInfo(room: Room, ws: WebSocket): RoomInfo {
  const entry = clientRoom.get(ws);
  return {
    code: room.code,
    seats: room.seats.map(s => (s ? { name: s.name, cpu: s.cpu } : null)),
    youAreHost: room.host === ws,
    yourSeat: entry?.room === room ? entry.seat : null,
    started: room.game !== null,
  };
}

function everyone(room: Room): WebSocket[] {
  const conns = room.seats
    .map(s => s?.conn)
    .filter((c): c is WebSocket => !!c);
  return [...conns, ...room.spectators];
}

function broadcastRoom(room: Room) {
  for (const ws of everyone(room)) send(ws, { t: 'room', room: roomInfo(room, ws) });
}

function seatNames(room: Room): string[] {
  return room.seats.map((s, i) => (s ? (s.cpu ? `CPU ${s.name}` : s.name) : `CPU ${i}`));
}

function broadcastState(room: Room) {
  const game = room.game;
  if (!game) return;
  const names = seatNames(room);
  for (const ws of everyone(room)) {
    const entry = clientRoom.get(ws);
    const seat = entry?.seat ?? null;
    const canAct =
      seat !== null &&
      game.current === seat &&
      room.seats[seat] !== null &&
      !room.seats[seat]!.cpu;
    send(ws, { t: 'state', view: makeView(game, seat, names, canAct) });
  }
}

function scheduleCpu(room: Room) {
  const game = room.game;
  if (!game || game.winner !== null) return;
  const seat = room.seats[game.current];
  const isCpu = !seat || seat.cpu;
  if (!isCpu) return;
  if (room.cpuTimer) clearTimeout(room.cpuTimer);
  room.cpuTimer = setTimeout(() => {
    room.cpuTimer = null;
    if (!room.game || room.game.winner !== null) return;
    try {
      applyMove(room.game, chooseMove(room.game));
    } catch (err) {
      console.error('CPU move failed:', err);
      return;
    }
    broadcastState(room);
    scheduleCpu(room);
  }, CPU_DELAY_MS);
}

function handleMessage(ws: WebSocket, msg: ClientMsg) {
  const entry = clientRoom.get(ws);

  switch (msg.t) {
    case 'create': {
      if (entry) return send(ws, { t: 'err', msg: 'Already in a room.' });
      const room: Room = {
        code: makeCode(),
        seats: [null, null, null, null],
        host: ws,
        game: null,
        cpuTimer: null,
        spectators: new Set(),
      };
      room.seats[0] = { name: sanitize(msg.name), cpu: false, conn: ws };
      rooms.set(room.code, room);
      clientRoom.set(ws, { room, seat: 0 });
      broadcastRoom(room);
      break;
    }
    case 'join': {
      if (entry) return send(ws, { t: 'err', msg: 'Already in a room.' });
      const room = rooms.get(String(msg.code).toUpperCase());
      if (!room) return send(ws, { t: 'err', msg: 'Room not found.' });
      const seat = room.seats.findIndex(s => s === null);
      if (seat === -1 || room.game) {
        room.spectators.add(ws);
        clientRoom.set(ws, { room, seat: null });
      } else {
        room.seats[seat] = { name: sanitize(msg.name), cpu: false, conn: ws };
        clientRoom.set(ws, { room, seat });
      }
      broadcastRoom(room);
      if (room.game) broadcastState(room);
      break;
    }
    case 'sit': {
      if (!entry || entry.room.game) return;
      const { room } = entry;
      const target = msg.seat | 0;
      if (target < 0 || target > 3 || room.seats[target]) return;
      const name = entry.seat !== null ? room.seats[entry.seat]?.name ?? 'Player' : 'Player';
      if (entry.seat !== null) room.seats[entry.seat] = null;
      room.seats[target] = { name, cpu: false, conn: ws };
      entry.seat = target;
      broadcastRoom(room);
      break;
    }
    case 'cpu': {
      if (!entry || entry.room.host !== ws || entry.room.game) return;
      const { room } = entry;
      const target = msg.seat | 0;
      if (target < 0 || target > 3) return;
      if (msg.on && room.seats[target] === null) {
        room.seats[target] = { name: nameForSeat(target), cpu: true, conn: null };
      } else if (!msg.on && room.seats[target]?.cpu) {
        room.seats[target] = null;
      }
      broadcastRoom(room);
      break;
    }
    case 'start': {
      if (!entry || entry.room.host !== ws || entry.room.game) return;
      const { room } = entry;
      for (let i = 0; i < 4; i++) {
        if (!room.seats[i]) room.seats[i] = { name: nameForSeat(i), cpu: true, conn: null };
      }
      room.game = createGame(Math.floor(Math.random() * 2 ** 31));
      broadcastRoom(room);
      broadcastState(room);
      scheduleCpu(room);
      break;
    }
    case 'move': {
      if (!entry || entry.seat === null) return;
      const { room } = entry;
      const game = room.game;
      if (!game || game.winner !== null) return;
      if (game.current !== entry.seat) return send(ws, { t: 'err', msg: 'Not your turn.' });
      try {
        applyMove(game, msg.move);
      } catch (err) {
        return send(ws, { t: 'err', msg: `Illegal move: ${(err as Error).message}` });
      }
      broadcastState(room);
      scheduleCpu(room);
      break;
    }
  }
}

const SEAT_NAMES = ['Red', 'Blue', 'Green', 'Yellow'];
const nameForSeat = (i: number) => SEAT_NAMES[i];

function sanitize(name: unknown): string {
  return String(name ?? 'Player').replace(/[<>&"']/g, '').slice(0, 12) || 'Player';
}

function handleClose(ws: WebSocket) {
  const entry = clientRoom.get(ws);
  if (!entry) return;
  clientRoom.delete(ws);
  const { room, seat } = entry;
  room.spectators.delete(ws);
  if (seat !== null && room.seats[seat]?.conn === ws) {
    if (room.game && room.game.winner === null) {
      // Keep the game going: the seat becomes a CPU.
      room.seats[seat] = { name: `${room.seats[seat]!.name}`, cpu: true, conn: null };
      scheduleCpu(room);
    } else {
      room.seats[seat] = null;
    }
  }
  if (room.host === ws) {
    room.host = room.seats.find(s => s && !s.cpu && s.conn)?.conn ?? null;
  }
  const anyHumans = room.seats.some(s => s && !s.cpu) || room.spectators.size > 0;
  if (!anyHumans) {
    if (room.cpuTimer) clearTimeout(room.cpuTimer);
    rooms.delete(room.code);
    return;
  }
  broadcastRoom(room);
  if (room.game) broadcastState(room);
}

const http = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Wahoo server is running. Connect with the Wahoo web client.\n');
});
const wss = new WebSocketServer({ server: http });

wss.on('connection', ws => {
  ws.on('message', data => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    try {
      handleMessage(ws, msg);
    } catch (err) {
      console.error('message error:', err);
    }
  });
  ws.on('close', () => handleClose(ws));
  ws.on('error', () => { /* handled by close */ });
});

http.listen(PORT, () => {
  console.log(`Wahoo server listening on ws://localhost:${PORT}`);
});
