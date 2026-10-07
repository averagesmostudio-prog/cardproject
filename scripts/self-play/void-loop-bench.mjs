// One-off benchmark: does the AI's new synergy/combo-awareness
// (synergyValue/KNOWN_COMBOS in ai.js) actually make it assemble the
// Boundless Hunger loop (Immen Gorta + Mouth of Madness + Terranean Gates)
// more often and faster? Plays the 'void' precon ("Call of the Void" —
// 2x each combo piece, aiDifficulty: 'hard') against a random other
// precon for a fixed number of games and reports win rate plus loop-
// completion rate/speed. Meant to be run against two worktrees (before vs
// after the synergy change) with this same script, for a direct A/B
// comparison — see runBatch's own game-by-game loopWin tracking below.
// Read-only, no output files. Must be run with vite-node.
//
//   node_modules/.bin/vite-node scripts/self-play/void-loop-bench.mjs [--games=N]

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
const voidPrecon = PRECON_DECKS.find((p) => p.id === 'void');
const opponentPrecons = PRECON_DECKS.filter((p) => p.id !== 'void');
// Decks are rebuilt (and so RESHUFFLED) for every game: buildMainDeckList
// shuffles once at build time and createInitialState deals the list as given,
// so a deck built once at module load would hand every game the identical
// draw order — the loop would then complete on the same turn every time (an
// early version of this bench measured exactly that: 34 completions, all on
// turn 33).
const randomOpponentDeck = () => preconDeckFor(opponentPrecons[Math.floor(Math.random() * opponentPrecons.length)]);

const actionFor = (state, playerId) => {
  const owesChoice = state.pendingChoice?.playerId === playerId;
  const owesReaction = state.reactiveWindow?.openFor === playerId;
  const isTurn = (state.phase === 'mulligan' && !state.players[playerId].keptHand)
    || (state.phase === 'playing' && state.turnPlayer === playerId);
  if (state.pendingChoice && !owesChoice) return null;
  if (!owesChoice && !isTurn && !owesReaction) return null;
  // 'void' is aiDifficulty: 'hard'; the opponent plays Hard too, so both
  // sides get the new synergy-aware scoreAction/evaluateState — isolates
  // the comparison to "does void specifically assemble its own loop more
  // often now", not "does Hard beat Standard more often".
  return owesReaction ? pickAiReaction(state, playerId) : pickAiAction(state, playerId, 'hard');
};

const playOneGame = () => {
  const startingPlayer = Math.random() < 0.5 ? 'A' : 'B';
  const opp = randomOpponentDeck();
  const voidGameDeck = preconDeckFor(voidPrecon);
  let state = createInitialState({
    mainDeckA: voidGameDeck.mainDeck, effigyDeckA: voidGameDeck.effigyDeck,
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
      const action = actionFor(state, p);
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
  return {
    winner: state.winner, stopReason, turnNumber: state.turnNumber, actionCount, phase: state.phase,
    loopWin: !!state.loopWin, loopWinner: state.loopWin?.winnerId ?? null,
  };
};

const start = Date.now();
let winsVoid = 0, winsOpp = 0, draws = 0;
let loopCompletions = 0, loopCompletionsByVoid = 0;
const loopTurns = [];
const stopReasonCounts = {};
for (let g = 0; g < GAMES; g++) {
  const result = playOneGame();
  if (result.winner === 'A') winsVoid++;
  else if (result.winner === 'B') winsOpp++;
  else draws++;
  if (result.loopWin) {
    loopCompletions++;
    if (result.loopWinner === 'A') loopCompletionsByVoid++;
    loopTurns.push(result.turnNumber);
  }
  stopReasonCounts[result.stopReason] = (stopReasonCounts[result.stopReason] || 0) + 1;
  if ((g + 1) % 25 === 0) {
    console.log(`[${((Date.now() - start) / 60000).toFixed(1)}m] ${g + 1}/${GAMES} games — Void ${winsVoid}-${winsOpp}, loop completions ${loopCompletions} (${loopCompletionsByVoid} by Void)`);
  }
}
const elapsedS = (Date.now() - start) / 1000;

console.log(`\nVoid (2x Immen Gorta + 2x Terranean Gates + 2x Mouth of Madness) vs random-precon-opponent, both Hard, ${GAMES} games.`);
console.log(`  Completed in ${elapsedS.toFixed(1)}s (${(elapsedS / GAMES * 1000).toFixed(0)}ms/game)`);
console.log(`  Void (A) wins: ${winsVoid} (${(winsVoid / GAMES * 100).toFixed(1)}%)`);
console.log(`  Opponent (B) wins: ${winsOpp} (${(winsOpp / GAMES * 100).toFixed(1)}%)`);
console.log(`  Draws/stalls: ${draws}`);
console.log(`  Boundless Hunger loop completed: ${loopCompletions}/${GAMES} (${(loopCompletions / GAMES * 100).toFixed(1)}%)`);
console.log(`  ...by Void specifically (A): ${loopCompletionsByVoid}/${GAMES} (${(loopCompletionsByVoid / GAMES * 100).toFixed(1)}%)`);
if (loopTurns.length > 0) {
  const mean = loopTurns.reduce((a, b) => a + b, 0) / loopTurns.length;
  const sorted = [...loopTurns].sort((a, b) => a - b);
  console.log(`  Loop-completion turn: mean ${mean.toFixed(1)}, median ${sorted[Math.floor(sorted.length / 2)]}, min ${sorted[0]}, max ${sorted[sorted.length - 1]}`);
}
console.log(`  Stop reasons:`, stopReasonCounts);
