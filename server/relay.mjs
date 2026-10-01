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
      // `role` tells each side which seat it got — redundant for this path
      // (a joiner already knows it's the peer) but the SAME 'paired' shape
      // is also used by find-match below, where neither side can know its
      // role in advance, so both paths send it for one consistent client
      // handler.
      ws.send(JSON.stringify({ type: 'paired', role: 'peer' }));
      result.room.host.send(JSON.stringify({ type: 'paired', role: 'host' }));
      return;
    }

    if (msg.type === 'find-match') {
      const result = registry.findMatch(ws);
      if (result.waiting) {
        ws.send(JSON.stringify({ type: 'searching' }));
        return;
      }
      result.host.send(JSON.stringify({ type: 'paired', role: 'host' }));
      result.peer.send(JSON.stringify({ type: 'paired', role: 'peer' }));
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
