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
  // Board.jsx's Engage-ability activation glow, colored by the activating
  // card's own Effigy type. Trickier than lastAttack/lastMartyr above: an
  // ACTIVATE_ENGAGE dispatch can resolve the ability right away (a response
  // to an already-open reactive window, or a fresh declaration the opponent
  // has no real reply to — actions.js's own auto-close loop resolves it
  // within that SAME dispatch), or defer it behind `state.pendingResolution`
  // for however many further dispatches it takes the window to close (a
  // real PASS_PRIORITY exchange). Worse, the auto-close case never exposes
  // the pendingResolution to React at all — it's created and cleared again
  // inside the one reducer call, so there's nothing to diff from the
  // outside. What's common to all three shapes is the log line
  // resolveOrLogEffect's own call site adds on a real resolution —
  // "<player> engages <card>'s ability." — never written for a merely
  // *declared* attempt ("<player> attempts to engage...") or a fizzled one
  // ("...fails to resolve..."). So: capture the activating cellId/card at
  // declare time (below), then watch the log for that exact card's own
  // "engages ... ability" line to appear — however many dispatches later
  // that turns out to be — and fire the glow then. Named by card, not just
  // "the most recent declare," since a reactive response can itself engage
  // a *different* card while ours is still pending.
  const engageGlowSeqRef = useRef(0);
  const [lastEngageGlow, setLastEngageGlow] = useState(null);
  const pendingEngageGlowRef = useRef(null);
  // Lets dispatchTracked read the CURRENT state without becoming a new
  // function identity every render (staying `[]`-deps stable) — Match.jsx
  // hands `dispatch` to a few effects keyed on it, including a competitive-
  // mode countdown timer that tears down and restarts its setTimeout on
  // every re-run; recreating dispatchTracked on every dispatch would reset
  // that timer's countdown on every unrelated action instead of just when
  // the window it's timing actually opens/closes. Updated in an effect
  // rather than inline during render (React refs shouldn't be written
  // mid-render) — this still lands well before the next user-triggered
  // dispatch, which is all this needs.
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; });
  const dispatchTracked = useCallback((action) => {
    if (action?.type === 'MOVE_OR_ATTACK' && action.isAttack) {
      attackSeqRef.current += 1;
      setLastAttack({ fromCellId: action.fromCellId, toCellId: action.toCellId, seq: attackSeqRef.current });
    }
    if (action?.type === 'ACTIVATE_MARTYR') {
      martyrSeqRef.current += 1;
      setLastMartyr({ cellId: action.cellId, seq: martyrSeqRef.current });
    }
    if (action?.type === 'ACTIVATE_ENGAGE') {
      const card = stateRef.current.board[action.cellId]?.card;
      if (card) {
        pendingEngageGlowRef.current = {
          cellId: action.cellId, cardName: card.name, effigyType: card.effigyType,
          // Only log lines from here on can possibly be THIS activation's
          // own resolution — without this floor, an already-consumed
          // "engages <name>'s ability" line from an earlier activation of
          // the same-named card earlier in the match would false-match.
          logFloor: stateRef.current.log.length,
        };
      }
    }
    dispatch(action);
  }, []);

  // Fires the candidate captured above once its own card's real resolution
  // line appears in the log — see the long comment above for why this has
  // to be log-text matching rather than a state diff. `engages <card>'s
  // ability.` only ever appears on an actual resolution (never the
  // declare-only `attempts to engage...` line); a fizzle
  // (`...fails to resolve...`) instead just drops the candidate, un-fired.
  useEffect(() => {
    const candidate = pendingEngageGlowRef.current;
    if (!candidate) return;
    const escapedName = candidate.cardName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const resolvedRe = new RegExp(`^\\S+ engages ${escapedName}'s ability\\.$`);
    const fizzledNeedle = `${candidate.cardName}'s Engage ability fails to resolve`;
    const newMessages = state.log.slice(candidate.logFloor).map(entry => entry.message);
    if (newMessages.some(m => resolvedRe.test(m))) {
      pendingEngageGlowRef.current = null;
      engageGlowSeqRef.current += 1;
      setLastEngageGlow({ cellId: candidate.cellId, effigyType: candidate.effigyType, seq: engageGlowSeqRef.current });
    } else if (newMessages.some(m => m.includes(fizzledNeedle))) {
      pendingEngageGlowRef.current = null;
    }
  }, [state.log]);

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

  return [state, dispatchTracked, lastAttack, lastMartyr, lastEngageGlow];
};
