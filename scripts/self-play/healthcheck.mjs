import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCSV, toGameCard } from '../../src/lib/cardData.js';
import { createInitialState, gameReducer } from '../../src/game/engine/actions.js';
import {
  buildMainDeckList, buildEffigyDeckList, autoBuildMainDeckEntries,
  autoBuildEffigyCounts, randomEffigyColor,
} from '../../src/game/engine/deck.js';
import { pickAiAction, pickAiReaction } from '../../src/game/engine/ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const pool = parseCSV(fs.readFileSync(path.join(REPO_ROOT, 'public/default-card-set.csv'), 'utf-8')).map((row, idx) => toGameCard(row, idx));

const randomDeckFor = (color) => ({
  mainDeck: buildMainDeckList(autoBuildMainDeckEntries(pool, color)),
  effigyDeck: buildEffigyDeckList(autoBuildEffigyCounts(color)),
});

const actionFor = (state, playerId) => {
  const owesChoice = state.pendingChoice?.playerId === playerId;
  const owesReaction = state.reactiveWindow?.openFor === playerId;
  const isTurn = (state.phase === 'mulligan' && !state.players[playerId].keptHand)
    || (state.phase === 'playing' && state.turnPlayer === playerId);
  if (state.pendingChoice && !owesChoice) return null;
  if (!owesChoice && !isTurn && !owesReaction) return null;
  return owesReaction ? pickAiReaction(state, playerId) : pickAiAction(state, playerId);
};

const N = 15000;
let crashes = 0, stalls = 0, completed = 0;
const crashSigs = new Map();
for (let g = 0; g < N; g++) {
  const deckA = randomDeckFor(randomEffigyColor());
  const deckB = randomDeckFor(randomEffigyColor());
  let state = createInitialState({
    mainDeckA: deckA.mainDeck, effigyDeckA: deckA.effigyDeck,
    mainDeckB: deckB.mainDeck, effigyDeckB: deckB.effigyDeck,
    startingPlayer: Math.random() < 0.5 ? 'A' : 'B',
  });
  state = gameReducer(state, { type: 'KEEP_HAND', player: 'A' });
  state = gameReducer(state, { type: 'KEEP_HAND', player: 'B' });

  let actionCount = 0;
  let lastActionType = null;
  let sameStreak = 0;
  let stalled = false;
  try {
    while (state.phase !== 'gameover' && actionCount < 4000) {
      let acted = false;
      for (const p of ['A', 'B']) {
        const action = actionFor(state, p);
        if (!action) continue;
        if (action.type === lastActionType) sameStreak++; else sameStreak = 0;
        lastActionType = action.type;
        if (sameStreak > 800) { stalled = true; }
        state = gameReducer(state, action);
        actionCount++;
        acted = true;
        break;
      }
      if (!acted || stalled) break;
    }
    if (stalled) stalls++;
    else if (state.phase === 'gameover') completed++;
  } catch (e) {
    crashes++;
    const key = e.stack.split('\n').slice(0, 2).join(' | ');
    crashSigs.set(key, (crashSigs.get(key) || 0) + 1);
  }
}
console.log(`Games: ${N}  Completed: ${completed} (${(100*completed/N).toFixed(2)}%)  Crashes: ${crashes} (${(100*crashes/N).toFixed(3)}%)  Stalls: ${stalls} (${(100*stalls/N).toFixed(3)}%)`);
[...crashSigs.entries()].sort((a,b)=>b[1]-a[1]).forEach(([k,c]) => console.log(`  ${c}x  ${k}`));
