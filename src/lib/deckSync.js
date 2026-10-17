// Keeps the signed-in account's saved decks in step across devices: pull the
// account's copy, merge it with this device's, keep the merge on both sides.
// Offline or signed out, the library just keeps working from localStorage.
import { getSyncSnapshot, applySyncSnapshot, onLibraryChange } from './deckLibrary.js';
import { getAccount, getAuthToken, onAccountChange, apiRequest, signOut } from './account.js';

const MAX_TOMBSTONES = 500;
const PUSH_DELAY_MS = 1500;

// Newest edit wins per deck id (ISO timestamps compare as strings). A
// removal beats an edit made before it; an edit made after a removal
// brings the deck back. Order: this device's decks first, then new arrivals.
export const mergeDeckSets = (a, b) => {
  const deleted = { ...a.deleted };
  for (const [id, at] of Object.entries(b.deleted || {})) {
    if (!deleted[id] || at > deleted[id]) deleted[id] = at;
  }

  const newest = new Map();
  for (const deck of [...a.decks, ...b.decks]) {
    const current = newest.get(deck.id);
    if (!current || deck.updatedAt > current.updatedAt) newest.set(deck.id, deck);
  }

  const decks = [];
  for (const deck of newest.values()) {
    const removedAt = deleted[deck.id];
    if (removedAt && removedAt >= deck.updatedAt) continue;
    delete deleted[deck.id];
    decks.push(deck);
  }

  const kept = Object.entries(deleted).sort((x, y) => (y[1] > x[1] ? 1 : -1)).slice(0, MAX_TOMBSTONES);
  return { decks, deleted: Object.fromEntries(kept) };
};

const sameSnapshot = (x, y) => JSON.stringify(x) === JSON.stringify(y);

let inFlight = null;
let rerunQueued = false;

export const syncDecks = async () => {
  const token = getAuthToken();
  if (!token) return { synced: false };
  if (inFlight) {
    rerunQueued = true;
    return inFlight;
  }
  inFlight = (async () => {
    try {
      const remote = await apiRequest('GET', '/decks', { token });
      const local = getSyncSnapshot();
      const merged = mergeDeckSets(local, { decks: remote.decks || [], deleted: remote.deleted || {} });
      if (!sameSnapshot(merged, local)) applySyncSnapshot(merged);
      if (!sameSnapshot(merged, { decks: remote.decks || [], deleted: remote.deleted || {} })) {
        await apiRequest('PUT', '/decks', { token, body: merged });
      }
      return { synced: true };
    } catch (err) {
      if (err.status === 401) signOut();
      return { synced: false, error: err.message };
    } finally {
      inFlight = null;
      if (rerunQueued) {
        rerunQueued = false;
        syncDecks();
      }
    }
  })();
  return inFlight;
};

let started = false;

// Call once at app start. Syncs on launch and on sign-in, and a moment after
// every local deck edit.
export const initDeckSync = () => {
  if (started) return;
  started = true;
  let timer = null;
  onLibraryChange((source) => {
    if (source !== 'local' || !getAccount()) return;
    clearTimeout(timer);
    timer = setTimeout(syncDecks, PUSH_DELAY_MS);
  });
  let lastUser = getAccount()?.user.id ?? null;
  onAccountChange(() => {
    const id = getAccount()?.user.id ?? null;
    if (id && id !== lastUser) syncDecks();
    lastUser = id;
  });
  syncDecks();
};
