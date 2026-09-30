// Standalone relay server (`npm run relay`). Not part of the Vite/
// Electron bundle — nothing under src/ imports this file. A dumb,
// game-logic-unaware WebSocket relay: it pairs two sockets under a
// short room code and forwards 'relay' messages between them verbatim,
// never parsing `payload`.
import { WebSocketServer } from 'ws';
import { RoomRegistry } from './roomRegistry.mjs';

const PORT = process.env.RELAY_PORT || 8787;
const registry = new RoomRegistry();

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.role = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'create-room') {
      const code = registry.createRoom(ws);
      ws.send(JSON.stringify({ type: 'room-created', code }));
      return;
    }

    if (msg.type === 'join-room') {
      const result = registry.joinRoom(msg.code, ws);
      if (result.error) {
        ws.send(JSON.stringify({ type: 'join-error', reason: result.error }));
        return;
      }
      ws.send(JSON.stringify({ type: 'paired' }));
      result.room.host.send(JSON.stringify({ type: 'paired' }));
      return;
    }

    if (msg.type === 'relay') {
      registry.relay(ws, msg.payload);
      return;
    }
  });

  ws.on('close', () => {
    registry.disconnect(ws);
  });
});

console.log(`Relay server listening on ws://localhost:${PORT}`);
