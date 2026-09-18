import React, { useState } from 'react';
import Landing from './screens/Landing.jsx';
import TradingCardGenerator from './generator/TradingCardGenerator.jsx';
import GameApp from './game/components/GameApp.jsx';
import PackOpener from './screens/PackOpener.jsx';

export default function App() {
  const [screen, setScreen] = useState('landing'); // 'landing' | 'generator' | 'game' | 'pack'

  if (screen === 'generator') {
    return (
      <div>
        <button
          onClick={() => setScreen('landing')}
          className="fixed top-3 left-3 z-40 text-xs bg-white/90 border border-stone-300 rounded px-3 py-1.5 shadow hover:bg-white"
        >
          ← Menu
        </button>
        <TradingCardGenerator />
      </div>
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
      onSelectGenerator={() => setScreen('generator')}
      onSelectGame={() => setScreen('game')}
      onSelectPack={() => setScreen('pack')}
    />
  );
}
