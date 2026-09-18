// Simple rule-based opponent for Phase 1 — no search tree, just a greedy
// heuristic over the legal action list. Upgrade path: replace pickAction's
// scoring with a shallow minimax once the core loop is proven out.
import { getLegalActions, actorView } from './actions.js';
import { effectiveStrength } from './combat.js';

const opponentIdOf = (playerId) => (playerId === 'A' ? 'B' : 'A');

const scoreAction = (state, action, playerId) => {
  const opponentId = opponentIdOf(playerId);
  const opponent = state.players[opponentId];

  if (action.type === 'MOVE_OR_ATTACK') {
    const target = state.board[action.toCellId];
    const attacker = state.board[action.fromCellId];

    if (!action.isAttack) {
      // Plain reposition — only useful as a setup move toward the front
      // row (so a later turn can attack from there).
      return 5;
    }

    // `attacker`/`target` may be an armament-stack occupant (an Animated
    // Armament acting as a Being — RULES.md > Keywords) rather than a plain
    // `type: 'being'` one, which doesn't carry a top-level `.card`/
    // `.currentLifespan` itself. `actorView` (actions.js) is the same
    // uniform-view helper the real MOVE_OR_ATTACK reducer already uses to
    // read either shape — reused here so the AI's own pre-dispatch scoring
    // doesn't crash reading `.card.strength` off a bare armament-stack.
    const attackerView = actorView(attacker);
    const attackerStrength = effectiveStrength(attackerView);
    const targetView = actorView(target);
    if (!targetView) {
      // Attacking into an empty lane (or a non-Animated, Being-less
      // Armament pile, which can't be attacked as a Being either) always
      // lands — favor lethal, then damage.
      const lethal = opponent.lifespan - attackerStrength <= 0;
      return lethal ? 1000 : 50 + attackerStrength;
    }
    // Occupied lane: mutual damage. Prefer trades that kill without dying,
    // or that kill a bigger threat than what you risk.
    const targetStrength = effectiveStrength(targetView);
    const killsDefender = targetView.currentLifespan - attackerStrength <= 0;
    const attackerDies = attackerView.currentLifespan - targetStrength <= 0;
    if (killsDefender && !attackerDies) return 80 + targetStrength;
    if (killsDefender && attackerDies) return 30 + (targetStrength - attackerStrength);
    if (!killsDefender && !attackerDies) return 10;
    return -20; // dies for nothing
  }

  if (action.type === 'SUMMON_BEING') {
    return 20 + (state.players[playerId].hand.find(c => c.instanceId === action.instanceId)?.strength || 0);
  }

  if (action.type === 'PLAY_PROPHECY') return 15;
  if (action.type === 'KEEP_HAND') return 10;
  if (action.type === 'MULLIGAN') return 0;
  if (action.type === 'PASS_TURN') return -100; // last resort
  return 0;
};

export const pickAiAction = (state, playerId) => {
  const actions = getLegalActions(state, playerId);
  if (actions.length === 0) return null;
  let best = actions[0];
  let bestScore = -Infinity;
  actions.forEach(action => {
    const score = scoreAction(state, action, playerId);
    if (score > bestScore) {
      bestScore = score;
      best = action;
    }
  });
  return best;
};
