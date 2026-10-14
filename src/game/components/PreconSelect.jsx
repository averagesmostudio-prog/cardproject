import React, { useState } from 'react';
import { Layers } from 'lucide-react';
import { resolveDeckEntries, validateMainDeck } from '../engine/deck.js';
import { buildDeckLibraryList, removeDeck, toDeckSeed, duplicateDeck } from '../../lib/deckLibrary.js';
import { LINEN_BG, PAGE_BG } from '../../lib/deckBuilderStyle.js';
import DeckTiles from './DeckTiles.jsx';

const SEG = 'px-3 py-1 text-xs font-bold transition-colors';
const segActive = 'bg-[#393938] text-white';
const segIdle = 'bg-white/60 text-stone-800 hover:bg-white/90';

// The "Play a Game" landing screen: the same deck-selection screen as the
// Library (DeckTiles — precons + anything saved) except that picking a deck
// jumps straight to the coin flip, or edits a copy first (into DeckBuilder)
// without ever mutating a precon in place, plus a plain "Import / Build a
// Custom Deck" option below that routes into the existing DeckImport →
// DeckBuilder flow unchanged.
export default function PreconSelect({ pool, onStart, onCustom, onEdit, onBack, competitiveMode, onToggleCompetitiveMode, aiDifficulty, onChangeAiDifficulty }) {
  const [error, setError] = useState(null);
  const [, setVersion] = useState(0); // bumped to force the tiles to re-read the store after a remove/duplicate

  const handleRemove = (deck) => {
    if (deck.source !== 'saved') return;
    if (!window.confirm(`Remove "${deck.name}" from your Library?`)) return;
    removeDeck(deck.id);
    setVersion(v => v + 1);
  };

  const handleDuplicate = (deck) => {
    duplicateDeck(deck);
    setVersion(v => v + 1);
  };

  const handlePick = (deck) => {
    const { entries, effigyCounts, warnings } = resolveDeckEntries(pool, deck.raw);
    const mainErrors = validateMainDeck(entries);
    if (mainErrors.length > 0) {
      setError(
        `"${deck.name}" couldn't be built from the loaded card set` +
        (warnings.length > 0 ? `: ${warnings.join(' ')}` : '.')
      );
      return;
    }
    setError(null);
    onStart({ entries, effigyCounts });
  };

  const handleEdit = (deck) => onEdit(toDeckSeed(deck));

  return (
    <div className="min-h-dvh p-3 sm:p-4 short:p-2" style={{ background: PAGE_BG, fontFamily: 'Georgia, serif' }}>
      <div className="max-w-5xl mx-auto">
        <div className="mb-3">
          <button onClick={onBack} className="text-sm text-stone-300 hover:text-white">← Menu</button>
        </div>

        <div className="border-[6px] border-black rounded-md p-4 sm:p-5" style={{ background: LINEN_BG }}>
          <h1 className="text-xl font-bold text-stone-900">Play a Game</h1>
          <p className="text-stone-800 mt-1 mb-4 short:mb-2 text-sm">
            Pick a ready-to-play deck, or build your own. The AI opponent's own
            deck is chosen at random, scoped to the AI Difficulty below.
          </p>

          <div className="mb-4 flex flex-wrap items-start gap-x-8 gap-y-3">
            {/* Set before the match is built (GameApp.jsx > buildMatch), so it
                can't change mid-match. Casual leaves the Ethereal Conjuring
                reactive window (Match.jsx) open indefinitely; Competitive turns
                on its 20s-then-10s auto-decline timer. */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] text-stone-800 font-bold uppercase tracking-wide">Casual Mode/Competitive</span>
              <div className="inline-flex rounded-lg border-2 border-black overflow-hidden self-start">
                <button onClick={() => onToggleCompetitiveMode(false)} className={`${SEG} ${!competitiveMode ? segActive : segIdle}`}>
                  Casual
                </button>
                <button onClick={() => onToggleCompetitiveMode(true)} className={`${SEG} ${competitiveMode ? 'bg-amber-700 text-white' : segIdle}`}>
                  Competitive
                </button>
              </div>
            </div>

            {/* Which precons (precons.js > aiDifficulty) the AI opponent's own
                deck is drawn from (pickAiDeck, GameApp.jsx) — never affects
                which deck the human themself can pick below. Easy skips precons
                entirely for a plain random mono-color deck; Standard and Hard
                each draw only from the precons tagged that way. */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] text-stone-800 font-bold uppercase tracking-wide">AI Difficulty</span>
              <div className="inline-flex rounded-lg border-2 border-black overflow-hidden self-start">
                <button onClick={() => onChangeAiDifficulty('easy')} className={`${SEG} ${aiDifficulty === 'easy' ? 'bg-emerald-700 text-white' : segIdle}`}>
                  Easy
                </button>
                <button onClick={() => onChangeAiDifficulty('standard')} className={`${SEG} ${aiDifficulty === 'standard' ? segActive : segIdle}`}>
                  Standard
                </button>
                <button onClick={() => onChangeAiDifficulty('hard')} className={`${SEG} ${aiDifficulty === 'hard' ? 'bg-rose-700 text-white' : segIdle}`}>
                  Hard
                </button>
              </div>
            </div>
          </div>

          <DeckTiles
            decks={buildDeckLibraryList()}
            onPick={handlePick}
            onEdit={handleEdit}
            onDuplicate={handleDuplicate}
            onRemove={handleRemove}
            pickLabel="Play"
          />

          {error && (
            <p className="text-sm text-red-800 font-bold mt-4 max-w-lg">{error}</p>
          )}

          <button
            onClick={onCustom}
            className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 border-2 border-black bg-white/60 hover:bg-white/90 text-stone-900 rounded-lg text-sm font-bold transition-colors"
          >
            <Layers className="w-4 h-4" />
            Import / Build a Custom Deck
          </button>
        </div>
      </div>
    </div>
  );
}
