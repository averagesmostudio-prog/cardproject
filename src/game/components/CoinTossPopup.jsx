import React, { useEffect, useState } from 'react';
import CoinToss from './CoinToss.jsx';

// Overlay shown for every in-game coin flip (a card's "Flip a coin, if heads
// ..., if tails ..." — Ambiguity, Illegible Grimoire, Witching Well). The
// engine has already resolved the flip by the time this shows (it only
// leaves a log line), so `flip.heads` is the true result; this just plays it
// out. Non-interactive (pointer-events-none) — it never blocks play — and
// removes itself via onDone a beat after the coin lands.
const HOLD_MS = 1100;
const FADE_MS = 260;

export default function CoinTossPopup({ flip, onDone }) {
  const [landed, setLanded] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!landed) return undefined;
    const hold = setTimeout(() => setLeaving(true), HOLD_MS);
    return () => clearTimeout(hold);
  }, [landed]);

  useEffect(() => {
    if (!leaving) return undefined;
    const fade = setTimeout(onDone, FADE_MS);
    return () => clearTimeout(fade);
  }, [leaving, onDone]);

  const result = flip.heads ? 'heads' : 'tails';
  return (
    <div className={`ct-popup ${leaving ? 'ct-leaving' : ''} fixed inset-0 z-[45] pointer-events-none flex items-center justify-center`}>
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative flex flex-col items-center -mt-6">
        <div className="text-xs uppercase tracking-[0.18em] text-amber-200/80" style={{ fontFamily: 'Cinzel, serif' }}>
          {flip.source} flips a coin
        </div>
        <CoinToss result={result} size={190} onLanded={() => setLanded(true)} />
        <div
          className={`-mt-8 h-8 text-2xl font-semibold tracking-wide ${landed ? 'text-amber-100' : 'text-stone-400'}`}
          style={{ fontFamily: 'Cinzel, serif' }}
        >
          {landed ? (flip.heads ? 'Heads' : 'Tails') : 'Flipping…'}
        </div>
      </div>
    </div>
  );
}
