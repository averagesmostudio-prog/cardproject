// One-off benchmark: does the "Graveyard Bash" (Bones) precon's dominant
// win rate (86.5% over 44,548 games at Standard difficulty, the 2-hour
// self-play run) hold up once BOTH sides pilot with the improved Hard-mode
// search, or is its edge partly an artifact of a non-searching AI being
// unusually good at piloting its own "sacrifice a cheap token for
// immediate value" loops specifically? Plays Bones (player A) against a
// random precon opponent (player B) for a fixed number of games, BOTH at
// Hard difficulty, and reports the win rate plus a same-sample Standard-
// difficulty control run for direct comparison. Read-only, no output
// files. Must be run with vite-node (see run.mjs's own note on why).
//
//   node_modules/.bin/vite-node scripts/self-play/bones-hard-mode-bench.mjs [--games=N]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCSV, toGameCard } from '../../src/lib/cardData.js';
import { createInitialState, gameReducer } from '../../src/game/engine/actions.js';
import { buildMainDeckList, buildEffigyDeckList, resolveDeckEntries } from '../../src/game/engine/deck.js';
import { pickAiAction, pickAiReaction } from '../../src/game/engine/ai.js';
import { PRECON_DECKS } from '../../src/game/decks/precons.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const csvText = fs.readFileSync(path.join(REPO_ROOT, 'public/default-card-set.csv'), 'utf-8');
const pool = parseCSV(csvText).map((row, idx) => toGameCard(row, idx));

const GAMES = parseInt((process.argv.find((a) => a.startsWith('--games=')) || '--games=400').split('=')[1], 10);
const MAX_ACTIONS = 4000;

const preconDeckFor = (precon) => {
  const { entries, effigyCounts } = resolveDeckEntries(pool, precon);
  return { mainDeck: buildMainDeckList(entries), effigyDeck: buildEffigyDeckList(effigyCounts) };
};
const bonesPrecon = PRECON_DECKS.find((p) => p.id === 'bones');
const opponentPrecons = PRECON_DECKS.filter((p) => p.id !== 'bones');
const bonesDeck = preconDeckFor(bonesPrecon);
const opponentDecks = opponentPrecons.map(preconDeckFor);
const randomOpponentDeck = () => opponentDecks[Math.floor(Math.random() * opponentDecks.length)];

const actionFor = (state, playerId, difficultyFor) => {
  const owesChoice = state.pendingChoice?.playerId === playerId;
  const owesReaction = state.reactiveWindow?.openFor === playerId;
  const isTurn = (state.phase === 'mulligan' && !state.players[playerId].keptHand)
    || (state.phase === 'playing' && state.turnPlayer === playerId);
  if (state.pendingChoice && !owesChoice) return null;
  if (!owesChoice && !isTurn && !owesReaction) return null;
  return owesReaction ? pickAiReaction(state, playerId) : pickAiAction(state, playerId, difficultyFor(playerId));
};

const playOneGame = (difficultyFor) => {
  const startingPlayer = Math.random() < 0.5 ? 'A' : 'B';
  const opp = randomOpponentDeck();
  let state = createInitialState({
    mainDeckA: bonesDeck.mainDeck, effigyDeckA: bonesDeck.effigyDeck,
    mainDeckB: opp.mainDeck, effigyDeckB: opp.effigyDeck,
    startingPlayer,
  });
  state = gameReducer(state, { type: 'KEEP_HAND', player: 'A' });
  state = gameReducer(state, { type: 'KEEP_HAND', player: 'B' });

  let actionCount = 0;
  let lastTurnNumber = state.turnNumber;
  let sameTurnStreak = 0;
  let stopReason = 'gameover';
  while (state.phase !== 'gameover' && actionCount < MAX_ACTIONS) {
    let acted = false;
    for (const p of ['A', 'B']) {
      const action = actionFor(state, p, difficultyFor);
      if (!action) continue;
      state = gameReducer(state, action);
      actionCount++;
      acted = true;
      break;
    }
    if (!acted) { stopReason = 'no-action-owed'; break; }
    if (state.turnNumber === lastTurnNumber) sameTurnStreak++;
    else { sameTurnStreak = 0; lastTurnNumber = state.turnNumber; }
    if (sameTurnStreak > 800) { stopReason = 'same-turn-streak-800'; break; }
    if (state.turnNumber > 60) { stopReason = 'turn-cap-60'; break; }
    if (actionCount >= MAX_ACTIONS) { stopReason = 'max-actions'; break; }
  }
  return { winner: state.winner, stopReason, turnNumber: state.turnNumber, actionCount, phase: state.phase };
};

const runBatch = (label, difficultyFor) => {
  const start = Date.now();
  let winsA = 0, winsB = 0, draws = 0;
  const stopReasonCounts = {};
  const stalledSamples = [];
  for (let g = 0; g < GAMES; g++) {
    const result = playOneGame(difficultyFor);
    if (result.winner === 'A') winsA++;
    else if (result.winner === 'B') winsB++;
    else draws++;
    stopReasonCounts[result.stopReason] = (stopReasonCounts[result.stopReason] || 0) + 1;
    if (result.stopReason !== 'gameover' && stalledSamples.length < 5) {
      stalledSamples.push({ turnNumber: result.turnNumber, actionCount: result.actionCount, phase: result.phase });
    }
  }
  const elapsedS = (Date.now() - start) / 1000;
  console.log(`\n[${label}] ${GAMES} games in ${elapsedS.toFixed(1)}s (${(elapsedS / GAMES * 1000).toFixed(0)}ms/game)`);
  console.log(`  Bones (A) wins: ${winsA} (${(winsA / GAMES * 100).toFixed(1)}%)`);
  console.log(`  Opponent (B) wins: ${winsB} (${(winsB / GAMES * 100).toFixed(1)}%)`);
  console.log(`  Draws/stalls: ${draws}`);
  console.log(`  Stop reasons:`, stopReasonCounts);
  if (stalledSamples.length > 0) console.log(`  Sample stalls:`, stalledSamples);
  return winsA / GAMES;
};

const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const conditions = {
  standard: ['Standard vs Standard (control)', () => 'standard'],
  hardboth: ['Hard vs Hard (both sides upgraded)', () => 'hard'],
  hardbones: ['Bones=Hard, Opponent=Standard (does Hard help Bones specifically)', (p) => (p === 'A' ? 'hard' : 'standard')],
  hardopp: ['Bones=Standard, Opponent=Hard (does Hard help the OPPONENT beat Bones)', (p) => (p === 'A' ? 'standard' : 'hard')],
};
console.log(`Bones vs random-precon-opponent, ${GAMES} games per condition.`);
const results = {};
for (const [key, [label, difficultyFor]] of Object.entries(conditions)) {
  if (ONLY && key !== ONLY) continue;
  results[key] = runBatch(label, difficultyFor);
}

console.log('\n=== Summary ===');
for (const [key, rate] of Object.entries(results)) {
  console.log(`${key}: Bones win rate ${(rate * 100).toFixed(1)}%`);
}
