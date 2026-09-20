import React, { useState } from 'react';
import { Layers } from 'lucide-react';
import { EFFIGY_TYPE_COLORS } from '../../lib/cardData.js';
import { PRECON_DECKS } from '../decks/precons.js';
import { resolvePreconEntries, validateMainDeck } from '../engine/deck.js';

// The "Play a Game" landing screen: ready-to-play precons (unique icon +
// color per deck, from precons.js) that jump straight to the coin flip,
// plus a plain "Import / Build a Custom Deck" option below that routes
// into the existing DeckImport → DeckBuilder flow unchanged.
export default function PreconSelect({ pool, onStart, onCustom, onBack, competitiveMode, onToggleCompetitiveMode, aiDifficulty, onChangeAiDifficulty }) {
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
        <p className="text-stone-400 mb-6 text-sm">
          Pick a ready-to-play deck, or build your own. The AI opponent's own
          deck is chosen at random, scoped to the AI Difficulty below.
        </p>

        {/* Set before the match is built (GameApp.jsx > buildMatch), so it
            can't change mid-match. Casual leaves the Ethereal Conjuring
            reactive window (Match.jsx) open indefinitely; Competitive turns
            on its 20s-then-10s auto-decline timer. */}
        <div className="mb-10 flex flex-col items-center gap-1.5">
          <span className="text-[11px] text-stone-500 uppercase tracking-wide">Casual Mode/Competitive</span>
          <div className="inline-flex rounded-lg border border-stone-600 overflow-hidden">
            <button
              onClick={() => onToggleCompetitiveMode(false)}
              className={`px-3 py-1 text-xs font-semibold transition ${!competitiveMode ? 'bg-white text-stone-800' : 'bg-transparent text-stone-400 hover:bg-white/10'}`}
            >
              Casual
            </button>
            <button
              onClick={() => onToggleCompetitiveMode(true)}
              className={`px-3 py-1 text-xs font-semibold transition ${competitiveMode ? 'bg-amber-600 text-white' : 'bg-transparent text-stone-400 hover:bg-white/10'}`}
            >
              Competitive
            </button>
          </div>
        </div>

        {/* Which precons (precons.js > aiDifficulty) the AI opponent's own
            deck is drawn from (pickAiDeck, GameApp.jsx) — never affects
            which deck the human themself can pick above. Easy skips precons
            entirely for a plain random mono-color deck; Standard and Hard
            each draw only from the precons tagged that way. */}
        <div className="mb-10 flex flex-col items-center gap-1.5">
          <span className="text-[11px] text-stone-500 uppercase tracking-wide">AI Difficulty</span>
          <div className="inline-flex rounded-lg border border-stone-600 overflow-hidden">
            <button
              onClick={() => onChangeAiDifficulty('easy')}
              className={`px-3 py-1 text-xs font-semibold transition ${aiDifficulty === 'easy' ? 'bg-emerald-600 text-white' : 'bg-transparent text-stone-400 hover:bg-white/10'}`}
            >
              Easy
            </button>
            <button
              onClick={() => onChangeAiDifficulty('standard')}
              className={`px-3 py-1 text-xs font-semibold transition ${aiDifficulty === 'standard' ? 'bg-white text-stone-800' : 'bg-transparent text-stone-400 hover:bg-white/10'}`}
            >
              Standard
            </button>
            <button
              onClick={() => onChangeAiDifficulty('hard')}
              className={`px-3 py-1 text-xs font-semibold transition ${aiDifficulty === 'hard' ? 'bg-rose-600 text-white' : 'bg-transparent text-stone-400 hover:bg-white/10'}`}
            >
              Hard
            </button>
          </div>
        </div>

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
