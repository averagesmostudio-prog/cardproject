import React, { useState } from 'react';
import DeckImport from './DeckImport.jsx';
import PreconSelect from './PreconSelect.jsx';
import DeckBuilder from './DeckBuilder.jsx';
import CoinFlip from './CoinFlip.jsx';
import Match from './Match.jsx';
import { createInitialState } from '../engine/actions.js';
import {
  buildMainDeckList, buildEffigyDeckList,
  autoBuildMainDeckEntries, autoBuildEffigyCounts, randomEffigyColor,
  resolveDeckEntries, validateMainDeck,
} from '../engine/deck.js';
import { PRECON_DECKS } from '../decks/precons.js';

// The AI opponent's own deck, scoped by the human's chosen AI Difficulty
// (PreconSelect.jsx's toggle, precons.js's own `aiDifficulty` tag on each
// precon) — never the same thing as which precon the human picked for
// themself. Easy skips precons entirely, same plain random mono-color deck
// as the old (pre-difficulty) default. Standard/Hard pick at random among
// only the precons tagged that way, falling back to the plain random build
// only if the loaded card set doesn't actually contain any of that tier's
// precons' cards (a heavily customized CSV missing their names), so the AI
// always ends up with a real, legal 40-card deck either way.
const pickAiDeck = (pool, aiDifficulty) => {
  if (aiDifficulty !== 'easy') {
    const tierDecks = PRECON_DECKS.filter((p) => p.aiDifficulty === aiDifficulty);
    const shuffled = [...tierDecks].sort(() => Math.random() - 0.5);
    for (const precon of shuffled) {
      const { entries, effigyCounts } = resolveDeckEntries(pool, precon);
      if (validateMainDeck(entries).length === 0) return { entries, effigyCounts };
    }
  }
  const color = randomEffigyColor();
  return { entries: autoBuildMainDeckEntries(pool, color), effigyCounts: autoBuildEffigyCounts(color) };
};

export default function GameApp({ onExitToMenu }) {
  const [screen, setScreen] = useState('import'); // 'import' | 'select' | 'build' | 'coinflip' | 'match'
  const [pool, setPool] = useState([]);
  const [matchState, setMatchState] = useState(null);
  const [matchKey, setMatchKey] = useState(0);
  const [lastConfig, setLastConfig] = useState(null);
  // Set when DeckBuilder should open pre-populated from a Library pick
  // (precon or saved deck) instead of empty — see PreconSelect's onEdit.
  const [seedDeck, setSeedDeck] = useState(null);
  // Casual (default) leaves the Ethereal Conjuring reactive window
  // (Match.jsx) open indefinitely, same as before this toggle existed.
  // Competitive turns on its 20s-then-10s auto-decline timer.
  const [competitiveMode, setCompetitiveMode] = useState(false);
  // Which precons (precons.js > aiDifficulty) pickAiDeck draws the AI
  // opponent's own deck from — 'standard' as the default middle ground.
  const [aiDifficulty, setAiDifficulty] = useState('standard');

  const handleImported = (cards) => {
    setPool(cards);
    setScreen('select');
  };

  // Hands aren't dealt until the coin flip is resolved (RULES.md > Turn
  // structure) — createInitialState (and the deal it does internally) only
  // runs once the flip's winner has chosen who goes first.
  const buildMatch = ({ entries, effigyCounts, aiEntries, aiEffigyCounts }, startingPlayer) => {
    const mainDeckA = buildMainDeckList(entries);
    const effigyDeckA = buildEffigyDeckList(effigyCounts);
    const mainDeckB = buildMainDeckList(aiEntries);
    const effigyDeckB = buildEffigyDeckList(aiEffigyCounts);

    setMatchState(createInitialState({ mainDeckA, effigyDeckA, mainDeckB, effigyDeckB, startingPlayer }));
    setMatchKey(k => k + 1);
    setScreen('match');
  };

  const handleStart = ({ entries, effigyCounts }) => {
    // The AI opponent plays a precon scoped to the chosen AI Difficulty
    // (pickAiDeck, above) — same mono-color-deck guarantee the old random
    // auto-build had (every colored card it draws is actually payable from
    // its own mono-color Effigy Deck) whenever a precon is used, just a
    // real curated list instead of a random legal pile.
    const { entries: aiEntries, effigyCounts: aiEffigyCounts } = pickAiDeck(pool, aiDifficulty);
    const config = { entries, effigyCounts, aiEntries, aiEffigyCounts };
    setLastConfig(config);
    setScreen('coinflip');
  };

  // Rematch reuses the exact same deck composition (both players) — only the
  // shuffle and coin flip are re-rolled.
  const handleRematch = () => {
    if (!lastConfig) return;
    setScreen('coinflip');
  };

  const handleCoinFlipResolved = (startingPlayer) => {
    if (!lastConfig) return;
    buildMatch(lastConfig, startingPlayer);
  };

  if (screen === 'import') {
    return <DeckImport onImported={handleImported} onBack={onExitToMenu} />;
  }
  if (screen === 'select') {
    // Import auto-loads the active CSV and immediately advances here, so
    // routing "back" through it would just bounce straight back — go all
    // the way out to the menu instead.
    return (
      <PreconSelect
        pool={pool}
        onStart={handleStart}
        onCustom={() => { setSeedDeck(null); setScreen('build'); }}
        onEdit={(seed) => { setSeedDeck(seed); setScreen('build'); }}
        onBack={onExitToMenu}
        competitiveMode={competitiveMode}
        onToggleCompetitiveMode={setCompetitiveMode}
        aiDifficulty={aiDifficulty}
        onChangeAiDifficulty={setAiDifficulty}
      />
    );
  }
  if (screen === 'build') {
    return <DeckBuilder pool={pool} seedDeck={seedDeck} onStart={handleStart} onBack={() => setScreen('select')} />;
  }
  if (screen === 'coinflip') {
    // key forces a fresh flip (and fresh random caller) on every rematch.
    return <CoinFlip key={matchKey} onResolved={handleCoinFlipResolved} />;
  }
  return (
    <Match
      key={matchKey}
      initialState={matchState}
      onExit={onExitToMenu}
      onRematch={handleRematch}
      deckEntries={lastConfig?.entries}
      competitiveMode={competitiveMode}
    />
  );
}
