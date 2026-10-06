// Paired A/B validation of an AI change: the same random deck pair and
// starting player is played TWICE, once with the candidate AI in seat A and
// once with it in seat B (the other seat always runs the baseline AI from
// this checkout). Seat and deck luck cancel out of the comparison, which a
// plain "run both builds and compare win rates" cannot do.
//
//   node_modules/.bin/vite-node scripts/self-play/paired-ab.mjs \
//     --candidate=/abs/path/to/other/worktree [--games=3000] [--difficulty=standard]
//
// `--candidate` is another checkout (a git worktree) of this repo whose
// src/game/engine/ai.js holds the change under test. The game itself is
// always driven by THIS checkout's engine, so the two checkouts must have
// the same actions.js (rebase the candidate onto the baseline first) —
// only the decision function differs per seat.
//
// Reports the candidate's overall win rate with a 95% Wilson interval, and
// the paired breakdown (both seatings won / both lost / split), where
// "split" games are decided by seat rather than by the AI.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCSV, toGameCard } from '../../src/lib/cardData.js';
import { createInitialState, gameReducer } from '../../src/game/engine/actions.js';
import {
  buildMainDeckList, buildEffigyDeckList, autoBuildMainDeckEntries,
  autoBuildEffigyCounts, randomEffigyColor,
} from '../../src/game/engine/deck.js';
import * as baseline from '../../src/game/engine/ai.js';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const GAMES = parseInt(args.games || '3000', 10);
const DIFFICULTY = args.difficulty || 'standard';
if (!args.candidate) {
  console.error('Usage: paired-ab.mjs --candidate=/abs/path/to/worktree [--games=N] [--difficulty=standard|hard]');
  process.exit(1);
}
const candidate = await import(pathToFileURL(path.join(args.candidate, 'src/game/engine/ai.js')).href);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const pool = parseCSV(fs.readFileSync(path.join(REPO_ROOT, 'public/default-card-set.csv'), 'utf-8')).map((row, idx) => toGameCard(row, idx));

const randomDeckFor = (color) => ({
  mainDeck: buildMainDeckList(autoBuildMainDeckEntries(pool, color)),
  effigyDeck: buildEffigyDeckList(autoBuildEffigyCounts(color)),
});

// ai[seat] is whichever module decides for that seat this game.
const actionFor = (state, playerId, ai) => {
  const owesChoice = state.pendingChoice?.playerId === playerId;
  const owesReaction = state.reactiveWindow?.openFor === playerId;
  const isTurn = (state.phase === 'mulligan' && !state.players[playerId].keptHand)
    || (state.phase === 'playing' && state.turnPlayer === playerId);
  if (state.pendingChoice && !owesChoice) return null;
  if (!owesChoice && !isTurn && !owesReaction) return null;
  return owesReaction ? ai.pickAiReaction(state, playerId) : ai.pickAiAction(state, playerId, DIFFICULTY);
};

// Returns 'A' | 'B' | 'draw' | 'stall' | 'crash'.
const play = (deckA, deckB, startingPlayer, ai) => {
  let state = createInitialState({
    mainDeckA: deckA.mainDeck, effigyDeckA: deckA.effigyDeck,
    mainDeckB: deckB.mainDeck, effigyDeckB: deckB.effigyDeck,
    startingPlayer,
  });
  try {
    state = gameReducer(state, { type: 'KEEP_HAND', player: 'A' });
    state = gameReducer(state, { type: 'KEEP_HAND', player: 'B' });
    let actions = 0;
    let lastTurn = state.turnNumber;
    let sameTurn = 0;
    while (state.phase !== 'gameover' && actions < 4000) {
      let acted = false;
      for (const p of ['A', 'B']) {
        const action = actionFor(state, p, ai[p]);
        if (!action) continue;
        state = gameReducer(state, action);
        actions++;
        acted = true;
        break;
      }
      if (!acted) return 'stall';
      if (state.turnNumber === lastTurn) { if (++sameTurn > 800) return 'stall'; } else { sameTurn = 0; lastTurn = state.turnNumber; }
      if (state.turnNumber > 400) return 'draw';
    }
    if (state.phase !== 'gameover') return 'stall';
    return state.winner === 'A' || state.winner === 'B' ? state.winner : 'draw';
  } catch {
    return 'crash';
  }
};

const wilson = (wins, n) => {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [centre - half, centre + half];
};

const tally = { candWins: 0, baseWins: 0, other: 0, bothCand: 0, bothBase: 0, split: 0, pairs: 0 };
const start = Date.now();
for (let g = 0; g < GAMES; g++) {
  const deckA = randomDeckFor(randomEffigyColor());
  const deckB = randomDeckFor(randomEffigyColor());
  const startingPlayer = Math.random() < 0.5 ? 'A' : 'B';
  // Same decks and starter both times; only the AI-to-seat mapping swaps.
  const r1 = play(deckA, deckB, startingPlayer, { A: candidate, B: baseline }); // candidate = A
  const r2 = play(deckA, deckB, startingPlayer, { A: baseline, B: candidate }); // candidate = B
  const candWon1 = r1 === 'A';
  const baseWon1 = r1 === 'B';
  const candWon2 = r2 === 'B';
  const baseWon2 = r2 === 'A';
  tally.candWins += (candWon1 ? 1 : 0) + (candWon2 ? 1 : 0);
  tally.baseWins += (baseWon1 ? 1 : 0) + (baseWon2 ? 1 : 0);
  tally.other += (candWon1 || baseWon1 ? 0 : 1) + (candWon2 || baseWon2 ? 0 : 1);
  if ((candWon1 || baseWon1) && (candWon2 || baseWon2)) {
    tally.pairs++;
    const candInPair = (candWon1 ? 1 : 0) + (candWon2 ? 1 : 0);
    if (candInPair === 2) tally.bothCand++; else if (candInPair === 0) tally.bothBase++; else tally.split++;
  }
  if ((g + 1) % 250 === 0) {
    const decided = tally.candWins + tally.baseWins;
    console.log(`[${((Date.now() - start) / 60000).toFixed(1)}m] ${g + 1}/${GAMES} pairs — candidate ${tally.candWins}-${tally.baseWins} (${(100 * tally.candWins / Math.max(1, decided)).toFixed(2)}%)`);
  }
}

const decided = tally.candWins + tally.baseWins;
const [lo, hi] = wilson(tally.candWins, decided);
console.log('\n=== Paired A/B result ===');
console.log(`Difficulty: ${DIFFICULTY}   Pairs: ${GAMES}   Games: ${GAMES * 2}   Undecided (draw/stall/crash): ${tally.other}`);
console.log(`Candidate wins: ${tally.candWins}   Baseline wins: ${tally.baseWins}`);
console.log(`Candidate win rate: ${(100 * tally.candWins / decided).toFixed(2)}%   95% CI [${(100 * lo).toFixed(2)}%, ${(100 * hi).toFixed(2)}%]`);
console.log(`Both-decided pairs: ${tally.pairs}  — candidate won both seats: ${tally.bothCand}, baseline won both: ${tally.bothBase}, split by seat: ${tally.split}`);
const decisive = tally.bothCand + tally.bothBase;
if (decisive > 0) {
  const [plo, phi] = wilson(tally.bothCand, decisive);
  console.log(`Of the ${decisive} AI-decided pairs, candidate won ${(100 * tally.bothCand / decisive).toFixed(2)}%  95% CI [${(100 * plo).toFixed(2)}%, ${(100 * phi).toFixed(2)}%]`);
}
