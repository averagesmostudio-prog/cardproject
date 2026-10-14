import { getColumnData } from './cardData.js';

// PackOpener's pack roll, pulled out as pure functions so the odds can be
// simulated and tested without React.

// 2 Rare slots x 1/12 + the Wildcard's 1/30 = ~0.2 Sacred-tier cards per
// pack, i.e. about 6 per 30-pack box.
export const SACRED_UPGRADE_CHANCE = 1 / 12;

// Chance a card drawn into a slot of this tier is swapped for a Historic
// (stylized-art) variant. Derived from per-pack targets of ~17% / 9% / 7% /
// 1.7% across every slot of that tier, Wildcard included — not a flat 10%,
// because a pack has two Rare slots plus the Wildcard.
export const HISTORIC_CHANCE = {
  common: 1 / 40,
  uncommon: 0.028,
  rare: 0.0375,
  sacred: 1 / 12,
};

// Immortal Rare: each Deity's second Historic version. Carved out of the
// Historic Sacred rolls (not added on top): 1/36 of Sacred-tier draws = ~0.0056
// per pack = about 1 per 6 boxes (a case), shared among the 5 Immortals.
export const IMMORTAL_CHANCE = 1 / 36;

// How many cards of each tier get a Historic variant. Sacred is every
// Sacred Rare once, plus a second variant for each Deity.
export const HISTORIC_COUNTS = { common: 20, uncommon: 20, rare: 40 };

export const classifyRarity = (card) => {
  const r = (getColumnData(card, ['Rarity', 'rarity']) || '').toLowerCase().trim();
  if (!r) return null;
  if (r.includes('sacred') || r.includes('mythic') || r === 'sr' || r === 'm') return 'sacred';
  if (r.includes('rare') || r === 'r') return 'rare';
  if (r.includes('uncommon') || r === 'u') return 'uncommon';
  if (r.includes('common') || r === 'c') return 'common';
  return null;
};

const isDeity = (card) =>
  (getColumnData(card, ['Card Typing', 'Card typing']) || '').toLowerCase().includes('deity');

// Stable string hash, so which cards have a Historic variant doesn't change
// between sessions.
const hashName = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
};

const cardName = (card) => getColumnData(card, ['Card Name', 'A', 'Column A']) || '';

// Number of Historic variants a CSV row declares in its optional `Historic`
// column (blank/0 = none, 1 = one variant, 2 = two, e.g. Deities).
const declaredVariants = (card) => {
  const n = parseInt(getColumnData(card, ['Historic', 'historic']) || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// Which cards have a Historic version. Once any CSV row fills in the
// `Historic` column, that list is used exactly. Until then it's a
// placeholder: a fixed hash-ordered subset of each non-Sacred tier, every
// Sacred Rare once, and Deities twice — sized to match the planned 103.
export const buildHistoricPools = (pools) => {
  const out = { common: [], uncommon: [], rare: [], sacred: [], immortal: [] };
  // A Deity's second Historic version is its Immortal Rare.
  const pushSacred = (card, v) => {
    const entry = { ...card, __historic: 'sacred', __historicVariant: v };
    if (v === 2 && isDeity(card)) out.immortal.push({ ...entry, __immortal: true });
    else out.sacred.push(entry);
  };
  const tiers = ['common', 'uncommon', 'rare', 'sacred'];
  const hasDeclared = tiers.some(t => pools[t].some(c => declaredVariants(c) > 0));
  if (hasDeclared) {
    tiers.forEach(tier => pools[tier].forEach(card => {
      for (let v = 1; v <= declaredVariants(card); v++) {
        if (tier === 'sacred') pushSacred(card, v);
        else out[tier].push({ ...card, __historic: tier, __historicVariant: v });
      }
    }));
    return out;
  }
  ['common', 'uncommon', 'rare'].forEach(tier => {
    out[tier] = [...pools[tier]]
      .sort((a, b) => hashName(cardName(a)) - hashName(cardName(b)))
      .slice(0, HISTORIC_COUNTS[tier])
      .map(card => ({ ...card, __historic: tier, __historicVariant: 1 }));
  });
  pools.sacred.forEach(card => {
    pushSacred(card, 1);
    if (isDeity(card)) pushSacred(card, 2);
  });
  return out;
};

// buildHistoricPools sorts every tier, so reuse the result across packs.
const historicCache = new WeakMap();
const getHistoricPools = (pools) => {
  if (!historicCache.has(pools)) historicCache.set(pools, buildHistoricPools(pools));
  return historicCache.get(pools);
};

const pickRandom = (arr, rng) => arr[Math.floor(rng() * arr.length)];

const TIER_LABEL = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', sacred: 'Sacred Rare' };

// Sparkle colour for the reveal: bronze = Historic Common/Uncommon/Rare,
// silver = base Sacred Rare, gold = Historic Sacred Rare, prismatic =
// Immortal Rare.
export const sparkleFor = (card, tier) => {
  if (card.__immortal) return 'immortal';
  if (card.__historic) return tier === 'sacred' ? 'gold' : 'bronze';
  return tier === 'sacred' ? 'silver' : null;
};

// Draws one card from a tier, with the chance of swapping in its Historic
// variant. `label` is the slot's description; Historic cards gain a suffix.
const drawFromTier = (tier, label, { pools, historic, rng }) => {
  // One roll decides the outcome: for Sacred, the lowest slice is Immortal,
  // then the rest of the Historic chance is a regular Historic Sacred.
  const r = rng();
  let card;
  let suffix = '';
  if (tier === 'sacred' && historic.immortal.length > 0 && r < IMMORTAL_CHANCE) {
    card = pickRandom(historic.immortal, rng);
    suffix = ' (Immortal)';
  } else if (historic[tier].length > 0 && r < HISTORIC_CHANCE[tier]) {
    card = pickRandom(historic[tier], rng);
    suffix = ' (Historic)';
  } else {
    card = pickRandom(pools[tier], rng);
  }
  return { card, slot: `${label}${suffix}`, sparkle: sparkleFor(card, tier) };
};

// 14 cards: 6 Common, 3 Uncommon, 2 Rare (1/12 each upgrade to Sacred Rare),
// 1 Wildcard, 1 Basic Effigy, 1 Token. Any slot may then roll Historic.
export const rollPack = ({ pools, tokenPool, makeBasicEffigy, rng = Math.random }) => {
  const ctx = { pools, historic: getHistoricPools(pools), rng };
  const pack = [];
  for (let i = 0; i < 6; i++) pack.push(drawFromTier('common', 'Common', ctx));
  for (let i = 0; i < 3; i++) pack.push(drawFromTier('uncommon', 'Uncommon', ctx));
  for (let i = 0; i < 2; i++) {
    const upgraded = pools.sacred.length > 0 && rng() < SACRED_UPGRADE_CHANCE;
    pack.push(upgraded
      ? drawFromTier('sacred', 'Rare → Sacred Rare', ctx)
      : drawFromTier('rare', 'Rare', ctx));
  }

  // Wildcard: Sacred 1/30, Rare 1/30, Uncommon 1/5, the rest Common.
  const roll = rng();
  let tier = 'common';
  if (roll < 1 / 30 && pools.sacred.length > 0) tier = 'sacred';
  else if (roll < 2 / 30) tier = 'rare';
  else if (roll < 2 / 30 + 1 / 5) tier = 'uncommon';
  pack.push(drawFromTier(tier, `Wildcard (${TIER_LABEL[tier]})`, ctx));

  pack.push({ card: makeBasicEffigy(), slot: 'Basic Effigy', sparkle: null });
  pack.push({ card: pickRandom(tokenPool, rng), slot: 'Token', sparkle: null });
  return pack;
};
