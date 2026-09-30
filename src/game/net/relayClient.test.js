import { describe, it, expect, vi } from 'vitest';
import { createGameChannel } from './relayClient.js';

function fakeRelayClient() {
  const messageListeners = new Set();
  const closeListeners = new Set();
  return {
    sent: [],
    send(msg) { this.sent.push(msg); },
    onMessage(listener) { messageListeners.add(listener); return () => messageListeners.delete(listener); },
    onClose(listener) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
    emitMessage(msg) { for (const l of messageListeners) l(msg); },
    emitClose() { for (const l of closeListeners) l(); },
  };
}

describe('createGameChannel', () => {
  it('wraps sent payloads in a relay envelope', () => {
    const relay = fakeRelayClient();
    const channel = createGameChannel(relay);
    channel.send({ kind: 'state', foo: 1 });
    expect(relay.sent).toEqual([{ type: 'relay', payload: { kind: 'state', foo: 1 } }]);
  });

  it('unwraps relay envelopes and delivers the payload', () => {
    const relay = fakeRelayClient();
    const channel = createGameChannel(relay);
    const listener = vi.fn();
    channel.onMessage(listener);
    relay.emitMessage({ type: 'relay', payload: { kind: 'state', foo: 2 } });
    expect(listener).toHaveBeenCalledWith({ kind: 'state', foo: 2 });
  });

  it('ignores non-relay messages from the underlying client', () => {
    const relay = fakeRelayClient();
    const channel = createGameChannel(relay);
    const listener = vi.fn();
    channel.onMessage(listener);
    relay.emitMessage({ type: 'paired' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('forwards close events', () => {
    const relay = fakeRelayClient();
    const channel = createGameChannel(relay);
    const listener = vi.fn();
    channel.onClose(listener);
    relay.emitClose();
    expect(listener).toHaveBeenCalled();
  });

  it('surfaces peer-disconnected as its own event, not as an onMessage payload', () => {
    const relay = fakeRelayClient();
    const channel = createGameChannel(relay);
    const messageListener = vi.fn();
    const peerGoneListener = vi.fn();
    channel.onMessage(messageListener);
    channel.onPeerDisconnected(peerGoneListener);
    relay.emitMessage({ type: 'peer-disconnected' });
    expect(peerGoneListener).toHaveBeenCalled();
    expect(messageListener).not.toHaveBeenCalled();
  });
});
