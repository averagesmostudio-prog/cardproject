import { describe, it, expect } from 'vitest';
import { rematchPhase, rematchStartingPlayer } from './rematch.js';

describe('online rematch handshake', () => {
  it('walks idle -> waiting / incoming -> start, only starting when BOTH sides asked', () => {
    expect(rematchPhase({ myRequested: false, peerRequested: false })).toBe('idle');
    expect(rematchPhase({ myRequested: true, peerRequested: false })).toBe('waiting');
    expect(rematchPhase({ myRequested: false, peerRequested: true })).toBe('incoming');
    expect(rematchPhase({ myRequested: true, peerRequested: true })).toBe('start');
  });

  it('the other seat goes first in the rematch', () => {
    expect(rematchStartingPlayer('A')).toBe('B');
    expect(rematchStartingPlayer('B')).toBe('A');
  });
});
