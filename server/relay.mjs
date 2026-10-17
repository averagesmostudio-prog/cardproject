// Standalone relay server (`npm run relay`). Not part of the Vite/
// Electron bundle — nothing under src/ imports this file. A dumb,
// game-logic-unaware WebSocket relay: it pairs two sockets under a
// short room code and forwards 'relay' messages between them verbatim,
// never parsing `payload`.
//
// The same port also serves a small JSON API for accounts (auth.mjs):
//   GET  /auth/config    -> { googleClientId }
//   POST /auth/register  { username, password } -> { token, user }
//   POST /auth/login     { username, password } -> { token, user }
//   POST /auth/google    { credential }         -> { token, user }
//   GET  /auth/me        (Bearer token)         -> { user }
//   GET  /decks          (Bearer token)         -> { decks, deleted }
//   PUT  /decks          (Bearer token) { decks, deleted } -> { ok }
// Accounts are optional: a socket that sends no (or a bad) token plays as a
// guest, exactly as before. A signed-in player's display name is handed to
// their opponent in the 'paired' message.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomRegistry } from './roomRegistry.mjs';
import { AuthService, AuthError, RateLimiter, UserStore, loadSecret, validateDecksPayload } from './auth.mjs';

const MAX_BODY_BYTES = 1024 * 1024;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
};

const readJson = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      reject(new AuthError(413, 'too-large', 'Request too large.'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    try {
      resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
    } catch {
      reject(new AuthError(400, 'bad-json', 'Invalid JSON.'));
    }
  });
  req.on('error', reject);
});

const bearer = (req) => {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
};

// Behind nginx every request arrives from 127.0.0.1, so the real caller comes
// from the proxy's X-Real-IP (this box's nginx sets it) or X-Forwarded-For.
const clientKey = (req) => req.headers['x-real-ip']
  || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  || req.socket.remoteAddress
  || 'unknown';

export async function createRelayServer({
  port = process.env.RELAY_PORT || 8787,
  dataDir = process.env.AUTH_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data'),
  secret = process.env.AUTH_SECRET,
  googleClientId = process.env.GOOGLE_CLIENT_ID || null,
  fetchImpl = fetch,
  authLimiter = new RateLimiter({ max: 10, windowMs: 15 * 60 * 1000 }),
} = {}) {
  const store = new UserStore(dataDir);
  await store.init();
  const auth = new AuthService({ store, secret: await loadSecret(dataDir, secret), googleClientId, fetchImpl });
  const registry = new RoomRegistry();

  const handleHttp = async (req, res) => {
    const url = new URL(req.url, 'http://relay');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    try {
      if (req.method === 'GET' && url.pathname === '/auth/config') {
        return sendJson(res, 200, { googleClientId: auth.googleClientId });
      }
      if (req.method === 'POST' && ['/auth/register', '/auth/login', '/auth/google'].includes(url.pathname)) {
        if (!authLimiter.allow(clientKey(req))) throw new AuthError(429, 'rate-limited', 'Too many attempts — try again in a few minutes.');
        const body = await readJson(req);
        if (url.pathname === '/auth/register') return sendJson(res, 200, await auth.register(body.username, body.password));
        if (url.pathname === '/auth/login') return sendJson(res, 200, await auth.login(body.username, body.password));
        return sendJson(res, 200, await auth.google(body.credential));
      }
      if (url.pathname === '/auth/me' || url.pathname === '/decks') {
        const user = auth.userFromToken(bearer(req));
        if (!user) throw new AuthError(401, 'unauthorized', 'Please sign in again.');
        if (req.method === 'GET' && url.pathname === '/auth/me') {
          return sendJson(res, 200, { user: { id: user.id, username: user.username, displayName: user.displayName } });
        }
        if (req.method === 'GET') return sendJson(res, 200, { decks: user.decks, deleted: user.deleted });
        if (req.method === 'PUT') {
          await store.setDecks(user.id, validateDecksPayload(await readJson(req)));
          return sendJson(res, 200, { ok: true });
        }
      }
      return sendJson(res, 404, { error: 'not-found', message: 'Not found.' });
    } catch (err) {
      if (err instanceof AuthError) return sendJson(res, err.status, { error: err.code, message: err.message });
      console.error(err);
      return sendJson(res, 500, { error: 'server-error', message: 'Something went wrong.' });
    }
  };

  const server = http.createServer(handleHttp);
  const wss = new WebSocketServer({ server });

  // Names a socket by its (optional) token. A bad token just means guest.
  const identify = (ws, token) => {
    const user = token ? auth.userFromToken(token) : null;
    ws.displayName = user ? user.displayName : null;
  };

  const paired = (role, opponent) => JSON.stringify({
    type: 'paired',
    role,
    ...(opponent.displayName ? { opponentName: opponent.displayName } : {}),
  });

  wss.on('connection', (ws) => {
    ws.roomCode = null;
    ws.role = null;
    ws.displayName = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === 'create-room') {
        identify(ws, msg.token);
        const code = registry.createRoom(ws);
        ws.send(JSON.stringify({ type: 'room-created', code }));
        return;
      }

      if (msg.type === 'join-room') {
        identify(ws, msg.token);
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
        ws.send(paired('peer', result.room.host));
        result.room.host.send(paired('host', ws));
        return;
      }

      if (msg.type === 'find-match') {
        identify(ws, msg.token);
        const result = registry.findMatch(ws);
        if (result.waiting) {
          ws.send(JSON.stringify({ type: 'searching' }));
          return;
        }
        result.host.send(paired('host', result.peer));
        result.peer.send(paired('peer', result.host));
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

  await new Promise((resolve) => server.listen(port, resolve));
  return {
    server,
    wss,
    port: server.address().port,
    close: () => new Promise((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const relay = await createRelayServer();
  console.log(`Relay server listening on port ${relay.port}${process.env.GOOGLE_CLIENT_ID ? ' (Google sign-in on)' : ''}`);
}
