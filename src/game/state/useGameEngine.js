import { useEffect, useReducer } from 'react';
import { gameReducer } from '../engine/actions.js';
import { pickAiAction } from '../engine/ai.js';

// Wraps the pure gameReducer in React state and drives the AI player's
// turns automatically. `dispatch` is only meant to be called for the human
// player's own actions — the AI dispatches itself via the effect below.
export const useGameEngine = (initialState, aiPlayer = 'B') => {
  const [state, dispatch] = useReducer(gameReducer, initialState);

  useEffect(() => {
    if (state.phase === 'gameover') return;
    // A pending search effect (see actions.js > pendingChoice) can belong to
    // either player regardless of whose turn it is — e.g. the AI's Being
    // Departs while it's the human's turn. Let the AI resolve its own
    // choice immediately even outside its normal turn.
    const aiOwesChoice = state.pendingChoice?.playerId === aiPlayer;
    const isAiTurn = (state.phase === 'mulligan' && !state.players[aiPlayer].keptHand)
      || (state.phase === 'playing' && state.turnPlayer === aiPlayer);
    if (!aiOwesChoice && !isAiTurn) return;
    if (state.pendingChoice && !aiOwesChoice) return; // someone else's choice — wait

    const action = pickAiAction(state, aiPlayer);
    if (!action) return;
    // Small delay so the AI's moves are readable rather than instant.
    const timer = setTimeout(() => dispatch(action), 500);
    return () => clearTimeout(timer);
  }, [state, aiPlayer]);

  return [state, dispatch];
};
