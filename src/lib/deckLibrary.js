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
import { autoBuildEffigyCounts } from '../game/engine/deck.js';

const LIBRARY_KEY = 'scripturas-deck-library';
// Ids of decks removed on this device, with when — so a deck deleted here
// isn't resurrected by the next account sync (deckSync.js merges against
// these) and so the deletion can reach the account's other devices.
const TOMBSTONE_KEY = 'scripturas-deck-tombstones';

const changeListeners = new Set();
// source: 'local' (this device edited the library) | 'sync' (an account
// sync rewrote it). deckSync only reacts to 'local'; screens refresh on both.
const notify = (source) => changeListeners.forEach((fn) => fn(source));
export const onLibraryChange = (fn) => {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
};

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

const readTombstones = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(TOMBSTONE_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const writeTombstones = (deleted) => {
  try {
    localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(deleted));
  } catch {
    // Same best-effort contract as write() above.
  }
};

export const getSyncSnapshot = () => ({ decks: read(), deleted: readTombstones() });

export const applySyncSnapshot = ({ decks, deleted }) => {
  write(decks);
  writeTombstones(deleted);
  notify('sync');
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
  notify('local');
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
  notify('local');
  return updated;
};

export const removeDeck = (id) => {
  write(read().filter(d => d.id !== id));
  writeTombstones({ ...readTombstones(), [id]: new Date().toISOString() });
  notify('local');
};

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

// "Name (copy)", then "Name (copy 2)", ... — never collides with an existing
// precon or saved deck, and copying a copy doesn't stack "(copy) (copy)".
export const nextCopyName = (name) => {
  const taken = new Set(buildDeckLibraryList().map(d => d.name));
  const base = ((name || '').trim() || 'Untitled Deck').replace(/ \(copy( \d+)?\)$/, '');
  let candidate = `${base} (copy)`;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base} (copy ${n})`;
  return candidate;
};

// Saves an independent copy of a deck (a precon or a saved one — a normalized
// buildDeckLibraryList() entry) as a new saved deck. A precon without its own
// explicit Effigy split gets its usual mono-color build written out in full.
export const duplicateDeck = (deck) => {
  const { raw } = deck;
  return saveDeck({
    name: nextCopyName(deck.name),
    entries: raw.entries.map(({ name, count }) => ({ name, count })),
    effigyCounts: { ...(raw.effigyCounts || autoBuildEffigyCounts(raw.color)) },
  });
};
