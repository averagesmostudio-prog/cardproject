import { describe, it, expect } from 'vitest';
import { engineReducer } from './useGameEngine.js';
import { gameReducer } from '../engine/actions.js';

const baseState = (overrides = {}) => ({
  phase: 'playing', turnPlayer: 'A', turnNumber: 1, winner: null, board: {}, groundRelics: {}, altars: { A: [], B: [] }, log: [],
  players: {
    A: { id: 'A', lifespan: 50, mainDeck: [], hand: [], purgatory: [], effigyDeck: [], effigyPool: [], effigySpentThisTurn: [], keptHand: true },
    B: { id: 'B', lifespan: 50, mainDeck: [], hand: [], purgatory: [], effigyDeck: [], effigyPool: [], effigySpentThisTurn: [], keptHand: true },
  },
  ...overrides,
});

describe('engineReducer', () => {
  it('returns the given state verbatim for __ADOPT_REMOTE_STATE__, bypassing gameReducer', () => {
    const remoteState = baseState({ turnNumber: 7 });
    const result = engineReducer(baseState(), { type: '__ADOPT_REMOTE_STATE__', state: remoteState });
    expect(result).toBe(remoteState); // referential equality — never re-derived
  });

  it('still routes a normal action through gameReducer, matching calling it directly', () => {
    const current = baseState();
    const action = { type: 'SOME_UNKNOWN_ACTION' };
    expect(engineReducer(current, action)).toEqual(gameReducer(current, action));
  });
});
