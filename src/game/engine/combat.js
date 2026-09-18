// Pure combat-resolution helpers. No state mutation — callers apply the
// returned deltas.

import { isFaithlessTypedCard } from '../../lib/cardData.js';

// Armaments can grant an additive Strength bonus while attached (e.g.
// "Being gains +3/+0" — RULES.md > Card types). Strength isn't a depleting
// resource the way Lifespan is, so it's always computed fresh from the
// card + whatever's currently attached rather than stored anywhere — a 1/1
// with a +3/+0 Armament attached is a 4/1 for as long as it stays attached.
export const armamentStrengthBonus = (occupant) =>
  (occupant.armaments || []).reduce((sum, a) => sum + (a.card.keywords?.statBonus?.strength || 0), 0);

// A When Summoned effect can grant a permanent additive Strength/Lifespan
// bonus (e.g. Lamtukka Gentleman's "+1/+1") distinct from an attached
// Armament's — stored directly on the occupant since, unlike an Armament,
// it isn't tied to anything that can be removed.
export const permanentStrengthBonus = (occupant) => occupant.permanentBonus?.strength || 0;

// Thespian's "this Being's Strength ... becomes equal to target Being you
// control" is an absolute override, not a bonus — when present, it replaces
// the card's own printed Strength entirely (Armament/permanent bonuses on
// top of it still apply normally). `strengthSetUntilEndOfTurn` (Regress:
// "Target Being's Strength becomes (0) until end of turn") takes priority
// over that — it's the most recently applied, temporary effect, cleared by
// endTurn (turn.js) rather than persisting like strengthOverride does.
// Boknean Wine's own "it has +2/+0 until end of turn" — an additive bonus
// (unlike strengthSetUntilEndOfTurn's absolute override above), also
// cleared by endTurn (turn.js) rather than persisting like permanentBonus.
export const statBonusUntilEndOfTurnStrength = (occupant) => occupant.statBonusUntilEndOfTurn?.strength || 0;

// Singularity: "has -X/-X where X equals the number of Time Counters that
// you control" (recomputeXBeings, actions.js) — a live subtractive penalty,
// distinct from strengthOverride's absolute replacement (Horological
// Horror/Thespian) above.
export const timeCounterStatPenalty = (occupant) => occupant.timeCounterStatPenalty || 0;

// "-1/-1 Counter(s)" (Scarab: "Target Being gains a -1/-1 Counter.") — a
// real, persistent counter (RULES.md > Keywords), unlike
// statBonusUntilEndOfTurn's own temporary debuffs. Its Strength half is
// this live, additive-negative read; its Lifespan half is applied directly
// to currentLifespan the moment the counter is granted (dealDamageToBeing
// — the same "route a negative permanent Lifespan change through the real
// death pipeline" precedent an Armament's own negative statBonus.lifespan
// already uses, see applyNewArmamentsLifespanBonus in actions.js), so
// there's nothing to read live for Lifespan here.
export const minusCounterPenalty = (occupant) => occupant.counters?.['-1/-1'] || 0;

// Restless Dead: "has +2/+0 until end of turn for each Being that died
// under your control this turn." — a live, continuously-recomputed
// additive bonus (recomputeDeathCountBonuses, actions.js), kept in its own
// field rather than folded into statBonusUntilEndOfTurn so it can't
// silently clobber some OTHER card's genuine one-shot grant to the same
// occupant (Boknean Wine, Spirit of War's own reaction, etc.) the way a
// blind overwrite would.
export const deathCountStatBonusStrength = (occupant) => occupant.deathCountBonus?.strength || 0;

// Darmah-Triya / Menagerie Mistress / Mischief of Rats' own live conditional
// Strength bonus (recomputeConditionalBonuses, actions.js) — kept in its
// own field for the same reason deathCountBonus is: so it can't silently
// clobber some OTHER card's one-shot grant to the same occupant.
export const conditionalBonusStrength = (occupant) => occupant.conditionalBonus?.strength || 0;

// Growth Spurt / Blooming Life / Withering Life's own live board-wide aura
// (recomputeBoardWideAuraBonuses, actions.js) — same "kept in its own
// field" reasoning as conditionalBonus/deathCountBonus above, and the same
// Strength-live/Lifespan-baked-in-as-damage split every other bonus here
// uses (see recomputeBoardWideAuraBonuses' own dealDamageToBeing delta).
export const boardWideAuraStrength = (occupant) => occupant.boardWideAuraBonus?.strength || 0;

// Dryad: "This has that Being's Strength and Lifespan while attached." —
// the Strength half is live, added fresh every time (same "never depletes,
// so never baked in" precedent as armamentStrengthBonus above), read off
// the whole attached sub-occupant via effectiveStrength itself — so a
// mount that's already carrying its own Armaments/bonuses (or even another
// Dryad attachment underneath IT) contributes its full current Strength,
// not just its printed base. The Lifespan half is instead applied once as
// an immediate heal at the moment of attaching (see
// applyDryadAttachLifespanBonus, actions.js), so there's nothing to read
// live for it here — same split effectiveStrength/dealDamageToBeing
// already draw for every other Strength-vs-Lifespan bonus in this file.
export const dryadAttachedStrengthBonus = (occupant) =>
  occupant.dryadAttached ? effectiveStrength(occupant.dryadAttached) : 0;

export const effectiveStrength = (occupant) =>
  Math.max(0, (occupant.strengthSetUntilEndOfTurn ?? occupant.strengthOverride ?? occupant.card.strength)
  + armamentStrengthBonus(occupant) + permanentStrengthBonus(occupant) + statBonusUntilEndOfTurnStrength(occupant)
  + deathCountStatBonusStrength(occupant) + conditionalBonusStrength(occupant) + dryadAttachedStrengthBonus(occupant)
  + boardWideAuraStrength(occupant)
  - timeCounterStatPenalty(occupant) - minusCounterPenalty(occupant));

// Fidian Nol: "During Combat if the opposing Being is not Faithless it has
// (-1) Strength." — a combat-time-only reduction to whoever it fights, not
// a persisted stat change (no field written anywhere for it), so it's
// applied here at the point damage is computed rather than folded into
// effectiveStrength itself. `selfOccupant` is whichever side carries the
// ability; `opponentOccupant` is whoever it's fighting. Faithless-costed
// opponents (isFaithlessTypedCard, cardData.js) are exempt, per the card's
// own text.
const combatOpponentStrengthPenalty = (selfOccupant, opponentOccupant) => {
  const amount = selfOccupant.card.keywords?.combatOpponentStrengthPenaltyIfNotFaithless;
  if (!amount || isFaithlessTypedCard(opponentOccupant.card)) return 0;
  return amount;
};

// Both sides deal their (Armament-boosted) Strength to each other
// simultaneously. Damage persists (no auto-heal), so callers must apply
// currentLifespan -= damage on both occupants using the returned values.
export const resolveMutualCombat = (attackerOccupant, defenderOccupant) => {
  // damage dealt TO the attacker — the defender's own Strength, less any
  // combat-time penalty Fidian Nol's ability (on the ATTACKER's side)
  // imposes on it.
  const attackerDamage = Math.max(0, effectiveStrength(defenderOccupant) - combatOpponentStrengthPenalty(attackerOccupant, defenderOccupant));
  // damage dealt TO the defender — same, mirrored.
  const defenderDamage = Math.max(0, effectiveStrength(attackerOccupant) - combatOpponentStrengthPenalty(defenderOccupant, attackerOccupant));
  return {
    attackerLifespanAfter: attackerOccupant.currentLifespan - attackerDamage,
    defenderLifespanAfter: defenderOccupant.currentLifespan - defenderDamage,
  };
};

// A Being's own base (printed) Lifespan is dealt to its controller when it
// dies — unless Dendrify's own "becomes a 0/5 ... Being until end of turn"
// has overridden it (lifespanSetUntilEndOfTurn), same absolute-override
// precedent as strengthSetUntilEndOfTurn above.
export const deathDamageFor = (occupant) => occupant.lifespanSetUntilEndOfTurn ?? occupant.card.lifespan;
