import { describe, it, expect } from 'vitest';
import {
  validateMainDeck, validateEffigyDeck, buildMainDeckList, buildEffigyDeckList,
  drawCard, MAIN_DECK_SIZE, EFFIGY_DECK_SIZE, MAX_COPIES, MAX_DEITY_COPIES,
  autoBuildMainDeckEntries, autoBuildEffigyCounts, randomEffigyColor,
} from './deck.js';

const card = (overrides = {}) => ({ id: 'c1', name: 'Card', isDeity: false, ...overrides });

describe('validateMainDeck', () => {
  it('requires exactly 40 cards', () => {
    const errors = validateMainDeck([{ card: card(), count: 39 }]);
    expect(errors.some(e => e.includes('exactly 40'))).toBe(true);
  });

  it('rejects more than 3 copies of a normal card', () => {
    const errors = validateMainDeck([{ card: card(), count: MAX_COPIES + 1 }]);
    expect(errors.some(e => e.includes('max 3'))).toBe(true);
  });

  it('rejects more than 2 copies of a Deity', () => {
    const errors = validateMainDeck([{ card: card({ isDeity: true }), count: MAX_DEITY_COPIES + 1 }]);
    expect(errors.some(e => e.includes('max 2'))).toBe(true);
  });

  it('passes for a legal 40-card deck', () => {
    const entries = [];
    for (let i = 0; i < 14; i++) entries.push({ card: card({ id: `c${i}` }), count: i < 13 ? 3 : 1 });
    const total = entries.reduce((s, e) => s + e.count, 0);
    expect(total).toBe(MAIN_DECK_SIZE);
    expect(validateMainDeck(entries)).toEqual([]);
  });
});

describe('validateEffigyDeck', () => {
  it('requires exactly 15', () => {
    expect(validateEffigyDeck({ bleeding: 10 })[0]).toMatch(/exactly 15/);
    expect(validateEffigyDeck({ bleeding: 15 })).toEqual([]);
  });

  it('allows any mix of colors, including a single color', () => {
    expect(validateEffigyDeck({ bleeding: 15, timeless: 0, formless: 0, living: 0, shifting: 0 })).toEqual([]);
  });
});

describe('buildMainDeckList / buildEffigyDeckList', () => {
  it('expands counts into individual instances with unique instanceIds', () => {
    const list = buildMainDeckList([{ card: card(), count: 3 }]);
    expect(list).toHaveLength(3);
    expect(new Set(list.map(c => c.instanceId)).size).toBe(3);
  });

  it('builds the requested number of effigies', () => {
    const list = buildEffigyDeckList({ bleeding: 5, timeless: 10, formless: 0, living: 0, shifting: 0 });
    expect(list).toHaveLength(EFFIGY_DECK_SIZE);
    expect(list.filter(e => e.effigyType === 'bleeding')).toHaveLength(5);
  });
});

describe('autoBuildEffigyCounts / randomEffigyColor (AI mono-color deck)', () => {
  it('puts every one of the 15 Effigies into the single given color', () => {
    expect(autoBuildEffigyCounts('bleeding')).toEqual({ bleeding: 15, timeless: 0, formless: 0, living: 0, shifting: 0 });
  });

  it('randomEffigyColor always returns a real Effigy color', () => {
    const EFFIGY_COLORS = ['bleeding', 'timeless', 'formless', 'living', 'shifting'];
    for (let i = 0; i < 20; i++) {
      expect(EFFIGY_COLORS).toContain(randomEffigyColor());
    }
  });
});

describe('autoBuildMainDeckEntries (AI mono-color deck)', () => {
  const being = (overrides = {}) => ({
    id: 'b', kind: 'being', isDeity: false, isToken: false,
    castingCost: { faithless: 1, colored: {} }, ...overrides,
  });

  it('only includes cards colorless or matching the chosen color — a mixed-color card is excluded', () => {
    const pool = [
      being({ id: 'faithless-only', castingCost: { faithless: 2, colored: {} } }),
      being({ id: 'bleeding-only', castingCost: { faithless: 0, colored: { bleeding: 1 } } }),
      being({ id: 'timeless-only', castingCost: { faithless: 0, colored: { timeless: 1 } } }),
      being({ id: 'mixed', castingCost: { faithless: 0, colored: { bleeding: 1, timeless: 1 } } }),
    ];
    const entries = autoBuildMainDeckEntries(pool, 'bleeding');
    const ids = entries.map(e => e.card.id);
    expect(ids).toEqual(expect.arrayContaining(['faithless-only', 'bleeding-only']));
    expect(ids).not.toContain('timeless-only');
    expect(ids).not.toContain('mixed');
  });

  it('Faithless pips alone never gate a card out of any mono-color deck', () => {
    const pool = [being({ id: 'faithless-heavy', castingCost: { faithless: 5, colored: {} } })];
    const entries = autoBuildMainDeckEntries(pool, 'living', () => 0);
    expect(entries.map(e => e.card.id)).toContain('faithless-heavy');
  });

  it('still sums to a legal 40-card deck, respecting the 3/2 copy caps', () => {
    const pool = Array.from({ length: 20 }, (_, i) => being({ id: `c${i}`, castingCost: { faithless: 0, colored: { bleeding: 1 } } }));
    const entries = autoBuildMainDeckEntries(pool, 'bleeding');
    const total = entries.reduce((sum, e) => sum + e.count, 0);
    expect(total).toBe(MAIN_DECK_SIZE);
    expect(validateMainDeck(entries)).toEqual([]);
  });
});

describe('drawCard', () => {
  it('draws the top card', () => {
    const { deck, drawn, penalty } = drawCard([{ instanceId: 'a' }, { instanceId: 'b' }]);
    expect(drawn.instanceId).toBe('a');
    expect(deck).toHaveLength(1);
    expect(penalty).toBe(0);
  });

  it('applies the draw-from-empty penalty instead of throwing', () => {
    const { deck, drawn, penalty } = drawCard([]);
    expect(drawn).toBeNull();
    expect(deck).toEqual([]);
    expect(penalty).toBe(10);
  });
});
