// READ-ONLY static audit: for every card in the real CSV pool, checks
// whether its printed textBox has real engine implementation.
//
//   (a) CONFIRMED GAP: a keyword field that DOES get parsed out of the text
//       and IS passed to resolveOrLogEffect at a real trigger point, but
//       resolveOrLogEffect's own fallback fires ("isn't automated yet").
//       Each field is tested with a mock state/context that mirrors the
//       REAL call site as closely as possible (vacated-tile vs. occupied,
//       occupant type, movedFromCellId, etc — see the per-field comments
//       below, each cross-checked directly against actions.js).
//   (b) POSSIBLE PARSE-TIME DROP: textBox contains actionable-looking rules
//       language, but parseKeywords produced a totally empty/default
//       keywords object for it (nothing for any trigger point to ever read).
//
// Must be run with vite-node, not plain node — cardData.js reads
// import.meta.env.BASE_URL at module load time (see run.mjs's own comment).
//
//   node_modules/.bin/vite-node scripts/self-play/static-coverage-audit.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCSV, toGameCard, stripFlavorText, EFFIGY_COLORS } from '../../src/lib/cardData.js';
import { resolveOrLogEffect } from '../../src/game/engine/actions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const CSV_PATH = path.join(REPO_ROOT, 'public/default-card-set.csv');

const csvText = fs.readFileSync(CSV_PATH, 'utf8');
const rows = parseCSV(csvText);
const allCards = rows.map((row, idx) => toGameCard(row, idx));

console.log(`Loaded ${allCards.length} rows from ${CSV_PATH}`);

// -- Minimal state construction (mirrors actions.test.js's own helpers) ---

const player = (overrides = {}) => ({
  id: 'A',
  lifespan: 50,
  mainDeck: [],
  hand: [],
  purgatory: [],
  effigyDeck: [],
  effigyPool: [],
  effigySpentThisTurn: [],
  keptHand: true,
  ...overrides,
});

const baseState = (overrides = {}) => ({
  phase: 'playing',
  turnPlayer: 'A',
  turnNumber: 5,
  winner: null,
  board: {},
  groundRelics: {},
  altars: { A: [], B: [] },
  log: [],
  players: { A: player({ id: 'A' }), B: player({ id: 'B' }) },
  pendingChoice: null,
  reactiveWindow: null,
  pendingResolution: null,
  ...overrides,
});

const generousPool = () => EFFIGY_COLORS.flatMap(color =>
  Array.from({ length: 20 }, (_, i) => ({ instanceId: `${color}#${i}`, effigyType: color, kind: 'effigy' }))
);

const fillerBeings = allCards.filter(c => c.kind === 'being' && !c.isToken).slice(0, 6);
const instOf = (card, suffix) => ({ ...card, instanceId: `${card.id}__${suffix}` });

const SELF_CELL = 'r2c1';
const OTHER_OWN_CELL = 'r2c2';
const OPP_CELL = 'r4c1';
const MOVED_FROM_CELL = 'r3c2';

// Builds a state with hand/purgatory/deck/board filler so search/target
// effects have real candidates, plus (optionally) a self-occupant of a
// given `occType` at SELF_CELL — or none at all, for the many real trigger
// points that fire with the tile already vacated (Depart, Martyr,
// onAttachedBeingDied — see per-field comments at the call sites below).
const buildStateForCard = (card, occType /* null = vacated */, selfCard = card, selfArmaments = [], groundRelicCard = null) => {
  const filler0 = fillerBeings[0] || card;
  const filler1 = fillerBeings[1] || card;
  const board = {
    // currentLifespan MUST be set explicitly — dealDamageToBeing reads
    // view.currentLifespan, not card.lifespan, so an occupant missing it
    // reads as `undefined - damage = NaN`, which is NOT `> 0`, so ANY
    // damage effect would spuriously "kill" the occupant outright
    // regardless of its real printed Lifespan (found via Envoy of the
    // Hungers's own "Deal (1) damage to this, then..." falsely dying to a
    // 1-damage self-hit and never reaching its own second clause).
    [OTHER_OWN_CELL]: { type: 'being', ownerId: 'A', card: filler0, currentLifespan: filler0.lifespan || 5, engaged: false, counters: {}, armaments: [] },
    [OPP_CELL]: { type: 'being', ownerId: 'B', card: filler1, currentLifespan: filler1.lifespan || 5, engaged: false, counters: {}, armaments: [] },
  };
  if (occType) {
    board[SELF_CELL] = {
      type: occType,
      ownerId: 'A',
      card: selfCard,
      currentLifespan: selfCard.lifespan || 5,
      engaged: false,
      counters: { crossing: 9, growth: 9, forge: 9, time: 9, favor: 9, rot: 9, generic: 9 },
      armaments: selfArmaments,
      timer: selfCard.timerMax || 5,
      faceDown: false,
    };
  }
  const groundRelics = groundRelicCard
    ? { [SELF_CELL]: { ownerId: 'A', card: groundRelicCard, engaged: false, counters: { crossing: 9, growth: 9, forge: 9, time: 9 } } }
    : {};

  const purgatoryFiller = fillerBeings.slice(2, 4).map((c, i) => instOf(c, `purg${i}`));
  const deckFiller = fillerBeings.slice(0, 6).map((c, i) => instOf(c, `deck${i}`));
  const handFiller = fillerBeings.slice(0, 3).map((c, i) => instOf(c, `hand${i}`));

  const players = {
    A: player({
      id: 'A',
      lifespan: 50,
      hand: [instOf(card, 'hand0'), ...handFiller],
      purgatory: [instOf(card, 'purg0'), ...purgatoryFiller],
      mainDeck: deckFiller,
      effigyPool: generousPool(),
    }),
    B: player({ id: 'B', lifespan: 50, effigyPool: generousPool() }),
  };

  return baseState({ board, players, groundRelics });
};

const logHasAutomationFallback = (state) =>
  state.log.some(entry => typeof entry.message === 'string' && entry.message.includes("isn't automated yet"));

// name -> "this" substitution, mirroring actions.js's own
// selfReferentialWhenSummonedText (applied only at the 4 real call sites
// that use it: depart, whenSummoned, onMove, and each Prophecy flip line).
const selfRef = (text, cardName) => text.replace(new RegExp(cardName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'this');

// -- Category (a): confirmed gaps ------------------------------------------

const confirmedGaps = [];

// Runs one (state, context) attempt; returns true if it hit the fallback
// (or threw), false if it resolved as something other than the fallback.
const attempt = (card, text, label, occType, context, selfCard, selfArmaments, groundRelicCard) => {
  const state = buildStateForCard(card, occType, selfCard, selfArmaments, groundRelicCard);
  let result;
  try {
    result = resolveOrLogEffect(state, 'A', card.name, text, label, context);
  } catch (e) {
    return { hit: true, error: e.message };
  }
  return { hit: logHasAutomationFallback(result), error: null };
};

// `variants`: array of { occType, context } to try. Flags a confirmed gap
// only if EVERY variant hits the fallback (so a field whose real trigger
// context is ambiguous from static analysis alone — e.g. an Armament's own
// Engage vs. a granted-to-Being Engage — isn't falsely flagged just because
// ONE plausible interpretation doesn't happen to match).
const tryResolve = (card, field, text, label, variants) => {
  if (!text || !String(text).trim()) return;
  const results = variants.map(v => attempt(card, text, label, v.occType, v.context, v.selfCard, v.selfArmaments, v.groundRelicCard));
  if (results.every(r => r.hit)) {
    const err = results.find(r => r.error)?.error;
    confirmedGaps.push({ name: card.name, typing: card.typing, field, label, text, error: err ? `THROW: ${err}` : null });
  }
};

const defaultCtx = (extra = {}) => ({ selfCellId: SELF_CELL, selfArrows: [], selfCounters: { crossing: 9, growth: 9, forge: 9, time: 9, favor: 9, rot: 9 }, ...extra });

for (const card of allCards) {
  const kw = card.keywords || {};
  const arrows = card.arrows && card.arrows.length ? card.arrows : [1, 2, 3, 4, 5, 6, 7, 8];

  // -- Depart: fires with the tile ALREADY VACATED (logDepartIfPresent —
  // the dying Being is removed from board before this runs). Own-name
  // substituted to "this" (selfReferentialWhenSummonedText).
  if (kw.depart) {
    tryResolve(card, 'depart', selfRef(kw.depart, card.name), 'Depart',
      [{ occType: null, context: { selfCellId: SELF_CELL } }]);
  }

  // -- Martyr / grantedMartyr: the generic ACTIVATE_MARTYR (a Being's or a
  // standalone Relic's own Martyr) vacates the tile before resolving
  // (dropArmamentsOrDryadMount runs first) and passes
  // selfCounters/selfArrows from the sacrificed occupant. NOT name-
  // substituted (effectiveMartyr passes the field raw). An Armament's OWN
  // Martyr (ACTIVATE_ARMAMENT_MARTYR — Armor Animus, HeartWood Locket) is a
  // SEPARATE real trigger point: the wearer stays ON the board at
  // selfCellId (only the Armament entry itself is removed from its
  // armaments array), so "Being this is attached to gains..."-style text
  // needs a live 'being' occupant there to find — tried as a second variant
  // for Armament-kind cards.
  const martyrVariants = (kind) => {
    const vacated = { occType: null, context: { selfCellId: SELF_CELL, selfCounters: { crossing: 9, growth: 9, forge: 9, time: 9 }, selfArrows: arrows } };
    if (kind !== 'relic-armament') return [vacated];
    const wearer = { occType: 'being', selfCard: fillerBeings[0] || card, context: { selfCellId: SELF_CELL, selfCounters: { crossing: 9, growth: 9, forge: 9, time: 9 }, selfArrows: arrows } };
    return [vacated, wearer];
  };
  if (kw.martyr) tryResolve(card, 'martyr', kw.martyr, 'Martyr', martyrVariants(card.kind));
  if (kw.grantedMartyr) tryResolve(card, 'grantedMartyr', kw.grantedMartyr, 'Martyr', martyrVariants(card.kind));

  // -- Engage / grantedEngage / engageAbilities: the real occupant type at
  // context.selfCellId depends on WHICH real action reaches it —
  // ACTIVATE_ENGAGE (occupant IS the Being/Relic itself), or
  // ACTIVATE_ARMAMENT_ENGAGE (selfCellId is the WEARER's cell, always type
  // 'being', even though `cardName` is the Armament's own name — see
  // Darmah-Triya Bracers). Tried both ways; only flagged if BOTH fail.
  // `engageAbilities[i]` is only a REAL trigger for i>0 cards (the reducer
  // only ever indexes into this array when it holds more than one ability —
  // a single-ability card always resolves through the singular
  // `engage`/`grantedEngage` field instead, via effectiveEngage).
  // A Prophecy's own `engage`/`engageAbilities` field is NEVER actually
  // read by anything — ACTIVATE_ENGAGE only ever offers itself for a
  // board occupant of type 'being' or 'relic' (never 'prophecy'), so this
  // field being non-null on a Prophecy card is purely a parse-time
  // artifact (typically a "<Typing> you control gain: 'Engage: X'" GRANT
  // clause mis-captured as if it were the Prophecy's own ability — e.g.
  // Natures Bounty). The real grant mechanic itself is already covered by
  // the Prophecy-flip line test below, so testing this field too would
  // just be a guaranteed methodology false positive.
  const selfKindOccType = card.kind === 'relic' || card.kind === 'relic-armament' ? 'relic'
    : card.kind === 'altar' ? 'altar' : 'being';
  const engageVariants = () => {
    const variants = [
      { occType: 'being', context: { selfCellId: SELF_CELL, selfArrows: arrows, selfCounters: { crossing: 9, growth: 9, forge: 9, time: 9 } } },
      { occType: selfKindOccType, context: { selfCellId: SELF_CELL, selfArrows: arrows, selfCounters: { crossing: 9, growth: 9, forge: 9, time: 9 } } },
    ];
    // A standalone/ground Relic (Tilled Fields, Sanative Siphon, ...) is
    // activated via ACTIVATE_GROUND_RELIC_ENGAGE, which reads from
    // state.groundRelics[cellId], not state.board — some effect text (e.g.
    // PLANTS_ENTER_DISENGAGED_RE) explicitly requires a live groundRelics
    // entry there. Tried as a third variant for 'relic' kind cards.
    if (card.kind === 'relic') {
      variants.push({ occType: null, groundRelicCard: card, context: { selfCellId: SELF_CELL, selfArrows: arrows, selfCounters: { crossing: 9, growth: 9, forge: 9, time: 9 } } });
    }
    // An Armament granting/printing "Sacrifice <OwnName>, ..." (Shovel)
    // needs to find ITSELF inside the wearer's own `armaments` list.
    if (card.kind === 'relic-armament') {
      variants.push({ occType: 'being', selfCard: fillerBeings[0] || card, selfArmaments: [{ card, engaged: false }], context: { selfCellId: SELF_CELL, selfArrows: arrows, selfCounters: { crossing: 9, growth: 9, forge: 9, time: 9 } } });
    }
    return variants;
  };
  if (card.kind !== 'prophecy') {
    if (kw.engage) tryResolve(card, 'engage', kw.engage, 'Engage ability', engageVariants());
    if (kw.grantedEngage) tryResolve(card, 'grantedEngage', kw.grantedEngage, 'Engage ability', engageVariants());
    if (Array.isArray(kw.engageAbilities) && kw.engageAbilities.length > 1) {
      kw.engageAbilities.forEach((ab, i) => {
        if (ab?.effect) tryResolve(card, `engageAbilities[${i}]`, ab.effect, 'Engage ability', engageVariants());
      });
    }
  }

  // -- onAttachedBeingDied: fires with the wearer's tile already vacated
  // (triggerOnAttachedBeingDied runs after dropArmamentsOrDryadMount).
  if (kw.onAttachedBeingDied) {
    tryResolve(card, 'onAttachedBeingDied', kw.onAttachedBeingDied, 'ability',
      [{ occType: null, context: { selfCellId: SELF_CELL } }]);
  }

  // -- conjureCost: resolveOrLogEffect is ONLY ever called with this field
  // for an Altar (PLACE_ALTAR, line ~11447) — a plain Conjuring's own
  // conjureCost (Desperate Finale) is special-cased entirely outside
  // resolveOrLogEffect (resolveDesperateFinale). Real call passes no
  // selfCellId/selfArrows/selfCounters at all.
  if (kw.conjureCost && card.kind === 'altar') {
    tryResolve(card, 'conjureCost', kw.conjureCost, 'conjure cost', [{ occType: null, context: {} }]);
  }

  // -- whenConjureProphecy: fired from PLAY_PROPHECY for every Being the
  // caster controls carrying the keyword; occupant IS the reacting Being.
  if (kw.whenConjureProphecy) {
    tryResolve(card, 'whenConjureProphecy', kw.whenConjureProphecy, 'Whenever you conjure a Prophecy',
      [{ occType: 'being', context: { selfCellId: SELF_CELL } }]);
  }

  // -- onRevealedTopOfDeck: called with an empty context ({}) — the drawn
  // card isn't a board occupant at all yet.
  if (kw.onRevealedTopOfDeck) {
    tryResolve(card, 'onRevealedTopOfDeck', kw.onRevealedTopOfDeck, 'When revealed', [{ occType: null, context: {} }]);
  }

  // -- onDryadAttachedOnto: context.selfCellId's board occupant is the
  // MOVER's card (NOT this card's own) — selfArrows is passed explicitly
  // instead, since reading arrows off the board there would use the wrong
  // card's geometry (see the comment at triggerOnDryadAttachedOnto).
  if (kw.onDryadAttachedOnto) {
    tryResolve(card, 'onDryadAttachedOnto', kw.onDryadAttachedOnto, 'Reaction',
      [{ occType: 'being', context: { selfCellId: SELF_CELL, selfArrows: arrows } }]);
  }

  // -- onMovedIntoMortalRealm: board[selfCellId] holds this card itself,
  // freshly placed as a 'being' occupant (placeReturnedFromShift).
  if (kw.onMovedIntoMortalRealm) {
    tryResolve(card, 'onMovedIntoMortalRealm', kw.onMovedIntoMortalRealm, 'Reaction',
      [{ occType: 'being', context: { selfCellId: SELF_CELL } }]);
  }

  // -- onTypedSummonedUnderControl / onOwnMartyrTyped / onOwnBeingShift:
  // "Reaction" triggers on a DIFFERENT/this same Being still sitting on the
  // board watching — always a real 'being' (or, for onOwnBeingShift, also
  // possibly 'relic' — Sanative Siphon) occupant at its own cell.
  if (kw.onTypedSummonedUnderControl?.effect) {
    tryResolve(card, 'onTypedSummonedUnderControl', kw.onTypedSummonedUnderControl.effect, 'Reaction',
      [{ occType: 'being', context: { selfCellId: SELF_CELL } }]);
  }
  if (kw.onOwnMartyrTyped?.effect) {
    tryResolve(card, 'onOwnMartyrTyped', kw.onOwnMartyrTyped.effect, 'Reaction',
      [{ occType: 'being', context: { selfCellId: SELF_CELL } }]);
  }
  if (kw.onOwnBeingShift?.effect) {
    tryResolve(card, 'onOwnBeingShift', kw.onOwnBeingShift.effect, 'Reaction',
      [{ occType: 'being', context: { selfCellId: SELF_CELL } }, { occType: 'relic', context: { selfCellId: SELF_CELL } }]);
  }

  // -- timesPerTurnAbility / payEffigyCostAbility / payLifespanCostAbility /
  // counterCostSacrificeAbility: occupant stays on board (not vacated) at
  // its own cell when these resolve.
  if (kw.timesPerTurnAbility?.effect) {
    tryResolve(card, 'timesPerTurnAbility', kw.timesPerTurnAbility.effect, 'ability',
      [{ occType: 'being', context: { selfCellId: SELF_CELL } }]);
  }
  if (kw.payEffigyCostAbility?.effect) {
    tryResolve(card, 'payEffigyCostAbility', kw.payEffigyCostAbility.effect, 'ability',
      [{ occType: 'being', context: { selfCellId: SELF_CELL } }, { occType: 'relic', context: { selfCellId: SELF_CELL } }]);
  }
  if (kw.payLifespanCostAbility?.effect) {
    tryResolve(card, 'payLifespanCostAbility', kw.payLifespanCostAbility.effect, 'ability',
      [{ occType: 'being', context: { selfCellId: SELF_CELL } }]);
  }
  if (kw.counterCostSacrificeAbility?.effect) {
    tryResolve(card, 'counterCostSacrificeAbility', `Sacrifice this, ${kw.counterCostSacrificeAbility.effect}`, 'ability',
      [{ occType: 'being', context: { selfCellId: SELF_CELL } }]);
  }

  // -- whenSummoned / onMove: only ever read off a 'being' board occupant
  // (SUMMON_BEING / triggerOnMoveReaction) — a Relic/Armament/Altar
  // accidentally parsing one of these fields is genuinely never read by
  // anything, so testing it would be a methodology false positive, not a
  // real gap. onMove also needs movedFromCellId (SUMMON_VINE_MOVED_FROM_RE
  // and friends read it directly, not off the board).
  if ((card.kind === 'being' || card.kind === 'deity') && kw.whenSummoned) {
    tryResolve(card, 'whenSummoned', selfRef(kw.whenSummoned, card.name), 'When Summoned',
      [{ occType: 'being', context: { selfCellId: SELF_CELL } }]);
  }
  if ((card.kind === 'being' || card.kind === 'deity') && kw.onMove) {
    tryResolve(card, 'onMove', selfRef(kw.onMove, card.name), 'Move',
      [{ occType: 'being', context: { selfCellId: SELF_CELL, movedFromCellId: MOVED_FROM_CELL } }]);
  }

  // -- whole-textBox resolution (Conjuring / Ethereal Conjuring cast,
  // CAST_CONJURING, line ~13819) — called with an EMPTY context. Skipped
  // for the handful of Conjurings CAST_CONJURING special-cases entirely
  // outside resolveOrLogEffect before ever reaching that generic call
  // (Deja Vu's own dejaVu branch, Blood Rites' own searchDeckArmamentCostX
  // branch, Desperate Finale's own isDesperateFinale branch).
  const isDesperateFinaleShape = kw.conjureCost && /Pay Lifespan equal to the Lifespan of target engaged Being/i.test(kw.conjureCost);
  if ((card.kind === 'conjuring' || card.kind === 'ethereal-conjuring')
    && !kw.dejaVu && !kw.searchDeckArmamentCostX && !isDesperateFinaleShape) {
    tryResolve(card, 'textBox (CAST_CONJURING)', card.textBox, 'effect', [{ occType: null, context: {} }]);
  }

  // -- Prophecy flip: resolveProphecyModulateHitZero resolves the whole
  // textBox ONE LINE AT A TIME (each line gets its own resolveOrLogEffect
  // call — NOT the combined multi-line text), skipping only the two lines
  // it explicitly excludes as live/continuous auras rather than one-time
  // flip effects (skipsControllerDraw, onAnyBeingDiedGiveDifferentBuff).
  // Every OTHER live-aura field (armamentIdentityOverride,
  // allCardsCostReduction, boardWideAllyBonus/boardWideEnemyBonus, etc.) is
  // NOT excluded from this loop in the real code, so its own textBox line
  // really is (redundantly) fed through resolveOrLogEffect too — flagged
  // here exactly as the real game would log it.
  if (card.kind === 'prophecy') {
    const lines = (stripFlavorText(card.textBox) || '').split('\n').map(l => l.trim()).filter(Boolean);
    lines.forEach((line, i) => {
      if (kw.skipsControllerDraw && /do not draw during the start of your turn/i.test(line)) return;
      if (kw.onAnyBeingDiedGiveDifferentBuff && /^Whenever a Being dies/i.test(line)) return;
      tryResolve(card, `textBox line ${i} (Prophecy flip)`, selfRef(line, card.name), 'Prophecy',
        [{ occType: 'prophecy', context: { selfCellId: SELF_CELL } }]);
    });
  }
}

// -- Category (b): possible parse-time drops -------------------------------

const ACTION_CUES = [
  '(1)', '(2)', '(3)', '(4)', '(5)', '(X)', '(x)',
  'Sacrifice', 'Engage', 'Summon', 'Damage', 'Counter', 'Craft', 'Martyr',
  'Depart', 'Shift', 'Essence', 'Lifespan', 'Modulate', 'Draw', 'Gain',
  'Add', 'Effigy', 'Purgatory', 'Conjure', 'target',
];

const isKeywordsEmpty = (kw) => {
  if (!kw) return true;
  return Object.values(kw).every(v => v === null || v === undefined || v === false || v === 0
    || (Array.isArray(v) && v.length === 0));
};

const possibleDrops = [];
for (const card of allCards) {
  // Conjuring / Ethereal Conjuring / Prophecy kinds don't route their
  // effect text through `keywords` fields at all in normal operation —
  // CAST_CONJURING resolves the whole textBox as one block, and a
  // Prophecy's own flip resolves it one line at a time (see the Prophecy
  // flip / CAST_CONJURING branches in the (a) loop above, which already
  // fully covers these kinds' real coverage). An empty `keywords` object is
  // completely expected for them, so checking it here would just flag
  // every ordinary Conjuring/Prophecy as a false "drop".
  if (card.kind === 'conjuring' || card.kind === 'ethereal-conjuring' || card.kind === 'prophecy') continue;
  const stripped = stripFlavorText(card.textBox) || '';
  if (!stripped.trim()) continue;
  if (!isKeywordsEmpty(card.keywords)) continue;
  const hasCue = ACTION_CUES.some(cue => stripped.includes(cue));
  if (!hasCue) continue;
  possibleDrops.push({ name: card.name, typing: card.typing, textBox: card.textBox });
}

// -- Report -----------------------------------------------------------------

const nonEmptyTextBoxCards = allCards.filter(c => (stripFlavorText(c.textBox) || '').trim());
console.log(`\nScanned ${allCards.length} rows; ${nonEmptyTextBoxCards.length} had a non-empty (post-flavor-strip) textBox.`);

console.log('\n=== (a) CONFIRMED GAPS (hit "isn\'t automated yet" under every plausible context / threw) ===');
if (confirmedGaps.length === 0) {
  console.log('NONE.');
} else {
  confirmedGaps.forEach(g => {
    console.log(`- ${g.name} [${g.typing}] field=${g.field} label="${g.label}"${g.error ? ' ERROR=' + g.error : ''}\n    text: ${JSON.stringify(g.text)}`);
  });
}

console.log(`\n=== (b) POSSIBLE PARSE-TIME DROPS (${possibleDrops.length} candidates, pre-sanity-pass) ===`);
possibleDrops.forEach(d => {
  console.log(`- ${d.name} [${d.typing}]\n    textBox: ${JSON.stringify(d.textBox)}`);
});

fs.writeFileSync(
  path.join(__dirname, 'static-coverage-audit-results.json'),
  JSON.stringify({ confirmedGaps, possibleDrops, totalCards: allCards.length, nonEmptyTextBoxCount: nonEmptyTextBoxCards.length }, null, 2)
);
console.log('\nFull results written to scripts/self-play/static-coverage-audit-results.json');
