import React, { useState } from 'react';

// A face-down stack visual for a Deck or Purgatory zone. Hovering always
// shows the card count; Purgatory additionally passes onClick to open its
// contents (Decks stay closed — their contents/order are hidden information).
export default function CardPile({ label, count, clickable, onClick, tone = 'stone', highlight = false }) {
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
      </div>
      {hover && (
        <div className="absolute z-50 left-1/2 -translate-x-1/2 -top-8 bg-black/85 text-white text-xs px-2 py-1 rounded whitespace-nowrap pointer-events-none">
          {count} card{count === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}
