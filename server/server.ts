// Wahoo dedicated game server (WebSocket).
//
//   npm run server            (defaults to port 8787)
//   PORT=9000 npm run server
//
// Requires Node >= 23.6 (built-in TypeScript type stripping).
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { GameRoom } from '../src/net/room.ts';
import type { ClientMsg, ServerMsg } from '../src/net/protocol.ts';

const PORT = Number(process.env.PORT ?? 8787);
const CPU_DELAY_MS = Number(process.env.CPU_DELAY_MS ?? 900);

const rooms = new Map<string, GameRoom>();
const sockets = new Map<string, WebSocket>();
const clientRoom = new Map<string, GameRoom>();
let nextClient = 1;

function send(clientId: string, msg: ServerMsg) {
  const ws = sockets.get(clientId);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function makeCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function handleMessage(clientId: string, msg: ClientMsg) {
  const room = clientRoom.get(clientId);
  if (msg.t === 'create') {
    if (room) return send(clientId, { t: 'err', msg: 'Already in a room.' });
    const created = new GameRoom(makeCode(), send, CPU_DELAY_MS);
    rooms.set(created.code, created);
    clientRoom.set(clientId, created);
    created.addClient(clientId, msg.name);
    return;
  }
  if (msg.t === 'join') {
    if (room) return send(clientId, { t: 'err', msg: 'Already in a room.' });
    const target = rooms.get(String(msg.code).toUpperCase());
    if (!target) return send(clientId, { t: 'err', msg: 'Room not found.' });
    clientRoom.set(clientId, target);
    target.addClient(clientId, msg.name);
    return;
  }
  room?.handle(clientId, msg);
}

function handleClose(clientId: string) {
  const room = clientRoom.get(clientId);
  clientRoom.delete(clientId);
  sockets.delete(clientId);
  if (room && room.removeClient(clientId)) rooms.delete(room.code);
}

const http = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Wahoo server is running. Connect with the Wahoo web client.\n');
});
const wss = new WebSocketServer({ server: http });

wss.on('connection', ws => {
  const clientId = `c${nextClient++}`;
  sockets.set(clientId, ws);
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

http.listen(PORT, () => {
  console.log(`Wahoo server listening on ws://localhost:${PORT}`);
});
