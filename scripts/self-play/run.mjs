// AI-vs-AI self-play simulation harness for Scripturas Alpha.
//
// Plays as many full games as fit in a wall-clock time budget, using the
// REAL engine code (no UI) — same gameReducer/pickAiAction/pickAiReaction
// a live match uses. Goals: surface crashes/soft-locks/suspected infinite
// loops, and rank individual cards' own IMPACT on win rate (see cardStats'
// own comment) — included-vs-excluded, not a raw win rate, which stays
// deeply confounded by whatever OTHER cards a deck-building process
// happens to pair a card with. Evolved mono-color, hybrid (2-color), AND
// triple (3-color) decks are built by ranking each color combo's card pool
// on that impact, PLUS independent per-card random noise (RANK_NOISE — see
// fillDeckEntries' own comment for why the noise is the actual fix, not
// just extra randomness). The 6 precon decks in src/game/decks/precons.js,
// and any user-provided deck exports dropped in ./uploaded-decks/, are only
// ever READ (resolveDeckEntries) — every evolved/hybrid/triple deck built
// here is a fresh, in-memory-only entries list, never written back to
// precons.js, uploaded-decks/, or any other tracked file.
//
// Must be run with vite-node (not plain `node`) — cardData.js references
// import.meta.env.BASE_URL at module load time, which only vite-node's
// transform (the same one Vitest uses) populates.
//
//   node_modules/.bin/vite-node scripts/self-play/run.mjs [--minutes=N] [--out=DIR]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCSV, toGameCard, EFFIGY_COLORS } from '../../src/lib/cardData.js';
import { createInitialState, gameReducer } from '../../src/game/engine/actions.js';
import {
  buildMainDeckList, buildEffigyDeckList, autoBuildMainDeckEntries,
  autoBuildEffigyCounts, randomEffigyColor, resolveDeckEntries, MAIN_DECK_SIZE,
  MAX_COPIES, MAX_DEITY_COPIES, EFFIGY_DECK_SIZE,
} from '../../src/game/engine/deck.js';
import { pickAiAction, pickAiReaction } from '../../src/game/engine/ai.js';
import { PRECON_DECKS } from '../../src/game/decks/precons.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const MINUTES = Number(args.minutes || 180); // default: 3 hours
const OUT_DIR = args.out || path.join(REPO_ROOT, 'scripts/self-play/out');
const MAX_TURNS = 400; // a real game realistically ends well under this
const MAX_ACTIONS = 4000; // guards a pendingChoice loop that never advances turnNumber
const CHECKPOINT_EVERY_MS = 60_000;

fs.mkdirSync(OUT_DIR, { recursive: true });
const gamesPath = path.join(OUT_DIR, 'games.jsonl');
const crashesPath = path.join(OUT_DIR, 'crashes.jsonl');
const loopsPath = path.join(OUT_DIR, 'suspected-loops.jsonl');
const summaryPath = path.join(OUT_DIR, 'summary.json');
// Plain fs.appendFileSync, not fs.createWriteStream — a WriteStream buffers
// internally and only actually creates/flushes the file to disk once
// enough data backs up or .end() runs. A hard kill (SIGKILL, no time to
// run the loop's own final .end() calls) loses everything still sitting
// in that buffer — confirmed directly: a stream test showed the target
// file didn't exist on disk at all after 5 synchronous-looking writes,
// only after .end()'s callback fired. appendFileSync's own write()
// syscall completes before the call returns, so every game record that
// finishes logging is durably on disk immediately, independent of how the
// process eventually stops.

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// ---------- card pool ----------
const csvText = fs.readFileSync(path.join(REPO_ROOT, 'public/default-card-set.csv'), 'utf-8');
const pool = parseCSV(csvText).map((row, idx) => toGameCard(row, idx));
log(`Loaded ${pool.length} cards from default-card-set.csv`);

// ---------- deck sources ----------
// Precons are only ever resolved (read), never mutated.
const preconDeckFor = (precon) => {
  const { entries, effigyCounts } = resolveDeckEntries(pool, precon);
  return { mainDeck: buildMainDeckList(entries), effigyDeck: buildEffigyDeckList(effigyCounts), label: `precon:${precon.id}` };
};

// ---------- uploaded decks (user-provided deck exports — never modified) ----------
// Dropped as plain {format:'tcg-deck', mainDeck:[{name,count}]} export files
// (DeckBuilder's own "Export deck list" shape) into ./uploaded-decks/ — read
// here, resolved against the pool by name (same lookup resolveDeckEntries
// gives the real app's own Import Deck List), and played alongside every
// other deck source below. Read-only: nothing here ever writes back to
// uploaded-decks/, precons.js, or the Deck Library.
const UPLOADED_DECKS_DIR = path.join(__dirname, 'uploaded-decks');
// A plain deck-list export has no Effigy composition of its own (that's a
// separate, per-player build choice in the real app) — supplied here per
// the user's own explicit instructions rather than guessed. `variants`
// lets one deck list be tested under more than one Effigy split at once
// (the user's own "pivot between 8/7 and 7/8" ask for winnertorusdeck) —
// each variant gets its own distinct label so its win rate is tracked
// separately, never blended together.
const UPLOADED_DECK_CONFIG = {
  DoubtsTest: { variants: [{ suffix: '', effigyCounts: { shifting: 15 } }] },
  SeedsTest: { variants: [{ suffix: '', effigyCounts: { living: 15 } }] },
  winnertorusdeck: {
    variants: [
      { suffix: ':8timeless-7shifting', effigyCounts: { timeless: 8, shifting: 7 } },
      { suffix: ':7timeless-8shifting', effigyCounts: { timeless: 7, shifting: 8 } },
    ],
  },
  // BonesTest/ComboTest/FormlessTest/RatsTest/SwordsTest/TimelessTest are
  // each byte-for-byte the same card list as an existing precon (Graveyard
  // Bash/Call of the Void/Famished Phantoms/Plague Rats/Armed and Ready/
  // Tick Tock respectively — precons.js) — Effigy splits below mirror
  // those precons' own exactly, for the same reason: these add no new deck
  // shape to test, just another equally-weighted sample of an already-
  // tracked one under a second label, included per the user's own request
  // rather than silently deduplicated away.
  BonesTest: { variants: [{ suffix: '', effigyCounts: { shifting: 15 } }] },
  ComboTest: { variants: [{ suffix: '', effigyCounts: { formless: 8, timeless: 7 } }] },
  FormlessTest: { variants: [{ suffix: '', effigyCounts: { formless: 15 } }] },
  RatsTest: { variants: [{ suffix: '', effigyCounts: { living: 8, shifting: 7 } }] },
  SwordsTest: { variants: [{ suffix: '', effigyCounts: { bleeding: 15 } }] },
  TimelessTest: { variants: [{ suffix: '', effigyCounts: { timeless: 15 } }] },
  // An earlier draft of the Lamtukka (Formless/Hunger-tribal) build pulled
  // from the app's own Deck Library — distinct card list from Lamtukka.json
  // above, worth its own separate track rather than assuming it's obsolete.
  lamtukatest: { variants: [{ suffix: '', effigyCounts: { formless: 15 } }] },
};
const loadUploadedDecks = () => {
  const decks = [];
  if (!fs.existsSync(UPLOADED_DECKS_DIR)) return decks;
  for (const file of fs.readdirSync(UPLOADED_DECKS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const base = file.slice(0, -'.json'.length);
    const raw = JSON.parse(fs.readFileSync(path.join(UPLOADED_DECKS_DIR, file), 'utf-8'));
    const rawEntries = raw.mainDeck || raw.entries || [];
    // A real Deck-Library-saved record (pulled straight from the app's own
    // localStorage, e.g. Lamtukka) already carries its own effigyCounts —
    // self-contained, no config entry needed. A plain "Export deck list"
    // file (DoubtsTest/SeedsTest/winnertorusdeck) has no Effigy composition
    // of its own, so it needs one supplied via UPLOADED_DECK_CONFIG instead.
    const variants = raw.effigyCounts
      ? [{ suffix: '', effigyCounts: raw.effigyCounts }]
      : UPLOADED_DECK_CONFIG[base]?.variants;
    if (!variants) {
      log(`Uploaded deck file "${file}" has no effigyCounts of its own and no entry in UPLOADED_DECK_CONFIG — skipped.`);
      continue;
    }
    variants.forEach((variant) => {
      const { entries, warnings } = resolveDeckEntries(pool, { entries: rawEntries, effigyCounts: variant.effigyCounts });
      warnings.forEach((w) => log(`Uploaded deck "${base}": ${w}`));
      decks.push({
        mainDeck: buildMainDeckList(entries),
        effigyDeck: buildEffigyDeckList(variant.effigyCounts),
        label: `uploaded:${base}${variant.suffix}`,
      });
    });
  }
  return decks;
};
const uploadedDecks = loadUploadedDecks();
log(`Loaded ${uploadedDecks.length} uploaded deck build(s): ${uploadedDecks.map((d) => d.label).join(', ') || '(none)'}`);
const uploadedDeckFor = () => uploadedDecks[Math.floor(Math.random() * uploadedDecks.length)];
// entries/eligiblePool are attached so playOneGame can feed this deck's
// choices into the included-vs-excluded card stats below — a plain random
// pick is actually the CLEANEST possible sample for that comparison (truly
// unbiased, no score-based influence at all), so it isn't wasted.
// `pairKey: color` (mirroring the hybrid/triple/faithless archetypes below)
// is what makes bumpPairStats track a single Effigy typing's own OVERALL
// win rate — the "best/worst effigy typing" question — not just its
// individual cards' impact within that color.
const randomDeckFor = (color) => {
  const eligiblePool = eligibleFor(color);
  const entries = autoBuildMainDeckEntries(pool, color);
  return { mainDeck: buildMainDeckList(entries), effigyDeck: buildEffigyDeckList(autoBuildEffigyCounts(color)), label: `random:${color}`, entries, eligiblePool, pairKey: color };
};

// Per-card IMPACT tracking, used to evolve a candidate deck per color (and
// per hybrid color pair, below). A plain win rate isn't enough on its own:
// see fillDeckEntries' own comment for the full story, but in short, every
// card near the top of a color's ranking ends up almost always played
// TOGETHER (correlated), so their raw win rates converge to "how good is
// this deck shape" rather than "how good is this one card" — confirmed
// empirically, every card in a reported top-12 landing on the identical
// win rate even after several rounds of trying to fix it with more random
// exploration. The actual fix is this: every eligible card in a color's
// pool gets EITHER its `included` or `excluded` counters bumped every
// single game (never both) — whether it made this specific deck or not —
// and a card's own IMPACT is included win rate minus excluded win rate:
// how much better decks do WITH it than decks (drawn from that exact same
// pool, by that exact same process) WITHOUT it. That's a real
// difference-in-means estimate, and it's only valid because
// fillDeckEntries' own per-card independent noise (not a shared per-slot
// coin flip) makes inclusion close to independently randomized card by
// card — the same logic a randomized controlled trial relies on to
// isolate one variable's own effect from its usual company. Laplace-
// smoothed (wins+1)/(games+2) on each side so a handful of games doesn't
// get ranked on pure noise.
const cardStats = new Map(); // name -> { gamesIncluded, winsIncluded, gamesExcluded, winsExcluded }
const bumpCardStats = (eligiblePool, includedEntries, won) => {
  const includedIds = new Set(includedEntries.map((e) => e.card.id));
  eligiblePool.forEach((card) => {
    const s = cardStats.get(card.name) || { gamesIncluded: 0, winsIncluded: 0, gamesExcluded: 0, winsExcluded: 0 };
    if (includedIds.has(card.id)) {
      s.gamesIncluded += 1;
      if (won) s.winsIncluded += 1;
    } else {
      s.gamesExcluded += 1;
      if (won) s.winsExcluded += 1;
    }
    cardStats.set(card.name, s);
  });
};
const winRateIncluded = (name) => {
  const s = cardStats.get(name);
  return !s || s.gamesIncluded === 0 ? 0.5 : (s.winsIncluded + 1) / (s.gamesIncluded + 2);
};
const winRateExcluded = (name) => {
  const s = cardStats.get(name);
  return !s || s.gamesExcluded === 0 ? 0.5 : (s.winsExcluded + 1) / (s.gamesExcluded + 2);
};
const impactOf = (name) => winRateIncluded(name) - winRateExcluded(name);

// Same per-color-pair tracking for hybrid (2-color) evolved decks —
// "how well does formless+timeless do together", not any single card's own
// rate. Keyed by the two colors sorted and joined, so order never matters.
// No correlation problem here (this is a whole-archetype win rate, not a
// per-card one), so a plain win rate is already the right statistic.
const pairStats = new Map(); // "colorA+colorB" -> { games, wins }
const bumpPairStats = (pairKey, won) => {
  const s = pairStats.get(pairKey) || { games: 0, wins: 0 };
  s.games += 1;
  if (won) s.wins += 1;
  pairStats.set(pairKey, s);
};
const pairWinRate = (pairKey) => {
  const s = pairStats.get(pairKey);
  return s ? (s.wins + 1) / (s.games + 2) : 0.5;
};

// Every exact deck BUILD's own overall win rate, keyed by its label
// (precon:swords, uploaded:Lamtukka, evolved:shifting, evolved-hybrid:
// bleeding+shifting, evolved-triple:..., random:faithless, ...) — the
// "what is the seemingly best deck overall" question, spanning every deck
// source uniformly (unlike pairStats, which only covers the archetype
// tracks that have a pairKey). Bumped for literally every deck played.
const labelStats = new Map(); // label -> { games, wins }
const bumpLabelStats = (label, won) => {
  const s = labelStats.get(label) || { games: 0, wins: 0 };
  s.games += 1;
  if (won) s.wins += 1;
  labelStats.set(label, s);
};
const labelWinRate = (label) => {
  const s = labelStats.get(label);
  return s ? (s.wins + 1) / (s.games + 2) : 0.5;
};

// A Faithless-only card is eligible for EVERY mono-color deck, EVERY
// hybrid pair, AND the dedicated faithless track (eligibleFor() below is
// vacuously true for it regardless of which colors are asked for) — far
// more different deck contexts than any colored card ever sees (only its
// own mono pool + the ≤4 hybrid pairs involving its own color). Its
// "excluded" comparison group in, say, a bleeding deck is a completely
// different population than in the dedicated faithless track, so it keeps
// its own separately-scoped impact tally, same shape as cardStats above,
// bumped only by the dedicated faithless track — never by a colored/hybrid
// deck that happened to include one as filler.
const faithlessCardStats = new Map();
const bumpFaithlessCardStats = (eligiblePool, includedEntries, won) => {
  const includedIds = new Set(includedEntries.map((e) => e.card.id));
  eligiblePool.forEach((card) => {
    const s = faithlessCardStats.get(card.name) || { gamesIncluded: 0, winsIncluded: 0, gamesExcluded: 0, winsExcluded: 0 };
    if (includedIds.has(card.id)) {
      s.gamesIncluded += 1;
      if (won) s.winsIncluded += 1;
    } else {
      s.gamesExcluded += 1;
      if (won) s.winsExcluded += 1;
    }
    faithlessCardStats.set(card.name, s);
  });
};
const faithlessWinRateIncluded = (name) => {
  const s = faithlessCardStats.get(name);
  return !s || s.gamesIncluded === 0 ? 0.5 : (s.winsIncluded + 1) / (s.gamesIncluded + 2);
};
const faithlessWinRateExcluded = (name) => {
  const s = faithlessCardStats.get(name);
  return !s || s.gamesExcluded === 0 ? 0.5 : (s.winsExcluded + 1) / (s.gamesExcluded + 2);
};
const faithlessImpactOf = (name) => faithlessWinRateIncluded(name) - faithlessWinRateExcluded(name);

const EVOLVABLE_KINDS = ['being', 'deity', 'prophecy', 'relic', 'relic-armament', 'conjuring', 'ethereal-conjuring', 'altar'];
// Every colored pip on the card must be one of the allowed colors — a
// Faithless-only card (no colored pips at all) always qualifies for any
// deck, mono or hybrid, same as the real deckbuilder's own cardColors rule
// (deck.js). One argument = the old mono-color eligibility; two = hybrid.
const eligibleFor = (...allowedColors) => pool.filter((c) =>
  EVOLVABLE_KINDS.includes(c.kind) && !c.isToken
  && Object.keys(c.castingCost?.colored || {})
    .filter((cc) => (c.castingCost.colored[cc] || 0) > 0)
    .every((cc) => allowedColors.includes(cc)));

// Ranks `eligible` by impactFn(name) PLUS independent per-card noise, then
// greedily fills 40 slots respecting copy limits. The noise is the actual
// fix for the correlation problem described above cardStats: the old
// approach (a shared per-SLOT coin flip deciding "take the next-ranked
// card, or a uniformly random one") still kept the top-ranked cards
// correlated with each other, since when the coin said "ranked", EVERY top
// card got taken together — tried at two different flip rates (15%, then
// 40%), neither broke the correlation. Giving each card its OWN
// independent random nudge before sorting reshuffles which specific ~14
// cards make a color's cut from one build to the next largely
// independently card-by-card, which is what makes the included-vs-excluded
// comparison above (impactOf) a valid estimate instead of noise.
// `noiseScale = 0` (writeSummary's own reporting calls) reproduces a pure-
// impact ranking with no perturbation — only deck SELECTION for actually-
// played games needs the noise; the reported ranking itself never does.
const RANK_NOISE = 0.35;
const fillDeckEntries = (eligible, rng, noiseScale, impactFn = impactOf) => {
  if (eligible.length === 0) return [];
  const ranked = eligible
    .map((card) => ({ card, score: impactFn(card.name) + (rng() - 0.5) * 2 * noiseScale }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.card);
  const limitFor = (c) => (c.isDeity ? MAX_DEITY_COPIES : MAX_COPIES);
  const entries = [];
  let total = 0;
  for (const card of ranked) {
    if (total >= MAIN_DECK_SIZE) break;
    const count = Math.min(limitFor(card), MAIN_DECK_SIZE - total);
    if (count <= 0) continue;
    entries.push({ card, count });
    total += count;
  }
  return entries;
};

// Builds the current best-known deck for `color` from observed impact.
// eligiblePool is attached so playOneGame can bump the included-vs-
// excluded comparison for every card in the pool, not just the ones that
// made this particular build.
const evolvedDeckFor = (color) => {
  const eligiblePool = eligibleFor(color);
  const entries = fillDeckEntries(eligiblePool, Math.random, RANK_NOISE);
  return { mainDeck: buildMainDeckList(entries), effigyDeck: buildEffigyDeckList(autoBuildEffigyCounts(color)), label: `evolved:${color}`, entries, eligiblePool, pairKey: color };
};

// Multi-color (hybrid 2-color, or triple 3-color) evolution — same evolved-
// deck idea as evolvedDeckFor, just drawing from cards restricted to ANY of
// `colors` instead of one (2-color mirrors "Call of the Void"/"Plague
// Rats", precons.js — a real, user-confirmed-good archetype shape, not a
// hypothetical; 3-color has no existing precon precedent, but the user
// explicitly wants it tested regardless of whether it turns out good).
// Its own Effigy Deck is a proportional split of the 15 slots by how much
// each color's pips are actually demanded across the evolved entries, not
// an even split — the same idea 2-color precons' own hand-picked splits
// (8/7) follow, generalized to N colors. Every color is guaranteed at
// least 1 slot so a 3-color deck never silently degrades to fewer colors
// than requested.
const multiColorEffigyCounts = (colors, entries) => {
  const counts = {};
  EFFIGY_COLORS.forEach((c) => { counts[c] = 0; });
  const demand = {};
  colors.forEach((c) => { demand[c] = 0; });
  entries.forEach(({ card, count }) => {
    colors.forEach((c) => { demand[c] += (card.castingCost?.colored?.[c] || 0) * count; });
  });
  const totalDemand = colors.reduce((sum, c) => sum + demand[c], 0);
  let remaining = EFFIGY_DECK_SIZE;
  colors.forEach((c, i) => {
    const isLast = i === colors.length - 1;
    const share = totalDemand > 0 ? Math.round(EFFIGY_DECK_SIZE * demand[c] / totalDemand) : Math.round(EFFIGY_DECK_SIZE / colors.length);
    // Keep every color real (>= 1) and never overshoot what's left, so the
    // final color's own share always exactly finishes the deck at 15.
    const count = isLast ? remaining : Math.max(1, Math.min(remaining - (colors.length - i - 1), share));
    counts[c] = count;
    remaining -= count;
  });
  return counts;
};
const evolvedMultiColorDeckFor = (colors, labelPrefix) => {
  const eligiblePool = eligibleFor(...colors);
  const entries = fillDeckEntries(eligiblePool, Math.random, RANK_NOISE);
  const pairKey = [...colors].sort().join('+');
  return {
    mainDeck: buildMainDeckList(entries),
    effigyDeck: buildEffigyDeckList(multiColorEffigyCounts(colors, entries)),
    label: `${labelPrefix}:${pairKey}`, entries, pairKey, eligiblePool,
  };
};
const evolvedHybridDeckFor = (colorA, colorB) => evolvedMultiColorDeckFor([colorA, colorB], 'evolved-hybrid');
const evolvedTripleDeckFor = (colorA, colorB, colorC) => evolvedMultiColorDeckFor([colorA, colorB, colorC], 'evolved-triple');
const ALL_COLOR_PAIRS = EFFIGY_COLORS.flatMap((a, i) => EFFIGY_COLORS.slice(i + 1).map((b) => [a, b]));
// C(5,3) = 10 distinct 3-color combinations — per the user's own framing
// ("3 or more colors may be bad, but it is worth testing"), capped at 3
// (not 4+) so each combination still gets a meaningful sample size within
// the run's time budget rather than spreading too thin.
const ALL_COLOR_TRIPLES = EFFIGY_COLORS.flatMap((a, i) =>
  EFFIGY_COLORS.slice(i + 1).flatMap((b, j) =>
    EFFIGY_COLORS.slice(i + 1 + j + 1).map((c) => [a, b, c])));

// A fully Faithless (colorless) deck — every Main Deck card costs only
// Faithless pips, no colored ones at all (eligibleFor() with zero color
// arguments: the "every colored pip must be one of the allowed colors"
// check is vacuously true only when a card HAS no colored pips, so this
// reuses the exact same eligibility helper with nothing to allow). Still
// needs a real Effigy Deck to pay those Faithless costs — Faithless is a
// wildcard payable from ANY Effigy color (deck.js's own cardColors rule,
// confirmed by an existing test), so which color it is doesn't matter
// mechanically; picked at random each build purely so the harness doesn't
// silently bias toward one particular color's Effigy supply.
const FAITHLESS_ARCHETYPE_KEY = 'faithless-only';
// Same weighted-random-fill algorithm autoBuildMainDeckEntries (deck.js)
// uses, just generalized to an arbitrary eligible list instead of a single
// required color — that helper's own color filter can't express "colored
// pips forbidden entirely" (any color value it's given vacuously passes a
// Faithless-only card, so it'd also pull in real `color`-costed cards).
const randomEntriesFrom = (eligible, rng = Math.random) => {
  if (eligible.length === 0) return [];
  const entries = eligible.map((card) => ({ card, count: 0 }));
  let total = 0, guard = 0;
  while (total < MAIN_DECK_SIZE && guard < 20_000) {
    guard++;
    const entry = entries[Math.floor(rng() * entries.length)];
    const limit = entry.card.isDeity ? MAX_DEITY_COPIES : MAX_COPIES;
    if (entry.count < limit) { entry.count++; total++; }
  }
  return entries.filter((e) => e.count > 0);
};
const randomFaithlessDeckFor = () => {
  const eligiblePool = eligibleFor();
  const entries = randomEntriesFrom(eligiblePool);
  return { mainDeck: buildMainDeckList(entries), effigyDeck: buildEffigyDeckList(autoBuildEffigyCounts(randomEffigyColor())), label: 'random:faithless', entries, pairKey: FAITHLESS_ARCHETYPE_KEY, eligiblePool };
};
const evolvedFaithlessDeckFor = () => {
  // faithlessImpactOf, not the shared impactOf — see its own comment.
  const eligiblePool = eligibleFor();
  const entries = fillDeckEntries(eligiblePool, Math.random, RANK_NOISE, faithlessImpactOf);
  return { mainDeck: buildMainDeckList(entries), effigyDeck: buildEffigyDeckList(autoBuildEffigyCounts(randomEffigyColor())), label: 'evolved:faithless', entries, pairKey: FAITHLESS_ARCHETYPE_KEY, eligiblePool };
};

// Whether to reserve a share of games for the uploaded decks at all — only
// meaningful once at least one was actually found in ./uploaded-decks/.
const HAS_UPLOADED = uploadedDecks.length > 0;
const pickDeck = (gamesPlayed) => {
  const r = Math.random();
  let t = 0;
  t += 0.15;
  if (r < t) return preconDeckFor(PRECON_DECKS[Math.floor(Math.random() * PRECON_DECKS.length)]);
  if (HAS_UPLOADED) {
    t += 0.05;
    if (r < t) return uploadedDeckFor();
  }
  // Every evolution/archetype track below needs real signal first — plain
  // random for its own warm-up stretch (hybrid/triple/faithless each need
  // more games than a solo color: hybrid covers 10 color pairs, triple
  // covers 10 color triples, faithless is competing for slots against
  // every colored card's own deck too), then mixed in for real.
  t += HAS_UPLOADED ? 0.40 : 0.45; // mono-color: random + evolved
  if (r < t) {
    if (gamesPlayed < 200) return randomDeckFor(randomEffigyColor());
    return evolvedDeckFor(randomEffigyColor());
  }
  t += 0.20; // hybrid (2-color)
  if (r < t) {
    if (gamesPlayed < 400) return randomDeckFor(randomEffigyColor());
    const [colorA, colorB] = ALL_COLOR_PAIRS[Math.floor(Math.random() * ALL_COLOR_PAIRS.length)];
    return evolvedHybridDeckFor(colorA, colorB);
  }
  t += 0.12; // triple (3-color) — per the user's own "worth testing" ask
  if (r < t) {
    if (gamesPlayed < 400) return randomDeckFor(randomEffigyColor());
    const [colorA, colorB, colorC] = ALL_COLOR_TRIPLES[Math.floor(Math.random() * ALL_COLOR_TRIPLES.length)];
    return evolvedTripleDeckFor(colorA, colorB, colorC);
  }
  // Remaining share -> faithless (colorless).
  if (gamesPlayed < 300) return randomFaithlessDeckFor();
  return evolvedFaithlessDeckFor();
};

// ---------- AI turn-ownership logic (mirrors useGameEngine.js exactly) ----------
const actionFor = (state, playerId) => {
  const owesChoice = state.pendingChoice?.playerId === playerId;
  const owesReaction = state.reactiveWindow?.openFor === playerId;
  const isTurn = (state.phase === 'mulligan' && !state.players[playerId].keptHand)
    || (state.phase === 'playing' && state.turnPlayer === playerId);
  if (state.pendingChoice && !owesChoice) return null;
  if (!owesChoice && !isTurn && !owesReaction) return null;
  return owesReaction ? pickAiReaction(state, playerId) : pickAiAction(state, playerId);
};

// ---------- one game ----------
let gameCounter = 0;
const playOneGame = () => {
  const id = ++gameCounter;
  const startingPlayer = Math.random() < 0.5 ? 'A' : 'B';
  const deckA = pickDeck(id);
  const deckB = pickDeck(id);
  const trace = [];
  let state = createInitialState({
    mainDeckA: deckA.mainDeck, effigyDeckA: deckA.effigyDeck,
    mainDeckB: deckB.mainDeck, effigyDeckB: deckB.effigyDeck,
    startingPlayer,
  });

  let actionCount = 0;
  const start = Date.now();
  try {
    // Mulligan phase — always keep (a real mulligan-quality heuristic is a
    // separate, later improvement; this harness's own goal is coverage and
    // bug-finding, not "the AI plays a perfect opening").
    state = gameReducer(state, { type: 'KEEP_HAND', player: 'A' });
    state = gameReducer(state, { type: 'KEEP_HAND', player: 'B' });

    let lastTurnNumber = state.turnNumber;
    let sameTurnStreak = 0;
    while (state.phase !== 'gameover' && actionCount < MAX_ACTIONS) {
      let acted = false;
      for (const p of ['A', 'B']) {
        const action = actionFor(state, p);
        if (!action) continue;
        trace.push({ p, action: action.type });
        state = gameReducer(state, action);
        actionCount++;
        acted = true;
        break;
      }
      if (!acted) break; // neither side owes an action and it isn't gameover — a real stall
      if (state.turnNumber === lastTurnNumber) {
        sameTurnStreak++;
      } else {
        sameTurnStreak = 0;
        lastTurnNumber = state.turnNumber;
      }
      // A turn number that never advances despite hundreds of actions is
      // the real infinite-loop signature (MAX_TURNS alone wouldn't catch a
      // loop stuck resolving pendingChoices within a single turn).
      if (sameTurnStreak > 800) break;
      if (state.turnNumber > MAX_TURNS) break;
    }
  } catch (err) {
    fs.appendFileSync(crashesPath, JSON.stringify({
      id, deckA: deckA.label, deckB: deckB.label, startingPlayer,
      error: { message: err.message, stack: err.stack },
      trace: trace.slice(-40), // last 40 actions leading up to the crash
      stateSnapshot: safeSnapshot(state),
    }) + '\n');
    return { crashed: true };
  }

  const durationMs = Date.now() - start;
  const stalled = state.phase !== 'gameover';
  if (stalled) {
    fs.appendFileSync(loopsPath, JSON.stringify({
      id, deckA: deckA.label, deckB: deckB.label, startingPlayer,
      turnNumber: state.turnNumber, actionCount, durationMs,
      trace: trace.slice(-60),
      stateSnapshot: safeSnapshot(state),
    }) + '\n');
  }

  // The Faithless archetype (pairKey === FAITHLESS_ARCHETYPE_KEY) bumps its
  // own separately-scoped tally instead — see faithlessCardStats' own
  // comment for why it needs a dedicated included-vs-excluded comparison
  // rather than sharing the colored one.
  if (deckA.entries && deckA.pairKey !== FAITHLESS_ARCHETYPE_KEY) bumpCardStats(deckA.eligiblePool, deckA.entries, state.winner === 'A');
  if (deckB.entries && deckB.pairKey !== FAITHLESS_ARCHETYPE_KEY) bumpCardStats(deckB.eligiblePool, deckB.entries, state.winner === 'B');
  if (deckA.pairKey) bumpPairStats(deckA.pairKey, state.winner === 'A');
  if (deckB.pairKey) bumpPairStats(deckB.pairKey, state.winner === 'B');
  if (deckA.pairKey === FAITHLESS_ARCHETYPE_KEY) bumpFaithlessCardStats(deckA.eligiblePool, deckA.entries, state.winner === 'A');
  if (deckB.pairKey === FAITHLESS_ARCHETYPE_KEY) bumpFaithlessCardStats(deckB.eligiblePool, deckB.entries, state.winner === 'B');
  bumpLabelStats(deckA.label, state.winner === 'A');
  bumpLabelStats(deckB.label, state.winner === 'B');

  const record = {
    id, deckA: deckA.label, deckB: deckB.label, startingPlayer,
    winner: state.winner, stalled, turnNumber: state.turnNumber, actionCount, durationMs,
    lifespanA: state.players.A.lifespan, lifespanB: state.players.B.lifespan,
  };
  fs.appendFileSync(gamesPath, JSON.stringify(record) + '\n');
  return record;
};

const safeSnapshot = (state) => {
  try {
    return {
      phase: state.phase, turnNumber: state.turnNumber, turnPlayer: state.turnPlayer,
      pendingChoice: state.pendingChoice, reactiveWindow: state.reactiveWindow,
      lifespanA: state.players?.A?.lifespan, lifespanB: state.players?.B?.lifespan,
      boardKeys: Object.keys(state.board || {}),
    };
  } catch {
    return null;
  }
};

// ---------- main loop ----------
const deadline = Date.now() + MINUTES * 60_000;
let lastCheckpoint = 0;
let totalGames = 0, wins = { A: 0, B: 0, draw: 0 }, crashes = 0, stalls = 0;
let turnSum = 0;

// Shared shape for every "top 12" report below: pure-impact ranking (no
// noise — noiseScale=0 below), with both sides of the included-vs-excluded
// comparison spelled out, not just the delta, so it's easy to sanity-check
// a reported impact against real sample sizes rather than trusting a bare
// number.
const rankedReport = (eligible, impactFn, includedFn, excludedFn) =>
  fillDeckEntries(eligible, Math.random, 0, impactFn).slice(0, 12).map((e) => ({
    name: e.card.name, count: e.count,
    impact: +impactFn(e.card.name).toFixed(3),
    winRateIncluded: +includedFn(e.card.name).toFixed(3),
    winRateExcluded: +excludedFn(e.card.name).toFixed(3),
  }));

const writeSummary = () => {
  const topByColor = {};
  EFFIGY_COLORS.forEach((color) => {
    topByColor[color] = rankedReport(eligibleFor(color), impactOf, winRateIncluded, winRateExcluded);
  });
  const topHybridDecks = {};
  ALL_COLOR_PAIRS.forEach(([colorA, colorB]) => {
    const pairKey = [colorA, colorB].sort().join('+');
    topHybridDecks[pairKey] = rankedReport(eligibleFor(colorA, colorB), impactOf, winRateIncluded, winRateExcluded);
  });
  const topTripleDecks = {};
  ALL_COLOR_TRIPLES.forEach(([colorA, colorB, colorC]) => {
    const pairKey = [colorA, colorB, colorC].sort().join('+');
    topTripleDecks[pairKey] = rankedReport(eligibleFor(colorA, colorB, colorC), impactOf, winRateIncluded, winRateExcluded);
  });
  const topFaithlessCards = rankedReport(eligibleFor(), faithlessImpactOf, faithlessWinRateIncluded, faithlessWinRateExcluded);

  // pairStats now holds THREE different shapes of key (mono colors, plus
  // FAITHLESS_ARCHETYPE_KEY, all mixed in alongside "+"-joined hybrid/
  // triple keys since randomDeckFor/evolvedDeckFor now also set pairKey to
  // their own single color — see its own comment) — split back out by
  // counting "+" separators, the one property that unambiguously tells
  // them apart, so each gets its own clearly-labeled report section below.
  const pairEntries = [...pairStats.entries()].filter(([k]) => k !== FAITHLESS_ARCHETYPE_KEY);
  const effigyTypingWinRates = pairEntries.filter(([k]) => !k.includes('+'))
    .map(([key, s]) => ({ color: key, games: s.games, winRate: +pairWinRate(key).toFixed(3) }))
    .sort((a, b) => b.winRate - a.winRate);
  const hybridPairWinRates = pairEntries.filter(([k]) => k.split('+').length === 2)
    .map(([key, s]) => ({ pair: key, games: s.games, winRate: +pairWinRate(key).toFixed(3) }))
    .sort((a, b) => b.winRate - a.winRate);
  const tripleColorWinRates = pairEntries.filter(([k]) => k.split('+').length === 3)
    .map(([key, s]) => ({ triple: key, games: s.games, winRate: +pairWinRate(key).toFixed(3) }))
    .sort((a, b) => b.winRate - a.winRate);

  // "What is the seemingly best deck overall" — every exact deck BUILD's
  // own win rate (precons, uploaded decks, and every evolved/random
  // archetype build alike), sorted best to worst. Only built decks that
  // actually got played enough to mean anything (>= 20 games) make this
  // list — an archetype with 2 games at 100% would otherwise swamp the top
  // purely on small-sample noise.
  const MIN_GAMES_FOR_DECK_RANKING = 20;
  const deckWinRates = [...labelStats.entries()]
    .filter(([, s]) => s.games >= MIN_GAMES_FOR_DECK_RANKING)
    .map(([label, s]) => ({ label, games: s.games, winRate: +labelWinRate(label).toFixed(3) }))
    .sort((a, b) => b.winRate - a.winRate);

  // "Overall power rankings of the cards" — cardStats already accumulates
  // every card's included-vs-excluded impact across EVERY mono/hybrid/
  // triple deck context it was ever eligible for (shared Map keyed by card
  // name, bumped regardless of which color combo built the deck — see
  // bumpCardStats' own call sites), so this is a real cross-color ranking,
  // not just a union of the per-color top-12 lists above. Faithless cards
  // are tracked in their own separately-scoped faithlessCardStats (see its
  // own comment on why) and reported alongside, not merged in here.
  const MIN_GAMES_FOR_CARD_RANKING = 30;
  const overallCardRows = [...cardStats.entries()]
    .filter(([, s]) => s.gamesIncluded + s.gamesExcluded >= MIN_GAMES_FOR_CARD_RANKING)
    .map(([name]) => ({
      name,
      impact: +impactOf(name).toFixed(3),
      winRateIncluded: +winRateIncluded(name).toFixed(3),
      winRateExcluded: +winRateExcluded(name).toFixed(3),
    }))
    .sort((a, b) => b.impact - a.impact);

  fs.writeFileSync(summaryPath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    totalGames, wins, crashes, stalls,
    avgTurns: totalGames ? +(turnSum / totalGames).toFixed(1) : 0,
    minutesElapsed: +((MINUTES * 60_000 - (deadline - Date.now())) / 60_000).toFixed(1),
    minutesBudget: MINUTES,
    uploadedDeckLabels: uploadedDecks.map((d) => d.label),
    // "Best deck overall" / "best effigy typing, worst effigy typing" /
    // "best color combination, worst color combination" — best is index 0,
    // worst is the last entry, of each list below.
    deckWinRatesOverall: deckWinRates,
    effigyTypingWinRates,
    hybridPairWinRates,
    tripleColorWinRates,
    faithlessArchetypeWinRate: pairStats.has(FAITHLESS_ARCHETYPE_KEY) ? +pairWinRate(FAITHLESS_ARCHETYPE_KEY).toFixed(3) : null,
    faithlessArchetypeGames: pairStats.get(FAITHLESS_ARCHETYPE_KEY)?.games || 0,
    // "Overall power rankings of the cards" — top 30 / bottom 10 by impact,
    // plus the full per-color/hybrid/triple/faithless top-12 breakdowns.
    topCardsOverall: overallCardRows.slice(0, 30),
    worstCardsOverall: overallCardRows.slice(-10).reverse(),
    topCardsByColor: topByColor,
    topCardsByHybridPair: topHybridDecks,
    topCardsByTriple: topTripleDecks,
    topFaithlessCards,
  }, null, 2));
};

log(`Starting self-play run: budget=${MINUTES}min, out=${OUT_DIR}`);
while (Date.now() < deadline) {
  const result = playOneGame();
  totalGames++;
  if (result.crashed) crashes++;
  else {
    if (result.stalled) stalls++;
    if (result.winner === 'A' || result.winner === 'B') wins[result.winner]++;
    else wins.draw++;
    turnSum += result.turnNumber;
  }
  if (Date.now() - lastCheckpoint > CHECKPOINT_EVERY_MS) {
    writeSummary();
    lastCheckpoint = Date.now();
    log(`games=${totalGames} wins.A=${wins.A} wins.B=${wins.B} draw=${wins.draw} crashes=${crashes} stalls=${stalls} avgTurns=${(turnSum / Math.max(1, totalGames - crashes)).toFixed(1)}`);
  }
}
writeSummary();
log(`Done. games=${totalGames} crashes=${crashes} stalls=${stalls}`);
