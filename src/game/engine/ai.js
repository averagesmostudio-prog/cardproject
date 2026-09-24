// Rule-based opponent. Easy/Standard both use a flat greedy heuristic over
// the legal action list (scoreAction, below) with no lookahead. Hard adds a
// shallow 2-ply search on top (pickHardAction, near the bottom) — see its
// own comment for why a classical deep minimax doesn't fit this game's own
// turn structure.
import {
  getLegalActions, actorView, gameReducer, resolveProphecyModulateHitZero,
  countControlledByName, ownedFodderCells, raceTypings, hasOwnTyping, relicWithKeywordAnywhere,
} from './actions.js';
import { effectiveStrength } from './combat.js';
import { directionDelta } from './board.js';

const opponentIdOf = (playerId) => (playerId === 'A' ? 'B' : 'A');

// A small, deliberately curated table of multi-card designed interactions
// that no structured `keywords` field links together (unlike
// otherSameTypingBonus/costReduction/etc. below, which the real engine
// already cross-references by typing/name on its own). The Boundless
// Hunger loop (Immen Gorta + Mouth of Madness + Terranean Gates) is
// hand-authored engine logic (actions.js's 'boundless-hunger-*'
// pendingResolution chain), not a printed cross-reference, so the AI has
// no other way to notice it's being assembled. Each piece is identified
// the SAME way actions.js's own engine code already identifies it when
// resolving the combo for real — by exact card name for a specific
// singular card, or by the same relic keyword flag
// relicWithKeywordAnywhere already keys off of — so this table can't
// silently drift out of sync with a reprint/errata. `ownerScoped: false`
// on the two relics matches RULES.md's own "either player's copy affects
// any Being's Shift" (Mouth of Madness/Terranean Gates on the OPPONENT's
// side enable my own Immen Gorta loop just as well as my own copy would).
const KNOWN_COMBOS = [
  {
    id: 'boundless-hunger-loop',
    pieces: [
      { name: 'Immen Gorta, the Boundless Hunger', ownerScoped: true },
      { relicKeyword: 'duringEndStepForceShift', ownerScoped: false }, // Mouth of Madness
      { relicKeyword: 'duringEndStepLoseTimeCounters', ownerScoped: false }, // Terranean Gates
    ],
    // Indexed by assembled-piece count (0..pieces.length) — jumps hard on
    // the final piece since completing it is close to an outright win
    // (repeated free damage every End Phase), not linear partial credit.
    // Stays two orders of magnitude under evaluateState's own ±1,000,000
    // gameover sentinel, so it can never outrank an actual win/loss.
    //
    // Piece 1 (Immen Gorta alone) is deliberately worth NOTHING — self-play
    // validation found a real regression from giving it even a small
    // bonus: Immen Gorta already has its own printed Shift/damage ability
    // (a self-contained "ping" loop with no Relics needed), and any credit
    // for merely having it "assembled" made the Hard-mode search camp on
    // re-Shifting it turn after turn to keep collecting that credit,
    // instead of developing the board or actually working toward the
    // other two pieces — it lost every single self-play game once it fell
    // into that pattern (0/150 wins, down from a healthier baseline).
    // Reverting to 0 here removed the camping behavior in the same traced
    // games. Only 2+ pieces (a real step toward the actual combo, not just
    // "the card that happens to anchor it") get real credit.
    bonusByCount: [0, 0, 20, 150],
  },
];

const comboPieceSatisfied = (state, playerId, piece) => {
  if (piece.name) return countControlledByName(state.board, playerId, piece.name) > 0;
  if (piece.relicKeyword) return !!relicWithKeywordAnywhere(state.board, piece.relicKeyword);
  return false;
};

// Exported for direct testing, same convention as evaluateState/bestFirst/
// opponentReplyValue below.
export const knownComboValue = (state, playerId) => {
  let total = 0;
  KNOWN_COMBOS.forEach(combo => {
    const assembled = combo.pieces.filter(p => comboPieceSatisfied(state, playerId, p)).length;
    total += combo.bonusByCount[assembled] ?? combo.bonusByCount[combo.bonusByCount.length - 1];
  });
  return total;
};

// The marginal combo value of playing `card` from hand right now, given the
// CURRENT board — scoreAction scores a candidate action BEFORE gameReducer
// ever dispatches it, so it needs the delta between "as if this named piece
// were already assembled" and the real current value, not knownComboValue's
// own already-assembled read. Only meaningful for name-identified pieces (a
// hand card can complete a piece by its own name landing; it can never
// itself BE a relic-keyword piece it doesn't carry).
const knownComboMarginalValue = (state, playerId, card) => {
  let total = 0;
  KNOWN_COMBOS.forEach(combo => {
    const now = combo.pieces.filter(p => comboPieceSatisfied(state, playerId, p)).length;
    const withCard = combo.pieces.filter(p =>
      comboPieceSatisfied(state, playerId, p) || (p.name && card.name === p.name)
    ).length;
    total += (combo.bonusByCount[withCard] ?? combo.bonusByCount[combo.bonusByCount.length - 1])
      - (combo.bonusByCount[now] ?? combo.bonusByCount[combo.bonusByCount.length - 1]);
  });
  return total;
};

// Weight scale for synergyValue/summonSynergyBonus below, calibrated
// against evaluateState's existing terms: board material runs roughly
// 3-15 per Being (effectiveStrength + currentLifespan), lifespan-diff runs
// up to roughly ±100 (×2, up to ~50 Lifespan per side), hand-size runs
// roughly 0-15 (×1.5). Every weight here is sized to tip a genuinely CLOSE
// decision, not outweigh a real material/lifespan swing — KNOWN_COMBOS'
// own final-piece bonus is the one deliberate exception (see its own
// comment above).
const COST_REDUCTION_SYNERGY_CAP = 6;
const SACRIFICE_ENGINE_LIVE_BONUS = 4;
const TYPED_REACTION_HAND_BONUS = 3;
const TYPED_REACTION_BOARD_ONLY_BONUS = 1;
const REANIMATE_REACTION_BONUS = 2;
const END_OF_TURN_GROWTH_DISCOUNT = 0.75; // one End Step away from real material, not yet real
const HAND_POTENTIAL_SYNERGY_BONUS = 2;
const HAND_POTENTIAL_SYNERGY_CAP = 3;
const AURA_EMISSION_BONUS_CAP = 12;

// Synergy value ALREADY on board or in hand for `playerId` — feeds
// evaluateState (the Hard-mode search's only leaf evaluator), so the
// search itself values synergy-rich states higher at every leaf, not just
// the top-level move choice. Deliberately does NOT re-score
// otherSameTypingBonus/allTypingsBonus/perOtherTypingBonus/
// boardWideAllyBonus for an occupant already ON board — those four are
// already live-applied to effectiveStrength/currentLifespan by
// gameReducer's own recomputeLiveAuras chain (actions.js), and Hard-mode
// search always dispatches through gameReducer before calling
// evaluateState, so evaluateState's own material sum already prices them
// in once a card is actually on board. Re-adding them here would double-
// count and skew close comparisons. What's left is real value that isn't
// yet reflected as material: tempo/capability (costReduction,
// sacrificeXSummon), reaction availability contingent on a future summon/
// sacrifice (onTypedSummonedUnderControl, reanimateOnSacrificedTypedToken),
// value one End Step away (endOfTurnGrowthPerName), small capped credit
// for a HAND card whose condition is already met on board (potential, not
// yet realized), and the curated combo table.
export const synergyValue = (state, playerId) => {
  const board = state.board;
  let value = 0;
  Object.values(board).forEach(occupant => {
    if (occupant?.type !== 'being' || occupant.ownerId !== playerId) return;
    const kw = occupant.card.keywords || {};
    if (kw.costReduction) {
      const count = countControlledByName(board, playerId, kw.costReduction.name);
      value += Math.min(kw.costReduction.amount * count, COST_REDUCTION_SYNERGY_CAP);
    }
    if (kw.sacrificeXSummon && ownedFodderCells(board, playerId, kw.sacrificeXSummon.fodderName).length > 0) {
      value += SACRIFICE_ENGINE_LIVE_BONUS;
    }
    if (kw.onTypedSummonedUnderControl) {
      const typing = kw.onTypedSummonedUnderControl.typing;
      const hasHandTarget = state.players[playerId].hand.some(c => (c.typing || '').toLowerCase().includes(typing.toLowerCase()));
      if (hasHandTarget) value += TYPED_REACTION_HAND_BONUS;
      else if (hasOwnTyping(board, playerId, typing)) value += TYPED_REACTION_BOARD_ONLY_BONUS;
    }
    if (kw.reanimateOnSacrificedTypedToken && hasOwnTyping(board, playerId, kw.reanimateOnSacrificedTypedToken.typing)) {
      value += REANIMATE_REACTION_BONUS;
    }
    if (kw.endOfTurnGrowthPerName) {
      const needle = kw.endOfTurnGrowthPerName.namePart.toLowerCase();
      const count = Object.values(board).filter(o =>
        o && o !== occupant && o.type === 'being' && o.ownerId === playerId && o.card.name.toLowerCase().includes(needle)
      ).length;
      value += END_OF_TURN_GROWTH_DISCOUNT * (kw.endOfTurnGrowthPerName.strength + kw.endOfTurnGrowthPerName.lifespan) * count;
    }
  });

  let handSynergyCount = 0;
  state.players[playerId].hand.forEach(card => {
    if (handSynergyCount >= HAND_POTENTIAL_SYNERGY_CAP) return;
    const kw = card.keywords || {};
    let combos = false;
    if (kw.costReduction && countControlledByName(board, playerId, kw.costReduction.name) > 0) combos = true;
    if (!combos && kw.otherSameTypingBonus) {
      const myTypings = raceTypings(card);
      combos = myTypings.length > 0 && Object.values(board).some(o =>
        o?.type === 'being' && o.ownerId === playerId && raceTypings(o.card).some(t => myTypings.includes(t))
      );
    }
    if (!combos && kw.allTypingsBonus) combos = kw.allTypingsBonus.typings.every(t => hasOwnTyping(board, playerId, t));
    if (!combos && kw.perOtherTypingBonus) combos = hasOwnTyping(board, playerId, kw.perOtherTypingBonus.typing);
    if (combos) { value += HAND_POTENTIAL_SYNERGY_BONUS; handSynergyCount += 1; }
  });

  value += knownComboValue(state, playerId);
  return value;
};

// What a not-yet-on-board `card` would gain in live conditional/aura
// Strength+Lifespan the instant it lands, given playerId's CURRENT board —
// mirrors recomputeConditionalBonuses'/recomputeBoardWideAuraBonuses' own
// exact matching rules (actions.js) rather than reinventing them, so this
// always agrees with what the real engine applies once summoned.
// scoreAction has no other way to see this: it scores a candidate action
// BEFORE gameReducer ever dispatches it.
const summonSynergyBonus = (state, playerId, card) => {
  const kw = card.keywords || {};
  const board = state.board;
  let bonus = 0;
  if (kw.otherSameTypingBonus) {
    const myTypings = raceTypings(card);
    const hasOther = myTypings.length > 0 && Object.values(board).some(o =>
      o?.type === 'being' && o.ownerId === playerId && raceTypings(o.card).some(t => myTypings.includes(t))
    );
    if (hasOther) bonus += kw.otherSameTypingBonus.strength + kw.otherSameTypingBonus.lifespan;
  }
  if (kw.allTypingsBonus && kw.allTypingsBonus.typings.every(t => hasOwnTyping(board, playerId, t))) {
    bonus += kw.allTypingsBonus.strength + kw.allTypingsBonus.lifespan;
  }
  if (kw.perOtherTypingBonus) {
    const word = kw.perOtherTypingBonus.typing.toLowerCase();
    const count = Object.values(board).filter(o => o?.type === 'being' && o.ownerId === playerId && (o.card.typing || '').toLowerCase().includes(word)).length;
    bonus += (kw.perOtherTypingBonus.strength + kw.perOtherTypingBonus.lifespan) * count;
  }
  // Aura THIS card would emit onto existing allies — approximated as a
  // flat per-ally count (this file's own "cheap heuristic, not a
  // simulator" philosophy) rather than re-deriving
  // recomputeBoardWideAuraBonuses per ally. Capped so a wide board can't
  // let this one term swamp everything else in scoreAction.
  if (kw.boardWideAllyBonus) {
    const allyCount = Object.values(board).filter(o => o?.type === 'being' && o.ownerId === playerId).length;
    bonus += Math.min((kw.boardWideAllyBonus.strength + kw.boardWideAllyBonus.lifespan) * allyCount, AURA_EMISSION_BONUS_CAP);
  }
  return bonus;
};

// Same aura-emission case as summonSynergyBonus's own boardWideAllyBonus
// branch, but for a Prophecy about to be played (PLAY_PROPHECY) —
// recomputeBoardWideAuraBonuses (actions.js) reads boardWideAllyBonus off
// ANY face-up Prophecy occupant, not just Beings, so a Prophecy carrying
// this keyword is a real synergy signal scoreAction's flat baseline score
// currently can't see at all.
const prophecySynergyBonus = (state, playerId, card) => {
  const kw = card.keywords || {};
  if (!kw.boardWideAllyBonus) return 0;
  const allyCount = Object.values(state.board).filter(o => o?.type === 'being' && o.ownerId === playerId).length;
  return Math.min((kw.boardWideAllyBonus.strength + kw.boardWideAllyBonus.lifespan) * allyCount, AURA_EMISSION_BONUS_CAP);
};

// How many of a Prophecy's own future automatic decay ticks (the same
// 1-per-turn countdown modulate()/turn.js already applies every real turn)
// to simulate when weighing a Modulate decision. Confirmed with the user:
// a Modulate choice should be judged by the actual effect of the card
// it's ticking, including its impact across the following turns, not just
// by who controls it. Long enough to actually see whether hastening or
// delaying changes whether the Prophecy resolves within a realistic
// timeframe; short enough to stay cheap and to not pretend to see
// arbitrarily far into a game neither player has actually played out.
const MODULATE_LOOKAHEAD_TICKS = 6;

// Each further simulated tick counts a little less than the one before —
// reaching a good outcome SOONER is worth more than the identical outcome
// arriving later (tempo), and a bad outcome landing later costs less than
// the same one landing now. Without this, evaluating only the FINAL tick
// makes hastening vs. delaying a LOOK identical whenever the effect
// resolves within the window either way (both branches land on the same
// end state) — the discounted sum below is what actually rewards getting
// there first, not just getting there eventually.
const MODULATE_DISCOUNT = 0.85;

// Simulates a Prophecy's own natural decay forward through
// MODULATE_LOOKAHEAD_TICKS ticks, resolving its face-up text the exact
// same way a real turn eventually would — resolveProphecyModulateHitZero
// is the very same function applyEndOfTurnShiftDecay/modulate call every
// real turn — the moment it actually hits 0, rather than guessing from
// ownership alone, and returns a single discounted-sum value (see
// MODULATE_DISCOUNT above) rather than just the state after the full
// window. Once resolved (or the game ends), the loop stops ticking but
// keeps accumulating that same settled state for the remaining ticks —
// exactly what makes an earlier resolution accumulate more (discounted)
// weight than an identical-but-later one. A no-op tick call (timer still
// above 0) is cheap, so ticking unconditionally and letting the function's
// own guard decide is simpler than duplicating that check here.
const modulateProphecyLookaheadValue = (state, playerId, cellId) => {
  let next = state;
  let total = 0;
  let weight = 1;
  for (let i = 0; i < MODULATE_LOOKAHEAD_TICKS; i++) {
    if (next.phase !== 'gameover') {
      const occupant = next.board[cellId];
      if (occupant?.type === 'prophecy') {
        const timer = Math.max(0, (occupant.timer || 0) - 1);
        next = { ...next, board: { ...next.board, [cellId]: { ...occupant, timer } } };
        next = resolveProphecyModulateHitZero(next, cellId, true, 0);
      }
    }
    total += evaluateState(next, playerId) * weight;
    weight *= MODULATE_DISCOUNT;
  }
  return total;
};

// "When summoned ... deal (N) damage to target Being" (Mini Mage, and any
// future card sharing this exact unqualified-target shape — no "you
// control"/"an enemy" restriction, so its own target choice can land on
// either side's Being) has no way to know in advance, from a flat
// SUMMON_BEING score alone, whether it'll actually find a worthwhile
// target once it resolves. Self-play found the AI cheerfully summoning
// Mini Mage with no opposing Being on board and shooting one of its own
// instead. Mirrors the SAME "if you control a Prophecy" condition prefix
// resolveOrLogEffect itself strips (PROPHECY_CONDITION_PREFIX_RE in
// actions.js) — this only ever fires when that condition is actually met.
// Deliberately narrow (one specific text shape, not a general effect
// evaluator) — matches this file's own greedy/shallow philosophy.
const WHEN_SUMMONED_PROPHECY_COND_RE = /^if you control a Prophecy,?\s*/i;
const WHEN_SUMMONED_DAMAGE_ANY_TARGET_RE = /^deal\s*\(?(\d+)\)?\s+damage to (?:target Being|any target)\b/i;
const hasOwnProphecy = (board, playerId) =>
  Object.values(board).some(o => o?.type === 'prophecy' && o.ownerId === playerId);

// Returns the damage this card's own When Summoned trigger would deal with
// no upside — i.e. it will definitely fire (its condition, if any, is
// already met) and the only Being(s) it could possibly hit are the
// summoner's own (no opposing Being on board yet) — or 0 if the trigger
// either can't fire, isn't this shape, or has a real opposing target.
const whenSummonedSelfDamageRisk = (state, playerId, card) => {
  const text = card.keywords?.whenSummoned;
  if (!text) return 0;
  const condMatch = text.match(WHEN_SUMMONED_PROPHECY_COND_RE);
  if (condMatch && !hasOwnProphecy(state.board, playerId)) return 0; // condition unmet — never fires
  const remainder = condMatch ? text.slice(condMatch[0].length) : text;
  const damageMatch = remainder.match(WHEN_SUMMONED_DAMAGE_ANY_TARGET_RE);
  if (!damageMatch) return 0;
  const opponentId = opponentIdOf(playerId);
  const hasOpponentBeing = Object.values(state.board).some(o => o?.type === 'being' && o.ownerId === opponentId);
  if (hasOpponentBeing) return 0; // a real target exists — not a risk
  return parseInt(damageMatch[1], 10);
};

const scoreAction = (state, action, playerId) => {
  const opponentId = opponentIdOf(playerId);
  const opponent = state.players[opponentId];

  if (action.type === 'MOVE_OR_ATTACK') {
    const target = state.board[action.toCellId];
    const attacker = state.board[action.fromCellId];

    if (!action.isAttack) {
      // Plain reposition — only useful as a setup move toward the front
      // row (so a later turn can attack from there). A flat score here
      // left the AI directionally blind: every reposition option (forward,
      // sideways, or backward) tied at the same value, so ties were broken
      // by nothing more than getLegalActions' own iteration order — self-
      // play's own "moves backward when working toward an attack would
      // clearly be better." `directionDelta` already flips sign for player
      // B (board.js's own directionDelta), so "forward" isn't a universal
      // row-delta sign — it's whichever sign matches this player's own
      // HOME_ROW-to-FRONT_ROW direction (+row for A, -row for B, mirroring
      // directionDelta's own internal convention).
      const delta = directionDelta(playerId, action.direction);
      const forwardSign = playerId === 'A' ? 1 : -1;
      const advancing = delta ? delta[0] === forwardSign : false;
      const retreating = delta ? delta[0] === -forwardSign : false;
      if (advancing) return 8;
      if (retreating) return 2;
      return 5; // sideways — no closer to attacking, but no further either
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
    const card = state.players[playerId].hand.find(c => c.instanceId === action.instanceId);
    // Weighted well above the bare damage amount so a genuinely no-upside
    // self-hit (see whenSummonedSelfDamageRisk's own comment) reliably
    // drops below the AI's other options rather than merely denting this
    // one score — but not an outright ban: still summonable as a last
    // resort, same as everything else here degrading rather than vetoing.
    const selfDamageRisk = card ? whenSummonedSelfDamageRisk(state, playerId, card) * 15 : 0;
    // What this card gains live the instant it lands (typing/aura synergy
    // already on board) plus what it's worth toward a known combo — see
    // summonSynergyBonus/knownComboMarginalValue's own comments above.
    const synergyBonus = card
      ? summonSynergyBonus(state, playerId, card) + knownComboMarginalValue(state, playerId, card)
      : 0;
    return 20 + (card?.strength || 0) - selfDamageRisk + synergyBonus;
  }

  if (action.type === 'PLAY_PROPHECY') {
    const card = state.players[playerId].hand.find(c => c.instanceId === action.instanceId);
    return 15 + (card ? prophecySynergyBonus(state, playerId, card) : 0);
  }

  // Previously unscored (fell through to the flat 0 default at the bottom
  // of this function) — the real gap for the Boundless Hunger loop's own
  // two Relic pieces (Mouth of Madness/Terranean Gates), which use THIS
  // action type, not PLAY_PROPHECY. Baselined at 0, NOT 15 like
  // PLAY_PROPHECY — self-play validation found 15 made the AI rush
  // Relics out ahead of actual board development, since (unlike a
  // Prophecy, which can become a real Being) a Relic never blocks an
  // attack (RULES.md > Combat) and provides zero defensive value; losing
  // games showed it eating full unblocked damage turn after turn while
  // it had already "used" its priority placing a Relic instead. Real
  // combo-completion value still comes through via knownComboMarginalValue.
  if (action.type === 'PLACE_RELIC') {
    const card = state.players[playerId].hand.find(c => c.instanceId === action.instanceId);
    return card ? knownComboMarginalValue(state, playerId, card) : 0;
  }

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

  // RESOLVE_MODULATE's own +1/-1 pair used to both fall through to the
  // flat 0 below whenever a card grants a genuine +1-or-(-1) choice
  // (delta: 'choose' — actions.js's getLegalActions always pushes the +1
  // option first for one of these). Tied at 0, pickAiAction's strict `>`
  // tie-break always kept that first-pushed +1 — so the AI reflexively
  // delayed things every single time one of these fired, never letting
  // its own stuff actually resolve. Self-play's own complaint: "not
  // allowing a Prophecy to resolve, modulating it up instead."
  //
  // Confirmed with the user: a Modulate choice targeting a Prophecy should
  // actually be judged by the real effect of the card it's ticking — does
  // hastening or delaying change WHETHER and WHEN its face-up text
  // resolves, and is that good or bad for me, including several turns out
  // — not guessed from ownership alone. modulateProphecyLookaheadValue
  // (above) simulates this delta's own board forward through the
  // Prophecy's remaining natural decay, resolving it for real the moment
  // it hits 0 — this is called once per candidate delta (this function's
  // own contract), so the caller's plain max-score comparison naturally
  // picks whichever real outcome is better, no separate side-by-side
  // comparison needed here.
  if (action.type === 'RESOLVE_MODULATE' && action.cellId && state.board[action.cellId]?.type === 'prophecy') {
    return modulateProphecyLookaheadValue(gameReducer(state, action), playerId, action.cellId);
  }
  // Every other Modulate target shape (an Altar — 0 Time Counters is its
  // own meaningful state, e.g. Eònion Altar's craft bonus — or any other
  // Time-Counter-bearing occupant) has no comparable "resolve at 0"
  // mechanic to simulate forward the same way, so this keeps the simpler
  // ownership-based default: hastening your own stuff toward whatever its
  // Time Counters gate is the sensible default, delaying the opponent's
  // is the defensive mirror. `ownerId` covers both addressing shapes —
  // `action.cellId` (a board occupant) and `action.altarInstanceId`
  // (searched across both players' `state.altars`, since an Altar's own
  // owner isn't otherwise derivable from the action alone).
  if (action.type === 'RESOLVE_MODULATE') {
    const ownerId = action.altarInstanceId
      ? Object.keys(state.altars || {}).find(oid => (state.altars[oid] || []).some(a => a.card.instanceId === action.altarInstanceId))
      : state.board[action.cellId]?.ownerId;
    if (ownerId) {
      const own = ownerId === playerId;
      const preferredDelta = own ? -1 : 1;
      return action.delta === preferredDelta ? 10 : 4;
    }
  }

  return 0;
};

// Sorts legal actions by the plain greedy heuristic (scoreAction), best
// first — reused as the search's own move-ordering wherever a node
// budget might run out partway through a candidate list, so the leftover
// budget is always spent on the most promising branches first rather than
// whatever order getLegalActions happened to produce them in. scoreAction
// already has a safe default (0) for any action type it doesn't
// explicitly recognize, so this is safe to use over the full
// heterogeneous action list (RESOLVE_* pendingChoice actions,
// PASS_PRIORITY, etc. included), not just plain turn actions.
// Exported for direct testing (ai.test.js) — otherwise only used
// internally below.
export const bestFirst = (state, playerId, actions) =>
  [...actions].sort((a, b) => scoreAction(state, b, playerId) - scoreAction(state, a, playerId));

// The plain flat-heuristic picker (Easy/Standard).
const pickGreedyAction = (state, playerId) => {
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

// ---- Hard difficulty: a shallow, bounded search ----
//
// This game's own turn structure — one player takes a whole SEQUENCE of
// individual actions before passing, not a single alternating move the way
// chess does — means a classical recursive minimax tree doesn't map onto
// it cleanly, and hidden information (the opponent's hand and deck order)
// makes deep search less trustworthy than in a perfect-information game
// anyway. What this adds instead: search up to MAX_OWN_PLY of the AI's OWN
// actions deep (so a move that only pays off — or only gets punished — a
// couple of actions later is actually foreseen, not just the immediate
// one), and the moment the turn or priority would actually pass to the
// opponent, fold in a few plies of their own best GREEDY replies (see
// OPPONENT_REPLY_BREADTH/opponentReplyValue, below — reusing scoreAction,
// not another hard search — modeling the opponent as a reasonable-but-
// not-searching player is what keeps this bounded instead of mutually
// recursive) before evaluating the resulting board. A shared node budget
// across the whole search caps worst-case latency regardless of how bushy
// any one branch turns out to be (a "choose up to N candidates" toggle
// choice, say), degrading gracefully to a shallower effective search
// there rather than blowing up — candidates are explored in bestFirst
// order (above) precisely so that degradation spends whatever budget is
// left on the most promising branches, not an arbitrary one.
//
// Both constants below are sized off a real measurement, not a guess:
// benchmarked across 300 full AI-vs-AI games (getLegalActions' own
// branching factor was mean ~6 / median 4 / p90 14 per decision), a
// single (dispatch + getLegalActions) "node" costs ~0.1ms. 6000 nodes is
// therefore ≈600ms worst case — a perfectly reasonable "AI is thinking"
// pause for a turn-based game — with real headroom over the old 600-node
// (≈60ms) budget, and MAX_OWN_PLY=4 comfortably fits within it on a
// typical (non-busy) board (6+36+216+1296 ≈ 1554 of the 6000 budget,
// leaving the rest for wider boards and opponent-reply modeling). Both
// are empirically-chosen starting points, not exact science — worth
// tuning further after live play-testing.
const MAX_OWN_PLY = 4;
const MAX_SEARCH_NODES = 6000;

// How many of the opponent's own top-scoring (by THEIR greedy heuristic)
// replies to consider when folding in their turn, rather than just their
// single best — the AI then defends against the WORST of those for
// itself, instead of assuming the opponent always plays their literal
// single greediest option. Kept small: this cost multiplies the "turn
// just passed" leaf case, and the opponent's own turn is still never
// searched further beyond these replies (see this file's own note above
// on why not — hidden information about their hand/deck).
const OPPONENT_REPLY_BREADTH = 3;

// Static board evaluation — the search's leaf value function. Kept
// intentionally compact (life totals, board material, hand size) rather
// than a deep per-card evaluator, matching this file's own established
// "greedy/shallow, not a full effect simulator" philosophy elsewhere — the
// search gets its power from looking a step ahead with this, not from a
// heavier evaluation function. Exported for direct testing (ai.test.js) —
// otherwise only used internally below.
export const evaluateState = (state, playerId) => {
  const opponentId = opponentIdOf(playerId);
  if (state.phase === 'gameover') {
    if (state.winner === playerId) return 1_000_000;
    if (state.winner === opponentId) return -1_000_000;
    return 0; // draw
  }
  let value = (state.players[playerId].lifespan - state.players[opponentId].lifespan) * 2;
  // Board material — actorView (see scoreAction's own comment on it above)
  // reads a plain Being or an Animated Armament-stack's topmost entry
  // uniformly; it returns null for a Relic/Altar/Prophecy/inert armament
  // pile, which this simply skips rather than trying to value them too.
  Object.values(state.board).forEach(occupant => {
    if (!occupant?.ownerId) return;
    const view = actorView(occupant);
    if (!view) return;
    const material = effectiveStrength(view) + (view.currentLifespan || 0);
    value += occupant.ownerId === playerId ? material : -material;
  });
  value += (state.players[playerId].hand.length - state.players[opponentId].hand.length) * 1.5;
  // Synergy/combo awareness — see synergyValue's own comment above for why
  // this deliberately skips value the material loop above already prices in.
  value += synergyValue(state, playerId) - synergyValue(state, opponentId);
  return value;
};

// Whether `playerId` still has an immediate decision to make in `state` —
// mirrors useGameEngine.js's own "is it the AI's move" check exactly
// (aiOwesChoice/aiOwesReaction/isAiTurn there), so the search's notion of
// "my turn continues" can never drift out of sync with what actually
// drives the real AI loop.
const stillToAct = (state, playerId) =>
  state.pendingChoice?.playerId === playerId
  || state.reactiveWindow?.openFor === playerId
  || (state.phase === 'playing' && state.turnPlayer === playerId);

// A RESOLVE_MODULATE targeting a Prophecy is special-cased to a direct
// leaf evaluation via modulateProphecyLookaheadValue (see scoreAction's
// own identical reasoning above it) rather than the generic recursion
// below — recursing further only explores MORE of this same turn's own
// actions, never reaches the Prophecy's own eventual resolution on a
// LATER turn, so plain recursion structurally can't see the thing this
// decision actually turns on. Shared by both searchValue's own inner loop
// and pickHardAction's top-level one below, so Hard difficulty gets the
// same real multi-turn look at a Modulate decision Easy/Standard already
// do via scoreAction, not just whatever its generic bounded search
// happens to see within the current turn.
const valueOfCandidate = (state, playerId, action, plyBudget, budget) => {
  if (action.type === 'RESOLVE_MODULATE' && action.cellId && state.board[action.cellId]?.type === 'prophecy') {
    return modulateProphecyLookaheadValue(gameReducer(state, action), playerId, action.cellId);
  }
  // A "toggle candidates in, then confirm" pendingChoice (kind always ends
  // in '-toggle' by convention — sacrifice-x-toggle, shuffle-purgatory-
  // toggle, etc.; Match.jsx's own TOGGLE_CHOICE_KINDS enumerates the exact
  // set) doesn't change any board material/lifespan/hand size at all until
  // CONFIRM finally commits — a toggle is "free" to the generic recursive
  // searchValue below, which has no notion that probing further here is a
  // no-progress round trip. Found via self-play: that made the search
  // prefer flip-flopping a toggle forever over ever committing, since
  // "keep exploring, don't commit yet" always looked at least marginally
  // as good as confirming/declining in a myopic per-node comparison — a
  // genuine, reachable infinite loop (a real `sacrifice-x-toggle` with
  // CONFIRM legal and clearly correct scored only 47.5 by search vs. 51
  // for un-toggling the very candidate it had just added). scoreAction
  // already has the correct, deliberate anti-loop ranking for exactly this
  // shape (toggle-new-candidate > confirm > toggle-existing-candidate >
  // pass) — reused directly here for EVERY sibling option at this same
  // decision point (toggle, confirm, AND decline alike, so they stay on
  // one consistent scale and remain comparable against each other) instead
  // of letting the generic recursion re-discover, and sometimes get wrong,
  // the same thing. Gated on the pendingChoice's own kind specifically
  // (not just the action's own '_TOGGLE'/'_CONFIRM'/RESOLVE_DECLINE
  // suffix) so an unrelated RESOLVE_DECLINE on a completely different,
  // non-toggle optional choice (e.g. an optional Modulate) still gets the
  // full recursive search it deserves — this only short-circuits the
  // specific toggle-then-confirm shape that's actually vulnerable to the
  // loop. Does give up search-driven insight for the toggle sequence
  // itself (Easy/Standard already resolve these the same way, one
  // scoreAction-ranked step at a time), a deliberate, low-risk trade for a
  // class of decision that was outright broken otherwise.
  if (state.pendingChoice?.kind?.endsWith('-toggle')
    && (action.type.endsWith('_TOGGLE') || action.type.endsWith('_CONFIRM') || action.type === 'RESOLVE_DECLINE')) {
    return scoreAction(state, action, playerId);
  }
  return searchValue(gameReducer(state, action), playerId, plyBudget, budget);
};

// The worst outcome (for `playerId`) among the opponent's own top
// OPPONENT_REPLY_BREADTH greedy replies — replaces assuming they always
// play their single most greedy-by-their-own-metric move. Each simulated
// reply spends one more of the shared node budget; degrades gracefully to
// fewer replies (down to the old single-best behavior, or the plain
// static eval with zero) once the budget runs low, same as every other
// budget-limited loop in this file. Exported for direct testing
// (ai.test.js) — otherwise only used internally below.
export const opponentReplyValue = (state, playerId, budget) => {
  const opponentId = opponentIdOf(playerId);
  const opponentActions = getLegalActions(state, opponentId);
  if (opponentActions.length === 0) return evaluateState(state, playerId);
  const sorted = bestFirst(state, opponentId, opponentActions);
  // Only defend against replies genuinely close to the opponent's own
  // best-scoring option, not just literally top-N by rank — without this,
  // a much-lower-scored "last resort" option (PASS_TURN, scored -100, see
  // scoreAction) can still get pulled into the worst-case check purely
  // because it's one of only 2-3 legal actions, and its simulated outcome
  // can be catastrophic for reasons that have nothing to do with the
  // opponent making a good choice (e.g. it simply lets a later turn
  // boundary happen sooner, tripping over some other, unrelated mid-game
  // event) — that's not a real threat to defend against, it's noise from
  // treating an option the opponent would never actually take as if it
  // were a live possibility. A positive top score is halved for the
  // cutoff (a real relative-closeness bar); a non-positive top score
  // means every legal option already looks bad to the opponent, so
  // there's nothing meaningfully "close" to widen into — just use their
  // single best.
  const topScore = scoreAction(state, sorted[0], opponentId);
  const threshold = topScore > 0 ? topScore / 2 : topScore;
  const candidates = sorted
    .filter(action => scoreAction(state, action, opponentId) >= threshold)
    .slice(0, OPPONENT_REPLY_BREADTH);
  let worst = Infinity;
  candidates.forEach(action => {
    if (budget.remaining <= 0) return;
    budget.remaining -= 1;
    const value = evaluateState(gameReducer(state, action), playerId);
    if (value < worst) worst = value;
  });
  return worst === Infinity ? evaluateState(state, playerId) : worst;
};

// The value of `state` from `playerId`'s own perspective, `plyBudget` of
// their own further actions deep. `budget` is a single mutable node
// counter shared across the WHOLE top-level search (every recursive call
// and every candidate action decrements it) — once it runs out, every
// further node just evaluates immediately instead of recursing or
// simulating an opponent reply, so a single bushy branch can never blow
// past the overall latency budget.
const searchValue = (state, playerId, plyBudget, budget) => {
  if (state.phase === 'gameover' || budget.remaining <= 0) return evaluateState(state, playerId);
  if (stillToAct(state, playerId)) {
    if (plyBudget <= 0) return evaluateState(state, playerId);
    const actions = bestFirst(state, playerId, getLegalActions(state, playerId));
    if (actions.length === 0) return evaluateState(state, playerId);
    let best = -Infinity;
    actions.forEach(action => {
      if (budget.remaining <= 0) return;
      budget.remaining -= 1;
      const value = valueOfCandidate(state, playerId, action, plyBudget - 1, budget);
      if (value > best) best = value;
    });
    return best === -Infinity ? evaluateState(state, playerId) : best;
  }
  // Turn or priority actually passed to the opponent — fold in their own
  // top few greedy replies and defend against the worst of them (see
  // opponentReplyValue, above), then evaluate from my own perspective.
  return opponentReplyValue(state, playerId, budget);
};

const pickHardAction = (state, playerId) => {
  const actions = bestFirst(state, playerId, getLegalActions(state, playerId));
  if (actions.length === 0) return null;
  const budget = { remaining: MAX_SEARCH_NODES };
  let best = actions[0];
  let bestValue = -Infinity;
  actions.forEach(action => {
    if (budget.remaining <= 0) return;
    budget.remaining -= 1;
    const value = valueOfCandidate(state, playerId, action, MAX_OWN_PLY - 1, budget);
    if (value > bestValue) {
      bestValue = value;
      best = action;
    }
  });
  return best;
};

// `aiDifficulty` ('easy' | 'standard' | 'hard', PreconSelect.jsx's own
// toggle — threaded here via GameApp.jsx > Match.jsx > useGameEngine.js)
// only steers Hard onto the search above; Easy and Standard are otherwise
// identical today (Easy's own distinction is entirely in which precon deck
// pickAiDeck draws for it, not how it plays — see precons.js).
export const pickAiAction = (state, playerId, aiDifficulty = 'standard') => {
  if (aiDifficulty === 'hard') return pickHardAction(state, playerId);
  return pickGreedyAction(state, playerId);
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
