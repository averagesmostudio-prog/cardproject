import { describe, it, expect } from 'vitest';
import { mergeDeckSets } from './deckSync.js';

const deck = (id, updatedAt, name = id) => ({ id, name, updatedAt });

describe('mergeDeckSets', () => {
  it('unions decks from both sides', () => {
    const merged = mergeDeckSets(
      { decks: [deck('a', '2026-01-01')], deleted: {} },
      { decks: [deck('b', '2026-01-02')], deleted: {} },
    );
    expect(merged.decks.map(d => d.id)).toEqual(['a', 'b']);
  });

  it('keeps the most recently edited copy of the same deck', () => {
    const merged = mergeDeckSets(
      { decks: [deck('a', '2026-01-01', 'old')], deleted: {} },
      { decks: [deck('a', '2026-02-01', 'new')], deleted: {} },
    );
    expect(merged.decks).toEqual([deck('a', '2026-02-01', 'new')]);
  });

  it('a removal made after the last edit removes the deck everywhere', () => {
    const merged = mergeDeckSets(
      { decks: [], deleted: { a: '2026-03-01' } },
      { decks: [deck('a', '2026-02-01')], deleted: {} },
    );
    expect(merged.decks).toEqual([]);
    expect(merged.deleted).toEqual({ a: '2026-03-01' });
  });

  it('an edit made after a removal brings the deck back and drops the tombstone', () => {
    const merged = mergeDeckSets(
      { decks: [], deleted: { a: '2026-01-01' } },
      { decks: [deck('a', '2026-02-01')], deleted: {} },
    );
    expect(merged.decks.map(d => d.id)).toEqual(['a']);
    expect(merged.deleted).toEqual({});
  });

  it('merges tombstones from both sides, keeping the later time', () => {
    const merged = mergeDeckSets(
      { decks: [], deleted: { x: '2026-01-01', y: '2026-01-05' } },
      { decks: [], deleted: { x: '2026-01-03' } },
    );
    expect(merged.deleted).toEqual({ x: '2026-01-03', y: '2026-01-05' });
  });

  it('is stable: merging the result with either input changes nothing', () => {
    const a = { decks: [deck('a', '2026-01-01'), deck('c', '2026-01-04')], deleted: { b: '2026-01-02' } };
    const b = { decks: [deck('b', '2026-01-01'), deck('c', '2026-01-03')], deleted: {} };
    const once = mergeDeckSets(a, b);
    expect(mergeDeckSets(once, a)).toEqual(once);
    expect(mergeDeckSets(once, b)).toEqual(once);
  });
});
