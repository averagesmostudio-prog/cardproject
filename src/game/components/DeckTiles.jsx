import React from 'react';
import { Pencil, Copy, X } from 'lucide-react';

// The deck-selection tiles shared by the Library and Play a Game screens, in
// the Deck Builder's linen / black-border style. `decks` is the normalized
// list from deckLibrary.js's buildDeckLibraryList(). Clicking a tile calls
// onPick (open it, or play it); the corner buttons are each optional:
// onEdit (open the deck in the builder — saved decks only; a precon is
// duplicated first), onDuplicate (save a "(copy)"), and onRemove (saved decks
// only — a precon is never stored, so it never shows one).
export default function DeckTiles({ decks, onPick, onEdit, onDuplicate, onRemove, pickLabel = 'Open' }) {
  const corner = 'p-1 rounded-full border-2 border-black bg-white/70 hover:bg-white';
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
      {decks.map((deck) => {
        const { Icon } = deck;
        // A precon is never edited in place — duplicate it, then edit the copy.
        const canEdit = onEdit && deck.source === 'saved';
        return (
          <div
            key={deck.id}
            onClick={() => onPick(deck)}
            className="relative flex flex-col items-center gap-2 p-5 border-[3px] border-black rounded-lg bg-white/60 hover:bg-white/90 cursor-pointer transition-colors"
            title={`${pickLabel} ${deck.name}`}
          >
            {(canEdit || onDuplicate) && (
              <div className="absolute top-2 left-2 flex gap-1">
                {canEdit && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onEdit(deck); }}
                    className={corner}
                    aria-label={`Edit ${deck.name}`}
                    title="Edit deck"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
                {onDuplicate && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onDuplicate(deck); }}
                    className={corner}
                    aria-label={`Duplicate ${deck.name}`}
                    title="Duplicate deck"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
            {onRemove && deck.source === 'saved' && (
              <button
                onClick={(e) => { e.stopPropagation(); onRemove(deck); }}
                className={`absolute top-2 right-2 ${corner} hover:!bg-rose-200`}
                aria-label={`Remove ${deck.name}`}
                title="Remove from Library"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
            <span
              className="w-14 h-14 rounded-full border-2 border-black/60 flex items-center justify-center"
              style={{ background: `${deck.accentColor}55` }}
            >
              <Icon className="w-7 h-7" style={{ color: deck.accentColor }} />
            </span>
            <span className="text-lg font-bold text-stone-900 text-center">{deck.name}</span>
            <span className="text-xs text-stone-700 text-center">{deck.tagline}</span>
          </div>
        );
      })}
    </div>
  );
}
