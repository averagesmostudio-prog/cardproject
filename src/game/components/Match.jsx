import React, { useEffect, useMemo, useRef, useState } from 'react';
import { History, X, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Flag, Eye, EyeOff } from 'lucide-react';
import { useGameEngine } from '../state/useGameEngine.js';
import { useStagedBoard, useStagedLife, useTurnBanner, useJustDrawn, useShiftVortex, useDepartFlash, useDeitySummonCinematic, useOpenLaneStrike } from '../state/useStagedBoard.js';
import { getLegalActions, effectiveEngage, animatedTopEntry, effectiveCastingCost, faithlessPaymentNeedsChoice, faithlessPaymentCandidates, searchZoneCandidates } from '../engine/actions.js';
import { effectiveStrength } from '../engine/combat.js';
import { STARTING_LIFESPAN } from '../engine/constants.js';
import { useCardFont, useBorderImages, useCardArtImages } from '../../lib/useCardAssets.js';
import { getBorderTypeForCard, resolveCardArt, EFFIGY_COLORS, EFFIGY_TYPE_COLORS, totalCastingCost } from '../../lib/cardData.js';
import { renderCardOnCanvas, DEFAULT_POSITIONS } from '../../lib/cardRender.js';
import Board from './Board.jsx';
import Hand from './Hand.jsx';
import ActionLog from './ActionLog.jsx';
import CardPile from './CardPile.jsx';
import CardTile from './CardTile.jsx';
import CardThumbnail from './CardThumbnail.jsx';

const HUMAN = 'A';
const AI = 'B';

// Board.jsx renders rows top-to-bottom as Row 5 -> Row 1; a rail beside the
// board reuses the same row heights (Mortal Realm cells, and the shorter
// Ethereal Realm row 3) so a pile lines up with its matching board row.
// Keep in sync with Board.jsx's own cell classes.
const ROW_H = 'h-[138px] sm:h-[169px]';
const ETHEREAL_ROW_H = 'h-24 sm:h-28';

// A 5-band color gradient scaled to STARTING_LIFESPAN (not hardcoded to 50)
// so it stays correct if that constant ever changes: full health reads as
// a calm dark green, then eases through a lighter green, yellow, and light
// red as danger approaches, ending in a stark darker red near 0.
const LIFE_COLOR_BANDS = [
  { atOrAbove: 0.8, color: '#15803d' }, // dark green
  { atOrAbove: 0.6, color: '#4ade80' }, // lighter green
  { atOrAbove: 0.4, color: '#eab308' }, // yellow
  { atOrAbove: 0.2, color: '#f87171' }, // light red
  { atOrAbove: -Infinity, color: '#991b1b' }, // darker red
];
const lifeColor = (value) => {
  const ratio = value / STARTING_LIFESPAN;
  return LIFE_COLOR_BANDS.find(band => ratio >= band.atOrAbove).color;
};

// `flash` (useStagedLife.js) is `{ amount }` for the brief window right
// after a direct hit to this player's Lifespan — same staged-pause /
// starburst treatment Board.jsx's DamageFlash gives a damaged Being, just
// sized down to sit next to a number instead of over a whole board tile.
// `strike` (useStagedBoard.js > useOpenLaneStrike) is a separate, coarser
// signal: `flash` alone fires for ANY Lifespan drop, a paid cost included,
// so it can't by itself read as "you got hit" — `strike` is set only for
// the one case that's actually combat reaching this player's face
// undefended (an open lane, or a Relic/inert Armament that doesn't
// block), and drives a bigger red pulse behind the whole number plus a
// quick jolt, layered underneath it (z-0 vs the number's own z-10) so the
// digits stay readable through the flash. `targetAction`, when set, means
// this life total is a legal "any target" destination right now
// (Sharpshoot-style direct damage, restore-lifespan-target) — the whole
// badge becomes a clickable, highlighted target instead of the separate
// "A's Lifespan" / "B's Lifespan" buttons this used to need.
function LifeBadge({ value, flash, strike, targetAction, onSelectTarget }) {
  return (
    <div
      className={`relative text-center leading-tight rounded-lg transition ${targetAction ? 'cursor-pointer ring-2 ring-green-400 ring-offset-2 ring-offset-black animate-pulse hover:bg-green-400/10' : ''}`}
      onClick={targetAction ? () => onSelectTarget(targetAction) : undefined}
      role={targetAction ? 'button' : undefined}
      title={targetAction ? 'Target this Lifespan total' : undefined}
    >
      {flash && (
        <div className="absolute -top-2 -right-3 z-30 w-9 h-9 damage-burst-pop pointer-events-none">
          <div className="absolute inset-0 bg-gradient-to-br from-amber-300 via-orange-500 to-red-600 rounded-md shadow-[0_0_6px_rgba(0,0,0,0.6)] rotate-45" />
          <div className="absolute inset-0 bg-gradient-to-br from-amber-300 via-orange-500 to-red-600 rounded-md shadow-[0_0_6px_rgba(0,0,0,0.6)]" />
          <div
            className="absolute inset-0 flex items-center justify-center text-red-600 font-extrabold text-xs"
            style={{ textShadow: '0 0 2px #000, 0 0 3px #000, 0 1px 1px #000' }}
          >
            -{flash.amount}
          </div>
        </div>
      )}
      {strike && (
        <div key={`hit-${strike}`} className="absolute inset-0 z-0 flex items-center justify-center pointer-events-none">
          <div className="w-20 h-20 rounded-full life-direct-hit-flash" />
        </div>
      )}
      <div
        key={strike ? `num-${strike}` : undefined}
        className={`relative z-10 text-5xl font-extrabold ${strike ? 'life-direct-hit-shake' : ''}`}
        style={{ color: lifeColor(value) }}
      >
        {value}
      </div>
      <div className="relative z-10 text-xs text-stone-400 uppercase tracking-wide">Life</div>
    </div>
  );
}

// Hand actions that work by selecting a card, then clicking a target cell.
// PLACE_ALTAR is deliberately NOT here — an Altar isn't tied to a board
// cell at all (RULES.md > Card types), so like a Conjuring it resolves
// immediately from hand instead of needing a cell picked afterward (see
// onHandSelect).
// RESOLVE_SUMMON_HAND_BEING_POINTED (Collapsing Bridge's own "you may
// summon a Being on a tile this points to") is the same hand-card-then-
// cell two-step as a normal SUMMON_BEING, just gated behind a pendingChoice
// instead of being freely offered — including it here is what makes
// playableIds/highlightCells/onCellClick pick it up for free.
const CELL_TARGET_TYPES = ['SUMMON_BEING', 'PLAY_PROPHECY', 'PLACE_RELIC', 'ATTACH_ARMAMENT', 'RESOLVE_SUMMON_HAND_BEING_POINTED'];

// pendingChoice kinds that resolve by picking exactly one board cell, with
// no further sub-choice needed — the same board-native interaction
// token-location (Cookie's Bag o' Bones placement) already uses: the legal
// tiles themselves light up (see highlightCells) and clicking one resolves
// the choice directly (see onCellClick), instead of a full-screen list
// picker. `cellField` is the field on the matching legalActions entry that
// names the cell (most are `cellId`; a couple reuse existing fields that
// happen to mean "the cell this choice is about").
const SINGLE_CELL_CHOICE_KINDS = {
  'token-location': { actionType: 'RESOLVE_TOKEN_LOCATION', cellField: 'cellId' },
  'damage-target': { actionType: 'RESOLVE_DAMAGE_TARGET', cellField: 'cellId' },
  'destroy-permanent': { actionType: 'RESOLVE_DESTROY_PERMANENT', cellField: 'cellId' },
  'strength-set-eot': { actionType: 'RESOLVE_STRENGTH_SET_EOT', cellField: 'cellId' },
  'reveal-prophecy': { actionType: 'RESOLVE_REVEAL_PROPHECY', cellField: 'cellId' },
  'sacrifice': { actionType: 'RESOLVE_SACRIFICE', cellField: 'cellId' },
  'grant-favor': { actionType: 'RESOLVE_GRANT_FAVOR', cellField: 'cellId' },
  'buff-ally': { actionType: 'RESOLVE_BUFF_ALLY', cellField: 'cellId' },
  'copy-stats': { actionType: 'RESOLVE_COPY_STATS', cellField: 'cellId' },
  'doesnt-disengage': { actionType: 'RESOLVE_DOESNT_DISENGAGE', cellField: 'cellId' },
  // The destination is fixed on the pendingChoice itself — picking the
  // Being (by its current cell) is the whole choice.
  'move-target-being': { actionType: 'RESOLVE_MOVE_TARGET_BEING', cellField: 'fromCellId' },
  'free-move': { actionType: 'RESOLVE_FREE_MOVE', cellField: 'toCellId' },
  'return-to-hand': { actionType: 'RESOLVE_RETURN_TO_HAND', cellField: 'cellId' },
  'sacrifice-being-cost': { actionType: 'RESOLVE_SACRIFICE_BEING_COST', cellField: 'cellId' },
  'sacrifice-typed-cost': { actionType: 'RESOLVE_SACRIFICE_TYPED_COST', cellField: 'cellId' },
  'select-move-source': { actionType: 'RESOLVE_SELECT_MOVE_SOURCE', cellField: 'cellId' },
  'engage-buff-eot': { actionType: 'RESOLVE_ENGAGE_BUFF_EOT', cellField: 'cellId' },
  'engage-then-move': { actionType: 'RESOLVE_ENGAGE_THEN_MOVE', cellField: 'cellId' },
  'engage-move-twice': { actionType: 'RESOLVE_ENGAGE_MOVE_TWICE', cellField: 'cellId' },
  'diablerie-select-mover': { actionType: 'RESOLVE_DIABLERIE_SELECT_MOVER', cellField: 'cellId' },
  'diablerie-move-destination': { actionType: 'RESOLVE_DIABLERIE_MOVE_DESTINATION', cellField: 'cellId' },
  'time-counter-block-move': { actionType: 'RESOLVE_TIME_COUNTER_BLOCK_MOVE', cellField: 'cellId' },
  'freeze-frame-target': { actionType: 'RESOLVE_FREEZE_FRAME_TARGET', cellField: 'cellId' },
  'add-counter-relic-target': { actionType: 'RESOLVE_ADD_COUNTER_RELIC_TARGET', cellField: 'cellId' },
  'sacrifice-relic-cost': { actionType: 'RESOLVE_SACRIFICE_RELIC_COST', cellField: 'cellId' },
  'vyu-bhata-target': { actionType: 'RESOLVE_VYU_BHATA_TARGET', cellField: 'cellId' },
  'sacrifice-pointed-target': { actionType: 'RESOLVE_SACRIFICE_POINTED_TARGET', cellField: 'cellId' },
  'sacrifice-typed-cost-limit': { actionType: 'RESOLVE_SACRIFICE_TYPED_COST_LIMIT', cellField: 'cellId' },
  'drown-screams-target': { actionType: 'RESOLVE_DROWN_SCREAMS_TARGET', cellField: 'cellId' },
  'dendrify-target': { actionType: 'RESOLVE_DENDRIFY_TARGET', cellField: 'cellId' },
  'recollect-target': { actionType: 'RESOLVE_RECOLLECT_TARGET', cellField: 'cellId' },
  'legend-rule-keep': { actionType: 'RESOLVE_LEGEND_RULE_KEEP', cellField: 'cellId' },
  'teeth-bounds-sacrifice-hunger': { actionType: 'RESOLVE_TEETH_BOUNDS_SACRIFICE_HUNGER', cellField: 'cellId' },
  'midnight-mass-sacrifice-target': { actionType: 'RESOLVE_MIDNIGHT_MASS_SACRIFICE_TARGET', cellField: 'cellId' },
  'afterimage-target': { actionType: 'RESOLVE_AFTERIMAGE_TARGET', cellField: 'cellId' },
  'move-forward-target': { actionType: 'RESOLVE_MOVE_FORWARD_TARGET', cellField: 'cellId' },
  'strength-debuff-target': { actionType: 'RESOLVE_STRENGTH_DEBUFF_TARGET', cellField: 'cellId' },
  'debuff-per-own-death-target': { actionType: 'RESOLVE_DEBUFF_PER_OWN_DEATH_TARGET', cellField: 'cellId' },
  'return-the-favor-target': { actionType: 'RESOLVE_RETURN_THE_FAVOR_TARGET', cellField: 'cellId' },
  'lifespan-damage-first-target': { actionType: 'RESOLVE_LIFESPAN_DAMAGE_FIRST_TARGET', cellField: 'cellId' },
  'lifespan-damage-second-target': { actionType: 'RESOLVE_LIFESPAN_DAMAGE_SECOND_TARGET', cellField: 'cellId' },
  'summon-token-pointed': { actionType: 'RESOLVE_SUMMON_TOKEN_POINTED', cellField: 'cellId' },
  'copy-engage-target': { actionType: 'RESOLVE_COPY_ENGAGE_TARGET', cellField: 'cellId' },
  'trigger-depart-target': { actionType: 'RESOLVE_TRIGGER_DEPART_TARGET', cellField: 'cellId' },
  'minus-counter-target': { actionType: 'RESOLVE_MINUS_COUNTER_TARGET', cellField: 'cellId' },
  'invoke-destination': { actionType: 'RESOLVE_INVOKE_DESTINATION', cellField: 'cellId' },
  // Crathea's own token-choice ("create a face up Blooming Life token... or
  // a Withering Life token...") only opens this SECOND pendingChoice once
  // the Ethereal Realm has more than one empty cell for the chosen token to
  // land on (RESOLVE_CREATE_TOKEN_CHOICE, actions.js) — the same board-
  // native highlighted-tile click every other single-cell choice above uses.
  'ethereal-token-location': { actionType: 'RESOLVE_ETHEREAL_TOKEN_LOCATION', cellField: 'cellId' },
  'end-of-turn-damage-named-family-target': { actionType: 'RESOLVE_END_OF_TURN_DAMAGE_NAMED_FAMILY_TARGET', cellField: 'cellId' },
  'add-counter-typed-pointed-target': { actionType: 'RESOLVE_ADD_COUNTER_TYPED_POINTED_TARGET', cellField: 'cellId' },
  'move-armament-destination': { actionType: 'RESOLVE_MOVE_ARMAMENT_DESTINATION', cellField: 'cellId' },
  'restore-lifespan-target': { actionType: 'RESOLVE_RESTORE_LIFESPAN_TARGET', cellField: 'cellId' },
  // Shift's own destination/return picks — same board-native click-a-
  // highlighted-tile resolution as every other choice above, just landing
  // in the Ethereal Realm (shift-destination) or back in the Mortal Realm
  // (shift-return, shift-from-purgatory-destination).
  'shift-destination': { actionType: 'RESOLVE_SHIFT_DESTINATION', cellField: 'cellId' },
  'shift-return': { actionType: 'RESOLVE_SHIFT_RETURN', cellField: 'cellId' },
  'shift-from-purgatory-destination': { actionType: 'RESOLVE_SHIFT_FROM_PURGATORY_DESTINATION', cellField: 'cellId' },
  'give-different-typed-buff': { actionType: 'RESOLVE_GIVE_DIFFERENT_TYPED_BUFF', cellField: 'cellId' },
  'force-shift-target': { actionType: 'RESOLVE_FORCE_SHIFT_TARGET', cellField: 'cellId' },
  'copy-opponent-effect': { actionType: 'RESOLVE_COPY_OPPONENT_EFFECT', cellField: 'cellId' },
  'udarik-shift-target': { actionType: 'RESOLVE_UDARIK_SHIFT_TARGET', cellField: 'cellId' },
  // Deja Vu: candidates are already narrowed to affordable targets
  // (dejaVuCandidates, actions.js) before this ever opens.
  'deja-vu-target': { actionType: 'RESOLVE_DEJA_VU_TARGET', cellField: 'cellId' },
  // Immen Gorta's additional summon cost: clicking a highlighted own Being
  // picks it for sacrifice; the choice loops back onto itself (still
  // 'summon-sacrifice-cost', fewer highlighted cells each time) until
  // enough are picked, then resolves and places the Being — see
  // RESOLVE_SUMMON_SACRIFICE_COST, actions.js.
  'summon-sacrifice-cost': { actionType: 'RESOLVE_SUMMON_SACRIFICE_COST', cellField: 'cellId' },
};

// pendingChoice kinds resolved by toggling any number of board cells in or
// out of a selection, then confirming — Cemetery Physician's own
// "sacrifice any number of <Name>" originated this shape (sacrifice-x-
// toggle); Death's Howl's "sacrifice (X) Beings" reuses the exact same
// board-toggle-then-confirm UI, just over a different candidate set.
const TOGGLE_CHOICE_KINDS = {
  'sacrifice-x-toggle': { toggleActionType: 'RESOLVE_SACRIFICE_X_TOGGLE', confirmActionType: 'RESOLVE_SACRIFICE_X_CONFIRM' },
  'sacrifice-any-beings-toggle': { toggleActionType: 'RESOLVE_SACRIFICE_ANY_BEINGS_TOGGLE', confirmActionType: 'RESOLVE_SACRIFICE_ANY_BEINGS_CONFIRM' },
  'summon-vine-tokens-toggle': { toggleActionType: 'RESOLVE_SUMMON_VINE_TOKENS_TOGGLE', confirmActionType: 'RESOLVE_SUMMON_VINE_TOKENS_CONFIRM' },
};

// pendingChoice kinds resolved by picking a single whole number 0..max —
// Blood Rites' own "add an Armament that costs (X)" and False Testament's
// "enter with up to (N) Time Counters" already built this exact engine-side
// shape (getLegalActions offers one RESOLVE_* per value in range) but had
// no UI to pick from, same class of gap as Mausoleum Gates before it got
// its own modal — this one small picker covers all three at once. `max`
// reads whichever field that pendingChoice stores its ceiling under.
const NUMERIC_CHOICE_KINDS = {
  'choose-x-value': { actionType: 'RESOLVE_CHOOSE_X_VALUE', max: 'maxX', prompt: (pc) => `${pc.cardName}: how much additional Essence to pay for its (X)?` },
  'choose-prophecy-timer': { actionType: 'RESOLVE_CHOOSE_PROPHECY_TIMER', max: 'maxValue', prompt: (pc) => `${pc.cardName}: how many Time Counters should it enter with?` },
  'legion-onset-choose-count': { actionType: 'RESOLVE_LEGION_ONSET_CHOOSE_COUNT', max: 'maxCount', prompt: (pc) => `${pc.cardName}: how many Vassal tokens to summon? (5 Lifespan each)` },
};

// One short line of banner text per SINGLE_CELL_CHOICE_KINDS entry,
// describing what clicking a highlighted tile does. Falls back to a generic
// line for any kind not called out explicitly.
const singleCellChoiceLabel = (pendingChoice) => {
  const { kind, cardName } = pendingChoice;
  switch (kind) {
    case 'token-location':
      return `${cardName}: choose a highlighted tile to summon ${pendingChoice.purgatoryInstanceId ? 'it' : 'a token'} on.`;
    case 'summon-token-pointed':
      return `${cardName}: choose a highlighted tile it points to, to summon a token on.`;
    case 'copy-engage-target':
      return `${cardName}: choose a highlighted opposing Being to copy the Engage ability of.`;
    case 'trigger-depart-target':
      return `${cardName}: choose a highlighted Being to trigger the Depart of.`;
    case 'minus-counter-target':
      return `${cardName}: choose a highlighted Being to give ${pendingChoice.amount} -1/-1 Counter(s).`;
    case 'invoke-destination':
      return `${cardName}: choose a highlighted tile to invoke onto.`;
    case 'add-counter-typed-pointed-target':
      return `${cardName}: choose a highlighted Being to add ${pendingChoice.amount} ${pendingChoice.counterType} Counter(s) to.`;
    case 'move-armament-destination':
      return `${cardName}: choose a highlighted tile to move the Armament onto.`;
    case 'restore-lifespan-target':
      return `${cardName}: choose a highlighted target (or a player below) to restore ${pendingChoice.amount} Lifespan to.`;
    case 'damage-target':
      // Immen Gorta's own Boundless Hunger bounce loop (placeReturnedFromShift/
      // continueBoundlessHungerBounce, actions.js) pauses on a real target
      // choice for each of its first 3 illustrated returns before the loop is
      // declared — bounceCount is 0/1/2, so step (bounceCount + 1) of 3.
      // Without this, all 3 identical-looking prompts in a row (then a sudden
      // game-over) gave no indication anything beyond an ordinary damage
      // choice was happening.
      return pendingChoice.boundlessHunger
        ? `Boundless Hunger loop — step ${pendingChoice.boundlessHunger.bounceCount + 1} of 3: choose a highlighted target for ${cardName}'s ${pendingChoice.damage} damage.`
          + (pendingChoice.boundlessHunger.bounceCount === 2 ? ' Resolving this completes the loop and wins the game.' : '')
        : `${cardName}: choose a highlighted ${pendingChoice.typing || 'Being'} to take ${pendingChoice.damage} damage.`;
    case 'destroy-permanent':
      return `${cardName}: choose a highlighted permanent to destroy.`;
    case 'strength-set-eot':
      return `${cardName}: choose a highlighted Being to set its Strength to ${pendingChoice.amount} until end of turn.`;
    case 'reveal-prophecy':
      return `${cardName}: choose a highlighted Prophecy to reveal.`;
    case 'sacrifice':
      return `${cardName}: choose a highlighted Being to sacrifice.`;
    case 'grant-favor':
      return `${cardName}: choose a highlighted Being to become Favored.`;
    case 'buff-ally':
      return `${cardName}: choose a highlighted ally to buff.`;
    case 'copy-stats':
      return `${cardName}: choose a highlighted Being to copy the stats of.`;
    case 'doesnt-disengage':
      return `${cardName}: choose a highlighted Being.`;
    case 'move-target-being':
      return `${cardName}: choose a highlighted Being to move to ${pendingChoice.toCellId}.`;
    case 'free-move':
      return `${cardName}: choose a highlighted tile to move to.`;
    case 'return-to-hand':
      return `${cardName}: choose a highlighted Being to return to hand.`;
    case 'sacrifice-being-cost':
      return `${cardName}: choose a highlighted Being to sacrifice.`;
    case 'sacrifice-typed-cost':
      return `${cardName}: choose a highlighted ${pendingChoice.typing} to sacrifice.`;
    case 'select-move-source':
      return `${cardName}: choose a highlighted Being to move.`;
    case 'engage-buff-eot':
      return `${cardName}: choose a highlighted Being to Engage (${pendingChoice.strengthBonus >= 0 ? '+' : ''}${pendingChoice.strengthBonus}/${pendingChoice.lifespanBonus >= 0 ? '+' : ''}${pendingChoice.lifespanBonus} until end of turn).`;
    case 'engage-then-move':
      return `${cardName}: choose a highlighted ${pendingChoice.typing} to Engage and move.`;
    case 'engage-move-twice':
      return `${cardName}: choose a highlighted Being to Engage and move twice.`;
    case 'time-counter-block-move':
      return `${cardName}: choose a highlighted Being to give ${pendingChoice.amount} Time Counter(s) (it can't move while it has any).`;
    case 'freeze-frame-target':
      return `${cardName}: choose a highlighted Engaged Being to give ${pendingChoice.amount} Time Counter(s) (it won't disengage while it has any).`;
    case 'add-counter-relic-target':
      return `${cardName}: choose a highlighted Relic to add ${pendingChoice.amount} ${pendingChoice.counterType} Counter(s) to.`;
    case 'sacrifice-relic-cost':
      return `${cardName}: choose a highlighted Relic to sacrifice.`;
    case 'vyu-bhata-target':
      return `${cardName}: choose a highlighted Being to give +1/+1 (plus 1 for each adjacent Being you control).`;
    case 'sacrifice-pointed-target':
      return `${cardName}: choose a highlighted Being to sacrifice.`;
    case 'sacrifice-typed-cost-limit':
      return `${cardName}: choose a highlighted Being to sacrifice.`;
    case 'drown-screams-target':
      return `${cardName}: choose a highlighted Non-Deity Being to strip its abilities until end of turn.`;
    case 'dendrify-target':
      return `${cardName}: choose a highlighted Being to strip its abilities and set it to ${pendingChoice.newStrength}/${pendingChoice.newLifespan} until end of turn.`;
    case 'recollect-target':
      return `${cardName}: choose a highlighted Being to return to its owner's hand.`;
    case 'legend-rule-keep':
      return `You control more than one ${cardName} — choose which one to keep (the legend rule).`;
    case 'move-forward-target':
      return `${cardName}: choose a highlighted Being to move forward.`;
    case 'strength-debuff-target':
      return `${cardName}: choose a highlighted Being to give -${pendingChoice.amount}/-0 Strength until end of turn.`;
    case 'debuff-per-own-death-target':
      return `${cardName}: choose a highlighted Being to give -${pendingChoice.amount}/-${pendingChoice.amount} until end of turn.`;
    case 'return-the-favor-target':
      return `${cardName}: choose a different highlighted Being to make Favored.`;
    case 'diablerie-select-mover':
      return `${cardName}: choose a highlighted Being of yours to move (or Done, below), then it loses half its Lifespan.`;
    case 'diablerie-move-destination':
      return `${cardName}: choose where it moves.`;
    case 'lifespan-damage-first-target':
      return `${cardName}: choose a highlighted Being you control to deal ${pendingChoice.amount1} Lifespan Damage to.`;
    case 'lifespan-damage-second-target':
      return `${cardName}: choose a different highlighted Being to deal ${pendingChoice.amount} Lifespan Damage to.`;
    case 'shift-destination':
      return `${cardName}: choose a highlighted Ethereal Realm tile to Shift onto.`;
    case 'shift-return':
      return `${cardName}: choose a highlighted Mortal Realm tile to return to.`;
    case 'shift-from-purgatory-destination':
      return `${cardName}: choose a highlighted Mortal Realm tile to return to.`;
    case 'give-different-typed-buff':
      return `${cardName}: choose a highlighted Being to buff.`;
    case 'force-shift-target':
      return `${cardName}: choose a highlighted Being to force to Shift.`;
    case 'copy-opponent-effect':
      return `${cardName}: choose a highlighted opposing Being to copy the effect(s) of until the end of your next turn.`;
    case 'udarik-shift-target':
      return `${cardName}: choose a highlighted Being to Shift.`;
    case 'deja-vu-target':
      return `${cardName}: choose a highlighted Being you control to return to hand and resummon for free.`;
    case 'summon-sacrifice-cost':
      return `${cardName}: choose ${pendingChoice.amount - pendingChoice.selected.length} more highlighted Being(s) to sacrifice as an additional cost.`;
    case 'end-of-turn-damage-named-family-target':
      return `${cardName}: choose a highlighted Being to take ${pendingChoice.amount} Lifespan Damage.`;
    default:
      return `${cardName}: choose a highlighted tile.`;
  }
};

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// "Reveal the top of your deck..." popups (Farm Hand — bug report: "Reveal
// the card large scale (size of a card when hovered) on the center of the
// board in a pop up window... allow the player to view the card for 30
// seconds before force closing that window") — `revealPopup` (actions.js)
// is a purely transient, informational field: the real outcome (drawn vs.
// left on top) already happened by the time this shows, so the one button
// here is just an acknowledgment that matches whichever outcome actually
// occurred, not a live choice. Auto-dismisses after 30s either way.
const REVEAL_POPUP_WIDTH = 260;
const REVEAL_POPUP_HEIGHT = Math.round(REVEAL_POPUP_WIDTH * 7 / 5);
function RevealPopup({ revealPopup, dispatch, cardArtProps }) {
  useEffect(() => {
    const id = setTimeout(() => dispatch({ type: 'DISMISS_REVEAL_POPUP' }), 30000);
    return () => clearTimeout(id);
  }, [revealPopup, dispatch]);
  const drawn = revealPopup.outcome === 'drawn';
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-2xl p-4 flex flex-col items-center gap-3">
        <div className="font-semibold text-stone-800 text-center">
          {revealPopup.cardName}'s {revealPopup.label} reveals {revealPopup.playerId === HUMAN ? 'your' : "the opponent's"} top card
        </div>
        <div style={{ width: REVEAL_POPUP_WIDTH, height: REVEAL_POPUP_HEIGHT }}>
          <CardThumbnail card={revealPopup.card} width={REVEAL_POPUP_WIDTH} height={REVEAL_POPUP_HEIGHT} {...cardArtProps} />
        </div>
        <p className="text-xs text-stone-500 text-center">
          {drawn ? `${revealPopup.card.name} is added to hand.` : `${revealPopup.card.name} doesn't qualify — it stays on top of the deck.`}
        </p>
        <button
          onClick={() => dispatch({ type: 'DISMISS_REVEAL_POPUP' })}
          className={`px-4 py-2 rounded-lg text-white font-semibold ${drawn ? 'bg-amber-600 hover:bg-amber-500' : 'bg-stone-600 hover:bg-stone-500'}`}
        >
          {drawn ? 'Draw' : 'Put Back on Top'}
        </button>
      </div>
    </div>
  );
}

export default function Match({ initialState, onExit, onRematch, deckEntries, competitiveMode, aiDifficulty }) {
  const [state, dispatch, lastAttack, lastMartyr, lastEngageGlow, lastModulate] = useGameEngine(initialState, AI, aiDifficulty);
  // Purely a rendering concern — game logic/AI/legality below all keep
  // reading the real state.board; only what gets painted onto <Board> is
  // staged (see useStagedBoard.js).
  const { displayBoard, flashes } = useStagedBoard(state.board);
  const { displayLifespans, lifeFlashes } = useStagedLife(state.players);
  const turnBanner = useTurnBanner(state);
  const justDrawnIds = useJustDrawn(state.players[HUMAN].hand);
  const vortexCells = useShiftVortex(state.board);
  const departCells = useDepartFlash(state.board, state.log);
  const deityCells = useDeitySummonCinematic(state.board);
  const openLaneStrikes = useOpenLaneStrike(state.log);
  const [selectedHand, setSelectedHand] = useState(null);
  const [selectedCell, setSelectedCell] = useState(null);
  // Set when the human clicks a highlighted Modulate target that offers
  // both +1 and -1 (a "±" effect) — the board click alone can't say which
  // sign, so a tiny inline prompt (in the Modulate banner, below) asks for
  // just that one cell instead of falling back to a full-screen modal.
  const [modulateDeltaCell, setModulateDeltaCell] = useState(null);
  // "View Board" for the ~27 full-screen choice popups (Invoke, discard,
  // search results, the numeric picker, ...) — those all share the exact
  // same "fixed inset-0" wrapper, now conditionally `hidden` (not
  // unmounted, so nothing about the choice itself is lost) while this is
  // true. Reset to false below whenever a NEW choice opens, so hiding one
  // choice's popup never leaves a LATER, unrelated choice silently hidden.
  // Viewer-style popups (hand/Purgatory/armament zoom, already dismissable
  // via their own X button) intentionally don't participate.
  const [popupHidden, setPopupHidden] = useState(false);
  // Same "peek without losing what's on screen" idea as popupHidden above,
  // for the win/lose screen specifically — that screen replaces the whole
  // match view outright (state.phase 'gameover' short-circuits the render
  // below) rather than overlaying it, so there's no board left mounted
  // underneath to reveal; this instead renders a simple read-only snapshot
  // of the final board in its place. Declared at the top level (not inside
  // the gameover branch) since it's only ever read once phase is already
  // 'gameover' — a hook can't be called conditionally.
  const [showBoardOnGameOver, setShowBoardOnGameOver] = useState(false);
  const [expandedCell, setExpandedCell] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // `.slice(-30)` on every render would otherwise hand ActionLog a brand
  // new array reference each time — including the once-a-second re-render
  // from the live match clock (setLiveElapsedMs below) — which made its own
  // useEffect(() => scrollTop = scrollHeight, [entries]) think new entries
  // had arrived and yank the panel back to the bottom every second,
  // fighting any manual scroll-up. Memoized on state.log itself (a fresh
  // reference only when a real dispatch appends to it) so the panel only
  // snaps to bottom when there's actually something new to show.
  const historyEntries = useMemo(() => state.log.slice(-30), [state.log]);
  const [purgatoryOwner, setPurgatoryOwner] = useState(null); // null | HUMAN | AI
  const [altarsOwner, setAltarsOwner] = useState(null); // null | HUMAN | AI
  const [purgatoryPreviewIndex, setPurgatoryPreviewIndex] = useState(null);
  // Set when the human clicks a highlighted, activatable card inside their
  // own Purgatory list (Roots of Eternity) — closes the Purgatory modal and
  // highlights the legal board tiles to sacrifice instead (same "click a
  // highlighted board tile" resolution every other single-cell choice
  // uses), rather than opening the normal name/preview view.
  const [reanimatingPurgatoryId, setReanimatingPurgatoryId] = useState(null);
  // The value currently dialed in on a NUMERIC_CHOICE_KINDS picker (a
  // <select>, not a click-to-resolve board tile), before Confirm dispatches
  // it. Reset to 0 whenever a NEW such choice opens — tracked via the
  // "adjust state during render" pattern (comparing against the kind last
  // seen) rather than a useEffect, so a stale value from a previous pick
  // never flashes before the reset runs.
  const [numericChoiceValue, setNumericChoiceValue] = useState(0);
  const [numericChoiceKindSeen, setNumericChoiceKindSeen] = useState(null);
  const currentPendingChoiceKind = state.pendingChoice?.kind ?? null;
  if (currentPendingChoiceKind !== numericChoiceKindSeen) {
    setNumericChoiceKindSeen(currentPendingChoiceKind);
    if (NUMERIC_CHOICE_KINDS[currentPendingChoiceKind]) setNumericChoiceValue(0);
  }
  const [handViewOpen, setHandViewOpen] = useState(false);
  const [handMinimized, setHandMinimized] = useState(false);
  // Scales the board + side-panel group to whatever space is actually left
  // between the header and the Hand row, so it's never cut off/scrolled
  // behind the Hand on a shorter or narrower window — see the ResizeObserver
  // effect below. `boardAreaRef` is the flexible space available to it;
  // `boardContentRef` is the group's own natural (unscaled) size. Capped at
  // 1 — this only ever shrinks the board to fit, never enlarges it past its
  // own natural size (the recent size bump already covers "make it bigger").
  const boardAreaRef = useRef(null);
  const boardContentRef = useRef(null);
  const [boardScale, setBoardScale] = useState(1);
  // The content's own natural (unscaled) size, tracked as state (not read
  // from the ref during render — refs are only ever read inside the effect
  // below, an event handler's territory) so the reserved-space wrapper can
  // size itself to the *scaled* footprint without a live ref read.
  const [boardNaturalSize, setBoardNaturalSize] = useState({ width: 0, height: 0 });
  // Set when summoning/casting/playing/attaching something whose Faithless
  // (generic) cost portion can be paid with more than one Effigy color and
  // some would be left over either way (faithlessPaymentNeedsChoice,
  // actions.js) — the underlying engine action is held here, not yet
  // dispatched, until the player picks exactly which colors to spend in
  // the small picker below (see dispatchWithPaymentCheck).
  const [pendingPaymentAction, setPendingPaymentAction] = useState(null); // { action, cost, cardName }
  const [selectedPaymentIds, setSelectedPaymentIds] = useState([]);
  // popupHidden (View Board) resets whenever a NEW choice-popup-worthy
  // state appears — covers every pendingChoice-driven popup (27 of the 27)
  // plus the one local-state exception, pendingPaymentAction, which isn't
  // itself a pendingChoice.
  useEffect(() => { setPopupHidden(false); }, [state.pendingChoice]);
  useEffect(() => { setPopupHidden(false); }, [pendingPaymentAction]);
  // A pending "search deck/Purgatory" choice defaults to showing only the
  // legal targets (the common case — usually a handful of matches); this
  // toggles to browsing every card in that zone instead, e.g. to double
  // check the automated search query didn't miss something.
  const [searchShowAll, setSearchShowAll] = useState(false);
  const previewCanvasRef = useRef(null);
  const matchStartRef = useRef(null);
  const [elapsedMs, setElapsedMs] = useState(null);
  const [liveElapsedMs, setLiveElapsedMs] = useState(0);
  const fontLoaded = useCardFont();
  const { borderImages, loaded: borderImagesLoaded } = useBorderImages();
  const { artImages, artBorderImages, loaded: artImagesLoaded } = useCardArtImages();

  useEffect(() => {
    matchStartRef.current = Date.now();
  }, []);

  // Reset the "show all" toggle whenever a genuinely new search choice
  // opens (or closes) — it shouldn't carry over from a previous one.
  // Adjusted during render (React's own pattern for this) rather than in
  // an effect, so it doesn't cost an extra render pass.
  const searchChoiceKey = state.pendingChoice?.kind === 'search' ? state.pendingChoice : null;
  const prevSearchChoiceKeyRef = useRef(searchChoiceKey);
  if (prevSearchChoiceKeyRef.current !== searchChoiceKey) {
    prevSearchChoiceKeyRef.current = searchChoiceKey;
    if (searchShowAll) setSearchShowAll(false);
  }

  useEffect(() => {
    if (state.phase === 'gameover' && matchStartRef.current != null && elapsedMs === null) {
      setElapsedMs(Date.now() - matchStartRef.current);
    }
  }, [state.phase, elapsedMs]);

  // Live match clock, top-left — ticks every second until the game ends.
  useEffect(() => {
    if (state.phase === 'gameover') return;
    const id = setInterval(() => {
      if (matchStartRef.current != null) setLiveElapsedMs(Date.now() - matchStartRef.current);
    }, 1000);
    return () => clearInterval(id);
  }, [state.phase]);

  // Keeps the board + side-panel group's uniform scale in sync with
  // whatever space is actually available for it (boardAreaRef) versus its
  // own natural, unscaled footprint (boardContentRef) — recomputed on
  // every resize of either (a window resize, or the group's own natural
  // size changing as board state/board size classes change). A single
  // ResizeObserver watches both elements at once; either firing recomputes
  // the same ratio. Uniform (one scalar, both axes) so the board's own
  // aspect ratio never distorts — only ever shrinks it (capped at 1), per
  // boardScale's own comment above.
  useEffect(() => {
    const areaEl = boardAreaRef.current;
    const contentEl = boardContentRef.current;
    if (!areaEl || !contentEl) return;
    const recompute = () => {
      const availableWidth = areaEl.clientWidth;
      const availableHeight = areaEl.clientHeight;
      const naturalWidth = contentEl.scrollWidth;
      const naturalHeight = contentEl.scrollHeight;
      if (!naturalWidth || !naturalHeight) return;
      const next = Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight);
      setBoardScale(prev => (Math.abs(prev - next) > 0.005 ? next : prev));
      setBoardNaturalSize(prev => (prev.width === naturalWidth && prev.height === naturalHeight ? prev : { width: naturalWidth, height: naturalHeight }));
    };
    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(areaEl);
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [state.board, state.groundRelics]);

  const purgatoryCards = useMemo(
    () => (purgatoryOwner ? state.players[purgatoryOwner].purgatory : []),
    [purgatoryOwner, state.players]
  );

  // Group same-named cards in the list view (e.g. "Goblin x2") while the
  // preview modal still cycles every individual card via its own index.
  const purgatoryGroups = useMemo(() => {
    const groups = [];
    const byName = new Map();
    purgatoryCards.forEach((card, i) => {
      let group = byName.get(card.name);
      if (!group) {
        group = { name: card.name, count: 0, firstIndex: i, instanceId: card.instanceId };
        byName.set(card.name, group);
        groups.push(group);
      }
      group.count += 1;
    });
    return groups;
  }, [purgatoryCards]);

  useEffect(() => {
    if (purgatoryPreviewIndex === null || !fontLoaded) return;
    const card = purgatoryCards[purgatoryPreviewIndex];
    if (!card) return;
    const art = resolveCardArt(card.raw, 'default', artImages, artBorderImages, artImagesLoaded);
    const key = getBorderTypeForCard(card.raw);
    const img = art ? art.artBorderImg : borderImages.current[key];
    if (!img || !(art || borderImagesLoaded[key])) return;
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    renderCardOnCanvas(canvas, card.raw, img, DEFAULT_POSITIONS, undefined, undefined, 'default', art?.artImg, art?.artBoxRect);
  }, [purgatoryPreviewIndex, purgatoryCards, fontLoaded, borderImages, borderImagesLoaded, artImages, artBorderImages, artImagesLoaded]);

  const exportDeckList = () => {
    if (!deckEntries) return;
    const lines = deckEntries.map(({ card, count }) => `${count}x ${card.name}`);
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = 'decklist.txt';
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const openPurgatory = (owner) => {
    setPurgatoryOwner(owner);
    setPurgatoryPreviewIndex(null);
  };
  const closePurgatory = () => {
    setPurgatoryOwner(null);
    setPurgatoryPreviewIndex(null);
  };

  const handleConcede = () => {
    if (state.phase !== 'playing') return;
    if (!window.confirm('Concede this match? The AI will be declared the winner.')) return;
    dispatch({ type: 'CONCEDE', player: HUMAN });
  };

  const isHumanTurn = state.phase === 'playing' && state.turnPlayer === HUMAN;
  // A pending search effect can belong to the human even outside their own
  // turn (e.g. their Being Departs during the AI's attack) — getLegalActions
  // still needs to run so the choice modal has candidates to show. An open
  // Ethereal Conjuring reactive window (actions.js > manageReactiveWindow)
  // is the same shape, just for a real optional action instead of a forced
  // choice — the human may hold priority during the AI's own turn.
  const humanCanAct = state.pendingChoice
    ? state.pendingChoice.playerId === HUMAN
    : state.reactiveWindow
      ? state.reactiveWindow.openFor === HUMAN
      : isHumanTurn;
  const legalActions = useMemo(
    () => (humanCanAct ? getLegalActions(state, HUMAN) : []),
    [state, humanCanAct]
  );

  // "Any target" effects that can hit a player's Lifespan directly
  // (Sharpshoot-style damage, restore-lifespan-target) resolve onto
  // whichever player's own LifeBadge the human clicks, rather than a
  // separate "A's Lifespan" / "B's Lifespan" button pair — see the
  // LifeBadge highlight/onClick wiring below and singleCellChoiceLabel's
  // own banner (still shown as a text reminder, minus the old buttons).
  const playerTargetActionType = state.pendingChoice?.kind === 'restore-lifespan-target'
    ? 'RESOLVE_RESTORE_LIFESPAN_TARGET_PLAYER'
    : state.pendingChoice?.kind === 'damage-target' && state.pendingChoice.includesPlayers
      ? 'RESOLVE_DAMAGE_TARGET_PLAYER'
      : null;
  const playerTargetActions = useMemo(
    () => (playerTargetActionType ? legalActions.filter(a => a.type === playerTargetActionType) : []),
    [legalActions, playerTargetActionType]
  );
  const playerTargetActionFor = (id) => playerTargetActions.find(a => a.targetPlayerId === id);

  // Competitive Mode's reactive-window clock: the human's own turn is never
  // timed (only PASS_TURN ends it, at their own pace) — this only times an
  // open Ethereal Conjuring reactive window (state.reactiveWindow), since
  // that's the one place the human can otherwise sit indefinitely on the
  // AI's turn. Ref-tracked (not state) since it must survive across many
  // windows without itself triggering re-renders: 3 consecutive timeouts
  // (no response before the clock hits 0) speeds every window after that
  // down to 10s, until the human actually responds — casts, or hits Pass —
  // before time runs out, which resets it back to a fresh 20s baseline.
  const reactiveWindowOpenForHuman = state.reactiveWindow?.openFor === HUMAN;
  const reactiveTimeoutStreakRef = useRef(0);
  const reactiveAutoPassRef = useRef(false);
  const [reactiveSecondsLeft, setReactiveSecondsLeft] = useState(null);
  useEffect(() => {
    if (!competitiveMode || !reactiveWindowOpenForHuman) return undefined;
    const duration = reactiveTimeoutStreakRef.current >= 3 ? 10 : 20;
    setReactiveSecondsLeft(duration);
    const tickInterval = setInterval(() => {
      setReactiveSecondsLeft(s => (s === null ? null : Math.max(0, s - 1)));
    }, 1000);
    const autoPassTimeout = setTimeout(() => {
      reactiveAutoPassRef.current = true;
      dispatch({ type: 'PASS_PRIORITY' });
    }, duration * 1000);
    return () => {
      clearInterval(tickInterval);
      clearTimeout(autoPassTimeout);
      setReactiveSecondsLeft(null);
      if (reactiveAutoPassRef.current) {
        reactiveAutoPassRef.current = false;
        reactiveTimeoutStreakRef.current += 1;
      } else {
        // The window closed for some other reason — the human cast an
        // Ethereal Conjuring or hit Pass themselves before time ran out.
        reactiveTimeoutStreakRef.current = 0;
      }
    };
  }, [reactiveWindowOpenForHuman, competitiveMode, dispatch]);

  // Opening-hand clock: 60 seconds to Keep or Mulligan the very first hand,
  // then 40 seconds for every hand redrawn by a Mulligan after that — auto-
  // Keeps whichever hand is showing once time runs out, same "don't let the
  // game stall waiting on a human who's stepped away" reasoning the
  // Competitive Mode reactive-window clock above already follows (always
  // on here, though, not gated to Competitive Mode — this is about opening
  // pace, not in-match priority). `mulliganCount` is bumped locally by the
  // Mulligan button's own onClick (below) — the single place a new hand can
  // ever be requested — rather than derived from engine state, since
  // nothing else needs to track it. The effect re-arms whenever the human's
  // own hand reference actually changes (a fresh deal or a Mulligan
  // redraw — KEEP_HAND never reassigns `hand`, so clicking Keep doesn't
  // spuriously restart it).
  const humanMulliganHand = state.players[HUMAN]?.hand;
  const [mulliganCount, setMulliganCount] = useState(0);
  const [mulliganSecondsLeft, setMulliganSecondsLeft] = useState(null);
  const [mulliganPreviewCard, setMulliganPreviewCard] = useState(null);
  useEffect(() => {
    if (state.phase !== 'mulligan' || state.players[HUMAN].keptHand) return undefined;
    const duration = mulliganCount === 0 ? 60 : 40;
    setMulliganSecondsLeft(duration);
    const tickInterval = setInterval(() => {
      setMulliganSecondsLeft(s => (s === null ? null : Math.max(0, s - 1)));
    }, 1000);
    const autoKeepTimeout = setTimeout(() => {
      dispatch({ type: 'KEEP_HAND', player: HUMAN });
    }, duration * 1000);
    return () => {
      clearInterval(tickInterval);
      clearTimeout(autoKeepTimeout);
      setMulliganSecondsLeft(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, humanMulliganHand, mulliganCount, dispatch]);

  const playableIds = useMemo(() => new Set(
    legalActions.filter(a => CELL_TARGET_TYPES.includes(a.type) || a.type === 'CAST_CONJURING' || a.type === 'PLACE_ALTAR').map(a => a.instanceId)
  ), [legalActions]);

  // Roots of Eternity's own Purgatory-reanimate ability: which cards
  // sitting in the human's own Purgatory are legally activatable right now
  // (at least one matching token the human controls on board) — drives the
  // "highlight your Purgatory" glow and each activatable name's own
  // highlight inside the list.
  const reanimatablePurgatoryIds = useMemo(() => {
    if (!isHumanTurn) return new Set();
    return new Set(legalActions.filter(a => a.type === 'ACTIVATE_REANIMATE_FROM_PURGATORY').map(a => a.purgatoryInstanceId));
  }, [legalActions, isHumanTurn]);

  // Mausoleum Gates' own standing "you may summon <Typing> from your
  // Purgatory until the end of your turn" window — unlike Roots of
  // Eternity's reanimate above, this is a single click with no board-tile
  // follow-up of its own: ACTIVATE_SUMMON_TYPED_FROM_PURGATORY_WINDOW either
  // places it directly (one empty tile) or opens the already-wired
  // 'token-location' pendingChoice (more than one), so it dispatches right
  // from this list instead of setting a two-step selection state.
  const summonWindowPurgatoryIds = useMemo(() => {
    if (!isHumanTurn) return new Set();
    return new Set(legalActions.filter(a => a.type === 'ACTIVATE_SUMMON_TYPED_FROM_PURGATORY_WINDOW').map(a => a.instanceId));
  }, [legalActions, isHumanTurn]);

  // Once the human has clicked an activatable Purgatory entry
  // (reanimatingPurgatoryId set), the legal board tiles to sacrifice —
  // each is its own destination, since the summon lands wherever the
  // sacrificed token was standing.
  const reanimateSacrificeCandidates = useMemo(() => {
    if (!reanimatingPurgatoryId) return [];
    return legalActions
      .filter(a => a.type === 'ACTIVATE_REANIMATE_FROM_PURGATORY' && a.purgatoryInstanceId === reanimatingPurgatoryId)
      .map(a => a.sacrificeCellId);
  }, [legalActions, reanimatingPurgatoryId]);

  const highlightCells = useMemo(() => {
    const set = new Set();
    // Roots of Eternity's own Purgatory-reanimate: once the human has
    // clicked the activatable entry in their own Purgatory list, the legal
    // board tiles to sacrifice light up directly, same as any other
    // board-native single-cell choice — see reanimateSacrificeCandidates.
    if (reanimatingPurgatoryId) {
      reanimateSacrificeCandidates.forEach(cell => set.add(cell));
      return set;
    }
    // Any pendingChoice resolved by picking a single board cell (see
    // SINGLE_CELL_CHOICE_KINDS) takes priority over the normal hand/cell
    // selection highlighting — a modal-free, board-native choice: the
    // legal tiles themselves light up, same as a hand card's legal
    // destinations do, and clicking one resolves it directly.
    const singleCellChoice = state.pendingChoice?.playerId === HUMAN ? SINGLE_CELL_CHOICE_KINDS[state.pendingChoice.kind] : null;
    if (singleCellChoice) {
      legalActions
        .filter(a => a.type === singleCellChoice.actionType)
        .forEach(a => set.add(a[singleCellChoice.cellField]));
      return set;
    }
    // Modulate targets any Time Counter the player controls (a Prophecy's
    // own timer, or another occupant's counters.time, e.g. Hourglass) — not
    // a fixed single field/actionType shape, so it isn't a plain
    // SINGLE_CELL_CHOICE_KINDS entry: a "±" effect offers two deltas per
    // cell, resolved by the small inline prompt below (modulateDeltaCell)
    // rather than a full-screen modal.
    if (state.pendingChoice?.kind === 'modulate' && state.pendingChoice.playerId === HUMAN) {
      legalActions.filter(a => a.type === 'RESOLVE_MODULATE' && a.cellId).forEach(a => set.add(a.cellId));
      return set;
    }
    // Any toggle-then-confirm choice (see TOGGLE_CHOICE_KINDS) — every
    // legal candidate lights up as toggleable (see toggledCells, below,
    // for which are currently in).
    const toggleChoice = state.pendingChoice?.playerId === HUMAN ? TOGGLE_CHOICE_KINDS[state.pendingChoice.kind] : null;
    if (toggleChoice) {
      legalActions
        .filter(a => a.type === toggleChoice.toggleActionType)
        .forEach(a => set.add(a.cellId));
      return set;
    }
    if (selectedHand) {
      legalActions
        .filter(a => CELL_TARGET_TYPES.includes(a.type) && a.instanceId === selectedHand)
        .forEach(a => set.add(a.cellId));
    } else if (selectedCell) {
      legalActions
        .filter(a => a.type === 'MOVE_OR_ATTACK' && a.fromCellId === selectedCell)
        .forEach(a => set.add(a.toCellId));
    }
    return set;
  }, [legalActions, selectedHand, selectedCell, state.pendingChoice, reanimatingPurgatoryId, reanimateSacrificeCandidates]);

  // The one board cell the currently-open reactive window's own pending
  // effect is about (Medium Mage's summoned Being, an Engage attempt, a
  // declared attacker) — a distinct yellow highlight from the green
  // target-selection ring below, so it's visually obvious which card is
  // "the thing being responded to" until the window closes and it resolves.
  // No pendingResolution (e.g. a reactive window opened after a plain
  // CAST_CONJURING that already resolved atomically) means there's no
  // single cell to outline.
  const respondingCellId = state.reactiveWindow
    ? state.pendingResolution?.cellId || state.pendingResolution?.fromCellId || null
    : null;

  const toggledCells = useMemo(() => {
    if (!TOGGLE_CHOICE_KINDS[state.pendingChoice?.kind] || state.pendingChoice.playerId !== HUMAN) return undefined;
    return new Set(state.pendingChoice.selected);
  }, [state.pendingChoice]);

  // Dispatches `action` right away, unless paying `card`'s own Faithless
  // portion is a real choice for the human right now (more than one Effigy
  // color available, with some left over either way) — in which case the
  // action is held in pendingPaymentAction and the small picker below asks
  // first. `card` is whichever card in hand this action is casting/
  // summoning/playing/attaching; costOverride is only needed for
  // SUMMON_BEING, where the real charge (effectiveCastingCost) can differ
  // from the card's own printed castingCost (Skeletal Colossus/Singularity/
  // Simple Summoner-style reductions).
  const dispatchWithPaymentCheck = (action, card, costOverride) => {
    if (action.type === 'RESOLVE_CHOICE' || !card) {
      dispatch(action);
      return;
    }
    const cost = costOverride || card.castingCost;
    const pool = state.players[HUMAN].effigyPool;
    if (faithlessPaymentNeedsChoice(pool, cost)) {
      setPendingPaymentAction({ action, cost, cardName: card.name });
      setSelectedPaymentIds([]);
      return;
    }
    dispatch(action);
  };

  // A Conjuring or an Altar has no board target to click afterward, so
  // selecting one just marks it selected (same as every other hand card)
  // instead of casting it immediately — the confirmSelectedHandAction
  // banner below is the actual "commit" step, with its own Cast/X buttons,
  // so a misclick here (Desecration and friends) can still be backed out
  // of before anything is paid or a target picker opens.
  const onHandSelect = (instanceId) => {
    // Scoped narrowly to this one gate (not the broader humanCanAct, which
    // is also true during an unrelated pendingChoice and would leave a
    // confusing dead-end hand selection there) — during a reactive window
    // opened for the human, state.turnPlayer is still the OTHER player, so
    // isHumanTurn alone would wrongly block selecting an Ethereal Conjuring
    // to cast in response.
    if (!isHumanTurn && state.reactiveWindow?.openFor !== HUMAN) return;
    setSelectedCell(null);
    setSelectedHand(prev => (prev === instanceId ? null : instanceId));
  };

  // The Conjuring/Altar the selected hand card would cast, if any — shown
  // as its own confirm banner (see below) rather than dispatched straight
  // from onHandSelect.
  const selectedHandImmediateAction = useMemo(
    () => (selectedHand
      ? legalActions.find(a => (a.type === 'CAST_CONJURING' || a.type === 'PLACE_ALTAR') && a.instanceId === selectedHand)
      : null),
    [legalActions, selectedHand]
  );

  // Beings can move/attack/Martyr/Engage; Relics can only Engage (if they
  // carry "Engage: X" text); an Animated Armament (RULES.md > Keywords) —
  // the topmost entry of a Being-less pile — can move/attack too, just not
  // Martyr/Engage. All three need cell selection to reach their action.
  const isSelectableForEngage = (occupant) =>
    occupant?.ownerId === HUMAN
    && (occupant.type === 'being' || occupant.type === 'relic' || !!animatedTopEntry(occupant));

  // An occupant's own top-level `engaged` for a Being/Relic; the topmost
  // entry's own `engaged` for an Animated Armament pile (it has no
  // top-level `engaged` field of its own).
  const actorEngaged = (occupant) =>
    occupant?.type === 'armament-stack' ? !!animatedTopEntry(occupant)?.engaged : !!occupant?.engaged;

  // A handful of activated abilities are deliberately NOT gated by
  // Engage/tap (MetaToris's "Twice per turn Modulate", Blooming Seed's Pay/
  // counter-cost abilities, Cemetery Physician's sacrifice-X — see their own
  // getLegalActions comments in actions.js). legalActions already omits an
  // engaged check for these, so an already-engaged occupant carrying one of
  // them still needs to be selectable here, or its button never reaches the
  // player.
  const hasNonEngageGatedAbility = (id) =>
    legalActions.some(a =>
      (a.type === 'ACTIVATE_TIMES_PER_TURN_ABILITY' || a.type === 'ACTIVATE_PAY_EFFIGY_COST_ABILITY'
        || a.type === 'ACTIVATE_COUNTER_COST_SACRIFICE' || a.type === 'ACTIVATE_SACRIFICE_X_SUMMON'
        || a.type === 'ACTIVATE_REMOVE_COUNTERS_SACRIFICE_SEARCH' || a.type === 'ACTIVATE_ENGAGE_BEING_GRANT_COUNTER'
        || a.type === 'ACTIVATE_PAY_LIFESPAN_COST_ABILITY')
      && a.cellId === id
    );

  // A "Beings may move across this" Relic (RULES.md > Keywords) lives in
  // groundRelics, not board — selectable for its own Engage the same way a
  // board Relic is. Deliberately independent of whatever's in board[id]
  // (Claws of Onoushara: "Sacrifice a Being on this tile..." is exactly a
  // ground Relic sharing a tile with a Being) — gating this on an empty
  // board[id] made an already-engaged/no-bare-ability Being on the same
  // tile block selection entirely, leaving the Relic's own Engage
  // unreachable. engageActions below already merges both action types by
  // selectedCell, so either occupant being independently selectable is
  // enough to surface both.
  const isSelectableGroundRelic = (id) => {
    const g = state.groundRelics[id];
    return !!g && g.ownerId === HUMAN && !g.engaged;
  };

  const onCellClick = (id) => {
    // Roots of Eternity's own Purgatory-reanimate — same board-native
    // resolution as a real pendingChoice, but driven by local UI state
    // (reanimatingPurgatoryId) since the ability itself lives on a card in
    // Purgatory, not a board occupant with its own engine pendingChoice.
    if (reanimatingPurgatoryId) {
      const action = legalActions.find(a =>
        a.type === 'ACTIVATE_REANIMATE_FROM_PURGATORY' && a.purgatoryInstanceId === reanimatingPurgatoryId && a.sacrificeCellId === id
      );
      setReanimatingPurgatoryId(null);
      if (action) dispatch(action);
      return;
    }

    // A pendingChoice belonging to the human resolves even outside their
    // own turn (e.g. Venefica's forced sacrifice fires on the AI's turn,
    // but it's the human who chooses) — same humanCanAct reasoning
    // getLegalActions already follows above. Everything past this block is
    // normal play, which is only ever legal on the human's own turn.
    const singleCellChoice = state.pendingChoice?.playerId === HUMAN ? SINGLE_CELL_CHOICE_KINDS[state.pendingChoice.kind] : null;
    if (singleCellChoice) {
      const action = legalActions.find(a => a.type === singleCellChoice.actionType && a[singleCellChoice.cellField] === id);
      if (action) dispatch(action);
      return;
    }

    if (state.pendingChoice?.kind === 'modulate' && state.pendingChoice.playerId === HUMAN) {
      const matches = legalActions.filter(a => a.type === 'RESOLVE_MODULATE' && a.cellId === id);
      if (matches.length === 1) {
        dispatch(matches[0]);
        setModulateDeltaCell(null);
      } else if (matches.length > 1) {
        setModulateDeltaCell(id);
      }
      return;
    }

    const toggleChoiceClick = state.pendingChoice?.playerId === HUMAN ? TOGGLE_CHOICE_KINDS[state.pendingChoice.kind] : null;
    if (toggleChoiceClick) {
      const action = legalActions.find(a => a.type === toggleChoiceClick.toggleActionType && a.cellId === id);
      if (action) dispatch(action);
      return;
    }

    // Same reactive-window exception onHandSelect's own gate already uses —
    // Engage abilities are "ethereal speed" too (actions.js >
    // offerReactiveEngageActions), so selecting a cell to bring up its
    // Engage banner below needs to work during an open window, not just on
    // the human's own turn. Everything past this point that isn't actually
    // legal right now (moving, summoning from hand, ...) simply won't find
    // a matching action in `legalActions` and no-ops, same safety net as
    // always — getLegalActions itself is what actually restricts a
    // reactive window down to PASS_PRIORITY/CAST_CONJURING/Engage.
    if (!isHumanTurn && state.reactiveWindow?.openFor !== HUMAN) return;

    if (selectedHand) {
      const action = legalActions.find(a =>
        CELL_TARGET_TYPES.includes(a.type) && a.instanceId === selectedHand && a.cellId === id
      );
      setSelectedHand(null);
      if (action) {
        const card = state.players[HUMAN].hand.find(c => c.instanceId === selectedHand);
        // effectiveCastingCost can differ from the card's own printed cost
        // for a Being (Simple Summoner's own discount, costReduction, etc.)
        // or a Relic (Metal Worker's own "next Relic" discount) — never for
        // a Prophecy/Armament, which don't have any such reduction today.
        // RESOLVE_SUMMON_HAND_BEING_POINTED (Collapsing Bridge) summons a
        // Being exactly like SUMMON_BEING, just via a pendingChoice, so it
        // needs the same discount-aware override.
        const costOverride = (action.type === 'SUMMON_BEING' || action.type === 'PLACE_RELIC' || action.type === 'RESOLVE_SUMMON_HAND_BEING_POINTED') && card
          ? effectiveCastingCost(card, state, HUMAN)
          : undefined;
        dispatchWithPaymentCheck(action, card, costOverride);
      }
      return;
    }

    if (selectedCell) {
      if (id === selectedCell) { setSelectedCell(null); return; }
      const action = legalActions.find(a => a.type === 'MOVE_OR_ATTACK' && a.fromCellId === selectedCell && a.toCellId === id);
      if (action) { dispatch(action); setSelectedCell(null); return; }
      const occupant = state.board[id];
      if ((isSelectableForEngage(occupant) && (!actorEngaged(occupant) || hasNonEngageGatedAbility(id))) || isSelectableGroundRelic(id)) { setSelectedCell(id); return; }
      setSelectedCell(null);
      return;
    }

    const occupant = state.board[id];
    if ((isSelectableForEngage(occupant) && (!actorEngaged(occupant) || hasNonEngageGatedAbility(id))) || isSelectableGroundRelic(id)) {
      setSelectedCell(id);
    }
  };

  // Double-clicking a stack carrying more than one real card on the tile
  // (a Being with Armaments attached, a freestanding Armament pile, a
  // Dryad-attached mount — including Armaments attached to THAT mount —
  // or a Being/Prophecy co-located with a ground Relic, e.g. Planchette/
  // Shifting Sands) opens an expanded view showing each card
  // independently, so a specific Armament can be interacted with (e.g.
  // Engaged) without that choice being ambiguous — works for either
  // side's stacks, though only the human's own offers action buttons. A
  // ground Relic lives outside `state.board` entirely (state.groundRelics,
  // same cellId), so it needs its own check here — `state.board[id]` alone
  // would never see it.
  const onCellDoubleClick = (id) => {
    const occupant = state.board[id];
    const groundRelic = state.groundRelics[id];
    if (!(occupant?.armaments?.length > 0 || occupant?.dryadAttached || groundRelic)) return;
    setSelectedCell(null);
    setSelectedHand(null);
    setExpandedCell(id);
  };

  const expandedOccupant = expandedCell ? state.board[expandedCell] : null;
  const expandedGroundRelic = expandedCell ? state.groundRelics[expandedCell] : null;

  // Legal ACTIVATE_ARMAMENT_ENGAGE actions for the expanded stack, keyed by
  // which Armament instance they belong to — a stack can carry more than
  // one independently engageable Armament at once.
  const expandedArmamentEngageActions = useMemo(() => {
    const map = new Map();
    if (!expandedCell) return map;
    legalActions
      .filter(a => a.type === 'ACTIVATE_ARMAMENT_ENGAGE' && a.cellId === expandedCell)
      .forEach(a => map.set(a.armamentInstanceId, a));
    return map;
  }, [legalActions, expandedCell]);

  // Shown next to the board when the selected friendly Being has a legal
  // Martyr activation — engage-and-sacrifice, so it needs its own explicit
  // confirm rather than piggybacking on the move/attack cell-click flow.
  const martyrAction = useMemo(
    () => (selectedCell ? legalActions.find(a => a.type === 'ACTIVATE_MARTYR' && a.cellId === selectedCell) : null),
    [legalActions, selectedCell]
  );

  // Shown next to the board when the selected friendly Being has a legal
  // Shift activation ("Shift (X)." — RULES.md > Keywords) — a single
  // engage-and-move action, same explicit-confirm treatment as Martyr/Engage
  // since it isn't part of the ordinary move/attack cell-click flow. The
  // engine already offers ACTIVATE_SHIFT as one legal action (actions.js);
  // this button was simply never wired up, so a bare "Shift (X)." card
  // (Ounati Hunger, Shifting Shade, ...) had no way to ever be Shifted.
  const shiftAction = useMemo(
    () => (selectedCell ? legalActions.find(a => a.type === 'ACTIVATE_SHIFT' && a.cellId === selectedCell) : null),
    [legalActions, selectedCell]
  );

  // Shown next to the board when the selected friendly Being/Relic has a
  // legal Engage activation — a generic activated ability (RULES.md's
  // "Engage:" pattern), same explicit-confirm treatment as Martyr since it
  // isn't part of the move/attack cell-click flow. A card printing more
  // than one independent Engage ability (Osteomancer) offers more than one
  // entry here, each its own button — everything else still offers exactly
  // one, same as before this existed.
  const engageActions = useMemo(
    () => (selectedCell
      ? legalActions.filter(a => (a.type === 'ACTIVATE_ENGAGE' || a.type === 'ACTIVATE_GROUND_RELIC_ENGAGE') && a.cellId === selectedCell)
      : []),
    [legalActions, selectedCell]
  );

  // Cemetery Physician's own "sacrifice any number of <Name>" trigger — not
  // gated by Engage/tap (see actions.js), so it's offered the same way
  // Martyr/Engage are, just its own separate button.
  const sacrificeXAction = useMemo(
    () => (selectedCell ? legalActions.find(a => a.type === 'ACTIVATE_SACRIFICE_X_SUMMON' && a.cellId === selectedCell) : null),
    [legalActions, selectedCell]
  );

  // Smithing Tools' own "Engage a Being, Gain (1) Forge Counter." — not
  // gated by Engage/tap on itself either, same "own separate button"
  // treatment as sacrificeXAction above.
  const engageGrantCounterAction = useMemo(
    () => (selectedCell ? legalActions.find(a => a.type === 'ACTIVATE_ENGAGE_BEING_GRANT_COUNTER' && a.cellId === selectedCell) : null),
    [legalActions, selectedCell]
  );

  // Smithing Tools' own second ability: "Engage, Remove (X) Forge Counters:
  // Add an Armament from deck to hand with conjuring cost (X)." — a real
  // printed Engage (taps itself), but its own dedicated action type (not
  // ACTIVATE_ENGAGE/ACTIVATE_GROUND_RELIC_ENGAGE), so it needs its own
  // button rather than piggybacking on engageActions below.
  const removeCountersXSearchArmamentAction = useMemo(
    () => (selectedCell ? legalActions.find(a => a.type === 'ACTIVATE_REMOVE_COUNTERS_X_SEARCH_ARMAMENT' && a.cellId === selectedCell) : null),
    [legalActions, selectedCell]
  );

  // A bare "N times per turn X" activated ability (e.g. MetaToris's "Twice
  // per turn Modulate (±1)") — not gated by Engage/tap, so it's offered the
  // same way Martyr/Engage/sacrificeX are, just its own button.
  const timesPerTurnAction = useMemo(
    () => (selectedCell ? legalActions.find(a => a.type === 'ACTIVATE_TIMES_PER_TURN_ABILITY' && a.cellId === selectedCell) : null),
    [legalActions, selectedCell]
  );

  // "Pay (N) <Color>: X" (Blooming Seed's own Growth Counter ability) — a
  // bare, unlimited-per-turn activated ability costed by real Effigy, same
  // "its own button" treatment as sacrificeXAction/timesPerTurnAction above.
  const payEffigyCostAction = useMemo(
    () => (selectedCell ? legalActions.find(a => a.type === 'ACTIVATE_PAY_EFFIGY_COST_ABILITY' && a.cellId === selectedCell) : null),
    [legalActions, selectedCell]
  );

  // Sha-KaRah's own "Pay (5) Lifespan to move an adjacent Armament..." —
  // same bare-activated-ability, own-button treatment as
  // payEffigyCostAction above, just spending real Lifespan instead.
  const payLifespanCostAction = useMemo(
    () => (selectedCell ? legalActions.find(a => a.type === 'ACTIVATE_PAY_LIFESPAN_COST_ABILITY' && a.cellId === selectedCell) : null),
    [legalActions, selectedCell]
  );

  // "Remove (N) <Type> Counter(s): Sacrifice this, X" (Blooming Seed's own
  // Growth-Counter-gated Martyr) — same treatment, its own button.
  const counterCostSacrificeAction = useMemo(
    () => (selectedCell ? legalActions.find(a => a.type === 'ACTIVATE_COUNTER_COST_SACRIFICE' && a.cellId === selectedCell) : null),
    [legalActions, selectedCell]
  );

  // "Remove (X) <Type> Counters: Sacrifice this Relic, then add a <Typing>
  // Being with Conjuring cost (X) from your Purgatory to hand." (Death's
  // Decanter) — X is a player choice, so (unlike the single actions above)
  // this can have more than one legal amount for the same cell; each gets
  // its own button, same "one button per legal value" shape the Modulate
  // "±1" inline prompt already uses.
  const removeCountersSacrificeSearchActions = useMemo(
    () => (selectedCell ? legalActions.filter(a => a.type === 'ACTIVATE_REMOVE_COUNTERS_SACRIFICE_SEARCH' && a.cellId === selectedCell) : []),
    [legalActions, selectedCell]
  );

  // Candidate cards for a pending "Add X to hand from deck" search that
  // belongs to the human — each RESOLVE_CHOICE action names an instanceId,
  // resolved back to its full card here so the picker can show real names.
  const pendingChoiceCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'search' || state.pendingChoice.playerId !== HUMAN) return [];
    const zone = state.players[HUMAN][state.pendingChoice.source];
    return legalActions
      .filter(a => a.type === 'RESOLVE_CHOICE')
      .map(a => zone.find(c => c.instanceId === a.instanceId))
      .filter(Boolean);
  }, [legalActions, state.pendingChoice, state.players]);

  // Every card in the zone a pending search is looking through — offered
  // as a "show all" alternative to the legal-only list above, e.g. to
  // double-check the automated search query didn't miss something. Cards
  // not among the legal candidates render but aren't selectable.
  const pendingChoiceAllInZone = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'search' || state.pendingChoice.playerId !== HUMAN) return [];
    return state.players[HUMAN][state.pendingChoice.source];
  }, [state.pendingChoice, state.players]);

  // Candidate targets for a pending Modulate that belongs to the human —
  // grouped by cell so a "±" (player picks the sign) shows one row with
  // both a +1 and a -1 button instead of two separate rows.
  const pendingModulateCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'modulate' || state.pendingChoice.playerId !== HUMAN) return [];
    const byCell = new Map();
    legalActions.filter(a => a.type === 'RESOLVE_MODULATE' && a.cellId).forEach(a => {
      if (!byCell.has(a.cellId)) {
        byCell.set(a.cellId, { cellId: a.cellId, card: state.board[a.cellId]?.card, deltas: [] });
      }
      byCell.get(a.cellId).deltas.push(a.delta);
    });
    return Array.from(byCell.values());
  }, [legalActions, state.pendingChoice, state.board]);

  // Same grouping for an Altar target (Eònion Altar) — altars aren't board
  // cells, so they're addressed by the altar card's own instanceId instead
  // and can't piggyback on the board's click-to-select flow; listed as
  // their own always-visible row in the Modulate banner below instead.
  const pendingModulateAltarCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'modulate' || state.pendingChoice.playerId !== HUMAN) return [];
    const byAltar = new Map();
    legalActions.filter(a => a.type === 'RESOLVE_MODULATE' && a.altarInstanceId).forEach(a => {
      if (!byAltar.has(a.altarInstanceId)) {
        const altar = (state.altars[HUMAN] || []).find(al => al.card.instanceId === a.altarInstanceId);
        byAltar.set(a.altarInstanceId, { altarInstanceId: a.altarInstanceId, card: altar?.card, deltas: [] });
      }
      byAltar.get(a.altarInstanceId).deltas.push(a.delta);
    });
    return Array.from(byAltar.values());
  }, [legalActions, state.pendingChoice, state.altars]);

  // Candidate deck cards for a pending Invoke card choice (more than one
  // real card matched the search — see resolveInvoke, actions.js).
  const pendingInvokeCardCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'invoke-card-choice' || state.pendingChoice.playerId !== HUMAN) return [];
    return legalActions
      .filter(a => a.type === 'RESOLVE_INVOKE_CARD_CHOICE')
      .map(a => state.players[HUMAN].mainDeck.find(c => c.instanceId === a.instanceId))
      .filter(Boolean);
  }, [legalActions, state.pendingChoice, state.players]);

  // Candidate named tokens for a pending "create a token, choose one of two"
  // choice (Crathea's own "create a face up Blooming Life token... or a
  // Withering Life token..." — see CREATE_TOKEN_CHOICE_RE, actions.js).
  // Unlike pendingInvokeCardCandidates above, each option is a plain token
  // key string (Crathea's own printed effect names both outcomes directly —
  // there's no deck search here), not a real card to look up.
  const pendingCreateTokenChoiceCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'create-token-choice' || state.pendingChoice.playerId !== HUMAN) return [];
    return legalActions.filter(a => a.type === 'RESOLVE_CREATE_TOKEN_CHOICE').map(a => a.tokenKey);
  }, [legalActions, state.pendingChoice]);

  // Candidate hand cards for a pending "put a card from hand on the bottom
  // of deck" choice (Weaver).
  const pendingBottomOfDeckCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'bottom-of-deck' || state.pendingChoice.playerId !== HUMAN) return [];
    return legalActions
      .filter(a => a.type === 'RESOLVE_BOTTOM_OF_DECK')
      .map(a => state.players[HUMAN].hand.find(c => c.instanceId === a.instanceId))
      .filter(Boolean);
  }, [legalActions, state.pendingChoice, state.players]);

  // Candidate hand cards for a pending "Discard a <Kind>: Draw (N) cards"
  // cost (Scrap Removal) — same shape as pendingBottomOfDeckCandidates above.
  const pendingDiscardKindDrawCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'discard-kind-draw' || state.pendingChoice.playerId !== HUMAN) return [];
    return legalActions
      .filter(a => a.type === 'RESOLVE_DISCARD_KIND_DRAW')
      .map(a => state.players[HUMAN].hand.find(c => c.instanceId === a.instanceId))
      .filter(Boolean);
  }, [legalActions, state.pendingChoice, state.players]);

  // Candidate hand cards for a pending "Discard a <Typing>" cost (Onagīous
  // Hunger's own "Engage: Discard a Hunger, then draw (1) card.") — same
  // shape as pendingDiscardKindDrawCandidates above. This pendingChoice kind
  // (RESOLVE_DISCARD_TYPED, actions.js) previously had no UI at all, so it
  // silently froze the game: the "then draw" half of the effect already ran
  // (the engine-wide "then"-split has no pendingChoice bail-out — documented,
  // shared behavior, not unique to this card), but the player had no way to
  // ever resolve the still-open discard choice blocking every other action.
  const pendingDiscardTypedCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'discard-typed' || state.pendingChoice.playerId !== HUMAN) return [];
    return legalActions
      .filter(a => a.type === 'RESOLVE_DISCARD_TYPED')
      .map(a => state.players[HUMAN].hand.find(c => c.instanceId === a.instanceId))
      .filter(Boolean);
  }, [legalActions, state.pendingChoice, state.players]);

  // Candidate hand cards for a pending "Discard (1) Card" cost (Skeptical
  // Scrawling's own "Discard (1) Card, then return a Null Being From
  // Purgatory to hand.") — same shape as pendingDiscardKindDrawCandidates
  // above. This pendingChoice kind (RESOLVE_DISCARD_ONE_CARD, actions.js)
  // previously had no UI at all either (same latent gap the
  // pendingDiscardTypedCandidates comment above already documents for a
  // different kind) — 1 card in hand auto-resolves with no choice needed,
  // so it was never caught until a 2+-card hand actually needed to pick.
  const pendingDiscardOneCardCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'discard-one-card' || state.pendingChoice.playerId !== HUMAN) return [];
    return legalActions
      .filter(a => a.type === 'RESOLVE_DISCARD_ONE_CARD')
      .map(a => state.players[HUMAN].hand.find(c => c.instanceId === a.instanceId))
      .filter(Boolean);
  }, [legalActions, state.pendingChoice, state.players]);

  // Candidate hand cards for a pending "Discard a card: the next card you
  // play this turn costs (-1) Faithless" cost (Lighten the Load) — same
  // shape as pendingDiscardKindDrawCandidates above.
  const pendingDiscardCostReductionCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'discard-chosen-cost-reduction' || state.pendingChoice.playerId !== HUMAN) return [];
    return legalActions
      .filter(a => a.type === 'RESOLVE_DISCARD_CHOSEN_COST_REDUCTION')
      .map(a => state.players[HUMAN].hand.find(c => c.instanceId === a.instanceId))
      .filter(Boolean);
  }, [legalActions, state.pendingChoice, state.players]);

  // Candidate Armaments (wherever attached) for a pending "sacrifice an
  // Armament" cost (Tiny Forge Master).
  const pendingSacrificeArmamentCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'sacrifice-armament' || state.pendingChoice.playerId !== HUMAN) return [];
    return legalActions
      .filter(a => a.type === 'RESOLVE_SACRIFICE_ARMAMENT')
      .map(a => ({
        cellId: a.cellId,
        armamentInstanceId: a.armamentInstanceId,
        card: state.board[a.cellId]?.armaments?.find(x => x.card.instanceId === a.armamentInstanceId)?.card,
      }))
      .filter(c => c.card);
  }, [legalActions, state.pendingChoice, state.board]);

  // Every matching Purgatory card for a pending "Shuffle up to (N)
  // <Typing>(s) into deck from Purgatory" toggle (Scrap Collector) — the
  // *whole* matching set, not just the currently-togglable subset, so a
  // card already excluded by the "up to N" cap still shows (greyed out)
  // instead of silently vanishing from the list once the cap is hit.
  // Selection state lives on the pendingChoice itself
  // (state.pendingChoice.selected), not local component state, since it's
  // resolved server-side.
  const pendingShufflePurgatoryToggleCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'shuffle-purgatory-toggle' || state.pendingChoice.playerId !== HUMAN) return [];
    return searchZoneCandidates(state.players[HUMAN].purgatory, state.pendingChoice.query);
  }, [state.pendingChoice, state.players]);

  // Candidate Armaments (wherever attached) for a pending "Move target
  // Armament you control..." source choice (Ay-gruhda), Smith Assistant's
  // own "Move an Armament in any direction" source choice, or Sha-KaRah's
  // own "move an adjacent Armament..." source choice — same compound
  // cellId+armamentInstanceId shape as pendingSacrificeArmamentCandidates
  // above, just resolved via whichever of the three
  // RESOLVE_MOVE_*ARMAMENT*_SOURCE action types matches the pendingChoice
  // actually open.
  const pendingMoveArmamentSourceActionType = state.pendingChoice?.kind === 'move-armament-any-source'
    ? 'RESOLVE_MOVE_ARMAMENT_ANY_SOURCE'
    : state.pendingChoice?.kind === 'move-adjacent-armament-source'
    ? 'RESOLVE_MOVE_ADJACENT_ARMAMENT_SOURCE'
    : 'RESOLVE_MOVE_ARMAMENT_SOURCE';
  const pendingMoveArmamentSourceCandidates = useMemo(() => {
    const kind = state.pendingChoice?.kind;
    if ((kind !== 'move-armament-source' && kind !== 'move-armament-any-source' && kind !== 'move-adjacent-armament-source') || state.pendingChoice.playerId !== HUMAN) return [];
    return legalActions
      .filter(a => a.type === pendingMoveArmamentSourceActionType)
      .map(a => ({
        cellId: a.cellId,
        armamentInstanceId: a.armamentInstanceId,
        card: state.board[a.cellId]?.armaments?.find(x => x.card.instanceId === a.armamentInstanceId)?.card,
      }))
      .filter(c => c.card);
  }, [legalActions, state.pendingChoice, state.board, pendingMoveArmamentSourceActionType]);

  // Candidate Armaments (wherever attached) for a pending "Sacrifice an
  // Armament, then deal damage equal to its cost" choice (Scrap Shot) —
  // same compound cellId+armamentInstanceId shape as
  // pendingSacrificeArmamentCandidates above.
  const pendingSacrificeArmamentDamageCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'sacrifice-armament-damage' || state.pendingChoice.playerId !== HUMAN) return [];
    return legalActions
      .filter(a => a.type === 'RESOLVE_SACRIFICE_ARMAMENT_DAMAGE')
      .map(a => ({
        cellId: a.cellId,
        armamentInstanceId: a.armamentInstanceId,
        card: state.board[a.cellId]?.armaments?.find(x => x.card.instanceId === a.armamentInstanceId)?.card,
      }))
      .filter(c => c.card);
  }, [legalActions, state.pendingChoice, state.board]);

  // Candidate Armaments (wherever attached) for a pending "Destroy an
  // Armament" Conjuring effect — same compound cellId+armamentInstanceId
  // shape as pendingSacrificeArmamentCandidates above, so it keeps the same
  // small picker rather than full-board highlighting (a single tile can
  // host more than one destroyable Armament).
  const pendingDestroyArmamentCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'destroy-armament' || state.pendingChoice.playerId !== HUMAN) return [];
    return legalActions
      .filter(a => a.type === 'RESOLVE_DESTROY_ARMAMENT')
      .map(a => ({
        cellId: a.cellId,
        armamentInstanceId: a.armamentInstanceId,
        card: state.board[a.cellId]?.armaments?.find(x => x.card.instanceId === a.armamentInstanceId)?.card,
      }))
      .filter(c => c.card);
  }, [legalActions, state.pendingChoice, state.board]);

  // Desecration's widened "Destroy a Relic." — a freestanding Relic, a
  // Relic-Being, or one specific Relic-Armament entry within a stack/
  // attachment, so (like pendingDestroyArmamentCandidates above) a single
  // tile can host more than one legal target — same small picker instead
  // of full-board highlighting.
  const pendingDestroyRelicCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'destroy-relic-target' || state.pendingChoice.playerId !== HUMAN) return [];
    return legalActions
      .filter(a => a.type === 'RESOLVE_DESTROY_RELIC_TARGET')
      .map(a => ({
        cellId: a.cellId,
        armamentInstanceId: a.armamentInstanceId,
        card: a.armamentInstanceId
          ? state.board[a.cellId]?.armaments?.find(x => x.card.instanceId === a.armamentInstanceId)?.card
          : state.board[a.cellId]?.card,
      }))
      .filter(c => c.card);
  }, [legalActions, state.pendingChoice, state.board]);

  // Antiquities Dealer's "Sacrifice a Relic: Craft (1) Effigy." — same
  // three-shape Relic pool as pendingDestroyRelicCandidates above (plain
  // Relic, Relic-Being, or one Relic-Armament entry), just as a paid cost
  // rather than a plain effect.
  const pendingSacrificeRelicCostCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'sacrifice-relic-cost-target' || state.pendingChoice.playerId !== HUMAN) return [];
    return legalActions
      .filter(a => a.type === 'RESOLVE_SACRIFICE_RELIC_COST_TARGET')
      .map(a => ({
        cellId: a.cellId,
        armamentInstanceId: a.armamentInstanceId,
        card: a.armamentInstanceId
          ? state.board[a.cellId]?.armaments?.find(x => x.card.instanceId === a.armamentInstanceId)?.card
          : state.board[a.cellId]?.card,
      }))
      .filter(c => c.card);
  }, [legalActions, state.pendingChoice, state.board]);

  // Candidate (Prophecy, target Being) pairs for Cro-āsik Hunger's optional
  // "sacrifice a Prophecy, then destroy a non-Deity Being".
  const pendingSacrificeDestroyCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'sacrifice-destroy' || state.pendingChoice.playerId !== HUMAN) return [];
    return legalActions
      .filter(a => a.type === 'RESOLVE_SACRIFICE_DESTROY')
      .map(a => ({
        prophecyCellId: a.prophecyCellId,
        prophecyCard: state.board[a.prophecyCellId]?.card,
        targetCellId: a.targetCellId,
        targetCard: state.board[a.targetCellId]?.card,
      }))
      .filter(c => c.prophecyCard && c.targetCard);
  }, [legalActions, state.pendingChoice, state.board]);

  // Candidate Beings in Purgatory for a pending "Summon a <Typing> Being on
  // this tile from your Purgatory" choice (Grave robber's Martyr).
  const pendingSummonFromPurgatoryCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'summon-from-purgatory' || state.pendingChoice.playerId !== HUMAN) return [];
    const purgatory = state.players[HUMAN].purgatory;
    return legalActions
      .filter(a => a.type === 'RESOLVE_SUMMON_FROM_PURGATORY')
      .map(a => purgatory.find(c => c.instanceId === a.instanceId))
      .filter(Boolean);
  }, [legalActions, state.pendingChoice, state.players]);

  // Candidate Purgatory cards for a pending "Shuffle a <query> into deck
  // from your Purgatory" choice (Melting Clock / Temple of Dubiety) — same
  // shape as pendingSummonFromPurgatoryCandidates above. Canopic Jar's own
  // anyOwner case (its printed text has no "your Purgatory" restriction)
  // can offer a candidate from EITHER player's Purgatory, each action
  // carrying its own explicit `ownerId` (actions.js — instanceId alone
  // can't safely disambiguate which pile it came from), so each candidate
  // here looks itself up in its own owner's Purgatory, not always HUMAN's.
  const pendingShufflePurgatoryCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'shuffle-purgatory-into-deck' || state.pendingChoice.playerId !== HUMAN) return [];
    return legalActions
      .filter(a => a.type === 'RESOLVE_SHUFFLE_PURGATORY_INTO_DECK')
      .map(a => {
        const owner = a.ownerId || HUMAN;
        const card = state.players[owner]?.purgatory.find(c => c.instanceId === a.instanceId);
        return card ? { card, ownerId: a.ownerId } : null;
      })
      .filter(Boolean);
  }, [legalActions, state.pendingChoice, state.players]);

  // Cemetery Physician's own "choose which cost-X Being to summon" step —
  // same shape as pendingSummonFromPurgatoryCandidates above, just a
  // different pendingChoice kind (no fixed cellId — see
  // summonFromPurgatoryToOpenCell, actions.js) and action type.
  const pendingSummonFromPurgatoryCostCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'summon-from-purgatory-cost' || state.pendingChoice.playerId !== HUMAN) return [];
    const purgatory = state.players[HUMAN].purgatory;
    return legalActions
      .filter(a => a.type === 'RESOLVE_SUMMON_FROM_PURGATORY_COST')
      .map(a => purgatory.find(c => c.instanceId === a.instanceId))
      .filter(Boolean);
  }, [legalActions, state.pendingChoice, state.players]);

  // Osteomancer's own "choose which different <Typing> to summon" step —
  // same shape as pendingSummonFromPurgatoryCostCandidates above, just a
  // different pendingChoice kind/action type (filtered by typing + the
  // excluded just-sacrificed name instead of cost).
  const pendingSummonDifferentTypedCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'summon-different-typed-from-purgatory' || state.pendingChoice.playerId !== HUMAN) return [];
    const purgatory = state.players[HUMAN].purgatory;
    return legalActions
      .filter(a => a.type === 'RESOLVE_SUMMON_DIFFERENT_TYPED_FROM_PURGATORY')
      .map(a => purgatory.find(c => c.instanceId === a.instanceId))
      .filter(Boolean);
  }, [legalActions, state.pendingChoice, state.players]);

  // Candidate hand cards for a pending "Discard (X) <Name>: Draw (X)
  // Cards" toggle-then-confirm choice (Deossification) — hand-based, so
  // (unlike TOGGLE_CHOICE_KINDS above) it gets its own small modal with a
  // checkbox per card instead of board-tile highlighting.
  const pendingDiscardXNamedCandidates = useMemo(() => {
    if (!state.pendingChoice || state.pendingChoice.kind !== 'discard-x-named-toggle' || state.pendingChoice.playerId !== HUMAN) return [];
    return legalActions
      .filter(a => a.type === 'RESOLVE_DISCARD_X_NAMED_TOGGLE')
      .map(a => state.players[HUMAN].hand.find(c => c.instanceId === a.instanceId))
      .filter(Boolean);
  }, [legalActions, state.pendingChoice, state.players]);

  // Whether a Decline option should render alongside the pending choice's
  // own modal — every "you may" effect (see actions.js > RESOLVE_DECLINE).
  const pendingChoiceIsOptional = state.pendingChoice?.optional && state.pendingChoice.playerId === HUMAN;

  // Legal ACTIVATE_ARMAMENT_SACRIFICE actions for the expanded stack, keyed
  // by which Armament instance they belong to.
  const expandedArmamentSacrificeActions = useMemo(() => {
    const map = new Map();
    if (!expandedCell) return map;
    legalActions
      .filter(a => a.type === 'ACTIVATE_ARMAMENT_SACRIFICE' && a.cellId === expandedCell)
      .forEach(a => map.set(a.armamentInstanceId, a));
    return map;
  }, [legalActions, expandedCell]);

  // Legal ACTIVATE_ARMAMENT_MARTYR actions for the expanded stack — an
  // attached Armament's OWN "Martyr: X" (Armor Animus/HeartWood Locket),
  // same per-instance keying as the Engage/Sacrifice maps above.
  const expandedArmamentMartyrActions = useMemo(() => {
    const map = new Map();
    if (!expandedCell) return map;
    legalActions
      .filter(a => a.type === 'ACTIVATE_ARMAMENT_MARTYR' && a.cellId === expandedCell)
      .forEach(a => map.set(a.armamentInstanceId, a));
    return map;
  }, [legalActions, expandedCell]);

  if (state.phase === 'mulligan') {
    const human = state.players[HUMAN];
    // Five-point star layout (percent-of-container positions, each card
    // centered on its own point via translate(-50%,-50%)) instead of a
    // plain row — Keep sits in the open center the five points form;
    // Mulligan sits below the whole shape, sharing Keep's own horizontal
    // center (both are centered within the same container) rather than
    // being explicitly coordinated. A true regular pentagon (72° apart,
    // R=260px against a 700×760 container — see the geometry worked out
    // for this) so a card's own footprint (CardTile 'xl' — 192×269px)
    // never overlaps its neighbors.
    const STAR_POSITIONS = [
      { left: '50%', top: '18%' },  // top point
      { left: '85%', top: '41%' },  // upper right
      { left: '72%', top: '80%' },  // lower right
      { left: '28%', top: '80%' },  // lower left
      { left: '15%', top: '41%' },  // upper left
    ];
    // Hovering a point card expands it — full portrait frame, text box
    // included — right in the star's own open center (same spot Keep sits),
    // instead of CardTile's usual near-tile popup, which for a card this
    // small (compact On Board frame, no text box) wouldn't actually show
    // the text at all. Sized to stay clear of the neighboring points.
    const MULLIGAN_PREVIEW_WIDTH = 260;
    const MULLIGAN_PREVIEW_HEIGHT = Math.round(MULLIGAN_PREVIEW_WIDTH * 7 / 5);
    return (
      <div className="min-h-screen flex items-center justify-center bg-black p-8">
        <div className="relative max-w-3xl w-full text-center bg-white rounded-lg shadow p-6">
          {mulliganSecondsLeft !== null && (
            <div className="absolute top-3 right-4 text-sm font-mono tabular-nums text-stone-400">
              {mulliganSecondsLeft}s
            </div>
          )}
          <h2 className="text-lg font-bold text-stone-800 mb-1">Your opening hand</h2>
          <p className="text-sm text-stone-500 mb-2">
            {state.turnPlayer === HUMAN ? 'You go first.' : 'Opponent goes first.'}
          </p>
          <div className="relative mx-auto" style={{ width: 'min(100%, 540px)', aspectRatio: '700 / 760' }}>
            {human.hand.map((card, i) => {
              const pos = STAR_POSITIONS[i] || STAR_POSITIONS[STAR_POSITIONS.length - 1];
              return (
                <div
                  key={card.instanceId}
                  className="absolute"
                  style={{ left: pos.left, top: pos.top, transform: 'translate(-50%, -50%)' }}
                  onMouseEnter={() => setMulliganPreviewCard(card)}
                  onMouseLeave={() => setMulliganPreviewCard(null)}
                >
                  <CardTile
                    card={card}
                    // Nothing is "unplayable" on this screen — it's just a
                    // preview of the dealt hand, not the real game board —
                    // so it's shown fully undimmed (no `dimmed` prop),
                    // same intent the old row layout's playableIds-for-
                    // everything achieved.
                    size="lg"
                    onboard
                    hoverDelayMs={0}
                    disableHoverPreview
                    borderImages={borderImages}
                    borderImagesLoaded={borderImagesLoaded}
                    artImages={artImages}
                    artBorderImages={artBorderImages}
                    artImagesLoaded={artImagesLoaded}
                    fontLoaded={fontLoaded}
                  />
                </div>
              );
            })}
            {!human.keptHand && (
              <button
                onClick={() => dispatch({ type: 'KEEP_HAND', player: HUMAN })}
                className="absolute px-5 py-2.5 bg-stone-800 text-white rounded-full shadow-lg font-semibold text-sm hover:bg-stone-700 transition"
                style={{ left: '50%', top: '52%', transform: 'translate(-50%, -50%)' }}
              >
                Keep
              </button>
            )}
            {mulliganPreviewCard && (
              <div
                className="absolute z-20 pointer-events-none drop-shadow-2xl"
                style={{
                  left: '50%', top: '52%', transform: 'translate(-50%, -50%)',
                  width: MULLIGAN_PREVIEW_WIDTH,
                }}
              >
                <CardThumbnail
                  card={mulliganPreviewCard}
                  borderImages={borderImages}
                  borderImagesLoaded={borderImagesLoaded}
                  artImages={artImages}
                  artBorderImages={artBorderImages}
                  artImagesLoaded={artImagesLoaded}
                  fontLoaded={fontLoaded}
                  width={MULLIGAN_PREVIEW_WIDTH}
                  height={MULLIGAN_PREVIEW_HEIGHT}
                />
              </div>
            )}
          </div>
          {human.keptHand ? (
            <p className="text-sm text-stone-500 mt-2">Waiting on the opponent…</p>
          ) : (
            <button
              onClick={() => { dispatch({ type: 'MULLIGAN', player: HUMAN }); setMulliganCount(c => c + 1); }}
              disabled={human.lifespan - 5 <= 0}
              className="mt-2 px-4 py-2 border border-stone-300 rounded-lg disabled:opacity-30"
            >
              Mulligan (−5 Lifespan)
            </button>
          )}
        </div>
      </div>
    );
  }

  if (state.phase === 'gameover') {
    const elapsed = elapsedMs != null ? formatDuration(elapsedMs) : '—';
    // Boundless Hunger loop declaration (Mouth of Madness + Terranean
    // Gates + Immen Gorta — see placeReturnedFromShift, actions.js): a
    // distinct game-over presentation from a normal Lifespan-exhaustion
    // win, naming the 3 combo pieces and framed from whichever side
    // actually lost it, per the user's own phrasing for the losing side
    // ("Your opponent has presented a loop! You Lose!").
    const humanWonLoop = state.loopWin && state.loopWin.winnerId === HUMAN;
    // The win/lose screen replaces the whole match view outright (this
    // branch short-circuits the return below), so unlike every pendingChoice
    // popup's own "View Board" — which just hides an overlay, since the
    // real board is always still mounted underneath it — there's no board
    // left on screen to reveal here. This instead renders a simple,
    // read-only snapshot of the final board in the result card's place:
    // no highlight/selection state, and both cell-click handlers are no-ops
    // (the match is already over; nothing here is actionable).
    if (showBoardOnGameOver) {
      return (
        <div className="min-h-screen flex flex-col items-center bg-black p-4 gap-3">
          <button
            onClick={() => setShowBoardOnGameOver(false)}
            className="self-start flex items-center gap-1.5 text-xs bg-white/90 border border-stone-300 rounded px-3 py-1.5 shadow hover:bg-white"
          >
            <EyeOff className="w-3.5 h-3.5" />
            Back to Result
          </button>
          <div className="overflow-auto max-w-full">
            <Board
              state={state}
              displayBoard={state.board}
              flashes={{}}
              viewerId={HUMAN}
              highlightCells={new Set()}
              selectedCell={null}
              onCellClick={() => {}}
              borderImages={borderImages}
              borderImagesLoaded={borderImagesLoaded}
              artImages={artImages}
              artBorderImages={artBorderImages}
              artImagesLoaded={artImagesLoaded}
              fontLoaded={fontLoaded}
            />
          </div>
        </div>
      );
    }
    return (
      <div className="min-h-screen flex items-center justify-center bg-black p-8">
        <div className="text-center bg-white rounded-lg shadow p-8 max-w-lg">
          <h2 className="text-2xl font-bold text-stone-800 mb-2">
            {state.loopWin
              ? (humanWonLoop ? 'You have presented a loop! Opponent loses!' : 'Your opponent has presented a loop! You Lose!')
              : (state.winner ? `${state.winner === HUMAN ? 'You win!' : 'The AI wins.'}` : 'Draw.')}
          </h2>
          {state.loopWin && (
            <div className="flex gap-3 justify-center flex-wrap my-4">
              {state.loopWin.cards.map((card) => (
                <CardTile
                  key={card.instanceId || card.name}
                  card={card}
                  size="sm"
                  disableHoverPreview
                  borderImages={borderImages}
                  borderImagesLoaded={borderImagesLoaded}
                  artImages={artImages}
                  artBorderImages={artBorderImages}
                  artImagesLoaded={artImagesLoaded}
                  fontLoaded={fontLoaded}
                />
              ))}
            </div>
          )}
          <p className="text-sm text-stone-500 mb-4">
            {state.turnNumber} turns — {elapsed} played
          </p>
          <div className="flex gap-3 justify-center flex-wrap">
            <button onClick={onExit} className="px-4 py-2 border border-stone-300 rounded-lg">Back to menu</button>
            <button onClick={() => setShowBoardOnGameOver(true)} className="flex items-center gap-1.5 px-4 py-2 border border-stone-300 rounded-lg">
              <Eye className="w-3.5 h-3.5" />
              View Board
            </button>
            {deckEntries && deckEntries.length > 0 && (
              <button onClick={exportDeckList} className="px-4 py-2 border border-stone-300 rounded-lg">Export deck list</button>
            )}
            {onRematch && (
              <button onClick={onRematch} className="px-4 py-2 bg-amber-600 text-white rounded-lg">Rematch</button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-black p-4 flex flex-col gap-3 relative overflow-hidden">
      {/* "View Board" — lets the player peek at the board without losing
          (or resolving) whatever choice popup is currently open. `fixed`
          (not `absolute`) and z-[60] so it stays clickable above every
          popup's own z-50, regardless of which one is showing. */}
      {(state.pendingChoice || pendingPaymentAction) && (
        <button
          onClick={() => setPopupHidden(h => !h)}
          className="fixed top-4 right-4 z-[60] flex items-center gap-1.5 px-3 py-1.5 bg-stone-800 border border-stone-600 text-white rounded-lg text-xs font-semibold shadow-lg hover:bg-stone-700 transition"
        >
          {popupHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          {popupHidden ? 'Show Choice' : 'View Board'}
        </button>
      )}
      {turnBanner && (
        <div
          key={`turn-${turnBanner.seq}`}
          className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none"
        >
          <div className="absolute w-[420px] h-[420px] rounded-full turn-banner-glow" />
          <div className="relative turn-banner-text px-8 py-3 bg-stone-900/85 border-2 border-amber-400 rounded-full shadow-2xl">
            <span className="text-2xl font-extrabold tracking-wide text-amber-300 uppercase">
              {turnBanner.player === HUMAN ? 'Your Turn' : "Opponent's Turn"}
            </span>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={onExit} className="text-sm text-stone-400 hover:text-stone-200">← Menu</button>
          <div className="text-sm text-stone-400 font-mono tabular-nums">{formatDuration(liveElapsedMs)}</div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-sm text-stone-400">Turn {state.turnNumber} — {state.turnPlayer === HUMAN ? 'Your turn' : "AI's turn"}</div>
          <button
            onClick={() => setHistoryOpen(o => !o)}
            className={`flex items-center gap-1 text-xs px-2 py-1 rounded border transition
              ${historyOpen ? 'bg-stone-800 border-stone-600 text-white' : 'border-stone-700 text-stone-400 hover:text-stone-200 hover:border-stone-500'}`}
          >
            <History className="w-3.5 h-3.5" />
            History
          </button>
          <button
            onClick={handleConcede}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-red-900 text-red-400 hover:bg-red-950 hover:text-red-300 transition"
          >
            <Flag className="w-3.5 h-3.5" />
            Concede
          </button>
        </div>
      </div>

      {historyOpen && (
        <div className="absolute top-12 right-4 z-40 w-80">
          <ActionLog entries={historyEntries} />
        </div>
      )}

      {pendingPaymentAction && (() => {
        const pool = state.players[HUMAN].effigyPool;
        const candidates = faithlessPaymentCandidates(pool, pendingPaymentAction.cost);
        const needed = pendingPaymentAction.cost.faithless;
        // Grouped by color ("Timeless(3)") instead of one button per
        // fungible unit — which specific instanceId within a color gets
        // spent never matters, so +/- just grabs/releases any untouched
        // candidate of that color.
        const byColor = new Map();
        candidates.forEach(e => {
          if (!byColor.has(e.effigyType)) byColor.set(e.effigyType, []);
          byColor.get(e.effigyType).push(e);
        });
        const totalSelected = selectedPaymentIds.length;
        const selectedCountFor = (units) => selectedPaymentIds.filter(id => units.some(e => e.instanceId === id)).length;
        const adjust = (units, delta) => {
          setSelectedPaymentIds(prev => {
            if (delta > 0) {
              if (prev.length >= needed) return prev;
              const free = units.find(e => !prev.includes(e.instanceId));
              return free ? [...prev, free.instanceId] : prev;
            }
            const lastIndex = [...prev].reverse().findIndex(id => units.some(e => e.instanceId === id));
            if (lastIndex === -1) return prev;
            const removeAt = prev.length - 1 - lastIndex;
            return [...prev.slice(0, removeAt), ...prev.slice(removeAt + 1)];
          });
        };
        return (
          <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`} onClick={() => setPendingPaymentAction(null)}>
            <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
              <div className="font-semibold text-stone-800 mb-1">
                {pendingPaymentAction.cardName}: choose {needed} Effigy{needed === 1 ? '' : 's'} to spend
              </div>
              <p className="text-xs text-stone-500 mb-3">More than one Effigy color is available for its Faithless cost — use +/- to pick how many of each to spend.</p>
              <div className="overflow-y-auto space-y-1">
                {[...byColor.entries()].map(([color, units]) => {
                  const selectedCount = selectedCountFor(units);
                  const canIncrement = selectedCount < units.length && totalSelected < needed;
                  const canDecrement = selectedCount > 0;
                  return (
                    <div key={color} className="w-full flex items-center gap-2 px-2 py-1.5 rounded border border-stone-200">
                      <button
                        onClick={() => adjust(units, 1)}
                        disabled={!canIncrement}
                        aria-label={`Spend one more ${color} Essence`}
                        className="w-6 h-6 shrink-0 flex items-center justify-center rounded border border-stone-300 text-stone-600 hover:bg-stone-100 disabled:opacity-30 disabled:cursor-not-allowed transition"
                      >
                        +
                      </button>
                      <button
                        onClick={() => adjust(units, -1)}
                        disabled={!canDecrement}
                        aria-label={`Spend one less ${color} Essence`}
                        className="w-6 h-6 shrink-0 flex items-center justify-center rounded border border-stone-300 text-stone-600 hover:bg-stone-100 disabled:opacity-30 disabled:cursor-not-allowed transition"
                      >
                        −
                      </button>
                      <span className={`text-sm font-medium capitalize ${selectedCount > 0 ? 'text-stone-800' : 'text-stone-500'}`}>
                        {color}({units.length}){selectedCount > 0 ? `x${selectedCount}` : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center justify-between mt-3 gap-2">
                <button onClick={() => setPendingPaymentAction(null)} className="text-xs text-stone-400 hover:text-stone-200 transition">
                  Cancel
                </button>
                <button
                  onClick={() => {
                    dispatch({ ...pendingPaymentAction.action, faithlessInstanceIds: selectedPaymentIds });
                    setPendingPaymentAction(null);
                  }}
                  disabled={totalSelected !== needed}
                  className="px-3 py-1.5 bg-amber-700 text-white rounded text-xs font-semibold hover:bg-amber-600 transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Confirm ({totalSelected}/{needed})
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {pendingChoiceCandidates.length > 0 && (() => {
        const zoneLabel = state.pendingChoice.source === 'purgatory' ? 'Purgatory' : 'deck';
        const legalIds = new Set(pendingChoiceCandidates.map(c => c.instanceId));
        const shownCards = searchShowAll ? pendingChoiceAllInZone : pendingChoiceCandidates;
        return (
          <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
            <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col">
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="font-semibold text-stone-800">
                  {state.pendingChoice.cardName}: choose a card
                </div>
                <button
                  onClick={() => setSearchShowAll(v => !v)}
                  className="shrink-0 text-[11px] px-2 py-1 rounded border border-stone-300 text-stone-600 hover:bg-stone-100 transition"
                >
                  {searchShowAll ? 'Show legal targets' : `Show all in ${zoneLabel}`}
                </button>
              </div>
              <p className="text-xs text-stone-500 mb-3">
                Searching your {zoneLabel} for "{state.pendingChoice.query}"
                {searchShowAll ? ' — greyed-out cards don\'t match.' : ' — pick one to add to hand.'}
              </p>
              <div className="overflow-y-auto space-y-1">
                {shownCards.map((card) => {
                  const legal = legalIds.has(card.instanceId);
                  return (
                    <button
                      key={card.instanceId}
                      disabled={!legal}
                      onClick={() => legal && dispatch({ type: 'RESOLVE_CHOICE', instanceId: card.instanceId })}
                      className={`w-full text-left text-sm px-2 py-1.5 rounded border ${
                        legal
                          ? 'border-stone-200 text-stone-700 hover:bg-stone-100 cursor-pointer'
                          : 'border-stone-100 text-stone-300 cursor-not-allowed'
                      }`}
                    >
                      {card.name}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}

      {pendingInvokeCardCandidates.length > 0 && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col">
            <div className="font-semibold text-stone-800 mb-1">
              {state.pendingChoice.cardName}: choose which to invoke
            </div>
            <p className="text-xs text-stone-500 mb-3">Searching your deck for "{state.pendingChoice.query || ''}".</p>
            <div className="overflow-y-auto space-y-1">
              {pendingInvokeCardCandidates.map((card) => (
                <button
                  key={card.instanceId}
                  onClick={() => dispatch({ type: 'RESOLVE_INVOKE_CARD_CHOICE', instanceId: card.instanceId })}
                  className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-stone-100 text-stone-700 border border-stone-200"
                >
                  {card.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {pendingCreateTokenChoiceCandidates.length > 0 && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col">
            <div className="font-semibold text-stone-800 mb-1">
              {state.pendingChoice.cardName}: choose a token to create
            </div>
            <div className="overflow-y-auto space-y-1">
              {pendingCreateTokenChoiceCandidates.map((tokenKey) => (
                <button
                  key={tokenKey}
                  onClick={() => dispatch({ type: 'RESOLVE_CREATE_TOKEN_CHOICE', tokenKey })}
                  className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-stone-100 text-stone-700 border border-stone-200"
                >
                  {tokenKey.replace(/\b\w/g, (c) => c.toUpperCase())}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {state.revealPopup && (
        <RevealPopup
          revealPopup={state.revealPopup}
          dispatch={dispatch}
          cardArtProps={{ borderImages, borderImagesLoaded, artImages, artBorderImages, artImagesLoaded, fontLoaded }}
        />
      )}

      {pendingBottomOfDeckCandidates.length > 0 && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col">
            <div className="font-semibold text-stone-800 mb-1">
              {state.pendingChoice.cardName}: choose a card
            </div>
            <p className="text-xs text-stone-500 mb-3">Pick a card from hand to put on the bottom of your deck.</p>
            <div className="overflow-y-auto space-y-1">
              {pendingBottomOfDeckCandidates.map((card) => (
                <button
                  key={card.instanceId}
                  onClick={() => dispatch({ type: 'RESOLVE_BOTTOM_OF_DECK', instanceId: card.instanceId })}
                  className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-stone-100 text-stone-700 border border-stone-200"
                >
                  {card.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {pendingDiscardKindDrawCandidates.length > 0 && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col">
            <div className="font-semibold text-stone-800 mb-1">
              {state.pendingChoice.cardName}: choose a card to discard
            </div>
            <p className="text-xs text-stone-500 mb-3">Then draw {state.pendingChoice.drawCount} card(s).</p>
            <div className="overflow-y-auto space-y-1">
              {pendingDiscardKindDrawCandidates.map((card) => (
                <button
                  key={card.instanceId}
                  onClick={() => dispatch({ type: 'RESOLVE_DISCARD_KIND_DRAW', instanceId: card.instanceId })}
                  className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-stone-100 text-stone-700 border border-stone-200"
                >
                  {card.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {pendingDiscardTypedCandidates.length > 0 && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col">
            <div className="font-semibold text-stone-800 mb-1">
              {state.pendingChoice.cardName}: choose a {state.pendingChoice.typing} to discard
            </div>
            <div className="overflow-y-auto space-y-1">
              {pendingDiscardTypedCandidates.map((card) => (
                <button
                  key={card.instanceId}
                  onClick={() => dispatch({ type: 'RESOLVE_DISCARD_TYPED', instanceId: card.instanceId })}
                  className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-stone-100 text-stone-700 border border-stone-200"
                >
                  {card.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {pendingDiscardOneCardCandidates.length > 0 && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col">
            <div className="font-semibold text-stone-800 mb-1">
              {state.pendingChoice.cardName}: choose a card to discard
            </div>
            <div className="overflow-y-auto space-y-1">
              {pendingDiscardOneCardCandidates.map((card) => (
                <button
                  key={card.instanceId}
                  onClick={() => dispatch({ type: 'RESOLVE_DISCARD_ONE_CARD', instanceId: card.instanceId })}
                  className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-stone-100 text-stone-700 border border-stone-200"
                >
                  {card.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {pendingDiscardCostReductionCandidates.length > 0 && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col">
            <div className="font-semibold text-stone-800 mb-1">
              {state.pendingChoice.cardName}: choose a card to discard
            </div>
            <p className="text-xs text-stone-500 mb-3">Your next card played this turn costs {state.pendingChoice.amount} less Faithless.</p>
            <div className="overflow-y-auto space-y-1">
              {pendingDiscardCostReductionCandidates.map((card) => (
                <button
                  key={card.instanceId}
                  onClick={() => dispatch({ type: 'RESOLVE_DISCARD_CHOSEN_COST_REDUCTION', instanceId: card.instanceId })}
                  className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-stone-100 text-stone-700 border border-stone-200"
                >
                  {card.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {pendingDiscardXNamedCandidates.length > 0 && (() => {
        const selected = state.pendingChoice.selected;
        return (
          <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
            <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col gap-2">
              <div className="font-semibold text-stone-800 mb-1">
                {state.pendingChoice.cardName}: choose how many {state.pendingChoice.name} to discard
              </div>
              <p className="text-xs text-stone-500 mb-1">Draws that many cards.</p>
              <div className="overflow-y-auto space-y-1">
                {pendingDiscardXNamedCandidates.map((card) => {
                  const isSelected = selected.includes(card.instanceId);
                  return (
                    <button
                      key={card.instanceId}
                      onClick={() => dispatch({ type: 'RESOLVE_DISCARD_X_NAMED_TOGGLE', instanceId: card.instanceId })}
                      className={`w-full flex items-center justify-between gap-2 text-sm px-2 py-1.5 rounded border text-left transition ${
                        isSelected ? 'bg-purple-100 border-purple-400' : 'border-stone-200 hover:bg-stone-50'
                      }`}
                    >
                      <span className="text-stone-700">{card.name}</span>
                      {isSelected && <span className="text-purple-700 font-semibold text-xs shrink-0">selected</span>}
                    </button>
                  );
                })}
              </div>
              <button
                onClick={() => dispatch({ type: 'RESOLVE_DISCARD_X_NAMED_CONFIRM' })}
                className="mt-1 shrink-0 px-3 py-1.5 bg-purple-800 text-white rounded-lg text-xs font-semibold hover:bg-purple-700 transition"
              >
                Confirm ({selected.length})
              </button>
            </div>
          </div>
        );
      })()}

      {state.pendingChoice?.kind === 'shuffle-or-keep' && state.pendingChoice.playerId === HUMAN && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full flex flex-col gap-3">
            <div>
              <div className="font-semibold text-stone-800 mb-1">{state.pendingChoice.cardName}</div>
              <p className="text-xs text-stone-500">You looked at the top card of your deck. Shuffle, or leave it on top?</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => dispatch({ type: 'RESOLVE_SHUFFLE_OR_KEEP', shuffle: true })}
                className="flex-1 px-3 py-1.5 bg-stone-800 text-white rounded-lg text-xs font-semibold hover:bg-stone-700 transition"
              >
                Shuffle
              </button>
              <button
                onClick={() => dispatch({ type: 'RESOLVE_SHUFFLE_OR_KEEP', shuffle: false })}
                className="flex-1 px-3 py-1.5 border border-stone-300 rounded-lg text-xs font-semibold hover:bg-stone-50 transition"
              >
                Keep on top
              </button>
            </div>
          </div>
        </div>
      )}

      {state.pendingChoice?.kind === 'teeth-bounds-tie-choice' && state.pendingChoice.playerId === HUMAN && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full flex flex-col gap-3">
            <div>
              <div className="font-semibold text-stone-800 mb-1">{state.pendingChoice.cardName}</div>
              <p className="text-xs text-stone-500">You control the same number of Beings as your opponent. Choose one:</p>
            </div>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => dispatch({ type: 'RESOLVE_TEETH_BOUNDS_TIE_CHOICE', choice: 'more' })}
                className="px-3 py-1.5 bg-stone-800 text-white rounded-lg text-xs font-semibold hover:bg-stone-700 transition"
              >
                Sacrifice a Hunger, add Immen Gorta from deck to hand
              </button>
              <button
                onClick={() => dispatch({ type: 'RESOLVE_TEETH_BOUNDS_TIE_CHOICE', choice: 'less' })}
                className="px-3 py-1.5 border border-stone-300 rounded-lg text-xs font-semibold hover:bg-stone-50 transition"
              >
                Draw (2) cards
              </button>
            </div>
          </div>
        </div>
      )}

      {NUMERIC_CHOICE_KINDS[state.pendingChoice?.kind] && state.pendingChoice.playerId === HUMAN && (() => {
        const numericChoice = NUMERIC_CHOICE_KINDS[state.pendingChoice.kind];
        const max = state.pendingChoice[numericChoice.max] ?? 0;
        const options = Array.from({ length: max + 1 }, (_, n) => n);
        return (
          <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
            <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full flex flex-col gap-3">
              <p className="text-xs text-stone-500">{numericChoice.prompt(state.pendingChoice)}</p>
              <div className="flex items-center gap-2">
                <select
                  value={numericChoiceValue}
                  onChange={(e) => setNumericChoiceValue(Number(e.target.value))}
                  className="flex-1 border border-stone-300 rounded-lg px-2 py-1.5 text-sm"
                >
                  {options.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <button
                  onClick={() => dispatch({ type: numericChoice.actionType, value: numericChoiceValue })}
                  className="shrink-0 px-3 py-1.5 bg-stone-800 text-white rounded-lg text-xs font-semibold hover:bg-stone-700 transition"
                >
                  Confirm
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {pendingSacrificeArmamentCandidates.length > 0 && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col">
            <div className="font-semibold text-stone-800 mb-1">
              {state.pendingChoice.cardName}: choose an Armament to sacrifice
            </div>
            <p className="text-xs text-stone-500 mb-3">Then draw {state.pendingChoice.drawCount} card(s).</p>
            <div className="overflow-y-auto space-y-1">
              {pendingSacrificeArmamentCandidates.map(({ cellId, armamentInstanceId, card }) => (
                <button
                  key={armamentInstanceId}
                  onClick={() => dispatch({ type: 'RESOLVE_SACRIFICE_ARMAMENT', cellId, armamentInstanceId })}
                  className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-stone-100 text-stone-700 border border-stone-200"
                >
                  {card.name} ({cellId})
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {pendingShufflePurgatoryToggleCandidates.length > 0 && (() => {
        const { selected, maxCount } = state.pendingChoice;
        return (
          <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
            <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col">
              <div className="font-semibold text-stone-800 mb-1">
                {state.pendingChoice.cardName}: choose up to {maxCount} to shuffle in
              </div>
              <p className="text-xs text-stone-500 mb-3">{selected.length}/{maxCount} selected.</p>
              <div className="overflow-y-auto space-y-1">
                {pendingShufflePurgatoryToggleCandidates.map((card) => {
                  const isSelected = selected.includes(card.instanceId);
                  const disabled = !isSelected && selected.length >= maxCount;
                  return (
                    <button
                      key={card.instanceId}
                      disabled={disabled}
                      onClick={() => dispatch({ type: 'RESOLVE_SHUFFLE_PURGATORY_TOGGLE', instanceId: card.instanceId })}
                      className={`w-full text-left text-sm px-2 py-1.5 rounded border flex items-center justify-between transition-colors ${
                        isSelected
                          ? 'border-amber-600 bg-amber-50 text-stone-800'
                          : disabled
                          ? 'border-stone-100 text-stone-300 cursor-not-allowed'
                          : 'border-stone-200 text-stone-700 hover:bg-stone-100'
                      }`}
                    >
                      <span>{card.name}</span>
                      {isSelected && <span className="text-amber-700 text-xs font-semibold">✓</span>}
                    </button>
                  );
                })}
              </div>
              <button
                onClick={() => dispatch({ type: 'RESOLVE_SHUFFLE_PURGATORY_CONFIRM' })}
                className="mt-3 px-3 py-1.5 bg-amber-700 text-white rounded text-xs font-semibold hover:bg-amber-600 transition self-end"
              >
                Confirm ({selected.length})
              </button>
            </div>
          </div>
        );
      })()}

      {pendingMoveArmamentSourceCandidates.length > 0 && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col">
            <div className="font-semibold text-stone-800 mb-1">
              {state.pendingChoice.cardName}: choose an Armament to move
            </div>
            <div className="overflow-y-auto space-y-1">
              {pendingMoveArmamentSourceCandidates.map(({ cellId, armamentInstanceId, card }) => (
                <button
                  key={armamentInstanceId}
                  onClick={() => dispatch({ type: pendingMoveArmamentSourceActionType, cellId, armamentInstanceId })}
                  className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-stone-100 text-stone-700 border border-stone-200"
                >
                  {card.name} ({cellId})
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {pendingSacrificeArmamentDamageCandidates.length > 0 && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col">
            <div className="font-semibold text-stone-800 mb-1">
              {state.pendingChoice.cardName}: choose an Armament to sacrifice
            </div>
            <p className="text-xs text-stone-500 mb-3">Deals damage equal to its total cost to a target.</p>
            <div className="overflow-y-auto space-y-1">
              {pendingSacrificeArmamentDamageCandidates.map(({ cellId, armamentInstanceId, card }) => (
                <button
                  key={armamentInstanceId}
                  onClick={() => dispatch({ type: 'RESOLVE_SACRIFICE_ARMAMENT_DAMAGE', cellId, armamentInstanceId })}
                  className="w-full flex items-center justify-between gap-2 text-sm px-2 py-1.5 rounded border border-stone-200 hover:bg-stone-50 transition text-left"
                >
                  <span className="text-stone-700">{card.name} ({cellId})</span>
                  <span className="text-red-600 font-semibold text-xs shrink-0">-{totalCastingCost(card)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {pendingDestroyArmamentCandidates.length > 0 && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col">
            <div className="font-semibold text-stone-800 mb-1">
              {state.pendingChoice.cardName}: choose an Armament to destroy
            </div>
            <div className="overflow-y-auto space-y-1">
              {pendingDestroyArmamentCandidates.map(({ cellId, armamentInstanceId, card }) => (
                <button
                  key={armamentInstanceId}
                  onClick={() => dispatch({ type: 'RESOLVE_DESTROY_ARMAMENT', cellId, armamentInstanceId })}
                  className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-stone-100 text-stone-700 border border-stone-200"
                >
                  {card.name} ({cellId})
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {pendingDestroyRelicCandidates.length > 0 && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col">
            <div className="font-semibold text-stone-800 mb-1">
              {state.pendingChoice.cardName}: choose a Relic to destroy
            </div>
            <div className="overflow-y-auto space-y-1">
              {pendingDestroyRelicCandidates.map(({ cellId, armamentInstanceId, card }) => (
                <button
                  key={armamentInstanceId || cellId}
                  onClick={() => dispatch({ type: 'RESOLVE_DESTROY_RELIC_TARGET', cellId, armamentInstanceId })}
                  className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-stone-100 text-stone-700 border border-stone-200"
                >
                  {card.name} ({cellId})
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {pendingSacrificeRelicCostCandidates.length > 0 && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col">
            <div className="font-semibold text-stone-800 mb-1">
              {state.pendingChoice.cardName}: choose a Relic to sacrifice
            </div>
            <div className="overflow-y-auto space-y-1">
              {pendingSacrificeRelicCostCandidates.map(({ cellId, armamentInstanceId, card }) => (
                <button
                  key={armamentInstanceId || cellId}
                  onClick={() => dispatch({ type: 'RESOLVE_SACRIFICE_RELIC_COST_TARGET', cellId, armamentInstanceId })}
                  className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-stone-100 text-stone-700 border border-stone-200"
                >
                  {card.name} ({cellId})
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {(pendingSacrificeDestroyCandidates.length > 0 || (pendingChoiceIsOptional && state.pendingChoice.kind === 'sacrifice-destroy')) && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col gap-2">
            <div className="font-semibold text-stone-800 mb-1">
              {state.pendingChoice.cardName}: sacrifice a Prophecy to destroy a Being?
            </div>
            <div className="overflow-y-auto space-y-1">
              {pendingSacrificeDestroyCandidates.map(({ prophecyCellId, prophecyCard, targetCellId, targetCard }) => (
                <button
                  key={`${prophecyCellId}-${targetCellId}`}
                  onClick={() => dispatch({ type: 'RESOLVE_SACRIFICE_DESTROY', prophecyCellId, targetCellId })}
                  className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-stone-100 text-stone-700 border border-stone-200"
                >
                  Sacrifice {prophecyCard.name} &rarr; destroy {targetCard.name}
                </button>
              ))}
            </div>
            <button
              onClick={() => dispatch({ type: 'RESOLVE_DECLINE' })}
              className="text-xs text-stone-500 hover:text-stone-700 mt-1"
            >
              Decline
            </button>
          </div>
        </div>
      )}


      {state.pendingChoice?.kind === 'shuffle-or-draw' && state.pendingChoice.playerId === HUMAN && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full flex flex-col gap-3">
            <div className="font-semibold text-stone-800 mb-1">{state.pendingChoice.cardName}</div>
            <div className="flex gap-2">
              <button
                onClick={() => dispatch({ type: 'RESOLVE_SHUFFLE_OR_DRAW', shuffle: true })}
                className="flex-1 px-3 py-1.5 bg-stone-800 text-white rounded-lg text-xs font-semibold hover:bg-stone-700 transition"
              >
                Shuffle {state.pendingChoice.shuffleCount} from Purgatory
              </button>
              <button
                onClick={() => dispatch({ type: 'RESOLVE_SHUFFLE_OR_DRAW', shuffle: false })}
                className="flex-1 px-3 py-1.5 border border-stone-300 rounded-lg text-xs font-semibold hover:bg-stone-50 transition"
              >
                Draw {state.pendingChoice.drawCount}
              </button>
            </div>
          </div>
        </div>
      )}

      {state.pendingChoice?.kind === 'restore-or-summon-vine' && state.pendingChoice.playerId === HUMAN && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full flex flex-col gap-3">
            <div className="font-semibold text-stone-800 mb-1">{state.pendingChoice.cardName}</div>
            <div className="flex gap-2">
              <button
                onClick={() => dispatch({ type: 'RESOLVE_RESTORE_OR_SUMMON_VINE', choice: 'restore' })}
                className="flex-1 px-3 py-1.5 bg-stone-800 text-white rounded-lg text-xs font-semibold hover:bg-stone-700 transition"
              >
                Restore {state.pendingChoice.restoreAmount} Lifespan
              </button>
              <button
                onClick={() => dispatch({ type: 'RESOLVE_RESTORE_OR_SUMMON_VINE', choice: 'summon' })}
                className="flex-1 px-3 py-1.5 border border-stone-300 rounded-lg text-xs font-semibold hover:bg-stone-50 transition"
              >
                Summon up to {state.pendingChoice.tokenCount} Blooming Vine
              </button>
            </div>
          </div>
        </div>
      )}

      {state.pendingChoice?.kind === 'choose-essence-color' && state.pendingChoice.playerId === HUMAN && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full flex flex-col gap-3">
            <div className="font-semibold text-stone-800 mb-1">
              {state.pendingChoice.cardName}: choose a color of Essence
            </div>
            <div className="grid grid-cols-3 gap-2">
              {EFFIGY_COLORS.map((color) => (
                <button
                  key={color}
                  onClick={() => dispatch({ type: 'RESOLVE_CHOOSE_ESSENCE_COLOR', color })}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition capitalize"
                  style={{ backgroundColor: EFFIGY_TYPE_COLORS[color] }}
                >
                  {color}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {(() => {
        // "You may pay (N) Lifespan to X" (Vassal Matriach) — a tiny
        // non-blocking banner, not a board choice or modal: Pay commits the
        // cost and resolves the effect, Decline (the existing generic
        // optional-choice button, rendered alongside every other kind) just
        // clears it.
        if (state.pendingChoice?.kind !== 'pay-lifespan-optional' || state.pendingChoice.playerId !== HUMAN) return null;
        const affordable = legalActions.some(a => a.type === 'RESOLVE_PAY_LIFESPAN_OPTIONAL');
        return (
          <div className="shrink-0 flex items-center gap-2 bg-stone-900 border border-amber-700 rounded-lg px-3 py-2">
            <span className="text-xs text-stone-300">
              {state.pendingChoice.cardName}: pay {state.pendingChoice.cost} Lifespan to {state.pendingChoice.effectText}
            </span>
            <button
              onClick={() => dispatch({ type: 'RESOLVE_PAY_LIFESPAN_OPTIONAL' })}
              disabled={!affordable}
              className="ml-auto shrink-0 px-3 py-1 bg-amber-800 text-white rounded text-xs font-semibold hover:bg-amber-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Pay {state.pendingChoice.cost}
            </button>
            <button
              onClick={() => dispatch({ type: 'RESOLVE_DECLINE' })}
              className="shrink-0 text-xs text-stone-400 hover:text-stone-200 transition"
            >
              Decline
            </button>
          </div>
        );
      })()}

      {(() => {
        // "You may summon (N) 0/2 Vine tokens on tiles this points to"
        // (Jirahperā) — same tiny non-blocking banner treatment; placement
        // is auto-picked once accepted (see RESOLVE_MAY_SUMMON_VINE_POINTED),
        // so there's no board highlight to show, just Summon/Decline.
        if (state.pendingChoice?.kind !== 'may-summon-vine-pointed' || state.pendingChoice.playerId !== HUMAN) return null;
        const offered = legalActions.some(a => a.type === 'RESOLVE_MAY_SUMMON_VINE_POINTED');
        return (
          <div className="shrink-0 flex items-center gap-2 bg-stone-900 border border-amber-700 rounded-lg px-3 py-2">
            <span className="text-xs text-stone-300">
              {state.pendingChoice.cardName}: summon up to {state.pendingChoice.count} Vine token(s) on tiles it points to?
            </span>
            <button
              onClick={() => dispatch({ type: 'RESOLVE_MAY_SUMMON_VINE_POINTED' })}
              disabled={!offered}
              className="ml-auto shrink-0 px-3 py-1 bg-amber-800 text-white rounded text-xs font-semibold hover:bg-amber-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Summon
            </button>
            <button
              onClick={() => dispatch({ type: 'RESOLVE_DECLINE' })}
              className="shrink-0 text-xs text-stone-400 hover:text-stone-200 transition"
            >
              Decline
            </button>
          </div>
        );
      })()}

      {(() => {
        // "You may sacrifice this and X" (Oracle of Eonia) — same tiny
        // non-blocking banner treatment as pay-lifespan-optional above,
        // just costed by self-sacrifice instead of Lifespan.
        if (state.pendingChoice?.kind !== 'sacrifice-this-optional' || state.pendingChoice.playerId !== HUMAN) return null;
        return (
          <div className="shrink-0 flex items-center gap-2 bg-stone-900 border border-amber-700 rounded-lg px-3 py-2">
            <span className="text-xs text-stone-300">
              {state.pendingChoice.cardName}: sacrifice this and {state.pendingChoice.effectText}
            </span>
            <button
              onClick={() => dispatch({ type: 'RESOLVE_SACRIFICE_THIS_OPTIONAL' })}
              className="ml-auto shrink-0 px-3 py-1 bg-red-800 text-white rounded text-xs font-semibold hover:bg-red-700 transition"
            >
              Sacrifice
            </button>
            <button
              onClick={() => dispatch({ type: 'RESOLVE_DECLINE' })}
              className="shrink-0 text-xs text-stone-400 hover:text-stone-200 transition"
            >
              Decline
            </button>
          </div>
        );
      })()}

      {(() => {
        // Echoes of the Boundless: "...its controller may pay its
        // Summoning cost to Shift (1) instead of sending it to Purgatory."
        // Same tiny non-blocking banner as the other optional choices above
        // — no board target needed (the dying Being is already fixed on
        // the pendingChoice itself), just Shift/Decline.
        if (state.pendingChoice?.kind !== 'echoes-boundless-shift-instead' || state.pendingChoice.playerId !== HUMAN) return null;
        const offered = legalActions.some(a => a.type === 'RESOLVE_ECHOES_BOUNDLESS_SHIFT_INSTEAD');
        return (
          <div className="shrink-0 flex items-center gap-2 bg-stone-900 border border-amber-700 rounded-lg px-3 py-2">
            <span className="text-xs text-stone-300">
              Echoes of the Boundless: pay {state.pendingChoice.dyingCard.name}'s summoning cost to Shift ({state.pendingChoice.amount}) instead of sending it to Purgatory?
            </span>
            <button
              onClick={() => dispatch({ type: 'RESOLVE_ECHOES_BOUNDLESS_SHIFT_INSTEAD' })}
              disabled={!offered}
              className="ml-auto shrink-0 px-3 py-1 bg-amber-800 text-white rounded text-xs font-semibold hover:bg-amber-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Shift
            </button>
            <button
              onClick={() => dispatch({ type: 'RESOLVE_DECLINE' })}
              className="shrink-0 text-xs text-stone-400 hover:text-stone-200 transition"
            >
              Decline
            </button>
          </div>
        );
      })()}

      {pendingShufflePurgatoryCandidates.length > 0 && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col">
            <div className="font-semibold text-stone-800 mb-1">
              {state.pendingChoice.cardName}: choose a card to shuffle into {state.pendingChoice.anyOwner ? "its owner's" : 'your'} deck
            </div>
            <div className="overflow-y-auto space-y-1">
              {pendingShufflePurgatoryCandidates.map(({ card, ownerId }) => (
                <button
                  key={`${ownerId || HUMAN}-${card.instanceId}`}
                  onClick={() => dispatch({ type: 'RESOLVE_SHUFFLE_PURGATORY_INTO_DECK', instanceId: card.instanceId, ...(ownerId ? { ownerId } : {}) })}
                  className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-stone-100 text-stone-700 border border-stone-200"
                >
                  {card.name}{ownerId ? ` (${ownerId === HUMAN ? 'yours' : "opponent's"})` : ''}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {pendingSummonFromPurgatoryCandidates.length > 0 && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col">
            <div className="font-semibold text-stone-800 mb-1">
              {state.pendingChoice.cardName}: choose a Being to summon
            </div>
            <p className="text-xs text-stone-500 mb-3">
              Searching your Purgatory for "{state.pendingChoice.query}" to summon onto the board.
            </p>
            <div className="overflow-y-auto space-y-1">
              {pendingSummonFromPurgatoryCandidates.map((card) => (
                <button
                  key={card.instanceId}
                  onClick={() => dispatch({ type: 'RESOLVE_SUMMON_FROM_PURGATORY', instanceId: card.instanceId })}
                  className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-stone-100 text-stone-700 border border-stone-200"
                >
                  {card.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {pendingSummonFromPurgatoryCostCandidates.length > 0 && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col">
            <div className="font-semibold text-stone-800 mb-1">
              {state.pendingChoice.cardName}: choose a Being to summon
            </div>
            <p className="text-xs text-stone-500 mb-3">
              More than one Being in your Purgatory costs ({state.pendingChoice.cost}) — pick which one.
            </p>
            <div className="overflow-y-auto space-y-1">
              {pendingSummonFromPurgatoryCostCandidates.map((card) => (
                <button
                  key={card.instanceId}
                  onClick={() => dispatch({ type: 'RESOLVE_SUMMON_FROM_PURGATORY_COST', instanceId: card.instanceId })}
                  className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-stone-100 text-stone-700 border border-stone-200"
                >
                  {card.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {pendingSummonDifferentTypedCandidates.length > 0 && (
        <div className={`fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 ${popupHidden ? 'hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col">
            <div className="font-semibold text-stone-800 mb-1">
              {state.pendingChoice.cardName}: choose a different {state.pendingChoice.typing} to summon
            </div>
            <div className="overflow-y-auto space-y-1">
              {pendingSummonDifferentTypedCandidates.map((card) => (
                <button
                  key={card.instanceId}
                  onClick={() => dispatch({ type: 'RESOLVE_SUMMON_DIFFERENT_TYPED_FROM_PURGATORY', instanceId: card.instanceId })}
                  className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-stone-100 text-stone-700 border border-stone-200"
                >
                  {card.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {(expandedOccupant?.armaments?.length > 0 || expandedOccupant?.dryadAttached || expandedGroundRelic) && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setExpandedCell(null)}
        >
          <div
            className="bg-white rounded-lg shadow-2xl p-4 max-w-3xl w-full max-h-[85vh] flex flex-col relative"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setExpandedCell(null)}
              className="absolute top-3 right-3 p-1.5 rounded-full bg-stone-200 hover:bg-stone-300 transition-colors z-10"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="font-semibold text-stone-800 mb-3 pr-8">
              {expandedOccupant
                ? (expandedOccupant.type === 'being' ? expandedOccupant.card.name : 'Armament pile')
                : expandedGroundRelic.card.name} at {expandedCell}
            </div>
            <div className="overflow-auto">
              <div className="flex gap-4 pb-2 w-max">
                {expandedOccupant?.type === 'being' && (
                  <div className="flex flex-col items-center gap-2 shrink-0">
                    <CardTile
                      card={expandedOccupant.card}
                      currentLifespan={expandedOccupant.currentLifespan}
                      strength={effectiveStrength(expandedOccupant)}
                      engaged={expandedOccupant.engaged}
                      size="lg"
                      onClick={() => { setExpandedCell(null); onCellClick(expandedCell); }}
                      borderImages={borderImages}
                      borderImagesLoaded={borderImagesLoaded}
                      artImages={artImages}
                      artBorderImages={artBorderImages}
                      artImagesLoaded={artImagesLoaded}
                      fontLoaded={fontLoaded}
                    />
                    <span className="text-[10px] text-stone-400 uppercase tracking-wide">Click to select</span>
                  </div>
                )}
                {expandedOccupant?.dryadAttached && (
                  <div className="flex flex-col items-center gap-2 shrink-0">
                    <CardTile
                      card={expandedOccupant.dryadAttached.card}
                      currentLifespan={expandedOccupant.dryadAttached.currentLifespan}
                      strength={expandedOccupant.dryadAttached.card.strength}
                      engaged={expandedOccupant.dryadAttached.engaged}
                      size="lg"
                      borderImages={borderImages}
                      borderImagesLoaded={borderImagesLoaded}
                      artImages={artImages}
                      artBorderImages={artBorderImages}
                      artImagesLoaded={artImagesLoaded}
                      fontLoaded={fontLoaded}
                    />
                    <span className="text-[10px] text-stone-400 uppercase tracking-wide">Dryad mount</span>
                  </div>
                )}
                {/* Armaments attached to the Dryad mount ITSELF, not the
                    rider — display-only here (no Engage/Sacrifice/Martyr
                    buttons wired up, unlike the rider's own armaments
                    below): previously silently dropped from this popup
                    entirely. */}
                {expandedOccupant?.dryadAttached?.armaments?.map(({ card, engaged, counters }) => (
                  <div key={card.instanceId} className="flex flex-col items-center gap-2 shrink-0">
                    <CardTile
                      card={card}
                      engaged={engaged}
                      size="lg"
                      borderImages={borderImages}
                      borderImagesLoaded={borderImagesLoaded}
                      artImages={artImages}
                      artBorderImages={artBorderImages}
                      artImagesLoaded={artImagesLoaded}
                      fontLoaded={fontLoaded}
                    />
                    {counters && Object.keys(counters).length > 0 && (
                      <span className="text-[10px] text-stone-500">
                        {Object.entries(counters).map(([type, n]) => `${n} ${type}`).join(', ')} Counter{Object.values(counters).some(n => n !== 1) ? 's' : ''}
                      </span>
                    )}
                    <span className="text-[10px] text-stone-400 uppercase tracking-wide">On the mount</span>
                  </div>
                ))}
                {/* A ground Relic co-located on this same tile (Planchette,
                    Shifting Sands, ...) — lives entirely outside
                    state.board, so it was previously invisible to this
                    popup no matter what else was here. Relics have no
                    Strength/Lifespan of their own to show. */}
                {expandedGroundRelic && (
                  <div className="flex flex-col items-center gap-2 shrink-0">
                    <CardTile
                      card={expandedGroundRelic.card}
                      engaged={expandedGroundRelic.engaged}
                      size="lg"
                      borderImages={borderImages}
                      borderImagesLoaded={borderImagesLoaded}
                      artImages={artImages}
                      artBorderImages={artBorderImages}
                      artImagesLoaded={artImagesLoaded}
                      fontLoaded={fontLoaded}
                    />
                    {expandedGroundRelic.counters && Object.keys(expandedGroundRelic.counters).length > 0 && (
                      <span className="text-[10px] text-stone-500">
                        {Object.entries(expandedGroundRelic.counters).map(([type, n]) => `${n} ${type}`).join(', ')} Counter{Object.values(expandedGroundRelic.counters).some(n => n !== 1) ? 's' : ''}
                      </span>
                    )}
                    <span className="text-[10px] text-stone-400 uppercase tracking-wide">Ground Relic</span>
                  </div>
                )}
                {expandedOccupant?.armaments?.map(({ card, engaged, counters }) => {
                  const engageAction = expandedArmamentEngageActions.get(card.instanceId);
                  const sacrificeAction = expandedArmamentSacrificeActions.get(card.instanceId);
                  const armamentMartyrAction = expandedArmamentMartyrActions.get(card.instanceId);
                  return (
                    <div key={card.instanceId} className="flex flex-col items-center gap-2 shrink-0">
                      <CardTile
                        card={card}
                        engaged={engaged}
                        size="lg"
                        borderImages={borderImages}
                        borderImagesLoaded={borderImagesLoaded}
                        artImages={artImages}
                        artBorderImages={artBorderImages}
                        artImagesLoaded={artImagesLoaded}
                        fontLoaded={fontLoaded}
                      />
                      {counters && Object.keys(counters).length > 0 && (
                        <span className="text-[10px] text-stone-500">
                          {Object.entries(counters).map(([type, n]) => `${n} ${type}`).join(', ')} Counter{Object.values(counters).some(n => n !== 1) ? 's' : ''}
                        </span>
                      )}
                      <div className="flex gap-1.5">
                        {engageAction && (
                          <button
                            onClick={() => dispatch(engageAction)}
                            className="px-3 py-1 bg-amber-700 text-white rounded text-xs font-semibold hover:bg-amber-600 transition"
                          >
                            Engage
                          </button>
                        )}
                        {sacrificeAction && (
                          <button
                            onClick={() => dispatch(sacrificeAction)}
                            className="px-3 py-1 bg-red-800 text-white rounded text-xs font-semibold hover:bg-red-700 transition"
                          >
                            Sacrifice
                          </button>
                        )}
                        {armamentMartyrAction && (
                          <button
                            onClick={() => dispatch(armamentMartyrAction)}
                            className="px-3 py-1 bg-red-800 text-white rounded text-xs font-semibold hover:bg-red-700 transition"
                          >
                            Martyr
                          </button>
                        )}
                      </div>
                      {!engageAction && !sacrificeAction && !armamentMartyrAction && (
                        <span className="text-[10px] text-stone-400 uppercase tracking-wide">
                          {engaged ? 'Engaged' : card.keywords?.engage ? 'Unavailable' : 'No Engage'}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      <div ref={boardAreaRef} className="flex-1 min-h-0 overflow-auto pt-2">
        <div
          className="mx-auto"
          style={{ width: boardNaturalSize.width ? boardNaturalSize.width * boardScale : undefined, height: boardNaturalSize.height ? boardNaturalSize.height * boardScale : undefined }}
        >
          <div
            ref={boardContentRef}
            className="flex items-start gap-1 w-fit"
            style={{ transform: `scale(${boardScale})`, transformOrigin: 'top left' }}
          >
          <div className="flex flex-col gap-1 p-2 w-56">
            <div className={`${ROW_H} flex items-center justify-start gap-2`}>
              <CardPile label="Hand" count={state.players[AI].hand.length} tone="amber" />
              <CardPile label="Deck" count={state.players[AI].mainDeck.length} tone="stone" />
            </div>
            <div className={`${ROW_H} flex items-center justify-start gap-2`}>
              <CardPile
                label="Altars"
                count={state.altars[AI].length}
                clickable={state.altars[AI].length > 0}
                onClick={() => setAltarsOwner(AI)}
                tone="stone"
              />
              <CardPile
                label="Purgatory"
                count={state.players[AI].purgatory.length}
                clickable
                onClick={() => openPurgatory(AI)}
                tone="purple"
              />
            </div>
            <div className={`${ETHEREAL_ROW_H} flex items-center justify-start gap-2`}>
              <div className="w-14 shrink-0" />
              <LifeBadge value={displayLifespans[AI]} flash={lifeFlashes[AI]} strike={openLaneStrikes[AI]} targetAction={playerTargetActionFor(AI)} onSelectTarget={dispatch} />
            </div>
            {/* Portal target for CardTile.jsx's onboard hover preview — this
                column is naturally shorter than the board it sits beside,
                leaving blank space here below the opponent's Life Total.
                `relative` so the portaled preview (`absolute`) positions
                against this div's own top-left corner rather than some
                farther-out ancestor; no height of its own is needed since
                the preview itself is what fills the space. */}
            <div id="onboard-hover-anchor" className="w-full relative" />
          </div>

          <Board
            state={state}
            displayBoard={displayBoard}
            flashes={flashes}
            lastAttack={lastAttack}
            lastMartyr={lastMartyr}
            lastEngageGlow={lastEngageGlow}
            lastModulate={lastModulate}
            vortexCells={vortexCells}
            departCells={departCells}
            deityCells={deityCells}
            viewerId={HUMAN}
            highlightCells={highlightCells}
            selectedCell={selectedCell}
            toggledCells={toggledCells}
            respondingCellId={respondingCellId}
            onCellClick={onCellClick}
            onCellDoubleClick={onCellDoubleClick}
            borderImages={borderImages}
            borderImagesLoaded={borderImagesLoaded}
            artImages={artImages}
            artBorderImages={artBorderImages}
            artImagesLoaded={artImagesLoaded}
            fontLoaded={fontLoaded}
          />

          <div className="flex flex-col gap-1 p-2 w-56">
            <div className={ROW_H} />
            {/* Ability-activation banners (Martyr/Engage/etc.) used to live
                here, floating beside the board. Moved below the board,
                under the human's own front row, in the same full-width
                banner spot the "cast this?" confirmation uses — see
                abilityActionBanners near selectedHandImmediateAction. */}
            <div className="flex-1" />
            <div className={`${ETHEREAL_ROW_H} flex items-center justify-start gap-2`}>
              <LifeBadge value={displayLifespans[HUMAN]} flash={lifeFlashes[HUMAN]} strike={openLaneStrikes[HUMAN]} targetAction={playerTargetActionFor(HUMAN)} onSelectTarget={dispatch} />
            </div>
            <div className={`${ROW_H} flex items-center justify-start gap-2`}>
              <CardPile
                label="Purgatory"
                count={state.players[HUMAN].purgatory.length}
                clickable
                onClick={() => openPurgatory(HUMAN)}
                tone="purple"
                highlight={reanimatablePurgatoryIds.size > 0 || summonWindowPurgatoryIds.size > 0}
              />
              <CardPile
                label="Altars"
                count={state.altars[HUMAN].length}
                clickable={state.altars[HUMAN].length > 0}
                onClick={() => setAltarsOwner(HUMAN)}
                tone="stone"
              />
            </div>
            <div className={`${ROW_H} flex items-center justify-start gap-2`}>
              <CardPile label="Deck" count={state.players[HUMAN].mainDeck.length} tone="stone" />
              <CardPile
                label="Hand"
                count={state.players[HUMAN].hand.length}
                clickable
                onClick={() => setHandViewOpen(true)}
                tone="amber"
              />
              {isHumanTurn && (
                <button
                  onClick={() => dispatch({ type: 'PASS_TURN' })}
                  className="px-3 py-1.5 bg-amber-600 text-white rounded-lg text-xs font-semibold hover:bg-amber-700 transition"
                >
                  Pass turn
                </button>
              )}
            </div>
            {/* Ethereal Conjuring reactive window (actions.js >
                manageReactiveWindow) — a compact notification instead of a
                full-width banner, sitting beside the human's own Deck/Hand
                piles (right next to the board's own Effigy Zone corner,
                r1c5 — board.js). The description line names exactly what
                the opponent just did (reactiveWindow.triggerDescription —
                the same log message that action's own reducer case
                already wrote), so the player knows what they're being
                asked to respond to instead of just seeing a bare "Respond"
                pill. "Respond" itself is just a status pill, not a
                dispatchable action — casting still happens by clicking a
                highlighted card in Hand (onHandSelect's own gate already
                covers this window), same as before. "Pass Priority" is the
                one real button here, dispatching PASS_PRIORITY — a
                genuinely different action from the "Pass turn" button
                above (PASS_TURN, isHumanTurn-gated). */}
            {state.reactiveWindow?.openFor === HUMAN && (
              <div className={`${ROW_H} flex flex-col justify-center gap-1`}>
                {state.reactiveWindow.triggerDescription && (
                  <p className="text-lg font-semibold leading-snug text-stone-200 line-clamp-3">
                    {state.reactiveWindow.triggerDescription}
                  </p>
                )}
                <div className="flex items-center justify-start gap-1.5 flex-wrap">
                  <span className="shrink-0 flex items-center gap-1 px-2 py-1 bg-amber-500 text-stone-900 rounded text-sm font-bold animate-pulse">
                    Respond
                    {competitiveMode && reactiveSecondsLeft !== null && (
                      <span className="tabular-nums">{reactiveSecondsLeft}s</span>
                    )}
                  </span>
                  {/* state.pendingResolution (Medium Mage's own "respond
                      before the trigger lands" case) — this window is about
                      something declared but not yet applied, distinct from
                      the ordinary post-hoc "X already happened" window this
                      banner otherwise always represents. */}
                  {state.pendingResolution && (
                    <span className="shrink-0 px-2 py-1 bg-amber-900/60 text-amber-300 border border-amber-600 rounded text-[10px] font-bold uppercase tracking-wide">
                      Pending
                    </span>
                  )}
                  <button
                    onClick={() => dispatch({ type: 'PASS_PRIORITY' })}
                    className="shrink-0 px-4 py-2 bg-stone-700 text-white rounded text-base font-bold hover:bg-stone-600 transition"
                  >
                    Pass Priority
                  </button>
                </div>
              </div>
            )}
          </div>
          </div>
        </div>
      </div>

      <div className="shrink-0">
        {/* Ethereal Conjuring reactive window (actions.js >
            manageReactiveWindow) — the notification/Pass Priority pair for
            it now lives beside the human's own Deck/Hand piles (see
            reactiveWindowOpenForHuman below), not here. Casting itself
            still reuses the existing hand-select -> "cast this?" confirm
            flow (onHandSelect/selectedHandImmediateAction, above) once
            playableIds picks up the now-legal CAST_CONJURING options. */}
        {/* Ability-activation banners (Martyr/Engage/a bare activated
            ability) for the selected Being/Relic — positioned here, under
            the human's own front row and above the Hand, the same
            full-width spot the "cast this?" confirmation below uses,
            rather than floating in a narrow column beside the board. */}
        {(() => {
          // Board-native choice, not a modal — the legal tiles themselves are
          // highlighted (see highlightCells) and clicking one resolves it
          // directly (see onCellClick), the same interaction as placing a
          // hand card. This banner is just a non-blocking reminder of what's
          // being chosen, shared by every SINGLE_CELL_CHOICE_KINDS kind.
          // Lives in this same full-width "activation banner" spot as
          // Martyr/Engage/etc. below, rather than floating above the board.
          if (!state.pendingChoice || state.pendingChoice.playerId !== HUMAN) return null;
          if (!SINGLE_CELL_CHOICE_KINDS[state.pendingChoice.kind]) return null;
          return (
            <div className="flex items-center gap-2 bg-stone-900 border border-amber-700 rounded-lg px-3 py-2 mb-1">
              <span className="text-xs text-stone-300">
                {singleCellChoiceLabel(state.pendingChoice)}
                {/* "any target" (unlike a typed/Being-only "target Being")
                    also includes either player's own Lifespan directly — not
                    a board cell, so it's chosen by clicking the highlighted
                    LifeBadge itself (below) rather than a tile here. */}
                {playerTargetActions.length > 0 ? ' — including either player\'s own Lifespan total.' : ''}
              </span>
              {state.pendingChoice.kind === 'diablerie-select-mover' && (
                <button
                  onClick={() => dispatch({ type: 'RESOLVE_DIABLERIE_DONE' })}
                  className="ml-auto shrink-0 px-2 py-1 bg-stone-700 text-white rounded text-xs font-semibold hover:bg-stone-600 transition"
                >
                  Done
                </button>
              )}
              {pendingChoiceIsOptional && (
                <button
                  onClick={() => dispatch({ type: 'RESOLVE_DECLINE' })}
                  className="ml-auto shrink-0 text-xs text-stone-400 hover:text-stone-200 transition"
                >
                  Decline
                </button>
              )}
            </div>
          );
        })()}
        {(() => {
          // Collapsing Bridge's own "you may summon a Being on a tile this
          // points to" — a hand-card-then-cell choice (RESOLVE_SUMMON_HAND_
          // BEING_POINTED is in CELL_TARGET_TYPES, so selecting a Hand
          // Being and clicking a highlighted tile resolves it directly,
          // same as a normal SUMMON_BEING), just with no pendingChoice
          // banner of its own before this — left the player with no way to
          // even see the choice was open, let alone decline it.
          if (state.pendingChoice?.kind !== 'summon-hand-being-pointed' || state.pendingChoice.playerId !== HUMAN) return null;
          return (
            <div className="flex items-center gap-2 bg-stone-900 border border-amber-700 rounded-lg px-3 py-2 mb-1">
              <span className="text-xs text-stone-300">
                {state.pendingChoice.cardName}: select a Being in Hand, then a highlighted tile to summon it on.
              </span>
              {pendingChoiceIsOptional && (
                <button
                  onClick={() => dispatch({ type: 'RESOLVE_DECLINE' })}
                  className="ml-auto shrink-0 text-xs text-stone-400 hover:text-stone-200 transition"
                >
                  Decline
                </button>
              )}
            </div>
          );
        })()}
        {(() => {
          const toggleChoice = state.pendingChoice?.playerId === HUMAN ? TOGGLE_CHOICE_KINDS[state.pendingChoice.kind] : null;
          if (!toggleChoice) return null;
          const selected = state.pendingChoice.selected.length;
          const confirmable = legalActions.some(a => a.type === toggleChoice.confirmActionType);
          const prompt = state.pendingChoice.kind === 'sacrifice-x-toggle'
            ? `click highlighted ${state.pendingChoice.fodderName} tiles to choose how many to sacrifice`
            : state.pendingChoice.kind === 'summon-vine-tokens-toggle'
            ? `click highlighted tiles to choose up to ${state.pendingChoice.maxCount} to summon ${state.pendingChoice.tokenName || 'Blooming Vine'} token(s) on`
            : 'click highlighted Beings to choose how many to sacrifice';
          return (
            <div className="flex items-center gap-2 bg-stone-900 border border-purple-700 rounded-lg px-3 py-2 mb-1">
              <span className="text-xs text-stone-300">
                {state.pendingChoice.cardName}: {prompt} — {selected} selected.
              </span>
              {state.pendingChoice.optional && (
                <button
                  onClick={() => dispatch({ type: 'RESOLVE_DECLINE' })}
                  className="ml-auto shrink-0 text-xs text-stone-400 hover:text-stone-200 transition"
                >
                  Cancel
                </button>
              )}
              <button
                onClick={() => dispatch({ type: toggleChoice.confirmActionType })}
                disabled={!confirmable}
                className={`${state.pendingChoice.optional ? '' : 'ml-auto'} shrink-0 px-3 py-1 bg-purple-800 text-white rounded text-xs font-semibold hover:bg-purple-700 transition disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                Confirm ({selected})
              </button>
            </div>
          );
        })()}
        {(() => {
          // Board-native, like the SINGLE_CELL_CHOICE_KINDS banner above — the
          // legal Time Counter holders light up on the board (highlightCells)
          // and clicking one resolves it directly (onCellClick) when only one
          // delta is legal there. A "±" effect (both +1 and -1 legal on the
          // same cell) can't be disambiguated by a plain click, so clicking it
          // instead opens this tiny inline +/- prompt for just that one cell,
          // rather than falling back to a full-screen list of every candidate.
          if (state.pendingChoice?.kind !== 'modulate' || state.pendingChoice.playerId !== HUMAN) return null;
          const cellCandidates = pendingModulateCandidates.find(c => c.cellId === modulateDeltaCell);
          return (
            <div className="flex flex-wrap items-center gap-2 bg-stone-900 border border-amber-700 rounded-lg px-3 py-2 mb-1">
              <span className="text-xs text-stone-300">
                {state.pendingChoice.cardName}: choose a highlighted Time Counter to Modulate.
              </span>
              {/* Orbital Acceleration: "You may Modulate (-1)." — a genuinely
                  optional Modulate (pendingChoice.optional, same generic flag
                  every other optional choice uses) had no way to skip it here,
                  unlike its sibling banners just above (summon-hand-being-
                  pointed, the toggle-choice kinds), which both already check
                  this and render their own Decline/Cancel button. */}
              {state.pendingChoice.optional && (
                <button
                  onClick={() => dispatch({ type: 'RESOLVE_DECLINE' })}
                  className="ml-auto shrink-0 text-xs text-stone-400 hover:text-stone-200 transition"
                >
                  Decline
                </button>
              )}
              {cellCandidates && (
                <div className="flex gap-1 shrink-0 ml-auto">
                  <span className="text-xs text-stone-400 self-center">{cellCandidates.card?.name || modulateDeltaCell}:</span>
                  {cellCandidates.deltas.map(delta => (
                    <button
                      key={delta}
                      onClick={() => {
                        dispatch({ type: 'RESOLVE_MODULATE', cellId: modulateDeltaCell, delta });
                        setModulateDeltaCell(null);
                      }}
                      className="px-2 py-1 rounded bg-stone-800 text-white text-xs font-semibold hover:bg-stone-700 transition"
                    >
                      {delta > 0 ? `+${delta}` : delta}
                    </button>
                  ))}
                </div>
              )}
              {/* Altars aren't board tiles, so they can't be clicked to
                  select the way cellCandidates above are — listed here as
                  their own always-visible row instead. */}
              {pendingModulateAltarCandidates.map(ac => (
                <div key={ac.altarInstanceId} className="flex gap-1 shrink-0 ml-auto">
                  <span className="text-xs text-stone-400 self-center">{ac.card?.name || 'Altar'}:</span>
                  {ac.deltas.map(delta => (
                    <button
                      key={delta}
                      onClick={() => dispatch({ type: 'RESOLVE_MODULATE', altarInstanceId: ac.altarInstanceId, delta })}
                      className="px-2 py-1 rounded bg-stone-800 text-white text-xs font-semibold hover:bg-stone-700 transition"
                    >
                      {delta > 0 ? `+${delta}` : delta}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          );
        })()}
        {martyrAction && (
          <div className="flex items-center gap-2 bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 mb-1">
            <span className="text-xs text-stone-300">
              {state.board[selectedCell].card.name}: Engage and sacrifice for Martyr
              {state.board[selectedCell].card.keywords.martyr ? ` — "${state.board[selectedCell].card.keywords.martyr}"` : ''}
            </span>
            <button
              onClick={() => { dispatch(martyrAction); setSelectedCell(null); }}
              className="ml-auto shrink-0 px-3 py-1 bg-red-800 text-white rounded text-xs font-semibold hover:bg-red-700 transition"
            >
              Martyr
            </button>
          </div>
        )}
        {shiftAction && (
          <div className="flex items-center gap-2 bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 mb-1">
            <span className="text-xs text-stone-300">
              {state.board[selectedCell].card.name}: Shift — engage and move onto the Ethereal Realm as a Prophecy
            </span>
            <button
              onClick={() => { dispatch(shiftAction); setSelectedCell(null); }}
              className="ml-auto shrink-0 px-3 py-1 bg-indigo-800 text-white rounded text-xs font-semibold hover:bg-indigo-700 transition"
            >
              Shift
            </button>
          </div>
        )}
        {engageActions.length > 0 && (() => {
          // The selected cell can carry an Engage-able board occupant (a
          // Being/Relic/animated Armament pile) AND, independently, a
          // ground Relic living outside `board` entirely (RULES.md >
          // Keywords > "Beings may move across this" — Claws of Onoushara
          // stacked under a Being is exactly this case), each with its own
          // ACTIVATE_ENGAGE/ACTIVATE_GROUND_RELIC_ENGAGE entry in
          // engageActions. Resolved per-action rather than once for the
          // whole block, so Claws' own name/text never gets shadowed by
          // whatever Being happens to share its tile.
          return (
            <div className="flex flex-col gap-1 bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 mb-1">
              {engageActions.map((action) => {
                const cardOccupant = action.type === 'ACTIVATE_GROUND_RELIC_ENGAGE'
                  ? state.groundRelics[selectedCell]
                  : state.board[selectedCell];
                const ownAbilities = cardOccupant.card.keywords?.engageAbilities || [];
                const effectText = action.abilityIndex != null && ownAbilities[action.abilityIndex]
                  ? ownAbilities[action.abilityIndex].effect
                  : action.type === 'ACTIVATE_GROUND_RELIC_ENGAGE'
                    ? cardOccupant.card.keywords?.engage
                    : effectiveEngage(cardOccupant);
                return (
                  <div key={`${action.type}-${action.abilityIndex ?? 0}`} className="flex items-center gap-2">
                    <span className="text-xs text-stone-300">
                      {cardOccupant.card.name}: Engage — "{effectText}"
                    </span>
                    <button
                      onClick={() => { dispatch(action); setSelectedCell(null); }}
                      className="ml-auto shrink-0 px-3 py-1 bg-amber-700 text-white rounded text-xs font-semibold hover:bg-amber-600 transition"
                    >
                      Engage
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })()}
        {sacrificeXAction && (
          <div className="flex items-center gap-2 bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 mb-1">
            <span className="text-xs text-stone-300">
              {state.board[selectedCell].card.name}: sacrifice any number of {state.board[selectedCell].card.keywords.sacrificeXSummon.fodderName} to summon a Being from Purgatory with that cost.
            </span>
            <button
              onClick={() => { dispatch(sacrificeXAction); setSelectedCell(null); }}
              className="ml-auto shrink-0 px-3 py-1 bg-purple-800 text-white rounded text-xs font-semibold hover:bg-purple-700 transition"
            >
              Sacrifice
            </button>
          </div>
        )}
        {engageGrantCounterAction && (
          <div className="flex items-center gap-2 bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 mb-1">
            <span className="text-xs text-stone-300">
              {state.board[selectedCell].card.name}: Engage a Being you control, gain {state.board[selectedCell].card.keywords.engageBeingGrantCounter.amount} {state.board[selectedCell].card.keywords.engageBeingGrantCounter.counterType} Counter(s).
            </span>
            <button
              onClick={() => { dispatch(engageGrantCounterAction); setSelectedCell(null); }}
              className="ml-auto shrink-0 px-3 py-1 bg-amber-700 text-white rounded text-xs font-semibold hover:bg-amber-600 transition"
            >
              Engage
            </button>
          </div>
        )}
        {removeCountersXSearchArmamentAction && (
          <div className="flex items-center gap-2 bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 mb-1">
            <span className="text-xs text-stone-300">
              {state.board[selectedCell].card.name}: Engage, remove any number of {state.board[selectedCell].card.keywords.removeCountersXSearchArmament.counterType} Counters — add an Armament costing that much from deck to hand.
            </span>
            <button
              onClick={() => { dispatch(removeCountersXSearchArmamentAction); setSelectedCell(null); }}
              className="ml-auto shrink-0 px-3 py-1 bg-amber-700 text-white rounded text-xs font-semibold hover:bg-amber-600 transition"
            >
              Engage
            </button>
          </div>
        )}
        {timesPerTurnAction && (() => {
          const cardOccupant = state.board[selectedCell];
          const ability = cardOccupant.card.keywords.timesPerTurnAbility;
          const used = cardOccupant.timesPerTurnUsed || 0;
          return (
            <div className="flex items-center gap-2 bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 mb-1">
              <span className="text-xs text-stone-300">
                {cardOccupant.card.name}: {ability.effect} ({used}/{ability.times} used this turn)
              </span>
              <button
                onClick={() => dispatch(timesPerTurnAction)}
                className="ml-auto shrink-0 px-3 py-1 bg-amber-700 text-white rounded text-xs font-semibold hover:bg-amber-600 transition"
              >
                Activate
              </button>
            </div>
          );
        })()}
        {payEffigyCostAction && (() => {
          const cardOccupant = state.board[selectedCell];
          const ability = cardOccupant.card.keywords.payEffigyCostAbility;
          return (
            <div className="flex items-center gap-2 bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 mb-1">
              <span className="text-xs text-stone-300">
                {cardOccupant.card.name}: Pay ({ability.amount}) {ability.color} — {ability.effect}
              </span>
              <button
                onClick={() => dispatch(payEffigyCostAction)}
                className="ml-auto shrink-0 px-3 py-1 bg-amber-700 text-white rounded text-xs font-semibold hover:bg-amber-600 transition"
              >
                Activate
              </button>
            </div>
          );
        })()}
        {payLifespanCostAction && (() => {
          const cardOccupant = state.board[selectedCell];
          const ability = cardOccupant.card.keywords.payLifespanCostAbility;
          return (
            <div className="flex items-center gap-2 bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 mb-1">
              <span className="text-xs text-stone-300">
                {cardOccupant.card.name}: Pay ({ability.amount}) Lifespan — {ability.effect}
              </span>
              <button
                onClick={() => dispatch(payLifespanCostAction)}
                className="ml-auto shrink-0 px-3 py-1 bg-amber-700 text-white rounded text-xs font-semibold hover:bg-amber-600 transition"
              >
                Activate
              </button>
            </div>
          );
        })()}
        {counterCostSacrificeAction && (() => {
          const cardOccupant = state.board[selectedCell];
          const ability = cardOccupant.card.keywords.counterCostSacrificeAbility;
          return (
            <div className="flex items-center gap-2 bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 mb-1">
              <span className="text-xs text-stone-300">
                {cardOccupant.card.name}: Remove ({ability.amount}) {ability.type} Counter — Sacrifice this, {ability.effect}
              </span>
              <button
                onClick={() => { dispatch(counterCostSacrificeAction); setSelectedCell(null); }}
                className="ml-auto shrink-0 px-3 py-1 bg-red-800 text-white rounded text-xs font-semibold hover:bg-red-700 transition"
              >
                Sacrifice
              </button>
            </div>
          );
        })()}
        {removeCountersSacrificeSearchActions.length > 0 && (() => {
          const cardOccupant = state.board[selectedCell];
          const ability = cardOccupant.card.keywords.removeCountersSacrificeSearchTypedCost;
          return (
            <div className="flex items-center gap-2 bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 mb-1">
              <span className="text-xs text-stone-300">
                {cardOccupant.card.name}: Remove (X) {ability.counterType} Counters — Sacrifice this Relic, add a {ability.typing} Being with cost (X) from Purgatory to hand.
              </span>
              <div className="flex gap-1 shrink-0 ml-auto">
                {removeCountersSacrificeSearchActions.map(action => (
                  <button
                    key={action.amount}
                    onClick={() => { dispatch(action); setSelectedCell(null); }}
                    className="px-2 py-1 rounded bg-red-800 text-white text-xs font-semibold hover:bg-red-700 transition"
                  >
                    X={action.amount}
                  </button>
                ))}
              </div>
            </div>
          );
        })()}
        {selectedHandImmediateAction && (() => {
          const card = state.players[HUMAN].hand.find(c => c.instanceId === selectedHand);
          return (
            <div className="flex items-center gap-2 bg-stone-900 border border-amber-700 rounded-lg px-3 py-2 mb-1">
              <span className="text-xs text-stone-300">
                {card.name}{card.textBox ? `: "${card.textBox}"` : ''} — cast this?
              </span>
              <button
                onClick={() => { dispatchWithPaymentCheck(selectedHandImmediateAction, card); setSelectedHand(null); }}
                className="ml-auto shrink-0 px-3 py-1 bg-amber-700 text-white rounded text-xs font-semibold hover:bg-amber-600 transition"
              >
                {selectedHandImmediateAction.type === 'PLACE_ALTAR' ? 'Conjure' : 'Cast'}
              </button>
              <button
                onClick={() => setSelectedHand(null)}
                aria-label="Cancel"
                className="shrink-0 p-1 rounded text-stone-400 hover:text-white hover:bg-stone-800 transition"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })()}
        <button
          onClick={() => setHandMinimized(m => !m)}
          className="flex items-center gap-1 text-xs text-stone-300 uppercase tracking-wide mb-1 hover:text-white transition"
        >
          {handMinimized ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          Hand
        </button>
        {!handMinimized && (
          <Hand
            cards={state.players[HUMAN].hand}
            playableIds={playableIds}
            selectedInstanceId={selectedHand}
            onSelect={onHandSelect}
            borderImages={borderImages}
            borderImagesLoaded={borderImagesLoaded}
            artImages={artImages}
            artBorderImages={artBorderImages}
            artImagesLoaded={artImagesLoaded}
            fontLoaded={fontLoaded}
            cardSize="lg"
            justDrawnIds={justDrawnIds}
          />
        )}
      </div>

      {handViewOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setHandViewOpen(false)}
        >
          <div
            className="bg-white rounded-lg shadow-2xl p-4 max-w-4xl w-full max-h-[85vh] flex flex-col relative"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setHandViewOpen(false)}
              className="absolute top-3 right-3 p-1.5 rounded-full bg-stone-200 hover:bg-stone-300 transition-colors z-10"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="font-semibold text-stone-800 mb-3 pr-8">Your Hand ({state.players[HUMAN].hand.length})</div>
            <div className="overflow-auto">
              <Hand
                cards={state.players[HUMAN].hand}
                playableIds={playableIds}
                selectedInstanceId={selectedHand}
                onSelect={(instanceId) => { onHandSelect(instanceId); setHandViewOpen(false); }}
                borderImages={borderImages}
                borderImagesLoaded={borderImagesLoaded}
                artImages={artImages}
                artBorderImages={artBorderImages}
                artImagesLoaded={artImagesLoaded}
                fontLoaded={fontLoaded}
                cardSize="lg"
                stack={false}
                justDrawnIds={justDrawnIds}
              />
            </div>
          </div>
        </div>
      )}

      {altarsOwner && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setAltarsOwner(null)}
        >
          <div
            className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col relative"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setAltarsOwner(null)}
              className="absolute top-3 right-3 p-1.5 rounded-full bg-stone-200 hover:bg-stone-300 transition-colors z-10"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="font-semibold text-stone-800 mb-3 pr-8">
              {altarsOwner === HUMAN ? 'Your' : "Opponent's"} Altars ({state.altars[altarsOwner].length})
            </div>
            <div className="overflow-y-auto flex flex-wrap gap-3">
              {state.altars[altarsOwner].map(({ card, counters }, i) => (
                <div key={`${card.instanceId}-${i}`} className="flex flex-col items-center gap-1 shrink-0">
                  <div className="relative">
                    <CardTile
                      card={card} size="sm"
                      borderImages={borderImages} borderImagesLoaded={borderImagesLoaded}
                      artImages={artImages} artBorderImages={artBorderImages} artImagesLoaded={artImagesLoaded}
                      fontLoaded={fontLoaded}
                    />
                    {Object.entries(counters || {}).filter(([, n]) => n > 0).length > 0 && (
                      <div className="absolute -bottom-1 -right-1 z-10 flex gap-0.5">
                        {Object.entries(counters).filter(([, n]) => n > 0).map(([type, n]) => (
                          <span
                            key={type}
                            className="flex items-center justify-center min-w-[16px] h-4 px-0.5 rounded-full bg-stone-800 text-white text-[9px] font-bold border border-white shadow"
                            title={`${n} ${type[0].toUpperCase()}${type.slice(1)} Counter${n === 1 ? '' : 's'}`}
                          >
                            {type[0].toUpperCase()}{n}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {card.keywords?.craftBonus > 0 && (
                    <span className="text-[10px] text-stone-500">
                      Craft +{card.keywords.craftBonus}
                      {card.keywords.craftBonusCondition === 'faithless-only' ? ' (Faithless only)' : ''}
                      {card.keywords.craftBonusCondition === 'zero-time-counters' ? ' (at 0 Time Counters)' : ''}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {purgatoryOwner && purgatoryPreviewIndex === null && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={closePurgatory}
        >
          <div
            className="bg-white rounded-lg shadow-2xl p-4 max-w-sm w-full max-h-[75vh] flex flex-col relative"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={closePurgatory}
              className="absolute top-3 right-3 p-1.5 rounded-full bg-stone-200 hover:bg-stone-300 transition-colors z-10"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="font-semibold text-stone-800 mb-3 pr-8">
              {purgatoryOwner === HUMAN ? 'Your' : "Opponent's"} Purgatory ({purgatoryCards.length})
            </div>
            <div className="overflow-y-auto space-y-1">
              {purgatoryCards.length === 0 && (
                <div className="text-sm text-stone-400 italic">Empty.</div>
              )}
              {purgatoryGroups.map((group) => {
                // Roots of Eternity: an activatable entry (this owner is
                // the human, and its own ability has a legal target right
                // now) is highlighted and, unlike every other entry, a
                // click activates its ability directly instead of opening
                // the normal name/preview view — "the same way you would
                // activate a regular ability" (a board-native choice), see
                // reanimatingPurgatoryId/reanimateSacrificeCandidates above.
                const reanimatable = purgatoryOwner === HUMAN && reanimatablePurgatoryIds.has(group.instanceId);
                const summonable = purgatoryOwner === HUMAN && summonWindowPurgatoryIds.has(group.instanceId);
                const activatable = reanimatable || summonable;
                return (
                  <button
                    key={group.name}
                    onClick={() => {
                      if (reanimatable) {
                        setReanimatingPurgatoryId(group.instanceId);
                        closePurgatory();
                      } else if (summonable) {
                        dispatch({ type: 'ACTIVATE_SUMMON_TYPED_FROM_PURGATORY_WINDOW', instanceId: group.instanceId });
                        closePurgatory();
                      } else {
                        setPurgatoryPreviewIndex(group.firstIndex);
                      }
                    }}
                    className={`w-full flex items-center justify-between text-left text-sm px-2 py-1.5 rounded transition
                      ${activatable
                        ? 'bg-amber-100 text-amber-900 font-semibold ring-1 ring-amber-400 hover:bg-amber-200'
                        : 'hover:bg-stone-100 text-stone-700'}`}
                  >
                    <span>{group.name}{activatable ? ' — Activate' : ''}</span>
                    {group.count > 1 && (
                      <span className="text-xs text-stone-400 font-semibold">x{group.count}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {purgatoryOwner && purgatoryPreviewIndex !== null && purgatoryCards[purgatoryPreviewIndex] && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setPurgatoryPreviewIndex(null)}
        >
          <div
            className="bg-white rounded-lg shadow-2xl p-4 max-w-lg w-full relative"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setPurgatoryPreviewIndex(null)}
              className="absolute top-3 right-3 p-1.5 rounded-full bg-stone-200 hover:bg-stone-300 transition-colors z-10"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="text-center font-semibold text-stone-800 mb-3 pr-8">
              {purgatoryCards[purgatoryPreviewIndex].name}
            </div>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => setPurgatoryPreviewIndex(i => Math.max(0, i - 1))}
                disabled={purgatoryPreviewIndex === 0}
                className="p-2.5 rounded-full bg-stone-200 hover:bg-stone-300 disabled:opacity-30 disabled:hover:bg-stone-200 transition-colors shrink-0"
                aria-label="Previous card"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <canvas
                ref={previewCanvasRef}
                className="max-w-full max-h-[65vh] w-auto h-auto border border-stone-300 mx-auto block"
              />
              <button
                onClick={() => setPurgatoryPreviewIndex(i => Math.min(purgatoryCards.length - 1, i + 1))}
                disabled={purgatoryPreviewIndex === purgatoryCards.length - 1}
                className="p-2.5 rounded-full bg-stone-200 hover:bg-stone-300 disabled:opacity-30 disabled:hover:bg-stone-200 transition-colors shrink-0"
                aria-label="Next card"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
