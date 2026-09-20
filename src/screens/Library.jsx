import React, { useEffect, useState } from 'react';
import { Plus, PenSquare } from 'lucide-react';
import { parseCSV, toGameCard } from '../lib/cardData.js';
import { getActiveCsvText } from '../lib/csvSource.js';
import { removeDeck, buildDeckLibraryList, toDeckSeed } from '../lib/deckLibrary.js';
import DeckBuilder from '../game/components/DeckBuilder.jsx';
import DeckLibraryGrid from '../game/components/DeckLibraryGrid.jsx';

// Reachable from Landing ("Library") and, standalone, manages saved decks:
// browse everything (precons + saved), start a fresh build, edit any deck
// (a precon edit always saves as new — see DeckBuilder), or remove a saved
// one. The card-art Generator lives one level down from here ("Design
// Cards") rather than being merged into deck management.
export default function Library({ onBack, onSelectGenerator }) {
  const [step, setStep] = useState('grid'); // 'grid' | 'edit'
  const [editSeed, setEditSeed] = useState(null); // null = fresh build
  const [pool, setPool] = useState([]);
  const [, setVersion] = useState(0); // bumped to force the grid to re-read the store

  useEffect(() => {
    getActiveCsvText().then(text => {
      if (text) setPool(parseCSV(text).map((row, idx) => toGameCard(row, idx)));
    }).catch(() => {});
  }, []);

  const openEdit = (deck) => { setEditSeed(toDeckSeed(deck)); setStep('edit'); };
  const openNew = () => { setEditSeed(null); setStep('edit'); };
  const closeEdit = () => { setStep('grid'); setVersion(v => v + 1); };

  const handleRemove = (deck) => {
    if (deck.source !== 'saved') return;
    removeDeck(deck.id);
    setVersion(v => v + 1);
  };

  if (step === 'edit') {
    return (
      <DeckBuilder
        pool={pool}
        seedDeck={editSeed}
        onBack={closeEdit}
        onSaveComplete={closeEdit}
      />
    );
  }

  // Recomputed fresh every render (including the ones triggered by
  // `version` below) so a save/edit/remove is reflected immediately.
  const decks = buildDeckLibraryList();

  return (
    <div className="min-h-screen bg-black p-8">
      <button
        onClick={onBack}
        className="fixed top-3 left-3 z-40 text-xs bg-white/90 border border-stone-300 rounded px-3 py-1.5 shadow hover:bg-white"
      >
        ← Menu
      </button>
      <div className="max-w-3xl mx-auto text-center pt-8">
        <h1 className="text-2xl font-bold text-white mb-2">Library</h1>
        <p className="text-stone-400 mb-6 text-sm">
          Preloaded decks plus anything you've saved. Click a deck to edit it,
          or start fresh.
        </p>

        <div className="mb-8 flex items-center justify-center gap-3">
          <button
            onClick={openNew}
            className="inline-flex items-center gap-2 px-4 py-2 bg-white text-stone-800 rounded-lg text-sm font-semibold shadow hover:shadow-md transition-shadow"
          >
            <Plus className="w-4 h-4" />
            New Deck
          </button>
          <button
            onClick={onSelectGenerator}
            className="inline-flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 text-stone-200 rounded-lg text-sm font-medium transition-colors"
          >
            <PenSquare className="w-4 h-4" />
            Design Cards
          </button>
        </div>

        <DeckLibraryGrid
          decks={decks}
          onPick={openEdit}
          onEdit={openEdit}
          onRemove={handleRemove}
        />
      </div>
    </div>
  );
}
