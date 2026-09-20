import React, { useState } from 'react';
import Landing from './screens/Landing.jsx';
import TradingCardGenerator from './generator/TradingCardGenerator.jsx';
import GameApp from './game/components/GameApp.jsx';
import PackOpener from './screens/PackOpener.jsx';
import Library from './screens/Library.jsx';

export default function App() {
  const [screen, setScreen] = useState('landing'); // 'landing' | 'library' | 'generator' | 'game' | 'pack'
  // The Generator is reached both directly (no longer possible from Landing,
  // kept anyway for the 'landing' fallback) and as a Library sub-destination
  // ("Design Cards") — its own back button should return wherever it was
  // opened from, not always skip past Library to the top-level menu.
  const [generatorBackTo, setGeneratorBackTo] = useState('landing');

  if (screen === 'generator') {
    return (
      <div>
        <button
          onClick={() => setScreen(generatorBackTo)}
          className="fixed top-3 left-3 z-40 text-xs bg-white/90 border border-stone-300 rounded px-3 py-1.5 shadow hover:bg-white"
        >
          ← Menu
        </button>
        <TradingCardGenerator />
      </div>
    );
  }

  if (screen === 'library') {
    return (
      <Library
        onBack={() => setScreen('landing')}
        onSelectGenerator={() => { setGeneratorBackTo('library'); setScreen('generator'); }}
      />
    );
  }

  if (screen === 'game') {
    return <GameApp onExitToMenu={() => setScreen('landing')} />;
  }

  if (screen === 'pack') {
    return <PackOpener onBack={() => setScreen('landing')} />;
  }

  return (
    <Landing
      onSelectLibrary={() => setScreen('library')}
      onSelectGame={() => setScreen('game')}
      onSelectPack={() => setScreen('pack')}
    />
  );
}
