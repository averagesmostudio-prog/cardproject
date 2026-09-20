import { useEffect, useRef, useState } from 'react';

const DAMAGE_ANIMATION_MS = 700;

// Building a per-instanceId index lets us tell "this Being died" (its
// instanceId vanished from the whole board) apart from "this Being just
// moved to a different cell" (same instanceId, different cellId, same
// currentLifespan) — a naive per-cell diff would wrongly read a plain move
// as a death, since the being's old cell also goes empty. Scoped to real
// Beings (`type: 'being'`) only — Animated Armaments/armament-stacks are
// deliberately left unanimated for now, a smaller scope than the full
// generalized version this could grow into later.
const indexBeings = (board) => {
  const map = {};
  Object.entries(board || {}).forEach(([cellId, occupant]) => {
    if (occupant?.type === 'being') {
      map[occupant.card.instanceId] = { cellId, occupant, currentLifespan: occupant.currentLifespan };
    }
  });
  return map;
};

// Diffs two board snapshots to find Beings that took damage or died in
// place (same cell, lower/gone Lifespan) between them — the only two
// events worth pausing on. A plain move/reposition (same instanceId, new
// cell, same Lifespan) is deliberately NOT staged; it renders instantly,
// same as everything else always has.
const diffBoardDamage = (prevBoard, nextBoard) => {
  const prevIdx = indexBeings(prevBoard);
  const nextIdx = indexBeings(nextBoard);
  const staged = {};
  Object.entries(prevIdx).forEach(([instanceId, prevEntry]) => {
    const nextEntry = nextIdx[instanceId];
    if (!nextEntry) {
      staged[prevEntry.cellId] = { occupant: prevEntry.occupant, amount: prevEntry.currentLifespan, dying: true };
    } else if (nextEntry.cellId === prevEntry.cellId && nextEntry.currentLifespan < prevEntry.currentLifespan) {
      staged[prevEntry.cellId] = { occupant: prevEntry.occupant, amount: prevEntry.currentLifespan - nextEntry.currentLifespan, dying: false };
    }
  });
  return staged;
};

// Renders combat/effect damage with a brief pause instead of an instant cut:
// a Being that just took damage or died keeps showing its PRE-damage self
// (full Lifespan, still on the tile) for DAMAGE_ANIMATION_MS with a floating
// "-N" badge over it (Board.jsx), before flipping to the real post-dispatch
// board (lower Lifespan, or an empty tile). This is a pure rendering-layer
// effect — `board` itself (from useGameEngine) is never touched, so game
// logic/AI/legality always see the real, un-delayed state; only what
// Match.jsx hands to <Board> for painting is staged. Everything else —
// moves, new summons, UI-only re-renders — updates immediately, same as
// before this existed; only an actual Lifespan drop is ever staged.
export const useStagedBoard = (board) => {
  const [displayBoard, setDisplayBoard] = useState(board);
  const [flashes, setFlashes] = useState({});
  const prevBoardRef = useRef(board);
  const timerRef = useRef(null);

  useEffect(() => {
    const prevBoard = prevBoardRef.current;
    prevBoardRef.current = board;
    if (prevBoard === board) return undefined;

    // A new dispatch landed while a previous animation was still playing —
    // rather than stack timers/partial states, snap straight to "now" and
    // start the new animation fresh from there.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const staged = diffBoardDamage(prevBoard, board);
    const stagedCells = Object.keys(staged);
    if (stagedCells.length === 0) {
      setDisplayBoard(board);
      setFlashes({});
      return undefined;
    }

    setDisplayBoard(() => {
      const merged = { ...board };
      stagedCells.forEach(cellId => { merged[cellId] = staged[cellId].occupant; });
      return merged;
    });
    setFlashes(() => {
      const next = {};
      stagedCells.forEach(cellId => { next[cellId] = { amount: staged[cellId].amount, dying: staged[cellId].dying }; });
      return next;
    });

    timerRef.current = setTimeout(() => {
      setDisplayBoard(board);
      setFlashes({});
      timerRef.current = null;
    }, DAMAGE_ANIMATION_MS);
    return undefined;
  }, [board]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return { displayBoard, flashes };
};

// Same staged-pause treatment as useStagedBoard above, applied to a
// player's own Lifespan total (LifeBadge in Match.jsx) instead of a board
// tile — a direct hit (an attack that connects with no Being in the way, a
// "deal damage to a player" effect) drops a player's life immediately today
// with no visible impact, the same instant-cut problem combat/mass-damage
// had before useStagedBoard. `players` is the real `state.players` object.
export const useStagedLife = (players) => {
  const [displayLifespans, setDisplayLifespans] = useState({ A: players.A.lifespan, B: players.B.lifespan });
  const [lifeFlashes, setLifeFlashes] = useState({});
  const prevPlayersRef = useRef(players);
  const timerRef = useRef(null);

  useEffect(() => {
    const prevPlayers = prevPlayersRef.current;
    prevPlayersRef.current = players;
    if (prevPlayers === players) return undefined;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const staged = {};
    ['A', 'B'].forEach(id => {
      const before = prevPlayers[id].lifespan;
      const after = players[id].lifespan;
      if (after < before) staged[id] = before - after;
    });
    const stagedIds = Object.keys(staged);
    const settledLifespans = { A: players.A.lifespan, B: players.B.lifespan };
    if (stagedIds.length === 0) {
      setDisplayLifespans(settledLifespans);
      setLifeFlashes({});
      return undefined;
    }

    const heldBackLifespans = {
      A: staged.A != null ? prevPlayers.A.lifespan : players.A.lifespan,
      B: staged.B != null ? prevPlayers.B.lifespan : players.B.lifespan,
    };
    setDisplayLifespans(heldBackLifespans);
    setLifeFlashes(staged);

    timerRef.current = setTimeout(() => {
      setDisplayLifespans(settledLifespans);
      setLifeFlashes({});
      timerRef.current = null;
    }, DAMAGE_ANIMATION_MS);
    return undefined;
  }, [players]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return { displayLifespans, lifeFlashes };
};

const TURN_BANNER_MS = 1500;

// Match.jsx's "Your Turn"/"Opponent's Turn" banner — fires once per distinct
// `state.turnNumber` while `phase === 'playing'` (never during mulligan),
// including the very first turn once mulligan hands off into real play.
// Purely a transient rendering flag, same shape as useStagedBoard/
// useStagedLife above; the reducer's own turn/draw logic never sees this.
export const useTurnBanner = (state) => {
  const prevTurnRef = useRef(null);
  const [banner, setBanner] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (state.phase !== 'playing') {
      prevTurnRef.current = null;
      return undefined;
    }
    if (prevTurnRef.current === state.turnNumber) return undefined;
    prevTurnRef.current = state.turnNumber;

    if (timerRef.current) clearTimeout(timerRef.current);
    setBanner({ player: state.turnPlayer, seq: state.turnNumber });
    timerRef.current = setTimeout(() => {
      setBanner(null);
      timerRef.current = null;
    }, TURN_BANNER_MS);
    return undefined;
  }, [state.phase, state.turnNumber, state.turnPlayer]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return banner;
};

const DRAW_ANIMATION_MS = 450;

// Hand.jsx's draw-step pop-in — tracks instanceIds already seen (seeded
// from the hand as of first render, so the dealt opening hand never
// animates) and flags any newly-appeared ones for DRAW_ANIMATION_MS. A
// mulligan redraw counts as "new" too, but Hand.jsx isn't mounted during
// the mulligan screen, so that never actually fires — the first hand this
// ever sees is whatever settles after Keep.
export const useJustDrawn = (hand) => {
  const seenRef = useRef(new Set(hand.map(c => c.instanceId)));
  const [justDrawn, setJustDrawn] = useState(new Set());
  const timerRef = useRef(null);

  useEffect(() => {
    const newIds = hand.map(c => c.instanceId).filter(id => !seenRef.current.has(id));
    if (newIds.length === 0) return undefined;
    newIds.forEach(id => seenRef.current.add(id));

    if (timerRef.current) clearTimeout(timerRef.current);
    setJustDrawn(new Set(newIds));
    timerRef.current = setTimeout(() => {
      setJustDrawn(new Set());
      timerRef.current = null;
    }, DRAW_ANIMATION_MS);
    return undefined;
  }, [hand]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return justDrawn;
};
