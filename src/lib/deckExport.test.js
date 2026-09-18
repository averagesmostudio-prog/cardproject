import { describe, it, expect } from 'vitest';
import { buildDeckExport, parseDeckImport, DECK_EXPORT_FORMAT, DECK_EXPORT_VERSION } from './deckExport.js';

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
