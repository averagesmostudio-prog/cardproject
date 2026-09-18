import React, { useState } from 'react';
import { Layers } from 'lucide-react';
import { EFFIGY_TYPE_COLORS } from '../../lib/cardData.js';
import { PRECON_DECKS } from '../decks/precons.js';
import { resolvePreconEntries, validateMainDeck } from '../engine/deck.js';

// The "Play a Game" landing screen: three ready-to-play precons (unique
// icon + color per deck, from precons.js) that jump straight to the coin
// flip, plus a plain "Import / Build a Custom Deck" option below that
// routes into the existing DeckImport → DeckBuilder flow unchanged.
export default function PreconSelect({ pool, onStart, onCustom, onBack }) {
  const [error, setError] = useState(null);

  const handlePick = (precon) => {
    const { entries, effigyCounts, warnings } = resolvePreconEntries(pool, precon);
    const mainErrors = validateMainDeck(entries);
    if (mainErrors.length > 0) {
      setError(
        `"${precon.name}" couldn't be built from the loaded card set` +
        (warnings.length > 0 ? `: ${warnings.join(' ')}` : '.')
      );
      return;
    }
    setError(null);
    onStart({ entries, effigyCounts });
  };

  return (
    <div className="min-h-screen bg-black p-8">
      <button
        onClick={onBack}
        className="fixed top-3 left-3 z-40 text-xs bg-white/90 border border-stone-300 rounded px-3 py-1.5 shadow hover:bg-white"
      >
        ← Menu
      </button>
      <div className="max-w-3xl mx-auto text-center pt-8">
        <h1 className="text-2xl font-bold text-white mb-2">Play a Game</h1>
        <p className="text-stone-400 mb-10 text-sm">
          Pick a ready-to-play deck, or build your own. The AI opponent plays a
          random one of these three same decks.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 mb-6">
          {PRECON_DECKS.map((precon) => {
            const accent = EFFIGY_TYPE_COLORS[precon.color] || '#9c6b1f';
            const Icon = precon.icon;
            return (
              <button
                key={precon.id}
                onClick={() => handlePick(precon)}
                className="flex flex-col items-center gap-3 p-7 bg-white rounded-xl shadow hover:shadow-lg transition-shadow border-2"
                style={{ borderColor: accent }}
              >
                <span
                  className="w-14 h-14 rounded-full flex items-center justify-center"
                  style={{ backgroundColor: `${accent}22` }}
                >
                  <Icon className="w-7 h-7" style={{ color: accent }} />
                </span>
                <span className="text-lg font-semibold text-stone-800">{precon.name}</span>
                <span className="text-xs text-stone-500">{precon.tagline}</span>
              </button>
            );
          })}
        </div>

        {error && (
          <p className="text-sm text-red-400 mb-6 max-w-lg mx-auto">{error}</p>
        )}

        <button
          onClick={onCustom}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-white/10 hover:bg-white/20 text-stone-200 rounded-lg text-sm font-medium transition-colors"
        >
          <Layers className="w-4 h-4" />
          Import / Build a Custom Deck
        </button>
      </div>
    </div>
  );
}
