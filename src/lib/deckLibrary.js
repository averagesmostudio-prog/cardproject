// Persistent storage for player-saved decks — plain localStorage, matching
// csvSource.js's existing convention (this app has no Electron IPC/preload
// infra for a file-backed store, and doesn't need new infra for this).
//
// Precons (precons.js) are never copied into this store — the Library's
// displayed list is always PRECON_DECKS (static, unremovable) unioned with
// what's read here (removable). That gives "preloaded decks are in the
// Library on first download" for free, with no seeding/migration step.
import { EFFIGY_TYPE_COLORS } from './cardData.js';
import { PRECON_DECKS } from '../game/decks/precons.js';
import { deriveDominantColor, getDeckIcon, pickRandomIconKey } from './deckLibraryStyle.js';

const LIBRARY_KEY = 'scripturas-deck-library';

const read = () => {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const write = (decks) => {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(decks));
  } catch {
    // Storage unavailable (private mode, quota, non-browser test env) —
    // saved decks just won't persist; nothing else in the app depends on it.
  }
};

export const listSavedDecks = () => read();
export const getSavedDeck = (id) => read().find(d => d.id === id) || null;

// entries: [{ name, count }] — same plain, pool-independent shape
// precons.js and deckExport.js already use.
export const saveDeck = ({ name, entries, effigyCounts }) => {
  const decks = read();
  const now = new Date().toISOString();
  const record = {
    id: `deck-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: (name || '').trim() || 'Untitled Deck',
    entries,
    effigyCounts,
    colorKey: deriveDominantColor(effigyCounts),
    iconKey: pickRandomIconKey(),
    createdAt: now,
    updatedAt: now,
  };
  write([...decks, record]);
  return record;
};

// iconKey is deliberately never touched here — stable for the deck's whole
// life. colorKey IS recomputed since it should reflect the current mix.
export const updateDeck = (id, { name, entries, effigyCounts }) => {
  const decks = read();
  const idx = decks.findIndex(d => d.id === id);
  if (idx === -1) return null;
  const updated = {
    ...decks[idx],
    name: (name || '').trim() || decks[idx].name,
    entries,
    effigyCounts,
    colorKey: deriveDominantColor(effigyCounts),
    updatedAt: new Date().toISOString(),
  };
  decks[idx] = updated;
  write(decks);
  return updated;
};

export const removeDeck = (id) => write(read().filter(d => d.id !== id));

// The Library's full deck list: static precons (unremovable) unioned with
// whatever's currently saved (removable) — read fresh on every call so a
// save/edit/remove is reflected the next time a screen re-renders this.
export const buildDeckLibraryList = () => [
  ...PRECON_DECKS.map(p => ({
    id: p.id,
    name: p.name,
    tagline: p.tagline,
    accentColor: EFFIGY_TYPE_COLORS[p.color] || '#9c6b1f',
    Icon: p.icon,
    source: 'precon',
    raw: p,
  })),
  ...listSavedDecks().map(d => ({
    id: d.id,
    name: d.name,
    tagline: 'Custom deck',
    accentColor: EFFIGY_TYPE_COLORS[d.colorKey] || '#9c6b1f',
    Icon: getDeckIcon(d.iconKey),
    source: 'saved',
    raw: d,
  })),
];

// A grid entry (precon or saved deck), normalized into the shape
// DeckBuilder's own seedDeck prop expects — resolveDeckEntries (deck.js)
// already knows how to fall back from an explicit effigyCounts to a
// mono-color build off `color`, so both sources pass through unchanged.
// Shared by Library.jsx (management) and PreconSelect.jsx (in-match edit).
export const toDeckSeed = (deck) => ({
  entries: deck.raw.entries,
  effigyCounts: deck.raw.effigyCounts,
  color: deck.raw.color,
  source: deck.source,
  sourceId: deck.raw.id,
  sourceName: deck.raw.name,
});
