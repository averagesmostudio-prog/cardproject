import React, { useState } from 'react';
import { Settings, X, BookOpen, Maximize, Minimize } from 'lucide-react';
import { useFullscreen } from '../lib/useFullscreen.js';
import FullscreenHint from '../game/components/FullscreenHint.jsx';
import { getCustomCsvName, setCustomCsv, clearCustomCsv, CSV_PASSCODE } from '../lib/csvSource.js';
import { LINEN_BG, PAGE_BG } from '../lib/deckBuilderStyle.js';

// The coin's two faces (the same art the coin flip uses): front for Play
// Test, back for Play a Game (online).
function CoinIcon({ face, className }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}coin/coin_${face}.png`}
      alt=""
      aria-hidden="true"
      className={`${className} object-contain drop-shadow-md`}
    />
  );
}

// A closed leather-bound journal — a worn leather cover wrapped with a tied
// strap, and a rough deckle-edge page block peeking out along the spine
// side. Drawn as plain SVG (not the reference photo, which was an
// unlicensed stock image) so it scales crisply and matches the warm
// leather/paper palette the other two icons on this screen share.
function OpenPackIcon({ className }) {
  return (
    <svg viewBox="0 0 200 220" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <radialGradient id="leatherCoverGrad" cx="32%" cy="24%" r="90%">
          <stop offset="0%" stopColor="#8a6a44" />
          <stop offset="45%" stopColor="#5c4128" />
          <stop offset="100%" stopColor="#2e1f10" />
        </radialGradient>
      </defs>
      {/* the rough-cut page block, peeking out along the right/spine edge */}
      <rect x="150" y="20" width="24" height="182" rx="5" fill="#cbb27f" />
      <line x1="156" y1="26" x2="156" y2="196" stroke="#a68f5f" strokeWidth="1.5" />
      <line x1="162" y1="26" x2="162" y2="196" stroke="#a68f5f" strokeWidth="1.5" />
      <line x1="168" y1="26" x2="168" y2="196" stroke="#a68f5f" strokeWidth="1.5" />
      {/* leather cover */}
      <rect x="18" y="14" width="148" height="194" rx="14" fill="url(#leatherCoverGrad)" stroke="#1c1209" strokeWidth="2" />
      {/* hand-stitched edge, left side */}
      {[38, 62, 86, 110, 134, 158, 182].map((y) => (
        <line key={y} x1="26" y1={y - 4} x2="34" y2={y + 4} stroke="#b98a4f" strokeWidth="2" strokeLinecap="round" />
      ))}
      {/* wrap-around strap, tied in a knot at center */}
      <rect x="18" y="103" width="148" height="16" fill="#241a0f" opacity="0.85" />
      <rect x="90" y="60" width="14" height="100" rx="4" fill="#241a0f" opacity="0.85" />
      <rect x="82" y="103" width="30" height="16" rx="3" fill="#4a3018" stroke="#1c1209" strokeWidth="1.5" />
      <polygon points="97,100 107,111 97,122 87,111" fill="#6b4a28" stroke="#1c1209" strokeWidth="1.5" />
    </svg>
  );
}

// An inkwell with a feather quill resting in it, nib dipped toward the ink —
// same "drawn, not photographed" approach as the other two icons. The
// quill's shaft/feather is built in its own local coordinate space (tip —
// the nib — pointing along +x) and rotated into place over the bottle.
function InkwellQuillIcon({ className }) {
  return (
    <svg viewBox="0 0 200 220" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {/* Normalizes this icon's own drawn content to fill/center the
          viewBox about the same as the other two icons — the raw artwork
          below was drawn at its own natural size, which came out noticeably
          smaller and off-center than the pack/sword+pen icons once compared
          side by side. */}
      <g transform="translate(100,110) scale(1.4) translate(-96,-126.6)">
        {/* feather quill, leaning down into the inkwell */}
        <g transform="translate(108,168) rotate(65)">
          <path
            d="M-120,0 Q-72,-30 -15,-5 Q-72,15 -120,0 Z"
            fill="#cbbfa8"
            stroke="#7a6d54"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          <line x1="-105" y1="-1" x2="-92" y2="-17" stroke="#7a6d54" strokeWidth="2" />
          <line x1="-90" y1="-1" x2="-77" y2="-19" stroke="#7a6d54" strokeWidth="2" />
          <line x1="-75" y1="-2" x2="-62" y2="-19" stroke="#7a6d54" strokeWidth="2" />
          <line x1="-60" y1="-2" x2="-48" y2="-17" stroke="#7a6d54" strokeWidth="2" />
          <line x1="-45" y1="-3" x2="-34" y2="-15" stroke="#7a6d54" strokeWidth="2" />
          <path d="M-15,-4 L12,4" stroke="#e8ddc4" strokeWidth="4.5" strokeLinecap="round" />
          <path d="M12,4 L24,8" stroke="#4a3826" strokeWidth="3.5" strokeLinecap="round" />
        </g>
        {/* glass inkwell */}
        <rect x="72" y="128" width="20" height="52" rx="6" fill="#dfe6e6" opacity="0.55" stroke="#8a9494" strokeWidth="1.5" />
        <rect x="58" y="150" width="84" height="52" rx="12" fill="#e6ecec" opacity="0.5" stroke="#8a9494" strokeWidth="2" />
        <path d="M64,164 C64,188 74,198 100,198 C126,198 136,188 136,164 Z" fill="#0d0d10" />
        <line x1="72" y1="158" x2="72" y2="192" stroke="#fff" strokeOpacity="0.35" strokeWidth="3" />
      </g>
    </svg>
  );
}

function SettingsModal({ onClose }) {
  const [unlocked, setUnlocked] = useState(false);
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  const [customName, setCustomName] = useState(() => getCustomCsvName());
  const [status, setStatus] = useState('');

  const submitPasscode = (e) => {
    e.preventDefault();
    if (passcode === CSV_PASSCODE) {
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
      setStatus(`Saved "${file.name}" — it'll be used next time you open Open a Pack, Play Test, Play a Game, or the Library.`);
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

export default function Landing({ onSelectLibrary, onSelectGame, onSelectNetGame, onSelectPack, onSelectHowToPlay }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fullscreen = useFullscreen();

  return (
    <div
      className="min-h-dvh flex items-center justify-center p-8 short:p-3 relative"
      style={{ background: PAGE_BG, fontFamily: 'Georgia, serif' }}
    >
      <button
        onClick={() => setSettingsOpen(true)}
        className="fixed top-4 right-4 z-40 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
        aria-label="Settings"
      >
        <Settings className="w-5 h-5 text-stone-300" />
      </button>
      {fullscreen.available && (
        <button
          onClick={fullscreen.toggle}
          className="fixed top-4 right-16 z-40 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
          aria-label={fullscreen.active ? 'Exit full screen' : 'Full screen'}
        >
          {fullscreen.active ? <Minimize className="w-5 h-5 text-stone-300" /> : <Maximize className="w-5 h-5 text-stone-300" />}
        </button>
      )}
      <FullscreenHint open={fullscreen.hintOpen} onClose={fullscreen.closeHint} />
      <button
        onClick={onSelectHowToPlay}
        className="fixed top-4 left-4 z-40 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
        aria-label="How to play"
      >
        <BookOpen className="w-5 h-5 text-stone-300" />
      </button>

      <div className="max-w-3xl short:max-w-none w-full text-center border-[6px] border-black rounded-md p-6 sm:p-8 short:p-3" style={{ background: LINEN_BG }}>
        <h1 className="text-3xl short:text-xl font-bold text-stone-900 mb-2 short:mb-0">Scripturas Alpha</h1>
        <p className="text-stone-800 mb-8 short:mb-3 short:text-sm">Design cards, open a pack, or play the game.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 short:!grid-cols-4 gap-6 short:gap-2">
          <button
            onClick={onSelectPack}
            className="flex flex-col items-center justify-center gap-3 p-8 short:p-2 bg-white/60 hover:bg-white/90 rounded-lg border-[3px] border-black transition-colors"
          >
            <OpenPackIcon className="h-24 short:h-12 w-auto" />
            <span className="text-lg short:text-sm font-bold text-stone-900">Open a Pack!</span>
          </button>
          <button
            onClick={onSelectGame}
            className="flex flex-col items-center gap-3 p-8 short:p-2 bg-white/60 hover:bg-white/90 rounded-lg border-[3px] border-black transition-colors"
          >
            <CoinIcon face="heads" className="h-24 w-24 short:h-12 short:w-12" />
            <span className="text-lg short:text-sm font-bold text-stone-900">Play Test</span>
            <span className="text-xs short:hidden text-stone-700">Test vs the AI Opponent before heading into Battle</span>
          </button>
          <button
            onClick={onSelectNetGame}
            className="flex flex-col items-center gap-3 p-8 short:p-2 bg-white/60 hover:bg-white/90 rounded-lg border-[3px] border-black transition-colors"
          >
            <CoinIcon face="tails" className="h-24 w-24 short:h-12 short:w-12" />
            <span className="text-lg short:text-sm font-bold text-stone-900">Play a Game</span>
            <span className="text-xs short:hidden text-stone-700">Compete vs other Players in Ranked or Casual</span>
          </button>
          <button
            onClick={onSelectLibrary}
            className="flex flex-col items-center gap-3 p-8 short:p-2 bg-white/60 hover:bg-white/90 rounded-lg border-[3px] border-black transition-colors"
          >
            <InkwellQuillIcon className="h-24 short:h-12 w-auto" />
            <span className="text-lg short:text-sm font-bold text-stone-900">Library</span>
            <span className="text-xs short:hidden text-stone-700">Manage decks and Browse the Card Pool</span>
          </button>
        </div>
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
