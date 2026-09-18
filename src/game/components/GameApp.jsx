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
  resolvePreconEntries, validateMainDeck,
} from '../engine/deck.js';
import { PRECON_DECKS } from '../decks/precons.js';

// One of the same 3 precons a human can pick (see PreconSelect.jsx),
// chosen at random — falls back to the old random-mono-color auto-build
// only if the loaded card set doesn't actually contain that precon's cards
// (a heavily customized CSV missing the bundled precon's names), so the AI
// always ends up with a real, legal 40-card deck either way.
const pickAiDeck = (pool) => {
  const shuffled = [...PRECON_DECKS].sort(() => Math.random() - 0.5);
  for (const precon of shuffled) {
    const { entries, effigyCounts } = resolvePreconEntries(pool, precon);
    if (validateMainDeck(entries).length === 0) return { entries, effigyCounts };
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
    // The AI opponent plays one of the same 3 precons a human can pick,
    // chosen at random (pickAiDeck, above) — same mono-color-deck guarantee
    // the old random auto-build had (every colored card it draws is
    // actually payable from its own mono-color Effigy Deck), just a real
    // curated list instead of a random legal pile.
    const { entries: aiEntries, effigyCounts: aiEffigyCounts } = pickAiDeck(pool);
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
    return <PreconSelect pool={pool} onStart={handleStart} onCustom={() => setScreen('build')} onBack={onExitToMenu} />;
  }
  if (screen === 'build') {
    return <DeckBuilder pool={pool} onStart={handleStart} onBack={() => setScreen('select')} />;
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
    />
  );
}
