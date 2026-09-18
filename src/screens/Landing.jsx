import React, { useState } from 'react';
import { LayoutGrid, Swords, PackageOpen, Settings, X } from 'lucide-react';
import { getCustomCsvName, setCustomCsv, clearCustomCsv } from '../lib/csvSource.js';

const PASSCODE = 'WellPlayedGG';

function SettingsModal({ onClose }) {
  const [unlocked, setUnlocked] = useState(false);
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  const [customName, setCustomName] = useState(() => getCustomCsvName());
  const [status, setStatus] = useState('');

  const submitPasscode = (e) => {
    e.preventDefault();
    if (passcode === PASSCODE) {
      setUnlocked(true);
      setError('');
    } else {
      setError('Incorrect passcode.');
    }
  };

  const handleUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      setCustomCsv(event.target.result, file.name);
      setCustomName(file.name);
      setStatus(`Saved "${file.name}" — it'll be used next time you open Build, Open a Pack, or Play a Game.`);
    };
    reader.readAsText(file);
  };

  const handleReset = () => {
    clearCustomCsv();
    setCustomName(null);
    setStatus('Reset to the built-in default CSV.');
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-2xl p-6 max-w-sm w-full relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 p-1.5 rounded-full bg-stone-200 hover:bg-stone-300 transition-colors"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>

        {!unlocked ? (
          <form onSubmit={submitPasscode}>
            <h2 className="text-lg font-bold text-stone-800 mb-1">Settings</h2>
            <p className="text-sm text-stone-500 mb-4">Enter the passcode to change the active card CSV.</p>
            <input
              type="password"
              autoFocus
              value={passcode}
              onChange={(e) => { setPasscode(e.target.value); setError(''); }}
              placeholder="Passcode"
              className="w-full px-3 py-2 border border-stone-300 rounded mb-2 focus:outline-none focus:ring-1 focus:ring-stone-400"
            />
            {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
            <button type="submit" className="w-full px-4 py-2 bg-stone-800 text-white rounded-lg">
              Unlock
            </button>
          </form>
        ) : (
          <div>
            <h2 className="text-lg font-bold text-stone-800 mb-1">Card CSV</h2>
            <p className="text-sm text-stone-500 mb-4">
              Currently using: <span className="font-medium text-stone-700">{customName || 'default (built-in)'}</span>
            </p>
            <label className="flex flex-col items-center justify-center border-2 border-dashed border-stone-300 rounded-lg p-6 cursor-pointer hover:border-stone-400 transition-colors mb-3">
              <span className="text-stone-600 font-medium text-sm">Choose a CSV file</span>
              <input type="file" accept=".csv" onChange={handleUpload} className="hidden" />
            </label>
            {customName && (
              <button
                onClick={handleReset}
                className="w-full px-4 py-2 border border-stone-300 rounded-lg text-sm text-stone-600 hover:bg-stone-50 mb-3"
              >
                Reset to default CSV
              </button>
            )}
            {status && <p className="text-xs text-emerald-700">{status}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Landing({ onSelectGenerator, onSelectGame, onSelectPack }) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="min-h-screen flex items-center justify-center bg-black p-8 relative">
      <button
        onClick={() => setSettingsOpen(true)}
        className="fixed top-4 right-4 z-40 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
        aria-label="Settings"
      >
        <Settings className="w-5 h-5 text-stone-300" />
      </button>

      <div className="max-w-3xl w-full text-center">
        <h1 className="text-3xl font-bold text-white mb-2">Scripturas Alpha</h1>
        <p className="text-stone-400 mb-10">Design cards, open a pack, or play the game.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          <button
            onClick={onSelectPack}
            className="flex flex-col items-center gap-3 p-8 bg-white rounded-xl shadow hover:shadow-lg transition-shadow border border-stone-200"
          >
            <PackageOpen className="w-10 h-10 text-stone-700" />
            <span className="text-lg font-semibold text-stone-800">Open a Pack!</span>
            <span className="text-xs text-stone-400">Crack open a random 14-card pack</span>
          </button>
          <button
            onClick={onSelectGame}
            className="flex flex-col items-center gap-3 p-8 bg-white rounded-xl shadow hover:shadow-lg transition-shadow border border-stone-200"
          >
            <Swords className="w-10 h-10 text-stone-700" />
            <span className="text-lg font-semibold text-stone-800">Play a Game</span>
            <span className="text-xs text-stone-400">Build a deck and play against the AI</span>
          </button>
          <button
            onClick={onSelectGenerator}
            className="flex flex-col items-center gap-3 p-8 bg-white rounded-xl shadow hover:shadow-lg transition-shadow border border-stone-200"
          >
            <LayoutGrid className="w-10 h-10 text-stone-700" />
            <span className="text-lg font-semibold text-stone-800">Build</span>
            <span className="text-xs text-stone-400">Design and export card art from a CSV</span>
          </button>
        </div>
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
