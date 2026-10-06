// One-off benchmark: measures getLegalActions' real branching factor across
// actual AI-vs-AI games (using the real engine, precon decks, mirroring
// run.mjs's own actionFor loop), plus the wall-clock cost of a single
// gameReducer dispatch — together these size up whether a depth-2/3
// lookahead search (for a more synergy-aware practice AI) would stay fast
// enough for interactive play. Read-only, no output files — just prints a
// summary. Must be run with vite-node (see run.mjs's own note on why).
//
//   node_modules/.bin/vite-node scripts/self-play/branching-factor-bench.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCSV, toGameCard } from '../../src/lib/cardData.js';
import { createInitialState, gameReducer, getLegalActions } from '../../src/game/engine/actions.js';
import { buildMainDeckList, buildEffigyDeckList, resolveDeckEntries } from '../../src/game/engine/deck.js';
import { pickAiAction, pickAiReaction } from '../../src/game/engine/ai.js';
import { PRECON_DECKS } from '../../src/game/decks/precons.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const csvText = fs.readFileSync(path.join(REPO_ROOT, 'public/default-card-set.csv'), 'utf-8');
const pool = parseCSV(csvText).map((row, idx) => toGameCard(row, idx));

const preconDeckFor = (precon) => {
  const { entries, effigyCounts } = resolveDeckEntries(pool, precon);
  return { mainDeck: buildMainDeckList(entries), effigyDeck: buildEffigyDeckList(effigyCounts) };
};
const decks = PRECON_DECKS.map(preconDeckFor);
const randomDeck = () => decks[Math.floor(Math.random() * decks.length)];

const actionFor = (state, playerId) => {
  const owesChoice = state.pendingChoice?.playerId === playerId;
  const owesReaction = state.reactiveWindow?.openFor === playerId;
  const isTurn = (state.phase === 'mulligan' && !state.players[playerId].keptHand)
    || (state.phase === 'playing' && state.turnPlayer === playerId);
  if (state.pendingChoice && !owesChoice) return null;
  if (!owesChoice && !isTurn && !owesReaction) return null;
  return owesReaction ? pickAiReaction(state, playerId) : pickAiAction(state, playerId);
};

// ---------- branching factor sampling ----------
// Separately bucketed: a "main turn" decision (state.phase === 'playing',
// it's this player's turnPlayer, no pendingChoice/reactiveWindow open) is
// the shape a lookahead search would actually branch on each ply; a
// "reaction/choice" decision (an open reactiveWindow or pendingChoice) is a
// much narrower, usually-small decision point along the way.
const mainTurnCounts = [];
const reactionOrChoiceCounts = [];

const MAX_ACTIONS = 4000;
const GAMES = 300;

for (let g = 0; g < GAMES; g++) {
  const startingPlayer = Math.random() < 0.5 ? 'A' : 'B';
  const deckA = randomDeck();
  const deckB = randomDeck();
  let state = createInitialState({
    mainDeckA: deckA.mainDeck, effigyDeckA: deckA.effigyDeck,
    mainDeckB: deckB.mainDeck, effigyDeckB: deckB.effigyDeck,
    startingPlayer,
  });
  state = gameReducer(state, { type: 'KEEP_HAND', player: 'A' });
  state = gameReducer(state, { type: 'KEEP_HAND', player: 'B' });

  let actionCount = 0;
  let lastTurnNumber = state.turnNumber;
  let sameTurnStreak = 0;
  while (state.phase !== 'gameover' && actionCount < MAX_ACTIONS) {
    let acted = false;
    for (const p of ['A', 'B']) {
      const owesChoice = state.pendingChoice?.playerId === p;
      const owesReaction = state.reactiveWindow?.openFor === p;
      const isTurn = state.phase === 'playing' && state.turnPlayer === p;
      const action = actionFor(state, p);
      if (!action) continue;

      const n = getLegalActions(state, p).length;
      if (isTurn && !owesChoice && !owesReaction) {
        mainTurnCounts.push(n);
      } else if (owesChoice || owesReaction) {
        reactionOrChoiceCounts.push(n);
      }

      state = gameReducer(state, action);
      actionCount++;
      acted = true;
      break;
    }
    if (!acted) break;
    if (state.turnNumber === lastTurnNumber) sameTurnStreak++;
    else { sameTurnStreak = 0; lastTurnNumber = state.turnNumber; }
    if (sameTurnStreak > 800) break;
    if (state.turnNumber > 60) break;
  }
}

const stats = (arr) => {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = arr.reduce((s, n) => s + n, 0);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    n: arr.length,
    mean: sum / arr.length,
    median: pct(0.5),
    p90: pct(0.9),
    p99: pct(0.99),
    max: sorted[sorted.length - 1],
  };
};

console.log(`Games played: ${GAMES}`);
console.log('Main-turn decision branching factor (getLegalActions length):', stats(mainTurnCounts));
console.log('Reaction/pendingChoice decision branching factor:', stats(reactionOrChoiceCounts));

// ---------- per-dispatch timing ----------
// Re-play a handful of games, timing every single gameReducer dispatch
// (any action, not just main-turn ones — a search node is exactly one
// dispatch + one getLegalActions call to enumerate the next ply).
let dispatchCount = 0;
let getLegalActionsCount = 0;
const timingStart = process.hrtime.bigint();
for (let g = 0; g < 50; g++) {
  const startingPlayer = Math.random() < 0.5 ? 'A' : 'B';
  const deckA = randomDeck();
  const deckB = randomDeck();
  let state = createInitialState({
    mainDeckA: deckA.mainDeck, effigyDeckA: deckA.effigyDeck,
    mainDeckB: deckB.mainDeck, effigyDeckB: deckB.effigyDeck,
    startingPlayer,
  });
  state = gameReducer(state, { type: 'KEEP_HAND', player: 'A' }); dispatchCount++;
  state = gameReducer(state, { type: 'KEEP_HAND', player: 'B' }); dispatchCount++;

  let actionCount = 0;
  let lastTurnNumber = state.turnNumber;
  let sameTurnStreak = 0;
  while (state.phase !== 'gameover' && actionCount < MAX_ACTIONS) {
    let acted = false;
    for (const p of ['A', 'B']) {
      const owesChoice = state.pendingChoice?.playerId === p;
      const owesReaction = state.reactiveWindow?.openFor === p;
      const isTurn = (state.phase === 'mulligan' && !state.players[p].keptHand)
        || (state.phase === 'playing' && state.turnPlayer === p);
      if (state.pendingChoice && !owesChoice) continue;
      if (!owesChoice && !isTurn && !owesReaction) continue;
      getLegalActionsCount++;
      const action = owesReaction ? pickAiReaction(state, p) : pickAiAction(state, p);
      if (!action) continue;
      state = gameReducer(state, action);
      dispatchCount++;
      actionCount++;
      acted = true;
      break;
    }
    if (!acted) break;
    if (state.turnNumber === lastTurnNumber) sameTurnStreak++;
    else { sameTurnStreak = 0; lastTurnNumber = state.turnNumber; }
    if (sameTurnStreak > 800) break;
    if (state.turnNumber > 60) break;
  }
}
const timingEnd = process.hrtime.bigint();
const totalMs = Number(timingEnd - timingStart) / 1e6;
console.log(`\nTiming sample: ${dispatchCount} dispatches, ${getLegalActionsCount} getLegalActions calls, ${totalMs.toFixed(1)}ms total`);
console.log(`Avg per dispatch+getLegalActions "node": ${(totalMs / dispatchCount).toFixed(4)}ms`);

// ---------- Hard-mode real wall-clock latency ----------
// Directly times pickAiAction(state, playerId, 'hard') across a sample of
// realistic mid-game states (reusing the same game-generation loop above)
// — validates the "does it still feel responsive" question empirically,
// not just by extrapolating from the generic per-node estimate.
const hardTimings = [];
for (let g = 0; g < 40; g++) {
  const startingPlayer = Math.random() < 0.5 ? 'A' : 'B';
  const deckA = randomDeck();
  const deckB = randomDeck();
  let state = createInitialState({
    mainDeckA: deckA.mainDeck, effigyDeckA: deckA.effigyDeck,
    mainDeckB: deckB.mainDeck, effigyDeckB: deckB.effigyDeck,
    startingPlayer,
  });
  state = gameReducer(state, { type: 'KEEP_HAND', player: 'A' });
  state = gameReducer(state, { type: 'KEEP_HAND', player: 'B' });

  let actionCount = 0;
  let lastTurnNumber = state.turnNumber;
  let sameTurnStreak = 0;
  while (state.phase !== 'gameover' && actionCount < MAX_ACTIONS) {
    let acted = false;
    for (const p of ['A', 'B']) {
      const owesChoice = state.pendingChoice?.playerId === p;
      const owesReaction = state.reactiveWindow?.openFor === p;
      const isTurn = (state.phase === 'mulligan' && !state.players[p].keptHand)
        || (state.phase === 'playing' && state.turnPlayer === p);
      if (state.pendingChoice && !owesChoice) continue;
      if (!owesChoice && !isTurn && !owesReaction) continue;

      // Time a Hard-mode pick at this exact decision point (main-turn
      // decisions only — the ones a search actually branches on), without
      // letting it affect the actual game trajectory below (which keeps
      // using the fast standard AI, so this sample spans a realistic
      // mix of early/mid/late-game boards, not just Hard-mode-reachable
      // ones).
      if (isTurn && !owesChoice && !owesReaction) {
        const t0 = process.hrtime.bigint();
        pickAiAction(state, p, 'hard');
        const t1 = process.hrtime.bigint();
        hardTimings.push(Number(t1 - t0) / 1e6);
      }

      const action = owesReaction ? pickAiReaction(state, p) : pickAiAction(state, p);
      if (!action) continue;
      state = gameReducer(state, action);
      actionCount++;
      acted = true;
      break;
    }
    if (!acted) break;
    if (state.turnNumber === lastTurnNumber) sameTurnStreak++;
    else { sameTurnStreak = 0; lastTurnNumber = state.turnNumber; }
    if (sameTurnStreak > 800) break;
    if (state.turnNumber > 60) break;
  }
}
console.log(`\nHard-mode pickAiAction wall-clock latency (${hardTimings.length} samples, ms):`, stats(hardTimings));
