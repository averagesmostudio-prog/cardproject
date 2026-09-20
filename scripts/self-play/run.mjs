// AI-vs-AI self-play simulation harness for Scripturas Alpha.
//
// Plays as many full games as fit in a wall-clock time budget, using the
// REAL engine code (no UI) — same gameReducer/pickAiAction/pickAiReaction
// a live match uses. Goals: surface crashes/soft-locks/suspected infinite
// loops, and rank individual cards' own IMPACT on win rate (see cardStats'
// own comment) — included-vs-excluded, not a raw win rate, which stays
// deeply confounded by whatever OTHER cards a deck-building process
// happens to pair a card with. Evolved mono-color AND hybrid (2-color)
// decks are built by ranking each color's card pool on that impact, PLUS
// independent per-card random noise (RANK_NOISE — see fillDeckEntries'
// own comment for why the noise is the actual fix, not just extra
// randomness). The 6 precon decks in src/game/decks/precons.js are only
// ever READ (resolvePreconEntries) — every evolved/hybrid deck built here
// is a fresh, in-memory-only entries list, never written back to
// precons.js or any other tracked file.
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
  autoBuildEffigyCounts, randomEffigyColor, resolvePreconEntries, MAIN_DECK_SIZE,
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
  const { entries, effigyCounts } = resolvePreconEntries(pool, precon);
  return { mainDeck: buildMainDeckList(entries), effigyDeck: buildEffigyDeckList(effigyCounts), label: `precon:${precon.id}` };
};
// entries/eligiblePool are attached so playOneGame can feed this deck's
// choices into the included-vs-excluded card stats below — a plain random
// pick is actually the CLEANEST possible sample for that comparison (truly
// unbiased, no score-based influence at all), so it isn't wasted.
const randomDeckFor = (color) => {
  const eligiblePool = eligibleFor(color);
  const entries = autoBuildMainDeckEntries(pool, color);
  return { mainDeck: buildMainDeckList(entries), effigyDeck: buildEffigyDeckList(autoBuildEffigyCounts(color)), label: `random:${color}`, entries, eligiblePool };
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
  return { mainDeck: buildMainDeckList(entries), effigyDeck: buildEffigyDeckList(autoBuildEffigyCounts(color)), label: `evolved:${color}`, entries, eligiblePool };
};

// Hybrid (2-color) evolution — same evolved-deck idea as evolvedDeckFor,
// just drawing from cards restricted to EITHER of two colors instead of
// one (mirrors "Call of the Void"/"Plague Rats", precons.js — a real,
// user-confirmed-good archetype shape, not a hypothetical). Its own Effigy
// Deck is a proportional split of the 15 slots by how much each color's
// pips are actually demanded across the evolved entries, not an even 50/50
// — the same idea those two precons' own hand-picked splits (8/7) follow.
const hybridEffigyCounts = (colorA, colorB, entries) => {
  const counts = {};
  EFFIGY_COLORS.forEach((c) => { counts[c] = 0; });
  let demandA = 0, demandB = 0;
  entries.forEach(({ card, count }) => {
    demandA += (card.castingCost?.colored?.[colorA] || 0) * count;
    demandB += (card.castingCost?.colored?.[colorB] || 0) * count;
  });
  const total = demandA + demandB;
  let countA = total > 0 ? Math.round(EFFIGY_DECK_SIZE * demandA / total) : Math.round(EFFIGY_DECK_SIZE / 2);
  countA = Math.max(1, Math.min(EFFIGY_DECK_SIZE - 1, countA)); // keep both colors real
  counts[colorA] = countA;
  counts[colorB] = EFFIGY_DECK_SIZE - countA;
  return counts;
};
const evolvedHybridDeckFor = (colorA, colorB) => {
  const eligiblePool = eligibleFor(colorA, colorB);
  const entries = fillDeckEntries(eligiblePool, Math.random, RANK_NOISE);
  const pairKey = [colorA, colorB].sort().join('+');
  return {
    mainDeck: buildMainDeckList(entries),
    effigyDeck: buildEffigyDeckList(hybridEffigyCounts(colorA, colorB, entries)),
    label: `evolved-hybrid:${pairKey}`, entries, pairKey, eligiblePool,
  };
};
const ALL_COLOR_PAIRS = EFFIGY_COLORS.flatMap((a, i) => EFFIGY_COLORS.slice(i + 1).map((b) => [a, b]));

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

const pickDeck = (gamesPlayed) => {
  const r = Math.random();
  if (r < 0.2) return preconDeckFor(PRECON_DECKS[Math.floor(Math.random() * PRECON_DECKS.length)]);
  if (r < 0.4) return randomDeckFor(randomEffigyColor());
  // Every evolution/archetype track below needs real signal first — plain
  // random for its own warm-up stretch (hybrids and faithless need more
  // games than a solo color: hybrids cover 10 color pairs, faithless is
  // competing for slots against every colored card's own deck too), then
  // mixed in for real.
  if (r < 0.6) {
    if (gamesPlayed < 200) return randomDeckFor(randomEffigyColor());
    return evolvedDeckFor(randomEffigyColor());
  }
  if (r < 0.8) {
    if (gamesPlayed < 400) return randomDeckFor(randomEffigyColor());
    const [colorA, colorB] = ALL_COLOR_PAIRS[Math.floor(Math.random() * ALL_COLOR_PAIRS.length)];
    return evolvedHybridDeckFor(colorA, colorB);
  }
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
  const topFaithlessCards = rankedReport(eligibleFor(), faithlessImpactOf, faithlessWinRateIncluded, faithlessWinRateExcluded);
  const hybridPairWinRates = [...pairStats.entries()]
    // The faithless archetype's own overall win rate is tracked through the
    // exact same pairStats map (FAITHLESS_ARCHETYPE_KEY, a plain string key
    // — pairStats never actually required a "colorA+colorB" shape) rather
    // than a second, near-identical Map, but it's reported separately below
    // (faithlessArchetypeWinRate), not mixed into this colored-pair list.
    .filter(([pairKey]) => pairKey !== FAITHLESS_ARCHETYPE_KEY)
    .map(([pairKey, s]) => ({ pair: pairKey, games: s.games, winRate: +pairWinRate(pairKey).toFixed(3) }))
    .sort((a, b) => b.winRate - a.winRate);
  fs.writeFileSync(summaryPath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    totalGames, wins, crashes, stalls,
    avgTurns: totalGames ? +(turnSum / totalGames).toFixed(1) : 0,
    minutesElapsed: +((MINUTES * 60_000 - (deadline - Date.now())) / 60_000).toFixed(1),
    minutesBudget: MINUTES,
    topCardsByColor: topByColor,
    // Ranked by which color PAIR wins most as a combo (not any one card's
    // own rate) — Goal #2's "which combination of cards" question, one
    // level up from a single color's own top-12.
    hybridPairWinRates,
    topCardsByHybridPair: topHybridDecks,
    // A fully Faithless (colorless) deck — every card costs only Faithless
    // pips, no colored ones — as its own tracked archetype, not just
    // whatever colorless cards happened to get folded into a colored deck.
    faithlessArchetypeWinRate: pairStats.has(FAITHLESS_ARCHETYPE_KEY) ? +pairWinRate(FAITHLESS_ARCHETYPE_KEY).toFixed(3) : null,
    faithlessArchetypeGames: pairStats.get(FAITHLESS_ARCHETYPE_KEY)?.games || 0,
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
