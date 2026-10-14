import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Minus, Upload, Download, Search, X, ChevronLeft, ChevronRight, Save, Copy } from 'lucide-react';
import { EFFIGY_COLORS, EFFIGY_TYPE_COLORS, getBorderTypeForCard, resolveCardArt, totalCastingCost } from '../../lib/cardData.js';
import { buildDeckExport, parseDeckImportFull } from '../../lib/deckExport.js';
import { saveDeck, updateDeck, nextCopyName } from '../../lib/deckLibrary.js';
import { renderCardOnCanvas, DEFAULT_POSITIONS } from '../../lib/cardRender.js';
import { useCardFont, useBorderImages, useCardArtImages } from '../../lib/useCardAssets.js';
import {
  PHASE1_PLAYABLE_KINDS, MAIN_DECK_SIZE, MAX_COPIES, MAX_DEITY_COPIES,
  EFFIGY_DECK_SIZE, validateMainDeck, validateEffigyDeck, resolveDeckEntries,
} from '../engine/deck.js';
import CardThumbnail from './CardThumbnail.jsx';
import EffigyCardCanvas from './EffigyCardCanvas.jsx';
import { EFFIGY_LABELS } from '../../lib/effigyCard.js';
import { LINEN_BG, PAGE_BG } from '../../lib/deckBuilderStyle.js';

// "Strength=2", "Lifespan<3", "Cost>1" — a search term matching this pattern
// filters by a numeric card field (an exact/less-than/greater-than
// comparison) instead of substring-matching text. FIELD_GETTERS' keys are
// every accepted spelling of a field; "cost" means total printed Effigy
// cost (totalCastingCost), matching how DeckBuilder already sorts by cost.

// Stepper icons and count inputs: comfortable on a desktop mouse, and bumped to
// a full 44px tap target (16px+ input text, so iOS doesn't zoom on focus) on
// touch screens.
const STEP_ICON = 'w-4 h-4 [@media(pointer:coarse)]:w-5 [@media(pointer:coarse)]:h-5';
const STEP_INPUT = 'w-10 text-center text-sm border border-stone-200 rounded py-0.5 [@media(pointer:coarse)]:w-14 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:text-base';

// Deck Builder "card book" look: gray linen panels with solid black borders over
// a mottled dark backdrop, colored typing tabs across the top.
const TEXT_OUTLINE = '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 3px #000';
const TYPING_TABS = ['formless', 'living', 'bleeding', 'timeless', 'shifting', 'faithless'];
const EFFIGY_TAB_COLOR = '#efe6c9';
const PAGE_SIZE = 8;
const COST_FILTERS = ['all', 0, 1, 2, 3, 4, 5, '6+'];
const KIND_ORDER = ['being', 'deity', 'prophecy', 'relic', 'relic-armament', 'conjuring', 'ethereal-conjuring', 'altar'];
const KIND_LABELS = {
  being: 'Being', deity: 'Deity', prophecy: 'Prophecy', relic: 'Relic', 'relic-armament': 'Armament',
  conjuring: 'Conjuring', 'ethereal-conjuring': 'Ethereal', altar: 'Altar',
};
// Dark text on the light gems, white on the saturated ones.
const GEM_TEXT = (color) => (['timeless', 'shifting', 'faithless'].includes(color) ? '#111' : '#fff');
const cardTypingTab = (card) => {
  const t = (card.effigyType || '').toLowerCase();
  return TYPING_TABS.includes(t) ? t : 'faithless';
};
const CHIP = 'border-2 border-black rounded-full px-3 py-1 text-xs font-bold transition-colors';
const EFF_STEP = 'inline-flex items-center justify-center shrink-0 rounded-full border-2 border-black bg-white/60 hover:bg-white/90 w-8 h-8 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:h-11';

const FIELD_GETTERS = {
  strength: (card) => card.strength || 0,
  str: (card) => card.strength || 0,
  lifespan: (card) => card.lifespan || 0,
  life: (card) => card.lifespan || 0,
  cost: (card) => totalCastingCost(card),
};
const FIELD_QUERY_RE = /^(strength|str|lifespan|life|cost)\s*(=|<|>)\s*(\d+)$/i;

const cardMatchesText = (card, q) =>
  card.name.toLowerCase().includes(q) ||
  (card.textBox || '').toLowerCase().includes(q) ||
  (card.rarity || '').toLowerCase().includes(q) ||
  (card.typing || '').toLowerCase().includes(q) ||
  (card.effigyType || '').includes(q) ||
  Object.keys(card.castingCost?.colored || {}).some(color => color.includes(q));

const cardMatchesFieldQuery = (card, field, op, value) => {
  const actual = FIELD_GETTERS[field](card);
  if (op === '=') return actual === value;
  if (op === '<') return actual < value;
  return actual > value; // '>'
};

// Multiple terms combine with ":" (e.g. "Strength=2:Cost<3"), ANDed
// together — each term is either a field comparison or, falling back to the
// original behavior, a free-text substring match.
const filterCards = (cards, search) => {
  const terms = search.trim().split(':').map(t => t.trim()).filter(Boolean);
  if (terms.length === 0) return cards;
  return cards.filter(card => terms.every(term => {
    const m = term.match(FIELD_QUERY_RE);
    return m
      ? cardMatchesFieldQuery(card, m[1].toLowerCase(), m[2], parseInt(m[3], 10))
      : cardMatchesText(card, term.toLowerCase());
  }));
};

// `libraryDecks` (+ onSelectDeck / onNewDeck / onRemoveDeck / onDesignCards) is
// only passed by the Library screen: it turns the right-hand panel into a deck
// switcher as well, so picking, building and editing happen on one screen.
export default function DeckBuilder({ pool, seedDeck, onStart, onSaveComplete, onBack, libraryDecks, onSelectDeck, onNewDeck, onRemoveDeck, onDesignCards }) {
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
  const [deckName, setDeckName] = useState(seedDeck?.sourceName || '');
  const [saveStatus, setSaveStatus] = useState('');
  const [importWarnings, setImportWarnings] = useState([]);
  const [dirty, setDirty] = useState(false); // unsaved edits since the deck was loaded/saved
  const justSavedRef = useRef(null); // id of a deck we just saved, so the re-seed that follows keeps the status line

  // Pre-populates once from a Library pick (precon or saved deck) — still
  // fully editable afterward. Runs again if seedDeck's identity changes
  // (a fresh "New Deck" passes null and clears back to empty) or once the
  // pool actually finishes loading (Library.jsx loads it async on mount).
  useEffect(() => {
    if (!seedDeck) return;
    if (pool.length === 0) return;
    const { entries: resolved, effigyCounts: resolvedEffigy, warnings } = resolveDeckEntries(pool, {
      entries: seedDeck.entries, effigyCounts: seedDeck.effigyCounts, color: seedDeck.color,
    });
    const nextCounts = {};
    resolved.forEach(({ card, count }) => { nextCounts[card.id] = count; });
    setCounts(nextCounts);
    setEffigyCounts(resolvedEffigy);
    setDeckName(seedDeck.sourceName || '');
    if (justSavedRef.current && seedDeck.sourceId === justSavedRef.current) justSavedRef.current = null;
    else setSaveStatus('');
    setImportWarnings(warnings.length > 0 ? warnings : []);
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedDeck, pool]);
  const [search, setSearch] = useState('');
  // Two independent toggles: WHICH cards (the whole Library pool vs just the
  // Deck being built) and HOW they're laid out (a text List vs card Visuals).
  const [source, setSource] = useState('library'); // 'library' | 'deck'
  const [layout, setLayout] = useState('visual'); // 'list' | 'visual'
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

  // Card-book browsing: which typing tab (or the Effigy tab) is open, the
  // type / cost chips, the current page, and the hover/pinned card preview
  // shown beside the deck panel.
  const [activeTab, setActiveTab] = useState('formless');
  const [kindFilter, setKindFilter] = useState('all');
  const [costFilter, setCostFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [hover, setHover] = useState(null); // { type: 'card' | 'effigy', key, top }
  const [dropActive, setDropActive] = useState(false);
  const [removeDrag, setRemoveDrag] = useState(false); // dragging a deck row out to remove it
  const deckPanelRef = useRef(null);
  const [coarse] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches);

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
      let importedEffigy = null;
      try {
        ({ entries: parsed, effigyCounts: importedEffigy } = parseDeckImportFull(event.target.result));
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
      setDirty(true);
      // An export carries the Effigy Deck too — restore it (unknown colors are
      // ignored). A main-deck-only file leaves the current Effigy counts alone.
      if (importedEffigy) {
        const nextEffigy = Object.fromEntries(EFFIGY_COLORS.map(color => [color, importedEffigy[color] || 0]));
        const ignored = Object.keys(importedEffigy).filter(color => !EFFIGY_COLORS.includes(color));
        if (ignored.length > 0) warnings.push(`Ignored unknown Effigy type(s): ${ignored.join(', ')}.`);
        setEffigyCounts(nextEffigy);
      }
      setImportWarnings(warnings);
    };
    reader.readAsText(file);
  };

  // Downloads the deck as a JSON file the importer above reads back: the Main
  // Deck AND the Effigy Deck (a deck exported without its Effigies couldn't be
  // played as exported).
  const exportDeckList = () => {
    const data = buildDeckExport(
      entries.map(({ card, count }) => ({ name: card.name, count })),
      { effigyCounts, name: deckName || null },
    );
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeName = (deckName || 'deck').trim().replace(/[^a-z0-9 _-]+/gi, '').replace(/\s+/g, '-') || 'deck';
    link.download = `${safeName}.json`;
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
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
  // apply to whichever source list is currently showing. A term like
  // "Strength=2" or "Cost<3" filters by a numeric card field instead of
  // substring-matching text; multiple terms combine with ":" (e.g.
  // "Strength=2:Cost<3"), ANDed together — see filterCards below. Any term
  // that isn't one of these field comparisons falls back to the original
  // free-text substring search, so a plain query still behaves exactly as
  // before.
  const filterAndSort = useCallback((cards) => {
    const filtered = filterCards(cards, search);

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

  const searching = search.trim() !== '';
  const kindsPresent = useMemo(() => KIND_ORDER.filter(k => eligible.some(c => c.kind === k)), [eligible]);
  const costMatches = (card) => {
    if (costFilter === 'all') return true;
    const cost = totalCastingCost(card);
    return costFilter === '6+' ? cost >= 6 : cost === costFilter;
  };

  // The cards the book is showing: the whole Library or just the Deck (Source
  // toggle), narrowed by the open typing tab (a search looks across every tab),
  // the type chip and the cost chip.
  const shownCards = useMemo(() => {
    const base = source === 'deck' ? visibleDeckCards : visibleCards;
    return base.filter(card =>
      (searching || activeTab === 'effigy' || cardTypingTab(card) === activeTab)
      && (kindFilter === 'all' || card.kind === kindFilter)
      && costMatches(card));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, visibleDeckCards, visibleCards, searching, activeTab, kindFilter, costFilter]);
  const previewSource = shownCards;

  const pageCount = Math.max(1, Math.ceil(shownCards.length / PAGE_SIZE));
  const pageIndex = Math.min(page, pageCount - 1);
  const pageCards = shownCards.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE);
  useEffect(() => { setPage(0); }, [activeTab, kindFilter, costFilter, search, sortBy, source]);

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
    setDirty(true);
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
    setDirty(true);
    setCounts(prev => ({ ...prev, [card.id]: n }));
  };

  const adjustEffigy = (color, delta) => {
    setDirty(true);
    setEffigyCounts(prev => ({ ...prev, [color]: Math.max(0, (prev[color] || 0) + delta) }));
  };

  const setEffigyDirect = (color, value) => {
    const n = Math.max(0, Math.floor(Number(value)) || 0);
    setDirty(true);
    setEffigyCounts(prev => ({ ...prev, [color]: n }));
  };

  // Flattens {card,count} to the plain {name,count} shape precons.js and a
  // saved-deck record both store, so it round-trips through
  // resolveDeckEntries unchanged the next time this deck is picked or
  // edited — same shape buildDeckExport's own JSON export uses.
  const flatEntries = () => entries.map(({ card, count }) => ({ name: card.name, count }));

  const handleSaveNew = () => {
    const saved = saveDeck({ name: deckName, entries: flatEntries(), effigyCounts });
    setSaveStatus(`Saved to Library as "${saved.name}".`);
    justSavedRef.current = saved.id;
    setDirty(false);
    onSaveComplete?.(saved);
  };

  const handleUpdate = () => {
    const updated = updateDeck(seedDeck.sourceId, { name: deckName, entries: flatEntries(), effigyCounts });
    setSaveStatus(`Updated "${updated.name}" in the Library.`);
    justSavedRef.current = updated.id;
    setDirty(false);
    onSaveComplete?.(updated);
  };

  // Saves what's currently on screen (including unsaved edits) as a separate
  // deck named "<name> (copy)" and opens that copy; the original is untouched.
  const handleDuplicate = () => {
    const copy = saveDeck({ name: nextCopyName(deckName), entries: flatEntries(), effigyCounts });
    setSaveStatus(`Duplicated as "${copy.name}".`);
    justSavedRef.current = copy.id;
    setDirty(false);
    onSaveComplete?.(copy);
  };

  if (eligible.length === 0) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-black p-8 short:p-2">
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

  // -- Card book helpers ---------------------------------------------------

  const deckRows = [...entries].sort((a, b) => totalCastingCost(a.card) - totalCastingCost(b.card) || a.card.name.localeCompare(b.card.name));
  const effigyRows = EFFIGY_COLORS.filter(color => (effigyCounts[color] || 0) > 0);

  const showHover = (e, type, key) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover({ type, key, top: r.top + r.height / 2 });
  };
  const hoverCard = hover?.type === 'card' ? entries.find(en => en.card.id === hover.key)?.card ?? eligible.find(c => c.id === hover.key) : null;
  const hoverEffigy = hover?.type === 'effigy' ? hover.key : null;

  // Cards and Effigy tiles can be dragged onto the deck panel to add a copy.
  const onDeckDrop = (e) => {
    e.preventDefault();
    setDropActive(false);
    const data = e.dataTransfer.getData('text/plain');
    if (data.startsWith('effigy:')) adjustEffigy(data.slice(7), 1);
    else if (data.startsWith('card:')) {
      const card = eligible.find(c => c.id === data.slice(5));
      if (card) adjust(card, 1);
    }
  };

  // Leaving the open deck (switching or starting a new one) asks first when
  // there are unsaved edits, so a stray click never throws work away.
  const switchDeck = (go) => {
    if (dirty && !window.confirm('Discard the unsaved changes to this deck?')) return;
    go();
  };

  // Dragging a deck row (card or Effigy) anywhere outside the deck panel
  // removes one copy. The payload carries a custom type so ordinary drags
  // (adding a card) are never mistaken for it.
  const REMOVE_TYPE = 'application/x-deck-remove';
  const startRemoveDrag = (e, payload) => {
    e.dataTransfer.setData('text/plain', payload);
    e.dataTransfer.setData(REMOVE_TYPE, '1');
    e.dataTransfer.effectAllowed = 'move';
    setHover(null);
    setRemoveDrag(true);
  };
  const isRemoveDrag = (e) => Array.from(e.dataTransfer.types || []).includes(REMOVE_TYPE);
  const onPageDrop = (e) => {
    if (!isRemoveDrag(e)) return;
    e.preventDefault();
    setRemoveDrag(false);
    if (deckPanelRef.current?.contains(e.target)) return; // dropped back on the deck: no change
    const data = e.dataTransfer.getData('text/plain');
    if (data.startsWith('remove-effigy:')) adjustEffigy(data.slice(14), -1);
    else if (data.startsWith('remove-card:')) {
      const card = eligible.find(c => c.id === data.slice(12));
      if (card) adjust(card, -1);
    }
  };

  const pageArrow = (dir) => {
    const disabled = dir < 0 ? pageIndex === 0 : pageIndex >= pageCount - 1;
    return (
      <button
        key={dir}
        onClick={() => setPage(pageIndex + dir)}
        disabled={disabled}
        aria-label={dir < 0 ? 'Previous page' : 'Next page'}
        className={`absolute top-1/2 -translate-y-1/2 ${dir < 0 ? 'left-0' : 'right-0'} p-0.5 transition-opacity disabled:opacity-25`}
      >
        <svg viewBox="0 0 30 44" width="34" height="50" aria-hidden="true">
          {dir < 0 ? (
            <>
              <polygon points="3,22 27,3 27,41" fill="#141414" stroke="#d6d6d6" strokeWidth="1.8" />
              <line x1="5" y1="22" x2="27" y2="22" stroke="#ececec" strokeWidth="2.4" strokeLinecap="round" />
              <line x1="27" y1="1" x2="27" y2="43" stroke="#d6d6d6" strokeWidth="2" />
            </>
          ) : (
            <>
              <polygon points="27,22 3,3 3,41" fill="#141414" stroke="#d6d6d6" strokeWidth="1.8" />
              <line x1="25" y1="22" x2="3" y2="22" stroke="#ececec" strokeWidth="2.4" strokeLinecap="round" />
              <line x1="3" y1="1" x2="3" y2="43" stroke="#d6d6d6" strokeWidth="2" />
            </>
          )}
        </svg>
      </button>
    );
  };

  const toggleBtn = (active, onClick, label) => (
    <button
      onClick={onClick}
      className={`${CHIP} ${active ? 'bg-[#393938] text-white' : 'bg-white/60 text-stone-800 hover:bg-white/90'}`}
    >
      {label}
    </button>
  );

  const copyDots = (card, count) => {
    const limit = card.isDeity ? MAX_DEITY_COPIES : MAX_COPIES;
    return (
      <div className="mt-1.5 flex gap-1 border-2 border-black rounded-md px-2.5 py-0.5 bg-white/60" aria-label={`${count} of ${limit} copies`}>
        {Array.from({ length: limit }, (_, i) => (
          <span key={i} className="w-2.5 h-2.5 rounded-full border-[1.5px] border-black" style={{ background: i < count ? EFFIGY_TYPE_COLORS[cardTypingTab(card)] : 'transparent' }} />
        ))}
      </div>
    );
  };

  const gem = (color, text) => (
    <span
      className="w-[22px] h-[22px] rounded-full border-2 border-black/60 text-xs font-bold flex items-center justify-center shrink-0"
      style={{ background: EFFIGY_TYPE_COLORS[color] || '#999', color: GEM_TEXT(color) }}
    >
      {text}
    </span>
  );

  const rowClass = 'flex items-center gap-1.5 px-1.5 py-1 mb-0.5 border-2 border-black rounded-md bg-white/60 hover:bg-white/90 cursor-pointer text-sm select-none';

  return (
    <div
      className="min-h-dvh p-3 sm:p-4 short:p-2"
      style={{ background: PAGE_BG, fontFamily: 'Georgia, serif' }}
      onDragOver={(e) => { if (isRemoveDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
      onDrop={onPageDrop}
    >
      <div className="max-w-[1500px] mx-auto">
        <div className="flex items-center gap-4 mb-2">
          <button onClick={libraryDecks ? () => switchDeck(onBack) : onBack} className="text-sm text-stone-300 hover:text-white">{libraryDecks ? '← Decks' : '← Menu'}</button>
          {onDesignCards && <button onClick={onDesignCards} className="text-sm text-stone-300 hover:text-white">Design Cards</button>}
        </div>

        <div className="grid lg:grid-cols-[minmax(0,1fr)_280px] gap-4 items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-end gap-1.5 pl-3 relative z-10" role="tablist" aria-label="Card typing">
              {[...TYPING_TABS, 'effigy'].map(tab => {
                const active = activeTab === tab;
                return (
                  <button
                    key={tab}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setActiveTab(tab)}
                    className={`px-3 sm:px-4 text-sm sm:text-[15px] font-bold border-[3px] border-black border-b-0 rounded-t-[10px] capitalize ${active ? 'pt-3 pb-3 -mb-[6px]' : 'mt-2 pt-2 pb-3 brightness-[.82]'}`}
                    style={{ background: LINEN_BG, color: tab === 'effigy' ? EFFIGY_TAB_COLOR : EFFIGY_TYPE_COLORS[tab], textShadow: TEXT_OUTLINE }}
                  >
                    {tab}
                  </button>
                );
              })}
            </div>

            <div className={`border-[6px] border-black rounded-md p-3 sm:p-4 ${removeDrag ? 'outline outline-[3px] outline-dashed outline-red-700 -outline-offset-[12px]' : ''}`} style={{ background: LINEN_BG }}>
              {activeTab !== 'effigy' && (
                <>
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <div className="flex gap-1.5" role="group" aria-label="Which cards to show">
                      {toggleBtn(source === 'library', () => setSource('library'), 'Library')}
                      {toggleBtn(source === 'deck', () => setSource('deck'), `Deck (${mainTotal})`)}
                    </div>
                    <div className="flex gap-1.5" role="group" aria-label="Card layout">
                      {toggleBtn(layout === 'visual', () => setLayout('visual'), 'Visual')}
                      {toggleBtn(layout === 'list', () => setLayout('list'), 'List')}
                    </div>
                    <div className="flex flex-wrap gap-1.5 ml-auto" role="group" aria-label="Card type">
                      {toggleBtn(kindFilter === 'all', () => setKindFilter('all'), 'All')}
                      {kindsPresent.map(k => toggleBtn(kindFilter === k, () => setKindFilter(k), KIND_LABELS[k]))}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 mb-3">
                    <div className="relative flex-1 min-w-[180px]">
                      <Search className="w-3.5 h-3.5 text-stone-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder='Search by name, text, or rarity… or "Strength=2:Cost<3"'
                        className="w-full pl-8 pr-3 py-1.5 text-sm border-2 border-black rounded-lg bg-white/70 focus:outline-none focus:bg-white"
                      />
                    </div>
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value)}
                      className="text-sm border-2 border-black rounded-lg px-2 py-1.5 bg-white/70 focus:outline-none"
                    >
                      <option value="none">Sort…</option>
                      <option value="name">Name (A–Z)</option>
                      <option value="effigyType">Effigy Type</option>
                      <option value="cost">Cost (low–high)</option>
                    </select>
                    <div className="flex gap-1" role="group" aria-label="Cost">
                      {COST_FILTERS.map(c => (
                        <button
                          key={c}
                          onClick={() => setCostFilter(c)}
                          aria-label={c === 'all' ? 'Any cost' : `Cost ${c}`}
                          className={`min-w-[26px] h-[26px] px-1 rounded-full border-2 border-black text-xs font-bold ${costFilter === c ? 'bg-[#393938] text-white' : 'bg-white/60 text-stone-800 hover:bg-white/90'}`}
                        >
                          {c === 'all' ? 'All' : c}
                        </button>
                      ))}
                    </div>
                  </div>

                  {importWarnings.length > 0 && (
                    <ul className="mb-3 text-xs text-amber-900 bg-amber-100 border-2 border-amber-700 rounded p-2 list-disc pl-4 space-y-0.5">
                      {importWarnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  )}

                  {shownCards.length === 0 ? (
                    <p className="text-sm text-stone-700 py-8 text-center">
                      {source === 'deck' && entries.length === 0
                        ? 'Your deck is empty — switch to Library to add cards.'
                        : searching
                          ? `No cards match "${search}".`
                          : 'No cards here — try another tab or filter.'}
                    </p>
                  ) : layout === 'list' ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[34rem] overflow-y-auto pr-1">
                      {shownCards.map(card => {
                        const count = counts[card.id] || 0;
                        const limit = card.isDeity ? MAX_DEITY_COPIES : MAX_COPIES;
                        return (
                          <div key={card.id} className="flex items-center justify-between border-2 border-black rounded-md bg-white/60 px-3 py-2">
                            <button onClick={() => openPreview(card)} className="min-w-0 text-left hover:opacity-70 transition-opacity">
                              <div className="text-sm font-medium text-stone-900 truncate">{card.name}</div>
                              <div className="text-xs text-stone-600 capitalize flex items-center gap-1 flex-wrap">
                                <span>{card.kind} · Cost</span>
                                <CostPips card={card} />
                                <span>· Str {card.strength} / Life {card.lifespan}</span>
                              </div>
                            </button>
                            <div className="flex items-center gap-2 shrink-0">
                              <button onClick={() => adjust(card, -1)} className={EFF_STEP} aria-label={`Remove one copy of ${card.name}`}>
                                <Minus className={STEP_ICON} />
                              </button>
                              <input
                                type="number"
                                min="0"
                                max={limit}
                                value={count}
                                onChange={(e) => setCountDirect(card, e.target.value)}
                                className={STEP_INPUT}
                              />
                              <button onClick={() => adjust(card, 1)} disabled={count >= limit} className={`${EFF_STEP} disabled:opacity-30`} aria-label={`Add a copy of ${card.name}`}>
                                <Plus className={STEP_ICON} />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <>
                      <div className="relative px-10 sm:px-14">
                        {pageArrow(-1)}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-4">
                          {pageCards.map(card => {
                            const count = counts[card.id] || 0;
                            return (
                              <div key={card.id} className="flex flex-col items-center">
                                <div
                                  draggable
                                  onDragStart={(e) => { e.dataTransfer.setData('text/plain', `card:${card.id}`); e.dataTransfer.effectAllowed = 'copy'; }}
                                  onClick={() => adjust(card, 1)}
                                  onContextMenu={(e) => { e.preventDefault(); adjust(card, -1); }}
                                  className="group relative w-full cursor-grab active:cursor-grabbing hover:-translate-y-1 transition-transform"
                                  title="Click or drag to add · right-click to remove one"
                                >
                                  <CardThumbnail card={card} borderImages={borderImages} borderImagesLoaded={borderImagesLoaded} artImages={artImages} artBorderImages={artBorderImages} artImagesLoaded={artImagesLoaded} fontLoaded={fontLoaded} width={360} height={504} />
                                  <button
                                    onClick={(e) => { e.stopPropagation(); openPreview(card); }}
                                    aria-label={`Inspect ${card.name}`}
                                    className="absolute top-1.5 right-1.5 p-1.5 rounded-full bg-black/70 text-white opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity"
                                  >
                                    <Search className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                                {copyDots(card, count)}
                              </div>
                            );
                          })}
                        </div>
                        {pageArrow(1)}
                      </div>
                      <div className="text-center text-sm text-stone-800 mt-3">Page {pageIndex + 1} of {pageCount}</div>
                    </>
                  )}
                </>
              )}

              {activeTab === 'effigy' && (
                <div className="flex flex-wrap justify-center gap-x-5 gap-y-5 py-2">
                  {EFFIGY_COLORS.map(color => (
                    <div key={color} className="flex flex-col items-center gap-2 w-[calc((100%-2.5rem)/3)] min-w-[130px] max-w-[270px]">
                      <div
                        draggable
                        onDragStart={(e) => { e.dataTransfer.setData('text/plain', `effigy:${color}`); e.dataTransfer.effectAllowed = 'copy'; }}
                        onClick={() => adjustEffigy(color, 1)}
                        onContextMenu={(e) => { e.preventDefault(); adjustEffigy(color, -1); }}
                        className="w-full cursor-grab active:cursor-grabbing hover:-translate-y-1 transition-transform"
                        title="Click or drag to add · right-click to remove one"
                      >
                        <EffigyCardCanvas color={color} borderImages={borderImages} borderImagesLoaded={borderImagesLoaded} fontLoaded={fontLoaded} />
                      </div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => adjustEffigy(color, -1)} className={EFF_STEP} aria-label={`Remove one ${EFFIGY_LABELS[color]} Effigy`}>
                          <Minus className={STEP_ICON} />
                        </button>
                        <input
                          type="number"
                          min="0"
                          value={effigyCounts[color] || 0}
                          onChange={(e) => setEffigyDirect(color, e.target.value)}
                          className={`${STEP_INPUT} bg-white/70 border-2 border-black font-bold`}
                          aria-label={`${EFFIGY_LABELS[color]} Effigy count`}
                        />
                        <button onClick={() => adjustEffigy(color, 1)} className={EFF_STEP} aria-label={`Add one ${EFFIGY_LABELS[color]} Effigy`}>
                          <Plus className={STEP_ICON} />
                        </button>
                      </div>
                    </div>
                  ))}
                  <p className="w-full text-center text-sm text-stone-800 mt-1">
                    <b className="text-lg">{effigyTotal} / {EFFIGY_DECK_SIZE}</b> Effigies in your Effigy Deck
                  </p>
                </div>
              )}
            </div>
          </div>

          <aside
            ref={deckPanelRef}
            onDragOver={(e) => { if (isRemoveDrag(e)) { e.stopPropagation(); return; } e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropActive(true); }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropActive(false); }}
            onDrop={onDeckDrop}
            className={`border-[6px] border-black rounded-md p-3 lg:mt-[44px] flex flex-col ${dropActive ? 'outline outline-[3px] outline-dashed outline-[#B84FC2] -outline-offset-[12px]' : ''}`}
            style={{ background: LINEN_BG }}
          >
            {libraryDecks && (
              <div className="mb-3">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-bold text-stone-900">Decks</span>
                  <button
                    onClick={() => switchDeck(onNewDeck)}
                    className="inline-flex items-center gap-1 px-2.5 py-0.5 border-2 border-black rounded-full text-xs font-bold bg-white/60 hover:bg-white/90"
                  >
                    <Plus className="w-3 h-3" />
                    New
                  </button>
                </div>
                <div className="max-h-44 overflow-y-auto pr-0.5">
                  {libraryDecks.map(deck => {
                    const { Icon } = deck;
                    const current = seedDeck?.sourceId === deck.id;
                    return (
                      <div
                        key={deck.id}
                        className={`${rowClass} ${current ? '!bg-white ring-2 ring-[#393938]' : ''}`}
                        onClick={() => { if (!current) switchDeck(() => onSelectDeck(deck)); }}
                        title={deck.tagline}
                      >
                        <span className="w-[22px] h-[22px] rounded-full border-2 border-black/60 flex items-center justify-center shrink-0" style={{ background: `${deck.accentColor}55` }}>
                          <Icon className="w-3 h-3" style={{ color: deck.accentColor }} />
                        </span>
                        <span className="flex-1 min-w-0 truncate">{deck.name}</span>
                        {deck.source === 'saved' && onRemoveDeck && (
                          <button
                            onClick={(e) => { e.stopPropagation(); onRemoveDeck(deck); }}
                            className="p-0.5 rounded-full hover:bg-rose-200"
                            aria-label={`Remove ${deck.name}`}
                            title="Remove from Library"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="border-t-[3px] border-[#393938] mt-3" />
              </div>
            )}
            <input
              type="text"
              value={deckName}
              onChange={(e) => { setDeckName(e.target.value); setSaveStatus(''); setDirty(true); }}
              placeholder="Name this deck…"
              aria-label="Deck name"
              className="w-full text-center text-lg text-white bg-[#393938] placeholder:text-stone-400 rounded-lg px-2 py-2 mb-2.5 focus:outline-none focus:ring-2 focus:ring-white/40"
            />

            {deckRows.length === 0 && <p className="text-sm text-stone-700 text-center py-3">Click or drag cards into your deck.</p>}
            {deckRows.map(({ card, count }) => (
              <div
                key={card.id}
                className={rowClass}
                draggable
                onDragStart={(e) => startRemoveDrag(e, `remove-card:${card.id}`)}
                onDragEnd={() => setRemoveDrag(false)}
                onMouseEnter={coarse ? undefined : (e) => showHover(e, 'card', card.id)}
                onMouseLeave={coarse ? undefined : () => setHover(null)}
                onClick={(e) => {
                  if (coarse) { if (hover?.key === card.id) setHover(null); else showHover(e, 'card', card.id); }
                  else { adjust(card, -1); if (count <= 1) setHover(null); }
                }}
                title={coarse ? 'Tap to preview' : 'Click, or drag out of the deck, to remove one'}
              >
                {gem(cardTypingTab(card), totalCastingCost(card))}
                <span className="flex-1 min-w-0 truncate">{card.name}</span>
                <span className="font-bold text-stone-700">x{count}</span>
                {coarse && (
                  <button
                    onClick={(e) => { e.stopPropagation(); adjust(card, -1); if (count <= 1) setHover(null); }}
                    className="p-1 rounded-full border-2 border-black bg-white/70"
                    aria-label={`Remove one copy of ${card.name}`}
                  >
                    <Minus className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}

            <div className="h-2 rounded bg-black/30 overflow-hidden mt-3">
              <div className={`h-full ${mainTotal === MAIN_DECK_SIZE ? 'bg-emerald-500' : mainTotal > MAIN_DECK_SIZE ? 'bg-red-500' : 'bg-amber-400'}`} style={{ width: `${Math.min(100, (mainTotal / MAIN_DECK_SIZE) * 100)}%` }} />
            </div>
            <div className="text-xs text-stone-800 mt-1">{mainTotal} / {MAIN_DECK_SIZE} cards</div>
            {mainErrors.length > 0 && (
              <ul className="mt-1.5 text-xs text-red-800 list-disc pl-4">
                {mainErrors.map(err => <li key={err}>{err}</li>)}
              </ul>
            )}

            <div className="mt-3.5 pt-2 border-t-[3px] border-[#393938]">
              <div className={`flex justify-between text-sm font-bold mb-1.5 ${effigyErrors.length > 0 ? 'text-red-800' : 'text-stone-900'}`}>
                <span>Effigy Deck</span>
                <span>{effigyTotal} / {EFFIGY_DECK_SIZE}</span>
              </div>
              {effigyRows.length === 0 && <p className="text-xs text-stone-700 mb-1">Add Effigies on the Effigy tab.</p>}
              {effigyRows.map(color => (
                <div
                  key={color}
                  className={rowClass}
                  draggable
                  onDragStart={(e) => startRemoveDrag(e, `remove-effigy:${color}`)}
                  onDragEnd={() => setRemoveDrag(false)}
                  onMouseEnter={coarse ? undefined : (e) => showHover(e, 'effigy', color)}
                  onMouseLeave={coarse ? undefined : () => setHover(null)}
                  onClick={(e) => {
                    if (coarse) { if (hover?.key === color) setHover(null); else showHover(e, 'effigy', color); }
                    else { adjustEffigy(color, -1); if ((effigyCounts[color] || 0) <= 1) setHover(null); }
                  }}
                  title={coarse ? 'Tap to preview' : 'Click, or drag out of the deck, to remove one'}
                >
                  {gem(color, 1)}
                  <span className="flex-1 min-w-0 truncate">{EFFIGY_LABELS[color]} Effigy</span>
                  <span className="font-bold text-stone-700">x{effigyCounts[color]}</span>
                  {coarse && (
                    <button
                      onClick={(e) => { e.stopPropagation(); adjustEffigy(color, -1); if ((effigyCounts[color] || 0) <= 1) setHover(null); }}
                      className="p-1 rounded-full border-2 border-black bg-white/70"
                      aria-label={`Remove one ${EFFIGY_LABELS[color]} Effigy`}
                    >
                      <Minus className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {effigyErrors.length > 0 && (
                <ul className="mt-1.5 text-xs text-red-800 list-disc pl-4">
                  {effigyErrors.map(err => <li key={err}>{err}</li>)}
                </ul>
              )}
            </div>

            <div className="mt-3.5 flex flex-col gap-2">
              {!canStart && <p className="text-xs text-stone-700">Fix the errors above before saving.</p>}
              {seedDeck?.source === 'saved' ? (
                <>
                  <button
                    onClick={handleUpdate}
                    disabled={!canStart}
                    className="inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-[#393938] text-white rounded-lg text-sm font-bold disabled:opacity-30"
                  >
                    <Save className="w-3.5 h-3.5" />
                    Update
                  </button>
                  <button
                    onClick={handleSaveNew}
                    disabled={!canStart}
                    className="px-4 py-2 border-2 border-black bg-white/60 rounded-lg text-sm font-bold text-stone-800 disabled:opacity-30"
                  >
                    Save As New
                  </button>
                </>
              ) : (
                <button
                  onClick={handleSaveNew}
                  disabled={!canStart}
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-[#393938] text-white rounded-lg text-sm font-bold disabled:opacity-30"
                >
                  <Save className="w-3.5 h-3.5" />
                  Save to Library
                </button>
              )}
              {libraryDecks && entries.length > 0 && (
                <button
                  onClick={handleDuplicate}
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-2 border-2 border-black bg-white/60 hover:bg-white/90 rounded-lg text-sm font-bold text-stone-800"
                >
                  <Copy className="w-3.5 h-3.5" />
                  Duplicate Deck
                </button>
              )}
              {saveStatus && <p className="text-xs text-emerald-900">{saveStatus}</p>}
              <div className="flex gap-2">
                <label className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 border-2 border-black bg-white/60 hover:bg-white/90 rounded-lg text-xs font-bold text-stone-800 cursor-pointer transition-colors">
                  <Upload className="w-3.5 h-3.5" />
                  Import
                  <input type="file" accept=".json,.txt" onChange={importDeckList} className="hidden" />
                </label>
                <button
                  onClick={exportDeckList}
                  disabled={entries.length === 0}
                  className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 border-2 border-black bg-white/60 hover:bg-white/90 rounded-lg text-xs font-bold text-stone-800 transition-colors disabled:opacity-40"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export
                </button>
              </div>
              {onStart && (
                <button
                  onClick={() => onStart({ entries, effigyCounts })}
                  disabled={!canStart}
                  className="w-full py-3 bg-[#393938] text-white rounded-lg font-bold disabled:opacity-30"
                >
                  Start Match vs. AI
                </button>
              )}
            </div>
          </aside>
        </div>
      </div>

      {coarse && hover && <div className="fixed inset-0 z-[65]" onClick={() => setHover(null)} />}
      {hover && (hoverCard || hoverEffigy) && (() => {
        const w = Math.min(340, Math.round(window.innerWidth * 0.42));
        const h = Math.round(w * 7 / 5);
        const panel = deckPanelRef.current?.getBoundingClientRect();
        let left = (panel ? panel.left : window.innerWidth) - w - 16;
        if (left < 8) left = 8;
        const top = Math.max(8, Math.min(hover.top - h / 2, window.innerHeight - h - 8));
        return (
          <div className="fixed z-[70] pointer-events-none" style={{ left, top, width: w }}>
            <div className="rounded-[14px] overflow-hidden border-4 border-black shadow-2xl bg-black">
              {hoverCard ? (
                <CardThumbnail card={hoverCard} borderImages={borderImages} borderImagesLoaded={borderImagesLoaded} artImages={artImages} artBorderImages={artBorderImages} artImagesLoaded={artImagesLoaded} fontLoaded={fontLoaded} width={480} height={672} />
              ) : (
                <EffigyCardCanvas color={hoverEffigy} borderImages={borderImages} borderImagesLoaded={borderImagesLoaded} fontLoaded={fontLoaded} />
              )}
            </div>
          </div>
        );
      })()}

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
                  className="max-w-full max-h-[65dvh] w-auto h-auto border border-stone-300 mx-auto block"
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
                  className="p-2 [@media(pointer:coarse)]:p-3 rounded-full bg-stone-200 hover:bg-stone-300 disabled:opacity-30 transition-colors"
                  aria-label={`Remove one copy of ${card.name}`}
                >
                  <Minus className="w-4 h-4 [@media(pointer:coarse)]:w-5 [@media(pointer:coarse)]:h-5" />
                </button>
                <span className="text-sm font-medium text-stone-700 w-16 text-center">{count} / {limit}</span>
                <button
                  onClick={() => adjust(card, 1)}
                  disabled={count >= limit}
                  className="p-2 [@media(pointer:coarse)]:p-3 rounded-full bg-stone-200 hover:bg-stone-300 disabled:opacity-30 transition-colors"
                  aria-label={`Add a copy of ${card.name}`}
                >
                  <Plus className="w-4 h-4 [@media(pointer:coarse)]:w-5 [@media(pointer:coarse)]:h-5" />
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
