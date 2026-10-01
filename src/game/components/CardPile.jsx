import React, { useState } from 'react';

// Purgatory's own "a card was milled or discarded" flourish
// (useStagedBoard.js > usePurgatoryArrivals, the `swirl` signal) — a
// black-hole-style vortex (reusing Board.jsx's shift-vortex-spin
// *technique*, recolored and with its motion inverted to read as "sucked
// in" rather than "arriving") over the whole pile. One shot, keyed on
// `seq`, same remount-to-replay trick every other staged effect uses.
function BlackHoleSwirl({ seq }) {
  if (!seq) return null;
  return (
    <div key={`swirl-${seq}`} className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none overflow-hidden rounded">
      <div className="w-full aspect-square rounded-full purgatory-swirl-spin" />
    </div>
  );
}

// Purgatory's own "a Being was sent here from the field" flourish
// (useStagedBoard.js > usePurgatoryArrivals, the `tombstone` signal) — a
// flat tombstone silhouette rising over the pile with a ground-mist glow
// underneath, distinct from the swirl above so a death reads differently
// from a mill/discard. Rendered above the swirl (z-30 vs. z-20) so both
// can coexist legibly if they ever land on the same render. One shot,
// keyed on `seq`.
function Tombstone({ seq }) {
  if (!seq) return null;
  return (
    <div key={`tombstone-${seq}`} className="absolute inset-0 z-30 flex items-end justify-center pointer-events-none overflow-hidden rounded">
      <div className="purgatory-tombstone-glow absolute inset-x-0 bottom-0 h-1/2 rounded-full" />
      <div className="purgatory-tombstone-rise" />
    </div>
  );
}

// A face-down stack visual for a Deck or Purgatory zone. Hovering always
// shows the card count; Purgatory additionally passes onClick to open its
// contents (Decks stay closed — their contents/order are hidden information).
export default function CardPile({ label, count, clickable, onClick, tone = 'stone', highlight = false, swirlSeq, tombstoneSeq }) {
  const [hover, setHover] = useState(false);
  const toneClasses = tone === 'purple'
    ? { back: 'bg-purple-950 border-purple-800', front: 'bg-purple-900 border-purple-700' }
    : tone === 'amber'
    ? { back: 'bg-amber-950 border-amber-800', front: 'bg-amber-900 border-amber-700' }
    : { back: 'bg-stone-900 border-stone-700', front: 'bg-stone-800 border-stone-600' };

  return (
    <div
      className="relative"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        onClick={clickable ? onClick : undefined}
        className={`relative w-20 h-28 ${clickable ? 'cursor-pointer' : ''}`}
      >
        {count > 0 && (
          <div className={`absolute inset-0 translate-x-1 translate-y-1 rounded border-2 ${toneClasses.back}`} />
        )}
        <div
          className={`relative w-full h-full rounded border-2 flex flex-col items-center justify-center gap-1 text-white transition
            ${toneClasses.front} ${clickable ? 'hover:brightness-125' : ''} ${highlight ? 'ring-2 ring-amber-400 animate-pulse' : ''}`}
        >
          <span className="text-xs uppercase tracking-wide opacity-80">{label}</span>
          <span className="text-2xl font-extrabold">{count}</span>
        </div>
        <BlackHoleSwirl seq={swirlSeq} />
        <Tombstone seq={tombstoneSeq} />
      </div>
      {hover && (
        <div className="absolute z-50 left-1/2 -translate-x-1/2 -top-8 bg-black/85 text-white text-xs px-2 py-1 rounded whitespace-nowrap pointer-events-none">
          {count} card{count === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}
