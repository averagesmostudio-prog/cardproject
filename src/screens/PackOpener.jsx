import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, LayoutGrid, Upload } from 'lucide-react';
import { getColumnData, EFFIGY_TYPE_COLORS, getBorderTypeForCard, parseCSV, resolveCardArt } from '../lib/cardData.js';
import {
  CARD_PX_WIDTH, CARD_PX_HEIGHT, DEFAULT_POSITIONS, renderCardOnCanvas,
  SHEET_COLS, SHEET_ROWS, CARDS_PER_SHEET, pngBlobWithDpi,
} from '../lib/cardRender.js';
import { useCardFont, useBorderImages, useCardArtImages } from '../lib/useCardAssets.js';
import { getActiveCsvText } from '../lib/csvSource.js';
import { classifyRarity, rollPack } from '../lib/packRoll.js';
import SparkleFrame from './SparkleFrame.jsx';
import { LINEN_BG, PAGE_BG } from '../lib/deckBuilderStyle.js';
import { buildEffigyCardRow } from '../lib/effigyCard.js';

const PACK_SIZE = 14;
const THUMB_WIDTH = 320;
const THUMB_HEIGHT = 448;

const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

export default function PackOpener({ onBack }) {
  const [csvData, setCsvData] = useState([]);
  const [currentPack, setCurrentPack] = useState(null);
  const [packError, setPackError] = useState(null);
  const [packThumbnails, setPackThumbnails] = useState({});
  const [packViewIndex, setPackViewIndex] = useState(0);
  const [isExportingPackSheets, setIsExportingPackSheets] = useState(false);
  const effigyTemplateCache = useRef({});

  // Auto-load the working card set (the bundled default, or a custom one set
  // via Settings) so it doesn't need to be re-uploaded by hand every time.
  useEffect(() => {
    getActiveCsvText().then(text => { if (text) setCsvData(parseCSV(text)); }).catch(() => {});
  }, []);

  const fontLoaded = useCardFont();
  const { borderImages: borderImageRefs, loaded: borderImagesLoaded } = useBorderImages();
  const { artImages, artBorderImages, loaded: artImagesLoaded } = useCardArtImages();

  // Tints the Effigy card's border template (the Altar/Conjuring border)'s
  // blank art window (its near-white pixels) to a solid color for the Basic
  // Effigy slot, leaving the marbled border and every other pixel untouched.
  const getTintedEffigyTemplate = (colorType) => {
    if (effigyTemplateCache.current[colorType]) return effigyTemplateCache.current[colorType];

    const baseImg = borderImageRefs.current.conjuring;
    if (!baseImg) return null;

    const hex = EFFIGY_TYPE_COLORS[colorType] || '#888888';
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);

    const canvas = document.createElement('canvas');
    canvas.width = baseImg.naturalWidth;
    canvas.height = baseImg.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(baseImg, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const luminance = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (luminance > 235) {
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
      }
    }
    ctx.putImageData(imageData, 0, 0);

    effigyTemplateCache.current[colorType] = canvas;
    return canvas;
  };

  const pickTemplateImageForPack = (card) => {
    if (card.__effigyColor) {
      const tinted = getTintedEffigyTemplate(card.__effigyColor);
      return { img: tinted, loaded: !!tinted };
    }
    const art = resolveCardArt(card, undefined, artImages, artBorderImages, artImagesLoaded);
    if (art) return { img: art.artBorderImg, loaded: true, artImg: art.artImg, artBoxRect: art.artBoxRect };
    const key = getBorderTypeForCard(card);
    return { img: borderImageRefs.current[key], loaded: !!borderImagesLoaded[key] };
  };

  // The same Effigy card face the Deck Builder shows (effigyCard.js): Altar
  // border, one pip of its color, its Engage text, rarity C.
  const makeBasicEffigyCard = () => {
    const colorTypes = ['bleeding', 'living', 'formless', 'timeless', 'shifting'];
    const colorType = pickRandom(colorTypes);
    return { ...buildEffigyCardRow(colorType), __effigyColor: colorType };
  };

  const generatePack = (pool) => {
    const pools = { common: [], uncommon: [], rare: [], sacred: [] };
    pool.forEach(card => {
      const tier = classifyRarity(card);
      if (tier) pools[tier].push(card);
    });
    const tokenPool = pool.filter(card =>
      (getColumnData(card, ['Card Typing', 'Card typing']) || '').toLowerCase().includes('token')
    );

    const missing = [];
    if (pools.common.length === 0) missing.push('Common');
    if (pools.uncommon.length === 0) missing.push('Uncommon');
    if (pools.rare.length === 0) missing.push('Rare');
    if (tokenPool.length === 0) missing.push('Token (Card Typing containing "Token")');
    if (missing.length > 0) {
      setPackError(`Can't build a pack — no cards found for: ${missing.join(', ')}. Make sure the loaded CSV has a Rarity column filled in.`);
      setCurrentPack(null);
      return;
    }

    const pack = rollPack({ pools, tokenPool, makeBasicEffigy: makeBasicEffigyCard });

    setPackError(null);
    setCurrentPack(pack);
    setPackViewIndex(0);
  };

  const handleUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const rows = parseCSV(event.target.result);
      setCsvData(rows);
    };
    reader.readAsText(file);
  };

  // Opens a pack automatically as soon as a CSV is loaded — no extra click needed.
  useEffect(() => {
    if (csvData.length > 0 && !currentPack && !packError) generatePack(csvData);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csvData]);

  useEffect(() => {
    if (!currentPack || !fontLoaded) return;
    const canvas = document.createElement('canvas');
    const next = {};
    currentPack.forEach(({ card }, idx) => {
      const { img, loaded, artImg, artBoxRect } = pickTemplateImageForPack(card);
      if (img && loaded) {
        renderCardOnCanvas(canvas, card, img, DEFAULT_POSITIONS, THUMB_WIDTH, THUMB_HEIGHT, undefined, artImg, artBoxRect);
        next[idx] = canvas.toDataURL('image/png');
      }
    });
    setPackThumbnails(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPack, fontLoaded, borderImagesLoaded, artImagesLoaded]);

  const downloadPackList = () => {
    if (!currentPack) return;
    const lines = currentPack.map(({ card, slot }) => `${slot}: ${card['Card Name'] || 'Unnamed Card'}`);
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = 'pack_list.txt';
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const downloadPackPrintSheets = async () => {
    if (!currentPack) return;
    setIsExportingPackSheets(true);

    const cardCanvas = document.createElement('canvas');
    const totalPages = Math.ceil(currentPack.length / CARDS_PER_SHEET);

    for (let page = 0; page < totalPages; page++) {
      const pageCanvas = document.createElement('canvas');
      pageCanvas.width = CARD_PX_WIDTH * SHEET_COLS;
      pageCanvas.height = CARD_PX_HEIGHT * SHEET_ROWS;
      const pctx = pageCanvas.getContext('2d');
      pctx.fillStyle = '#ffffff';
      pctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);

      for (let slot = 0; slot < CARDS_PER_SHEET; slot++) {
        const cardIndex = page * CARDS_PER_SHEET + slot;
        if (cardIndex >= currentPack.length) break;

        const { img, loaded, artImg, artBoxRect } = pickTemplateImageForPack(currentPack[cardIndex].card);
        if (!img || !loaded) continue;

        renderCardOnCanvas(cardCanvas, currentPack[cardIndex].card, img, DEFAULT_POSITIONS, undefined, undefined, undefined, artImg, artBoxRect);

        const col = slot % SHEET_COLS;
        const row = Math.floor(slot / SHEET_COLS);
        pctx.drawImage(cardCanvas, col * CARD_PX_WIDTH, row * CARD_PX_HEIGHT, CARD_PX_WIDTH, CARD_PX_HEIGHT);
      }

      const blob = await pngBlobWithDpi(pageCanvas);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `pack_sheet_${page + 1}.png`;
      link.href = url;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      await new Promise(resolve => setTimeout(resolve, 150));
    }

    setIsExportingPackSheets(false);
  };

  return (
    <div className="min-h-dvh p-6 short:p-2" style={{ background: PAGE_BG, fontFamily: 'Georgia, serif' }}>
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={onBack}
            aria-label="Back to menu"
            className="p-2 -ml-2 rounded hover:bg-stone-800 transition-colors text-stone-300"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <h1 className="text-xl font-bold text-white">Open a Pack!</h1>
        </div>

        {csvData.length === 0 ? (
          <div className="border-[6px] border-black rounded-md p-8 text-center" style={{ background: LINEN_BG }}>
            <p className="text-sm text-stone-800 mb-4">
              Upload a card CSV (with a Rarity column) to open a 14-card pack: 6
              Common, 3 Uncommon, 2 Rare (~1 in 12 upgrade to Sacred Rare), 1
              Wildcard, 1 Basic Effigy, 1 Token. Any card can roll a Historic
              (stylized art) version.
            </p>
            <label className="inline-flex flex-col items-center justify-center border-2 border-dashed border-black rounded-lg p-10 cursor-pointer bg-white/40 hover:bg-white/70 transition-colors">
              <Upload className="w-8 h-8 text-stone-700 mb-3" />
              <span className="text-stone-900 font-bold">Choose a CSV file</span>
              <input type="file" accept=".csv" onChange={handleUpload} className="hidden" />
            </label>
          </div>
        ) : (
          <div className="border-[6px] border-black rounded-md p-6" style={{ background: LINEN_BG }}>
            {packError && (
              <div className="mb-4 p-3 bg-red-100 border-2 border-red-800 rounded text-sm text-red-900">
                {packError}
              </div>
            )}

            {currentPack && (
              <>
                <div className="flex items-center justify-center gap-4 sm:gap-6 mb-4">
                  <button
                    onClick={() => setPackViewIndex(i => Math.max(0, i - 1))}
                    disabled={packViewIndex === 0}
                    className="p-3 rounded-full border-2 border-black bg-[#393938] text-white hover:bg-black disabled:opacity-30 disabled:hover:bg-[#393938] transition-colors shrink-0"
                    aria-label="Previous card"
                  >
                    <ChevronLeft className="w-6 h-6" />
                  </button>

                  <div className="relative w-56 sm:w-64" style={{ aspectRatio: '5 / 7' }}>
                    {packViewIndex < currentPack.length - 2 && (
                      <div className="absolute inset-0 translate-x-3 translate-y-3 bg-stone-800 rounded-lg border border-stone-600" />
                    )}
                    {packViewIndex < currentPack.length - 1 && (
                      <div className="absolute inset-0 translate-x-1.5 translate-y-1.5 bg-stone-900 rounded-lg border border-stone-700" />
                    )}
                    <SparkleFrame
                      key={`${packViewIndex}-${currentPack[packViewIndex].sparkle || 'none'}`}
                      tier={currentPack[packViewIndex].sparkle}
                    />
                    <div className="relative border-2 border-purple-400 rounded-lg overflow-hidden bg-white shadow-xl">
                      {packThumbnails[packViewIndex] ? (
                        <img
                          src={packThumbnails[packViewIndex]}
                          alt={currentPack[packViewIndex].card['Card Name']}
                          className="w-full block"
                        />
                      ) : (
                        <div className="w-full aspect-[5/7] bg-stone-100 flex items-center justify-center text-xs text-stone-400">
                          Loading…
                        </div>
                      )}
                    </div>
                  </div>

                  <button
                    onClick={() => setPackViewIndex(i => Math.min(currentPack.length - 1, i + 1))}
                    disabled={packViewIndex === currentPack.length - 1}
                    className="p-3 rounded-full border-2 border-black bg-[#393938] text-white hover:bg-black disabled:opacity-30 disabled:hover:bg-[#393938] transition-colors shrink-0"
                    aria-label="Next card"
                  >
                    <ChevronRight className="w-6 h-6" />
                  </button>
                </div>

                <div className="text-center mb-4">
                  <div className="text-sm font-bold text-stone-700">{currentPack[packViewIndex].slot}</div>
                  <div className="text-stone-900 font-bold">{currentPack[packViewIndex].card['Card Name']}</div>
                  <div className="text-xs text-stone-700 mt-1">{packViewIndex + 1} / {PACK_SIZE}</div>
                </div>

                <div className="flex flex-wrap items-center justify-center gap-3">
                  <button
                    onClick={() => generatePack(csvData)}
                    className="flex items-center gap-2 px-4 py-2 border-2 border-black bg-[#393938] text-white font-bold rounded-lg hover:bg-black transition-colors"
                  >
                    Open another Pack
                  </button>
                  <button
                    onClick={downloadPackList}
                    className="flex items-center gap-2 px-4 py-2 border-2 border-black bg-white/60 text-stone-900 font-bold rounded-lg hover:bg-white/90 transition-colors"
                  >
                    <Download className="w-4 h-4" />
                    Download Pack List (.txt)
                  </button>
                  <button
                    onClick={downloadPackPrintSheets}
                    disabled={isExportingPackSheets}
                    className="flex items-center gap-2 px-4 py-2 border-2 border-black bg-white/60 text-stone-900 font-bold rounded-lg hover:bg-white/90 transition-colors disabled:opacity-60"
                  >
                    <LayoutGrid className="w-4 h-4" />
                    {isExportingPackSheets ? 'Building sheet…' : 'Download Pack Print Sheet'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
