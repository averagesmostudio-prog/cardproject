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

  // "Pay (N) <Color>: <effect>" (Blooming Seed, Skeleton Key) has no
  // printed per-turn cap and stays legal every time it's affordable — fine
  // normally, since a real cost eventually exhausts the player's own
  // Effigy pool. But another permanent can reduce that printed cost all
  // the way to 0 (Nursery Attendant pointing at a Seed), and once it's
  // genuinely free, nothing ever makes it illegal again this turn. A
  // greedy AI with no other reason to prefer PASS_TURN (-100) over this
  // action's own otherwise-flat 0 score would just repeat a free,
  // no-longer-useful "add a counter to myself" forever (self-play found
  // this exact shape as a real, otherwise-endless stall). Once already
  // used this turn (payEffigyAbilityUsesThisTurn, bumped unconditionally
  // by the reducer regardless of the ability's own `once` cap), score it
  // below PASS_TURN so the AI moves on — the ability itself stays exactly
  // as repeatable as before at the legality level, only the AI's greedy
  // preference changes.
  if (action.type === 'ACTIVATE_PAY_EFFIGY_COST_ABILITY') {
    const used = state.board[action.cellId]?.payEffigyAbilityUsesThisTurn || 0;
    if (used > 0) return -150;
    // "Disengage." as the ability's own effect (Anahk-sha: "Once per turn
    // Pay (1) Bleeding Essence: Disengage.") is a different shape from a
    // generic value-add ("add a counter", "trigger Depart") — it recovers
    // a whole Being that's otherwise dead weight for the rest of the turn,
    // AND (since this action doesn't itself cost the Being's own turn
    // action) immediately re-opens a real MOVE_OR_ATTACK for it on the
    // AI's very next decision, which will naturally outscore everything
    // else once it's legal again — no lookahead needed here, just making
    // sure the AI actually takes this step instead of leaving it engaged.
    // Self-play's own card-impact data found Anahk-sha underperforming a
    // plain vanilla Being of the same cost specifically because the old
    // flat score (8) routinely lost out to SUMMON_BEING/PLAY_PROPHECY,
    // leaving it stuck engaged turn after turn instead of paying its own
    // upkeep. Scored above those (20-25ish) so recovering an existing
    // attacker wins the toss-up against playing a new card.
    const effect = state.board[action.cellId]?.card?.keywords?.payEffigyCostAbility?.effect;
    if (/^Disengage\.?$/i.test(effect || '')) return 28;
    return 8;
  }

  // Every "toggle candidates in, then confirm" pendingChoice (shuffle-
  // purgatory-toggle, sacrifice-x-toggle, summon-vine-tokens-toggle,
  // sacrifice-any-beings-toggle, favor-pointed-toggle, discard-x-named —
  // actions.js's own RESOLVE_*_TOGGLE/RESOLVE_*_CONFIRM pairs) used to fall
  // through to the flat `return 0` below for every one of those actions,
  // toggle AND confirm alike. Since pickAiAction only replaces its current
  // best on a STRICT `score > bestScore`, an all-tied-at-0 field always
  // keeps whichever action getLegalActions happened to push first — always
  // a TOGGLE, since every one of those offer blocks pushes CONFIRM last.
  // The AI could never reach CONFIRM: it kept re-toggling the same first
  // candidate on and off forever, a real, reachable infinite loop (found
  // via self-play simulation, not simulation-only — RESOLVE_SHUFFLE_
  // PURGATORY_TOGGLE alone hit it in seconds against a plain greedy
  // opponent). Toggling ON a new candidate now outscores confirming
  // (so an "up to N" choice actually fills up to N before committing);
  // toggling a candidate back OFF is never worth it on its own.
  if (action.type.endsWith('_TOGGLE') && state.pendingChoice) {
    const id = action.instanceId ?? action.cellId;
    const alreadySelected = state.pendingChoice.selected?.includes(id);
    return alreadySelected ? -5 : 10;
  }
  if (action.type.endsWith('_CONFIRM')) return 5;

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

// Ethereal Conjuring reactive timing (actions.js's manageReactiveWindow) —
// a separate scoring function from scoreAction above, not a reuse of it:
// scoreAction has no case for CAST_CONJURING/PASS_PRIORITY, so both would
// silently score 0 and pickAiAction's strict `score > bestScore` tie-break
// would always keep whichever came first in getLegalActions' own list
// (PASS_PRIORITY, pushed before any CAST_CONJURING option) — the AI would
// always pass and never react. Flat "always react if affordable" scoring,
// matching this file's own near-flat-constant philosophy everywhere else
// (PLAY_PROPHECY → 15, KEEP_HAND → 10) — 15 deliberately mirrors
// PLAY_PROPHECY's own score, the closest existing precedent ("cast a
// non-Being spell"), keeping the reactive AI's aggressiveness in the same
// ballpark as its normal-turn casting rather than inventing a new tier. A
// real per-Ethereal-Conjuring-effect evaluation isn't worth building here —
// the effect text is too free-form (mirrors resolveOrLogEffect's own huge
// dispatch table) for a meaningful generic value function, and this file's
// own established stance is greedy-not-deep everywhere else.
// Engage abilities are "ethereal speed" too (actions.js > manageReactiveWindow,
// getLegalActions' own reactiveWindow branch) — same flat-score treatment as
// CAST_CONJURING, for the same reason: without this, ACTIVATE_ENGAGE/
// ACTIVATE_GROUND_RELIC_ENGAGE/ACTIVATE_ARMAMENT_ENGAGE would all silently
// score 0 (tying PASS_PRIORITY, pushed first) and the AI would never
// reactively Engage anything.
const REACTIVE_RESPONSE_ACTION_TYPES = new Set(['CAST_CONJURING', 'ACTIVATE_ENGAGE', 'ACTIVATE_GROUND_RELIC_ENGAGE', 'ACTIVATE_ARMAMENT_ENGAGE']);
const scoreReaction = (action) => (REACTIVE_RESPONSE_ACTION_TYPES.has(action.type) ? 15 : 0);

export const pickAiReaction = (state, playerId) => {
  const actions = getLegalActions(state, playerId);
  if (actions.length === 0) return null;
  let best = actions[0];
  let bestScore = -Infinity;
  actions.forEach(action => {
    const score = scoreReaction(action);
    if (score > bestScore) {
      bestScore = score;
      best = action;
    }
  });
  return best;
};
