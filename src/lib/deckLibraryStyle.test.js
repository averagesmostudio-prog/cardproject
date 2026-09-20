import { describe, it, expect } from 'vitest';
import { EFFIGY_COLORS } from './cardData.js';
import { deriveDominantColor, pickRandomIconKey, getDeckIcon, DECK_ICON_MAP } from './deckLibraryStyle.js';

describe('deriveDominantColor', () => {
  it('picks the highest-count color', () => {
    expect(deriveDominantColor({ bleeding: 2, timeless: 9, formless: 1 })).toBe('timeless');
  });

  it('breaks ties by EFFIGY_COLORS\' own declared order', () => {
    // bleeding is first in EFFIGY_COLORS, so it wins a tie with living.
    expect(deriveDominantColor({ bleeding: 5, living: 5 })).toBe('bleeding');
  });

  it('falls back to the first EFFIGY_COLORS entry when everything is zero/missing', () => {
    expect(deriveDominantColor({})).toBe(EFFIGY_COLORS[0]);
    expect(deriveDominantColor({ bleeding: 0, timeless: 0 })).toBe(EFFIGY_COLORS[0]);
  });
});

describe('pickRandomIconKey', () => {
  it('uses the injected rng to pick a deterministic key', () => {
    expect(pickRandomIconKey(() => 0)).toBe(Object.keys(DECK_ICON_MAP)[0]);
    const lastIdx = Object.keys(DECK_ICON_MAP).length - 1;
    expect(pickRandomIconKey(() => 0.999999)).toBe(Object.keys(DECK_ICON_MAP)[lastIdx]);
  });
});

describe('getDeckIcon', () => {
  it('resolves a known key to its component', () => {
    expect(getDeckIcon('skull')).toBe(DECK_ICON_MAP.skull);
  });

  it('falls back to Shield for an unknown/missing key', () => {
    expect(getDeckIcon('not-a-real-key')).toBe(DECK_ICON_MAP.shield);
    expect(getDeckIcon(undefined)).toBe(DECK_ICON_MAP.shield);
  });
});
