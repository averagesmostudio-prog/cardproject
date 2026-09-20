import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { gameReducer } from '../engine/actions.js';
import { pickAiAction, pickAiReaction } from '../engine/ai.js';

// Wraps the pure gameReducer in React state and drives the AI player's
// turns automatically. `dispatch` is only meant to be called for the human
// player's own actions — the AI dispatches itself via the effect below.
export const useGameEngine = (initialState, aiPlayer = 'B') => {
  const [state, dispatch] = useReducer(gameReducer, initialState);

  // Purely a rendering hint for Board.jsx's attack-lunge animation — the
  // reducer itself never sees or produces this; it's just "the most recent
  // dispatch (human or AI, tracked here since the AI dispatches internally
  // below) happened to be an attack, from/to these cells." `seq` guarantees
  // a fresh value even for two attacks from the same cell back to back, so
  // Board.jsx's remount-to-replay trick (keying on it) always fires.
  const attackSeqRef = useRef(0);
  const [lastAttack, setLastAttack] = useState(null);
  // Same shape/precedent as lastAttack above, for Board.jsx's Martyr glow —
  // keyed off the dispatched ACTIVATE_MARTYR action's own cellId rather
  // than diffed from the resulting state, since the sacrificed Being is
  // already gone from `board` by the time the reducer returns (nothing left
  // there to diff against).
  const martyrSeqRef = useRef(0);
  const [lastMartyr, setLastMartyr] = useState(null);
  const dispatchTracked = useCallback((action) => {
    if (action?.type === 'MOVE_OR_ATTACK' && action.isAttack) {
      attackSeqRef.current += 1;
      setLastAttack({ fromCellId: action.fromCellId, toCellId: action.toCellId, seq: attackSeqRef.current });
    }
    if (action?.type === 'ACTIVATE_MARTYR') {
      martyrSeqRef.current += 1;
      setLastMartyr({ cellId: action.cellId, seq: martyrSeqRef.current });
    }
    dispatch(action);
  }, []);

  useEffect(() => {
    if (state.phase === 'gameover') return;
    // A pending search effect (see actions.js > pendingChoice) can belong to
    // either player regardless of whose turn it is — e.g. the AI's Being
    // Departs while it's the human's turn. Let the AI resolve its own
    // choice immediately even outside its normal turn.
    const aiOwesChoice = state.pendingChoice?.playerId === aiPlayer;
    // Ethereal Conjuring reactive timing (actions.js > manageReactiveWindow)
    // — same "can happen outside the AI's own turn" shape as aiOwesChoice
    // above, just for a reactive window instead of a forced choice.
    const aiOwesReaction = state.reactiveWindow?.openFor === aiPlayer;
    const isAiTurn = (state.phase === 'mulligan' && !state.players[aiPlayer].keptHand)
      || (state.phase === 'playing' && state.turnPlayer === aiPlayer);
    if (!aiOwesChoice && !isAiTurn && !aiOwesReaction) return;
    if (state.pendingChoice && !aiOwesChoice) return; // someone else's choice — wait

    const action = aiOwesReaction ? pickAiReaction(state, aiPlayer) : pickAiAction(state, aiPlayer);
    if (!action) return;
    // Small delay so the AI's moves are readable rather than instant.
    const timer = setTimeout(() => dispatchTracked(action), 500);
    return () => clearTimeout(timer);
  }, [state, aiPlayer, dispatchTracked]);

  return [state, dispatchTracked, lastAttack, lastMartyr];
};
