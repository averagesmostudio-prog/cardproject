import { describe, it, expect } from 'vitest';
import { classifyRarity, rollPack, buildHistoricPools, HISTORIC_COUNTS } from './packRoll.js';

const make = (n, rarity, extra = {}) =>
  Array.from({ length: n }, (_, i) => ({ 'Card Name': `${rarity}${i}`, Rarity: rarity, 'Card Typing': 'Being', ...extra }));

const cards = [
  ...make(138, 'C'), ...make(90, 'U'), ...make(54, 'R'), ...make(13, 'Sacred'),
  ...make(5, 'Sacred', { 'Card Typing': 'Being, Deity' }).map((c, i) => ({ ...c, 'Card Name': `Deity${i}` })),
];
const pools = { common: [], uncommon: [], rare: [], sacred: [] };
cards.forEach(c => pools[classifyRarity(c)].push(c));
const tokenPool = [{ 'Card Name': 'Tok', 'Card Typing': 'Token' }];
const effigy = () => ({ 'Card Name': 'Basic Effigy' });

describe('Historic pools', () => {
  it('match the 20/20/40 counts, with Sacred at 13 + 5 Deity Historics and 5 Immortals', () => {
    const h = buildHistoricPools(pools);
    expect(h.common.length).toBe(HISTORIC_COUNTS.common);
    expect(h.uncommon.length).toBe(HISTORIC_COUNTS.uncommon);
    expect(h.rare.length).toBe(HISTORIC_COUNTS.rare);
    expect(h.sacred.length).toBe(18);
    expect(h.immortal.length).toBe(5);
  });
});

describe('Historic column override', () => {
  it('uses exactly the rows that declare variants', () => {
    const p = { common: make(5, 'C'), uncommon: make(5, 'U'), rare: make(5, 'R'), sacred: make(3, 'Sacred') };
    p.common[0].Historic = '1';
    p.rare[2].Historic = '1';
    p.sacred[1].Historic = '2';
    const h = buildHistoricPools(p);
    expect(h.common.length).toBe(1);
    expect(h.uncommon.length).toBe(0);
    expect(h.rare.length).toBe(1);
    // Non-Deity Sacred with Historic=2 are plain Historic versions.
    expect(h.sacred.length).toBe(2);
    expect(h.immortal.length).toBe(0);
  });
});

describe('rollPack', () => {
  it('makes 14 cards and hits the per-pack Historic and sparkle rates', () => {
    const N = 100000;
    let hist = { Common: 0, Uncommon: 0, Rare: 0, Sacred: 0 };
    let silver = 0;
    let immortal = 0;
    for (let i = 0; i < N; i++) {
      const pack = rollPack({ pools, tokenPool, makeBasicEffigy: effigy });
      expect(pack.length).toBe(14);
      let seen = new Set();
      pack.forEach(({ card, sparkle }) => {
        if (card.__historic) seen.add(card.__historic);
        if (sparkle === 'silver') silver++;
        if (sparkle === 'immortal') immortal++;
      });
      const flags = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', sacred: 'Sacred' };
      seen.forEach(t => hist[flags[t]]++);
    }
    expect(hist.Common / N).toBeGreaterThan(0.14);
    expect(hist.Common / N).toBeLessThan(0.17);
    expect(hist.Uncommon / N).toBeGreaterThan(0.08);
    expect(hist.Uncommon / N).toBeLessThan(0.1);
    expect(hist.Rare / N).toBeGreaterThan(0.06);
    expect(hist.Rare / N).toBeLessThan(0.08);
    expect(hist.Sacred / N).toBeGreaterThan(0.0135);
    expect(hist.Sacred / N).toBeLessThan(0.0200);
    // Immortal: ~1 per 6 boxes = 0.0056 per pack.
    expect(immortal / N).toBeGreaterThan(0.0045);
    expect(immortal / N).toBeLessThan(0.0068);
    // Base Sacred (silver) ~0.19 per pack, so ~6 Sacred-tier cards per 30-pack box.
    expect(silver / N).toBeGreaterThan(0.17);
    expect(silver / N).toBeLessThan(0.21);
  }, 30000);

  it('maps sparkle tiers: bronze for Historic non-Sacred, gold for Historic Sacred', () => {
    for (let i = 0; i < 20000; i++) {
      rollPack({ pools, tokenPool, makeBasicEffigy: effigy }).forEach(({ card, sparkle }) => {
        if (card.__immortal) expect(sparkle).toBe('immortal');
        else if (card.__historic === 'sacred') expect(sparkle).toBe('gold');
        else if (card.__historic) expect(sparkle).toBe('bronze');
      });
    }
  }, 30000);
});
