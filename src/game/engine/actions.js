import { cellId, parseCellId, ROWS, COLS, ETHEREAL_ROW, SUMMON_CELLS, mortalCellsFor, isMortalRealm, opponentOf, computeMoveDestination, computeAttackCell, owningPlayerOfRow } from './board.js';
import { STARTING_LIFESPAN } from './constants.js';
import { STARTING_HAND_SIZE, MULLIGAN_COST, drawCard } from './deck.js';
import { addLog, beginTurn, endTurn, checkWin, controlsOnlyFaithlessPermanents, triggerZealotProphecyEssence, triggerHourglassCollection, resolveEndOfTurnDamageNamedFamilyQueue } from './turn.js';
import { resolveMutualCombat, deathDamageFor, effectiveStrength } from './combat.js';
import { stripFlavorText, EFFIGY_COLORS, makeTemporaryEssence, totalCastingCost, createTokenCard, isFaithlessTypedCard, parseKeywords } from '../../lib/cardData.js';

const ETHEREAL_CELLS = [1, 2, 3, 4, 5].map(col => cellId(ETHEREAL_ROW, col));

// A token (card.isToken — RULES.md > Tokens) has no real card behind it, so
// whenever it would enter Purgatory it simply ceases to exist instead —
// same as a real card leaving the game outright, not changing zones. Used
// everywhere a card is added to a player's purgatory array, so a token
// dying, being discarded, or being destroyed never lingers in the zone.
const purgatoryAfterAdding = (purgatory, card) => (card.isToken ? purgatory : [...purgatory, card]);

// Mulligan-phase actions happen before state.turnPlayer is meaningful (it's
// pre-set to the coin-flip winner), so log them under the acting player
// explicitly rather than via turn.js's addLog (which stamps state.turnPlayer).
const addLogAs = (state, player, message) => ({
  ...state,
  log: [...state.log, { turn: state.turnNumber, player, message }],
});

// Distant Debator: "When revealed on the top of your deck, <effect>." —
// this engine has no separate reveal-without-drawing mechanic, so the
// closest real trigger point is the literal moment a card is actually
// drawn (the top card is always "revealed" to its owner as part of
// drawing it). Exported so turn.js's own drawStep (a separate
// implementation from drawCardsFor below, not sharing code with it) can
// fire it too.
export const triggerOnRevealedTopOfDeck = (state, playerId, drawnCard) => {
  if (!drawnCard?.keywords?.onRevealedTopOfDeck) return state;
  return resolveOrLogEffect(state, playerId, drawnCard.name, drawnCard.keywords.onRevealedTopOfDeck, 'When revealed', {});
};

// Draws `count` cards for one player, applying the same draw-from-empty
// Lifespan penalty turn.js's own draw step uses — shared by DRAW_CARDS_RE
// (one player) and ALL_PLAYERS_DRAW_RE (every player, one call each).
// Splits a comma/"and"-joined typing list from printed prose ("TreeFolk,
// Vine, and Seeds", "Hungers") into individual lowercase tokens, singularized
// (a trailing "s" stripped) — printed text always lists typings in plural,
// while the CSV's own typing field is always singular ("Hunger", "Seed"), so
// a naive `card.typing.includes(t)` check silently never matches for any
// typing whose plural isn't already a substring of its own singular (i.e.
// every typing but the ones that already end in "s"). Shared by every
// "<typing list> you control gain ..." board-scan pattern below.
const parseTypingGroup = (text) => text.split(/,|\band\b/i).map(t => t.trim().toLowerCase().replace(/s$/, '')).filter(Boolean);
const cardMatchesTypingGroup = (card, typings) => typings.some(t => (card.typing || '').toLowerCase().includes(t));

const drawCardsFor = (state, playerId, count) => {
  let next = state;
  let drawnCount = 0;
  for (let i = 0; i < count; i++) {
    const player = next.players[playerId];
    const { deck, drawn, penalty } = drawCard(player.mainDeck);
    next = {
      ...next,
      players: {
        ...next.players,
        [playerId]: { ...player, mainDeck: deck, hand: drawn ? [...player.hand, drawn] : player.hand, lifespan: player.lifespan - penalty },
      },
    };
    if (drawn) drawnCount++;
    if (penalty > 0) {
      next = addLog(next, `${playerId} tried to draw from an empty Main Deck and loses ${penalty} Lifespan.`);
    }
    if (drawn) next = triggerOnRevealedTopOfDeck(next, playerId, drawn);
  }
  return { state: next, drawnCount };
};

// "Add X to hand from deck" (either word order — real card text uses both,
// e.g. "Add an Armament to hand from deck" vs. "Add a Spirit from deck to
// hand") is a well-defined, executable effect (unlike most free-text
// payloads): search the caster's Main Deck for a card whose name or typing
// matches X, and add a chosen match to hand. When more than one card
// matches, the choice is the player's — `state.pendingChoice` parks the
// game on that decision until RESOLVE_CHOICE picks one.
// Alternation order matters: "an" must be tried before "a" or the shorter
// alternative wins first, leaving a stray "n" glued onto the captured query.
const SEARCH_FROM_DECK_PATTERNS = [
  /Add\s+(?:\d+|an|a)?\s*(.+?)\s+to hand from (?:your )?deck/i,
  /Add\s+(?:\d+|an|a)?\s*(.+?)\s+from (?:your )?deck to hand/i,
];

// Invoke (RULES.md > Keywords): "Add to hand, then summon/conjure" — see
// the resolveOrLogEffect branch that checks these (near
// invokeCandidates/resolveInvoke) for what each shape means. Real cards
// print four distinct forms:
// - A specific named card, with Classic Familiar's own inline definition
//   of the keyword quoted verbatim ("Invoke (Add to hand, then summon/
//   conjure) White Whisker.").
// - "Invoke a Faithless <Typing> Card that costs (N) or less." (Faithless
//   Invocation) — a typing filter plus a real cost-type constraint
//   ("Faithless" here means "no colored casting cost", not a typing word),
//   reusing isFaithlessTypedCard (already used by Temple of Dubiety).
// - "Invoke a <Typing> with cost (N) or less summon it on a tile this
//   points to." (Kernel), or the same clause with "summon it" dropped —
//   "Invoke a <Typing> with cost (N) or less on a tile this points to."
//   (Samara Seed's own Martyr) — a typing filter, a cost ceiling, landing
//   on an arrow-pointed tile either way.
// - "Invoke a <Typing> on target tile this points to." (Crathean
//   Cultivator) — a typing filter only, landing on an arrow-pointed tile.
const INVOKE_NAMED_RE = /^Invoke \(Add to hand,? then summon\/conjure\)\s+(.+?)\.?$/i;
const INVOKE_TYPED_RELIC_FAITHLESS_RE = /^Invoke an?\s+Faithless\s+(.+?)\s+Card that costs\s*\(?(\d+)\)?\s+or less\.?$/i;
const INVOKE_TYPED_COST_POINTED_RE = /^Invoke an?\s+(.+?)\s+with cost\s*\(?(\d+)\)?\s+or less(?:\s+summon it)?\s+on a tile this points to\.?$/i;
const INVOKE_TYPED_POINTED_RE = /^Invoke an?\s+(.+?)\s+on target tile this points to\.?$/i;

// "Add X to hand from your Purgatory" (e.g. Osteomancer: "Add an Undead to
// hand from your Purgatory") — the same well-defined search-and-choose
// effect as SEARCH_FROM_DECK_PATTERNS, just searching the reanimation zone
// instead of the deck. Reuses the exact same 'search' pendingChoice kind
// (already generic over which zone — see RESOLVE_CHOICE) with
// `source: 'purgatory'`, so no new choice machinery is needed.
const SEARCH_FROM_PURGATORY_RE = /Add\s+(?:\d+|an|a)?\s*(.+?)\s+to hand from (?:your )?Purgatory/i;

// "Add X to hand from your Purgatory, if you control <Name> you may add Y
// instead" (Fetch: "Add a Bag o' Bones to hand from your Purgatory, if you
// control Cookie you may add an Undead instead.") — a single un-split
// sentence, so the plain SEARCH_FROM_PURGATORY_RE above would otherwise
// match just its prefix and silently drop the conditional upgrade. Checked
// first; falls through to SEARCH_FROM_PURGATORY_RE for cards without the
// conditional clause.
const CONDITIONAL_PURGATORY_UPGRADE_RE = /Add\s+(?:\d+|an|a)?\s*(.+?)\s+to hand from (?:your )?Purgatory,\s*if you control\s+(.+?)\s+you may add\s+(?:an|a)?\s*(.+?)\s+instead/i;

// "Shuffle a `<query>` [card] into deck from your Purgatory" (Melting
// Clock: "...a Prophecy card..."; Scrap Smith: "...an Armament..." — no
// trailing "card"/"Being" word at all) — the reverse of
// SEARCH_FROM_PURGATORY_RE above (shuffled into the deck, not added to
// hand). The lazy capture stops before an optional trailing "card"/"Being"
// the same way SEARCH_FROM_PURGATORY_RE's own capture naturally excludes
// "to hand" — but that trailing word isn't always printed, so it's
// optional here rather than required.
const SHUFFLE_FROM_PURGATORY_INTO_DECK_RE = /Shuffle an? (.+?)(?:\s+(?:cards?|Beings?))? into deck from (?:your )?Purgatory/i;

// "Shuffle up to (N) <Typing>(s) into your deck from Purgatory." (Scrap
// Collector: "Shuffle up to (2) Armaments into your deck from Purgatory.")
// — unlike the singular SHUFFLE_FROM_PURGATORY_INTO_DECK_RE above, a real
// choice of *how many* (0 up to the printed cap), not just which one —
// its own dedicated toggle-then-confirm pendingChoice (shuffle-purgatory-
// toggle), the same "pull up Purgatory and multi-select" UI shape as
// Crucible's own Purgatory search picker, just toggling more than one.
const SHUFFLE_UP_TO_N_FROM_PURGATORY_RE = /^Shuffle up to\s*\(?(\d+)\)?\s+(.+?)s? into (?:your )?deck from (?:your )?Purgatory\.?$/i;
// "Shuffle (2) Hungers into your deck from your Purgatory" (Cycle of
// Hunger, as the first half of a "then"-split — its own trailing "then
// draw (1) card" resolves independently via the generic split, so this
// only ever needs to match up to "Purgatory") — a fixed count rather than
// "up to", reused as an "up to N" toggle anyway (same choice UI as
// SHUFFLE_UP_TO_N above); picking fewer than printed is a minor,
// low-stakes leniency rather than new mandatory-exactly-N picker
// machinery.
const SHUFFLE_FIXED_N_FROM_PURGATORY_RE = /^Shuffle\s*\(?(\d+)\)?\s+(.+?)s? into (?:your )?deck from (?:your )?Purgatory\.?$/i;

// "Shuffle a Faithless Being into deck from your Purgatory, then if you
// control only Faithless Cards draw (1) Card." (Temple of Dubiety) —
// matched as one whole unit (excluded from the generic then-split above)
// since the first clause can itself open a pendingChoice with more than
// one Faithless Being in Purgatory, and the draw needs to wait for that
// to actually resolve before checking the board condition.
const TEMPLE_OF_DUBIETY_RE = /^Shuffle a Faithless Being into deck from (?:your )?Purgatory,?\s*then if you control only Faithless Cards draw\s*\(?(\d+)\)?\s+Cards?/i;

// "Summon a/an <Typing> Being on this tile from your Purgatory" (Grave
// robber's Martyr), or the same clauses in the other order, "...Being from
// your Purgatory on this tile" (Planchette's own granted Martyr) — real
// reanimation straight onto the board, not to hand (contrast
// SEARCH_FROM_PURGATORY_RE above). Needs its own pendingChoice kind since
// resolving it does something entirely different (a board placement, via
// placeBeingOnBoard) from the generic 'search' kind's add-to-hand.
const SUMMON_FROM_PURGATORY_RE = /Summon an?\s+(.+?)\s+Being (?:on this tile from (?:your )?Purgatory|from (?:your )?Purgatory on this tile)/i;

// "You may summon Undead from your Purgatory until the end of your turn."
// (Mausoleum Gates) — unlike SUMMON_FROM_PURGATORY_RE above (a single,
// immediate summon onto one fixed tile), this opens a standing WINDOW for
// the rest of the turn: any number of matching Purgatory Beings can be
// summoned, each onto any open Mortal Realm tile, until endTurn clears it
// (turn.js). See summonTypedFromPurgatoryWindows on the player object and
// ACTIVATE_SUMMON_TYPED_FROM_PURGATORY_WINDOW below.
const SUMMON_TYPED_FROM_PURGATORY_WINDOW_RE = /you may summon (\w+) from your Purgatory until the end of your turn/i;

// "Summon a different <Typing> from your Purgatory." (Osteomancer's second
// Engage ability, paid by "Sacrifice an <Typing>" — see engageExtraCost) —
// "different" specifically excludes any Purgatory card sharing the SAME
// NAME as whichever one was just sacrificed to pay the cost (confirmed
// with the user: this closes a same-named-card sacrifice/resummon loop,
// e.g. Venefica's forced sacrifice into an immediate re-summon of the
// identical card). No "on this tile" wording, unlike Grave robber's own
// SUMMON_FROM_PURGATORY_RE above — the destination is picked freely, via
// summonFromPurgatoryToOpenCell.
const SUMMON_DIFFERENT_TYPED_FROM_PURGATORY_RE = /^Summon a different (\w+) from (?:your )?Purgatory\.?$/i;

// Exported so Match.jsx's own "Shuffle up to (N) ..." Purgatory picker
// (Scrap Collector) can show the full matching candidate set the exact
// same way the engine itself determines it, rather than duplicating the
// match rule in the UI layer.
export const searchZoneCandidates = (zone, query) => {
  const q = query.toLowerCase();
  // A card whose own printed name carries a ", the <epithet>" suffix (e.g.
  // "Immen Gorta, the Boundless Hunger") is still referenced by its bare
  // first name in other cards' own effect text ("add Immen Gorta from deck
  // to hand" — By Teeth and Bounds), so an exact match alone would never
  // find it. Matches the part of the name before the first comma too, not
  // just the full name, since a name with no comma never triggers this.
  return zone.filter(c => {
    const name = (c.name || '').toLowerCase();
    return (c.typing || '').toLowerCase().includes(q) || name === q || name.startsWith(`${q},`);
  });
};

// searchZoneCandidates, widened for an OR'd typing list (Planchette: "an
// Undead or Demon Being...") — splits on " or " and unions each part's own
// matches, deduped by instanceId. A single-typing query (the overwhelming
// majority of real cards) is just a one-part split, so this is a drop-in
// replacement anywhere a query might legally contain "X or Y" — same
// split-and-union convention BUFF_ALLY_RE's own handler already uses.
export const searchZoneCandidatesAnyOf = (zone, query) => {
  const seenIds = new Set();
  return query.split(/\s+or\s+/i).map(w => w.trim()).filter(Boolean)
    .flatMap(part => searchZoneCandidates(zone, part))
    .filter(c => !seenIds.has(c.instanceId) && seenIds.add(c.instanceId));
};

// A card with no colored casting cost at all — the same "Faithless" test
// controlsOnlyFaithlessPermanents (turn.js) applies to board occupants,
// reused here for a hand/Purgatory CARD instead (Temple of Dubiety's own
// "a Faithless Being").
// "Shuffle a `<query>` into deck from your Purgatory" (Melting Clock) —
// removes the found card from Purgatory and shuffles it back into the
// Main Deck, the reverse direction of SEARCH_FROM_PURGATORY_RE's own
// "add to hand".
const shuffleFromPurgatoryIntoDeck = (state, playerId, card) => {
  const player = state.players[playerId];
  const purgatory = player.purgatory.filter(c => c.instanceId !== card.instanceId);
  const shuffled = [...player.mainDeck, card]
    .map(c => ({ c, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ c }) => c);
  return { ...state, players: { ...state.players, [playerId]: { ...player, purgatory, mainDeck: shuffled } } };
};

// "Modulate (+X)" / "Modulate (-X)" / "Modulate (±X)" — a well-defined,
// executable effect (RULES.md > Keywords): add or remove X Time Counters
// from a target. Real printed text ("on a target you control", "target Time
// Counters that you control" — Hurry Up and Wait) targets any Time Counter
// the player controls, not just a Prophecy's own — so the target pool is
// every board occupant the player owns that's either a Prophecy (its
// `timer`) or already tracking its own `counters.time` (Hourglass and
// similar Relics), plus anything carrying collectsRemovedProphecyTimeCounters
// (Hourglass specifically) even before it's collected its first one, so it
// can still be Modulated up from 0. "±" means the player picks the sign at
// resolution, so both are offered as separate candidates. A text with more
// than one Modulate clause (e.g. "Modulate (-1) and Modulate (+1)") only
// resolves the first — the same one-effect-per-trigger simplification as
// everything else here.
const MODULATE_RE = /Modulate\s*\(([+\-±]?\d+)\)/i;
// Time Keeper: "Engage: Modulate (±1) a target this points to." — checked
// before the bare MODULATE_RE above (more specific), restricting the
// 'modulate' pendingChoice's own candidates to the caster's own printed
// Arrows instead of every Time-Counter permanent on the board.
const MODULATE_POINTED_RE = /Modulate\s*\(([+\-±]?\d+)\)\s+a target this points to\.?/i;
// "You may Modulate (-1)." (Orbital Acceleration's own third clause, after
// "All players draw a card. Craft (1) Effigy.") — genuinely OPTIONAL
// ("may", never forced) and, per its own printed wording carrying no "you
// control" restriction (unlike the bare Modulate clauses above, which are
// always scoped to the caster's own permanents), able to target EITHER
// player's Time Counters. Checked before the generic MODULATE_RE below
// (more specific — an unanchored MODULATE_RE would otherwise match "Modulate
// (-1)" as a bare substring here too and silently drop both the "may" and
// the either-owner targeting).
const OPTIONAL_MODULATE_ANY_OWNER_RE = /^You may Modulate\s*\(([+\-±]?\d+)\)\.?$/i;

// "Modulate (+1), then repeat for each Time Counter on this." (Time
// Capsule's own Martyr) — matched as one whole unit (excluded from the
// generic then-split below, same reasoning as every other card whose own
// "then" needs the unsplit text) since the base Modulate already opens its
// own pendingChoice, and "repeat" has to thread through THAT choice's own
// resolution (continueModulateRepeat) rather than run immediately after.
const TIME_CAPSULE_MODULATE_REPEAT_RE = /^Modulate\s*\(([+\-±]?\d+)\),?\s*then repeat for each Time Counter on this\.?$/i;

// "When Onoushara is summoned all Beings lose -1/-1. Onoushara gains
// +1/+1 for each Being affected." — after self-name substitution
// ("Onoushara" -> "this") the whole clause reads "all Beings lose -1/-1.
// this gains +1/+1 for each Being affected." Generic over the numbers,
// same as every other +N/+N keyword this session parameterized even
// though only one real card currently uses this exact shape.
const MASS_DEBUFF_SELF_GROWTH_RE = /^all Beings lose -(\d+)\/-(\d+)\.\s*this gains\s*\+?(\d+)\/\+?(\d+) for each Being affected\.?$/i;

const hasOwnProphecy = (board, playerId) =>
  Object.values(board).some(o => o?.type === 'prophecy' && o.ownerId === playerId);

// "If you control a <Typing>, X" (Propagate) — a Being of the given typing
// anywhere on the controller's own side, mirroring hasOwnProphecy's own
// shape for a printed-typing condition instead of a card kind.
const hasOwnTyping = (board, playerId, typing) =>
  Object.values(board).some(o => o?.type === 'being' && o.ownerId === playerId && (o.card.typing || '').toLowerCase().includes(typing.toLowerCase()));

// A card already sitting at 0 Time Counters isn't a legal Modulate target —
// it has nothing left to tick down (Modulate (-1) would be a no-op) and, for
// something like Eònion Altar, 0 Time Counters is itself a meaningful game
// state (its craft bonus condition) that Modulate shouldn't be able to
// casually target at all. Hourglass-style relics (keywords.
// collectsRemovedProphecyTimeCounters) are the one documented exception —
// they can still be Modulated UP from 0, since that's how they receive
// their very first collected counter. Confirmed with the user: this same
// "must already hold a Time Counter" rule applies to a Prophecy's own
// `timer` too — merely being CAPABLE of holding Time Counters (i.e. being
// a Prophecy at all) isn't enough on its own.
const isModulateTarget = (occupant) =>
  !!occupant && (
    (occupant.type === 'prophecy' && (occupant.timer || 0) > 0)
    || occupant.card?.keywords?.collectsRemovedProphecyTimeCounters
    || (occupant.counters?.time !== undefined && occupant.counters.time > 0)
  );

// An Altar (Eònion Altar in particular) carries its own Time Counters too,
// but altars live in `state.altars[playerId]` (a plain array, keyed by
// nothing but position), not `state.board` — structurally outside
// isModulateTarget's board-occupant scan, so it needs its own check. Same
// 0-Time-Counters exclusion (and Hourglass-style exception) as
// isModulateTarget above.
const isModulateableAltar = (altar) =>
  !!altar && altar.counters?.time !== undefined
  && (altar.counters.time > 0 || altar.card?.keywords?.collectsRemovedProphecyTimeCounters);

const hasModulateTarget = (board, playerId, altars) =>
  Object.values(board).some(o => o?.ownerId === playerId && isModulateTarget(o))
  || (altars?.[playerId] || []).some(isModulateableAltar);

// Same check with no ownership restriction at all — OPTIONAL_MODULATE_ANY_
// OWNER_RE's own "either player" targeting (see its comment above).
const hasModulateTargetAnyOwner = (board, altars) =>
  Object.values(board).some(isModulateTarget)
  || Object.values(altars || {}).some(list => (list || []).some(isModulateableAltar));

// Time Capsule: "Modulate (+1), then repeat for each Time Counter on
// this." — each Modulate needs its own target choice (the 'modulate'
// pendingChoice always opens one, even with a single legal candidate), so
// "repeat N times" can't loop synchronously the way Equanimity's own
// repeat does; instead each RESOLVE_MODULATE checks repeatsRemaining and,
// if any are left, opens a FRESH 'modulate' choice instead of clearing
// pendingChoice — same "thread a continuation through the choice itself"
// shape as Acrobatic Escape's own `then`. Stops early (same graceful
// non-offer precedent as everywhere else) if a repeat finds no legal
// target left to Modulate.
// `thenDelta` (Hurry Up and Wait's own "Modulate (-1) and Modulate (+1)")
// takes priority over a Time-Capsule-style same-delta repeat when both are
// somehow present — it always represents a DIFFERENT, explicitly printed
// second Modulate, not a repeat of the first.
const continueModulateRepeat = (state, playerId, cardName, label, delta, repeatsRemaining, thenDelta = null) => {
  if (thenDelta != null) {
    if (!hasModulateTarget(state.board, playerId, state.altars)) {
      return addLog({ ...state, pendingChoice: null }, `${cardName}'s ${label} has no more Time Counters of ${playerId}'s to Modulate.`);
    }
    return { ...state, pendingChoice: { kind: 'modulate', playerId, cardName, label, delta: thenDelta } };
  }
  if (repeatsRemaining <= 0) return { ...state, pendingChoice: null };
  if (!hasModulateTarget(state.board, playerId, state.altars)) {
    return addLog({ ...state, pendingChoice: null }, `${cardName}'s ${label} has no more Time Counters of ${playerId}'s to Modulate.`);
  }
  return { ...state, pendingChoice: { kind: 'modulate', playerId, cardName, label, delta, repeatsRemaining: repeatsRemaining - 1 } };
};

// "Add (N) <Color> Essence" — the Zealot pattern (Engage: grant bonus
// Effigies): a well-defined, executable effect. Unlike an Altar's "Craft"
// (which flips a real card off the Effigy Deck and so lingers in the pool
// exactly like any other drafted effigy), a Zealot's "Add" is a temporary
// grant — good only until end of the turn it's granted. Marked `temporary:
// true` so endTurn (turn.js) can expire any of these left unspent, and can
// keep spent ones out of the real Effigy Deck when shuffling back (they
// were never real deck cards). "Faithless" is a real color name here too
// (some Zealots grant it) — it works as a wildcard token, same as any pip
// canPayCost/payCost treat as a generic faithless payment.
const ADD_ESSENCE_RE = /Add\s*\(?(\d+)\)?\s+(\w+)\s+Essence/i;

// "Target Effigy that you control Engages, then add (1) Essence of its
// typing." (Effigial Conservator) — ruled: "Target Effigy" means a real
// Effigy pool pip, not a board occupant (nothing in the set is actually
// typed "Effigy"). Engaging it protects it from being spent this turn
// (see payablePool above) until the normal Disengage Step untaps it,
// same lifecycle as any other Engaged permanent — and grants a Zealot-
// style temporary Essence of its own color on top. See
// engageEffigyAddEssence below.
const TARGET_EFFIGY_ENGAGE_ADD_ESSENCE_RE = /^Target Effigy that you control Engages,?\s*then add\s*\(?(\d+)\)?\s+Essence of its typing\.?$/i;

// "Add (N) Essence of any type" (Conversion) — unlike ADD_ESSENCE_RE above,
// the color isn't printed; the player picks it. Checked first so it isn't
// swallowed by nothing (ADD_ESSENCE_RE requires a color word right after
// the count, which "of any type" isn't).
const ADD_ESSENCE_ANY_TYPE_RE = /Add\s*\(?(\d+)\)?\s+Essence of any type/i;

// "Add (N) <Color>" with no trailing "Essence" (Blooming Vine Token's own
// "Engage: Add (1) Living") — a real, permanent Effigy straight into the
// pool, distinct from ADD_ESSENCE_RE's own "Add (N) <Color> Essence" (which
// is explicitly temporary — see makeTemporaryEssence and the
// `!e.temporary` filter in turn.js's endTurn). Anchored to the whole line
// so it never also matches an Essence line (that has trailing text after
// the color word this pattern's end-anchor won't allow).
const ADD_EFFIGY_RE = /^Add\s*\(?(\d+)\)?\s+(\w+)\.?$/i;
let effigyInstanceCounter = 0;

// "Send the top (N) cards of your deck to your Purgatory" (mill) and
// "discard a card at random" — well-defined, executable effects. Real usage
// so far is as an Altar's "additional cost to Conjure" (see PLACE_ALTAR),
// but they're recognized here rather than in a dedicated Altar-only
// resolver so any future Depart/Martyr/Engage/Conjuring text using the same
// phrasing picks them up automatically too. Both degrade gracefully instead
// of blocking play: milling fewer than N cards (deck running low) or
// discarding from an empty hand is a silent no-op rather than a refusal —
// matching the same "graceful degradation" precedent as drawing from an
// empty Main Deck elsewhere in this engine.
const MILL_RE = /send the top\s*\(?(\d+)\)?\s+cards? of your deck to your Purgatory/i;
// Real text phrases this two ways: "discard a card at random" (an Altar's
// conjure cost) and "discard (1) card at random" (Imp-practical Joker's
// When Summoned) — both discard exactly one card, so one pattern covers
// both spellings of "one".
const DISCARD_RANDOM_RE = /discard (?:a|\(?1\)?) cards? at random/i;

// "Deal (N) Damage to a <Typing> you control" (e.g. Rhak-tùrin Altar's
// conjure cost: "Deal (3) Damage to a Turanga you control") — unlike combat
// damage, this targets a Being outside of combat by creature typing. Unlike
// the mill/discard patterns above, this one does NOT degrade gracefully:
// it's a genuine "additional cost" in the MTG sense, so PLACE_ALTAR's own
// legal-action gating (see altarConjureCostPayable) refuses to offer the
// placement at all unless a legal target exists — this pattern only ever
// resolves here once that's already guaranteed true.
const DAMAGE_TARGET_RE = /Deal\s*\(?(\d+)\)?\s+Damage to an?\s+(\w+)\s+you control/i;

// "Deal (N1) Lifespan Damage to a Being you control and (N2) to a
// different Being." (Crumbling Sphinx) — two sequential targets: the first
// is the caster's own Being, the second any OTHER Being (either owner),
// excluding whichever cell the first damage just landed on. Two separate
// captured amounts in case a future card ever prints different numbers for
// each half.
const TWO_TARGET_LIFESPAN_DAMAGE_RE = /^Deal\s*\(?(\d+)\)?\s+Lifespan Damage to a Being you control and\s*\(?(\d+)\)?\s+to a different Being/i;

const beingsOfTypingOwnedBy = (board, playerId, typingWord) => {
  const word = typingWord.toLowerCase();
  return Object.entries(board).filter(([, occupant]) =>
    occupant?.type === 'being' && occupant.ownerId === playerId && (occupant.card.typing || '').toLowerCase().includes(word)
  );
};

// "Deal (N) Damage to this" — self-damage, where "this" is the Being whose
// own ability text it's part of: either printed directly on a Being, or
// granted to one by an attached Armament (e.g. "Darmah-Triya Bracers":
// "Attached Being has: Engage: Deal (2) Damage to this, then add (1)
// Bleeding Essence"). Only resolvable when resolveOrLogEffect is given a
// `context.selfCellId` pointing at the Being "this" refers to. Also
// accepts "to it" (Impatient Imp's own When Summoned phrasing) — safe to
// fold into the same pattern since it only ever follows "Deal N damage",
// never a generic "it" elsewhere. A When Summoned effect naming the
// Being's own printed name instead (Wounded Turanga) is handled by
// substituting that name for "this" before calling resolveOrLogEffect —
// see SUMMON_BEING.
const SELF_DAMAGE_RE = /Deal\s*\(?(\d+)\)?\s+Damage to (?:this|it)\b/i;
// Envoy of the Hungers: "switch this Being with a Hunger you control." —
// ruled: a board-position swap, the two Beings trading tiles (each keeps
// its own stats/counters/engaged state).
const SWITCH_WITH_TYPED_RE = /switch this Being with an?\s+(\w+) you control\.?/i;
// Grand Germination: "Trigger all Martyr abilities on Seeds you control
// ignoring costs." — ruled: every matching Seed's own Martyr text resolves
// for real, but none of them are actually sacrificed (Martyr's usual
// engage-then-sacrifice is itself the ignored cost) and any additional
// cost before the colon (a counter/Essence cost — martyrCounterCost/
// martyrEffigyCost) is waived too.
const TRIGGER_ALL_TYPED_MARTYR_RE = /^Trigger all Martyr abilities on\s+(\w+)s you control ignoring costs\.?$/i;
// Conscription / Tactical Withdraw: "All Beings move forward/backward if
// possible." — a real mass, unconditional move (no "you control" — real
// text has none, either side's Beings move), each checked against its own
// printed Arrows and normal move legality. These are two SEPARATE printed
// lines on the card (the Prophecy flip resolver splits by newline and
// resolves each independently — see resolveProphecyModulateHitZero), so
// whether anything actually moved is threaded to the following "If none
// move..." line via a one-shot scratch flag on state itself
// (`lastMassMoveNoneMoved`), the same "state carries a small flag between
// two logically-linked but separately-resolved effects" precedent
// skipNextModulate/nextBeingCostReduction already establish.
const MASS_MOVE_NO_DISENGAGE_RE = /^All Beings move (forward|backward)s? if possible\.\s*Any that move do not disengage during disengage step\.?$/i;
const MASS_MOVE_RE = /^All Beings move (forward|backward)s? if possible\.?$/i;
const IF_NONE_MOVE_FORCE_COMBAT_RE = /^If none move,?\s*choose two Beings they Engage in combat\.?$/i;
const IF_NONE_MOVE_RETURN_RE = /^If no Beings move then each player may return a Being they control to their hand\.?$/i;
// Vicious Vittles: "Engage: As an additional cost to summon your next
// Hunger this turn, sacrifice this and summon the hunger on this tile."
// — ruled: sets up a one-shot flag (nextHungerFreeSummonOnTile, read by
// SUMMON_BEING) rather than doing anything immediately; the actual
// sacrifice and same-tile placement happen only once a real Hunger is
// summoned.
const NEXT_HUNGER_SACRIFICE_THIS_ONTO_TILE_RE = /^As an additional cost to summon your next Hunger this turn,?\s*sacrifice this and summon the hunger on this tile\.?$/i;
// Brick: "Engage: Deal (1) Damge to target Being, then move Brick to the
// tile occupied by the targeted Being." (CSV typo "Damge" tolerated, same
// as every other loose-spelling precedent in this file.) Matched as one
// whole unit (excluded from the generic then-split below) since the move
// half needs to know which tile the damage half actually targeted — ruled:
// the move happens regardless of whether the damage was lethal.
const DAMAGE_THEN_MOVE_ARMAMENT_HERE_RE = /^Deal\s*\(?(\d+)\)?\s+Dam(?:age|ge) to target Being,?\s*then move\s+.+?\s+to the tile occupied by the targeted Being\.?$/i;

// Shovel: "Engage: Sacrifice Shovel, then reveal the top (3) cards of your
// deck, you may add any Relics revealed to hand, shuffle the others back
// into your deck." — a granted-Engage Armament naming ITSELF by its own
// printed name (the granted text's own cardName param is the WEARER's
// name, not the Armament's, so a generic self-name substitution doesn't
// apply here the way it does for Depart/a Prophecy's own flip lines — the
// Armament's own name is captured directly out of the "Sacrifice X" clause
// instead). Its own "then" needs the whole text as one unit (the reveal
// only happens after the sacrifice), so it joins the then-split exclusion
// list below rather than being split into two independent clauses.
const SACRIFICE_NAMED_REVEAL_TOP_RELICS_RE = /^Sacrifice\s+([\w' -]+?),\s*then reveal the top\s*\(?(\d+)\)?\s+cards? of your deck,?\s*you may add any Relics revealed to hand,?\s*shuffle the others back(?: into your deck)?\.?$/i;

// An Armament's own "Remove (N) <Name> Counter(s), then move attached Being
// one tile in any direction" (e.g. "Feathers of the Fallen"). Tailored to
// this exact printed shape rather than generalized further — no other
// Armament in the set pairs a counter-spend with a free move.
const ARMAMENT_COUNTER_MOVE_RE = /Remove\s*\(?(\d+)\)?\s+(\w+)\s+Counters?,?\s*then move attached Being one tile in any direction/i;

// A ground Relic's own "Remove (N) <Name> Counter(s), then move target
// Being you control to this tile" (Shifting Sands) — the Relic-level
// analog of ARMAMENT_COUNTER_MOVE_RE above, just spending the Relic's own
// counters (see RULES.md > Keywords > "Beings may move across this") and
// moving a *targeted* Being to the Relic's own tile instead of the
// *attached* one one tile over. Same "then" chaining, so it needs the same
// whole-text-match exclusion from the generic split below.
const RELIC_COUNTER_MOVE_RE = /Remove\s*\(?(\d+)\)?\s+(\w+)\s+Counters?,?\s*then move target Being you control to this tile/i;

// "Until end of turn Plants summoned on this tile come in Disengaged."
// (Tilled Fields' own Engage effect) — a temporary per-tile override of
// the normal "a Being enters Engaged" rule (RULES.md > Card types),
// scoped to Plant-typed Beings summoned onto THIS specific ground-Relic
// tile — see placeBeingOnBoard's own check of
// groundRelics[cellId].plantsEnterDisengagedUntilEndOfTurn.
const PLANTS_ENTER_DISENGAGED_RE = /Until end of turn Plants summoned on this tile come in Disengaged/i;

// Bare "Remove (N) <Type> Counter(s)" (Hourglass: "Engage: Remove (5) Time
// Counters, then draw (2) cards.") — a standalone clause spending this
// permanent's own Counters, distinct from RELIC_COUNTER_MOVE_RE above
// (which is one specific *compound* effect, excluded from the generic
// "then"-split so it isn't torn apart); this one is meant to be split off
// from whatever follows it and resolved on its own.
// Horologist's Apprentice: "Once per turn remove (3) Time Counters:
// Shuffle a random card from hand into deck, then draw (1) Card." —
// checked before the bare REMOVE_OWN_COUNTERS_RE below (which would
// otherwise match just the "Remove (3) Time Counters" prefix and return,
// silently dropping everything after the colon).
const REMOVE_OWN_COUNTERS_THEN_RE = /^Remove\s*\(?(\d+)\)?\s+(\w+)\s+Counters?:\s*(.+)$/i;
// Canopic Jar: "Engage: Remove (4) Crossing Counters Shuffle a Being from
// Purgatory into it's owners deck, they draw (1) card." — no punctuation
// at all between the counter cost and the effect (the CSV's own irregular
// phrasing), so it needs its own dedicated whole-text pattern rather than
// reuse REMOVE_OWN_COUNTERS_THEN_RE's colon-separated shape.
const REMOVE_OWN_COUNTERS_SHUFFLE_PURGATORY_DRAW_RE = /^Remove\s*\(?(\d+)\)?\s+(\w+)\s+Counters?\s+Shuffle an?\s+(.+?)\s+from Purgatory into it'?s owners?\s+deck,?\s*they draw\s*\(?(\d+|one|two|three|four|five)\)?\s+cards?\.?$/i;
// May Break my Bones: "Choose a Being this points to, destroy it and
// Summon a Bag o' Bones token on that tile." — the token lands on the
// SAME tile the destroyed Being just vacated.
const DESTROY_POINTED_SUMMON_TOKEN_HERE_RE = /^Choose a Being this points to,?\s*destroy it and Summon an?\s+(.+?)\s+tokens?\b/i;
// Mirage Visage: "Choose (2) Beings this points to, become Favored." — up
// to N of the pointed Beings, either side (no "you control" printed).
const FAVOR_POINTED_MULTI_RE = /^Choose\s*\(?(\d+)\)?\s+Beings this points to,?\s*become Favored\.?$/i;
// "Shuffle a random card from hand into deck." (Horologist's Apprentice,
// as one half of a then-split) — a random hand card, not a chosen one.
const SHUFFLE_RANDOM_HAND_CARD_INTO_DECK_RE = /^Shuffle a random card from hand into deck\.?$/i;
const REMOVE_OWN_COUNTERS_RE = /^Remove\s*\(?(\d+)\)?\s+(\w+)\s+Counters?\b/i;

// "this Deity immediately moves without engaging" (Mahka-Rahva's own When
// Summoned — the real CSV misspells it "Diety", so both spellings match).
// A Deity already enters play disengaged on its own (SUMMON_BEING), so this
// free move doesn't change that — it just relocates her once before she
// still gets her own real action for the turn (move or attack), same as
// any other ready Being. Net effect: two actions on the turn she's
// summoned, only one of which can be an attack (this move never is one) —
// the same "relocate without engaging" primitive as an Armament's free
// move above (ARMAMENT_COUNTER_MOVE_RE), just triggered by summoning
// instead of spending Armament Counters.
const SELF_MOVE_WITHOUT_ENGAGING_RE = /this (?:Deity|Diety) immediately moves without engaging/i;

// -- "When Summoned" patterns (Beings only — see SUMMON_BEING) -------------

// "If you control a Prophecy, X" — a conditional wrapper shared by several
// real Beings' When Summoned text (Clock Tower Custodian, Massive/Medium/
// Mini Mage, Sneaky Peek). Checked early in resolveOrLogEffect so it can
// strip the prefix and recurse on the remainder — reusable by any future
// card with the same prefix, not hardcoded per-card.
const PROPHECY_CONDITION_PREFIX_RE = /^if you control a Prophecy,?\s*/i;

// "Draw (N) card(s)" — backed by the same drawCard() used by turn.js's own
// draw step, including its draw-from-empty Lifespan penalty. Most real
// cards print a digit ("(3)"), but a couple spell it out instead ("Draw
// three Cards." — Daylight Savings), so the count accepts either.
// "a"/"an" mean 1 (Orbital Acceleration: "All players draw a card.";
// Oracle of Eonia: "...draw a card.") — same "1" ALL_PLAYERS_DRAW_RE's own
// alternation already treats them as.
const WORD_NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };
const parseAmount = (raw) => (raw in WORD_NUMBERS ? WORD_NUMBERS[raw.toLowerCase()] : parseInt(raw, 10));
const DRAW_CARDS_RE = /draw\s*\(?(\d+|an?|one|two|three|four|five)\)?\s+cards?\b/i;

// "All players draw (N) card(s)" (Orbital Acceleration) — unlike
// DRAW_CARDS_RE above, this is every player at the table, not just whoever
// controls the effect; checked first so it doesn't collide with the
// single-player pattern (DRAW_CARDS_RE would still match the "draw a card"
// tail of this same sentence).
const ALL_PLAYERS_DRAW_RE = /All players draw\s*\(?(\d+|a|an|one|two|three|four|five)\)?\s+cards?\b/i;

// By Teeth and Bounds — a Prophecy's own flip trigger resolves ONE PRINTED
// LINE AT A TIME (resolveProphecyModulateHitZero splits `textBox` on `\n`
// and calls resolveOrLogEffect once per line), unlike a Conjuring's whole
// textBox (CAST_CONJURING passes it as one combined string — compare
// Propagate's own bespoke two-condition regex, needed only because of that
// difference). So each of this card's three "If ..." lines is its own
// self-contained, self-gating branch below, rather than one combined
// multi-line pattern: whichever one is checked, first re-derives whether
// its own condition holds, and no-ops (a false condition just isn't a match
// worth logging, same as an unmet PROPHECY_CONDITION_PREFIX_RE elsewhere)
// when it doesn't. MORE_RE's own printed "then" is the sacrifice-and-search
// combo, not two independent clauses — it joins the chained-clause
// exclusion list at the top of this function so it isn't split apart first.
const BY_TEETH_AND_BOUNDS_MORE_RE = /^If you control more Beings than your opponent:?\s*sacrifice a Hunger,?\s*then add Immen Gorta from deck to hand\.?$/i;
const BY_TEETH_AND_BOUNDS_LESS_RE = /^If you control less [Bb]eings than your opponent:?\s*draw\s*\(?2\)?\s*cards?\.?$/i;
const BY_TEETH_AND_BOUNDS_TIE_RE = /^If it is tied:?\s*choose one\.?$/i;

// "Gain (N) Time Counters" — a Prophecy's own flip trigger (RULES.md >
// Prophecies): when a face-down Prophecy's timer hits 0, it flips face up
// and resolves its printed text one line at a time
// (resolveProphecyModulateHitZero, below); this specific line is what
// grants it its own new Time Counter total for the face-up half of its
// life, rather than a token/damage/draw-style effect.
const GAIN_TIME_COUNTERS_RE = /Gain\s*\(?(\d+)\)?\s+Time Counters?/i;

// "Craft (N) Effigy" as a one-time effect (Tiarlish Magic, Orbital
// Acceleration) — distinct from an Altar's passive, always-on "Craft (N)
// additional Effigy on your turn" (card.keywords.craftBonus, turn.js);
// this drafts straight from the caster's own Effigy Deck into their pool
// once, the same underlying flip craftEffigies (turn.js) already does.
// Naturally distinct from the Altar-only pattern's own wording, which
// always has "additional" between the count and "Effigy" — this one never
// does, so the two never collide. "a"/"an" (Reveler: "craft an Effigy")
// mean 1, same as DRAW_CARDS_RE's own word-count handling.
const CRAFT_EFFIGY_RE = /Craft\s*\(?(\d+|an?)\)?\s+Effigy\b/i;

// "Your next Being this turn costs (-1) Formless to Summon." (Simple
// Summoner) — a one-shot flag on state itself, consumed by SUMMON_BEING
// the next time it actually places a Being this turn (see
// effectiveCastingCost above and SUMMON_BEING's own reducer case).
const NEXT_BEING_COST_REDUCTION_RE = /Your next Being this turn costs\s*\(?-(\d+)\)?\s+(\w+) to Summon/i;

// "The next Relic you summon this turn costs (-N) <Color>." (Metal Worker,
// reached via its own "Once per turn, you may Pay (1) Bleeding Essence:
// ..." wrapper — PAY_EFFIGY_COST_EFFECT_RE strips that cost off first) —
// same one-shot-flag shape as NEXT_BEING_COST_REDUCTION_RE above, just
// "Relic" and worded as "you summon" instead of "to Summon" (confirmed
// with the user: identical mechanic to Simple Summoner, Relic in place of
// Being).
const NEXT_RELIC_COST_REDUCTION_RE = /The next Relic you (?:summon|conjure) this turn costs\s*\(?-(\d+)\)?\s+(\w+)/i;

// "All Beings are sent to Purgatory. Each player Crafts (1) Effigy card for
// each Being they controlled. Your turn ends." (Dust to Dust) — a one-off,
// self-contained combination (board wipe scaled per-player crafting, then
// a forced end of turn) rather than three separately composable clauses,
// since "for each Being they controlled" needs the pre-wipe count and
// applies independently to BOTH players, not just the caster the way
// CRAFT_EFFIGY_RE's plain "Craft (N) Effigy" always does.
const BOARD_WIPE_CRAFT_PER_BEING_RE = /All Beings are sent to Purgatory\.\s*Each player Crafts\s*\(?(\d+)\)?\s+Effigy card for each Being they controlled/i;

// "Discard your hand and Craft (3) Effigies. At the start of your next
// turn draw (1) additional card. Your Turn Ends." (All or nothing) —
// three plain sentences (no "then"), so this is matched as one whole unit
// and handled by hand — the middle sentence in particular needs a
// one-shot flag on the player (extraDrawNextTurn), consumed by drawStep
// in turn.js the next time it runs for them.
const DISCARD_HAND_CRAFT_DELAYED_DRAW_RE = /Discard your hand and Craft\s*\(?(\d+)\)?\s+Effigies\.\s*At the start of your next turn draw\s*\(?(\d+)\)?\s+additional cards?\.\s*Your Turn Ends/i;

// "Reveal the top card of your deck" (Sneaky Peek) — informational only;
// no state change, since a solitary reveal has no real secret to keep.
const REVEAL_TOP_RE = /reveal the top card of your deck/i;

// "Deal (N) Damage to all other Beings" (Quake Goliath).
const DAMAGE_ALL_OTHERS_RE = /Deal\s*\(?(\d+)\)?\s+Damage to all other Beings/i;

// "Deal (N) damage to target Being" (Massive/Medium/Mini Mage, after their
// shared Prophecy-condition prefix is stripped) — unlike DAMAGE_TARGET_RE
// above, "target Being" is unqualified: any Being on the board, either
// owner. Reuses the same 'damage-target' pendingChoice kind with
// `typing: null` meaning "no typing/ownership filter" (see the
// generalized candidate-gathering in getLegalActions/RESOLVE_DAMAGE_TARGET).
const DAMAGE_ANY_TARGET_RE = /Deal\s*\(?(\d+)\)?\s+damage to (?:target Being|any target)\b/i;

// "Target Being's Strength becomes (N) until end of turn" (Regress).
const STRENGTH_BECOMES_EOT_RE = /Target Being's Strength becomes\s*\(?(\d+)\)?\s+until end of turn/i;

// "Target Being gains a -1/-1 Counter." (Scarab) — unqualified target (any
// Being, either owner), same "any target" candidate pool as
// DAMAGE_ANY_TARGET_RE above. The optional count defaults to 1 ("a" rather
// than a printed number) — generic over the count regardless, so any
// future card printing "gains (N) -1/-1 Counters" is picked up too.
const MINUS_COUNTER_TARGET_RE = /^Target Being gains an?\s*(?:\(?(\d+)\)?\s+)?-1\/-1 Counters?\.?$/i;

// "Flip a coin, If heads deal (1) damage to an enemy, if tails target
// opponent deals (1) damage where ever they want" (Ambiguity) — heads
// lets the CASTER choose an opponent's Being to damage (reuses
// 'damage-target' with ownerFilter: 'opponent'); tails hands the whole
// choice to the OPPONENT instead, over any Being on the board (same
// "pendingChoice belongs to whoever is choosing, not necessarily the
// caster" precedent Venefica's forced sacrifice already established).
const COIN_FLIP_DAMAGE_RE = /^Flip a coin,?\s*If heads deal\s*\(?(\d+)\)?\s+damage to an enemy,?\s*if tails target opponent deals\s*\(?(\d+)\)?\s+damage where ?ever they want/i;
// Illegible Grimoire / Witching Well: "Flip a coin, if heads X, if tails
// Y." — a generic version of COIN_FLIP_DAMAGE_RE above (which is
// hardcoded to a different card's own damage wording): whichever branch
// wins resolves through the exact same shared resolver recursively, so
// any future card with this shape is picked up for free, not just these
// two. Checked AFTER COIN_FLIP_DAMAGE_RE so that card's own more specific
// match still wins for its own text.
const GENERIC_COIN_FLIP_RE = /^Flip a coin,?\s*if heads\s+(.+?),?\s*if tails\s+(.+?)\.?$/i;
// Exactly on TIme: "Add a Timless Being that costs (3) or more from deck
// to hand." (CSV's own "Timless" typo for "Timeless") — a real cost-floor
// deck search, reusing the existing minCostFilter on the 'search'
// pendingChoice rather than a new search mechanism.
const SEARCH_DECK_COST_OR_MORE_RE = /^Add an?\s+(.+?)\s+that costs\s*\(?(\d+)\)?\s+or more from deck to hand\.?$/i;

// "Return target Non-Deity Being you control to your hand" (Revoke) — the
// card's own second sentence ("Revoke can not target a Faithless Being")
// is a targeting restriction baked directly into the candidate filter
// below rather than parsed out of the text.
const RETURN_TO_HAND_RE = /Return target Non-?Deity Being you control to your hand/i;

// "Shuffle your hand into your deck, then draw half that many cards
// rounded up." (Infinite Divisibility) — matched as one whole unit
// (excluded from the generic then-split above) because the second half's
// draw count is derived from the first half's own result (hand size),
// not printed anywhere in the text itself.
const SHUFFLE_HAND_DRAW_HALF_RE = /Shuffle your hand into your deck,?\s*then draw half that many cards rounded up/i;

// "Reveal the top (3) cards of your deck, you may add any Seed Beings
// revealed in this way to hand, then shuffle your deck." (Aerate) —
// matched as one whole unit (excluded from the generic then-split above)
// since the shuffle half needs to know exactly which cards were revealed
// and which of those were kept. "You may add" is implemented the same
// simplified way Farm Hand's own single-card reveal already is: any
// matching Seed Being found is added automatically rather than offering a
// per-card keep/discard choice. The real CSV misspells "revealed" as
// "revelaed" on this one card (the 'a' and 'l' transposed, not just a
// dropped letter — reve+aled vs reve+laed), so both spellings are matched
// (same class of fix as SACRIFICE_ARMAMENT_DRAW_RE's own real-text typo/
// wording gaps).
const REVEAL_TOP_SEED_TO_HAND_SHUFFLE_RE = /Reveal the top\s*\(?(\d+)\)?\s+cards? of your deck,?\s*you may add any Seed Beings reve(?:al|la)ed in this way to hand,?\s*then shuffle your deck/i;

// "Discard a card the next card you play this turn costs (-1) Faithless."
// (Lighten the Load) — discards a chosen card, then grants a Faithless
// discount for whatever's played next this turn. Implemented as 1
// temporary Faithless Essence added to the pool (makeTemporaryEssence,
// same primitive ADD_ESSENCE_RE already uses, cleared at end of turn by
// endTurn) rather than a true "only the very next card" cost reduction —
// a documented simplification: the practical effect (one fewer real
// Effigy needed to pay for something this turn) is identical, it just
// isn't pinned to being spent on literally the next card played.
const DISCARD_THEN_COST_REDUCTION_RE = /^Discard a card the next card you play this turn costs\s*\(?(-?\d+)\)?\s+Faithless/i;

// "Target Being gains (1) Time Counter and 'Can not move while this being
// has at least (1) Time Counter'." (Moment of Doubt) — the printed
// threshold is always the same as the amount gained in practice, so this
// is implemented as a generic "blocked while it holds any Time Counter at
// all" flag (blockedWhileHasTimeCounters) rather than tracking a separate
// numeric threshold. The counter itself never depletes on its own (no
// printed decay), so the block is effectively permanent unless some other
// effect removes the Counter.
const GAIN_TIME_COUNTER_BLOCKS_MOVE_RE = /^Target Being gains\s*\(?(\d+)\)?\s+Time Counters?\s+and\s*["']?Can ?not move while this being has at least/i;

// "Target Engaged Being gains: (2) Time Counters and 'While this has at
// least (1) Time Counter, it does not Disengage during Disengage step'"
// (Freeze Frame) — candidates are restricted to currently-Engaged Beings,
// either owner. Sets doesNotDisengageWhileHasTimeCounters (turn.js's own
// disengage()), which — unlike Instigator's self-consuming
// doesNotDisengage — keeps re-applying for as long as the Counter(s) last.
const GAIN_TIME_COUNTER_NO_DISENGAGE_RE = /^Target Engaged Being gains:?\s*\(?(\d+)\)?\s+Time Counters?\s+and\s*["']?While this has at least/i;

// "Move target Being (1) tile in any direction" (Divine Winds) — any Being,
// either owner (no "you control"). Feeds the same 'select-move-source' /
// 'free-move' two-step flow as Prepare for Battle below.
const MOVE_TARGET_ANY_ONE_TILE_RE = /^Move target Being\s*\(?1\)?\s+tile in any direction/i;

// "Target Being you control moves to a tile with an Armament on it"
// (Prepare for Battle) — same two-step flow, but the caster's own Beings
// only, and the destination must specifically be a freestanding Armament
// pile (destinationFilter: 'armament' — see freeMoveDestinationOk).
const MOVE_TO_ARMAMENT_TILE_RE = /^Target Being you control moves to a tile with an Armament on it/i;

// "Move target Being you control forward." (Spirit Guide) — unlike
// MOVE_TARGET_ANY_ONE_TILE_RE/MOVE_TO_ARMAMENT_TILE_RE above, the
// destination isn't a player choice at all: always exactly one tile in the
// fixed "forward" direction (computeMoveDestination's direction 1, board.js
// > Arrow directions). Only which Being (if more than one legal) is ever a
// real choice, so this gets its own small dedicated flow rather than
// startMoveSequence's full any-direction one.
const MOVE_TARGET_OWN_FORWARD_RE = /^Move target Being you control forward\b/i;

// "Move target Armament you control to a tile this points to." (Ay-gruhda)
// — see moveArmamentEntry/placeMovedArmament above for the shared
// relocation machinery; two independent choice dimensions (which
// Armament, which pointed tile), handled as its own small two-stage flow
// the same way Invoke's own card-then-destination split works.
const MOVE_ARMAMENT_POINTED_RE = /^Move target Armament you control to a tile this points to\.?$/i;

// "Move an Armament in any direction." (Smith Assistant's own Engage) —
// the Divine Winds "any direction" free-move geometry
// (moveOrOfferFreeMove/computeMoveDestination over all 8 directions),
// applied to one of the player's own Armament entries board-wide instead
// of a Being — see placeMovedArmamentAnyDirection below.
const MOVE_ARMAMENT_ANY_DIRECTION_RE = /^Move an Armament in any direction\.?$/i;

// Sha-KaRah's own printed effect (payLifespanCostAbility.effect, cardData.js
// — the cost half is paid by ACTIVATE_PAY_LIFESPAN_COST_ABILITY before this
// ever runs): "move an adjacent Armament one tile in any direction." — no
// ownership restriction printed (unlike Ay-gruhda's own "you control"), so
// any Armament on a tile adjacent to Sha-KaRah itself is a legal source,
// either owner. Shares placeMovedArmamentAnyDirection's own destination
// geometry with MOVE_ARMAMENT_ANY_DIRECTION_RE above — only the source
// candidate pool differs (adjacent-to-self here, vs. every Armament the
// player controls board-wide there).
const MOVE_ADJACENT_ARMAMENT_ANY_DIRECTION_RE = /^move an adjacent Armament one tile in any direction\.?$/i;

// Echo chamber: "Move target Being you control in any direction, then move
// target Being an opponent controls in any direction." — matched as ONE
// whole unit (excluded from the generic then-split above) rather than two
// independently-split clauses, because the first half can itself open a
// pendingChoice (multiple legal Beings of the caster's own to move); the
// resolver below chains the second half through an explicit `then`
// continuation instead, so it truly waits for the first to finish.
const MOVE_OWN_THEN_OPPONENT_RE = /^Move target Being you control in any direction,?\s+then move target Being an? opponent controls in any direction/i;

// "Engage target being, it has +2/+0 until end of turn." (Boknean Wine) —
// Engage itself IS the cost here (a disengaged Being of the caster's own),
// not a separate keyword trigger.
const ENGAGE_TARGET_STAT_BONUS_EOT_RE = /^Engage target being,?\s*it has\s*([+-]\d+)\/([+-]\d+)\s+until end of turn/i;

// "Target Being has (-X/-0) strength until end of turn where (X) is
// Venomous Viper's Strength." — X is read live from the caster's own
// current Strength (effectiveStrength, combat.js) at the moment this
// resolves, via context.selfCellId; applied to the target as a negative
// statBonusUntilEndOfTurn (the "-0" Lifespan half is a no-op). Target is
// unrestricted by ownership ("Target Being", no "you control"). Written to
// not care which card's own name appears before "'s Strength" — generic
// over any future card phrased the same way, unlike
// selfReferentialWhenSummonedText's own name-substitution trick (which
// only ever runs for whenSummoned text, not Engage).
const SELF_STRENGTH_DEBUFF_TARGET_RE = /^Target Being has\s*\(?-X\/-?0\)?\s+[Ss]trength until end of turn where\s*\(?X\)?\s+is .+?'s Strength/i;

// "Until the end of turn, target Being has -1/-1 for each Being that died
// under your control this turn." (Plague doctor) — X is read live from the
// CASTER's own beingsDiedThisTurn counter (incrementBeingsDiedThisTurn,
// above) at the moment this resolves, applied to an unrestricted "target
// Being" the same way SELF_STRENGTH_DEBUFF_TARGET_RE's own target pool is
// (either owner) — see the DEBUFF_PER_OWN_DEATH_TARGET_RE branch below.
const DEBUFF_PER_OWN_DEATH_TARGET_RE = /^Until the end of turn,?\s*target Being has -1\/-1 for each Being that died under your control this turn\.?$/i;

// "Engage target Treefolk, move it (1) tile in any direction." (Transplant)
// — Engage a typed Being of the caster's own as the cost, then immediately
// move that SAME Being (moveOrOfferFreeMove), unlike Divine Winds/Prepare
// for Battle above where the mover is picked independently of any cost.
const ENGAGE_TYPED_THEN_MOVE_RE = /^Engage target (\w+),?\s*move it\s*\(?1\)?\s+tile in any direction/i;

// "Engage target Being you control: Move it, then move it again."
// (Acrobatic Escape) — same "Engage a Being as the cost, then move that
// SAME Being" shape as ENGAGE_TYPED_THEN_MOVE_RE above (no typing filter
// here, and the "any direction" free move happens twice in a row instead
// of once — see continueMoveThen's own `sameActor` branch, which is what
// makes the SECOND move act on wherever the first one actually landed).
const ENGAGE_TARGET_MOVE_TWICE_RE = /^Engage target Being you control:?\s*Move it,?\s*then move it again\.?$/i;

// "Summon a 0/2 Vine token on an empty tile adjacent to another Vine you
// control." (Crawling Growth) — plain grid adjacency (all 8 neighbors),
// not arrow/direction-gated like movement, and never into the Ethereal
// Realm (Beings, tokens included, never enter it).
const SUMMON_VINE_ADJACENT_RE = /Summon a 0\/2 Vine token on an empty tile adjacent to another Vine you control/i;

// "Summon a 0/2 Vine token on target empty tile you control." (Ravenous
// Growth) — the stat prefix ("0/2 ") means this doesn't match the generic
// SUMMON_TOKEN_RE above (which expects "a/an <name> token" with nothing
// but the name in between), so it gets its own dedicated pattern reusing
// the same 'token-location' choice SUMMON_TOKEN_RE's own multi-candidate
// case already offers.
const SUMMON_VINE_TARGET_TILE_RE = /Summon a 0\/2 Vine token on target empty tile you control/i;

// "Summon (2) 0/2 vine being tokens on tiles you control." (Spreading
// Roots) — no explicit choice in the text (just "on tiles you control"),
// so this auto-places on up to N of the caster's own empty tiles in a
// stable order, same "no choice offered" precedent as
// SUMMON_ALL_POINTED_RE's own mass token placement.
const SUMMON_VINE_MULTI_RE = /Summon\s*\(?(\d+)\)?\s+0\/2 vine being tokens on tiles you control/i;

// "you may summon (2) 0/2 Vine tokens on tiles this points to" (Jirahperā,
// its own printed name already substituted to "this" by
// selfReferentialWhenSummonedText) — an optional trigger with no separate
// cost, reusing the same optional/Decline mechanism as every other "you
// may" choice; once accepted, placement is auto-picked (up to the printed
// count, across up to that many of its own pointed tiles) with no further
// player choice of *which* pointed tile — same no-picker precedent as
// SUMMON_VINE_MULTI_RE/SUMMON_TOKEN_ALL_POINTED_RE's own mass placement.
const MAY_SUMMON_VINE_POINTED_RE = /you may summon\s*\(?(\d+)\)?\s+0\/2 Vine tokens? on tiles this points to/i;

// "summon a 0/2 Vine token on a tile this points to" (Sporangium) —
// singular/definite "a tile", unlike MAY_SUMMON_VINE_POINTED_RE's "tiles"
// above (an optional, up-to-N-tiles mass placement) or
// SUMMON_TOKEN_POINTED_RE's own "any tile" (a free-form token name,
// captured from the text) below: this is a single, mandatory placement of
// a fixed Vine token, so it's its own dedicated fixed-shape regex, same
// "0/2 Vine" literal precedent as SUMMON_VINE_ADJACENT_RE/
// SUMMON_VINE_TARGET_TILE_RE above (their stat prefix would otherwise
// corrupt a name-capturing regex's TOKEN_REGISTRY lookup).
const SUMMON_VINE_POINTED_RE = /Summon a 0\/2 Vine token on a tile this points to/i;

// "Sacrifice target <Typing>: X" (Cannibalize: "Sacrifice target Hunger:
// Hungers you control disengage.") — a typed sacrifice cost, unlike
// SACRIFICE_BEING_COST_RE's untyped "a Being you control".
const SACRIFICE_TARGET_TYPING_COST_RE = /^Sacrifice target (\w+):\s*(.+)$/i;

// "Sacrifice a non Armament Relic: X" (Smelt) — a board Relic (type:
// 'relic' already excludes attached/freestanding Armaments, which live as
// their own separate occupant/entry shape, so "non Armament" needs no
// extra filtering beyond the normal Relic candidate pool).
const SACRIFICE_NON_ARMAMENT_RELIC_COST_RE = /^Sacrifice a non ?Armament Relic:\s*(.+)$/i;

// "Sacrifice a Relic: X" (Antiquities Dealer: "Once per turn sacrifice a
// Relic: Craft (1) Effigy.") — unlike SACRIFICE_NON_ARMAMENT_RELIC_COST_RE
// above, no "non Armament" restriction: any of the three real Relic shapes
// (RULES.md > Card types) is a legal cost payment — a plain freestanding
// Relic, a Relic-Being, or a Relic-Armament entry — same wider pool
// gatherRelicTargets (Desecration) already generalizes over. Doesn't match
// the "non Armament" text above (that has extra words between "a" and
// "Relic"), so the two never collide.
const SACRIFICE_RELIC_COST_RE = /^Sacrifice an? Relic:\s*(.+)$/i;

// "Pay (N) <Color> [Essence]: <effect>" as free-standing EFFECT TEXT
// (Anahk-sha: "Once per turn Pay (1) Bleeding Essence: Disengage." — the
// "Once per turn" prefix is stripped off by timesPerTurnMatch, cardData.js,
// leaving just this to resolve). Distinct from payEffigyCostAbility
// (cardData.js) — that field is a card's own *top-level* activated
// ability, anchored to the start of its text box; this is the same cost
// shape recognized generically wherever it shows up as an effect string
// mid-resolution (the same "some patterns are also generic effect-text
// shapes, not just top-level keywords" precedent SACRIFICE_RELIC_COST_RE
// above already establishes). The optional "Essence" word is just flavor
// here — paying is the same real Effigy-pool spend either way.
const PAY_EFFIGY_COST_EFFECT_RE = /^Pay\s*\(?(\d+)\)?\s+(\w+)(?:\s+Essence)?:\s*(.+)$/i;

// "Disengage." as a bare effect (Anahk-sha, after its own Pay-cost prefix
// above is paid) — sets the caster's own occupant back to disengaged.
const DISENGAGE_SELF_RE = /^Disengage\.?$/i;

// "Add (N) <Type> Counter(s) to target Relic" (Smelt's own effect half:
// "Add (1) Forge Counter to target Relic") — generic over the counter
// type, any Relic on the board (either owner, no "you control" printed).
const ADD_COUNTER_TO_TARGET_RELIC_RE = /^Add\s*\(?(\d+)\)?\s+(\w+)\s+Counters? to target Relic/i;

// "Add (N) <Type> Counter(s)." with no target at all (Blooming Seed's own
// "Add (1) Growth Counter." — a Being's activated ability adding a counter
// to itself, the same generic `occupant.counters` primitive Forge/Crossing
// Counters already use — RULES.md > Keywords). Anchored to the whole line
// (through the required trailing "Counter(s)" and optional period) so it
// never collides with ADD_COUNTER_TO_TARGET_RELIC_RE above (that shape
// always has more text — "to target Relic" — after "Counter(s)"). Tolerant
// of "Gain" as a synonym for "Add" (Sanative Siphon's own "Gain (1)
// Crossing Counter whenever a Being you control Shifts" — same mechanical
// action, just different printed vocabulary, like GAIN_TIME_COUNTERS_RE's
// own "Gain" already is for Time Counters specifically) — but "Time"
// itself stays excluded here (negative lookahead) so it keeps falling
// through to GAIN_TIME_COUNTERS_RE's own dedicated Prophecy-timer handling
// further down this chain, rather than being wrongly written into
// occupant.counters.time instead of the real Prophecy timer.
const ADD_COUNTER_SELF_RE = /^(?:Add|Gain)\s*\(?(\d+)\)?\s+(?!Time\b)(\w+)\s+Counters?\.?$/i;

// "Add (N) <Type> Counter(s) to a <Typing> this points to." (Green thumbed
// Gardener: "add (1) Growth Counter to a Seed this points to.") — the
// same "points to" arrow geometry every other pointed-tile effect this
// session uses, narrowed to occupants matching a printed typing (any
// owner — the real text has no "you control").
const ADD_COUNTER_TYPED_POINTED_RE = /^add\s*\(?(\d+)\)?\s+(\w+)\s+Counters? to an?\s+(.+?)\s+this points to\.?$/i;

// "Give target Being you control (+1/+1), reconjure this for each
// adjacent Being you control." (Vyu-bhata) — a documented simplification:
// rather than genuinely re-casting the whole card once per adjacent
// Being (which could itself pick a fresh target and further recurse), the
// adjacency count is taken once, against the FIRST target's own tile, and
// applied as that many *additional* +1/+1 stacks onto the same target —
// same net Strength/Lifespan outcome as compounding separate casts onto
// one Being, without open-ended recursion risk.
const VYU_BHATA_RE = /^Give target Being you control\s*\(?\+1\/\+1\)?,?\s*reconjure this for each adjacent Being you control/i;

// "Destroy target blocking Being, its controller is not dealt damage when
// it dies; the attacking Being deals no damage." (Strike Down) — "blocking
// Being" is whichever Being currently occupies the lane a real declared
// attack is resolving into (state.pendingResolution.kind === 'attack' —
// see declareAttackFrom/attackPendingBlockingCell, below), not a broad
// "any front-row Being of the opponent" approximation. Castable by EITHER
// player during that window (confirmed with the user), not just the
// attacker or just the defender — the blocking Being it destroys is
// always the DEFENDER's own, regardless of who casts it. Both printed
// clauses are real now that the attack-declaration priority window
// exists (Phase 3 of the priority-window rework — see the approved
// plan): the destroy-with-no-death-damage half (unchanged, via
// destroyBeing's own no-death-damage behavior) AND "the attacking Being
// deals no damage" (resolveAttackFrom's own `noDamage` param, set via
// the `noDamage: true` flag this stashes onto state.pendingResolution
// itself) — previously undocumented-gap, now closed.
const STRIKE_DOWN_RE = /^Destroy target blocking Being,?\s*its controller is not dealt damage when it dies/i;

// The board cell a real, currently-open attack-declaration window is
// resolving into — null whenever no such window is open. Shared by Strike
// Down's own castability gate (conjuringCastGateOk) and its resolution
// branch (resolveOrLogEffect) so both always agree on exactly the same
// cell.
const attackPendingBlockingCell = (state) => {
  const pr = state.pendingResolution;
  if (pr?.kind !== 'attack') return null;
  return computeAttackCell(pr.declaringPlayer, pr.fromCellId);
};

// Desperate Finale: "As an additonal cost to conjure: Pay Lifespan equal
// to the Lifespan of target engaged Being you control." — the SAME target
// then "fights without engaging" and is sacrificed at end of turn (the
// Conjuring's own remaining text, see resolveDesperateFinale below). A
// dedicated flow rather than the generic conjureCost->resolveOrLogEffect
// path every other Altar/Conjuring cost uses, since the cost's own amount
// depends on which Being is chosen — the choice has to happen before the
// cost can even be computed, let alone paid.
const LIFESPAN_EQUAL_TARGET_ENGAGED_RE = /^Pay Lifespan equal to the Lifespan of target engaged Being you control\.?$/i;

// Whether `playerId` has at least one engaged Being they control whose own
// printed Lifespan is still affordable as a cost (same "can't drop to 0"
// gate every other Lifespan-cost effect in this file already uses).
const hasAffordableEngagedTarget = (board, players, playerId) =>
  Object.values(board).some(o =>
    o?.type === 'being' && o.ownerId === playerId && o.engaged && players[playerId].lifespan - o.card.lifespan > 0
  );

// How many real Beings `playerId` currently controls on the board — backs
// Immen Gorta's own "As an additional cost to summon, Sacrifice (2)
// Beings" gate/candidate pool.
const countOwnBeings = (board, playerId) =>
  Object.values(board).filter(o => o?.type === 'being' && o.ownerId === playerId).length;

// Same count, but an Animated Armament's own topmost entry (RULES.md >
// Keywords > Animated) also counts as a Being — By Teeth and Bounds' own
// three-way "more/less/tied Beings than your opponent" comparison is the
// one place in this file that needs this broader count; countOwnBeings
// above stays strict to real Beings everywhere else (e.g. Immen Gorta's
// own sacrifice-cost gate, which isn't asking "who has more board
// presence" the way this card is). Forward-references animatedTopEntry
// (defined further down this file) — safe, since neither function body
// runs until actually called, well after the whole module has loaded.
const countBeingsIncludingAnimated = (board, playerId) =>
  Object.values(board).filter(o =>
    o?.ownerId === playerId && (o.type === 'being' || animatedTopEntry(o))
  ).length;

// Samara Seed / Seed of Divinity ("Remove (N) Counters, Martyr: X") and
// Melting Clock ("Pay (N) Essence, Martyr: X") both gate their otherwise-
// unconditional Martyr behind a real additional cost — checked at offer
// time (graceful non-offer, same precedent as every other cost gate) and
// again in ACTIVATE_MARTYR itself.
// Planchette: "Being gains 'Martyr: X'." — a Being with no printed Martyr
// of its own still has one available while it shares a ground Relic's
// tile granting it (same "Beings may move across this" co-location
// Vadē Rah's own Engage ability reads). The Being's own printed Martyr
// always wins if it has one; the granted text is only ever a fallback.
const effectiveMartyr = (state, cellId, occupant) => {
  if (occupant.card.keywords?.martyr != null) return occupant.card.keywords.martyr;
  // Willing Sacrifice: "Until end of turn target Being gains: 'Martyr: X'"
  // — a temporary grant directly on the occupant itself (cleared at end of
  // turn, turn.js), distinct from Planchette's permanent groundRelic-based
  // grantedMartyr below.
  if (occupant.grantedMartyrUntilEndOfTurn != null) return occupant.grantedMartyrUntilEndOfTurn;
  const groundRelic = state.groundRelics[cellId];
  return groundRelic?.card.keywords?.grantedMartyr ?? null;
};

const martyrCostPayable = (occupant, pool) => {
  const counterCost = occupant.card.keywords?.martyrCounterCost;
  if (counterCost && (occupant.counters?.[counterCost.type] || 0) < counterCost.amount) return false;
  const effigyCost = occupant.card.keywords?.martyrEffigyCost;
  if (effigyCost && !canPayCost(pool, { faithless: 0, colored: { [effigyCost.color]: effigyCost.amount } })) return false;
  return true;
};

// Desperate Finale's own two-clause effect, once its target is settled
// (either auto-resolved or via RESOLVE_DESPERATE_FINALE_TARGET): pay the
// Lifespan cost, make the target attack via resolveAttackFrom (bypassing
// the normal engaged gate — this Being IS engaged, that's the whole
// point), then flag it for a delayed sacrifice, but only if it actually
// survived its own forced attack (resolveAttackFrom already sent it to
// Purgatory otherwise, via the normal death pipeline — nothing left to
// flag).
const resolveDesperateFinale = (state, playerId, cardName, cellId) => {
  const target = state.board[cellId];
  if (!target || target.type !== 'being') return { ...state, pendingChoice: null };
  const cost = target.card.lifespan;
  const owner = state.players[playerId];
  let next = {
    ...state,
    pendingChoice: null,
    players: { ...state.players, [playerId]: { ...owner, lifespan: owner.lifespan - cost } },
  };
  next = addLog(next, `${playerId} pays ${cost} Lifespan (${target.card.name}'s own Lifespan) for ${cardName}'s additional cost.`);
  const targetInstanceId = target.card.instanceId;
  next = resolveAttackFrom(next, playerId, cellId);
  if (next.board[cellId]?.card?.instanceId === targetInstanceId) {
    next = {
      ...next,
      board: { ...next.board, [cellId]: { ...next.board[cellId], sacrificeAtEndOfTurn: true } },
    };
    next = addLog(next, `${target.card.name} will be sacrificed at the end of the turn (${cardName}).`);
  }
  return next;
};

// "Target Non Deity Being loses all abilities until end of turn." (Drown
// out the Screams) — any Being (either owner), excluding Deities.
const DROWN_OUT_THE_SCREAMS_RE = /^Target Non ?Deity Being loses all abilities until end of turn/i;

// "Target Being loses all abilities and becomes a 0/5 TreeFolk Being until
// end of turn." (Dendrify) — any Being, no Deity exclusion this time.
const DENDRIFY_RE = /^Target Being loses all abilities and becomes a (\d+)\/(\d+) (\w+) Being until end of turn/i;

// "Until end of turn target Relic becomes a 1/1 Armament and Being, it can
// move any direction." (Animate) — same "target + apply a temporary
// transformation, revert at endTurn" shape as Drown out the Screams/
// Dendrify above, but the transformation itself is different: rather than
// stripping abilities, it literally grants the real "Animated" keyword
// (RULES.md > Keywords) on a synthetic Armament card, reusing the WHOLE
// existing Animated-Armament-acts-as-a-Being subsystem (movement, attack,
// getLegalActions' own scan) for free — see applyAnimate below. "Any
// direction" comes from giving that synthetic card all 8 printed arrows,
// the same geometry Divine Winds' own free move already walks.
const ANIMATE_RELIC_RE = /^Until end of turn target Relic becomes a (\d+)\/(\d+) Armament and Being,?\s*it can move any direction\.?$/i;

// "Deal (1) damage to each Being and your Lifespan, repeat for each Time
// Counter on a Prophecy that you control.\nNo damage is dealt from any
// Beings that die." (Equanimity) — only the mechanically meaningful first
// line is matched; the second line is pure reminder text for the "no
// death Lifespan loss" behavior baked directly into
// dealDamageToBeingNoDeathLoss (below), the same "only the first line is
// pattern-matched, the rest is inert reminder text" precedent used
// elsewhere in this file for other multi-line card texts.
const EQUANIMITY_RE = /^Deal\s*\(?1\)?\s+damage to each Being and your Lifespan,?\s*repeat for each Time Counter on an? Prophecy that you control\.?/i;

// "you may Summon a Demon, Imp or Null Being directly on this tile, when
// you do sacrifice Lesser Summoning Circles." (Lesser Summoning Circle's
// own Engage, after its own "Pay (5) Lifespan, Engage:" cost is stripped
// off by payLifespanEngageMatch — cardData.js) — captures the typing list
// as one free-text group, split into individual typings where it's
// resolved (see the LESSER_SUMMONING_CIRCLE_RE branch, below).
const LESSER_SUMMONING_CIRCLE_RE = /^you may Summon (?:an?\s+)?(.+?) Being directly on this tile,?\s*when you do sacrifice .+$/i;

// "Until the end of the turn whenever a Being you control loses a Favored
// Counter a different Being becomes Favored." (Return the Favor) — sets a
// PLAYER-scoped (not card-keyword-based) temporary flag,
// returnTheFavorUntilEndOfTurn, cleared for the turn player by endTurn
// (turn.js) same as every other until-end-of-turn effect. See
// triggerReturnTheFavorReaction below for where it's actually read.
const RETURN_THE_FAVOR_RE = /^Until the end of the turn,?\s*whenever a Being you control loses a Favou?red Counter,?\s*a different Being becomes Favou?red\.?$/i;

// "Each Player may move any number of Beings they control (in any
// direction), any Beings that move lose half their lifespan rounded up."
// (Diablerie) — see diablerieOfferMover/diablerieMoveAndDamage above.
const DIABLERIE_RE = /^Each Player may move any number of Beings they control\s*\(in any direction\),?\s*any Beings that move lose half their lifespan rounded up\.?$/i;

// Suppresses every printed ability an occupant's card carries (Engage,
// Martyr, static keywords, everything parseKeywords ever derived from its
// text box) for the rest of the turn, by swapping its own `card.keywords`
// out for an empty object — every existing keyword read in this file goes
// through `occupant.card.keywords?.X`, so this single choke point covers
// all of them without needing 20+ individual call sites touched. The
// original is stashed on `suppressedKeywords` so endTurn (turn.js) can
// restore it. Doesn't touch printed Arrows (a separate CSV column, not
// "text") or the card's typing/Strength/Lifespan — those are each their
// own field, handled by Dendrify's own stat/typing override where it
// applies.
const suppressAbilitiesUntilEndOfTurn = (occupant) => ({
  ...occupant,
  card: { ...occupant.card, keywords: {} },
  suppressedKeywords: occupant.suppressedKeywords || occupant.card.keywords,
});

// Wretched Remnants: "Once per turn when a Being you control dies you may
// have this Relic gain its effect(s) until end of turn." — ruled: copies
// the dying Being's WHOLE textBox (Depart, Martyr, Engage, a static bonus
// — everything parseKeywords would ever derive from it), not its own
// stats/typing/name. Swaps `card.keywords`/`card.textBox` the same
// single-choke-point way suppressAbilitiesUntilEndOfTurn above overwrites
// them — every existing keyword read in this file goes through
// `occupant.card.keywords?.X`, so nothing else needs touching for a
// borrowed ability to just work. The dying Being's own name is
// substituted for "this" first (selfReferentialWhenSummonedText, already
// used for the same reason on a Being's own When Summoned text) so a
// self-referential effect (e.g. "deal damage to Wounded Turanga") now
// correctly means whatever's currently carrying it, not the Being that
// died. The original card is stashed on `wretchedRemnantsOriginalCard` so
// endTurn (turn.js) can restore it.
const grantBorrowedTextBox = (occupant, dyingCard) => {
  const normalizedText = selfReferentialWhenSummonedText(dyingCard.textBox || '', dyingCard.name);
  return {
    ...occupant,
    wretchedRemnantsUsedThisTurn: true,
    wretchedRemnantsOriginalCard: occupant.wretchedRemnantsOriginalCard || occupant.card,
    card: { ...occupant.card, textBox: normalizedText, keywords: parseKeywords(normalizedText) },
  };
};

// Tiarlish Hunger: "When this moves into the Mortal Realm copy the
// effect(s) of target Being an opponent controls until the end of your
// next turn." — ruled to function like Wretched Remnants above (copies
// the target's WHOLE textBox, not just stats/typing/name), just with a
// longer, self-consuming expiry: `copiedEffectSkipNextClear` starts true
// the moment this is granted and gets consumed (flipped to false) the
// very next time endTurn's own cleanup runs for this occupant's owner —
// which, since the grant always happens mid-processing of the owner's OWN
// endTurn (a Shift return only ever fires on its controller's turn), is
// this same turn's cleanup pass. Only the SECOND time that owner's
// cleanup runs (their next real turn) does it actually clear — giving
// "survives the rest of this turn, the opponent's turn, and all of your
// next turn" for free, same self-consuming-flag philosophy
// doesNotDisengage (Instigator) already uses for its own "until your next
// turn" duration, just applied to a different field. See turn.js's
// endTurn for the other half.
const grantCopiedEffectUntilNextTurn = (occupant, targetCard) => ({
  ...occupant,
  copiedEffectSkipNextClear: true,
  copiedEffectOriginalCard: occupant.copiedEffectOriginalCard || occupant.card,
  card: { ...occupant.card, textBox: targetCard.textBox || '', keywords: parseKeywords(targetCard.textBox || '', targetCard.name) },
});

// The "you may" offer itself — one legal choice per eligible Wretched
// Remnants (not yet used this turn) `playerId` controls. If a
// pendingChoice is already claimed (e.g. by the dying Being's own Depart,
// resolved just before this runs) this is skipped with an honest log
// instead — same one-choice-at-a-time precedent logDepartIfPresent above
// already establishes; this engine tracks only one pendingChoice at a
// time, no queueing.
const triggerWretchedRemnantsOffer = (state, playerId, dyingCard) => {
  if (state.pendingChoice) return state;
  const candidates = Object.entries(state.board)
    .filter(([, o]) => o?.type === 'relic' && o.ownerId === playerId && o.card.keywords?.onOwnBeingDiedGainTextBox && !o.wretchedRemnantsUsedThisTurn)
    .map(([cell]) => cell);
  if (candidates.length === 0) return state;
  const next = addLog(state, `${dyingCard.name}'s death lets ${playerId} choose whether a Wretched Remnants gains its effect(s) until end of turn.`);
  return {
    ...next,
    pendingChoice: { kind: 'copy-textbox-until-end-of-turn', playerId, dyingCard, allowedCells: candidates, optional: true },
  };
};

// Animate: "Until end of turn target Relic becomes a 1/1 Armament and
// Being, it can move any direction." — converts the standalone Relic
// occupant into a real `armament-stack` with one Animated entry (RULES.md
// > Keywords > Animated already lets the topmost entry of a Being-less
// pile act as a Being — move and attack, via animatedTopEntry/
// freeMoveEligible/getLegalActions' own Animated scan — so this is free
// once the card itself carries `keywords.animated`). All 8 arrows grant
// "any direction" through that same existing movement scan, rather than
// needing new movement code. The original card/counters are stashed on
// the entry itself (animateOriginal) so endTurn (turn.js) can revert it
// back to a plain Relic. Simplification: if another real Armament gets
// attached to this same pile during the animated window (only reachable
// because Animate itself is what makes the Relic a legal attach target —
// a normal standalone Relic never is), the end-of-turn revert is skipped
// for that cell rather than trying to split one board cell into two
// occupants; a narrow edge case, documented rather than silently mishandled.
const applyAnimate = (state, cellId, newStrength, newLifespan, cardName, label) => {
  const occupant = state.board[cellId];
  const animatedCard = {
    ...occupant.card,
    typing: `${occupant.card.typing}, Armament`,
    strength: newStrength,
    lifespan: newLifespan,
    arrows: [1, 2, 3, 4, 5, 6, 7, 8],
    keywords: { ...occupant.card.keywords, animated: true },
  };
  const next = {
    ...state,
    board: {
      ...state.board,
      [cellId]: {
        type: 'armament-stack',
        ownerId: occupant.ownerId,
        armaments: [{
          card: animatedCard,
          engaged: !!occupant.engaged,
          animateOriginal: { card: occupant.card, counters: occupant.counters },
        }],
      },
    },
  };
  return addLog(next, `${cardName}'s ${label} animates ${occupant.card.name} into a ${newStrength}/${newLifespan} Armament and Being until end of turn.`);
};

// "Sacrifice a Being on a tile this points to." (Ferryman's Boat's own
// Engage, after its Crossing Counter cost is stripped off by
// counterCostEngageMatch) — same "tiles this points to" geometry
// SUMMON_TOKEN_ALL_POINTED_RE already uses (this card's own printed
// Arrows), just sacrificing whichever Being (either owner) sits there
// instead of placing a token.
const SACRIFICE_BEING_POINTED_RE = /^Sacrifice a Being on a tile this points to/i;
// Smite (own name substituted for "this" first, per the Prophecy flip
// resolver): "Destroy Being this points to (Opponent does not take
// lifespan damage from it dying)." — same "no death damage" ending
// destroyBeing already gives every other sacrifice/destroy effect, so the
// parenthetical needs no special handling at all.
const DESTROY_BEING_POINTED_RE = /^Destroy Being this points to\b/i;

// Midnight Mass: "Sacrifice target Being this points to: Invoke a Demon
// with equal Strength on a tile this points to." — "target" (not "a") means
// the player picks WHICH pointed Being when more than one exists, unlike
// SACRIFICE_BEING_POINTED_RE's own auto-pick shape above. The sacrificed
// Being's own live Strength (effectiveStrength, combat.js — whatever it
// actually is right now, bonuses included) becomes the invoked Demon's own
// permanent strengthOverride (see invokeCardOnto's own comment).
const MIDNIGHT_MASS_RE = /^Sacrifice target Being this points to:?\s*Invoke an?\s+(.+?) with equal Strength on a tile this points to\.?$/i;

// Legion's Onset: "Pay (X) Lifespan, then Summon a Vassal token, for every
// (5) Lifespan paid." — (X) is the caster's own free choice, resolved via
// the shared numeric-choice UI (see NUMERIC_CHOICE_KINDS, Match.jsx) already
// built for Blood Rites'/False Testament's own X/N pickers, just over
// Lifespan instead of Essence/Time Counters. Its own printed "then" needs
// protecting from the generic chained-clause splitter at the top of this
// function (see its own exclusion list) since the two halves are
// interdependent (the token count depends on how much was actually paid),
// not two independent clauses.
const LEGION_ONSET_RE = /^Pay\s*\(?X\)?\s+Lifespan,?\s*then Summon an? Vassal token,?\s*for every\s*\(?5\)?\s+Lifespan paid\.?$/i;

// "Sacrifice target Being you control." (Ritual Executioner) — the whole
// ability is the sacrifice itself (no colon, no further effect), unlike
// SACRIFICE_BEING_COST_RE's "Sacrifice a Being you control: <effect>" cost
// shape above.
const SACRIFICE_TARGET_OWN_BEING_RE = /^Sacrifice target Being you control\.?$/i;

// "Target a Being you don't control, then copy it's Engage ability."
// (Marionette Doll) — the copied ability's own extra costs (a Lifespan/
// counter cost, a condition) are deliberately not re-paid or re-checked;
// only its effect text is copied and resolved as Marionette Doll's own,
// the standard "copy the text, not the trigger" simplification (matches
// how a printed Engage's own extra-cost fields already only ever gate
// *offering* the original ability, never its effect text once reached).
const COPY_ENGAGE_RE = /^Target a Being you don'?t control,?\s*then copy it'?s Engage ability\.?$/i;

// "Trigger the Depart of a Being you control." (Skeleton Key) — see
// triggerDepartOfTarget for what "trigger" means: the target's own printed
// Depart text resolves, without the target actually dying.
const TRIGGER_DEPART_RE = /^Trigger the Depart of a Being you control\.?$/i;

// "Sacrifice this, <effect>" (Blooming Seed's own counterCostSacrificeAbility
// effect text, after "Remove (N) Growth Counter:" is stripped off as its
// cost) — a Martyr-shaped self-sacrifice-then-effect, generic over whatever
// follows so any future card using this exact phrasing is picked up too.
// Captures `selfArrows` from the board *before* sacrificing below (see its
// resolver branch) so a chained "on any tile this points to" clause still
// works after the caster itself is already gone from the board.
const SACRIFICE_THIS_THEN_RE = /^Sacrifice this,?\s*(.+)$/i;

// "sacrifice it" / "sacrifice this" with NOTHING else after it (Defective
// Demon's own onMove text, after self-name substitution: "When Defective
// Demon moves sacrifice it." becomes "sacrifice it.") — a bare self-
// sacrifice, no further effect, distinct from SACRIFICE_THIS_THEN_RE above
// (which requires trailing effect text). Real sacrifice, not death damage
// — no owner Lifespan loss, same "sacrifice" vs "dies" distinction every
// other sacrifice-as-a-cost effect in this file already follows
// (destroyBeing).
const SELF_SACRIFICE_BARE_RE = /^Sacrifice (?:this|it)\.?$/i;

// "Summon (N) <Name> token(s) ... on any tile this points to" (Blooming
// Seed's Blooming Vine Token) — unlike SUMMON_TOKEN_ALL_POINTED_RE (which
// places on *every* pointed tile with no choice), "any" here means the
// player picks *one* pointed tile among however many are legal, same
// choice-when-ambiguous precedent as every other pendingChoice in this
// file. Checked before the generic SUMMON_TOKEN_RE below, which would
// otherwise match the same prefix and default to "any empty tile you
// control" instead of honoring the pointed-tile restriction. The lazy
// `.*?` between the token name and the trailing anchor (rather than a
// `\([^)]*\)`-style parenthetical skip) is deliberate — Blooming Seed's own
// aside ("(0/3 Being - vine token with \"Engage: Add (1) Living\")") nests
// a second, unrelated "(1)" inside it, which a non-nesting `[^)]*` class
// would stop at prematurely; `.*?` just skips everything up to the known
// trailing phrase regardless of what's inside.
const SUMMON_TOKEN_POINTED_RE = /summon\s*\(?(\d+)?\)?\s*(?:an?\s+)?(.+?)\s+tokens?\b.*?\s+on (?:any|a) tile this points to/i;

// "Choose target Being this points to, it is returned to it's owner's hand,
// It's owner Crafts Effigies equal to its cost." (Recollect) — same "tiles
// this points to" arrow geometry as SACRIFICE_BEING_POINTED_RE above, but
// targeting either owner's Being (RULES.md doesn't restrict "target Being"
// to "you control" here), returning it to whoever actually owns it, and
// crafting Effigies for that same owner scaled by the returned card's own
// printed casting cost (totalCastingCost) rather than a fixed amount.
// Tolerant of both straight and curly ' (the real CSV text uses curly).
const RECOLLECT_RE = /^Choose target Being this points to,?\s*it is returned to it[’']?s owner[’']?s hand,?\s*it[’']?s owner Crafts Effigies equal to its cost/i;

// "Sacrifice a Being on this tile, then draw cards equal to it's
// Lifespan." (Claws of Onoushara — a "Beings may move across this"
// groundRelic, so "this tile" is its own cell, and any co-located Being
// there is unambiguous — no target choice needed at all). Matched whole
// (excluded from the generic then-split) since the draw count is read off
// the sacrificed Being's own printed Lifespan, not a number in the text.
const SACRIFICE_BEING_HERE_DRAW_LIFESPAN_RE = /^Sacrifice a Being on this tile,?\s*then draw cards equal to it'?s? Lifespan/i;

// "Sacrifice a TreeFolk, Vine, or Seed you control that costs (2) or
// less, then gain (5) Lifespan." (Pruning Sheers) — matched whole
// (excluded from the generic then-split) for the same reason
// SACRIFICE_ARMAMENT_DRAW_RE is: the sacrifice half can itself open a
// pendingChoice with more than one legal candidate.
const SACRIFICE_TYPED_COST_LIMIT_GAIN_LIFESPAN_RE = /^Sacrifice a (\w+),\s*(\w+),?\s*or (\w+) you control that costs\s*\(?(\d+)\)?\s+or less,?\s*then gain\s*\(?(\d+)\)?\s+Lifespan/i;

// "Sacrifice (X) Beings: Add (X) Shifting Essence where (X) is the number
// of Beings sacrificed." (Death's Howl) — the printed "(X)" is a variable,
// not a number, chosen by the player (any of their own Beings, including
// none at all) via a board-toggle-then-confirm choice, same shape as
// Cemetery Physician's own "sacrifice any number of <Name>"
// (sacrifice-x-toggle) but over any Being the player controls rather than
// one named card, and granting temporary Essence instead of summoning
// from Purgatory — different enough in both dimensions to warrant its own
// pendingChoice kind rather than generalizing that one further.
const SACRIFICE_X_BEINGS_ADD_ESSENCE_RE = /^Sacrifice \(X\) Beings:\s*Add \(X\)\s+(\w+)\s+Essence where \(X\) is the number of Beings sacrificed/i;

// "Discard (X) Bag o' Bones: Draw (X) Cards." (Deossification) — the hand
// equivalent of SACRIFICE_X_BEINGS_ADD_ESSENCE_RE above: a variable-count
// toggle-then-confirm choice, just over hand cards matching a printed
// name instead of board Beings, and drawing instead of granting Essence.
const DISCARD_X_NAMED_DRAW_RE = /^Discard \(X\)\s+(.+?):\s*Draw \(X\)\s+Cards?/i;

// "During the next Modulate Step, Time Counters are not removed." (Pause)
// — a one-shot flag on the whole game state (skipNextModulate), checked
// and consumed by beginTurn (turn.js) the next time it runs for EITHER
// player, since a Modulate Step happens at the start of whoever's turn is
// next, not specifically the caster's own.
const PAUSE_NEXT_MODULATE_RE = /^During the next Modulate Step,?\s*Time Counters are not removed/i;

// "<Typing>s you control disengage" (Cannibalize's own effect half) — a
// mass, unconditional disengage of every one of the caster's own Beings
// with the named typing.
const MASS_DISENGAGE_TYPING_RE = /^(\w+?)s?\s+you control disengage\b/i;

// "Sacrifice a Being you control: X" (My Body as a Shield) — a cost:effect
// colon pair like DISCARD_KIND_DRAW_RE, just paying with a Being sacrifice
// instead of a hand discard. Generic over whatever effect X is — once the
// cost is paid, X is recursed into resolveOrLogEffect same as any other
// text, so e.g. "Target being becomes Favored until end of turn" is
// already handled by TARGET_BECOME_FAVORED_TEMP_ANY_RE for free.
// Balance the Scales prints the cost without "you control" ("Sacrifice a
// Being:") — same meaning (the caster's own), tolerated as an alternate.
const SACRIFICE_BEING_COST_RE = /^Sacrifice a Being(?: you control)?:\s*(.+)$/i;

// "Sacrifice target Being add (2) Shifting Essence." (Martyrdom) — the
// same sacrifice-then-effect shape as SACRIFICE_BEING_COST_RE above, just
// missing the colon in the real printed text (no punctuation at all
// between the cost and the effect). "target Being" with no "you control"
// still means the caster's own, same convention every other sacrifice
// cost this session has followed (you can't pay a cost with something you
// don't control).
const SACRIFICE_TARGET_BEING_ADD_ESSENCE_RE = /^Sacrifice target Being,?\s*add\s*\(?(\d+)\)?\s+(\w+)\s+Essence/i;

// A direct Lifespan swing for the effect's own controller — not a Being
// taking damage, an adjustment to the player's own total (same kind of
// change the end-step pass cost or the draw-from-empty penalty already
// make). "Lose" and "take ... Lifespan Damage" are two real phrasings of
// the same loss (Thespian: "you lose (4) Lifespan"; Horological Horror:
// "you take (5) Lifespan Damage") — one pattern covers both.
// "Restore (N) Lifespan" (Priestly Practitioner) is the same self-gain as
// "Gain (N) Lifespan" whenever it's printed with no explicit target — the
// negative lookahead excludes Sanative Siphon's own differently-shaped
// "Restore (X) Lifespan to target" (a variable amount tied to a Counter
// spend, targeting someone else — not automated yet, handled separately).
const LIFESPAN_GAIN_RE = /\b(?:gain|restore)\s*\(?(\d+)\)?\s+Lifespan\b(?!\s+to target)/i;
const LIFESPAN_LOSE_RE = /(?:you )?(?:lose|take)\s*\(?(\d+)\)?\s+Lifespan(?:\s+Damage)?\b/i;
// Bare "Pay (N) Lifespan." with no attached effect (Illegible Grimoire's
// own coin-flip tails: "if tails Pay (3) Lifespan.") — strictly anchored
// start-and-end, unlike LIFESPAN_LOSE_RE above, so it never swallows a
// "Pay (N) Lifespan to X" shape that has a real effect attached.
const PAY_LIFESPAN_BARE_RE = /^Pay\s*\(?(\d+)\)?\s+Lifespan\.?$/i;

// "become Favored" (Favorite Son) — self-targeted, permanent (unlike
// IkVarem's differently-worded, temporary, other-targeted version below).
// Anchored to the start of the clause so it can't also match inside
// "target Being you control becomes Favored until end of turn".
const SELF_BECOME_FAVORED_RE = /^become Favored\b/i;
// "Gain +N/+N." as a bare self-effect (Saan tachīan Hunger: "Pay (2)
// Formless Essence: Gain +1/+1.", a repeatable Pay-cost ability) — a real,
// permanent, stacking stat gain via the same `permanentBonus` primitive
// triggerPermanentGrowthReactions already uses for a reactive growth
// trigger, applied once per activation instead of once per trigger.
const SELF_STAT_GAIN_RE = /^Gain\s*\+?(\d+)\/\+?(\d+)\.?$/i;
// "Deal (N) damage to all Beings." (Pangs of Hunger) — a real board wipe,
// either side, no "you control"/"opponent" qualifier printed (same
// symmetric-no-owner-check precedent Mouth of Madness/Terranean Gates
// already establish for a passive with no "you control").
const DAMAGE_ALL_BEINGS_RE = /^Deal\s*\(?(\d+)\)?\s+damage to all Beings\.?$/i;
// "...your opponent summons (1) Vassal token on any tile they control."
// (Erroneous Evocation, as the trailing half of a comma-joined compound
// with its own leading deck search) — a FORCED summon onto the opponent's
// own board, auto-placed (no choice offered, same precedent as every
// other no-choice mass token placement) since it isn't really the
// opponent's decision to make.
const OPPONENT_SUMMON_TOKEN_RE = /your opponent summons\s*\(?(\d+)?\)?\s*(?:an?\s+)?(.+?)\s+tokens? on any tile they control/i;
// "Discard a Spirit, add a Turanga to hand from your Purgatory." (Book of
// Mahatzu) — the discard is a real cost gating the search, not a second
// independent clause (same "matched as one whole pattern" precedent Tiny
// Forge Master's own sacrifice-then-draw already established).
const DISCARD_TYPED_SEARCH_PURGATORY_RE = /^Discard an?\s+(\w+),\s*add an?\s+(\w+) to hand from (?:your )?Purgatory\.?$/i;

// "target Being you control becomes Favored until end of turn" (IkVarem).
const TARGET_BECOME_FAVORED_TEMP_RE = /target Being you control becomes Favored until end of turn/i;

// "Target Being becomes Favored until end of turn" (Intervene) — no "you
// control", so either player's Being is a legal target, unlike IkVarem's
// own version above. Anchored so it can never also match that "you
// control" phrasing as a substring.
const TARGET_BECOME_FAVORED_TEMP_ANY_RE = /^target Being becomes Favored until end of turn/i;

// "Target Being becomes Favored." (One Above All) — permanent, not "until
// end of turn", and (same as Intervene) either player's Being. The
// negative lookahead keeps this from also matching the "until end of
// turn" variant above as a prefix.
const TARGET_BECOME_FAVORED_PERMANENT_RE = /^target Being becomes Favored\b(?! until end of turn)/i;

// "Target Familiar becomes Favored until end of turn." (Greenseer) — same
// shape as TARGET_BECOME_FAVORED_TEMP_ANY_RE above, just restricted to a
// printed typing word instead of a bare "Being". The negative lookahead
// keeps this from also matching that "Being" case as "typing === Being" —
// TARGET_BECOME_FAVORED_TEMP_ANY_RE already owns that one.
const TARGET_TYPED_BECOME_FAVORED_TEMP_RE = /^target (?!Being\b)(\w+) becomes Favored until end of turn/i;

// "Target Being you control becomes Favored." (Careless IkVarem) —
// permanent, unlike IkVarem's own "you control" + "until end of turn"
// combo above. The negative lookahead keeps this from also matching that
// temporary variant as a prefix.
const TARGET_BECOME_FAVORED_PERMANENT_OWN_RE = /^target Being you control becomes Favored\b(?! until end of turn)/i;

// "All Beings become Favored until end of turn" (Fleeting Auspice) — a
// mass grant, no target choice needed at all.
const ALL_BEINGS_FAVORED_RE = /All Beings become Favored until end of turn/i;

// "reveal the top of your deck, if it is a Seed Being add it to hand"
// (Farm hand) — deterministic, no choice: peek, check typing, move if it
// matches. The typing word ("Seed") is captured generically so a future
// card phrased the same way with a different typing works too.
const REVEAL_TOP_SEED_RE = /reveal the top of your deck,?\s*if it is a\s+(\w+)\s+Being,?\s*add it to hand/i;

// "reveal the top card of each deck, the player who has the lowest/highest
// cost card draws it. If it is tied each player draws." (Humble/Pompous
// Contrarian).
const CONTRARIAN_RE = /reveal the top card of each deck.*?(lowest|highest) cost card draws it/i;

// "you may pay (N) Lifespan to give a different <typing> you control
// +S/+L" (Lamtukka Gentleman) — the typing phrase is captured generically
// (split on "or"/"and") so a differently-typed future card works too.
const BUFF_ALLY_RE = /you may pay\s*\(?(\d+)\)?\s+Lifespan to give a different\s+(.+?)\s+you control\s*([+-]\d+)\/([+-]\d+)/i;

// "give a different <Typing> you control +S/+L" with NO Lifespan-cost
// prefix (Ounati Hunger's own "When this moves into the Mortal Realm give
// a different Hunger you control +1/+1.") — a mandatory grant, unlike
// BUFF_ALLY_RE's optional paid one above; checked separately since it
// can't reuse that pendingChoice's own always-`optional: true` shape.
const GIVE_DIFFERENT_TYPED_BUFF_RE = /give a different\s+(.+?)\s+you control\s*([+-]\d+)\/([+-]\d+)/i;

// "Target Being an opponent controls Shifts (X)." (Chains of the Unbound's
// own Martyr) — forces an opponent's Being to Shift by a printed amount of
// THIS card's own, regardless of whether the target has Shift printed on
// it at all — see performShift's own `shiftOverride` param, actions.js.
const FORCE_OPPONENT_SHIFT_RE = /^Target Being an opponent controls Shifts\s*\(?(\d+)\)?\.?$/i;
// "<own name> Shifts (N)." (Locust swarm's own Depart: "Locust Swarm
// Shifts (3).") — logDepartIfPresent substitutes the card's own printed
// name for "this" first (selfReferentialWhenSummonedText, same as
// whenSummoned/onMove already do), so this only ever needs to match "this".
const SELF_SHIFT_RE = /^this Shifts\s*\(?(\d+)\)?\.?$/i;

// "copy the effect(s) of target Being an opponent controls until the end
// of your next turn." (Tiarlish Hunger, fired from its own
// onMovedIntoMortalRealm) — see grantCopiedEffectUntilNextTurn above.
const COPY_OPPONENT_EFFECT_UNTIL_NEXT_TURN_RE = /^copy the effect\(s\) of target Being an opponent controls until the end of your next turn\.?$/i;

// Údarik Hunger: "Engage: Target Being you control Shifts (1), then loses
// (1) Time Counter; if it moves into the Mortal Realm this turn Disengage
// it. This ability can not target a Being named Udarik Hunger." — matched
// as one whole unit (its own "then" is the immediate follow-up decrement,
// not two independently-resolved clauses — same reasoning
// TARGET_EFFIGY_ENGAGE_ADD_ESSENCE_RE's own exclusion documents). The
// trailing "can not target a Being named X" sentence isn't captured here
// — the resolver below always excludes same-name candidates for this
// shape, which is what that sentence means for any card.
const UDARIK_FORCE_SHIFT_THEN_LOSE_RE = /^Target Being you control Shifts\s*\(?(\d+)\)?,?\s*then loses\s*\(?(\d+)\)?\s+Time Counters?;?\s*if it moves into the Mortal Realm this turn Disengage it\.?/i;

// "You may pay (N) Lifespan to X" (Vassal Matriach) — generic optional-cost
// wrapper; see its own resolver branch below for why BUFF_ALLY_RE's more
// specific shape above is excluded.
const MAY_PAY_LIFESPAN_RE = /you may pay\s*\(?(\d+)\)?\s+Lifespan to\s+(.+?)(?:\n|$)/i;

// "you may sacrifice this and <effect>" (Oracle of Eonia: "Reveal the top
// card of your deck, then you may sacrifice this and draw a card.") — same
// generic optional-cost-wrapper treatment as MAY_PAY_LIFESPAN_RE above,
// just costed by self-sacrifice instead of Lifespan. Distinct from
// SACRIFICE_THIS_THEN_RE (a mandatory cost, no "you may", no Decline).
const MAY_SACRIFICE_THIS_AND_RE = /you may sacrifice this and\s+(.+?)(?:\n|$)/i;

// "you may target a Prophecy and reveal it" (Vaticinator) — reveal-only,
// no state change (Prophecies are always modeled face-down already).
const REVEAL_PROPHECY_RE = /you may target a Prophecy and reveal it/i;

// "Destroy a/an Prophecy/Relic" (Blasphemy, Desecration) — a whole board
// occupant, either player's, sent to Purgatory (RULES.md > Zones:
// "destroyed Relics/Altars — all of it" goes there). Deliberately doesn't
// share `sacrificeOccupantAt` (used for paying a sacrifice *cost*, e.g.
// Osteomancer/Cemetery Physician), which was built and tested without
// adding to Purgatory — changing that now would be a real behavior change
// to already-shipped mechanics, so this is its own small helper instead
// (see destroyPermanentAt, below) even though the two look similar.
const DESTROY_OCCUPANT_RE = /Destroy an? (Prophecy|Relic)\b/i;

// "Destroy an Armament" (Convenient Corrosion) — targets one specific
// Armament entry anywhere on the board (attached to a Being, or sitting in
// a freestanding pile), not a whole occupant.
const DESTROY_ARMAMENT_RE = /Destroy an Armament\b/i;

// "you may sacrifice a Prophecy you control, then destroy target non
// Deity Being" (Cro-āsik Hunger — the real CSV misspells it "Diety", so
// both spellings are matched). Matched as one whole clause: both halves
// are this ONE optional ability, so — like ARMAMENT_COUNTER_MOVE_RE — it
// needs to be excluded from the top-of-function "then"-split guard below,
// or its own internal "then" would get split apart from the cost it
// belongs to.
const SACRIFICE_PROPHECY_DESTROY_RE = /you may sacrifice a Prophecy you control,?\s*then destroy target non\s+(?:Deity|Diety) Being/i;

// "sacrifice an Armament, then draw (N) card(s)" (Tiny Forge Master, Forge
// Master — Forge Master's own text spells the count out as "one" instead
// of a digit) / "Sacrifice an Armament: Draw (N) card(s)" (Seasoned Forge
// Master's own colon-costed phrasing, same shape, different separator) — a
// required cost gating a real effect, not two independent clauses: without
// this being matched as one whole pattern (like SACRIFICE_PROPHECY_DESTROY_RE
// above), the generic "then"-split would resolve "sacrifice an Armament" on
// its own (unrecognized, a no-op) and "draw (N) card(s)" on its own (matched
// by DRAW_CARDS_RE, unconditionally) — a free draw with no cost ever paid.
// This exact failure mode is what Seasoned Forge Master's own text hit
// before the colon-form and word-number count were added here: its cost
// was silently dropped and it drew for free. Also needs to be checked
// *before* DRAW_CARDS_RE's own check below, since that pattern isn't
// anchored and would otherwise match "draw (1) card" as a bare substring
// of this same text first.
const SACRIFICE_ARMAMENT_DRAW_RE = /sacrifice an Armament,?\s*(?:then\s+draw|:\s*Draw)\s*\(?(\d+|an?|one|two|three|four|five)\)?\s+cards?/i;

// "Sacrifice an Armament, then deal damage equal to it's total cost to any
// target." (Scrap Shot) — same shape as SACRIFICE_ARMAMENT_DRAW_RE above,
// just a different follow-up effect (built as text and recursed through
// resolveOrLogEffect at resolve time, once the sacrificed Armament's own
// cost is known — see DAMAGE_ANY_TARGET_RE, already generic over any
// amount).
const SACRIFICE_ARMAMENT_DAMAGE_RE = /Sacrifice an Armament,?\s*then deal damage equal to (?:it'?s?|its) total cost to any target/i;

// "target opponent sacrifices a Being but takes no Lifespan damage from
// it" (Venefica) — the *opponent* chooses which of their own Beings to
// lose; Match.jsx already anticipates a pendingChoice belonging to a
// player outside their own turn (see its humanCanAct comment), so this
// needs no new UI plumbing beyond its own modal.
// Balance the Scales prints "Each opponent sacrifices a Being" (a
// 2-player-game synonym for "target opponent" — there's only ever one).
const OPPONENT_SACRIFICE_RE = /(?:target|each) opponent sacrifices a Being/i;

// "engage target non Deity Being, until the start of your next turn it
// gains "This does not disengage during Disengage Step"" (Instigator).
const DOESNT_DISENGAGE_RE = /engage target non Deity Being.*?does not disengage during Disengage Step/i;

// "you may engage a non Deity Being in the Mortal Realm until your next
// turn" (Distant Debator) — the same engage+doesNotDisengage mechanism as
// Instigator's own DOESNT_DISENGAGE_RE above, just optional ("you may")
// and differently worded. Every Being is already in the Mortal Realm —
// RULES.md: Beings never enter the Ethereal Realm — so "in the Mortal
// Realm" is non-restrictive here, not a real filter.
const DISTANT_DEBATOR_ENGAGE_RE = /you may engage a non Deity Being in the Mortal Realm until your next turn/i;

// "this Being's Strength and Lifespan becomes equal to target Being you
// control" (Thespian). Its separate "When this Being dies you lose (4)
// Lifespan" clause is a distinct, non-"When Summoned" death trigger this
// doesn't cover — a documented gap (RULES.md), not a bug.
const COPY_STATS_RE = /this Being's Strength and Lifespan becomes equal to target Being you control/i;

// "look at the top card of your deck, then you may shuffle or put it back
// on top" (Inquisitive Prodigy).
const SHUFFLE_OR_KEEP_RE = /look at the top card of your deck,?\s*then you may shuffle or put it back on top/i;

// "Look at the top (X) cards of your deck where (X) is the number of
// Undead in your Purgatory, then put them back in any order you like or
// shuffle." (Read the Bones) — the real choice (leave alone, or shuffle)
// reuses the exact same 'shuffle-or-keep' mechanism SHUFFLE_OR_KEEP_RE
// resolves to; its own "shuffle" branch already shuffles the WHOLE deck,
// not just the revealed top cards, so X only changes how many cards are
// named in the reveal log, never the mechanism itself. "In any order you
// like" collapses to the same "leave as is" option "put it back on top"
// already is (this engine has no per-card free-reordering UI) — the same
// simplification LOOK_TOP_NO_OP_RE (Seeress) already established for a
// fixed-order look, just with a real shuffle branch still offered here.
const READ_THE_BONES_RE = /Look at the top\s*\(?X\)?\s+cards? of your deck where\s*\(?X\)?\s+is the number of\s+(\w+) in your Purgatory,?\s*then put them back in any order you like or shuffle/i;

// "Look at the top card of an opponent's deck. You may have them shuffle."
// (Foresight). Witching Well's tails clause phrases the same thing as
// "your opponents deck" instead of "an opponent's deck".
const LOOK_OPPONENT_TOP_MAY_SHUFFLE_RE = /Look at the top card of (?:an?|your) opponents?'?s?\s*deck[.,]?\s*you may have them shuffle/i;

// "look at the top (N) cards of your deck, return them in the same order"
// (Seeress) — a no-op (the order is unchanged either way), so this is
// log-only, matching REVEAL_TOP_RE's precedent.
const LOOK_TOP_NO_OP_RE = /look at the top\s*\(?(\d+)?\)?\s+cards? of your deck,?\s*return them in the same order/i;

// "put (1) card from hand on the bottom of deck" (Weaver, second clause
// after its own "draw (2) cards, then ..." — the existing then-split
// handles the chaining, so this only ever needs to resolve on its own).
const BOTTOM_OF_DECK_RE = /put\s*\(?(\d+)\)?\s+card from hand on the bottom of deck/i;

// "Discard a <Kind>: Draw (N) cards" (Scrap Removal: "Discard a Relic:
// Draw (2) cards.") — a colon-separated cost:effect on a Conjuring, not a
// "then"-chained pair, so the generic then-split doesn't see it and the
// bare DRAW_CARDS_RE below would otherwise match the effect half alone and
// grant the draw without requiring the discard. Checked before
// DRAW_CARDS_RE. Candidates are the player's OWN hand cards of the given
// kind (the card doing the discarding has already left hand for Purgatory
// by the time CAST_CONJURING calls this resolver, so it's never its own
// candidate).
const DISCARD_KIND_DRAW_RE = /^Discard an?\s+(\w+):\s*Draw\s*\(?(\d+|one|two|three|four|five)\)?\s+cards?\.?$/i;
// "Discard a <Typing>, then draw (N) card(s)." (Onagīous Hunger's real
// printed text: "Engage: Discard a Hunger, then draw (1) card.") — matched
// as ONE whole pattern, excluded from the generic "then"-split below
// (same precedent as MOVE_OWN_THEN_OPPONENT_RE and friends): the discard
// half can open a real pendingChoice with 2+ matching cards, and the
// generic split has no way to defer the draw until AFTER that choice
// resolves — it would just run the draw immediately on the not-yet-
// reduced hand, so with 2+ candidates the draw fired before the discard
// choice was ever made (and could even offer discarding the very card
// just drawn). Handled as its own branch below, storing `drawCount` on
// the SAME 'discard-typed' pendingChoice the plain DISCARD_TYPED_RE below
// already uses, so RESOLVE_DISCARD_TYPED can do the draw once the discard
// actually completes.
const DISCARD_TYPED_THEN_DRAW_RE = /^Discard an?\s+(\w+),?\s+then\s+draw\s*\(?(\d+|one|two|three|four|five)\)?\s+cards?\.?$/i;
// "Discard a <Typing>." with no attached draw (Skeptical Scrawling-style
// "then"-split leftover halves that DON'T need the draw-continuation
// above — anything already caught by DISCARD_TYPED_THEN_DRAW_RE never
// reaches here, since it's checked first).
const DISCARD_TYPED_RE = /^Discard an?\s+(\w+)\.?$/i;
// Bare "Discard (1) Card." (Skeptical Scrawling, as one half of a
// "then"-split) — no "at random" (DISCARD_RANDOM_RE) and no typing
// filter (DISCARD_TYPED_RE above): the player's own choice of which card.
const DISCARD_ONE_CARD_RE = /^Discard\s*\(?1\)?\s+Cards?\.?$/i;
// "return a <Typing/Name> from Purgatory to hand" (Skeptical Scrawling) —
// the reverse word order of SEARCH_FROM_PURGATORY_RE's own "Add X to hand
// from Purgatory", functionally identical (same searchZoneCandidates
// query, same 'search' pendingChoice).
const RETURN_TYPED_FROM_PURGATORY_RE = /^return an?\s+(.+?)\s+from (?:your )?Purgatory to hand\.?$/i;
// "Discard (1) Card, then return a Null Being From Purgatory to hand."
// (Skeptical Scrawling) — matched as one whole unit, same
// "the discard is a real cost gating the second clause" precedent as
// DISCARD_TYPED_SEARCH_PURGATORY_RE (Book of Mahatzu) above, just with an
// untyped discard (any one card, not filtered by typing — same candidate
// set as plain DISCARD_ONE_CARD_RE) instead of a typed one. Without this,
// the generic then-split resolves DISCARD_ONE_CARD_RE and
// RETURN_TYPED_FROM_PURGATORY_RE as two independent clauses — the return
// firing unconditionally even when the hand was empty and nothing was
// actually discarded.
const DISCARD_ONE_CARD_THEN_RETURN_PURGATORY_RE = /^Discard\s*\(?1\)?\s+Cards?,?\s*then return an?\s+(.+?)\s+from (?:your )?Purgatory to hand\.?$/i;
// "Discard your hand then draw cards equal to the number of cards that
// you discarded." (Seasons of Regrowth) — no choice needed (the whole
// hand goes), so this is one self-contained pattern rather than a
// discard-then-draw split.
const DISCARD_HAND_DRAW_EQUAL_RE = /^Discard your hand,?\s*then draw cards equal to the number of cards that you discarded\.?$/i;
// Rejuvinating Waters / Festival of Monatssa: "Gain (N) Lifespan for each
// <Typing list> you control." / "Draw (1) Card for each Being you control
// with <Keyword>." — a flat effect (Lifespan gain or card draw) scaled by
// how many of the player's own Beings match a typing list or carry a
// keyword, generalized over both since the counting logic is identical.
const LIFESPAN_GAIN_PER_TYPING_RE = /^Gain\s*\(?(\d+)\)?\s+Lifespan for each\s+(.+?)\s+you control\.?$/i;
const DRAW_PER_KEYWORD_RE = /^Draw\s*\(?(\d+|one)\)?\s+Cards? for each Being you control with\s+(\w+)\.?$/i;
// "Discard a Being: Draw one card. If you discarded a Turanga draw one
// additional card." (For the Greater Good) — same discard-then-draw shape
// as DISCARD_KIND_DRAW_RE, plus a bonus draw conditioned on the specific
// card discarded (checked after the fact, not part of the candidate
// filter — any Being is a legal discard, the bonus just doesn't apply for
// most of them).
const DISCARD_BEING_DRAW_BONUS_RE = /^Discard an?\s+Being:\s*Draw\s*(?:\(?1\)?|one)\s+cards?\.\s*If you discarded an?\s+(\w+)\s+draw\s*(?:\(?1\)?|one)\s+additional cards?\.?$/i;

// "Relic" as a discard-cost kind (Scrap removal: "Discard a Relic: Draw
// (2) cards.") means any card typed as a Relic at all — RULES.md > Card
// types recognizes "Relic, Armament" (card.kind === 'relic-armament') and
// "Relic, Being" (card.kind === 'being' with card.isRelicBeing) as real
// Relics too, not just the bare 'relic' kind — same widening as
// gatherRelicTargets/Desecration above, just over hand cards instead of
// board occupants. Every other discard kind (Being, Conjuring, ...) still
// matches its own card.kind exactly.
const matchesDiscardKind = (card, kind) =>
  kind === 'relic'
    ? card.kind === 'relic' || card.kind === 'relic-armament' || (card.kind === 'being' && card.isRelicBeing)
    : card.kind === kind;

// Distinct from matchesDiscardKind above, which matches the engine's own
// structural `card.kind` (being/relic/conjuring/...). A card discard
// filtered by a printed creature TYPING word instead (Onagīous Hunger's
// "Discard a Hunger", Book of Mahatzu's "Discard a Spirit") needs to check
// `card.typing` — a "Hunger" card is still `kind: 'being'`.
const matchesDiscardTyping = (card, typing) => (card.typing || '').toLowerCase().includes(typing.toLowerCase());

// "Shuffle (N) cards into deck from your Purgatory ... or draw (M) Cards"
// (MetaToris) — a mandatory (no "you may") either/or between two fixed,
// differently-sized options. The "(can not target MetaToris)" parenthetical
// is a dead clause here (a just-summoned Being can't already be in its own
// controller's Purgatory) and is safely ignored rather than specially coded.
const SHUFFLE_OR_DRAW_RE = /Shuffle\s*\(?(\d+)\)?\s+cards? into deck from your Purgatory.*?or draw\s*\(?(\d+)\)?\s+[Cc]ards?/i;

// "Restore (N) Lifespan or Summon (M) Blooming Vine tokens (...)." (Elderflower
// Ancient) — same mandatory either/or shape as SHUFFLE_OR_DRAW_RE above.
// No trailing anchor: the rest of the real text is a parenthetical
// describing the Blooming Vine Token, including a nested, unrelated "(1)"
// inside its own quoted "Engage: Add (1) Living" — the same nested-parens
// situation SUMMON_TOKEN_POINTED_RE's own comment already documents — so
// this simply doesn't try to match past "tokens", rather than fight it.
const RESTORE_LIFESPAN_OR_SUMMON_VINE_RE = /^Restore\s*\(?(\d+)\)?\s+Lifespan or Summon\s*\(?(\d+)\)?\s+Blooming Vine tokens?\b/i;

// A few real Beings name themselves in their own When Summoned text instead
// of saying "this" (e.g. Wounded Turanga: "deal (2) Damage to Wounded
// Turanga") — substituted for "this" before the text reaches
// resolveOrLogEffect so the existing SELF_DAMAGE_RE path picks it up
// unchanged, rather than teaching every self-referential pattern to also
// recognize a card's own printed name.
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const selfReferentialWhenSummonedText = (text, cardName) => {
  return text.replace(new RegExp(escapeRegExp(cardName), 'gi'), 'this');
};

// -- Token creation ----------------------------------------------------

// A fixed catalog of the real set's named tokens, rather than trying to
// parse arbitrary printed reminder-text grammar (the real CSV phrases each
// token's inline spec differently — "1 cost Relic - Martyr.", "Cost 2
// Bleeding - Relic - Armament- Animated Being gains +1/+1", "0/3 Being -
// vine token with 'Engage: Add (1) Living'" — no single pattern covers all
// of them safely). Adding a new token is a new registry entry, not a new
// parser rule. Keyed by lowercase name; `createTokenCard` (cardData.js)
// builds a full, real, playable card from each spec, parsing its own
// `textBox` through the exact same `parseKeywords` every printed card uses.
const TOKEN_REGISTRY = {
  "bag o' bones": () => createTokenCard({ name: "Bag o' Bones", typing: 'Relic, Token', effigyCost: '1', textBox: 'Martyr' }),
  'snake skin': () => createTokenCard({ name: 'Snake Skin', typing: 'Relic, Armament, Token', effigyCost: '1', textBox: 'Being gains +0/+2' }),
  'cursed cutlass': () => createTokenCard({ name: 'Cursed Cutlass', typing: 'Relic, Armament, Token', effigyCost: '2 Bleeding', textBox: 'Animated Being gains +1/+1' }),
  // Real printed token's own typing (public/default-card-set.csv row 452:
  // "Being, Vine, Token") — was missing "Vine" here, which silently broke
  // any typing-based match against it (e.g. Roots of Eternity's own "sacrifice
  // a Vine token" ability). Its own row also prints Arrows "1" — like every
  // other Being token below, createTokenCard used to have no `arrows` param
  // at all, so every token silently came out immobile regardless of what its
  // real card actually prints; now fixed at the source (createTokenCard), so
  // each entry here just needs its own real printed Arrows value passed through.
  'vine': () => createTokenCard({ name: 'Vine', typing: 'Being, Vine, Token', strength: 0, lifespan: 2, arrows: '1' }),
  'shifting sands': () => createTokenCard({
    name: 'Shifting Sands', typing: 'Relic, Token', effigyCost: '1 Shifting',
    textBox: 'When summoned gain (2) Crossing Counters.\nEngage: Remove (1) Crossing Counter, then move target Being you control to this tile.\nBeings may move across Shifting Sands.',
  }),
  // A plain 2/2 vanilla Being, no ability of its own (Vassal Matriach/
  // Vassal Vessel/Erroneous Evocation/Legion's Onset all just say "Summon
  // a Vassal token"). Typing follows the real printed (non-token) "Vassal"
  // card (public/default-card-set.csv row 210: "Demon, Being") rather than
  // the token's own row (448: "Being, Token", missing "Demon") — confirmed
  // with the user that "Demon" stays on the token too; the CSV's own token
  // row is the one that's inconsistent, not this entry.
  'vassal': () => createTokenCard({ name: 'Vassal', typing: 'Demon, Being, Token', effigyCost: '2 Formless', strength: 2, lifespan: 2, arrows: '1, 7' }),
  // Afterimage's own real printed token (public/default-card-set.csv row
  // 462) — its own dedicated row prints only the sacrifice-at-zero
  // trigger, not "When Summoned gain (2) Time Counters" (that line lives
  // in Afterimage-the-Conjuring's own reminder text describing it, not on
  // the token's own row), so the starting counters are applied explicitly
  // wherever this token is actually placed (see triggerOnMoveReaction),
  // not baked into textBox here.
  'afterimage': () => createTokenCard({ name: 'AfterImage', typing: 'Being, Temporal, Token', strength: 0, lifespan: 3, textBox: 'When this Being has (0) Time Counters on it, sacrifice it.' }),
  // Real printed token (Blooming Seed's own summon effect — see
  // counterCostSacrificeAbility, cardData.js): 0/3, with its own real
  // "Engage: Add (1) Living" ability (parsed off its textBox the same as
  // any other card, so `keywords.engage` fires for real — see
  // ADD_EFFIGY_RE below).
  'blooming vine': () => createTokenCard({ name: 'Blooming Vine Token', typing: 'Vine, Being, Token', strength: 0, lifespan: 3, textBox: 'Engage: Add (1) Living Essence', arrows: '1' }),
  // Real printed token (public/default-card-set.csv row 463) — a plain 1/1
  // vanilla Being, no ability of its own (Hoarder's own "Each time this
  // moves create a Rat token on the tile it moved from." is the only real
  // card that creates one).
  'rat': () => createTokenCard({ name: 'Rat', typing: 'Being, Rat, Familiar, Token', effigyCost: '1 Living', strength: 1, lifespan: 1, arrows: '1' }),
  // Real printed card's own stats (public/default-card-set.csv row 125),
  // generated straight as a token by Skeptic's own Depart — confirmed with
  // the user this is really meant to create a fresh token, not search the
  // deck for the one printed copy.
  'passing doubt': () => createTokenCard({
    name: 'Passing Doubt', typing: 'Null, Being, Token', effigyCost: '2 Faithless', strength: 2, lifespan: 2,
    textBox: 'At the end of your turn target Doubt you control is dealt (1) Lifespan Damage',
    arrows: '2, 8',
  }),
  // Crathea's own printed reminder text (public/default-card-set.csv row
  // 231): "0 cost - Divine Prophecy - 3T" — a face-up Prophecy token, 3
  // starting Time Counters (createTokenCard's own `timer` param — see
  // placeTokenOnBoard's new 'prophecy' branch), its aura read live by
  // recomputeBoardWideAuraBonuses for as long as it stays face-up with Time
  // Counters left.
  'blooming life': () => createTokenCard({ name: 'Blooming Life', typing: 'Divine, Prophecy, Token', timer: 3, textBox: 'Beings you control have +1/+1.' }),
  'withering life': () => createTokenCard({ name: 'Withering Life', typing: 'Divine, Prophecy, Token', timer: 3, textBox: "Beings you don't control have -1/-1." }),
  // Real printed token's own stats (public/default-card-set.csv row 449) —
  // the SAME textBox as the real card (Scā-vuhk Hunger's own "sacrifice
  // this and create (2) Scā-vuhk Hunger tokens" makes more of itself,
  // tokens included), so a token created this way can keep chaining the
  // same Shift/self-sacrifice behavior a real copy would.
  "scā-vuhk hunger": () => createTokenCard({
    name: 'Scā-vuhk Hunger', typing: 'Being, Hunger, Token', strength: 0, lifespan: 3,
    textBox: 'Shift (1): "At the end of your turn remove (1) Time Counter from this"\nWhen this moves into the Mortal Realm, sacrifice this and create (2) Scā-vuhk Hunger tokens.',
    arrows: '1',
  }),
};

// Places a freshly created token card at `cellId` — dispatches by the
// token's own kind the same way SUMMON_BEING/PLACE_RELIC/ATTACH_ARMAMENT
// each place their own kind, since a token can be any of them. Assumes
// the cell is already known to be a legal destination for this kind (see
// emptyMortalCellsFor below) — this only writes the occupant.
const placeTokenOnBoard = (state, playerId, tokenCard, cellId) => {
  const waiting = state.board[cellId];
  if (tokenCard.kind === 'relic-armament') {
    const armaments = [...(waiting?.armaments || []), { card: tokenCard, engaged: false }];
    return { ...state, board: { ...state.board, [cellId]: { type: 'armament-stack', ownerId: playerId, armaments } } };
  }
  if (tokenCard.kind === 'relic') {
    const counterGrant = tokenCard.keywords?.armamentCounterGrant;
    const relicOccupant = {
      type: 'relic', ownerId: playerId, card: tokenCard,
      ...(counterGrant ? { counters: { [counterGrant.type]: counterGrant.amount } } : {}),
    };
    // "Beings may move across this" (Shifting Sands) — see createInitialState's
    // own comment on groundRelics for why this lives outside `board`.
    return tokenCard.keywords?.beingsMayMoveAcross
      ? { ...state, groundRelics: { ...state.groundRelics, [cellId]: relicOccupant } }
      : { ...state, board: { ...state.board, [cellId]: relicOccupant } };
  }
  // Crathea: "create a face up Blooming Life token... or a face up
  // Withering Life token..." — unlike a normally-CAST Prophecy
  // (PLAY_PROPHECY), a created-face-up token starts face-up with its full
  // printed Time Counters already on it (createTokenCard's own `timer`
  // param), not face-down waiting to flip.
  if (tokenCard.kind === 'prophecy') {
    return { ...state, board: { ...state.board, [cellId]: { type: 'prophecy', ownerId: playerId, card: tokenCard, timer: tokenCard.timerMax, faceDown: false } } };
  }
  // Being (the only other kind any current token uses).
  const next = {
    ...state,
    board: {
      ...state.board,
      [cellId]: {
        type: 'being',
        ownerId: playerId,
        card: tokenCard,
        currentLifespan: tokenCard.lifespan,
        engaged: !tokenCard.keywords?.persist,
        favorCounter: !!tokenCard.keywords?.favored,
        ...(waiting ? { armaments: waiting.armaments } : {}),
      },
    },
  };
  // A token Being still counts as "a Being summoned under your control" for
  // any OTHER Being's own reaction to that (Greenseer's assistant: "When a
  // Familiar is summoned under your control, draw (1) card" — a token like
  // Rat, typed "Being, Rat, Familiar, Token", triggers it exactly the same
  // as a real one drawn from hand would). Every other placeBeingOnBoard-only
  // trigger (whenSummoned, the legend rule, etc.) stays out of scope here —
  // no current token prints any of those, so there's nothing yet to wire.
  return triggerTypedSummonReactions(next, playerId, cellId, tokenCard);
};

// Empty Mortal Realm cells `playerId` controls — the default destination
// for a "summon a token" effect that doesn't name an explicit tile (most
// of them: Bone collector, Cookie, Ditch Digger "Steve" all just say
// "summon a Bag o' Bones token", no location).
const emptyMortalCellsFor = (board, playerId) => mortalCellsFor(playerId).filter(c => !board[c]);

// Every cell geometrically adjacent to `fromCellId` (all 8 neighbors),
// restricted to the Mortal Realm — plain grid adjacency, unlike
// computeMoveDestination's arrow/orientation-gated movement (Crawling
// Growth's own "adjacent" isn't a move, so it isn't arrow-restricted).
const adjacentCells = (fromCellId) => {
  const { row, col } = parseCellId(fromCellId);
  const cells = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = row + dr;
      const c = col + dc;
      if (r < 1 || r > ROWS || c < 1 || c > COLS || !isMortalRealm(r)) continue;
      cells.push(cellId(r, c));
    }
  }
  return cells;
};

// "Summon a/an <Name> token" — looked up in TOKEN_REGISTRY by name; a name
// not in the registry logs the same honest "isn't automated yet" fallback
// as any other unrecognized effect, rather than silently doing nothing.
// "on this tile" (context.selfCellId) is the one explicit location this
// covers so far (e.g. Cobra's Depart) — everything else defaults to an
// empty Mortal Realm cell the player controls (offering a choice when more
// than one is legal). Arrow-based "points to" targeting (the Vine tokens'
// usual real destination) isn't covered yet — same gap as Green thumbed
// Gardener (RULES.md > Keywords).
const SUMMON_TOKEN_ON_TILE_RE = /summon\s*(?:\(?\d+\)?)?\s*an?\s+(.+?)\s+tokens?\b(?:\s*\([^)]*\))?\s+on this tile/i;

// "create a Rat token on the tile it moved from" (Hoarder's own onMove
// reaction — see MOVE_OR_ATTACK's move branch, which fires this with
// `context.movedFromCellId` set to the cell just vacated). Distinct from
// "on this tile" above (context.selfCellId, the mover's *new* cell) —
// Hoarder's token lands where it moved *from*, not where it landed.
const CREATE_TOKEN_MOVED_FROM_RE = /create an?\s+(.+?)\s+tokens?\b(?:\s*\([^)]*\))?\s+on the tile it moved from/i;

// "Summon (1) 0/2 Vine token on the tile it moved from." (Imneyat Dryad's
// own onMove) — same moved-from destination as CREATE_TOKEN_MOVED_FROM_RE
// above, but printed with "Summon" instead of "create" and a literal "0/2"
// stat block between the count and the token name, same "0/2 Vine" fixed
// literal precedent every other Vine-token regex above uses (its own
// dedicated shape, rather than trying to generalize the "create" regex to
// also tolerate a stat block for every other token name too).
const SUMMON_VINE_MOVED_FROM_RE = /Summon\s*\(?\d+\)?\s+0\/2 Vine tokens? on the tile it moved from/i;

// Crathea: "create a face up Blooming Life token (0 cost - Divine Prophecy
// - 3T "...") or a Withering Life token (0 cost - Divine Prophecy - 3T -
// "...")." — a choice between two named tokens, each parenthetical's own
// reminder text tolerated inline (`[^)]*`, same as SUMMON_TOKEN_RE's own
// trailing-parenthetical handling). Both current uses are face-up Prophecy
// tokens (RESOLVE_CREATE_TOKEN_CHOICE places into the Ethereal Realm when
// TOKEN_REGISTRY says 'prophecy', Mortal otherwise, so this is reusable for
// a future Being/Relic-token version of the same "choose one of two"
// shape too).
const CREATE_TOKEN_CHOICE_RE = /^create a face up\s+(.+?)\s+tokens?\b(?:\s*\([^)]*\))?\s*or an?\s+(.+?)\s+tokens?\b(?:\s*\([^)]*\))?\.?$/i;
// "Summon a/an <Name> token on all tiles this points to" (Al khali the
// Empty) — Arrow-based targeting, resolved the same way a Being's own
// arrows already are (RULES.md's Combat/movement section): reusing
// `computeMoveDestination(ownerId, fromCellId, dir)` unchanged, starting
// from the Prophecy's own Ethereal Realm cell instead of a Mortal Realm
// one. That function's existing owner-relative sign convention already
// means direction 1 (12 o'clock/forward) lands on the *opponent's* front
// row and direction 5 (6 o'clock/backward) on the *controller's* — exactly
// the orientation a face-up Prophecy resolves under — so no new geometry
// was needed, just applying the existing one from a new starting cell.
// Checked before the more general SUMMON_TOKEN_RE below, same reason as
// SUMMON_TOKEN_ON_TILE_RE above.
export const SUMMON_TOKEN_ALL_POINTED_RE = /summon\s*(?:\(?\d+\)?)?\s*an?\s+(.+?)\s+tokens?\b(?:\s*\([^)]*\))?\s+on all tiles this points to/i;
// "Summon (N) <Name> tokens" (Vassal Matriach: "Summon (2) Vassal tokens")
// has no "a"/"an" at all (plural, counted instead) — unlike every other
// SUMMON_TOKEN_* pattern above, so both the article and the count are
// optional here, with the count captured (group 1) instead of discarded,
// defaulting to 1 when absent (the common "Summon a <Name> token" case).
// "create" is used interchangeably with "summon" elsewhere in this same
// CSV for an identical token-placement shape (Hoarder's own "create a Rat
// token on the tile it moved from"; Crathea's own "create a face up...
// token") — Scā-vuhk Hunger's own "sacrifice this and create (2) Scā-vuhk
// Hunger tokens" needed the same tolerance here, on the generic catch-all,
// not just the two bespoke patterns above that already had it.
const SUMMON_TOKEN_RE = /(?:summon|create)\s*\(?(\d+)?\)?\s*(?:an?\s+)?(.+?)\s+tokens?\b(?:\s*\([^)]*\))?/i;
// "Add a/an <Name> token to hand" (Grave robber) — a token that goes
// straight to hand instead of onto the board.
const ADD_TOKEN_TO_HAND_RE = /add an?\s+(.+?)\s+tokens?\b(?:\s*\([^)]*\))?\s+to hand/i;

// "Add a/an <Name> to hand" with no "token" word and no "from deck"/"from
// your Purgatory" qualifier at all (Skeptic: "Add a Passing Doubt to
// hand.") — confirmed with the user this really does mean generating a
// token directly in hand, not searching the deck for a printed copy, even
// though the CSV doesn't spell "token" out here (unlike Grave robber's own
// otherwise-identical phrasing). Anchored to the whole line so it never
// collides with ADD_TOKEN_TO_HAND_RE above or the "from deck"/"from your
// Purgatory" search patterns, which all have more text after "to hand".
const ADD_NAMED_TOKEN_TO_HAND_BARE_RE = /^Add an?\s+(.+?)\s+to hand\.?$/i;

// Whether an Altar's conjure cost (if any) can actually be paid right now.
// Mill/discard degrade gracefully (see MILL_RE/DISCARD_RANDOM_RE above) so
// they never block placement; a damage-to-target cost genuinely can't be
// paid without a legal target, so — unlike those — it does.
const altarConjureCostPayable = (board, playerId, card) => {
  const cost = card.keywords?.conjureCost;
  if (!cost) return true;
  const text = stripFlavorText(cost);
  const damageMatch = text && text.match(DAMAGE_TARGET_RE);
  if (!damageMatch) return true;
  return beingsOfTypingOwnedBy(board, playerId, damageMatch[2]).length > 0;
};

// By Teeth and Bounds's own "more Beings" branch — shared by its own
// condition-gated line match (BY_TEETH_AND_BOUNDS_MORE_RE, below) and its
// "tied: choose one" tie-break (the 'teeth-bounds-tie-choice' pendingChoice,
// resolved unconditionally once the player has already picked it).
const applyByTeethAndBoundsMore = (state, playerId, cardName, label, context) => {
  const hungerCandidates = Object.entries(state.board).filter(([, o]) =>
    o?.type === 'being' && o.ownerId === playerId && (o.card.typing || '').toLowerCase().includes('hunger'));
  if (hungerCandidates.length === 0) {
    return addLog(state, `${cardName}'s ${label} finds no Hunger of ${playerId}'s to sacrifice — Immen Gorta isn't added.`);
  }
  const doSacrifice = (st, cellId) => {
    const sacrificedName = st.board[cellId].card.name;
    let next = addLog(st, `${playerId} sacrifices ${sacrificedName} for ${cardName}'s ${label}.`);
    next = destroyBeing(next, cellId);
    return resolveOrLogEffect(next, playerId, cardName, 'Add Immen Gorta from deck to hand.', label, context);
  };
  if (hungerCandidates.length === 1) return doSacrifice(state, hungerCandidates[0][0]);
  const next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Hunger to sacrifice.`);
  return { ...next, pendingChoice: { kind: 'teeth-bounds-sacrifice-hunger', playerId, cardName, label, context } };
};

// By Teeth and Bounds's own "less Beings" branch — same sharing reason as
// applyByTeethAndBoundsMore above.
const applyByTeethAndBoundsLess = (state, playerId, cardName, label) => {
  const { state: next, drawnCount } = drawCardsFor(state, playerId, 2);
  return addLog(next, `${cardName}'s ${label} draws ${drawnCount} card(s) for ${playerId}.`);
};

// Resolves a card-text effect where possible (currently: "Add X to/from hand
// from/to deck" searches, and "Modulate (±X)"), and otherwise falls back to
// logging that it fired without executing it — the same honest scope
// boundary Depart/Martyr/Conjurings have always had (see RULES.md >
// Keywords). `rawText` is the free-text payload to interpret (a captured
// keyword's trailing text, or a whole Conjuring's Text Box); flavor text is
// stripped first so quoted prose is never mistaken for an instruction.
export const resolveOrLogEffect = (state, playerId, cardName, rawText, label, context = {}) => {
  const text = stripFlavorText(rawText);
  if (!text) return state;

  // Chained clauses ("X, then Y" / "X then Y" — e.g. Rhak-tùrin Zealot:
  // "Add (1) Bleeding Essence then deal (1) Damage to this.", or
  // Darmah-Triya Bracers: "Deal (2) Damage to this, then add (1) Bleeding
  // Essence.") are split apart and each resolved independently in order,
  // threading state through. Checked before any single-pattern match below
  // — otherwise an earlier pattern matching just a *substring* of the whole
  // chained text (e.g. "add ... Essence" inside a longer sentence) would
  // return immediately and silently swallow a real second clause, the same
  // bug this replaces. The exceptions are ARMAMENT_COUNTER_MOVE_RE,
  // SACRIFICE_PROPHECY_DESTROY_RE, SHUFFLE_OR_KEEP_RE,
  // SACRIFICE_ARMAMENT_DRAW_RE, RELIC_COUNTER_MOVE_RE, and
  // MOVE_OWN_THEN_OPPONENT_RE (below), which each deliberately span their
  // own "then" and need the whole, unsplit text to match — checked first
  // so none of them is broken apart by this (ENGAGE_TARGET_MOVE_TWICE_RE
  // below joins this list for the same reason — its own "then" is the
  // literal second move, resolved via continueMoveThen's `sameActor`
  // continuation once the first move actually lands, not by splitting the
  // text). MOVE_OWN_THEN_OPPONENT_RE in
  // particular can't be split the generic way at all: its first clause can
  // itself open a pendingChoice (multiple legal Beings to move), and the
  // generic split would run the second clause immediately after — before
  // that choice is ever resolved — so it uses its own explicit `then`
  // continuation (moveOrOfferFreeMove/startMoveSequence) instead.
  if (!ARMAMENT_COUNTER_MOVE_RE.test(text) && !SACRIFICE_PROPHECY_DESTROY_RE.test(text) && !SHUFFLE_OR_KEEP_RE.test(text)
    && !SACRIFICE_ARMAMENT_DRAW_RE.test(text) && !RELIC_COUNTER_MOVE_RE.test(text) && !MOVE_OWN_THEN_OPPONENT_RE.test(text)
    && !SHUFFLE_HAND_DRAW_HALF_RE.test(text) && !SACRIFICE_ARMAMENT_DAMAGE_RE.test(text) && !REVEAL_TOP_SEED_TO_HAND_SHUFFLE_RE.test(text)
    && !TEMPLE_OF_DUBIETY_RE.test(text) && !SACRIFICE_BEING_HERE_DRAW_LIFESPAN_RE.test(text)
    && !SACRIFICE_TYPED_COST_LIMIT_GAIN_LIFESPAN_RE.test(text) && !COPY_ENGAGE_RE.test(text) && !INVOKE_NAMED_RE.test(text)
    && !ENGAGE_TARGET_MOVE_TWICE_RE.test(text) && !TIME_CAPSULE_MODULATE_REPEAT_RE.test(text) && !READ_THE_BONES_RE.test(text)
    // TARGET_EFFIGY_ENGAGE_ADD_ESSENCE_RE (Effigial Conservator) joins the
    // same list — its own "then" is the granted Essence's color depending
    // on whichever Effigy pip gets chosen by the FIRST clause, so it can't
    // be split into two independently-resolved clauses either.
    && !TARGET_EFFIGY_ENGAGE_ADD_ESSENCE_RE.test(text)
    // UDARIK_FORCE_SHIFT_THEN_LOSE_RE (Údarik Hunger) joins the same list
    // for the same reason — its own "then" is the immediate follow-up
    // decrement on the SAME freshly-shifted Prophecy the first clause just
    // created, not a second independent effect.
    && !UDARIK_FORCE_SHIFT_THEN_LOSE_RE.test(text)
    // DISCARD_HAND_DRAW_EQUAL_RE (Seasons of Regrowth) joins the same
    // list — its own "then" separates a discard from a draw count that's
    // read off how many were JUST discarded, so it can't be split into two
    // independently-resolved clauses either.
    && !DISCARD_HAND_DRAW_EQUAL_RE.test(text)
    // DISCARD_TYPED_THEN_DRAW_RE (Onagīous Hunger) joins the same list —
    // see its own comment above: the discard half can defer to a real
    // pendingChoice, and the draw must wait for that choice to actually
    // resolve, not fire immediately.
    && !DISCARD_TYPED_THEN_DRAW_RE.test(text)
    // DAMAGE_THEN_MOVE_ARMAMENT_HERE_RE (Brick) joins the same list — its
    // own "then" is a move to wherever the damage just landed, which needs
    // the same target settled by both halves, not two independent clauses.
    && !DAMAGE_THEN_MOVE_ARMAMENT_HERE_RE.test(text)
    // SACRIFICE_NAMED_REVEAL_TOP_RELICS_RE (Shovel) joins the same list —
    // its own "then" is a reveal that only happens after the named
    // Armament is actually sacrificed.
    && !SACRIFICE_NAMED_REVEAL_TOP_RELICS_RE.test(text)
    // IF_NONE_MOVE_RETURN_RE (Tactical Withdraw) joins the same list — its
    // own "then" is the SAME sentence's own condition-then-effect, not two
    // independent clauses; splitting it breaks both halves (neither
    // "If no Beings move" nor "each player may return a Being they control
    // to their hand." matches anything on its own).
    && !IF_NONE_MOVE_RETURN_RE.test(text)
    // BY_TEETH_AND_BOUNDS_MORE_RE (By Teeth and Bounds) joins the same
    // list — its own "then" is the sacrifice-and-search combo, only ever
    // applied together once the line's own "If you control more Beings..."
    // condition holds, not two independent clauses.
    && !BY_TEETH_AND_BOUNDS_MORE_RE.test(text)
    // LEGION_ONSET_RE (Legion's Onset) joins the same list — its own "then"
    // separates a Lifespan payment from a token count that depends on how
    // much of it was actually paid, not two independent clauses.
    && !LEGION_ONSET_RE.test(text)
    // DISCARD_ONE_CARD_THEN_RETURN_PURGATORY_RE (Skeptical Scrawling) joins
    // the same list — see its own comment above: the discard can defer to
    // a real pendingChoice (2+ cards in hand), and the Purgatory return
    // must wait for that choice to actually resolve, not fire immediately
    // regardless of whether anything was discarded.
    && !DISCARD_ONE_CARD_THEN_RETURN_PURGATORY_RE.test(text)) {
    const clauses = text.split(/\s*,?\s+then\s+/i);
    if (clauses.length > 1) {
      return clauses.reduce((acc, clause) => resolveOrLogEffect(acc, playerId, cardName, clause, label, context), state);
    }
  }

  // "If you control a Prophecy, X" — strip and recurse on the remainder
  // (see PROPHECY_CONDITION_PREFIX_RE above).
  const prophecyCondMatch = text.match(PROPHECY_CONDITION_PREFIX_RE);
  if (prophecyCondMatch) {
    if (!hasOwnProphecy(state.board, playerId)) {
      return addLog(state, `${cardName}'s ${label} has no Prophecy of ${playerId}'s to satisfy its condition.`);
    }
    return resolveOrLogEffect(state, playerId, cardName, text.slice(prophecyCondMatch[0].length), label, context);
  }

  // Propagate: "If you control a TreeFolk, draw (1) Card.\nIf you control a
  // Vine, add a TreeFollk to hand from your Purgatory.\nIf you control both
  // you may do both." — a whole Conjuring's textBox is resolved as ONE
  // string (CAST_CONJURING passes card.textBox straight through, unlike a
  // Prophecy's own flip-trigger which resolves one line at a time), so
  // without this, whichever generic pattern matches first anywhere in the
  // combined text wins regardless of which line's own condition it belongs
  // to (the same ordering hazard fixed elsewhere in this file, just across
  // lines instead of within one). Bespoke to this card's own two-condition
  // shape rather than a generic newline split, which risks wrongly
  // splitting other cards' genuinely-linked multi-line text. Both
  // conditions are independently checked (matching the printed "If you
  // control both you may do both." — there's nothing exclusive to enforce),
  // and the CSV's own "TreeFollk" typo is tolerated inline.
  const propagateMatch = text.match(/^If you control an?\s+(\w+),\s*(.+?)\.\s*\n\s*If you control an?\s+(\w+),\s*(.+?)\.\s*(?:\n.*)?$/is);
  if (propagateMatch) {
    const [, typing1, effect1, typing2, effect2raw] = propagateMatch;
    const effect2 = effect2raw.replace(/TreeFollk/i, 'TreeFolk');
    let next = state;
    if (hasOwnTyping(next.board, playerId, typing1)) {
      next = resolveOrLogEffect(next, playerId, cardName, `${effect1}.`, label, context);
    }
    if (hasOwnTyping(next.board, playerId, typing2)) {
      next = resolveOrLogEffect(next, playerId, cardName, `${effect2}.`, label, context);
    }
    return next;
  }

  // Engrave: "Beings you control gain 'Depart: Summon a Bag o' Bones
  // token'." — a one-time grant (this is an Ethereal Conjuring, resolved
  // once when cast, not a continuous aura) applied directly onto every
  // Being the caster controls RIGHT NOW; a Being summoned afterward never
  // sees it, matching the printed present-tense "gain" rather than a
  // standing rule. See logDepartIfPresent's own grantedDepart fallback.
  const grantDepartAllMatch = text.match(/^Beings you control gain:?\s*"?Depart:?\s*(.+?)"?\.?$/i);
  if (grantDepartAllMatch) {
    const departText = grantDepartAllMatch[1].trim();
    const targets = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && o.ownerId === playerId);
    if (targets.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being of ${playerId}'s to grant Depart to.`);
    }
    let next = targets.reduce((s, [cell, o]) => ({ ...s, board: { ...s.board, [cell]: { ...o, grantedDepart: departText } } }), state);
    return addLog(next, `${cardName}'s ${label} gives ${targets.length} Being(s) "Depart: ${departText}".`);
  }

  // Armor Animus: "Martyr: Being this is attatched to gains 'Depart:
  // Summon this in the Mortal Realm engaged'." — a single-target version of
  // Engrave's grant above, fired from ACTIVATE_ARMAMENT_MARTYR (this
  // Armament's own Martyr, engaged and sacrificed independently of its
  // wearer) with context.selfCellId already pointed at the WEARER's own
  // cell, not the Armament's (it has none of its own — it lives inside the
  // wearer's `armaments` array). The CSV's own "attatched" typo tolerated
  // inline.
  const grantDepartWearerMatch = text.match(/^Being this is attat?ched to gains:?\s*"?Depart:?\s*(.+?)"?\.?$/i);
  if (grantDepartWearerMatch && context.selfCellId && state.board[context.selfCellId]) {
    const departText = grantDepartWearerMatch[1].trim();
    const occ = state.board[context.selfCellId];
    // ACTIVATE_ARMAMENT_MARTYR's own getLegalActions offer (and reducer
    // case) deliberately allow this Martyr to fire from a freestanding
    // (Being-less) armament-stack too — Martyr itself doesn't require a
    // wearer — but THIS specific granted text ("Being this is attached to
    // gains...") only means something when there actually is one. No wearer
    // is a real, reachable case (attach the Armament to an empty tile, then
    // Martyr it there), not just a defensive check.
    if (occ.type !== 'being') {
      return addLog(state, `${cardName}'s ${label} has no attached Being to grant "Depart: ${departText}" to.`);
    }
    const next = { ...state, board: { ...state.board, [context.selfCellId]: { ...occ, grantedDepart: departText } } };
    return addLog(next, `${cardName}'s ${label} gives ${occ.card.name} "Depart: ${departText}".`);
  }

  // Armor Animus's own granted "Depart: Summon this in the Mortal Realm
  // engaged." — by the time a Depart resolves, the dying Being is already
  // in Purgatory (dealDamageToBeing/destroyBeing send it there before
  // logDepartIfPresent ever runs), so it's found there by name — same
  // "pull the just-departed card back out of Purgatory" precedent Locust
  // swarm's own Depart-triggered Shift already established, just summoned
  // normally instead of shifted.
  const selfResummonMortalMatch = /^Summon this in the Mortal Realm engaged\.?$/i.test(text);
  if (selfResummonMortalMatch) {
    const found = state.players[playerId].purgatory.find(c => c.name === cardName);
    if (!found) return addLog(state, `${cardName}'s ${label} isn't automated yet: "${text}"`);
    const candidates = emptyMortalCellsFor(state.board, playerId);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no empty tile of ${playerId}'s to summon on.`);
    }
    if (candidates.length === 1) {
      const purgatory = state.players[playerId].purgatory.filter(c => c.instanceId !== found.instanceId);
      const purged = { ...state, players: { ...state.players, [playerId]: { ...state.players[playerId], purgatory } } };
      let next = placeBeingOnBoard(purged, playerId, candidates[0], found);
      const occ = next.board[candidates[0]];
      next = { ...next, board: { ...next.board, [candidates[0]]: { ...occ, engaged: true } } };
      return addLog(next, `${cardName}'s ${label} summons ${found.name} back onto the Mortal Realm, engaged.`);
    }
    // Left in Purgatory until a tile is actually chosen — RESOLVE_TOKEN_LOCATION's
    // own purgatoryInstanceId handling does the find-and-remove itself (same
    // precedent Cemetery Physician's own variable-X summon already
    // established), so this must NOT pre-remove it here.
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a tile to summon ${found.name} on.`);
    return { ...next, pendingChoice: { kind: 'token-location', playerId, cardName, purgatoryInstanceId: found.instanceId, forceEngaged: true } };
  }

  // Natures Bounty: "TreeFolk, Vine, and Seeds you control gain: 'Engage:
  // add (1) Living'." — same one-time-grant-onto-current-Beings shape as
  // Engrave above, just filtered to a list of typings instead of every
  // Being, and granting Engage instead of Depart (see effectiveEngage's own
  // grantedEngage fallback).
  const grantEngageTypingGroupMatch = text.match(/^(.+?) you control gain:?\s*"?Engage:?\s*(.+?)"?\.?$/i);
  if (grantEngageTypingGroupMatch) {
    const typings = parseTypingGroup(grantEngageTypingGroupMatch[1]);
    const engageText = grantEngageTypingGroupMatch[2].trim();
    const targets = Object.entries(state.board).filter(([, o]) =>
      o?.type === 'being' && o.ownerId === playerId && cardMatchesTypingGroup(o.card, typings)
    );
    if (targets.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no matching Being of ${playerId}'s to grant Engage to.`);
    }
    let next = targets.reduce((s, [cell, o]) => ({ ...s, board: { ...s.board, [cell]: { ...o, grantedEngage: engageText } } }), state);
    return addLog(next, `${cardName}'s ${label} gives ${targets.length} Being(s) "Engage: ${engageText}".`);
  }

  // Willing Sacrifice: "Until end of turn target Being gains: 'Martyr:
  // Craft (1) Effigy'." — no "you control" in the printed text, so either
  // player's Being is a legal target (see effectiveMartyr's own
  // grantedMartyrUntilEndOfTurn fallback, cleared at end of turn by
  // turn.js).
  const grantMartyrTargetMatch = text.match(/^Until end of turn target Being gains:?\s*"?Mar?tyr:?\s*(.+?)"?\.?$/i);
  if (grantMartyrTargetMatch) {
    const martyrText = grantMartyrTargetMatch[1].trim();
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being');
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being to target.`);
    }
    const applyTo = (st, cellId) => {
      const occ = st.board[cellId];
      let n = { ...st, board: { ...st.board, [cellId]: { ...occ, grantedMartyrUntilEndOfTurn: martyrText } } };
      return addLog(n, `${cardName}'s ${label} gives ${occ.card.name} "Martyr: ${martyrText}" until end of turn.`);
    };
    if (candidates.length === 1) return applyTo(state, candidates[0][0]);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to target.`);
    return { ...next, pendingChoice: { kind: 'grant-martyr-target', playerId, cardName, label, martyrText } };
  }

  // Afterimage: "Whenever target Being moves this turn, summon an
  // Afterimage token on the tile it moved from." — grants a temporary,
  // until-end-of-turn "watch" flag onto the target (either owner, no "you
  // control" printed), read by triggerOnMoveReaction (shared by every
  // move-application site in this file) independently of the mover's own
  // printed onMove keyword, so both can fire off the same move. The flag's
  // own value is the CASTER's playerId (not just a boolean) since the
  // created token belongs to whoever cast Afterimage, not the mover's own
  // controller. Cleared at end of turn (turn.js), same either-owner
  // unconditional treatment as every other "until end of turn" grant.
  if (/^Whenever target Being moves this turn,?\s*summon an Afterimage token on the tile it moved from\.?/i.test(text)) {
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being');
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being to target.`);
    }
    const applyWatch = (st, cellId) => {
      const occ = st.board[cellId];
      let n = { ...st, board: { ...st.board, [cellId]: { ...occ, afterimageWatchOwnerId: playerId } } };
      return addLog(n, `${cardName}'s ${label} watches ${occ.card.name}'s movement for the rest of the turn.`);
    };
    if (candidates.length === 1) return applyWatch(state, candidates[0][0]);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to target.`);
    return { ...next, pendingChoice: { kind: 'afterimage-target', playerId, cardName, label } };
  }

  // Delectable Deviant: "Hungers you control gain +1/+0 until the end of
  // your turn." — same typing-group board scan as the Engage-grant pattern
  // above (grantEngageTypingGroupMatch), applying a numeric
  // statBonusUntilEndOfTurn bump (Boknean Wine's own primitive, combat.js)
  // to every matching Being at once instead of a single target, cleared by
  // endTurn the same way. Requires a numeric "+S/+L" grant, so it can't
  // accidentally match Natures Bounty's own "gain: 'Engage: ...'" shape.
  const typedGroupTempStatBuffMatch = text.match(/^(.+?) you control gain\s*\+?(\d+)\/\+?(\d+) until the end of (?:your|the) turn\.?$/i);
  if (typedGroupTempStatBuffMatch) {
    const typings = parseTypingGroup(typedGroupTempStatBuffMatch[1]);
    const strengthBonus = parseInt(typedGroupTempStatBuffMatch[2], 10);
    const lifespanBonus = parseInt(typedGroupTempStatBuffMatch[3], 10);
    const targets = Object.entries(state.board).filter(([, o]) =>
      o?.type === 'being' && o.ownerId === playerId && cardMatchesTypingGroup(o.card, typings)
    );
    if (targets.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no matching Being of ${playerId}'s to buff.`);
    }
    const next = targets.reduce((s, [cell, o]) => {
      const existing = o.statBonusUntilEndOfTurn || { strength: 0, lifespan: 0 };
      return { ...s, board: { ...s.board, [cell]: { ...o, statBonusUntilEndOfTurn: { strength: existing.strength + strengthBonus, lifespan: existing.lifespan + lifespanBonus } } } };
    }, state);
    return addLog(next, `${cardName}'s ${label} gives ${targets.length} Being(s) +${strengthBonus}/+${lifespanBonus} until end of turn.`);
  }

  // HeartWood Locket: "Until end of turn attached Being gains: 'Damage
  // dealt to this Being is dealt directly to it's controller instead'." —
  // an attached-Armament Martyr (Armor Animus precedent), so `context.
  // selfCellId` already points at the WEARER's own cell. Sets a simple flag
  // read at the single damage choke point every Being-damage source already
  // goes through (dealDamageToBeing, below) — redirecting straight to the
  // controller's own Lifespan instead of the Being's, with no death/Depart
  // cascade since the Being itself never takes the hit. Cleared by endTurn
  // (turn.js), same either-owner unconditional treatment as every other
  // "until end of turn" grant.
  const damageRedirectMatch = /^Until end of turn attached Being gains:?\s*"?Damage dealt to this Being is dealt directly to it'?s controller instead"?\.?$/i.test(text);
  if (damageRedirectMatch && context.selfCellId && state.board[context.selfCellId]) {
    const occ = state.board[context.selfCellId];
    const next = { ...state, board: { ...state.board, [context.selfCellId]: { ...occ, damageRedirectToController: true } } };
    return addLog(next, `${cardName}'s ${label} makes damage dealt to ${actorView(occ)?.card?.name || cardName} go directly to its controller instead, until end of turn.`);
  }

  // By Teeth and Bounds's three condition-gated lines (see
  // BY_TEETH_AND_BOUNDS_MORE_RE's own comment for why each is its own
  // self-contained branch instead of one combined multi-line pattern).
  if (BY_TEETH_AND_BOUNDS_MORE_RE.test(text)) {
    const oppId = opponentOf(playerId);
    const ownBeings = countBeingsIncludingAnimated(state.board, playerId);
    const oppBeings = countBeingsIncludingAnimated(state.board, oppId);
    if (ownBeings <= oppBeings) return state; // this line's own condition isn't met — no-op, not an automation gap
    return applyByTeethAndBoundsMore(state, playerId, cardName, label, context);
  }
  if (BY_TEETH_AND_BOUNDS_LESS_RE.test(text)) {
    const oppId = opponentOf(playerId);
    const ownBeings = countBeingsIncludingAnimated(state.board, playerId);
    const oppBeings = countBeingsIncludingAnimated(state.board, oppId);
    if (ownBeings >= oppBeings) return state;
    return applyByTeethAndBoundsLess(state, playerId, cardName, label);
  }
  if (BY_TEETH_AND_BOUNDS_TIE_RE.test(text)) {
    const oppId = opponentOf(playerId);
    const ownBeings = countBeingsIncludingAnimated(state.board, playerId);
    const oppBeings = countBeingsIncludingAnimated(state.board, oppId);
    if (ownBeings !== oppBeings) return state;
    const next = addLog(state, `${cardName}'s ${label}: it's tied — ${playerId} chooses.`);
    return { ...next, pendingChoice: { kind: 'teeth-bounds-tie-choice', playerId, cardName, label, context } };
  }

  // Collapsing Bridge: "Engage: Remove (1) Crossing Counter, you may summon
  // a Being on a tile that Collapsing Bridge points to." — its own Engage
  // text isn't pre-substituted with "this" the way Depart/a Prophecy's own
  // flip-trigger lines are (see ACTIVATE_ENGAGE), so this matches the
  // card's own printed name directly alongside "this" for any future card
  // that prints the same shape correctly. The pointed tile still costs the
  // normal summoning cost — this only widens WHERE, not whether that cost
  // is paid — so it opens the same hand-Being-choice pendingChoice any
  // future "you may summon a Being on a tile X points to" card can reuse.
  const removeCounterMaySummonPointedMatch = text.match(new RegExp(
    `^Remove\\s*\\(?(\\d+)\\)?\\s+(\\w+)\\s+Counters?,?\\s*you may summon an?\\s+Being on a tile(?: that)?\\s+(?:this|${escapeRegExp(cardName)})\\s+points to\\.?$`, 'i'
  ));
  if (removeCounterMaySummonPointedMatch && context.selfCellId && state.board[context.selfCellId]) {
    const spend = parseInt(removeCounterMaySummonPointedMatch[1], 10);
    const counterType = removeCounterMaySummonPointedMatch[2].toLowerCase();
    const occupant = state.board[context.selfCellId];
    const have = occupant.counters?.[counterType] || 0;
    if (have < spend) {
      return addLog(state, `${cardName}'s ${label} has no ${counterType} Counters left to spend.`);
    }
    let next = {
      ...state,
      board: { ...state.board, [context.selfCellId]: { ...occupant, counters: { ...occupant.counters, [counterType]: have - spend } } },
    };
    next = addLog(next, `${cardName}'s ${label} spends ${spend} ${counterType} Counter(s).`);
    const selfArrows = context.selfArrows || occupant.card?.arrows || [];
    // A pointed tile already carrying the player's own TreeFolk/Vine/Seed
    // is still a legal candidate here — a Dryad-keyword Being from hand
    // can attach onto it (dryadAttachTargetOk, checked properly once a
    // specific hand card is chosen, in both getLegalActions' own offer
    // branch and RESOLVE_SUMMON_HAND_BEING_POINTED's reducer) — which hand
    // card will actually be picked isn't known yet at this declare step,
    // so this only checks the TARGET side (its own typing), not whether
    // any hand card is actually Dryad-eligible.
    const pointedCells = [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, context.selfCellId, dir)))]
      .filter(c => {
        if (!c) return false;
        const there = next.board[c];
        if (emptyOrOwnArmamentStack(there, playerId)) return true;
        return there?.type === 'being' && there.ownerId === playerId
          && DRYAD_ATTACH_TYPINGS.some(t => (there.card.typing || '').toLowerCase().includes(t));
      });
    if (pointedCells.length === 0) {
      return addLog(next, `${cardName}'s ${label} has no legal tile it points to, to summon on.`);
    }
    return { ...next, pendingChoice: { kind: 'summon-hand-being-pointed', playerId, cardName, label, allowedCells: pointedCells, optional: true } };
  }

  // Strike the Ore: "Engage a Being you control: Draw (1) card." — an
  // additional-cost shape (like SACRIFICE_BEING_COST_RE above), just
  // engaging instead of sacrificing one of the caster's own Beings.
  // Checked here, well before the unanchored DRAW_CARDS_RE below, for the
  // same reason every other "<cost>: <effect>" pattern in this file has to
  // be — the effect's own "draw (1) card" would otherwise match as a bare
  // substring and resolve unconditionally, skipping the Engage cost.
  const engageBeingCostMatch = text.match(/^Engage an?\s+Being(?: you control)?:\s*(.+)$/i);
  if (engageBeingCostMatch) {
    const effectText = engageBeingCostMatch[1].trim();
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && o.ownerId === playerId && !o.engaged);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no un-Engaged Being of ${playerId}'s to Engage.`);
    }
    const applyTo = (st, cellId) => {
      const occ = st.board[cellId];
      let n = { ...st, board: { ...st.board, [cellId]: { ...occ, engaged: true } } };
      n = addLog(n, `${playerId} Engages ${occ.card.name} for ${cardName}'s ${label}.`);
      return resolveOrLogEffect(n, playerId, cardName, effectText, label, context);
    };
    if (candidates.length === 1) return applyTo(state, candidates[0][0]);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to Engage.`);
    return { ...next, pendingChoice: { kind: 'engage-being-cost', playerId, cardName, effectText, label, context } };
  }

  // "You may pay (N) Lifespan to X" (Vassal Matriach: "You may pay (5)
  // Lifespan to Summon (2) Vassal tokens.") — a generic optional-cost
  // wrapper: opens a real choice (pay-and-do-X, or Decline via the
  // existing generic `optional` mechanism) rather than auto-resolving,
  // since paying real Lifespan for an optional effect is always the
  // player's call. Checked early, before any single-pattern match below
  // could otherwise intercept just the "...to X" remainder as a bare
  // substring (the same class of bug ADD_ESSENCE_RE's own reordering
  // fixed for Martyrdom) — excludes BUFF_ALLY_RE's own more specific
  // "...to give a different <typing> you control +S/+L" shape (Lamtukka
  // Gentleman), which reads captured stat numbers directly rather than
  // recursing on free text, so it must keep matching whole, not be split
  // into a generic "cost" + a not-otherwise-recognized "effectText".
  const mayPayLifespanMatch = !BUFF_ALLY_RE.test(text) && text.match(MAY_PAY_LIFESPAN_RE);
  if (mayPayLifespanMatch) {
    const cost = parseInt(mayPayLifespanMatch[1], 10);
    const effectText = mayPayLifespanMatch[2].trim();
    if (state.players[playerId].lifespan - cost <= 0) {
      return addLog(state, `${cardName}'s ${label} has no Lifespan of ${playerId}'s to spare to pay ${cost}.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose whether to pay ${cost} Lifespan to ${effectText}`);
    return { ...next, pendingChoice: { kind: 'pay-lifespan-optional', playerId, cardName, label, cost, effectText, optional: true } };
  }

  // "you may sacrifice this and <effect>" (Oracle of Eonia) — same
  // optional-cost-wrapper shape as mayPayLifespanMatch above, costed by
  // sacrificing the ability's own caster instead of Lifespan. `context` is
  // threaded through the pendingChoice (unlike pay-lifespan-optional, which
  // never needs it) so RESOLVE_SACRIFICE_THIS_OPTIONAL still knows which
  // cell to sacrifice.
  const maySacrificeThisMatch = text.match(MAY_SACRIFICE_THIS_AND_RE);
  if (maySacrificeThisMatch && context.selfCellId) {
    const effectText = maySacrificeThisMatch[1].trim();
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose whether to sacrifice ${cardName} and ${effectText}`);
    return { ...next, pendingChoice: { kind: 'sacrifice-this-optional', playerId, cardName, label, effectText, context, optional: true } };
  }

  // Invoke (RULES.md > Keywords): "Add to hand, then summon/conjure" — see
  // invokeCandidates/resolveInvoke below for the shared search+placement
  // machinery every one of these reuses. Checked as a small family of
  // narrow, precise shapes (matching this file's own established style —
  // see e.g. the Vine-token patterns) rather than one fully generic regex,
  // since the real cards vary in exactly what they search by (an exact
  // name, or a typing — optionally narrowed by a cost ceiling and/or
  // "Faithless") and where the found card lands (a normal empty Mortal
  // Realm cell, or a tile this points to).
  const invokeNamedMatch = text.match(INVOKE_NAMED_RE);
  if (invokeNamedMatch) {
    const query = invokeNamedMatch[1].trim();
    return resolveInvoke(state, playerId, cardName, label, query, invokeCandidates(state, playerId, query), 'default', context);
  }
  const invokeFaithlessRelicMatch = text.match(INVOKE_TYPED_RELIC_FAITHLESS_RE);
  if (invokeFaithlessRelicMatch) {
    const query = invokeFaithlessRelicMatch[1].trim();
    const maxCost = parseInt(invokeFaithlessRelicMatch[2], 10);
    const candidates = invokeCandidates(state, playerId, query, { faithlessOnly: true, maxCost });
    return resolveInvoke(state, playerId, cardName, label, `Faithless ${query}`, candidates, 'default', context);
  }
  const invokeTypedCostPointedMatch = text.match(INVOKE_TYPED_COST_POINTED_RE);
  if (invokeTypedCostPointedMatch && context.selfCellId) {
    const query = invokeTypedCostPointedMatch[1].trim();
    const maxCost = parseInt(invokeTypedCostPointedMatch[2], 10);
    const candidates = invokeCandidates(state, playerId, query, { maxCost });
    return resolveInvoke(state, playerId, cardName, label, query, candidates, 'pointed', context);
  }
  const invokeTypedPointedMatch = text.match(INVOKE_TYPED_POINTED_RE);
  if (invokeTypedPointedMatch && context.selfCellId) {
    const query = invokeTypedPointedMatch[1].trim();
    return resolveInvoke(state, playerId, cardName, label, query, invokeCandidates(state, playerId, query), 'pointed', context);
  }

  // Vadē Rah: "add a Rhak-tùrin Deity to hand from deck that shares a type
  // with the sacrificed Being." — same shape as SEARCH_DECK_COST_OR_MORE_RE
  // just below (a new filter field on the same 'search' pendingChoice,
  // alongside Death's Decanter's costFilter and Exactly on TIme's own
  // minCostFilter), sourced from context.sacrificedTyping — set by
  // ACTIVATE_GROUND_RELIC_ENGAGE right before this resolves, from the
  // co-located Being it just sacrificed to pay the Engage cost.
  const searchDeckSharesSacrificedTypingMatch = text.match(/^Add an?\s+(.+?)\s+to hand from deck that shares a type with the sacrificed Being\.?$/i);
  if (searchDeckSharesSacrificedTypingMatch && context.sacrificedTyping != null) {
    // Same redundant-typing-suffix fix Erroneous Evocation/Skeptical
    // Scrawling/Exactly on TIme's own queries already needed — "Rhak-tùrin
    // Deity" (two words, space-separated) is never a literal substring of
    // the real, comma-separated typing ("Rhak-tùrin, Deity").
    const query = searchDeckSharesSacrificedTypingMatch[1].trim().replace(/\s+Deity$/i, '');
    const sharedTypings = context.sacrificedTyping.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    const matchesSharedTyping = (c) => (c.typing || '').split(',').map(t => t.trim().toLowerCase()).some(t => sharedTypings.includes(t));
    const candidates = searchZoneCandidates(state.players[playerId].mainDeck, query).filter(matchesSharedTyping);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} finds no "${query}" sharing a type with the sacrificed Being in ${playerId}'s deck.`);
    }
    let next = addLog(state, `${cardName}'s ${label} searches ${playerId}'s deck for a "${query}" sharing a type with the sacrificed Being.`);
    return { ...next, pendingChoice: { kind: 'search', playerId, source: 'mainDeck', query, sharedTypings, cardName } };
  }

  const searchDeckCostOrMoreMatch = text.match(SEARCH_DECK_COST_OR_MORE_RE);
  if (searchDeckCostOrMoreMatch) {
    // Strip a redundant trailing "Being" and fix the CSV's own "Timless"
    // typo — same treatment Erroneous Evocation/Skeptical Scrawling's own
    // queries already needed for the same reason (a real typing is
    // comma-separated, "Timless Being" isn't a literal substring of it).
    const query = searchDeckCostOrMoreMatch[1].trim().replace(/\s+Being$/i, '').replace(/Timless/i, 'Timeless');
    const minCostFilter = parseInt(searchDeckCostOrMoreMatch[2], 10);
    const candidates = searchZoneCandidates(state.players[playerId].mainDeck, query).filter(c => totalCastingCost(c) >= minCostFilter);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} finds no "${query}" costing ${minCostFilter} or more in ${playerId}'s deck.`);
    }
    let next = addLog(state, `${cardName}'s ${label} searches ${playerId}'s deck for a "${query}" costing ${minCostFilter} or more to add to hand.`);
    return { ...next, pendingChoice: { kind: 'search', playerId, source: 'mainDeck', query, minCostFilter, cardName } };
  }

  let searchMatch = null;
  for (const pattern of SEARCH_FROM_DECK_PATTERNS) {
    searchMatch = text.match(pattern);
    if (searchMatch) break;
  }
  if (searchMatch) {
    // Erroneous Evocation is the one card in the set that redundantly
    // appends "Being" to its own search phrase ("Add a Demon Being from
    // deck to hand") — every other card just prints the bare typing.
    // searchZoneCandidates matches the query as a literal substring of the
    // real, comma-separated typing ("Demon, Being"), which "Demon Being"
    // (no comma) never is — stripped here rather than touching the shared
    // matcher every other search already relies on.
    const query = searchMatch[1].trim().replace(/\s+Being$/i, '');
    // Seed of Divinity: "Add a Living Deity to hand from your deck" — a
    // leading Effigy-color word ("Living") isn't part of the typing at
    // all (a Deity's typing is just "...Deity", never "Living, Deity");
    // it's this card's own way of also filtering by color. Stripped from
    // the typing query and applied as its own effigyType filter, same
    // "search plus an extra filter layered on top" shape
    // searchDeckCostOrMoreMatch above already uses for a cost ceiling.
    const leadingColorMatch = query.match(new RegExp(`^(${EFFIGY_COLORS.join('|')})\\s+(.+)$`, 'i'));
    const colorFilter = leadingColorMatch ? leadingColorMatch[1].toLowerCase() : null;
    const typingQuery = leadingColorMatch ? leadingColorMatch[2] : query;
    const candidates = searchZoneCandidates(state.players[playerId].mainDeck, typingQuery)
      .filter(c => !colorFilter || c.effigyType === colorFilter);
    // Erroneous Evocation's own trailing clause — independent of the
    // search's own outcome, so it's applied either way, not deferred.
    const opponentTokenMatch = text.match(OPPONENT_SUMMON_TOKEN_RE);
    const applyOpponentToken = (st) => {
      if (!opponentTokenMatch) return st;
      const opponentId = opponentOf(playerId);
      const makeToken = TOKEN_REGISTRY[opponentTokenMatch[2].trim().toLowerCase()];
      if (!makeToken) return addLog(st, `${cardName}'s ${label} isn't automated yet: "${opponentTokenMatch[0]}"`);
      const cells = emptyMortalCellsFor(st.board, opponentId).sort();
      if (cells.length === 0) return addLog(st, `${cardName}'s ${label} has no empty tile of ${opponentId}'s to summon a token on.`);
      const token = makeToken();
      return addLog(placeTokenOnBoard(st, opponentId, token, cells[0]), `${cardName}'s ${label} forces ${opponentId} to summon ${token.name} at ${cells[0]}.`);
    };
    if (candidates.length === 0) {
      return applyOpponentToken(addLog(state, `${cardName}'s ${label} finds no "${query}" in ${playerId}'s deck.`));
    }
    let next = applyOpponentToken(addLog(state, `${cardName}'s ${label} searches ${playerId}'s deck for "${query}" to add to hand.`));
    return { ...next, pendingChoice: { kind: 'search', playerId, source: 'mainDeck', query: typingQuery, ...(colorFilter ? { colorFilter } : {}), cardName } };
  }

  // "Discard a Spirit, add a Turanga to hand from your Purgatory." (Book
  // of Mahatzu) — checked before the plain SEARCH_FROM_PURGATORY_RE below
  // (and CONDITIONAL_PURGATORY_UPGRADE_RE, which would also otherwise
  // match just the "add X to hand from your Purgatory" suffix, silently
  // skipping the discard cost entirely). The discard is a real cost
  // gating the search, not a second independent clause (same "matched as
  // one whole pattern" precedent Tiny Forge Master's own sacrifice-then-
  // draw already established).
  const discardThenSearchPurgatoryMatch = text.match(DISCARD_TYPED_SEARCH_PURGATORY_RE);
  if (discardThenSearchPurgatoryMatch) {
    const discardTyping = discardThenSearchPurgatoryMatch[1];
    const searchQuery = discardThenSearchPurgatoryMatch[2].trim();
    const candidates = state.players[playerId].hand.filter(c => matchesDiscardTyping(c, discardTyping));
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no ${discardTyping} in ${playerId}'s hand to discard.`);
    }
    const afterDiscard = (st, card) => {
      const player = st.players[playerId];
      let next = {
        ...st,
        players: {
          ...st.players,
          [playerId]: { ...player, hand: player.hand.filter(c => c.instanceId !== card.instanceId), purgatory: purgatoryAfterAdding(player.purgatory, card) },
        },
      };
      next = addLog(next, `${playerId} discards ${card.name} for ${cardName}'s ${label}.`);
      const searchCandidates = searchZoneCandidates(next.players[playerId].purgatory, searchQuery);
      if (searchCandidates.length === 0) {
        return addLog(next, `${cardName}'s ${label} finds no "${searchQuery}" in ${playerId}'s Purgatory.`);
      }
      next = addLog(next, `${cardName}'s ${label} searches ${playerId}'s Purgatory for "${searchQuery}" to add to hand.`);
      return { ...next, pendingChoice: { kind: 'search', playerId, source: 'purgatory', query: searchQuery, cardName } };
    };
    if (candidates.length === 1) return afterDiscard(state, candidates[0]);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a ${discardTyping} to discard.`);
    return { ...next, pendingChoice: { kind: 'discard-then-search-purgatory', playerId, cardName, label, discardTyping, searchQuery } };
  }

  // "Discard (1) Card, then return a Null Being From Purgatory to hand."
  // (Skeptical Scrawling) — same "discard gates the second clause" shape
  // as discardThenSearchPurgatoryMatch just above, adapted for an untyped
  // discard (any card in hand). Reuses the plain 'discard-one-card'
  // pendingChoice/RESOLVE_DISCARD_ONE_CARD plumbing (same picker UI a bare
  // DISCARD_ONE_CARD_RE already uses) rather than a dedicated kind, via
  // the optional thenReturnPurgatoryQuery field RESOLVE_DISCARD_ONE_CARD
  // checks once the discard itself resolves.
  const discardOneThenReturnPurgatoryMatch = text.match(DISCARD_ONE_CARD_THEN_RETURN_PURGATORY_RE);
  if (discardOneThenReturnPurgatoryMatch) {
    const query = discardOneThenReturnPurgatoryMatch[1].trim().replace(/\s+Being$/i, '');
    const hand = state.players[playerId].hand;
    if (hand.length === 0) return state;
    const afterDiscard = (st, card) => {
      const player = st.players[playerId];
      let next = {
        ...st,
        players: {
          ...st.players,
          [playerId]: { ...player, hand: player.hand.filter(c => c.instanceId !== card.instanceId), purgatory: purgatoryAfterAdding(player.purgatory, card) },
        },
      };
      next = addLog(next, `${playerId} discards ${card.name} for ${cardName}'s ${label}.`);
      const searchCandidates = searchZoneCandidates(next.players[playerId].purgatory, query);
      if (searchCandidates.length === 0) {
        return addLog(next, `${cardName}'s ${label} finds no "${query}" in ${playerId}'s Purgatory.`);
      }
      next = addLog(next, `${cardName}'s ${label} searches ${playerId}'s Purgatory for "${query}" to return to hand.`);
      return { ...next, pendingChoice: { kind: 'search', playerId, source: 'purgatory', query, cardName } };
    };
    if (hand.length === 1) return afterDiscard(state, hand[0]);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a card from hand to discard.`);
    return { ...next, pendingChoice: { kind: 'discard-one-card', playerId, cardName, label, thenReturnPurgatoryQuery: query } };
  }

  // "Add X to hand from your Purgatory, if you control <Name> you may add
  // Y instead" (Fetch: "Add a Bag o' Bones to hand from your Purgatory, if
  // you control Cookie you may add an Undead instead.") — checked before
  // the plain SEARCH_FROM_PURGATORY_RE below, which would otherwise match
  // just the "Add X to hand from your Purgatory" prefix and silently drop
  // the conditional upgrade clause entirely.
  const conditionalPurgatoryMatch = text.match(CONDITIONAL_PURGATORY_UPGRADE_RE);
  if (conditionalPurgatoryMatch) {
    const [, defaultQuery, requiredName, upgradedQuery] = conditionalPurgatoryMatch;
    const query = (countControlledByName(state.board, playerId, requiredName) > 0 ? upgradedQuery : defaultQuery).trim();
    const candidates = searchZoneCandidates(state.players[playerId].purgatory, query);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} finds no "${query}" in ${playerId}'s Purgatory.`);
    }
    let next = addLog(state, `${cardName}'s ${label} searches ${playerId}'s Purgatory for "${query}" to add to hand.`);
    return { ...next, pendingChoice: { kind: 'search', playerId, source: 'purgatory', query, cardName } };
  }

  const purgatorySearchMatch = text.match(SEARCH_FROM_PURGATORY_RE);
  if (purgatorySearchMatch) {
    const query = purgatorySearchMatch[1].trim();
    const candidates = searchZoneCandidates(state.players[playerId].purgatory, query);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} finds no "${query}" in ${playerId}'s Purgatory.`);
    }
    let next = addLog(state, `${cardName}'s ${label} searches ${playerId}'s Purgatory for "${query}" to add to hand.`);
    return { ...next, pendingChoice: { kind: 'search', playerId, source: 'purgatory', query, cardName } };
  }

  const temp = TEMPLE_OF_DUBIETY_RE.exec(text);
  if (temp) {
    const drawCount = parseInt(temp[1], 10);
    const candidates = state.players[playerId].purgatory.filter(c => c.kind === 'being' && isFaithlessTypedCard(c));
    const thenMaybeDraw = (st) => {
      if (!controlsOnlyFaithlessPermanents(st.board, playerId, st.altars[playerId], st.groundRelics)) return st;
      const { state: afterDraw, drawnCount } = drawCardsFor(st, playerId, drawCount);
      return addLog(afterDraw, `${cardName}'s ${label} draws ${drawnCount} card(s) for ${playerId} (only Faithless permanents controlled).`);
    };
    if (candidates.length === 0) {
      return thenMaybeDraw(addLog(state, `${cardName}'s ${label} has no Faithless Being in ${playerId}'s Purgatory to shuffle in.`));
    }
    if (candidates.length === 1) {
      let next = shuffleFromPurgatoryIntoDeck(state, playerId, candidates[0]);
      next = addLog(next, `${cardName}'s ${label} shuffles ${candidates[0].name} into ${playerId}'s deck.`);
      return thenMaybeDraw(next);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Faithless Being to shuffle into their deck.`);
    return { ...next, pendingChoice: { kind: 'shuffle-purgatory-into-deck', playerId, cardName, label, source: 'purgatory-faithless-being', then: { drawCount } } };
  }

  const shuffleFixedNMatch = text.match(SHUFFLE_FIXED_N_FROM_PURGATORY_RE);
  if (shuffleFixedNMatch) {
    const maxCount = parseInt(shuffleFixedNMatch[1], 10);
    const query = shuffleFixedNMatch[2].trim();
    if (searchZoneCandidates(state.players[playerId].purgatory, query).length === 0) {
      return addLog(state, `${cardName}'s ${label} finds no "${query}" in ${playerId}'s Purgatory.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose up to ${maxCount} "${query}" to shuffle into their deck.`);
    return { ...next, pendingChoice: { kind: 'shuffle-purgatory-toggle', playerId, cardName, label, query, maxCount, selected: [] } };
  }

  // "Shuffle up to (N) <Typing>(s) into your deck from Purgatory." (Scrap
  // Collector) — see SHUFFLE_UP_TO_N_FROM_PURGATORY_RE above.
  const shuffleUpToMatch = text.match(SHUFFLE_UP_TO_N_FROM_PURGATORY_RE);
  if (shuffleUpToMatch) {
    const maxCount = parseInt(shuffleUpToMatch[1], 10);
    const query = shuffleUpToMatch[2].trim();
    if (searchZoneCandidates(state.players[playerId].purgatory, query).length === 0) {
      return addLog(state, `${cardName}'s ${label} finds no "${query}" in ${playerId}'s Purgatory.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose up to ${maxCount} "${query}" to shuffle into their deck.`);
    return { ...next, pendingChoice: { kind: 'shuffle-purgatory-toggle', playerId, cardName, label, query, maxCount, selected: [] } };
  }

  const shuffleIntoDeckMatch = text.match(SHUFFLE_FROM_PURGATORY_INTO_DECK_RE);
  if (shuffleIntoDeckMatch) {
    const query = shuffleIntoDeckMatch[1].trim();
    const candidates = searchZoneCandidates(state.players[playerId].purgatory, query);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} finds no "${query}" in ${playerId}'s Purgatory.`);
    }
    if (candidates.length === 1) {
      let next = shuffleFromPurgatoryIntoDeck(state, playerId, candidates[0]);
      return addLog(next, `${cardName}'s ${label} shuffles ${candidates[0].name} into ${playerId}'s deck.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a "${query}" to shuffle into their deck.`);
    return { ...next, pendingChoice: { kind: 'shuffle-purgatory-into-deck', playerId, cardName, label, query } };
  }

  const summonFromPurgatoryMatch = text.match(SUMMON_FROM_PURGATORY_RE);
  if (summonFromPurgatoryMatch && context.selfCellId) {
    const query = summonFromPurgatoryMatch[1].trim();
    // Planchette: "Summon an Undead or Demon Being..." — see
    // searchZoneCandidatesAnyOf's own comment.
    const candidates = searchZoneCandidatesAnyOf(state.players[playerId].purgatory, query).filter(c => c.kind === 'being');
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} finds no "${query}" Being in ${playerId}'s Purgatory.`);
    }
    if (state.board[context.selfCellId]) {
      return addLog(state, `${cardName}'s ${label} has no empty tile to summon onto.`);
    }
    const summonFromPurgatory = (st, card) => {
      const p = st.players[playerId];
      const purged = { ...st, players: { ...st.players, [playerId]: { ...p, purgatory: p.purgatory.filter(c => c.instanceId !== card.instanceId) } } };
      return placeBeingOnBoard(purged, playerId, context.selfCellId, card);
    };
    if (candidates.length === 1) {
      return summonFromPurgatory(state, candidates[0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a "${query}" Being to summon from Purgatory.`);
    return { ...next, pendingChoice: { kind: 'summon-from-purgatory', playerId, cardName, cellId: context.selfCellId, query } };
  }

  // "You may summon Undead from your Purgatory until the end of your
  // turn." (Mausoleum Gates) — opens the standing window itself; see
  // SUMMON_TYPED_FROM_PURGATORY_WINDOW_RE above for what the window means.
  const summonTypedWindowMatch = text.match(SUMMON_TYPED_FROM_PURGATORY_WINDOW_RE);
  if (summonTypedWindowMatch) {
    const typing = summonTypedWindowMatch[1];
    const player = state.players[playerId];
    const windows = [...(player.summonTypedFromPurgatoryWindows || []), typing];
    const next = { ...state, players: { ...state.players, [playerId]: { ...player, summonTypedFromPurgatoryWindows: windows } } };
    return addLog(next, `${cardName}'s ${label} lets ${playerId} summon ${typing} from Purgatory for the rest of the turn.`);
  }

  // Checked before the generic modulateMatch below (its own MODULATE_RE
  // isn't anchored, so it would otherwise match "Modulate (+1)" as a bare
  // substring of this whole text first, silently dropping "then repeat...").
  const timeCapsuleMatch = text.match(TIME_CAPSULE_MODULATE_REPEAT_RE);
  if (timeCapsuleMatch) {
    const raw = timeCapsuleMatch[1];
    const delta = raw.startsWith('±') ? 'choose' : parseInt(raw, 10);
    const repeatCount = context.selfCounters?.time || 0;
    if (!hasModulateTarget(state.board, playerId, state.altars)) {
      return addLog(state, `${cardName}'s ${label} has no Time Counter of ${playerId}'s to Modulate.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} Modulate a Time Counter they control.`);
    return { ...next, pendingChoice: { kind: 'modulate', playerId, cardName, label, delta, repeatsRemaining: repeatCount } };
  }

  const massDebuffMatch = text.match(MASS_DEBUFF_SELF_GROWTH_RE);
  if (massDebuffMatch && context.selfCellId) {
    const debuffStrength = parseInt(massDebuffMatch[1], 10);
    const debuffLifespan = parseInt(massDebuffMatch[2], 10);
    const growStrength = parseInt(massDebuffMatch[3], 10);
    const growLifespan = parseInt(massDebuffMatch[4], 10);
    const affected = Object.entries(state.board).filter(([, o]) => o?.type === 'being').map(([cell]) => cell);
    let next = addLog(state, `${cardName}'s ${label} gives every Being -${debuffStrength}/-${debuffLifespan}.`);
    affected.forEach(cell => {
      const occ = next.board[cell];
      if (!occ) return; // may already be gone — e.g. this card itself, if the Lifespan half killed it
      const existing = occ.permanentBonus || { strength: 0, lifespan: 0 };
      next = { ...next, board: { ...next.board, [cell]: { ...occ, permanentBonus: { ...existing, strength: existing.strength - debuffStrength } } } };
      if (debuffLifespan > 0) next = dealDamageToBeing(next, cell, debuffLifespan);
    });
    const selfOccupant = next.board[context.selfCellId];
    if (selfOccupant) {
      const existing = selfOccupant.permanentBonus || { strength: 0, lifespan: 0 };
      const gainedStrength = growStrength * affected.length;
      const gainedLifespan = growLifespan * affected.length;
      next = {
        ...next,
        board: {
          ...next.board,
          [context.selfCellId]: {
            ...selfOccupant,
            permanentBonus: { strength: existing.strength + gainedStrength, lifespan: existing.lifespan + gainedLifespan },
            currentLifespan: selfOccupant.currentLifespan + gainedLifespan,
          },
        },
      };
      next = addLog(next, `${cardName} gains +${gainedStrength}/+${gainedLifespan} (${affected.length} Being(s) affected).`);
    }
    return next;
  }

  const summonDifferentTypedMatch = text.match(SUMMON_DIFFERENT_TYPED_FROM_PURGATORY_RE);
  if (summonDifferentTypedMatch) {
    const typing = summonDifferentTypedMatch[1];
    const excludeName = (context.excludeName || '').toLowerCase();
    const matches = state.players[playerId].purgatory.filter(c =>
      (c.kind === 'being' || c.kind === 'deity')
      && (c.typing || '').toLowerCase().includes(typing.toLowerCase())
      && c.name.toLowerCase() !== excludeName
    );
    if (matches.length === 0) {
      return addLog(state, `${cardName}'s ${label} finds no different "${typing}" in ${playerId}'s Purgatory to summon.`);
    }
    if (matches.length === 1) {
      return summonFromPurgatoryToOpenCell(state, playerId, cardName, matches[0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a different ${typing} to summon from Purgatory.`);
    return { ...next, pendingChoice: { kind: 'summon-different-typed-from-purgatory', playerId, cardName, label, typing, excludeName } };
  }

  const modulatePointedMatch = text.match(MODULATE_POINTED_RE);
  if (modulatePointedMatch && context.selfCellId) {
    const selfArrows = context.selfArrows || state.board[context.selfCellId]?.card?.arrows || [];
    const pointedCells = [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, context.selfCellId, dir)))]
      .filter(cell => cell && isModulateTarget(state.board[cell]) && state.board[cell].ownerId === playerId);
    if (pointedCells.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Time Counter it points to, to Modulate.`);
    }
    const raw = modulatePointedMatch[1];
    const delta = raw.startsWith('±') ? 'choose' : parseInt(raw, 10);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} Modulate a Time Counter it points to.`);
    return { ...next, pendingChoice: { kind: 'modulate', playerId, cardName, delta, allowedCells: pointedCells } };
  }

  // "Modulate (-1) and Modulate (+1)." (Hurry Up and Wait) — the generic
  // MODULATE_RE below only ever resolves the FIRST Modulate clause on a
  // line, silently dropping a second one joined by "and" (as opposed to
  // "then", which the top-level then-split already handles) — this is a
  // literal both-happen shape, not conditional, so it's a bespoke anchor
  // rather than a generic "and"-split (a generic split risks wrongly
  // breaking apart other cards' own "X and Y" prose that isn't two
  // independent clauses). Resolves the first Modulate now and threads the
  // second's delta through as `thenDelta` on the SAME `modulate`
  // pendingChoice (continueModulateRepeat, below `RESOLVE_MODULATE`) rather
  // than a new pendingChoice kind.
  // Not anchored with a trailing `$` — the real printed card's own
  // textBox has a whole SECOND line after this one ("This may only
  // target Time Counters that you control."), and `$` (no multiline
  // flag) matches end-of-STRING, not end-of-line, so it silently failed
  // to match the real two-line text at all (confirmed live: it fell
  // through to the generic single-Modulate branch below instead,
  // applying only the first "-1" and dropping the "+1" entirely) —
  // own-only is already this branch's own unconditional default below,
  // which already matches that second line's own printed restriction, so
  // it needs no further handling once this pattern can actually see
  // past it.
  const doubleModulateMatch = text.match(/^Modulate\s*\(([+\-±]?\d+)\)\s+and\s+Modulate\s*\(([+\-±]?\d+)\)\.?/i);
  if (doubleModulateMatch) {
    if (!hasModulateTarget(state.board, playerId, state.altars)) {
      return addLog(state, `${cardName}'s ${label} has no Time Counter of ${playerId}'s to Modulate.`);
    }
    const parseDelta = (raw) => (raw.startsWith('±') ? 'choose' : parseInt(raw, 10));
    const delta = parseDelta(doubleModulateMatch[1]);
    const thenDelta = parseDelta(doubleModulateMatch[2]);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} Modulate a Time Counter they control, twice.`);
    return { ...next, pendingChoice: { kind: 'modulate', playerId, cardName, label, delta, thenDelta } };
  }

  // Checked before the generic MODULATE_RE just below — see its own regex
  // comment for why (more specific, and MODULATE_RE would otherwise catch
  // "Modulate (-1)" as a bare substring first and silently drop the "may").
  const optionalModulateAnyOwnerMatch = text.match(OPTIONAL_MODULATE_ANY_OWNER_RE);
  if (optionalModulateAnyOwnerMatch) {
    if (!hasModulateTargetAnyOwner(state.board, state.altars)) {
      return addLog(state, `${cardName}'s ${label} has no Time Counter on the board to Modulate.`);
    }
    const raw = optionalModulateAnyOwnerMatch[1];
    const delta = raw.startsWith('±') ? 'choose' : parseInt(raw, 10);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose whether to Modulate a Time Counter either player controls.`);
    return { ...next, pendingChoice: { kind: 'modulate', playerId, cardName, delta, optional: true, anyOwner: true } };
  }

  const modulateMatch = text.match(MODULATE_RE);
  if (modulateMatch) {
    // Own-only unless the printed text says otherwise — but "otherwise"
    // isn't every card without "you control": it's specifically whether
    // "you control" appears ANYWHERE in this Modulate's own text at all.
    // Confirmed by the real CSV's own internal contrast: Hurry Up and Wait
    // spells out "This may only target Time Counters that you control" as
    // an explicit second clause, while Charge Forward, Roll Back, the
    // Conjuring literally named "Modulate", and MetaToris ("Twice per
    // turn Modulate (±1).") all print a bare Modulate with no such
    // restriction anywhere — the CSV author adds the qualifier exactly
    // when it's meant to apply and leaves it off otherwise, so its
    // absence here means "either player's Time Counter", not "assume
    // own-only". Matches the user's own ruling: unlike Dial of Metatoris
    // (own-only, per its printed "on a target you control"), MetaToris's
    // own ability has no such restriction in its printed text, so it can
    // target a Time Counter — including one on a shifted Being — that the
    // opponent controls.
    const anyOwner = !/you control/i.test(text);
    const hasTarget = anyOwner
      ? hasModulateTargetAnyOwner(state.board, state.altars)
      : hasModulateTarget(state.board, playerId, state.altars);
    if (!hasTarget) {
      return addLog(state, `${cardName}'s ${label} has no Time Counter ${anyOwner ? 'on the board' : `of ${playerId}'s`} to Modulate.`);
    }
    const raw = modulateMatch[1];
    const delta = raw.startsWith('±') ? 'choose' : parseInt(raw, 10);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} Modulate a Time Counter ${anyOwner ? 'either player controls' : 'they control'}.`);
    return { ...next, pendingChoice: { kind: 'modulate', playerId, cardName, delta, ...(anyOwner ? { anyOwner: true } : {}) } };
  }

  // "Sacrifice a Being you control: X" / "Sacrifice target Being add (N)
  // <Color> Essence." (My Body as a Shield / Martyrdom) — checked here,
  // before any single-pattern match below (ADD_ESSENCE_RE in particular),
  // for the same reason the "then"-split above is checked first: Martyrdom's
  // own embedded "add (2) Shifting Essence" would otherwise match
  // ADD_ESSENCE_RE as a bare substring and grant the Essence for free,
  // silently skipping the sacrifice its text requires as a cost.
  const sacrificeBeingCostMatch = text.match(SACRIFICE_BEING_COST_RE);
  const sacrificeTargetBeingEssenceMatch = text.match(SACRIFICE_TARGET_BEING_ADD_ESSENCE_RE);
  // "Sacrifice target Being you control." (Ritual Executioner) — the whole
  // ability, no further effect; reuses this same sacrifice-a-Being-you-
  // control machinery with an empty effectText, which resolveOrLogEffect
  // already no-ops gracefully on (see its own `if (!text) return state;`).
  const sacrificeTargetOwnBeingMatch = text.match(SACRIFICE_TARGET_OWN_BEING_RE);
  if (sacrificeBeingCostMatch || sacrificeTargetBeingEssenceMatch || sacrificeTargetOwnBeingMatch) {
    const effectText = sacrificeBeingCostMatch
      ? sacrificeBeingCostMatch[1].trim()
      : sacrificeTargetBeingEssenceMatch
      ? `Add (${sacrificeTargetBeingEssenceMatch[1]}) ${sacrificeTargetBeingEssenceMatch[2]} Essence.`
      : '';
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && o.ownerId === playerId);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being of ${playerId}'s to sacrifice.`);
    }
    if (candidates.length === 1) {
      let next = addLog(state, `${playerId} sacrifices ${candidates[0][1].card.name} for ${cardName}'s ${label}.`);
      next = destroyBeing(next, candidates[0][0]);
      return resolveOrLogEffect(next, playerId, cardName, effectText, label, context);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to sacrifice.`);
    return { ...next, pendingChoice: { kind: 'sacrifice-being-cost', playerId, cardName, effectText, label, context } };
  }

  // "Target a Being you don't control, then copy it's Engage ability."
  // (Marionette Doll) — see copyEngageAbility above for what "copy" means
  // here (effect text only, not the original's own extra costs/condition).
  if (COPY_ENGAGE_RE.test(text) && context.selfCellId) {
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && o.ownerId !== playerId);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being ${playerId} doesn't control to target.`);
    }
    if (candidates.length === 1) {
      return copyEngageAbility(state, playerId, cardName, label, candidates[0][0], context);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose an opposing Being to copy the Engage ability of.`);
    return { ...next, pendingChoice: { kind: 'copy-engage-target', playerId, cardName, label, context } };
  }

  // "Trigger the Depart of a Being you control." (Skeleton Key) — see
  // triggerDepartOfTarget above for what "trigger" means here (the
  // target's own Depart text resolves; the target itself doesn't die).
  const triggerDepartMatch = text.match(TRIGGER_DEPART_RE);
  if (triggerDepartMatch) {
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && o.ownerId === playerId && o.card.keywords?.depart);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being of ${playerId}'s with a Depart to trigger.`);
    }
    if (candidates.length === 1) {
      return triggerDepartOfTarget(state, playerId, cardName, label, candidates[0][0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to trigger the Depart of.`);
    return { ...next, pendingChoice: { kind: 'trigger-depart-target', playerId, cardName, label } };
  }

  // "Sacrifice this, <effect>" (Blooming Seed's counterCostSacrificeAbility
  // — see ACTIVATE_COUNTER_COST_SACRIFICE) — unconditionally sacrifices the
  // ability's own caster (no candidate search, unlike "Sacrifice target
  // Being you control" above), then resolves whatever follows. `selfArrows`
  // is captured off the board *before* destroying self so a chained "on any
  // tile this points to" effect (SUMMON_TOKEN_POINTED_RE) still has
  // something to work with once the caster is already gone.
  const sacrificeThisMatch = text.match(SACRIFICE_THIS_THEN_RE);
  if (sacrificeThisMatch && context.selfCellId) {
    const sacrificedCard = state.board[context.selfCellId]?.card;
    const selfArrows = sacrificedCard?.arrows || [];
    let next = addLog(state, `${playerId} sacrifices ${cardName} for its ${label}.`);
    next = destroyBeing(next, context.selfCellId);
    // SACRIFICE_THIS_THEN_RE's own `,?` is an optional COMMA, not "and" —
    // Scā-vuhk Hunger phrases the same "sacrifice this, <effect>" shape as
    // "sacrifice this AND <effect>" instead, which the regex still matches
    // (it captures everything after "this" regardless of connector) but
    // leaves a stray leading "and " on the captured effect text that no
    // downstream pattern expects; stripped here rather than widening the
    // regex itself, since every other card using this shape already uses a
    // comma and would never hit this branch.
    const effectText = sacrificeThisMatch[1].trim().replace(/^(?:and|then)\s+/i, '');
    next = resolveOrLogEffect(next, playerId, cardName, effectText, label, { ...context, selfArrows });
    // Sapling's own "Whenever you Martyr a Seed" (triggerMartyrTypedReactions
    // below) fires here too, not just from ACTIVATE_MARTYR — this IS the
    // caster sacrificing its own Seed to its own effect (Blooming Seed/
    // Kernel's counterCostSacrificeAbility), the same real-game event
    // Sapling's text means to react to, just reached through a different
    // reducer action than a printed "Martyr:" ability.
    if (sacrificedCard) next = triggerMartyrTypedReactions(next, playerId, sacrificedCard);
    return next;
  }

  if (SELF_SACRIFICE_BARE_RE.test(text) && context.selfCellId) {
    const occupant = state.board[context.selfCellId];
    if (!occupant || occupant.type !== 'being') {
      return addLog(state, `${cardName}'s ${label} has no Being on this tile to sacrifice.`);
    }
    let next = addLog(state, `${cardName}'s ${label} sacrifices ${occupant.card.name}.`);
    return destroyBeing(next, context.selfCellId);
  }

  const targetEffigyEngageMatch = text.match(TARGET_EFFIGY_ENGAGE_ADD_ESSENCE_RE);
  if (targetEffigyEngageMatch) {
    const amount = parseInt(targetEffigyEngageMatch[1], 10);
    const candidates = payablePool(state.players[playerId].effigyPool);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Effigy of ${playerId}'s to Engage.`);
    }
    if (candidates.length === 1) {
      return engageEffigyAddEssence(state, playerId, cardName, label, candidates[0].instanceId, amount);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose an Effigy to Engage.`);
    return { ...next, pendingChoice: { kind: 'engage-effigy-add-essence', playerId, cardName, label, amount, allowedInstanceIds: candidates.map(e => e.instanceId) } };
  }

  const essenceAnyTypeMatch = text.match(ADD_ESSENCE_ANY_TYPE_RE);
  if (essenceAnyTypeMatch) {
    const count = parseInt(essenceAnyTypeMatch[1], 10);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a color of Essence to add.`);
    return { ...next, pendingChoice: { kind: 'choose-essence-color', playerId, cardName, count } };
  }

  const essenceMatch = text.match(ADD_ESSENCE_RE);
  if (essenceMatch) {
    const count = parseInt(essenceMatch[1], 10);
    const color = essenceMatch[2].toLowerCase();
    if (EFFIGY_COLORS.includes(color) || color === 'faithless') {
      const granted = makeTemporaryEssence(color, count);
      const player = state.players[playerId];
      const next = {
        ...state,
        players: {
          ...state.players,
          [playerId]: { ...player, effigyPool: [...player.effigyPool, ...granted] },
        },
      };
      return addLog(next, `${cardName}'s ${label} adds ${count} ${color} Essence to ${playerId}'s pool until end of turn.`);
    }
  }

  const addEffigyMatch = text.match(ADD_EFFIGY_RE);
  if (addEffigyMatch) {
    const count = parseInt(addEffigyMatch[1], 10);
    const color = addEffigyMatch[2].toLowerCase();
    if (EFFIGY_COLORS.includes(color)) {
      const granted = Array.from({ length: count }, () => ({
        instanceId: `effigy-${color}#${effigyInstanceCounter++}`,
        kind: 'effigy',
        effigyType: color,
      }));
      const player = state.players[playerId];
      const next = {
        ...state,
        players: { ...state.players, [playerId]: { ...player, effigyPool: [...player.effigyPool, ...granted] } },
      };
      return addLog(next, `${cardName}'s ${label} adds ${count} ${color} Effigy to ${playerId}'s pool.`);
    }
  }

  const millMatch = text.match(MILL_RE);
  if (millMatch) {
    const count = parseInt(millMatch[1], 10);
    const player = state.players[playerId];
    const milled = player.mainDeck.slice(0, count);
    if (milled.length === 0) return state;
    const next = {
      ...state,
      players: {
        ...state.players,
        [playerId]: { ...player, mainDeck: player.mainDeck.slice(count), purgatory: [...player.purgatory, ...milled.filter(c => !c.isToken)] },
      },
    };
    return addLog(next, `${cardName}'s ${label} sends ${milled.length} card(s) from ${playerId}'s deck to Purgatory.`);
  }

  if (SHUFFLE_RANDOM_HAND_CARD_INTO_DECK_RE.test(text)) {
    const player = state.players[playerId];
    if (player.hand.length === 0) return addLog(state, `${cardName}'s ${label} has no card in ${playerId}'s hand to shuffle in.`);
    const idx = Math.floor(Math.random() * player.hand.length);
    const card = player.hand[idx];
    const mainDeck = [...player.mainDeck, card];
    for (let i = mainDeck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [mainDeck[i], mainDeck[j]] = [mainDeck[j], mainDeck[i]];
    }
    const next = { ...state, players: { ...state.players, [playerId]: { ...player, hand: player.hand.filter((_, i) => i !== idx), mainDeck } } };
    return addLog(next, `${cardName}'s ${label} shuffles ${card.name} from ${playerId}'s hand into their deck.`);
  }

  if (DISCARD_RANDOM_RE.test(text)) {
    const player = state.players[playerId];
    if (player.hand.length === 0) return state;
    const idx = Math.floor(Math.random() * player.hand.length);
    const discarded = player.hand[idx];
    const next = {
      ...state,
      players: {
        ...state.players,
        [playerId]: { ...player, hand: player.hand.filter((_, i) => i !== idx), purgatory: purgatoryAfterAdding(player.purgatory, discarded) },
      },
    };
    return addLog(next, `${cardName}'s ${label} discards ${discarded.name} from ${playerId}'s hand at random.`);
  }

  const damageMatch = text.match(DAMAGE_TARGET_RE);
  if (damageMatch) {
    const damage = parseInt(damageMatch[1], 10);
    const typingWord = damageMatch[2];
    const candidates = beingsOfTypingOwnedBy(state.board, playerId, typingWord);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no ${typingWord} of ${playerId}'s to target.`);
    }
    if (candidates.length === 1) {
      const [targetCellId, targetOccupant] = candidates[0];
      let next = addLog(state, `${cardName}'s ${label} deals ${damage} damage to ${targetOccupant.card.name}.`);
      return dealDamageToBeing(next, targetCellId, damage);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a ${typingWord} to deal ${damage} damage to.`);
    return { ...next, pendingChoice: { kind: 'damage-target', playerId, cardName, damage, typing: typingWord } };
  }

  const twoTargetLifespanDamageMatch = text.match(TWO_TARGET_LIFESPAN_DAMAGE_RE);
  if (twoTargetLifespanDamageMatch) {
    const amount1 = parseInt(twoTargetLifespanDamageMatch[1], 10);
    const amount2 = parseInt(twoTargetLifespanDamageMatch[2], 10);
    const candidates1 = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && o.ownerId === playerId).map(([cell]) => cell);
    if (candidates1.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being of ${playerId}'s to target.`);
    }
    if (candidates1.length === 1) {
      let next = addLog(state, `${cardName}'s ${label} deals ${amount1} Lifespan Damage to ${state.board[candidates1[0]].card.name}.`);
      next = dealDamageToBeing(next, candidates1[0], amount1);
      return dealSecondLifespanDamage(next, playerId, cardName, label, amount2, candidates1[0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being they control to target.`);
    return { ...next, pendingChoice: { kind: 'lifespan-damage-first-target', playerId, cardName, label, amount1, amount2 } };
  }

  // "Deal (N) damage to target Being" / "...to any target" — unqualified
  // (any Being, either owner), unlike DAMAGE_TARGET_RE above. Reuses the
  // same pendingChoice *kind* with `typing: null` (see getLegalActions/
  // RESOLVE_DAMAGE_TARGET). Both phrasings include a freestanding Animated
  // Armament acting as a Being (its topmost entry — RULES.md > Keywords >
  // Animated), the same way it's already a legal attack target in combat;
  // `actorView` reads either shape's card/name uniformly. Only "any
  // target" (Sharpshoot, Immen Gorta) — never the narrower "target
  // Being" (Kendasha, the Mages) — also lets either player's own Lifespan
  // be chosen directly (RESOLVE_DAMAGE_TARGET_PLAYER), matching how "any
  // target" reads in every other real trading-card game: since both
  // players are always legal candidates for it, an "any target" effect
  // never auto-resolves the way a Being-only one can when exactly one
  // Being is on the board — there are always at least 2 targets to choose
  // between.
  const damageAnyMatch = text.match(DAMAGE_ANY_TARGET_RE);
  if (damageAnyMatch) {
    const damage = parseInt(damageAnyMatch[1], 10);
    // Immen Gorta's own "deal (1) damage to any target" firing every
    // iteration of the Boundless Hunger bounce loop (placeReturnedFromShift
    // above) has nowhere to pause for a real player choice — bypass the
    // normal "any target" candidate pool entirely and hit the shifted
    // Being's owner's opponent directly.
    if (context.autoTargetOpponentId) {
      const opponent = state.players[context.autoTargetOpponentId];
      const next = {
        ...state,
        players: { ...state.players, [context.autoTargetOpponentId]: { ...opponent, lifespan: opponent.lifespan - damage } },
      };
      return addLog(next, `${cardName}'s ${label} deals ${damage} damage directly to ${context.autoTargetOpponentId}.`);
    }
    const includesPlayers = /any target/i.test(text);
    const beingCandidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being' || animatedTopEntry(o));
    if (beingCandidates.length === 0 && !includesPlayers) {
      return addLog(state, `${cardName}'s ${label} has no Being to target.`);
    }
    if (beingCandidates.length === 1 && !includesPlayers) {
      const [targetCellId, targetOccupant] = beingCandidates[0];
      let next = addLog(state, `${cardName}'s ${label} deals ${damage} damage to ${actorView(targetOccupant).card.name}.`);
      return dealDamageToBeing(next, targetCellId, damage);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a target to deal ${damage} damage to.`);
    return { ...next, pendingChoice: { kind: 'damage-target', playerId, cardName, damage, typing: null, includesPlayers } };
  }

  // "Target Being gains a -1/-1 Counter." (Scarab) — same "any target"
  // candidate pool as DAMAGE_ANY_TARGET_RE, but a distinct pendingChoice
  // kind since resolving it both grants a real counter (read live by
  // combat.js's effectiveStrength) and deals Lifespan damage (see
  // applyMinusCounters below), not just the latter.
  const minusCounterMatch = text.match(MINUS_COUNTER_TARGET_RE);
  if (minusCounterMatch) {
    const amount = minusCounterMatch[1] ? parseInt(minusCounterMatch[1], 10) : 1;
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being');
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being to target.`);
    }
    if (candidates.length === 1) {
      return applyMinusCounters(state, cardName, label, candidates[0][0], amount);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to target.`);
    return { ...next, pendingChoice: { kind: 'minus-counter-target', playerId, cardName, label, amount } };
  }

  // "Target Being's Strength becomes (N) until end of turn" (Regress) — any
  // Being, either owner, same "any target" candidate pool as
  // DAMAGE_ANY_TARGET_RE above. Sets strengthSetUntilEndOfTurn (read by
  // combat.js's effectiveStrength, cleared by endTurn in turn.js) rather
  // than the permanent strengthOverride Thespian/Horological Horror use.
  const coinFlipDamageMatch = text.match(COIN_FLIP_DAMAGE_RE);
  if (coinFlipDamageMatch) {
    const headsDamage = parseInt(coinFlipDamageMatch[1], 10);
    const tailsDamage = parseInt(coinFlipDamageMatch[2], 10);
    const heads = Math.random() < 0.5;
    let next = addLog(state, `${cardName}'s ${label} flips a coin: ${heads ? 'heads' : 'tails'}.`);
    if (heads) {
      const candidates = Object.entries(next.board).filter(([, o]) => o?.type === 'being' && o.ownerId !== playerId);
      if (candidates.length === 0) {
        return addLog(next, `${cardName}'s ${label} finds no enemy Being to damage.`);
      }
      if (candidates.length === 1) {
        const [targetCellId, targetOccupant] = candidates[0];
        next = addLog(next, `${cardName}'s ${label} deals ${headsDamage} damage to ${targetOccupant.card.name}.`);
        return dealDamageToBeing(next, targetCellId, headsDamage);
      }
      next = addLog(next, `${cardName}'s ${label} lets ${playerId} choose an enemy Being to damage.`);
      return { ...next, pendingChoice: { kind: 'damage-target', playerId, cardName, damage: headsDamage, typing: null, ownerFilter: 'opponent' } };
    }
    const opponentId = opponentOf(playerId);
    const candidates = Object.entries(next.board).filter(([, o]) => o?.type === 'being');
    if (candidates.length === 0) {
      return addLog(next, `${cardName}'s ${label} finds no Being for ${opponentId} to damage.`);
    }
    if (candidates.length === 1) {
      const [targetCellId, targetOccupant] = candidates[0];
      next = addLog(next, `${cardName}'s ${label} lets ${opponentId} deal ${tailsDamage} damage to ${targetOccupant.card.name}.`);
      return dealDamageToBeing(next, targetCellId, tailsDamage);
    }
    next = addLog(next, `${cardName}'s ${label} lets ${opponentId} choose any Being to damage.`);
    return { ...next, pendingChoice: { kind: 'damage-target', playerId: opponentId, cardName, damage: tailsDamage, typing: null } };
  }

  const strengthSetMatch = text.match(STRENGTH_BECOMES_EOT_RE);
  if (strengthSetMatch) {
    const amount = parseInt(strengthSetMatch[1], 10);
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being');
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being to target.`);
    }
    if (candidates.length === 1) {
      const [targetCellId, targetOccupant] = candidates[0];
      const next = { ...state, board: { ...state.board, [targetCellId]: { ...targetOccupant, strengthSetUntilEndOfTurn: amount } } };
      return addLog(next, `${cardName}'s ${label} sets ${targetOccupant.card.name}'s Strength to ${amount} until end of turn.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to set the Strength of.`);
    return { ...next, pendingChoice: { kind: 'strength-set-eot', playerId, cardName, amount } };
  }

  // "Return target Non-Deity Being you control to your hand. ... can not
  // target a Faithless Being." (Revoke) — candidates are the caster's own
  // non-Deity Beings with at least one non-Faithless color in their casting
  // cost (isFaithlessCard's own definition, inlined — see turn.js).
  const returnToHandMatch = text.match(RETURN_TO_HAND_RE);
  if (returnToHandMatch) {
    const candidates = Object.entries(state.board).filter(([, o]) =>
      o?.type === 'being' && o.ownerId === playerId && !o.card.isDeity
      && Object.keys(o.card.castingCost?.colored || {}).length > 0);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no legal Being of ${playerId}'s to return.`);
    }
    if (candidates.length === 1) {
      return returnBeingToHand(state, candidates[0][0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to return to hand.`);
    return { ...next, pendingChoice: { kind: 'return-to-hand', playerId, cardName } };
  }

  const massDisengageMatch = text.match(MASS_DISENGAGE_TYPING_RE);
  if (massDisengageMatch) {
    const typing = massDisengageMatch[1];
    const board = { ...state.board };
    let changed = false;
    Object.entries(board).forEach(([cell, o]) => {
      if (o?.type !== 'being' || o.ownerId !== playerId || !o.engaged) return;
      if (!(o.card.typing || '').toLowerCase().includes(typing.toLowerCase())) return;
      board[cell] = { ...o, engaged: false };
      changed = true;
    });
    if (!changed) {
      return addLog(state, `${cardName}'s ${label} has no engaged ${typing} of ${playerId}'s to disengage.`);
    }
    return addLog({ ...state, board }, `${cardName}'s ${label} disengages ${playerId}'s ${typing}s.`);
  }

  const engageStatBonusMatch = text.match(ENGAGE_TARGET_STAT_BONUS_EOT_RE);
  if (engageStatBonusMatch) {
    const strengthBonus = parseInt(engageStatBonusMatch[1], 10);
    const lifespanBonus = parseInt(engageStatBonusMatch[2], 10);
    // "Engage target being..." (Boknean Wine) — no "you control" in the
    // printed text, unlike Acrobatic Escape/Transplant's own "Engage
    // target Being you control"/engage-as-a-self-cost shapes. Any Being,
    // either owner — found while designing the pre-resolution priority
    // window (the user's own Boknean-Wine-vs-Arbosalis-Zealot example
    // needs this to even be reachable at all, window or not).
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && !o.engaged);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no disengaged Being to Engage.`);
    }
    if (candidates.length === 1) {
      return applyEngageStatBuff(state, candidates[0][0], strengthBonus, lifespanBonus, playerId, cardName, label);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to Engage.`);
    return { ...next, pendingChoice: { kind: 'engage-buff-eot', playerId, cardName, label, strengthBonus, lifespanBonus } };
  }

  if (SELF_STRENGTH_DEBUFF_TARGET_RE.test(text) && context.selfCellId) {
    const selfOccupant = state.board[context.selfCellId];
    const amount = selfOccupant ? effectiveStrength(selfOccupant) : 0;
    const applyDebuff = (st, cell) => {
      const occ = st.board[cell];
      const existing = occ.statBonusUntilEndOfTurn || { strength: 0, lifespan: 0 };
      const next = { ...st, board: { ...st.board, [cell]: { ...occ, statBonusUntilEndOfTurn: { strength: existing.strength - amount, lifespan: existing.lifespan } } } };
      return addLog(next, `${cardName}'s ${label} gives ${occ.card.name} -${amount}/-0 Strength until end of turn.`);
    };
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being').map(([cell]) => cell);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being to target.`);
    }
    if (candidates.length === 1) {
      return applyDebuff(state, candidates[0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to target.`);
    return { ...next, pendingChoice: { kind: 'strength-debuff-target', playerId, cardName, label, amount } };
  }

  if (DEBUFF_PER_OWN_DEATH_TARGET_RE.test(text)) {
    const amount = state.players[playerId].beingsDiedThisTurn || 0;
    const applyDebuff = (st, cell) => {
      const occ = st.board[cell];
      const existing = occ.statBonusUntilEndOfTurn || { strength: 0, lifespan: 0 };
      let nxt = { ...st, board: { ...st.board, [cell]: { ...occ, statBonusUntilEndOfTurn: { strength: existing.strength - amount, lifespan: existing.lifespan } } } };
      nxt = addLog(nxt, `${cardName}'s ${label} gives ${occ.card.name} -${amount}/-${amount} until end of turn.`);
      // Strength is genuinely temporary (statBonusUntilEndOfTurn, cleared
      // by endTurn); Lifespan is never actually temporary in this engine
      // (same precedent applyEngageStatBuff's own comment documents for a
      // positive Lifespan bonus, and minusCounterPenalty's own comment
      // documents for a negative one) — applied as real, permanent damage
      // through the normal death pipeline instead.
      return amount > 0 ? dealDamageToBeing(nxt, cell, amount) : nxt;
    };
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being').map(([cell]) => cell);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being to target.`);
    }
    if (candidates.length === 1) {
      return applyDebuff(state, candidates[0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to target.`);
    return { ...next, pendingChoice: { kind: 'debuff-per-own-death-target', playerId, cardName, label, amount } };
  }

  const engageTypedThenMoveMatch = text.match(ENGAGE_TYPED_THEN_MOVE_RE);
  if (engageTypedThenMoveMatch) {
    const typing = engageTypedThenMoveMatch[1];
    const candidates = Object.entries(state.board).filter(([cell, o]) =>
      o?.type === 'being' && o.ownerId === playerId && !o.engaged
      && (o.card.typing || '').toLowerCase().includes(typing.toLowerCase())
      && hasFreeMoveDestination(state, playerId, cell, 'any'));
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no legal ${typing} of ${playerId}'s to Engage.`);
    }
    const engageAndMove = (st, cellId) => {
      const occupant = st.board[cellId];
      let next = { ...st, board: { ...st.board, [cellId]: { ...occupant, engaged: true } } };
      next = addLog(next, `${playerId} engages ${occupant.card.name} for ${cardName}'s ${label}.`);
      return moveOrOfferFreeMove(next, playerId, cardName, label, cellId, 'any');
    };
    if (candidates.length === 1) {
      return engageAndMove(state, candidates[0][0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a ${typing} to Engage.`);
    return { ...next, pendingChoice: { kind: 'engage-then-move', playerId, cardName, label, typing } };
  }

  if (ENGAGE_TARGET_MOVE_TWICE_RE.test(text)) {
    const candidates = Object.entries(state.board).filter(([cell, o]) =>
      o?.type === 'being' && o.ownerId === playerId && !o.engaged && hasFreeMoveDestination(state, playerId, cell, 'any'));
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no legal Being of ${playerId}'s to Engage.`);
    }
    const engageAndMoveTwice = (st, cellId) => {
      const occupant = st.board[cellId];
      let next = { ...st, board: { ...st.board, [cellId]: { ...occupant, engaged: true } } };
      next = addLog(next, `${playerId} engages ${occupant.card.name} for ${cardName}'s ${label}.`);
      return moveOrOfferFreeMove(next, playerId, cardName, label, cellId, 'any', { sameActor: true, destinationFilter: 'any' });
    };
    if (candidates.length === 1) {
      return engageAndMoveTwice(state, candidates[0][0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to Engage.`);
    return { ...next, pendingChoice: { kind: 'engage-move-twice', playerId, cardName, label } };
  }

  const sacrificeXBeingsMatch = text.match(SACRIFICE_X_BEINGS_ADD_ESSENCE_RE);
  if (sacrificeXBeingsMatch) {
    const color = sacrificeXBeingsMatch[1].toLowerCase();
    const myBeings = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && o.ownerId === playerId);
    if (myBeings.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being of ${playerId}'s to sacrifice.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose how many Beings to sacrifice.`);
    return { ...next, pendingChoice: { kind: 'sacrifice-any-beings-toggle', playerId, cardName, label, color, selected: [] } };
  }

  if (PAUSE_NEXT_MODULATE_RE.test(text)) {
    const next = { ...state, skipNextModulate: true };
    return addLog(next, `${cardName}'s ${label} will skip the next Modulate Step's Time Counter removal.`);
  }

  const discardXNamedMatch = text.match(DISCARD_X_NAMED_DRAW_RE);
  if (discardXNamedMatch) {
    const name = discardXNamedMatch[1].trim();
    const candidates = state.players[playerId].hand.filter(c => c.name.toLowerCase() === name.toLowerCase());
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no ${name} in ${playerId}'s hand to discard.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose how many ${name} to discard.`);
    return { ...next, pendingChoice: { kind: 'discard-x-named-toggle', playerId, cardName, label, name, selected: [] } };
  }

  const addCounterToRelicMatch = text.match(ADD_COUNTER_TO_TARGET_RELIC_RE);
  if (addCounterToRelicMatch) {
    const amount = parseInt(addCounterToRelicMatch[1], 10);
    const counterType = addCounterToRelicMatch[2].toLowerCase();
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'relic');
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Relic to target.`);
    }
    const applyCounter = (st, cellId) => {
      const occupant = st.board[cellId];
      const have = occupant.counters?.[counterType] || 0;
      const next = { ...st, board: { ...st.board, [cellId]: { ...occupant, counters: { ...occupant.counters, [counterType]: have + amount } } } };
      return addLog(next, `${cardName}'s ${label} adds ${amount} ${counterType} Counter(s) to ${occupant.card.name}.`);
    };
    if (candidates.length === 1) {
      return applyCounter(state, candidates[0][0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Relic to target.`);
    return { ...next, pendingChoice: { kind: 'add-counter-relic-target', playerId, cardName, label, amount, counterType } };
  }

  const addCounterSelfMatch = text.match(ADD_COUNTER_SELF_RE);
  if (addCounterSelfMatch && context.selfCellId && state.board[context.selfCellId]) {
    const amount = parseInt(addCounterSelfMatch[1], 10);
    const counterType = addCounterSelfMatch[2].toLowerCase();
    const occupant = state.board[context.selfCellId];
    const have = occupant.counters?.[counterType] || 0;
    const next = {
      ...state,
      board: { ...state.board, [context.selfCellId]: { ...occupant, counters: { ...occupant.counters, [counterType]: have + amount } } },
    };
    return addLog(next, `${cardName}'s ${label} adds ${amount} ${counterType} Counter(s) to itself.`);
  }

  // "Add (N) <Type> Counter(s) to a <Typing> this points to." (Green
  // thumbed Gardener) — see ADD_COUNTER_TYPED_POINTED_RE above.
  const addCounterTypedPointedMatch = text.match(ADD_COUNTER_TYPED_POINTED_RE);
  if (addCounterTypedPointedMatch && context.selfCellId) {
    const amount = parseInt(addCounterTypedPointedMatch[1], 10);
    const counterType = addCounterTypedPointedMatch[2].toLowerCase();
    const typing = addCounterTypedPointedMatch[3].trim();
    const selfArrows = context.selfArrows || state.board[context.selfCellId]?.card?.arrows || [];
    const candidates = [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, context.selfCellId, dir)))]
      .filter(c => c && state.board[c]?.type === 'being' && (state.board[c].card.typing || '').toLowerCase().includes(typing.toLowerCase()));
    const applyTypedCounter = (st, cellId) => {
      const occupant = st.board[cellId];
      const have = occupant.counters?.[counterType] || 0;
      const next = { ...st, board: { ...st.board, [cellId]: { ...occupant, counters: { ...occupant.counters, [counterType]: have + amount } } } };
      return addLog(next, `${cardName}'s ${label} adds ${amount} ${counterType} Counter(s) to ${occupant.card.name}.`);
    };
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no ${typing} it points to.`);
    }
    if (candidates.length === 1) {
      return applyTypedCounter(state, candidates[0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a ${typing} it points to.`);
    return { ...next, pendingChoice: { kind: 'add-counter-typed-pointed-target', playerId, cardName, label, amount, counterType, allowedCells: candidates } };
  }

  const sacrificeNonArmamentRelicMatch = text.match(SACRIFICE_NON_ARMAMENT_RELIC_COST_RE);
  if (sacrificeNonArmamentRelicMatch) {
    const effectText = sacrificeNonArmamentRelicMatch[1].trim();
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'relic' && o.ownerId === playerId);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no non-Armament Relic of ${playerId}'s to sacrifice.`);
    }
    if (candidates.length === 1) {
      let next = addLog(state, `${playerId} sacrifices ${candidates[0][1].card.name} for ${cardName}'s ${label}.`);
      next = destroyPermanentAt(next, candidates[0][0]);
      return resolveOrLogEffect(next, playerId, cardName, effectText, label, context);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Relic to sacrifice.`);
    return { ...next, pendingChoice: { kind: 'sacrifice-relic-cost', playerId, cardName, effectText, label, context } };
  }

  const sacrificeRelicMatch = text.match(SACRIFICE_RELIC_COST_RE);
  if (sacrificeRelicMatch) {
    const effectText = sacrificeRelicMatch[1].trim();
    const candidates = gatherRelicTargets(state.board).filter(t => state.board[t.cellId]?.ownerId === playerId);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Relic of ${playerId}'s to sacrifice.`);
    }
    const sacrificeRelicAndContinue = (st, target) => {
      const occ = st.board[target.cellId];
      const name = target.armamentInstanceId
        ? occ.armaments.find(a => a.card.instanceId === target.armamentInstanceId)?.card.name
        : occ.card.name;
      let next2 = addLog(st, `${playerId} sacrifices ${name} for ${cardName}'s ${label}.`);
      next2 = destroyRelicTarget(next2, target);
      return resolveOrLogEffect(next2, playerId, cardName, effectText, label, context);
    };
    if (candidates.length === 1) {
      return sacrificeRelicAndContinue(state, candidates[0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Relic to sacrifice.`);
    return { ...next, pendingChoice: { kind: 'sacrifice-relic-cost-target', playerId, cardName, effectText, label, context } };
  }

  // "Pay (N) <Color> [Essence]: <effect>" as free-standing effect text
  // (Anahk-sha, reached via its own timesPerTurnAbility) — see
  // PAY_EFFIGY_COST_EFFECT_RE's own comment above.
  const payEffigyCostEffectMatch = text.match(PAY_EFFIGY_COST_EFFECT_RE);
  if (payEffigyCostEffectMatch) {
    const amount = parseInt(payEffigyCostEffectMatch[1], 10);
    const color = payEffigyCostEffectMatch[2].toLowerCase();
    const effectText = payEffigyCostEffectMatch[3].trim();
    if (EFFIGY_COLORS.includes(color)) {
      const player = state.players[playerId];
      const have = payablePool(player.effigyPool).filter(e => e.effigyType === color).length;
      if (have < amount) {
        return addLog(state, `${cardName}'s ${label} can't afford to pay ${amount} ${payEffigyCostEffectMatch[2]}.`);
      }
      let pool = [...player.effigyPool];
      for (let i = 0; i < amount; i++) {
        const idx = pool.findIndex(e => e.effigyType === color && !e.engaged);
        pool.splice(idx, 1);
      }
      let next = { ...state, players: { ...state.players, [playerId]: { ...player, effigyPool: pool } } };
      next = addLog(next, `${playerId} pays ${amount} ${payEffigyCostEffectMatch[2]} for ${cardName}'s ${label}.`);
      return resolveOrLogEffect(next, playerId, cardName, effectText, label, context);
    }
  }

  // "Disengage." (Anahk-sha, after its own Pay-cost above) — sets the
  // caster's own occupant back to disengaged.
  if (DISENGAGE_SELF_RE.test(text) && context.selfCellId && state.board[context.selfCellId]) {
    const occupant = state.board[context.selfCellId];
    const next = { ...state, board: { ...state.board, [context.selfCellId]: { ...occupant, engaged: false } } };
    return addLog(next, `${cardName}'s ${label} disengages ${occupant.card.name}.`);
  }

  if (VYU_BHATA_RE.test(text)) {
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && o.ownerId === playerId);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being of ${playerId}'s to target.`);
    }
    const applyVyuBhata = (st, cellId) => {
      const occupant = st.board[cellId];
      const adjacentOwnBeings = adjacentCells(cellId).filter(c => st.board[c]?.type === 'being' && st.board[c]?.ownerId === playerId).length;
      const totalStacks = 1 + adjacentOwnBeings;
      const existing = occupant.permanentBonus || { strength: 0, lifespan: 0 };
      // Strength is read live off permanentBonus (combat.js); Lifespan
      // isn't, so — same precedent as Lamtukka Gentleman's own permanent
      // ally buff — its half is also applied as an immediate heal here.
      const next = {
        ...st,
        board: {
          ...st.board,
          [cellId]: {
            ...occupant,
            permanentBonus: { strength: existing.strength + totalStacks, lifespan: existing.lifespan + totalStacks },
            currentLifespan: occupant.currentLifespan + totalStacks,
          },
        },
      };
      return addLog(next, `${cardName}'s ${label} gives ${occupant.card.name} +${totalStacks}/+${totalStacks} (1 plus ${adjacentOwnBeings} adjacent Being(s)).`);
    };
    if (candidates.length === 1) {
      return applyVyuBhata(state, candidates[0][0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to target.`);
    return { ...next, pendingChoice: { kind: 'vyu-bhata-target', playerId, cardName, label } };
  }

  if (STRIKE_DOWN_RE.test(text)) {
    // The target is always exactly ONE specific cell — whichever Being is
    // currently blocking the real, currently-open declared attack (see
    // attackPendingBlockingCell above) — never a broader "any front-row
    // Being of the opponent" search, so there's no multi-candidate choice
    // to offer here at all (unlike the old approximation this replaces).
    // conjuringCastGateOk already refused to offer this cast at all
    // unless a real Being sits there, but this is re-checked fresh in
    // case the board changed between offer and resolution.
    const blockingCell = attackPendingBlockingCell(state);
    const blocker = blockingCell ? state.board[blockingCell] : null;
    if (!blocker || blocker.type !== 'being') {
      return addLog(state, `${cardName}'s ${label} has no blocking Being to destroy.`);
    }
    let next = addLog(state, `${cardName}'s ${label} destroys ${blocker.card.name} — the attacking Being will deal no damage.`);
    next = destroyBeing(next, blockingCell);
    // Stashed on the SAME pendingResolution the attack's own declare step
    // already opened (never a fresh one) — resolvePendingResolution's own
    // 'attack' kind reads this to zero out the attacker's damage once the
    // window finally closes (see resolveAttackFrom's own `noDamage` param).
    return { ...next, pendingResolution: { ...next.pendingResolution, noDamage: true } };
  }

  if (DROWN_OUT_THE_SCREAMS_RE.test(text)) {
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && !o.card.isDeity);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Non-Deity Being to target.`);
    }
    const applyDrown = (st, cellId) => {
      const occupant = st.board[cellId];
      const next = { ...st, board: { ...st.board, [cellId]: suppressAbilitiesUntilEndOfTurn(occupant) } };
      return addLog(next, `${cardName}'s ${label} strips ${occupant.card.name}'s abilities until end of turn.`);
    };
    if (candidates.length === 1) {
      return applyDrown(state, candidates[0][0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Non-Deity Being to target.`);
    return { ...next, pendingChoice: { kind: 'drown-screams-target', playerId, cardName, label } };
  }

  const dendrifyMatch = text.match(DENDRIFY_RE);
  if (dendrifyMatch) {
    const newStrength = parseInt(dendrifyMatch[1], 10);
    const newLifespan = parseInt(dendrifyMatch[2], 10);
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being');
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being to target.`);
    }
    const applyDendrify = (st, cellId) => {
      const occupant = st.board[cellId];
      const suppressed = suppressAbilitiesUntilEndOfTurn(occupant);
      const next = {
        ...st,
        board: {
          ...st.board,
          [cellId]: {
            ...suppressed,
            strengthSetUntilEndOfTurn: newStrength,
            lifespanSetUntilEndOfTurn: newLifespan,
            currentLifespan: Math.min(occupant.currentLifespan, newLifespan),
          },
        },
      };
      return addLog(next, `${cardName}'s ${label} turns ${occupant.card.name} into a ${newStrength}/${newLifespan} Being until end of turn, losing its abilities.`);
    };
    if (candidates.length === 1) {
      return applyDendrify(state, candidates[0][0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to target.`);
    return { ...next, pendingChoice: { kind: 'dendrify-target', playerId, cardName, label, newStrength, newLifespan } };
  }

  const animateMatch = text.match(ANIMATE_RELIC_RE);
  if (animateMatch) {
    const newStrength = parseInt(animateMatch[1], 10);
    const newLifespan = parseInt(animateMatch[2], 10);
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'relic');
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Relic to target.`);
    }
    if (candidates.length === 1) {
      return applyAnimate(state, candidates[0][0], newStrength, newLifespan, cardName, label);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Relic to target.`);
    return { ...next, pendingChoice: { kind: 'animate-relic-target', playerId, cardName, label, newStrength, newLifespan } };
  }

  if (EQUANIMITY_RE.test(text)) {
    // "Deal (1) damage..., repeat for each Time Counter..." — the base
    // effect always fires once, then repeats once more per Time Counter, so
    // X = Time Counters + 1 (0 Time Counters still triggers once), not the
    // Time Counter count alone.
    const timeCounters = totalProphecyTimeCountersControlledBy(state, playerId);
    const repeats = timeCounters + 1;
    let next = state;
    for (let i = 0; i < repeats; i += 1) {
      next = addLog(next, `${cardName}'s ${label} triggers (${i + 1}/${repeats}).`);
      next = resolveEquanimityIteration(next, playerId);
      if (next.phase === 'gameover') return next;
    }
    return next;
  }

  const lscMatch = text.match(LESSER_SUMMONING_CIRCLE_RE);
  if (lscMatch && context.selfCellId) {
    // Lesser Summoning Circle's own printed "Beings may move across this
    // Relic" line (public/default-card-set.csv) makes it a real ground
    // Relic (RULES.md > Being-Relic co-location) — it lives in
    // state.groundRelics, not state.board, so that's where the flag goes.
    const occupant = state.groundRelics[context.selfCellId];
    if (!occupant || occupant.type !== 'relic') {
      return addLog(state, `${cardName}'s ${label} has no Relic on this tile.`);
    }
    const typings = lscMatch[1]
      .split(/,\s*|\s+or\s+/i)
      .map(s => s.replace(/^an?\s+/i, '').trim().toLowerCase())
      .filter(Boolean);
    const next = { ...state, groundRelics: { ...state.groundRelics, [context.selfCellId]: { ...occupant, summonHereTypings: typings } } };
    return addLog(next, `${cardName}'s ${label} lets ${playerId} summon a matching Being directly onto this tile.`);
  }

  if (RETURN_THE_FAVOR_RE.test(text)) {
    const owner = state.players[playerId];
    const next = { ...state, players: { ...state.players, [playerId]: { ...owner, returnTheFavorUntilEndOfTurn: true } } };
    return addLog(next, `${cardName}'s ${label} is active until the end of the turn.`);
  }

  if (DIABLERIE_RE.test(text)) {
    return diablerieOfferMover(state, playerId, cardName, label, [], opponentOf(playerId));
  }

  if (SACRIFICE_BEING_HERE_DRAW_LIFESPAN_RE.test(text) && context.selfCellId) {
    const occupant = state.board[context.selfCellId];
    if (!occupant || occupant.type !== 'being') {
      return addLog(state, `${cardName}'s ${label} has no Being on this tile to sacrifice.`);
    }
    const drawCount = occupant.card.lifespan;
    let next = addLog(state, `${playerId} sacrifices ${occupant.card.name} for ${cardName}'s ${label}.`);
    next = destroyBeing(next, context.selfCellId);
    const { state: afterDraw, drawnCount } = drawCardsFor(next, playerId, drawCount);
    return addLog(afterDraw, `${cardName}'s ${label} draws ${drawnCount} card(s) for ${playerId} (equal to ${occupant.card.name}'s Lifespan).`);
  }

  if (SACRIFICE_BEING_POINTED_RE.test(text) && context.selfCellId) {
    const selfArrows = state.board[context.selfCellId]?.card?.arrows || [];
    const pointedCells = [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, context.selfCellId, dir)))].filter(Boolean);
    const candidates = pointedCells.filter(c => state.board[c]?.type === 'being').map(c => [c, state.board[c]]);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being on a tile it points to.`);
    }
    if (candidates.length === 1) {
      let next = addLog(state, `${cardName}'s ${label} sacrifices ${candidates[0][1].card.name}.`);
      return destroyBeing(next, candidates[0][0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to sacrifice.`);
    return { ...next, pendingChoice: { kind: 'sacrifice-pointed-target', playerId, cardName, label, selfCellId: context.selfCellId } };
  }

  if (DESTROY_BEING_POINTED_RE.test(text) && context.selfCellId) {
    const selfArrows = state.board[context.selfCellId]?.card?.arrows || [];
    const pointedCells = [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, context.selfCellId, dir)))].filter(Boolean);
    const candidates = pointedCells.filter(c => state.board[c]?.type === 'being').map(c => [c, state.board[c]]);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being on a tile it points to.`);
    }
    if (candidates.length === 1) {
      let next = addLog(state, `${cardName}'s ${label} destroys ${candidates[0][1].card.name}.`);
      return destroyBeing(next, candidates[0][0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to destroy.`);
    return { ...next, pendingChoice: { kind: 'sacrifice-pointed-target', playerId, cardName, label, selfCellId: context.selfCellId } };
  }

  const midnightMassMatch = text.match(MIDNIGHT_MASS_RE);
  if (midnightMassMatch && context.selfCellId) {
    const typing = midnightMassMatch[1].trim();
    const selfArrows = context.selfArrows || state.board[context.selfCellId]?.card?.arrows || [];
    const pointedCells = [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, context.selfCellId, dir)))].filter(Boolean);
    const candidates = pointedCells.filter(c => state.board[c]?.type === 'being').map(c => [c, state.board[c]]);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being on a tile it points to, to sacrifice.`);
    }
    const applySacrifice = (st, cellId) => {
      const strength = effectiveStrength(st.board[cellId]);
      let next = addLog(st, `${playerId} sacrifices ${st.board[cellId].card.name} (Strength ${strength}) for ${cardName}'s ${label}.`);
      next = destroyBeing(next, cellId);
      return resolveInvoke(next, playerId, cardName, label, typing, invokeCandidates(next, playerId, typing), 'pointed', { ...context, strengthOverride: strength });
    };
    if (candidates.length === 1) return applySacrifice(state, candidates[0][0]);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being it points to, to sacrifice.`);
    return { ...next, pendingChoice: { kind: 'midnight-mass-sacrifice-target', playerId, cardName, label, typing, selfCellId: context.selfCellId, context } };
  }

  if (LEGION_ONSET_RE.test(text)) {
    // The player chooses how many Vassal tokens to summon (not a raw
    // Lifespan amount — user ruling), capped by BOTH the same "can't drop
    // to 0" Lifespan floor every other optional Lifespan cost in this file
    // already gates on (buff-ally/Mulligan), and by how many empty Mortal
    // Realm tiles are actually available to place them on — picking more
    // imps than either allows is never offered in the first place.
    const maxByLifespan = Math.floor(Math.max(0, state.players[playerId].lifespan - 1) / 5);
    const maxByTiles = emptyMortalCellsFor(state.board, playerId).length;
    const maxCount = Math.min(maxByLifespan, maxByTiles);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose how many Vassal tokens to summon.`);
    return { ...next, pendingChoice: { kind: 'legion-onset-choose-count', playerId, cardName, label, maxCount } };
  }

  const destroyPointedSummonTokenMatch = text.match(DESTROY_POINTED_SUMMON_TOKEN_HERE_RE);
  if (destroyPointedSummonTokenMatch && context.selfCellId) {
    const makeToken = TOKEN_REGISTRY[destroyPointedSummonTokenMatch[1].trim().toLowerCase()];
    if (!makeToken) return addLog(state, `${cardName}'s ${label} isn't automated yet: "${text}"`);
    const selfArrows = context.selfArrows || state.board[context.selfCellId]?.card?.arrows || [];
    const pointedCells = [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, context.selfCellId, dir)))].filter(Boolean);
    const candidates = pointedCells.filter(c => state.board[c]?.type === 'being').map(c => [c, state.board[c]]);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being on a tile it points to.`);
    }
    const resolveOn = (st, targetCellId) => {
      const name = st.board[targetCellId].card.name;
      let next = addLog(st, `${cardName}'s ${label} destroys ${name}.`);
      next = destroyBeing(next, targetCellId);
      const token = makeToken();
      next = placeTokenOnBoard(next, playerId, token, targetCellId);
      return addLog(next, `${cardName}'s ${label} summons ${token.name} at ${targetCellId}.`);
    };
    if (candidates.length === 1) return resolveOn(state, candidates[0][0]);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to destroy.`);
    return { ...next, pendingChoice: { kind: 'destroy-pointed-summon-token', playerId, cardName, label, tokenName: destroyPointedSummonTokenMatch[1].trim().toLowerCase(), selfCellId: context.selfCellId } };
  }

  const favorPointedMatch = text.match(FAVOR_POINTED_MULTI_RE);
  if (favorPointedMatch && context.selfCellId) {
    const maxCount = parseInt(favorPointedMatch[1], 10);
    const selfArrows = context.selfArrows || state.board[context.selfCellId]?.card?.arrows || [];
    const pointedCells = [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, context.selfCellId, dir)))]
      .filter(c => c && state.board[c]?.type === 'being');
    if (pointedCells.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being on a tile it points to.`);
    }
    const applyFavor = (st, cells) => cells.reduce((s, cell) => {
      const occ = s.board[cell];
      return { ...s, board: { ...s.board, [cell]: { ...occ, favorCounter: true } } };
    }, st);
    if (pointedCells.length <= maxCount) {
      let next = applyFavor(state, pointedCells);
      return addLog(next, `${cardName}'s ${label} makes ${pointedCells.length} Being(s) it points to Favored.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose up to ${maxCount} Beings it points to, to become Favored.`);
    return { ...next, pendingChoice: { kind: 'favor-pointed-toggle', playerId, cardName, label, maxCount, allowedCells: pointedCells, selected: [] } };
  }

  if (RECOLLECT_RE.test(text) && context.selfCellId) {
    const selfArrows = state.board[context.selfCellId]?.card?.arrows || [];
    const pointedCells = [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, context.selfCellId, dir)))].filter(Boolean);
    const candidates = pointedCells.filter(c => state.board[c]?.type === 'being').map(c => [c, state.board[c]]);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being on a tile it points to.`);
    }
    if (candidates.length === 1) {
      return applyRecollect(state, candidates[0][0], cardName, label);
    }
    // pointedCells (not selfCellId) is stashed directly on the pendingChoice
    // — unlike Ferryman's Boat's own sacrifice-pointed-target (a Relic's
    // Engage, whose source stays on the board while its choice is open),
    // a Prophecy's own cell empties out (sent to Purgatory) in this SAME
    // resolveProphecyModulateHitZero pass, right after this line finishes
    // resolving — so re-deriving arrows off state.board[selfCellId] at
    // resolve time would find nothing there any more.
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to return.`);
    return { ...next, pendingChoice: { kind: 'recollect-target', playerId, cardName, label, pointedCells } };
  }

  const sacrificeTypedCostLimitMatch = text.match(SACRIFICE_TYPED_COST_LIMIT_GAIN_LIFESPAN_RE);
  if (sacrificeTypedCostLimitMatch) {
    const typings = [sacrificeTypedCostLimitMatch[1], sacrificeTypedCostLimitMatch[2], sacrificeTypedCostLimitMatch[3]].map(t => t.toLowerCase());
    const costLimit = parseInt(sacrificeTypedCostLimitMatch[4], 10);
    const gainAmount = parseInt(sacrificeTypedCostLimitMatch[5], 10);
    const candidates = Object.entries(state.board).filter(([, o]) =>
      o?.type === 'being' && o.ownerId === playerId
      && typings.some(t => (o.card.typing || '').toLowerCase().includes(t))
      && totalCastingCost(o.card) <= costLimit);
    const sacrificeAndGain = (st, cellId) => {
      const occupant = st.board[cellId];
      let next = addLog(st, `${playerId} sacrifices ${occupant.card.name} for ${cardName}'s ${label}.`);
      next = destroyBeing(next, cellId);
      return resolveOrLogEffect(next, playerId, cardName, `Gain (${gainAmount}) Lifespan.`, label, {});
    };
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no legal Being of ${playerId}'s to sacrifice.`);
    }
    if (candidates.length === 1) {
      return sacrificeAndGain(state, candidates[0][0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to sacrifice.`);
    return { ...next, pendingChoice: { kind: 'sacrifice-typed-cost-limit', playerId, cardName, label, typings, costLimit, gainAmount } };
  }

  const sacrificeTypedCostMatch = text.match(SACRIFICE_TARGET_TYPING_COST_RE);
  if (sacrificeTypedCostMatch) {
    const typing = sacrificeTypedCostMatch[1];
    const effectText = sacrificeTypedCostMatch[2].trim();
    const candidates = beingsOfTypingOwnedBy(state.board, playerId, typing);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no ${typing} of ${playerId}'s to sacrifice.`);
    }
    if (candidates.length === 1) {
      let next = addLog(state, `${playerId} sacrifices ${candidates[0][1].card.name} for ${cardName}'s ${label}.`);
      next = destroyBeing(next, candidates[0][0]);
      return resolveOrLogEffect(next, playerId, cardName, effectText, label, context);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a ${typing} to sacrifice.`);
    return { ...next, pendingChoice: { kind: 'sacrifice-typed-cost', playerId, cardName, typing, effectText, label, context } };
  }

  const selfDamageMatch = text.match(SELF_DAMAGE_RE);
  if (selfDamageMatch && context.selfCellId && state.board[context.selfCellId]?.type === 'being') {
    const damage = parseInt(selfDamageMatch[1], 10);
    const targetName = state.board[context.selfCellId].card.name;
    let next = addLog(state, `${cardName}'s ${label} deals ${damage} damage to ${targetName}.`);
    return dealDamageToBeing(next, context.selfCellId, damage);
  }

  const damageAllMatch = text.match(DAMAGE_ALL_OTHERS_RE);
  if (damageAllMatch) {
    const damage = parseInt(damageAllMatch[1], 10);
    const targets = Object.keys(state.board).filter(cell => state.board[cell]?.type === 'being' && cell !== context.selfCellId);
    if (targets.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no other Beings to target.`);
    }
    let next = addLog(state, `${cardName}'s ${label} deals ${damage} damage to all other Beings.`);
    return targets.reduce((acc, cell) => (acc.board[cell] ? dealDamageToBeing(acc, cell, damage) : acc), next);
  }

  // Also checked before DRAW_CARDS_RE below, same reason as
  // shuffleOrDrawMatch just below this — Tiny Forge Master's own text ends
  // in "...then draw (1) card", which DRAW_CARDS_RE would otherwise match
  // as a bare substring and draw for free, without the sacrifice cost ever
  // being paid (see SACRIFICE_ARMAMENT_DRAW_RE's own comment above).
  const sacrificeArmamentDrawMatch = text.match(SACRIFICE_ARMAMENT_DRAW_RE);
  if (sacrificeArmamentDrawMatch) {
    const drawCount = parseAmount(sacrificeArmamentDrawMatch[1]);
    const candidates = [];
    Object.entries(state.board).forEach(([cell, o]) => {
      if (!o || o.ownerId !== playerId || !o.armaments) return;
      o.armaments.forEach(a => candidates.push({ cellId: cell, armamentInstanceId: a.card.instanceId, armamentName: a.card.name }));
    });
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Armament to sacrifice.`);
    }
    const sacrificeAndDraw = (st, { cellId, armamentInstanceId, armamentName }) => {
      let n = addLog(st, `${playerId} sacrifices ${armamentName} to ${cardName}'s ${label}.`);
      n = removeArmamentEntry(n, cellId, armamentInstanceId, { toPurgatory: true });
      return resolveOrLogEffect(n, playerId, cardName, `draw (${drawCount}) card(s).`, label, context);
    };
    if (candidates.length === 1) return sacrificeAndDraw(state, candidates[0]);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose an Armament to sacrifice.`);
    return { ...next, pendingChoice: { kind: 'sacrifice-armament', playerId, cardName, drawCount } };
  }

  const sacrificeArmamentDamageMatch = text.match(SACRIFICE_ARMAMENT_DAMAGE_RE);
  if (sacrificeArmamentDamageMatch) {
    const candidates = [];
    Object.entries(state.board).forEach(([cell, o]) => {
      if (!o || o.ownerId !== playerId || !o.armaments) return;
      o.armaments.forEach(a => candidates.push({ cellId: cell, armamentInstanceId: a.card.instanceId, armamentName: a.card.name, cost: totalCastingCost(a.card) }));
    });
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Armament to sacrifice.`);
    }
    const sacrificeAndDamage = (st, { cellId, armamentInstanceId, armamentName, cost }) => {
      let n = addLog(st, `${playerId} sacrifices ${armamentName} (cost ${cost}) to ${cardName}'s ${label}.`);
      n = removeArmamentEntry(n, cellId, armamentInstanceId, { toPurgatory: true });
      return resolveOrLogEffect(n, playerId, cardName, `Deal (${cost}) damage to any target.`, label, context);
    };
    if (candidates.length === 1) return sacrificeAndDamage(state, candidates[0]);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose an Armament to sacrifice.`);
    return { ...next, pendingChoice: { kind: 'sacrifice-armament-damage', playerId, cardName, label, context } };
  }

  // Checked before DRAW_CARDS_RE below — MetaToris's own text ends in "...or
  // draw (3) Cards", which DRAW_CARDS_RE would otherwise match as a
  // substring anywhere in the string and resolve (just drawing, ignoring
  // the Shuffle option) before this whole-pattern check ever got a look.
  const shuffleOrDrawMatch = text.match(SHUFFLE_OR_DRAW_RE);
  if (shuffleOrDrawMatch) {
    const shuffleCount = parseInt(shuffleOrDrawMatch[1], 10);
    const drawCount = parseInt(shuffleOrDrawMatch[2], 10);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose: shuffle ${shuffleCount} from Purgatory, or draw ${drawCount}.`);
    return { ...next, pendingChoice: { kind: 'shuffle-or-draw', playerId, cardName, shuffleCount, drawCount } };
  }

  // "Restore (N) Lifespan or Summon (M) Blooming Vine tokens (...)." (Elderflower
  // Ancient) — same mandatory either/or shape as shuffleOrDrawMatch above;
  // each branch opens its own further choice (restore-lifespan-target or
  // summon-vine-tokens-toggle) once the player picks one.
  const restoreOrSummonMatch = text.match(RESTORE_LIFESPAN_OR_SUMMON_VINE_RE);
  if (restoreOrSummonMatch) {
    const restoreAmount = parseInt(restoreOrSummonMatch[1], 10);
    const tokenCount = parseInt(restoreOrSummonMatch[2], 10);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose: restore ${restoreAmount} Lifespan, or summon up to ${tokenCount} Blooming Vine token(s).`);
    return { ...next, pendingChoice: { kind: 'restore-or-summon-vine', playerId, cardName, label, restoreAmount, tokenCount } };
  }

  const allPlayersDrawMatch = text.match(ALL_PLAYERS_DRAW_RE);
  if (allPlayersDrawMatch) {
    const count = parseAmount(allPlayersDrawMatch[1] === 'a' || allPlayersDrawMatch[1] === 'an' ? 'one' : allPlayersDrawMatch[1]);
    let next = state;
    Object.keys(next.players).forEach(pid => {
      const { state: afterDraw } = drawCardsFor(next, pid, count);
      next = afterDraw;
    });
    return addLog(next, `${cardName}'s ${label} has every player draw ${count} card(s).`);
  }

  const discardBeingDrawBonusMatch = text.match(DISCARD_BEING_DRAW_BONUS_RE);
  if (discardBeingDrawBonusMatch) {
    const bonusTyping = discardBeingDrawBonusMatch[1];
    const candidates = state.players[playerId].hand.filter(c => c.kind === 'being' || c.kind === 'deity');
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being in ${playerId}'s hand to discard.`);
    }
    const resolveDiscard = (st, card) => {
      const player = st.players[playerId];
      let next = {
        ...st,
        players: {
          ...st.players,
          [playerId]: { ...player, hand: player.hand.filter(c => c.instanceId !== card.instanceId), purgatory: purgatoryAfterAdding(player.purgatory, card) },
        },
      };
      next = addLog(next, `${playerId} discards ${card.name} for ${cardName}'s ${label}.`);
      const bonus = (card.typing || '').toLowerCase().includes(bonusTyping.toLowerCase()) ? 1 : 0;
      const { state: afterDraw, drawnCount } = drawCardsFor(next, playerId, 1 + bonus);
      return addLog(afterDraw, `${cardName}'s ${label} draws ${drawnCount} card(s) for ${playerId}.`);
    };
    if (candidates.length === 1) return resolveDiscard(state, candidates[0]);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to discard.`);
    return { ...next, pendingChoice: { kind: 'discard-being-draw-bonus', playerId, cardName, label, bonusTyping } };
  }

  const discardKindDrawMatch = text.match(DISCARD_KIND_DRAW_RE);
  if (discardKindDrawMatch) {
    const kind = discardKindDrawMatch[1].toLowerCase();
    const count = parseAmount(discardKindDrawMatch[2]);
    const candidates = state.players[playerId].hand.filter(c => matchesDiscardKind(c, kind));
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no ${discardKindDrawMatch[1]} to discard in ${playerId}'s hand.`);
    }
    if (candidates.length === 1) {
      const card = candidates[0];
      const player = state.players[playerId];
      let next = {
        ...state,
        players: {
          ...state.players,
          [playerId]: {
            ...player,
            hand: player.hand.filter(c => c.instanceId !== card.instanceId),
            purgatory: purgatoryAfterAdding(player.purgatory, card),
          },
        },
      };
      next = addLog(next, `${playerId} discards ${card.name} for ${cardName}'s ${label}.`);
      const { state: afterDraw, drawnCount } = drawCardsFor(next, playerId, count);
      return addLog(afterDraw, `${cardName}'s ${label} draws ${drawnCount} card(s) for ${playerId}.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a ${discardKindDrawMatch[1]} to discard.`);
    return { ...next, pendingChoice: { kind: 'discard-kind-draw', playerId, cardName, label, discardKind: kind, drawCount: count } };
  }

  // "Discard a <Typing>, then draw (N) card(s)." (Onagīous Hunger's real
  // printed text) — see DISCARD_TYPED_THEN_DRAW_RE's own comment above for
  // why this needs its own combined branch rather than the generic
  // "then"-split. Same shape as discardKindDrawMatch above (0/1/2+
  // candidates), just matched by typing (matchesDiscardTyping) instead of
  // kind, and storing `drawCount` on the 'discard-typed' pendingChoice
  // below so RESOLVE_DISCARD_TYPED can draw once the discard actually
  // resolves.
  const discardTypedThenDrawMatch = text.match(DISCARD_TYPED_THEN_DRAW_RE);
  if (discardTypedThenDrawMatch) {
    const typing = discardTypedThenDrawMatch[1];
    const count = parseAmount(discardTypedThenDrawMatch[2]);
    const candidates = state.players[playerId].hand.filter(c => matchesDiscardTyping(c, typing));
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no ${typing} to discard in ${playerId}'s hand.`);
    }
    if (candidates.length === 1) {
      const card = candidates[0];
      const player = state.players[playerId];
      let next = {
        ...state,
        players: {
          ...state.players,
          [playerId]: {
            ...player,
            hand: player.hand.filter(c => c.instanceId !== card.instanceId),
            purgatory: purgatoryAfterAdding(player.purgatory, card),
          },
        },
      };
      next = addLog(next, `${playerId} discards ${card.name} for ${cardName}'s ${label}.`);
      const { state: afterDraw, drawnCount } = drawCardsFor(next, playerId, count);
      return addLog(afterDraw, `${cardName}'s ${label} draws ${drawnCount} card(s) for ${playerId}.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a ${typing} to discard.`);
    return { ...next, pendingChoice: { kind: 'discard-typed', playerId, cardName, label, typing, drawCount: count } };
  }

  // "Discard a <Typing>." with no attached draw (Skeptical Scrawling-style
  // "then"-split leftover halves) — same shape as discardTypedThenDrawMatch
  // above, minus the draw.
  const discardTypedMatch = text.match(DISCARD_TYPED_RE);
  if (discardTypedMatch) {
    const typing = discardTypedMatch[1];
    const candidates = state.players[playerId].hand.filter(c => matchesDiscardTyping(c, typing));
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no ${discardTypedMatch[1]} to discard in ${playerId}'s hand.`);
    }
    if (candidates.length === 1) {
      const card = candidates[0];
      const player = state.players[playerId];
      const next = {
        ...state,
        players: {
          ...state.players,
          [playerId]: { ...player, hand: player.hand.filter(c => c.instanceId !== card.instanceId), purgatory: purgatoryAfterAdding(player.purgatory, card) },
        },
      };
      return addLog(next, `${playerId} discards ${card.name} for ${cardName}'s ${label}.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a ${discardTypedMatch[1]} to discard.`);
    return { ...next, pendingChoice: { kind: 'discard-typed', playerId, cardName, label, typing } };
  }

  const discardOneCardMatch = text.match(DISCARD_ONE_CARD_RE);
  if (discardOneCardMatch) {
    const hand = state.players[playerId].hand;
    if (hand.length === 0) return state;
    if (hand.length === 1) {
      const [card] = hand;
      const player = state.players[playerId];
      const next = { ...state, players: { ...state.players, [playerId]: { ...player, hand: [], purgatory: purgatoryAfterAdding(player.purgatory, card) } } };
      return addLog(next, `${playerId} discards ${card.name} for ${cardName}'s ${label}.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a card from hand to discard.`);
    return { ...next, pendingChoice: { kind: 'discard-one-card', playerId, cardName, label } };
  }

  const returnTypedFromPurgatoryMatch = text.match(RETURN_TYPED_FROM_PURGATORY_RE);
  if (returnTypedFromPurgatoryMatch) {
    // Skeptical Scrawling's own "a Null Being" redundantly appends
    // "Being" — see the identical strip on the deck-search query above.
    const query = returnTypedFromPurgatoryMatch[1].trim().replace(/\s+Being$/i, '');
    const candidates = searchZoneCandidates(state.players[playerId].purgatory, query);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} finds no "${query}" in ${playerId}'s Purgatory.`);
    }
    let next = addLog(state, `${cardName}'s ${label} searches ${playerId}'s Purgatory for "${query}" to return to hand.`);
    return { ...next, pendingChoice: { kind: 'search', playerId, source: 'purgatory', query, cardName } };
  }

  const drawPerKeywordMatch = text.match(DRAW_PER_KEYWORD_RE);
  if (drawPerKeywordMatch) {
    const perAmount = parseAmount(drawPerKeywordMatch[1]);
    const keyword = drawPerKeywordMatch[2].toLowerCase();
    const count = Object.values(state.board).filter(o => o?.type === 'being' && o.ownerId === playerId && o.card.keywords?.[keyword]).length;
    const { state: next, drawnCount } = drawCardsFor(state, playerId, perAmount * count);
    return addLog(next, `${cardName}'s ${label} draws ${drawnCount} card(s) for ${playerId} (${perAmount} for each of ${count} Being(s) with ${drawPerKeywordMatch[2]}).`);
  }

  const discardHandDrawEqualMatch = text.match(DISCARD_HAND_DRAW_EQUAL_RE);
  if (discardHandDrawEqualMatch) {
    const player = state.players[playerId];
    const discarded = player.hand;
    let next = {
      ...state,
      players: {
        ...state.players,
        [playerId]: { ...player, hand: [], purgatory: discarded.reduce((p, c) => purgatoryAfterAdding(p, c), player.purgatory) },
      },
    };
    next = addLog(next, `${playerId} discards ${discarded.length} card(s) for ${cardName}'s ${label}.`);
    const { state: afterDraw, drawnCount } = drawCardsFor(next, playerId, discarded.length);
    return addLog(afterDraw, `${cardName}'s ${label} draws ${drawnCount} card(s) for ${playerId}.`);
  }

  // Bare "Remove (N) <Type> Counter(s)" — spends this permanent's own
  // Counters as a standalone clause (e.g. Canopic Jar's own "Engage: Remove
  // (4) Crossing Counters Shuffle a Being from Purgatory into it's owners
  // deck, they draw (1) card" — its own unpunctuated "...deck, they draw"
  // never gets split apart by the top-level "then" logic since it has no
  // literal "then", so it has to be checked here, BEFORE the unanchored
  // DRAW_CARDS_RE below, or that would swallow its trailing "draw (1) card"
  // as a substring and silently skip the counter spend and Purgatory
  // shuffle entirely (the same ordering bug Book of Mahatzu's own discard
  // clause hit earlier). Only ever reached for a *board* occupant (not
  // a groundRelic — RELIC_COUNTER_MOVE_RE, above, owns that shape, and it's
  // excluded from the then-split so this never double-matches it).
  const removeCountersShuffleDrawMatch = text.match(REMOVE_OWN_COUNTERS_SHUFFLE_PURGATORY_DRAW_RE);
  if (removeCountersShuffleDrawMatch && context.selfCellId && state.board[context.selfCellId]) {
    const spend = parseInt(removeCountersShuffleDrawMatch[1], 10);
    const counterType = removeCountersShuffleDrawMatch[2].toLowerCase();
    const query = removeCountersShuffleDrawMatch[3].trim();
    const drawCount = parseAmount(removeCountersShuffleDrawMatch[4]);
    const occupant = state.board[context.selfCellId];
    const have = occupant.counters?.[counterType] || 0;
    if (have < spend) {
      return addLog(state, `${cardName}'s ${label} has no ${counterType} Counters left to spend.`);
    }
    // Unlike Melting Clock/Temple of Dubiety's own "from YOUR Purgatory"
    // (own-only), Canopic Jar's printed text says just "from Purgatory
    // into it's owners deck, they draw (1) card" — no "your", and "it's
    // owners"/"they" both point at whoever the found Being actually
    // belongs to, not necessarily the activating player. So this searches
    // BOTH players' Purgatories, and the shuffle + draw both apply to the
    // found card's own owner — confirmed with the user.
    const candidates = [
      ...searchZoneCandidates(state.players.A.purgatory, query).map(card => ({ card, owner: 'A' })),
      ...searchZoneCandidates(state.players.B.purgatory, query).map(card => ({ card, owner: 'B' })),
    ];
    let next = {
      ...state,
      board: { ...state.board, [context.selfCellId]: { ...occupant, counters: { ...occupant.counters, [counterType]: have - spend } } },
    };
    next = addLog(next, `${cardName}'s ${label} spends ${spend} ${counterType} Counter(s).`);
    if (candidates.length === 0) {
      return addLog(next, `${cardName}'s ${label} finds no "${query}" in either player's Purgatory.`);
    }
    const shuffleAndDraw = (st, owner, card) => {
      let n = shuffleFromPurgatoryIntoDeck(st, owner, card);
      n = addLog(n, `${cardName}'s ${label} shuffles ${card.name} into ${owner}'s deck.`);
      const { state: afterDraw, drawnCount } = drawCardsFor(n, owner, drawCount);
      return addLog(afterDraw, `${cardName}'s ${label} draws ${drawnCount} card(s) for ${owner}.`);
    };
    if (candidates.length === 1) return shuffleAndDraw(next, candidates[0].owner, candidates[0].card);
    next = addLog(next, `${cardName}'s ${label} lets ${playerId} choose a "${query}" (either player's Purgatory) to shuffle into its owner's deck.`);
    return { ...next, pendingChoice: { kind: 'shuffle-purgatory-into-deck', playerId, cardName, label, query, then: { drawCount }, anyOwner: true } };
  }

  // Generic coin flip ("Flip a coin, if heads X, if tails Y" — Illegible
  // Grimoire/Witching Well) — checked BEFORE the unanchored DRAW_CARDS_RE
  // below, since a heads clause of "draw (N) card(s)" would otherwise match
  // as a substring of the whole flip text and silently draw unconditionally,
  // skipping the actual coin flip (the same ordering hazard Canopic Jar's
  // own counter-spend pattern hit above).
  const genericCoinFlipMatch = !COIN_FLIP_DAMAGE_RE.test(text) && text.match(GENERIC_COIN_FLIP_RE);
  if (genericCoinFlipMatch) {
    const heads = Math.random() < 0.5;
    const branch = (heads ? genericCoinFlipMatch[1] : genericCoinFlipMatch[2]).trim();
    let next = addLog(state, `${cardName}'s ${label} flips a coin: ${heads ? 'heads' : 'tails'}.`);
    return resolveOrLogEffect(next, playerId, cardName, branch.endsWith('.') ? branch : `${branch}.`, label, context);
  }

  const drawMatch = text.match(DRAW_CARDS_RE);
  if (drawMatch) {
    const count = parseAmount(drawMatch[1]);
    const { state: next, drawnCount } = drawCardsFor(state, playerId, count);
    return addLog(next, `${cardName}'s ${label} draws ${drawnCount} card(s) for ${playerId}.`);
  }

  const craftEffigyMatch = text.match(CRAFT_EFFIGY_RE);
  if (craftEffigyMatch) {
    const count = parseAmount(craftEffigyMatch[1]);
    const player = state.players[playerId];
    let deck = player.effigyDeck;
    let pool = player.effigyPool;
    let crafted = 0;
    for (let i = 0; i < count && deck.length > 0; i++) {
      pool = [...pool, deck[0]];
      deck = deck.slice(1);
      crafted++;
    }
    const next = { ...state, players: { ...state.players, [playerId]: { ...player, effigyDeck: deck, effigyPool: pool } } };
    return addLog(next, `${cardName}'s ${label} crafts ${crafted} Effigy for ${playerId}.`);
  }

  const nextBeingCostMatch = text.match(NEXT_BEING_COST_REDUCTION_RE);
  if (nextBeingCostMatch) {
    const amount = parseInt(nextBeingCostMatch[1], 10);
    const color = nextBeingCostMatch[2].toLowerCase();
    // Simple Summoner: engaging it more than once this turn stacks (user
    // ruling) — a list of {color, amount} entries, each applied in
    // effectiveCastingCost, rather than a single slot a second activation
    // would just overwrite.
    const next = { ...state, nextBeingCostReduction: [...(state.nextBeingCostReduction || []), { color, amount }] };
    return addLog(next, `${cardName}'s ${label} discounts ${playerId}'s next Being this turn by ${amount} ${nextBeingCostMatch[2]}.`);
  }

  const nextRelicCostMatch = text.match(NEXT_RELIC_COST_REDUCTION_RE);
  if (nextRelicCostMatch) {
    const amount = parseInt(nextRelicCostMatch[1], 10);
    const color = nextRelicCostMatch[2].toLowerCase();
    const next = { ...state, nextRelicCostReduction: { color, amount } };
    return addLog(next, `${cardName}'s ${label} discounts ${playerId}'s next Relic this turn by ${amount} ${nextRelicCostMatch[2]}.`);
  }

  if (SHUFFLE_HAND_DRAW_HALF_RE.test(text)) {
    const player = state.players[playerId];
    const handSize = player.hand.length;
    const shuffled = [...player.mainDeck, ...player.hand]
      .map(c => ({ c, sort: Math.random() }))
      .sort((a, b) => a.sort - b.sort)
      .map(({ c }) => c);
    let next = {
      ...state,
      players: { ...state.players, [playerId]: { ...player, hand: [], mainDeck: shuffled } },
    };
    next = addLog(next, `${cardName}'s ${label} shuffles ${playerId}'s hand (${handSize} card(s)) into their deck.`);
    const drawCount = Math.ceil(handSize / 2);
    const { state: afterDraw, drawnCount } = drawCardsFor(next, playerId, drawCount);
    return addLog(afterDraw, `${cardName}'s ${label} draws ${drawnCount} card(s) for ${playerId}.`);
  }

  const discardHandCraftMatch = text.match(DISCARD_HAND_CRAFT_DELAYED_DRAW_RE);
  if (discardHandCraftMatch) {
    const craftCount = parseInt(discardHandCraftMatch[1], 10);
    const extraDrawCount = parseInt(discardHandCraftMatch[2], 10);
    const player = state.players[playerId];
    const discardedCount = player.hand.length;
    let deck = player.effigyDeck;
    let pool = player.effigyPool;
    let crafted = 0;
    for (let i = 0; i < craftCount && deck.length > 0; i++) {
      pool = [...pool, deck[0]];
      deck = deck.slice(1);
      crafted++;
    }
    let next = {
      ...state,
      players: {
        ...state.players,
        [playerId]: {
          ...player,
          hand: [],
          purgatory: [...player.purgatory, ...player.hand.filter(c => !c.isToken)],
          effigyDeck: deck,
          effigyPool: pool,
          extraDrawNextTurn: (player.extraDrawNextTurn || 0) + extraDrawCount,
        },
      },
    };
    next = addLog(next, `${cardName}'s ${label} discards ${discardedCount} card(s) from ${playerId}'s hand and crafts ${crafted} Effigy.`);
    next = addLog(next, `${playerId} will draw ${extraDrawCount} additional card(s) at the start of their next turn.`);
    return endTurn(next);
  }

  const discardCostReductionMatch = text.match(DISCARD_THEN_COST_REDUCTION_RE);
  if (discardCostReductionMatch) {
    const amount = Math.abs(parseInt(discardCostReductionMatch[1], 10));
    const candidates = state.players[playerId].hand;
    const discardAndGrant = (st, card) => {
      const player = st.players[playerId];
      let next = {
        ...st,
        players: {
          ...st.players,
          [playerId]: {
            ...player,
            hand: player.hand.filter(c => c.instanceId !== card.instanceId),
            purgatory: purgatoryAfterAdding(player.purgatory, card),
            effigyPool: [...player.effigyPool, ...makeTemporaryEssence('faithless', amount)],
          },
        },
      };
      next = addLog(next, `${playerId} discards ${card.name} for ${cardName}'s ${label}.`);
      return addLog(next, `${cardName}'s ${label} grants ${playerId} ${amount} temporary Faithless Essence (usable this turn).`);
    };
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no card in ${playerId}'s hand to discard.`);
    }
    if (candidates.length === 1) {
      return discardAndGrant(state, candidates[0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a card to discard.`);
    return { ...next, pendingChoice: { kind: 'discard-chosen-cost-reduction', playerId, cardName, label, amount } };
  }

  const gainTimeCounterBlockMoveMatch = text.match(GAIN_TIME_COUNTER_BLOCKS_MOVE_RE);
  if (gainTimeCounterBlockMoveMatch) {
    const amount = parseInt(gainTimeCounterBlockMoveMatch[1], 10);
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being');
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being to target.`);
    }
    const applyTimeCounterBlock = (st, cellId) => {
      const occupant = st.board[cellId];
      const have = occupant.counters?.time || 0;
      const next = {
        ...st,
        board: { ...st.board, [cellId]: { ...occupant, counters: { ...occupant.counters, time: have + amount }, blockedWhileHasTimeCounters: true } },
      };
      return addLog(next, `${cardName}'s ${label} gives ${occupant.card.name} ${amount} Time Counter(s); it can not move while it has any.`);
    };
    if (candidates.length === 1) {
      return applyTimeCounterBlock(state, candidates[0][0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to target.`);
    return { ...next, pendingChoice: { kind: 'time-counter-block-move', playerId, cardName, label, amount } };
  }

  const revealTopSeedMatch = text.match(REVEAL_TOP_SEED_TO_HAND_SHUFFLE_RE);
  if (revealTopSeedMatch) {
    const count = parseInt(revealTopSeedMatch[1], 10);
    const player = state.players[playerId];
    const revealed = player.mainDeck.slice(0, count);
    const seedBeings = revealed.filter(c => c.kind === 'being' && (c.typing || '').toLowerCase().includes('seed'));
    const kept = revealed.filter(c => !seedBeings.includes(c));
    const shuffled = [...player.mainDeck.slice(count), ...kept]
      .map(c => ({ c, sort: Math.random() }))
      .sort((a, b) => a.sort - b.sort)
      .map(({ c }) => c);
    let next = {
      ...state,
      players: { ...state.players, [playerId]: { ...player, hand: [...player.hand, ...seedBeings], mainDeck: shuffled } },
    };
    next = addLog(next, `${cardName}'s ${label} reveals ${revealed.length} card(s) from ${playerId}'s deck.`);
    if (seedBeings.length > 0) {
      next = addLog(next, `${cardName}'s ${label} adds ${seedBeings.map(c => c.name).join(', ')} to ${playerId}'s hand.`);
    }
    return addLog(next, `${cardName}'s ${label} shuffles the rest back into ${playerId}'s deck.`);
  }

  const sacrificeNamedRevealRelicsMatch = text.match(SACRIFICE_NAMED_REVEAL_TOP_RELICS_RE);
  if (sacrificeNamedRevealRelicsMatch && context.selfCellId) {
    const armamentName = sacrificeNamedRevealRelicsMatch[1].trim();
    const count = parseInt(sacrificeNamedRevealRelicsMatch[2], 10);
    const occupant = state.board[context.selfCellId];
    const armIdx = (occupant?.armaments || []).findIndex(a => a.card.name === armamentName);
    if (!occupant || armIdx === -1) {
      return addLog(state, `${cardName}'s ${label} isn't automated yet: "${text}"`);
    }
    const armaments = occupant.armaments.filter((_, i) => i !== armIdx);
    let next = {
      ...state,
      board: { ...state.board, [context.selfCellId]: { ...occupant, armaments } },
    };
    next = addLog(next, `${playerId} sacrifices ${armamentName}.`);
    const player = next.players[playerId];
    const revealed = player.mainDeck.slice(0, count);
    const relics = revealed.filter(c => c.kind === 'relic' || c.kind === 'relic-armament');
    const kept = revealed.filter(c => !relics.includes(c));
    const shuffled = [...player.mainDeck.slice(count), ...kept]
      .map(c => ({ c, sort: Math.random() }))
      .sort((a, b) => a.sort - b.sort)
      .map(({ c }) => c);
    next = {
      ...next,
      players: { ...next.players, [playerId]: { ...player, hand: [...player.hand, ...relics], mainDeck: shuffled } },
    };
    next = addLog(next, `${cardName}'s ${label} reveals ${revealed.length} card(s) from ${playerId}'s deck.`);
    if (relics.length > 0) {
      next = addLog(next, `${cardName}'s ${label} adds ${relics.map(c => c.name).join(', ')} to ${playerId}'s hand.`);
    }
    return addLog(next, `${cardName}'s ${label} shuffles the rest back into ${playerId}'s deck.`);
  }

  // The Roots Remember: "Gain (1) Time Counter.\n If there are (0) Time
  // Counters on this conjure a (Living) Prophecy from your Purgatory." —
  // each line of a Prophecy's flip-trigger resolves independently and in
  // printed order (resolveProphecyModulateHitZero), so by the time this
  // SECOND line is reached, the FIRST line's own unconditional "Gain (1)
  // Time Counter" has already run — this really does re-check the live
  // Time Counter count on the board at this exact point, not a snapshot
  // from before the flip. `context.selfCellId` is only ever set once this
  // Prophecy already flipped face-up (the same context every other line
  // gets), so it reads `state.board[context.selfCellId].timer` directly.
  const conjureProphecyPurgatoryMatch = text.match(/^If there are\s*\(?0\)?\s+Time Counters on (?:this|it),?\s*conjure an?\s+\((\w+)\)\s+Prophecy from your Purgatory\.?$/i);
  if (conjureProphecyPurgatoryMatch && context.selfCellId) {
    if ((state.board[context.selfCellId]?.timer || 0) !== 0) return state;
    const color = conjureProphecyPurgatoryMatch[1].toLowerCase();
    const candidates = state.players[playerId].purgatory.filter(c => c.kind === 'prophecy' && Object.keys(c.castingCost?.colored || {}).includes(color));
    const emptyEthereal = ETHEREAL_CELLS.filter(c => !state.board[c]);
    if (candidates.length === 0 || emptyEthereal.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no (${color}) Prophecy in ${playerId}'s Purgatory to conjure, or no empty tile for it.`);
    }
    if (candidates.length === 1) return conjureProphecyFromPurgatory(state, playerId, cardName, label, candidates[0], emptyEthereal[0]);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a (${color}) Prophecy from Purgatory to conjure.`);
    return { ...next, pendingChoice: { kind: 'conjure-prophecy-purgatory', playerId, cardName, label, color, cellId: emptyEthereal[0] } };
  }

  const gainTimeCounterNoDisengageMatch = text.match(GAIN_TIME_COUNTER_NO_DISENGAGE_RE);
  if (gainTimeCounterNoDisengageMatch) {
    const amount = parseInt(gainTimeCounterNoDisengageMatch[1], 10);
    // Also targets an Animated Armament acting as a Being (RULES.md >
    // Keywords > Animated), the same actorView/writeActorState pattern
    // dealDamageToBeing already uses — its own topmost entry carries
    // `engaged`/`counters` instead of the stack occupant itself.
    const candidates = Object.entries(state.board).filter(([, o]) =>
      (o?.type === 'being' && o.engaged) || (o?.type === 'armament-stack' && animatedTopEntry(o)?.engaged));
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Engaged Being to target.`);
    }
    const applyFreezeFrame = (st, cellId) => {
      const occupant = st.board[cellId];
      const actingCard = actorView(occupant).card;
      const have = (occupant.type === 'being' ? occupant.counters : animatedTopEntry(occupant).counters)?.time || 0;
      const updated = writeActorState(occupant, {
        counters: { ...(occupant.type === 'being' ? occupant.counters : animatedTopEntry(occupant).counters), time: have + amount },
        doesNotDisengageWhileHasTimeCounters: true,
      });
      const next = { ...st, board: { ...st.board, [cellId]: updated } };
      return addLog(next, `${cardName}'s ${label} gives ${actingCard.name} ${amount} Time Counter(s); it won't disengage while it has any.`);
    };
    if (candidates.length === 1) {
      return applyFreezeFrame(state, candidates[0][0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose an Engaged Being to target.`);
    return { ...next, pendingChoice: { kind: 'freeze-frame-target', playerId, cardName, label, amount } };
  }

  const boardWipeCraftMatch = text.match(BOARD_WIPE_CRAFT_PER_BEING_RE);
  if (boardWipeCraftMatch) {
    const perBeing = parseInt(boardWipeCraftMatch[1], 10);
    const beingCellsByOwner = {};
    Object.keys(state.players).forEach(pid => { beingCellsByOwner[pid] = []; });
    Object.entries(state.board).forEach(([cell, o]) => {
      if (o?.type === 'being') beingCellsByOwner[o.ownerId].push(cell);
    });
    let next = addLog(state, `${cardName}'s ${label} sends every Being to Purgatory.`);
    Object.values(beingCellsByOwner).flat().forEach(cell => {
      if (next.board[cell]?.type === 'being') next = destroyBeing(next, cell);
    });
    Object.keys(state.players).forEach(pid => {
      const count = beingCellsByOwner[pid].length * perBeing;
      if (count === 0) return;
      const player = next.players[pid];
      let deck = player.effigyDeck;
      let pool = player.effigyPool;
      let crafted = 0;
      for (let i = 0; i < count && deck.length > 0; i++) {
        pool = [...pool, deck[0]];
        deck = deck.slice(1);
        crafted++;
      }
      next = { ...next, players: { ...next.players, [pid]: { ...player, effigyDeck: deck, effigyPool: pool } } };
      next = addLog(next, `${pid} crafts ${crafted} Effigy for the Beings they controlled.`);
    });
    next = addLog(next, `${cardName}'s ${label} ends the turn.`);
    return endTurn(next);
  }

  // Chronostasis: "Gain (2) Time Counters. \nBefore drawing a card(s) that
  // player may reveal the top card of their deck, they may shuffle." — a
  // Prophecy flip trigger with TWO clauses (GAIN_TIME_COUNTERS_RE below
  // would match only the first line and silently drop the second, the same
  // "additive bonus, ignored second line" precedent Growth Spurt's own
  // board-wide aura relies on — except Chronostasis's second clause has no
  // separate live-read mechanism to fall back on). Ruled as an immediate
  // simplification: rather than tracking a standing "before your next draw"
  // replacement effect, this resolves the reveal-and-maybe-shuffle right
  // away, at the moment Chronostasis itself flips — the same real value as
  // Foresight's own "look at the top card, may shuffle" (SHUFFLE_OR_KEEP_RE,
  // reusing its exact 'shuffle-or-keep' pendingChoice), just triggered by a
  // flip instead of a cast. Checked before the generic GAIN_TIME_COUNTERS_RE
  // so it isn't the one that matches first.
  const chronostasisMatch = /^Gain\s*\(?2\)?\s+Time Counters?\.\s*Before drawing a cards?\(?s?\)?,?\s*that player may reveal the top card of their deck,?\s*they may shuffle\.?$/i.test(text);
  if (chronostasisMatch && context.selfCellId && state.board[context.selfCellId]?.type === 'prophecy') {
    const occupant = state.board[context.selfCellId];
    const gained = { ...state, board: { ...state.board, [context.selfCellId]: { ...occupant, timer: (occupant.timer || 0) + 2 } } };
    let next = addLog(gained, `${cardName}'s ${label} gains 2 Time Counter(s).`);
    next = addLog(next, `${cardName}'s ${label} lets ${playerId} reveal the top card of their deck and choose whether to shuffle.`);
    return { ...next, pendingChoice: { kind: 'shuffle-or-keep', playerId, cardName, deckOwner: playerId } };
  }

  const gainTimeCountersMatch = text.match(GAIN_TIME_COUNTERS_RE);
  if (gainTimeCountersMatch && context.selfCellId && state.board[context.selfCellId]?.type === 'prophecy') {
    const amount = parseInt(gainTimeCountersMatch[1], 10);
    const occupant = state.board[context.selfCellId];
    const next = { ...state, board: { ...state.board, [context.selfCellId]: { ...occupant, timer: (occupant.timer || 0) + amount } } };
    return addLog(next, `${cardName}'s ${label} gains ${amount} Time Counter(s).`);
  }

  if (REVEAL_TOP_RE.test(text)) {
    const top = state.players[playerId].mainDeck[0];
    return addLog(state, top
      ? `${cardName}'s ${label} reveals ${top.name} from ${playerId}'s deck.`
      : `${cardName}'s ${label} finds no cards left in ${playerId}'s deck to reveal.`);
  }

  const lifespanGainPerTypingMatch = text.match(LIFESPAN_GAIN_PER_TYPING_RE);
  if (lifespanGainPerTypingMatch) {
    const perAmount = parseInt(lifespanGainPerTypingMatch[1], 10);
    const typings = lifespanGainPerTypingMatch[2].split(/,|\band\b/i).map(s => s.trim().toLowerCase()).filter(Boolean);
    const count = Object.values(state.board).filter(o => o?.type === 'being' && o.ownerId === playerId
      && typings.some(t => (o.card.typing || '').toLowerCase().includes(t))).length;
    const amount = perAmount * count;
    const player = state.players[playerId];
    const next = { ...state, players: { ...state.players, [playerId]: { ...player, lifespan: player.lifespan + amount } } };
    return addLog(next, `${cardName}'s ${label} grants ${playerId} ${amount} Lifespan (${perAmount} for each of ${count} matching Being(s)).`);
  }

  // Priestly Practitioner: "Restore (2) Lifespan." — printed with no
  // "target" wording, but per user ruling this is a real targeted ability
  // (any Being or player, not self-only), reusing the same
  // 'restore-lifespan-target' choice Elderflower Ancient/Sanative Siphon
  // already open. Every OTHER bare "gain/restore N Lifespan" card (Pruning
  // Sheers' own post-sacrifice benefit, a per-Being-typed scaling bonus) is
  // self-only by clear design, so this is gated on the card's own name
  // rather than widening LIFESPAN_GAIN_RE's match for everyone.
  if (cardName === 'Priestly Practitioner') {
    const priestlyMatch = text.match(LIFESPAN_GAIN_RE);
    if (priestlyMatch) {
      const amount = parseInt(priestlyMatch[1], 10);
      const next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose who restores ${amount} Lifespan.`);
      return { ...next, pendingChoice: { kind: 'restore-lifespan-target', playerId, cardName, label, amount } };
    }
  }

  const lifespanGainMatch = text.match(LIFESPAN_GAIN_RE);
  if (lifespanGainMatch) {
    const amount = parseInt(lifespanGainMatch[1], 10);
    const player = state.players[playerId];
    const next = { ...state, players: { ...state.players, [playerId]: { ...player, lifespan: player.lifespan + amount } } };
    return addLog(next, `${cardName}'s ${label} grants ${playerId} ${amount} Lifespan.`);
  }

  const lifespanLoseMatch = text.match(LIFESPAN_LOSE_RE);
  if (lifespanLoseMatch) {
    const amount = parseInt(lifespanLoseMatch[1], 10);
    const player = state.players[playerId];
    const next = { ...state, players: { ...state.players, [playerId]: { ...player, lifespan: player.lifespan - amount } } };
    return checkWin(addLog(next, `${cardName}'s ${label} costs ${playerId} ${amount} Lifespan.`));
  }

  const payLifespanBareMatch = text.match(PAY_LIFESPAN_BARE_RE);
  if (payLifespanBareMatch) {
    const amount = parseInt(payLifespanBareMatch[1], 10);
    const player = state.players[playerId];
    const next = { ...state, players: { ...state.players, [playerId]: { ...player, lifespan: player.lifespan - amount } } };
    return checkWin(addLog(next, `${cardName}'s ${label} costs ${playerId} ${amount} Lifespan.`));
  }

  if (SELF_BECOME_FAVORED_RE.test(text) && context.selfCellId && state.board[context.selfCellId]?.type === 'being') {
    const occupant = state.board[context.selfCellId];
    const next = { ...state, board: { ...state.board, [context.selfCellId]: { ...occupant, favorCounter: true } } };
    return addLog(next, `${cardName}'s ${label} becomes Favored.`);
  }

  const selfStatGainMatch = text.match(SELF_STAT_GAIN_RE);
  if (selfStatGainMatch && context.selfCellId && state.board[context.selfCellId]?.type === 'being') {
    const strength = parseInt(selfStatGainMatch[1], 10);
    const lifespan = parseInt(selfStatGainMatch[2], 10);
    const occupant = state.board[context.selfCellId];
    const permanentBonus = {
      strength: (occupant.permanentBonus?.strength || 0) + strength,
      lifespan: (occupant.permanentBonus?.lifespan || 0) + lifespan,
    };
    const next = {
      ...state,
      board: { ...state.board, [context.selfCellId]: { ...occupant, permanentBonus, currentLifespan: occupant.currentLifespan + lifespan } },
    };
    return addLog(next, `${cardName}'s ${label} grows +${strength}/+${lifespan}.`);
  }

  const switchWithTypedMatch = text.match(SWITCH_WITH_TYPED_RE);
  if (switchWithTypedMatch && context.selfCellId && state.board[context.selfCellId]?.type === 'being') {
    const typing = switchWithTypedMatch[1];
    const selfOccupant = state.board[context.selfCellId];
    const candidates = Object.entries(state.board).filter(([cell, o]) =>
      cell !== context.selfCellId && o?.type === 'being' && o.ownerId === playerId && (o.card.typing || '').toLowerCase().includes(typing.toLowerCase())
    );
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no other ${typing} of ${playerId}'s to switch with.`);
    }
    const doSwitch = (st, otherCellId) => {
      const other = st.board[otherCellId];
      const next = { ...st, board: { ...st.board, [context.selfCellId]: other, [otherCellId]: st.board[context.selfCellId] } };
      return addLog(next, `${cardName}'s ${label} switches ${selfOccupant.card.name} with ${other.card.name}.`);
    };
    if (candidates.length === 1) return doSwitch(state, candidates[0][0]);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a ${typing} to switch with.`);
    return { ...next, pendingChoice: { kind: 'switch-with-typed', playerId, cardName, label, typing, selfCellId: context.selfCellId } };
  }

  const triggerAllTypedMartyrMatch = text.match(TRIGGER_ALL_TYPED_MARTYR_RE);
  if (triggerAllTypedMartyrMatch) {
    const typing = triggerAllTypedMartyrMatch[1];
    const matches = Object.entries(state.board).filter(([, o]) =>
      o?.type === 'being' && o.ownerId === playerId && o.card.keywords?.martyr != null && (o.card.typing || '').toLowerCase().includes(typing.toLowerCase())
    );
    if (matches.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no ${typing} of ${playerId}'s with Martyr to trigger.`);
    }
    return matches.reduce((s, [cell, occupant]) => {
      let n = addLog(s, `${cardName}'s ${label} triggers ${occupant.card.name}'s Martyr for free (no sacrifice).`);
      return resolveOrLogEffect(n, playerId, occupant.card.name, occupant.card.keywords.martyr, 'Martyr', { selfCellId: cell });
    }, state);
  }

  const damageAllBeingsMatch = text.match(DAMAGE_ALL_BEINGS_RE);
  if (damageAllBeingsMatch) {
    const amount = parseInt(damageAllBeingsMatch[1], 10);
    const targets = Object.entries(state.board).filter(([, o]) => o?.type === 'being').map(([cell]) => cell);
    let next = addLog(state, `${cardName}'s ${label} deals ${amount} damage to all Beings.`);
    targets.forEach(cell => { next = dealDamageToBeing(next, cell, amount); });
    return next;
  }

  const massMoveNoDisengageMatch = text.match(MASS_MOVE_NO_DISENGAGE_RE);
  const massMoveMatch = massMoveNoDisengageMatch || text.match(MASS_MOVE_RE);
  if (massMoveMatch) {
    const direction = massMoveMatch[1].toLowerCase() === 'forward' ? 1 : 5;
    let next = state;
    const movedCells = [];
    Object.keys(state.board).forEach(cell => {
      const occupant = next.board[cell];
      if (!occupant || occupant.type !== 'being' || !occupant.card.arrows.includes(direction)) return;
      const toCellId = computeMoveDestination(occupant.ownerId, cell, direction);
      if (!toCellId || !emptyOrOwnArmamentStack(next.board[toCellId], occupant.ownerId)) return;
      next = moveBeingFreely(next, cell, toCellId);
      movedCells.push(toCellId);
    });
    next = addLog(next, movedCells.length > 0
      ? `${cardName}'s ${label} moves ${movedCells.length} Being(s) ${massMoveMatch[1].toLowerCase()}.`
      : `${cardName}'s ${label} finds no Being able to move ${massMoveMatch[1].toLowerCase()}.`);
    if (massMoveNoDisengageMatch) {
      movedCells.forEach(cell => {
        const o = next.board[cell];
        if (o) next = { ...next, board: { ...next.board, [cell]: { ...o, doesNotDisengage: true } } };
      });
    }
    return { ...next, lastMassMoveNoneMoved: movedCells.length === 0 };
  }

  if (IF_NONE_MOVE_FORCE_COMBAT_RE.test(text)) {
    if (!state.lastMassMoveNoneMoved) return state;
    const myBeings = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && o.ownerId === playerId);
    const theirBeings = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && o.ownerId !== playerId);
    if (myBeings.length === 0 || theirBeings.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being on both sides to force into combat.`);
    }
    if (myBeings.length === 1 && theirBeings.length === 1) {
      return forceCombatBetween(state, cardName, label, myBeings[0][0], theirBeings[0][0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being of theirs to force into combat.`);
    return { ...next, pendingChoice: { kind: 'force-combat-select-mine', playerId, cardName, label } };
  }

  const damageThenMoveMatch = text.match(DAMAGE_THEN_MOVE_ARMAMENT_HERE_RE);
  if (damageThenMoveMatch) {
    const amount = parseInt(damageThenMoveMatch[1], 10);
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being');
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being to target.`);
    }
    const resolveOn = (st, targetCellId) => {
      let next = dealDamageToBeing(st, targetCellId, amount);
      return moveNamedArmamentToTile(next, cardName, targetCellId);
    };
    if (candidates.length === 1) return resolveOn(state, candidates[0][0]);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to target.`);
    return { ...next, pendingChoice: { kind: 'damage-target', playerId, cardName, label, damage: amount, typing: null, includesPlayers: false, thenMoveArmament: cardName } };
  }

  if (NEXT_HUNGER_SACRIFICE_THIS_ONTO_TILE_RE.test(text) && context.selfCellId) {
    const selfInstanceId = state.board[context.selfCellId]?.card?.instanceId;
    const next = { ...state, nextHungerFreeSummonOnTile: { ownerId: playerId, cellId: context.selfCellId, instanceId: selfInstanceId } };
    return addLog(next, `${cardName}'s ${label} sets up a free Hunger summon directly onto its own tile, sacrificing itself when that happens.`);
  }

  if (IF_NONE_MOVE_RETURN_RE.test(text)) {
    if (!state.lastMassMoveNoneMoved) return state;
    return ['A', 'B'].reduce((s, pid) => {
      const candidates = Object.entries(s.board).filter(([, o]) => o?.type === 'being' && o.ownerId === pid);
      if (candidates.length !== 1) return s; // graceful: only auto-resolves the unambiguous single-candidate case
      return returnBeingToHand(s, candidates[0][0]);
    }, state);
  }

  if (TARGET_BECOME_FAVORED_TEMP_RE.test(text)) {
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && o.ownerId === playerId);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being of ${playerId}'s to target.`);
    }
    if (candidates.length === 1) {
      const [cell, occ] = candidates[0];
      const next = { ...state, board: { ...state.board, [cell]: { ...occ, favorCounter: true, favorCounterExpiresEndOfTurn: true } } };
      return addLog(next, `${cardName}'s ${label} makes ${occ.card.name} Favored until end of turn.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to become Favored until end of turn.`);
    return { ...next, pendingChoice: { kind: 'grant-favor', playerId, cardName } };
  }

  if (TARGET_BECOME_FAVORED_PERMANENT_OWN_RE.test(text)) {
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && o.ownerId === playerId);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being of ${playerId}'s to target.`);
    }
    if (candidates.length === 1) {
      const [cell, occ] = candidates[0];
      const next = { ...state, board: { ...state.board, [cell]: { ...occ, favorCounter: true } } };
      return addLog(next, `${cardName}'s ${label} makes ${occ.card.name} Favored.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to become Favored.`);
    return { ...next, pendingChoice: { kind: 'grant-favor', playerId, cardName, permanent: true } };
  }

  if (ALL_BEINGS_FAVORED_RE.test(text)) {
    const board = { ...state.board };
    let touched = 0;
    Object.entries(board).forEach(([cell, o]) => {
      if (o?.type !== 'being') return;
      board[cell] = { ...o, favorCounter: true, favorCounterExpiresEndOfTurn: true };
      touched++;
    });
    return addLog({ ...state, board }, `${cardName}'s ${label} makes ${touched} Being(s) Favored until end of turn.`);
  }

  // `typing`, when given (Greenseer: "target Familiar"), restricts
  // candidates to Beings whose own printed typing includes that word —
  // otherwise any Being, either owner, same as before.
  const grantFavorAny = (permanent, typing = null) => {
    const needle = typing?.toLowerCase();
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && (!needle || (o.card.typing || '').toLowerCase().includes(needle)));
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no ${typing || 'Being'} to target.`);
    }
    if (candidates.length === 1) {
      const [cell, occ] = candidates[0];
      const next = {
        ...state,
        board: { ...state.board, [cell]: { ...occ, favorCounter: true, ...(permanent ? {} : { favorCounterExpiresEndOfTurn: true }) } },
      };
      return addLog(next, `${cardName}'s ${label} makes ${occ.card.name} Favored${permanent ? '' : ' until end of turn'}.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a ${typing || 'Being'} to become Favored${permanent ? '' : ' until end of turn'}.`);
    return { ...next, pendingChoice: { kind: 'grant-favor', playerId, cardName, anyOwner: true, permanent, typing } };
  };

  if (TARGET_BECOME_FAVORED_TEMP_ANY_RE.test(text)) {
    return grantFavorAny(false);
  }

  if (TARGET_BECOME_FAVORED_PERMANENT_RE.test(text)) {
    return grantFavorAny(true);
  }

  const typedFavoredMatch = text.match(TARGET_TYPED_BECOME_FAVORED_TEMP_RE);
  if (typedFavoredMatch) {
    return grantFavorAny(false, typedFavoredMatch[1]);
  }

  const seedMatch = text.match(REVEAL_TOP_SEED_RE);
  if (seedMatch) {
    const seedTyping = seedMatch[1];
    const player = state.players[playerId];
    const top = player.mainDeck[0];
    if (!top) return addLog(state, `${cardName}'s ${label} reveals nothing — ${playerId}'s deck is empty.`);
    // revealPopup (Farm Hand's own bug report): the outcome itself is
    // already fully decided right here — no player choice, the printed
    // condition alone decides it — this transient field is purely a
    // "show the player what was revealed" overlay (Match.jsx), not a
    // pendingChoice; it never blocks or reorders anything and is cleared
    // by DISMISS_REVEAL_POPUP (a click, or the UI's own 30s auto-timeout).
    if ((top.typing || '').toLowerCase().includes(seedTyping.toLowerCase())) {
      const next = {
        ...state,
        players: { ...state.players, [playerId]: { ...player, mainDeck: player.mainDeck.slice(1), hand: [...player.hand, top] } },
        revealPopup: { playerId, card: top, outcome: 'drawn', cardName, label },
      };
      return addLog(next, `${cardName}'s ${label} reveals ${top.name} (a ${seedTyping} Being) and adds it to ${playerId}'s hand.`);
    }
    return addLog(
      { ...state, revealPopup: { playerId, card: top, outcome: 'kept', cardName, label } },
      `${cardName}'s ${label} reveals ${top.name} — not a ${seedTyping} Being, so it stays on top.`
    );
  }

  const lookMatch = text.match(LOOK_TOP_NO_OP_RE);
  if (lookMatch) {
    const count = lookMatch[1] ? parseInt(lookMatch[1], 10) : 1;
    const topNames = state.players[playerId].mainDeck.slice(0, count).map(c => c.name);
    return addLog(state, topNames.length
      ? `${cardName}'s ${label} looks at ${topNames.join(', ')} — order unchanged.`
      : `${cardName}'s ${label} finds ${playerId}'s deck empty.`);
  }

  const contrarianMatch = text.match(CONTRARIAN_RE);
  if (contrarianMatch) {
    const direction = contrarianMatch[1].toLowerCase();
    const cardA = state.players.A.mainDeck[0];
    const cardB = state.players.B.mainDeck[0];
    if (!cardA && !cardB) {
      return addLog(state, `${cardName}'s ${label} finds both players' decks empty.`);
    }
    const costA = cardA ? totalCastingCost(cardA) : null;
    const costB = cardB ? totalCastingCost(cardB) : null;
    let winners;
    if (costA === null) winners = ['B'];
    else if (costB === null) winners = ['A'];
    else if (costA === costB) winners = ['A', 'B'];
    else if (direction === 'lowest') winners = costA < costB ? ['A'] : ['B'];
    else winners = costA > costB ? ['A'] : ['B'];
    let next = state;
    winners.forEach(pid => {
      const p = next.players[pid];
      const [drawnCard, ...rest] = p.mainDeck;
      next = { ...next, players: { ...next.players, [pid]: { ...p, mainDeck: rest, hand: [...p.hand, drawnCard] } } };
    });
    return addLog(next, `${cardName}'s ${label} reveals ${cardA ? cardA.name : 'nothing'} (A) vs. ${cardB ? cardB.name : 'nothing'} (B) — ${winners.join(' and ')} draw${winners.length === 1 ? 's' : ''}.`);
  }

  const bottomMatch = text.match(BOTTOM_OF_DECK_RE);
  if (bottomMatch) {
    const hand = state.players[playerId].hand;
    if (hand.length === 0) return state;
    if (hand.length === 1) {
      const [card] = hand;
      const player = state.players[playerId];
      const next = { ...state, players: { ...state.players, [playerId]: { ...player, hand: [], mainDeck: [...player.mainDeck, card] } } };
      return addLog(next, `${cardName}'s ${label} puts ${card.name} on the bottom of ${playerId}'s deck.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a card from hand to put on the bottom of their deck.`);
    return { ...next, pendingChoice: { kind: 'bottom-of-deck', playerId, cardName } };
  }

  if (SHUFFLE_OR_KEEP_RE.test(text)) {
    const top = state.players[playerId].mainDeck[0];
    let next = addLog(state, top
      ? `${cardName}'s ${label} looks at ${top.name} on top of ${playerId}'s deck.`
      : `${cardName}'s ${label} finds ${playerId}'s deck empty.`);
    if (!top) return next;
    return { ...next, pendingChoice: { kind: 'shuffle-or-keep', playerId, cardName, deckOwner: playerId } };
  }

  const readTheBonesMatch = text.match(READ_THE_BONES_RE);
  if (readTheBonesMatch) {
    const typing = readTheBonesMatch[1];
    const count = state.players[playerId].purgatory.filter(c => (c.typing || '').toLowerCase().includes(typing.toLowerCase())).length;
    let next = addLog(state, `${cardName}'s ${label} looks at the top ${count} card(s) of ${playerId}'s deck (${count} ${typing} in Purgatory).`);
    if (count === 0 || state.players[playerId].mainDeck.length === 0) return next;
    return { ...next, pendingChoice: { kind: 'shuffle-or-keep', playerId, cardName, deckOwner: playerId } };
  }

  // "Look at the top card of an opponent's deck. You may have them
  // shuffle." (Foresight) — reuses the same 'shuffle-or-keep' pendingChoice
  // as SHUFFLE_OR_KEEP_RE above, but the deck being looked at/shuffled
  // belongs to the OPPONENT (deckOwner) while the CASTER (playerId) is
  // still the one who makes the choice.
  const lookOpponentTopMatch = text.match(LOOK_OPPONENT_TOP_MAY_SHUFFLE_RE);
  if (lookOpponentTopMatch) {
    const opponentId = opponentOf(playerId);
    const top = state.players[opponentId].mainDeck[0];
    let next = addLog(state, top
      ? `${cardName}'s ${label} reveals ${top.name} on top of ${opponentId}'s deck.`
      : `${cardName}'s ${label} finds ${opponentId}'s deck empty.`);
    if (!top) return next;
    return { ...next, pendingChoice: { kind: 'shuffle-or-keep', playerId, cardName, deckOwner: opponentId } };
  }

  if (REVEAL_PROPHECY_RE.test(text)) {
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'prophecy');
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Prophecy to reveal.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose whether to reveal a Prophecy.`);
    return { ...next, pendingChoice: { kind: 'reveal-prophecy', playerId, cardName, optional: true } };
  }

  const destroyOccupantMatch = text.match(DESTROY_OCCUPANT_RE);
  if (destroyOccupantMatch) {
    const targetKind = destroyOccupantMatch[1].toLowerCase();
    // "Destroy a Relic." (Desecration) — wider than a bare freestanding
    // Relic occupant, see gatherRelicTargets above.
    if (targetKind === 'relic') {
      const candidates = gatherRelicTargets(state.board);
      if (candidates.length === 0) {
        return addLog(state, `${cardName}'s ${label} has no Relic to destroy.`);
      }
      if (candidates.length === 1) {
        return destroyRelicTarget(state, candidates[0]);
      }
      let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Relic to destroy.`);
      return { ...next, pendingChoice: { kind: 'destroy-relic-target', playerId, cardName } };
    }
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === targetKind).map(([cell]) => cell);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no ${targetKind} to destroy.`);
    }
    if (candidates.length === 1) {
      return destroyPermanentAt(state, candidates[0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a ${targetKind} to destroy.`);
    return { ...next, pendingChoice: { kind: 'destroy-permanent', playerId, cardName, targetKind } };
  }

  if (DESTROY_ARMAMENT_RE.test(text)) {
    const entries = gatherArmamentEntries(state.board);
    if (entries.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Armament to destroy.`);
    }
    if (entries.length === 1) {
      return destroyArmamentEntryAt(state, entries[0].cellId, entries[0].armamentInstanceId);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose an Armament to destroy.`);
    return { ...next, pendingChoice: { kind: 'destroy-armament', playerId, cardName } };
  }

  if (SACRIFICE_PROPHECY_DESTROY_RE.test(text)) {
    const prophecyCandidates = Object.entries(state.board).filter(([, o]) => o?.type === 'prophecy' && o.ownerId === playerId);
    const destroyCandidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && !o.card.isDeity);
    if (prophecyCandidates.length === 0 || destroyCandidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no legal Prophecy to sacrifice and Being to destroy.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose whether to sacrifice a Prophecy to destroy a Being.`);
    return { ...next, pendingChoice: { kind: 'sacrifice-destroy', playerId, cardName, optional: true } };
  }

  if (OPPONENT_SACRIFICE_RE.test(text)) {
    const opponentId = opponentOf(playerId);
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && o.ownerId === opponentId);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} finds ${opponentId} with no Being to sacrifice.`);
    }
    if (candidates.length === 1) {
      const [cell, occ] = candidates[0];
      let next = addLog(state, `${opponentId} sacrifices ${occ.card.name} to ${cardName}'s ${label}.`);
      return destroyBeing(next, cell);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${opponentId} choose a Being to sacrifice.`);
    return { ...next, pendingChoice: { kind: 'sacrifice', playerId: opponentId, cardName } };
  }

  const isOptionalDoesntDisengage = DISTANT_DEBATOR_ENGAGE_RE.test(text);
  if (DOESNT_DISENGAGE_RE.test(text) || isOptionalDoesntDisengage) {
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && !o.card.isDeity);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no non-Deity Being to target.`);
    }
    const applyTo = (st, cell) => {
      const occ = st.board[cell];
      const next = { ...st, board: { ...st.board, [cell]: { ...occ, engaged: true, doesNotDisengage: true } } };
      return addLog(next, `${cardName}'s ${label} engages ${occ.card.name} — it won't disengage next Disengage Step.`);
    };
    // Distant Debator's own "you may" keeps this skippable even with a
    // single legal candidate — same generic `optional`/RESOLVE_DECLINE
    // affordance every other "you may" trigger already uses.
    if (candidates.length === 1 && !isOptionalDoesntDisengage) return applyTo(state, candidates[0][0]);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a non-Deity Being to engage.`);
    return { ...next, pendingChoice: { kind: 'doesnt-disengage', playerId, cardName, ...(isOptionalDoesntDisengage ? { optional: true } : {}) } };
  }

  if (COPY_STATS_RE.test(text) && context.selfCellId && state.board[context.selfCellId]?.type === 'being') {
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && o.ownerId === playerId);
    const applyTo = (st, cell) => {
      const target = st.board[cell];
      const self = st.board[context.selfCellId];
      const copiedStrength = effectiveStrength(target);
      const next = {
        ...st,
        board: {
          ...st.board,
          [context.selfCellId]: { ...self, strengthOverride: copiedStrength, currentLifespan: target.currentLifespan },
        },
      };
      return addLog(next, `${cardName}'s ${label} becomes ${copiedStrength}/${target.currentLifespan}, matching ${target.card.name}.`);
    };
    if (candidates.length === 1) return applyTo(state, candidates[0][0]);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to copy Strength/Lifespan from.`);
    return { ...next, pendingChoice: { kind: 'copy-stats', playerId, cardName, selfCellId: context.selfCellId } };
  }

  const buffAllyMatch = text.match(BUFF_ALLY_RE);
  if (buffAllyMatch) {
    const cost = parseInt(buffAllyMatch[1], 10);
    const typingWords = buffAllyMatch[2].split(/\s+(?:or|and)\s+/i).map(w => w.trim().toLowerCase());
    const strengthBonus = parseInt(buffAllyMatch[3], 10);
    const lifespanBonus = parseInt(buffAllyMatch[4], 10);
    const player = state.players[playerId];
    const candidates = Object.entries(state.board).filter(([cell, o]) =>
      o?.type === 'being' && o.ownerId === playerId && cell !== context.selfCellId &&
      typingWords.some(w => (o.card.typing || '').toLowerCase().includes(w))
    );
    if (candidates.length === 0 || player.lifespan - cost <= 0) {
      return addLog(state, `${cardName}'s ${label} has no legal target and/or can't afford its Lifespan cost.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose whether to pay ${cost} Lifespan to buff an ally.`);
    return { ...next, pendingChoice: { kind: 'buff-ally', playerId, cardName, cost, strengthBonus, lifespanBonus, optional: true } };
  }

  const giveDifferentTypedMatch = text.match(GIVE_DIFFERENT_TYPED_BUFF_RE);
  if (giveDifferentTypedMatch && context.selfCellId) {
    const typing = giveDifferentTypedMatch[1].trim();
    const strengthBonus = parseInt(giveDifferentTypedMatch[2], 10);
    const lifespanBonus = parseInt(giveDifferentTypedMatch[3], 10);
    const candidates = Object.entries(state.board).filter(([cell, o]) =>
      o?.type === 'being' && o.ownerId === playerId && cell !== context.selfCellId &&
      (o.card.typing || '').toLowerCase().includes(typing.toLowerCase())
    );
    const applyBuff = (st, cell) => {
      const occ = st.board[cell];
      const existing = occ.permanentBonus || { strength: 0, lifespan: 0 };
      const next2 = {
        ...st,
        board: {
          ...st.board,
          [cell]: {
            ...occ,
            permanentBonus: { strength: existing.strength + strengthBonus, lifespan: existing.lifespan + lifespanBonus },
            currentLifespan: occ.currentLifespan + lifespanBonus,
          },
        },
      };
      return addLog(next2, `${cardName}'s ${label} gives ${occ.card.name} +${strengthBonus}/+${lifespanBonus}.`);
    };
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no other ${typing} of ${playerId}'s to buff.`);
    }
    if (candidates.length === 1) return applyBuff(state, candidates[0][0]);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a ${typing} to buff.`);
    return {
      ...next,
      pendingChoice: { kind: 'give-different-typed-buff', playerId, cardName, label, strengthBonus, lifespanBonus, allowedCells: candidates.map(([cell]) => cell) },
    };
  }

  const forceShiftMatch = text.match(FORCE_OPPONENT_SHIFT_RE);
  if (forceShiftMatch) {
    const amount = parseInt(forceShiftMatch[1], 10);
    const opponentId = opponentOf(playerId);
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && o.ownerId === opponentId);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no opponent Being to force Shift.`);
    }
    if (candidates.length === 1) {
      return offerOrPerformShift(state, opponentId, candidates[0][0], { amount, effect: null });
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose an opponent's Being to force Shift.`);
    return { ...next, pendingChoice: { kind: 'force-shift-target', playerId, cardName, label, amount, allowedCells: candidates.map(([cell]) => cell) } };
  }

  const selfShiftMatch = text.match(SELF_SHIFT_RE);
  if (selfShiftMatch) {
    const amount = parseInt(selfShiftMatch[1], 10);
    const player = state.players[playerId];
    const card = player.purgatory.find(c => c.name === cardName);
    if (!card) {
      return addLog(state, `${cardName}'s ${label} has no copy of itself in ${playerId}'s Purgatory to Shift.`);
    }
    const removed = {
      ...state,
      players: { ...state.players, [playerId]: { ...player, purgatory: player.purgatory.filter(c => c.instanceId !== card.instanceId) } },
    };
    return offerOrShiftFromPurgatory(removed, playerId, card, amount);
  }

  const copyOpponentEffectMatch = COPY_OPPONENT_EFFECT_UNTIL_NEXT_TURN_RE.test(text);
  if (copyOpponentEffectMatch && context.selfCellId) {
    const opponentId = opponentOf(playerId);
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && o.ownerId === opponentId);
    const applyCopy = (st, targetCellId) => {
      const target = st.board[targetCellId];
      const self = st.board[context.selfCellId];
      if (!target || !self) return st;
      const next2 = { ...st, board: { ...st.board, [context.selfCellId]: grantCopiedEffectUntilNextTurn(self, target.card) } };
      return addLog(next2, `${cardName}'s ${label} copies ${target.card.name}'s effect(s) until the end of ${playerId}'s next turn.`);
    };
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no opponent Being to copy.`);
    }
    if (candidates.length === 1) return applyCopy(state, candidates[0][0]);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose an opponent's Being to copy.`);
    return {
      ...next,
      pendingChoice: { kind: 'copy-opponent-effect', playerId, cardName, label, selfCellId: context.selfCellId, allowedCells: candidates.map(([cell]) => cell) },
    };
  }

  const udarikMatch = text.match(UDARIK_FORCE_SHIFT_THEN_LOSE_RE);
  if (udarikMatch) {
    const shiftAmount = parseInt(udarikMatch[1], 10);
    const loseAmount = parseInt(udarikMatch[2], 10);
    // "This ability can not target a Being named Udarik Hunger" — excludes
    // any Being sharing THIS card's own name (itself, or another copy).
    const candidates = Object.entries(state.board).filter(([, o]) =>
      o?.type === 'being' && o.ownerId === playerId && o.card.name !== cardName
    );
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no legal Being of ${playerId}'s to target.`);
    }
    if (candidates.length === 1) {
      return offerOrPerformShift(state, playerId, candidates[0][0], { amount: shiftAmount, effect: null }, false, 0, loseAmount);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to Shift.`);
    return {
      ...next,
      pendingChoice: { kind: 'udarik-shift-target', playerId, cardName, label, shiftAmount, loseAmount, allowedCells: candidates.map(([cell]) => cell) },
    };
  }

  const counterMoveMatch = text.match(ARMAMENT_COUNTER_MOVE_RE);
  if (counterMoveMatch && context.selfCellId && context.armamentInstanceId) {
    const spend = parseInt(counterMoveMatch[1], 10);
    const counterType = counterMoveMatch[2].toLowerCase();
    const occupant = state.board[context.selfCellId];
    const entry = occupant?.armaments?.find(a => a.card.instanceId === context.armamentInstanceId);
    const have = entry?.counters?.[counterType] || 0;
    if (have < spend) {
      return addLog(state, `${cardName}'s ${label} has no ${counterType} Counters left to spend.`);
    }
    const armaments = occupant.armaments.map(a =>
      a.card.instanceId === context.armamentInstanceId
        ? { ...a, counters: { ...a.counters, [counterType]: have - spend } }
        : a
    );
    let next = {
      ...state,
      board: { ...state.board, [context.selfCellId]: { ...occupant, armaments } },
    };
    next = addLog(next, `${cardName}'s ${label} spends ${spend} ${counterType} Counter(s).`);
    // The "attached Being" is either a real one, or an Animated Armament
    // currently acting as one (RULES.md > Keywords > Animated) — Feathers
    // of the Fallen's own move-grant doesn't care which.
    if (!freeMoveEligible(occupant)) {
      return addLog(next, `${cardName}'s ${label} has no attached Being to move.`);
    }
    const actingName = occupant.card?.name || occupant.armaments[occupant.armaments.length - 1].card.name;
    const candidates = [...new Set([1, 2, 3, 4, 5, 6, 7, 8].map(dir => computeMoveDestination(playerId, context.selfCellId, dir)))]
      .filter(c => c && emptyOrOwnArmamentStack(state.board[c], playerId));
    if (candidates.length === 0) {
      return addLog(next, `${cardName}'s ${label} has nowhere to move ${actingName}.`);
    }
    if (candidates.length === 1) {
      return moveBeingFreely(next, context.selfCellId, candidates[0]);
    }
    next = addLog(next, `${cardName}'s ${label} lets ${playerId} choose where to move ${actingName}.`);
    return { ...next, pendingChoice: { kind: 'free-move', playerId, cardName, fromCellId: context.selfCellId } };
  }

  const relicCounterMoveMatch = text.match(RELIC_COUNTER_MOVE_RE);
  if (relicCounterMoveMatch && context.selfCellId && state.groundRelics[context.selfCellId]) {
    const spend = parseInt(relicCounterMoveMatch[1], 10);
    const counterType = relicCounterMoveMatch[2].toLowerCase();
    const relicOccupant = state.groundRelics[context.selfCellId];
    const have = relicOccupant.counters?.[counterType] || 0;
    if (have < spend) {
      return addLog(state, `${cardName}'s ${label} has no ${counterType} Counters left to spend.`);
    }
    let next = {
      ...state,
      groundRelics: {
        ...state.groundRelics,
        [context.selfCellId]: { ...relicOccupant, counters: { ...relicOccupant.counters, [counterType]: have - spend } },
      },
    };
    next = addLog(next, `${cardName}'s ${label} spends ${spend} ${counterType} Counter(s).`);
    // The destination (this Relic's own tile) only ever needs to be clear
    // of a board-tracked Being — the Relic itself never blocks it, same as
    // "Beings may move across this" already means for any other move.
    if (next.board[context.selfCellId]) {
      return addLog(next, `${cardName}'s ${label} has nowhere to place a Being — its own tile is occupied.`);
    }
    const candidates = Object.entries(next.board).filter(([, o]) => o?.type === 'being' && o.ownerId === playerId);
    if (candidates.length === 0) {
      return addLog(next, `${cardName}'s ${label} has no Being of ${playerId}'s to move here.`);
    }
    if (candidates.length === 1) {
      return moveBeingFreely(next, candidates[0][0], context.selfCellId);
    }
    next = addLog(next, `${cardName}'s ${label} lets ${playerId} choose which Being to move here.`);
    return { ...next, pendingChoice: { kind: 'move-target-being', playerId, cardName, toCellId: context.selfCellId } };
  }

  // "Until end of turn Plants summoned on this tile come in Disengaged."
  // (Tilled Fields) — flags this ground Relic's own tile; placeBeingOnBoard
  // reads the flag off it directly when a Plant-typed Being lands there.
  if (PLANTS_ENTER_DISENGAGED_RE.test(text) && context.selfCellId && state.groundRelics[context.selfCellId]) {
    const relicOccupant = state.groundRelics[context.selfCellId];
    const next = {
      ...state,
      groundRelics: { ...state.groundRelics, [context.selfCellId]: { ...relicOccupant, plantsEnterDisengagedUntilEndOfTurn: true } },
    };
    return addLog(next, `${cardName}'s ${label} lets Plants summoned on this tile enter Disengaged until end of turn.`);
  }


  const removeOwnCountersThenMatch = text.match(REMOVE_OWN_COUNTERS_THEN_RE);
  if (removeOwnCountersThenMatch && context.selfCellId && state.board[context.selfCellId]) {
    const spend = parseInt(removeOwnCountersThenMatch[1], 10);
    const counterType = removeOwnCountersThenMatch[2].toLowerCase();
    const effect = removeOwnCountersThenMatch[3].trim();
    const occupant = state.board[context.selfCellId];
    const have = occupant.counters?.[counterType] || 0;
    if (have < spend) {
      return addLog(state, `${cardName}'s ${label} has no ${counterType} Counters left to spend.`);
    }
    let next = {
      ...state,
      board: { ...state.board, [context.selfCellId]: { ...occupant, counters: { ...occupant.counters, [counterType]: have - spend } } },
    };
    next = addLog(next, `${cardName}'s ${label} spends ${spend} ${counterType} Counter(s).`);
    return resolveOrLogEffect(next, playerId, cardName, effect, label, context);
  }

  const removeOwnCountersMatch = text.match(REMOVE_OWN_COUNTERS_RE);
  if (removeOwnCountersMatch && context.selfCellId && state.board[context.selfCellId]) {
    const spend = parseInt(removeOwnCountersMatch[1], 10);
    const counterType = removeOwnCountersMatch[2].toLowerCase();
    const occupant = state.board[context.selfCellId];
    const have = occupant.counters?.[counterType] || 0;
    if (have < spend) {
      return addLog(state, `${cardName}'s ${label} has no ${counterType} Counters left to spend.`);
    }
    const next = {
      ...state,
      board: { ...state.board, [context.selfCellId]: { ...occupant, counters: { ...occupant.counters, [counterType]: have - spend } } },
    };
    return addLog(next, `${cardName}'s ${label} spends ${spend} ${counterType} Counter(s).`);
  }

  const selfMoveMatch = text.match(SELF_MOVE_WITHOUT_ENGAGING_RE);
  if (selfMoveMatch && context.selfCellId) {
    const occupant = state.board[context.selfCellId];
    const candidates = [...new Set([1, 2, 3, 4, 5, 6, 7, 8].map(dir => computeMoveDestination(playerId, context.selfCellId, dir)))]
      .filter(c => c && emptyOrOwnArmamentStack(state.board[c], playerId));
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has nowhere to move.`);
    }
    if (candidates.length === 1) {
      return moveBeingFreely(state, context.selfCellId, candidates[0]);
    }
    // A real Being carries its own top-level `card`; an Animated Armament
    // acting as one (moveBeingFreely, just above, already handles this
    // same shape) doesn't — occupant.card.name unconditionally crashed the
    // moment context.selfCellId held one instead (self-play found this a
    // real, reachable crash).
    const actingCard = occupant.card || occupant.armaments[occupant.armaments.length - 1].card;
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose where ${actingCard.name} moves.`);
    return { ...next, pendingChoice: { kind: 'free-move', playerId, cardName, fromCellId: context.selfCellId } };
  }

  // "Move target Being (1) tile in any direction" (Divine Winds) and
  // "Target Being you control moves to a tile with an Armament on it"
  // (Prepare for Battle) — both a two-step "pick a Being, then pick a
  // destination" choice, via the shared startMoveSequence/
  // moveOrOfferFreeMove helpers; they only differ in which Beings are
  // legal sources (ownerFilter) and destinations (destinationFilter).
  const moveTargetAnyMatch = text.match(MOVE_TARGET_ANY_ONE_TILE_RE);
  const moveToArmamentMatch = text.match(MOVE_TO_ARMAMENT_TILE_RE);
  if (moveTargetAnyMatch || moveToArmamentMatch) {
    const ownerFilter = moveToArmamentMatch ? 'own' : 'any';
    const destinationFilter = moveToArmamentMatch ? 'armament' : 'any';
    return startMoveSequence(state, playerId, cardName, label, ownerFilter, destinationFilter);
  }

  if (MOVE_TARGET_OWN_FORWARD_RE.test(text)) {
    const moveForward = (st, cell) => {
      const occupant = st.board[cell];
      const dest = computeMoveDestination(playerId, cell, 1);
      if (!dest || !freeMoveDestinationOk(st, playerId, dest, 'any')) {
        return addLog(st, `${cardName}'s ${label} has nowhere for ${occupant.card.name} to move.`);
      }
      return moveBeingFreely(st, cell, dest);
    };
    const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && o.ownerId === playerId).map(([cell]) => cell);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Being of ${playerId}'s to move.`);
    }
    if (candidates.length === 1) {
      return moveForward(state, candidates[0]);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to move forward.`);
    return { ...next, pendingChoice: { kind: 'move-forward-target', playerId, cardName, label } };
  }

  // "Move target Armament you control to a tile this points to." (Ay-gruhda)
  if (MOVE_ARMAMENT_POINTED_RE.test(text) && context.selfCellId) {
    const armamentCandidates = [];
    Object.entries(state.board).forEach(([cell, o]) => {
      if (!o || o.ownerId !== playerId || !o.armaments) return;
      o.armaments.forEach(a => armamentCandidates.push({ cellId: cell, armamentInstanceId: a.card.instanceId }));
    });
    if (armamentCandidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Armament of ${playerId}'s to move.`);
    }
    if (armamentCandidates.length === 1) {
      return placeMovedArmament(state, playerId, cardName, label, armamentCandidates[0].cellId, armamentCandidates[0].armamentInstanceId, context);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose an Armament to move.`);
    return { ...next, pendingChoice: { kind: 'move-armament-source', playerId, cardName, label, context } };
  }

  // "Move an Armament in any direction." (Smith Assistant's own Engage) —
  // same "gather every Armament entry the player controls" source step as
  // Ay-gruhda above, just handed off to the "any direction" destination
  // geometry (placeMovedArmamentAnyDirection) instead of the pointed one.
  if (MOVE_ARMAMENT_ANY_DIRECTION_RE.test(text)) {
    const armamentCandidates = [];
    Object.entries(state.board).forEach(([cell, o]) => {
      if (!o || o.ownerId !== playerId || !o.armaments) return;
      o.armaments.forEach(a => armamentCandidates.push({ cellId: cell, armamentInstanceId: a.card.instanceId }));
    });
    if (armamentCandidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no Armament of ${playerId}'s to move.`);
    }
    if (armamentCandidates.length === 1) {
      return placeMovedArmamentAnyDirection(state, playerId, cardName, label, armamentCandidates[0].cellId, armamentCandidates[0].armamentInstanceId);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose an Armament to move.`);
    return { ...next, pendingChoice: { kind: 'move-armament-any-source', playerId, cardName, label } };
  }

  // Sha-KaRah: "move an adjacent Armament one tile in any direction." — see
  // MOVE_ADJACENT_ARMAMENT_ANY_DIRECTION_RE's own comment for how this
  // differs from MOVE_ARMAMENT_ANY_DIRECTION_RE above (adjacent-to-self,
  // either owner, vs. board-wide, own Armaments only).
  if (MOVE_ADJACENT_ARMAMENT_ANY_DIRECTION_RE.test(text) && context.selfCellId) {
    const adjacentCells = [...new Set([1, 2, 3, 4, 5, 6, 7, 8].map(dir => computeMoveDestination(playerId, context.selfCellId, dir)))].filter(Boolean);
    const armamentCandidates = [];
    adjacentCells.forEach(cell => {
      const o = state.board[cell];
      if (o?.armaments) o.armaments.forEach(a => armamentCandidates.push({ cellId: cell, armamentInstanceId: a.card.instanceId }));
    });
    if (armamentCandidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no adjacent Armament to move.`);
    }
    if (armamentCandidates.length === 1) {
      return placeMovedArmamentAnyDirection(state, playerId, cardName, label, armamentCandidates[0].cellId, armamentCandidates[0].armamentInstanceId);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose an adjacent Armament to move.`);
    return { ...next, pendingChoice: { kind: 'move-adjacent-armament-source', playerId, cardName, label, selfCellId: context.selfCellId } };
  }

  // Echo chamber: move the caster's own Being, THEN — once that fully
  // resolves, however many steps it takes — move an opponent's. See
  // MOVE_OWN_THEN_OPPONENT_RE's own comment for why this isn't just two
  // generically-split clauses.
  if (MOVE_OWN_THEN_OPPONENT_RE.test(text)) {
    return startMoveSequence(state, playerId, cardName, label, 'own', 'any', { ownerFilter: 'opponent', destinationFilter: 'any' });
  }

  // "Summon a/an <Name> token on this tile" — checked before the more
  // general SUMMON_TOKEN_RE below, which would otherwise match the same
  // text (its capture just stops at "token", ignoring "on this tile") and
  // default to an empty-cell choice instead of honoring the explicit
  // location.
  const summonTokenOnTileMatch = text.match(SUMMON_TOKEN_ON_TILE_RE);
  if (summonTokenOnTileMatch) {
    const makeToken = TOKEN_REGISTRY[summonTokenOnTileMatch[1].trim().toLowerCase()];
    if (!makeToken) return addLog(state, `${cardName}'s ${label} isn't automated yet: "${text}"`);
    if (!context.selfCellId || state.board[context.selfCellId]) {
      return addLog(state, `${cardName}'s ${label} has no empty tile to summon a token on.`);
    }
    const token = makeToken();
    let next = placeTokenOnBoard(state, playerId, token, context.selfCellId);
    return addLog(next, `${cardName}'s ${label} summons ${token.name} at ${context.selfCellId}.`);
  }

  // "create a Rat token on the tile it moved from" (Hoarder) — see
  // MOVE_OR_ATTACK's move branch for where movedFromCellId comes from.
  const createTokenMovedFromMatch = text.match(CREATE_TOKEN_MOVED_FROM_RE);
  if (createTokenMovedFromMatch && context.movedFromCellId) {
    const makeToken = TOKEN_REGISTRY[createTokenMovedFromMatch[1].trim().toLowerCase()];
    if (!makeToken) return addLog(state, `${cardName}'s ${label} isn't automated yet: "${text}"`);
    if (state.board[context.movedFromCellId]) {
      return addLog(state, `${cardName}'s ${label} has no empty tile to create a token on.`);
    }
    const token = makeToken();
    let next = placeTokenOnBoard(state, playerId, token, context.movedFromCellId);
    return addLog(next, `${cardName}'s ${label} creates ${token.name} at ${context.movedFromCellId}.`);
  }

  // "Summon (1) 0/2 Vine token on the tile it moved from." (Imneyat Dryad) —
  // same moved-from placement as createTokenMovedFromMatch just above,
  // fixed to the Vine token instead of a name captured from the text.
  if (SUMMON_VINE_MOVED_FROM_RE.test(text) && context.movedFromCellId) {
    if (state.board[context.movedFromCellId]) {
      return addLog(state, `${cardName}'s ${label} has no empty tile to summon a token on.`);
    }
    const token = TOKEN_REGISTRY['vine']();
    let next = placeTokenOnBoard(state, playerId, token, context.movedFromCellId);
    return addLog(next, `${cardName}'s ${label} summons ${token.name} at ${context.movedFromCellId}.`);
  }

  const createTokenChoiceMatch = text.match(CREATE_TOKEN_CHOICE_RE);
  if (createTokenChoiceMatch) {
    const options = [createTokenChoiceMatch[1].trim().toLowerCase(), createTokenChoiceMatch[2].trim().toLowerCase()]
      .filter(key => TOKEN_REGISTRY[key]);
    if (options.length === 0) {
      return addLog(state, `${cardName}'s ${label} isn't automated yet: "${text}"`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose which token to create.`);
    return { ...next, pendingChoice: { kind: 'create-token-choice', playerId, cardName, label, options } };
  }

  // "Summon a 0/2 Vine token on a tile this points to" (Sporangium) — same
  // "points to" candidate geometry as summonPointedMatch just below, fixed
  // to the Vine token instead of a name captured from the text (see
  // SUMMON_VINE_POINTED_RE above for why this needs its own branch).
  if (SUMMON_VINE_POINTED_RE.test(text) && context.selfCellId) {
    const selfArrows = context.selfArrows || state.board[context.selfCellId]?.card?.arrows || [];
    const candidates = [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, context.selfCellId, dir)))]
      .filter(c => c && !state.board[c] && !state.groundRelics[c]);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no empty tile it points to, to summon a token on.`);
    }
    if (candidates.length === 1) {
      const token = TOKEN_REGISTRY.vine();
      let next = placeTokenOnBoard(state, playerId, token, candidates[0]);
      return addLog(next, `${cardName}'s ${label} summons ${token.name} at ${candidates[0]}.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a tile it points to, to summon a token on.`);
    return { ...next, pendingChoice: { kind: 'summon-token-pointed', playerId, cardName, tokenName: 'vine', label, allowedCells: candidates } };
  }

  // "Summon (N) <Name> token(s) ... on any tile this points to" (Blooming
  // Seed's Blooming Vine Token) — checked before SUMMON_TOKEN_ALL_POINTED_RE
  // below, which matches "on all tiles", a different (no-choice, place-on-
  // every-pointed-tile) shape. `selfArrows` prefers the context value
  // SACRIFICE_THIS_THEN_RE's resolver captured (the caster may already be
  // gone from the board by the time this runs), falling back to reading
  // them live off context.selfCellId for any future card that reaches this
  // pattern without going through a self-sacrifice first.
  const summonPointedMatch = text.match(SUMMON_TOKEN_POINTED_RE);
  if (summonPointedMatch && context.selfCellId) {
    const tokenName = summonPointedMatch[2].trim().toLowerCase();
    const makeToken = TOKEN_REGISTRY[tokenName];
    if (!makeToken) return addLog(state, `${cardName}'s ${label} isn't automated yet: "${text}"`);
    const selfArrows = context.selfArrows || state.board[context.selfCellId]?.card?.arrows || [];
    const candidates = [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, context.selfCellId, dir)))]
      .filter(c => c && !state.board[c] && !state.groundRelics[c]);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no empty tile it points to, to summon a token on.`);
    }
    if (candidates.length === 1) {
      const token = makeToken();
      let next = placeTokenOnBoard(state, playerId, token, candidates[0]);
      return addLog(next, `${cardName}'s ${label} summons ${token.name} at ${candidates[0]}.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a tile it points to, to summon a token on.`);
    return { ...next, pendingChoice: { kind: 'summon-token-pointed', playerId, cardName, tokenName, label, allowedCells: candidates } };
  }

  const summonAllPointedMatch = text.match(SUMMON_TOKEN_ALL_POINTED_RE);
  if (summonAllPointedMatch && context.selfCellId) {
    const makeToken = TOKEN_REGISTRY[summonAllPointedMatch[1].trim().toLowerCase()];
    if (!makeToken) return addLog(state, `${cardName}'s ${label} isn't automated yet: "${text}"`);
    // A "Beings may move across this" token (Shifting Sands) still lands on
    // a tile a Being already occupies — it co-locates into groundRelics
    // (see placeTokenOnBoard), same as placing one from hand onto an
    // occupied tile. Anything else still needs a genuinely empty tile.
    const coLocatesWithBeings = !!makeToken().keywords?.beingsMayMoveAcross;
    const selfArrows = state.board[context.selfCellId]?.card?.arrows || [];
    const targets = [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, context.selfCellId, dir)))].filter(Boolean);
    let next = state;
    let placed = 0;
    targets.forEach(targetCellId => {
      if (next.groundRelics[targetCellId]) return; // a ground Relic is already here — skip
      const boardOccupant = next.board[targetCellId];
      if (boardOccupant && !(coLocatesWithBeings && boardOccupant.type === 'being')) return; // genuinely blocked — skip
      // Al khali the Empty's own arrows reach all the way across the
      // midline (RULES.md — direction 1 "forward" points at the
      // OPPONENT'S front row), so a token landing on the far side belongs
      // to whichever player's own side that tile actually is, not
      // whoever cast this — same as any other permanent, control follows
      // the board zone it's sitting on, not its caster.
      const targetOwnerId = owningPlayerOfRow(parseCellId(targetCellId).row) || playerId;
      next = placeTokenOnBoard(next, targetOwnerId, makeToken(), targetCellId);
      placed++;
    });
    return addLog(next, `${cardName}'s ${label} summons ${placed} ${summonAllPointedMatch[1].trim()} token(s) on tiles it points to.`);
  }

  // "Add a/an <Name> token to hand" (Grave robber) — checked before the
  // plain "summon" pattern below since this is a different verb entirely.
  const addTokenMatch = text.match(ADD_TOKEN_TO_HAND_RE);
  if (addTokenMatch) {
    const makeToken = TOKEN_REGISTRY[addTokenMatch[1].trim().toLowerCase()];
    if (!makeToken) return addLog(state, `${cardName}'s ${label} isn't automated yet: "${text}"`);
    const token = makeToken();
    const player = state.players[playerId];
    const next = { ...state, players: { ...state.players, [playerId]: { ...player, hand: [...player.hand, token] } } };
    return addLog(next, `${cardName}'s ${label} adds ${token.name} to ${playerId}'s hand.`);
  }

  // "Add a/an <Name> to hand" with no "token" word (Skeptic) — same
  // TOKEN_REGISTRY lookup as ADD_TOKEN_TO_HAND_RE above, just a bare name.
  const addNamedTokenBareMatch = text.match(ADD_NAMED_TOKEN_TO_HAND_BARE_RE);
  if (addNamedTokenBareMatch) {
    const makeToken = TOKEN_REGISTRY[addNamedTokenBareMatch[1].trim().toLowerCase()];
    if (!makeToken) return addLog(state, `${cardName}'s ${label} isn't automated yet: "${text}"`);
    const token = makeToken();
    const player = state.players[playerId];
    const next = { ...state, players: { ...state.players, [playerId]: { ...player, hand: [...player.hand, token] } } };
    return addLog(next, `${cardName}'s ${label} adds ${token.name} to ${playerId}'s hand.`);
  }

  // "Summon a 0/2 Vine token on an empty tile adjacent to another Vine you
  // control." (Crawling Growth) — checked before the generic
  // SUMMON_TOKEN_RE below, which would otherwise match "Summon a 0/2 Vine
  // token" too (capturing "0/2 Vine" instead of just "Vine") and fail the
  // TOKEN_REGISTRY lookup before ever reaching this branch. Candidates are
  // empty Mortal Realm tiles adjacent to any Vine the caster controls (a
  // Vine can be adjacent to more than one candidate tile, and more than
  // one Vine can share candidates — de-duplicated via the Set).
  if (SUMMON_VINE_ADJACENT_RE.test(text)) {
    const myVineCells = Object.entries(state.board)
      .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId && o.card.name === 'Vine')
      .map(([cell]) => cell);
    const candidates = [...new Set(myVineCells.flatMap(adjacentCells))]
      .filter(c => !state.board[c] && mortalCellsFor(playerId).includes(c));
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no empty tile adjacent to a Vine of ${playerId}'s.`);
    }
    if (candidates.length === 1) {
      const token = TOKEN_REGISTRY.vine();
      let next = placeTokenOnBoard(state, playerId, token, candidates[0]);
      return addLog(next, `${cardName}'s ${label} summons ${token.name} at ${candidates[0]}.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a tile to summon a token on.`);
    return { ...next, pendingChoice: { kind: 'token-location', playerId, cardName, tokenName: 'vine', allowedCells: candidates } };
  }

  // "Summon a 0/2 Vine token on target empty tile you control." (Ravenous
  // Growth) — same shape as summonTokenMatch above, just a fixed token
  // name (the "0/2 " prefix keeps this from matching SUMMON_TOKEN_RE).
  if (SUMMON_VINE_TARGET_TILE_RE.test(text)) {
    const candidates = emptyMortalCellsFor(state.board, playerId);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no empty tile of ${playerId}'s to summon a token on.`);
    }
    if (candidates.length === 1) {
      const token = TOKEN_REGISTRY.vine();
      let next = placeTokenOnBoard(state, playerId, token, candidates[0]);
      return addLog(next, `${cardName}'s ${label} summons ${token.name} at ${candidates[0]}.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a tile to summon a token on.`);
    return { ...next, pendingChoice: { kind: 'token-location', playerId, cardName, tokenName: 'vine' } };
  }

  // "Summon (2) 0/2 vine being tokens on tiles you control." (Spreading
  // Roots) — no choice offered in the text; auto-places on up to N of the
  // caster's own empty tiles in a stable order (same "no choice" precedent
  // as SUMMON_ALL_POINTED_RE's own mass placement above).
  const summonVineMultiMatch = text.match(SUMMON_VINE_MULTI_RE);
  if (summonVineMultiMatch) {
    const count = parseInt(summonVineMultiMatch[1], 10);
    const candidates = emptyMortalCellsFor(state.board, playerId).sort();
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no empty tile of ${playerId}'s to summon a token on.`);
    }
    let next = state;
    let placed = 0;
    candidates.slice(0, count).forEach(cell => {
      next = placeTokenOnBoard(next, playerId, TOKEN_REGISTRY.vine(), cell);
      placed++;
    });
    return addLog(next, `${cardName}'s ${label} summons ${placed} Vine token(s) on tiles ${playerId} controls.`);
  }

  const maySummonVinePointedMatch = text.match(MAY_SUMMON_VINE_POINTED_RE);
  if (maySummonVinePointedMatch && context.selfCellId) {
    const count = parseInt(maySummonVinePointedMatch[1], 10);
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose whether to summon up to ${count} Vine token(s) on tiles it points to.`);
    return { ...next, pendingChoice: { kind: 'may-summon-vine-pointed', playerId, cardName, label, count, context, optional: true } };
  }

  // "Summon a/an <Name> token" with no explicit location — the common
  // case (Bone collector, Cookie, Ditch Digger "Steve" all just say this):
  // defaults to an empty Mortal Realm cell the player controls.
  const summonTokenMatch = text.match(SUMMON_TOKEN_RE);
  if (summonTokenMatch) {
    const count = summonTokenMatch[1] ? parseInt(summonTokenMatch[1], 10) : 1;
    const tokenName = summonTokenMatch[2].trim().toLowerCase();
    if (!TOKEN_REGISTRY[tokenName]) return addLog(state, `${cardName}'s ${label} isn't automated yet: "${text}"`);
    const candidates = emptyMortalCellsFor(state.board, playerId);
    if (candidates.length === 0) {
      return addLog(state, `${cardName}'s ${label} has no empty tile of ${playerId}'s to summon a token on.`);
    }
    if (count > 1) {
      // Same 'token-location' choice as the single-token case below, just
      // opened `count` times in a row (RESOLVE_TOKEN_LOCATION's own
      // `remaining` field reopens it after each placement) — the player
      // picks where each token lands instead of the engine auto-placing
      // them on sorted empty tiles (Scā-vuhk Hunger's own report: "allow
      // the player to decide where the tokens are summoned"). Degrades
      // gracefully exactly like the single-token branch below if the board
      // runs out of empty tiles partway through.
      let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose ${count} tile(s) to summon ${TOKEN_REGISTRY[tokenName]().name} tokens on.`);
      return { ...next, pendingChoice: { kind: 'token-location', playerId, cardName, tokenName, remaining: count } };
    }
    if (candidates.length === 1) {
      const token = TOKEN_REGISTRY[tokenName]();
      let next = placeTokenOnBoard(state, playerId, token, candidates[0]);
      return addLog(next, `${cardName}'s ${label} summons ${token.name} at ${candidates[0]}.`);
    }
    let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a tile to summon a token on.`);
    return { ...next, pendingChoice: { kind: 'token-location', playerId, cardName, tokenName } };
  }

  return addLog(state, `${cardName}'s ${label} isn't automated yet: "${text}"`);
};

// Shift (RULES.md > Keywords > Shift, real reminder text on Shifting
// Shade): "Engage: Move this onto a tile in the Ethereal Realm, it
// becomes a Prophecy, then gains (X) Time Counter(s) and [the default
// return ability]; While it is a Prophecy it loses all other text and
// typings." — the transformed occupant is a completely ordinary `type:
// 'prophecy'` (same `timer`, same automatic per-turn tick, same
// resolveProphecyModulateHitZero lifecycle below as any printed Prophecy)
// so nothing else needs to learn a new occupant shape. Its own printed
// quoted text ("Shift (1): \"X\"") is re-parsed through parseKeywords —
// the SAME single-choke-point trick grantBorrowedTextBox (Wretched
// Remnants) uses — so it becomes the shifted form's own real ability
// while active; with no quote, the card is left with no ability at all
// (an empty textBox), matching "loses all other text" literally.
// `shiftedFromCard` stashes the original Being card so returnFromShift
// below can reconstruct it. `shiftOverride` (`{amount, effect}`), when
// given, is used in place of the mover's own printed `card.keywords.shift`
// — for a card that FORCES some other Being to Shift by a printed amount
// of its own (Chains of the Unbound: "Target Being an opponent controls
// Shifts (1)"), regardless of whether that Being has Shift printed on it
// at all. `playerId` here is always the shifted Being's OWNER (whoever
// ends up controlling the new Prophecy), not necessarily whoever caused
// the Shift — "Whenever a Being you control Shifts" (triggerOnOwnBeingShiftReactions)
// is scoped to that owner too, and fires for every Shift regardless of
// what caused it.
// Finds the first Relic anywhere on the board (either owner — neither
// Mouth of Madness nor Terranean Gates says "you control") carrying the
// given keyword, if any — used by the Boundless Hunger bounce loop below.
const relicWithKeywordAnywhere = (board, keywordField) => {
  const found = Object.values(board).find(o => o?.type === 'relic' && o.card.keywords?.[keywordField]);
  return found ? found.card.keywords[keywordField] : null;
};

// `duringEndStep`/`bounceCount` thread the Boundless Hunger bounce loop
// through this whole mutually-recursive Shift/return chain (performShift
// <-> placeReturnedFromShift/returnFromShift via
// resolveProphecyModulateHitZero) — see the loop's own comment on
// placeReturnedFromShift below for the full mechanism. Every other real
// caller leaves both at their defaults (false/0): a normal player-
// initiated Shift never bounces.
// `postShiftLoseAmount` is Údarik Hunger's own "...then loses (X) Time
// Counter(s)" follow-up (see UDARIK_FORCE_SHIFT_THEN_LOSE_RE below) —
// applied immediately after landing in the Ethereal Realm, on top of
// whatever the Shift itself just granted. Threaded through as far as
// resolveProphecyModulateHitZero/returnFromShift/placeReturnedFromShift
// need it, so the "if it moves into the Mortal Realm this turn Disengage
// it" half still applies even when the resulting return needs its own
// real player choice along the way.
const performShift = (state, playerId, fromCellId, toCellId, shiftOverride = null, duringEndStep = false, bounceCount = 0, postShiftLoseAmount = 0) => {
  const occupant = state.board[fromCellId];
  const shift = shiftOverride || occupant.card.keywords.shift;
  const board = { ...state.board };
  dropArmamentsOrDryadMount(board, fromCellId, occupant);
  board[toCellId] = {
    type: 'prophecy', ownerId: playerId,
    card: { ...occupant.card, textBox: shift.effect || '', typing: '', keywords: parseKeywords(shift.effect || '', occupant.card.name) },
    timer: shift.amount, faceDown: false,
    shiftedFromCard: occupant.card,
  };
  let next = addLog({ ...state, board }, `${occupant.card.name} Shifts (${shift.amount}) and becomes a Prophecy in the Ethereal Realm at ${toCellId}.`);
  next = triggerOnOwnBeingShiftReactions(next, playerId, duringEndStep);
  // Terranean Gates: "If a Being moves into the Ethereal Realm during End
  // Phase it loses (X) Time Counters" — half of the Boundless Hunger
  // bounce loop (Immen Gorta + Mouth of Madness + Terranean Gates,
  // confirmed intentional with the user), capped at 100 bounces as a hard
  // safety stop rather than looping forever. `bounceCount` itself isn't
  // incremented again here — it only counts real activations (each return
  // trip, in placeReturnedFromShift below), not this purely mechanical
  // "immediately hits 0 again" continuation on the way back to the next one.
  if (duringEndStep && bounceCount < 100) {
    const loseAmount = relicWithKeywordAnywhere(next.board, 'duringEndStepLoseTimeCounters');
    if (loseAmount) {
      const current = next.board[toCellId];
      const timer = Math.max(0, (current?.timer || 0) - loseAmount);
      next = addLog(
        { ...next, board: { ...next.board, [toCellId]: { ...current, timer } } },
        `${occupant.card.name} loses ${loseAmount} Time Counter(s) (Terranean Gates).`
      );
      next = resolveProphecyModulateHitZero(next, toCellId, duringEndStep, bounceCount);
    }
  }
  if (postShiftLoseAmount > 0) {
    const current = next.board[toCellId];
    if (current) {
      const timer = Math.max(0, (current.timer || 0) - postShiftLoseAmount);
      next = addLog(
        { ...next, board: { ...next.board, [toCellId]: { ...current, timer } } },
        `${occupant.card.name} loses ${postShiftLoseAmount} Time Counter(s).`
      );
      next = resolveProphecyModulateHitZero(next, toCellId, false, 0, postShiftLoseAmount);
    }
  }
  return next;
};

// The "offer a destination, or just place it" half of Shift, shared by
// ACTIVATE_SHIFT (a Being shifting itself) and any forced-Shift effect
// (Chains of the Unbound, Mouth of Madness) — same free-choice-among-
// empty-tiles precedent as SUMMON_BEING/token placement. `duringEndStep`
// always auto-picks the first empty tile instead of ever opening a
// pendingChoice — a hundred-iteration automatic bounce cascade has no
// natural pause point to ask the player anything.
const offerOrPerformShift = (state, playerId, fromCellId, shiftOverride = null, duringEndStep = false, bounceCount = 0, postShiftLoseAmount = 0) => {
  const occupant = state.board[fromCellId];
  const emptyEthereal = ETHEREAL_CELLS.filter(c => !state.board[c]);
  if (emptyEthereal.length === 0) {
    return addLog(state, `${occupant.card.name} has no empty tile in the Ethereal Realm to Shift onto.`);
  }
  if (emptyEthereal.length === 1 || duringEndStep) {
    return performShift(state, playerId, fromCellId, emptyEthereal[0], shiftOverride, duringEndStep, bounceCount, postShiftLoseAmount);
  }
  let next = addLog(state, `${playerId} Shifts ${occupant.card.name} and chooses an Ethereal Realm tile.`);
  return { ...next, pendingChoice: { kind: 'shift-destination', playerId, fromCellId, shiftOverride, postShiftLoseAmount, allowedCells: emptyEthereal } };
};

// Echoes of the Boundless's own "Shift instead of Purgatory" — places a
// card that ISN'T currently on the board (it just came out of Purgatory)
// as a fresh shifted Prophecy, same shape performShift builds but with no
// origin cell to vacate/drop Armaments from and no quoted Shift text of
// its own (a generic forced Shift, same "loses all other text" treatment
// as any other Shift while active).
const shiftFromPurgatory = (state, playerId, card, toCellId, amount) => {
  const board = { ...state.board };
  board[toCellId] = {
    type: 'prophecy', ownerId: playerId,
    card: { ...card, textBox: '', typing: '', keywords: {} },
    timer: amount, faceDown: false,
    shiftedFromCard: card,
  };
  let next = addLog({ ...state, board }, `${card.name} Shifts (${amount}) from Purgatory and becomes a Prophecy in the Ethereal Realm at ${toCellId}.`);
  return triggerOnOwnBeingShiftReactions(next, playerId);
};

// Same "offer a destination, or just place it" shape as offerOrPerformShift
// above, for a card with no board `fromCellId` (Echoes of the Boundless).
const offerOrShiftFromPurgatory = (state, playerId, card, amount) => {
  const emptyEthereal = ETHEREAL_CELLS.filter(c => !state.board[c]);
  if (emptyEthereal.length === 0) {
    return addLog(state, `${card.name} has no empty tile in the Ethereal Realm to Shift onto.`);
  }
  if (emptyEthereal.length === 1) return shiftFromPurgatory(state, playerId, card, emptyEthereal[0], amount);
  let next = addLog(state, `${playerId} Shifts ${card.name} from Purgatory and chooses an Ethereal Realm tile.`);
  return { ...next, pendingChoice: { kind: 'shift-from-purgatory-destination', playerId, card, amount, allowedCells: emptyEthereal } };
};

// The Roots Remember: "conjure a (Living) Prophecy from your Purgatory." —
// a REAL conjure, distinct from shiftFromPurgatory above: the card keeps
// its own printed text (nothing is lost the way an actual Shift loses all
// other text) and flips/resolves normally later, same as PLAY_PROPHECY's
// own placement, just for free and sourced from Purgatory instead of hand.
const conjureProphecyFromPurgatory = (state, playerId, cardName, label, card, cellId) => {
  const player = state.players[playerId];
  const purgatory = player.purgatory.filter(c => c.instanceId !== card.instanceId);
  const next = {
    ...state,
    board: { ...state.board, [cellId]: { type: 'prophecy', ownerId: playerId, card, timer: card.timerMax, faceDown: true } },
    players: { ...state.players, [playerId]: { ...player, purgatory } },
  };
  return addLog(next, `${cardName}'s ${label} conjures ${card.name} from ${playerId}'s Purgatory as a face-down Prophecy at ${cellId}.`);
};

// Echoes of the Boundless: "Whenever another Being dies it's controller
// may pay its Summoning cost to Shift (X) instead of sending it to
// Purgatory. Damage is still dealt from it dying." — the normal death
// pipeline (which already deals its own Lifespan damage — "damage is
// still dealt" per the card's own text) has already sent the card to
// Purgatory by the time this runs; pulling that SAME card back out and
// placing it as a shifted Prophecy produces an identical end state to a
// true replacement effect, without needing to intercept the death
// pipeline itself. Offered whenever ANY Echoes of the Boundless is
// anywhere on the board (no "you control" printed) and the dying card's
// own controller can actually afford its own Summoning cost. Same
// one-choice-at-a-time guard as triggerWretchedRemnantsOffer.
const triggerEchoesOfBoundlessOffer = (state, dyingOwnerId, dyingCard) => {
  if (state.pendingChoice) return state;
  // "Another Being" excludes Echoes of the Boundless dying to its own
  // trigger — a different copy of it elsewhere on the board still counts.
  const found = Object.values(state.board).find(o =>
    o?.type === 'being' && o.card.keywords?.onAnyBeingDiedMayShiftInstead && o.card.instanceId !== dyingCard.instanceId
  );
  if (!found) return state;
  const owner = state.players[dyingOwnerId];
  if (!canPayCost(owner.effigyPool, dyingCard.castingCost)) return state;
  const amount = found.card.keywords.onAnyBeingDiedMayShiftInstead;
  const next = addLog(state, `${dyingCard.name}'s death lets ${dyingOwnerId} choose whether to pay its Summoning cost to Shift it instead of leaving it in Purgatory.`);
  return { ...next, pendingChoice: { kind: 'echoes-boundless-shift-instead', playerId: dyingOwnerId, dyingCard, amount, optional: true } };
};

// "Whenever a Being you control Shifts, X" (Sanative Siphon's first
// clause; Thōgrakin Hunger, with its own "except during the end step"
// exception) — fires from performShift above for EVERY Shift, whether
// caused by the Being's own Shift ability or a forced Shift from another
// card. Sanative Siphon is itself a Relic, not a Being, so this scans both
// shapes (unlike most reaction scans here, which are Being-only).
const triggerOnOwnBeingShiftReactions = (state, playerId, duringEndStep = false) => {
  let next = state;
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.ownerId !== playerId || (occupant.type !== 'being' && occupant.type !== 'relic')) return;
    const reaction = occupant.card.keywords?.onOwnBeingShift;
    if (!reaction || (reaction.exceptEndStep && duringEndStep)) return;
    next = addLog(next, `${occupant.card.name}'s reaction triggers.`);
    next = resolveOrLogEffect(next, playerId, occupant.card.name, reaction.effect, 'Reaction', { selfCellId: cell });
  });
  return next;
};

// Reconstructs a shifted Being back from its Prophecy form once its own
// return trip actually lands (see returnFromShift below) — full printed
// Lifespan (a Prophecy tracks no damage of its own to carry over) and
// Engaged, same as Shifting Shade's own default "...move it onto a tile
// in the Mortal Realm Engaged" reminder text. A card's own separate "When
// this moves into the Mortal Realm, X" line fires on top, same real
// trigger-point/generic-resolver treatment as every other reaction here.
// The Boundless Hunger bounce loop (Immen Gorta's own quoted Shift decay
// + Mouth of Madness + Terranean Gates — confirmed intentional with the
// user, meant to illustrate the loop via Immen Gorta's own "deal (1)
// damage to any target" firing on each of its first 3 return trips before
// its controller wins outright): while Mouth of Madness is actually on
// the board the loop will keep re-firing right after this, so forcing the
// next Shift immediately (rather than waiting on a still-open target
// choice) would silently clobber whatever the player just picked — see
// the `next.pendingChoice` check below, which instead stashes a
// `boundlessHunger` continuation onto the choice itself
// (continueBoundlessHungerBounce, just below this function) so
// RESOLVE_DAMAGE_TARGET(_PLAYER) can pick the bounce back up once the
// player actually resolves it. This real-choice treatment is scoped to
// Immen Gorta BY NAME (`isBoundlessHungerCard` below) — no other real
// card shares this shape, and one that hypothetically did would still
// have nowhere safe to pause across up to 100 bounces, so it keeps the
// old `autoTargetOpponentId` bypass (see resolveOrLogEffect's own
// damageAnyMatch branch) unchanged.
// `disengageOnReturn` is Údarik Hunger's own "...if it moves into the
// Mortal Realm this turn Disengage it" — lands Engaged as normal (per
// Shift's own default ending) and is THEN explicitly Disengaged as a
// separate follow-up step, same "returns Engaged, then the ability
// disengages it" sequencing the user described. Never true for the
// Boundless Hunger bounce loop (`duringEndStep`) — Údarik's own Engage
// activation only ever happens mid-turn, not during automatic End Phase
// processing, so the two flags never co-occur in practice.
//
// `landDisengaged` (default true) is the general-purpose version of the
// same idea: a shifted Being lands Engaged per its own printed text, but
// if this specific return is happening at a point where its controller's
// own Disengage step for the CURRENT turn has already run (or will never
// run again this turn) — a mid-turn card-granted Modulate bringing it to
// 0, a multi-tile RESOLVE_SHIFT_RETURN choice the player resolves after
// beginTurn's own disengage() already passed, or an End Phase decay tick
// (applyEndOfTurnShiftDecay, turn.js) — it would otherwise sit Engaged for
// a whole extra turn it was never supposed to lose, rather than being
// swept up by "that same turn's Disengage step" per the user's own
// framing of the ruling. The ONE call site that should NOT do this is
// turn.js's own `modulate()` — the automatic per-turn tick runs BEFORE
// beginTurn's disengage() in that same synchronous pass, so the normal
// step still catches it naturally moments later; that's the only place
// this is explicitly passed `false`.
const placeReturnedFromShift = (state, cellId, toCellId, duringEndStep = false, bounceCount = 0, disengageOnReturn = false, landDisengaged = true) => {
  const occupant = state.board[cellId];
  const card = occupant.shiftedFromCard;
  const board = { ...state.board };
  delete board[cellId];
  board[toCellId] = { type: 'being', ownerId: occupant.ownerId, card, currentLifespan: card.lifespan, engaged: true };
  let next = addLog({ ...state, board }, `${card.name} moves into the Mortal Realm at ${toCellId}, Engaged.`);
  const reaction = card.keywords?.onMovedIntoMortalRealm;
  if (reaction) {
    // Bypass the real "any target" choice only for a card OTHER than Immen
    // Gorta sharing this forced-bounce shape (no real card does today —
    // see the 100-bounce-cap test) — it has nowhere safe to pause across
    // up to 100 automatic bounces. Immen Gorta itself now always gets a
    // real choice (see isBoundlessHungerCard below), deferring the forced
    // re-Shift via a `boundlessHunger` continuation instead of bypassing.
    const activeBounceLoop = duringEndStep && !!relicWithKeywordAnywhere(state.board, 'duringEndStepForceShift');
    const isBoundlessHungerCard = card.name === 'Immen Gorta, the Boundless Hunger';
    next = resolveOrLogEffect(next, occupant.ownerId, card.name, reaction, 'Reaction', {
      selfCellId: toCellId,
      ...(activeBounceLoop && !isBoundlessHungerCard ? { autoTargetOpponentId: opponentOf(occupant.ownerId) } : {}),
    });
    // The player just chose (or is about to choose) where Immen Gorta's
    // damage goes for this iteration — forcing the next Shift, or
    // declaring the loop win, has to wait for that choice to actually
    // resolve (RESOLVE_DAMAGE_TARGET / RESOLVE_DAMAGE_TARGET_PLAYER below
    // call continueBoundlessHungerBounce once it does), so bail out here
    // rather than falling through to the forced-reshift/disengage/legend-
    // rule tail below.
    if (next.pendingChoice && activeBounceLoop && isBoundlessHungerCard) {
      return { ...next, pendingChoice: { ...next.pendingChoice, boundlessHunger: { toCellId, ownerId: occupant.ownerId, card, bounceCount } } };
    }
  }
  // Mouth of Madness: "If a Being moves into the Mortal Realm during End
  // Phase it Shifts (X)." — the other half of the bounce loop, forcing
  // the Being right back out using Mouth of Madness's OWN printed amount
  // (not the Being's own Shift, if it even has one). `bounceCount + 1`
  // here is the one real increment in the whole cascade — it counts
  // completed activations (this return trip, which already dealt its own
  // damage above), capped at 100 as the user's own hard safety stop.
  if (duringEndStep && bounceCount < 100) {
    const forceAmount = relicWithKeywordAnywhere(next.board, 'duringEndStepForceShift');
    if (forceAmount && next.board[toCellId]?.type === 'being') {
      next = addLog(next, `${card.name} is forced to Shift again (Mouth of Madness).`);
      next = offerOrPerformShift(next, occupant.ownerId, toCellId, { amount: forceAmount, effect: null }, duringEndStep, bounceCount + 1);
    }
  }
  if (disengageOnReturn || landDisengaged) {
    const landed = next.board[toCellId];
    if (landed?.type === 'being' && landed.engaged) {
      next = addLog(
        { ...next, board: { ...next.board, [toCellId]: { ...landed, engaged: false } } },
        `${card.name} Disengages (it moved into the Mortal Realm this turn).`
      );
    }
  }
  // This writes a fresh `type: 'being'` occupant directly rather than going
  // through placeBeingOnBoard (a Shift return is a very different shape —
  // no cost, no When Summoned, a fixed destination tile), so it needs its
  // own legend-rule check — same "at most one same-named Deity" enforcement
  // placeBeingOnBoard's own end already does, just duplicated here since
  // this is the one other real path a Being (Deity included — nothing
  // stops a Deity from being forced to Shift by another card) lands on the
  // board as a going concern. Same `!next.pendingChoice` guard for the same
  // reason: this engine only ever tracks one pendingChoice at a time.
  if (card.isDeity && !next.pendingChoice) {
    next = enforceDeityLegendRule(next, occupant.ownerId, card.name);
  }
  // Shift's own return trip can only resolve one "which tile?" choice at a
  // time — if a second shifted Being was ALSO sitting at 0-or-fewer Time
  // Counters when this one needed a multi-tile choice made for a different
  // return earlier this same tick, it was left waiting rather than retried
  // (returnFromShift's own comment). Retried here, once the coast is clear
  // (no pendingChoice currently open — from this placement itself or from
  // the legend-rule check just above), rather than leaving it stuck until
  // the owner's next turn ticks it again.
  return retryStuckShiftReturns(next, landDisengaged);
};

// Picks the Boundless Hunger bounce loop back up once Immen Gorta's own
// per-iteration "any target" damage choice (stashed as `boundlessHunger`
// on the pendingChoice by placeReturnedFromShift above) actually resolves.
// Called from RESOLVE_DAMAGE_TARGET / RESOLVE_DAMAGE_TARGET_PLAYER below,
// after the damage itself has already been applied. `bounceCount` is 0 on
// Immen Gorta's first (non-forced) return, so the 3rd illustrated choice
// (the loop's 3rd return) is bounceCount === 2 — per the user's own
// ruling, the controller gets a real target choice for all 3 (unlike the
// old auto-bypass, which silently skipped the first 2 and skipped dealing
// any damage at all for the 3rd), and only once that 3rd choice resolves
// does the loop get declared and the game move to the loop screen.
const continueBoundlessHungerBounce = (state, { toCellId, ownerId, card, bounceCount }) => {
  if (bounceCount === 2) {
    const mouthOfMadness = Object.values(state.board).find(o => o?.type === 'relic' && o.card.keywords?.duringEndStepForceShift)?.card;
    const terraneanGates = Object.values(state.board).find(o => o?.type === 'relic' && o.card.keywords?.duringEndStepLoseTimeCounters)?.card;
    const loopNext = addLog(state, `${ownerId} has assembled the Boundless Hunger loop (Mouth of Madness + Terranean Gates + ${card.name}) — ${opponentOf(ownerId)} concedes.`);
    return {
      ...loopNext,
      phase: 'gameover',
      winner: ownerId,
      loopWin: { winnerId: ownerId, cards: [mouthOfMadness, terraneanGates, card].filter(Boolean) },
    };
  }
  const forceAmount = relicWithKeywordAnywhere(state.board, 'duringEndStepForceShift');
  if (forceAmount && state.board[toCellId]?.type === 'being') {
    const next = addLog(state, `${card.name} is forced to Shift again (Mouth of Madness).`);
    return offerOrPerformShift(next, ownerId, toCellId, { amount: forceAmount, effect: null }, true, bounceCount + 1);
  }
  return state;
};

// Shift's own return trip, fired from resolveProphecyModulateHitZero below
// once a shifted Prophecy's Time Counters reach 0 — same free-choice-
// among-empty-tiles precedent as SUMMON_BEING/token placement (auto-place
// on the one legal candidate, otherwise open a real pendingChoice). If a
// pendingChoice is already claimed (rare: more than one shifted Being
// returning in the very same automatic tick pass) this waits with an
// honest log instead of clobbering it — same one-choice-at-a-time
// precedent logDepartIfPresent already establishes elsewhere.
// `duringEndStep` always auto-picks the first empty tile instead — see
// offerOrPerformShift's own comment: the Boundless Hunger bounce loop has
// nowhere to pause. `landDisengaged` (see placeReturnedFromShift's own
// comment) only matters for the auto-place branch here — the multi-tile
// pendingChoice branch deliberately does NOT stash it, since by the time a
// player actually resolves that choice (RESOLVE_SHIFT_RETURN, a separate
// later dispatch), the current turn's Disengage step has unconditionally
// already run regardless of what it was when the choice first opened —
// RESOLVE_SHIFT_RETURN's own call to placeReturnedFromShift relies on that
// function's own `true` default instead.
const returnFromShift = (state, cellId, duringEndStep = false, bounceCount = 0, disengageOnReturn = false, landDisengaged = true) => {
  const occupant = state.board[cellId];
  const card = occupant.shiftedFromCard;
  const emptyCells = emptyMortalCellsFor(state.board, occupant.ownerId);
  if (emptyCells.length === 0) {
    return addLog(state, `${card.name} has no empty tile in the Mortal Realm to return to.`);
  }
  if (emptyCells.length === 1 || duringEndStep) {
    return placeReturnedFromShift(state, cellId, emptyCells[0], duringEndStep, bounceCount, disengageOnReturn, landDisengaged);
  }
  if (state.pendingChoice) {
    return addLog(state, `${card.name}'s return from the Ethereal Realm doesn't resolve yet — still waiting on an earlier choice.`);
  }
  let next = addLog(state, `${occupant.ownerId} chooses where ${card.name} returns to the Mortal Realm.`);
  return { ...next, pendingChoice: { kind: 'shift-return', playerId: occupant.ownerId, cellId, disengageOnReturn, allowedCells: emptyCells } };
};

// Scans for any OTHER shifted Being still sitting at 0-or-fewer Time
// Counters (stuck behind an earlier multi-tile shift-return choice, per
// returnFromShift's own one-choice-at-a-time comment) and retries it
// immediately, rather than leaving it to wait for the owner's next turn's
// automatic tick. Called from placeReturnedFromShift itself, so this
// naturally chains through however many are stuck at once — each
// successful auto-place removes exactly one candidate from the board,
// guaranteeing termination — and stops cleanly the moment a retry itself
// needs its own multi-tile choice (the `!state.pendingChoice` guard below
// then leaves the rest for the NEXT time this runs, once that choice
// resolves).
const retryStuckShiftReturns = (state, landDisengaged = true) => {
  if (state.pendingChoice) return state;
  const stuckCellId = Object.entries(state.board).find(([, o]) =>
    o?.type === 'prophecy' && !o.faceDown && o.shiftedFromCard && (o.timer || 0) <= 0
  )?.[0];
  return stuckCellId ? returnFromShift(state, stuckCellId, false, 0, false, landDisengaged) : state;
};

// A Prophecy's own two-phase Time Counter lifecycle (RULES.md >
// Prophecies), shared by both places a Prophecy's Time Counters can be
// decremented to 0: the automatic per-controller-turn tick (turn.js >
// modulate) and a card-granted "Modulate (±X)" effect (RESOLVE_MODULATE,
// below) — both write the already-decremented `timer` onto the board
// first, then call this to finalize whatever that reaches:
//   - Face-down, timer 0: flips face up and resolves its own printed text
//     one line at a time (most real Prophecies are more than one
//     independent sentence, not joined by "then", so each line gets its
//     own resolveOrLogEffect call rather than only the first pattern that
//     matches the whole blob). A "Gain (N) Time Counters" line
//     (GAIN_TIME_COUNTERS_RE, above) is what gives it a real, nonzero
//     Time Counter total for the face-up half below — if nothing granted
//     it any (Al khali the Empty has no such line), it's fully resolved
//     immediately and goes to Purgatory in this same step, same as it
//     always has. A line matching `card.keywords.skipsControllerDraw`'s own
//     text is skipped here — it's an ongoing effect read live by drawStep
//     for as long as this stays face-up (see cardData.js), not a one-time
//     action, so resolving it here would just log a spurious "isn't
//     automated yet".
//   - Face-up, timer 0: its own new Time Counters (from the flip above)
//     just ran out — already resolved back at the flip, so this is just
//     cleanup: straight to Purgatory, no further effect.
// A Prophecy still above 0 either way is a no-op (the caller already wrote
// its new timer onto the board).
export const resolveProphecyModulateHitZero = (state, cellId, duringEndStep = false, bounceCount = 0, disengageOnReturn = false, landDisengaged = true) => {
  const occupant = state.board[cellId];
  if (!occupant || occupant.type !== 'prophecy' || (occupant.timer || 0) > 0) return state;

  const sendToPurgatory = (s) => {
    const found = s.board[cellId];
    if (!found) return s;
    let next = addLog(s, `${found.card.name}'s Prophecy resolves and is sent to Purgatory.`);
    const owner = next.players[found.ownerId];
    const board = { ...next.board };
    delete board[cellId];
    return {
      ...next,
      board,
      players: { ...next.players, [found.ownerId]: { ...owner, purgatory: purgatoryAfterAdding(owner.purgatory, found.card) } },
    };
  };

  if (!occupant.faceDown) {
    // A shifted Being (occupant.shiftedFromCard — see performShift above)
    // returns to the Mortal Realm instead of going to Purgatory; a real
    // printed Prophecy has no such field and takes the normal ending.
    if (occupant.shiftedFromCard) return returnFromShift(state, cellId, duringEndStep, bounceCount, disengageOnReturn, landDisengaged);
    return sendToPurgatory(state);
  }

  let next = { ...state, board: { ...state.board, [cellId]: { ...occupant, faceDown: false } } };
  const lines = stripFlavorText(occupant.card.textBox || '').split('\n').map(l => l.trim()).filter(Boolean);
  lines.forEach(line => {
    if (occupant.card.keywords?.skipsControllerDraw && /do not draw during the start of your turn/i.test(line)) return;
    // Blood Moon's own "Whenever a Being dies..." line is a live, ongoing
    // passive (read off the board by triggerAnyBeingDiedGiveDifferentBuff
    // whenever a death actually happens), not a one-time flip effect.
    if (occupant.card.keywords?.onAnyBeingDiedGiveDifferentBuff && /^Whenever a Being dies/i.test(line)) return;
    const prophecyLine = selfReferentialWhenSummonedText(line, occupant.card.name);
    next = resolveOrLogEffect(next, occupant.ownerId, occupant.card.name, prophecyLine, 'Prophecy', { selfCellId: cellId });
  });

  const flipped = next.board[cellId];
  if (!flipped || (flipped.timer || 0) <= 0) {
    return sendToPurgatory(next);
  }
  return addLog(next, `${occupant.card.name} flips face up with ${flipped.timer} Time Counter(s).`);
};

// Depart's trigger point: fires the moment a Being with the keyword dies.
// `cellId` (the tile the Being died on, already empty by the time this
// runs) is passed through as context.selfCellId so a "Summon a token on
// this tile" Depart effect (e.g. Cobra) knows where "this tile" is.
const logDepartIfPresent = (state, occupant, cellId) => {
  // Engrave: "Beings you control gain 'Depart: Summon a Bag o' Bones
  // token'." — a one-time grant applied directly onto each currently-
  // controlled Being (see the ENGRAVE_GRANT_DEPART_RE branch below), not a
  // continuous aura, so it's just a permanent field read here alongside the
  // card's own printed Depart keyword.
  const effect = occupant.card.keywords?.depart || occupant.grantedDepart;
  if (!effect) return state;
  // Two Beings can die in the same mutual combat (MOVE_OR_ATTACK resolves
  // the attacker-dies branch, then the defender-dies branch, each calling
  // this) — if the first Depart already opened a pendingChoice (e.g.
  // Vassal Matriach's own "you may pay Lifespan to Summon..."), firing a
  // second Depart here risks silently clobbering it: every pendingChoice-
  // opening branch in resolveOrLogEffect just overwrites state.pendingChoice
  // unconditionally, since this engine only ever tracks one choice at a
  // time (no queueing — see the identical reasoning where SUMMON_BEING
  // skips the legend rule check for the same reason). Rather than risk that
  // silent loss, the second Depart is skipped with an honest log instead —
  // the first Being to die (always the attacker, in combat) still gets its
  // own Depart resolved normally.
  if (state.pendingChoice) {
    return addLog(state, `${occupant.card.name}'s Depart doesn't resolve — ${state.pendingChoice.cardName}'s own trigger is still waiting on a choice.`);
  }
  let next = addLog(state, `${occupant.card.name}'s Depart triggers.`);
  const departText = selfReferentialWhenSummonedText(effect, occupant.card.name);
  return resolveOrLogEffect(next, occupant.ownerId, occupant.card.name, departText, 'Depart', { selfCellId: cellId });
};

// Armaments play on any of a player's own Mortal Realm cells (RULES.md >
// Card types), not just ones with a Being already on them — so a target cell
// is fine if it's empty, holds the player's own Being, or holds the
// player's own freestanding Armament stack (Armaments piled on Armaments).
const armamentTargetOk = (occupant, playerId) =>
  !occupant || (occupant.ownerId === playerId && (occupant.type === 'being' || occupant.type === 'armament-stack'));

// A cell a Being may occupy (by summoning or moving there): empty, or the
// player's own freestanding Armament stack waiting there — it's picked up
// on arrival. A Being can never land on another Being (or an opponent's
// Armament stack), so this is stricter than armamentTargetOk above.
const emptyOrOwnArmamentStack = (occupant, playerId) =>
  !occupant || (occupant.type === 'armament-stack' && occupant.ownerId === playerId);

// Dryad (RULES.md > Keywords): "This Being may move onto another Being
// with the TreeFolk, Vine, or Seed typing" — a MOVE-only destination, not
// a summon one (unlike emptyOrOwnArmamentStack above, never checked by
// SUMMON_BEING). Real card text doesn't say "you control", but attaching
// onto an opponent's Being would collide with this engine's normal
// "moving onto an opponent's tile is an attack" rule (RULES.md > Combat) —
// documented simplification, scoped to the mover's own Beings only, same
// as every other own-tile-only stacking rule (Armaments included). Only
// one Being may be attached at a time on the MOVER's side (the card's own
// "that Being" is singular) — the mover can't already be carrying one.
// The destination side, though, may already be carrying a mount of its
// own: a treefolk/vine/seed pile can stack arbitrarily deep (e.g. a
// Being onto a Being already riding a Samara Seed), each level nested in
// the next occupant's own dryadAttached — see dropDryadAttached and the
// two dryadAttached construction sites below, which all propagate a
// prior nested attachment forward instead of dropping it.
const DRYAD_ATTACH_TYPINGS = ['treefolk', 'vine', 'seed'];
const dryadAttachTargetOk = (occupant, playerId, moverCard) =>
  !!moverCard.keywords?.dryad && !!occupant && occupant.type === 'being' && occupant.ownerId === playerId
  && DRYAD_ATTACH_TYPINGS.some(t => (occupant.card.typing || '').toLowerCase().includes(t));

// Lesser Summoning Circle: "you may Summon a Demon, Imp or Null Being
// directly on this tile, when you do sacrifice Lesser Summoning Circles."
// — a ground Relic occupant (state.groundRelics, not state.board — see the
// LESSER_SUMMONING_CIRCLE_RE branch) carrying `summonHereTypings` (set
// once its own Engage resolves) is a legal summon destination for a
// matching-typed Being from hand, on top of the normal empty/own-armament-
// stack rule emptyOrOwnArmamentStack enforces for state.board itself
// (the two coexist on the same tile — RULES.md > Being-Relic co-location).
// SUMMON_BEING's own reducer case explicitly removes the ground Relic as
// the sacrifice once placement succeeds, since overwriting a board entry
// can no longer double as removing it the way it could when this card was
// mistakenly treated as a normal board Relic.
const summonHereTargetOk = (occupant, playerId, card) =>
  !!occupant && occupant.type === 'relic' && occupant.ownerId === playerId
  && (occupant.summonHereTypings || []).some(t => (card.typing || '').toLowerCase().includes(t));

// A Being's Engage ability can come from its own printed "Engage: X" text,
// or be granted by an attached Armament ("Being gains: Engage: X" — e.g.
// Darmah-Triya Bracers, Brick, Shovel, Soulless Scissors). Its own keyword
// takes priority; if it has none, the first attached Armament that grants
// one is used. Simplification: a Being carrying more than one Armament that
// each grant a *different* Engage ability isn't disambiguated — none of the
// real cards checked so far equip more than one Engage-granting Armament at
// once, so this hasn't come up.
export const effectiveEngage = (occupant) =>
  occupant.card.keywords?.engage
  // Natures Bounty: "TreeFolk, Vine, and Seeds you control gain: 'Engage:
  // add (1) Living'." — a one-time grant applied directly onto each
  // matching Being at the moment it resolves (see the
  // GRANT_ENGAGE_TYPING_GROUP_RE branch below), stored directly on the
  // occupant rather than via an attached Armament.
  || occupant.grantedEngage
  || (occupant.armaments || []).find(a => a.card.keywords?.grantedEngage)?.card.keywords?.grantedEngage || null;

// Whether a Zealot's conditional Engage ("If you control ... you may
// Engage: X" — see cardData.js > classifyEngageCondition) can actually be
// activated right now. An unrecognized condition (engageCondition === null)
// is always met — the honest simplification documented alongside the
// parser itself.
const engageConditionMet = (condition, board, playerId, altars = [], groundRelics = {}) => {
  if (!condition) return true;
  if (condition === 'faithless-only') return controlsOnlyFaithlessPermanents(board, playerId, altars, groundRelics);
  // A "Beings may move across this" Relic (Shifting Sands and friends)
  // lives in groundRelics, not board (RULES.md > Being-Relic
  // co-location) — still a real controlled Relic for this check.
  if (condition === 'controls-relic') {
    return Object.values(board).some(o => o?.type === 'relic' && o.ownerId === playerId)
      || Object.values(groundRelics).some(o => o?.ownerId === playerId);
  }
  return true;
};

// "Sacrifice a/an <Name-or-Typing>" — the one recognized shape of
// "Engage, X: Y"'s extra cost (see cardData.js > engageExtraCost). The
// real CSV misspells "Sacrifice" on the one card that uses this
// ("Sacrfiice") so the middle of the word is matched loosely.
const SACRIFICE_NAMED_RE = /^Sacr\w*ice an?\s+(.+)$/i;

// Whether a Being/Relic's "Engage, X: Y" extra cost can be paid right now,
// and which cell would be sacrificed to pay it. Only the "Sacrifice a/an
// <Name-or-Typing>" shape is recognized here — Smithing Tools' "Remove (X)
// Forge Counters" would still need Relic-level counters (a primitive that
// doesn't exist yet — only Armaments carry counters today), so that one
// stays unrecognized and simply isn't offered, the same graceful non-offer
// precedent as every other unpayable cost in this file. Vadē Rah's own
// "Sacrifice the Being on this tile" USED to have the same problem (this
// engine's board used to be one-occupant-per-cell) but is a real, separate
// shape now that groundRelics co-location exists — see
// SACRIFICE_CO_LOCATED_BEING_RE/groundRelicEngageCostPayable, below, not
// this generic board-wide name/typing search. When more than one candidate
// matches, the first one
// found is used — none of the real cards using this pattern make that
// choice meaningful (a player rarely holds more than one of a specific
// token at once), so this doesn't open a player-facing choice.
const engageExtraCostSacrificeCell = (extraCost, board, playerId) => {
  if (!extraCost) return { payable: true, sacrificeCellId: null };
  const match = extraCost.match(SACRIFICE_NAMED_RE);
  if (!match) return { payable: false, sacrificeCellId: null };
  const needle = match[1].trim().toLowerCase();
  const candidate = Object.entries(board).find(([, o]) => {
    if (!o || o.ownerId !== playerId) return false;
    const card = o.type === 'armament-stack' ? o.armaments[o.armaments.length - 1]?.card : o.card;
    if (!card) return false;
    return card.name.toLowerCase() === needle || (card.typing || '').toLowerCase().includes(needle);
  });
  return { payable: !!candidate, sacrificeCellId: candidate ? candidate[0] : null };
};

// Whether a ground Relic's own Engage ability can actually afford its cost
// right now — the RELIC_COUNTER_MOVE_RE shape's own counter cost
// (Shifting Sands), and/or engageEffigyCost (Tilled Fields' own "Pay (1)
// Living Essence, Engage: X") if the card carries it; an Engage with
// neither is always payable as far as this check is concerned (its own
// effect might still gracefully no-op if it has nothing to target —
// that's resolveOrLogEffect's job, not this gate's).
// Vadē Rah: "Engage, Sacrifice the Being on this tile: X" — the one
// "Engage, X: Y" extra-cost shape SACRIFICE_NAMED_RE/engageExtraCostSacrificeCell
// above can never recognize (it searches the whole board for a name/typing
// match, not "whatever's co-located with THIS specific Relic"). Unlike that
// generic search, this only ever means the single Being sharing this
// ground Relic's own tile (RULES.md > Being-Relic co-location) — real now
// that groundRelics co-location exists, not the "board is one-occupant-
// per-cell" blocker this used to be.
const SACRIFICE_CO_LOCATED_BEING_RE = /^Sacrifice the Being on this tile$/i;

const groundRelicEngageCostPayable = (occupant, player, playerId, cellId, board) => {
  const match = occupant.card.keywords?.engage?.match(RELIC_COUNTER_MOVE_RE);
  const counterOk = !match || (occupant.counters?.[match[2].toLowerCase()] || 0) >= parseInt(match[1], 10);
  const effigyCost = occupant.card.keywords?.engageEffigyCost;
  const effigyOk = !effigyCost || payablePool(player.effigyPool).filter(e => e.effigyType === effigyCost.color).length >= effigyCost.amount;
  const extraCost = occupant.card.keywords?.engageExtraCost;
  const coLocatedOk = !extraCost || !SACRIFICE_CO_LOCATED_BEING_RE.test(extraCost)
    || (board[cellId]?.type === 'being' && board[cellId].ownerId === playerId);
  // Lesser Summoning Circle: "Pay (5) Lifespan, Engage: ..." — same
  // "can't drop to 0" floor ACTIVATE_ENGAGE's own lifespanCost check uses;
  // this was missing entirely, so a ground Relic's own Lifespan-costed
  // Engage was silently free.
  const lifespanCost = occupant.card.keywords?.engageLifespanCost || 0;
  const lifespanOk = player.lifespan - lifespanCost > 0;
  return counterOk && effigyOk && coLocatedOk && lifespanOk;
};

// Removes whatever occupies `cellId` to pay a sacrifice cost — a Being
// goes through the real death pipeline (Depart, death-damage... except
// this specific cost pattern never deals death-damage in the two real
// cards that use it, so this reuses `destroyBeing`, not
// `dealDamageToBeing`); anything else (a Relic — e.g. a Bag o' Bones
// token) has no death pipeline of its own, so it's just removed.
const sacrificeOccupantAt = (state, cellId) => {
  const occupant = state.board[cellId];
  if (!occupant) return state;
  if (occupant.type === 'being') return destroyBeing(state, cellId);
  const board = { ...state.board };
  delete board[cellId];
  return { ...state, board };
};

// Board cells holding a Relic named `name` (case-insensitive) `playerId`
// owns — the candidate pool for Cemetery Physician's "sacrifice (X) <Name>"
// variable-count cost, where the player picks which/how many of their own
// copies to spend by clicking tiles directly (see the 'sacrifice-x-toggle'
// pendingChoice), not a fixed sacrifice-cost text pattern like
// engageExtraCostSacrificeCell above.
const ownedFodderCells = (board, playerId, name) => {
  const needle = name.toLowerCase();
  return Object.entries(board)
    .filter(([, o]) => o?.type === 'relic' && o.ownerId === playerId && o.card.name.toLowerCase() === needle)
    .map(([cell]) => cell);
};

// Beings/Deities in `purgatory` whose total printed casting cost equals
// `cost` — backs Cemetery Physician's "Summon a Being from your Purgatory
// with cost (X)" half, where X is however many fodder the player just
// sacrificed (see RESOLVE_SACRIFICE_X_CONFIRM).
const purgatoryBeingsWithCost = (purgatory, cost) =>
  purgatory.filter(c => (c.kind === 'being' || c.kind === 'deity') && totalCastingCost(c) === cost);

// Same, further restricted to a printed typing (Death's Decanter: "a
// Formless Being with Conjuring cost (X)") — X here is the player's own
// choice of how many Counters they remove, not a fixed number, see
// removeCountersSacrificeSearchTypedCost (cardData.js) and
// ACTIVATE_REMOVE_COUNTERS_SACRIFICE_SEARCH below.
const purgatoryTypedBeingsWithCost = (purgatory, typing, cost) =>
  purgatoryBeingsWithCost(purgatory, cost).filter(c => (c.typing || '').toLowerCase().includes(typing.toLowerCase()));

// Removes one specific Armament entry (by its own card.instanceId) from
// wherever it's attached — a Being just loses that one entry (same as
// ACTIVATE_ARMAMENT_SACRIFICE), while a freestanding pile is removed from
// the board entirely once its last Armament is gone (same precedent as
// gatherArmamentsToTile below). Used by "sacrifice an Armament" costs that
// aren't tied to one specific named Armament (Tiny Forge Master) — unlike
// engageExtraCostSacrificeCell/sacrificeOccupantAt above, which sacrifice
// a whole occupant, this only ever removes the one Armament entry.
// `toPurgatory` (default false, so moveArmamentEntry/moveAutoAttachArmaments'
// own relocation calls are completely unaffected) marks a genuine "leaving
// play" removal — a sacrifice cost being paid, not a reposition — and does
// two things a plain relocation must NOT: sends the real card to its
// owner's Purgatory (so a later "search Purgatory for an Armament" effect,
// e.g. Crucible, can actually find it — it used to just vanish from the
// game entirely) and claws back any Lifespan stat bonus it was granting
// (removeArmamentsLifespanBonus — it used to stay permanently banked on
// the Being even after the Armament itself was long gone).
const removeArmamentEntry = (state, cellId, armamentInstanceId, { toPurgatory = false } = {}) => {
  const occupant = state.board[cellId];
  const removed = (occupant.armaments || []).find(a => a.card.instanceId === armamentInstanceId);
  const armaments = (occupant.armaments || []).filter(a => a.card.instanceId !== armamentInstanceId);
  const board = { ...state.board };
  if (armaments.length === 0 && occupant.type === 'armament-stack') {
    delete board[cellId];
  } else {
    board[cellId] = { ...occupant, armaments };
  }
  let next = { ...state, board };
  if (!toPurgatory || !removed) return next;
  next = removeArmamentsLifespanBonus(next, cellId, [removed]);
  // Same "never let Kalmahka's board-only synthetic stand-in leak into a
  // permanent zone" fix destroyArmamentEntryAt's own comment documents.
  const realCard = removed.kalmahkaOriginalCard || removed.card;
  const owner = next.players[occupant.ownerId];
  next = { ...next, players: { ...next.players, [occupant.ownerId]: { ...owner, purgatory: purgatoryAfterAdding(owner.purgatory, realCard) } } };
  return next;
};

// Destroys a whole board occupant (Prophecy or standalone Relic) for a
// "Destroy a/an X" Conjuring (DESTROY_OCCUPANT_RE, above) — sent to
// Purgatory, unlike sacrificeOccupantAt's own removal (see that function's
// own comment for why the two deliberately don't share behavior).
const destroyPermanentAt = (state, cellId) => {
  const occupant = state.board[cellId];
  if (!occupant) return state;
  const board = { ...state.board };
  delete board[cellId];
  let next = { ...state, board };
  if (occupant.card) {
    const owner = next.players[occupant.ownerId];
    next = { ...next, players: { ...next.players, [occupant.ownerId]: { ...owner, purgatory: purgatoryAfterAdding(owner.purgatory, occupant.card) } } };
  }
  return addLog(next, `${occupant.card?.name || 'It'} is destroyed.`);
};

// Every Armament entry anywhere on the board, either player's, as
// { cellId, armamentInstanceId, card } — the candidate pool for "Destroy
// an Armament" (DESTROY_ARMAMENT_RE, above), which targets one specific
// entry rather than a whole occupant.
const gatherArmamentEntries = (board) => {
  const entries = [];
  Object.entries(board).forEach(([cell, o]) => {
    (o?.armaments || []).forEach(a => entries.push({ cellId: cell, armamentInstanceId: a.card.instanceId, card: a.card }));
  });
  return entries;
};

// Every legal "Relic" target for Desecration's "Destroy a Relic." — wider
// than a bare freestanding `type: 'relic'` occupant: RULES.md > Card types
// also recognizes "Relic, Being" (a Relic-Being, e.g. Training dummy,
// Crumbling Sphinx — placed as a real `type: 'being'` occupant, flagged by
// card.isRelicBeing) and "Relic, Armament" (every real Armament in this
// game is typed this way, so gatherArmamentEntries' full pool applies
// unfiltered) as genuine Relics too. Either player's board, no ownership
// restriction (the printed text names no "you control"). Each candidate is
// tagged with what kind of removal it needs at resolve time — a whole
// occupant (destroyBeing for a Relic-Being, destroyPermanentAt for a plain
// Relic) or one specific armament entry within a stack/attachment
// (destroyArmamentEntryAt).
const gatherRelicTargets = (board) => {
  const targets = [];
  Object.entries(board).forEach(([cell, o]) => {
    if (o?.type === 'relic' || (o?.type === 'being' && o.card.isRelicBeing)) {
      targets.push({ cellId: cell, armamentInstanceId: null, card: o.card });
    }
  });
  gatherArmamentEntries(board).forEach(e => targets.push({ cellId: e.cellId, armamentInstanceId: e.armamentInstanceId, card: e.card }));
  return targets;
};

const destroyRelicTarget = (state, target) => {
  if (target.armamentInstanceId) {
    return destroyArmamentEntryAt(state, target.cellId, target.armamentInstanceId);
  }
  const occupant = state.board[target.cellId];
  if (!occupant) return state;
  if (occupant.type === 'being') {
    return destroyBeing(addLog(state, `${occupant.card.name} is destroyed.`), target.cellId);
  }
  return destroyPermanentAt(state, target.cellId);
};

// Destroys one specific Armament entry (DESTROY_ARMAMENT_RE) — removes it
// via removeArmamentEntry with `toPurgatory: true` (same primitive Tiny
// Forge Master's own sacrifice now shares — both send the real card to
// Purgatory and claw back any Lifespan bonus it was granting; a genuine
// "destroy" effect is exactly as much "leaving play" as a sacrifice cost
// being paid, they're no longer two different precedents here).
const destroyArmamentEntryAt = (state, cellId, armamentInstanceId) => {
  const occupant = state.board[cellId];
  const entry = occupant?.armaments?.find(a => a.card.instanceId === armamentInstanceId);
  if (!entry) return state;
  // entry.kalmahkaOriginalCard || entry.card — same "never let Kalmahka's
  // board-only synthetic stand-in leak into a permanent zone" fix
  // removeArmamentEntry's own `toPurgatory` branch already applies; read
  // here too only for this function's own log line.
  const realCard = entry.kalmahkaOriginalCard || entry.card;
  const next = removeArmamentEntry(state, cellId, armamentInstanceId, { toPurgatory: true });
  return addLog(next, `${realCard.name} is destroyed.`);
};

// When a Being dies, its Armaments stay behind on the tile instead of
// vanishing with it — they keep waiting there for another Being to pick up.
// (A Being that just *moves* away takes its Armaments with it — see the
// MOVE_OR_ATTACK reposition branch, which carries the whole occupant object
// including `armaments` over to the new cell instead of using this.)
const dropArmaments = (board, cellId, occupant) => {
  if (occupant.armaments?.length > 0) {
    // An Animated Armament (RULES.md > Keywords) only ever acts once it's
    // the topmost entry of a Being-less pile — normal attachment already
    // keeps it there (insertArmamentEntry), but the array can still end up
    // with one buried mid-stack if it arrived some other way (e.g.
    // MOVE_OR_ATTACK's own reposition branch, which just concatenates a
    // picked-up waiting pile's armaments after the mover's own, with no
    // reordering). This is the one choke point where a pile first actually
    // NEEDS a "topmost" (the Being that was overriding it just died), so
    // it's the right place to restore the invariant once and for all,
    // regardless of how it got buried.
    const animatedIndex = occupant.armaments.findIndex(a => a.card.keywords?.animated);
    const armaments = animatedIndex === -1 || animatedIndex === occupant.armaments.length - 1
      ? occupant.armaments
      : [...occupant.armaments.slice(0, animatedIndex), ...occupant.armaments.slice(animatedIndex + 1), occupant.armaments[animatedIndex]];
    board[cellId] = { type: 'armament-stack', ownerId: occupant.ownerId, armaments };
  } else {
    delete board[cellId];
  }
};

// Dryad's own mirror of dropArmaments above: the attached Being was never
// actually harmed by whatever just happened to its rider, so it's returned
// to the tile as an ordinary Being occupant again, at whatever
// currentLifespan/engaged it already had. If the departing Dryad ALSO had
// its own separate Armaments equipped (on top of riding something), those
// transfer onto the returned mount as its new equipment rather than being
// lost — the tile can only ever hold one occupant, so they can't stay
// their own freestanding pile the way dropArmaments would leave them.
const dropDryadAttached = (board, cellId, occupant) => {
  const mount = occupant.dryadAttached;
  const combinedArmaments = [...(mount.armaments || []), ...(occupant.armaments || [])];
  board[cellId] = {
    type: 'being', ownerId: occupant.ownerId, card: mount.card, currentLifespan: mount.currentLifespan, engaged: mount.engaged,
    ...(combinedArmaments.length > 0 ? { armaments: combinedArmaments } : {}),
    // The mount may itself have been riding something (a 3rd-deep chain)
    // — propagate that nested attachment forward instead of losing it.
    ...(mount.dryadAttached ? { dryadAttached: mount.dryadAttached } : {}),
  };
};

// Shared by every site that already calls dropArmaments when a Being
// leaves the board (dies, is sacrificed/destroyed, or returns to hand) —
// a Dryad currently riding something drops its mount back onto the tile
// instead of (never both: the tile can only hold one occupant).
const dropArmamentsOrDryadMount = (board, cellId, occupant) => {
  if (occupant.dryadAttached) dropDryadAttached(board, cellId, occupant);
  else dropArmaments(board, cellId, occupant);
};

// An Animated Armament (RULES.md > Keywords) acts as a Being in its own
// right, but only while it's the topmost entry of a Being-less pile — the
// instant a real Being picks the pile up (the occupant becomes `type:
// 'being'`) or a non-Animated Armament ends up on top, this naturally
// stops matching, with no extra bookkeeping needed anywhere else. Never
// true for an Armament attached *under* a Being — that's just ordinary
// equipment, regardless of its own Animated keyword.
export const animatedTopEntry = (occupant) => {
  if (occupant?.type !== 'armament-stack' || !occupant.armaments?.length) return null;
  const top = occupant.armaments[occupant.armaments.length - 1];
  return top.card.keywords?.animated ? top : null;
};

// The real, permanent-zone-safe card behind whatever actorView(occupant)
// returned as `view` — itself, for a real Being, or, only when Kalmahka's
// live board-wide aura (recomputeKalmahkaOverrides, below) replaced an
// Animated Armament's own card with its synthetic KALMAHKA_OVERRIDE_CARD
// stand-in (no castingCost, no real identity — fine for combat-stat
// display while still on the board, where every read already goes through
// this same override), the ORIGINAL card stashed on that entry
// (kalmahkaOriginalCard) before the override was applied. `view.card`
// itself is exactly right for combat-stat reading, but must never be what
// gets captured into a permanent zone (Purgatory, hand) once the occupant
// actually leaves the board for good — self-play found the synthetic
// "Warped Armament" stand-in leaking into Purgatory this way, later
// crashing (reading .colored off its missing castingCost) the moment it
// was searched back to hand.
const realCardFor = (occupant, view) => animatedTopEntry(occupant)?.kalmahkaOriginalCard || view.card;

// Where a newly-attached Armament entry slots into an existing pile. A
// non-Animated Armament always goes in *below* whatever's currently
// topmost if that's Animated — attaching one on top of it would otherwise
// silently bump the Animated entry out of "topmost" and stop it acting
// (RULES.md > Keywords > Animated), which isn't how equipping something
// onto an active permanent is supposed to work. An Animated Armament being
// attached still goes on top as normal — that's the common case, and how
// it becomes the acting entry in the first place.
const insertArmamentEntry = (existing, newEntry, isAnimated) => {
  if (isAnimated || existing.length === 0) return [...existing, newEntry];
  const top = existing[existing.length - 1];
  if (!top.card.keywords?.animated) return [...existing, newEntry];
  return [...existing.slice(0, -1), newEntry, top];
};

// A non-Animated Armament sliding in *below* an existing Animated top (see
// insertArmamentEntry above) still grants that top its own "Being gains
// +N/+N" the same way it would if it were attached directly to a real
// Being — RULES.md > Keywords > Animated: a buried Armament still
// contributes to whatever's currently acting, on top or not. Mirrors
// applyNewArmamentsLifespanBonus's own role, just writing into the top
// entry's own `currentLifespan` (armament-stack shape) instead of a `type:
// 'being'` occupant's top-level one. Simplification: unlike that version,
// a lethal negative bonus here doesn't route through the death pipeline —
// no real card combination produces one yet, so this stays the simple case.
const applyLifespanBonusToArmamentEntry = (armaments, bonus) => {
  if (!bonus || armaments.length === 0) return armaments;
  const top = armaments[armaments.length - 1];
  if (top.currentLifespan == null) return armaments; // top isn't Animated — nothing to add it to
  return [...armaments.slice(0, -1), { ...top, currentLifespan: top.currentLifespan + bonus }];
};

// Writes an updated `engaged`/`currentLifespan` back onto whichever real
// shape is currently acting as a Being — a `being` occupant directly, or
// just the topmost entry of an animated `armament-stack` (everything else
// already in the pile is left exactly as it was).
const writeActorState = (occupant, updates) => {
  if (occupant.type === 'being') return { ...occupant, ...updates };
  const armaments = [...occupant.armaments];
  armaments[armaments.length - 1] = { ...armaments[armaments.length - 1], ...updates };
  return { ...occupant, armaments };
};

// Read-only view of whichever real occupant shape is acting as a Being —
// itself, if it already is one, or a synthetic `{ card, currentLifespan,
// armaments }` built from an Animated Armament's topmost entry otherwise,
// with everything below that entry treated as its own attached Armaments
// (their stat bonuses still apply, same as a real Being's). combat.js's
// helpers (effectiveStrength/resolveMutualCombat/deathDamageFor) can read
// this shape unchanged — but never write through it; writes always go
// back through the real occupant via writeActorState/dropAnimatedTop.
// Exported so Board.jsx can reuse the exact same shape to display an
// Animated top's current Strength/Lifespan the same way a real Being's are
// shown.
export const actorView = (occupant) => {
  if (!occupant) return null;
  if (occupant.type === 'being') return occupant;
  const top = animatedTopEntry(occupant);
  if (!top) return null;
  return { card: top.card, currentLifespan: top.currentLifespan, armaments: occupant.armaments.slice(0, -1) };
};

// Removes just the topmost (Animated, acting) entry from an armament-stack
// occupant once it dies — same "empties and removes" precedent as
// dropArmaments above, but for one entry within the pile rather than the
// occupant's whole armaments list. Whatever's left underneath stays behind
// as ordinary equipment (which can itself start acting next, if it's also
// Animated and now topmost).
const dropAnimatedTop = (board, cellId, occupant) => {
  const armaments = occupant.armaments.slice(0, -1);
  if (armaments.length > 0) {
    board[cellId] = { ...occupant, armaments };
  } else {
    delete board[cellId];
  }
};

// Deals damage to a Being outside of combat (currently only reachable via
// Rhak-tùrin Altar's conjure cost — see DAMAGE_TARGET_RE). Mirrors
// MOVE_OR_ATTACK's own death handling so a Being killed this way behaves
// identically to one killed in combat: below 0 Lifespan it dies, its owner
// takes its base Lifespan as damage, Depart fires, and any attached
// Armaments stay behind as a freestanding pile. Unlike combat, a Favor
// Counter is not checked here — Favored's only wired trigger point today is
// mutual combat resolution (RULES.md > Keywords), and extending it to cover
// non-combat damage sources isn't part of this pattern's scope yet.
//
// Also accepts an Animated Armament acting as a Being (the topmost entry of
// a Being-less pile — RULES.md > Keywords > Animated), the same way
// MOVE_OR_ATTACK's own combat resolution already does: `actorView` reads
// either shape uniformly, `writeActorState` writes the Lifespan update back
// to the right place (the occupant itself for a real Being, just its top
// entry for a pile), and on death `dropAnimatedTop` (vs `dropArmaments`)
// strips just that entry, leaving the rest of the pile behind. This is what
// lets "Deal (N) damage to any target" (Sharpshoot and friends —
// DAMAGE_ANY_TARGET_RE) legally target a freestanding Animated Armament,
// matching how it's already a legal attack target in combat.
export const dealDamageToBeing = (state, cellId, damage) => {
  const occupant = state.board[cellId];
  const view = actorView(occupant);
  if (!occupant || !view) return state;
  // HeartWood Locket's own Martyr (damageRedirectMatch, above): the Being
  // never takes the hit at all — no death/Depart cascade, no Purgatory —
  // its controller's own Lifespan drops instead, same raw subtraction
  // endTurn's own Down Tick Step already uses. checkWin still runs, same
  // as every other Lifespan-loss path in this file.
  if (occupant.damageRedirectToController) {
    const owner = state.players[occupant.ownerId];
    const next = {
      ...state,
      players: { ...state.players, [occupant.ownerId]: { ...owner, lifespan: owner.lifespan - damage } },
    };
    return checkWin(addLog(next, `${view.card.name}'s damage redirect sends ${damage} Lifespan damage to ${occupant.ownerId} instead.`));
  }
  // Favored (RULES.md > Keywords): "The next time this Being would take
  // damage, remove the Favor Counter instead and prevent that damage." —
  // printed with no combat-only qualifier, but the only place this was
  // ever actually checked was resolveAttackFrom's own inline mutual-combat
  // math (attackerFavored/defenderFavored, below). Generalized here so it
  // also protects against a generic "deal (N) damage to target Being"
  // effect (Medium Mage, etc.) — found while building the pre-resolution
  // priority window, since the user's own worked example (cast One Above
  // All to make the target Favored, preventing Medium Mage's pending
  // damage) needs this to actually hold true, not just the window itself.
  // An Animated Armament acting as a Being can never carry a Favor
  // Counter in the first place (see resolveAttackFrom's own comment), so
  // no extra type check is needed here — `favorCounter` is simply never
  // set on one.
  if (occupant.favorCounter) {
    return addLog(
      { ...state, board: { ...state.board, [cellId]: { ...occupant, favorCounter: false } } },
      `${view.card.name}'s Favor Counter prevents ${damage} damage.`
    );
  }
  const isBeing = occupant.type === 'being';
  const lifespanAfter = view.currentLifespan - damage;
  if (lifespanAfter > 0) {
    return { ...state, board: { ...state.board, [cellId]: writeActorState(occupant, { currentLifespan: lifespanAfter }) } };
  }
  const dmg = deathDamageFor(view);
  const realCard = realCardFor(occupant, view);
  const owner = state.players[occupant.ownerId];
  let next = {
    ...state,
    players: {
      ...state.players,
      [occupant.ownerId]: { ...owner, lifespan: owner.lifespan - dmg, purgatory: purgatoryAfterAdding(owner.purgatory, realCard) },
    },
  };
  next = addLog(next, `${realCard.name} dies; ${occupant.ownerId} takes ${dmg} Lifespan damage.`);
  // Plague Doctor's own counter is Being-specific — an Animated Armament
  // dying (isBeing false) doesn't count, it was never really a Being.
  if (isBeing) next = incrementBeingsDiedThisTurn(next, occupant.ownerId);
  if (isBeing) next = triggerOwnBeingDiedReactions(next, occupant.ownerId);
  if (isBeing) next = triggerAnyBeingDiedCounterGain(next);
  if (isBeing) next = triggerAnyBeingDiedGiveDifferentBuff(next, occupant.ownerId);
  if (isBeing) next = triggerDeckSearchOnTypedDeath(next, occupant.ownerId, view.card.typing);
  // The cell must already read empty in `next.board` before Depart fires,
  // or a "Summon a token on this tile" effect (e.g. Cobra) would see its
  // own about-to-vacate tile as still occupied and refuse to place there.
  const board = { ...next.board };
  const priorArmaments = occupant.armaments;
  if (isBeing) dropArmamentsOrDryadMount(board, cellId, occupant); else dropAnimatedTop(board, cellId, occupant);
  next = logDepartIfPresent({ ...next, board }, { card: view.card, ownerId: occupant.ownerId, grantedDepart: occupant.grantedDepart }, cellId);
  if (isBeing) next = triggerOnAttachedBeingDied(next, occupant.ownerId, cellId, priorArmaments);
  if (isBeing) next = triggerWretchedRemnantsOffer(next, occupant.ownerId, view.card);
  if (isBeing) next = triggerEchoesOfBoundlessOffer(next, occupant.ownerId, view.card);
  return checkWin(next);
};

// Grants `amount` -1/-1 Counters to `targetCellId` (Scarab —
// MINUS_COUNTER_TARGET_RE) — records the counter itself (read live by
// combat.js's effectiveStrength for the Strength half) and, in the same
// step, applies the Lifespan half as real damage through the normal death
// pipeline (dealDamageToBeing), mirroring how an Armament's own negative
// Lifespan statBonus is already applied (applyNewArmamentsLifespanBonus
// above). The counter is written first so dealDamageToBeing's own board
// read sees it too, even if this hit is lethal.
const applyMinusCounters = (state, cardName, label, targetCellId, amount) => {
  const occupant = state.board[targetCellId];
  const have = occupant.counters?.['-1/-1'] || 0;
  const withCounter = {
    ...state,
    board: { ...state.board, [targetCellId]: { ...occupant, counters: { ...occupant.counters, '-1/-1': have + amount } } },
  };
  const next = addLog(withCounter, `${cardName}'s ${label} gives ${occupant.card.name} ${amount} -1/-1 Counter(s).`);
  return dealDamageToBeing(next, targetCellId, amount);
};

// Crumbling Sphinx: "Deal (N1) Lifespan Damage to a Being you control and
// (N2) to a different Being." — the second target's candidate pool
// excludes whichever cell the first damage landed on. Shared by both the
// initial resolver (first pick auto-resolves) and
// RESOLVE_LIFESPAN_DAMAGE_FIRST_TARGET (it doesn't), so both paths reach
// the same second-target logic.
const dealSecondLifespanDamage = (state, playerId, cardName, label, amount, excludeCell) => {
  const candidates = Object.entries(state.board).filter(([cell, o]) => cell !== excludeCell && o?.type === 'being').map(([cell]) => cell);
  if (candidates.length === 0) {
    return addLog(state, `${cardName}'s ${label} has no different Being to target.`);
  }
  if (candidates.length === 1) {
    let next = addLog(state, `${cardName}'s ${label} deals ${amount} Lifespan Damage to ${state.board[candidates[0]].card.name}.`);
    return dealDamageToBeing(next, candidates[0], amount);
  }
  let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a different Being to target.`);
  return { ...next, pendingChoice: { kind: 'lifespan-damage-second-target', playerId, cardName, label, amount, excludeCell } };
};

// Copies `targetCellId`'s own printed Engage ability text and resolves it
// as `cardName`'s own effect (Marionette Doll — COPY_ENGAGE_RE) — shared by
// the initial resolver (auto/offer-choice) and RESOLVE_COPY_ENGAGE_TARGET,
// which both reach this once a target is settled. A target with no Engage
// ability at all (`keywords.engage == null`) is a graceful no-op, same
// "honest log, no crash" precedent as every other unmatched effect text.
const copyEngageAbility = (state, playerId, cardName, label, targetCellId, context) => {
  const targetCard = state.board[targetCellId]?.card;
  const engageText = targetCard?.keywords?.engage;
  if (!targetCard || !engageText) {
    return addLog(state, `${cardName}'s ${label} has no Engage ability of ${targetCard?.name || 'its target'}'s to copy.`);
  }
  // A target whose own Engage ability IS "copy an Engage ability" (another
  // Marionette Doll, say) is a graceful no-op rather than actually copying
  // it — standard "a copy effect can't target another copy effect"
  // precedent, and the one this file actually needs: self-play found this
  // recursing for real. With exactly one opposing Being (itself a copy-
  // Engage card), copying it re-enters this exact same resolveOrLogEffect
  // -> copyEngageAbility pair on the same single candidate every time —
  // guaranteed stack overflow, not just a lot of iterations. With more than
  // one candidate, it instead opens a fresh 'copy-engage-target' choice
  // every time it's picked, chaining forever with no real effect ever
  // landing — the matching AI-loop half of the same bug.
  if (COPY_ENGAGE_RE.test(engageText)) {
    return addLog(state, `${cardName}'s ${label} can't copy ${targetCard.name}'s Engage ability — it's a copy effect too.`);
  }
  let next = addLog(state, `${cardName}'s ${label} copies ${targetCard.name}'s Engage ability: "${engageText}"`);
  return resolveOrLogEffect(next, playerId, cardName, engageText, label, context);
};

// "Trigger the Depart of a Being you control." (Skeleton Key) — same
// "copy this other card's own keyword text" shape as copyEngageAbility
// above, just Depart instead of Engage: the target's own printed Depart
// text resolves as if it had just died, without it actually dying (no
// Purgatory, no owner Lifespan loss — this is purely triggering the text,
// not killing anything).
const triggerDepartOfTarget = (state, playerId, cardName, label, targetCellId) => {
  const target = state.board[targetCellId];
  const departText = target?.card?.keywords?.depart;
  if (!target || !departText) {
    return addLog(state, `${cardName}'s ${label} has no Depart of ${target?.card?.name || 'its target'}'s to trigger.`);
  }
  let next = addLog(state, `${cardName}'s ${label} triggers ${target.card.name}'s Depart: "${departText}"`);
  return resolveOrLogEffect(next, playerId, cardName, departText, label, { selfCellId: targetCellId });
};

// Plague doctor: "...for each Being that died under your control this
// turn." — a turn-scoped running count, reset for BOTH players at the
// start of every beginTurn (turn.js), so it always reflects only deaths
// since the currently active turn began. Keyed by the dying Being's own
// OWNER — whoever caused the death (an opponent's attack, the owner's own
// sacrifice) doesn't matter, only whose control it died under. Called
// from every real "a Being died" site: dealDamageToBeing's own death
// branch, destroyBeing (below — covers the vast majority of
// sacrifice/destroy effects), MOVE_OR_ATTACK's own combat death branches,
// and ACTIVATE_MARTYR (guarded there to only count an actual Being, not a
// bare Relic Martyr).
const incrementBeingsDiedThisTurn = (state, ownerId) => {
  const owner = state.players[ownerId];
  return { ...state, players: { ...state.players, [ownerId]: { ...owner, beingsDiedThisTurn: (owner.beingsDiedThisTurn || 0) + 1 } } };
};

// Cutlass: "When the attached Being dies sacrifice this and summon a
// Cursed Cutlass token on this tile." — called AFTER dropArmamentsOrDryadMount
// has already run (so `cellId` reads as vacated/holding whatever pile is
// left), with `priorArmaments` being the dying Being's own armaments list
// captured BEFORE that drop (the pile shape has already changed by the
// time this runs, so that snapshot is the only place left to find this
// keyword). Each qualifying Armament removes itself from whatever pile is
// now there, then resolves its own effect text with `selfCellId: cellId`
// — reuses SUMMON_TOKEN_ON_TILE_RE's own "must be empty" resolution, a
// documented simplification: if another Armament is still stacked there,
// the token summon gracefully no-ops instead of forcing its way in.
const triggerOnAttachedBeingDied = (state, playerId, cellId, priorArmaments) => {
  const dying = (priorArmaments || []).filter(a => a.card.keywords?.onAttachedBeingDied);
  return dying.reduce((s, entry) => {
    const pile = s.board[cellId];
    const board = { ...s.board };
    if (pile?.type === 'armament-stack') {
      const remaining = pile.armaments.filter(a => a.card.instanceId !== entry.card.instanceId);
      if (remaining.length > 0) board[cellId] = { ...pile, armaments: remaining };
      else delete board[cellId];
    }
    let next = addLog({ ...s, board }, `${entry.card.name} sacrifices itself.`);
    return resolveOrLogEffect(next, playerId, entry.card.name, entry.card.keywords.onAttachedBeingDied, 'ability', { selfCellId: cellId });
  }, state);
};

// Sends a Being to Purgatory *without* dealing its owner death-damage —
// "destroy"/"sacrifice" effects (Cro-āsik Hunger's "destroy target non
// Deity Being (Lifespan damage is not dealt)"; Venefica's forced
// sacrifice). Mirrors dealDamageToBeing's own death branch (Purgatory,
// Depart, drop Armaments) minus the owner-Lifespan-loss step — a
// sacrifice/destroy is still a real death for every other purpose.
export const destroyBeing = (state, cellId) => {
  const occupant = state.board[cellId];
  if (!occupant || occupant.type !== 'being') return state;
  const owner = state.players[occupant.ownerId];
  let next = {
    ...state,
    players: { ...state.players, [occupant.ownerId]: { ...owner, purgatory: purgatoryAfterAdding(owner.purgatory, occupant.card) } },
  };
  next = incrementBeingsDiedThisTurn(next, occupant.ownerId);
  next = triggerOwnBeingDiedReactions(next, occupant.ownerId);
  next = triggerAnyBeingDiedCounterGain(next);
  next = triggerAnyBeingDiedGiveDifferentBuff(next, occupant.ownerId);
  next = triggerDeckSearchOnTypedDeath(next, occupant.ownerId, occupant.card.typing);
  // Same ordering as dealDamageToBeing above — vacate the cell in
  // `next.board` before Depart fires.
  const board = { ...next.board };
  const priorArmaments = occupant.armaments;
  dropArmamentsOrDryadMount(board, cellId, occupant);
  next = logDepartIfPresent({ ...next, board }, occupant, cellId);
  next = triggerOnAttachedBeingDied(next, occupant.ownerId, cellId, priorArmaments);
  next = triggerWretchedRemnantsOffer(next, occupant.ownerId, occupant.card);
  next = triggerEchoesOfBoundlessOffer(next, occupant.ownerId, occupant.card);
  return checkWin(next);
};

// Desperate Finale: "Sacrifice it at the end of the turn." — a genuinely
// dynamic, per-INSTANCE flag (sacrificeAtEndOfTurn, set on whichever one
// Being this specific cast's cost target happened to be — see
// resolveDesperateFinale above), not a static per-card condition like
// Tilled Fields' own sacrificeIfEngagedAtEndOfTurn. Exported so turn.js's
// own endTurn can sweep for it. "Sacrifice", not a real death, so this
// reuses destroyBeing (no owner Lifespan loss) — same distinction this
// whole file draws everywhere else. Deliberately NOT gated on
// `occupant.ownerId === state.turnPlayer` — now that Ethereal Conjurings
// (Desperate Finale included) can be cast reactively during a
// reactiveWindow, the flagged Being's own owner can be the NON-turn-player,
// and the flag itself is already scoped to the one specific instance that
// earned it, so no extra ownership check is needed (or correct).
export const applyDesperateFinaleSacrifice = (state) => {
  let next = state;
  Object.keys(state.board).forEach(cell => {
    const occupant = next.board[cell];
    if (occupant?.type === 'being' && occupant.sacrificeAtEndOfTurn) {
      next = destroyBeing(next, cell);
    }
  });
  return next;
};

// Equanimity: "Deal (1) damage to each Being... No damage is dealt from
// any Beings that die." — real, partial damage like dealDamageToBeing
// (heals nothing, persists), but on a lethal hit, reuses destroyBeing
// instead of dealDamageToBeing's own death branch specifically to skip the
// owner-Lifespan-loss step (Depart/Purgatory/the death counter all still
// happen exactly as they do for any other real death, since destroyBeing
// already covers those).
// Conscription: "If none move, choose two Beings they Engage in combat."
// — ruled: the CALLER (Conscription's own controller) picks, one
// controlled by each side, and they trade Strength damage the same way
// real mutual combat does. A deliberately simplified version of
// resolveAttackFrom's own much larger attacker/defender resolution (no
// Favor Counter, Unruly, or Formless-Fangs-style combat-damage reactions)
// — a plain Strength trade through the normal death pipeline, since
// nothing in this specific forced-engagement text calls for those.
const forceCombatBetween = (state, cardName, label, cellA, cellB) => {
  const a = state.board[cellA];
  const b = state.board[cellB];
  if (!a || a.type !== 'being' || !b || b.type !== 'being') return state;
  const dmgToA = effectiveStrength(b);
  const dmgToB = effectiveStrength(a);
  let next = addLog(state, `${cardName}'s ${label} engages ${a.card.name} and ${b.card.name} in combat: ${dmgToA} damage to ${a.card.name}, ${dmgToB} damage to ${b.card.name}.`);
  next = dealDamageToBeing(next, cellA, dmgToA);
  next = dealDamageToBeing(next, cellB, dmgToB);
  return next;
};

// Brick: "...then move Brick to the tile occupied by the targeted
// Being." — relocates a named Armament from wherever it's currently
// equipped to `targetCellId`, unconditional per the user's own ruling
// (still moves there even if the target died from the damage half —
// landing as a fresh freestanding pile in that case, same shape
// dropArmaments already leaves behind for any other departing Being).
const moveNamedArmamentToTile = (state, armamentName, targetCellId) => {
  let sourceCellId = null;
  let entry = null;
  Object.entries(state.board).forEach(([cell, o]) => {
    if (sourceCellId || !o?.armaments) return;
    const idx = o.armaments.findIndex(a => a.card.name === armamentName);
    if (idx !== -1) { sourceCellId = cell; entry = o.armaments[idx]; }
  });
  if (!entry || sourceCellId === targetCellId) return state;
  const board = { ...state.board };
  const source = board[sourceCellId];
  const remainingSource = source.armaments.filter(a => a.card.name !== armamentName);
  if (source.type === 'armament-stack') {
    if (remainingSource.length > 0) board[sourceCellId] = { ...source, armaments: remainingSource };
    else delete board[sourceCellId];
  } else {
    const { armaments: _drop, ...rest } = source;
    board[sourceCellId] = remainingSource.length > 0 ? { ...rest, armaments: remainingSource } : rest;
  }
  const target = board[targetCellId];
  if (target?.type === 'being' || target?.type === 'armament-stack') {
    board[targetCellId] = { ...target, armaments: [...(target.armaments || []), entry] };
  } else {
    board[targetCellId] = { type: 'armament-stack', ownerId: source.ownerId, armaments: [entry] };
  }
  return addLog({ ...state, board }, `${armamentName} moves to ${targetCellId}.`);
};

// Equanimity's own "No damage is dealt from any Beings that die" carve-out
// (RULES.md) — mirrors dealDamageToBeing's own full death handling
// (Purgatory, Depart, drop Armaments/Animated top, every reaction) but
// skips the owner-Lifespan-loss step, the same relationship destroyBeing
// has to dealDamageToBeing, just Animated-Armament-aware too (same
// actorView/writeActorState/dropAnimatedTop pattern as dealDamageToBeing
// itself — see its own comment) so a repeat cast that kills a Being with
// an Animated Armament attached can go on to hit that Armament, now
// topmost, on a later iteration.
const dealDamageToBeingNoDeathLoss = (state, cellId, damage) => {
  const occupant = state.board[cellId];
  const view = actorView(occupant);
  if (!occupant || !view) return state;
  const isBeing = occupant.type === 'being';
  const lifespanAfter = view.currentLifespan - damage;
  if (lifespanAfter > 0) {
    return { ...state, board: { ...state.board, [cellId]: writeActorState(occupant, { currentLifespan: lifespanAfter }) } };
  }
  const owner = state.players[occupant.ownerId];
  let next = {
    ...state,
    players: { ...state.players, [occupant.ownerId]: { ...owner, purgatory: purgatoryAfterAdding(owner.purgatory, realCardFor(occupant, view)) } },
  };
  if (isBeing) next = incrementBeingsDiedThisTurn(next, occupant.ownerId);
  if (isBeing) next = triggerOwnBeingDiedReactions(next, occupant.ownerId);
  if (isBeing) next = triggerAnyBeingDiedCounterGain(next);
  if (isBeing) next = triggerAnyBeingDiedGiveDifferentBuff(next, occupant.ownerId);
  if (isBeing) next = triggerDeckSearchOnTypedDeath(next, occupant.ownerId, view.card.typing);
  const board = { ...next.board };
  const priorArmaments = occupant.armaments;
  if (isBeing) dropArmamentsOrDryadMount(board, cellId, occupant); else dropAnimatedTop(board, cellId, occupant);
  next = logDepartIfPresent({ ...next, board }, { card: view.card, ownerId: occupant.ownerId, grantedDepart: occupant.grantedDepart }, cellId);
  if (isBeing) next = triggerOnAttachedBeingDied(next, occupant.ownerId, cellId, priorArmaments);
  if (isBeing) next = triggerWretchedRemnantsOffer(next, occupant.ownerId, view.card);
  if (isBeing) next = triggerEchoesOfBoundlessOffer(next, occupant.ownerId, view.card);
  return checkWin(next);
};

// Equanimity's own single iteration: 1 damage to every Being (or Animated
// Armament acting as one — RULES.md > Keywords > Animated) currently on
// the board (either owner, no death Lifespan loss — see
// dealDamageToBeingNoDeathLoss above, which still fires Depart/Purgatory/
// the death counter normally for a real Being) plus 1 REAL damage to the
// caster's own Lifespan. The target cell list is re-read fresh each call
// (not shared across iterations) so a later iteration correctly sees
// deaths (and any Departs they triggered) from earlier ones — "allow
// Depart mechanics to occur in between each trigger," per the user's own
// instruction — while never double-hitting a cell that's already empty by
// the time its turn in this particular iteration's pass comes up. This is
// also what lets a LATER iteration hit an Animated Armament that just
// became topmost because the Being wearing it died on an earlier one.
const resolveEquanimityIteration = (state, playerId) => {
  const targetCells = Object.entries(state.board)
    .filter(([, o]) => o?.type === 'being' || animatedTopEntry(o))
    .map(([cell]) => cell);
  let next = targetCells.reduce(
    (st, cell) => (st.board[cell]?.type === 'being' || animatedTopEntry(st.board[cell]) ? dealDamageToBeingNoDeathLoss(st, cell, 1) : st),
    state
  );
  const owner = next.players[playerId];
  next = { ...next, players: { ...next.players, [playerId]: { ...owner, lifespan: owner.lifespan - 1 } } };
  return checkWin(next);
};

// Returns a Being to its owner's hand (Revoke) — Armaments left behind stay
// a freestanding pile (dropArmaments), same as any other way a Being
// leaves the board. Unlike destroyBeing, this is NOT a death: no Purgatory,
// no Depart, no Lifespan loss.
const returnBeingToHand = (state, cellId) => {
  const occupant = state.board[cellId];
  if (!occupant || occupant.type !== 'being') return state;
  const board = { ...state.board };
  dropArmamentsOrDryadMount(board, cellId, occupant);
  const owner = state.players[occupant.ownerId];
  const next = {
    ...state,
    board,
    players: { ...state.players, [occupant.ownerId]: { ...owner, hand: [...owner.hand, occupant.card] } },
  };
  return addLog(next, `${occupant.card.name} returns to ${occupant.ownerId}'s hand.`);
};

// Recollect: returns the target Being to its own owner's hand (not
// necessarily the Prophecy's controller — RECOLLECT_RE above targets
// either side), then Crafts Effigies for that same owner equal to the
// returned card's own printed casting cost (totalCastingCost) — the same
// draft-straight-from-the-Effigy-Deck loop CRAFT_EFFIGY_RE's plain "Craft
// (N) Effigy" uses, just scaled by a variable amount instead of a fixed one.
const applyRecollect = (state, cellId, cardName, label) => {
  const occupant = state.board[cellId];
  const ownerId = occupant.ownerId;
  const cost = totalCastingCost(occupant.card);
  let next = returnBeingToHand(state, cellId);
  const owner = next.players[ownerId];
  let deck = owner.effigyDeck;
  let pool = owner.effigyPool;
  let crafted = 0;
  for (let i = 0; i < cost && deck.length > 0; i++) {
    pool = [...pool, deck[0]];
    deck = deck.slice(1);
    crafted++;
  }
  next = { ...next, players: { ...next.players, [ownerId]: { ...owner, effigyDeck: deck, effigyPool: pool } } };
  return addLog(next, `${cardName}'s ${label} crafts ${crafted} Effigy for ${ownerId} (equal to ${occupant.card.name}'s cost).`);
};

// Applies newly attached Armaments' Lifespan bonus to a Being already
// placed on the board (see SUMMON_BEING/MOVE_OR_ATTACK picking up a waiting
// pile, and ATTACH_ARMAMENT). A positive bonus heals immediately; a
// negative one (e.g. "Being gains +6/-3") is dealt as real damage through
// the same death pipeline as combat, so equipping something with a
// Lifespan penalty can kill the Being on the spot if it's lethal — Strength
// bonuses need no such handling since they're computed fresh wherever
// combat reads them (see effectiveStrength in combat.js) rather than
// stored on the occupant. An Animated Armament acting as a Being (RULES.md
// > Keywords > Animated) has no top-level `currentLifespan` of its own —
// the bonus goes on its topmost entry instead, via
// applyLifespanBonusToArmamentEntry (same simplification it already
// documents: a lethal negative bonus there doesn't route through the death
// pipeline, since no real card combination produces one yet).
const applyNewArmamentsLifespanBonus = (state, cellId, newArmaments) => {
  const bonus = newArmaments.reduce((sum, a) => sum + (a.card.keywords?.statBonus?.lifespan || 0), 0);
  if (bonus === 0) return state;
  const occupant = state.board[cellId];
  if (occupant.type !== 'being') {
    return { ...state, board: { ...state.board, [cellId]: { ...occupant, armaments: applyLifespanBonusToArmamentEntry(occupant.armaments, bonus) } } };
  }
  if (bonus < 0) return dealDamageToBeing(state, cellId, -bonus);
  return { ...state, board: { ...state.board, [cellId]: { ...occupant, currentLifespan: occupant.currentLifespan + bonus } } };
};

// Dryad's own Lifespan half of "This has that Being's Strength and
// Lifespan while attached" — applied once as an immediate heal at the
// moment of attaching, same "Lifespan never computed live, only ever a
// one-time heal/damage application" precedent applyNewArmamentsLifespanBonus
// above already establishes for Armament Lifespan bonuses (so a later
// detach never claws it back — see dryadAttachedStrengthBonus, combat.js,
// for why Strength doesn't need this: it's read live instead). Uses the
// mount's *current* Lifespan (not its printed base), since a mount that's
// already taken damage before being attached should only lend what it
// actually has left.
const applyDryadAttachLifespanBonus = (state, cellId) => {
  const occupant = state.board[cellId];
  const bonus = occupant?.dryadAttached?.currentLifespan || 0;
  if (bonus === 0) return state;
  return { ...state, board: { ...state.board, [cellId]: { ...occupant, currentLifespan: occupant.currentLifespan + bonus } } };
};

// The inverse of applyNewArmamentsLifespanBonus above, for a Lifespan-
// bonus-granting Armament that's genuinely LEAVING play (sacrificed,
// destroyed) rather than merely relocating — see removeArmamentEntry's own
// `toPurgatory` option and destroyArmamentEntryAt below, both of which call
// this. A positive bonus is clawed back as real damage through the same
// death pipeline a negative bonus's own attach-time application already
// uses (so a Being that was only alive because of the bonus can die the
// moment it's lost, symmetric with attaching a lethal negative one); a
// negative bonus (e.g. "gains +6/-3") heals back the amount it was
// costing. Deliberately NOT called by a plain relocation (Ay-gruhda's
// moveArmamentEntry, moveAutoAttachArmaments) — RULES.md's own documented
// precedent for those is that a moved Armament's Lifespan bonus stays
// banked on whichever Being it was already granted to, not clawed back.
const removeArmamentsLifespanBonus = (state, cellId, removedArmaments) => {
  const bonus = removedArmaments.reduce((sum, a) => sum + (a.card.keywords?.statBonus?.lifespan || 0), 0);
  if (bonus === 0) return state;
  const occupant = state.board[cellId];
  if (!occupant) return state; // the whole freestanding pile emptied out along with this entry
  if (occupant.type !== 'being') {
    return { ...state, board: { ...state.board, [cellId]: { ...occupant, armaments: applyLifespanBonusToArmamentEntry(occupant.armaments, -bonus) } } };
  }
  if (bonus > 0) return dealDamageToBeing(state, cellId, bonus);
  return { ...state, board: { ...state.board, [cellId]: { ...occupant, currentLifespan: occupant.currentLifespan - bonus } } };
};

// Sporangium: "When a Being with Dryad moves onto this, X." — fired the
// instant a Dryad attach succeeds (see MOVE_OR_ATTACK's move branch),
// checked against the WAITING occupant's own keyword (the tile being
// attached onto, not the mover). `selfArrows` is passed explicitly as the
// attached-onto card's own printed Arrows, same "the caster may already be
// gone from the board by the time this runs" precedent
// SUMMON_TOKEN_POINTED_RE's own callers already establish — by the time
// this resolves, `toCellId` on the board holds the MOVER's card, not
// Sporangium's, so reading arrows off state.board[toCellId] would silently
// use the wrong card's geometry.
const triggerOnDryadAttachedOnto = (state, playerId, toCellId, attachedCard) => {
  const reaction = attachedCard.keywords?.onDryadAttachedOnto;
  if (!reaction) return state;
  let next = addLog(state, `${attachedCard.name}'s reaction triggers.`);
  return resolveOrLogEffect(next, playerId, attachedCard.name, reaction, 'Reaction', { selfCellId: toCellId, selfArrows: attachedCard.arrows });
};

// Relocates one Armament entry from `fromCellId` to `toCellId` (Ay-gruhda:
// "Move target Armament you control to a tile this points to.") — detaches
// it from wherever it currently sits (attached to a Being, or freestanding
// in a pile) via removeArmamentEntry, then re-attaches at the destination
// via insertArmamentEntry, the same pair ATTACH_ARMAMENT itself uses when
// equipping from hand. The destination becomes a fresh freestanding pile
// if it was empty, or joins whatever's already there (a Being or another
// pile) otherwise.
const moveArmamentEntry = (state, cardName, label, fromCellId, armamentInstanceId, toCellId) => {
  const source = state.board[fromCellId];
  const entry = source?.armaments?.find(a => a.card.instanceId === armamentInstanceId);
  if (!entry) return state;
  let next = removeArmamentEntry(state, fromCellId, armamentInstanceId);
  const dest = next.board[toCellId];
  const insertedArmaments = insertArmamentEntry(dest?.armaments || [], entry, !!entry.card.keywords?.animated);
  const destOccupant = dest
    ? { ...dest, armaments: insertedArmaments }
    : { type: 'armament-stack', ownerId: source.ownerId, armaments: insertedArmaments };
  next = { ...next, board: { ...next.board, [toCellId]: destOccupant } };
  next = applyNewArmamentsLifespanBonus(next, toCellId, [entry]);
  return addLog(next, `${cardName}'s ${label} moves ${entry.card.name} to ${toCellId}.`);
};

// Ay-gruhda's own destination half, once a specific Armament entry is
// already settled (the sole candidate, or whichever the player chose from
// move-armament-source) — pointed-tile candidates (the same "points to"
// geometry every other pointed effect this session uses), legal by the
// same rule ATTACH_ARMAMENT itself uses (armamentTargetOk: empty, or the
// player's own Being/pile).
const placeMovedArmament = (state, playerId, cardName, label, fromCellId, armamentInstanceId, context) => {
  const selfArrows = context.selfArrows || state.board[context.selfCellId]?.card?.arrows || [];
  const candidates = [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, context.selfCellId, dir)))]
    .filter(c => c && c !== fromCellId && armamentTargetOk(state.board[c], playerId));
  if (candidates.length === 0) {
    return addLog(state, `${cardName}'s ${label} has no legal tile it points to, to move the Armament onto.`);
  }
  if (candidates.length === 1) {
    return moveArmamentEntry(state, cardName, label, fromCellId, armamentInstanceId, candidates[0]);
  }
  let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a tile it points to, to move the Armament onto.`);
  return {
    ...next,
    pendingChoice: { kind: 'move-armament-destination', playerId, cardName, label, fromCellId, armamentInstanceId, allowedCells: candidates },
  };
};

// Smith Assistant's own destination half — same "any direction" free-move
// geometry Divine Winds' own Being-move uses (moveOrOfferFreeMove), just
// relocating an Armament entry instead of a Being, legal by the same
// armamentTargetOk rule placeMovedArmament (above) uses for its own
// pointed variant. Reuses the SAME 'move-armament-destination'
// pendingChoice kind/UI as placeMovedArmament — its resolver only cares
// about fromCellId/armamentInstanceId/allowedCells, not how they were
// computed, so no new UI wiring is needed for the destination step.
const placeMovedArmamentAnyDirection = (state, playerId, cardName, label, fromCellId, armamentInstanceId) => {
  const candidates = [...new Set([1, 2, 3, 4, 5, 6, 7, 8].map(dir => computeMoveDestination(playerId, fromCellId, dir)))]
    .filter(c => c && c !== fromCellId && armamentTargetOk(state.board[c], playerId));
  if (candidates.length === 0) {
    return addLog(state, `${cardName}'s ${label} has nowhere to move the Armament.`);
  }
  if (candidates.length === 1) {
    return moveArmamentEntry(state, cardName, label, fromCellId, armamentInstanceId, candidates[0]);
  }
  let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose where to move the Armament.`);
  return {
    ...next,
    pendingChoice: { kind: 'move-armament-destination', playerId, cardName, label, fromCellId, armamentInstanceId, allowedCells: candidates },
  };
};

// Mahka-Rahva: "All Armaments you control move to the tile this is summoned
// on" — scans every occupant `playerId` controls (the same board-wide
// ownerId scan controlsOnlyFaithlessPermanents in turn.js uses, just
// collecting Armaments instead of checking Faithless-ness) and relocates
// every one found onto `targetCellId`, stripping it from wherever it was —
// another Being, or a freestanding pile (which is removed entirely once
// emptied, same as it would be from any other source). Deliberately leaves
// the *previous* host's currentLifespan untouched even if the moved
// Armament had granted it a Lifespan bonus — the same "no reversal on
// detach" precedent ACTIVATE_ARMAMENT_SACRIFICE already established, so
// this doesn't introduce a new inconsistency. A Strength bonus needs no
// such handling either way: combat.js's effectiveStrength always computes
// it live from wherever the Armament currently sits, so it follows
// immediately with zero extra bookkeeping.
const gatherArmamentsToTile = (state, playerId, targetCellId, cardName) => {
  const board = { ...state.board };
  const gathered = [];
  Object.entries(board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.ownerId !== playerId || cell === targetCellId) return;
    if (!occupant.armaments || occupant.armaments.length === 0) return;
    gathered.push(...occupant.armaments);
    if (occupant.type === 'armament-stack') {
      delete board[cell];
    } else {
      const { armaments: _armaments, ...rest } = occupant;
      board[cell] = rest;
    }
  });
  if (gathered.length === 0) return state;
  const target = board[targetCellId];
  board[targetCellId] = { ...target, armaments: [...(target.armaments || []), ...gathered] };
  return addLog({ ...state, board }, `${cardName} gathers ${gathered.length} Armament(s) onto ${targetCellId}.`);
};

// "Total Time Counters you control" (Horological Horror's own "(X) is
// equal to..." — cardData.js's xEqualsTimeCountersControlled) — every
// board occupant this player owns contributes whichever of its own two
// possible Time-Counter fields it carries: `timer` (a Prophecy, face-down
// or face-up alike — both phases use the same field, RULES.md >
// Prophecies) or `counters.time` (an Altar's own — Eònion Altar — or any
// other permanent that accumulates them, e.g. Hourglass). Generic over
// occupant type on purpose, rather than hardcoded to just Prophecy/Altar,
// so a future Time-Counter-bearing permanent is picked up automatically.
// Exported so turn.js can recompute Horological Horror's own Strength/
// Lifespan fresh every turn — RULES.md > Keywords: this is meant to read
// like a live, continuously-checked aura, not a value fixed at summon.
export const totalTimeCountersControlledBy = (state, playerId) => {
  let total = 0;
  Object.values(state.board).forEach(o => {
    if (!o || o.ownerId !== playerId) return;
    total += o.timer || 0;
    total += o.counters?.time || 0;
  });
  total += (state.altars[playerId] || []).reduce((sum, a) => sum + (a.counters?.time || 0), 0);
  return total;
};

// Equanimity: "...repeat for each Time Counter on a Prophecy that you
// control." — narrower than totalTimeCountersControlledBy above, which
// also counts Altars/Hourglass-style counters.time; this one is
// specifically a Prophecy's own `timer` field (whether face-down or
// face-up — RULES.md > Prophecies), nothing else.
const totalProphecyTimeCountersControlledBy = (state, playerId) =>
  Object.values(state.board).reduce((sum, o) => sum + (o?.type === 'prophecy' && o.ownerId === playerId ? (o.timer || 0) : 0), 0);

// Horological Horror: "(X) is equal to the total number of Time Counters
// you control" — a live, continuously-checked aura (confirmed directly),
// not a value fixed once at summon or only refreshed once per turn. Every
// copy on the board (either owner — the total is computed per that
// occupant's own owner, not the current turn player) gets its
// Strength/Lifespan refreshed here. Called both by turn.js's beginTurn
// (so it isn't blank before the first turn) and, generically, after every
// single gameReducer action below — a mid-turn effect that grants or
// removes a Time Counter (Freeze Frame, Moment of Doubt, an Engage cost
// spending Crossing/Forge Counters, etc.) must be reflected immediately,
// not just at the next turn's start. Confirmed with the user: real damage
// taken (combat, or anything else) must persist across a recompute rather
// than being wiped — so this only ever applies the DELTA between the live
// total's value at the LAST recompute (banked on `strengthOverride`,
// which otherwise only ever mirrors the live total 1:1) and its current
// value, as a real heal (total went up) or real damage (total went down)
// on top of whatever `currentLifespan` already was — never a hard reset
// to the new total outright. Skipped entirely whenever the live total
// hasn't actually changed since the last recompute, regardless of how far
// `currentLifespan` has since drifted from it via ordinary combat.
//
// Singularity: "has -X/-X where X equals the number of Time Counters that
// you control" — the same live total, but applied as a subtractive
// `timeCounterStatPenalty` (read by combat.js's effectiveStrength) on top
// of the card's own printed Strength, rather than an absolute replacement
// like Horror's `strengthOverride` above. Lifespan is likewise floored at
// printed Lifespan minus the total (never below 0), with the same
// no-separate-damage-tracking simplification as Horror's own case.
export const recomputeXBeings = (state) => {
  let next = state;
  const totalsByOwner = {};
  const getTotal = (ownerId) => {
    if (!(ownerId in totalsByOwner)) totalsByOwner[ownerId] = totalTimeCountersControlledBy(state, ownerId);
    return totalsByOwner[ownerId];
  };

  Object.keys(state.board).forEach(cell => {
    const occupant = next.board[cell];
    if (!occupant || occupant.type !== 'being') return;
    const isAbsolute = occupant.card.keywords?.xEqualsTimeCountersControlled;
    const isPenalty = occupant.card.keywords?.statPenaltyEqualsTimeCountersControlled;
    // "Drown Out the Screams"-style suppression (suppressAbilitiesUntilEndOfTurn)
    // wipes card.keywords to {} for the rest of the turn but stashes the
    // original on suppressedKeywords. An absolute-X Being (Horological
    // Horror) that loses its only Lifespan-defining ability this way has no
    // printed Lifespan to fall back to either — both its Strength and
    // Lifespan columns are literally "X" in the CSV — so it reverts to the
    // same fallback the CSV parser itself uses for an uncomputed "X" (0,
    // cardData.js's toNumber), same as its Time Counters dropping to 0
    // would.
    const suppressedAbsolute = !isAbsolute && occupant.suppressedKeywords?.xEqualsTimeCountersControlled;

    if (isAbsolute || suppressedAbsolute) {
      // Dendrify's own "becomes a 0/5 until end of turn" (applyDendrify
      // above) suppresses abilities AND stamps an explicit
      // lifespanSetUntilEndOfTurn override in the SAME reducer step — that
      // override already IS this Being's real current stats for the rest
      // of the turn, so the "lost its defining ability, falls back to 0"
      // death treatment below must never also fire for it: without this,
      // Horological Horror's suppressedAbsolute branch would immediately
      // re-derive its live X as 0 and deal damage equal to the Lifespan
      // Dendrify just set, silently undoing "becomes a 0/5" into a kill the
      // instant it lands.
      if (occupant.lifespanSetUntilEndOfTurn != null) return;
      const total = isAbsolute ? getTotal(occupant.ownerId) : 0;
      // `strengthOverride` doubles as "the live total as of the last
      // recompute" — falls back to `total` itself (a no-op skip) the very
      // first time this runs for a given occupant, since placeBeingOnBoard
      // already snapshots both `currentLifespan` and `strengthOverride` to
      // the same initial xValue at summon (see its own comment).
      const previousTotal = occupant.strengthOverride ?? total;
      if (previousTotal === total) return; // the live total itself hasn't changed — leave currentLifespan exactly as combat/etc. already left it
      // A live X of (0) — or losing the ability that defines it — is a
      // real death (RULES.md: a Being's Lifespan hitting 0 kills it), not
      // just a stat that happens to read 0; routed through the normal
      // death pipeline (Depart, owner Lifespan loss, Purgatory, the
      // death-count trigger) via dealDamageToBeing's own signed-damage
      // handling, which also correctly HEALS when the live total rises.
      // Only the CHANGE in the live total (`previousTotal` -> `total`) is
      // ever applied here — not a hard reset to `total` outright — so real
      // damage already taken (combat, or anything else) stays applied on
      // top rather than being wiped the moment anything else recomputes.
      const damage = previousTotal - total;
      next = { ...next, board: { ...next.board, [cell]: { ...occupant, strengthOverride: total } } };
      next = dealDamageToBeing(next, cell, damage);
      return;
    }

    if (!isPenalty) return;
    const total = getTotal(occupant.ownerId);
    const targetLifespan = Math.max(0, occupant.card.lifespan - total);
    if (occupant.timeCounterStatPenalty === total && occupant.currentLifespan === targetLifespan) return;
    // Singularity: "has -X/-X where X equals the number of Time Counters
    // that you control." A live X big enough to floor this at 0 Lifespan is
    // a real death (RULES.md: a Being's Lifespan hitting 0 kills it) — same
    // dealDamageToBeing-routed treatment the isAbsolute branch above already
    // gives Horological Horror's own live X, not a silent floor that leaves
    // it sitting on the board at 0.
    const damage = occupant.currentLifespan - targetLifespan;
    next = { ...next, board: { ...next.board, [cell]: { ...occupant, timeCounterStatPenalty: total } } };
    next = dealDamageToBeing(next, cell, damage);
  });
  return next;
};

// Words a card's own "Card Typing" column carries alongside its real race
// typing that don't themselves describe a race (RULES.md > Card types) —
// excluded when deriving "another Being sharing MY typing" (Darmah-Triya)
// so that shared word isn't just "Being", which would trivially match
// almost anything on the board.
const TYPING_SUPERTYPE_WORDS = new Set(['being', 'deity', 'token', 'familiar']);
const raceTypings = (card) => (card.typing || '')
  .split(',')
  .map(t => t.trim().toLowerCase())
  .filter(t => t && !TYPING_SUPERTYPE_WORDS.has(t));

// Computes one occupant's live conditional Strength/Lifespan bonus total
// from whichever of the "conditional/count-based static bonus" keyword
// shapes it carries (cardData.js: otherSameTypingBonus, allTypingsBonus,
// perOtherTypingBonus, perNonArmamentRelicLifespan). At most one is ever
// printed on a real card today, but they're summed rather than treated as
// mutually exclusive so a future card stacking two shapes just works, same
// spirit as effectiveStrength (combat.js) summing every bonus source.
// Reads off the ORIGINAL `state` (not an in-progress recompute pass), same
// "conditions don't chain within one pass" precedent as recomputeXBeings.
const conditionalBonusTarget = (state, cell, occupant) => {
  const kw = occupant.card.keywords || {};
  const owner = occupant.ownerId;
  let strength = 0;
  let lifespan = 0;

  // Darmah-Triya: "Gains +0/+3 if you control a Turanga other than
  // Darmah-Triya." — "a Turanga" just means "another Being sharing my own
  // race typing", derived from this occupant's own card.typing rather than
  // any word captured from the ability text (see cardData.js's own comment
  // on otherSameTypingBonus for why).
  if (kw.otherSameTypingBonus) {
    const myTypings = raceTypings(occupant.card);
    const hasOther = myTypings.length > 0 && Object.entries(state.board).some(([c, o]) =>
      c !== cell && o?.type === 'being' && o.ownerId === owner && raceTypings(o.card).some(t => myTypings.includes(t))
    );
    if (hasOther) {
      strength += kw.otherSameTypingBonus.strength;
      lifespan += kw.otherSameTypingBonus.lifespan;
    }
  }

  // Menagerie Mistress: "While you control an Imp, Cat, and a Rat,
  // Menagerie Mistress has +3/+6." — every typing in the printed list must
  // be represented by at least one of the controller's own Beings (not
  // necessarily different ones from each other).
  if (kw.allTypingsBonus) {
    const { typings, strength: s, lifespan: l } = kw.allTypingsBonus;
    const allControlled = typings.every(typing => {
      const word = typing.toLowerCase();
      return Object.values(state.board).some(o => o?.type === 'being' && o.ownerId === owner && (o.card.typing || '').toLowerCase().includes(word));
    });
    if (allControlled) {
      strength += s;
      lifespan += l;
    }
  }

  // Mischief of Rats: "This has +1/+1 for each other Rat you have in
  // play." — counts the controller's OTHER Beings of the named typing,
  // excluding this occupant's own cell even though it shares that typing.
  if (kw.perOtherTypingBonus) {
    const { typing, strength: s, lifespan: l } = kw.perOtherTypingBonus;
    const word = typing.toLowerCase();
    const count = Object.entries(state.board).filter(([c, o]) =>
      c !== cell && o?.type === 'being' && o.ownerId === owner && (o.card.typing || '').toLowerCase().includes(word)
    ).length;
    strength += s * count;
    lifespan += l * count;
  }

  // Temple Guardian: "Has (+1) Lifespan for each Non Armament Relic you
  // control." — a standalone board Relic (`type: 'relic'`) is already, by
  // construction, never an attached/Animated Armament (those live in
  // `occupant.armaments` or as an `armament-stack` instead), so no further
  // filtering is needed to exclude Armaments. Board-only, same as every
  // other Relic-counting precedent in this file (groundRelics/Altars never
  // counted as "a Relic" by any of them either).
  if (kw.perNonArmamentRelicLifespan) {
    const count = Object.values(state.board).filter(o => o?.type === 'relic' && o.ownerId === owner).length;
    lifespan += kw.perNonArmamentRelicLifespan * count;
  }

  return { strength, lifespan };
};

// Applies conditionalBonusTarget's live totals to every Being that carries
// one of the four keyword shapes — same "recomputed after every action"
// wrapper treatment as recomputeXBeings/recomputeDeathCountBonuses (called
// from gameReducer's own top-level wrapper and turn.js's beginTurn), and,
// unlike recomputeDeathCountBonuses' turn-scoped monotonic growth, a real
// two-way Lifespan delta — the condition can become false again mid-game
// (the other Turanga dies, a Relic is sacrificed), so a shrinking bonus is
// routed through dealDamageToBeing's own signed damage exactly like
// recomputeXBeings' absolute case, which can mean a real death if the lost
// bonus had been propping up Lifespan taken as damage while it was active.
export const recomputeConditionalBonuses = (state) => {
  let next = state;
  Object.keys(state.board).forEach(cell => {
    const occupant = next.board[cell];
    if (!occupant || occupant.type !== 'being') return;
    const kw = occupant.card.keywords || {};
    if (!kw.otherSameTypingBonus && !kw.allTypingsBonus && !kw.perOtherTypingBonus && !kw.perNonArmamentRelicLifespan) return;

    const { strength: targetStrength, lifespan: targetLifespan } = conditionalBonusTarget(state, cell, occupant);
    const appliedLifespan = occupant.conditionalBonus?.lifespan || 0;
    if (occupant.conditionalBonus?.strength === targetStrength && appliedLifespan === targetLifespan) return;

    const damage = appliedLifespan - targetLifespan; // shrinking bonus -> positive damage; growing -> negative (heal)
    next = { ...next, board: { ...next.board, [cell]: { ...occupant, conditionalBonus: { strength: targetStrength, lifespan: targetLifespan } } } };
    next = dealDamageToBeing(next, cell, damage);
  });
  return next;
};

// Growth Spurt ("Beings you control have +1/+0, if any of those beings are
// TreeFolk, they gain +2/+0 instead") / Blooming Life & Withering Life
// tokens ("Beings you control have +1/+1." / "Beings you don't control
// have -1/-1.") — sums every LIVE aura source's contribution to one
// occupant: boardWideAllyBonus from a source the occupant's OWN controller
// owns, boardWideEnemyBonus from a source owned by anyone else. A source is
// "live" only while it's a face-up Prophecy still holding Time Counters —
// the same "read live off the board, not a stored flag" convention
// Daylight Savings/Blood Moon's own ongoing passives already established
// (RULES.md > Prophecies) — so the aura turns off the instant its own
// Prophecy runs out and goes to Purgatory, with nothing extra to clean up.
const boardWideAuraBonusTarget = (state, cell, occupant) => {
  let strength = 0;
  let lifespan = 0;
  const controller = occupant.ownerId;
  Object.values(state.board).forEach(source => {
    if (!source || source.type !== 'prophecy' || source.faceDown || (source.timer || 0) <= 0) return;
    const ally = source.card.keywords?.boardWideAllyBonus;
    if (ally && source.ownerId === controller) {
      const conditionMet = ally.condTyping && (occupant.card.typing || '').toLowerCase().includes(ally.condTyping.toLowerCase());
      strength += conditionMet ? ally.condStrength : ally.strength;
      lifespan += conditionMet ? ally.condLifespan : ally.lifespan;
    }
    const enemy = source.card.keywords?.boardWideEnemyBonus;
    if (enemy && source.ownerId !== controller) {
      strength += enemy.strength;
      lifespan += enemy.lifespan;
    }
  });
  return { strength, lifespan };
};

// Same "recomputed after every action" wrapper treatment as
// recomputeConditionalBonuses above (called from gameReducer's own
// top-level wrapper and turn.js's beginTurn) — a board-wide aura can both
// grow (a new source flips face-up) and shrink (its source runs out of
// Time Counters, or the Being it's now buffing changes typing — not
// possible for any current card, but the live recompute handles it for
// free either way), so it goes through the same signed
// dealDamageToBeing-delta treatment recomputeConditionalBonuses' own
// two-way Lifespan swing uses.
export const recomputeBoardWideAuraBonuses = (state) => {
  let next = state;
  Object.keys(state.board).forEach(cell => {
    const occupant = next.board[cell];
    if (!occupant || occupant.type !== 'being') return;
    const { strength: targetStrength, lifespan: targetLifespan } = boardWideAuraBonusTarget(next, cell, occupant);
    const appliedLifespan = occupant.boardWideAuraBonus?.lifespan || 0;
    if ((occupant.boardWideAuraBonus?.strength || 0) === targetStrength && appliedLifespan === targetLifespan) return;

    const damage = appliedLifespan - targetLifespan;
    next = { ...next, board: { ...next.board, [cell]: { ...occupant, boardWideAuraBonus: { strength: targetStrength, lifespan: targetLifespan } } } };
    next = dealDamageToBeing(next, cell, damage);
  });
  return next;
};

// Kalmahka: "Armaments you control are 3/1 Relic - Armaments with
// 'Animated. Attached Being has +0/+0' and lose all other text." — same
// "recomputed after every action, live off a face-up Prophecy with Time
// Counters" wrapper treatment as recomputeBoardWideAuraBonuses above, just
// replacing the WHOLE card object instead of adding a stat bonus. Since
// every existing read site in this file (armamentStrengthBonus,
// animatedTopEntry, Martyr/Engage offering, Board.jsx's own rendering)
// already goes through occupant.armaments[i].card.*, rewriting that card
// object here needs no other touch point anywhere else — the same single-
// choke-point trick suppressAbilitiesUntilEndOfTurn already uses for a
// single target, just live/recomputed across every Armament the aura's
// own controller owns instead of a one-time stored flag on one occupant.
// The original card is stashed on the entry (kalmahkaOriginalCard) so it
// can be restored the instant the source Prophecy leaves play — recomputed
// fresh every action, so it never drifts out of sync. Deliberate
// simplification: an already-Animated entry's own tracked currentLifespan
// is never retroactively capped down to the new printed 1 — only the
// stats/keywords/text change, matching the "a live recompute never kills
// on its own" precedent recomputeBoardWideAuraBonuses above already
// follows (it only ever applies its OWN additive delta as real damage,
// never a hard cap unrelated to that delta).
const KALMAHKA_OVERRIDE_CARD = {
  name: 'Warped Armament', strength: 3, lifespan: 1,
  typing: 'Relic, Armament', kind: 'relic-armament', arrows: [],
  keywords: { animated: true, statBonus: { strength: 0, lifespan: 0 } },
  textBox: 'Animated. Attached Being has +0/+0.',
};

const activeArmamentIdentityOverride = (board, playerId) =>
  Object.values(board).some(o =>
    o?.type === 'prophecy' && o.ownerId === playerId && !o.faceDown && (o.timer || 0) > 0 && o.card.keywords?.armamentIdentityOverride
  );

export const recomputeKalmahkaOverrides = (state) => {
  let changed = false;
  const board = { ...state.board };
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant?.armaments?.length) return;
    const shouldOverride = activeArmamentIdentityOverride(state.board, occupant.ownerId);
    let armamentsChanged = false;
    const newArmaments = occupant.armaments.map(entry => {
      const isOverridden = !!entry.kalmahkaOriginalCard;
      if (shouldOverride && !isOverridden) {
        armamentsChanged = true;
        return { ...entry, kalmahkaOriginalCard: entry.card, card: { ...KALMAHKA_OVERRIDE_CARD, id: entry.card.id, instanceId: entry.card.instanceId } };
      }
      if (!shouldOverride && isOverridden) {
        armamentsChanged = true;
        return { ...entry, card: entry.kalmahkaOriginalCard, kalmahkaOriginalCard: undefined };
      }
      return entry;
    });
    if (armamentsChanged) {
      changed = true;
      board[cell] = { ...occupant, armaments: newArmaments };
    }
  });
  return changed ? { ...state, board } : state;
};

// Restless Dead: "has +2/+0 until end of turn for each Being that died
// under your control this turn." — same "recomputed after every action"
// live-aura treatment as recomputeXBeings above, just reading
// beingsDiedThisTurn (incrementBeingsDiedThisTurn) instead of Time
// Counters. Strength is a pure live read (combat.js's
// deathCountStatBonusStrength, always computed fresh — nothing to
// persist). Lifespan is healed immediately and permanently the moment the
// live total grows, same "a Lifespan change is never really temporary in
// this engine" precedent Plague doctor's own comment documents — only the
// DELTA since the last recompute is healed (deathCountBonus.lifespan
// tracks how much has already been applied), and that tracker is cleared
// alongside beingsDiedThisTurn itself at endTurn (turn.js) so a fresh turn
// starts from a clean baseline instead of clawing back last turn's heal.
export const recomputeDeathCountBonuses = (state) => {
  const board = { ...state.board };
  let changed = false;
  Object.entries(board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'being') return;
    const perUnit = occupant.card.keywords?.statBonusPerOwnDeathThisTurn;
    if (!perUnit) return;
    const count = state.players[occupant.ownerId]?.beingsDiedThisTurn || 0;
    const targetStrength = perUnit.strength * count;
    const targetLifespan = perUnit.lifespan * count;
    const appliedLifespan = occupant.deathCountBonus?.lifespan || 0;
    if (occupant.deathCountBonus?.strength === targetStrength && appliedLifespan === targetLifespan) return;
    board[cell] = {
      ...occupant,
      deathCountBonus: { strength: targetStrength, lifespan: targetLifespan },
      currentLifespan: occupant.currentLifespan + (targetLifespan - appliedLifespan),
    };
    changed = true;
  });
  return changed ? { ...state, board } : state;
};

// Places `card` (a Being or Deity) onto an empty/own-armament-stack cell
// and fires everything a normal cast does after its cost is paid — picks up
// any Armaments already waiting there, the engaged-on-entry rule (Deities
// and Persist enter ready), Favored, "gathers Armaments on summon"
// (Mahka-Rahva), and the card's own When Summoned trigger. Shared by
// SUMMON_BEING and Grave robber's Martyr ("Summon an Undead Being on this
// tile from your Purgatory") so a reanimated Being's own ETB effects fire
// exactly the same way a normally-cast one's do, not a parallel,
// easily-drifting reimplementation. Doesn't touch cost/hand/Purgatory —
// callers handle wherever the card came from themselves.
// Happy Hammer: "Whenever a Being is summoned under your control, move and
// attach [this] to that Being." — scans every Armament entry the
// summoning player controls (attached to another Being, or freestanding
// in an armament-stack pile) for one carrying movesToNewlySummonedBeing,
// detaches it from wherever it currently sits, and re-attaches it to the
// Being that was just placed at `cellId` — the same insertArmamentEntry/
// Lifespan-bonus handling ATTACH_ARMAMENT itself uses when equipping from
// hand. Cells already at `cellId` are skipped — if the newly-placed Being
// simply picked up a waiting pile that already included it (placeBeingOnBoard's
// own `waiting` handling, above), it's already there and there's nothing
// to move. Reads/writes `next` fresh on every entry found so multiple
// copies (or other movesToNewlySummonedBeing Armaments) each still see the
// up-to-date board shape.
const moveAutoAttachArmaments = (state, playerId, cellId) => {
  let next = state;
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (cell === cellId || !occupant || occupant.ownerId !== playerId) return;
    (occupant.armaments || []).forEach(a => {
      if (!a.card.keywords?.movesToNewlySummonedBeing) return;
      const source = next.board[cell];
      const entry = source?.armaments?.find(x => x.card.instanceId === a.card.instanceId);
      if (!entry) return; // already moved earlier this same pass, or no longer there
      next = removeArmamentEntry(next, cell, a.card.instanceId);
      const dest = next.board[cellId];
      const insertedArmaments = insertArmamentEntry(dest?.armaments || [], entry, !!entry.card.keywords?.animated);
      next = { ...next, board: { ...next.board, [cellId]: { ...dest, armaments: insertedArmaments } } };
      next = applyNewArmamentsLifespanBonus(next, cellId, [entry]);
      next = addLog(next, `${entry.card.name} moves and attaches to ${next.board[cellId].card?.name || cellId}.`);
    });
  });
  return next;
};

// Greenseer's assistant: "When a Familiar is summoned under your control,
// draw (1) card." — scans every OTHER Being `playerId` controls for its own
// onTypedSummonedUnderControl reaction (cardData.js), checking the newly-
// placed `card`'s own typing against each one's required typing. A
// Being's own reaction to *any* Being being summoned, distinct from
// moveAutoAttachArmaments above (an Armament's own reaction, unconditional
// on typing) — kept as its own pass rather than folded into that one since
// it scans real Beings, not Armament entries, and resolves free effect
// text instead of a single hardcoded move-and-attach.
const triggerTypedSummonReactions = (state, playerId, cellId, card) => {
  let next = state;
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (cell === cellId || !occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return;
    const reaction = occupant.card.keywords?.onTypedSummonedUnderControl;
    if (!reaction) return;
    if (!(card.typing || '').toLowerCase().includes(reaction.typing.toLowerCase())) return;
    next = addLog(next, `${occupant.card.name}'s reaction triggers.`);
    next = resolveOrLogEffect(next, playerId, occupant.card.name, reaction.effect, 'Reaction', { selfCellId: cell });
  });
  return next;
};

// White Whisker: "Sacrifice this when you summon a Familiar." — a Relic's
// own reactive sacrifice, watching the SAME typed-summon trigger point as
// triggerTypedSummonReactions above (a Being's onTypedSummonedUnderControl),
// just scanning `type === 'relic'` occupants instead and unconditionally
// sacrificing the matching Relic rather than resolving free-form effect
// text. Runs after the new Being is already placed (cellId excluded, same
// as above), so a Relic reacting to the very Being that triggered it still
// sees the board in its final state.
const triggerSacrificeSelfOnSummonTyping = (state, playerId, cellId, card) => {
  let next = state;
  Object.entries(next.board).forEach(([cell, occupant]) => {
    if (cell === cellId || !occupant || occupant.type !== 'relic' || occupant.ownerId !== playerId) return;
    const typing = occupant.card.keywords?.sacrificeSelfOnSummonTyping;
    if (!typing) return;
    if (!(card.typing || '').toLowerCase().includes(typing.toLowerCase())) return;
    next = addLog(next, `${occupant.card.name} is sacrificed (summoned a ${typing}).`);
    next = sacrificeOccupantAt(next, cell);
  });
  return next;
};

// Sapling: "Whenever you Martyr a Seed, Craft (1) Effigy." — a Being's own
// reaction to its controller sacrificing their own Seed, checked against
// whichever card was just sacrificed (`sacrificedCard`) — same typing-
// substring match as triggerTypedSummonReactions above, just watching a
// different trigger point. Called from two real self-sacrifice shapes: a
// printed "Martyr:" activation (ACTIVATE_MARTYR), and a card sacrificing
// itself to its OWN effect (SACRIFICE_THIS_THEN_RE — Blooming Seed/Kernel's
// own counterCostSacrificeAbility) — both are "you sacrifice a Seed" from
// the player's perspective, just reached through different reducer actions;
// scoping this to only the former was the actual bug (a Seed sacrificing
// itself via its own printed cost never reads as anything other than "you
// sacrificed a Seed" to a card watching for it). The scan runs on the board
// AFTER the sacrificed occupant is already removed, so a card reacting to
// its own sacrifice (not the case for any real card checked so far) simply
// wouldn't see itself — consistent with it no longer being on the board to
// react.
const triggerMartyrTypedReactions = (state, playerId, sacrificedCard) => {
  let next = state;
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return;
    const reaction = occupant.card.keywords?.onOwnMartyrTyped;
    if (!reaction) return;
    if (!(sacrificedCard.typing || '').toLowerCase().includes(reaction.typing.toLowerCase())) return;
    next = addLog(next, `${occupant.card.name}'s reaction triggers.`);
    next = resolveOrLogEffect(next, playerId, occupant.card.name, reaction.effect, 'Reaction', { selfCellId: cell });
  });
  return next;
};

// Monumental Mason: "If you conjure a non Armament Relic on a tile this
// points to, Craft an Effigy." — reacts to PLACE_RELIC (the only action
// that conjures a standalone, non-Armament Relic onto its own tile) landing
// on any tile this card's own printed Arrows point to — same "points to"
// geometry as ADD_COUNTER_TYPED_POINTED_RE (Green thumbed Gardener) above,
// just watching a different trigger point (a Relic conjured elsewhere on
// the board, not this card's own summon) and always resolving the same
// fixed effect (Craft Effigy) rather than free text, so it reuses
// CRAFT_EFFIGY_RE's own craft logic inline rather than round-tripping
// through resolveOrLogEffect for a single fixed shape.
const triggerPointedRelicConjureCraftEffigy = (state, playerId, placedCellId) => {
  let next = state;
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return;
    const ability = occupant.card.keywords?.craftEffigyOnPointedRelicConjure;
    if (!ability) return;
    const arrows = occupant.card.arrows || [];
    const pointedCells = new Set(arrows.map(dir => computeMoveDestination(playerId, cell, dir)));
    if (!pointedCells.has(placedCellId)) return;
    const player = next.players[playerId];
    let deck = player.effigyDeck;
    let pool = player.effigyPool;
    let crafted = 0;
    for (let i = 0; i < ability.amount && deck.length > 0; i++) {
      pool = [...pool, deck[0]];
      deck = deck.slice(1);
      crafted++;
    }
    next = { ...next, players: { ...next.players, [playerId]: { ...player, effigyDeck: deck, effigyPool: pool } } };
    next = addLog(next, `${occupant.card.name}'s reaction crafts ${crafted} Effigy for ${playerId}.`);
  });
  return next;
};

// Nursery Attendant: "<Typing> Beings that <name> Points to cost (-N)
// <Color> to activate." — a live discount on payEffigyCostAbility's own
// printed Effigy cost (RULES.md's only "activate" cost shape so far),
// recomputed at the moment a cost is checked/paid rather than stored on the
// target, so it always reflects Nursery Attendant's current board position
// live, same as every other "points to" geometry. Summed across every
// matching Nursery Attendant `playerId` controls, in case more than one
// somehow points at the same Being.
const pointedActivationCostReduction = (state, playerId, targetCellId, color) => {
  const targetOccupant = state.board[targetCellId];
  if (!targetOccupant || targetOccupant.type !== 'being') return 0;
  let reduction = 0;
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return;
    const ability = occupant.card.keywords?.seedActivationCostReduction;
    if (!ability || ability.color !== color) return;
    if (!(targetOccupant.card.typing || '').toLowerCase().includes(ability.typing.toLowerCase())) return;
    const arrows = occupant.card.arrows || [];
    const pointedCells = new Set(arrows.map(dir => computeMoveDestination(playerId, cell, dir)));
    if (pointedCells.has(targetCellId)) reduction += ability.amount;
  });
  return reduction;
};

// Shared by every "Whenever X, gain +S/+L" PERMANENT-growth reaction keyed
// off a simple {strength, lifespan} keyword field — Ravenous Lamtukka's
// own "Whenever you pay Lifespan gain +1/+1." (onLifespanPaidGrowth) and
// Onoushara's own "Whenever a Being you control dies, [this] gains +1/+1."
// (onOwnBeingDiedGrowth) are the two real shapes so far, each just reading
// a different keyword field off the same permanent `permanentBonus`
// primitive Lamtukka Gentleman's own buff-ally (and the Growth Counter
// mechanic) already use — a positive Lifespan half is applied as an
// immediate heal, same established precedent.
const triggerPermanentGrowthReactions = (state, playerId, keywordField) => {
  let next = state;
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return;
    const growth = occupant.card.keywords?.[keywordField];
    if (!growth) return;
    const current = next.board[cell];
    if (!current) return;
    const permanentBonus = {
      strength: (current.permanentBonus?.strength || 0) + growth.strength,
      lifespan: (current.permanentBonus?.lifespan || 0) + growth.lifespan,
    };
    next = {
      ...next,
      board: {
        ...next.board,
        [cell]: { ...current, permanentBonus, currentLifespan: current.currentLifespan + growth.lifespan },
      },
    };
    next = addLog(next, `${current.card.name} triggers, growing +${growth.strength}/+${growth.lifespan}.`);
  });
  return next;
};

const triggerLifespanPaidReactions = (state, playerId) => triggerPermanentGrowthReactions(state, playerId, 'onLifespanPaidGrowth');

// Onoushara: "Whenever a Being you control dies, [this] gains +1/+1." —
// fired from the exact same sites incrementBeingsDiedThisTurn already is
// (dealDamageToBeing's own death branch, destroyBeing, MOVE_OR_ATTACK's
// two combat death branches, ACTIVATE_MARTYR guarded to real Beings) —
// every real "a Being died" trigger point, so this reuses that same
// coverage instead of re-deriving it. Keyed by the dying Being's own
// OWNER, same as the death counter.
const triggerOwnBeingDiedReactions = (state, playerId) => triggerPermanentGrowthReactions(state, playerId, 'onOwnBeingDiedGrowth');

// Death's Decanter: "Gain (1) Crossing Counter whenever a Being Dies." —
// unlike triggerOwnBeingDiedReactions above, this has no "you control" on
// the trigger at all: ANY Being dying, either side, grants a Counter to
// every Relic carrying this keyword, regardless of who owns the Relic or
// who owned the Being that died. Fired from the exact same 5 real
// "a Being died" trigger points as triggerOwnBeingDiedReactions, just
// without a playerId scope.
// Blood Moon: "Whenever a Being dies it's controller gives a different
// target Being +1/+1." — read live off Blood Moon's own face-up Prophecy
// occupant (same "ongoing passive, not a stored flag" precedent
// controllerSkipsDraw/turn.js already establishes for Daylight Savings),
// fired from the same 5 real "a Being died" trigger points as
// triggerAnyBeingDiedCounterGain. `dyingOwnerId` picks the choosing
// player — the dying Being's OWN controller, not Blood Moon's.
const triggerAnyBeingDiedGiveDifferentBuff = (state, dyingOwnerId) => {
  const source = Object.values(state.board).find(o =>
    o?.type === 'prophecy' && !o.faceDown && (o.timer || 0) > 0 && o.card.keywords?.onAnyBeingDiedGiveDifferentBuff
  );
  if (!source) return state;
  const { strength, lifespan } = source.card.keywords.onAnyBeingDiedGiveDifferentBuff;
  const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && o.ownerId === dyingOwnerId);
  if (candidates.length === 0) return state;
  const applyBuff = (st, cell) => {
    const occ = st.board[cell];
    const existing = occ.permanentBonus || { strength: 0, lifespan: 0 };
    const next = {
      ...st,
      board: {
        ...st.board,
        [cell]: { ...occ, permanentBonus: { strength: existing.strength + strength, lifespan: existing.lifespan + lifespan }, currentLifespan: occ.currentLifespan + lifespan },
      },
    };
    return addLog(next, `${source.card.name} gives ${occ.card.name} +${strength}/+${lifespan}.`);
  };
  if (candidates.length === 1) return applyBuff(state, candidates[0][0]);
  let next = addLog(state, `${source.card.name} lets ${dyingOwnerId} choose a Being to give +${strength}/+${lifespan}.`);
  return {
    ...next,
    pendingChoice: {
      kind: 'give-different-typed-buff', playerId: dyingOwnerId, cardName: source.card.name, label: 'reaction',
      strengthBonus: strength, lifespanBonus: lifespan, allowedCells: candidates.map(([cell]) => cell),
    },
  };
};

const triggerAnyBeingDiedCounterGain = (state) => {
  let next = state;
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'relic') return;
    const gain = occupant.card.keywords?.gainCounterOnAnyBeingDeath;
    if (!gain) return;
    const current = next.board[cell];
    if (!current) return;
    const have = current.counters?.[gain.type] || 0;
    next = {
      ...next,
      board: { ...next.board, [cell]: { ...current, counters: { ...current.counters, [gain.type]: have + gain.amount } } },
    };
    next = addLog(next, `${current.card.name} gains ${gain.amount} ${gain.type} Counter(s) (a Being died).`);
  });
  return next;
};

// Void Channeler: "Gain (1) Crossing Counter each time you Conjure." —
// fired from CAST_CONJURING, scoped to the casting player's own board
// (the trigger says "you Conjure", not "a player conjures").
const triggerOnConjureReactions = (state, playerId) => {
  let next = state;
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.ownerId !== playerId || (occupant.type !== 'being' && occupant.type !== 'relic')) return;
    const gain = occupant.card.keywords?.onConjure;
    if (!gain) return;
    const current = next.board[cell];
    if (!current) return;
    const have = current.counters?.[gain.type] || 0;
    next = {
      ...next,
      board: { ...next.board, [cell]: { ...current, counters: { ...current.counters, [gain.type]: have + gain.amount } } },
    };
    next = addLog(next, `${current.card.name} gains ${gain.amount} ${gain.type} Counter(s) (a Conjuring was cast).`);
  });
  return next;
};

// Lotus: "Once per turn, when a Turanga you control dies: Add a Spirit
// from deck to hand.\nOnce per turn, when a Spirit you control dies: Add
// a Turanga from deck to hand." — two independent once-per-turn reactions
// (deckSearchOnTypedDeath, cardData.js), scoped to the SAME owner (the
// dying Being's owner must be this Relic's own controller — "you control"
// appears on both halves). Fired from the exact same 5 real "a Being died"
// trigger points as triggerOwnBeingDiedReactions/triggerAnyBeingDiedCounterGain.
// The once-per-turn flag is consumed on ANY trigger, even a whiff (no
// matching card currently in deck) — matching how every other "Once per
// turn" ability in this file gates the trigger itself, not a successful
// outcome. Reset per-clause at the start of the controller's own turn
// (resetLotusTriggers, turn.js).
const triggerDeckSearchOnTypedDeath = (state, dyingOwnerId, dyingTyping) => {
  let next = state;
  if (!dyingTyping) return next;
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'relic' || occupant.ownerId !== dyingOwnerId) return;
    const clauses = occupant.card.keywords?.deckSearchOnTypedDeath;
    if (!clauses) return;
    clauses.forEach((clause, idx) => {
      const current = next.board[cell];
      if (!current) return;
      if ((current.typedDeathSearchUsed || [])[idx]) return;
      if (!dyingTyping.toLowerCase().includes(clause.dyingTyping.toLowerCase())) return;
      const usedFlags = [...(current.typedDeathSearchUsed || [])];
      usedFlags[idx] = true;
      const withUsed = { ...current, typedDeathSearchUsed: usedFlags };
      next = { ...next, board: { ...next.board, [cell]: withUsed } };
      const player = next.players[dyingOwnerId];
      const candidates = searchZoneCandidates(player.mainDeck, clause.addTyping);
      if (candidates.length === 0) {
        next = addLog(next, `${withUsed.card.name} finds no "${clause.addTyping}" in ${dyingOwnerId}'s deck.`);
      } else if (candidates.length === 1) {
        const found = candidates[0];
        const mainDeck = player.mainDeck.filter(c => c.instanceId !== found.instanceId);
        next = { ...next, players: { ...next.players, [dyingOwnerId]: { ...player, mainDeck, hand: [...player.hand, found] } } };
        next = addLog(next, `${withUsed.card.name} adds ${found.name} to ${dyingOwnerId}'s hand.`);
      } else {
        next = addLog(next, `${withUsed.card.name} lets ${dyingOwnerId} choose a "${clause.addTyping}" to add to hand.`);
        next = { ...next, pendingChoice: { kind: 'search', playerId: dyingOwnerId, source: 'mainDeck', query: clause.addTyping, cardName: withUsed.card.name } };
      }
    });
  });
  return next;
};

// Temporal Anomaly: "This gains +1/+1 whenever you Modulate (±1) except
// due to the Modulate Step." — fired only from RESOLVE_MODULATE (a
// player-activated Modulate), never from the automatic per-turn Modulate
// Step tick (turn.js's own modulate/modulateOtherTimeCounters/
// modulateAltarTimeCounters), which is exactly what "except due to the
// Modulate Step" means: those never dispatch RESOLVE_MODULATE at all.
const triggerModulateReactions = (state, playerId) => triggerPermanentGrowthReactions(state, playerId, 'onModulateGrowth');

// Time Capsule: "Whenever you Modulate (-1) except due to the Modulate
// Step, add (1) Time Counter to this." — fired only from the 3 real
// player-activated Modulate sites below (RESOLVE_MODULATE), same as
// triggerModulateReactions above, and never from the automatic per-turn
// tick (turn.js), which the card's own text explicitly excludes.
const triggerModulateMinusOneCounterGain = (state, playerId, delta) => {
  if (delta !== -1) return state;
  let next = state;
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || (occupant.type !== 'being' && occupant.type !== 'relic') || occupant.ownerId !== playerId) return;
    const amount = occupant.card.keywords?.onModulateMinusOneAddCounter;
    if (!amount) return;
    const current = next.board[cell];
    if (!current) return;
    const have = current.counters?.time || 0;
    next = { ...next, board: { ...next.board, [cell]: { ...current, counters: { ...current.counters, time: have + amount } } } };
    next = addLog(next, `${current.card.name} gains ${amount} Time Counter(s) (Modulate -1).`);
  });
  return next;
};

// Spirit of War: "Whenever a different Being you control Fights, gain
// +1/+0 until the end of turn." — a passive reaction to the controller's
// own OTHER Being attacking (this engine's "Fights" = declares an attack,
// per the "fights without engaging" precedent — Desperate Finale's own
// text). Fired from both of MOVE_OR_ATTACK's attack-resolution paths
// (an unblocked lane, and mutual combat — the reaction fires either way,
// even if the attacker itself dies in the exchange) for the attacking
// player. Every matching Being the attacker's controller controls (other
// than the attacker itself) grows independently — a genuinely temporary
// bonus (statBonusUntilEndOfTurn, cleared by endTurn), same primitive
// Boknean Wine's own buff already uses; a positive Lifespan half heals
// immediately, same established precedent.
const triggerAllyFightsReactions = (state, playerId, attackerCellId) => {
  let next = state;
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (cell === attackerCellId || !occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return;
    const reaction = occupant.card.keywords?.onAllyFights;
    if (!reaction) return;
    const current = next.board[cell];
    const existing = current.statBonusUntilEndOfTurn || { strength: 0, lifespan: 0 };
    next = {
      ...next,
      board: {
        ...next.board,
        [cell]: { ...current, statBonusUntilEndOfTurn: { strength: existing.strength + reaction.strength, lifespan: existing.lifespan + reaction.lifespan } },
      },
    };
    next = addLog(next, `${current.card.name} triggers, gaining +${reaction.strength}/+${reaction.lifespan} until end of turn.`);
    if (reaction.lifespan > 0) {
      const buffed = next.board[cell];
      next = { ...next, board: { ...next.board, [cell]: { ...buffed, currentLifespan: buffed.currentLifespan + reaction.lifespan } } };
    }
  });
  return next;
};

// Return the Favor: "Until the end of the turn whenever a Being you
// control loses a Favored Counter a different Being becomes Favored." —
// fired from the ONLY place a Favor Counter is ever genuinely CONSUMED
// (MOVE_OR_ATTACK's own combat resolution, when attackerFavored/
// defenderFavored was true — RULES.md > Keywords > Favored), gated by the
// player-scoped flag the Conjuring itself sets (RETURN_THE_FAVOR_RE,
// above) rather than any card keyword. "a different Being" is
// unrestricted by ownership, same unqualified "target Being" scope
// Dendrify/SELF_STRENGTH_DEBUFF_TARGET_RE already use — and the grant
// itself is permanent (no "until end of turn" on the grant, only on the
// reaction's own active window).
const triggerReturnTheFavorReaction = (state, ownerId, consumedCellId) => {
  const owner = state.players[ownerId];
  if (!owner.returnTheFavorUntilEndOfTurn) return state;
  const candidates = Object.entries(state.board).filter(([cell, o]) => cell !== consumedCellId && o?.type === 'being');
  if (candidates.length === 0) {
    return addLog(state, `Return the Favor has no different Being to make Favored.`);
  }
  const applyFavor = (st, cellId) => {
    const occ = st.board[cellId];
    const next = { ...st, board: { ...st.board, [cellId]: { ...occ, favorCounter: true } } };
    return addLog(next, `Return the Favor makes ${occ.card.name} Favored.`);
  };
  if (candidates.length === 1) {
    return applyFavor(state, candidates[0][0]);
  }
  let next = addLog(state, `Return the Favor lets ${ownerId} choose a different Being to make Favored.`);
  return { ...next, pendingChoice: { kind: 'return-the-favor-target', playerId: ownerId, cardName: 'Return the Favor', excludeCell: consumedCellId } };
};

const placeBeingOnBoard = (state, playerId, cellId, card) => {
  const waiting = state.board[cellId];
  // Lesser Summoning Circle: "...Summon a Demon, Imp or Null Being
  // directly on this tile, when you do sacrifice Lesser Summoning
  // Circles." — the only case `waiting` is something OTHER than an
  // armament-stack pile (a real Relic, still sitting there). Overwriting
  // it here IS the sacrifice (same "just removed, no Purgatory" precedent
  // every other non-Being sacrifice-as-a-cost already follows —
  // sacrificeOccupantAt above) — no armaments to carry over from it.
  const pickingUpArmaments = waiting?.type === 'armament-stack';
  // Boknea Druid: "Dryad. This may be summoned directly onto another
  // TreeFolk, Vine, or Seed." — ruled: summoning it onto an eligible own
  // Being triggers the same Dryad-attach a move onto one would, as an
  // extra legal summon destination (see SUMMON_BEING's own legality
  // check, which is what actually offers this tile at all). Checked
  // before the Lesser-Summoning-Circle-style "sacrifice whatever's
  // there" fallback below, so a Dryad-eligible Being under it is
  // attached onto, not destroyed.
  const attachingDryad = dryadAttachTargetOk(waiting, playerId, card);
  // Horological Horror: "(X) is equal to the total number of Time Counters
  // you control" — a characteristic-defining Strength/Lifespan. This is
  // only the INITIAL snapshot (both fields start equal, matching a fresh
  // Being's usual "no damage taken yet" state) — recomputeXBeings above
  // keeps it live for the rest of this Being's time on the board, applying
  // only the CHANGE in the live total on each future recompute rather than
  // re-snapshotting outright, so real damage taken persists across it.
  const xValue = card.keywords?.xEqualsTimeCountersControlled ? totalTimeCountersControlledBy(state, playerId) : null;
  let next = {
    ...state,
    board: {
      ...state.board,
      [cellId]: {
        type: 'being',
        ownerId: playerId,
        card,
        currentLifespan: xValue != null ? xValue : card.lifespan,
        // Deities, Persist Beings, and "Relic, Being"s (RULES.md > Card
        // types — Training dummy, Crumbling Sphinx) all enter ready instead
        // of summoning-sick — as does a Plant landing on a tile Tilled
        // Fields has flagged this turn (state.groundRelics[cellId].
        // plantsEnterDisengagedUntilEndOfTurn), since a ground Relic shares
        // its tile with whatever Being is summoned there.
        engaged: !card.isDeity && !card.keywords?.persist && !card.isRelicBeing
          && !(state.groundRelics[cellId]?.plantsEnterDisengagedUntilEndOfTurn && (card.typing || '').toLowerCase().includes('plant')),
        favorCounter: !!card.keywords?.favored,
        ...(xValue != null ? { strengthOverride: xValue } : {}),
        ...(pickingUpArmaments ? { armaments: waiting.armaments } : {}),
        ...(attachingDryad
          ? { dryadAttached: { card: waiting.card, currentLifespan: waiting.currentLifespan, engaged: waiting.engaged, ...(waiting.armaments ? { armaments: waiting.armaments } : {}), ...(waiting.dryadAttached ? { dryadAttached: waiting.dryadAttached } : {}) } }
          : {}),
      },
    },
  };
  const summonMsg = `${playerId} summons ${card.name} at ${cellId}.`;
  next = addLog(next, attachingDryad
    ? `${summonMsg} It attaches onto ${waiting.card.name} (Dryad).`
    : pickingUpArmaments
    ? `${summonMsg} It picks up the Armament(s) waiting there.`
    : waiting ? `${summonMsg} ${waiting.card?.name || 'The permanent there'} is sacrificed.` : summonMsg);
  next = applyNewArmamentsLifespanBonus(next, cellId, pickingUpArmaments ? waiting.armaments : []);
  if (attachingDryad) {
    next = applyDryadAttachLifespanBonus(next, cellId);
    next = triggerOnDryadAttachedOnto(next, playerId, cellId, waiting.card);
  }
  if (card.keywords?.gathersArmamentsOnSummon) {
    next = gatherArmamentsToTile(next, playerId, cellId, card.name);
  }
  next = moveAutoAttachArmaments(next, playerId, cellId);
  next = triggerTypedSummonReactions(next, playerId, cellId, card);
  next = triggerSacrificeSelfOnSummonTyping(next, playerId, cellId, card);
  // Skipped when an earlier reaction above already left its own
  // pendingChoice open — this engine only ever tracks one pendingChoice at
  // a time (no queueing), so enforcing the legend rule here would silently
  // clobber that still-unresolved choice. A vanishingly rare double-edge
  // case; the legend rule simply isn't checked that specific turn — a
  // known, documented gap rather than new multi-choice infrastructure.
  if (card.isDeity && !next.pendingChoice) {
    next = enforceDeityLegendRule(next, playerId, card.name);
  }
  // Medium Mage, Massive Mage, Quake Goliath, etc.: "When summoned... deal
  // (N) damage to target Being" — deferred behind a real pre-resolution
  // priority window (state.pendingResolution, resolved by
  // manageReactiveWindow below) instead of resolving inline here, so the
  // opponent gets a genuine chance to respond — e.g. cast One Above All to
  // make the target Favored — BEFORE the trigger's own effect applies,
  // not after. Confirmed with the user via the Medium Mage / One Above
  // All example. Every OTHER caller of placeBeingOnBoard (Martyr
  // reanimation, Invoke, tokens) gets the exact same deferred treatment
  // for free, matching RULES.md's own "fires exactly the same way a
  // normally-cast Being's would" precedent — no special-casing needed.
  //
  // Unlike the legend-rule check just above, this is NOT skipped when an
  // earlier reaction (Sporangium's own "When a Being with Dryad moves onto
  // this") already left a pendingChoice open — scheduling pendingResolution
  // here is purely additive (it never touches/clobbers pendingChoice
  // itself), so the two coexist safely: getLegalActions already resolves
  // whichever pendingChoice exists first (it short-circuits before ever
  // reaching a reactiveWindow offer), and only once that's resolved does
  // the reactive window this pendingResolution rides behind actually
  // become reachable — one extra dispatch later, not lost. Before this,
  // Jirahperā's own "you may summon (2) Vine tokens" was silently dropped
  // every time it landed on Sporangium specifically, since Sporangium's
  // own reaction always opens its own pendingChoice first.
  if (card.keywords?.whenSummoned) {
    const whenSummonedText = selfReferentialWhenSummonedText(card.keywords.whenSummoned, card.name);
    next = {
      ...next,
      pendingResolution: { kind: 'summon-being', declaringPlayer: playerId, cellId, cardName: card.name, whenSummonedText, instanceId: card.instanceId },
    };
  }
  return next;
};

// -- Invoke keyword ------------------------------------------------------
// RULES.md > Keywords > Invoke: "Add to hand, then summon/conjure" (Classic
// Familiar's own inline definition of the word, quoted verbatim from the
// real CSV — every other card printing Invoke uses the same meaning, just
// with its own search criteria and/or destination). Modeled as two small,
// reusable primitives rather than one per card: invokeCandidates (the
// search half, layering on top of the existing searchZoneCandidates a
// player already has for plain "Add X to hand" effects) and invokeCardOnto
// (the placement half).

// Finds Invoke's own legal candidates in `playerId`'s deck: `query` is
// matched the same way any other deck search already is (exact name, or a
// typing substring — searchZoneCandidates), optionally narrowed further by
// `faithlessOnly` (Faithless Invocation's own "a Faithless Relic Card" —
// no colored casting cost at all, the same isFaithlessTypedCard check
// Temple of Dubiety already uses) and/or `maxCost` (the common "...with
// cost (N) or less" ceiling, several real cards print).
const invokeCandidates = (state, playerId, query, { faithlessOnly = false, maxCost = null } = {}) => {
  let candidates = searchZoneCandidates(state.players[playerId].mainDeck, query);
  if (faithlessOnly) candidates = candidates.filter(isFaithlessTypedCard);
  if (maxCost != null) candidates = candidates.filter(c => totalCastingCost(c) <= maxCost);
  return candidates;
};

// Places an Invoked `card` for real: removes it from `playerId`'s deck,
// then summons/conjures it by its own real kind — placeBeingOnBoard for a
// Being (so its own When Summoned/legend-rule handling fires exactly as if
// it had been cast from hand normally, not a stripped-down token
// placement) or placeTokenOnBoard's own Relic branch otherwise (identical
// shape to PLACE_RELIC's reducer, including armamentCounterGrant/
// beingsMayMoveAcross). No real card ever Invokes a Conjuring or an Altar
// today, so those kinds fall back to the same honest "isn't automated yet"
// log every other unrecognized shape gets, rather than guessing at what
// "conjure" would even mean for them here.
// `context.strengthOverride` (Midnight Mass: "Invoke a Demon with equal
// Strength...") writes a permanent strengthOverride (combat.js's
// effectiveStrength, same primitive Thespian/Horological Horror already
// use) onto the freshly-placed Being, right after it lands — never applies
// to a Relic destination, since Invoke's own Relic branch has no Strength
// to override in the first place.
const invokeCardOnto = (state, playerId, cardName, label, card, cellId, context = {}) => {
  const player = state.players[playerId];
  const deck = player.mainDeck.filter(c => c.instanceId !== card.instanceId);
  let next = { ...state, players: { ...state.players, [playerId]: { ...player, mainDeck: deck } } };
  next = addLog(next, `${cardName}'s ${label} invokes ${card.name}.`);
  if (card.kind === 'being') {
    next = placeBeingOnBoard(next, playerId, cellId, card);
    if (context.strengthOverride != null && next.board[cellId]) {
      next = { ...next, board: { ...next.board, [cellId]: { ...next.board[cellId], strengthOverride: context.strengthOverride } } };
    }
    return next;
  }
  if (card.kind === 'relic') return placeTokenOnBoard(next, playerId, card, cellId);
  return addLog(next, `${cardName}'s ${label} isn't automated yet for ${card.name} (Invoke only recognizes a Being or Relic destination).`);
};

// Resolves Invoke's destination half once a specific card is already
// settled (the sole search match, or whichever the player picked from
// invoke-card-choice) — shared so both paths land on the exact same
// placement logic. `destinationMode` 'pointed' resolves candidates from
// context.selfCellId's own arrows (the same "points to" geometry every
// other arrow-targeted effect this session already uses); 'default' is
// any empty Mortal Realm cell the player controls, the same fallback a
// plain "summon a token" with no named location uses.
const placeInvokedCard = (state, playerId, cardName, label, card, destinationMode, context) => {
  // `context.selfArrows`, when present (SACRIFICE_THIS_THEN_RE's own
  // capture), takes priority over a live board read — the caster may
  // already be gone from the board by the time this runs (Kernel/Samara
  // Seed both sacrifice themselves as part of the same cost that leads
  // here), same fallback order SUMMON_TOKEN_POINTED_RE's own resolver uses.
  const selfArrows = context.selfArrows || state.board[context.selfCellId]?.card?.arrows || [];
  // Samara Seed / Kernel: "Invoke a TreeFolk...on a tile this points to" —
  // when the invoked card itself has Dryad (Jirahperā, Boknean Druid), a
  // tile occupied by an eligible plant (TreeFolk/Vine/Seed) is ALSO a
  // legal destination, per the same dryadAttachTargetOk rule
  // placeBeingOnBoard's own SUMMON_BEING-time check already applies — the
  // gap was here, one level up: this filter never offered that tile as a
  // candidate at all, so placeBeingOnBoard's already-correct attach logic
  // never got a chance to run. Ruled directly analogous to Boknean Druid's
  // own "may be summoned directly onto..." — confirmed with the user
  // ("Samara Seed should allow a Jirahperā to be summoned onto an
  // Elderflower Ancient, assuming Samara Seed points to it").
  const candidates = destinationMode === 'pointed'
    ? [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, context.selfCellId, dir)))]
      .filter(c => c && !state.groundRelics[c] && (!state.board[c] || dryadAttachTargetOk(state.board[c], playerId, card)))
    : emptyMortalCellsFor(state.board, playerId);
  if (candidates.length === 0) {
    return addLog(state, `${cardName}'s ${label} has no empty tile to invoke ${card.name} onto.`);
  }
  if (candidates.length === 1) {
    return invokeCardOnto(state, playerId, cardName, label, card, candidates[0], context);
  }
  let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a tile to invoke ${card.name} onto.`);
  return { ...next, pendingChoice: { kind: 'invoke-destination', playerId, cardName, label, cardInstanceId: card.instanceId, allowedCells: candidates, context } };
};

// Resolves the whole Invoke effect from a freshly computed set of deck
// candidates — opens invoke-card-choice first if more than one real card
// matches the search (they aren't fungible, unlike duplicate copies of the
// exact same card, so which one is a real choice), otherwise goes straight
// to placeInvokedCard for the sole match.
const resolveInvoke = (state, playerId, cardName, label, query, candidates, destinationMode, context) => {
  if (candidates.length === 0) {
    return addLog(state, `${cardName}'s ${label} finds no "${query}" in ${playerId}'s deck to invoke.`);
  }
  if (candidates.length === 1) {
    return placeInvokedCard(state, playerId, cardName, label, candidates[0], destinationMode, context);
  }
  let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose which "${query}" to invoke.`);
  return {
    ...next,
    pendingChoice: {
      kind: 'invoke-card-choice', playerId, cardName, label, query,
      candidateInstanceIds: candidates.map(c => c.instanceId), destinationMode, context,
    },
  };
};

// The "legendary rule" (MTG term, unprinted here but confirmed as the
// intended ruling): a player may control at most one Deity of any given
// name at a time. The moment a second same-named Deity would join a side
// (any path through placeBeingOnBoard — a fresh summon, a Purgatory
// reanimation, etc.), the controller must choose which single copy to
// keep; every other same-named copy is sacrificed (destroyBeing — no
// owner Lifespan loss, still Purgatory+Depart, same as any other
// rules-forced sacrifice). Always prompts, even for the obvious
// exactly-2 case, since keeping the older, possibly-buffed/damaged copy
// over the fresh one is a real, meaningful choice, not something to
// auto-resolve.
const enforceDeityLegendRule = (state, playerId, deityName) => {
  const candidates = Object.entries(state.board)
    .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId && o.card.isDeity && o.card.name === deityName);
  if (candidates.length <= 1) return state;
  let next = addLog(state, `${playerId} controls more than one ${deityName} — choose which one to keep (the rest are sacrificed).`);
  return { ...next, pendingChoice: { kind: 'legend-rule-keep', playerId, cardName: deityName, deityName } };
};

// Summons a specific Being `found` (still sitting in `playerId`'s
// Purgatory) onto whichever empty Mortal Realm tile is available — no
// "on this tile" wording, unlike Grave robber's Martyr
// (SUMMON_FROM_PURGATORY_RE), so unlike that fixed-cellId flow this picks
// the destination itself: straight to placeBeingOnBoard with 1 legal tile,
// a 'token-location' pendingChoice (reused via its purgatoryInstanceId
// payload — see RESOLVE_TOKEN_LOCATION) with more than 1, or a graceful log
// with none — the card stays in Purgatory either way until it's actually
// placed. Backs Cemetery Physician's own variable-X sacrifice ability.
const summonFromPurgatoryToOpenCell = (state, playerId, cardName, found) => {
  if (!found) return addLog(state, `${cardName} finds no matching Being in ${playerId}'s Purgatory to summon.`);
  const emptyCells = emptyMortalCellsFor(state.board, playerId);
  if (emptyCells.length === 0) {
    return addLog(state, `${cardName} has no empty tile of ${playerId}'s to summon ${found.name} on.`);
  }
  if (emptyCells.length > 1) {
    let next = addLog(state, `${cardName} lets ${playerId} choose a tile to summon ${found.name} on.`);
    return { ...next, pendingChoice: { kind: 'token-location', playerId, cardName, purgatoryInstanceId: found.instanceId } };
  }
  const purged = {
    ...state,
    players: {
      ...state.players,
      [playerId]: { ...state.players[playerId], purgatory: state.players[playerId].purgatory.filter(c => c.instanceId !== found.instanceId) },
    },
  };
  let next = addLog(purged, `${playerId} summons ${found.name} from Purgatory (${cardName}).`);
  return placeBeingOnBoard(next, playerId, emptyCells[0], found);
};

// Relocates a Being to an empty/own-pile cell without engaging it — used by
// an Armament-granted free move (e.g. "Feathers of the Fallen": "move
// attached Being one tile in any direction"), which is the Armament's own
// benefit, not the Being's own move action, so it shouldn't cost the Being
// its turn. Mirrors MOVE_OR_ATTACK's own reposition branch otherwise: any
// Armaments already carried move along, and a waiting pile at the
// destination is picked up (and its Lifespan bonus applied) the same way.
// Whether `occupant` can be the mover for a free-move effect ("Remove (1)
// Crossing Counter, then move attached Being one tile in any direction" —
// Feathers of the Fallen) — a real Being, or an Animated Armament acting as
// one (RULES.md > Keywords > Animated), same "acts as a Being" scope used
// throughout (e.g. MOVE_OR_ATTACK's own attacker check).
const freeMoveEligible = (occupant) => occupant?.type === 'being' || !!animatedTopEntry(occupant);

// "Each time this moves, X" (Hoarder) — a Being's own reaction to any move
// of itself, whether self-initiated (MOVE_OR_ATTACK's own move branch) or
// caused by another card's effect (moveBeingFreely below — Shifting
// Sands, Spirit Guide's own Depart, Echo chamber, etc.). Shared by every
// move-application site so it fires identically no matter which one moved
// it — Reveler's own "Can not move" / "Whenever this moves..." pairing
// (confirmed with the user as intentionally contradictory) specifically
// depends on this: its own move is blocked by cannotMove, but an
// externally-caused one still reaches here and triggers the reaction.
const triggerOnMoveReaction = (state, playerId, toCellId, fromCellId, card) => {
  let next = state;
  // Afterimage: "Whenever target Being moves this turn, summon an
  // Afterimage token on the tile it moved from." — a temporary "watch"
  // flag (afterimageWatchOwnerId, resolveOrLogEffect above), independent
  // of the mover's own printed onMove keyword below, so both can fire off
  // the same move. The token's owner is whoever cast Afterimage (the
  // flag's own value), not necessarily the mover's own controller.
  // fromCellId is always empty here (this exact move just vacated it), so
  // no occupancy check is needed before placing — same "always lands"
  // precedent every other "summon on the tile it moved from" token
  // (Hoarder's own Rat) already relies on.
  const watchOwnerId = next.board[toCellId]?.afterimageWatchOwnerId;
  if (watchOwnerId) {
    const token = TOKEN_REGISTRY['afterimage']();
    next = placeTokenOnBoard(next, watchOwnerId, token, fromCellId);
    next = { ...next, board: { ...next.board, [fromCellId]: { ...next.board[fromCellId], counters: { time: 2 } } } };
    next = addLog(next, `${card?.name || 'The move'} creates an Afterimage token at ${fromCellId} for ${watchOwnerId}.`);
  }
  if (!card?.keywords?.onMove) return next;
  next = addLog(next, `${card.name}'s move triggers.`);
  // Same self-name-substitution precedent whenSummoned's own trigger point
  // already applies (selfReferentialWhenSummonedText, despite the name, is
  // generic over any text) — a card phrased "When <OwnName> moves, X" can
  // have its own name inside X too, not just in the trigger phrase itself.
  const onMoveText = selfReferentialWhenSummonedText(card.keywords.onMove, card.name);
  return resolveOrLogEffect(next, playerId, card.name, onMoveText, 'Move', {
    selfCellId: toCellId, movedFromCellId: fromCellId,
  });
};

// Exported so turn.js can reuse it for Minute-taur's own forced
// start/end-of-turn moves (applyForcedDirectionalMoves) — the same
// "reposition, no Engage/tap change, still fires onMove reactions" shape
// every other free-move effect already gets.
export const moveBeingFreely = (state, fromCellId, toCellId) => {
  const occupant = state.board[fromCellId];
  const waiting = state.board[toCellId];
  const board = { ...state.board };
  delete board[fromCellId];
  const carriedArmaments = [...(occupant.armaments || []), ...(waiting?.armaments || [])];
  board[toCellId] = { ...occupant, ...(carriedArmaments.length > 0 ? { armaments: carriedArmaments } : {}) };
  // A real Being carries its own top-level `card`; an Animated Armament
  // acting as one (occupant.type === 'armament-stack') doesn't — its name
  // is on its topmost entry instead.
  const actingCard = occupant.card || occupant.armaments[occupant.armaments.length - 1].card;
  let next = addLog({ ...state, board }, `${actingCard.name} is moved to ${toCellId}.`);
  next = applyNewArmamentsLifespanBonus(next, toCellId, waiting?.armaments || []);
  return triggerOnMoveReaction(next, occupant.ownerId, toCellId, fromCellId, actingCard);
};

// A destination is legal for a free move either because it's empty/holds
// only the mover's own Armaments (the ordinary case — same rule
// MOVE_OR_ATTACK's own repositioning uses), or, for a "moves to a tile
// with an Armament on it" effect (Prepare for Battle), only because it's
// specifically a freestanding Armament pile — an otherwise-empty tile does
// NOT count there.
const freeMoveDestinationOk = (state, playerId, cellId, destinationFilter) =>
  (destinationFilter === 'armament'
    ? state.board[cellId]?.type === 'armament-stack'
    : emptyOrOwnArmamentStack(state.board[cellId], playerId));

// Continues a move sequence's own `then` continuation once the preceding
// move has fully resolved — either Echo chamber's own "move a THEN-
// selected Being" shape (`{ownerFilter, destinationFilter}`, via
// startMoveSequence's fresh candidate search) or Acrobatic Escape's own
// "move it, then move it AGAIN" shape (`{sameActor: true,
// destinationFilter}` — the SAME Being that just moved, from wherever it
// just ended up, via moveOrOfferFreeMove directly rather than re-searching
// for a source).
const continueMoveThen = (state, playerId, cardName, label, then, movedToCellId) => {
  if (!then) return state;
  return then.sameActor
    ? moveOrOfferFreeMove(state, playerId, cardName, label, movedToCellId, then.destinationFilter)
    : startMoveSequence(state, playerId, cardName, label, then.ownerFilter, then.destinationFilter);
};

// Shared by any effect that lets a specific Being move freely (no engage,
// no attack) once it's already been identified — auto-resolves with a
// single legal destination, otherwise opens the 'free-move' pendingChoice
// (same one SELF_MOVE_WITHOUT_ENGAGING_RE and ARMAMENT_COUNTER_MOVE_RE use
// inline for their own single-purpose free moves). `then` is a second move
// to start once THIS one fully completes (see continueMoveThen above) —
// needed because the generic "X, then Y" split at the top of
// resolveOrLogEffect runs Y immediately after X *returns*, even if X only
// opened a pendingChoice rather than finishing outright; threading an
// explicit continuation here instead means Y truly waits for X to resolve.
const moveOrOfferFreeMove = (state, playerId, cardName, label, fromCellId, destinationFilter = 'any', then = null) => {
  const occupant = state.board[fromCellId];
  // continueMoveThen's `sameActor` path (Acrobatic Escape: "move it, then
  // move it again") re-enters this function at the Being's own NEW cell,
  // assuming it's still there — but moveBeingFreely (for the FIRST move)
  // already fired triggerOnMoveReaction before returning, and that
  // reaction can itself be another "when this moves, move it again" effect
  // that moved (or otherwise removed) the same Being a second time before
  // this explicit continuation ever runs. Same graceful degrade as the "no
  // legal destination" case just below, minus the log line (no card left
  // to name) — self-play found the un-guarded version a real, reachable
  // crash (`occupant` undefined here).
  if (!occupant) return continueMoveThen(state, playerId, cardName, label, then, fromCellId);
  // A real Being carries its own top-level `card`; an Animated Armament
  // acting as one doesn't (moveBeingFreely, just above, already handles
  // this same shape) — reachable here too via the same sameActor
  // continuation, when the first move's destination is itself an
  // armament-stack rather than a plain Being.
  const actingCard = occupant.card || occupant.armaments[occupant.armaments.length - 1].card;
  const candidates = [...new Set([1, 2, 3, 4, 5, 6, 7, 8].map(dir => computeMoveDestination(playerId, fromCellId, dir)))]
    .filter(c => c && freeMoveDestinationOk(state, playerId, c, destinationFilter));
  if (candidates.length === 0) {
    const next = addLog(state, `${cardName}'s ${label} has nowhere for ${actingCard.name} to move.`);
    return continueMoveThen(next, playerId, cardName, label, then, fromCellId);
  }
  if (candidates.length === 1) {
    const next = moveBeingFreely(state, fromCellId, candidates[0]);
    return continueMoveThen(next, playerId, cardName, label, then, candidates[0]);
  }
  const next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose where ${actingCard.name} moves.`);
  return { ...next, pendingChoice: { kind: 'free-move', playerId, cardName, label, fromCellId, destinationFilter, then } };
};

// Engages a Being (the cost) and applies its "+S/+L until end of turn"
// bonus (Boknean Wine) in one step — a positive Lifespan half heals
// immediately, same precedent as a positive Armament Lifespan bonus
// (applyNewArmamentsLifespanBonus); the Strength half is read live by
// combat.js's effectiveStrength and both are cleared together by endTurn.
const applyEngageStatBuff = (state, cellId, strengthBonus, lifespanBonus, playerId, cardName, label) => {
  const occupant = state.board[cellId];
  let next = {
    ...state,
    board: { ...state.board, [cellId]: { ...occupant, engaged: true, statBonusUntilEndOfTurn: { strength: strengthBonus, lifespan: lifespanBonus } } },
  };
  const sign = (n) => (n >= 0 ? `+${n}` : `${n}`);
  next = addLog(next, `${playerId} engages ${occupant.card.name} for ${cardName}'s ${label} (${sign(strengthBonus)}/${sign(lifespanBonus)} until end of turn).`);
  if (lifespanBonus > 0) {
    const buffed = next.board[cellId];
    next = { ...next, board: { ...next.board, [cellId]: { ...buffed, currentLifespan: buffed.currentLifespan + lifespanBonus } } };
  }
  return next;
};

// True when `o` (a board occupant) matches a "select a Being to move"
// choice's ownership scope: the caster's own ('own'), an opponent's
// ('opponent'), or either ('any' — the default when unspecified).
const moveSourceOwnerMatches = (o, ownerFilter, playerId) => {
  if (ownerFilter === 'own') return o.ownerId === playerId;
  if (ownerFilter === 'opponent') return o.ownerId !== playerId;
  return true;
};

// Finds every legal source Being for a "select a Being to move" choice
// (ownerFilter + at least one legal destination under destinationFilter)
// and either auto-resolves straight through moveOrOfferFreeMove (0 or 1
// candidate) or opens a 'select-move-source' pendingChoice. Entry point
// for both a fresh move effect and a `then`-continuation's second move.
const startMoveSequence = (state, playerId, cardName, label, ownerFilter, destinationFilter, then = null) => {
  const candidates = Object.entries(state.board).filter(([cell, o]) =>
    o?.type === 'being' && moveSourceOwnerMatches(o, ownerFilter, playerId)
    && hasFreeMoveDestination(state, playerId, cell, destinationFilter));
  if (candidates.length === 0) {
    const next = addLog(state, `${cardName}'s ${label} has no legal Being to move.`);
    return then ? startMoveSequence(next, playerId, cardName, label, then.ownerFilter, then.destinationFilter) : next;
  }
  if (candidates.length === 1) {
    return moveOrOfferFreeMove(state, playerId, cardName, label, candidates[0][0], destinationFilter, then);
  }
  const next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose a Being to move.`);
  return { ...next, pendingChoice: { kind: 'select-move-source', playerId, cardName, label, ownerFilter, destinationFilter, then } };
};

// Whether `cell` (any board occupant) has at least one legal free-move
// destination under `destinationFilter` — used to only ever offer a
// "select a Being to move" candidate that can actually go somewhere.
const hasFreeMoveDestination = (state, playerId, cell, destinationFilter) =>
  [1, 2, 3, 4, 5, 6, 7, 8].some(dir => {
    const c = computeMoveDestination(playerId, cell, dir);
    return c && freeMoveDestinationOk(state, playerId, c, destinationFilter);
  });

// Diablerie: "Each Player may move any number of Beings they control (in
// any direction), any Beings that move lose half their lifespan rounded
// up." — the "(1) tile in any direction" geometry (computeMoveDestination
// over all 8 directions) Divine Winds' own single move already uses,
// applied to any number of the ACTING player's own Beings in a row —
// never the same Being twice per side (movedInstanceIds), each move
// followed immediately by real damage (dealDamageToBeing — a normal
// death, unlike Equanimity's own "no death Lifespan loss" carve-out,
// since Diablerie's text has no such clause) equal to half the mover's
// own PRINTED Lifespan, rounded up (Math.ceil, same "rounded up"
// precedent SHUFFLE_HAND_DRAW_HALF_RE's own draw-count already uses).
// "Each Player" resolves the caster's own side to completion first, then
// hands off to the opponent's identical choice via `nextPlayerId` — a
// plain player id, not the generic `{ownerFilter, destinationFilter}`
// `then` shape moveOrOfferFreeMove's own callers use, since this needs a
// literal "switch whose turn it is to choose" continuation instead.
const diablerieOfferMover = (state, playerId, cardName, label, movedInstanceIds, nextPlayerId) => {
  const candidates = Object.entries(state.board).filter(([cell, o]) =>
    o?.type === 'being' && o.ownerId === playerId && !movedInstanceIds.includes(o.card.instanceId)
    && hasFreeMoveDestination(state, playerId, cell, 'any'));
  if (candidates.length === 0) {
    return nextPlayerId ? diablerieOfferMover(state, nextPlayerId, cardName, label, [], null) : state;
  }
  return { ...state, pendingChoice: { kind: 'diablerie-select-mover', playerId, cardName, label, movedInstanceIds, nextPlayerId } };
};

const diablerieMoveAndDamage = (state, playerId, cardName, label, fromCellId, toCellId, movedInstanceIds, nextPlayerId) => {
  const occupant = state.board[fromCellId];
  const damage = Math.ceil(occupant.card.lifespan / 2);
  let next = moveBeingFreely(state, fromCellId, toCellId);
  next = addLog(next, `${cardName}'s ${label} deals ${damage} Lifespan damage to ${occupant.card.name} (half its Lifespan, rounded up).`);
  next = dealDamageToBeing(next, toCellId, damage);
  if (next.phase === 'gameover') return next;
  return diablerieOfferMover(next, playerId, cardName, label, [...movedInstanceIds, occupant.card.instanceId], nextPlayerId);
};

const emptyPlayerState = (id, mainDeck, effigyDeck) => ({
  id,
  lifespan: STARTING_LIFESPAN,
  mainDeck: mainDeck.slice(STARTING_HAND_SIZE),
  hand: mainDeck.slice(0, STARTING_HAND_SIZE),
  purgatory: [],
  effigyDeck,
  effigyPool: [],
  effigySpentThisTurn: [],
  keptHand: false,
});

export const createInitialState = ({ mainDeckA, effigyDeckA, mainDeckB, effigyDeckB, startingPlayer }) => ({
  phase: 'mulligan',
  turnPlayer: startingPlayer,
  turnNumber: 1,
  winner: null,
  board: {},
  // A "Beings may move across this" Relic (Shifting Sands, Tilled Fields)
  // lives here instead of `board` — keyed by cellId, same shape as a normal
  // `type: 'relic'` board occupant (ownerId, card, optional counters,
  // optional engaged). Kept entirely separate from `board` rather than
  // trying to represent "a Being and a Relic on the same tile" as one
  // occupant, so every existing board-occupancy check (movement legality,
  // "does this lane block an attack", combat, rendering elsewhere) stays
  // correct with zero changes: a cell with only a groundRelic reads as
  // empty in `board`, exactly matching "Beings may move across this" and
  // "a Relic doesn't block an attack" — and the groundRelic itself is
  // simply never touched by any of that, matching "remains on its
  // starting tile even after a Being moves onto/across it".
  groundRelics: {},
  // Altars ("Land" permanents, RULES.md > Card types) live here instead of
  // `board` — a plain per-player list of `{ card }` entries, not tied to
  // any cellId at all. A player may control any number of Altars at once
  // (their "Craft (N) additional Effigy" bonuses simply stack — see
  // altarCraftBonus, turn.js), which doesn't fit the old "one reserved
  // Effigy Zone cell" model at all, so rather than trying to fan multiple
  // Altars out across board cells (there's no natural place for them —
  // they're not Mortal Realm permanents and don't interact with
  // movement/combat/targeting by board position), they're kept as their
  // own small pile, same minimal-blast-radius precedent as groundRelics
  // above: everything that reads `board` for occupancy/combat/movement is
  // completely unaffected, and the Effigy Zone cell goes back to always
  // showing the Effigy pool breakdown (Board.jsx) now that nothing but that
  // ever occupies it.
  altars: { A: [], B: [] },
  log: [{ turn: 0, player: null, message: `Coin flip: ${startingPlayer} goes first.` }],
  players: {
    A: emptyPlayerState('A', mainDeckA, effigyDeckA),
    B: emptyPlayerState('B', mainDeckB, effigyDeckB),
  },
  // Set while a card-text search effect ("Add X to hand from deck") is
  // waiting on the searching player to pick a candidate — see
  // resolveOrLogEffect / RESOLVE_CHOICE. Blocks all other actions for both
  // players until resolved, same as a mandatory tutor in most TCGs.
  pendingChoice: null,
  // Ethereal Conjuring reactive timing — see manageReactiveWindow, below.
  // `null | { openFor: playerId }`.
  reactiveWindow: null,
  // A declared-but-not-yet-applied effect riding behind reactiveWindow —
  // see resolvePendingResolution, below.
  pendingResolution: null,
});

// -- Effigy cost payment ----------------------------------------------------

// Effigial Conservator: "Target Effigy that you control Engages, then add
// (1) Essence of its typing." — an Engaged Effigy pool entry is protected
// from being spent on any cost while it stays Engaged (same "an engaged
// permanent can't act" idea as a board occupant, just applied to a pool
// pip instead). Every cost function below reads the pool through this one
// choke point instead of the raw array, so no individual cost-paying call
// site anywhere else needs touching.
//
// Temporary Essence (makeTemporaryEssence — a Zealot's own "Add" grant, or
// any other "...Essence usable this turn" effect) expires at end of turn
// regardless of whether it's spent, so it should always be prioritized
// over a real Effigy that would otherwise persist into future turns — a
// player would rather burn value they were about to lose anyway than
// spend a permanent resource unnecessarily. Sort is stable (guaranteed by
// the JS spec), so relative order within each group — temporary entries
// among themselves, real Effigies among themselves — stays exactly the
// "pool order" every payment function already relied on before this.
const payablePool = (pool) => pool.filter(e => !e.engaged)
  .sort((a, b) => (b.temporary ? 1 : 0) - (a.temporary ? 1 : 0));

// Marks one Effigy pool pip Engaged and grants a temporary Essence of its
// own color — see TARGET_EFFIGY_ENGAGE_ADD_ESSENCE_RE above. The Engaged
// mark itself isn't temporary (it clears at the normal Disengage Step,
// turn.js — see disengage there), only the granted Essence is.
const engageEffigyAddEssence = (state, playerId, cardName, label, instanceId, amount) => {
  const player = state.players[playerId];
  const target = player.effigyPool.find(e => e.instanceId === instanceId);
  if (!target) return state;
  const pool = player.effigyPool.map(e => (e.instanceId === instanceId ? { ...e, engaged: true } : e));
  const granted = makeTemporaryEssence(target.effigyType, amount);
  const next = {
    ...state,
    players: { ...state.players, [playerId]: { ...player, effigyPool: [...pool, ...granted] } },
  };
  return addLog(next, `${cardName}'s ${label} Engages a ${target.effigyType} Effigy and adds ${amount} ${target.effigyType} Essence to ${playerId}'s pool until end of turn.`);
};

export const canPayCost = (pool, castingCost) => {
  const remaining = payablePool(pool);
  for (const [color, count] of Object.entries(castingCost.colored)) {
    for (let i = 0; i < count; i++) {
      const idx = remaining.findIndex(e => e.effigyType === color);
      if (idx === -1) return false;
      remaining.splice(idx, 1);
    }
  }
  return remaining.length >= castingCost.faithless;
};

// `faithlessInstanceIds`, when given, is the player's own explicit choice
// of which Effigies fund the Faithless (generic) portion of the cost — see
// faithlessPaymentNeedsChoice below, which Match.jsx uses to decide
// whether to ask at all. Colored pips are always paid automatically first
// (never ambiguous — each pip only accepts its own printed color), exactly
// as before; only the Faithless slots ever have a real choice. Falls back
// to the original "first N left in pool order" pick when no explicit
// selection is given (every caller that doesn't offer a choice — the AI,
// and any not-yet-updated path — keeps working unchanged).
const payCost = (pool, castingCost, faithlessInstanceIds = null) => {
  const remaining = payablePool(pool);
  const spent = [];
  Object.entries(castingCost.colored).forEach(([color, count]) => {
    for (let i = 0; i < count; i++) {
      const idx = remaining.findIndex(e => e.effigyType === color);
      spent.push(remaining.splice(idx, 1)[0]);
    }
  });
  if (faithlessInstanceIds) {
    faithlessInstanceIds.forEach(id => {
      const idx = remaining.findIndex(e => e.instanceId === id);
      if (idx !== -1) spent.push(remaining.splice(idx, 1)[0]);
    });
  } else {
    for (let i = 0; i < castingCost.faithless; i++) {
      spent.push(remaining.splice(0, 1)[0]);
    }
  }
  return { remaining, spent };
};

// Whether paying `castingCost.faithless` out of `pool` (after the colored
// pips are set aside) is actually a real choice — more than one distinct
// Effigy color would be left over AFTER paying, meaning the player is
// genuinely choosing which color(s) to keep versus spend. If everything
// left has to be spent anyway (remaining.length <= faithless), or only one
// color is present at all, there's nothing to ask — Match.jsx uses this to
// decide whether to show its payment picker or just dispatch immediately.
export const faithlessPaymentNeedsChoice = (pool, castingCost) => {
  if (!castingCost.faithless) return false;
  const remaining = payablePool(pool);
  Object.entries(castingCost.colored || {}).forEach(([color, count]) => {
    for (let i = 0; i < count; i++) {
      const idx = remaining.findIndex(e => e.effigyType === color);
      if (idx !== -1) remaining.splice(idx, 1);
    }
  });
  if (remaining.length <= castingCost.faithless) return false;
  return new Set(remaining.map(e => e.effigyType)).size > 1;
};

// The candidate pool Match.jsx's payment picker offers for the Faithless
// portion — the same "pool minus colored pips" remainder
// faithlessPaymentNeedsChoice itself computes, exposed so the UI never has
// to reimplement (and risk drifting from) that same colored-pips-first
// subtraction.
export const faithlessPaymentCandidates = (pool, castingCost) => {
  const remaining = payablePool(pool);
  Object.entries(castingCost.colored || {}).forEach(([color, count]) => {
    for (let i = 0; i < count; i++) {
      const idx = remaining.findIndex(e => e.effigyType === color);
      if (idx !== -1) remaining.splice(idx, 1);
    }
  });
  return remaining;
};

// Validates a player-chosen explicit Faithless-payment selection against
// the pool and cost — used by every cost-paying reducer case below so a
// malformed or stale explicit selection (e.g. an Effigy already spent by
// some other action first) safely falls back to the automatic pick
// instead of silently underpaying.
const validFaithlessSelection = (pool, cost, ids) =>
  Array.isArray(ids) && ids.length === cost.faithless && new Set(ids).size === ids.length
  && ids.every(id => payablePool(pool).some(e => e.instanceId === id));

// Deja Vu: "Return target Being that you control with cost (X) to your
// hand, then Summon it without paying its summoning cost. Pay (2)
// additional Timeless Essence to target a Deity." Per the user's own
// ruling, the (X) in Deja Vu's own printed cost ("X, 2 Timeless") IS the
// target's own totalCastingCost, read back at cast time — not a separate
// filter number. `baseCost` is Deja Vu's own static castingCost object
// (its xCostColor field says which slot the X pip was printed in — '' for
// generic/faithless, a color name otherwise); `deitySurcharge` is the
// card's own { amount, color } line, applied on top only when the chosen
// target is a Deity (also what makes a Deity a legal target at all, per
// RULES.md's established "target Being" precedent excluding Deities).
const dejaVuCombinedCost = (baseCost, deitySurcharge, targetCard, isDeity) => {
  const xAmount = totalCastingCost(targetCard);
  const colored = { ...baseCost.colored };
  let faithless = baseCost.faithless;
  if (baseCost.xCostColor) {
    colored[baseCost.xCostColor] = (colored[baseCost.xCostColor] || 0) + xAmount;
  } else {
    faithless += xAmount;
  }
  if (isDeity && deitySurcharge) {
    colored[deitySurcharge.color] = (colored[deitySurcharge.color] || 0) + deitySurcharge.amount;
  }
  return { faithless, colored };
};

// Deja Vu's own legal-target set — the user's own ruling that "a cast
// widening midway through" means only targets the player could actually
// afford the COMBINED cost for get offered/highlighted at all, not just
// checked after the fact. Used both to gate ever offering CAST_CONJURING
// for this card (same graceful non-offer precedent as every other
// additional-cost gate above) and, unchanged, as the pendingChoice's own
// frozen candidate list.
const dejaVuCandidates = (state, playerId, card) => {
  const deitySurcharge = card.keywords?.dejaVuDeitySurcharge || null;
  const pool = state.players[playerId].effigyPool;
  return Object.entries(state.board)
    .filter(([, o]) => {
      if (!o || o.type !== 'being' || o.ownerId !== playerId) return false;
      const combinedCost = dejaVuCombinedCost(card.castingCost, deitySurcharge, o.card, !!o.card.isDeity);
      return canPayCost(pool, combinedCost);
    })
    .map(([cell]) => cell);
};

// Every additional-cost/target-availability gate a Conjuring or Ethereal
// Conjuring's own cast can carry, beyond plain affordability (Strike Down's
// attackPendingBlockingCell, Desperate Finale's hasAffordableEngagedTarget, Deja
// Vu's own candidate search, "Shuffle (N) <X>s..."'s fixed-count Purgatory
// search) — shared by both getLegalActions' main-phase offer AND its
// reactiveWindow offer (offerReactiveEngageActions/the reactiveWindow
// branch just above it in getLegalActions itself cast this same net for
// Engage; CAST_CONJURING's own reactive offer used to only check
// affordability, never these, so a card whose gate failed (no attacker
// available, no Deja Vu target, ...) stayed offered — and, critically, once
// dispatched it was a real state-changing action reaching a real
// REACTIVE_RESPONSE_ACTION_TYPES entry as far as manageReactiveWindow was
// concerned, so it kept flipping the reactive window back and forth
// forever between the two players even though the reducer silently no-oped
// every single cast (self-play found this as an infinite CAST_CONJURING
// ping-pong — Strike Down/Deja Vu repeatedly "cast" but never actually
// leaving hand).
const conjuringCastGateOk = (state, playerId, card) => {
  // Strike Down: legal specifically during a real, currently-open attack-
  // declaration window with an actual Being still there to destroy — not
  // "any time playerId has an unengaged front-row Being," now that the
  // real window this card was always waiting for exists. `playerId` here
  // is deliberately unused for this gate — either player may cast it
  // against the same blocking cell (confirmed with the user).
  if (STRIKE_DOWN_RE.test(stripFlavorText(card.textBox) || '')) {
    const blockingCell = attackPendingBlockingCell(state);
    if (!blockingCell || state.board[blockingCell]?.type !== 'being') return false;
  }
  if (card.keywords?.conjureCost && LIFESPAN_EQUAL_TARGET_ENGAGED_RE.test(card.keywords.conjureCost)
    && !hasAffordableEngagedTarget(state.board, state.players, playerId)) return false;
  if (card.keywords?.dejaVu && dejaVuCandidates(state, playerId, card).length === 0) return false;
  const shuffleFixedNGate = stripFlavorText(card.textBox || '').match(SHUFFLE_FIXED_N_FROM_PURGATORY_RE);
  if (shuffleFixedNGate) {
    const needed = parseInt(shuffleFixedNGate[1], 10);
    const query = shuffleFixedNGate[2].trim();
    if (searchZoneCandidates(state.players[playerId].purgatory, query).length < needed) return false;
  }
  return true;
};

// How many permanents named `name` (case-insensitive) `playerId` controls,
// anywhere on the board — a Being/Relic occupant's own card, or any
// Armament entry attached to one, including a freestanding pile. Backs
// "Costs (-N) <Color> for each <Name> you control" below; scans the whole
// board the same way gatherArmamentsToTile/controlsOnlyFaithlessPermanents
// already do, rather than assuming the named permanent is always a
// particular occupant type (Bag o' Bones happens to be a Relic today, but
// nothing here hardcodes that). Altars live off-board entirely (see
// createInitialState's own comment on `altars`) and no printed card
// currently names one in this pattern, so this doesn't scan `state.altars`.
const countControlledByName = (board, playerId, name) => {
  const needle = name.toLowerCase();
  let count = 0;
  Object.values(board).forEach(occupant => {
    if (!occupant || occupant.ownerId !== playerId) return;
    if (occupant.card?.name.toLowerCase() === needle) count++;
    (occupant.armaments || []).forEach(a => {
      if (a.card.name.toLowerCase() === needle) count++;
    });
  });
  return count;
};

// "Costs (-N) <Color> for each <Name> you control" (Skeletal Colossus) — a
// static cost modifier checked fresh at the point of casting/summoning
// (getLegalActions' own affordability check, and again in SUMMON_BEING
// itself), never stored anywhere, so it always reflects the current board.
// Reduction never drops a component below 0. `color` is either
// `'faithless'` or one of `castingCost.colored`'s own keys. `name` is
// usually a real card name counted via countControlledByName, but
// "Time Counter" is special-cased (Singularity: "for each Time Counter
// that you control") to instead sum every Time Counter the player
// controls via totalTimeCountersControlledBy — a running total across
// many permanents, not a count of occurrences of one named card.
// Reduces one component of a casting cost by `amount`, never below 0 —
// shared by costReduction's own per-permanent scaling and Simple
// Summoner's flat one-shot "next Being" discount below.
const applyCostReduction = (cost, color, amount) => {
  if (amount <= 0) return cost;
  if (color === 'faithless') {
    return { ...cost, faithless: Math.max(0, cost.faithless - amount) };
  }
  const current = cost.colored?.[color] || 0;
  return { ...cost, colored: { ...cost.colored, [color]: Math.max(0, current - amount) } };
};

// Exported so Match.jsx's own Faithless-payment picker (faithlessPayment
// NeedsChoice/Candidates above) can compute the same real, reduction-
// applied cost the reducer is about to charge, rather than the raw printed
// one — a card with an active costReduction/nextBeingCostReduction might
// have fewer Faithless left to choose payment for than its printed cost
// suggests.
// Appease the Masses: "All cards cost (-1) Faithless." — live off a
// face-up Prophecy `playerId` controls that's still holding Time Counters,
// same source every other board-wide aura in this file already reads from
// (recomputeBoardWideAuraBonuses's own Growth Spurt precedent, just for a
// cost reduction instead of a stat bonus).
const activeAllCardsCostReduction = (board, playerId) => {
  const source = Object.values(board).find(o =>
    o?.type === 'prophecy' && o.ownerId === playerId && !o.faceDown && (o.timer || 0) > 0 && o.card.keywords?.allCardsCostReduction
  );
  return source ? source.card.keywords.allCardsCostReduction : null;
};

export const effectiveCastingCost = (card, state, playerId) => {
  let cost = card.castingCost;
  const reduction = card.keywords?.costReduction;
  if (reduction) {
    const count = reduction.name.toLowerCase() === 'time counter'
      ? totalTimeCountersControlledBy(state, playerId)
      : countControlledByName(state.board, playerId, reduction.name);
    cost = applyCostReduction(cost, reduction.color, reduction.amount * count);
  }
  const allReduction = activeAllCardsCostReduction(state.board, playerId);
  if (allReduction) {
    cost = applyCostReduction(cost, allReduction.color, allReduction.amount);
  }
  // Simple Summoner: "Your next Being this turn costs (-1) Formless to
  // Summon." — a one-shot flag on `state` itself (consumed by SUMMON_BEING
  // once it actually places a Being, not here — this is also called by
  // getLegalActions' own affordability check, which must never mutate
  // state), applied on top of any printed costReduction above. Scoped to
  // `card.kind === 'being'` specifically — a Deity is a distinct kind in
  // this engine, not "a Being" for this purpose. A list, not a single
  // slot, so engaging Simple Summoner more than once this turn stacks
  // (user ruling) instead of a second activation overwriting the first.
  (state.nextBeingCostReduction || []).forEach(({ color, amount }) => {
    if (card.kind === 'being') cost = applyCostReduction(cost, color, amount);
  });
  // Metal Worker: "The next Relic you summon this turn costs (-2)
  // Faithless." — same one-shot-flag shape as Simple Summoner's own
  // nextBeingCostReduction above, just scoped to card.kind === 'relic'
  // instead (confirmed with the user: identical mechanic, Relic in place
  // of Being).
  if (state.nextRelicCostReduction && card.kind === 'relic') {
    cost = applyCostReduction(cost, state.nextRelicCostReduction.color, state.nextRelicCostReduction.amount);
  }
  return cost;
};

// -- Legal action enumeration ------------------------------------------------

// The Engage-only subset of getLegalActions' own board-occupant scan below —
// a Being's own/granted Engage (including a multi-ability card like
// Osteomancer), a plain board Relic's Engage, a ground Relic's Engage
// (Shifting Sands), and an Armament's own independent Engage — with none of
// the move/attack/Martyr/Shift offers those same loops also make. Used by
// getLegalActions' reactiveWindow branch so an Engage ability can be
// activated "at ethereal speed" (reactively, during an open priority
// window) without also re-running the full turn-player action scan (hand
// affordability, moves, attacks, ...), which is both wasted work and, for
// occupants a reactive scenario never needed to shape correctly before,
// a real crash risk (e.g. a hand card with no real castingCost). Kept as
// its own small, explicitly-duplicated scan rather than refactoring the
// main loops below to share it — safer than risking the already-tested
// main-phase path for this.
const offerReactiveEngageActions = (state, playerId, actions) => {
  const player = state.players[playerId];

  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (occupant?.type === 'being' && occupant.ownerId === playerId && !occupant.engaged) {
      const ownAbilities = occupant.card.keywords?.engageAbilities || [];
      if (ownAbilities.length > 1) {
        ownAbilities.forEach((ability, abilityIndex) => {
          const conditionOk = engageConditionMet(ability.condition, state.board, playerId, state.altars[playerId], state.groundRelics);
          const costOk = player.lifespan - (ability.lifespanCost || 0) > 0;
          const extraCostOk = engageExtraCostSacrificeCell(ability.extraCost, state.board, playerId).payable;
          if (conditionOk && costOk && extraCostOk) {
            actions.push({ type: 'ACTIVATE_ENGAGE', cellId: cell, abilityIndex });
          }
        });
      } else if (effectiveEngage(occupant)) {
        const engageKeywords = occupant.card.keywords || {};
        const conditionOk = engageConditionMet(engageKeywords.engageCondition, state.board, playerId, state.altars[playerId], state.groundRelics);
        const costOk = player.lifespan - (engageKeywords.engageLifespanCost || 0) > 0;
        const extraCostOk = engageExtraCostSacrificeCell(engageKeywords.engageExtraCost, state.board, playerId).payable;
        // A counter-gated Engage (Void Channeler: "Remove (3) Crossing
        // Counters, Engage: ...") also needs this checked here — the same
        // check the Relic branch just below already makes, and the one
        // ACTIVATE_ENGAGE's own reducer case already enforces. Missing it
        // meant this stayed "legal" forever once the counter cost couldn't
        // actually be paid: the reducer would silently no-op every time
        // (self-play found this as the single largest source of AI infinite
        // loops — the AI kept re-selecting the same always-offered,
        // never-payable action with nothing to distinguish it from a real
        // one).
        const counterCost = engageKeywords.engageCounterCost;
        const counterCostOk = !counterCost || (occupant.counters?.[counterCost.type] || 0) >= counterCost.amount;
        if (conditionOk && costOk && extraCostOk && counterCostOk) {
          actions.push({ type: 'ACTIVATE_ENGAGE', cellId: cell });
        }
      }
    }
    if (occupant?.type === 'relic' && occupant.ownerId === playerId && !occupant.engaged && occupant.card.keywords?.engage) {
      // A Relic's Engage can carry the same "If you control ... you may
      // Engage" condition a Being's can (a borrowed textbox via Wretched
      // Remnants, e.g. "If you control only Faithless permanents..." —
      // condition: 'faithless-only'). Missing this check here (unlike the
      // Being branch above, which already had it) meant a Relic Engage
      // whose condition wasn't met stayed "legal" forever: the reducer
      // silently no-ops (see the shared engageConditionMet check in the
      // ACTIVATE_ENGAGE case), indistinguishable from real progress to the
      // AI, so it kept re-selecting it every turn.
      const conditionOk = engageConditionMet(occupant.card.keywords?.engageCondition, state.board, playerId, state.altars[playerId], state.groundRelics);
      const lifespanCostOk = player.lifespan - (occupant.card.keywords?.engageLifespanCost || 0) > 0;
      const extraCostOk = engageExtraCostSacrificeCell(occupant.card.keywords?.engageExtraCost, state.board, playerId).payable;
      const counterCost = occupant.card.keywords?.engageCounterCost;
      const counterCostOk = !counterCost || (occupant.counters?.[counterCost.type] || 0) >= counterCost.amount;
      const ownEffectCounterMatch = occupant.card.keywords.engage.match(REMOVE_OWN_COUNTERS_RE);
      const ownEffectCounterOk = !ownEffectCounterMatch
        || (occupant.counters?.[ownEffectCounterMatch[2].toLowerCase()] || 0) >= parseInt(ownEffectCounterMatch[1], 10);
      if (conditionOk && lifespanCostOk && extraCostOk && counterCostOk && ownEffectCounterOk) {
        actions.push({ type: 'ACTIVATE_ENGAGE', cellId: cell });
      }
    }
    if (occupant && (occupant.type === 'being' || occupant.type === 'armament-stack') && occupant.ownerId === playerId) {
      (occupant.armaments || []).forEach(a => {
        if (!a.engaged && a.card.keywords?.engage) {
          actions.push({ type: 'ACTIVATE_ARMAMENT_ENGAGE', cellId: cell, armamentInstanceId: a.card.instanceId });
        }
      });
    }
  });

  Object.entries(state.groundRelics).forEach(([cell, occupant]) => {
    if (!occupant || occupant.ownerId !== playerId || occupant.engaged) return;
    if (!occupant.card.keywords?.engage) return;
    if (!groundRelicEngageCostPayable(occupant, player, playerId, cell, state.board)) return;
    actions.push({ type: 'ACTIVATE_GROUND_RELIC_ENGAGE', cellId: cell });
  });
};

export const getLegalActions = (state, playerId) => {
  const actions = [];

  // A pending search/Modulate effect blocks everything else for both
  // players until the acting player resolves it — it can fire on either
  // player's turn (e.g. a defender's Depart triggers during the attacker's
  // turn).
  if (state.pendingChoice) {
    if (state.pendingChoice.playerId !== playerId) return actions;
    if (state.pendingChoice.kind === 'search') {
      // costFilter (Death's Decanter) narrows a typing/name search further
      // to an exact totalCastingCost match; minCostFilter (Exactly on
      // TIme: "costs (3) or more") is the same idea but a floor instead of
      // an exact match — everything else about a 'search' choice
      // (RESOLVE_CHOICE's own resolution) is unchanged.
      const { source, query, costFilter, minCostFilter, sharedTypings, colorFilter } = state.pendingChoice;
      let candidates = searchZoneCandidates(state.players[playerId][source], query);
      if (costFilter != null) candidates = candidates.filter(c => totalCastingCost(c) === costFilter);
      if (minCostFilter != null) candidates = candidates.filter(c => totalCastingCost(c) >= minCostFilter);
      if (colorFilter != null) candidates = candidates.filter(c => c.effigyType === colorFilter);
      // sharedTypings (Vadē Rah) — same idea as costFilter/minCostFilter,
      // just narrowing by a typing overlap with the just-sacrificed Being
      // instead of a cost comparison.
      if (sharedTypings != null) {
        candidates = candidates.filter(c => (c.typing || '').split(',').map(t => t.trim().toLowerCase()).some(t => sharedTypings.includes(t)));
      }
      candidates.forEach(c => actions.push({ type: 'RESOLVE_CHOICE', instanceId: c.instanceId }));
    } else if (state.pendingChoice.kind === 'invoke-card-choice') {
      state.pendingChoice.candidateInstanceIds.forEach(instanceId => actions.push({ type: 'RESOLVE_INVOKE_CARD_CHOICE', instanceId }));
    } else if (state.pendingChoice.kind === 'invoke-destination') {
      state.pendingChoice.allowedCells.forEach(cell => actions.push({ type: 'RESOLVE_INVOKE_DESTINATION', cellId: cell }));
    } else if (state.pendingChoice.kind === 'shuffle-purgatory-into-deck') {
      // Two shapes: a plain typing/name query (Melting Clock), or Temple of
      // Dubiety's own fixed "Faithless Being" filter (source). `anyOwner`
      // (Canopic Jar — its own printed text has no "your Purgatory"
      // restriction) widens the search to both players' Purgatories
      // instead of just the activating player's own.
      const { query, source, anyOwner } = state.pendingChoice;
      const purgatoryOwners = anyOwner ? Object.keys(state.players) : [playerId];
      purgatoryOwners.forEach(ownerId => {
        const candidates = source === 'purgatory-faithless-being'
          ? state.players[ownerId].purgatory.filter(c => c.kind === 'being' && isFaithlessTypedCard(c))
          : searchZoneCandidates(state.players[ownerId].purgatory, query);
        // `ownerId` rides along on the action itself (not just re-derived
        // by searching both piles for the instanceId at resolve time) —
        // deck-built instanceIds are only unique WITHIN one player's own
        // deck (`${card.id}#${i}`, deck.js), so the same two decks (e.g.
        // both players on the same precon) can genuinely produce the same
        // instanceId in both Purgatories at once; only the action's own
        // explicit ownerId disambiguates which one this candidate is.
        candidates.forEach(c => actions.push({ type: 'RESOLVE_SHUFFLE_PURGATORY_INTO_DECK', instanceId: c.instanceId, ...(anyOwner ? { ownerId } : {}) }));
      });
    } else if (state.pendingChoice.kind === 'summon-from-purgatory') {
      const { query } = state.pendingChoice;
      searchZoneCandidatesAnyOf(state.players[playerId].purgatory, query)
        .filter(c => c.kind === 'being')
        .forEach(c => actions.push({ type: 'RESOLVE_SUMMON_FROM_PURGATORY', instanceId: c.instanceId }));
    } else if (state.pendingChoice.kind === 'move-target-being') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_MOVE_TARGET_BEING', fromCellId: cell }));
    } else if (state.pendingChoice.kind === 'modulate') {
      const { delta, allowedCells, anyOwner } = state.pendingChoice;
      Object.entries(state.board).forEach(([cell, occupant]) => {
        if (!(anyOwner ? occupant : occupant?.ownerId === playerId) || !isModulateTarget(occupant)) return;
        if (allowedCells && !allowedCells.includes(cell)) return;
        if (delta === 'choose') {
          actions.push({ type: 'RESOLVE_MODULATE', cellId: cell, delta: 1 });
          actions.push({ type: 'RESOLVE_MODULATE', cellId: cell, delta: -1 });
        } else {
          actions.push({ type: 'RESOLVE_MODULATE', cellId: cell, delta });
        }
      });
      // Altars (Eònion Altar) — same "±" fan-out, addressed by the altar
      // card's own instanceId since altars aren't board cells. Time
      // Keeper's own "a target this points to" (allowedCells) can never
      // point at an Altar (off-board entirely), so this is skipped then.
      // anyOwner (OPTIONAL_MODULATE_ANY_OWNER_RE) scans both players' own
      // altar lists instead of just the activating player's.
      if (!allowedCells) {
        const altarOwners = anyOwner ? Object.keys(state.altars) : [playerId];
        altarOwners.forEach((ownerId) => (state.altars[ownerId] || []).forEach(altar => {
          if (!isModulateableAltar(altar)) return;
          if (delta === 'choose') {
            actions.push({ type: 'RESOLVE_MODULATE', altarInstanceId: altar.card.instanceId, delta: 1 });
            actions.push({ type: 'RESOLVE_MODULATE', altarInstanceId: altar.card.instanceId, delta: -1 });
          } else {
            actions.push({ type: 'RESOLVE_MODULATE', altarInstanceId: altar.card.instanceId, delta });
          }
        }));
      }
    } else if (state.pendingChoice.kind === 'damage-target') {
      // `typing: null` means "any Being on the board, either owner" (see
      // DAMAGE_ANY_TARGET_RE) — otherwise the original typed/owned filter.
      // `ownerFilter: 'opponent'` (Ambiguity's heads case — "an enemy")
      // narrows the untyped case to just the opposing side. The untyped
      // case also includes a freestanding Animated Armament acting as a
      // Being (RULES.md > Keywords > Animated) — a typed filter never
      // would, since an Armament's own typing is never a creature typing.
      const { typing, ownerFilter, includesPlayers } = state.pendingChoice;
      const candidates = typing
        ? beingsOfTypingOwnedBy(state.board, playerId, typing)
        : Object.entries(state.board).filter(([, o]) => (o?.type === 'being' || animatedTopEntry(o)) && moveSourceOwnerMatches(o, ownerFilter, playerId));
      candidates.forEach(([cell]) => actions.push({ type: 'RESOLVE_DAMAGE_TARGET', cellId: cell }));
      // "any target" also lets either player's own Lifespan be chosen
      // directly — not a board cell, so it's its own action type.
      if (includesPlayers) {
        ['A', 'B'].forEach(targetPlayerId => actions.push({ type: 'RESOLVE_DAMAGE_TARGET_PLAYER', targetPlayerId }));
      }
    } else if (state.pendingChoice.kind === 'minus-counter-target') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being')
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_MINUS_COUNTER_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'add-counter-typed-pointed-target') {
      state.pendingChoice.allowedCells.forEach(cell => actions.push({ type: 'RESOLVE_ADD_COUNTER_TYPED_POINTED_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'strength-set-eot') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being')
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_STRENGTH_SET_EOT', cellId: cell }));
    } else if (state.pendingChoice.kind === 'return-to-hand') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId && !o.card.isDeity
          && Object.keys(o.card.castingCost?.colored || {}).length > 0)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_RETURN_TO_HAND', cellId: cell }));
    } else if (state.pendingChoice.kind === 'choose-essence-color') {
      EFFIGY_COLORS.forEach(color => actions.push({ type: 'RESOLVE_CHOOSE_ESSENCE_COLOR', color }));
    } else if (state.pendingChoice.kind === 'sacrifice-being-cost') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_SACRIFICE_BEING_COST', cellId: cell }));
    } else if (state.pendingChoice.kind === 'engage-being-cost') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId && !o.engaged)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_ENGAGE_BEING_COST', cellId: cell }));
    } else if (state.pendingChoice.kind === 'grant-martyr-target') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being')
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_GRANT_MARTYR_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'afterimage-target') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being')
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_AFTERIMAGE_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'conjure-prophecy-purgatory') {
      const { color, cellId } = state.pendingChoice;
      if (!state.board[cellId]) {
        state.players[playerId].purgatory
          .filter(c => c.kind === 'prophecy' && Object.keys(c.castingCost?.colored || {}).includes(color))
          .forEach(c => actions.push({ type: 'RESOLVE_CONJURE_PROPHECY_PURGATORY', instanceId: c.instanceId }));
      }
    } else if (state.pendingChoice.kind === 'create-token-choice') {
      state.pendingChoice.options.forEach(tokenKey => actions.push({ type: 'RESOLVE_CREATE_TOKEN_CHOICE', tokenKey }));
    } else if (state.pendingChoice.kind === 'ethereal-token-location') {
      const { allowedCells } = state.pendingChoice;
      ETHEREAL_CELLS.filter(cell => !state.board[cell] && (!allowedCells || allowedCells.includes(cell)))
        .forEach(cell => actions.push({ type: 'RESOLVE_ETHEREAL_TOKEN_LOCATION', cellId: cell }));
    } else if (state.pendingChoice.kind === 'end-of-turn-damage-named-family-target') {
      // Passing Doubt/Lingering Doubt (turn.js > applyEndOfTurnDamageNamedFamily)
      // — every Being of the trigger's own name-family the controller owns
      // is a legal target, including the trigger source itself (the
      // printed text has no "another" qualifier).
      const needle = state.pendingChoice.namePart.toLowerCase();
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId && o.card.name.toLowerCase().includes(needle))
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_END_OF_TURN_DAMAGE_NAMED_FAMILY_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'summon-hand-being-pointed') {
      const { allowedCells } = state.pendingChoice;
      const player = state.players[playerId];
      // A pointed tile that already carries the player's own TreeFolk/
      // Vine/Seed is still legal for a Dryad-keyword Being from hand — the
      // same Dryad-attach bypass SUMMON_BEING's own legality check already
      // grants (dryadAttachTargetOk), just threaded through here too.
      // Dryad eligibility depends on the SPECIFIC hand card being
      // considered (its own `dryad` keyword), not just the cell, so this
      // checks per (cell, card) pair rather than filtering cells first.
      allowedCells.forEach(cell => {
        const occupant = state.board[cell];
        player.hand
          .filter(c => c.kind === 'being'
            && (emptyOrOwnArmamentStack(occupant, playerId) || dryadAttachTargetOk(occupant, playerId, c))
            && canPayCost(player.effigyPool, effectiveCastingCost(c, state, playerId)))
          .forEach(c => actions.push({ type: 'RESOLVE_SUMMON_HAND_BEING_POINTED', instanceId: c.instanceId, cellId: cell }));
      });
    } else if (state.pendingChoice.kind === 'copy-engage-target') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && o.ownerId !== playerId)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_COPY_ENGAGE_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'trigger-depart-target') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId && o.card.keywords?.depart)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_TRIGGER_DEPART_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'add-counter-relic-target') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'relic')
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_ADD_COUNTER_RELIC_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'sacrifice-relic-cost') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'relic' && o.ownerId === playerId)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_SACRIFICE_RELIC_COST', cellId: cell }));
    } else if (state.pendingChoice.kind === 'vyu-bhata-target') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_VYU_BHATA_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'sacrifice-typed-cost-limit') {
      const { typings, costLimit } = state.pendingChoice;
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId
          && typings.some(t => (o.card.typing || '').toLowerCase().includes(t))
          && totalCastingCost(o.card) <= costLimit)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_SACRIFICE_TYPED_COST_LIMIT', cellId: cell }));
    } else if (state.pendingChoice.kind === 'drown-screams-target') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && !o.card.isDeity)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_DROWN_SCREAMS_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'dendrify-target') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being')
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_DENDRIFY_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'animate-relic-target') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'relic')
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_ANIMATE_RELIC_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'teeth-bounds-sacrifice-hunger') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId && (o.card.typing || '').toLowerCase().includes('hunger'))
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_TEETH_BOUNDS_SACRIFICE_HUNGER', cellId: cell }));
    } else if (state.pendingChoice.kind === 'teeth-bounds-tie-choice') {
      actions.push({ type: 'RESOLVE_TEETH_BOUNDS_TIE_CHOICE', choice: 'more' });
      actions.push({ type: 'RESOLVE_TEETH_BOUNDS_TIE_CHOICE', choice: 'less' });
    } else if (state.pendingChoice.kind === 'legend-rule-keep') {
      const { deityName } = state.pendingChoice;
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId && o.card.isDeity && o.card.name === deityName)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_LEGEND_RULE_KEEP', cellId: cell }));
    } else if (state.pendingChoice.kind === 'move-forward-target') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_MOVE_FORWARD_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'strength-debuff-target') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being')
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_STRENGTH_DEBUFF_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'debuff-per-own-death-target') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being')
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_DEBUFF_PER_OWN_DEATH_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'return-the-favor-target') {
      const { excludeCell } = state.pendingChoice;
      Object.entries(state.board)
        .filter(([cell, o]) => cell !== excludeCell && o?.type === 'being')
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_RETURN_THE_FAVOR_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'diablerie-select-mover') {
      const { movedInstanceIds } = state.pendingChoice;
      Object.entries(state.board)
        .filter(([cell, o]) => o?.type === 'being' && o.ownerId === playerId
          && !movedInstanceIds.includes(o.card.instanceId) && hasFreeMoveDestination(state, playerId, cell, 'any'))
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_DIABLERIE_SELECT_MOVER', cellId: cell }));
      // "May move ANY NUMBER" — always offered, same "up to N legitimately
      // includes 0" reasoning the toggle-then-confirm patterns already use.
      actions.push({ type: 'RESOLVE_DIABLERIE_DONE' });
    } else if (state.pendingChoice.kind === 'diablerie-move-destination') {
      state.pendingChoice.allowedCells.forEach(cell => actions.push({ type: 'RESOLVE_DIABLERIE_MOVE_DESTINATION', cellId: cell }));
    } else if (state.pendingChoice.kind === 'lifespan-damage-first-target') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_LIFESPAN_DAMAGE_FIRST_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'lifespan-damage-second-target') {
      const { excludeCell } = state.pendingChoice;
      Object.entries(state.board)
        .filter(([cell, o]) => cell !== excludeCell && o?.type === 'being')
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_LIFESPAN_DAMAGE_SECOND_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'sacrifice-pointed-target') {
      const { selfCellId } = state.pendingChoice;
      const selfArrows = state.board[selfCellId]?.card?.arrows || [];
      const pointedCells = [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, selfCellId, dir)))].filter(Boolean);
      pointedCells
        .filter(c => state.board[c]?.type === 'being')
        .forEach(c => actions.push({ type: 'RESOLVE_SACRIFICE_POINTED_TARGET', cellId: c }));
    } else if (state.pendingChoice.kind === 'midnight-mass-sacrifice-target') {
      const { selfCellId } = state.pendingChoice;
      const selfArrows = state.pendingChoice.context?.selfArrows || state.board[selfCellId]?.card?.arrows || [];
      const pointedCells = [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, selfCellId, dir)))].filter(Boolean);
      pointedCells
        .filter(c => state.board[c]?.type === 'being')
        .forEach(c => actions.push({ type: 'RESOLVE_MIDNIGHT_MASS_SACRIFICE_TARGET', cellId: c }));
    } else if (state.pendingChoice.kind === 'engage-grant-counter-source') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId && !o.engaged)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_ENGAGE_GRANT_COUNTER_SOURCE', cellId: cell }));
    } else if (state.pendingChoice.kind === 'recollect-target') {
      state.pendingChoice.pointedCells
        .filter(c => state.board[c]?.type === 'being')
        .forEach(c => actions.push({ type: 'RESOLVE_RECOLLECT_TARGET', cellId: c }));
    } else if (state.pendingChoice.kind === 'engage-buff-eot') {
      // Boknean Wine's own printed text has no "you control" — any
      // disengaged Being, either owner (see the resolveOrLogEffect branch
      // that opens this choice for the full explanation).
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && !o.engaged)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_ENGAGE_BUFF_EOT', cellId: cell }));
    } else if (state.pendingChoice.kind === 'engage-then-move') {
      const { typing } = state.pendingChoice;
      Object.entries(state.board)
        .filter(([cell, o]) => o?.type === 'being' && o.ownerId === playerId && !o.engaged
          && (o.card.typing || '').toLowerCase().includes(typing.toLowerCase())
          && hasFreeMoveDestination(state, playerId, cell, 'any'))
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_ENGAGE_THEN_MOVE', cellId: cell }));
    } else if (state.pendingChoice.kind === 'engage-move-twice') {
      Object.entries(state.board)
        .filter(([cell, o]) => o?.type === 'being' && o.ownerId === playerId && !o.engaged && hasFreeMoveDestination(state, playerId, cell, 'any'))
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_ENGAGE_MOVE_TWICE', cellId: cell }));
    } else if (state.pendingChoice.kind === 'discard-x-named-toggle') {
      const { name } = state.pendingChoice;
      state.players[playerId].hand
        .filter(c => c.name.toLowerCase() === name.toLowerCase())
        .forEach(c => actions.push({ type: 'RESOLVE_DISCARD_X_NAMED_TOGGLE', instanceId: c.instanceId }));
      actions.push({ type: 'RESOLVE_DISCARD_X_NAMED_CONFIRM' });
    } else if (state.pendingChoice.kind === 'sacrifice-any-beings-toggle') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_SACRIFICE_ANY_BEINGS_TOGGLE', cellId: cell }));
      actions.push({ type: 'RESOLVE_SACRIFICE_ANY_BEINGS_CONFIRM' });
    } else if (state.pendingChoice.kind === 'sacrifice-typed-cost') {
      beingsOfTypingOwnedBy(state.board, playerId, state.pendingChoice.typing)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_SACRIFICE_TYPED_COST', cellId: cell }));
    } else if (state.pendingChoice.kind === 'free-move') {
      const { fromCellId, destinationFilter } = state.pendingChoice;
      [...new Set([1, 2, 3, 4, 5, 6, 7, 8].map(dir => computeMoveDestination(playerId, fromCellId, dir)))]
        .filter(c => c && freeMoveDestinationOk(state, playerId, c, destinationFilter))
        .forEach(toCellId => actions.push({ type: 'RESOLVE_FREE_MOVE', toCellId }));
    } else if (state.pendingChoice.kind === 'select-move-source') {
      const { ownerFilter, destinationFilter } = state.pendingChoice;
      Object.entries(state.board)
        .filter(([cell, o]) => o?.type === 'being' && moveSourceOwnerMatches(o, ownerFilter, playerId)
          && hasFreeMoveDestination(state, playerId, cell, destinationFilter))
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_SELECT_MOVE_SOURCE', cellId: cell }));
    } else if (state.pendingChoice.kind === 'bottom-of-deck') {
      state.players[playerId].hand.forEach(c => actions.push({ type: 'RESOLVE_BOTTOM_OF_DECK', instanceId: c.instanceId }));
    } else if (state.pendingChoice.kind === 'freeze-frame-target') {
      // Also offers an Animated Armament acting as a Being (RULES.md >
      // Keywords > Animated) — see the matching fix in resolveOrLogEffect's
      // own GAIN_TIME_COUNTER_NO_DISENGAGE_RE handler.
      Object.entries(state.board)
        .filter(([, o]) => (o?.type === 'being' && o.engaged) || (o?.type === 'armament-stack' && animatedTopEntry(o)?.engaged))
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_FREEZE_FRAME_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'time-counter-block-move') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being')
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_TIME_COUNTER_BLOCK_MOVE', cellId: cell }));
    } else if (state.pendingChoice.kind === 'discard-chosen-cost-reduction') {
      state.players[playerId].hand.forEach(c => actions.push({ type: 'RESOLVE_DISCARD_CHOSEN_COST_REDUCTION', instanceId: c.instanceId }));
    } else if (state.pendingChoice.kind === 'discard-kind-draw') {
      const { discardKind } = state.pendingChoice;
      state.players[playerId].hand
        .filter(c => matchesDiscardKind(c, discardKind))
        .forEach(c => actions.push({ type: 'RESOLVE_DISCARD_KIND_DRAW', instanceId: c.instanceId }));
    } else if (state.pendingChoice.kind === 'discard-being-draw-bonus') {
      state.players[playerId].hand
        .filter(c => c.kind === 'being' || c.kind === 'deity')
        .forEach(c => actions.push({ type: 'RESOLVE_DISCARD_BEING_DRAW_BONUS', instanceId: c.instanceId }));
    } else if (state.pendingChoice.kind === 'discard-then-search-purgatory') {
      const { discardTyping } = state.pendingChoice;
      state.players[playerId].hand
        .filter(c => matchesDiscardTyping(c, discardTyping))
        .forEach(c => actions.push({ type: 'RESOLVE_DISCARD_THEN_SEARCH_PURGATORY', instanceId: c.instanceId }));
    } else if (state.pendingChoice.kind === 'choose-x-value') {
      const { maxX } = state.pendingChoice;
      for (let value = 0; value <= maxX; value++) actions.push({ type: 'RESOLVE_CHOOSE_X_VALUE', value });
    } else if (state.pendingChoice.kind === 'choose-prophecy-timer') {
      const { maxValue } = state.pendingChoice;
      for (let value = 0; value <= maxValue; value++) actions.push({ type: 'RESOLVE_CHOOSE_PROPHECY_TIMER', value });
    } else if (state.pendingChoice.kind === 'legion-onset-choose-count') {
      const { maxCount } = state.pendingChoice;
      for (let value = 0; value <= maxCount; value++) actions.push({ type: 'RESOLVE_LEGION_ONSET_CHOOSE_COUNT', value });
    } else if (state.pendingChoice.kind === 'force-combat-select-mine') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_FORCE_COMBAT_SELECT_MINE', cellId: cell }));
    } else if (state.pendingChoice.kind === 'force-combat-select-theirs') {
      const { myCellId } = state.pendingChoice;
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && o.ownerId !== playerId)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_FORCE_COMBAT_SELECT_THEIRS', myCellId, cellId: cell }));
    } else if (state.pendingChoice.kind === 'favor-pointed-toggle') {
      const { maxCount, allowedCells, selected } = state.pendingChoice;
      allowedCells.forEach(cell => {
        if (!selected.includes(cell) && selected.length >= maxCount) return;
        actions.push({ type: 'RESOLVE_FAVOR_POINTED_TOGGLE', cellId: cell });
      });
      actions.push({ type: 'RESOLVE_FAVOR_POINTED_CONFIRM' });
    } else if (state.pendingChoice.kind === 'destroy-pointed-summon-token') {
      const { selfCellId } = state.pendingChoice;
      const selfArrows = state.board[selfCellId]?.card?.arrows || [];
      const pointedCells = [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, selfCellId, dir)))].filter(Boolean);
      pointedCells.filter(c => state.board[c]?.type === 'being').forEach(cell => actions.push({ type: 'RESOLVE_DESTROY_POINTED_SUMMON_TOKEN', cellId: cell }));
    } else if (state.pendingChoice.kind === 'switch-with-typed') {
      const { typing, selfCellId } = state.pendingChoice;
      Object.entries(state.board)
        .filter(([cell, o]) => cell !== selfCellId && o?.type === 'being' && o.ownerId === playerId && (o.card.typing || '').toLowerCase().includes(typing.toLowerCase()))
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_SWITCH_WITH_TYPED', cellId: cell }));
    } else if (state.pendingChoice.kind === 'discard-typed') {
      const { typing } = state.pendingChoice;
      state.players[playerId].hand
        .filter(c => matchesDiscardTyping(c, typing))
        .forEach(c => actions.push({ type: 'RESOLVE_DISCARD_TYPED', instanceId: c.instanceId }));
    } else if (state.pendingChoice.kind === 'discard-one-card') {
      state.players[playerId].hand.forEach(c => actions.push({ type: 'RESOLVE_DISCARD_ONE_CARD', instanceId: c.instanceId }));
    } else if (state.pendingChoice.kind === 'shuffle-or-keep') {
      actions.push({ type: 'RESOLVE_SHUFFLE_OR_KEEP', shuffle: true });
      actions.push({ type: 'RESOLVE_SHUFFLE_OR_KEEP', shuffle: false });
    } else if (state.pendingChoice.kind === 'reveal-prophecy') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'prophecy')
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_REVEAL_PROPHECY', cellId: cell }));
    } else if (state.pendingChoice.kind === 'sacrifice') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_SACRIFICE', cellId: cell }));
    } else if (state.pendingChoice.kind === 'sacrifice-armament') {
      Object.entries(state.board).forEach(([cell, o]) => {
        if (!o || o.ownerId !== playerId || !o.armaments) return;
        o.armaments.forEach(a => actions.push({ type: 'RESOLVE_SACRIFICE_ARMAMENT', cellId: cell, armamentInstanceId: a.card.instanceId }));
      });
    } else if (state.pendingChoice.kind === 'sacrifice-armament-damage') {
      Object.entries(state.board).forEach(([cell, o]) => {
        if (!o || o.ownerId !== playerId || !o.armaments) return;
        o.armaments.forEach(a => actions.push({ type: 'RESOLVE_SACRIFICE_ARMAMENT_DAMAGE', cellId: cell, armamentInstanceId: a.card.instanceId }));
      });
    } else if (state.pendingChoice.kind === 'move-armament-source') {
      Object.entries(state.board).forEach(([cell, o]) => {
        if (!o || o.ownerId !== playerId || !o.armaments) return;
        o.armaments.forEach(a => actions.push({ type: 'RESOLVE_MOVE_ARMAMENT_SOURCE', cellId: cell, armamentInstanceId: a.card.instanceId }));
      });
    } else if (state.pendingChoice.kind === 'move-armament-any-source') {
      Object.entries(state.board).forEach(([cell, o]) => {
        if (!o || o.ownerId !== playerId || !o.armaments) return;
        o.armaments.forEach(a => actions.push({ type: 'RESOLVE_MOVE_ARMAMENT_ANY_SOURCE', cellId: cell, armamentInstanceId: a.card.instanceId }));
      });
    } else if (state.pendingChoice.kind === 'move-armament-destination') {
      state.pendingChoice.allowedCells.forEach(cell => actions.push({ type: 'RESOLVE_MOVE_ARMAMENT_DESTINATION', cellId: cell }));
    } else if (state.pendingChoice.kind === 'move-adjacent-armament-source') {
      const { selfCellId } = state.pendingChoice;
      const adjacentCells = [...new Set([1, 2, 3, 4, 5, 6, 7, 8].map(dir => computeMoveDestination(playerId, selfCellId, dir)))].filter(Boolean);
      adjacentCells.forEach(cell => {
        const o = state.board[cell];
        if (o?.armaments) o.armaments.forEach(a => actions.push({ type: 'RESOLVE_MOVE_ADJACENT_ARMAMENT_SOURCE', cellId: cell, armamentInstanceId: a.card.instanceId }));
      });
    } else if (state.pendingChoice.kind === 'copy-textbox-until-end-of-turn') {
      state.pendingChoice.allowedCells.forEach(cell => actions.push({ type: 'RESOLVE_COPY_TEXTBOX_UNTIL_END_OF_TURN', cellId: cell }));
    } else if (state.pendingChoice.kind === 'engage-effigy-add-essence') {
      state.pendingChoice.allowedInstanceIds.forEach(instanceId => actions.push({ type: 'RESOLVE_ENGAGE_EFFIGY_ADD_ESSENCE', instanceId }));
    } else if (state.pendingChoice.kind === 'shift-destination') {
      state.pendingChoice.allowedCells.forEach(cell => actions.push({ type: 'RESOLVE_SHIFT_DESTINATION', cellId: cell }));
    } else if (state.pendingChoice.kind === 'shift-return') {
      state.pendingChoice.allowedCells.forEach(cell => actions.push({ type: 'RESOLVE_SHIFT_RETURN', cellId: cell }));
    } else if (state.pendingChoice.kind === 'give-different-typed-buff') {
      // allowedCells is a snapshot taken when this reaction fired — one of
      // those Beings can die before the choice actually resolves (e.g. a
      // multi-step turn with other things happening in between). Filtered
      // live against the board, not trusted as still-accurate: self-play
      // found that offering a since-emptied cell stayed legal forever (the
      // reducer's own `if (!occupant) return state;` guard is a silent
      // no-op, not a real resolution), so the AI just kept re-selecting it.
      state.pendingChoice.allowedCells
        .filter(cell => state.board[cell]?.type === 'being')
        .forEach(cell => actions.push({ type: 'RESOLVE_GIVE_DIFFERENT_TYPED_BUFF', cellId: cell }));
    } else if (state.pendingChoice.kind === 'force-shift-target') {
      state.pendingChoice.allowedCells.forEach(cell => actions.push({ type: 'RESOLVE_FORCE_SHIFT_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'copy-opponent-effect') {
      state.pendingChoice.allowedCells.forEach(cell => actions.push({ type: 'RESOLVE_COPY_OPPONENT_EFFECT', cellId: cell }));
    } else if (state.pendingChoice.kind === 'echoes-boundless-shift-instead') {
      // triggerEchoesOfBoundlessOffer only checks canPayCost once, at the
      // moment this choice first opens — but self-play found the effigy
      // pool can still fail this same check by the time it's actually
      // resolved (the same "offer never re-verifies what the reducer still
      // enforces" gap as give-different-typed-buff's own fix above), and
      // the reducer's own `if (!canPayCost(...)) return state;` guard is a
      // silent no-op, not a real resolution — the AI just kept
      // re-selecting a permanently-unaffordable "pay to Shift instead"
      // forever. RESOLVE_DECLINE (below, this pendingChoice's own
      // `optional: true`) stays the only real way out once this fails.
      const { playerId: choicePlayerId, dyingCard } = state.pendingChoice;
      if (canPayCost(state.players[choicePlayerId].effigyPool, dyingCard.castingCost)) {
        actions.push({ type: 'RESOLVE_ECHOES_BOUNDLESS_SHIFT_INSTEAD' });
      }
    } else if (state.pendingChoice.kind === 'shift-from-purgatory-destination') {
      state.pendingChoice.allowedCells.forEach(cell => actions.push({ type: 'RESOLVE_SHIFT_FROM_PURGATORY_DESTINATION', cellId: cell }));
    } else if (state.pendingChoice.kind === 'udarik-shift-target') {
      state.pendingChoice.allowedCells.forEach(cell => actions.push({ type: 'RESOLVE_UDARIK_SHIFT_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'deja-vu-target') {
      state.pendingChoice.allowedCells.forEach(cell => actions.push({ type: 'RESOLVE_DEJA_VU_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'summon-sacrifice-cost') {
      const { selected } = state.pendingChoice;
      Object.entries(state.board)
        .filter(([cell, o]) => o?.type === 'being' && o.ownerId === playerId && !selected.includes(cell))
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_SUMMON_SACRIFICE_COST', cellId: cell }));
    } else if (state.pendingChoice.kind === 'sacrifice-destroy') {
      const prophecyCells = Object.entries(state.board).filter(([, o]) => o?.type === 'prophecy' && o.ownerId === playerId).map(([cell]) => cell);
      const destroyCells = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && !o.card.isDeity).map(([cell]) => cell);
      prophecyCells.forEach(prophecyCellId => {
        destroyCells.forEach(targetCellId => {
          actions.push({ type: 'RESOLVE_SACRIFICE_DESTROY', prophecyCellId, targetCellId });
        });
      });
    } else if (state.pendingChoice.kind === 'destroy-permanent') {
      const { targetKind } = state.pendingChoice;
      Object.entries(state.board)
        .filter(([, o]) => o?.type === targetKind)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_DESTROY_PERMANENT', cellId: cell }));
    } else if (state.pendingChoice.kind === 'destroy-armament') {
      gatherArmamentEntries(state.board)
        .forEach(({ cellId, armamentInstanceId }) => actions.push({ type: 'RESOLVE_DESTROY_ARMAMENT', cellId, armamentInstanceId }));
    } else if (state.pendingChoice.kind === 'destroy-relic-target') {
      gatherRelicTargets(state.board)
        .forEach(({ cellId, armamentInstanceId }) => actions.push({ type: 'RESOLVE_DESTROY_RELIC_TARGET', cellId, armamentInstanceId }));
    } else if (state.pendingChoice.kind === 'sacrifice-relic-cost-target') {
      gatherRelicTargets(state.board)
        .filter(({ cellId }) => state.board[cellId]?.ownerId === playerId)
        .forEach(({ cellId, armamentInstanceId }) => actions.push({ type: 'RESOLVE_SACRIFICE_RELIC_COST_TARGET', cellId, armamentInstanceId }));
    } else if (state.pendingChoice.kind === 'grant-favor') {
      // Own Beings only by default (IkVarem's own "target Being you
      // control"); `anyOwner` widens it to either player's (Intervene,
      // One Above All — printed as plain "target Being", no "you control").
      // `typing`, when given (Greenseer: "target Familiar"), further
      // restricts to Beings whose own printed typing includes that word.
      const favorTyping = state.pendingChoice.typing?.toLowerCase();
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && (state.pendingChoice.anyOwner || o.ownerId === playerId)
          && (!favorTyping || (o.card.typing || '').toLowerCase().includes(favorTyping)))
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_GRANT_FAVOR', cellId: cell }));
    } else if (state.pendingChoice.kind === 'buff-ally') {
      const { cost } = state.pendingChoice;
      if (state.players[playerId].lifespan - cost > 0) {
        Object.entries(state.board)
          .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId)
          .forEach(([cell]) => actions.push({ type: 'RESOLVE_BUFF_ALLY', cellId: cell }));
      }
    } else if (state.pendingChoice.kind === 'shuffle-or-draw') {
      actions.push({ type: 'RESOLVE_SHUFFLE_OR_DRAW', shuffle: true });
      actions.push({ type: 'RESOLVE_SHUFFLE_OR_DRAW', shuffle: false });
    } else if (state.pendingChoice.kind === 'restore-or-summon-vine') {
      actions.push({ type: 'RESOLVE_RESTORE_OR_SUMMON_VINE', choice: 'restore' });
      actions.push({ type: 'RESOLVE_RESTORE_OR_SUMMON_VINE', choice: 'summon' });
    } else if (state.pendingChoice.kind === 'restore-lifespan-target') {
      // Any legal target — a Being (either owner) or either player's own
      // Lifespan directly. A Being caps at its own printed Lifespan (the
      // excess fizzles — see RESOLVE_RESTORE_LIFESPAN_TARGET), but a
      // player is uncapped (confirmed with the user: a player can be
      // restored above their starting 50) — either way a target already
      // at its cap is still a legal choice, it just gains 0.
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' || animatedTopEntry(o))
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_RESTORE_LIFESPAN_TARGET', cellId: cell }));
      ['A', 'B'].forEach(targetPlayerId => actions.push({ type: 'RESOLVE_RESTORE_LIFESPAN_TARGET_PLAYER', targetPlayerId }));
    } else if (state.pendingChoice.kind === 'summon-vine-tokens-toggle') {
      const { maxCount, selected } = state.pendingChoice;
      emptyMortalCellsFor(state.board, playerId).forEach(cell => {
        if (selected.includes(cell) || selected.length < maxCount) {
          actions.push({ type: 'RESOLVE_SUMMON_VINE_TOKENS_TOGGLE', cellId: cell });
        }
      });
      // "Up to N" always allows confirming, even with nothing selected.
      actions.push({ type: 'RESOLVE_SUMMON_VINE_TOKENS_CONFIRM' });
    } else if (state.pendingChoice.kind === 'copy-stats') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_COPY_STATS', cellId: cell }));
    } else if (state.pendingChoice.kind === 'doesnt-disengage') {
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && !o.card.isDeity)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_DOESNT_DISENGAGE', cellId: cell }));
    } else if (state.pendingChoice.kind === 'desperate-finale-target') {
      // Not `player` — this pendingChoice branch runs before that binding
      // exists yet in this function (see the later per-card offering loop).
      const lifespan = state.players[playerId].lifespan;
      Object.entries(state.board)
        .filter(([, o]) => o?.type === 'being' && o.ownerId === playerId && o.engaged && lifespan - o.card.lifespan > 0)
        .forEach(([cell]) => actions.push({ type: 'RESOLVE_DESPERATE_FINALE_TARGET', cellId: cell }));
    } else if (state.pendingChoice.kind === 'token-location') {
      // `allowedCells`, when present (Crawling Growth's "adjacent to
      // another Vine you control"), narrows the usual "any empty Mortal
      // Realm tile" pool to a specific subset computed when the choice
      // opened.
      const { allowedCells } = state.pendingChoice;
      emptyMortalCellsFor(state.board, playerId)
        .filter(cell => !allowedCells || allowedCells.includes(cell))
        .forEach(cell => actions.push({ type: 'RESOLVE_TOKEN_LOCATION', cellId: cell }));
    } else if (state.pendingChoice.kind === 'summon-token-pointed') {
      // Unlike 'token-location' above, `allowedCells` here (the pointed
      // tiles, already filtered to empty when the choice opened) is the
      // *whole* candidate pool, not a narrowing of emptyMortalCellsFor — a
      // pointed tile can lie outside the caster's own Mortal Realm side
      // (the same "points to" geometry Ferryman's Boat/Recollect already
      // use unrestricted by owner).
      state.pendingChoice.allowedCells.forEach(cell => actions.push({ type: 'RESOLVE_SUMMON_TOKEN_POINTED', cellId: cell }));
    } else if (state.pendingChoice.kind === 'sacrifice-x-toggle') {
      // Every fodder cell the player currently controls can be toggled in
      // or out of the selection, whether or not it's already selected —
      // see RESOLVE_SACRIFICE_X_TOGGLE.
      const { fodderName, selected } = state.pendingChoice;
      ownedFodderCells(state.board, playerId, fodderName)
        .forEach(cellId => actions.push({ type: 'RESOLVE_SACRIFICE_X_TOGGLE', cellId }));
      // Confirming is only offered once at least one is selected AND that
      // exact count has a real match waiting in Purgatory — this cost is
      // "free" to back out of (no partial payment happens until confirm),
      // so there's never a reason to let the player commit to a guaranteed
      // whiff, unlike a real mid-resolution search.
      if (selected.length > 0 && purgatoryBeingsWithCost(state.players[playerId].purgatory, selected.length).length > 0) {
        actions.push({ type: 'RESOLVE_SACRIFICE_X_CONFIRM' });
      }
    } else if (state.pendingChoice.kind === 'shuffle-purgatory-toggle') {
      // Every matching Purgatory card can be toggled off if already
      // selected; toggled on only while under the printed "up to N" cap.
      const { query, maxCount, selected } = state.pendingChoice;
      searchZoneCandidates(state.players[playerId].purgatory, query).forEach(c => {
        if (selected.includes(c.instanceId) || selected.length < maxCount) {
          actions.push({ type: 'RESOLVE_SHUFFLE_PURGATORY_TOGGLE', instanceId: c.instanceId });
        }
      });
      // "Up to N" always allows confirming, even with nothing selected.
      actions.push({ type: 'RESOLVE_SHUFFLE_PURGATORY_CONFIRM' });
    } else if (state.pendingChoice.kind === 'summon-from-purgatory-cost') {
      const { cost } = state.pendingChoice;
      purgatoryBeingsWithCost(state.players[playerId].purgatory, cost)
        .forEach(c => actions.push({ type: 'RESOLVE_SUMMON_FROM_PURGATORY_COST', instanceId: c.instanceId }));
    } else if (state.pendingChoice.kind === 'summon-different-typed-from-purgatory') {
      const { typing, excludeName } = state.pendingChoice;
      state.players[playerId].purgatory
        .filter(c => (c.kind === 'being' || c.kind === 'deity') && (c.typing || '').toLowerCase().includes(typing.toLowerCase()) && c.name.toLowerCase() !== excludeName)
        .forEach(c => actions.push({ type: 'RESOLVE_SUMMON_DIFFERENT_TYPED_FROM_PURGATORY', instanceId: c.instanceId }));
    } else if (state.pendingChoice.kind === 'pay-lifespan-optional') {
      if (state.players[playerId].lifespan - state.pendingChoice.cost > 0) {
        actions.push({ type: 'RESOLVE_PAY_LIFESPAN_OPTIONAL' });
      }
    } else if (state.pendingChoice.kind === 'sacrifice-this-optional') {
      // Sacrificing self has no affordability gate (unlike paying
      // Lifespan) — always offered as long as the caster is still there.
      if (state.board[state.pendingChoice.context.selfCellId]) {
        actions.push({ type: 'RESOLVE_SACRIFICE_THIS_OPTIONAL' });
      }
    } else if (state.pendingChoice.kind === 'may-summon-vine-pointed') {
      // Only offered while at least one pointed tile is still empty —
      // matching the graceful non-offer precedent elsewhere; Decline is
      // always available regardless via the generic optional mechanism.
      const { selfCellId } = state.pendingChoice.context;
      const selfArrows = state.board[selfCellId]?.card?.arrows || [];
      const pointedEmpty = [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, selfCellId, dir)))]
        .filter(c => c && !state.board[c] && !state.groundRelics[c]);
      if (pointedEmpty.length > 0) {
        actions.push({ type: 'RESOLVE_MAY_SUMMON_VINE_POINTED' });
      }
    }
    // "You may" effects always keep a Decline option alongside their real
    // candidates, even when exactly one legal choice exists — matching the
    // real-card semantics of an optional trigger.
    if (state.pendingChoice.optional) {
      actions.push({ type: 'RESOLVE_DECLINE' });
    }
    return actions;
  }

  if (state.phase === 'mulligan') {
    const player = state.players[playerId];
    if (!player.keptHand) {
      actions.push({ type: 'KEEP_HAND', player: playerId });
      if (player.lifespan - MULLIGAN_COST > 0) {
        actions.push({ type: 'MULLIGAN', player: playerId });
      }
    }
    return actions;
  }

  // A reactive window (Ethereal Conjuring timing — manageReactiveWindow,
  // below) blocks everything else for BOTH players, same "one thing at a
  // time" precedent the pendingChoice branch above already establishes —
  // only its own owner (state.reactiveWindow.openFor) gets anything at
  // all, and only PASS_PRIORITY plus casting an affordable Ethereal
  // Conjuring from hand. Checked before the normal turnPlayer gate below
  // so it applies on EITHER player's turn — the whole point is letting the
  // non-active player act here.
  if (state.reactiveWindow) {
    if (state.reactiveWindow.openFor !== playerId) return actions;
    actions.push({ type: 'PASS_PRIORITY' });
    state.players[playerId].hand.forEach(card => {
      if (card.kind !== 'ethereal-conjuring') return;
      if (!canPayCost(state.players[playerId].effigyPool, effectiveCastingCost(card, state, playerId))) return;
      if (!conjuringCastGateOk(state, playerId, card)) return;
      actions.push({ type: 'CAST_CONJURING', instanceId: card.instanceId });
    });
    // Engage abilities are "ethereal speed" too — activatable during a
    // reactive window, not just an Ethereal Conjuring — but this
    // deliberately does NOT extend to attacking, moving, or Shifting
    // (ACTIVATE_SHIFT), which all stay conjuring/sorcery-speed, main-phase
    // only (confirmed with the user). See offerReactiveEngageActions, above.
    offerReactiveEngageActions(state, playerId, actions);
    return actions;
  }

  if (state.phase !== 'playing' || state.turnPlayer !== playerId) return actions;

  const player = state.players[playerId];

  player.hand.forEach(card => {
    const payable = canPayCost(player.effigyPool, effectiveCastingCost(card, state, playerId));
    if (!payable) return;
    if (card.kind === 'being' || card.kind === 'deity') {
      // Immen Gorta: "As an additional cost to summon, Sacrifice (2)
      // Beings." — never offered at all without enough of the player's
      // own Beings already on board to pay it, same graceful non-offer
      // precedent as every other additional-cost gate (Desperate Finale,
      // Strike Down, Deja Vu above).
      const sacrificeCost = card.keywords?.additionalSummonCostSacrificeBeings;
      if (sacrificeCost && countOwnBeings(state.board, playerId) < sacrificeCost) return;
      // A "Relic, Being" (RULES.md > Card types) is placed like a Relic —
      // any Mortal Realm cell, front row included — rather than restricted
      // to the home-row summon cells a normal Being needs.
      const legalCells = card.isRelicBeing ? mortalCellsFor(playerId) : SUMMON_CELLS[playerId];
      legalCells.forEach(cell => {
        if (emptyOrOwnArmamentStack(state.board[cell], playerId)) actions.push({ type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: cell });
      });
      // Lesser Summoning Circle: also offer every one of the player's own
      // flagged ground-Relic tiles whose required typing matches this card
      // — legal even though state.board there is outside the normal summon
      // cells (a ground Relic's own tile can be anywhere in the Mortal
      // Realm, not just the home row).
      Object.entries(state.groundRelics).forEach(([cell, o]) => {
        if (summonHereTargetOk(o, playerId, card)) actions.push({ type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: cell });
      });
      // Boknea Druid: also offer every one of the player's own eligible
      // TreeFolk/Vine/Seed Beings as a direct-attach destination.
      Object.entries(state.board).forEach(([cell, o]) => {
        if (dryadAttachTargetOk(o, playerId, card)) actions.push({ type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: cell });
      });
      // Vicious Vittles: also offer its own tile as a destination for the
      // player's next Hunger this turn, if it's still there.
      const vittles = state.nextHungerFreeSummonOnTile;
      if (vittles && vittles.ownerId === playerId && (card.typing || '').toLowerCase().includes('hunger')
        && state.board[vittles.cellId]?.card?.instanceId === vittles.instanceId) {
        actions.push({ type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: vittles.cellId });
      }
      // Vaneach Hunger: "You may pay an additional (1) Formless to summon
      // ... in the Ethereal Realm with (1) Time Counter." — an alternate
      // summon mode, offered alongside (not instead of) the normal one,
      // gated on affording the combined (base + extra) cost.
      const altSummon = card.keywords?.alternateSummonAsProphecy;
      if (altSummon) {
        const combinedCost = {
          faithless: card.castingCost.faithless,
          colored: { ...card.castingCost.colored, [altSummon.color]: (card.castingCost.colored[altSummon.color] || 0) + altSummon.extraAmount },
        };
        if (canPayCost(player.effigyPool, combinedCost)) {
          actions.push({ type: 'SUMMON_AS_PROPHECY', instanceId: card.instanceId });
        }
      }
    } else if (card.kind === 'prophecy') {
      ETHEREAL_CELLS.forEach(cell => {
        if (!state.board[cell]) actions.push({ type: 'PLAY_PROPHECY', instanceId: card.instanceId, cellId: cell });
      });
    } else if (card.kind === 'relic') {
      // A "Beings may move across this" Relic (Shifting Sands) still lives
      // in groundRelics rather than `board` once placed (createInitialState's
      // own comment), so it can share a tile with a Being or an Armament
      // pile. The only things that actually block it are a DIFFERENT
      // ground Relic already on that tile, or a plain (non-Armament) Relic
      // sitting in `board` itself (that's a real distinct permanent
      // occupying the tile in the ordinary sense, not something this can
      // coexist under) — a Being or an armament-stack occupant is fine.
      // Every other Relic keeps the stricter "tile must be fully empty" rule.
      const coLocatesWithBeings = !!card.keywords?.beingsMayMoveAcross;
      mortalCellsFor(playerId).forEach(cell => {
        const blocked = coLocatesWithBeings
          ? !!state.groundRelics[cell] || state.board[cell]?.type === 'relic'
          : !!state.board[cell] || !!state.groundRelics[cell];
        if (!blocked) actions.push({ type: 'PLACE_RELIC', instanceId: card.instanceId, cellId: cell });
      });
    } else if (card.kind === 'altar') {
      // Altars aren't tied to a board cell at all (RULES.md > Card types) —
      // a player may control any number of them at once, stacking their
      // "Craft (N) additional Effigy" bonuses. A genuine "additional cost
      // to Conjure" (e.g. Rhak-tùrin Altar's damage to a Turanga you
      // control) still makes placement illegal without a legal target —
      // unlike mill/discard, which always degrade gracefully.
      if (altarConjureCostPayable(state.board, playerId, card)) {
        actions.push({ type: 'PLACE_ALTAR', instanceId: card.instanceId });
      }
    } else if (card.kind === 'relic-armament') {
      // Armaments play on any of the player's own Mortal Realm cells —
      // empty, on their own Being, or stacking on their own Armament pile.
      mortalCellsFor(playerId).forEach(cell => {
        if (armamentTargetOk(state.board[cell], playerId)) {
          actions.push({ type: 'ATTACH_ARMAMENT', instanceId: card.instanceId, cellId: cell });
        }
      });
    } else if (card.kind === 'conjuring' || card.kind === 'ethereal-conjuring') {
      // A plain Conjuring is main-phase-only; an Ethereal Conjuring is also
      // offered reactively via the reactiveWindow branch above — both share
      // every additional-cost/target-availability gate via
      // conjuringCastGateOk (Strike Down's hasAttackerAvailable, Desperate
      // Finale's hasAffordableEngagedTarget, Deja Vu's own candidate
      // search, "Shuffle (N) <X>s..."'s fixed-count Purgatory search) so
      // the two offer sites can never drift out of sync again.
      if (!conjuringCastGateOk(state, playerId, card)) return;
      actions.push({ type: 'CAST_CONJURING', instanceId: card.instanceId });
    }
  });

  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId || occupant.engaged) return;

    // Attacking is always available from the front row, independent of the
    // card's arrows — it always goes straight forward. "Can not attack"
    // (Training dummy) is a static restriction that just skips offering it.
    const attackCell = !occupant.card.keywords?.cannotAttack && computeAttackCell(playerId, cell);
    if (attackCell) {
      actions.push({ type: 'MOVE_OR_ATTACK', fromCellId: cell, toCellId: attackCell, isAttack: true });
    }

    // Arrows govern repositioning only — never attacking. Moving onto a
    // freestanding Armament stack of the player's own is fine (it's picked
    // up); anything else occupying the destination blocks the move.
    // "Can not move while this has at least 1 Time Counter" (Moment of
    // Doubt) only ever restricts this half, not attacking. "Can not move."
    // (Reveler) is the same restriction, just unconditional/permanent
    // instead of counter-gated — it only blocks this *self-initiated* offer,
    // not a move granted by another card's own effect (those never reach
    // this getLegalActions check at all).
    const moveLocked = (occupant.blockedWhileHasTimeCounters && (occupant.counters?.time || 0) > 0)
      || occupant.card.keywords?.cannotMove;
    if (!moveLocked) {
      occupant.card.arrows.forEach(direction => {
        const toCellId = computeMoveDestination(playerId, cell, direction);
        if (!toCellId) return;
        const waiting = state.board[toCellId];
        // Dryad: mirrors MOVE_OR_ATTACK's own reducer branch (the "attaching"
        // check there) — a Dryad Being moving onto another eligible own
        // TreeFolk/Vine/Seed attaches instead of needing an empty/own-
        // armament-stack destination. Without this, the reducer already
        // allowed the move but this offer loop never surfaced it, so an
        // occupied plant tile was never highlighted/clickable at all — a
        // Dryad Being already carrying a mount still can't attach a SECOND
        // one in the same move (occupant.dryadAttached), same as the
        // reducer.
        const attaching = !occupant.dryadAttached && dryadAttachTargetOk(waiting, playerId, occupant.card);
        if (!emptyOrOwnArmamentStack(waiting, playerId) && !attaching) return;
        actions.push({ type: 'MOVE_OR_ATTACK', fromCellId: cell, toCellId, direction, isAttack: false });
      });
    }

    // Martyr: Engage this Being, then sacrifice it — the engage-and-
    // sacrifice cost is real, and its captured effect text resolves for
    // real wherever it matches a recognized pattern (same shared resolver
    // as Depart/Engage/When Summoned). `!= null` rather than plain
    // truthiness: an empty string (a bare "Martyr" with no effect text,
    // e.g. Bag o' Bones) still counts as having Martyr.
    if (effectiveMartyr(state, cell, occupant) != null && martyrCostPayable(occupant, player.effigyPool)) {
      actions.push({ type: 'ACTIVATE_MARTYR', cellId: cell });
    }

    // Shift: an Engage-costed ability (RULES.md > Keywords > Shift) — the
    // Being becomes a Prophecy in the Ethereal Realm. Only offered with a
    // real empty Ethereal Realm tile to land on — the same "never offer a
    // guaranteed whiff" precedent as Deja Vu/Strike Down elsewhere in this
    // file, not the "always offer it, offerOrPerformShift gracefully
    // no-ops" this used to be: self-play found that with the Ethereal
    // Realm full, ACTIVATE_SHIFT stayed legal forever (the no-op looks
    // identical to a real action to the AI), and it just kept
    // re-activating it every turn instead of doing anything else.
    if (occupant.card.keywords?.shift && ETHEREAL_CELLS.some(c => !state.board[c])) {
      actions.push({ type: 'ACTIVATE_SHIFT', cellId: cell });
    }

    // Engage: a generic activated ability — engages the Being (its action
    // for the turn) and resolves its captured effect where recognized.
    // Covers both a printed Engage keyword and one granted by an attached
    // Armament (see effectiveEngage). A Zealot's own Engage can carry an
    // extra Lifespan cost ("Pay (N) Lifespan, Engage: ..." — NamKaranian
    // Zealot), a condition ("If you control ... you may Engage: ..." —
    // Zealot, Kalduran Zealot), and/or a required second cost paid
    // alongside Engage itself ("Engage, X: Y" — Osteomancer); all three
    // gate whether it's even offered here, same style as Mulligan's own
    // "can't drop to 0 or below" gate.
    const ownAbilities = occupant.card.keywords?.engageAbilities || [];
    if (ownAbilities.length > 1) {
      // A card printing more than one independent Engage ability
      // (Osteomancer) — each is offered separately, gated on its own
      // cost/condition, so the player picks which one to activate.
      ownAbilities.forEach((ability, abilityIndex) => {
        const conditionOk = engageConditionMet(ability.condition, state.board, playerId, state.altars[playerId], state.groundRelics);
        const costOk = player.lifespan - (ability.lifespanCost || 0) > 0;
        const extraCostOk = engageExtraCostSacrificeCell(ability.extraCost, state.board, playerId).payable;
        if (conditionOk && costOk && extraCostOk) {
          actions.push({ type: 'ACTIVATE_ENGAGE', cellId: cell, abilityIndex });
        }
      });
    } else if (effectiveEngage(occupant)) {
      const engageKeywords = occupant.card.keywords || {};
      const conditionOk = engageConditionMet(engageKeywords.engageCondition, state.board, playerId, state.altars[playerId], state.groundRelics);
      const costOk = player.lifespan - (engageKeywords.engageLifespanCost || 0) > 0;
      const extraCostOk = engageExtraCostSacrificeCell(engageKeywords.engageExtraCost, state.board, playerId).payable;
      // A counter-gated Engage (Void Channeler: "Remove (3) Crossing
      // Counters, Engage: ...") also needs this checked here — see the
      // matching fix (and its own fuller comment) in
      // offerReactiveEngageActions above.
      const counterCost = engageKeywords.engageCounterCost;
      const counterCostOk = !counterCost || (occupant.counters?.[counterCost.type] || 0) >= counterCost.amount;
      if (conditionOk && costOk && extraCostOk && counterCostOk) {
        actions.push({ type: 'ACTIVATE_ENGAGE', cellId: cell });
      }
    }
  });

  // "Remove (X) <Type> Counters: Sacrifice this Relic, then add a <Typing>
  // Being with Conjuring cost (X) from your Purgatory to hand." (Death's
  // Decanter) — X is the player's own choice of how many Counters to spend
  // right now, offered as one discrete action per legal value (same
  // "each legal value is its own action" shape RESOLVE_MODULATE's "±1"
  // fan-out already uses), restricted to values with a real matching
  // Purgatory candidate so a guaranteed-whiff amount is never offered. Not
  // gated by engaged — the text never says Engage.
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'relic' || occupant.ownerId !== playerId) return;
    const ability = occupant.card.keywords?.removeCountersSacrificeSearchTypedCost;
    if (!ability) return;
    const have = occupant.counters?.[ability.counterType] || 0;
    for (let amount = 1; amount <= have; amount++) {
      if (purgatoryTypedBeingsWithCost(player.purgatory, ability.typing, amount).length > 0) {
        actions.push({ type: 'ACTIVATE_REMOVE_COUNTERS_SACRIFICE_SEARCH', cellId: cell, amount });
      }
    }
  });

  // "Remove (X) Crossing Counters, Engage: Restore (X) Lifespan to
  // target." (Sanative Siphon) — same "one discrete action per legal X"
  // shape as Death's Decanter above, but IS gated by engaged (a real
  // printed "Engage:") and needs no target check — restoring Lifespan is
  // always legal (the existing 'restore-lifespan-target' choice already
  // includes both players' own Lifespan as targets).
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'relic' || occupant.ownerId !== playerId || occupant.engaged) return;
    const ability = occupant.card.keywords?.removeCountersEngageRestoreLifespan;
    if (!ability) return;
    const have = occupant.counters?.[ability.counterType] || 0;
    for (let amount = 1; amount <= have; amount++) {
      actions.push({ type: 'ACTIVATE_REMOVE_COUNTERS_ENGAGE_RESTORE', cellId: cell, amount });
    }
  });

  // "You may summon Undead from your Purgatory until the end of your
  // turn." (Mausoleum Gates) — while the standing window is open
  // (summonTypedFromPurgatoryWindows), one action per matching Purgatory
  // Being, same "graceful non-offer without an empty tile" precedent as
  // every other Purgatory-summon effect.
  (player.summonTypedFromPurgatoryWindows || []).forEach(typing => {
    if (emptyMortalCellsFor(state.board, playerId).length === 0) return;
    player.purgatory
      .filter(c => c.kind === 'being' && (c.typing || '').toLowerCase().includes(typing.toLowerCase())
        // Unlike the other Purgatory-summon effects nearby (Cemetery
        // Physician, "summon a different X"), Mausoleum Gates' window is an
        // alternate SOURCE for a normal summon, not its own free reanimation
        // trigger — the Being's real casting cost still applies, same as
        // summoning it from hand (effectiveCastingCost, same choke point
        // SUMMON_BEING itself uses).
        && canPayCost(player.effigyPool, effectiveCastingCost(c, state, playerId)))
      .forEach(c => actions.push({ type: 'ACTIVATE_SUMMON_TYPED_FROM_PURGATORY_WINDOW', instanceId: c.instanceId }));
  });

  // "Once per turn sacrifice (X) <Name>: Summon a Being from your Purgatory
  // with cost (X)" (Cemetery Physician) — deliberately NOT gated by
  // occupant.engaged (unlike Martyr/Engage above): the real card text never
  // says "Engage", so tapped or not, it's usable once per turn. Only
  // offered when there's at least one of the named Relic to sacrifice and
  // at least one empty Mortal Realm tile to summon onto — matching the
  // "graceful non-offer" precedent used elsewhere (e.g.
  // altarConjureCostPayable) rather than ever offering a guaranteed-whiff.
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return;
    const sacrificeXSummon = occupant.card.keywords?.sacrificeXSummon;
    if (!sacrificeXSummon || occupant.usedSacrificeXThisTurn) return;
    if (ownedFodderCells(state.board, playerId, sacrificeXSummon.fodderName).length === 0) return;
    if (emptyMortalCellsFor(state.board, playerId).length === 0) return;
    actions.push({ type: 'ACTIVATE_SACRIFICE_X_SUMMON', cellId: cell });
  });

  // Smithing Tools: "Engage a Being, Gain (1) Forge Counter." — a bare
  // activated ability (not "Engage:" itself, so not gated by its own
  // occupant.engaged) whose cost is engaging a DIFFERENT un-Engaged Being.
  // No once-per-turn cap printed, so offered every time a legal target
  // exists — same "graceful non-offer" precedent as every other
  // conditionally-payable activated ability in this file.
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || (occupant.type !== 'being' && occupant.type !== 'relic') || occupant.ownerId !== playerId) return;
    const grant = occupant.card.keywords?.engageBeingGrantCounter;
    if (!grant) return;
    const hasTarget = Object.values(state.board).some(o => o?.type === 'being' && o.ownerId === playerId && !o.engaged);
    if (!hasTarget) return;
    actions.push({ type: 'ACTIVATE_ENGAGE_BEING_GRANT_COUNTER', cellId: cell });
  });

  // Smithing Tools' own second ability: "Engage, Remove (X) Forge Counters:
  // Add an Armament from deck to hand with conjuring cost (X)." — a real
  // printed "Engage" (taps itself), gated by occupant.engaged like any
  // other. Offered whenever it holds at least 1 of the matching counter —
  // paying X=0 would be legal but pointless, so requiring at least 1 avoids
  // offering a guaranteed-whiff button (same precedent altarConjureCostPayable
  // already established elsewhere).
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'relic' || occupant.ownerId !== playerId || occupant.engaged) return;
    const ability = occupant.card.keywords?.removeCountersXSearchArmament;
    if (!ability || (occupant.counters?.[ability.counterType] || 0) === 0) return;
    actions.push({ type: 'ACTIVATE_REMOVE_COUNTERS_X_SEARCH_ARMAMENT', cellId: cell });
  });

  // "Twice per turn Modulate (±1)." (MetaToris) — a bare activated ability,
  // no "Engage:", so also not gated by occupant.engaged, same reasoning as
  // Cemetery Physician's own sacrifice ability above. Offered whenever uses
  // remain, with no pre-check on the effect's own legal target (matching
  // how a bare "Engage: X" is already offered unconditionally elsewhere —
  // resolveOrLogEffect gracefully logs "no Prophecy to Modulate" on its
  // own if there's nothing to target, still consuming the use, same as an
  // Engage with no valid target still taps).
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return;
    const ability = occupant.card.keywords?.timesPerTurnAbility;
    if (!ability || (occupant.timesPerTurnUsed || 0) >= ability.times) return;
    actions.push({ type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: cell });
  });

  // "Pay (N) <Color>: <effect>" (Blooming Seed), or "Burn (N) <Color>: X"
  // (Skeleton Key, a Relic printing the identical shape) — a bare activated
  // ability costed by real Effigy straight out of the pool, no Engage and
  // no "times per turn" cap (usable every time it's affordable, same as a
  // plain Engage with no printed limit), so it's not gated by
  // occupant.engaged either. Not Being-only — a standalone Relic can print
  // this shape too (RULES.md's card types table only calls out summoning
  // sickness for Beings, so a Relic has no extra restriction here either).
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || (occupant.type !== 'being' && occupant.type !== 'relic') || occupant.ownerId !== playerId) return;
    const ability = occupant.card.keywords?.payEffigyCostAbility;
    if (!ability) return;
    // Metal Worker: "Once per turn, you may Pay..." — reuses the same
    // timesPerTurnUsed counter/reset timesPerTurnAbility already relies on
    // (turn.js clears it unconditionally at the start of the controller's
    // own turn), just capped at 1 instead of a printed N.
    if (ability.once && (occupant.timesPerTurnUsed || 0) >= 1) return;
    const have = payablePool(player.effigyPool).filter(e => e.effigyType === ability.color).length;
    const cost = Math.max(0, ability.amount - pointedActivationCostReduction(state, playerId, cell, ability.color));
    if (have < cost) return;
    actions.push({ type: 'ACTIVATE_PAY_EFFIGY_COST_ABILITY', cellId: cell });
  });

  // Sha-KaRah: "Pay (5) Lifespan to move an adjacent Armament one tile in
  // any direction." — a bare activated ability costed by real Lifespan
  // instead of Effigy (payLifespanCostAbility, cardData.js), same
  // no-Engage/no-cap treatment as payEffigyCostAbility above. Floored so it
  // can't drop the caster to 0 Lifespan, same "can't drop to 0" gate every
  // other optional Lifespan cost in this file already uses.
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return;
    const ability = occupant.card.keywords?.payLifespanCostAbility;
    if (!ability) return;
    if (player.lifespan - ability.amount <= 0) return;
    actions.push({ type: 'ACTIVATE_PAY_LIFESPAN_COST_ABILITY', cellId: cell });
  });

  // "Remove (N) <Type> Counter(s): Sacrifice this, <effect>" (Blooming
  // Seed) — a Martyr-shaped ability gated by a counter cost instead of
  // Martyr's own unconditional availability, and (like the pay-Effigy
  // ability above) not gated by occupant.engaged since it never says
  // "Engage".
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return;
    const ability = occupant.card.keywords?.counterCostSacrificeAbility;
    if (!ability) return;
    if ((occupant.counters?.[ability.type] || 0) < ability.amount) return;
    actions.push({ type: 'ACTIVATE_COUNTER_COST_SACRIFICE', cellId: cell });
  });

  // Roots of Eternity: "Once per turn you may sacrifice a Vine token,
  // summon this from Purgatory on the tile that the sacrificed vine token
  // was on" — an activated ability that lives on a card SITTING IN
  // PURGATORY, not the board (no occupant to hang engaged/tapped state
  // off of). Offered once per real matching TOKEN the player controls on
  // board (each is its own legal choice, since the destination tile is
  // wherever that specific token was standing) — gated per-turn by card
  // name on the player themselves (reanimatedFromPurgatoryThisTurn, reset
  // in beginTurn/turn.js), since the card's own identity moves between
  // Purgatory and the board and can't carry a stable per-occupant flag the
  // way a normal "times per turn" ability does.
  player.purgatory.forEach(card => {
    const reaction = card.keywords?.reanimateOnSacrificedTypedToken;
    if (!reaction || (player.reanimatedFromPurgatoryThisTurn || []).includes(card.name)) return;
    Object.entries(state.board).forEach(([cell, o]) => {
      if (!o || o.type !== 'being' || o.ownerId !== playerId || !o.card.isToken) return;
      if (!(o.card.typing || '').toLowerCase().includes(reaction.typing.toLowerCase())) return;
      actions.push({ type: 'ACTIVATE_REANIMATE_FROM_PURGATORY', purgatoryInstanceId: card.instanceId, sacrificeCellId: cell });
    });
  });

  // Animated Armaments (RULES.md > Keywords) — the topmost entry of a
  // Being-less pile acts as a Being of its own: it can move and attack,
  // gated by its own `engaged` flag (the same per-entry one
  // ACTIVATE_ARMAMENT_ENGAGE already tracks) rather than a whole
  // occupant's. None of a real Being's other abilities (Martyr, a generic
  // granted/printed Engage ability) apply to it.
  Object.entries(state.board).forEach(([cell, occupant]) => {
    const top = animatedTopEntry(occupant);
    if (!top || occupant.ownerId !== playerId || top.engaged) return;

    const attackCell = computeAttackCell(playerId, cell);
    if (attackCell) {
      actions.push({ type: 'MOVE_OR_ATTACK', fromCellId: cell, toCellId: attackCell, isAttack: true });
    }
    (top.card.arrows || []).forEach(direction => {
      const toCellId = computeMoveDestination(playerId, cell, direction);
      if (!toCellId || !emptyOrOwnArmamentStack(state.board[toCellId], playerId)) return;
      actions.push({ type: 'MOVE_OR_ATTACK', fromCellId: cell, toCellId, direction, isAttack: false });
    });
  });

  // Relics can carry "Engage: X" text too (e.g. "Dial of Metatoris"). Unlike
  // Beings, a placed Relic has no summoning-sickness rule (RULES.md's card
  // types table only calls that out for Beings), so it can Engage the same
  // turn it's placed.
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'relic' || occupant.ownerId !== playerId || occupant.engaged) return;
    if (occupant.card.keywords?.engage) {
      // "If you control ... you may Engage" condition (a borrowed textbox
      // via Wretched Remnants can carry one, e.g. condition: 'faithless-
      // only') — same missing-check bug as offerReactiveEngageActions
      // above, fixed the same way: the reducer's shared engageConditionMet
      // check applies to a Relic's Engage exactly like a Being's, so the
      // offer must check it too or a condition-failing Engage stays
      // "legal" forever (silent no-op every time, looks identical to
      // progress to the AI).
      const conditionOk = engageConditionMet(occupant.card.keywords?.engageCondition, state.board, playerId, state.altars[playerId], state.groundRelics);
      // "Pay (N) Lifespan, Engage: X" applies to a Relic's own Engage too,
      // not just a Being's (Lesser Summoning Circle) — same "can't drop to
      // 0 or below" gate the Being-side scan above already uses.
      const lifespanCostOk = player.lifespan - (occupant.card.keywords?.engageLifespanCost || 0) > 0;
      const extraCostOk = engageExtraCostSacrificeCell(occupant.card.keywords?.engageExtraCost, state.board, playerId).payable;
      const counterCost = occupant.card.keywords?.engageCounterCost;
      const counterCostOk = !counterCost || (occupant.counters?.[counterCost.type] || 0) >= counterCost.amount;
      // A bare "Engage: Remove (N) <Type> Counters, then X" (Hourglass) has
      // its counter-spend inside the *effect* text, not captured as its own
      // `engageCounterCost` field (that shape is for "Remove... Counters:
      // Engage..." — the cost before the colon, e.g. Crucible) — checked
      // directly here too so Engaging it isn't offered as a wasted tap when
      // it can't actually afford its own effect.
      const ownEffectCounterMatch = occupant.card.keywords.engage.match(REMOVE_OWN_COUNTERS_RE);
      const ownEffectCounterOk = !ownEffectCounterMatch
        || (occupant.counters?.[ownEffectCounterMatch[2].toLowerCase()] || 0) >= parseInt(ownEffectCounterMatch[1], 10);
      if (conditionOk && lifespanCostOk && extraCostOk && counterCostOk && ownEffectCounterOk) {
        actions.push({ type: 'ACTIVATE_ENGAGE', cellId: cell });
      }
    }
    // A Relic can print a bare "Martyr" too (Bag o' Bones) — engage and
    // sacrifice it, same as a Being's Martyr, just with no effect text to
    // resolve afterward for this specific card (see ACTIVATE_MARTYR).
    if (occupant.card.keywords?.martyr != null && martyrCostPayable(occupant, player.effigyPool)) {
      actions.push({ type: 'ACTIVATE_MARTYR', cellId: cell });
    }
  });

  // A "Beings may move across this" Relic (RULES.md > Keywords) lives in
  // groundRelics instead of board, but can still carry its own Engage
  // ability (Shifting Sands: "Remove (1) Crossing Counter, then move
  // target Being you control to this tile") — same no-summoning-sickness
  // rule as any other Relic's Engage, gracefully not offered if it can't
  // actually afford its own counter cost right now.
  Object.entries(state.groundRelics).forEach(([cell, occupant]) => {
    if (!occupant || occupant.ownerId !== playerId || occupant.engaged) return;
    if (!occupant.card.keywords?.engage) return;
    if (!groundRelicEngageCostPayable(occupant, player, playerId, cell, state.board)) return;
    actions.push({ type: 'ACTIVATE_GROUND_RELIC_ENGAGE', cellId: cell });
  });

  // Armaments are independently engageable permanents of their own (e.g.
  // "Feathers of the Fallen": "Engage: Remove (1) Crossing Counter, then
  // move attached Being one tile in any direction.") — distinct from a
  // *granted* Engage (see effectiveEngage above), which is the attached
  // Being's own action. An Armament's own Engage has no summoning-sickness
  // rule either, same as a Relic's, and works whether it's attached to a
  // Being or still sitting in a freestanding pile.
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || (occupant.type !== 'being' && occupant.type !== 'armament-stack') || occupant.ownerId !== playerId) return;
    (occupant.armaments || []).forEach(a => {
      if (!a.engaged && a.card.keywords?.engage) {
        actions.push({ type: 'ACTIVATE_ARMAMENT_ENGAGE', cellId: cell, armamentInstanceId: a.card.instanceId });
      }
    });
  });

  // "Sacrifice this to give attached being a Favored Counter until the end
  // of turn" (Mahka-Rahva's Tiger Skin) — not Engage-costed at all, so it's
  // available regardless of engaged state, but only when there's an
  // attached Being to actually give the Favor Counter to.
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return;
    (occupant.armaments || []).forEach(a => {
      if (a.card.keywords?.sacrificeForFavored) {
        actions.push({ type: 'ACTIVATE_ARMAMENT_SACRIFICE', cellId: cell, armamentInstanceId: a.card.instanceId });
      }
    });
  });

  // Armor Animus/HeartWood Locket: "Martyr: X" printed on an attached
  // Armament ITSELF, not the wearer — engaging and sacrificing the
  // Armament (not the wearer) the same way a board Being/Relic's own bare
  // Martyr already works (effectiveMartyr/martyrCostPayable), just scoped
  // to one entry in a `armaments` array instead of a whole occupant.
  Object.entries(state.board).forEach(([cell, occupant]) => {
    if (!occupant || (occupant.type !== 'being' && occupant.type !== 'armament-stack') || occupant.ownerId !== playerId) return;
    (occupant.armaments || []).forEach(a => {
      if (a.card.keywords?.martyr != null && martyrCostPayable(a, player.effigyPool)) {
        actions.push({ type: 'ACTIVATE_ARMAMENT_MARTYR', cellId: cell, armamentInstanceId: a.card.instanceId });
      }
    });
  });

  actions.push({ type: 'PASS_TURN' });
  return actions;
};

// Attack declaration (Phase 3 of the priority-window rework — see the
// approved plan): MOVE_OR_ATTACK's own normal `isAttack` branch now
// declares first instead of calling resolveAttackFrom (below) directly —
// validates the attacker and applies the RULES-mandated "starting an
// attack engages it" flip immediately, then defers the actual combat
// resolution behind a real priority window (state.pendingResolution,
// resolved by resolvePendingResolution once the window closes). Strike
// Down (RULES.md > Conjurings' own documented gap: "this Conjuring isn't
// reactive to [combat]... no instant-speed window yet") finally becomes
// legal specifically here, before combat damage lands.
//
// Desperate Finale's own forced attack (resolveDesperateFinale, above)
// deliberately keeps calling resolveAttackFrom directly, bypassing this
// declare step (and the window) entirely — same established "bypasses
// the normal engaged gate" precedent that function already documents for
// itself, just extended to the new window too: that forced attack was
// never interruptible before, and making it so now would also break its
// own immediate post-attack survival check (it reads next.board right
// after calling resolveAttackFrom, assuming combat has already fully
// resolved).
const declareAttackFrom = (state, playerId, fromCellId) => {
  const occupant = state.board[fromCellId];
  const isBeing = occupant?.type === 'being';
  const attackerTop = animatedTopEntry(occupant);
  if (!occupant || occupant.ownerId !== playerId || !(isBeing || attackerTop)) return state;
  const actorCard = isBeing ? occupant.card : attackerTop.card;
  if (actorCard.keywords?.cannotAttack) return state; // Training dummy
  const toCellId = computeAttackCell(playerId, fromCellId);
  if (!toCellId) return state;

  let next = {
    ...state,
    board: { ...state.board, [fromCellId]: writeActorState(occupant, { engaged: true }) },
  };
  next = addLog(next, `${playerId} declares an attack with ${actorCard.name}.`);
  return {
    ...next,
    pendingResolution: { kind: 'attack', declaringPlayer: playerId, fromCellId, cardName: actorCard.name },
  };
};

// Resolves a Being (or Animated Armament) attacking from `fromCellId` —
// the exact logic MOVE_OR_ATTACK's own `isAttack` branch uses, factored
// out so Desperate Finale's own "That Being fights without engaging" can
// reuse it directly for an ALREADY-Engaged Being (bypassing
// MOVE_OR_ATTACK's own engaged gate, which callers other than
// MOVE_OR_ATTACK itself never see) — and so resolvePendingResolution's own
// 'attack' kind can call it once a declared attack's priority window
// closes (see declareAttackFrom above). Self-contained — re-derives
// everything from `state`/`fromCellId` rather than taking any pre-computed
// locals, so it's safe to call from anywhere, including fresh off a
// possibly-changed board after a reactive response. Returns `state`
// unchanged if there's no real attacker at `fromCellId`, it can't attack
// (Training dummy's own cannotAttack), or there's no attack lane (not in
// the front row). `noDamage` (Strike Down's own "the attacking Being
// deals no damage" — see STRIKE_DOWN_RE's resolution, which stashes
// `noDamage: true` onto the SAME pendingResolution its own declare step
// opened) zeroes the attacker's own damage output once the lane it was
// attacking into has already been emptied by that same Conjuring —
// mutual combat itself is never affected (a destroyed blocker means the
// mutual-combat branch below can't even trigger anymore; only the open-
// lane branch needs this).
const resolveAttackFrom = (state, playerId, fromCellId, noDamage = false) => {
  const occupant = state.board[fromCellId];
  const isBeing = occupant?.type === 'being';
  const attackerTop = animatedTopEntry(occupant);
  if (!occupant || occupant.ownerId !== playerId || !(isBeing || attackerTop)) return state;
  const actorCard = isBeing ? occupant.card : attackerTop.card;
  if (actorCard.keywords?.cannotAttack) return state; // Training dummy
  const toCellId = computeAttackCell(playerId, fromCellId);
  if (!toCellId) return state;

  const target = state.board[toCellId];
  // Read-only combat views — reused unchanged by combat.js's helpers
  // whether each side is a real Being or an Animated Armament acting
  // as one; all writes below go back through the real occupant/target.
  const attackerView = actorView(occupant);
  const defenderView = actorView(target);

  // Unruly: "Whenever this Being attacks, lose Lifespan equal to its
  // current Strength." (Unruly Fiend's own spelled-out real text: "When
  // Unruly Fiend attacks you lose (X) Lifespan where (X) is it's current
  // strength") — a real cost of attacking at all, unconditional on the
  // outcome (open lane, mutual combat, even its own death moments later).
  // Reassigns `state` itself so every read below (board/players) sees it.
  if (isBeing && actorCard.keywords?.unruly) {
    const loss = effectiveStrength(attackerView);
    const owner = state.players[playerId];
    state = addLog(
      { ...state, players: { ...state.players, [playerId]: { ...owner, lifespan: owner.lifespan - loss } } },
      `${actorCard.name}'s Unruly triggers: ${playerId} loses ${loss} Lifespan.`
    );
  }

  // An attack never relocates the attacker — it stays in its lane on
  // its own side, whether it hits a defender or the opponent directly.
  // `let`, not `const`: a death branch below reassigns it from
  // `next.board` right after Depart fires, so a "Summon a token on
  // this tile" effect and the *other* side's own death branch both
  // keep seeing the up-to-date board (see the reassignment comments).
  let board = { ...state.board };

  // Only an opposing Being — or an Animated Armament acting as one —
  // blocks an attack (RULES.md > Combat). A Relic or non-Animated
  // freestanding Armament pile doesn't: it's left completely
  // untouched, same as if the lane were empty, and the attack goes
  // straight through to the opponent's Lifespan.
  if (!target || !defenderView) {
    const opponentId = playerId === 'A' ? 'B' : 'A';
    const opponent = state.players[opponentId];
    board[fromCellId] = writeActorState(occupant, { engaged: true });
    const laneDesc = !target
      ? 'an open lane'
      : target.type === 'relic'
        ? `past ${target.card.name} (a Relic doesn't block)`
        : "past a freestanding Armament pile (doesn't block)";
    // Strike Down: "the attacking Being deals no damage" — a full
    // negation, not "0 damage that still counts as dealt," so this skips
    // straight past Degrisch Vassal's own damage-to-Effigy conversion
    // below too (there's no damage for it to convert). checkWin still
    // runs for symmetry with every other branch here, though a no-damage
    // attack can never itself be what wins the game.
    if (noDamage) {
      let next = addLog({ ...state, board }, `${actorCard.name} attacks into ${laneDesc}, but Strike Down negates all of its damage.`);
      next = triggerAllyFightsReactions(next, playerId, fromCellId);
      return checkWin(next);
    }
    const attackDamage = effectiveStrength(attackerView);
    // Degrisch Vassal: "When this Being deals damage to an opponent,
    // prevent that damage and craft (X) Effigies where (X) is the damage
    // that would have been dealt." — ruled: this straight-through branch
    // IS "deals damage to an opponent" (the only case a Being's own
    // damage actually lands on the opponent's Lifespan directly, rather
    // than on another Being or its own controller's death loss).
    if (actorCard.keywords?.preventOpenLaneDamageCraftEffigy) {
      const attacker = state.players[playerId];
      let deck = attacker.effigyDeck;
      let pool = attacker.effigyPool;
      let crafted = 0;
      for (let i = 0; i < attackDamage && deck.length > 0; i++) {
        pool = [...pool, deck[0]];
        deck = deck.slice(1);
        crafted++;
      }
      let next = {
        ...state,
        board,
        players: { ...state.players, [playerId]: { ...attacker, effigyDeck: deck, effigyPool: pool } },
      };
      next = addLog(next, `${actorCard.name} attacks into ${laneDesc}: its ${attackDamage} damage to ${opponentId} is prevented, crafting ${crafted} Effigy for ${playerId} instead.`);
      next = triggerAllyFightsReactions(next, playerId, fromCellId);
      return checkWin(next);
    }
    let next = {
      ...state,
      board,
      players: {
        ...state.players,
        [opponentId]: { ...opponent, lifespan: opponent.lifespan - attackDamage },
      },
    };
    next = addLog(next, `${actorCard.name} attacks into ${laneDesc}, dealing ${attackDamage} damage to ${opponentId}.`);
    next = triggerAllyFightsReactions(next, playerId, fromCellId);
    return checkWin(next);
  }

  // Occupied lane: mutual combat. A Favor Counter on either side fully
  // prevents that side's damage instance (RULES.md > Keywords >
  // Favored), consuming the counter instead of applying the damage —
  // an Animated Armament can never carry one (favorCounter only ever
  // lives on a real `being` occupant), so this naturally never applies
  // to it without any special-casing.
  const attackerFavored = !!occupant.favorCounter;
  const defenderFavored = !!target.favorCounter;
  const rawCombat = resolveMutualCombat(attackerView, defenderView);
  const attackerLifespanAfter = attackerFavored ? attackerView.currentLifespan : rawCombat.attackerLifespanAfter;
  const defenderLifespanAfter = defenderFavored ? defenderView.currentLifespan : rawCombat.defenderLifespanAfter;

  let next = { ...state };
  next = addLog(next, `${actorCard.name} attacks ${defenderView.card.name}: ${effectiveStrength(defenderView)} damage to attacker, ${effectiveStrength(attackerView)} damage to defender.`);
  if (attackerFavored) next = addLog(next, `${actorCard.name}'s Favor Counter prevents the damage to it.`);
  if (defenderFavored) next = addLog(next, `${defenderView.card.name}'s Favor Counter prevents the damage to it.`);

  const attackerDies = attackerLifespanAfter <= 0;
  const defenderDies = defenderLifespanAfter <= 0;

  if (!attackerDies) {
    board[fromCellId] = writeActorState(occupant, {
      currentLifespan: attackerLifespanAfter, engaged: true, ...(isBeing ? { favorCounter: false } : {}),
    });
  } else {
    const dmg = deathDamageFor(attackerView);
    const realAttackerCard = realCardFor(occupant, attackerView);
    const owner = next.players[playerId];
    next = {
      ...next,
      players: {
        ...next.players,
        [playerId]: { ...owner, lifespan: owner.lifespan - dmg, purgatory: purgatoryAfterAdding(owner.purgatory, realAttackerCard) },
      },
    };
    next = addLog(next, `${realAttackerCard.name} dies; ${playerId} takes ${dmg} Lifespan damage.`);
    if (isBeing) next = incrementBeingsDiedThisTurn(next, playerId);
    // Vacate the cell in `next.board` before Depart fires — see the
    // dealDamageToBeing comment above for why.
    const attackerPriorArmaments = occupant.armaments;
    if (isBeing) dropArmamentsOrDryadMount(board, fromCellId, occupant);
    else dropAnimatedTop(board, fromCellId, occupant);
    next = logDepartIfPresent({ ...next, board }, { card: attackerView.card, ownerId: playerId, grantedDepart: occupant.grantedDepart }, fromCellId);
    // Onoushara's own reaction reads/writes next.board directly — run
    // it only after `board` (this branch's own local snapshot) has
    // already been folded into `next` above, or this would silently
    // clobber the write right back with the stale pre-Depart board.
    if (isBeing) next = triggerOnAttachedBeingDied(next, playerId, fromCellId, attackerPriorArmaments);
    if (isBeing) next = triggerOwnBeingDiedReactions(next, playerId);
    if (isBeing) next = triggerAnyBeingDiedCounterGain(next);
    if (isBeing) next = triggerAnyBeingDiedGiveDifferentBuff(next, playerId);
    if (isBeing) next = triggerDeckSearchOnTypedDeath(next, playerId, attackerView.card.typing);
    if (isBeing) next = triggerWretchedRemnantsOffer(next, playerId, attackerView.card);
    if (isBeing) next = triggerEchoesOfBoundlessOffer(next, playerId, attackerView.card);
    board = next.board;
  }

  if (!defenderDies) {
    board[toCellId] = writeActorState(target, {
      currentLifespan: defenderLifespanAfter, ...(target.type === 'being' ? { favorCounter: false } : {}),
    });
  } else {
    const dmg = deathDamageFor(defenderView);
    const realDefenderCard = realCardFor(target, defenderView);
    const owner = next.players[target.ownerId];
    next = {
      ...next,
      players: {
        ...next.players,
        [target.ownerId]: { ...owner, lifespan: owner.lifespan - dmg, purgatory: purgatoryAfterAdding(owner.purgatory, realDefenderCard) },
      },
    };
    next = addLog(next, `${realDefenderCard.name} dies; ${target.ownerId} takes ${dmg} Lifespan damage.`);
    if (target.type === 'being') next = incrementBeingsDiedThisTurn(next, target.ownerId);
    const defenderPriorArmaments = target.armaments;
    if (target.type === 'being') dropArmamentsOrDryadMount(board, toCellId, target);
    else dropAnimatedTop(board, toCellId, target);
    next = logDepartIfPresent({ ...next, board }, { card: defenderView.card, ownerId: target.ownerId, grantedDepart: target.grantedDepart }, toCellId);
    // Same ordering fix as the attacker branch above — after `board`
    // is already folded into `next`, not before.
    if (target.type === 'being') next = triggerOnAttachedBeingDied(next, target.ownerId, toCellId, defenderPriorArmaments);
    if (target.type === 'being') next = triggerOwnBeingDiedReactions(next, target.ownerId);
    if (target.type === 'being') next = triggerAnyBeingDiedCounterGain(next);
    if (target.type === 'being') next = triggerAnyBeingDiedGiveDifferentBuff(next, target.ownerId);
    if (target.type === 'being') next = triggerDeckSearchOnTypedDeath(next, target.ownerId, defenderView.card.typing);
    if (target.type === 'being') next = triggerWretchedRemnantsOffer(next, target.ownerId, defenderView.card);
    if (target.type === 'being') next = triggerEchoesOfBoundlessOffer(next, target.ownerId, defenderView.card);
    board = next.board;
  }

  next = { ...next, board };
  // Return the Favor's own reaction — same "second trigger waits
  // rather than silently clobbering the first pendingChoice" precedent
  // logDepartIfPresent already follows, for the rare case both sides
  // were Favored in the same combat.
  if (isBeing && attackerFavored) next = triggerReturnTheFavorReaction(next, playerId, fromCellId);
  if (target.type === 'being' && defenderFavored) {
    next = next.pendingChoice
      ? addLog(next, `Return the Favor doesn't resolve again — still waiting on an earlier choice.`)
      : triggerReturnTheFavorReaction(next, target.ownerId, toCellId);
  }
  next = triggerAllyFightsReactions(next, playerId, fromCellId);
  // Formless Fangs: "Any Being dealt damage by this Shifts (X)." — ruled:
  // fires for whichever side it DIDN'T occupy, only if THAT side survived
  // the damage — its own survival is irrelevant (even if Formless Fangs
  // itself died in this same combat, the Being it hit still Shifts if it
  // lived). Never fires for open-lane damage (that branch already
  // returned above) since it only ever hits the opponent's Lifespan
  // directly, never a Being.
  const attackerForcesShift = actorCard.keywords?.onDealsCombatDamageForceShift;
  if (attackerForcesShift && !defenderDies && next.board[toCellId]?.type === 'being') {
    next = offerOrPerformShift(next, target.ownerId, toCellId, { amount: attackerForcesShift, effect: null });
  }
  const defenderForcesShift = defenderView.card.keywords?.onDealsCombatDamageForceShift;
  if (defenderForcesShift && !attackerDies && next.board[fromCellId]?.type === 'being') {
    next = offerOrPerformShift(next, occupant.ownerId, fromCellId, { amount: defenderForcesShift, effect: null });
  }
  return checkWin(next);
};

// -- Reducer ------------------------------------------------------------------

const gameReducerCore = (state, action) => {
  // A pending search/Modulate effect blocks every other action until it's
  // resolved — see getLegalActions, which is what the UI/AI actually
  // dispatch from; this is just a defensive backstop against a stale action
  // slipping through.
  const PENDING_CHOICE_ACTION_TYPES = [
    'RESOLVE_CHOICE', 'RESOLVE_MODULATE', 'RESOLVE_DAMAGE_TARGET', 'RESOLVE_FREE_MOVE',
    'RESOLVE_BOTTOM_OF_DECK', 'RESOLVE_SHUFFLE_OR_KEEP', 'RESOLVE_REVEAL_PROPHECY',
    'RESOLVE_SACRIFICE', 'RESOLVE_SACRIFICE_ARMAMENT', 'RESOLVE_SACRIFICE_DESTROY', 'RESOLVE_GRANT_FAVOR', 'RESOLVE_BUFF_ALLY',
    'RESOLVE_SHUFFLE_OR_DRAW', 'RESOLVE_COPY_STATS', 'RESOLVE_DOESNT_DISENGAGE', 'RESOLVE_DECLINE',
    'RESOLVE_TOKEN_LOCATION', 'RESOLVE_SUMMON_FROM_PURGATORY', 'RESOLVE_MOVE_TARGET_BEING',
    'RESOLVE_SACRIFICE_X_TOGGLE', 'RESOLVE_SACRIFICE_X_CONFIRM', 'RESOLVE_SUMMON_FROM_PURGATORY_COST',
    'RESOLVE_DESTROY_PERMANENT', 'RESOLVE_DESTROY_ARMAMENT', 'RESOLVE_DISCARD_KIND_DRAW', 'RESOLVE_STRENGTH_SET_EOT',
    'RESOLVE_RETURN_TO_HAND', 'RESOLVE_CHOOSE_ESSENCE_COLOR', 'RESOLVE_SACRIFICE_BEING_COST', 'RESOLVE_SACRIFICE_TYPED_COST',
    'RESOLVE_ENGAGE_BEING_COST', 'RESOLVE_GRANT_MARTYR_TARGET', 'RESOLVE_SUMMON_HAND_BEING_POINTED', 'RESOLVE_CONJURE_PROPHECY_PURGATORY',
    'RESOLVE_CREATE_TOKEN_CHOICE', 'RESOLVE_ETHEREAL_TOKEN_LOCATION', 'RESOLVE_END_OF_TURN_DAMAGE_NAMED_FAMILY_TARGET',
    'RESOLVE_SELECT_MOVE_SOURCE', 'RESOLVE_ENGAGE_BUFF_EOT', 'RESOLVE_ENGAGE_THEN_MOVE', 'RESOLVE_ENGAGE_MOVE_TWICE', 'RESOLVE_SACRIFICE_ARMAMENT_DAMAGE',
    'RESOLVE_DISCARD_CHOSEN_COST_REDUCTION', 'RESOLVE_TIME_COUNTER_BLOCK_MOVE',
    'RESOLVE_SACRIFICE_ANY_BEINGS_TOGGLE', 'RESOLVE_SACRIFICE_ANY_BEINGS_CONFIRM',
    'RESOLVE_DISCARD_X_NAMED_TOGGLE', 'RESOLVE_DISCARD_X_NAMED_CONFIRM', 'RESOLVE_FREEZE_FRAME_TARGET',
    'RESOLVE_SHUFFLE_PURGATORY_INTO_DECK',
    'RESOLVE_ADD_COUNTER_RELIC_TARGET', 'RESOLVE_SACRIFICE_RELIC_COST', 'RESOLVE_VYU_BHATA_TARGET',
    'RESOLVE_SACRIFICE_POINTED_TARGET', 'RESOLVE_SACRIFICE_TYPED_COST_LIMIT',
    'RESOLVE_DROWN_SCREAMS_TARGET', 'RESOLVE_DENDRIFY_TARGET', 'RESOLVE_ANIMATE_RELIC_TARGET', 'RESOLVE_RECOLLECT_TARGET', 'RESOLVE_LEGEND_RULE_KEEP',
    'RESOLVE_DESTROY_RELIC_TARGET', 'RESOLVE_PAY_LIFESPAN_OPTIONAL', 'RESOLVE_MOVE_FORWARD_TARGET',
    'RESOLVE_STRENGTH_DEBUFF_TARGET', 'RESOLVE_RETURN_THE_FAVOR_TARGET', 'RESOLVE_LIFESPAN_DAMAGE_FIRST_TARGET', 'RESOLVE_LIFESPAN_DAMAGE_SECOND_TARGET',
    'RESOLVE_DIABLERIE_SELECT_MOVER', 'RESOLVE_DIABLERIE_MOVE_DESTINATION', 'RESOLVE_DIABLERIE_DONE',
    'RESOLVE_SACRIFICE_RELIC_COST_TARGET', 'RESOLVE_SUMMON_TOKEN_POINTED', 'RESOLVE_SACRIFICE_THIS_OPTIONAL',
    'RESOLVE_COPY_ENGAGE_TARGET', 'RESOLVE_TRIGGER_DEPART_TARGET', 'RESOLVE_DESPERATE_FINALE_TARGET', 'RESOLVE_MAY_SUMMON_VINE_POINTED', 'RESOLVE_MINUS_COUNTER_TARGET',
    'RESOLVE_INVOKE_CARD_CHOICE', 'RESOLVE_INVOKE_DESTINATION', 'RESOLVE_DAMAGE_TARGET_PLAYER',
    'RESOLVE_ADD_COUNTER_TYPED_POINTED_TARGET', 'RESOLVE_MOVE_ARMAMENT_SOURCE', 'RESOLVE_MOVE_ARMAMENT_DESTINATION',
    'RESOLVE_SHUFFLE_PURGATORY_TOGGLE', 'RESOLVE_SHUFFLE_PURGATORY_CONFIRM',
    'RESOLVE_RESTORE_OR_SUMMON_VINE', 'RESOLVE_RESTORE_LIFESPAN_TARGET', 'RESOLVE_RESTORE_LIFESPAN_TARGET_PLAYER',
    'RESOLVE_SUMMON_VINE_TOKENS_TOGGLE', 'RESOLVE_SUMMON_VINE_TOKENS_CONFIRM',
    'RESOLVE_MOVE_ARMAMENT_ANY_SOURCE', 'RESOLVE_DEBUFF_PER_OWN_DEATH_TARGET', 'RESOLVE_SUMMON_DIFFERENT_TYPED_FROM_PURGATORY',
    'RESOLVE_COPY_TEXTBOX_UNTIL_END_OF_TURN', 'RESOLVE_ENGAGE_EFFIGY_ADD_ESSENCE',
    'RESOLVE_SHIFT_DESTINATION', 'RESOLVE_SHIFT_RETURN',
    'RESOLVE_GIVE_DIFFERENT_TYPED_BUFF', 'RESOLVE_FORCE_SHIFT_TARGET', 'RESOLVE_COPY_OPPONENT_EFFECT',
    'RESOLVE_ECHOES_BOUNDLESS_SHIFT_INSTEAD', 'RESOLVE_SHIFT_FROM_PURGATORY_DESTINATION', 'RESOLVE_UDARIK_SHIFT_TARGET',
    'RESOLVE_DEJA_VU_TARGET', 'RESOLVE_SUMMON_SACRIFICE_COST', 'RESOLVE_DISCARD_BEING_DRAW_BONUS',
    'RESOLVE_DISCARD_THEN_SEARCH_PURGATORY', 'RESOLVE_DISCARD_ONE_CARD', 'RESOLVE_DISCARD_TYPED',
    'RESOLVE_SWITCH_WITH_TYPED', 'RESOLVE_FORCE_COMBAT_SELECT_MINE', 'RESOLVE_FORCE_COMBAT_SELECT_THEIRS',
    'RESOLVE_CHOOSE_X_VALUE', 'RESOLVE_CHOOSE_PROPHECY_TIMER', 'RESOLVE_DESTROY_POINTED_SUMMON_TOKEN',
    'RESOLVE_FAVOR_POINTED_TOGGLE', 'RESOLVE_FAVOR_POINTED_CONFIRM',
    'RESOLVE_TEETH_BOUNDS_SACRIFICE_HUNGER', 'RESOLVE_TEETH_BOUNDS_TIE_CHOICE', 'RESOLVE_MIDNIGHT_MASS_SACRIFICE_TARGET',
    'RESOLVE_LEGION_ONSET_CHOOSE_COUNT', 'RESOLVE_ENGAGE_GRANT_COUNTER_SOURCE', 'RESOLVE_MOVE_ADJACENT_ARMAMENT_SOURCE',
    'RESOLVE_AFTERIMAGE_TARGET',
    // Not a real choice — the revealPopup overlay (Match.jsx) is purely
    // informational (see REVEAL_TOP_SEED_RE's own comment above), so
    // dismissing it must always work even while an unrelated real
    // pendingChoice also happens to be open.
    'DISMISS_REVEAL_POPUP',
  ];
  if (state.pendingChoice && !PENDING_CHOICE_ACTION_TYPES.includes(action.type)) return state;
  // A reactive window (see manageReactiveWindow, below) only ever legally
  // resolves via one of these action types — mirrors the pendingChoice
  // whitelist immediately above. Casting an Ethereal Conjuring or
  // activating an Engage ability are both "ethereal speed" (the getLegalActions
  // reactiveWindow branch above only ever offers these plus PASS_PRIORITY
  // in the first place — this is just the matching defensive re-check).
  // Deliberately excludes MOVE_OR_ATTACK and ACTIVATE_SHIFT — attacking,
  // moving, and Shifting all stay conjuring/sorcery-speed, main-phase only
  // (confirmed with the user). The reactiveWindow/pendingChoice states
  // can't actually coexist (a reactiveWindow only ever opens once
  // state.pendingChoice is null, and this file forces it null again the
  // instant a new pendingChoice opens), but this is ordered defensively
  // right after that check anyway.
  if (state.reactiveWindow && !['CAST_CONJURING', 'PASS_PRIORITY', 'ACTIVATE_ENGAGE', 'ACTIVATE_GROUND_RELIC_ENGAGE', 'ACTIVATE_ARMAMENT_ENGAGE'].includes(action.type)) return state;

  switch (action.type) {
    case 'MULLIGAN': {
      const player = state.players[action.player];
      if (state.phase !== 'mulligan' || player.keptHand) return state;
      if (player.lifespan - MULLIGAN_COST <= 0) return state;
      const combined = [...player.mainDeck, ...player.hand];
      const reshuffled = combined
        .map(c => ({ c, sort: Math.random() }))
        .sort((a, b) => a.sort - b.sort)
        .map(({ c }) => c);
      let next = {
        ...state,
        players: {
          ...state.players,
          [action.player]: {
            ...player,
            lifespan: player.lifespan - MULLIGAN_COST,
            hand: reshuffled.slice(0, STARTING_HAND_SIZE),
            mainDeck: reshuffled.slice(STARTING_HAND_SIZE),
          },
        },
      };
      return addLogAs(next, action.player, `${action.player} mulligans (-${MULLIGAN_COST} Lifespan).`);
    }

    case 'KEEP_HAND': {
      const player = state.players[action.player];
      if (state.phase !== 'mulligan' || player.keptHand) return state;
      let next = {
        ...state,
        players: { ...state.players, [action.player]: { ...player, keptHand: true } },
      };
      next = addLogAs(next, action.player, `${action.player} keeps their opening hand.`);
      if (next.players.A.keptHand && next.players.B.keptHand) {
        next = { ...next, phase: 'playing' };
        next = beginTurn(next);
      }
      return next;
    }

    case 'SUMMON_BEING': {
      const playerId = state.turnPlayer;
      const player = state.players[playerId];
      if (state.phase !== 'playing') return state;
      const waiting = state.board[action.cellId];
      const card = player.hand.find(c => c.instanceId === action.instanceId);
      if (!card || (card.kind !== 'being' && card.kind !== 'deity')) return state;
      // A "Relic, Being" is placed like a Relic — any Mortal Realm cell —
      // rather than restricted to the home-row summon cells (see
      // getLegalActions' own matching check, above). Lesser Summoning
      // Circle's own flagged Relic tile is a legal destination too, even
      // occupied and outside both of those — see summonHereTargetOk.
      const legalCells = card.isRelicBeing ? mortalCellsFor(playerId) : SUMMON_CELLS[playerId];
      // Lesser Summoning Circle lives in groundRelics, not board (see
      // summonHereTargetOk) — state.board[action.cellId] (`waiting`) is
      // genuinely empty under it, so this needs its own lookup.
      const viaSummoningCircle = summonHereTargetOk(state.groundRelics[action.cellId], playerId, card);
      // Boknea Druid: "may be summoned directly onto another TreeFolk,
      // Vine, or Seed" — bypasses legalCells the same way Lesser Summoning
      // Circle's own flagged tile does, since the eligible Being could be
      // anywhere on the player's own side, not just a home-row cell.
      const viaDryadAttach = dryadAttachTargetOk(waiting, playerId, card);
      // Vicious Vittles: its own tile is a legal destination for the
      // player's next Hunger this turn, consuming (sacrificing) it — see
      // below, right after the normal summoning cost is paid.
      const vittles = state.nextHungerFreeSummonOnTile;
      const viaVittles = !!vittles && vittles.ownerId === playerId && vittles.cellId === action.cellId
        && (card.typing || '').toLowerCase().includes('hunger') && state.board[vittles.cellId]?.card?.instanceId === vittles.instanceId;
      if (!viaSummoningCircle && !viaDryadAttach && !viaVittles && (!emptyOrOwnArmamentStack(waiting, playerId) || !legalCells.includes(action.cellId))) return state;
      const cost = effectiveCastingCost(card, state, playerId);
      if (!canPayCost(player.effigyPool, cost)) return state;

      const explicitIds = validFaithlessSelection(player.effigyPool, cost, action.faithlessInstanceIds) ? action.faithlessInstanceIds : null;
      const { remaining, spent } = payCost(player.effigyPool, cost, explicitIds);
      const paidState = {
        ...state,
        // Simple Summoner's one-shot discount (effectiveCastingCost above)
        // is consumed by the next Being placed this turn, win or lose on
        // whether it actually needed the discount — same "used regardless"
        // rule real "your next X" effects follow.
        ...(state.nextBeingCostReduction && card.kind === 'being' ? { nextBeingCostReduction: null } : {}),
        players: {
          ...state.players,
          [playerId]: {
            ...player,
            hand: player.hand.filter(c => c.instanceId !== action.instanceId),
            effigyPool: remaining,
            effigySpentThisTurn: [...player.effigySpentThisTurn, ...spent],
          },
        },
      };
      // Immen Gorta: "As an additional cost to summon, Sacrifice (2)
      // Beings." — the summoning cost above is already paid (same order
      // Desperate Finale's own additional-cost precedent uses: base cost
      // first, then the additional one), but placement itself waits until
      // the sacrifices are chosen — reuses the same click-to-highlight
      // pendingChoice shape as everywhere else a player picks board
      // targets, one at a time, resolving automatically once enough are
      // picked (see RESOLVE_SUMMON_SACRIFICE_COST). `card` is stashed
      // directly on the pendingChoice since it's no longer in hand,
      // purgatory, or anywhere else to look it back up from.
      const sacrificeCost = card.keywords?.additionalSummonCostSacrificeBeings;
      if (sacrificeCost) {
        if (countOwnBeings(paidState.board, playerId) < sacrificeCost) return state;
        let next = addLog(paidState, `${playerId} must sacrifice ${sacrificeCost} Being(s) as an additional cost to summon ${card.name}.`);
        return {
          ...next,
          pendingChoice: { kind: 'summon-sacrifice-cost', playerId, cardName: card.name, cellId: action.cellId, card, amount: sacrificeCost, selected: [] },
        };
      }
      if (viaVittles) {
        let next = addLog({ ...paidState, nextHungerFreeSummonOnTile: null }, `${playerId} sacrifices Vicious Vittles as an additional cost to summon ${card.name}.`);
        next = destroyBeing(next, action.cellId);
        return placeBeingOnBoard(next, playerId, action.cellId, card);
      }
      if (viaSummoningCircle) {
        const circle = state.groundRelics[action.cellId];
        const groundRelics = { ...paidState.groundRelics };
        delete groundRelics[action.cellId];
        let next = addLog({ ...paidState, groundRelics }, `${playerId} sacrifices ${circle.card.name} to summon ${card.name}.`);
        return placeBeingOnBoard(next, playerId, action.cellId, card);
      }
      return placeBeingOnBoard(paidState, playerId, action.cellId, card);
    }

    case 'SUMMON_AS_PROPHECY': {
      const playerId = state.turnPlayer;
      const player = state.players[playerId];
      if (state.phase !== 'playing') return state;
      const card = player.hand.find(c => c.instanceId === action.instanceId);
      if (!card || (card.kind !== 'being' && card.kind !== 'deity')) return state;
      const altSummon = card.keywords?.alternateSummonAsProphecy;
      if (!altSummon) return state;
      const combinedCost = {
        faithless: card.castingCost.faithless,
        colored: { ...card.castingCost.colored, [altSummon.color]: (card.castingCost.colored[altSummon.color] || 0) + altSummon.extraAmount },
      };
      if (!canPayCost(player.effigyPool, combinedCost)) return state;
      const explicitIds = validFaithlessSelection(player.effigyPool, combinedCost, action.faithlessInstanceIds) ? action.faithlessInstanceIds : null;
      const { remaining, spent } = payCost(player.effigyPool, combinedCost, explicitIds);
      let next = {
        ...state,
        players: {
          ...state.players,
          [playerId]: { ...player, hand: player.hand.filter(c => c.instanceId !== action.instanceId), effigyPool: remaining, effigySpentThisTurn: [...player.effigySpentThisTurn, ...spent] },
        },
      };
      next = addLog(next, `${playerId} pays the extra cost to summon ${card.name} directly into the Ethereal Realm.`);
      return offerOrShiftFromPurgatory(next, playerId, card, altSummon.timeCounters);
    }

    case 'PLAY_PROPHECY': {
      const playerId = state.turnPlayer;
      const player = state.players[playerId];
      if (state.phase !== 'playing') return state;
      if (state.board[action.cellId]) return state;
      if (!ETHEREAL_CELLS.includes(action.cellId)) return state;
      const card = player.hand.find(c => c.instanceId === action.instanceId);
      if (!card || card.kind !== 'prophecy') return state;
      const cost = effectiveCastingCost(card, state, playerId);
      if (!canPayCost(player.effigyPool, cost)) return state;

      const explicitIds = validFaithlessSelection(player.effigyPool, cost, action.faithlessInstanceIds) ? action.faithlessInstanceIds : null;
      const { remaining, spent } = payCost(player.effigyPool, cost, explicitIds);
      let next = {
        ...state,
        board: {
          ...state.board,
          [action.cellId]: {
            type: 'prophecy',
            ownerId: playerId,
            card,
            timer: card.timerMax,
            faceDown: true,
          },
        },
        players: {
          ...state.players,
          [playerId]: {
            ...player,
            hand: player.hand.filter(c => c.instanceId !== action.instanceId),
            effigyPool: remaining,
            effigySpentThisTurn: [...player.effigySpentThisTurn, ...spent],
          },
        },
      };
      next = addLog(next, `${playerId} plays a Prophecy face-down at ${action.cellId}.`);
      // "Whenever you conjure a Prophecy, X" (Timeline Tinker) — fires for
      // every Being the player controls carrying the trigger, same
      // real-trigger-point/generic-resolver treatment as When Summoned.
      Object.entries(next.board).forEach(([cell, occupant]) => {
        if (occupant?.type !== 'being' || occupant.ownerId !== playerId) return;
        const triggerText = occupant.card.keywords?.whenConjureProphecy;
        if (!triggerText) return;
        next = addLog(next, `${occupant.card.name}'s "Whenever you conjure a Prophecy" triggers.`);
        next = resolveOrLogEffect(next, playerId, occupant.card.name, triggerText, 'Whenever you conjure a Prophecy', { selfCellId: cell });
      });
      // False Testament: "When conjured you may have this enter with up to
      // (5) Time Counters." — its own printed timerMax is 0 (an
      // uncomputed "X" — cardData.js), so it enters with nothing at all
      // unless the caster picks a real starting value now.
      if (card.keywords?.whenConjuredEnterUpTo) {
        next = addLog(next, `${card.name}'s "When conjured" lets ${playerId} choose how many Time Counters it enters with.`);
        return { ...next, pendingChoice: { kind: 'choose-prophecy-timer', playerId, cardName: card.name, cellId: action.cellId, maxValue: card.keywords.whenConjuredEnterUpTo } };
      }
      return next;
    }

    case 'MOVE_OR_ATTACK': {
      const playerId = state.turnPlayer;
      if (state.phase !== 'playing') return state;
      const occupant = state.board[action.fromCellId];
      // The mover is either a real Being, or an Animated Armament acting
      // as one (RULES.md > Keywords > Animated) — the topmost entry of a
      // Being-less pile.
      const isBeing = occupant?.type === 'being';
      const attackerTop = animatedTopEntry(occupant);
      if (!occupant || occupant.ownerId !== playerId || !(isBeing || attackerTop)) return state;
      const actorEngaged = isBeing ? occupant.engaged : attackerTop.engaged;
      if (actorEngaged) return state;
      const actorCard = isBeing ? occupant.card : attackerTop.card;

      if (action.isAttack) {
        // declareAttackFrom re-derives occupant/isBeing/actorCard itself —
        // the engaged gate above already applies to this normal path (see
        // its own comment for the one caller that deliberately bypasses
        // both it and the declare step entirely).
        return declareAttackFrom(state, playerId, action.fromCellId);
      } else {
        if (!actorCard.arrows.includes(action.direction)) return state;
        if (occupant.blockedWhileHasTimeCounters && (occupant.counters?.time || 0) > 0) return state; // Moment of Doubt
        if (actorCard.keywords?.cannotMove) return state; // Reveler
        const toCellId = computeMoveDestination(playerId, action.fromCellId, action.direction);
        const waiting = toCellId ? state.board[toCellId] : null;
        // Dryad (RULES.md > Keywords): a real Being moving onto another of
        // its own Beings (TreeFolk/Vine/Seed typing) attaches instead of
        // the normal empty/own-armament-stack destination — see
        // dryadAttachTargetOk above. Never true for an Animated Armament
        // acting as the mover (no real card prints Dryad on an Armament).
        const attaching = isBeing && !occupant.dryadAttached && dryadAttachTargetOk(waiting, playerId, actorCard);
        if (!toCellId || !(emptyOrOwnArmamentStack(waiting, playerId) || attaching)) return state;
        const board = { ...state.board };
        // Dryad: unlike Armaments (worn equipment that travels with the
        // Being), a mount is a shared TILE POSITION — moving away leaves it
        // right where it was instead of carrying it along. Reuses the same
        // "return it unharmed" helper death/sacrifice/return-to-hand
        // already use for exactly this. (occupant.dryadAttached can only
        // be true here for a real Being — attaching itself already refuses
        // to fire twice, per the `!occupant.dryadAttached` guard above — so
        // this never collides with forming a *new* attachment below.)
        if (isBeing && occupant.dryadAttached) dropDryadAttached(board, action.fromCellId, occupant);
        else delete board[action.fromCellId];
        // Armaments already on the mover travel with it; anything waiting
        // on the destination tile is picked up too — unless it's a Being
        // being attached to (Dryad), whose own Armaments stay bundled
        // inside its own dryadAttached entry instead of merging onto the
        // mover directly. For a real Being, order is irrelevant (all of it
        // is just equipment); for an Animated Armament acting as the mover,
        // its own pile goes *last* so it stays on top — still the acting
        // entry afterward.
        const pickedUpArmaments = attaching ? [] : (waiting?.armaments || []);
        const carriedArmaments = isBeing
          ? [...(occupant.armaments || []), ...pickedUpArmaments]
          : [...pickedUpArmaments, ...(occupant.armaments || [])];
        // A real Being with nothing attached keeps no `armaments`/
        // `dryadAttached` key at all (matching every other Being-shaped
        // occupant) — `occupantWithoutMount` drops any PRIOR attachment
        // (already left behind above) before movedBase decides whether to
        // add a fresh one. An Animated Armament always needs the armaments
        // array — it's at least its own acting entry, never actually empty
        // in practice.
        const { dryadAttached: _droppedMount, ...occupantWithoutMount } = occupant;
        const movedBase = isBeing
          ? {
              ...occupantWithoutMount,
              ...(carriedArmaments.length > 0 ? { armaments: carriedArmaments } : {}),
              ...(attaching
                ? { dryadAttached: { card: waiting.card, currentLifespan: waiting.currentLifespan, engaged: waiting.engaged, ...(waiting.armaments ? { armaments: waiting.armaments } : {}), ...(waiting.dryadAttached ? { dryadAttached: waiting.dryadAttached } : {}) } }
                : {}),
            }
          : { ...occupant, armaments: carriedArmaments };
        board[toCellId] = writeActorState(movedBase, { engaged: true });
        const moveMsg = `${playerId} moves ${actorCard.name} to ${toCellId}.`;
        let moveNext = addLog(
          { ...state, board },
          attaching ? `${moveMsg} It attaches to ${waiting.card.name}.`
            : (isBeing && occupant.dryadAttached) ? `${moveMsg} ${occupant.dryadAttached.card.name} stays behind at ${action.fromCellId}.`
            : (waiting ? `${moveMsg} It picks up the Armament(s) waiting there.` : moveMsg)
        );
        moveNext = applyNewArmamentsLifespanBonus(moveNext, toCellId, pickedUpArmaments);
        if (attaching) {
          moveNext = applyDryadAttachLifespanBonus(moveNext, toCellId);
          moveNext = triggerOnDryadAttachedOnto(moveNext, playerId, toCellId, waiting.card);
        }
        // "Each time this moves, X" (Hoarder) — fires only for an actual
        // move, never an attack (attacks don't reposition the attacker at
        // all, so there's no "tile it moved from" for that branch to mean
        // anything). Shared with every other move-application site —
        // see triggerOnMoveReaction's own comment.
        return triggerOnMoveReaction(moveNext, playerId, toCellId, action.fromCellId, actorCard);
      }
    }

    case 'PLACE_RELIC': {
      const playerId = state.turnPlayer;
      const player = state.players[playerId];
      if (state.phase !== 'playing') return state;
      const card = player.hand.find(c => c.instanceId === action.instanceId);
      if (!card || card.kind !== 'relic') return state;
      // Same "Beings may move across this" exception as this action's own
      // getLegalActions offer above.
      const blocked = card.keywords?.beingsMayMoveAcross
        ? !!state.groundRelics[action.cellId] || state.board[action.cellId]?.type === 'relic'
        : !!state.board[action.cellId] || !!state.groundRelics[action.cellId];
      if (blocked) return state;
      if (!mortalCellsFor(playerId).includes(action.cellId)) return state;
      const cost = effectiveCastingCost(card, state, playerId);
      if (!canPayCost(player.effigyPool, cost)) return state;

      const explicitIds = validFaithlessSelection(player.effigyPool, cost, action.faithlessInstanceIds) ? action.faithlessInstanceIds : null;
      const { remaining, spent } = payCost(player.effigyPool, cost, explicitIds);
      // "When summoned gain (N) <Name> Counters" applies to a standalone
      // Relic too, not just an Armament (e.g. Shifting Sands' own Crossing
      // Counters) — same field, just read here instead of in ATTACH_ARMAMENT.
      const counterGrant = card.keywords?.armamentCounterGrant;
      const relicOccupant = {
        type: 'relic', ownerId: playerId, card,
        ...(counterGrant ? { counters: { [counterGrant.type]: counterGrant.amount } } : {}),
      };
      // "Beings may move across this" (RULES.md > Keywords) — placed into
      // groundRelics instead of board, so it never blocks movement/attack
      // and stays exactly where it was placed no matter what a Being does
      // on that tile afterward (see createInitialState's own comment).
      let next = {
        ...state,
        // Metal Worker's one-shot discount (effectiveCastingCost above) is
        // consumed by the next Relic placed this turn, win or lose on
        // whether it actually needed the discount — same "used regardless"
        // rule Simple Summoner's own nextBeingCostReduction already follows.
        ...(state.nextRelicCostReduction ? { nextRelicCostReduction: null } : {}),
        ...(card.keywords?.beingsMayMoveAcross
          ? { groundRelics: { ...state.groundRelics, [action.cellId]: relicOccupant } }
          : { board: { ...state.board, [action.cellId]: relicOccupant } }),
        players: {
          ...state.players,
          [playerId]: {
            ...player,
            hand: player.hand.filter(c => c.instanceId !== action.instanceId),
            effigyPool: remaining,
            effigySpentThisTurn: [...player.effigySpentThisTurn, ...spent],
          },
        },
      };
      next = addLog(next, `${playerId} places ${card.name} at ${action.cellId}.`);
      // Monumental Mason's own reaction — only for a non-Armament Relic
      // (card.kind === 'relic' is exactly that; 'relic-armament' never
      // reaches this reducer, see ATTACH_ARMAMENT) landing on a tile it
      // points to.
      return triggerPointedRelicConjureCraftEffigy(next, playerId, action.cellId);
    }

    case 'PLACE_ALTAR': {
      const playerId = state.turnPlayer;
      const player = state.players[playerId];
      if (state.phase !== 'playing') return state;
      const card = player.hand.find(c => c.instanceId === action.instanceId);
      if (!card || card.kind !== 'altar') return state;
      const cost = effectiveCastingCost(card, state, playerId);
      if (!canPayCost(player.effigyPool, cost)) return state;
      if (!altarConjureCostPayable(state.board, playerId, card)) return state;

      const explicitIds = validFaithlessSelection(player.effigyPool, cost, action.faithlessInstanceIds) ? action.faithlessInstanceIds : null;
      const { remaining, spent } = payCost(player.effigyPool, cost, explicitIds);
      // "When conjured gain (N) <Name> Counters" (Eònion Altar: 3 Time
      // Counters) — same field/ETB semantics PLACE_RELIC/ATTACH_ARMAMENT
      // already use, just read here for an Altar too.
      const counterGrant = card.keywords?.armamentCounterGrant;
      const altarEntry = { card, ...(counterGrant ? { counters: { [counterGrant.type]: counterGrant.amount } } : {}) };
      // A player may control any number of Altars at once — they aren't
      // tied to a board cell (see createInitialState's own comment on
      // `altars`), just appended to their own small pile.
      let next = {
        ...state,
        altars: { ...state.altars, [playerId]: [...state.altars[playerId], altarEntry] },
        players: {
          ...state.players,
          [playerId]: {
            ...player,
            hand: player.hand.filter(c => c.instanceId !== action.instanceId),
            effigyPool: remaining,
            effigySpentThisTurn: [...player.effigySpentThisTurn, ...spent],
          },
        },
      };
      next = addLog(next, `${playerId} places ${card.name}.`);
      if (card.keywords?.conjureCost) {
        next = resolveOrLogEffect(next, playerId, card.name, card.keywords.conjureCost, 'conjure cost');
      }
      return checkWin(next);
    }

    case 'RESOLVE_DAMAGE_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'damage-target') return state;
      const { playerId, cardName, damage, typing, ownerFilter, thenMoveArmament, boundlessHunger } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      // A typed target must be a real Being (an Armament's own typing is
      // never a creature typing, so it could never match anyway); the
      // untyped "any target" case also allows a freestanding Animated
      // Armament acting as a Being (RULES.md > Keywords > Animated).
      if (!occupant || !(occupant.type === 'being' || (!typing && animatedTopEntry(occupant)))) return state;
      // `typing: null` (DAMAGE_ANY_TARGET_RE) means no typing/ownership
      // filter at all — any Being on the board, either owner (unless
      // narrowed by `ownerFilter` — Ambiguity's "an enemy").
      if (typing) {
        if (occupant.ownerId !== playerId) return state;
        if (!(occupant.card.typing || '').toLowerCase().includes(typing.toLowerCase())) return state;
      } else if (!moveSourceOwnerMatches(occupant, ownerFilter, playerId)) {
        return state;
      }

      let next = addLog({ ...state, pendingChoice: null }, `${playerId} chooses ${actorView(occupant).card.name} to take ${cardName}'s ${damage} damage.`);
      next = dealDamageToBeing(next, action.cellId, damage);
      // Brick: "...then move Brick to the tile occupied by the targeted
      // Being." — the move follows the choice, same as the damage does.
      if (thenMoveArmament) next = moveNamedArmamentToTile(next, thenMoveArmament, action.cellId);
      // Immen Gorta's own Boundless Hunger bounce loop (see
      // continueBoundlessHungerBounce) — this damage choice was one of the
      // loop's 3 illustrated iterations, so pick the bounce back up now
      // that it's actually resolved.
      if (boundlessHunger) next = continueBoundlessHungerBounce(next, boundlessHunger);
      return next;
    }

    // "any target" (never the narrower "target Being") also lets either
    // player's own Lifespan be chosen directly — a straight Lifespan hit,
    // no death pipeline involved since there's no occupant to kill.
    case 'RESOLVE_DAMAGE_TARGET_PLAYER': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'damage-target' || !state.pendingChoice.includesPlayers) return state;
      const { playerId, cardName, damage, boundlessHunger } = state.pendingChoice;
      const targetPlayerId = action.targetPlayerId;
      if (targetPlayerId !== 'A' && targetPlayerId !== 'B') return state;
      const target = state.players[targetPlayerId];
      let next = {
        ...state,
        pendingChoice: null,
        players: { ...state.players, [targetPlayerId]: { ...target, lifespan: target.lifespan - damage } },
      };
      next = addLog(next, `${playerId} chooses ${targetPlayerId}'s Lifespan to take ${cardName}'s ${damage} damage.`);
      // See the matching comment in RESOLVE_DAMAGE_TARGET above.
      if (boundlessHunger) next = continueBoundlessHungerBounce(next, boundlessHunger);
      return checkWin(next);
    }

    case 'RESOLVE_MINUS_COUNTER_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'minus-counter-target') return state;
      const { cardName, label, amount } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being') return state;
      const next = { ...state, pendingChoice: null };
      return applyMinusCounters(next, cardName, label, action.cellId, amount);
    }

    case 'RESOLVE_ADD_COUNTER_TYPED_POINTED_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'add-counter-typed-pointed-target') return state;
      const { cardName, label, amount, counterType, allowedCells } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || !allowedCells.includes(action.cellId)) return state;
      const have = occupant.counters?.[counterType] || 0;
      let next = {
        ...state, pendingChoice: null,
        board: { ...state.board, [action.cellId]: { ...occupant, counters: { ...occupant.counters, [counterType]: have + amount } } },
      };
      return addLog(next, `${cardName}'s ${label} adds ${amount} ${counterType} Counter(s) to ${occupant.card.name}.`);
    }

    case 'RESOLVE_STRENGTH_SET_EOT': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'strength-set-eot') return state;
      const { playerId, cardName, amount } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being') return state;
      const next = {
        ...state,
        pendingChoice: null,
        board: { ...state.board, [action.cellId]: { ...occupant, strengthSetUntilEndOfTurn: amount } },
      };
      return addLog(next, `${playerId} chooses ${occupant.card.name}'s Strength to become ${amount} until end of turn (${cardName}).`);
    }

    case 'RESOLVE_RETURN_TO_HAND': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'return-to-hand') return state;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being') return state;
      return returnBeingToHand({ ...state, pendingChoice: null }, action.cellId);
    }

    case 'RESOLVE_CHOOSE_ESSENCE_COLOR': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'choose-essence-color') return state;
      if (!EFFIGY_COLORS.includes(action.color)) return state;
      const { playerId, cardName, count } = state.pendingChoice;
      const granted = makeTemporaryEssence(action.color, count);
      const player = state.players[playerId];
      const next = {
        ...state,
        pendingChoice: null,
        players: { ...state.players, [playerId]: { ...player, effigyPool: [...player.effigyPool, ...granted] } },
      };
      return addLog(next, `${cardName}'s effect adds ${count} ${action.color} Essence to ${playerId}'s pool until end of turn.`);
    }

    case 'RESOLVE_SACRIFICE_BEING_COST': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'sacrifice-being-cost') return state;
      const { playerId, cardName, effectText, label, context } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return state;
      let next = addLog({ ...state, pendingChoice: null }, `${playerId} sacrifices ${occupant.card.name} for ${cardName}'s ${label}.`);
      next = destroyBeing(next, action.cellId);
      return resolveOrLogEffect(next, playerId, cardName, effectText, label, context);
    }

    case 'RESOLVE_ENGAGE_BEING_COST': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'engage-being-cost') return state;
      const { playerId, cardName, effectText, label, context } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId || occupant.engaged) return state;
      let next = { ...state, pendingChoice: null, board: { ...state.board, [action.cellId]: { ...occupant, engaged: true } } };
      next = addLog(next, `${playerId} Engages ${occupant.card.name} for ${cardName}'s ${label}.`);
      return resolveOrLogEffect(next, playerId, cardName, effectText, label, context);
    }

    case 'RESOLVE_GRANT_MARTYR_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'grant-martyr-target') return state;
      const { cardName, label, martyrText } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being') return state;
      let next = {
        ...state,
        pendingChoice: null,
        board: { ...state.board, [action.cellId]: { ...occupant, grantedMartyrUntilEndOfTurn: martyrText } },
      };
      return addLog(next, `${cardName}'s ${label} gives ${occupant.card.name} "Martyr: ${martyrText}" until end of turn.`);
    }

    case 'RESOLVE_AFTERIMAGE_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'afterimage-target') return state;
      const { playerId, cardName, label } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being') return state;
      let next = {
        ...state,
        pendingChoice: null,
        board: { ...state.board, [action.cellId]: { ...occupant, afterimageWatchOwnerId: playerId } },
      };
      return addLog(next, `${cardName}'s ${label} watches ${occupant.card.name}'s movement for the rest of the turn.`);
    }

    case 'RESOLVE_CONJURE_PROPHECY_PURGATORY': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'conjure-prophecy-purgatory') return state;
      const { playerId, cardName, label, cellId } = state.pendingChoice;
      if (state.board[cellId]) return { ...state, pendingChoice: null };
      const card = state.players[playerId].purgatory.find(c => c.instanceId === action.instanceId);
      if (!card || card.kind !== 'prophecy') return { ...state, pendingChoice: null };
      return conjureProphecyFromPurgatory({ ...state, pendingChoice: null }, playerId, cardName, label, card, cellId);
    }

    case 'RESOLVE_CREATE_TOKEN_CHOICE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'create-token-choice') return state;
      const { playerId, cardName, label, options } = state.pendingChoice;
      if (!options.includes(action.tokenKey)) return state;
      const makeToken = TOKEN_REGISTRY[action.tokenKey];
      if (!makeToken) return { ...state, pendingChoice: null };
      const token = makeToken();
      const candidates = token.kind === 'prophecy'
        ? ETHEREAL_CELLS.filter(c => !state.board[c])
        : emptyMortalCellsFor(state.board, playerId);
      let next = { ...state, pendingChoice: null };
      if (candidates.length === 0) {
        return addLog(next, `${cardName}'s ${label} has no empty tile to create ${token.name} on.`);
      }
      if (candidates.length === 1) {
        next = placeTokenOnBoard(next, playerId, token, candidates[0]);
        return addLog(next, `${cardName}'s ${label} creates ${token.name} at ${candidates[0]}.`);
      }
      next = addLog(next, `${cardName}'s ${label} lets ${playerId} choose a tile to create ${token.name} on.`);
      const kind = token.kind === 'prophecy' ? 'ethereal-token-location' : 'token-location';
      return { ...next, pendingChoice: { kind, playerId, cardName, label, tokenName: action.tokenKey, allowedCells: candidates } };
    }

    case 'RESOLVE_ETHEREAL_TOKEN_LOCATION': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'ethereal-token-location') return state;
      const { playerId, cardName, tokenName, allowedCells } = state.pendingChoice;
      if (state.board[action.cellId] || !ETHEREAL_CELLS.includes(action.cellId)
        || (allowedCells && !allowedCells.includes(action.cellId))) {
        return { ...state, pendingChoice: null };
      }
      const makeToken = TOKEN_REGISTRY[tokenName];
      if (!makeToken) return { ...state, pendingChoice: null };
      const token = makeToken();
      let next = placeTokenOnBoard({ ...state, pendingChoice: null }, playerId, token, action.cellId);
      return addLog(next, `${cardName} creates ${token.name} at ${action.cellId}.`);
    }

    case 'RESOLVE_END_OF_TURN_DAMAGE_NAMED_FAMILY_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'end-of-turn-damage-named-family-target') return state;
      const { playerId, cardName, amount, namePart, remainingSources } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId || !occupant.card.name.toLowerCase().includes(namePart.toLowerCase())) return state;
      let next = addLog({ ...state, pendingChoice: null }, `${playerId} chooses ${occupant.card.name} to take ${amount} Lifespan Damage from ${cardName}'s end-of-turn trigger.`);
      next = dealDamageToBeing(next, action.cellId, amount);
      next = checkWin(next);
      if (next.phase === 'gameover') return next;
      // A "Doubt-only" build can have more than one trigger source needing
      // its own real choice in the same End Step (turn.js >
      // resolveEndOfTurnDamageNamedFamilyQueue) — resume the rest of the
      // queue here instead of leaving any further source unresolved.
      // `playerId` (not state.turnPlayer, which has already flipped to the
      // opponent by now) is the declaring player this whole queue belongs to.
      return resolveEndOfTurnDamageNamedFamilyQueue(next, remainingSources || [], playerId);
    }

    case 'RESOLVE_SUMMON_HAND_BEING_POINTED': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'summon-hand-being-pointed') return state;
      const { playerId, allowedCells } = state.pendingChoice;
      if (!allowedCells.includes(action.cellId)) return state;
      const player = state.players[playerId];
      const card = player.hand.find(c => c.instanceId === action.instanceId);
      if (!card || card.kind !== 'being') return state;
      // A Dryad-keyword Being may still target a tile carrying the
      // player's own TreeFolk/Vine/Seed (dryadAttachTargetOk) — placeBeingOnBoard
      // below already has its own real Dryad-attach branch that handles
      // this correctly once it's actually reached; this is only the same
      // legality re-check the offer branch above already applies.
      const pointedOccupant = state.board[action.cellId];
      if (!emptyOrOwnArmamentStack(pointedOccupant, playerId) && !dryadAttachTargetOk(pointedOccupant, playerId, card)) return state;
      const cost = effectiveCastingCost(card, state, playerId);
      if (!canPayCost(player.effigyPool, cost)) return state;
      const { remaining, spent } = payCost(player.effigyPool, cost);
      let next = {
        ...state,
        pendingChoice: null,
        players: {
          ...state.players,
          [playerId]: {
            ...player,
            hand: player.hand.filter(c => c.instanceId !== action.instanceId),
            effigyPool: remaining,
            effigySpentThisTurn: [...player.effigySpentThisTurn, ...spent],
          },
        },
      };
      return placeBeingOnBoard(next, playerId, action.cellId, card);
    }

    case 'RESOLVE_COPY_ENGAGE_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'copy-engage-target') return state;
      const { playerId, cardName, label, context } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId === playerId) return state;
      const next = { ...state, pendingChoice: null };
      return copyEngageAbility(next, playerId, cardName, label, action.cellId, context);
    }

    case 'RESOLVE_TRIGGER_DEPART_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'trigger-depart-target') return state;
      const { playerId, cardName, label } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return state;
      const next = { ...state, pendingChoice: null };
      return triggerDepartOfTarget(next, playerId, cardName, label, action.cellId);
    }

    case 'RESOLVE_ADD_COUNTER_RELIC_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'add-counter-relic-target') return state;
      const { cardName, label, amount, counterType } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'relic') return state;
      const have = occupant.counters?.[counterType] || 0;
      let next = {
        ...state,
        pendingChoice: null,
        board: { ...state.board, [action.cellId]: { ...occupant, counters: { ...occupant.counters, [counterType]: have + amount } } },
      };
      return addLog(next, `${cardName}'s ${label} adds ${amount} ${counterType} Counter(s) to ${occupant.card.name}.`);
    }

    case 'RESOLVE_SACRIFICE_RELIC_COST': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'sacrifice-relic-cost') return state;
      const { playerId, cardName, effectText, label, context } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'relic' || occupant.ownerId !== playerId) return state;
      let next = addLog({ ...state, pendingChoice: null }, `${playerId} sacrifices ${occupant.card.name} for ${cardName}'s ${label}.`);
      next = destroyPermanentAt(next, action.cellId);
      return resolveOrLogEffect(next, playerId, cardName, effectText, label, context);
    }

    case 'RESOLVE_VYU_BHATA_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'vyu-bhata-target') return state;
      const { playerId, cardName, label } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return state;
      const adjacentOwnBeings = adjacentCells(action.cellId).filter(c => state.board[c]?.type === 'being' && state.board[c]?.ownerId === playerId).length;
      const totalStacks = 1 + adjacentOwnBeings;
      const existing = occupant.permanentBonus || { strength: 0, lifespan: 0 };
      let next = {
        ...state,
        pendingChoice: null,
        board: {
          ...state.board,
          [action.cellId]: {
            ...occupant,
            permanentBonus: { strength: existing.strength + totalStacks, lifespan: existing.lifespan + totalStacks },
            currentLifespan: occupant.currentLifespan + totalStacks,
          },
        },
      };
      return addLog(next, `${cardName}'s ${label} gives ${occupant.card.name} +${totalStacks}/+${totalStacks} (1 plus ${adjacentOwnBeings} adjacent Being(s)).`);
    }

    case 'RESOLVE_SACRIFICE_TYPED_COST_LIMIT': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'sacrifice-typed-cost-limit') return state;
      const { playerId, cardName, label, typings, costLimit, gainAmount } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return state;
      if (!typings.some(t => (occupant.card.typing || '').toLowerCase().includes(t)) || totalCastingCost(occupant.card) > costLimit) return state;
      let next = addLog({ ...state, pendingChoice: null }, `${playerId} sacrifices ${occupant.card.name} for ${cardName}'s ${label}.`);
      next = destroyBeing(next, action.cellId);
      return resolveOrLogEffect(next, playerId, cardName, `Gain (${gainAmount}) Lifespan.`, label, {});
    }

    case 'RESOLVE_SACRIFICE_POINTED_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'sacrifice-pointed-target') return state;
      const { playerId, cardName, label, selfCellId } = state.pendingChoice;
      const selfArrows = state.board[selfCellId]?.card?.arrows || [];
      const pointedCells = [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, selfCellId, dir)))].filter(Boolean);
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || !pointedCells.includes(action.cellId)) return state;
      let next = addLog({ ...state, pendingChoice: null }, `${cardName}'s ${label} sacrifices ${occupant.card.name}.`);
      return destroyBeing(next, action.cellId);
    }

    case 'RESOLVE_MIDNIGHT_MASS_SACRIFICE_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'midnight-mass-sacrifice-target') return state;
      const { playerId, cardName, label, typing, selfCellId, context } = state.pendingChoice;
      const selfArrows = context?.selfArrows || state.board[selfCellId]?.card?.arrows || [];
      const pointedCells = [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, selfCellId, dir)))].filter(Boolean);
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || !pointedCells.includes(action.cellId)) return state;
      const strength = effectiveStrength(occupant);
      let next = addLog({ ...state, pendingChoice: null }, `${playerId} sacrifices ${occupant.card.name} (Strength ${strength}) for ${cardName}'s ${label}.`);
      next = destroyBeing(next, action.cellId);
      return resolveInvoke(next, playerId, cardName, label, typing, invokeCandidates(next, playerId, typing), 'pointed', { ...context, strengthOverride: strength });
    }

    case 'RESOLVE_ENGAGE_GRANT_COUNTER_SOURCE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'engage-grant-counter-source') return state;
      const { playerId, cardName, selfCellId, counterType, amount } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId || occupant.engaged) return state;
      let next = { ...state, pendingChoice: null, board: { ...state.board, [action.cellId]: { ...occupant, engaged: true } } };
      const self = next.board[selfCellId];
      if (!self) return next;
      const have = self.counters?.[counterType] || 0;
      next = { ...next, board: { ...next.board, [selfCellId]: { ...self, counters: { ...self.counters, [counterType]: have + amount } } } };
      return addLog(next, `${playerId} Engages ${occupant.card.name} for ${cardName}'s ability — gains ${amount} ${counterType} Counter(s).`);
    }

    case 'RESOLVE_RECOLLECT_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'recollect-target') return state;
      const { cardName, label, pointedCells } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || !pointedCells.includes(action.cellId)) return state;
      return applyRecollect({ ...state, pendingChoice: null }, action.cellId, cardName, label);
    }

    case 'RESOLVE_DROWN_SCREAMS_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'drown-screams-target') return state;
      const { cardName, label } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.card.isDeity) return state;
      const next = { ...state, pendingChoice: null, board: { ...state.board, [action.cellId]: suppressAbilitiesUntilEndOfTurn(occupant) } };
      return addLog(next, `${cardName}'s ${label} strips ${occupant.card.name}'s abilities until end of turn.`);
    }

    case 'RESOLVE_DENDRIFY_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'dendrify-target') return state;
      const { cardName, label, newStrength, newLifespan } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being') return state;
      const suppressed = suppressAbilitiesUntilEndOfTurn(occupant);
      const next = {
        ...state,
        pendingChoice: null,
        board: {
          ...state.board,
          [action.cellId]: {
            ...suppressed,
            strengthSetUntilEndOfTurn: newStrength,
            lifespanSetUntilEndOfTurn: newLifespan,
            currentLifespan: Math.min(occupant.currentLifespan, newLifespan),
          },
        },
      };
      return addLog(next, `${cardName}'s ${label} turns ${occupant.card.name} into a ${newStrength}/${newLifespan} Being until end of turn, losing its abilities.`);
    }

    case 'RESOLVE_ANIMATE_RELIC_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'animate-relic-target') return state;
      const { cardName, label, newStrength, newLifespan } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'relic') return { ...state, pendingChoice: null };
      return applyAnimate({ ...state, pendingChoice: null }, action.cellId, newStrength, newLifespan, cardName, label);
    }

    case 'RESOLVE_TEETH_BOUNDS_SACRIFICE_HUNGER': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'teeth-bounds-sacrifice-hunger') return state;
      const { playerId, cardName, label, context } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return { ...state, pendingChoice: null };
      let next = addLog({ ...state, pendingChoice: null }, `${playerId} sacrifices ${occupant.card.name} for ${cardName}'s Prophecy.`);
      next = destroyBeing(next, action.cellId);
      return resolveOrLogEffect(next, playerId, cardName, 'Add Immen Gorta from deck to hand.', label, context);
    }

    case 'RESOLVE_TEETH_BOUNDS_TIE_CHOICE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'teeth-bounds-tie-choice') return state;
      const { playerId, cardName, label, context } = state.pendingChoice;
      const cleared = { ...state, pendingChoice: null };
      return action.choice === 'more'
        ? applyByTeethAndBoundsMore(cleared, playerId, cardName, label, context)
        : applyByTeethAndBoundsLess(cleared, playerId, cardName, label);
    }

    case 'RESOLVE_LEGEND_RULE_KEEP': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'legend-rule-keep') return state;
      const { playerId, deityName } = state.pendingChoice;
      const keep = state.board[action.cellId];
      if (!keep || keep.type !== 'being' || keep.ownerId !== playerId || !keep.card.isDeity || keep.card.name !== deityName) return state;
      const toSacrifice = Object.entries(state.board)
        .filter(([cell, o]) => cell !== action.cellId && o?.type === 'being' && o.ownerId === playerId && o.card.isDeity && o.card.name === deityName)
        .map(([cell]) => cell);
      let next = addLog({ ...state, pendingChoice: null }, `${playerId} keeps ${keep.card.name} at ${action.cellId} (the legend rule).`);
      toSacrifice.forEach(cell => {
        next = destroyBeing(next, cell);
      });
      return next;
    }

    case 'RESOLVE_MOVE_FORWARD_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'move-forward-target') return state;
      const { playerId, cardName, label } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return state;
      const dest = computeMoveDestination(playerId, action.cellId, 1);
      const cleared = { ...state, pendingChoice: null };
      if (!dest || !freeMoveDestinationOk(cleared, playerId, dest, 'any')) {
        return addLog(cleared, `${cardName}'s ${label} has nowhere for ${occupant.card.name} to move.`);
      }
      return moveBeingFreely(cleared, action.cellId, dest);
    }

    case 'RESOLVE_STRENGTH_DEBUFF_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'strength-debuff-target') return state;
      const { cardName, label, amount } = state.pendingChoice;
      const occ = state.board[action.cellId];
      if (!occ || occ.type !== 'being') return state;
      const existing = occ.statBonusUntilEndOfTurn || { strength: 0, lifespan: 0 };
      const next = {
        ...state,
        pendingChoice: null,
        board: { ...state.board, [action.cellId]: { ...occ, statBonusUntilEndOfTurn: { strength: existing.strength - amount, lifespan: existing.lifespan } } },
      };
      return addLog(next, `${cardName}'s ${label} gives ${occ.card.name} -${amount}/-0 Strength until end of turn.`);
    }

    case 'RESOLVE_RETURN_THE_FAVOR_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'return-the-favor-target') return state;
      const { excludeCell } = state.pendingChoice;
      if (action.cellId === excludeCell) return state;
      const occ = state.board[action.cellId];
      if (!occ || occ.type !== 'being') return state;
      const next = { ...state, pendingChoice: null, board: { ...state.board, [action.cellId]: { ...occ, favorCounter: true } } };
      return addLog(next, `Return the Favor makes ${occ.card.name} Favored.`);
    }

    case 'RESOLVE_DIABLERIE_SELECT_MOVER': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'diablerie-select-mover') return state;
      const { playerId, cardName, label, movedInstanceIds, nextPlayerId } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId || movedInstanceIds.includes(occupant.card.instanceId)) return state;
      const candidates = [...new Set([1, 2, 3, 4, 5, 6, 7, 8].map(dir => computeMoveDestination(playerId, action.cellId, dir)))]
        .filter(c => c && freeMoveDestinationOk(state, playerId, c, 'any'));
      if (candidates.length === 0) return state;
      const next = { ...state, pendingChoice: null };
      if (candidates.length === 1) {
        return diablerieMoveAndDamage(next, playerId, cardName, label, action.cellId, candidates[0], movedInstanceIds, nextPlayerId);
      }
      return {
        ...next,
        pendingChoice: { kind: 'diablerie-move-destination', playerId, cardName, label, fromCellId: action.cellId, movedInstanceIds, nextPlayerId, allowedCells: candidates },
      };
    }

    case 'RESOLVE_DIABLERIE_MOVE_DESTINATION': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'diablerie-move-destination') return state;
      const { playerId, cardName, label, fromCellId, movedInstanceIds, nextPlayerId, allowedCells } = state.pendingChoice;
      if (!allowedCells.includes(action.cellId)) return state;
      return diablerieMoveAndDamage({ ...state, pendingChoice: null }, playerId, cardName, label, fromCellId, action.cellId, movedInstanceIds, nextPlayerId);
    }

    case 'RESOLVE_DIABLERIE_DONE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'diablerie-select-mover') return state;
      const { cardName, label, nextPlayerId } = state.pendingChoice;
      const next = { ...state, pendingChoice: null };
      return nextPlayerId ? diablerieOfferMover(next, nextPlayerId, cardName, label, [], null) : next;
    }

    case 'RESOLVE_DEBUFF_PER_OWN_DEATH_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'debuff-per-own-death-target') return state;
      const { cardName, label, amount } = state.pendingChoice;
      const occ = state.board[action.cellId];
      if (!occ || occ.type !== 'being') return state;
      const existing = occ.statBonusUntilEndOfTurn || { strength: 0, lifespan: 0 };
      let next = {
        ...state,
        pendingChoice: null,
        board: { ...state.board, [action.cellId]: { ...occ, statBonusUntilEndOfTurn: { strength: existing.strength - amount, lifespan: existing.lifespan } } },
      };
      next = addLog(next, `${cardName}'s ${label} gives ${occ.card.name} -${amount}/-${amount} until end of turn.`);
      return amount > 0 ? dealDamageToBeing(next, action.cellId, amount) : next;
    }

    case 'RESOLVE_LIFESPAN_DAMAGE_FIRST_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'lifespan-damage-first-target') return state;
      const { playerId, cardName, label, amount1, amount2 } = state.pendingChoice;
      const occ = state.board[action.cellId];
      if (!occ || occ.type !== 'being' || occ.ownerId !== playerId) return state;
      let next = addLog({ ...state, pendingChoice: null }, `${cardName}'s ${label} deals ${amount1} Lifespan Damage to ${occ.card.name}.`);
      next = dealDamageToBeing(next, action.cellId, amount1);
      return dealSecondLifespanDamage(next, playerId, cardName, label, amount2, action.cellId);
    }

    case 'RESOLVE_LIFESPAN_DAMAGE_SECOND_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'lifespan-damage-second-target') return state;
      const { cardName, label, amount, excludeCell } = state.pendingChoice;
      const occ = state.board[action.cellId];
      if (!occ || occ.type !== 'being' || action.cellId === excludeCell) return state;
      let next = addLog({ ...state, pendingChoice: null }, `${cardName}'s ${label} deals ${amount} Lifespan Damage to ${occ.card.name}.`);
      return dealDamageToBeing(next, action.cellId, amount);
    }

    case 'RESOLVE_ENGAGE_BUFF_EOT': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'engage-buff-eot') return state;
      const { playerId, cardName, label, strengthBonus, lifespanBonus } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      // No ownerId check — Boknean Wine's own printed text targets any
      // Being, either owner (see the offer branch's own comment above).
      if (!occupant || occupant.type !== 'being' || occupant.engaged) return state;
      return applyEngageStatBuff({ ...state, pendingChoice: null }, action.cellId, strengthBonus, lifespanBonus, playerId, cardName, label);
    }

    case 'RESOLVE_ENGAGE_THEN_MOVE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'engage-then-move') return state;
      const { playerId, cardName, label } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId || occupant.engaged) return state;
      let next = { ...state, pendingChoice: null, board: { ...state.board, [action.cellId]: { ...occupant, engaged: true } } };
      next = addLog(next, `${playerId} engages ${occupant.card.name} for ${cardName}'s ${label}.`);
      return moveOrOfferFreeMove(next, playerId, cardName, label, action.cellId, 'any');
    }

    case 'RESOLVE_ENGAGE_MOVE_TWICE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'engage-move-twice') return state;
      const { playerId, cardName, label } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId || occupant.engaged) return state;
      let next = { ...state, pendingChoice: null, board: { ...state.board, [action.cellId]: { ...occupant, engaged: true } } };
      next = addLog(next, `${playerId} engages ${occupant.card.name} for ${cardName}'s ${label}.`);
      return moveOrOfferFreeMove(next, playerId, cardName, label, action.cellId, 'any', { sameActor: true, destinationFilter: 'any' });
    }

    case 'RESOLVE_SACRIFICE_TYPED_COST': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'sacrifice-typed-cost') return state;
      const { playerId, cardName, typing, effectText, label, context } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return state;
      if (!(occupant.card.typing || '').toLowerCase().includes(typing.toLowerCase())) return state;
      let next = addLog({ ...state, pendingChoice: null }, `${playerId} sacrifices ${occupant.card.name} for ${cardName}'s ${label}.`);
      next = destroyBeing(next, action.cellId);
      return resolveOrLogEffect(next, playerId, cardName, effectText, label, context);
    }

    case 'RESOLVE_FREE_MOVE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'free-move') return state;
      const { playerId, cardName, label, fromCellId, destinationFilter, then } = state.pendingChoice;
      const occupant = state.board[fromCellId];
      // No ownerId check here (unlike most other resolvers) — a handful of
      // effects (Divine Winds, Echo chamber's second clause) legitimately
      // move a Being the OPPONENT controls; `playerId` is just who's
      // choosing the direction, already gated by the pendingChoice itself.
      if (!occupant || !freeMoveEligible(occupant)) return { ...state, pendingChoice: null };
      if (!freeMoveDestinationOk(state, playerId, action.toCellId, destinationFilter)) return state;
      let next = moveBeingFreely({ ...state, pendingChoice: null }, fromCellId, action.toCellId);
      return continueMoveThen(next, playerId, cardName, label, then, action.toCellId);
    }

    case 'RESOLVE_SELECT_MOVE_SOURCE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'select-move-source') return state;
      const { playerId, cardName, label, ownerFilter, destinationFilter, then } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || !moveSourceOwnerMatches(occupant, ownerFilter, playerId)) return state;
      return moveOrOfferFreeMove({ ...state, pendingChoice: null }, playerId, cardName, label, action.cellId, destinationFilter, then);
    }

    case 'RESOLVE_DECLINE': {
      if (!state.pendingChoice?.optional) return state;
      return addLog({ ...state, pendingChoice: null }, `${state.pendingChoice.playerId} declines ${state.pendingChoice.cardName}'s ability.`);
    }

    case 'RESOLVE_PAY_LIFESPAN_OPTIONAL': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'pay-lifespan-optional') return state;
      const { playerId, cardName, label, cost, effectText } = state.pendingChoice;
      const player = state.players[playerId];
      if (player.lifespan - cost <= 0) return state;
      let next = {
        ...state,
        pendingChoice: null,
        players: { ...state.players, [playerId]: { ...player, lifespan: player.lifespan - cost } },
      };
      next = addLog(next, `${playerId} pays ${cost} Lifespan for ${cardName}'s ${label}.`);
      next = triggerLifespanPaidReactions(next, playerId);
      next = checkWin(next);
      if (next.phase === 'gameover') return next;
      return resolveOrLogEffect(next, playerId, cardName, effectText, label, {});
    }

    case 'RESOLVE_SACRIFICE_THIS_OPTIONAL': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'sacrifice-this-optional') return state;
      const { playerId, cardName, label, effectText, context } = state.pendingChoice;
      if (!state.board[context.selfCellId]) return { ...state, pendingChoice: null };
      let next = addLog({ ...state, pendingChoice: null }, `${playerId} sacrifices ${cardName} for its ${label}.`);
      next = destroyBeing(next, context.selfCellId);
      return resolveOrLogEffect(next, playerId, cardName, effectText, label, context);
    }

    case 'RESOLVE_MAY_SUMMON_VINE_POINTED': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'may-summon-vine-pointed') return state;
      const { playerId, cardName, label, count, context } = state.pendingChoice;
      const selfArrows = state.board[context.selfCellId]?.card?.arrows || [];
      const candidates = [...new Set(selfArrows.map(dir => computeMoveDestination(playerId, context.selfCellId, dir)))]
        .filter(c => c && !state.board[c] && !state.groundRelics[c]);
      let next = { ...state, pendingChoice: null };
      let placed = 0;
      candidates.slice().sort().slice(0, count).forEach(cell => {
        next = placeTokenOnBoard(next, playerId, TOKEN_REGISTRY.vine(), cell);
        placed++;
      });
      return addLog(next, `${cardName}'s ${label} summons ${placed} Vine token(s) on tiles it points to.`);
    }

    case 'RESOLVE_BOTTOM_OF_DECK': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'bottom-of-deck') return state;
      const { playerId } = state.pendingChoice;
      const player = state.players[playerId];
      const idx = player.hand.findIndex(c => c.instanceId === action.instanceId);
      if (idx === -1) return state;
      const card = player.hand[idx];
      const hand = [...player.hand.slice(0, idx), ...player.hand.slice(idx + 1)];
      let next = {
        ...state,
        pendingChoice: null,
        players: { ...state.players, [playerId]: { ...player, hand, mainDeck: [...player.mainDeck, card] } },
      };
      return addLog(next, `${playerId} puts ${card.name} on the bottom of their deck.`);
    }

    case 'RESOLVE_DISCARD_X_NAMED_TOGGLE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'discard-x-named-toggle') return state;
      const { selected } = state.pendingChoice;
      const nextSelected = selected.includes(action.instanceId)
        ? selected.filter(id => id !== action.instanceId)
        : [...selected, action.instanceId];
      return { ...state, pendingChoice: { ...state.pendingChoice, selected: nextSelected } };
    }

    case 'RESOLVE_DISCARD_X_NAMED_CONFIRM': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'discard-x-named-toggle') return state;
      const { playerId, cardName, label, selected } = state.pendingChoice;
      const x = selected.length;
      const player = state.players[playerId];
      const discarded = player.hand.filter(c => selected.includes(c.instanceId));
      let next = {
        ...state,
        pendingChoice: null,
        players: {
          ...state.players,
          [playerId]: {
            ...player,
            hand: player.hand.filter(c => !selected.includes(c.instanceId)),
            purgatory: discarded.reduce((p, c) => purgatoryAfterAdding(p, c), player.purgatory),
          },
        },
      };
      next = addLog(next, `${playerId} discards ${x} card(s) for ${cardName}'s ${label}.`);
      if (x === 0) return next;
      const { state: afterDraw, drawnCount } = drawCardsFor(next, playerId, x);
      return addLog(afterDraw, `${cardName}'s ${label} draws ${drawnCount} card(s) for ${playerId}.`);
    }

    case 'RESOLVE_SACRIFICE_ANY_BEINGS_TOGGLE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'sacrifice-any-beings-toggle') return state;
      const { playerId, selected } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return state;
      const nextSelected = selected.includes(action.cellId)
        ? selected.filter(c => c !== action.cellId)
        : [...selected, action.cellId];
      return { ...state, pendingChoice: { ...state.pendingChoice, selected: nextSelected } };
    }

    case 'RESOLVE_SACRIFICE_ANY_BEINGS_CONFIRM': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'sacrifice-any-beings-toggle') return state;
      const { playerId, cardName, label, color, selected } = state.pendingChoice;
      const x = selected.length;
      let next = selected.reduce((s, cellId) => destroyBeing(s, cellId), { ...state, pendingChoice: null });
      next = addLog(next, `${playerId} sacrifices ${x} Being(s) for ${cardName}'s ${label}.`);
      if (x === 0) return next;
      const player = next.players[playerId];
      const granted = makeTemporaryEssence(color, x);
      next = { ...next, players: { ...next.players, [playerId]: { ...player, effigyPool: [...player.effigyPool, ...granted] } } };
      return addLog(next, `${cardName}'s ${label} adds ${x} ${color} Essence to ${playerId}'s pool until end of turn.`);
    }

    case 'RESOLVE_FREEZE_FRAME_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'freeze-frame-target') return state;
      const { cardName, label, amount } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      const isEngagedActor = occupant?.type === 'being' ? occupant.engaged : (occupant?.type === 'armament-stack' && animatedTopEntry(occupant)?.engaged);
      if (!isEngagedActor) return state;
      const actingCard = actorView(occupant).card;
      const have = (occupant.type === 'being' ? occupant.counters : animatedTopEntry(occupant).counters)?.time || 0;
      const updated = writeActorState(occupant, {
        counters: { ...(occupant.type === 'being' ? occupant.counters : animatedTopEntry(occupant).counters), time: have + amount },
        doesNotDisengageWhileHasTimeCounters: true,
      });
      let next = { ...state, pendingChoice: null, board: { ...state.board, [action.cellId]: updated } };
      return addLog(next, `${cardName}'s ${label} gives ${actingCard.name} ${amount} Time Counter(s); it won't disengage while it has any.`);
    }

    case 'RESOLVE_TIME_COUNTER_BLOCK_MOVE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'time-counter-block-move') return state;
      const { cardName, label, amount } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being') return state;
      const have = occupant.counters?.time || 0;
      let next = {
        ...state,
        pendingChoice: null,
        board: { ...state.board, [action.cellId]: { ...occupant, counters: { ...occupant.counters, time: have + amount }, blockedWhileHasTimeCounters: true } },
      };
      return addLog(next, `${cardName}'s ${label} gives ${occupant.card.name} ${amount} Time Counter(s); it can not move while it has any.`);
    }

    case 'RESOLVE_DISCARD_CHOSEN_COST_REDUCTION': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'discard-chosen-cost-reduction') return state;
      const { playerId, cardName, label, amount } = state.pendingChoice;
      const player = state.players[playerId];
      const card = player.hand.find(c => c.instanceId === action.instanceId);
      if (!card) return state;
      let next = {
        ...state,
        pendingChoice: null,
        players: {
          ...state.players,
          [playerId]: {
            ...player,
            hand: player.hand.filter(c => c.instanceId !== action.instanceId),
            purgatory: purgatoryAfterAdding(player.purgatory, card),
            effigyPool: [...player.effigyPool, ...makeTemporaryEssence('faithless', amount)],
          },
        },
      };
      next = addLog(next, `${playerId} discards ${card.name} for ${cardName}'s ${label}.`);
      return addLog(next, `${cardName}'s ${label} grants ${playerId} ${amount} temporary Faithless Essence (usable this turn).`);
    }

    case 'RESOLVE_DISCARD_KIND_DRAW': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'discard-kind-draw') return state;
      const { playerId, cardName, label, drawCount } = state.pendingChoice;
      const player = state.players[playerId];
      const card = player.hand.find(c => c.instanceId === action.instanceId);
      if (!card) return state;
      let next = {
        ...state,
        pendingChoice: null,
        players: {
          ...state.players,
          [playerId]: {
            ...player,
            hand: player.hand.filter(c => c.instanceId !== action.instanceId),
            purgatory: purgatoryAfterAdding(player.purgatory, card),
          },
        },
      };
      next = addLog(next, `${playerId} discards ${card.name} for ${cardName}'s ${label}.`);
      const { state: afterDraw, drawnCount } = drawCardsFor(next, playerId, drawCount);
      return addLog(afterDraw, `${cardName}'s ${label} draws ${drawnCount} card(s) for ${playerId}.`);
    }

    case 'RESOLVE_DISCARD_BEING_DRAW_BONUS': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'discard-being-draw-bonus') return state;
      const { playerId, cardName, label, bonusTyping } = state.pendingChoice;
      const player = state.players[playerId];
      const card = player.hand.find(c => c.instanceId === action.instanceId);
      if (!card || (card.kind !== 'being' && card.kind !== 'deity')) return state;
      let next = {
        ...state,
        pendingChoice: null,
        players: {
          ...state.players,
          [playerId]: { ...player, hand: player.hand.filter(c => c.instanceId !== action.instanceId), purgatory: purgatoryAfterAdding(player.purgatory, card) },
        },
      };
      next = addLog(next, `${playerId} discards ${card.name} for ${cardName}'s ${label}.`);
      const bonus = (card.typing || '').toLowerCase().includes(bonusTyping.toLowerCase()) ? 1 : 0;
      const { state: afterDraw, drawnCount } = drawCardsFor(next, playerId, 1 + bonus);
      return addLog(afterDraw, `${cardName}'s ${label} draws ${drawnCount} card(s) for ${playerId}.`);
    }

    case 'RESOLVE_DISCARD_THEN_SEARCH_PURGATORY': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'discard-then-search-purgatory') return state;
      const { playerId, cardName, label, searchQuery } = state.pendingChoice;
      const player = state.players[playerId];
      const card = player.hand.find(c => c.instanceId === action.instanceId);
      if (!card) return state;
      let next = {
        ...state,
        pendingChoice: null,
        players: {
          ...state.players,
          [playerId]: { ...player, hand: player.hand.filter(c => c.instanceId !== action.instanceId), purgatory: purgatoryAfterAdding(player.purgatory, card) },
        },
      };
      next = addLog(next, `${playerId} discards ${card.name} for ${cardName}'s ${label}.`);
      const searchCandidates = searchZoneCandidates(next.players[playerId].purgatory, searchQuery);
      if (searchCandidates.length === 0) {
        return addLog(next, `${cardName}'s ${label} finds no "${searchQuery}" in ${playerId}'s Purgatory.`);
      }
      next = addLog(next, `${cardName}'s ${label} searches ${playerId}'s Purgatory for "${searchQuery}" to add to hand.`);
      return { ...next, pendingChoice: { kind: 'search', playerId, source: 'purgatory', query: searchQuery, cardName } };
    }

    case 'RESOLVE_DISCARD_ONE_CARD': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'discard-one-card') return state;
      const { playerId, cardName, label, thenReturnPurgatoryQuery } = state.pendingChoice;
      const player = state.players[playerId];
      const card = player.hand.find(c => c.instanceId === action.instanceId);
      if (!card) return state;
      let next = {
        ...state,
        pendingChoice: null,
        players: {
          ...state.players,
          [playerId]: { ...player, hand: player.hand.filter(c => c.instanceId !== action.instanceId), purgatory: purgatoryAfterAdding(player.purgatory, card) },
        },
      };
      next = addLog(next, `${playerId} discards ${card.name} for ${cardName}'s ${label}.`);
      // Skeptical Scrawling's own "then return a Null Being From
      // Purgatory to hand" half — see DISCARD_ONE_CARD_THEN_RETURN_
      // PURGATORY_RE's own comment for why this rides along on the plain
      // discard-one-card pendingChoice instead of a dedicated kind.
      if (!thenReturnPurgatoryQuery) return next;
      const searchCandidates = searchZoneCandidates(next.players[playerId].purgatory, thenReturnPurgatoryQuery);
      if (searchCandidates.length === 0) {
        return addLog(next, `${cardName}'s ${label} finds no "${thenReturnPurgatoryQuery}" in ${playerId}'s Purgatory.`);
      }
      next = addLog(next, `${cardName}'s ${label} searches ${playerId}'s Purgatory for "${thenReturnPurgatoryQuery}" to return to hand.`);
      return { ...next, pendingChoice: { kind: 'search', playerId, source: 'purgatory', query: thenReturnPurgatoryQuery, cardName } };
    }

    case 'RESOLVE_CHOOSE_X_VALUE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'choose-x-value') return state;
      const { playerId, cardName, baseCost, maxX, effect, cellId, counterType } = state.pendingChoice;
      const value = action.value;
      if (!Number.isInteger(value) || value < 0 || value > maxX) return state;
      let next;
      if (effect === 'search-armament-cost-x-via-counters') {
        // Smithing Tools: (X) is paid by removing that many of its own
        // Forge Counters (already engaged as part of opening this choice —
        // see ACTIVATE_REMOVE_COUNTERS_X_SEARCH_ARMAMENT), not Essence.
        const occupant = state.board[cellId];
        const have = occupant?.counters?.[counterType] || 0;
        if (!occupant || have < value) return state;
        next = addLog(
          { ...state, pendingChoice: null, board: { ...state.board, [cellId]: { ...occupant, counters: { ...occupant.counters, [counterType]: have - value } } } },
          `${playerId} removes ${value} ${counterType} Counter(s) for ${cardName}'s ability.`
        );
      } else {
        // Blood Rites: (X) is paid as additional generic Essence, on top of
        // the card's own printed base cost.
        const player = state.players[playerId];
        const combinedCost = { faithless: baseCost.faithless + value, colored: baseCost.colored };
        if (!canPayCost(player.effigyPool, combinedCost)) return state;
        const explicitIds = validFaithlessSelection(player.effigyPool, combinedCost, action.faithlessInstanceIds) ? action.faithlessInstanceIds : null;
        const { remaining, spent } = payCost(player.effigyPool, combinedCost, explicitIds);
        next = addLog(
          { ...state, pendingChoice: null, players: { ...state.players, [playerId]: { ...player, effigyPool: remaining, effigySpentThisTurn: [...player.effigySpentThisTurn, ...spent] } } },
          `${playerId} pays ${value} additional Essence for ${cardName}'s (X).`
        );
      }
      // Reuses the existing 'search' pendingChoice's own costFilter field
      // (Death's Decanter) — a typing search ("Armament") narrowed to an
      // exact totalCastingCost match, rather than inventing a new kind.
      const candidates = searchZoneCandidates(state.players[playerId].mainDeck, 'Armament').filter(c => totalCastingCost(c) === value);
      if (candidates.length === 0) {
        return addLog(next, `${cardName} finds no Armament costing exactly ${value} in ${playerId}'s deck.`);
      }
      next = addLog(next, `${cardName} searches ${playerId}'s deck for an Armament costing exactly ${value} to add to hand.`);
      return { ...next, pendingChoice: { kind: 'search', playerId, source: 'mainDeck', query: 'Armament', costFilter: value, cardName } };
    }

    // False Testament: "When conjured you may have this enter with up to
    // (5) Time Counters." — writes the caster's chosen starting value
    // straight onto the Prophecy's own `timer` (its printed timerMax is 0,
    // an uncomputed "X" — cardData.js), same two-phase face-down/face-up
    // lifecycle any other Prophecy already follows from there.
    case 'RESOLVE_CHOOSE_PROPHECY_TIMER': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'choose-prophecy-timer') return state;
      const { playerId, cardName, cellId, maxValue } = state.pendingChoice;
      const value = action.value;
      if (!Number.isInteger(value) || value < 0 || value > maxValue) return state;
      const occupant = state.board[cellId];
      if (!occupant || occupant.type !== 'prophecy') return { ...state, pendingChoice: null };
      let next = { ...state, pendingChoice: null, board: { ...state.board, [cellId]: { ...occupant, timer: value } } };
      next = addLog(next, `${playerId} has ${cardName} enter with ${value} Time Counter(s).`);
      // A choice of 0 flips it face up (and resolves its own printed text)
      // immediately — the same two-phase finalization every other Prophecy
      // hitting 0 already goes through.
      return resolveProphecyModulateHitZero(next, cellId);
    }

    // Legion's Onset — the player already chose how many Vassal tokens to
    // summon (declare time capped this at both the "can't drop to 0"
    // Lifespan floor and the actual number of empty tiles available), so
    // this just pays the matching Lifespan (5 per token) and hands off to
    // the same board-native multi-cell picker Elderflower Ancient's own
    // Blooming Vine tokens use (summon-vine-tokens-toggle, generalized via
    // tokenKey/tokenName) so the player picks WHERE each one lands instead
    // of them being auto-placed.
    case 'RESOLVE_LEGION_ONSET_CHOOSE_COUNT': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'legion-onset-choose-count') return state;
      const { playerId, cardName, label, maxCount } = state.pendingChoice;
      const value = action.value;
      if (!Number.isInteger(value) || value < 0 || value > maxCount) return state;
      if (value === 0) {
        return addLog({ ...state, pendingChoice: null }, `${cardName}'s ${label} summons no Vassal tokens.`);
      }
      const cost = value * 5;
      const player = state.players[playerId];
      if (player.lifespan - cost <= 0) return state;
      let next = { ...state, players: { ...state.players, [playerId]: { ...player, lifespan: player.lifespan - cost } } };
      next = addLog(next, `${playerId} pays ${cost} Lifespan for ${value} Vassal token(s) from ${cardName}'s ${label}.`);
      // Was missing before this fix — every OTHER Lifespan-payment resolver
      // in this file calls this (e.g. RESOLVE_PAY_LIFESPAN_OPTIONAL above),
      // so Ravenous Lamtukka's own "Whenever you pay Lifespan gain +1/+1"
      // silently never fired off Legion's Onset specifically.
      next = triggerLifespanPaidReactions(next, playerId);
      next = checkWin(next);
      if (next.phase === 'gameover') return next;
      return {
        ...next,
        // `landDisengaged` (RESOLVE_SUMMON_VINE_TOKENS_CONFIRM's own
        // comment) — these Vassals are summoned via this Prophecy's own
        // flip-trigger during the Modulate step, strictly before this same
        // turn's Disengage step even runs, but the actual placement always
        // happens later still (behind this very pendingChoice the player
        // still has to resolve) — so no Disengage step this turn could
        // ever actually reach them regardless of step ordering. Confirmed
        // with the user: land them already Disengaged instead of leaving
        // them stuck an entire extra turn cycle for a step they could
        // never have made it into in the first place.
        pendingChoice: { kind: 'summon-vine-tokens-toggle', playerId, cardName, label, maxCount: value, selected: [], tokenKey: 'vassal', tokenName: 'Vassal', landDisengaged: true },
      };
    }

    case 'RESOLVE_FORCE_COMBAT_SELECT_MINE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'force-combat-select-mine') return state;
      const { playerId, cardName, label } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return state;
      const theirBeings = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && o.ownerId !== playerId);
      if (theirBeings.length === 1) {
        return forceCombatBetween({ ...state, pendingChoice: null }, cardName, label, action.cellId, theirBeings[0][0]);
      }
      let next = addLog(state, `${cardName}'s ${label} lets ${playerId} choose an opposing Being to force into combat.`);
      return { ...next, pendingChoice: { kind: 'force-combat-select-theirs', playerId, cardName, label, myCellId: action.cellId } };
    }

    case 'RESOLVE_FORCE_COMBAT_SELECT_THEIRS': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'force-combat-select-theirs') return state;
      const { playerId, cardName, label, myCellId } = state.pendingChoice;
      const mine = state.board[myCellId];
      const theirs = state.board[action.cellId];
      if (!mine || mine.type !== 'being' || mine.ownerId !== playerId || !theirs || theirs.type !== 'being' || theirs.ownerId === playerId) return state;
      return forceCombatBetween({ ...state, pendingChoice: null }, cardName, label, myCellId, action.cellId);
    }

    case 'RESOLVE_FAVOR_POINTED_TOGGLE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'favor-pointed-toggle') return state;
      const { maxCount, allowedCells, selected } = state.pendingChoice;
      if (!allowedCells.includes(action.cellId)) return state;
      const alreadySelected = selected.includes(action.cellId);
      if (!alreadySelected && selected.length >= maxCount) return state;
      const nextSelected = alreadySelected ? selected.filter(c => c !== action.cellId) : [...selected, action.cellId];
      return { ...state, pendingChoice: { ...state.pendingChoice, selected: nextSelected } };
    }

    case 'RESOLVE_FAVOR_POINTED_CONFIRM': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'favor-pointed-toggle') return state;
      const { cardName, label, selected } = state.pendingChoice;
      let next = selected.reduce((s, cell) => {
        const occ = s.board[cell];
        return occ ? { ...s, board: { ...s.board, [cell]: { ...occ, favorCounter: true } } } : s;
      }, { ...state, pendingChoice: null });
      return addLog(next, `${cardName}'s ${label} makes ${selected.length} Being(s) Favored.`);
    }

    case 'RESOLVE_DESTROY_POINTED_SUMMON_TOKEN': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'destroy-pointed-summon-token') return state;
      const { cardName, label, tokenName } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      const makeToken = TOKEN_REGISTRY[tokenName];
      if (!occupant || occupant.type !== 'being' || !makeToken) return { ...state, pendingChoice: null };
      let next = addLog({ ...state, pendingChoice: null }, `${cardName}'s ${label} destroys ${occupant.card.name}.`);
      next = destroyBeing(next, action.cellId);
      const token = makeToken();
      next = placeTokenOnBoard(next, playerId, token, action.cellId);
      return addLog(next, `${cardName}'s ${label} summons ${token.name} at ${action.cellId}.`);
    }

    case 'RESOLVE_SWITCH_WITH_TYPED': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'switch-with-typed') return state;
      const { cardName, label, selfCellId } = state.pendingChoice;
      const other = state.board[action.cellId];
      const self = state.board[selfCellId];
      if (!other || !self) return state;
      const next = {
        ...state,
        pendingChoice: null,
        board: { ...state.board, [selfCellId]: other, [action.cellId]: self },
      };
      return addLog(next, `${cardName}'s ${label} switches ${self.card.name} with ${other.card.name}.`);
    }

    case 'RESOLVE_DISCARD_TYPED': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'discard-typed') return state;
      const { playerId, cardName, label, drawCount } = state.pendingChoice;
      const player = state.players[playerId];
      const card = player.hand.find(c => c.instanceId === action.instanceId);
      if (!card) return state;
      let next = {
        ...state,
        pendingChoice: null,
        players: {
          ...state.players,
          [playerId]: { ...player, hand: player.hand.filter(c => c.instanceId !== action.instanceId), purgatory: purgatoryAfterAdding(player.purgatory, card) },
        },
      };
      next = addLog(next, `${playerId} discards ${card.name} for ${cardName}'s ${label}.`);
      if (drawCount) {
        const { state: afterDraw, drawnCount } = drawCardsFor(next, playerId, drawCount);
        next = addLog(afterDraw, `${cardName}'s ${label} draws ${drawnCount} card(s) for ${playerId}.`);
      }
      return next;
    }

    case 'RESOLVE_SHUFFLE_OR_KEEP': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'shuffle-or-keep') return state;
      const { playerId, deckOwner = playerId } = state.pendingChoice;
      let next = { ...state, pendingChoice: null };
      if (!action.shuffle) {
        return addLog(next, `${playerId} leaves the top of ${deckOwner}'s deck as it is.`);
      }
      const owner = next.players[deckOwner];
      const shuffled = [...owner.mainDeck]
        .map(c => ({ c, sort: Math.random() }))
        .sort((a, b) => a.sort - b.sort)
        .map(({ c }) => c);
      next = { ...next, players: { ...next.players, [deckOwner]: { ...owner, mainDeck: shuffled } } };
      return addLog(next, `${deckOwner}'s deck is shuffled.`);
    }

    case 'RESOLVE_REVEAL_PROPHECY': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'reveal-prophecy') return state;
      const { playerId } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'prophecy') return state;
      return addLog({ ...state, pendingChoice: null }, `${playerId} reveals ${occupant.card.name}, then returns it face down.`);
    }

    case 'RESOLVE_SACRIFICE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'sacrifice') return state;
      const { playerId } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return state;
      let next = addLog({ ...state, pendingChoice: null }, `${playerId} sacrifices ${occupant.card.name}.`);
      return destroyBeing(next, action.cellId);
    }

    case 'RESOLVE_SACRIFICE_ARMAMENT': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'sacrifice-armament') return state;
      const { playerId, cardName, drawCount } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      const entry = occupant?.armaments?.find(a => a.card.instanceId === action.armamentInstanceId);
      if (!occupant || occupant.ownerId !== playerId || !entry) return state;
      let next = addLog({ ...state, pendingChoice: null }, `${playerId} sacrifices ${entry.card.name} to ${cardName}'s When Summoned.`);
      next = removeArmamentEntry(next, action.cellId, action.armamentInstanceId, { toPurgatory: true });
      return resolveOrLogEffect(next, playerId, cardName, `draw (${drawCount}) card(s).`, 'When Summoned');
    }

    case 'RESOLVE_SACRIFICE_ARMAMENT_DAMAGE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'sacrifice-armament-damage') return state;
      const { playerId, cardName, label, context } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      const entry = occupant?.armaments?.find(a => a.card.instanceId === action.armamentInstanceId);
      if (!occupant || occupant.ownerId !== playerId || !entry) return state;
      const cost = totalCastingCost(entry.card);
      let next = addLog({ ...state, pendingChoice: null }, `${playerId} sacrifices ${entry.card.name} (cost ${cost}) to ${cardName}'s ${label}.`);
      next = removeArmamentEntry(next, action.cellId, action.armamentInstanceId, { toPurgatory: true });
      return resolveOrLogEffect(next, playerId, cardName, `Deal (${cost}) damage to any target.`, label, context);
    }

    case 'RESOLVE_MOVE_ARMAMENT_SOURCE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'move-armament-source') return state;
      const { playerId, cardName, label, context } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      const entry = occupant?.armaments?.find(a => a.card.instanceId === action.armamentInstanceId);
      if (!occupant || occupant.ownerId !== playerId || !entry) return state;
      const next = { ...state, pendingChoice: null };
      return placeMovedArmament(next, playerId, cardName, label, action.cellId, action.armamentInstanceId, context);
    }

    case 'RESOLVE_MOVE_ARMAMENT_ANY_SOURCE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'move-armament-any-source') return state;
      const { playerId, cardName, label } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      const entry = occupant?.armaments?.find(a => a.card.instanceId === action.armamentInstanceId);
      if (!occupant || occupant.ownerId !== playerId || !entry) return state;
      const next = { ...state, pendingChoice: null };
      return placeMovedArmamentAnyDirection(next, playerId, cardName, label, action.cellId, action.armamentInstanceId);
    }

    case 'RESOLVE_MOVE_ARMAMENT_DESTINATION': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'move-armament-destination') return state;
      const { cardName, label, fromCellId, armamentInstanceId, allowedCells } = state.pendingChoice;
      if (!allowedCells.includes(action.cellId)) return state;
      const next = { ...state, pendingChoice: null };
      return moveArmamentEntry(next, cardName, label, fromCellId, armamentInstanceId, action.cellId);
    }

    // Sha-KaRah: no "you control" restriction is printed, so unlike
    // RESOLVE_MOVE_ARMAMENT_ANY_SOURCE above, either owner's Armament is a
    // legal source here — only that it's actually adjacent to Sha-KaRah
    // itself, re-derived the same way getLegalActions' own offering does.
    case 'RESOLVE_MOVE_ADJACENT_ARMAMENT_SOURCE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'move-adjacent-armament-source') return state;
      const { playerId, cardName, label, selfCellId } = state.pendingChoice;
      const adjacentCells = [...new Set([1, 2, 3, 4, 5, 6, 7, 8].map(dir => computeMoveDestination(playerId, selfCellId, dir)))].filter(Boolean);
      const occupant = state.board[action.cellId];
      const entry = occupant?.armaments?.find(a => a.card.instanceId === action.armamentInstanceId);
      if (!occupant || !entry || !adjacentCells.includes(action.cellId)) return state;
      const next = { ...state, pendingChoice: null };
      return placeMovedArmamentAnyDirection(next, playerId, cardName, label, action.cellId, action.armamentInstanceId);
    }

    case 'RESOLVE_COPY_TEXTBOX_UNTIL_END_OF_TURN': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'copy-textbox-until-end-of-turn') return state;
      const { playerId, dyingCard, allowedCells } = state.pendingChoice;
      if (!allowedCells.includes(action.cellId)) return state;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'relic' || occupant.ownerId !== playerId) return state;
      const next = {
        ...state, pendingChoice: null,
        board: { ...state.board, [action.cellId]: grantBorrowedTextBox(occupant, dyingCard) },
      };
      return addLog(next, `${occupant.card.name} gains ${dyingCard.name}'s effect(s) until end of turn.`);
    }

    case 'RESOLVE_ENGAGE_EFFIGY_ADD_ESSENCE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'engage-effigy-add-essence') return state;
      const { playerId, cardName, label, amount, allowedInstanceIds } = state.pendingChoice;
      if (!allowedInstanceIds.includes(action.instanceId)) return state;
      const next = { ...state, pendingChoice: null };
      return engageEffigyAddEssence(next, playerId, cardName, label, action.instanceId, amount);
    }

    case 'ACTIVATE_SHIFT': {
      const playerId = state.turnPlayer;
      if (state.phase !== 'playing') return state;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId || occupant.engaged) return state;
      if (!occupant.card.keywords?.shift) return state;
      return offerOrPerformShift(state, playerId, action.cellId);
    }

    case 'RESOLVE_SHIFT_DESTINATION': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'shift-destination') return state;
      const { playerId, fromCellId, shiftOverride, postShiftLoseAmount, allowedCells } = state.pendingChoice;
      if (!allowedCells.includes(action.cellId)) return state;
      const next = { ...state, pendingChoice: null };
      return performShift(next, playerId, fromCellId, action.cellId, shiftOverride, false, 0, postShiftLoseAmount || 0);
    }

    case 'RESOLVE_SHIFT_RETURN': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'shift-return') return state;
      const { cellId, disengageOnReturn, allowedCells } = state.pendingChoice;
      if (!allowedCells.includes(action.cellId)) return state;
      const next = { ...state, pendingChoice: null };
      return placeReturnedFromShift(next, cellId, action.cellId, false, 0, disengageOnReturn || false);
    }

    case 'RESOLVE_GIVE_DIFFERENT_TYPED_BUFF': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'give-different-typed-buff') return state;
      const { cardName, label, strengthBonus, lifespanBonus, allowedCells } = state.pendingChoice;
      if (!allowedCells.includes(action.cellId)) return state;
      const occupant = state.board[action.cellId];
      if (!occupant) return state;
      const existing = occupant.permanentBonus || { strength: 0, lifespan: 0 };
      const next = {
        ...state,
        pendingChoice: null,
        board: {
          ...state.board,
          [action.cellId]: {
            ...occupant,
            permanentBonus: { strength: existing.strength + strengthBonus, lifespan: existing.lifespan + lifespanBonus },
            currentLifespan: occupant.currentLifespan + lifespanBonus,
          },
        },
      };
      return addLog(next, `${cardName}'s ${label} gives ${occupant.card.name} +${strengthBonus}/+${lifespanBonus}.`);
    }

    case 'RESOLVE_FORCE_SHIFT_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'force-shift-target') return state;
      const { amount, allowedCells } = state.pendingChoice;
      if (!allowedCells.includes(action.cellId)) return state;
      const occupant = state.board[action.cellId];
      if (!occupant) return state;
      const next = { ...state, pendingChoice: null };
      return offerOrPerformShift(next, occupant.ownerId, action.cellId, { amount, effect: null });
    }

    case 'RESOLVE_COPY_OPPONENT_EFFECT': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'copy-opponent-effect') return state;
      const { playerId, cardName, label, selfCellId, allowedCells } = state.pendingChoice;
      if (!allowedCells.includes(action.cellId)) return state;
      const target = state.board[action.cellId];
      const self = state.board[selfCellId];
      if (!target || !self) return state;
      const next = {
        ...state, pendingChoice: null,
        board: { ...state.board, [selfCellId]: grantCopiedEffectUntilNextTurn(self, target.card) },
      };
      return addLog(next, `${cardName}'s ${label} copies ${target.card.name}'s effect(s) until the end of ${playerId}'s next turn.`);
    }

    case 'RESOLVE_ECHOES_BOUNDLESS_SHIFT_INSTEAD': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'echoes-boundless-shift-instead') return state;
      const { playerId, dyingCard, amount } = state.pendingChoice;
      const player = state.players[playerId];
      if (!canPayCost(player.effigyPool, dyingCard.castingCost)) return state;
      const explicitIds = validFaithlessSelection(player.effigyPool, dyingCard.castingCost, action.faithlessInstanceIds) ? action.faithlessInstanceIds : null;
      const { remaining, spent } = payCost(player.effigyPool, dyingCard.castingCost, explicitIds);
      const purgatory = player.purgatory.filter(c => c.instanceId !== dyingCard.instanceId);
      let next = {
        ...state, pendingChoice: null,
        players: {
          ...state.players,
          [playerId]: { ...player, effigyPool: remaining, effigySpentThisTurn: [...player.effigySpentThisTurn, ...spent], purgatory },
        },
      };
      next = addLog(next, `${playerId} pays ${dyingCard.name}'s Summoning cost to Shift it instead of leaving it in Purgatory.`);
      return offerOrShiftFromPurgatory(next, playerId, dyingCard, amount);
    }

    case 'RESOLVE_SHIFT_FROM_PURGATORY_DESTINATION': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'shift-from-purgatory-destination') return state;
      const { playerId, card, amount, allowedCells } = state.pendingChoice;
      if (!allowedCells.includes(action.cellId)) return state;
      const next = { ...state, pendingChoice: null };
      return shiftFromPurgatory(next, playerId, card, action.cellId, amount);
    }

    case 'RESOLVE_UDARIK_SHIFT_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'udarik-shift-target') return state;
      const { playerId, shiftAmount, loseAmount, allowedCells } = state.pendingChoice;
      if (!allowedCells.includes(action.cellId)) return state;
      const next = { ...state, pendingChoice: null };
      return offerOrPerformShift(next, playerId, action.cellId, { amount: shiftAmount, effect: null }, false, 0, loseAmount);
    }

    case 'RESOLVE_DEJA_VU_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'deja-vu-target') return state;
      const { playerId, cardName, baseCost, deitySurcharge, allowedCells } = state.pendingChoice;
      if (!allowedCells.includes(action.cellId)) return state;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return state;
      const isDeity = !!occupant.card.isDeity;
      const combinedCost = dejaVuCombinedCost(baseCost, deitySurcharge, occupant.card, isDeity);
      const player = state.players[playerId];
      if (!canPayCost(player.effigyPool, combinedCost)) return state;
      const explicitIds = validFaithlessSelection(player.effigyPool, combinedCost, action.faithlessInstanceIds) ? action.faithlessInstanceIds : null;
      const { remaining, spent } = payCost(player.effigyPool, combinedCost, explicitIds);
      let next = {
        ...state,
        pendingChoice: null,
        players: {
          ...state.players,
          [playerId]: { ...player, effigyPool: remaining, effigySpentThisTurn: [...player.effigySpentThisTurn, ...spent] },
        },
      };
      const targetCard = occupant.card;
      const cellId = action.cellId;
      next = addLog(next, `${playerId} pays ${cardName}'s cost (targeting ${targetCard.name}) and returns ${targetCard.name} to hand.`);
      const board = { ...next.board };
      dropArmamentsOrDryadMount(board, cellId, occupant);
      next = { ...next, board };
      // "...then Summon it without paying its summoning cost" —
      // unconditional and immediate per the user's own ruling ("the
      // summoning can not be stopped since it is a part of the card
      // resolution"), on the exact same tile it just left. Reuses
      // placeBeingOnBoard so When Summoned retriggers exactly like any
      // other real summon (also the user's ruling).
      return placeBeingOnBoard(next, playerId, cellId, targetCard);
    }

    case 'RESOLVE_SUMMON_SACRIFICE_COST': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'summon-sacrifice-cost') return state;
      const { playerId, cardName, cellId, card, amount, selected } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId || selected.includes(action.cellId)) return state;
      const nextSelected = [...selected, action.cellId];
      if (nextSelected.length < amount) {
        return { ...state, pendingChoice: { ...state.pendingChoice, selected: nextSelected } };
      }
      // Last pick — sacrifice all of them (destroyBeing, not raw damage:
      // same "sacrifice, not damage" precedent as every other
      // sacrifice-as-a-cost effect — no owner Lifespan loss, Depart still
      // fires), then place the Being that was waiting on this cost.
      const names = nextSelected.map(cell => state.board[cell].card.name);
      let next = nextSelected.reduce((s, cell) => destroyBeing(s, cell), { ...state, pendingChoice: null });
      next = addLog(next, `${playerId} sacrifices ${names.join(', ')} as an additional cost to summon ${cardName}.`);
      return placeBeingOnBoard(next, playerId, cellId, card);
    }

    case 'RESOLVE_SACRIFICE_DESTROY': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'sacrifice-destroy') return state;
      const { playerId, cardName } = state.pendingChoice;
      const prophecy = state.board[action.prophecyCellId];
      const target = state.board[action.targetCellId];
      if (!prophecy || prophecy.type !== 'prophecy' || prophecy.ownerId !== playerId) return state;
      if (!target || target.type !== 'being' || target.card.isDeity) return state;

      const owner = state.players[playerId];
      let next = {
        ...state,
        pendingChoice: null,
        board: { ...state.board },
        players: { ...state.players, [playerId]: { ...owner, purgatory: purgatoryAfterAdding(owner.purgatory, prophecy.card) } },
      };
      delete next.board[action.prophecyCellId];
      next = addLog(next, `${playerId} sacrifices ${prophecy.card.name} to ${cardName}'s When Summoned.`);
      next = addLog(next, `${cardName}'s When Summoned destroys ${target.card.name}.`);
      return destroyBeing(next, action.targetCellId);
    }

    case 'RESOLVE_DESTROY_PERMANENT': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'destroy-permanent') return state;
      const { targetKind } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== targetKind) return { ...state, pendingChoice: null };
      return destroyPermanentAt({ ...state, pendingChoice: null }, action.cellId);
    }

    case 'RESOLVE_DESTROY_ARMAMENT': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'destroy-armament') return state;
      const entry = state.board[action.cellId]?.armaments?.find(a => a.card.instanceId === action.armamentInstanceId);
      if (!entry) return { ...state, pendingChoice: null };
      return destroyArmamentEntryAt({ ...state, pendingChoice: null }, action.cellId, action.armamentInstanceId);
    }

    case 'RESOLVE_DESTROY_RELIC_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'destroy-relic-target') return state;
      const next = { ...state, pendingChoice: null };
      if (action.armamentInstanceId) {
        const entry = state.board[action.cellId]?.armaments?.find(a => a.card.instanceId === action.armamentInstanceId);
        if (!entry) return next;
        return destroyRelicTarget(next, { cellId: action.cellId, armamentInstanceId: action.armamentInstanceId });
      }
      const occupant = state.board[action.cellId];
      if (!occupant || (occupant.type !== 'relic' && !(occupant.type === 'being' && occupant.card.isRelicBeing))) return next;
      return destroyRelicTarget(next, { cellId: action.cellId, armamentInstanceId: null });
    }

    case 'RESOLVE_SACRIFICE_RELIC_COST_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'sacrifice-relic-cost-target') return state;
      const { playerId, cardName, effectText, label, context } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.ownerId !== playerId) return state;
      let target;
      let name;
      if (action.armamentInstanceId) {
        const entry = occupant.armaments?.find(a => a.card.instanceId === action.armamentInstanceId);
        if (!entry) return state;
        target = { cellId: action.cellId, armamentInstanceId: action.armamentInstanceId };
        name = entry.card.name;
      } else {
        if (occupant.type !== 'relic' && !(occupant.type === 'being' && occupant.card.isRelicBeing)) return state;
        target = { cellId: action.cellId, armamentInstanceId: null };
        name = occupant.card.name;
      }
      let next = addLog({ ...state, pendingChoice: null }, `${playerId} sacrifices ${name} for ${cardName}'s ${label}.`);
      next = destroyRelicTarget(next, target);
      return resolveOrLogEffect(next, playerId, cardName, effectText, label, context);
    }

    case 'RESOLVE_GRANT_FAVOR': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'grant-favor') return state;
      const { playerId, anyOwner, permanent, typing } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || (!anyOwner && occupant.ownerId !== playerId)) return state;
      if (typing && !(occupant.card.typing || '').toLowerCase().includes(typing.toLowerCase())) return state;
      let next = {
        ...state,
        pendingChoice: null,
        board: {
          ...state.board,
          [action.cellId]: { ...occupant, favorCounter: true, ...(permanent ? {} : { favorCounterExpiresEndOfTurn: true }) },
        },
      };
      return addLog(next, `${occupant.card.name} becomes Favored${permanent ? '' : ' until end of turn'}.`);
    }

    case 'RESOLVE_BUFF_ALLY': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'buff-ally') return state;
      const { playerId, cardName, cost, strengthBonus, lifespanBonus } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return state;
      const player = state.players[playerId];
      if (player.lifespan - cost <= 0) return state;

      const permanentBonus = {
        strength: (occupant.permanentBonus?.strength || 0) + strengthBonus,
        lifespan: (occupant.permanentBonus?.lifespan || 0) + lifespanBonus,
      };
      let next = {
        ...state,
        pendingChoice: null,
        players: { ...state.players, [playerId]: { ...player, lifespan: player.lifespan - cost } },
        board: {
          ...state.board,
          [action.cellId]: { ...occupant, permanentBonus, currentLifespan: occupant.currentLifespan + lifespanBonus },
        },
      };
      next = addLog(next, `${playerId} pays ${cost} Lifespan for ${cardName}'s When Summoned.`);
      next = addLog(next, `${occupant.card.name} gains +${strengthBonus}/+${lifespanBonus}.`);
      return triggerLifespanPaidReactions(next, playerId);
    }

    case 'RESOLVE_SHUFFLE_OR_DRAW': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'shuffle-or-draw') return state;
      const { playerId, cardName, shuffleCount, drawCount } = state.pendingChoice;
      let next = { ...state, pendingChoice: null };
      const player = next.players[playerId];
      if (action.shuffle) {
        const fromPurgatory = player.purgatory.slice(0, shuffleCount);
        if (fromPurgatory.length === 0) {
          return addLog(next, `${cardName}'s When Summoned finds ${playerId}'s Purgatory empty.`);
        }
        const remainingPurgatory = player.purgatory.slice(fromPurgatory.length);
        const shuffled = [...player.mainDeck, ...fromPurgatory]
          .map(c => ({ c, sort: Math.random() }))
          .sort((a, b) => a.sort - b.sort)
          .map(({ c }) => c);
        next = {
          ...next,
          players: { ...next.players, [playerId]: { ...player, mainDeck: shuffled, purgatory: remainingPurgatory } },
        };
        return addLog(next, `${playerId} shuffles ${fromPurgatory.length} card(s) from Purgatory into their deck.`);
      }
      let drawnCount = 0;
      for (let i = 0; i < drawCount; i++) {
        const p = next.players[playerId];
        const { deck, drawn, penalty } = drawCard(p.mainDeck);
        next = {
          ...next,
          players: {
            ...next.players,
            [playerId]: { ...p, mainDeck: deck, hand: drawn ? [...p.hand, drawn] : p.hand, lifespan: p.lifespan - penalty },
          },
        };
        if (drawn) drawnCount++;
        if (penalty > 0) next = addLog(next, `${playerId} tried to draw from an empty Main Deck and loses ${penalty} Lifespan.`);
      }
      return addLog(next, `${cardName}'s When Summoned draws ${drawnCount} card(s) for ${playerId}.`);
    }

    case 'RESOLVE_RESTORE_OR_SUMMON_VINE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'restore-or-summon-vine') return state;
      const { playerId, cardName, label, restoreAmount, tokenCount } = state.pendingChoice;
      if (action.choice === 'restore') {
        let next = addLog({ ...state, pendingChoice: null }, `${cardName}'s ${label} lets ${playerId} choose a target to restore ${restoreAmount} Lifespan to.`);
        return { ...next, pendingChoice: { kind: 'restore-lifespan-target', playerId, cardName, label, amount: restoreAmount } };
      }
      if (action.choice === 'summon') {
        let next = addLog({ ...state, pendingChoice: null }, `${cardName}'s ${label} lets ${playerId} choose up to ${tokenCount} tile(s) to summon Blooming Vine tokens on.`);
        return { ...next, pendingChoice: { kind: 'summon-vine-tokens-toggle', playerId, cardName, label, maxCount: tokenCount, selected: [] } };
      }
      return state;
    }

    case 'RESOLVE_RESTORE_LIFESPAN_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'restore-lifespan-target') return state;
      const { cardName, label, amount } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || !(occupant.type === 'being' || animatedTopEntry(occupant))) return state;
      const view = actorView(occupant);
      // A Being's own printed Lifespan is its max — restoring past it
      // fizzles the excess (user ruling) rather than overshooting it, so a
      // Being already at (or within `amount` of) max is still a legal
      // target, it just gains less than the full amount, possibly 0.
      const restored = Math.max(0, Math.min(amount, view.card.lifespan - view.currentLifespan));
      const next = {
        ...state, pendingChoice: null,
        board: { ...state.board, [action.cellId]: writeActorState(occupant, { currentLifespan: view.currentLifespan + restored }) },
      };
      return addLog(next, restored >= amount
        ? `${cardName}'s ${label} restores ${restored} Lifespan to ${view.card.name}.`
        : restored > 0
          ? `${cardName}'s ${label} restores ${restored} Lifespan to ${view.card.name} (${amount - restored} fizzles — already at max).`
          : `${cardName}'s ${label} fizzles — ${view.card.name} is already at max Lifespan.`);
    }

    case 'RESOLVE_RESTORE_LIFESPAN_TARGET_PLAYER': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'restore-lifespan-target') return state;
      const { playerId, cardName, label, amount } = state.pendingChoice;
      const targetPlayerId = action.targetPlayerId;
      if (targetPlayerId !== 'A' && targetPlayerId !== 'B') return state;
      const target = state.players[targetPlayerId];
      let next = {
        ...state, pendingChoice: null,
        players: { ...state.players, [targetPlayerId]: { ...target, lifespan: target.lifespan + amount } },
      };
      return addLog(next, `${playerId} chooses ${targetPlayerId}'s Lifespan to restore ${amount} for ${cardName}'s ${label}.`);
    }

    case 'RESOLVE_SUMMON_VINE_TOKENS_TOGGLE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'summon-vine-tokens-toggle') return state;
      const { playerId, maxCount, selected } = state.pendingChoice;
      if (!emptyMortalCellsFor(state.board, playerId).includes(action.cellId)) return state;
      const alreadySelected = selected.includes(action.cellId);
      if (!alreadySelected && selected.length >= maxCount) return state;
      const nextSelected = alreadySelected ? selected.filter(c => c !== action.cellId) : [...selected, action.cellId];
      return { ...state, pendingChoice: { ...state.pendingChoice, selected: nextSelected } };
    }

    case 'RESOLVE_SUMMON_VINE_TOKENS_CONFIRM': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'summon-vine-tokens-toggle') return state;
      // tokenKey/tokenName default to Blooming Vine (Elderflower Ancient,
      // the original caller) — Legion's Onset's own count-choice step sets
      // both explicitly to summon Vassal tokens instead through this same
      // generic multi-cell picker. `landDisengaged` is Legion's Onset's own
      // flag too (see its own comment) — every other caller leaves it
      // unset, so its tokens keep entering Engaged (summoning sickness) as
      // normal.
      const { playerId, cardName, label, selected, tokenKey, tokenName, landDisengaged } = state.pendingChoice;
      const makeToken = TOKEN_REGISTRY[tokenKey || 'blooming vine'];
      const name = tokenName || 'Blooming Vine';
      let next = selected.reduce((s, cell) => {
        if (s.board[cell]) return s;
        const placed = placeTokenOnBoard(s, playerId, makeToken(), cell);
        return landDisengaged && placed.board[cell]?.type === 'being'
          ? { ...placed, board: { ...placed.board, [cell]: { ...placed.board[cell], engaged: false } } }
          : placed;
      }, { ...state, pendingChoice: null });
      return addLog(next, selected.length > 0
        ? `${cardName}'s ${label} summons ${selected.length} ${name} token(s).`
        : `${cardName}'s ${label} summons no ${name} tokens.`);
    }

    case 'RESOLVE_COPY_STATS': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'copy-stats') return state;
      const { playerId, cardName, selfCellId } = state.pendingChoice;
      const target = state.board[action.cellId];
      const self = state.board[selfCellId];
      if (!target || target.type !== 'being' || target.ownerId !== playerId) return state;
      if (!self || self.type !== 'being') return state;
      const copiedStrength = effectiveStrength(target);
      let next = {
        ...state,
        pendingChoice: null,
        board: {
          ...state.board,
          [selfCellId]: { ...self, strengthOverride: copiedStrength, currentLifespan: target.currentLifespan },
        },
      };
      return addLog(next, `${cardName}'s When Summoned becomes ${copiedStrength}/${target.currentLifespan}, matching ${target.card.name}.`);
    }

    case 'RESOLVE_DOESNT_DISENGAGE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'doesnt-disengage') return state;
      const { cardName } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.card.isDeity) return state;
      let next = {
        ...state,
        pendingChoice: null,
        board: { ...state.board, [action.cellId]: { ...occupant, engaged: true, doesNotDisengage: true } },
      };
      return addLog(next, `${cardName}'s When Summoned engages ${occupant.card.name} — it won't disengage next Disengage Step.`);
    }

    case 'RESOLVE_DESPERATE_FINALE_TARGET': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'desperate-finale-target') return state;
      const { playerId, cardName } = state.pendingChoice;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId || !occupant.engaged) return state;
      if (state.players[playerId].lifespan - occupant.card.lifespan <= 0) return state;
      return resolveDesperateFinale(state, playerId, cardName, action.cellId);
    }

    case 'RESOLVE_TOKEN_LOCATION': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'token-location') return state;
      const { playerId, cardName, tokenName, purgatoryInstanceId, allowedCells, forceEngaged, remaining } = state.pendingChoice;
      if (state.board[action.cellId] || !mortalCellsFor(playerId).includes(action.cellId)
        || (allowedCells && !allowedCells.includes(action.cellId))) {
        return { ...state, pendingChoice: null };
      }
      // Same "choose an empty tile" flow, two different payloads: a fresh
      // token (the common case — see TOKEN_REGISTRY), or a specific card
      // already found in Purgatory (Cemetery Physician's own variable-X
      // sacrifice ability) that just needs somewhere to land.
      if (purgatoryInstanceId) {
        const found = state.players[playerId].purgatory.find(c => c.instanceId === purgatoryInstanceId);
        if (!found) return { ...state, pendingChoice: null };
        const purged = {
          ...state,
          pendingChoice: null,
          players: {
            ...state.players,
            [playerId]: { ...state.players[playerId], purgatory: state.players[playerId].purgatory.filter(c => c.instanceId !== purgatoryInstanceId) },
          },
        };
        let next = addLog(purged, `${playerId} chooses ${found.name} to summon from Purgatory (${cardName}).`);
        next = placeBeingOnBoard(next, playerId, action.cellId, found);
        // Armor Animus's own granted "Summon this in the Mortal Realm
        // engaged" — forces engaged regardless of what placeBeingOnBoard's
        // own default rule would have set (a Persist Being would otherwise
        // enter disengaged).
        if (forceEngaged && next.board[action.cellId]) {
          next = { ...next, board: { ...next.board, [action.cellId]: { ...next.board[action.cellId], engaged: true } } };
        }
        return next;
      }
      const makeToken = TOKEN_REGISTRY[tokenName];
      if (!makeToken) return { ...state, pendingChoice: null };
      const token = makeToken();
      let next = placeTokenOnBoard({ ...state, pendingChoice: null }, playerId, token, action.cellId);
      next = addLog(next, `${cardName} summons ${token.name} at ${action.cellId}.`);
      // Multi-token summon (Scā-vuhk Hunger's own "create (2) ... tokens" —
      // see the SUMMON_TOKEN_RE handler above): reopen the same choice for
      // the next token instead of clearing it, as long as there's still
      // both a token left to place and an empty tile left to place it on —
      // degrades gracefully (stops early, same as any other "ran out of
      // legal targets" case in this file) if the board fills up first.
      if (remaining > 1 && emptyMortalCellsFor(next.board, playerId).length > 0) {
        return { ...next, pendingChoice: { kind: 'token-location', playerId, cardName, tokenName, remaining: remaining - 1 } };
      }
      return next;
    }

    // "Summon a/an <Name> token ... on any tile this points to" (Blooming
    // Seed) — a dedicated kind, not 'token-location' above, since its
    // candidate pool (a fixed set of pointed cells, already computed and
    // filtered to empty when the choice opened) isn't restricted to the
    // caster's own Mortal Realm side the way `mortalCellsFor` requires.
    case 'RESOLVE_SUMMON_TOKEN_POINTED': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'summon-token-pointed') return state;
      const { playerId, cardName, tokenName, allowedCells } = state.pendingChoice;
      if (state.board[action.cellId] || !allowedCells.includes(action.cellId)) {
        return { ...state, pendingChoice: null };
      }
      const makeToken = TOKEN_REGISTRY[tokenName];
      if (!makeToken) return { ...state, pendingChoice: null };
      const token = makeToken();
      let next = placeTokenOnBoard({ ...state, pendingChoice: null }, playerId, token, action.cellId);
      return addLog(next, `${cardName} summons ${token.name} at ${action.cellId}.`);
    }

    // Death's Decanter's "Remove (X) Crossing Counters: Sacrifice this
    // Relic, then add a Formless Being with Conjuring cost (X) from your
    // Purgatory to hand." — action.amount (chosen at offer time, see
    // getLegalActions) IS X: it both counts as the "Counters removed" cost
    // and the target search cost, so there's nothing left to spend once
    // the Relic itself is sacrificed (no separate counter decrement).
    case 'ACTIVATE_REMOVE_COUNTERS_SACRIFICE_SEARCH': {
      const playerId = state.turnPlayer;
      if (state.phase !== 'playing') return state;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'relic' || occupant.ownerId !== playerId) return state;
      const ability = occupant.card.keywords?.removeCountersSacrificeSearchTypedCost;
      const have = occupant.counters?.[ability?.counterType] || 0;
      if (!ability || action.amount < 1 || action.amount > have) return state;
      let next = addLog(state, `${playerId} removes ${action.amount} ${ability.counterType} Counter(s) and sacrifices ${occupant.card.name}.`);
      next = sacrificeOccupantAt(next, action.cellId);
      const player = next.players[playerId];
      const matches = purgatoryTypedBeingsWithCost(player.purgatory, ability.typing, action.amount);
      if (matches.length === 0) {
        return addLog(next, `${occupant.card.name} finds no ${ability.typing} Being with cost ${action.amount} in ${playerId}'s Purgatory.`);
      }
      if (matches.length === 1) {
        const found = matches[0];
        const purgatory = player.purgatory.filter(c => c.instanceId !== found.instanceId);
        next = { ...next, players: { ...next.players, [playerId]: { ...player, purgatory, hand: [...player.hand, found] } } };
        return addLog(next, `${playerId} adds ${found.name} to hand.`);
      }
      next = addLog(next, `${occupant.card.name} lets ${playerId} choose a ${ability.typing} Being with cost ${action.amount} to add to hand.`);
      return {
        ...next,
        pendingChoice: { kind: 'search', playerId, source: 'purgatory', query: ability.typing, cardName: occupant.card.name, costFilter: action.amount },
      };
    }

    // "Remove (X) Crossing Counters, Engage: Restore (X) Lifespan to
    // target." (Sanative Siphon) — decrement the counters, tap the Relic,
    // then open the already-generic 'restore-lifespan-target' pendingChoice
    // (Being or either player's Lifespan) for the chosen X.
    case 'ACTIVATE_REMOVE_COUNTERS_ENGAGE_RESTORE': {
      const playerId = state.turnPlayer;
      if (state.phase !== 'playing') return state;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'relic' || occupant.ownerId !== playerId || occupant.engaged) return state;
      const ability = occupant.card.keywords?.removeCountersEngageRestoreLifespan;
      const have = occupant.counters?.[ability?.counterType] || 0;
      if (!ability || action.amount < 1 || action.amount > have) return state;
      let next = addLog(state, `${playerId} removes ${action.amount} ${ability.counterType} Counter(s) and Engages ${occupant.card.name}.`);
      next = {
        ...next,
        board: {
          ...next.board,
          [action.cellId]: {
            ...occupant,
            engaged: true,
            counters: { ...occupant.counters, [ability.counterType]: have - action.amount },
          },
        },
      };
      return {
        ...next,
        pendingChoice: { kind: 'restore-lifespan-target', playerId, cardName: occupant.card.name, label: 'Engage ability', amount: action.amount },
      };
    }

    // Mausoleum Gates' own standing "you may summon Undead from Purgatory
    // until the end of your turn" window — reuses summonFromPurgatoryToOpenCell
    // (the same "1 empty tile: place immediately; >1: open a
    // 'token-location' pendingChoice" flow Cemetery Physician's own variable
    // summon already uses), just re-checked against the live window list
    // rather than a fixed query, so it can't be dispatched after the
    // window's already closed (endTurn, turn.js).
    case 'ACTIVATE_SUMMON_TYPED_FROM_PURGATORY_WINDOW': {
      const playerId = state.turnPlayer;
      if (state.phase !== 'playing') return state;
      const player = state.players[playerId];
      const windows = player.summonTypedFromPurgatoryWindows || [];
      const found = player.purgatory.find(c => c.instanceId === action.instanceId);
      if (!found || windows.length === 0) return state;
      if (!windows.some(typing => (found.typing || '').toLowerCase().includes(typing.toLowerCase()))) return state;
      // Still a real summon, still costs Effigy — see the matching comment
      // on this action's own getLegalActions offer, above.
      const cost = effectiveCastingCost(found, state, playerId);
      if (!canPayCost(player.effigyPool, cost)) return state;
      const { remaining, spent } = payCost(player.effigyPool, cost);
      const paidState = {
        ...state,
        players: {
          ...state.players,
          [playerId]: { ...player, effigyPool: remaining, effigySpentThisTurn: [...player.effigySpentThisTurn, ...spent] },
        },
      };
      return summonFromPurgatoryToOpenCell(paidState, playerId, 'the Purgatory window', found);
    }

    // Cemetery Physician's "Once per turn sacrifice (X) <Name>: Summon a
    // Being from your Purgatory with cost (X)" — a 3-step flow: pick any
    // number of the named Relic to sacrifice (ACTIVATE_SACRIFICE_X_SUMMON
    // opens the toggle, RESOLVE_SACRIFICE_X_TOGGLE adjusts it,
    // RESOLVE_SACRIFICE_X_CONFIRM commits), then choose which matching
    // Purgatory Being if more than one shares that cost
    // (RESOLVE_SUMMON_FROM_PURGATORY_COST), then choose where to land it
    // if more than one Mortal Realm tile is open (the same 'token-location'
    // flow above, reused via its purgatoryInstanceId payload).
    case 'ACTIVATE_SACRIFICE_X_SUMMON': {
      const playerId = state.turnPlayer;
      if (state.phase !== 'playing') return state;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return state;
      const sacrificeXSummon = occupant.card.keywords?.sacrificeXSummon;
      if (!sacrificeXSummon || occupant.usedSacrificeXThisTurn) return state;
      if (ownedFodderCells(state.board, playerId, sacrificeXSummon.fodderName).length === 0) return state;
      if (emptyMortalCellsFor(state.board, playerId).length === 0) return state;
      let next = addLog(state, `${playerId} begins choosing how many ${sacrificeXSummon.fodderName} to sacrifice for ${occupant.card.name}.`);
      // "Once per turn" is consumed by ACTIVATING the ability, not by
      // successfully completing it — set here, not (only) in
      // RESOLVE_SACRIFICE_X_CONFIRM below. Self-play found that backing out
      // via RESOLVE_DECLINE (no X value has a real Purgatory match, so
      // CONFIRM is never even offered — see its own gate) never set this
      // flag, leaving the ability re-activatable in the same turn: the AI
      // would activate it, toggle, discover nothing matches, decline, and
      // immediately activate it again, forever.
      next = {
        ...next,
        board: { ...next.board, [action.cellId]: { ...occupant, usedSacrificeXThisTurn: true } },
      };
      return {
        ...next,
        pendingChoice: {
          kind: 'sacrifice-x-toggle', playerId, cardName: occupant.card.name, cellId: action.cellId,
          fodderName: sacrificeXSummon.fodderName, selected: [], optional: true,
        },
      };
    }

    // Smithing Tools: "Engage a Being, Gain (1) Forge Counter." — engages a
    // DIFFERENT un-Engaged Being the player controls (not Smithing Tools
    // itself), then grants the counter straight onto Smithing Tools.
    case 'ACTIVATE_ENGAGE_BEING_GRANT_COUNTER': {
      const playerId = state.turnPlayer;
      if (state.phase !== 'playing') return state;
      const occupant = state.board[action.cellId];
      if (!occupant || (occupant.type !== 'being' && occupant.type !== 'relic') || occupant.ownerId !== playerId) return state;
      const grant = occupant.card.keywords?.engageBeingGrantCounter;
      if (!grant) return state;
      const candidates = Object.entries(state.board).filter(([, o]) => o?.type === 'being' && o.ownerId === playerId && !o.engaged);
      if (candidates.length === 0) return state;
      const applyGrant = (st, engageCellId) => {
        const engagedOccupant = st.board[engageCellId];
        let next = { ...st, board: { ...st.board, [engageCellId]: { ...engagedOccupant, engaged: true } } };
        const self = next.board[action.cellId];
        const have = self.counters?.[grant.counterType] || 0;
        next = { ...next, board: { ...next.board, [action.cellId]: { ...self, counters: { ...self.counters, [grant.counterType]: have + grant.amount } } } };
        return addLog(next, `${playerId} Engages ${engagedOccupant.card.name} for ${occupant.card.name}'s ability — gains ${grant.amount} ${grant.counterType} Counter(s).`);
      };
      if (candidates.length === 1) return applyGrant(state, candidates[0][0]);
      let next = addLog(state, `${occupant.card.name} lets ${playerId} choose a Being to Engage.`);
      return { ...next, pendingChoice: { kind: 'engage-grant-counter-source', playerId, cardName: occupant.card.name, selfCellId: action.cellId, counterType: grant.counterType, amount: grant.amount } };
    }

    // Smithing Tools' own second ability: "Engage, Remove (X) Forge
    // Counters: Add an Armament from deck to hand with conjuring cost (X)."
    // — taps itself, then opens the shared numeric-choice UI (reused from
    // Blood Rites' own "(X)" picker — see RESOLVE_CHOOSE_X_VALUE's own
    // `effect` branch) bounded by however many counters it actually holds.
    case 'ACTIVATE_REMOVE_COUNTERS_X_SEARCH_ARMAMENT': {
      const playerId = state.turnPlayer;
      if (state.phase !== 'playing') return state;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'relic' || occupant.ownerId !== playerId || occupant.engaged) return state;
      const ability = occupant.card.keywords?.removeCountersXSearchArmament;
      if (!ability) return state;
      const maxX = occupant.counters?.[ability.counterType] || 0;
      let next = { ...state, board: { ...state.board, [action.cellId]: { ...occupant, engaged: true } } };
      next = addLog(next, `${playerId} Engages ${occupant.card.name} and begins choosing how many ${ability.counterType} Counters to remove.`);
      return {
        ...next,
        pendingChoice: {
          kind: 'choose-x-value', playerId, cardName: occupant.card.name, maxX,
          effect: 'search-armament-cost-x-via-counters', cellId: action.cellId, counterType: ability.counterType,
        },
      };
    }

    case 'ACTIVATE_TIMES_PER_TURN_ABILITY': {
      const playerId = state.turnPlayer;
      if (state.phase !== 'playing') return state;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return state;
      const ability = occupant.card.keywords?.timesPerTurnAbility;
      if (!ability) return state;
      const used = occupant.timesPerTurnUsed || 0;
      if (used >= ability.times) return state;
      let next = {
        ...state,
        board: { ...state.board, [action.cellId]: { ...occupant, timesPerTurnUsed: used + 1 } },
      };
      next = addLog(next, `${playerId} activates ${occupant.card.name}'s ability (${used + 1}/${ability.times} this turn).`);
      return resolveOrLogEffect(next, playerId, occupant.card.name, ability.effect, 'ability', { selfCellId: action.cellId });
    }

    // "Pay (N) <Color>: <effect>" (Blooming Seed) / "Burn (N) <Color>: X"
    // (Skeleton Key, a Relic) — see payEffigyCostAbility, cardData.js.
    // Spends real Effigy directly (not through payCost/castingCost — this
    // isn't a card being cast, just a bare activated ability's own cost)
    // then resolves the effect.
    case 'ACTIVATE_PAY_EFFIGY_COST_ABILITY': {
      const playerId = state.turnPlayer;
      if (state.phase !== 'playing') return state;
      const occupant = state.board[action.cellId];
      if (!occupant || (occupant.type !== 'being' && occupant.type !== 'relic') || occupant.ownerId !== playerId) return state;
      const ability = occupant.card.keywords?.payEffigyCostAbility;
      if (!ability) return state;
      if (ability.once && (occupant.timesPerTurnUsed || 0) >= 1) return state;
      const player = state.players[playerId];
      const cost = Math.max(0, ability.amount - pointedActivationCostReduction(state, playerId, action.cellId, ability.color));
      const have = payablePool(player.effigyPool).filter(e => e.effigyType === ability.color).length;
      if (have < cost) return state;
      let pool = [...player.effigyPool];
      for (let i = 0; i < cost; i++) {
        const idx = pool.findIndex(e => e.effigyType === ability.color && !e.engaged);
        pool.splice(idx, 1);
      }
      // payEffigyAbilityUsesThisTurn is tracked regardless of `ability.once`
      // (unlike timesPerTurnUsed just above, which only matters for a
      // printed cap) — a card whose own printed cost gets reduced all the
      // way to 0 by another permanent (e.g. Nursery Attendant pointing at
      // a Seed) has no real resource ever running out, so nothing else in
      // this reducer ever stops it being re-legal every single time. Purely
      // a hook for ai.js's own scoring (see scoreAction there) to
      // deprioritize repeating a played-out free ability below PASS_TURN
      // once it's already been used this turn — self-play found this exact
      // shape (Samara Seed's "Pay (1) Living: Add (1) Growth Counter."
      // reduced to Pay 0) as a real, otherwise-endless stall, since a
      // Being that's already used its own Engage/Martyr this turn still
      // has nothing else worth doing. Not a legality change: the ability
      // stays exactly as repeatable as before at the reducer/getLegalActions
      // level, only the greedy AI's own preference changes.
      let next = {
        ...state,
        players: { ...state.players, [playerId]: { ...player, effigyPool: pool } },
        board: {
          ...state.board,
          [action.cellId]: {
            ...occupant,
            payEffigyAbilityUsesThisTurn: (occupant.payEffigyAbilityUsesThisTurn || 0) + 1,
            ...(ability.once ? { timesPerTurnUsed: (occupant.timesPerTurnUsed || 0) + 1 } : {}),
          },
        },
      };
      next = addLog(next, `${playerId} pays ${cost} ${ability.color} for ${occupant.card.name}'s ability.`);
      return resolveOrLogEffect(next, playerId, occupant.card.name, ability.effect, 'ability', { selfCellId: action.cellId });
    }

    // Sha-KaRah: "Pay (5) Lifespan to move an adjacent Armament one tile in
    // any direction." — see payLifespanCostAbility, cardData.js. Same shape
    // as ACTIVATE_PAY_EFFIGY_COST_ABILITY above, just spending real
    // Lifespan instead of Effigy.
    case 'ACTIVATE_PAY_LIFESPAN_COST_ABILITY': {
      const playerId = state.turnPlayer;
      if (state.phase !== 'playing') return state;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return state;
      const ability = occupant.card.keywords?.payLifespanCostAbility;
      if (!ability) return state;
      const player = state.players[playerId];
      if (player.lifespan - ability.amount <= 0) return state;
      let next = {
        ...state,
        players: { ...state.players, [playerId]: { ...player, lifespan: player.lifespan - ability.amount } },
      };
      next = addLog(next, `${playerId} pays ${ability.amount} Lifespan for ${occupant.card.name}'s ability.`);
      return resolveOrLogEffect(next, playerId, occupant.card.name, ability.effect, 'ability', { selfCellId: action.cellId });
    }

    // "Remove (N) <Type> Counter(s): Sacrifice this, <effect>" (Blooming
    // Seed) — see counterCostSacrificeAbility, cardData.js. Removes the
    // counters as a real cost (checked again here, not just in
    // getLegalActions, same defense-in-depth every other cost check in
    // this file uses), then resolveOrLogEffect's own SACRIFICE_THIS_THEN_RE
    // branch handles the actual self-sacrifice.
    case 'ACTIVATE_COUNTER_COST_SACRIFICE': {
      const playerId = state.turnPlayer;
      if (state.phase !== 'playing') return state;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return state;
      const ability = occupant.card.keywords?.counterCostSacrificeAbility;
      if (!ability) return state;
      const have = occupant.counters?.[ability.type] || 0;
      if (have < ability.amount) return state;
      let next = {
        ...state,
        board: { ...state.board, [action.cellId]: { ...occupant, counters: { ...occupant.counters, [ability.type]: have - ability.amount } } },
      };
      next = addLog(next, `${playerId} removes ${ability.amount} ${ability.type} Counter(s) from ${occupant.card.name}.`);
      return resolveOrLogEffect(next, playerId, occupant.card.name, `Sacrifice this, ${ability.effect}`, 'ability', { selfCellId: action.cellId });
    }

    case 'RESOLVE_SACRIFICE_X_TOGGLE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'sacrifice-x-toggle') return state;
      const { playerId, fodderName, selected } = state.pendingChoice;
      if (!ownedFodderCells(state.board, playerId, fodderName).includes(action.cellId)) return state;
      const nextSelected = selected.includes(action.cellId)
        ? selected.filter(c => c !== action.cellId)
        : [...selected, action.cellId];
      return { ...state, pendingChoice: { ...state.pendingChoice, selected: nextSelected } };
    }

    case 'RESOLVE_SACRIFICE_X_CONFIRM': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'sacrifice-x-toggle') return state;
      const { playerId, cardName, cellId, selected } = state.pendingChoice;
      const x = selected.length;
      if (x === 0 || purgatoryBeingsWithCost(state.players[playerId].purgatory, x).length === 0) return state;

      let next = selected.reduce((s, fodderCellId) => sacrificeOccupantAt(s, fodderCellId), { ...state, pendingChoice: null });
      next = addLog(next, `${playerId} sacrifices ${x} for ${cardName}.`);
      const sourceOccupant = next.board[cellId];
      if (sourceOccupant) {
        next = { ...next, board: { ...next.board, [cellId]: { ...sourceOccupant, usedSacrificeXThisTurn: true } } };
      }
      const matches = purgatoryBeingsWithCost(next.players[playerId].purgatory, x);
      if (matches.length > 1) {
        next = addLog(next, `${cardName} lets ${playerId} choose which cost-${x} Being to summon from Purgatory.`);
        return { ...next, pendingChoice: { kind: 'summon-from-purgatory-cost', playerId, cardName, cost: x } };
      }
      return summonFromPurgatoryToOpenCell(next, playerId, cardName, matches[0]);
    }

    case 'RESOLVE_SUMMON_FROM_PURGATORY_COST': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'summon-from-purgatory-cost') return state;
      const { playerId, cardName, cost } = state.pendingChoice;
      const found = purgatoryBeingsWithCost(state.players[playerId].purgatory, cost).find(c => c.instanceId === action.instanceId);
      if (!found) return { ...state, pendingChoice: null };
      return summonFromPurgatoryToOpenCell({ ...state, pendingChoice: null }, playerId, cardName, found);
    }

    case 'RESOLVE_SUMMON_DIFFERENT_TYPED_FROM_PURGATORY': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'summon-different-typed-from-purgatory') return state;
      const { playerId, cardName, typing, excludeName } = state.pendingChoice;
      const found = state.players[playerId].purgatory.find(c =>
        c.instanceId === action.instanceId
        && (c.typing || '').toLowerCase().includes(typing.toLowerCase())
        && c.name.toLowerCase() !== excludeName
      );
      if (!found) return { ...state, pendingChoice: null };
      return summonFromPurgatoryToOpenCell({ ...state, pendingChoice: null }, playerId, cardName, found);
    }

    case 'RESOLVE_SHUFFLE_PURGATORY_TOGGLE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'shuffle-purgatory-toggle') return state;
      const { playerId, query, maxCount, selected } = state.pendingChoice;
      const candidateIds = searchZoneCandidates(state.players[playerId].purgatory, query).map(c => c.instanceId);
      if (!candidateIds.includes(action.instanceId)) return state;
      const alreadySelected = selected.includes(action.instanceId);
      if (!alreadySelected && selected.length >= maxCount) return state;
      const nextSelected = alreadySelected
        ? selected.filter(id => id !== action.instanceId)
        : [...selected, action.instanceId];
      return { ...state, pendingChoice: { ...state.pendingChoice, selected: nextSelected } };
    }

    case 'RESOLVE_SHUFFLE_PURGATORY_CONFIRM': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'shuffle-purgatory-toggle') return state;
      const { playerId, cardName, label, selected, then } = state.pendingChoice;
      const cards = selected
        .map(id => state.players[playerId].purgatory.find(c => c.instanceId === id))
        .filter(Boolean);
      let next = cards.reduce((s, card) => shuffleFromPurgatoryIntoDeck(s, playerId, card), { ...state, pendingChoice: null });
      next = addLog(next, cards.length > 0
        ? `${playerId} shuffles ${cards.length} card(s) into their deck for ${cardName}'s ${label}.`
        : `${playerId} shuffles nothing into their deck for ${cardName}'s ${label}.`);
      if (!then) return next;
      const { state: afterDraw, drawnCount } = drawCardsFor(next, playerId, then.drawCount);
      return addLog(afterDraw, `${cardName}'s ${label} draws ${drawnCount} card(s) for ${playerId}.`);
    }

    case 'ACTIVATE_ARMAMENT_SACRIFICE': {
      const playerId = state.turnPlayer;
      if (state.phase !== 'playing') return state;
      const occupant = state.board[action.cellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId) return state;
      const entry = (occupant.armaments || []).find(a => a.card.instanceId === action.armamentInstanceId);
      if (!entry || !entry.card.keywords?.sacrificeForFavored) return state;

      const armaments = occupant.armaments.filter(a => a.card.instanceId !== action.armamentInstanceId);
      const next = {
        ...state,
        board: { ...state.board, [action.cellId]: { ...occupant, armaments, favorCounter: true } },
      };
      return addLog(next, `${playerId} sacrifices ${entry.card.name}, giving ${occupant.card.name} a Favored Counter.`);
    }

    // Armor Animus/HeartWood Locket: an attached Armament's OWN "Martyr: X"
    // — engaging and sacrificing the ARMAMENT itself (not the wearer, which
    // stays right where it is), mirroring ACTIVATE_MARTYR's own cost/log
    // shape but scoped to one `armaments` entry. No Purgatory add for the
    // sacrificed Armament — same "just removed" precedent
    // ACTIVATE_ARMAMENT_SACRIFICE above already established (an Armament,
    // unlike a Being, never goes to Purgatory when sacrificed this way).
    case 'ACTIVATE_ARMAMENT_MARTYR': {
      const playerId = state.turnPlayer;
      if (state.phase !== 'playing') return state;
      const occupant = state.board[action.cellId];
      if (!occupant || (occupant.type !== 'being' && occupant.type !== 'armament-stack') || occupant.ownerId !== playerId) return state;
      const entry = (occupant.armaments || []).find(a => a.card.instanceId === action.armamentInstanceId);
      if (!entry || entry.card.keywords?.martyr == null) return state;
      const player = state.players[playerId];
      if (!martyrCostPayable(entry, player.effigyPool)) return state;

      const armaments = occupant.armaments.filter(a => a.card.instanceId !== action.armamentInstanceId);
      const martyrCounterCost = entry.card.keywords?.martyrCounterCost;
      const martyrEffigyCost = entry.card.keywords?.martyrEffigyCost;
      const spentEffigy = martyrEffigyCost
        ? payCost(player.effigyPool, { faithless: 0, colored: { [martyrEffigyCost.color]: martyrEffigyCost.amount } })
        : null;
      let next = {
        ...state,
        board: { ...state.board, [action.cellId]: { ...occupant, armaments } },
        players: {
          ...state.players,
          [playerId]: {
            ...player,
            ...(spentEffigy ? { effigyPool: spentEffigy.remaining, effigySpentThisTurn: [...player.effigySpentThisTurn, ...spentEffigy.spent] } : {}),
          },
        },
      };
      if (martyrCounterCost) {
        next = addLog(next, `${playerId} spends ${martyrCounterCost.amount} ${martyrCounterCost.type} Counter(s) for ${entry.card.name}'s Martyr.`);
      }
      if (martyrEffigyCost) {
        next = addLog(next, `${playerId} pays ${martyrEffigyCost.amount} ${martyrEffigyCost.color} Essence for ${entry.card.name}'s Martyr.`);
      }
      next = addLog(next, `${playerId} engages and sacrifices ${entry.card.name} for Martyr.`);
      next = addLog(next, `${entry.card.name}'s Martyr triggers.`);
      return resolveOrLogEffect(next, playerId, entry.card.name, entry.card.keywords.martyr, 'Martyr', { selfCellId: action.cellId });
    }

    case 'ATTACH_ARMAMENT': {
      const playerId = state.turnPlayer;
      const player = state.players[playerId];
      if (state.phase !== 'playing') return state;
      if (!mortalCellsFor(playerId).includes(action.cellId)) return state;
      const occupant = state.board[action.cellId];
      if (!armamentTargetOk(occupant, playerId)) return state;
      const card = player.hand.find(c => c.instanceId === action.instanceId);
      if (!card || card.kind !== 'relic-armament') return state;
      const cost = effectiveCastingCost(card, state, playerId);
      if (!canPayCost(player.effigyPool, cost)) return state;

      const explicitIds = validFaithlessSelection(player.effigyPool, cost, action.faithlessInstanceIds) ? action.faithlessInstanceIds : null;
      const { remaining, spent } = payCost(player.effigyPool, cost, explicitIds);
      // Stacks onto whatever's already there — a Being, another Armament
      // pile, or (if the tile was empty) a brand-new freestanding pile. Each
      // Armament is its own independently engageable permanent (see
      // ACTIVATE_ARMAMENT_ENGAGE), so it's stored as a small { card, engaged }
      // wrapper rather than the bare card. "When summoned gain (N) <Name>
      // Counters" (e.g. Feathers of the Fallen) is this Armament's own ETB —
      // it's attaching right now, so the counters start on it immediately.
      const counterGrant = card.keywords?.armamentCounterGrant;
      // An Animated Armament (RULES.md > Keywords) tracks its own Lifespan
      // independently, the same way a Being's `currentLifespan` sits beside
      // its card — it only ever matters once this entry is the topmost one
      // on a Being-less pile (see animatedTopEntry), but it's set up front
      // here so it just travels along with the entry wherever it goes,
      // rather than needing to be (re-)initialized at every later point it
      // might become relevant. A freshly-attached Animated entry always
      // becomes the new acting top (insertArmamentEntry), so it starts with
      // whatever Lifespan bonus the pile it's landing on already carries —
      // same "buried Armaments still contribute to whatever's currently
      // acting" rule applyLifespanBonusToArmamentEntry enforces for bonuses
      // that arrive *after* it, just applied up front instead.
      const existingLifespanBonus = (occupant?.armaments || [])
        .reduce((sum, a) => sum + (a.card.keywords?.statBonus?.lifespan || 0), 0);
      const newEntry = {
        card,
        engaged: false,
        ...(counterGrant ? { counters: { [counterGrant.type]: counterGrant.amount } } : {}),
        ...(card.keywords?.animated ? { currentLifespan: card.lifespan + existingLifespanBonus } : {}),
      };
      const insertedArmaments = insertArmamentEntry(occupant?.armaments || [], newEntry, !!card.keywords?.animated);
      // A non-Animated entry sliding in below an existing Animated top
      // still grants that top its own Lifespan bonus (see
      // applyLifespanBonusToArmamentEntry above) — only relevant when it
      // didn't become the new top itself (insertArmamentEntry already
      // guarantees a *newly* Animated entry always does).
      const finalArmaments = !card.keywords?.animated
        ? applyLifespanBonusToArmamentEntry(insertedArmaments, newEntry.card.keywords?.statBonus?.lifespan || 0)
        : insertedArmaments;
      const newOccupant = occupant
        ? { ...occupant, armaments: finalArmaments }
        : { type: 'armament-stack', ownerId: playerId, armaments: finalArmaments };
      let next = {
        ...state,
        board: { ...state.board, [action.cellId]: newOccupant },
        players: {
          ...state.players,
          [playerId]: {
            ...player,
            hand: player.hand.filter(c => c.instanceId !== action.instanceId),
            effigyPool: remaining,
            effigySpentThisTurn: [...player.effigySpentThisTurn, ...spent],
          },
        },
      };
      const targetLabel = occupant?.type === 'being' ? occupant.card.name : 'the tile';
      next = addLog(next, `${playerId} attaches ${card.name} to ${targetLabel} at ${action.cellId}.`);
      if (occupant?.type === 'being') {
        next = applyNewArmamentsLifespanBonus(next, action.cellId, [newEntry]);
      }
      // Animated (RULES.md > Keywords): "While in the Mortal Realm this is
      // treated as a Being." Landing on a previously EMPTY tile makes this
      // entry the acting top of a brand-new pile with nothing else in it —
      // a real Being being summoned, for every "a Being is summoned under
      // your control" reaction (Happy Hammer's own moveAutoAttachArmaments;
      // any future onTypedSummonedUnderControl watcher), not just its own
      // stats/Engage text. Attaching onto an existing Being or an existing
      // freestanding pile doesn't qualify — a Being was already there, or
      // the pile's own identity doesn't actually change the way a
      // freshly-created one does.
      if (!occupant && card.keywords?.animated) {
        next = moveAutoAttachArmaments(next, playerId, action.cellId);
        next = triggerTypedSummonReactions(next, playerId, action.cellId, card);
      }
      return next;
    }

    case 'CAST_CONJURING': {
      // A reactive Ethereal Conjuring cast (state.reactiveWindow open) is
      // cast by whoever currently holds the window, not necessarily
      // state.turnPlayer — every other reference in this whole case body
      // already goes through this same local `playerId`, never
      // state.turnPlayer again, so this one line is sufficient.
      const playerId = state.reactiveWindow?.openFor ?? state.turnPlayer;
      const player = state.players[playerId];
      if (state.phase !== 'playing') return state;
      const card = player.hand.find(c => c.instanceId === action.instanceId);
      if (!card || (card.kind !== 'conjuring' && card.kind !== 'ethereal-conjuring')) return state;

      // Deja Vu: nothing is paid or resolved yet here — its combined cost
      // depends on whichever Being ends up targeted (RULES.md's ruling),
      // so the card just leaves hand (irreversibly committed, same as any
      // other Conjuring) and a dedicated pendingChoice opens with its
      // candidates already restricted to what dejaVuCandidates found
      // affordable (the same check that gated ever offering this action).
      if (card.keywords?.dejaVu) {
        const allowedCells = dejaVuCandidates(state, playerId, card);
        if (allowedCells.length === 0) return state;
        let next = {
          ...state,
          players: {
            ...state.players,
            [playerId]: {
              ...player,
              hand: player.hand.filter(c => c.instanceId !== action.instanceId),
              purgatory: purgatoryAfterAdding(player.purgatory, card),
            },
          },
        };
        next = addLog(next, `${playerId} casts ${card.name}.`);
        next = triggerOnConjureReactions(next, playerId);
        return {
          ...next,
          pendingChoice: {
            kind: 'deja-vu-target', playerId, cardName: card.name,
            baseCost: card.castingCost, deitySurcharge: card.keywords.dejaVuDeitySurcharge || null,
            allowedCells,
          },
        };
      }

      // Blood Rites: "Add an Armament that costs (X) from deck to hand.
      // Until the end of turn, each Bleeding Essence in its cost may be
      // paid with (10) lifespan instead." — the (X) is chosen by the
      // caster as part of paying the printed "X, Bleeding" cost, per the
      // user's own ruling. The fixed 1 Bleeding is paid immediately; X
      // itself (any amount up to what's left affordable) is chosen via a
      // new pendingChoice, then paid as generic/Faithless Essence and used
      // as the exact-cost search filter — see RESOLVE_CHOOSE_X_VALUE.
      // The Lifespan-substitution ruling only ever kicks in automatically
      // when the real Bleeding Essence genuinely isn't available (this
      // session's established "only ask when it's a real choice"
      // philosophy) — a caster who actually holds a Bleeding Essence still
      // pays it normally, same as before this ruling. Floored so it can't
      // drop the caster to 0 Lifespan, same "can't drop to 0" gate every
      // other optional Lifespan cost in this file already uses.
      if (card.keywords?.searchDeckArmamentCostX) {
        const normalPayable = canPayCost(player.effigyPool, card.castingCost);
        const bleedingNeeded = card.castingCost.colored?.bleeding || 0;
        const lifespanSubstituteCost = bleedingNeeded * 10;
        const substituteBaseCost = { ...card.castingCost, colored: { ...card.castingCost.colored, bleeding: 0 } };
        const canSubstitute = !normalPayable && bleedingNeeded > 0
          && player.lifespan - lifespanSubstituteCost > 0
          && canPayCost(player.effigyPool, substituteBaseCost);
        if (!normalPayable && !canSubstitute) return state;
        const usingSubstitute = !normalPayable && canSubstitute;
        const effectiveBaseCost = usingSubstitute ? substituteBaseCost : card.castingCost;
        const payingPlayer = usingSubstitute ? { ...player, lifespan: player.lifespan - lifespanSubstituteCost } : player;
        const { remaining: afterBase } = payCost(payingPlayer.effigyPool, effectiveBaseCost);
        const maxX = payablePool(afterBase).length;
        let next = {
          ...state,
          players: {
            ...state.players,
            [playerId]: { ...payingPlayer, hand: payingPlayer.hand.filter(c => c.instanceId !== action.instanceId), purgatory: purgatoryAfterAdding(payingPlayer.purgatory, card) },
          },
        };
        next = addLog(next, usingSubstitute
          ? `${playerId} casts ${card.name}, paying its Bleeding Essence with ${lifespanSubstituteCost} Lifespan instead.`
          : `${playerId} casts ${card.name}.`);
        return checkWin({
          ...next,
          pendingChoice: { kind: 'choose-x-value', playerId, cardName: card.name, baseCost: effectiveBaseCost, maxX, effect: 'search-armament-cost-x' },
        });
      }

      const conjureCost = effectiveCastingCost(card, state, playerId);
      if (!canPayCost(player.effigyPool, conjureCost)) return state;
      if (STRIKE_DOWN_RE.test(stripFlavorText(card.textBox) || '')) {
        const blockingCell = attackPendingBlockingCell(state);
        if (!blockingCell || state.board[blockingCell]?.type !== 'being') return state;
      }
      // Desperate Finale: won't be offered at all without an affordable
      // engaged Being to pay its own additional cost with — same "graceful
      // non-offer" precedent as every other additional-cost gate.
      const isDesperateFinale = card.keywords?.conjureCost && LIFESPAN_EQUAL_TARGET_ENGAGED_RE.test(card.keywords.conjureCost);
      if (isDesperateFinale && !hasAffordableEngagedTarget(state.board, state.players, playerId)) return state;

      const explicitIds = validFaithlessSelection(player.effigyPool, conjureCost, action.faithlessInstanceIds) ? action.faithlessInstanceIds : null;
      const { remaining, spent } = payCost(player.effigyPool, conjureCost, explicitIds);
      let next = {
        ...state,
        players: {
          ...state.players,
          [playerId]: {
            ...player,
            hand: player.hand.filter(c => c.instanceId !== action.instanceId),
            purgatory: purgatoryAfterAdding(player.purgatory, card),
            effigyPool: remaining,
            effigySpentThisTurn: [...player.effigySpentThisTurn, ...spent],
          },
        },
      };
      next = addLog(next, `${playerId} casts ${card.name}.`);
      next = triggerOnConjureReactions(next, playerId);
      if (isDesperateFinale) {
        const candidates = Object.entries(next.board).filter(([, o]) =>
          o?.type === 'being' && o.ownerId === playerId && o.engaged && next.players[playerId].lifespan - o.card.lifespan > 0
        );
        if (candidates.length === 1) {
          return resolveDesperateFinale(next, playerId, card.name, candidates[0][0]);
        }
        next = addLog(next, `${playerId} chooses which engaged Being to pay ${card.name}'s additional cost with.`);
        return { ...next, pendingChoice: { kind: 'desperate-finale-target', playerId, cardName: card.name } };
      }
      return resolveOrLogEffect(next, playerId, card.name, card.textBox, 'effect');
    }

    case 'ACTIVATE_REANIMATE_FROM_PURGATORY': {
      const playerId = state.turnPlayer;
      if (state.phase !== 'playing') return state;
      const player = state.players[playerId];
      const purgCard = player.purgatory.find(c => c.instanceId === action.purgatoryInstanceId);
      if (!purgCard) return state;
      const reaction = purgCard.keywords?.reanimateOnSacrificedTypedToken;
      if (!reaction || (player.reanimatedFromPurgatoryThisTurn || []).includes(purgCard.name)) return state;
      const sacrificed = state.board[action.sacrificeCellId];
      if (!sacrificed || sacrificed.type !== 'being' || sacrificed.ownerId !== playerId || !sacrificed.card.isToken) return state;
      if (!(sacrificed.card.typing || '').toLowerCase().includes(reaction.typing.toLowerCase())) return state;

      // destroyBeing (not a raw board delete) — same "sacrifice, not
      // damage" precedent as every other sacrifice-as-a-cost effect: no
      // owner Lifespan loss, Depart still fires if present, and the death
      // still counts toward Plague Doctor's own "died under your control
      // this turn" tracking. A real token is never actually added to
      // Purgatory (purgatoryAfterAdding already no-ops for card.isToken),
      // so this is safe here too.
      let next = destroyBeing(addLog(state, `${playerId} sacrifices ${sacrificed.card.name} to reanimate ${purgCard.name} from Purgatory.`), action.sacrificeCellId);
      const ownerAfterSacrifice = next.players[playerId];
      next = {
        ...next,
        players: {
          ...next.players,
          [playerId]: {
            ...ownerAfterSacrifice,
            purgatory: ownerAfterSacrifice.purgatory.filter(c => c.instanceId !== purgCard.instanceId),
            reanimatedFromPurgatoryThisTurn: [...(ownerAfterSacrifice.reanimatedFromPurgatoryThisTurn || []), purgCard.name],
          },
        },
      };
      return placeBeingOnBoard(next, playerId, action.sacrificeCellId, purgCard);
    }

    case 'ACTIVATE_MARTYR': {
      const playerId = state.turnPlayer;
      if (state.phase !== 'playing') return state;
      const occupant = state.board[action.cellId];
      // Almost always a Being, but Relics can print a bare "Martyr" too
      // (Bag o' Bones — no effect text at all, just "engage and sacrifice
      // this, for nothing extra"). `keywords.martyr === ''` for that bare
      // case (vs `null` for no Martyr at all) — checked with `== null`
      // rather than plain truthiness so the empty string still counts as
      // "has Martyr", and resolveOrLogEffect below gracefully no-ops on it.
      const isMartyrable = occupant?.type === 'being' || occupant?.type === 'relic';
      if (!occupant || !isMartyrable || occupant.ownerId !== playerId || occupant.engaged) return state;
      const martyrText = effectiveMartyr(state, action.cellId, occupant);
      if (martyrText == null) return state;
      if (!martyrCostPayable(occupant, state.players[playerId].effigyPool)) return state;

      const board = { ...state.board };
      dropArmamentsOrDryadMount(board, action.cellId, occupant);
      const owner = state.players[playerId];
      const martyrCounterCost = occupant.card.keywords?.martyrCounterCost;
      const martyrEffigyCost = occupant.card.keywords?.martyrEffigyCost;
      const spentEffigy = martyrEffigyCost
        ? payCost(owner.effigyPool, { faithless: 0, colored: { [martyrEffigyCost.color]: martyrEffigyCost.amount } })
        : null;
      let next = {
        ...state,
        board,
        players: {
          ...state.players,
          [playerId]: {
            ...owner,
            purgatory: purgatoryAfterAdding(owner.purgatory, occupant.card),
            ...(spentEffigy ? { effigyPool: spentEffigy.remaining, effigySpentThisTurn: [...owner.effigySpentThisTurn, ...spentEffigy.spent] } : {}),
          },
        },
      };
      if (martyrCounterCost) {
        next = addLog(next, `${playerId} spends ${martyrCounterCost.amount} ${martyrCounterCost.type} Counter(s) for ${occupant.card.name}'s Martyr.`);
      }
      if (martyrEffigyCost) {
        next = addLog(next, `${playerId} pays ${martyrEffigyCost.amount} ${martyrEffigyCost.color} Essence for ${occupant.card.name}'s Martyr.`);
      }
      next = addLog(next, `${playerId} engages and sacrifices ${occupant.card.name} for Martyr.`);
      if (occupant.type === 'being') next = incrementBeingsDiedThisTurn(next, playerId);
      if (occupant.type === 'being') next = triggerOwnBeingDiedReactions(next, playerId);
      if (occupant.type === 'being') next = triggerAnyBeingDiedCounterGain(next);
      if (occupant.type === 'being') next = triggerAnyBeingDiedGiveDifferentBuff(next, playerId);
      if (occupant.type === 'being') next = triggerDeckSearchOnTypedDeath(next, playerId, occupant.card.typing);
      next = logDepartIfPresent(next, occupant, action.cellId);
      next = addLog(next, `${occupant.card.name}'s Martyr triggers.`);
      // selfCounters carries the sacrificed occupant's own Counters through
      // — needed by Time Capsule's own "repeat for each Time Counter on
      // this". selfArrows does the same for any "...on a tile this points
      // to" Martyr text (Samara Seed's own Invoke) — both are captured
      // here, before the sacrifice, since the tile is already vacated
      // (`board` above) by the time this resolves, and effects reading
      // context.selfCellId/context.selfArrows would otherwise find nothing
      // there to read arrows/counters off of. Harmlessly unread by every
      // other Martyr text.
      next = resolveOrLogEffect(next, playerId, occupant.card.name, martyrText, 'Martyr', { selfCellId: action.cellId, selfCounters: occupant.counters, selfArrows: occupant.card.arrows });
      next = triggerMartyrTypedReactions(next, playerId, occupant.card);
      // Wretched Remnants' own offer waits until Martyr's own effect (which
      // may itself open a pendingChoice) has fully resolved — inserting it
      // any earlier would risk resolveOrLogEffect's own unconditional
      // pendingChoice write silently clobbering it, the opposite of the
      // "later trigger waits" precedent logDepartIfPresent establishes.
      if (occupant.type === 'being') next = triggerWretchedRemnantsOffer(next, playerId, occupant.card);
      if (occupant.type === 'being') next = triggerEchoesOfBoundlessOffer(next, playerId, occupant.card);
      return next;
    }

    case 'ACTIVATE_ENGAGE': {
      // Engage abilities are "ethereal speed" — activatable reactively
      // during an open priority window too, not just on the turn player's
      // own main phase (see the matching getLegalActions branch above).
      const playerId = state.reactiveWindow?.openFor ?? state.turnPlayer;
      // Phase 2 of the priority-window rework (see the approved plan): a
      // fresh Engage attempt (no reactiveWindow already open) declares —
      // costs are paid, but the engaged-flip and the ability's own effect
      // are BOTH deferred behind a real priority window — while an
      // ACTIVATE_ENGAGE dispatched AS A RESPONSE (reactiveWindow already
      // open) keeps today's atomic behavior unchanged: cost, engage, and
      // effect all in one step, no new stack depth. Only ACTIVATE_ENGAGE
      // itself gets this split this phase — ACTIVATE_GROUND_RELIC_ENGAGE/
      // ACTIVATE_ARMAMENT_ENGAGE stay atomic, a deliberate, documented
      // scope boundary (no real card in the user's own examples needs
      // them deferred yet), not an oversight.
      const isReactiveResponse = !!state.reactiveWindow;
      if (state.phase !== 'playing') return state;
      const occupant = state.board[action.cellId];
      const isEngageable = occupant?.type === 'being' || occupant?.type === 'relic';
      if (!occupant || !isEngageable || occupant.ownerId !== playerId || occupant.engaged) return state;

      // A card with more than one independent Engage ability (Osteomancer)
      // is selected by `action.abilityIndex`; every other card just uses
      // its own single ability (or one granted by an attached Armament —
      // see effectiveEngage), same as before this existed.
      const ownAbilities = occupant.card.keywords?.engageAbilities || [];
      let engageEffect;
      let lifespanCost;
      let condition;
      let extraCost;
      let counterCost;
      if (ownAbilities.length > 1 && action.abilityIndex != null) {
        const ability = ownAbilities[action.abilityIndex];
        if (!ability) return state;
        ({ effect: engageEffect, lifespanCost, condition, extraCost } = ability);
      } else {
        engageEffect = effectiveEngage(occupant);
        const engageKeywords = occupant.card.keywords || {};
        lifespanCost = engageKeywords.engageLifespanCost;
        condition = engageKeywords.engageCondition;
        extraCost = engageKeywords.engageExtraCost;
        counterCost = engageKeywords.engageCounterCost;
      }
      if (!engageEffect) return state;
      lifespanCost = lifespanCost || 0;
      const player = state.players[playerId];
      if (!engageConditionMet(condition, state.board, playerId, state.altars[playerId], state.groundRelics)) return state;
      if (player.lifespan - lifespanCost <= 0) return state;
      const { payable: extraCostPayable, sacrificeCellId } = engageExtraCostSacrificeCell(extraCost, state.board, playerId);
      if (!extraCostPayable) return state;
      // "Remove (N) <Type> Counter(s): Engage then <effect>" (Crucible) —
      // spending the permanent's own Counters is part of the cost, same
      // shape as Shifting Sands' groundRelicEngageCostPayable, just for a
      // normal board Relic instead of one living in groundRelics.
      const haveCounters = counterCost ? (occupant.counters?.[counterCost.type] || 0) : 0;
      if (counterCost && haveCounters < counterCost.amount) return state;

      let next = {
        ...state,
        board: {
          ...state.board,
          [action.cellId]: {
            ...occupant,
            // The engaged-flip itself is part of what's deferred for a
            // fresh declaration (see the design-fork comment above the
            // reducer case) — Boknean Wine's own "Engage target being"
            // already excludes already-engaged Beings from its own
            // candidate pool (applyEngageStatBuff's own resolveOrLogEffect
            // branch), so flipping this immediately would make it
            // structurally impossible for a response to ever "get there
            // first" and negate the attempt, contradicting the user's own
            // worked example. A response (isReactiveResponse) still flips
            // it immediately, unchanged from before.
            ...(isReactiveResponse ? { engaged: true } : {}),
            ...(counterCost ? { counters: { ...occupant.counters, [counterCost.type]: haveCounters - counterCost.amount } } : {}),
          },
        },
      };
      // Every cost below is paid/sunk immediately regardless of declare
      // vs. response — only the engaged-flip and the ability's own effect
      // are ever deferred, matching this engine's established "a paid
      // cost doesn't refund on a fizzled effect" convention.
      if (lifespanCost > 0) {
        next = {
          ...next,
          players: { ...next.players, [playerId]: { ...player, lifespan: player.lifespan - lifespanCost } },
        };
        next = addLog(next, `${playerId} pays ${lifespanCost} Lifespan to engage ${occupant.card.name}.`);
        next = triggerLifespanPaidReactions(next, playerId);
      }
      let sacrificedCardName = null;
      if (sacrificeCellId) {
        const sacrificed = next.board[sacrificeCellId];
        // engageExtraCostSacrificeCell's own candidate search already
        // matches an Animated Armament acting as a Being (e.g. Bag o'
        // Bones animated via "Animate") — that occupant has no top-level
        // `.card` (only `.armaments[i].card`), unlike a real Being/Relic.
        // Reading `.card.name` unconditionally crashed the moment the
        // sacrifice candidate was one of those (self-play found this a
        // real, reachable crash).
        const sacrificedCard = sacrificed.card || sacrificed.armaments[sacrificed.armaments.length - 1].card;
        sacrificedCardName = sacrificedCard.name;
        next = addLog(next, `${playerId} sacrifices ${sacrificedCardName} to engage ${occupant.card.name}.`);
        next = sacrificeOccupantAt(next, sacrificeCellId);
      }
      if (counterCost) {
        next = addLog(next, `${playerId} spends ${counterCost.amount} ${counterCost.type} Counter(s) to engage ${occupant.card.name}.`);
      }
      // selfCellId now passed for a Relic's own Engage too, not just a
      // Being's — every resolver branch that reads it already checks the
      // occupant's own type first (e.g. self-damage requires a Being), so
      // this is harmless for patterns that don't apply to a Relic.
      // excludeName is Osteomancer's own "different" exclusion — the name
      // of whatever was just sacrificed to pay this same Engage's extra
      // cost, so "Summon a different Undead from your Purgatory" can't
      // just re-summon the identical card it consumed (SUMMON_DIFFERENT_
      // TYPED_FROM_PURGATORY_RE, above). Only added to context when there
      // actually was a sacrifice, so every other Engage's context shape is
      // unchanged.
      const engageContext = { selfCellId: action.cellId, ...(sacrificedCardName ? { excludeName: sacrificedCardName } : {}) };
      if (isReactiveResponse) {
        next = addLog(next, `${playerId} engages ${occupant.card.name}'s ability.`);
        return resolveOrLogEffect(next, playerId, occupant.card.name, engageEffect, 'Engage ability', engageContext);
      }
      next = addLog(next, `${playerId} attempts to engage ${occupant.card.name}'s ability.`);
      return {
        ...next,
        pendingResolution: {
          kind: 'activate-engage', declaringPlayer: playerId, cellId: action.cellId,
          cardName: occupant.card.name, engageEffect, context: engageContext,
        },
      };
    }

    case 'ACTIVATE_GROUND_RELIC_ENGAGE': {
      // Same "ethereal speed" reactive-window exception as ACTIVATE_ENGAGE.
      const playerId = state.reactiveWindow?.openFor ?? state.turnPlayer;
      if (state.phase !== 'playing') return state;
      const occupant = state.groundRelics[action.cellId];
      if (!occupant || occupant.ownerId !== playerId || occupant.engaged) return state;
      const engageEffect = occupant.card.keywords?.engage;
      const player = state.players[playerId];
      if (!engageEffect || !groundRelicEngageCostPayable(occupant, player, playerId, action.cellId, state.board)) return state;

      // Tilled Fields' own "Pay (1) Living Essence, Engage: X" — spend the
      // real Effigy cost first, same pattern ACTIVATE_PAY_EFFIGY_COST_ABILITY
      // already uses.
      const effigyCost = occupant.card.keywords?.engageEffigyCost;
      let next = state;
      if (effigyCost) {
        const pool = [...player.effigyPool];
        for (let i = 0; i < effigyCost.amount; i++) {
          const idx = pool.findIndex(e => e.effigyType === effigyCost.color && !e.engaged);
          pool.splice(idx, 1);
        }
        next = { ...next, players: { ...next.players, [playerId]: { ...player, effigyPool: pool } } };
        next = addLog(next, `${playerId} pays ${effigyCost.amount} ${effigyCost.color} for ${occupant.card.name}'s ability.`);
      }

      // Lesser Summoning Circle: "Pay (5) Lifespan, Engage: X" — same
      // sunk-immediately convention ACTIVATE_ENGAGE's own lifespanCost
      // deduction uses, just for a ground Relic instead of a board one.
      // Was missing entirely before this fix, so this cost was silently free.
      const lifespanCost = occupant.card.keywords?.engageLifespanCost || 0;
      if (lifespanCost > 0) {
        const payer = next.players[playerId];
        next = { ...next, players: { ...next.players, [playerId]: { ...payer, lifespan: payer.lifespan - lifespanCost } } };
        next = addLog(next, `${playerId} pays ${lifespanCost} Lifespan to engage ${occupant.card.name}.`);
        next = triggerLifespanPaidReactions(next, playerId);
      }

      // Vadē Rah: "Sacrifice the Being on this tile" — the co-located Being
      // shares this ground Relic's own cellId (RULES.md > Being-Relic
      // co-location), sacrificed as part of the Engage cost, its typing
      // captured before it's gone so "shares a type with the sacrificed
      // Being" (SACRIFICE_CO_LOCATED_TYPING_SEARCH_RE, below) can filter by it.
      let sacrificedTyping = null;
      if (SACRIFICE_CO_LOCATED_BEING_RE.test(occupant.card.keywords?.engageExtraCost || '')) {
        const coLocated = next.board[action.cellId];
        sacrificedTyping = coLocated.card.typing || '';
        next = addLog(next, `${playerId} sacrifices ${coLocated.card.name} to engage ${occupant.card.name}.`);
        next = destroyBeing(next, action.cellId);
      }

      next = {
        ...next,
        groundRelics: { ...next.groundRelics, [action.cellId]: { ...occupant, engaged: true } },
      };
      next = addLog(next, `${playerId} engages ${occupant.card.name}'s ability.`);
      return resolveOrLogEffect(next, playerId, occupant.card.name, engageEffect, 'Engage ability', {
        selfCellId: action.cellId, ...(sacrificedTyping != null ? { sacrificedTyping } : {}),
      });
    }

    case 'ACTIVATE_ARMAMENT_ENGAGE': {
      // Same "ethereal speed" reactive-window exception as ACTIVATE_ENGAGE.
      const playerId = state.reactiveWindow?.openFor ?? state.turnPlayer;
      if (state.phase !== 'playing') return state;
      const occupant = state.board[action.cellId];
      const isEngageable = occupant?.type === 'being' || occupant?.type === 'armament-stack';
      if (!occupant || !isEngageable || occupant.ownerId !== playerId) return state;
      const idx = (occupant.armaments || []).findIndex(a => a.card.instanceId === action.armamentInstanceId);
      if (idx === -1) return state;
      const entry = occupant.armaments[idx];
      if (entry.engaged || !entry.card.keywords?.engage) return state;

      const armaments = [...occupant.armaments];
      armaments[idx] = { ...entry, engaged: true };
      let next = { ...state, board: { ...state.board, [action.cellId]: { ...occupant, armaments } } };
      next = addLog(next, `${playerId} engages ${entry.card.name}'s ability.`);
      return resolveOrLogEffect(next, playerId, entry.card.name, entry.card.keywords.engage, 'Engage ability', {
        selfCellId: action.cellId,
        armamentInstanceId: action.armamentInstanceId,
      });
    }

    case 'RESOLVE_CHOICE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'search') return state;
      const { playerId, source, query, cardName, costFilter, minCostFilter, sharedTypings, colorFilter } = state.pendingChoice;
      const player = state.players[playerId];
      const zone = player[source];
      const idx = zone.findIndex(c => c.instanceId === action.instanceId);
      if (idx === -1) return state;
      const found = zone[idx];
      if (costFilter != null && totalCastingCost(found) !== costFilter) return state;
      if (minCostFilter != null && totalCastingCost(found) < minCostFilter) return state;
      if (sharedTypings != null && !(found.typing || '').split(',').map(t => t.trim().toLowerCase()).some(t => sharedTypings.includes(t))) return state;
      if (colorFilter != null && found.effigyType !== colorFilter) return state;
      const updatedZone = [...zone.slice(0, idx), ...zone.slice(idx + 1)];

      let next = {
        ...state,
        pendingChoice: null,
        players: {
          ...state.players,
          [playerId]: { ...player, [source]: updatedZone, hand: [...player.hand, found] },
        },
      };
      return addLog(next, `${playerId} finds ${found.name} (searching for "${query}" from ${cardName}) and adds it to hand.`);
    }

    case 'RESOLVE_INVOKE_CARD_CHOICE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'invoke-card-choice') return state;
      const { playerId, cardName, label, candidateInstanceIds, destinationMode, context } = state.pendingChoice;
      if (!candidateInstanceIds.includes(action.instanceId)) return state;
      const card = state.players[playerId].mainDeck.find(c => c.instanceId === action.instanceId);
      if (!card) return { ...state, pendingChoice: null };
      return placeInvokedCard({ ...state, pendingChoice: null }, playerId, cardName, label, card, destinationMode, context);
    }

    case 'RESOLVE_INVOKE_DESTINATION': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'invoke-destination') return state;
      const { playerId, cardName, label, cardInstanceId, allowedCells, context } = state.pendingChoice;
      // Not `state.board[action.cellId] || !allowedCells.includes(...)` — a
      // stale guard from before allowedCells' own candidate filter learned
      // to include Dryad-attach-eligible occupied tiles (placeInvokedCard
      // above, `dryadAttachTargetOk`). allowedCells already encodes every
      // real legality check (occupied-but-attachable included), so an
      // occupied cell in it is a legitimate destination, not something to
      // reject — this was silently clearing the pendingChoice and dropping
      // the Invoke entirely the moment its only candidate happened to be a
      // plant.
      if (!allowedCells.includes(action.cellId)) return { ...state, pendingChoice: null };
      const card = state.players[playerId].mainDeck.find(c => c.instanceId === cardInstanceId);
      if (!card) return { ...state, pendingChoice: null };
      return invokeCardOnto({ ...state, pendingChoice: null }, playerId, cardName, label, card, action.cellId, context);
    }

    case 'RESOLVE_SHUFFLE_PURGATORY_INTO_DECK': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'shuffle-purgatory-into-deck') return state;
      const { playerId, cardName, label, then, anyOwner } = state.pendingChoice;
      // `action.ownerId` (Canopic Jar's own anyOwner case) is the offer's
      // own explicit tag, not re-derived by searching both piles — see the
      // offer branch's own comment on why instanceId alone can't safely
      // disambiguate which player's Purgatory this candidate came from.
      const owner = anyOwner ? action.ownerId : playerId;
      if (anyOwner && !owner) return { ...state, pendingChoice: null };
      const found = state.players[owner]?.purgatory.find(c => c.instanceId === action.instanceId);
      if (!found) return { ...state, pendingChoice: null };
      let next = shuffleFromPurgatoryIntoDeck({ ...state, pendingChoice: null }, owner, found);
      next = addLog(next, `${cardName}'s ${label} shuffles ${found.name} into ${owner}'s deck.`);
      if (!then) return next;
      if (!anyOwner && !controlsOnlyFaithlessPermanents(next.board, owner, next.altars[owner], next.groundRelics)) return next;
      const { state: afterDraw, drawnCount } = drawCardsFor(next, owner, then.drawCount);
      return addLog(afterDraw, `${cardName}'s ${label} draws ${drawnCount} card(s) for ${owner}${anyOwner ? '' : ' (only Faithless permanents controlled)'}.`);
    }

    case 'RESOLVE_SUMMON_FROM_PURGATORY': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'summon-from-purgatory') return state;
      const { playerId, cellId, cardName } = state.pendingChoice;
      const found = state.players[playerId].purgatory.find(c => c.instanceId === action.instanceId);
      if (!found || state.board[cellId]) return { ...state, pendingChoice: null };
      const purged = {
        ...state,
        pendingChoice: null,
        players: {
          ...state.players,
          [playerId]: { ...state.players[playerId], purgatory: state.players[playerId].purgatory.filter(c => c.instanceId !== action.instanceId) },
        },
      };
      let next = addLog(purged, `${playerId} chooses ${found.name} to summon from Purgatory (${cardName}'s Martyr).`);
      return placeBeingOnBoard(next, playerId, cellId, found);
    }

    case 'RESOLVE_MOVE_TARGET_BEING': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'move-target-being') return state;
      const { playerId, toCellId } = state.pendingChoice;
      const occupant = state.board[action.fromCellId];
      if (!occupant || occupant.type !== 'being' || occupant.ownerId !== playerId || state.board[toCellId]) {
        return { ...state, pendingChoice: null };
      }
      return moveBeingFreely({ ...state, pendingChoice: null }, action.fromCellId, toCellId);
    }

    case 'RESOLVE_MODULATE': {
      if (!state.pendingChoice || state.pendingChoice.kind !== 'modulate') return state;
      const { playerId, cardName, label, repeatsRemaining = 0, thenDelta = null, anyOwner = false } = state.pendingChoice;

      // Altar target (Eònion Altar) — addressed by instanceId, not a board
      // cellId, since altars live in state.altars[<owner>], not state.board.
      // anyOwner (OPTIONAL_MODULATE_ANY_OWNER_RE) can target either
      // player's altar, so the owner has to be found by searching both
      // lists rather than assuming it's always the activating playerId's
      // own — getLegalActions' own anyOwner branch already offers the
      // opponent's altars here too, and this reducer silently rejecting
      // them (ownerId mismatch) would leave that offered action a
      // permanent no-op, the same "offer allows it, reducer can't actually
      // find it" gap fixed everywhere else in this file. No Prophecy-shaped
      // flip/Purgatory finalization applies here (an Altar's own "at 0 Time
      // Counters" condition, e.g. its craft bonus, is read live off its
      // counters wherever it matters — see turn.js — not triggered as an
      // event), so this just writes the new count and continues any Time
      // Capsule-style repeat, same as Hourglass below.
      if (action.altarInstanceId) {
        const altarOwnerId = anyOwner
          ? Object.keys(state.altars).find(oid => (state.altars[oid] || []).some(a => a.card.instanceId === action.altarInstanceId))
          : playerId;
        const altarList = (altarOwnerId && state.altars[altarOwnerId]) || [];
        const altarIndex = altarList.findIndex(a => a.card.instanceId === action.altarInstanceId);
        const altar = altarList[altarIndex];
        if (altarIndex === -1 || !isModulateableAltar(altar)) return state;
        const sign = action.delta > 0 ? '+' : '';
        const have = altar.counters?.time || 0;
        const time = Math.max(0, have + action.delta);
        const nextAltars = [...altarList];
        nextAltars[altarIndex] = { ...altar, counters: { ...altar.counters, time } };
        let next = {
          ...state,
          pendingChoice: null,
          altars: { ...state.altars, [altarOwnerId]: nextAltars },
        };
        next = addLog(next, `${playerId} Modulates ${altar.card.name} by ${sign}${action.delta} (now ${time}).`);
        // Temporal Anomaly: fires on any player-activated Modulate,
        // regardless of sign or target shape — see triggerModulateReactions.
        next = triggerModulateReactions(next, playerId);
        next = triggerModulateMinusOneCounterGain(next, playerId, action.delta);
        return continueModulateRepeat(next, playerId, cardName, label, action.delta, repeatsRemaining, thenDelta);
      }

      const occupant = state.board[action.cellId];
      if (!occupant || (!anyOwner && occupant.ownerId !== playerId) || !isModulateTarget(occupant)) return state;
      const sign = action.delta > 0 ? '+' : '';

      if (occupant.type === 'prophecy') {
        // Floored at 0 — same as the Altar/generic-occupant branches below
        // — since a large enough negative delta (a printed "Modulate (±2)"
        // or similar) could otherwise still drive a Prophecy sitting at a
        // small positive timer below 0, even with isModulateTarget's own
        // "must already be above 0 to be targeted at all" gate.
        const timer = Math.max(0, occupant.timer + action.delta);
        let next = {
          ...state,
          pendingChoice: null,
          board: { ...state.board, [action.cellId]: { ...occupant, timer } },
        };
        next = addLog(next, `${playerId} Modulates ${occupant.card.name} by ${sign}${action.delta} (now ${timer}).`);
        // Temporal Anomaly: fires on any player-activated Modulate,
        // regardless of sign or target shape — see triggerModulateReactions.
        next = triggerModulateReactions(next, playerId);
        next = triggerModulateMinusOneCounterGain(next, playerId, action.delta);
        // "Eònion Zealot": a Time Counter was genuinely removed (not added) —
        // check the once-per-turn Prophecy-counter-removal trigger, same as
        // the automatic per-turn tick does (turn.js > modulate).
        if (action.delta < 0) {
          next = triggerZealotProphecyEssence(next, occupant.ownerId);
          next = triggerHourglassCollection(next, occupant.ownerId);
        }
        // Same two-phase finalization the automatic per-turn tick uses
        // (RULES.md > Prophecies) — a face-down Prophecy that hits 0 this way
        // flips and resolves its own printed text too, not just a silent
        // removal.
        next = resolveProphecyModulateHitZero(next, action.cellId);
        // Time Capsule's own "repeat" continuation — skipped (rather than
        // silently clobbered) if resolving the Prophecy's own hit-zero
        // effect already opened a further pendingChoice of its own, same
        // "second trigger waits" precedent used elsewhere in this file.
        if (next.pendingChoice) {
          return (repeatsRemaining > 0 || thenDelta != null)
            ? addLog(next, `${cardName}'s ${label} doesn't repeat further — still waiting on a choice from the Prophecy it just resolved.`)
            : next;
        }
        return continueModulateRepeat(next, playerId, cardName, label, action.delta, repeatsRemaining, thenDelta);
      }

      // Any other Time-Counter-bearing occupant (Hourglass and similar
      // Relics use counters.time, not a Prophecy's own timer field) — no
      // flip/Purgatory finalization, that's a Prophecy-only concept, and no
      // Zealot/Hourglass-collection trigger either (those specifically fire
      // off a Time Counter removed FROM A PROPHECY, not off this). Floored
      // at 0 rather than going negative, same as the automatic per-turn tick.
      const have = occupant.counters?.time || 0;
      const time = Math.max(0, have + action.delta);
      let next = {
        ...state,
        pendingChoice: null,
        board: { ...state.board, [action.cellId]: { ...occupant, counters: { ...occupant.counters, time } } },
      };
      next = addLog(next, `${playerId} Modulates ${occupant.card.name} by ${sign}${action.delta} (now ${time}).`);
      // Temporal Anomaly: fires on any player-activated Modulate, regardless
      // of sign or target shape — see triggerModulateReactions.
      next = triggerModulateReactions(next, playerId);
      next = triggerModulateMinusOneCounterGain(next, playerId, action.delta);
      return continueModulateRepeat(next, playerId, cardName, label, action.delta, repeatsRemaining, thenDelta);
    }

    case 'PASS_TURN': {
      if (state.phase !== 'playing') return state;
      return endTurn(state);
    }

    case 'CONCEDE': {
      if (state.phase === 'gameover') return state;
      const winner = action.player === 'A' ? 'B' : 'A';
      return addLog({ ...state, phase: 'gameover', winner }, `${action.player} concedes — ${winner} wins.`);
    }

    // Dismisses the revealPopup overlay (Farm Hand's own bug report — see
    // REVEAL_TOP_SEED_RE's comment) — a click, or the UI's own 30s auto-
    // timeout. Purely clearing a transient display field; the real
    // outcome (drawn vs. left on top) already happened when it was set.
    case 'DISMISS_REVEAL_POPUP': {
      if (!state.revealPopup) return state;
      const { revealPopup: _dismissed, ...rest } = state;
      return rest;
    }

    default:
      return state;
  }
};

// Safety net against a stuck pendingChoice: every effect that opens one is
// supposed to check its own candidate list first and fall back to a plain
// log line when nothing legal exists (the "graceful non-offer" precedent
// used throughout this file) — but with ~150 call sites, a future one that
// skips that check would otherwise deadlock the whole game: getLegalActions
// returns nothing for anyone once a pendingChoice exists (see its own early
// `return actions` for a non-owning player), and useGameEngine's AI loop
// just silently does nothing when pickAiAction comes back null, freezing a
// bot-owned choice forever with no way for the human to intervene either.
// Checked after every single action (not just Prophecy resolution) since
// the same hazard applies to any pendingChoice, from any source.
const clearStuckPendingChoice = (state) => {
  if (!state.pendingChoice) return state;
  const { playerId, cardName, kind } = state.pendingChoice;
  if (getLegalActions(state, playerId).length > 0) return state;
  return addLog({ ...state, pendingChoice: null }, `${cardName ? `${cardName}'s ` : 'A'} pending "${kind}" choice has no legal option and is cleared automatically.`);
};

// Ethereal Conjuring reactive timing (RULES.md's own "the one real gap"
// note): after ANY action, the player who didn't just act gets one
// optional chance to respond by casting an affordable Ethereal Conjuring
// from hand — and if they do, the ORIGINAL actor gets the same chance to
// respond to THAT, alternating indefinitely (real, unlimited-depth
// chaining) until whoever currently holds it either has nothing to cast or
// explicitly declines. This is NOT a literal LIFO stack of unresolved
// effects — every reactive cast resolves immediately, through the exact
// same CAST_CONJURING reducer case / resolveOrLogEffect pipeline a normal
// cast already uses (see that case's own playerId derivation). Chaining is
// achieved purely by "does anyone want to respond to what just happened,"
// asked once per event.
//
// state.pendingResolution (added for Medium Mage's own "respond before the
// trigger lands" case — confirmed with the user) is the one real exception
// to "no deferred/queued resolution": certain declared-but-not-yet-applied
// effects (currently just a Being's own When Summoned trigger — see
// placeBeingOnBoard) ride behind this SAME reactiveWindow instead of
// resolving inline, so the window opens BEFORE the effect applies, not
// after. `pendingResolution` itself only ever holds the deferred data; it
// never drives whose turn it is to act — `reactiveWindow` still does that,
// completely unchanged. `resolvePendingResolution` (below) is what
// actually fires the deferred effect, called from the two places this
// function closes a window (an explicit PASS_PRIORITY, or the auto-close
// loop finding nobody has anything real to respond with) rather than from
// gameReducerCore directly — a response never gets its own deferred
// window (see ACTIVATE_ENGAGE/SUMMON_BEING's own gating once phases 2-3
// land), so there's no risk of this recursing into a second, nested
// pendingResolution.
const resolvePendingResolution = (state) => {
  const { pendingResolution } = state;
  if (!pendingResolution) return state;
  const cleared = { ...state, pendingResolution: null };
  if (pendingResolution.kind === 'summon-being') {
    const { declaringPlayer, cellId, cardName, whenSummonedText, instanceId } = pendingResolution;
    // The summoned Being might not be there anymore by the time priority
    // actually settles (a response destroyed it, or — more prosaically —
    // something else removed it) — re-checked fresh here rather than
    // assumed, same "never trust stale data across a window" discipline
    // the whole point of this mechanism exists for.
    if (cleared.board[cellId]?.card?.instanceId !== instanceId) {
      return addLog(cleared, `${cardName}'s When Summoned trigger fizzles — it's no longer on the battlefield.`);
    }
    let next = addLog(cleared, `${cardName}'s When Summoned triggers.`);
    return resolveOrLogEffect(next, declaringPlayer, cardName, whenSummonedText, 'When Summoned', { selfCellId: cellId });
  }
  if (pendingResolution.kind === 'activate-engage') {
    const { declaringPlayer, cellId, cardName, engageEffect, context } = pendingResolution;
    const occupant = cleared.board[cellId];
    // Re-validated fresh, per the design fork this whole kind exists for:
    // a response (Boknean Wine et al.) may have engaged this same
    // permanent first, or removed it outright — either way the original
    // attempt fails here rather than assuming its own declare-time
    // snapshot is still true. The costs already paid at declare time are
    // NOT refunded (same "sunk cost" precedent this engine already
    // follows everywhere else a cost is paid before a fizzled effect).
    if (!occupant) {
      return addLog(cleared, `${cardName}'s Engage ability fails to resolve — it's no longer on the battlefield.`);
    }
    if (occupant.engaged) {
      return addLog(cleared, `${cardName}'s Engage ability fails to resolve — it's already Engaged.`);
    }
    let next = { ...cleared, board: { ...cleared.board, [cellId]: { ...occupant, engaged: true } } };
    next = addLog(next, `${declaringPlayer} engages ${cardName}'s ability.`);
    return resolveOrLogEffect(next, declaringPlayer, cardName, engageEffect, 'Engage ability', context);
  }
  if (pendingResolution.kind === 'attack') {
    const { declaringPlayer, fromCellId, cardName, noDamage } = pendingResolution;
    const occupant = cleared.board[fromCellId];
    const isBeing = occupant?.type === 'being';
    const attackerTop = animatedTopEntry(occupant);
    // Re-validated fresh — a response destroying the attacker outright
    // isn't reachable by any in-scope card yet, but the check costs
    // nothing and matches every other kind's own "never trust stale data
    // across a window" discipline. resolveAttackFrom (below) separately
    // re-fetches the DEFENDER fresh too, which IS reachable today (Strike
    // Down destroys the blocking Being during exactly this window).
    if (!occupant || occupant.ownerId !== declaringPlayer || !(isBeing || attackerTop)) {
      return addLog(cleared, `${cardName}'s attack fizzles — it's no longer on the battlefield.`);
    }
    // `noDamage` (Strike Down — see STRIKE_DOWN_RE's own resolution) was
    // stashed directly onto this pendingResolution while the window was
    // still open, since a response resolves atomically against the SAME
    // one rather than opening its own.
    return resolveAttackFrom(cleared, declaringPlayer, fromCellId, !!noDamage);
  }
  return cleared;
};
//
// state.reactiveWindow is `null | { openFor: playerId }` — no "who has
// passed" bookkeeping is needed: PASS_PRIORITY from the current openFor
// always closes the window outright (nobody else is ever simultaneously
// "owed" a check); only a real CAST_CONJURING flips openFor to the other
// player for a fresh, single opportunity to react to that specific cast.
//
// `prevState` is the state from BEFORE gameReducerCore + the recomputes
// above ran (already in scope in gameReducer's own closure below), `state`
// is the fully-resolved post-action state, `action` is what was just
// dispatched.
const manageReactiveWindow = (prevState, state, action) => {
  if (state.phase !== 'playing' || state.winner) {
    // Always explicitly null (never left undefined) — createInitialState
    // sets it to null too, so `reactiveWindow`/`pendingResolution` are
    // consistently either `null` or a real object everywhere, same as
    // pendingChoice's own convention. Preserves reference equality when
    // both were already null — many existing tests assert a rejected/no-op
    // action returns the exact same state object, same discipline every
    // other function in this recompute chain already follows. A genuinely
    // ending/inactive game is the one case a still-pending resolution is
    // simply dropped rather than preserved — see the pendingChoice branch
    // just below for the case that instead keeps it alive.
    return (state.reactiveWindow == null && state.pendingResolution == null)
      ? state : { ...state, reactiveWindow: null, pendingResolution: null };
  }
  if (state.pendingChoice) {
    // A pendingChoice takes priority (this engine only ever tracks one
    // choice at a time) — reactiveWindow closes exactly like the
    // phase/winner case above, but `pendingResolution`, if any, is
    // deliberately NOT cleared here. A response cast/engaged during an
    // open window can itself need a real target choice (e.g. One Above
    // All with 2+ legal Beings) — dropping the still-pending resolution
    // in that moment would silently vaporize a real game effect (Medium
    // Mage's own damage, say) rather than just delaying it. Once the
    // blocking choice resolves, the "no window was open" branch below
    // naturally opens a fresh window scoped to whoever's choice just
    // finished, and the still-pending resolution keeps waiting behind it
    // exactly as if nothing had interrupted it.
    return state.reactiveWindow == null ? state : { ...state, reactiveWindow: null };
  }

  const REACTIVE_RESPONSE_ACTION_TYPES = new Set(['CAST_CONJURING', 'ACTIVATE_ENGAGE', 'ACTIVATE_GROUND_RELIC_ENGAGE', 'ACTIVATE_ARMAMENT_ENGAGE']);
  // The whole point of the window is "someone else just did something you
  // might want to respond to" — so it carries a human-readable description
  // of exactly what that was, shown above the Pass Priority button
  // (Match.jsx) instead of leaving the player to guess. Reuses the log
  // message the triggering action's own reducer case already wrote (every
  // action addLog()s a description of itself) rather than maintaining a
  // second, parallel switch over action types here that would inevitably
  // drift out of sync with the real one.
  const lastLogMessage = state.log.length > 0 ? state.log[state.log.length - 1].message : null;
  let next = state;
  if (prevState.reactiveWindow) {
    // This action is itself how an already-open window continues — only
    // PASS_PRIORITY or one of REACTIVE_RESPONSE_ACTION_TYPES can ever
    // reach here (enforced by both getLegalActions and gameReducerCore's
    // own whitelist above).
    const reactor = prevState.reactiveWindow.openFor;
    if (action.type === 'PASS_PRIORITY') {
      next = resolvePendingResolution({ ...next, reactiveWindow: null });
    } else if (REACTIVE_RESPONSE_ACTION_TYPES.has(action.type)) {
      // Defense in depth, mirroring the no-op check in the "no window was
      // open" branch below: a REACTIVE_RESPONSE_ACTION_TYPES entry that the
      // offer side legally listed but whose reducer case then silently
      // no-oped (any gate the offer doesn't yet mirror — self-play found
      // this exact shape for Strike Down/Deja Vu's own additional-target
      // gates, now fixed at the offer via conjuringCastGateOk, but this
      // guards against the next one) must never flip the window —
      // flipping on a no-op is indistinguishable from real progress to the
      // AI and ping-pongs forever between the two players. Leaving the
      // window open for the same reactor instead means the AI just tries
      // something else (or PASS_PRIORITY) next. PASS_PRIORITY itself is
      // deliberately checked above this, before this no-op test, since its
      // own "close the window" effect lives entirely here in
      // manageReactiveWindow rather than in gameReducerCore, so `state ===
      // prevState` is always true for it and would otherwise wrongly
      // short-circuit its real close-the-window behavior.
      if (state === prevState) return next;
      next = { ...next, reactiveWindow: { openFor: opponentOf(reactor), triggerDescription: lastLogMessage } };
    } else {
      return next;
    }
  } else {
    // No window was open — did a real, complete action just happen that
    // the OTHER player might want to respond to? A no-op dispatch (state
    // unchanged) or one of a small set of action types never opens one:
    // PASS_TURN (its own begin/endTurn pipeline stays atomic within this
    // one dispatch — a deliberate, documented scope boundary, not an
    // oversight), the test-only recompute sentinel, and the mulligan
    // actions (redundant with the phase check above, kept explicit).
    if (state === prevState) return next;
    const NON_REACTIVE_ACTION_TYPES = new Set(['PASS_TURN', '__TEST_RECOMPUTE_ONLY__', 'MULLIGAN', 'KEEP_HAND']);
    if (NON_REACTIVE_ACTION_TYPES.has(action.type)) return next;
    // The real actor isn't always prevState.turnPlayer — a RESOLVE_*
    // finishing a multi-step pendingChoice chain can be dispatched by
    // EITHER player (getLegalActions' own pendingChoice branch already
    // establishes this: "it can fire on either player's turn, e.g. a
    // defender's Depart triggers during the attacker's turn"), so the
    // choice's own owner is the real actor whenever one was just pending.
    const actor = prevState.pendingChoice ? prevState.pendingChoice.playerId : prevState.turnPlayer;
    next = { ...next, reactiveWindow: { openFor: opponentOf(actor), triggerDescription: lastLogMessage } };
  }

  // Auto-close (not flip-and-check-the-other-side — per the state shape
  // above, nobody else is owed a check) whenever the current holder has
  // nothing real to cast — same "auto-resolve what nobody can act on"
  // philosophy clearStuckPendingChoice uses just below. In the
  // overwhelming majority of actions (neither side holding an affordable
  // Ethereal Conjuring), this collapses the window shut within the same
  // dispatch, completely invisible to either player.
  while (next.reactiveWindow) {
    const { openFor } = next.reactiveWindow;
    const hasRealOption = getLegalActions(next, openFor).some(a => REACTIVE_RESPONSE_ACTION_TYPES.has(a.type));
    if (hasRealOption) break;
    next = resolvePendingResolution({ ...next, reactiveWindow: null });
  }
  return next;
};

// Horological Horror's "X" is a live, continuously-checked aura (see
// recomputeXBeings above) — refreshed after every single action, not just
// once at the start of a turn, so a mid-turn Time Counter change (an Engage
// cost, Freeze Frame, Moment of Doubt, etc.) is reflected immediately.
const recomputeLiveAuras = (state) =>
  recomputeKalmahkaOverrides(recomputeBoardWideAuraBonuses(recomputeConditionalBonuses(recomputeDeathCountBonuses(recomputeXBeings(state)))));

export const gameReducer = (state, action) => {
  const recomputed = recomputeLiveAuras(gameReducerCore(state, action));
  let afterWindow = manageReactiveWindow(state, recomputed, action);
  // manageReactiveWindow can itself apply a deferred effect
  // (resolvePendingResolution) when a pre-resolution priority window
  // closes — e.g. real combat damage finally landing once a declared
  // attack's window resolves — which changes board/player state the same
  // way any other real action would, and so needs this exact same live-
  // recompute pass every other dispatch already gets (found via Restless
  // Dead's own live "+2/+0 for each Being that died this turn" not
  // picking up a death that happened only inside this deferred
  // resolution, not the original dispatch). Skipped when nothing actually
  // changed here — the overwhelmingly common case, a window that just
  // opened/flipped/closed with no deferred effect firing — so a normal
  // dispatch pays no extra cost.
  if (afterWindow.board !== recomputed.board || afterWindow.players !== recomputed.players) {
    afterWindow = recomputeLiveAuras(afterWindow);
  }
  return clearStuckPendingChoice(afterWindow);
};
