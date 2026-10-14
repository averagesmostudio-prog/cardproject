import { describe, it, expect, beforeEach } from 'vitest';
import { PRECON_DECKS } from '../game/decks/precons.js';
import {
  listSavedDecks, saveDeck, updateDeck, removeDeck, getSavedDeck,
  buildDeckLibraryList, toDeckSeed, nextCopyName, duplicateDeck,
} from './deckLibrary.js';

// No jsdom in this project's vitest environment (node) — stub the same
// localStorage surface csvSource.js's own convention relies on, in-memory,
// fresh for every test.
beforeEach(() => {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
});

const entries = [{ name: 'Alpha One', count: 3 }];
const effigyCounts = { bleeding: 15, timeless: 0, formless: 0, living: 0, shifting: 0 };

describe('saveDeck / listSavedDecks / getSavedDeck', () => {
  it('starts empty', () => {
    expect(listSavedDecks()).toEqual([]);
  });

  it('saves a deck and can list/fetch it back', () => {
    const saved = saveDeck({ name: 'My Deck', entries, effigyCounts });
    expect(listSavedDecks()).toEqual([saved]);
    expect(getSavedDeck(saved.id)).toEqual(saved);
    expect(saved.colorKey).toBe('bleeding');
    expect(saved.name).toBe('My Deck');
  });

  it('defaults an empty/blank name to "Untitled Deck"', () => {
    const saved = saveDeck({ name: '   ', entries, effigyCounts });
    expect(saved.name).toBe('Untitled Deck');
  });

  it('assigns a stable-looking id and an icon key from the pool', () => {
    const saved = saveDeck({ name: 'A', entries, effigyCounts });
    expect(typeof saved.iconKey).toBe('string');
    expect(saved.iconKey.length).toBeGreaterThan(0);
  });
});

describe('updateDeck', () => {
  it('updates fields in place without changing the icon or duplicating the record', () => {
    const saved = saveDeck({ name: 'Original', entries, effigyCounts });
    const updated = updateDeck(saved.id, {
      name: 'Renamed',
      entries: [{ name: 'Beta One', count: 2 }],
      effigyCounts: { bleeding: 0, timeless: 15, formless: 0, living: 0, shifting: 0 },
    });
    expect(updated.name).toBe('Renamed');
    expect(updated.colorKey).toBe('timeless');
    expect(updated.iconKey).toBe(saved.iconKey);
    expect(updated.id).toBe(saved.id);
    expect(listSavedDecks()).toHaveLength(1);
  });

  it('returns null for a deck id that does not exist', () => {
    expect(updateDeck('nope', { name: 'X', entries, effigyCounts })).toBeNull();
  });
});

describe('removeDeck', () => {
  it('removes exactly the targeted deck', () => {
    const a = saveDeck({ name: 'A', entries, effigyCounts });
    const b = saveDeck({ name: 'B', entries, effigyCounts });
    removeDeck(a.id);
    expect(listSavedDecks()).toEqual([b]);
  });
});

describe('buildDeckLibraryList', () => {
  it('always includes every precon, unremovable, plus any saved decks', () => {
    const saved = saveDeck({ name: 'Mine', entries, effigyCounts });
    const list = buildDeckLibraryList();
    expect(list.filter(d => d.source === 'precon')).toHaveLength(PRECON_DECKS.length);
    expect(list.find(d => d.source === 'saved' && d.id === saved.id)).toBeTruthy();
  });

  it('never mutates precons.js itself', () => {
    buildDeckLibraryList();
    expect(listSavedDecks()).toEqual([]);
  });
});

describe('toDeckSeed', () => {
  it('carries a saved deck\'s entries/effigyCounts/source through for DeckBuilder', () => {
    const saved = saveDeck({ name: 'Mine', entries, effigyCounts });
    const list = buildDeckLibraryList();
    const deck = list.find(d => d.id === saved.id);
    const seed = toDeckSeed(deck);
    expect(seed).toEqual({
      entries, effigyCounts, color: undefined,
      source: 'saved', sourceId: saved.id, sourceName: 'Mine',
    });
  });

  it('carries a precon through with its color and no explicit effigyCounts', () => {
    const list = buildDeckLibraryList();
    const deck = list.find(d => d.source === 'precon');
    const seed = toDeckSeed(deck);
    expect(seed.source).toBe('precon');
    expect(seed.sourceId).toBe(deck.raw.id);
    expect(seed.color).toBe(deck.raw.color);
  });
});

describe('duplicateDeck / nextCopyName', () => {
  it('names the first copy "(copy)" and numbers later ones', () => {
    const saved = saveDeck({ name: 'My Deck', entries, effigyCounts });
    expect(nextCopyName('My Deck')).toBe('My Deck (copy)');
    const first = duplicateDeck({ name: saved.name, raw: saved });
    expect(first.name).toBe('My Deck (copy)');
    expect(nextCopyName('My Deck')).toBe('My Deck (copy 2)');
    // copying a copy doesn't stack suffixes
    expect(nextCopyName('My Deck (copy)')).toBe('My Deck (copy 2)');
    expect(nextCopyName('   ')).toBe('Untitled Deck (copy)');
  });

  it('copies a saved deck independently', () => {
    const saved = saveDeck({ name: 'My Deck', entries, effigyCounts });
    const copy = duplicateDeck({ name: saved.name, raw: saved });
    expect(copy.id).not.toBe(saved.id);
    expect(copy.entries).toEqual(saved.entries);
    expect(copy.effigyCounts).toEqual(saved.effigyCounts);
    expect(copy.entries).not.toBe(saved.entries);
    expect(listSavedDecks()).toHaveLength(2);
    removeDeck(copy.id);
    expect(listSavedDecks()).toEqual([saved]);
  });

  it('copies a precon into a saved deck with its full Effigy Deck', () => {
    const precon = buildDeckLibraryList().find(d => d.source === 'precon');
    const copy = duplicateDeck(precon);
    expect(copy.name).toBe(`${precon.name} (copy)`);
    expect(copy.entries).toEqual(precon.raw.entries.map(({ name, count }) => ({ name, count })));
    const total = Object.values(copy.effigyCounts).reduce((a, b) => a + b, 0);
    expect(total).toBe(15);
    expect(listSavedDecks()).toHaveLength(1);
  });
});
