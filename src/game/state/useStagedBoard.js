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

const SHIFT_VORTEX_MS = 900;

// Board.jsx's Shift vortex — Shift can be triggered by many different
// dispatched action types (ACTIVATE_SHIFT directly, or as a side effect of
// a forced-Shift Conjuring/Prophecy/reaction like Chains of the Unbound or
// Mouth of Madness), so there's no single action type to key off the way
// useGameEngine.js's lastAttack/lastMartyr do. Every real Shift funnels
// through performShift (actions.js) though, and always leaves the same
// unmistakable footprint: a brand-new Prophecy occupant carrying
// `shiftedFromCard` — so this diffs the board for a cell whose
// shiftedFromCard instanceId wasn't there on the immediately PREVIOUS
// board (prevBoardRef, same precedent as diffBoardDamage above), not an
// ever-growing "seen instanceId" set — a card's instanceId is stable
// across repeated Shifts of the same physical card (confirmed live: the
// same Being returning to the Mortal Realm and Shifting again reuses its
// original instanceId), so a permanent seenRef would only ever fire once
// per card's whole lifetime instead of once per Shift. Keyed by cellId ->
// an incrementing seq (not just a boolean), so Board.jsx's remount-to-
// replay trick still fires if the same Ethereal tile hosts two different
// Shifts back to back.
export const useShiftVortex = (board) => {
  const prevBoardRef = useRef(board);
  const [vortexCells, setVortexCells] = useState({});
  const timersRef = useRef({});

  useEffect(() => {
    const prevBoard = prevBoardRef.current;
    prevBoardRef.current = board;
    if (prevBoard === board) return undefined;

    const freshCellIds = [];
    Object.entries(board || {}).forEach(([cellId, occupant]) => {
      const instanceId = occupant?.type === 'prophecy' && occupant.shiftedFromCard?.instanceId;
      if (!instanceId) return;
      const prevOccupant = prevBoard?.[cellId];
      const prevInstanceId = prevOccupant?.type === 'prophecy' && prevOccupant.shiftedFromCard?.instanceId;
      if (prevInstanceId === instanceId) return;
      freshCellIds.push(cellId);
    });
    if (freshCellIds.length === 0) return undefined;

    setVortexCells(prev => {
      const next = { ...prev };
      freshCellIds.forEach(cellId => { next[cellId] = (next[cellId] || 0) + 1; });
      return next;
    });
    freshCellIds.forEach(cellId => {
      if (timersRef.current[cellId]) clearTimeout(timersRef.current[cellId]);
      timersRef.current[cellId] = setTimeout(() => {
        setVortexCells(prev => {
          const { [cellId]: _dropped, ...rest } = prev;
          return rest;
        });
        delete timersRef.current[cellId];
      }, SHIFT_VORTEX_MS);
    });
    return undefined;
  }, [board]);

  useEffect(() => () => { Object.values(timersRef.current).forEach(clearTimeout); }, []);

  return vortexCells;
};

const DEPART_BONES_MS = 1000;

// Board.jsx's Depart bones flash — like Shift above, there's no single
// dispatched action type to key off: a Depart-keyword Being can die to
// combat, Martyr, a damage effect, and dozens of other resolution paths,
// all of which funnel into logDepartIfPresent (actions.js). Unlike Shift
// though, that function's own footprint isn't visible on `board` at all —
// by the time it runs the dying Being is already gone (its own `cellId`
// param documents this), so a board diff alone can only say "a Being left
// this tile," not "...and it was a Depart." logDepartIfPresent always logs
// the literal line "<card>'s Depart triggers." right before actually
// resolving the effect (skipped, with a different log line, when a
// concurrent pendingChoice blocks it — see its own comment), so this
// combines both signals: diff the board for a cellId whose Being vanished
// since the last render (same "vacated" shape diffBoardDamage's death
// branch already detects), then cross-check the log for that exact
// vacated card's own "Depart triggers" line among the messages added since
// the last render, to confirm this specific vacancy really was a Depart
// and not just an ordinary death.
export const useDepartFlash = (board, log) => {
  const prevBoardRef = useRef(board);
  const prevLogLenRef = useRef(log.length);
  const [departCells, setDepartCells] = useState({});
  const timersRef = useRef({});

  useEffect(() => {
    const prevBoard = prevBoardRef.current;
    const prevLogLen = prevLogLenRef.current;
    prevBoardRef.current = board;
    prevLogLenRef.current = log.length;
    if (prevBoard === board && log.length === prevLogLen) return undefined;

    const newMessages = log.slice(prevLogLen).map(entry => entry.message);
    if (newMessages.length === 0) return undefined;

    const freshCellIds = [];
    Object.entries(prevBoard || {}).forEach(([cellId, occupant]) => {
      if (occupant?.type !== 'being') return;
      const current = board?.[cellId];
      const stillThere = current?.type === 'being' && current.card.instanceId === occupant.card.instanceId;
      if (stillThere) return;
      const escapedName = occupant.card.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const triggeredRe = new RegExp(`^${escapedName}'s Depart triggers\\.$`);
      if (newMessages.some(m => triggeredRe.test(m))) freshCellIds.push(cellId);
    });
    if (freshCellIds.length === 0) return undefined;

    setDepartCells(prev => {
      const next = { ...prev };
      freshCellIds.forEach(cellId => { next[cellId] = (next[cellId] || 0) + 1; });
      return next;
    });
    freshCellIds.forEach(cellId => {
      if (timersRef.current[cellId]) clearTimeout(timersRef.current[cellId]);
      timersRef.current[cellId] = setTimeout(() => {
        setDepartCells(prev => {
          const { [cellId]: _dropped, ...rest } = prev;
          return rest;
        });
        delete timersRef.current[cellId];
      }, DEPART_BONES_MS);
    });
    return undefined;
  }, [board, log]);

  useEffect(() => () => { Object.values(timersRef.current).forEach(clearTimeout); }, []);

  return departCells;
};

const OPEN_LANE_STRIKE_MS = 500;

// A regex, not a board diff: resolveAttackFrom's (actions.js) unblocked-
// lane branch — a real open lane, or a Relic/inert Armament that doesn't
// block either — never touches the DEFENDING side's `board` at all, so
// there's nothing there to diff. It always logs the literal line
// "<attacker> attacks into an open lane / past <X>, dealing <N> damage to
// <player>." right when it actually applies that damage — and only then:
// the same branch's Strike Down (`noDamage`) and Degrisch Vassal
// (damage-prevented-into-Effigy) variants log different text and never
// match this. Match.jsx's LifeBadge already gets a small damage-burst-pop
// (useStagedLife above) for ANY Lifespan drop, cost payments included, so
// that alone can't read as "you got hit" — this isolates the one case
// that actually is combat reaching a player's face undefended, for a
// bigger, more dramatic flourish reserved for just that.
const OPEN_LANE_HIT_RE = /attacks into (?:an open lane|past .+?), dealing \d+ damage to ([AB])\.$/;

// Planchette: "At the end of your turn lose Lifespan equal to the
// Lifespan of the Being on this tile." (applyEndOfTurnGroundRelicCoLocatedLifespanLoss,
// turn.js) — confirmed with the user: this should read as a real hit too,
// the same strike flourish as an undefended attack, not just the generic
// damage-burst-pop every Lifespan drop already gets. Matches that
// function's own exact log line: "<Relic> costs <player> <N> Lifespan
// (equal to <Being>'s Lifespan)." — narrow to this one shape rather than
// every Lifespan-cost message (an Effigy-pay cost, the flat end-of-turn
// -1, etc. should NOT get this).
const GROUND_RELIC_COST_HIT_RE = /^.+? costs ([AB]) \d+ Lifespan \(equal to .+?'s Lifespan\)\.$/;

export const useOpenLaneStrike = (log) => {
  const prevLogLenRef = useRef(log.length);
  const [strikes, setStrikes] = useState({});
  const timersRef = useRef({});

  useEffect(() => {
    const prevLogLen = prevLogLenRef.current;
    prevLogLenRef.current = log.length;
    if (log.length === prevLogLen) return undefined;

    const newMessages = log.slice(prevLogLen).map(entry => entry.message);
    const hitPlayers = [];
    newMessages.forEach(m => {
      const match = OPEN_LANE_HIT_RE.exec(m) || GROUND_RELIC_COST_HIT_RE.exec(m);
      if (match) hitPlayers.push(match[1]);
    });
    if (hitPlayers.length === 0) return undefined;

    setStrikes(prev => {
      const next = { ...prev };
      hitPlayers.forEach(id => { next[id] = (next[id] || 0) + 1; });
      return next;
    });
    hitPlayers.forEach(id => {
      if (timersRef.current[id]) clearTimeout(timersRef.current[id]);
      timersRef.current[id] = setTimeout(() => {
        setStrikes(prev => {
          const { [id]: _dropped, ...rest } = prev;
          return rest;
        });
        delete timersRef.current[id];
      }, OPEN_LANE_STRIKE_MS);
    });
    return undefined;
  }, [log]);

  useEffect(() => () => { Object.values(timersRef.current).forEach(clearTimeout); }, []);

  return strikes;
};

const DEITY_CINEMATIC_MS = 1200;

// Board.jsx's Deity-summon cinematic — a Deity is the one card type
// RULES.md itself singles out as "legendary/powerful" (it also skips the
// usual summoning-sickness engage, and is the only card type with its own
// legend rule), so this marks the moment with a grander drop-in-and-land
// animation than a plain Being's instant appearance, instead of a new
// staged-board placeholder (useStagedBoard above) or a seq-keyed decal
// alone. Every real placement path — hand-cast, reanimate, Invoke,
// Deja-Vu-style bounce-and-resummon, a sacrifice-cost resolution — funnels
// through the reducer's own placeBeingOnBoard, so diffing the board for a
// cellId whose occupant just became a fresh Deity instanceId (same
// prevBoard-vs-board shape useShiftVortex already uses, not a permanent
// "ever seen" set — a Deity can leave and return to the board more than
// once) catches all of them by construction, the same way Shift/Depart's
// own board diffs do. Carries the occupant's own `card` through (not just
// a boolean), since the overlay renders a real CardThumbnail of it.
export const useDeitySummonCinematic = (board) => {
  const prevBoardRef = useRef(board);
  const [deityCells, setDeityCells] = useState({});
  const timersRef = useRef({});

  useEffect(() => {
    const prevBoard = prevBoardRef.current;
    prevBoardRef.current = board;
    if (prevBoard === board) return undefined;

    const fresh = [];
    Object.entries(board || {}).forEach(([cellId, occupant]) => {
      if (occupant?.type !== 'being' || !occupant.card?.isDeity) return;
      const prevOccupant = prevBoard?.[cellId];
      const prevInstanceId = prevOccupant?.type === 'being' && prevOccupant.card?.instanceId;
      if (prevInstanceId === occupant.card.instanceId) return;
      fresh.push({ cellId, card: occupant.card });
    });
    if (fresh.length === 0) return undefined;

    setDeityCells(prev => {
      const next = { ...prev };
      fresh.forEach(({ cellId, card }) => { next[cellId] = { card, seq: (next[cellId]?.seq || 0) + 1 }; });
      return next;
    });
    fresh.forEach(({ cellId }) => {
      if (timersRef.current[cellId]) clearTimeout(timersRef.current[cellId]);
      timersRef.current[cellId] = setTimeout(() => {
        setDeityCells(prev => {
          const { [cellId]: _dropped, ...rest } = prev;
          return rest;
        });
        delete timersRef.current[cellId];
      }, DEITY_CINEMATIC_MS);
    });
    return undefined;
  }, [board]);

  useEffect(() => () => { Object.values(timersRef.current).forEach(clearTimeout); }, []);

  return deityCells;
};
