import { describe, it, expect } from 'vitest';
import { RoomRegistry, randomCode } from './roomRegistry.mjs';

function fakeSocket() {
  return { sent: [], roomCode: null, role: null, send(raw) { this.sent.push(JSON.parse(raw)); } };
}

describe('randomCode', () => {
  it('avoids codes already in use', () => {
    const existing = new Set(['AAAA']);
    for (let i = 0; i < 50; i++) {
      expect(randomCode(existing)).not.toBe('AAAA');
    }
  });
});

describe('RoomRegistry', () => {
  it('creates a room and assigns the host role', () => {
    const registry = new RoomRegistry();
    const host = fakeSocket();
    const code = registry.createRoom(host);
    expect(code).toHaveLength(4);
    expect(host.roomCode).toBe(code);
    expect(host.role).toBe('host');
  });

  it('pairs a peer into an existing room', () => {
    const registry = new RoomRegistry();
    const host = fakeSocket();
    const code = registry.createRoom(host);
    const peer = fakeSocket();
    const result = registry.joinRoom(code, peer);
    expect(result.error).toBeUndefined();
    expect(peer.roomCode).toBe(code);
    expect(peer.role).toBe('peer');
  });

  it('rejects joining a nonexistent room', () => {
    const registry = new RoomRegistry();
    const result = registry.joinRoom('ZZZZ', fakeSocket());
    expect(result.error).toBe('not-found');
  });

  it('rejects joining a full room', () => {
    const registry = new RoomRegistry();
    const host = fakeSocket();
    const code = registry.createRoom(host);
    registry.joinRoom(code, fakeSocket());
    const result = registry.joinRoom(code, fakeSocket());
    expect(result.error).toBe('full');
  });

  it('relays a message only to the other party in the room', () => {
    const registry = new RoomRegistry();
    const host = fakeSocket();
    const code = registry.createRoom(host);
    const peer = fakeSocket();
    registry.joinRoom(code, peer);

    registry.relay(host, { kind: 'state', foo: 1 });
    expect(peer.sent).toEqual([{ type: 'relay', payload: { kind: 'state', foo: 1 } }]);
    expect(host.sent).toEqual([]);

    registry.relay(peer, { kind: 'ping' });
    expect(host.sent).toEqual([{ type: 'relay', payload: { kind: 'ping' } }]);
  });

  it('does nothing when relaying with no paired peer yet', () => {
    const registry = new RoomRegistry();
    const host = fakeSocket();
    registry.createRoom(host);
    expect(() => registry.relay(host, { kind: 'state' })).not.toThrow();
    expect(host.sent).toEqual([]);
  });

  it('notifies the survivor on disconnect and removes the room', () => {
    const registry = new RoomRegistry();
    const host = fakeSocket();
    const code = registry.createRoom(host);
    const peer = fakeSocket();
    registry.joinRoom(code, peer);

    registry.disconnect(host);
    expect(peer.sent).toEqual([{ type: 'peer-disconnected' }]);
    expect(registry.rooms.has(code)).toBe(false);
  });

  it('is a no-op disconnecting a socket with no room', () => {
    const registry = new RoomRegistry();
    expect(() => registry.disconnect(fakeSocket())).not.toThrow();
  });
});
