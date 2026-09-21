import React from 'react';
import { Pencil, X } from 'lucide-react';

// Shared card grid for both the standalone Library screen and PreconSelect's
// in-match deck picker — both offer the full pick/edit/remove set; a precon
// (deck.source === 'precon') never shows a remove control regardless, since
// it isn't stored in the removable deckLibrary.js store at all. `decks` is
// the normalized list from deckLibrary.js's buildDeckLibraryList().
export default function DeckLibraryGrid({ decks, onPick, onEdit, onRemove }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
      {decks.map((deck) => {
        const { Icon } = deck;
        return (
          <div
            key={deck.id}
            className="relative flex flex-col items-center gap-3 p-7 bg-white rounded-xl shadow hover:shadow-lg transition-shadow border-2"
            style={{ borderColor: deck.accentColor }}
          >
            {onEdit && (
              <button
                onClick={() => onEdit(deck)}
                className="absolute top-2 left-2 p-1.5 rounded-full bg-stone-100 hover:bg-stone-200 transition-colors"
                aria-label={`Edit ${deck.name}`}
                title="Edit deck"
              >
                <Pencil className="w-3.5 h-3.5 text-stone-600" />
              </button>
            )}
            {onRemove && deck.source === 'saved' && (
              <button
                onClick={() => onRemove(deck)}
                className="absolute top-2 right-2 p-1.5 rounded-full bg-stone-100 hover:bg-rose-100 transition-colors"
                aria-label={`Remove ${deck.name}`}
                title="Remove from Library"
              >
                <X className="w-3.5 h-3.5 text-stone-600" />
              </button>
            )}
            <button onClick={() => onPick(deck)} className="flex flex-col items-center gap-3">
              <span
                className="w-14 h-14 rounded-full flex items-center justify-center"
                style={{ backgroundColor: `${deck.accentColor}22` }}
              >
                <Icon className="w-7 h-7" style={{ color: deck.accentColor }} />
              </span>
              <span className="text-lg font-semibold text-stone-800">{deck.name}</span>
              <span className="text-xs text-stone-500">{deck.tagline}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
