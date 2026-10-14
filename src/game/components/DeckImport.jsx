import React, { useEffect } from 'react';
import { Upload } from 'lucide-react';
import { parseCSV, toGameCard } from '../../lib/cardData.js';
import { getActiveCsvText } from '../../lib/csvSource.js';
import { LINEN_BG, PAGE_BG } from '../../lib/deckBuilderStyle.js';

// Temporary convenience: auto-load the working card set (the bundled default,
// or a custom one set via Settings) so it doesn't need to be re-uploaded by
// hand every time. The manual upload button below still works as an override
// for this session only — use Settings to change it for good.
export default function DeckImport({ onImported, onBack }) {
  const importText = (text) => {
    const rows = parseCSV(text);
    const cards = rows.map((row, idx) => toGameCard(row, idx));
    onImported(cards);
  };

  useEffect(() => {
    getActiveCsvText().then(text => { if (text) importText(text); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => importText(event.target.result);
    reader.readAsText(file);
  };

  return (
    <div className="min-h-dvh flex items-center justify-center p-8 short:p-2" style={{ background: PAGE_BG, fontFamily: 'Georgia, serif' }}>
      <button
        onClick={onBack}
        className="fixed top-3 left-3 z-40 text-xs bg-white/90 border-2 border-black rounded px-3 py-1.5 font-bold hover:bg-white"
      >
        ← Menu
      </button>
      <div className="max-w-md w-full text-center border-[6px] border-black rounded-md p-8" style={{ background: LINEN_BG }}>
        <h1 className="text-2xl font-bold text-stone-900 mb-2">Import your cards</h1>
        <p className="text-stone-800 mb-8 text-sm">
          Upload the same card CSV you use in the Generator. Only Beings, Deities,
          and Prophecies are playable in this version — other card types are
          coming in a later update.
        </p>
        <label className="flex flex-col items-center justify-center border-2 border-dashed border-black rounded-lg p-10 cursor-pointer bg-white/40 hover:bg-white/70 transition-colors">
          <Upload className="w-8 h-8 text-stone-700 mb-3" />
          <span className="text-stone-900 font-bold">Choose a CSV file</span>
          <input type="file" accept=".csv" onChange={handleUpload} className="hidden" />
        </label>
      </div>
    </div>
  );
}
