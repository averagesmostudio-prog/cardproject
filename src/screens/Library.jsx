import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { parseCSV, toGameCard, EFFIGY_COLORS } from '../lib/cardData.js';
import { getActiveCsvText } from '../lib/csvSource.js';
import { removeDeck, buildDeckLibraryList, toDeckSeed, duplicateDeck } from '../lib/deckLibrary.js';
import { LINEN_BG, PAGE_BG } from '../lib/deckBuilderStyle.js';
import { useLibrarySyncRefresh } from '../lib/useAccount.js';
import DeckBuilder from '../game/components/DeckBuilder.jsx';
import DeckTiles from '../game/components/DeckTiles.jsx';

// A fresh, empty build. A new object every call so DeckBuilder (which re-seeds
// whenever seedDeck's identity changes) clears itself back to empty each time.
const newDeckSeed = () => ({
  entries: [],
  effigyCounts: Object.fromEntries(EFFIGY_COLORS.map(c => [c, 0])),
  color: null,
  source: 'new',
  sourceId: null,
  sourceName: '',
});

// Reachable from Landing ("Library"). Opens on the decks themselves
// (preloaded + saved); picking one opens it in the deck builder, where the
// card library fills the center and a deck switcher sits in the right-hand
// panel. The card-art Generator is one click away ("Design Cards").
export default function Library({ onBack, onSelectGenerator }) {
  const [step, setStep] = useState('grid'); // 'grid' | 'edit'
  const [seed, setSeed] = useState(null);
  const [pool, setPool] = useState([]);
  const [, setVersion] = useState(0); // bumped to force the deck list to re-read the store
  useLibrarySyncRefresh();

  useEffect(() => {
    getActiveCsvText().then(text => {
      if (text) setPool(parseCSV(text).map((row, idx) => toGameCard(row, idx)));
    }).catch(() => {});
  }, []);

  const openDeck = (deck) => { setSeed(toDeckSeed(deck)); setStep('edit'); };
  const openNew = () => { setSeed(newDeckSeed()); setStep('edit'); };
  const closeEdit = () => { setStep('grid'); setVersion(v => v + 1); };

  // After a save the deck exists in the store: keep it open, now as that saved
  // deck, so the next save updates it instead of creating a duplicate.
  const handleSaved = (record) => {
    setSeed(toDeckSeed({ raw: record, source: 'saved' }));
    setVersion(v => v + 1);
  };

  // Saves an independent copy ("Name (copy)") and leaves you on the deck list,
  // where the new deck appears next to the original.
  const handleDuplicate = (deck) => {
    duplicateDeck(deck);
    setVersion(v => v + 1);
  };

  const handleRemove = (deck) => {
    if (deck.source !== 'saved') return;
    if (!window.confirm(`Remove "${deck.name}" from your Library?`)) return;
    removeDeck(deck.id);
    if (seed?.sourceId === deck.id) setSeed(newDeckSeed());
    setVersion(v => v + 1);
  };

  // Recomputed fresh every render (including the ones triggered by `version`)
  // so a save/edit/remove is reflected immediately.
  const decks = buildDeckLibraryList();

  if (step === 'edit') {
    if (pool.length === 0) {
      return (
        <div className="min-h-dvh bg-black p-6 short:p-2">
          <button onClick={closeEdit} className="text-sm text-stone-300 hover:text-white">← Decks</button>
          <p className="text-stone-400 text-sm text-center mt-24">Loading your cards…</p>
        </div>
      );
    }
    return (
      <DeckBuilder
        pool={pool}
        seedDeck={seed}
        onBack={closeEdit}
        onSaveComplete={handleSaved}
        libraryDecks={decks}
        onSelectDeck={openDeck}
        onNewDeck={openNew}
        onRemoveDeck={handleRemove}
      />
    );
  }

  return (
    <div className="min-h-dvh p-3 sm:p-4 short:p-2" style={{ background: PAGE_BG, fontFamily: 'Georgia, serif' }}>
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-4 mb-3">
          <button onClick={onBack} className="text-sm text-stone-300 hover:text-white">← Menu</button>
          <button onClick={onSelectGenerator} className="text-sm text-stone-300 hover:text-white">Design Cards</button>
        </div>

        <div className="border-[6px] border-black rounded-md p-4 sm:p-5" style={{ background: LINEN_BG }}>
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-xl font-bold text-stone-900">Library</h1>
            <button
              onClick={openNew}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-[#393938] text-white rounded-lg text-sm font-bold"
            >
              <Plus className="w-4 h-4" />
              New Deck
            </button>
          </div>

          <DeckTiles decks={decks} onPick={openDeck} onDuplicate={handleDuplicate} onRemove={handleRemove} />
        </div>
      </div>
    </div>
  );
}
