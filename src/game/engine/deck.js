import { EFFIGY_COLORS } from '../../lib/cardData.js';

export const MAIN_DECK_SIZE = 40;
export const MAX_COPIES = 3;
export const MAX_DEITY_COPIES = 2;
export const EFFIGY_DECK_SIZE = 15;
export const STARTING_HAND_SIZE = 5;
export const DRAW_FROM_EMPTY_PENALTY = 10;
export const MULLIGAN_COST = 5;

// entries: [{ card, count }] where card is a toGameCard() result.
export const validateMainDeck = (entries) => {
  const errors = [];
  const total = entries.reduce((sum, e) => sum + e.count, 0);
  if (total !== MAIN_DECK_SIZE) {
    errors.push(`Main Deck must be exactly ${MAIN_DECK_SIZE} cards (currently ${total}).`);
  }
  entries.forEach(({ card, count }) => {
    const limit = card.isDeity ? MAX_DEITY_COPIES : MAX_COPIES;
    if (count > limit) {
      errors.push(`${card.name}: max ${limit} ${card.isDeity ? '(Deity) ' : ''}copies, has ${count}.`);
    }
  });
  return errors;
};

// counts: { bleeding: n, timeless: n, formless: n, living: n, shifting: n }
export const validateEffigyDeck = (counts) => {
  const errors = [];
  const total = EFFIGY_COLORS.reduce((sum, c) => sum + (counts[c] || 0), 0);
  if (total !== EFFIGY_DECK_SIZE) {
    errors.push(`Effigy Deck must be exactly ${EFFIGY_DECK_SIZE} cards (currently ${total}).`);
  }
  return errors;
};

const shuffle = (arr, rng = Math.random) => {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

export const buildMainDeckList = (entries, rng = Math.random) => {
  const cards = [];
  entries.forEach(({ card, count }) => {
    for (let i = 0; i < count; i++) cards.push({ ...card, instanceId: `${card.id}#${i}` });
  });
  return shuffle(cards, rng);
};

let effigyInstanceCounter = 0;
export const buildEffigyDeckList = (counts, rng = Math.random) => {
  const cards = [];
  EFFIGY_COLORS.forEach(color => {
    const n = counts[color] || 0;
    for (let i = 0; i < n; i++) {
      cards.push({
        id: `effigy-${color}`,
        instanceId: `effigy-${color}#${effigyInstanceCounter++}`,
        name: `${color.charAt(0).toUpperCase()}${color.slice(1)} Effigy`,
        kind: 'effigy',
        effigyType: color,
      });
    }
  });
  return shuffle(cards, rng);
};

// Returns { deck, drawn, penalty } — drawing from an empty deck deals the
// draw-from-empty Lifespan penalty instead of throwing.
export const drawCard = (deck) => {
  if (deck.length === 0) return { deck, drawn: null, penalty: DRAW_FROM_EMPTY_PENALTY };
  const [drawn, ...rest] = deck;
  return { deck: rest, drawn, penalty: 0 };
};

// Card kinds the engine can actually play. Ethereal Conjurings are castable
// (CAST_CONJURING treats the two Conjuring kinds identically) but not yet
// castable *reactively* on the opponent's turn — that instant-speed window
// is still a real, separately-tracked gap (RULES.md > Conjurings), not a
// reason to keep them out of deckbuilding entirely; a main-phase-only
// Ethereal Conjuring is still a real, useful card, just not yet as
// flexible as its own printed type promises.
export const PHASE1_PLAYABLE_KINDS = ['being', 'deity', 'prophecy', 'relic', 'relic-armament', 'conjuring', 'ethereal-conjuring', 'altar'];

// A card's colored casting-cost pips (never its Faithless pips — those are
// a wildcard, payable from any color, so they carry no color identity of
// their own) define which mono-color deck(s) it can belong to: a card with
// no colored pips at all fits any color, one with a single colored pip
// fits only that color, and a card mixing two or more colored pips never
// fits a mono-color deck.
const cardColors = (card) =>
  Object.keys(card.castingCost?.colored || {}).filter(c => (card.castingCost.colored[c] || 0) > 0);

// Random legal Main Deck for the AI opponent (or as a quick-start for a
// human who doesn't want to hand-build one) — restricted to a single
// Effigy color's identity (see cardColors above), so every colored card it
// draws is actually payable from its own mono-color Effigy Deck
// (autoBuildEffigyCounts below uses the same `color`).
export const autoBuildMainDeckEntries = (pool, color, rng = Math.random) => {
  const eligible = pool.filter(c =>
    PHASE1_PLAYABLE_KINDS.includes(c.kind) && !c.isToken && cardColors(c).every(cc => cc === color)
  );
  if (eligible.length === 0) return [];
  const entries = eligible.map(card => ({ card, count: 0 }));
  let total = 0;
  let guard = 0;
  while (total < MAIN_DECK_SIZE && guard < 20000) {
    guard++;
    const entry = entries[Math.floor(rng() * entries.length)];
    const limit = entry.card.isDeity ? MAX_DEITY_COPIES : MAX_COPIES;
    if (entry.count < limit) {
      entry.count++;
      total++;
    }
  }
  return entries.filter(e => e.count > 0);
};

// The AI opponent always plays a mono-color Effigy Deck (every one of the
// 15 cards the same color) rather than a random mix — see
// autoBuildMainDeckEntries above for the matching Main Deck restriction.
export const randomEffigyColor = (rng = Math.random) => EFFIGY_COLORS[Math.floor(rng() * EFFIGY_COLORS.length)];

export const autoBuildEffigyCounts = (color) => {
  const counts = {};
  EFFIGY_COLORS.forEach(c => { counts[c] = 0; });
  counts[color] = EFFIGY_DECK_SIZE;
  return counts;
};

// Resolves a preloaded or saved deck's plain name+count list (precons.js,
// or a Library-saved deck record — same shape) against a loaded card pool —
// the same exact-then-case-insensitive name lookup DeckBuilder's own manual
// "Import Deck List" already uses, so either one behaves exactly like a
// hand-picked deck once resolved (and degrades the same way — a
// missing/ineligible card is skipped with a warning, not a thrown error —
// if a custom CSV doesn't happen to carry every card in it).
export const resolveDeckEntries = (pool, precon) => {
  const eligible = pool.filter(c => PHASE1_PLAYABLE_KINDS.includes(c.kind) && !c.isToken);
  const warnings = [];
  const entries = [];
  precon.entries.forEach(({ name, count }) => {
    const found = eligible.find(c => c.name === name) || eligible.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (!found) {
      warnings.push(`"${name}" wasn't found in the loaded card set — skipped.`);
      return;
    }
    const limit = found.isDeity ? MAX_DEITY_COPIES : MAX_COPIES;
    const clamped = Math.max(0, Math.min(limit, count));
    entries.push({ card: found, count: clamped });
  });
  // A precon can print its own explicit multi-color Effigy split (e.g. a
  // deck mixing two colors' Main Deck cards, like "Call of the Void") via
  // `precon.effigyCounts: { <color>: n, ... }` — falls back to the plain
  // mono-color autoBuildEffigyCounts(precon.color) every existing precon
  // already relies on when it's not set.
  return { entries, effigyCounts: precon.effigyCounts || autoBuildEffigyCounts(precon.color), warnings };
};
