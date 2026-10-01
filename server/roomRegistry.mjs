// Pure pairing logic for the relay server, kept free of any real `ws`
// dependency so it can be unit-tested against plain fake-socket stubs.
// The registry never reads or interprets game payloads — it only pairs
// two sockets under a room code and forwards 'relay' messages between
// them verbatim.

// Ambiguity-free alphabet (no 0/O/1/I) so a spoken/typed room code
// can't be misread.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

export function randomCode(existingCodes) {
  let code;
  do {
    code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
  } while (existingCodes.has(code));
  return code;
}

export class RoomRegistry {
  constructor() {
    this.rooms = new Map(); // code -> { host, peer }
    this.quickMatchQueue = []; // sockets waiting for an auto-matched opponent, FIFO
  }

  createRoom(hostSocket) {
    const code = randomCode(this.rooms);
    this.rooms.set(code, { host: hostSocket, peer: null });
    hostSocket.roomCode = code;
    hostSocket.role = 'host';
    return code;
  }

  joinRoom(code, peerSocket) {
    const room = this.rooms.get(code);
    if (!room) return { error: 'not-found' };
    if (room.peer) return { error: 'full' };
    room.peer = peerSocket;
    peerSocket.roomCode = code;
    peerSocket.role = 'peer';
    return { room };
  }

  // Pairs with whichever socket has been waiting longest, or queues this
  // one if nobody's waiting yet. The waiting socket becomes the room's host
  // (seat A) — same "whoever set the match up owns it" rule the host/join
  // flow already has, just decided by arrival order instead of a user's own
  // choice, since quick-match has no code for either side to deliberately
  // host or join.
  findMatch(socket) {
    if (this.quickMatchQueue.includes(socket)) return { waiting: true }; // already queued — ignore a repeat call
    const waiting = this.quickMatchQueue.shift();
    if (!waiting) {
      this.quickMatchQueue.push(socket);
      return { waiting: true };
    }
    const code = this.createRoom(waiting);
    this.joinRoom(code, socket);
    return { waiting: false, host: waiting, peer: socket };
  }

  // Removes a socket from the queue — used for both an explicit cancel and
  // a disconnect while still waiting (see disconnect() below).
  cancelFind(socket) {
    const idx = this.quickMatchQueue.indexOf(socket);
    if (idx !== -1) this.quickMatchQueue.splice(idx, 1);
  }

  relay(fromSocket, payload) {
    const room = this.rooms.get(fromSocket.roomCode);
    if (!room) return null;
    const other = fromSocket.role === 'host' ? room.peer : room.host;
    if (!other) return null;
    other.send(JSON.stringify({ type: 'relay', payload }));
    return other;
  }

  disconnect(socket) {
    this.cancelFind(socket);
    const room = this.rooms.get(socket.roomCode);
    if (!room) return null;
    const other = socket.role === 'host' ? room.peer : room.host;
    this.rooms.delete(socket.roomCode);
    if (other) other.send(JSON.stringify({ type: 'peer-disconnected' }));
    return other;
  }
}
