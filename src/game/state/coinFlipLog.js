import { useCallback, useEffect, useRef, useState } from 'react';

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

// Watches the log for new coin-flip lines and queues them, one popup at a
// time. Returns [currentFlip | null, dismiss]. Same new-entries-since-last-
// render approach as useStagedBoard.js's log-driven hooks.
export const useCoinFlipQueue = (log) => {
  const seenRef = useRef(log.length);
  const seqRef = useRef(0);
  const [queue, setQueue] = useState([]);

  useEffect(() => {
    if (log.length < seenRef.current) {   // log was reset (rematch / new match)
      seenRef.current = log.length;
      return;
    }
    if (log.length === seenRef.current) return;
    const fresh = extractCoinFlips(log.slice(seenRef.current));
    seenRef.current = log.length;
    if (fresh.length > 0) {
      setQueue(q => [...q, ...fresh.map(f => ({ ...f, seq: ++seqRef.current }))]);
    }
  }, [log]);

  const dismiss = useCallback(() => setQueue(q => q.slice(1)), []);
  return [queue[0] || null, dismiss];
};
