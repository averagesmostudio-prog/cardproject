import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Minus, Upload, Search, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { EFFIGY_COLORS, EFFIGY_TYPE_COLORS, getBorderTypeForCard, resolveCardArt } from '../../lib/cardData.js';
import { parseDeckImport } from '../../lib/deckExport.js';
import { renderCardOnCanvas, DEFAULT_POSITIONS } from '../../lib/cardRender.js';
import { useCardFont, useBorderImages, useCardArtImages } from '../../lib/useCardAssets.js';
import {
  PHASE1_PLAYABLE_KINDS, MAIN_DECK_SIZE, MAX_COPIES, MAX_DEITY_COPIES,
  EFFIGY_DECK_SIZE, validateMainDeck, validateEffigyDeck,
} from '../engine/deck.js';
import CardThumbnail from './CardThumbnail.jsx';

export default function DeckBuilder({ pool, onStart, onBack }) {
  const eligible = useMemo(
    () => pool.filter(c => PHASE1_PLAYABLE_KINDS.includes(c.kind) && !c.isToken),
    [pool]
  );
  const [counts, setCounts] = useState({});
  const [effigyCounts, setEffigyCounts] = useState(() => {
    const c = {};
    EFFIGY_COLORS.forEach(color => { c[color] = 0; });
    return c;
  });
  const [importWarnings, setImportWarnings] = useState([]);
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState('list'); // 'list' | 'visual' | 'deck'
  const [sortBy, setSortBy] = useState('none'); // 'none' | 'name' | 'effigyType' | 'cost'
  // Tracked by the card's own id, not a raw array position — previewSource
  // (below) is recomputed with a new order/length whenever search, sortBy,
  // or the deck's own contents change, so a bare index would silently point
  // at whatever card now happens to sit in that slot (e.g. re-sorting, or
  // dropping a card's count to 0 in Deck view while its preview is still
  // open, shifts everything after it up by one). Re-deriving the position
  // from the id on every render keeps Prev/Next correct no matter what
  // changed underneath.
  const [previewCardId, setPreviewCardId] = useState(null);
  const previewCanvasRef = useRef(null);

  const fontLoaded = useCardFont();
  const { borderImages, loaded: borderImagesLoaded } = useBorderImages();
  const { artImages, artBorderImages, loaded: artImagesLoaded } = useCardArtImages();

  const importDeckList = (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // allow re-importing the same file after fixing it
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      let parsed;
      try {
        parsed = parseDeckImport(event.target.result);
      } catch (err) {
        setImportWarnings([err.message]);
        return;
      }

      const warnings = [];
      const nextCounts = {};
      parsed.forEach(({ name, count }) => {
        const found = pool.find(c => c.name === name)
          || pool.find(c => c.name.toLowerCase() === name.toLowerCase());
        if (!found) {
          warnings.push(`"${name}" wasn't found in the loaded CSV — skipped.`);
          return;
        }
        if (!eligible.includes(found)) {
          warnings.push(`"${name}" is a ${found.kind}${found.isToken ? ' token' : ''}, not playable in this version yet — skipped.`);
          return;
        }
        const limit = found.isDeity ? MAX_DEITY_COPIES : MAX_COPIES;
        const clamped = Math.max(0, Math.min(limit, count));
        if (clamped !== count) {
          warnings.push(`"${name}": requested ${count}, capped at ${clamped} (max ${limit}${found.isDeity ? ' for Deities' : ''}).`);
        }
        nextCounts[found.id] = clamped;
      });

      setCounts(nextCounts);
      setImportWarnings(warnings);
    };
    reader.readAsText(file);
  };

  const entries = useMemo(
    () => eligible
      .map(card => ({ card, count: counts[card.id] || 0 }))
      .filter(e => e.count > 0),
    [eligible, counts]
  );

  const totalCost = (card) => card.castingCost.faithless
    + Object.values(card.castingCost.colored).reduce((a, b) => a + b, 0);

  // Colored numbers instead of "N Color" text — same color language as the
  // board's own Effigy Zone breakdown, just more compact in a list row.
  const CostPips = ({ card }) => {
    const { faithless, colored } = card.castingCost;
    const coloredEntries = Object.entries(colored).filter(([, n]) => n > 0);
    if (faithless === 0 && coloredEntries.length === 0) return <span>0</span>;
    return (
      <span className="inline-flex items-center gap-1">
        {faithless > 0 && <span>{faithless}</span>}
        {coloredEntries.map(([color, n]) => (
          <span key={color} className="font-bold" style={{ color: EFFIGY_TYPE_COLORS[color] }}>
            {n}
          </span>
        ))}
      </span>
    );
  };

  // Shared by both "browse the whole pool" (List/Visual) and "review just
  // what's in the deck so far" (Deck) — same search box and sort dropdown
  // apply to whichever source list is currently showing.
  const filterAndSort = useCallback((cards) => {
    const q = search.trim().toLowerCase();
    const filtered = !q ? cards : cards.filter(card =>
      card.name.toLowerCase().includes(q) ||
      (card.textBox || '').toLowerCase().includes(q) ||
      (card.rarity || '').toLowerCase().includes(q) ||
      (card.typing || '').toLowerCase().includes(q) ||
      (card.effigyType || '').includes(q) ||
      Object.keys(card.castingCost?.colored || {}).some(color => color.includes(q))
    );

    if (sortBy === 'none') return filtered;
    const sorted = [...filtered];
    if (sortBy === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === 'effigyType') sorted.sort((a, b) => (a.effigyType || '').localeCompare(b.effigyType || '') || a.name.localeCompare(b.name));
    else if (sortBy === 'cost') sorted.sort((a, b) => totalCost(a) - totalCost(b) || a.name.localeCompare(b.name));
    return sorted;
  }, [search, sortBy]);

  const visibleCards = useMemo(() => filterAndSort(eligible), [eligible, filterAndSort]);
  const visibleDeckCards = useMemo(() => filterAndSort(entries.map(e => e.card)), [entries, filterAndSort]);

  const openPreview = (card) => setPreviewCardId(card.id);

  // Whichever list is actually showing right now — the full pool (List/
  // Visual) or just the deck's own contents (Deck) — is what previewCardId
  // is looked up in.
  const previewSource = viewMode === 'deck' ? visibleDeckCards : visibleCards;

  // Re-derived fresh every render — see previewCardId's own comment above.
  // -1 (not found) covers both "nothing is open" and "the previewed card
  // just dropped out of previewSource" (e.g. its count hit 0 in Deck view)
  // the same way, so the modal simply closes instead of jumping to
  // whatever unrelated card now sits at its old numeric slot.
  const previewIndex = previewCardId == null ? -1 : previewSource.findIndex(c => c.id === previewCardId);

  useEffect(() => {
    if (previewIndex === -1 || !fontLoaded) return;
    const card = previewSource[previewIndex];
    if (!card) return;
    const art = resolveCardArt(card.raw, 'default', artImages, artBorderImages, artImagesLoaded);
    const key = getBorderTypeForCard(card.raw);
    const img = art ? art.artBorderImg : borderImages.current[key];
    if (!img || !(art || borderImagesLoaded[key])) return;
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    renderCardOnCanvas(canvas, card.raw, img, DEFAULT_POSITIONS, undefined, undefined, 'default', art?.artImg, art?.artBoxRect);
  }, [previewIndex, previewSource, fontLoaded, borderImages, borderImagesLoaded, artImages, artBorderImages, artImagesLoaded]);

  const mainTotal = entries.reduce((sum, e) => sum + e.count, 0);
  const effigyTotal = EFFIGY_COLORS.reduce((sum, c) => sum + (effigyCounts[c] || 0), 0);
  const mainErrors = validateMainDeck(entries);
  const effigyErrors = validateEffigyDeck(effigyCounts);
  const canStart = mainErrors.length === 0 && effigyErrors.length === 0;

  const adjust = (card, delta) => {
    setCounts(prev => {
      const current = prev[card.id] || 0;
      const limit = card.isDeity ? MAX_DEITY_COPIES : MAX_COPIES;
      const next = Math.max(0, Math.min(limit, current + delta));
      return { ...prev, [card.id]: next };
    });
  };

  const setCountDirect = (card, value) => {
    const limit = card.isDeity ? MAX_DEITY_COPIES : MAX_COPIES;
    const n = Math.max(0, Math.min(limit, Math.floor(Number(value)) || 0));
    setCounts(prev => ({ ...prev, [card.id]: n }));
  };

  const adjustEffigy = (color, delta) => {
    setEffigyCounts(prev => ({ ...prev, [color]: Math.max(0, (prev[color] || 0) + delta) }));
  };

  const setEffigyDirect = (color, value) => {
    const n = Math.max(0, Math.floor(Number(value)) || 0);
    setEffigyCounts(prev => ({ ...prev, [color]: n }));
  };

  if (eligible.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black p-8">
        <div className="max-w-md text-center">
          <p className="text-stone-300 mb-4">
            That CSV has no Being, Deity, or Prophecy cards (the only types this
            version can play).
          </p>
          <button onClick={onBack} className="px-4 py-2 bg-stone-800 text-white rounded-lg">
            ← Menu
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-white">Build your deck</h1>
          <button onClick={onBack} className="text-sm text-stone-400 hover:text-stone-200">← Menu</button>
        </div>

        <div className="bg-white rounded-lg shadow p-4 mb-4">
          <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
            <h2 className="font-semibold text-stone-700">
              Main Deck — {mainTotal} / {MAIN_DECK_SIZE}
            </h2>
            <div className="flex items-center gap-2">
              <div className="flex bg-stone-100 rounded p-0.5">
                <button
                  onClick={() => setViewMode('list')}
                  className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors ${viewMode === 'list' ? 'bg-white shadow-sm text-stone-800' : 'text-stone-500'}`}
                >
                  List
                </button>
                <button
                  onClick={() => setViewMode('visual')}
                  className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors ${viewMode === 'visual' ? 'bg-white shadow-sm text-stone-800' : 'text-stone-500'}`}
                >
                  Visual
                </button>
                <button
                  onClick={() => setViewMode('deck')}
                  className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors ${viewMode === 'deck' ? 'bg-white shadow-sm text-stone-800' : 'text-stone-500'}`}
                >
                  Deck ({mainTotal})
                </button>
              </div>
              <label className="flex items-center gap-1.5 px-3 py-1.5 bg-stone-100 hover:bg-stone-200 rounded text-xs font-medium text-stone-700 cursor-pointer transition-colors">
                <Upload className="w-3.5 h-3.5" />
                Import Deck List
                <input type="file" accept=".json,.txt" onChange={importDeckList} className="hidden" />
              </label>
            </div>
          </div>

          <div className="flex gap-2 mb-3">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 text-stone-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, text, or rarity…"
                className="w-full pl-8 pr-3 py-1.5 text-sm border border-stone-300 rounded focus:outline-none focus:ring-1 focus:ring-stone-400"
              />
            </div>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="text-sm border border-stone-300 rounded px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-stone-400"
            >
              <option value="none">Sort…</option>
              <option value="name">Name (A–Z)</option>
              <option value="effigyType">Effigy Type</option>
              <option value="cost">Cost (low–high)</option>
            </select>
          </div>

          {importWarnings.length > 0 && (
            <ul className="mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 list-disc pl-4 space-y-0.5">
              {importWarnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}

          {viewMode === 'deck' ? (
            visibleDeckCards.length === 0 ? (
              <p className="text-sm text-stone-400 py-4 text-center">
                {entries.length === 0
                  ? 'Your deck is empty — add cards from the List or Visual view.'
                  : `No deck cards match "${search}".`}
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-96 overflow-y-auto">
                {visibleDeckCards.map(card => {
                  const count = counts[card.id] || 0;
                  const limit = card.isDeity ? MAX_DEITY_COPIES : MAX_COPIES;
                  return (
                    <div key={card.id} className="flex items-center justify-between border border-stone-200 rounded px-3 py-2">
                      <button onClick={() => openPreview(card)} className="min-w-0 text-left hover:opacity-70 transition-opacity">
                        <div className="text-sm font-medium text-stone-800 truncate">{card.name}</div>
                        <div className="text-xs text-stone-400 capitalize flex items-center gap-1 flex-wrap">
                          <span>{card.kind} · Cost</span>
                          <CostPips card={card} />
                          <span>· Str {card.strength} / Life {card.lifespan}</span>
                        </div>
                      </button>
                      <div className="flex items-center gap-2 shrink-0">
                        <button onClick={() => adjust(card, -1)} className="p-1 rounded bg-stone-100 hover:bg-stone-200">
                          <Minus className="w-3 h-3" />
                        </button>
                        <input
                          type="number"
                          min="0"
                          max={limit}
                          value={count}
                          onChange={(e) => setCountDirect(card, e.target.value)}
                          className="w-10 text-center text-sm border border-stone-200 rounded py-0.5"
                        />
                        <button
                          onClick={() => adjust(card, 1)}
                          disabled={count >= limit}
                          className="p-1 rounded bg-stone-100 hover:bg-stone-200 disabled:opacity-30"
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : visibleCards.length === 0 ? (
            <p className="text-sm text-stone-400 py-4 text-center">No cards match "{search}".</p>
          ) : viewMode === 'list' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-96 overflow-y-auto">
              {visibleCards.map(card => {
                const count = counts[card.id] || 0;
                const limit = card.isDeity ? MAX_DEITY_COPIES : MAX_COPIES;
                return (
                  <div key={card.id} className="flex items-center justify-between border border-stone-200 rounded px-3 py-2">
                    <button onClick={() => openPreview(card)} className="min-w-0 text-left hover:opacity-70 transition-opacity">
                      <div className="text-sm font-medium text-stone-800 truncate">{card.name}</div>
                      <div className="text-xs text-stone-400 capitalize flex items-center gap-1 flex-wrap">
                        <span>{card.kind} · Cost</span>
                        <CostPips card={card} />
                        <span>· Str {card.strength} / Life {card.lifespan}</span>
                      </div>
                    </button>
                    <div className="flex items-center gap-2 shrink-0">
                      <button onClick={() => adjust(card, -1)} className="p-1 rounded bg-stone-100 hover:bg-stone-200">
                        <Minus className="w-3 h-3" />
                      </button>
                      <input
                        type="number"
                        min="0"
                        max={limit}
                        value={count}
                        onChange={(e) => setCountDirect(card, e.target.value)}
                        className="w-10 text-center text-sm border border-stone-200 rounded py-0.5"
                      />
                      <button
                        onClick={() => adjust(card, 1)}
                        disabled={count >= limit}
                        className="p-1 rounded bg-stone-100 hover:bg-stone-200 disabled:opacity-30"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3 max-h-96 overflow-y-auto pr-1">
              {visibleCards.map(card => {
                const count = counts[card.id] || 0;
                const limit = card.isDeity ? MAX_DEITY_COPIES : MAX_COPIES;
                return (
                  <div key={card.id} className="relative border border-stone-200 rounded overflow-hidden bg-white flex flex-col">
                    <button onClick={() => openPreview(card)} className="relative block w-full">
                      <CardThumbnail card={card} borderImages={borderImages} borderImagesLoaded={borderImagesLoaded} artImages={artImages} artBorderImages={artBorderImages} artImagesLoaded={artImagesLoaded} fontLoaded={fontLoaded} />
                      {count > 0 && (
                        <span className="absolute top-1 right-1 bg-black/70 text-white text-xs font-bold px-1.5 py-0.5 rounded">
                          x{count}
                        </span>
                      )}
                    </button>
                    <div className="flex items-center justify-between gap-1 px-1.5 py-1 bg-stone-50">
                      <button
                        onClick={() => adjust(card, -1)}
                        disabled={count === 0}
                        className="p-0.5 rounded bg-stone-200 hover:bg-stone-300 transition-colors shrink-0 disabled:opacity-30"
                        aria-label={`Remove one copy of ${card.name}`}
                      >
                        <Minus className="w-3 h-3" />
                      </button>
                      <span className="text-[10px] text-stone-600 truncate" title={card.name}>{card.name}</span>
                      <button
                        onClick={() => adjust(card, 1)}
                        disabled={count >= limit}
                        className="p-0.5 rounded bg-stone-200 hover:bg-stone-300 transition-colors shrink-0 disabled:opacity-30"
                        aria-label={`Add a copy of ${card.name}`}
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {mainErrors.length > 0 && (
            <ul className="mt-3 text-xs text-red-600 list-disc pl-4">
              {mainErrors.map(err => <li key={err}>{err}</li>)}
            </ul>
          )}
        </div>

        <div className="bg-white rounded-lg shadow p-4 mb-6">
          <h2 className="font-semibold text-stone-700 mb-3">
            Effigy Deck — {effigyTotal} / {EFFIGY_DECK_SIZE}
          </h2>
          <div className="flex flex-wrap gap-3">
            {EFFIGY_COLORS.map(color => (
              <div key={color} className="flex items-center gap-2 border border-stone-200 rounded px-3 py-2">
                <span
                  className="w-3 h-3 rounded-full inline-block"
                  style={{ backgroundColor: EFFIGY_TYPE_COLORS[color] }}
                />
                <span className="text-sm capitalize w-20">{color}</span>
                <button onClick={() => adjustEffigy(color, -1)} className="p-1 rounded bg-stone-100 hover:bg-stone-200">
                  <Minus className="w-3 h-3" />
                </button>
                <input
                  type="number"
                  min="0"
                  value={effigyCounts[color] || 0}
                  onChange={(e) => setEffigyDirect(color, e.target.value)}
                  className="w-10 text-center text-sm border border-stone-200 rounded py-0.5"
                />
                <button onClick={() => adjustEffigy(color, 1)} className="p-1 rounded bg-stone-100 hover:bg-stone-200">
                  <Plus className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
          {effigyErrors.length > 0 && (
            <ul className="mt-3 text-xs text-red-600 list-disc pl-4">
              {effigyErrors.map(err => <li key={err}>{err}</li>)}
            </ul>
          )}
        </div>

        <button
          onClick={() => onStart({ entries, effigyCounts })}
          disabled={!canStart}
          className="w-full py-3 bg-stone-800 text-white rounded-lg font-medium disabled:opacity-30"
        >
          Start Match vs. AI
        </button>
      </div>

      {previewIndex !== -1 && previewSource[previewIndex] && (() => {
        const card = previewSource[previewIndex];
        const count = counts[card.id] || 0;
        const limit = card.isDeity ? MAX_DEITY_COPIES : MAX_COPIES;
        return (
          <div
            className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
            onClick={() => setPreviewCardId(null)}
          >
            <div
              className="bg-white rounded-lg shadow-2xl p-4 max-w-lg w-full relative"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setPreviewCardId(null)}
                className="absolute top-3 right-3 p-1.5 rounded-full bg-stone-200 hover:bg-stone-300 transition-colors z-10"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
              <div className="text-center font-semibold text-stone-800 mb-3 pr-8">{card.name}</div>
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={() => {
                    const prev = previewSource[previewIndex - 1];
                    if (prev) setPreviewCardId(prev.id);
                  }}
                  disabled={previewIndex === 0}
                  className="p-2.5 rounded-full bg-stone-200 hover:bg-stone-300 disabled:opacity-30 disabled:hover:bg-stone-200 transition-colors shrink-0"
                  aria-label="Previous card"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <canvas
                  ref={previewCanvasRef}
                  className="max-w-full max-h-[65vh] w-auto h-auto border border-stone-300 mx-auto block"
                />
                <button
                  onClick={() => {
                    const next = previewSource[previewIndex + 1];
                    if (next) setPreviewCardId(next.id);
                  }}
                  disabled={previewIndex === previewSource.length - 1}
                  className="p-2.5 rounded-full bg-stone-200 hover:bg-stone-300 disabled:opacity-30 disabled:hover:bg-stone-200 transition-colors shrink-0"
                  aria-label="Next card"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              </div>
              <div className="flex items-center justify-center gap-3 mt-4">
                <button
                  onClick={() => adjust(card, -1)}
                  disabled={count === 0}
                  className="p-2 rounded-full bg-stone-200 hover:bg-stone-300 disabled:opacity-30 transition-colors"
                  aria-label={`Remove one copy of ${card.name}`}
                >
                  <Minus className="w-4 h-4" />
                </button>
                <span className="text-sm font-medium text-stone-700 w-16 text-center">{count} / {limit}</span>
                <button
                  onClick={() => adjust(card, 1)}
                  disabled={count >= limit}
                  className="p-2 rounded-full bg-stone-200 hover:bg-stone-300 disabled:opacity-30 transition-colors"
                  aria-label={`Add a copy of ${card.name}`}
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
