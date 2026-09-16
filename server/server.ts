// Wahoo dedicated game server (WebSocket).
//
//   npm run server            (defaults to port 8787)
//   PORT=9000 npm run server
//
// Requires Node >= 23.6 (built-in TypeScript type stripping).
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { GameRoom } from '../src/net/room.ts';
import { randomRoomCode } from '../src/net/words.ts';
import type { ClientMsg, ServerMsg } from '../src/net/protocol.ts';

const PORT = Number(process.env.PORT ?? 8787);
const CPU_DELAY_MS = Number(process.env.CPU_DELAY_MS ?? 4000);
const MAX_ROOMS = 500; // memory backstop; empty rooms are already reclaimed
// Per-IP sliding-hour limits, mirroring the PHP relay.
const MAX_CREATES_PER_IP_PER_HOUR = 20;
const MAX_JOINS_PER_IP_PER_HOUR = 60;

const rooms = new Map<string, GameRoom>();
const sockets = new Map<string, WebSocket>();
const clientRoom = new Map<string, GameRoom>();
const clientIp = new Map<string, string>();
let nextClient = 1;

/** Sliding-hour action log per ip:kind; entries expire as they age out. */
const ipActions = new Map<string, number[]>();
function ipThrottled(ip: string, kind: string, max: number): boolean {
  const key = `${ip}:${kind}`;
  const now = Date.now();
  const recent = (ipActions.get(key) ?? []).filter(t => now - t < 3_600_000);
  if (recent.length >= max) {
    ipActions.set(key, recent);
    return true;
  }
  recent.push(now);
  ipActions.set(key, recent);
  return false;
}

function send(clientId: string, msg: ServerMsg) {
  const ws = sockets.get(clientId);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function makeCode(): string {
  for (let i = 0; i < 60; i++) {
    const code = randomRoomCode();
    if (!rooms.has(code)) return code;
  }
  // Nearly every word is taken: fall back to random letters.
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

/** Reclaim tokens travel as opaque strings; anything else is dropped. */
const cleanToken = (token: unknown): string | undefined =>
  typeof token === 'string' && token !== '' ? token.slice(0, 64) : undefined;

function handleMessage(clientId: string, msg: ClientMsg) {
  const room = clientRoom.get(clientId);
  const ip = clientIp.get(clientId) ?? 'unknown';
  if (msg.t === 'create') {
    if (room) return send(clientId, { t: 'err', msg: 'Already in a room.' });
    if (rooms.size >= MAX_ROOMS || ipThrottled(ip, 'create', MAX_CREATES_PER_IP_PER_HOUR)) {
      return send(clientId, { t: 'err', msg: 'Too many rooms — try again later.' });
    }
    const created = new GameRoom(makeCode(), send, CPU_DELAY_MS);
    rooms.set(created.code, created);
    clientRoom.set(clientId, created);
    created.addClient(clientId, msg.name, cleanToken(msg.token));
    return;
  }
  if (msg.t === 'join') {
    if (room) return send(clientId, { t: 'err', msg: 'Already in a room.' });
    if (ipThrottled(ip, 'join', MAX_JOINS_PER_IP_PER_HOUR)) {
      return send(clientId, { t: 'err', msg: 'Too many join attempts — try again later.' });
    }
    const target = rooms.get(String(msg.code).toUpperCase());
    if (!target) return send(clientId, { t: 'err', msg: 'Room not found.' });
    clientRoom.set(clientId, target);
    target.addClient(clientId, msg.name, cleanToken(msg.token));
    return;
  }
  room?.handle(clientId, msg);
}

function handleClose(clientId: string) {
  const room = clientRoom.get(clientId);
  clientRoom.delete(clientId);
  sockets.delete(clientId);
  clientIp.delete(clientId);
  if (room && room.removeClient(clientId)) rooms.delete(room.code);
}

const http = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Wahoo server is running. Connect with the Wahoo web client.\n');
});
// Clients only ever send small messages (moves, names); a 64 KB cap stops
// anyone from streaming megabytes at the parser.
const wss = new WebSocketServer({ server: http, maxPayload: 64 * 1024 });

wss.on('connection', (ws, req) => {
  const clientId = `c${nextClient++}`;
  sockets.set(clientId, ws);
  clientIp.set(clientId, req.socket.remoteAddress ?? 'unknown');
  // Liveness: a phone that sleeps mid-game never sends a TCP close, which
  // would strand its seat. Ping every 30s; no pong by the next round means
  // the socket is dead, and closing it hands the seat to a CPU.
  (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
  ws.on('pong', () => {
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
  });
  ws.on('message', data => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    try {
      handleMessage(clientId, msg);
    } catch (err) {
      console.error('message error:', err);
    }
  });
  ws.on('close', () => handleClose(clientId));
  ws.on('error', () => { /* handled by close */ });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    const live = ws as WebSocket & { isAlive?: boolean };
    if (live.isAlive === false) {
      ws.terminate(); // fires 'close' -> the seat goes to a CPU
      continue;
    }
    live.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

http.listen(PORT, () => {
  console.log(`Wahoo server listening on ws://localhost:${PORT}`);
});
