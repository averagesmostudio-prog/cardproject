import { drawCard } from './deck.js';
import { EFFIGY_ROW_FIRST_TURN_BONUS } from './constants.js';
import { opponentOf, computeMoveDestination } from './board.js';
import { makeTemporaryEssence } from '../../lib/cardData.js';
// A Prophecy's own two-phase Time Counter lifecycle (flip face up and
// resolve its printed text when a face-down timer hits 0, then go to
// Purgatory once its new face-up Time Counters also run out — RULES.md >
// Prophecies) is shared with a card-granted "Modulate (±X)" effect
// (RESOLVE_MODULATE, actions.js), so it lives there. actions.js already
// imports several things from this file (addLog, beginTurn, ...);
// importing this one back is safe since it's never touched at
// module-top-level in either file, only from inside function bodies
// called well after both modules finish loading.
import {
  resolveProphecyModulateHitZero, recomputeXBeings, recomputeDeathCountBonuses, recomputeConditionalBonuses,
  recomputeBoardWideAuraBonuses, recomputeKalmahkaOverrides,
  moveBeingFreely, triggerOnRevealedTopOfDeck, applyDesperateFinaleSacrifice, dealDamageToBeing, destroyBeing,
} from './actions.js';

export const addLog = (state, message) => ({
  ...state,
  log: [...state.log, { turn: state.turnNumber, player: state.turnPlayer, message }],
});

// "Once per turn when a Time Counter is removed from a Prophecy you
// control, add (N) <Color> Essence" (e.g. "Eònion Zealot") — a passive
// trigger, not Engage-costed, reacting to *any* Time Counter removal from a
// Prophecy the trigger's own controller controls (not necessarily whoever's
// turn it is — RESOLVE_MODULATE in actions.js can decrement a Prophecy on
// either player's turn, and calls this the same way the automatic tick
// below does). Exported so actions.js's RESOLVE_MODULATE can call it too.
// The granted Essence is temporary, same as a Zealot's Engage-granted "Add
// Essence" (see actions.js > ADD_ESSENCE_RE) — good only until end of turn.
export const triggerZealotProphecyEssence = (state, prophecyOwnerId) => {
  let next = state;
  Object.entries(next.board).forEach(([cell, occupant]) => {
    if (occupant?.type !== 'being' || occupant.ownerId !== prophecyOwnerId || occupant.usedProphecyTrigger) return;
    const grant = occupant.card.keywords?.onProphecyCounterRemoved;
    if (!grant) return;
    const owner = next.players[prophecyOwnerId];
    next = {
      ...next,
      board: { ...next.board, [cell]: { ...occupant, usedProphecyTrigger: true } },
      players: {
        ...next.players,
        [prophecyOwnerId]: { ...owner, effigyPool: [...owner.effigyPool, ...makeTemporaryEssence(grant.type, grant.amount)] },
      },
    };
    next = addLog(next, `${occupant.card.name} triggers, adding ${grant.amount} ${grant.type} Essence to ${prophecyOwnerId}'s pool until end of turn.`);
  });
  return next;
};

// "Whenever a Time Counter is removed from a Prophecy you control add it
// to this" (Hourglass) — same trigger point as the Zealot reaction above,
// just collecting the Counter onto its own `counters.time` instead of
// granting Essence, and with no "Once per turn" limit — every removal
// counts, so (unlike the Zealot) there's no used-this-turn flag to reset.
// Each Hourglass the player controls collects independently.
export const triggerHourglassCollection = (state, prophecyOwnerId) => {
  let next = state;
  Object.entries(next.board).forEach(([cell, occupant]) => {
    // Hourglass (a Relic) and Horologist's Apprentice (a Being) print the
    // exact same trigger, just worded in the opposite order.
    if ((occupant?.type !== 'relic' && occupant?.type !== 'being') || occupant.ownerId !== prophecyOwnerId) return;
    if (!occupant.card.keywords?.collectsRemovedProphecyTimeCounters) return;
    const have = occupant.counters?.time || 0;
    next = { ...next, board: { ...next.board, [cell]: { ...occupant, counters: { ...occupant.counters, time: have + 1 } } } };
    next = addLog(next, `${occupant.card.name} collects a Time Counter (now ${have + 1}).`);
  });
  return next;
};

// Resets each Zealot's once-per-turn Prophecy-counter-removal trigger for
// the turn player at the *start* of their own turn — before modulate() ticks
// their Prophecies down below, so a trigger firing during this same
// beginTurn call isn't immediately un-used again by this same step.
const resetZealotTriggers = (state) => {
  const board = { ...state.board };
  let changed = false;
  Object.entries(board).forEach(([cell, occupant]) => {
    if (occupant?.type === 'being' && occupant.ownerId === state.turnPlayer && occupant.usedProphecyTrigger) {
      board[cell] = { ...occupant, usedProphecyTrigger: false };
      changed = true;
    }
  });
  return changed ? { ...state, board } : state;
};

// Tilled Fields: "If this is Engaged at the end of the turn, sacrifice
// it." — checked against the occupant's own live `engaged` field, for
// both a normal board Relic and a ground one (RULES.md > Keywords >
// "Beings may move across this"). Neither has a death pipeline of its own
// (sacrificeOccupantAt's own precedent, actions.js) — just removed.
const applySacrificeIfEngagedAtEndOfTurn = (state) => {
  let next = state;
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (occupant?.type === 'relic' && occupant.ownerId === state.turnPlayer && occupant.engaged && occupant.card.keywords?.sacrificeIfEngagedAtEndOfTurn) {
      const board = { ...next.board };
      delete board[cell];
      next = addLog({ ...next, board }, `${occupant.card.name} is sacrificed (still Engaged at end of turn).`);
    }
  });
  Object.entries(state.groundRelics).forEach(([cell, occupant]) => {
    if (occupant?.ownerId === state.turnPlayer && occupant.engaged && occupant.card.keywords?.sacrificeIfEngagedAtEndOfTurn) {
      const groundRelics = { ...next.groundRelics };
      delete groundRelics[cell];
      next = addLog({ ...next, groundRelics }, `${occupant.card.name} is sacrificed (still Engaged at end of turn).`);
    }
  });
  return next;
};

// Tilled Fields' own "Until end of turn Plants summoned on this tile come
// in Disengaged." — the flag it sets on itself (PLANTS_ENTER_DISENGAGED_RE,
// actions.js) is genuinely "until end of turn", so it's cleared here too.
const clearPlantsEnterDisengagedFlags = (state) => {
  const groundRelics = { ...state.groundRelics };
  let changed = false;
  Object.entries(groundRelics).forEach(([cell, occupant]) => {
    if (occupant?.plantsEnterDisengagedUntilEndOfTurn) {
      groundRelics[cell] = { ...occupant, plantsEnterDisengagedUntilEndOfTurn: false };
      changed = true;
    }
  });
  return changed ? { ...state, groundRelics } : state;
};

// Lotus's own pair of "Once per turn, when a <Typing> you control dies..."
// reactions (actions.js > triggerDeckSearchOnTypedDeath) — each clause's
// own used-flag resets at the start of its controller's next turn, same
// scoping and shape as resetZealotTriggers above.
const resetLotusTriggers = (state) => {
  const board = { ...state.board };
  let changed = false;
  Object.entries(board).forEach(([cell, occupant]) => {
    if (occupant?.type === 'relic' && occupant.ownerId === state.turnPlayer && occupant.typedDeathSearchUsed) {
      board[cell] = { ...occupant, typedDeathSearchUsed: undefined };
      changed = true;
    }
  });
  return changed ? { ...state, board } : state;
};

// Plague doctor's own "...for each Being that died under your control this
// turn" (actions.js > incrementBeingsDiedThisTurn) means "this turn" quite
// literally — the currently active turn, whoever's it is — so BOTH
// players' running counts reset here, not just the turn player's own
// (unlike resetZealotTriggers above, which is deliberately one-sided). A
// death that happened during the opponent's whole prior turn shouldn't
// still read as "this turn" once a new turn begins.
const resetBeingsDiedThisTurn = (state) => ({
  ...state,
  players: {
    A: { ...state.players.A, beingsDiedThisTurn: 0 },
    B: { ...state.players.B, beingsDiedThisTurn: 0 },
  },
});

// Restless Dead's own deathCountBonus (actions.js > recomputeDeathCountBonuses)
// tracks how much Lifespan it's already healed from beingsDiedThisTurn, so a
// later recompute only heals the NEW delta rather than re-healing the same
// amount — that tracker has to reset in the same beat beingsDiedThisTurn
// itself does, or the next recompute would read last turn's already-applied
// total against a freshly-zeroed count and claw the heal back down.
const clearDeathCountBonusTracking = (state) => {
  const board = { ...state.board };
  let changed = false;
  Object.entries(board).forEach(([cell, occupant]) => {
    if (occupant?.deathCountBonus) {
      board[cell] = { ...occupant, deathCountBonus: undefined };
      changed = true;
    }
  });
  return changed ? { ...state, board } : state;
};

// Minute-taur: "At the start of your turn move forward. At the end of your
// turn move backward." — a forced, unconditional move (no "may", not
// gated by Engage/tap — the text says nothing about either), same
// direction-1/direction-5 geometry a normal arrow move already uses
// (computeMoveDestination, board.js, is already player-relative). A
// graceful no-op when there's nowhere legal to go (off-board, into the
// Ethereal Realm, onto an occupied tile) — same "documented simplification,
// not every edge case" precedent as every other automatic effect here,
// rather than a hard requirement that always finds a destination.
const applyForcedDirectionalMoves = (state, keywordField, direction) => {
  let next = state;
  Object.keys(state.board).forEach(cell => {
    const occupant = next.board[cell];
    if (!occupant || occupant.type !== 'being' || occupant.ownerId !== state.turnPlayer) return;
    if (!occupant.card.keywords?.[keywordField]) return;
    const toCellId = computeMoveDestination(occupant.ownerId, cell, direction);
    if (!toCellId || next.board[toCellId]) return;
    next = moveBeingFreely(next, cell, toCellId);
  });
  return next;
};

// Lingering Doubt: "At the end of your turn gain +1/+1 for each other
// <NamePart> you control." — "Doubt" here is a name-family reference
// (Lingering Doubt/Passing Doubt), not a printed typing word, so this
// counts by NAME SUBSTRING rather than the `typing` field every other
// per-count bonus in this file uses. A real, permanent stat gain applied
// once here (RULES.md's Down Tick Step is a discrete moment), not a live
// continuously-recomputed aura like Mischief of Rats' near-identical
// wording (actions.js > recomputeConditionalBonuses).
const applyEndOfTurnGrowthPerName = (state) => {
  let next = state;
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'being' || occupant.ownerId !== state.turnPlayer) return;
    const growth = occupant.card.keywords?.endOfTurnGrowthPerName;
    if (!growth) return;
    const needle = growth.namePart.toLowerCase();
    const count = Object.entries(state.board).filter(([c, o]) =>
      c !== cell && o?.type === 'being' && o.ownerId === state.turnPlayer && o.card.name.toLowerCase().includes(needle)
    ).length;
    if (count === 0) return;
    const current = next.board[cell];
    if (!current) return;
    const gainedStrength = growth.strength * count;
    const gainedLifespan = growth.lifespan * count;
    const permanentBonus = {
      strength: (current.permanentBonus?.strength || 0) + gainedStrength,
      lifespan: (current.permanentBonus?.lifespan || 0) + gainedLifespan,
    };
    next = {
      ...next,
      board: { ...next.board, [cell]: { ...current, permanentBonus, currentLifespan: current.currentLifespan + gainedLifespan } },
    };
    next = addLog(next, `${current.card.name} grows +${gainedStrength}/+${gainedLifespan} (${count} other "${growth.namePart}" controlled).`);
  });
  return next;
};

// Shift's own quoted "At the end of your turn remove (N) Time Counter(s)
// from this" (Scā-vuhk Hunger) — a shifted Being's own self-decay,
// separate from (and resolved before) the automatic per-turn Modulate -1
// tick every Prophecy already gets at the START of its controller's next
// turn (modulate, above) — RULES.md's Down Tick Step, same "real
// end-of-turn triggers resolve here" precedent as every other call in
// endTurn. Routes through resolveProphecyModulateHitZero (actions.js) so
// hitting 0 here returns the Being to the Mortal Realm exactly the same
// way the automatic tick would.
const applyEndOfTurnShiftDecay = (state) => {
  let next = state;
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'prophecy' || occupant.ownerId !== state.turnPlayer) return;
    const amount = occupant.card.keywords?.endOfTurnRemoveOwnTimeCounters;
    if (!amount) return;
    const current = next.board[cell];
    if (!current) return;
    const timer = Math.max(0, (current.timer || 0) - amount);
    next = { ...next, board: { ...next.board, [cell]: { ...current, timer } } };
    next = addLog(next, `${current.card.name} loses ${amount} Time Counter(s) at the end of the turn.`);
    // `duringEndStep: true` is what lets the Boundless Hunger bounce loop
    // (Immen Gorta + Mouth of Madness + Terranean Gates — actions.js >
    // placeReturnedFromShift's own comment) actually run, capped at 100
    // bounces as a hard safety stop.
    next = resolveProphecyModulateHitZero(next, cell, true, 0);
  });
  return next;
};

// Planchette: "At the end of your turn lose Lifespan equal to the
// Lifespan of the Being on this tile." — scans the turn player's own
// ground Relics (a "Beings may move across this" Relic — RULES.md > Being-
// Relic co-location — lives in state.groundRelics, not state.board), not
// state.board, since that's where Planchette itself actually sits.
const applyEndOfTurnGroundRelicCoLocatedLifespanLoss = (state) => {
  let next = state;
  Object.entries(state.groundRelics).forEach(([cell, relic]) => {
    if (!relic || relic.ownerId !== state.turnPlayer || !relic.card.keywords?.endOfTurnLoseLifespanEqualToCoLocatedBeing) return;
    const being = next.board[cell];
    if (!being || being.type !== 'being' || being.currentLifespan <= 0) return;
    const amount = being.currentLifespan;
    const owner = next.players[relic.ownerId];
    next = { ...next, players: { ...next.players, [relic.ownerId]: { ...owner, lifespan: owner.lifespan - amount } } };
    next = addLog(next, `${relic.card.name} costs ${relic.ownerId} ${amount} Lifespan (equal to ${being.card.name}'s Lifespan).`);
  });
  return checkWin(next);
};

// Passing Doubt: "At the end of your turn target Doubt you control is
// dealt (1) Lifespan Damage." — "Doubt" is a name-family reference
// (Lingering Doubt/Passing Doubt), same as applyEndOfTurnGrowthPerName's
// own. A real end-of-turn choice isn't representable here (no
// pendingChoice infra in this pass of the turn cycle), so the target is
// auto-picked: a DIFFERENT Doubt-family Being if one exists, else itself
// — a documented simplification, same spirit as every other end-of-turn
// scan in this file that can't offer a real choice.
const applyEndOfTurnDamageNamedFamily = (state) => {
  let next = state;
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'being' || occupant.ownerId !== state.turnPlayer) return;
    const effect = occupant.card.keywords?.endOfTurnDamageNamedFamily;
    if (!effect) return;
    const needle = effect.namePart.toLowerCase();
    const candidates = Object.entries(next.board).filter(([, o]) =>
      o?.type === 'being' && o.ownerId === state.turnPlayer && o.card.name.toLowerCase().includes(needle)
    );
    const other = candidates.find(([c]) => c !== cell);
    const [targetCell] = other || candidates.find(([c]) => c === cell) || [];
    if (!targetCell) return;
    next = addLog(next, `${occupant.card.name}'s end-of-turn trigger deals ${effect.amount} Lifespan Damage to ${next.board[targetCell].card.name}.`);
    next = dealDamageToBeing(next, targetCell, effect.amount);
  });
  return next;
};

// Roots of Eternity's own "Once per turn" Purgatory-reanimate ability is
// tracked on the PLAYER (reanimatedFromPurgatoryThisTurn, actions.js >
// ACTIVATE_REANIMATE_FROM_PURGATORY) rather than on an occupant, since the
// card's own identity moves between Purgatory and the board and can't
// carry a stable per-occupant flag the way usedProphecyTrigger/
// timesPerTurnUsed do — reset at the start of the turn player's own turn,
// same as every other once-per-turn tracker here.
const resetPurgatoryReanimateTriggers = (state) => {
  const player = state.players[state.turnPlayer];
  if (!player.reanimatedFromPurgatoryThisTurn?.length) return state;
  return { ...state, players: { ...state.players, [state.turnPlayer]: { ...player, reanimatedFromPurgatoryThisTurn: [] } } };
};

// Modulate -1: tick every Prophecy the turn player controls — a face-down
// one counting down toward its flip, or an already-face-up one counting
// down its own new Time Counters toward Purgatory (RULES.md > Prophecies)
// — writes the decremented timer, then hands off to
// resolveProphecyModulateHitZero (actions.js) to finalize whatever a
// timer of 0 means for whichever phase it's in.
const modulate = (state) => {
  let next = state;
  let board = { ...next.board };
  Object.entries(board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'prophecy' || occupant.ownerId !== state.turnPlayer) return;
    const timer = occupant.timer - 1;
    next = triggerZealotProphecyEssence({ ...next, board }, occupant.ownerId);
    next = triggerHourglassCollection(next, occupant.ownerId);
    board = { ...next.board, [cell]: { ...next.board[cell], timer } };
    // landDisengaged=false: this automatic per-turn tick runs BEFORE
    // beginTurn's own disengage() step below (same synchronous call), so a
    // shifted Being returning here still lands Engaged and gets caught
    // naturally by that normal step moments later — see
    // placeReturnedFromShift's own comment (actions.js) for why every
    // OTHER call site defaults the other way.
    next = resolveProphecyModulateHitZero({ ...next, board }, cell, false, 0, false, false);
    board = next.board;
  });
  return { ...next, board };
};

// Time Counters tick down automatically each controller turn — the same
// "Modulate -1" mechanic Prophecies use (see modulate, above), just for an
// Altar's own Time Counters instead of a Prophecy's printed timer (RULES.md
// > Keywords: "the same mechanic as the turn structure's automatic
// 'Modulate -1' step"). Unlike a Prophecy, hitting 0 doesn't remove the
// Altar or resolve anything by itself — it just sits there, satisfying
// whatever condition reads it (Eònion Altar's own craft bonus, above).
// Floors at 0 rather than going negative.
const modulateAltarTimeCounters = (state) => {
  const own = state.altars[state.turnPlayer] || [];
  if (own.length === 0) return state;
  let changed = false;
  const next = own.map(altar => {
    const have = altar.counters?.time || 0;
    if (have <= 0) return altar;
    changed = true;
    return { ...altar, counters: { ...altar.counters, time: have - 1 } };
  });
  return changed ? { ...state, altars: { ...state.altars, [state.turnPlayer]: next } } : state;
};

// Time Counters tick down automatically each controller turn — the same
// "Modulate -1" mechanic as a Prophecy's own timer and an Altar's own
// counters.time (modulateAltarTimeCounters, above), generalized to any
// OTHER board occupant carrying its own counters.time (Hourglass — RULES.md
// bug fix: it used to only ever collect Time Counters via
// triggerHourglassCollection, never lose any on its own). Excludes
// Prophecies (which live in `timer`, handled by modulate, above, along with
// their own flip/Purgatory resolution) to avoid double-ticking the same
// counter through two different fields. Floors at 0, same as an Altar's own
// tick.
const modulateOtherTimeCounters = (state) => {
  const board = { ...state.board };
  let changed = false;
  Object.entries(board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type === 'prophecy' || occupant.ownerId !== state.turnPlayer) return;
    const have = occupant.counters?.time || 0;
    if (have <= 0) return;
    board[cell] = { ...occupant, counters: { ...occupant.counters, time: have - 1 } };
    changed = true;
  });
  return changed ? { ...state, board } : state;
};

// AfterImage token: "When this Being has (0) Time Counters on it, sacrifice
// it." — checked right after modulateOtherTimeCounters's own automatic
// tick above (the only way a Being's own counters.time reaches 0 on its
// own), for any Being carrying the keyword regardless of owner (the same
// either-owner, unconditional treatment recomputeXBeings/disengage already
// use for their own per-occupant checks this same Modulate Step). "Sacrifice"
// (not "dies"), so this routes through destroyBeing — no owner Lifespan
// loss, same precedent every other "sacrifice" text in this file follows.
const triggerSacrificeAtZeroTimeCounters = (state) => {
  let next = state;
  Object.keys(next.board).forEach(cell => {
    const current = next.board[cell];
    if (!current || current.type !== 'being' || !current.card.keywords?.sacrificeAtZeroTimeCounters) return;
    if ((current.counters?.time || 0) > 0) return;
    next = addLog(next, `${current.card.name} has 0 Time Counters and is sacrificed.`);
    next = destroyBeing(next, cell);
  });
  return next;
};

const disengage = (state) => {
  const board = { ...state.board };
  Object.entries(board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.ownerId !== state.turnPlayer) return;
    let next = occupant;
    // Instigator's "gains 'This does not disengage during Disengage Step'"
    // — modeled as a self-consuming flag: skip exactly the next Disengage
    // Step for this occupant, then clear it. A literal "until the start of
    // your [Instigator's controller's] next turn" would need tracking
    // *which* player's turn-start clears it, but self-consuming produces an
    // identical real-game outcome every time (Disengage is always the first
    // thing that would otherwise untap it) — a documented simplification
    // (RULES.md > Keywords).
    if ((occupant.type === 'being' || occupant.type === 'relic') && occupant.doesNotDisengage) {
      next = { ...next, doesNotDisengage: false };
    } else if (
      (occupant.type === 'being' || occupant.type === 'relic')
      && occupant.doesNotDisengageWhileHasTimeCounters && (occupant.counters?.time || 0) > 0
    ) {
      // Freeze Frame's own "While this has at least 1 Time Counter, it
      // does not Disengage during Disengage step" — unlike doesNotDisengage
      // above, this isn't self-consuming: it re-applies every Disengage
      // Step for as long as the Being still holds any Time Counter at all
      // (which, per its own text, never decays on its own).
    } else if ((occupant.type === 'being' || occupant.type === 'relic') && occupant.card.keywords?.neverAutoDisengages) {
      // Anahk-sha: "Does not Disengage during start of turn." — a static,
      // permanent, printed property of the card (unlike the two flags
      // above, which are granted/temporary), so it's read straight off
      // card.keywords instead of a per-occupant instance flag.
    } else if ((occupant.type === 'being' || occupant.type === 'relic') && occupant.engaged) {
      next = { ...next, engaged: false };
    }
    // Cemetery Physician's own "Once per turn sacrifice ..." resets here
    // too — the start of its controller's own next turn, same as the
    // engaged flag it shares this step with, even though its own ability
    // isn't gated by Engage/tap at all.
    if (occupant.usedSacrificeXThisTurn) {
      next = { ...next, usedSacrificeXThisTurn: false };
    }
    // MetaToris's own "Twice per turn ..." use-count resets here too, same
    // reasoning as the sacrifice ability above.
    if (occupant.timesPerTurnUsed) {
      next = { ...next, timesPerTurnUsed: 0 };
    }
    // payEffigyAbilityUsesThisTurn (actions.js's ACTIVATE_PAY_EFFIGY_COST_
    // ABILITY case) is an AI-scoring-only bookkeeping field, same reset
    // timing as timesPerTurnUsed just above.
    if (occupant.payEffigyAbilityUsesThisTurn) {
      next = { ...next, payEffigyAbilityUsesThisTurn: 0 };
    }
    // Wretched Remnants: "Once per turn ..." resets here too, same
    // reasoning — the borrowed textBox itself is a separate "until end of
    // turn" effect, restored in endTurn below, not here.
    if (occupant.wretchedRemnantsUsedThisTurn) {
      next = { ...next, wretchedRemnantsUsedThisTurn: false };
    }
    // Armaments are independently engageable permanents of their own (e.g.
    // "Feathers of the Fallen"'s own "Engage: ..." line) — untap any that
    // are engaged, whether attached to a Being or sitting in a freestanding
    // pile, same as the occupant they're stored on. Same Freeze Frame
    // exception as the Being/Relic check above: an Animated Armament's own
    // topmost entry (RULES.md > Keywords > Animated) can carry
    // doesNotDisengageWhileHasTimeCounters too (see the GAIN_TIME_COUNTER_
    // NO_DISENGAGE_RE handler in actions.js), and skips this untap the same
    // way a Being holding it would.
    const stillHeld = (a) => a.doesNotDisengageWhileHasTimeCounters && (a.counters?.time || 0) > 0;
    if (occupant.armaments?.some(a => a.engaged && !stillHeld(a))) {
      next = { ...next, armaments: occupant.armaments.map(a => (a.engaged && !stillHeld(a) ? { ...a, engaged: false } : a)) };
    }
    if (next !== occupant) board[cell] = next;
  });
  // A "Beings may move across this" Relic (Shifting Sands and friends)
  // lives in groundRelics, not board (RULES.md > Being-Relic co-location)
  // — its own Engage (ACTIVATE_GROUND_RELIC_ENGAGE) still needs the same
  // once-per-turn untap everything else here gets, or it stays tapped
  // forever after its first use.
  const groundRelics = { ...state.groundRelics };
  let groundChanged = false;
  Object.entries(groundRelics).forEach(([cell, occupant]) => {
    if (!occupant || occupant.ownerId !== state.turnPlayer || !occupant.engaged) return;
    groundRelics[cell] = { ...occupant, engaged: false };
    groundChanged = true;
  });
  // Effigial Conservator: an Effigy pool pip it Engaged (actions.js >
  // engageEffigyAddEssence) untaps here too, same once-per-turn lifecycle
  // as every other Engaged permanent — it's protected from being spent
  // (actions.js > payablePool) only until this step.
  const turnPlayer = state.players[state.turnPlayer];
  let players = state.players;
  if (turnPlayer.effigyPool.some(e => e.engaged)) {
    players = {
      ...state.players,
      [state.turnPlayer]: { ...turnPlayer, effigyPool: turnPlayer.effigyPool.map(e => (e.engaged ? { ...e, engaged: false } : e)) },
    };
  }
  return { ...state, board, players, ...(groundChanged ? { groundRelics } : {}) };
};

// A card with no colored Effigy pips at all in its casting cost — "only
// Faithless permanents" (Faithless Altar's condition) checks every card the
// player controls against this, re-evaluated fresh each craft step rather
// than locked in at placement.
const isFaithlessCard = (card) => !card?.castingCost || Object.keys(card.castingCost.colored || {}).length === 0;

// Exported so actions.js can reuse it for the "Zealot": "If you control
// only Faithless permanents you may Engage: ..." condition — the same
// "only Faithless" check, just gating a different kind of ability. Altars
// live off-board (see actions.js > createInitialState's own comment on
// `altars`) but are still real permanents the player controls, so a
// colored-cost Altar (e.g. Arbosalis Altar, "3 Living") still disqualifies
// this the same as it would have as a board occupant.
export const controlsOnlyFaithlessPermanents = (board, playerId, altars = [], groundRelics = {}) => {
  const cards = [];
  Object.values(board).forEach(occupant => {
    if (!occupant || occupant.ownerId !== playerId) return;
    if (occupant.card) cards.push(occupant.card);
    if (occupant.armaments) cards.push(...occupant.armaments.map(a => a.card));
  });
  altars.forEach(a => cards.push(a.card));
  // A "Beings may move across this" Relic lives in groundRelics, not board
  // (RULES.md > Being-Relic co-location) — still a real permanent the
  // player controls, so its own casting cost still counts here.
  Object.values(groundRelics).forEach(o => { if (o?.ownerId === playerId) cards.push(o.card); });
  return cards.every(isFaithlessCard);
};

// Altars ("Craft (N) additional Effigy on your turn") are a passive bonus
// on the base craft step — they trigger only during their controller's own
// craft-effigies step, never on the opponent's turn, so this only ever sums
// Altars owned by state.turnPlayer. A player may control any number of them
// at once (RULES.md > Card types) — their bonuses simply stack, since this
// already summed generically rather than assuming a single Altar. Faithless
// Altar's bonus is conditional ("If you control only Faithless Permanents")
// — checked fresh here every turn rather than gated once at placement,
// since board state can change.
const altarCraftBonus = (state) =>
  (state.altars[state.turnPlayer] || []).reduce((sum, altar) => {
    const { card } = altar;
    const bonus = card.keywords?.craftBonus || 0;
    if (bonus === 0) return sum;
    if (card.keywords?.craftBonusCondition === 'faithless-only' && !controlsOnlyFaithlessPermanents(state.board, state.turnPlayer, state.altars[state.turnPlayer], state.groundRelics)) {
      return sum;
    }
    // Eònion Altar: "If this has (0) Time Counters: Craft (N) additional
    // Effigy" — this specific Altar's own counters, not the player's board
    // state (contrast Faithless Altar's condition, above).
    if (card.keywords?.craftBonusCondition === 'zero-time-counters' && (altar.counters?.time || 0) !== 0) {
      return sum;
    }
    return sum + bonus;
  }, 0);

// Both players craft during every Craft Effigies step, not just the turn
// player — the step itself runs once per beginTurn (alternating A/B), but
// its base flip applies to whoever's turn it *isn't* too, so each player
// nets one real effigy per full round the same as the other. The
// game's-first-turn bonus (2 instead of 1) is narrower than the base flip,
// though: it belongs to the starting player alone, not to whoever happens
// to craft during that same step — so it's gated on `isTurnPlayer` too, not
// just `turnNumber === 1`. An Altar's bonus stays turn-player-exclusive the
// same way (altarCraftBonus is already scoped that way — see above),
// matching its own printed "on your turn".
const craftEffigies = (state) => {
  let next = state;
  Object.keys(state.players).forEach(playerId => {
    const player = next.players[playerId];
    const isTurnPlayer = playerId === state.turnPlayer;
    const base = isTurnPlayer && state.turnNumber === 1 ? EFFIGY_ROW_FIRST_TURN_BONUS : 1;
    const flips = base + (isTurnPlayer ? altarCraftBonus(state) : 0);
    let deck = player.effigyDeck;
    let pool = player.effigyPool;
    for (let i = 0; i < flips && deck.length > 0; i++) {
      pool = [...pool, deck[0]];
      deck = deck.slice(1);
    }
    next = { ...next, players: { ...next.players, [playerId]: { ...player, effigyDeck: deck, effigyPool: pool } } };
  });
  return next;
};

// Daylight Savings: "You do not draw during the start of your turn" — an
// ongoing effect read live off the board (cardData.js's
// skipsControllerDraw, checked on any face-up Prophecy the turn player
// controls with at least 1 Time Counter left — RULES.md > Prophecies),
// not a stored flag, so it naturally stops applying the moment that
// specific Prophecy leaves the board.
const controllerSkipsDraw = (state) =>
  Object.values(state.board).some(o =>
    o?.type === 'prophecy' && o.ownerId === state.turnPlayer && !o.faceDown
    && (o.timer || 0) > 0 && o.card.keywords?.skipsControllerDraw
  );

const drawStep = (state) => {
  if (controllerSkipsDraw(state)) {
    return addLog(state, `${state.turnPlayer} does not draw this turn (a face-up Prophecy).`);
  }
  const player = state.players[state.turnPlayer];
  // "At the start of your next turn draw (N) additional card(s)" (All or
  // nothing) — a one-shot bonus armed on the player themselves (not the
  // board), consumed and cleared the very next time this runs for them.
  const count = 1 + (player.extraDrawNextTurn || 0);
  let deck = player.mainDeck;
  let hand = player.hand;
  let lifespan = player.lifespan;
  const drawnCards = [];
  for (let i = 0; i < count; i++) {
    const { deck: nextDeck, drawn, penalty } = drawCard(deck);
    deck = nextDeck;
    if (drawn) { hand = [...hand, drawn]; drawnCards.push(drawn); }
    lifespan -= penalty;
  }
  let next = {
    ...state,
    players: {
      ...state.players,
      [state.turnPlayer]: { ...player, mainDeck: deck, hand, lifespan, extraDrawNextTurn: 0 },
    },
  };
  if (lifespan < player.lifespan) {
    next = addLog(next, `${state.turnPlayer} tried to draw from an empty Main Deck and loses ${player.lifespan - lifespan} Lifespan.`);
  }
  // Distant Debator: "When revealed on the top of your deck, <effect>." —
  // see triggerOnRevealedTopOfDeck, actions.js.
  drawnCards.forEach(card => { next = triggerOnRevealedTopOfDeck(next, state.turnPlayer, card); });
  return next;
};

export const beginTurn = (state) => {
  let next = addLog(state, `Turn ${state.turnNumber} begins for ${state.turnPlayer}.`);
  // Minute-taur: "At the start of your turn move forward." — direction 1.
  next = applyForcedDirectionalMoves(next, 'moveForwardAtTurnStart', 1);
  next = resetZealotTriggers(next);
  next = resetLotusTriggers(next);
  next = resetPurgatoryReanimateTriggers(next);
  next = resetBeingsDiedThisTurn(next);
  next = clearDeathCountBonusTracking(next);
  // Pause's "During the next Modulate Step, Time Counters are not
  // removed" — a one-shot flag consumed here, skipping ALL Time Counter
  // decrements this Modulate Step (Prophecies via modulate, Altars via
  // modulateAltarTimeCounters, and every other board occupant via
  // modulateOtherTimeCounters — RULES.md ties every one of these to the
  // same mechanic) for whichever player's turn this happens to be.
  if (next.skipNextModulate) {
    next = addLog(next, `Time Counters are not removed this Modulate Step (Pause).`);
    next = { ...next, skipNextModulate: false };
  } else {
    // modulateOtherTimeCounters runs first, before modulate()'s own Prophecy
    // tick can trigger a Hourglass's collection (triggerHourglassCollection)
    // — otherwise a Time Counter Hourglass collects THIS SAME Modulate Step
    // would be immediately undone by its own decay a moment later.
    next = modulateOtherTimeCounters(next);
    next = triggerSacrificeAtZeroTimeCounters(next);
    next = modulate(next);
    next = modulateAltarTimeCounters(next);
  }
  next = recomputeXBeings(next);
  next = recomputeDeathCountBonuses(next);
  next = recomputeConditionalBonuses(next);
  next = recomputeBoardWideAuraBonuses(next);
  next = recomputeKalmahkaOverrides(next);
  next = disengage(next);
  next = craftEffigies(next);
  // The starting player already has their dealt opening hand and doesn't
  // draw on top of it their very first turn — only turnNumber === 1 skips
  // this; the second player's own first turn (turnNumber === 2) draws
  // normally, same as every turn after.
  next = state.turnNumber === 1
    ? addLog(next, `${state.turnPlayer} does not draw on the game's first turn.`)
    : drawStep(next);
  return checkWin(next);
};

// End step: Lifespan -1 to pass the turn, shuffle spent effigies back into
// the Effigy Deck, then hand off to the opponent's begin-turn. A Zealot's
// "Add Essence" grant is temporary (see actions.js > ADD_ESSENCE_RE): any
// left unspent in the pool expire here rather than lingering, and any spent
// ones are kept out of the real Effigy Deck they never belonged to — unlike
// a normal (or Altar-crafted) effigy, which shuffles back like any other.
export const endTurn = (state) => {
  // Minute-taur: "At the end of your turn move backward." — direction 5.
  // Lingering Doubt: "At the end of your turn gain +1/+1 for each other
  // Doubt you control." — both are real end-of-turn triggers (RULES.md's
  // Down Tick Step), resolved before the flat -1 Lifespan cost below, per
  // the user's own turn-structure ruling ("Active Player resolves any end
  // of turn effects... loses (1) Lifespan as the final action").
  state = applyForcedDirectionalMoves(state, 'moveBackwardAtTurnEnd', 5);
  state = applyEndOfTurnGrowthPerName(state);
  state = applyEndOfTurnShiftDecay(state);
  state = applyEndOfTurnGroundRelicCoLocatedLifespanLoss(state);
  state = applyEndOfTurnDamageNamedFamily(state);
  // Tilled Fields: sacrifice-if-still-Engaged, then clear its own
  // Plants-enter-Disengaged flag — same "resolve real end-of-turn effects
  // before anything else" ordering as the two calls above.
  state = applySacrificeIfEngagedAtEndOfTurn(state);
  state = clearPlantsEnterDisengagedFlags(state);
  // Desperate Finale: "Sacrifice it at the end of the turn." — same
  // ordering as everything else above.
  state = applyDesperateFinaleSacrifice(state);
  const player = state.players[state.turnPlayer];
  const realSpent = player.effigySpentThisTurn.filter(e => !e.temporary);
  const shuffledBack = [...player.effigyDeck, ...realSpent];
  const survivingPool = player.effigyPool.filter(e => !e.temporary);
  // IkVarem's "becomes Favored until end of turn" (actions.js > RESOLVE
  // for TARGET_BECOME_FAVORED_TEMP_RE) marks the grant with
  // favorCounterExpiresEndOfTurn — strip both fields off here, same
  // temporary-until-end-of-turn precedent as the Zealot Essence expiry
  // above, and scoped the same way (the turn player's own occupants,
  // since a Being can only be summoned — and so only grant this — on its
  // controller's own turn).
  const board = { ...state.board };
  Object.entries(board).forEach(([cell, occupant]) => {
    if (occupant?.type === 'being' && occupant.ownerId === state.turnPlayer && occupant.favorCounterExpiresEndOfTurn) {
      board[cell] = { ...occupant, favorCounter: false, favorCounterExpiresEndOfTurn: false };
    }
  });
  // Regress's "Target Being's Strength becomes (0) until end of turn" (see
  // combat.js's effectiveStrength) — unlike the Favored expiry above, this
  // can target either player's Being (no "you control" in its text), so it
  // clears for every occupant regardless of owner rather than being scoped
  // to the turn player's own side.
  Object.entries(board).forEach(([cell, occupant]) => {
    if (occupant?.strengthSetUntilEndOfTurn != null) {
      board[cell] = { ...occupant, strengthSetUntilEndOfTurn: undefined };
    }
  });
  // Boknean Wine's "it has +2/+0 until end of turn" (combat.js's
  // effectiveStrength) — same either-owner, unconditional-clear treatment
  // as strengthSetUntilEndOfTurn above.
  Object.entries(board).forEach(([cell, occupant]) => {
    if (occupant?.statBonusUntilEndOfTurn != null) {
      board[cell] = { ...occupant, statBonusUntilEndOfTurn: undefined };
    }
  });
  // Dendrify's "becomes a 0/5 ... Being until end of turn" (combat.js's
  // deathDamageFor) — same either-owner, unconditional-clear treatment as
  // strengthSetUntilEndOfTurn above.
  Object.entries(board).forEach(([cell, occupant]) => {
    if (occupant?.lifespanSetUntilEndOfTurn != null) {
      board[cell] = { ...occupant, lifespanSetUntilEndOfTurn: undefined };
    }
  });
  // Willing Sacrifice's "target Being gains: 'Martyr: X' until end of
  // turn" (actions.js's effectiveMartyr reads grantedMartyrUntilEndOfTurn) —
  // same either-owner, unconditional-clear treatment as the stat overrides
  // above.
  Object.entries(board).forEach(([cell, occupant]) => {
    if (occupant?.grantedMartyrUntilEndOfTurn != null) {
      board[cell] = { ...occupant, grantedMartyrUntilEndOfTurn: undefined };
    }
  });
  // HeartWood Locket's "attached Being gains: 'Damage dealt to this Being
  // is dealt directly to it's controller instead' until end of turn"
  // (actions.js's dealDamageToBeing reads damageRedirectToController) —
  // same either-owner, unconditional-clear treatment as the flags above.
  Object.entries(board).forEach(([cell, occupant]) => {
    if (occupant?.damageRedirectToController != null) {
      board[cell] = { ...occupant, damageRedirectToController: undefined };
    }
  });
  // Afterimage's own "watch" flag (afterimageWatchOwnerId — actions.js's
  // triggerOnMoveReaction reads it) — same either-owner, unconditional-
  // clear treatment as the flags above.
  Object.entries(board).forEach(([cell, occupant]) => {
    if (occupant?.afterimageWatchOwnerId != null) {
      board[cell] = { ...occupant, afterimageWatchOwnerId: undefined };
    }
  });
  // Drown out the Screams / Dendrify's "loses all abilities until end of
  // turn" (actions.js's suppressAbilitiesUntilEndOfTurn stashed the
  // original keywords on suppressedKeywords) — restore them here, same
  // either-owner, unconditional treatment as the stat overrides above.
  Object.entries(board).forEach(([cell, occupant]) => {
    if (occupant?.suppressedKeywords != null) {
      board[cell] = {
        ...occupant,
        card: { ...occupant.card, keywords: occupant.suppressedKeywords },
        suppressedKeywords: undefined,
      };
    }
  });
  // Wretched Remnants: "... gain its effect(s) until end of turn." — same
  // stash-and-restore treatment as suppressedKeywords just above (actions.js
  // > grantBorrowedTextBox stashed the Relic's own original card on
  // wretchedRemnantsOriginalCard), just restoring the whole original card
  // (not just its keywords) since the borrowed textBox also overwrote
  // `card.textBox` itself.
  Object.entries(board).forEach(([cell, occupant]) => {
    if (occupant?.wretchedRemnantsOriginalCard != null) {
      board[cell] = { ...occupant, card: occupant.wretchedRemnantsOriginalCard, wretchedRemnantsOriginalCard: undefined };
    }
  });
  // Tiarlish Hunger: "... copy the effect(s) of target Being an opponent
  // controls until the end of your next turn." — same stash-and-restore
  // shape as Wretched Remnants just above (actions.js >
  // grantCopiedEffectUntilNextTurn), but a real TWO-turn-cycle duration
  // instead of one: `copiedEffectSkipNextClear` is a self-consuming flag
  // (same philosophy as Instigator's own doesNotDisengage — see
  // disengage() above), scoped to only the copying player's OWN endTurn
  // (never the opponent's) so it takes exactly two of THEIR OWN turns —
  // this one (consumes the flag) and their next (actually clears it) — to
  // expire, matching "until the end of your next turn" instead of "until
  // end of turn".
  Object.entries(board).forEach(([cell, occupant]) => {
    if (occupant?.copiedEffectOriginalCard == null || occupant.ownerId !== state.turnPlayer) return;
    if (occupant.copiedEffectSkipNextClear) {
      board[cell] = { ...occupant, copiedEffectSkipNextClear: false };
    } else {
      board[cell] = { ...occupant, card: occupant.copiedEffectOriginalCard, copiedEffectOriginalCard: undefined };
    }
  });
  // Animate's own "becomes a 1/1 Armament and Being ... until end of turn"
  // (actions.js > applyAnimate) — reverts the transformed occupant back to
  // a standalone Relic, restoring its original card/counters. Same
  // either-owner, unconditional treatment as the reversions above. Only
  // when the pile still holds exactly the one animated entry — see
  // applyAnimate's own comment for why a pile that grew a second real
  // Armament during the animated window is left alone instead.
  Object.entries(board).forEach(([cell, occupant]) => {
    if (occupant?.type !== 'armament-stack' || occupant.armaments.length !== 1) return;
    const original = occupant.armaments[0].animateOriginal;
    if (!original) return;
    board[cell] = {
      type: 'relic',
      ownerId: occupant.ownerId,
      card: original.card,
      ...(original.counters ? { counters: original.counters } : {}),
    };
  });
  // The Fountain: "You take (1) less Lifespan Damage during the Down Tick
  // Step." — "Down Tick Step" is the real name of this exact end-of-turn
  // phase (per the user's own turn-structure ruling), so this reduces the
  // flat -1 Lifespan cost of ending the turn below, floored at 0. Every
  // copy the turn player controls stacks, same as an Altar's own "Craft
  // additional Effigy" bonuses already do.
  const downTickReduction = Object.values(board).reduce((sum, o) =>
    sum + (o?.type === 'relic' && o.ownerId === state.turnPlayer ? (o.card.keywords?.downTickLifespanReduction || 0) : 0), 0);
  const endStepCost = Math.max(0, 1 - downTickReduction);
  let next = {
    ...state,
    // Simple Summoner's "your next Being this turn costs..." (actions.js's
    // effectiveCastingCost) — a one-shot flag that shouldn't survive into a
    // turn it was never used, the same "this turn" scoping every other
    // until-end-of-turn effect above gets. Metal Worker's own "next Relic"
    // version is the identical flag, just for Relics.
    nextBeingCostReduction: null,
    nextRelicCostReduction: null,
    // Vicious Vittles: "...your next Hunger this turn..." — same one-shot,
    // doesn't-survive-into-a-turn-it-was-never-used scoping.
    nextHungerFreeSummonOnTile: null,
    board,
    players: {
      ...state.players,
      [state.turnPlayer]: {
        ...player,
        lifespan: player.lifespan - endStepCost,
        effigyDeck: shuffledBack,
        effigyPool: survivingPool,
        effigySpentThisTurn: [],
        // Return the Favor's own "Until the end of the turn..." reaction
        // window (actions.js > triggerReturnTheFavorReaction) — a Conjuring
        // can only ever be cast on its own caster's turn, so "the turn"
        // always means the turn player's own, same scoping
        // favorCounterExpiresEndOfTurn already uses above.
        returnTheFavorUntilEndOfTurn: false,
        // Mausoleum Gates' own "you may summon Undead from your Purgatory
        // until the end of your turn" window (actions.js's
        // ACTIVATE_SUMMON_TYPED_FROM_PURGATORY_WINDOW) — same "this turn"
        // scoping as everything else in this block; Engage can only ever
        // be activated on its own controller's turn, so there's no
        // cross-turn case to worry about.
        summonTypedFromPurgatoryWindows: [],
      },
    },
  };
  next = addLog(next, `${state.turnPlayer} passes the turn (-${endStepCost} Lifespan).`);
  next = checkWin(next);
  if (next.phase === 'gameover') return next;

  next = {
    ...next,
    turnPlayer: opponentOf(state.turnPlayer),
    turnNumber: state.turnNumber + 1,
  };
  return beginTurn(next);
};

export const checkWin = (state) => {
  if (state.phase === 'gameover') return state;
  const a = state.players.A.lifespan;
  const b = state.players.B.lifespan;
  if (a <= 0 || b <= 0) {
    const winner = a <= 0 && b <= 0 ? null : (a <= 0 ? 'B' : 'A');
    return addLog({ ...state, phase: 'gameover', winner }, winner ? `${winner} wins!` : 'Both players hit 0 Lifespan — draw.');
  }
  return state;
};
