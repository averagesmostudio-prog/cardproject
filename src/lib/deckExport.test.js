import { describe, it, expect } from 'vitest';
import { buildDeckExport, parseDeckImport, parseDeckImportFull, DECK_EXPORT_FORMAT, DECK_EXPORT_VERSION } from './deckExport.js';

describe('buildDeckExport', () => {
  it('produces a versioned JSON-ready object with just name/count per entry', () => {
    const data = buildDeckExport([{ name: 'Ember Whelp', count: 3, card: { irrelevant: true } }]);
    expect(data.format).toBe(DECK_EXPORT_FORMAT);
    expect(data.version).toBe(DECK_EXPORT_VERSION);
    expect(data.mainDeck).toEqual([{ name: 'Ember Whelp', count: 3 }]);
  });
});

describe('parseDeckImport', () => {
  it('round-trips a buildDeckExport JSON payload', () => {
    const exported = buildDeckExport([{ name: 'A', count: 3 }, { name: 'B', count: 2 }]);
    const parsed = parseDeckImport(JSON.stringify(exported));
    expect(parsed).toEqual([{ name: 'A', count: 3 }, { name: 'B', count: 2 }]);
  });

  it('rejects JSON without a mainDeck array', () => {
    expect(() => parseDeckImport(JSON.stringify({ foo: 'bar' }))).toThrow(/mainDeck/);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseDeckImport('{not json')).toThrow(/valid JSON/);
  });

  it('parses the plain "Nx Card Name" .txt format', () => {
    const parsed = parseDeckImport('3x Ember Whelp\n2x Stone Guard\n1 Sun Deity');
    expect(parsed).toEqual([
      { name: 'Ember Whelp', count: 3 },
      { name: 'Stone Guard', count: 2 },
      { name: 'Sun Deity', count: 1 },
    ]);
  });

  it('skips blank lines and lines that don\'t match the pattern', () => {
    const parsed = parseDeckImport('3x Ember Whelp\n\nnot a valid line\n2x Stone Guard');
    expect(parsed).toEqual([{ name: 'Ember Whelp', count: 3 }, { name: 'Stone Guard', count: 2 }]);
  });

  it('throws when no lines match at all', () => {
    expect(() => parseDeckImport('nothing useful here')).toThrow(/Card Name/);
  });
});

describe('deck export / import including the Effigy Deck', () => {
  const entries = [{ name: 'Imp', count: 3 }, { name: 'Kendasha', count: 2 }];

  it('exports the Effigy Deck next to the Main Deck (dropping zero counts)', () => {
    const data = buildDeckExport(entries, { effigyCounts: { bleeding: 10, timeless: 5, living: 0 }, name: 'My Deck' });
    expect(data.mainDeck).toEqual(entries);
    expect(data.effigyDeck).toEqual({ bleeding: 10, timeless: 5 });
    expect(data.name).toBe('My Deck');
    expect(data.version).toBe(2);
  });

  it('round-trips both halves through parseDeckImportFull', () => {
    const text = JSON.stringify(buildDeckExport(entries, { effigyCounts: { bleeding: 10, shifting: 5 } }));
    expect(parseDeckImportFull(text)).toEqual({ entries, effigyCounts: { bleeding: 10, shifting: 5 } });
  });

  it('a main-deck-only export (the Generator\'s, or v1) still imports, with no Effigy Deck', () => {
    const text = JSON.stringify(buildDeckExport(entries));
    expect(buildDeckExport(entries).effigyDeck).toBeUndefined();
    expect(parseDeckImportFull(text)).toEqual({ entries, effigyCounts: null });
    expect(parseDeckImport(text)).toEqual(entries);
  });

  it('a plain "3x Card Name" list has no Effigy Deck', () => {
    expect(parseDeckImportFull('3x Imp\n2 Kendasha')).toEqual({ entries, effigyCounts: null });
  });

  it('ignores a malformed effigyDeck instead of failing the import', () => {
    const text = JSON.stringify({ format: 'tcg-deck', version: 2, mainDeck: entries, effigyDeck: ['x'] });
    expect(parseDeckImportFull(text).effigyCounts).toBeNull();
    const text2 = JSON.stringify({ format: 'tcg-deck', version: 2, mainDeck: entries, effigyDeck: { Bleeding: 4.7, bad: -2, ok: 'x' } });
    expect(parseDeckImportFull(text2).effigyCounts).toEqual({ bleeding: 4 });
  });
});
