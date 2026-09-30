// Thin WebSocket wrapper for talking to the relay server (server/relay.mjs).
// Plain browser WebSocket — Electron's renderer needs no IPC/preload for
// this, same as the existing direct fetch() in src/lib/csvSource.js.

export function createRelayClient(address) {
  const socket = new WebSocket(address);
  const listeners = new Set();
  const closeListeners = new Set();

  socket.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    for (const listener of listeners) listener(msg);
  });

  socket.addEventListener('close', () => {
    for (const listener of closeListeners) listener();
  });

  return {
    send(msg) {
      socket.send(JSON.stringify(msg));
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    onOpen(listener) {
      socket.addEventListener('open', listener, { once: true });
    },
    close() {
      socket.close();
    },
  };
}

// Wraps/unwraps the relay server's {type:'relay', payload} envelope so
// game-layer code just sends/receives plain messages ({kind: 'state', ...}
// etc.) without knowing the relay protocol exists.
export function createGameChannel(relayClient) {
  const listeners = new Set();
  const peerGoneListeners = new Set();

  const unsubscribe = relayClient.onMessage((msg) => {
    if (msg.type === 'relay') {
      for (const listener of listeners) listener(msg.payload);
      return;
    }
    // The relay server's own 'peer-disconnected' notice (sent when the
    // OTHER party's socket closes) — a top-level relay-protocol message,
    // not something forwarded through the 'relay' envelope above, so it
    // needs its own subscription surface rather than falling out of
    // onMessage.
    if (msg.type === 'peer-disconnected') {
      for (const listener of peerGoneListeners) listener();
    }
  });

  return {
    send(payload) {
      relayClient.send({ type: 'relay', payload });
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onPeerDisconnected(listener) {
      peerGoneListeners.add(listener);
      return () => peerGoneListeners.delete(listener);
    },
    onClose(listener) {
      return relayClient.onClose(listener);
    },
    close() {
      unsubscribe();
      relayClient.close();
    },
  };
}
