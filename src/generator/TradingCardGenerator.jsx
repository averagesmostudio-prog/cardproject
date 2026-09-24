import React, { useState, useRef, useEffect } from 'react';
import { Upload, Download, ChevronLeft, ChevronRight, ChevronDown, Settings2, LayoutGrid, Search, Plus, Minus, Trash2, X, Lock } from 'lucide-react';
import { getColumnData, BORDER_IMAGE_SRC, BORDER_STYLES, getBorderTypeForCard, getCardKind, parseEffigyCost, parseCSV as sharedParseCSV, resolveCardArt } from '../lib/cardData.js';
import { buildDeckExport, parseDeckImport } from '../lib/deckExport.js';
import { getActiveCsvText, CSV_PASSCODE } from '../lib/csvSource.js';
import {
  CARD_PX_WIDTH, CARD_PX_HEIGHT, ONBOARD_CARD_PX_WIDTH, ONBOARD_CARD_PX_HEIGHT, MPC_PX_WIDTH, MPC_PX_HEIGHT, DEFAULT_POSITIONS,
  renderCardOnCanvas, renderCardWithBleed, SHEET_COLS, SHEET_ROWS, CARDS_PER_SHEET, pngBlobWithDpi,
} from '../lib/cardRender.js';
import { useCardFont, useBorderImages, useCardArtImages } from '../lib/useCardAssets.js';

const TradingCardGenerator = () => {
  const [csvData, setCsvData] = useState([]);
  const [currentCard, setCurrentCard] = useState(0);
  const [cardSearch, setCardSearch] = useState('');
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [showSearchPanel, setShowSearchPanel] = useState(false);
  const [searchViewMode, setSearchViewMode] = useState('visual');
  const [searchSortBy, setSearchSortBy] = useState('none');
  const [searchThumbnails, setSearchThumbnails] = useState({});
  const [searchPreviewIndex, setSearchPreviewIndex] = useState(null);
  const searchPreviewCanvasRef = useRef(null);
  const [deckPreviewIndex, setDeckPreviewIndex] = useState(null);
  const deckPreviewCanvasRef = useRef(null);
  const [showPositioning, setShowPositioning] = useState(false);
  const [borderStyle, setBorderStyle] = useState('default');
  // Gates Build's own CSV upload box behind the same passcode as the Landing
  // Settings panel — otherwise it was an unlocked back door around that lock.
  const [csvUploadUnlocked, setCsvUploadUnlocked] = useState(false);
  const [csvUploadPasscode, setCsvUploadPasscode] = useState('');
  const [csvUploadError, setCsvUploadError] = useState('');
  const fontLoaded = useCardFont();
  const canvasRef = useRef(null);

  // Built-in border art (see BORDER_IMAGE_SRC) — loaded once on mount so no
  // manual template upload is needed.
  const { borderImages: borderImageRefs, loaded: borderImagesLoaded } = useBorderImages();
  // Per-card illustration art (see cardData.js's CARD_ART_SRC) — Dendrify is
  // the first and only entry right now; every other card's pickTemplateImage
  // call below falls through to the plain border image exactly as before.
  const { artImages, artBorderImages, loaded: artImagesLoaded } = useCardArtImages();

  const [positions, setPositions] = useState({
    ...DEFAULT_POSITIONS
  });

  // The On Board / On Board Border styles both render at their own
  // (shorter, near-square) shape instead of the standard trim size — see
  // ONBOARD_CARD_PX_* for why. They share the exact same border art/shape;
  // 'onboardStats' (cardData.js > BORDER_STYLES) only changes which stat
  // values cardRender.js draws into it.
  const isOnboardShape = borderStyle === 'onboard' || borderStyle === 'onboardStats';
  const cardWidth = isOnboardShape ? ONBOARD_CARD_PX_WIDTH : CARD_PX_WIDTH;
  const cardHeight = isOnboardShape ? ONBOARD_CARD_PX_HEIGHT : CARD_PX_HEIGHT;
  const thumbWidth = 180;
  const thumbHeight = Math.round(thumbWidth * (cardHeight / cardWidth));

  const submitCsvUploadPasscode = (e) => {
    e.preventDefault();
    if (csvUploadPasscode === CSV_PASSCODE) {
      setCsvUploadUnlocked(true);
      setCsvUploadError('');
    } else {
      setCsvUploadError('Incorrect passcode.');
    }
  };

  const handleCSVUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target.result;
        parseCSV(text);
      };
      reader.readAsText(file);
    }
  };

  const parseCSV = (text) => {
    setCsvData(sharedParseCSV(text));
    setCurrentCard(0);
  };

  // Auto-load the working card set (the bundled default, or a custom one set
  // via Settings) so it doesn't need to be re-uploaded by hand every time.
  useEffect(() => {
    getActiveCsvText().then(text => { if (text) parseCSV(text); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickTemplateImage = (card) => {
    const art = resolveCardArt(card, borderStyle, artImages, artBorderImages, artImagesLoaded);
    if (art) {
      return { img: art.artBorderImg, loaded: true, artImg: art.artImg, artBoxRect: art.artBoxRect };
    }
    const key = getBorderTypeForCard(card, borderStyle);
    return { img: borderImageRefs.current[key], loaded: !!borderImagesLoaded[key] };
  };

  useEffect(() => {
    if (!fontLoaded) return;
    if (csvData.length === 0) return;

    const card = csvData[currentCard];
    if (!card) return;

    const { img, loaded, artImg, artBoxRect } = pickTemplateImage(card);
    if (!img || !loaded) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    renderCardOnCanvas(canvas, card, img, positions, cardWidth, cardHeight, borderStyle, artImg, artBoxRect);
  }, [borderImagesLoaded, artImagesLoaded, csvData, currentCard, positions, fontLoaded, showSearchPanel, borderStyle]);

  const [previewUrl, setPreviewUrl] = useState(null);
  const [isExportingAll, setIsExportingAll] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  const downloadCard = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const card = csvData[currentCard];
    const filename = (card && card['Card Name']) || `card_${currentCard + 1}`;
    const blob = await pngBlobWithDpi(canvas);
    const url = URL.createObjectURL(blob);
    setPreviewUrl(url);
    const link = document.createElement('a');
    link.download = `${filename}.png`;
    link.href = url;
    link.click();
  };

  const downloadCardMPC = async () => {
    const card = csvData[currentCard];
    if (!card) return;
    const { img, loaded, artImg, artBoxRect } = pickTemplateImage(card);
    if (!img || !loaded) return;

    const cardCanvas = document.createElement('canvas');
    renderCardWithBleed(cardCanvas, card, img, positions, cardWidth, cardHeight, MPC_PX_WIDTH, MPC_PX_HEIGHT, borderStyle, artImg, artBoxRect);

    const filename = card['Card Name'] || `card_${currentCard + 1}`;
    const blob = await pngBlobWithDpi(cardCanvas);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `${filename}.png`;
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const downloadAll = async () => {
    setIsExportingAll(true);
    setExportProgress(0);
    for (let i = 0; i < csvData.length; i++) {
      setCurrentCard(i);
      await new Promise(resolve => setTimeout(resolve, 200));
      const canvas = canvasRef.current;
      const card = csvData[i];
      const filename = card['Card Name'] || `card_${i + 1}`;
      const blob = await pngBlobWithDpi(canvas);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `${filename}.png`;
      link.href = url;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setExportProgress(i + 1);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    setIsExportingAll(false);
  };

  const [isExportingMPC, setIsExportingMPC] = useState(false);
  const [mpcProgress, setMpcProgress] = useState(0);

  const downloadAllMPC = async () => {
    setIsExportingMPC(true);
    setMpcProgress(0);
    const cardCanvas = document.createElement('canvas');
    for (let i = 0; i < csvData.length; i++) {
      const card = csvData[i];
      const { img, loaded, artImg, artBoxRect } = pickTemplateImage(card);
      if (img && loaded) {
        renderCardWithBleed(cardCanvas, card, img, positions, cardWidth, cardHeight, MPC_PX_WIDTH, MPC_PX_HEIGHT, borderStyle, artImg, artBoxRect);
        const filename = card['Card Name'] || `card_${i + 1}`;
        const blob = await pngBlobWithDpi(cardCanvas);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `${filename}.png`;
        link.href = url;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
      setMpcProgress(i + 1);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    setIsExportingMPC(false);
  };

  const [isExportingSheets, setIsExportingSheets] = useState(false);
  const [sheetProgress, setSheetProgress] = useState(0);
  const totalSheets = Math.ceil(csvData.length / CARDS_PER_SHEET);

  const downloadPrintSheets = async () => {
    if (!Object.keys(BORDER_IMAGE_SRC).every(key => borderImagesLoaded[key])) return;

    const cardW = cardWidth;
    const cardH = cardHeight;

    setIsExportingSheets(true);
    setSheetProgress(0);

    const cardCanvas = document.createElement('canvas');

    for (let page = 0; page < totalSheets; page++) {
      const pageCanvas = document.createElement('canvas');
      pageCanvas.width = cardW * SHEET_COLS;
      pageCanvas.height = cardH * SHEET_ROWS;
      const pctx = pageCanvas.getContext('2d');
      pctx.fillStyle = '#ffffff';
      pctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);

      for (let slot = 0; slot < CARDS_PER_SHEET; slot++) {
        const cardIndex = page * CARDS_PER_SHEET + slot;
        if (cardIndex >= csvData.length) break;

        const card = csvData[cardIndex];
        const { img, loaded, artImg, artBoxRect } = pickTemplateImage(card);
        if (!img || !loaded) continue;

        renderCardOnCanvas(cardCanvas, card, img, positions, cardWidth, cardHeight, borderStyle, artImg, artBoxRect);

        const col = slot % SHEET_COLS;
        const row = Math.floor(slot / SHEET_COLS);
        pctx.drawImage(cardCanvas, col * cardW, row * cardH, cardW, cardH);
      }

      const blob = await pngBlobWithDpi(pageCanvas);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `print_sheet_${page + 1}.png`;
      link.href = url;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      setSheetProgress(page + 1);
      await new Promise(resolve => setTimeout(resolve, 150));
    }

    setIsExportingSheets(false);
  };

  // Custom 40-card deck list: up to 3 copies of any unique card, built by
  // clicking "Add to Deck" while browsing. Previewable before download/print.
  const DECK_SIZE = 40;
  const MAX_COPIES = 3;
  const MAX_DEITY_COPIES = 2;
  const maxCopiesFor = (card) => (getCardKind(card) === 'deity' ? MAX_DEITY_COPIES : MAX_COPIES);
  const [deckList, setDeckList] = useState([]);
  const [showDeckList, setShowDeckList] = useState(false);
  const [deckViewMode, setDeckViewMode] = useState('list');
  const [deckSortBy, setDeckSortBy] = useState('none');
  const [deckThumbnails, setDeckThumbnails] = useState({});
  const deckTotal = deckList.reduce((sum, entry) => sum + entry.count, 0);

  const sortDeckEntries = (entries, sortBy) => {
    if (sortBy === 'none') return entries;
    const sorted = [...entries];
    const effigyTypeOf = (entry) => getColumnData(entry.card, ['Effigy type', 'Effigy Type']).toLowerCase();
    const costOf = (entry) => parseEffigyCost(entry.card['Effigy Costs'] || entry.card['effigy costs'] || entry.card['Effigy Cost'] || '')
      .reduce((sum, part) => sum + (part.number === 'X' ? 0 : parseInt(part.number, 10) || 0), 0);
    if (sortBy === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === 'effigyType') sorted.sort((a, b) => effigyTypeOf(a).localeCompare(effigyTypeOf(b)) || a.name.localeCompare(b.name));
    else if (sortBy === 'cost') sorted.sort((a, b) => costOf(a) - costOf(b) || a.name.localeCompare(b.name));
    return sorted;
  };
  const displayDeckList = sortDeckEntries(deckList, deckSortBy);
  const currentDeckEntry = csvData[currentCard]
    ? deckList.find(entry => entry.name === (csvData[currentCard]['Card Name'] || `Card ${currentCard + 1}`))
    : null;

  useEffect(() => {
    if (deckViewMode !== 'visual' || !fontLoaded || deckList.length === 0) return;
    const canvas = document.createElement('canvas');
    const next = {};
    deckList.forEach(entry => {
      const { img, loaded, artImg, artBoxRect } = pickTemplateImage(entry.card);
      if (img && loaded) {
        renderCardOnCanvas(canvas, entry.card, img, positions, thumbWidth, thumbHeight, borderStyle, artImg, artBoxRect);
        next[entry.name] = canvas.toDataURL('image/png');
      }
    });
    setDeckThumbnails(next);
  }, [deckViewMode, deckList, fontLoaded, positions, borderImagesLoaded, borderStyle]);

  const addToDeck = (explicitIdx) => {
    const idx = typeof explicitIdx === 'number' ? explicitIdx : currentCard;
    const card = csvData[idx];
    if (!card) return;
    const name = card['Card Name'] || `Card ${idx + 1}`;
    if (deckTotal >= DECK_SIZE) return;

    setDeckList(prev => {
      const idx = prev.findIndex(entry => entry.name === name);
      if (idx >= 0) {
        if (prev[idx].count >= maxCopiesFor(prev[idx].card)) return prev;
        const updated = [...prev];
        updated[idx] = { ...updated[idx], count: updated[idx].count + 1 };
        return updated;
      }
      return [...prev, { name, card, count: 1 }];
    });
  };

  const addCopyToDeck = (name) => {
    if (deckTotal >= DECK_SIZE) return;
    setDeckList(prev => {
      const idx = prev.findIndex(entry => entry.name === name);
      if (idx < 0 || prev[idx].count >= maxCopiesFor(prev[idx].card)) return prev;
      const updated = [...prev];
      updated[idx] = { ...updated[idx], count: updated[idx].count + 1 };
      return updated;
    });
  };

  const removeFromDeck = (name) => {
    setDeckList(prev => {
      const idx = prev.findIndex(entry => entry.name === name);
      if (idx < 0) return prev;
      const updated = [...prev];
      if (updated[idx].count > 1) {
        updated[idx] = { ...updated[idx], count: updated[idx].count - 1 };
      } else {
        updated.splice(idx, 1);
      }
      return updated;
    });
  };

  const setDeckCount = (name, value) => {
    setDeckList(prev => {
      const idx = prev.findIndex(entry => entry.name === name);
      if (idx < 0) return prev;
      const entry = prev[idx];
      const limit = maxCopiesFor(entry.card);
      const otherTotal = prev.reduce((sum, e, i) => (i === idx ? sum : sum + e.count), 0);
      const maxAllowed = Math.min(limit, DECK_SIZE - otherTotal);
      const n = Math.max(0, Math.min(maxAllowed, Math.floor(Number(value)) || 0));
      const updated = [...prev];
      if (n === 0) {
        updated.splice(idx, 1);
      } else {
        updated[idx] = { ...entry, count: n };
      }
      return updated;
    });
  };

  const clearDeck = () => setDeckList([]);

  // The counterpart to downloadDeckList/downloadDeckForGame below — loads a
  // decklist file (either format: plain "3x Card Name" lines, or the JSON
  // shape those produce) and replaces the Custom Deck with it, resolving
  // each name against the currently loaded CSV. Same parser and the same
  // clamp-and-warn behavior as the Game's own deckbuilder import.
  const [deckImportWarnings, setDeckImportWarnings] = useState([]);
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
        setDeckImportWarnings([err.message]);
        return;
      }

      const warnings = [];
      const nextDeck = [];
      let total = 0;
      parsed.forEach(({ name, count }) => {
        const found = csvData.find(c => (c['Card Name'] || '') === name)
          || csvData.find(c => (c['Card Name'] || '').toLowerCase() === name.toLowerCase());
        if (!found) {
          warnings.push(`"${name}" wasn't found in the loaded CSV — skipped.`);
          return;
        }
        const limit = maxCopiesFor(found);
        let clamped = Math.max(0, Math.min(limit, count));
        if (total + clamped > DECK_SIZE) clamped = Math.max(0, DECK_SIZE - total);
        if (clamped !== count) {
          const reason = clamped < Math.min(limit, count)
            ? `Main Deck size limit (${DECK_SIZE})`
            : `max ${limit}${getCardKind(found) === 'deity' ? ' for Deities' : ''}`;
          warnings.push(`"${name}": requested ${count}, capped at ${clamped} (${reason}).`);
        }
        if (clamped > 0) {
          nextDeck.push({ name: found['Card Name'] || name, card: found, count: clamped });
          total += clamped;
        }
      });

      if (nextDeck.length === 0 && warnings.length === 0) {
        warnings.push('That deck file has no cards in it.');
      }
      setDeckList(nextDeck);
      setDeckImportWarnings(warnings);
      setShowDeckList(true);
    };
    reader.readAsText(file);
  };

  const downloadDeckList = () => {
    const lines = deckList.map(entry => `${entry.count}x ${entry.name}`);
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = 'decklist.txt';
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  // Same deck, as a JSON file the Game's deckbuilder can import directly
  // (Play Game -> Import Deck List) instead of re-picking every card by hand.
  const downloadDeckForGame = () => {
    const data = buildDeckExport(deckList.map(entry => ({ name: entry.name, count: entry.count })));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = 'deck-for-game.json';
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const [isExportingDeckSheets, setIsExportingDeckSheets] = useState(false);
  const [deckSheetProgress, setDeckSheetProgress] = useState(0);
  const deckTotalSheets = Math.ceil(deckTotal / CARDS_PER_SHEET);

  const downloadDeckPrintSheets = async () => {
    const flatDeck = [];
    deckList.forEach(entry => {
      for (let i = 0; i < entry.count; i++) flatDeck.push(entry.card);
    });
    if (flatDeck.length === 0) return;

    setIsExportingDeckSheets(true);
    setDeckSheetProgress(0);

    const cardCanvas = document.createElement('canvas');
    const totalPages = Math.ceil(flatDeck.length / CARDS_PER_SHEET);

    for (let page = 0; page < totalPages; page++) {
      const pageCanvas = document.createElement('canvas');
      pageCanvas.width = cardWidth * SHEET_COLS;
      pageCanvas.height = cardHeight * SHEET_ROWS;
      const pctx = pageCanvas.getContext('2d');
      pctx.fillStyle = '#ffffff';
      pctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);

      for (let slot = 0; slot < CARDS_PER_SHEET; slot++) {
        const cardIndex = page * CARDS_PER_SHEET + slot;
        if (cardIndex >= flatDeck.length) break;

        const card = flatDeck[cardIndex];
        const { img, loaded, artImg, artBoxRect } = pickTemplateImage(card);
        if (!img || !loaded) continue;

        renderCardOnCanvas(cardCanvas, card, img, positions, cardWidth, cardHeight, borderStyle, artImg, artBoxRect);

        const col = slot % SHEET_COLS;
        const row = Math.floor(slot / SHEET_COLS);
        pctx.drawImage(cardCanvas, col * cardWidth, row * cardHeight, cardWidth, cardHeight);
      }

      const blob = await pngBlobWithDpi(pageCanvas);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `deck_sheet_${page + 1}.png`;
      link.href = url;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      setDeckSheetProgress(page + 1);
      await new Promise(resolve => setTimeout(resolve, 150));
    }

    setIsExportingDeckSheets(false);
  };

  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showDownloadMenu, setShowDownloadMenu] = useState(false);
  const exportMenuRef = useRef(null);
  const downloadMenuRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target)) setShowExportMenu(false);
      if (downloadMenuRef.current && !downloadMenuRef.current.contains(e.target)) setShowDownloadMenu(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Matches on card name, rules text, rarity, a turn-timer query like
  // "2 turn"/"2 turns" (matched against Timer), OR a casting-cost query like
  // "2 cost" (matched against Casting Cost) — so the search can find cards by
  // rarity, timer, or total cost, not just by name/text.
  const getSearchMatches = (query) => {
    if (!query.trim()) return [];
    const q = query.trim().toLowerCase();
    const turnMatch = q.match(/^(\d+)\s*turns?$/);
    const timerQuery = turnMatch ? turnMatch[1] : null;
    const costMatch = q.match(/^(\d+)\s*costs?$/);
    const costQuery = costMatch ? costMatch[1] : null;
    return csvData
      .map((card, idx) => ({
        idx,
        name: card['Card Name'] || `Card ${idx + 1}`,
        textBox: getColumnData(card, ['Text Box', 'Text box']),
        rarity: getColumnData(card, ['Rarity', 'rarity']),
        timer: getColumnData(card, ['Timer', 'timer']),
        castingCost: getColumnData(card, ['Casting Cost', 'casting cost']),
        effigyCosts: getColumnData(card, ['Effigy Costs', 'effigy costs', 'Effigy Cost']),
        effigyType: getColumnData(card, ['Effigy type', 'Effigy Type']),
        typing: getColumnData(card, ['Card Typing', 'Card typing']),
      }))
      .filter(({ name, textBox, rarity, timer, castingCost, effigyCosts, effigyType, typing }) =>
        name.toLowerCase().includes(q) ||
        textBox.toLowerCase().includes(q) ||
        rarity.toLowerCase().includes(q) ||
        typing.toLowerCase().includes(q) ||
        effigyType.toLowerCase().includes(q) ||
        effigyCosts.toLowerCase().includes(q) ||
        (timerQuery !== null && timer === timerQuery) ||
        (costQuery !== null && castingCost === costQuery)
      );
  };
  const sortMatches = (matches, sortBy) => {
    if (sortBy === 'none') return matches;
    const sorted = [...matches];
    if (sortBy === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === 'effigyType') sorted.sort((a, b) => a.effigyType.localeCompare(b.effigyType) || a.name.localeCompare(b.name));
    else if (sortBy === 'cost') sorted.sort((a, b) => (parseInt(a.castingCost, 10) || 0) - (parseInt(b.castingCost, 10) || 0) || a.name.localeCompare(b.name));
    return sorted;
  };
  const allSearchMatches = sortMatches(getSearchMatches(cardSearch), searchSortBy);
  const searchMatches = allSearchMatches.slice(0, 8);

  useEffect(() => {
    if (!showSearchPanel || searchViewMode !== 'visual' || !fontLoaded) return;
    const matches = getSearchMatches(cardSearch);
    if (matches.length === 0) return;
    const canvas = document.createElement('canvas');
    const next = {};
    matches.forEach(({ idx }) => {
      const card = csvData[idx];
      const { img, loaded, artImg, artBoxRect } = pickTemplateImage(card);
      if (img && loaded) {
        renderCardOnCanvas(canvas, card, img, positions, thumbWidth, thumbHeight, borderStyle, artImg, artBoxRect);
        next[idx] = canvas.toDataURL('image/png');
      }
    });
    setSearchThumbnails(next);
  }, [showSearchPanel, searchViewMode, cardSearch, csvData, fontLoaded, positions, borderImagesLoaded, artImagesLoaded, borderStyle]);

  useEffect(() => {
    if (searchPreviewIndex === null || !fontLoaded) return;
    const match = getSearchMatches(cardSearch)[searchPreviewIndex];
    if (!match) return;
    const card = csvData[match.idx];
    const { img, loaded, artImg, artBoxRect } = pickTemplateImage(card);
    if (!img || !loaded) return;
    const canvas = searchPreviewCanvasRef.current;
    if (!canvas) return;
    renderCardOnCanvas(canvas, card, img, positions, cardWidth, cardHeight, borderStyle, artImg, artBoxRect);
  }, [searchPreviewIndex, cardSearch, csvData, positions, fontLoaded, borderImagesLoaded, artImagesLoaded, borderStyle]);

  useEffect(() => {
    if (deckPreviewIndex === null || !fontLoaded) return;
    const entry = displayDeckList[deckPreviewIndex];
    if (!entry) return;
    const { img, loaded, artImg, artBoxRect } = pickTemplateImage(entry.card);
    if (!img || !loaded) return;
    const canvas = deckPreviewCanvasRef.current;
    if (!canvas) return;
    renderCardOnCanvas(canvas, entry.card, img, positions, cardWidth, cardHeight, borderStyle, artImg, artBoxRect);
  }, [deckPreviewIndex, displayDeckList, positions, fontLoaded, borderImagesLoaded, artImagesLoaded, borderStyle]);

  return (
    <div className="min-h-screen bg-black p-4 md:p-8" style={{ fontFamily: "'Georgia', serif" }}>
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl md:text-4xl font-bold text-white mb-1">Trading Card Generator</h1>
        <p className="text-stone-400 mb-8 text-sm">Upload a CSV of card data to batch-generate finished cards. The border art is chosen automatically for each card from its Card Typing (Being/Prophecy, Relic/Altar, or Ethereal Conjuring/Conjuring).</p>

        <div className="bg-white p-6 rounded-lg shadow-sm border border-stone-200 mb-8 max-w-sm">
          {!csvUploadUnlocked ? (
            <form onSubmit={submitCsvUploadPasscode} className="flex flex-col items-center justify-center h-32 border-2 border-dashed border-stone-300 rounded px-4">
              <Lock className="w-6 h-6 text-stone-400 mb-2" />
              <p className="text-xs text-stone-500 mb-2 text-center">Enter the passcode to upload a CSV file.</p>
              <input
                type="password"
                value={csvUploadPasscode}
                onChange={(e) => { setCsvUploadPasscode(e.target.value); setCsvUploadError(''); }}
                placeholder="Passcode"
                className="w-full px-2 py-1 border border-stone-300 rounded text-sm mb-1 focus:outline-none focus:ring-1 focus:ring-stone-400"
              />
              {csvUploadError && <p className="text-xs text-red-600">{csvUploadError}</p>}
              <button type="submit" className="text-xs text-blue-600 hover:underline mt-1">Unlock</button>
            </form>
          ) : (
            <label className="flex flex-col items-center justify-center h-32 border-2 border-dashed border-stone-300 rounded cursor-pointer hover:border-blue-500 transition-colors">
              <Upload className="w-8 h-8 text-stone-400 mb-2" />
              <span className="text-sm text-stone-600">Upload CSV File</span>
              <input type="file" accept=".csv" onChange={handleCSVUpload} className="hidden" />
            </label>
          )}
          {csvData.length > 0 && <p className="text-green-600 mt-2 text-sm">✓ {csvData.length} cards loaded</p>}
        </div>

        {csvData.length > 0 && (
          <div className="bg-white p-6 rounded-lg shadow-sm border border-stone-200 mb-8">
            <div className="flex items-start gap-2 mb-4">
              <div className="relative flex-1">
                <div className="flex items-center gap-2 border border-stone-300 rounded px-3 py-2 bg-stone-50 focus-within:border-blue-500 transition-colors">
                  <Search className="w-4 h-4 text-stone-400 shrink-0" />
                  <input
                    type="text"
                    value={cardSearch}
                    onChange={(e) => { setCardSearch(e.target.value); setShowSearchResults(true); setShowSearchPanel(false); }}
                    onFocus={() => setShowSearchResults(true)}
                    onBlur={() => setTimeout(() => setShowSearchResults(false), 150)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && cardSearch.trim()) { setShowSearchPanel(true); setShowSearchResults(false); } }}
                    placeholder="Search by name, text, rarity, or e.g. &quot;2 turn&quot;…"
                    className="flex-1 bg-transparent outline-none text-sm"
                  />
                </div>
                {showSearchResults && cardSearch.trim() && (
                  <div className="absolute z-10 mt-1 w-full bg-white border border-stone-300 rounded shadow-lg max-h-64 overflow-y-auto">
                    {searchMatches.length > 0 ? (
                      searchMatches.map(({ idx, name }) => (
                        <button
                          key={idx}
                          onClick={() => { setCurrentCard(idx); setCardSearch(''); setShowSearchResults(false); }}
                          className="flex items-center justify-between w-full text-left px-3 py-2 text-sm hover:bg-stone-100 transition-colors"
                        >
                          <span>{name}</span>
                          <span className="text-stone-400 text-xs">#{idx + 1}</span>
                        </button>
                      ))
                    ) : (
                      <div className="px-3 py-2 text-sm text-stone-400">No matching cards</div>
                    )}
                  </div>
                )}
              </div>
              <button
                onClick={() => { if (cardSearch.trim()) { setShowSearchPanel(true); setShowSearchResults(false); } }}
                disabled={!cardSearch.trim()}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors text-sm disabled:opacity-40 shrink-0"
              >
                <Search className="w-4 h-4" />
                Search
              </button>
            </div>

            {showSearchPanel && cardSearch.trim() && (
              <div className="mb-4 bg-stone-50 border border-stone-200 rounded">
                <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 border-b border-stone-200">
                  <span className="text-sm font-semibold text-stone-700">
                    {allSearchMatches.length} card{allSearchMatches.length === 1 ? '' : 's'} match "{cardSearch.trim()}"
                  </span>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1 bg-stone-200 rounded p-0.5">
                      <button
                        onClick={() => setSearchViewMode('list')}
                        className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors ${searchViewMode === 'list' ? 'bg-white shadow-sm text-stone-800' : 'text-stone-500'}`}
                      >
                        List
                      </button>
                      <button
                        onClick={() => setSearchViewMode('visual')}
                        className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors ${searchViewMode === 'visual' ? 'bg-white shadow-sm text-stone-800' : 'text-stone-500'}`}
                      >
                        Visual
                      </button>
                    </div>
                    <select
                      value={searchSortBy}
                      onChange={(e) => setSearchSortBy(e.target.value)}
                      className="text-xs border border-stone-300 rounded px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-stone-400"
                    >
                      <option value="none">Sort…</option>
                      <option value="name">Name (A–Z)</option>
                      <option value="effigyType">Effigy Type</option>
                      <option value="cost">Cost (low–high)</option>
                    </select>
                    <button
                      onClick={() => setShowSearchPanel(false)}
                      className="text-stone-400 hover:text-stone-600 text-sm"
                    >
                      Close
                    </button>
                  </div>
                </div>
                {allSearchMatches.length === 0 ? (
                  <div className="px-3 py-3 text-sm text-stone-400">No matching cards</div>
                ) : searchViewMode === 'visual' ? (
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3 p-3 max-h-96 overflow-y-auto">
                    {allSearchMatches.map(({ idx, name }, pos) => (
                      <button
                        key={idx}
                        onClick={() => { setCurrentCard(idx); setSearchPreviewIndex(pos); }}
                        className={`relative border rounded overflow-hidden bg-white flex flex-col text-left transition-colors ${idx === currentCard ? 'border-blue-500 ring-2 ring-blue-200' : 'border-stone-200 hover:border-blue-300'}`}
                      >
                        {searchThumbnails[idx] ? (
                          <img src={searchThumbnails[idx]} alt={name} className="w-full block" />
                        ) : (
                          <div className="w-full aspect-[5/7] bg-stone-100 flex items-center justify-center text-xs text-stone-400">
                            Loading…
                          </div>
                        )}
                        <span className="text-[10px] text-stone-600 truncate px-1.5 py-1" title={name}>{name}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="max-h-72 overflow-y-auto divide-y divide-stone-200">
                    {allSearchMatches.map(({ idx, name }, pos) => (
                      <button
                        key={idx}
                        onClick={() => { setCurrentCard(idx); setSearchPreviewIndex(pos); }}
                        className={`flex items-center justify-between w-full text-left px-3 py-2 text-sm hover:bg-stone-100 transition-colors ${idx === currentCard ? 'bg-blue-50' : ''}`}
                      >
                        <span>{name}</span>
                        <span className="text-stone-400 text-xs">#{idx + 1}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {searchPreviewIndex !== null && allSearchMatches[searchPreviewIndex] && (() => {
              const match = allSearchMatches[searchPreviewIndex];
              const entry = deckList.find((e) => e.name === match.name);
              return (
                <div
                  className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
                  onClick={() => setSearchPreviewIndex(null)}
                >
                  <div
                    className="bg-white rounded-lg shadow-2xl p-4 max-w-lg w-full relative"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => setSearchPreviewIndex(null)}
                      className="absolute top-3 right-3 p-1.5 rounded-full bg-stone-200 hover:bg-stone-300 transition-colors z-10"
                      aria-label="Close"
                    >
                      <X className="w-5 h-5" />
                    </button>
                    <div className="text-center font-semibold text-stone-800 mb-3 pr-8">{match.name}</div>
                    <div className="flex items-center justify-center gap-3">
                      <button
                        onClick={() => setSearchPreviewIndex(Math.max(0, searchPreviewIndex - 1))}
                        disabled={searchPreviewIndex === 0}
                        className="p-2.5 rounded-full bg-stone-200 hover:bg-stone-300 disabled:opacity-30 disabled:hover:bg-stone-200 transition-colors shrink-0"
                        aria-label="Previous card"
                      >
                        <ChevronLeft className="w-5 h-5" />
                      </button>
                      <canvas
                        ref={searchPreviewCanvasRef}
                        className="max-w-full max-h-[65vh] w-auto h-auto border border-stone-300 mx-auto block"
                      />
                      <button
                        onClick={() => setSearchPreviewIndex(Math.min(allSearchMatches.length - 1, searchPreviewIndex + 1))}
                        disabled={searchPreviewIndex === allSearchMatches.length - 1}
                        className="p-2.5 rounded-full bg-stone-200 hover:bg-stone-300 disabled:opacity-30 disabled:hover:bg-stone-200 transition-colors shrink-0"
                        aria-label="Next card"
                      >
                        <ChevronRight className="w-5 h-5" />
                      </button>
                    </div>
                    <div className="flex justify-center mt-4">
                      <button
                        onClick={() => addToDeck(match.idx)}
                        disabled={deckTotal >= DECK_SIZE || (entry && entry.count >= maxCopiesFor(csvData[match.idx]))}
                        className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 transition-colors disabled:opacity-60"
                      >
                        <Plus className="w-4 h-4" />
                        Add to Deck{entry ? ` (${entry.count}/${maxCopiesFor(csvData[match.idx])})` : ''}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}

            {deckPreviewIndex !== null && displayDeckList[deckPreviewIndex] && (() => {
              const entry = displayDeckList[deckPreviewIndex];
              const limit = maxCopiesFor(entry.card);
              return (
                <div
                  className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
                  onClick={() => setDeckPreviewIndex(null)}
                >
                  <div
                    className="bg-white rounded-lg shadow-2xl p-4 max-w-lg w-full relative"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => setDeckPreviewIndex(null)}
                      className="absolute top-3 right-3 p-1.5 rounded-full bg-stone-200 hover:bg-stone-300 transition-colors z-10"
                      aria-label="Close"
                    >
                      <X className="w-5 h-5" />
                    </button>
                    <div className="text-center font-semibold text-stone-800 mb-3 pr-8">{entry.name}</div>
                    <div className="flex items-center justify-center gap-3">
                      <button
                        onClick={() => setDeckPreviewIndex(Math.max(0, deckPreviewIndex - 1))}
                        disabled={deckPreviewIndex === 0}
                        className="p-2.5 rounded-full bg-stone-200 hover:bg-stone-300 disabled:opacity-30 disabled:hover:bg-stone-200 transition-colors shrink-0"
                        aria-label="Previous card"
                      >
                        <ChevronLeft className="w-5 h-5" />
                      </button>
                      <canvas
                        ref={deckPreviewCanvasRef}
                        className="max-w-full max-h-[65vh] w-auto h-auto border border-stone-300 mx-auto block"
                      />
                      <button
                        onClick={() => setDeckPreviewIndex(Math.min(displayDeckList.length - 1, deckPreviewIndex + 1))}
                        disabled={deckPreviewIndex === displayDeckList.length - 1}
                        className="p-2.5 rounded-full bg-stone-200 hover:bg-stone-300 disabled:opacity-30 disabled:hover:bg-stone-200 transition-colors shrink-0"
                        aria-label="Next card"
                      >
                        <ChevronRight className="w-5 h-5" />
                      </button>
                    </div>
                    <div className="flex items-center justify-center gap-3 mt-4">
                      <button
                        onClick={() => removeFromDeck(entry.name)}
                        className="p-2 rounded-full bg-stone-200 hover:bg-stone-300 transition-colors"
                        aria-label={`Remove one copy of ${entry.name}`}
                      >
                        <Minus className="w-4 h-4" />
                      </button>
                      <span className="text-sm font-medium text-stone-700 w-16 text-center">{entry.count}/{limit}</span>
                      <button
                        onClick={() => addCopyToDeck(entry.name)}
                        disabled={entry.count >= limit || deckTotal >= DECK_SIZE}
                        className="p-2 rounded-full bg-indigo-200 hover:bg-indigo-300 disabled:opacity-30 transition-colors"
                        aria-label={`Add another copy of ${entry.name}`}
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}

            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <span className="text-lg font-semibold text-stone-800">
                Card {currentCard + 1} of {csvData.length}
                {csvData[currentCard]?.['Card Name'] ? ` — ${csvData[currentCard]['Card Name']}` : ''}
              </span>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 bg-stone-200 rounded p-0.5">
                  {Object.entries(BORDER_STYLES).map(([key, { label }]) => (
                    <button
                      key={key}
                      onClick={() => setBorderStyle(key)}
                      className={`px-2.5 py-1.5 text-xs font-semibold rounded transition-colors ${borderStyle === key ? 'bg-white shadow-sm text-stone-800' : 'text-stone-500'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setShowPositioning(!showPositioning)}
                  className="flex items-center gap-1.5 px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 transition-colors text-sm"
                >
                  <Settings2 className="w-4 h-4" />
                  {showPositioning ? 'Hide' : 'Show'} Position Controls
                </button>
              </div>
            </div>

            {showPositioning && (
              <div className="bg-yellow-50 p-4 rounded mb-4 border border-yellow-200">
                <h3 className="font-bold mb-3 text-stone-800">Position Controls (values 0.0 to 1.0)</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {Object.keys(positions).map(key => (
                    <div key={key} className="space-y-1">
                      <label className="font-semibold text-xs text-stone-600">{key}</label>
                      <div className="flex gap-2">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max="1"
                          value={positions[key].x}
                          onChange={(e) => setPositions({
                            ...positions,
                            [key]: { ...positions[key], x: parseFloat(e.target.value) || 0 }
                          })}
                          className="w-20 px-2 py-1 border rounded text-sm"
                          placeholder="X"
                        />
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max="1"
                          value={positions[key].y}
                          onChange={(e) => setPositions({
                            ...positions,
                            [key]: { ...positions[key], y: parseFloat(e.target.value) || 0 }
                          })}
                          className="w-20 px-2 py-1 border rounded text-sm"
                          placeholder="Y"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <details className="bg-stone-50 p-4 rounded mb-4 text-sm border border-stone-200">
              <summary className="font-bold cursor-pointer text-stone-700">Current Card Data (Debug)</summary>
              <pre className="whitespace-pre-wrap mt-2 text-stone-600">{JSON.stringify(csvData[currentCard], null, 2)}</pre>
            </details>

            <div className="flex flex-wrap items-center gap-4">
              <div className="relative" ref={exportMenuRef}>
                <button
                  onClick={() => setShowExportMenu(!showExportMenu)}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Export
                  <ChevronDown className="w-4 h-4" />
                </button>
                {showExportMenu && (
                  <div className="absolute z-20 mt-1 w-80 bg-white border border-stone-300 rounded shadow-lg overflow-hidden">
                    <button
                      onClick={() => { downloadCard(); setShowExportMenu(false); }}
                      className="block w-full text-left px-4 py-2 text-sm hover:bg-stone-100 transition-colors"
                    >
                      Export This Card
                    </button>
                    <button
                      onClick={() => { downloadCardMPC(); setShowExportMenu(false); }}
                      className="block w-full text-left px-4 py-2 text-sm hover:bg-stone-100 transition-colors"
                    >
                      Export This Card (MakePlayingCards.com, 816×1110)
                    </button>
                  </div>
                )}
              </div>
              <button
                onClick={addToDeck}
                disabled={deckTotal >= DECK_SIZE || (currentDeckEntry && currentDeckEntry.count >= maxCopiesFor(csvData[currentCard]))}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 transition-colors disabled:opacity-60"
              >
                <Plus className="w-4 h-4" />
                Add to Deck{currentDeckEntry ? ` (${currentDeckEntry.count}/${maxCopiesFor(csvData[currentCard])})` : ''}
              </button>
              <button
                onClick={() => setShowDeckList(!showDeckList)}
                className="flex items-center gap-2 px-4 py-2 bg-stone-600 text-white rounded hover:bg-stone-700 transition-colors"
              >
                {showDeckList ? 'Hide' : 'Show'} Custom Deck ({deckTotal}/{DECK_SIZE})
              </button>
              <div className="relative" ref={downloadMenuRef}>
                <button
                  onClick={() => setShowDownloadMenu(!showDownloadMenu)}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Download
                  <ChevronDown className="w-4 h-4" />
                </button>
                {showDownloadMenu && (
                  <div className="absolute z-20 mt-1 w-96 bg-white border border-stone-300 rounded shadow-lg overflow-hidden">
                    <button
                      onClick={() => { downloadAll(); setShowDownloadMenu(false); }}
                      disabled={isExportingAll}
                      className="block w-full text-left px-4 py-2 text-sm hover:bg-stone-100 disabled:opacity-60 transition-colors"
                    >
                      {isExportingAll ? `Exporting ${exportProgress}/${csvData.length}…` : 'Download All'}
                    </button>
                    <button
                      onClick={() => { downloadAllMPC(); setShowDownloadMenu(false); }}
                      disabled={isExportingMPC}
                      className="block w-full text-left px-4 py-2 text-sm hover:bg-stone-100 disabled:opacity-60 transition-colors"
                    >
                      {isExportingMPC
                        ? `Exporting ${mpcProgress}/${csvData.length}…`
                        : 'Download All (MakePlayingCards.com, 816×1110)'}
                    </button>
                    <button
                      onClick={() => { downloadPrintSheets(); setShowDownloadMenu(false); }}
                      disabled={isExportingSheets}
                      className="block w-full text-left px-4 py-2 text-sm hover:bg-stone-100 disabled:opacity-60 transition-colors"
                    >
                      {isExportingSheets
                        ? `Building sheet ${sheetProgress}/${totalSheets}…`
                        : `Download Print Sheets (3×3, ${totalSheets} page${totalSheets === 1 ? '' : 's'})`}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {!showSearchPanel && (
          <div className="bg-white p-6 rounded-lg shadow-sm border border-stone-200">
            {previewUrl && (
              <div className="mb-4 p-4 bg-yellow-50 border border-yellow-300 rounded">
                <p className="text-sm font-semibold text-yellow-800 mb-2">Downloaded. Preview below.</p>
                <img src={previewUrl} alt="Card export" className="max-w-full border border-stone-300 mx-auto block" />
              </div>
            )}
            {csvData.length === 0 ? (
              <div className="text-center text-stone-400 py-16 text-sm">
                Upload a CSV to see the card preview here.
              </div>
            ) : (
              <div className="relative">
                <canvas ref={canvasRef} className="max-w-full max-h-[70vh] w-auto h-auto border border-stone-300 mx-auto block" />
                <button
                  onClick={() => setCurrentCard(Math.max(0, currentCard - 1))}
                  disabled={currentCard === 0}
                  className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 disabled:opacity-0 transition-colors"
                  aria-label="Previous card"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>
                <button
                  onClick={() => setCurrentCard(Math.min(csvData.length - 1, currentCard + 1))}
                  disabled={currentCard === csvData.length - 1}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 disabled:opacity-0 transition-colors"
                  aria-label="Next card"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
              </div>
            )}
          </div>
        )}

        {csvData.length > 0 && showDeckList && (
          <div className="bg-white p-6 rounded-lg shadow-sm border border-stone-200 mb-8 mt-8">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <h3 className="font-bold text-stone-800">
                Custom Deck — {deckTotal}/{DECK_SIZE} cards
              </h3>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1 bg-stone-200 rounded p-0.5">
                  <button
                    onClick={() => setDeckViewMode('list')}
                    className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors ${deckViewMode === 'list' ? 'bg-white shadow-sm text-stone-800' : 'text-stone-500'}`}
                  >
                    List
                  </button>
                  <button
                    onClick={() => setDeckViewMode('visual')}
                    className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors ${deckViewMode === 'visual' ? 'bg-white shadow-sm text-stone-800' : 'text-stone-500'}`}
                  >
                    Visual
                  </button>
                </div>
                <select
                  value={deckSortBy}
                  onChange={(e) => setDeckSortBy(e.target.value)}
                  className="text-xs border border-stone-300 rounded px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-stone-400"
                >
                  <option value="none">Sort…</option>
                  <option value="name">Name (A–Z)</option>
                  <option value="effigyType">Effigy Type</option>
                  <option value="cost">Cost (low–high)</option>
                </select>
                <label className="flex items-center gap-1.5 px-3 py-1.5 bg-stone-100 hover:bg-stone-200 rounded text-sm font-medium text-stone-700 cursor-pointer transition-colors">
                  <Upload className="w-3.5 h-3.5" />
                  Import Deck List
                  <input type="file" accept=".json,.txt" onChange={importDeckList} className="hidden" />
                </label>
                {deckList.length > 0 && (
                  <button
                    onClick={clearDeck}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors text-sm"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Clear Deck
                  </button>
                )}
              </div>
            </div>

            {deckImportWarnings.length > 0 && (
              <ul className="mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 list-disc pl-4 space-y-0.5">
                {deckImportWarnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}

            {deckList.length === 0 ? (
              <p className="text-sm text-stone-500">
                No cards added yet. Browse cards above and click "Add to Deck" to build your list (up to {MAX_COPIES} copies each — {MAX_DEITY_COPIES} for Deities — {DECK_SIZE} cards total), or use Import Deck List above.
              </p>
            ) : deckViewMode === 'visual' ? (
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3 mb-4 max-h-96 overflow-y-auto pr-1">
                {displayDeckList.map((entry, idx) => (
                  <div key={entry.name} className="relative border border-indigo-200 rounded overflow-hidden bg-white flex flex-col">
                    <button onClick={() => setDeckPreviewIndex(idx)} className="relative block w-full">
                      {deckThumbnails[entry.name] ? (
                        <img src={deckThumbnails[entry.name]} alt={entry.name} className="w-full block" />
                      ) : (
                        <div className="w-full aspect-[5/7] bg-stone-100 flex items-center justify-center text-xs text-stone-400">
                          Loading…
                        </div>
                      )}
                      <span className="absolute top-1 right-1 bg-black/70 text-white text-xs font-bold px-1.5 py-0.5 rounded">
                        x{entry.count}
                      </span>
                    </button>
                    <div className="flex items-center justify-between gap-1 px-1.5 py-1 bg-indigo-50">
                      <button
                        onClick={() => removeFromDeck(entry.name)}
                        className="p-0.5 rounded bg-stone-200 hover:bg-stone-300 transition-colors shrink-0"
                        aria-label={`Remove one copy of ${entry.name}`}
                      >
                        <Minus className="w-3 h-3" />
                      </button>
                      <span className="text-[10px] text-stone-600 truncate" title={entry.name}>{entry.name}</span>
                      {entry.count < maxCopiesFor(entry.card) && deckTotal < DECK_SIZE ? (
                        <button
                          onClick={() => addCopyToDeck(entry.name)}
                          className="p-0.5 rounded bg-indigo-200 hover:bg-indigo-300 transition-colors shrink-0"
                          aria-label={`Add another copy of ${entry.name}`}
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                      ) : (
                        <span className="w-4 shrink-0" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <ul className="divide-y divide-indigo-100 mb-4 max-h-64 overflow-y-auto">
                {displayDeckList.map((entry, idx) => (
                  <li key={entry.name} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <button onClick={() => setDeckPreviewIndex(idx)} className="min-w-0 truncate text-stone-700 text-left hover:text-indigo-700 transition-colors">
                      {entry.name}
                    </button>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => removeFromDeck(entry.name)}
                        className="p-1 rounded bg-stone-200 hover:bg-stone-300 transition-colors"
                        aria-label={`Remove one copy of ${entry.name}`}
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <input
                        type="number"
                        min="0"
                        max={maxCopiesFor(entry.card)}
                        value={entry.count}
                        onChange={(e) => setDeckCount(entry.name, e.target.value)}
                        className="w-10 text-center text-sm border border-stone-200 rounded py-0.5"
                      />
                      {entry.count < maxCopiesFor(entry.card) && deckTotal < DECK_SIZE && (
                        <button
                          onClick={() => addCopyToDeck(entry.name)}
                          className="p-1 rounded bg-indigo-200 hover:bg-indigo-300 transition-colors"
                          aria-label={`Add another copy of ${entry.name}`}
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={downloadDeckList}
                disabled={deckTotal !== DECK_SIZE}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 transition-colors disabled:opacity-40"
              >
                <Download className="w-4 h-4" />
                Download Decklist (.txt)
              </button>
              <button
                onClick={downloadDeckForGame}
                disabled={deckTotal !== DECK_SIZE}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-700 text-white rounded hover:bg-emerald-800 transition-colors disabled:opacity-40"
              >
                <Download className="w-4 h-4" />
                Export Deck for Game (.json)
              </button>
              <button
                onClick={downloadDeckPrintSheets}
                disabled={deckTotal !== DECK_SIZE || isExportingDeckSheets}
                className="flex items-center gap-2 px-4 py-2 bg-amber-700 text-white rounded hover:bg-amber-800 transition-colors disabled:opacity-40"
              >
                <LayoutGrid className="w-4 h-4" />
                {isExportingDeckSheets
                  ? `Building sheet ${deckSheetProgress}/${deckTotalSheets}…`
                  : `Download Deck Print Sheets (3×3, ${deckTotalSheets} page${deckTotalSheets === 1 ? '' : 's'})`}
              </button>
              {deckTotal !== DECK_SIZE && (
                <span className="text-sm text-stone-500">
                  Add {DECK_SIZE - deckTotal} more card{DECK_SIZE - deckTotal === 1 ? '' : 's'} to enable download.
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default TradingCardGenerator;
