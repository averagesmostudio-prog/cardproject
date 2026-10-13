import { useCallback, useState } from 'react';

// Card-driven coin flips are resolved inside the engine (actions.js rolls
// Math.random() and writes "<source> flips a coin: heads." to the action
// log) — so the log line is the only trace of one, and the popup is driven
// from it rather than from any engine state. The start-of-game flip logs
// "Coin flip: A goes first." instead, which deliberately doesn't match.
const COIN_FLIP_LOG_RE = /^(.*) flips a coin: (heads|tails)\.$/i;

export const extractCoinFlips = (entries) => entries.flatMap(entry => {
  const m = COIN_FLIP_LOG_RE.exec(entry?.message || '');
  return m ? [{ source: m[1], heads: m[2].toLowerCase() === 'heads' }] : [];
});

// The engine applies a flip's whole outcome in the same reducer step that
// flips the coin (damage, draws, Lifespan paid, any follow-up choice), so by
// the time React sees the new state the result is already on the board. To
// let the coin land first, what the SCREEN shows is held at the last state
// from before the flip until every queued toss has played out, then catches
// up to the true state in one step. The hold is pure data so it's directly
// unit-testable:
//   hold = { shown, prevLive, pending, seq }
//     shown    — the state the screen is allowed to render
//     prevLive — the previous live state (to see which log lines are new)
//     pending  — coin tosses still to play, oldest first ({source, heads, seq})
//     seq      — counter for unique popup keys
export const initialHold = (live) => ({ shown: live, prevLive: live, pending: [], seq: 0 });

// Folds a new live state in. No new flip and nothing already queued: the
// screen just follows. A new flip (or flips already queued): `shown` stays
// frozen while the toss(es) play.
export const advanceHold = (hold, live) => {
  if (live === hold.prevLive) return hold;
  if (live.log.length < hold.prevLive.log.length) return initialHold(live);   // log reset: a new match
  const fresh = extractCoinFlips(live.log.slice(hold.prevLive.log.length));
  const pending = [...hold.pending, ...fresh.map((f, i) => ({ ...f, seq: hold.seq + i + 1 }))];
  return {
    shown: pending.length === 0 ? live : hold.shown,
    prevLive: live,
    pending,
    seq: hold.seq + fresh.length,
  };
};

// Once every queued toss has played, the screen catches up to the live state.
export const releaseHold = (hold, live) => (
  hold.pending.length === 0 && hold.shown !== live ? { ...hold, shown: live } : hold
);

// The oldest toss is done — drop it.
export const resolveOldestFlip = (hold) => ({ ...hold, pending: hold.pending.slice(1) });

// Returns { state, flip, holding, resolveFlip }:
//   state       — what to render (held while a toss is playing)
//   flip        — the toss to show right now, or null
//   holding     — true from the moment a flip appears until the board catches up
//   resolveFlip — call when that toss's popup has finished
export const useCoinFlipHold = (live) => {
  const [hold, setHold] = useState(() => initialHold(live));

  // Derived during render (not in an effect): the very first render after a
  // flip must already show the held state — an effect would flash the result —
  // and the catch-up once the last toss is resolved should land immediately.
  const next = releaseHold(advanceHold(hold, live), live);
  if (next !== hold) setHold(next);

  const resolveFlip = useCallback(() => setHold(resolveOldestFlip), []);
  return {
    state: next.shown,
    flip: next.pending[0] || null,
    holding: next.pending.length > 0,
    resolveFlip,
  };
};
