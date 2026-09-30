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

  relay(fromSocket, payload) {
    const room = this.rooms.get(fromSocket.roomCode);
    if (!room) return null;
    const other = fromSocket.role === 'host' ? room.peer : room.host;
    if (!other) return null;
    other.send(JSON.stringify({ type: 'relay', payload }));
    return other;
  }

  disconnect(socket) {
    const room = this.rooms.get(socket.roomCode);
    if (!room) return null;
    const other = socket.role === 'host' ? room.peer : room.host;
    this.rooms.delete(socket.roomCode);
    if (other) other.send(JSON.stringify({ type: 'peer-disconnected' }));
    return other;
  }
}
