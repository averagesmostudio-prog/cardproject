// Shared card-data helpers used by both the card Generator and the Game.
// Extracted from the original single-file App.jsx so both features parse
// the same CSV schema the same way.

export const getColumnData = (card, possibleNames) => {
  for (let name of possibleNames) {
    if (card[name] !== undefined && card[name] !== '') {
      return card[name];
    }
  }
  return '';
};

// Built-in border art, chosen per card from its Card Typing — no manual
// template upload needed. Falls back to the Being/Prophecy border for any
// typing that doesn't match one of the three known groups. Two full sets
// live side by side so the app can offer a "Border Style" choice; every key
// is loaded once by useBorderImages regardless of which style is selected.
export const BORDER_IMAGE_SRC = {
  beingProphecy: `${import.meta.env.BASE_URL}borders/being-prophecy.png`,
  relicAltar: `${import.meta.env.BASE_URL}borders/relic-altar.png`,
  conjuring: `${import.meta.env.BASE_URL}borders/conjuring.png`,
  onboardBeing: `${import.meta.env.BASE_URL}borders/onboard-being.png`,
  onboardConjuring: `${import.meta.env.BASE_URL}borders/onboard-conjuring.png`,
  onboardRelic: `${import.meta.env.BASE_URL}borders/onboard-relic.png`,
};

export const BORDER_STYLES = {
  default: { label: 'Default', keys: ['beingProphecy', 'relicAltar', 'conjuring'] },
  onboard: { label: 'On Board', keys: ['onboardBeing', 'onboardConjuring', 'onboardRelic'] },
};

// Per-card illustration art. Card Name -> image src. Undecorated cards (the
// vast majority right now — this is the first one) render exactly as
// before; only a name listed here triggers the art-box drawing path.
export const CARD_ART_SRC = {
  'Dendrify': `${import.meta.env.BASE_URL}art/dendrify.png`,
};

// Transparent-art-box counterparts to BORDER_IMAGE_SRC, keyed the same way —
// same border texture/ornaments, but the art-box interior is punched fully
// transparent instead of filled with the plain white/tan placeholder, so an
// illustration drawn underneath shows through. Only built for border keys
// that actually have an illustrated card right now; getBorderTypeForCard's
// other keys fall back to the normal opaque template.
export const ART_BORDER_IMAGE_SRC = {
  conjuring: `${import.meta.env.BASE_URL}borders/conjuring-art.png`,
  onboardConjuring: `${import.meta.env.BASE_URL}borders/onboard-conjuring-art.png`,
};

// Cover-fit target rect for the illustration, as fractions of the card
// canvas — the bounding box of each ART_BORDER_IMAGE_SRC entry's punched-out
// hole (measured once from the source art, not derived at runtime).
// y0 sits a bit above the border PNG's own measured alpha boundary — the
// ~2.9x downscale from the 2200px-wide source to the 750px card canvas lets
// canvas's default image smoothing bleed the hard alpha edge a few source
// rows early, which otherwise shows as a thin blank (canvas-background)
// sliver between the border's hole and the art layer drawn under it.
export const ART_BOX_RECT = {
  conjuring: { x0: 0.0582, y0: 0.0185, x1: 0.9427, y1: 0.572 },
  onboardConjuring: { x0: 0.0515, y0: 0.0337, x1: 0.9394, y1: 0.845 },
};

// Resolves a card's illustration (if any) plus the transparent-art-box
// border image to draw it into — null for the overwhelming majority of
// cards, which have no entry in CARD_ART_SRC yet, or whose resolved border
// key has no ART_BORDER_IMAGE_SRC counterpart. `artImages`/`artBorderImages`
// are the refs returned by useCardArtImages(); `artLoaded` its loaded map.
export const resolveCardArt = (card, style, artImages, artBorderImages, artLoaded) => {
  const name = getColumnData(card, ['Card Name', 'A', 'Column A']);
  if (!CARD_ART_SRC[name]) return null;
  const borderKey = getBorderTypeForCard(card, style);
  if (!ART_BORDER_IMAGE_SRC[borderKey]) return null;
  const artKey = `art:${name}`;
  const borderArtKey = `border:${borderKey}`;
  if (!artLoaded[artKey] || !artLoaded[borderArtKey]) return null;
  const artImg = artImages.current[artKey];
  const artBorderImg = artBorderImages.current[borderArtKey];
  if (!artImg || !artBorderImg) return null;
  return { artImg, artBorderImg, artBoxRect: ART_BOX_RECT[borderKey] };
};

// `style` picks which of the two border-art sets to resolve into. The two
// sets group typings differently — e.g. Altar rides with Relic in the
// default set but with Conjuring in the On Board set — so this isn't just a
// key-name swap on the same grouping logic.
export const getBorderTypeForCard = (card, style = 'default') => {
  const typing = (getColumnData(card, ['Card Typing', 'Card typing']) || '').toLowerCase();
  // "Relic, Being" (RULES.md > Card types — Training dummy, Crumbling
  // Sphinx) plays as a full Being and uses the Being border, not the Relic
  // one — checked before the plain "relic" cases below, same precedence as
  // getCardKind.
  const isRelicBeing = typing.includes('relic') && typing.includes('being');
  if (style === 'onboard') {
    if (typing.includes('armament')) return 'onboardBeing';
    if (isRelicBeing) return 'onboardBeing';
    if (typing.includes('relic')) return 'onboardRelic';
    if (typing.includes('altar') || typing.includes('conjuring')) return 'onboardConjuring';
    if (typing.includes('being') || typing.includes('prophecy')) return 'onboardBeing';
    return 'onboardBeing';
  }
  if (typing.includes('armament')) return 'beingProphecy';
  if (isRelicBeing) return 'beingProphecy';
  if (typing.includes('relic')) return 'relicAltar';
  if (typing.includes('altar')) return 'conjuring';
  if (typing.includes('conjuring')) return 'conjuring';
  if (typing.includes('being') || typing.includes('prophecy')) return 'beingProphecy';
  return 'beingProphecy';
};

// Shared with the random-pack generator's "Basic Effigy" card, which tints a
// template to match one of these colors instead of drawing pips.
export const EFFIGY_TYPE_COLORS = {
  'bleeding': '#dc2626',
  'living': '#8bc53f',
  'formless': '#B84FC2',
  'timeless': '#87CEEB',
  'shifting': '#fbbf24',
  'shifitng': '#fbbf24',
  'faithless': '#FFFFFF'
};

export const EFFIGY_COLORS = ['bleeding', 'timeless', 'formless', 'living', 'shifting'];

// A card with no colored casting cost at all — "Faithless" as a printed
// adjective (Temple of Dubiety's "a Faithless Being"; Fidian Nol's "if the
// opposing Being is not Faithless") means exactly this, not the Faithless
// Effigy *count* it might still cost. Shared by both actions.js (deck
// search/summon filters) and combat.js (Fidian Nol's own combat-time
// penalty) — lives here, not in actions.js, so combat.js can use it too
// without an actions.js<->combat.js import cycle.
export const isFaithlessTypedCard = (card) => !card.castingCost?.colored || Object.keys(card.castingCost.colored).length === 0;

// Freestanding utility, not tied to any card-parsing step — a Zealot's
// "Add (N) <Color> Essence" grant (see actions.js > ADD_ESSENCE_RE) is
// temporary (good only until end of turn), the same shape whether it's
// granted through an Engage effect (actions.js) or Eònion Zealot's passive
// Prophecy-counter-removal trigger (turn.js) — both import this rather than
// each keeping their own token-minting logic (and their own instanceId
// counter, which would risk colliding across the two call sites).
let temporaryEssenceInstanceCounter = 0;
export const makeTemporaryEssence = (color, count = 1) =>
  Array.from({ length: count }, () => ({
    instanceId: `essence-${color}#${temporaryEssenceInstanceCounter++}`,
    kind: 'effigy',
    effigyType: color,
    temporary: true,
  }));

// The real CSV misspells "Shifting" as "Shifitng" in 27 cards' Effigy Costs
// column (never in the Effigy type column, which is spelled correctly
// everywhere). Left unnormalized, those cards' castingCost.colored key would
// be a color ('shifitng') that no drafted effigy (always the canonical
// 'shifting') can ever match — making all 27 permanently uncastable. Fixed
// here rather than in the CSV itself, since the CSV is the user's own data.
const EFFIGY_TYPE_ALIASES = { shifitng: 'shifting' };
const normalizeEffigyType = (type) => EFFIGY_TYPE_ALIASES[type] || type;

// Parses an Effigy Costs string like "2, 1 Bleeding, X Living" into
// [{number: '2', type: ''}, {number: '1', type: 'bleeding'}, {number: 'X', type: 'living'}].
// A blank/'faithless' type means the pip can be paid with any color.
export const parseEffigyCost = (cost) => {
  const parts = [];

  if (!cost || cost.trim() === '') {
    return parts;
  }

  const segments = cost.split(',').map(s => s.trim()).filter(s => s);

  segments.forEach(segment => {
    const match = segment.match(/^([X\d]+)\s*([A-Za-z]+)?$/i);

    if (match) {
      const number = match[1].toUpperCase();
      const type = match[2] ? normalizeEffigyType(match[2].toLowerCase()) : '';
      parts.push({ number, type });
      return;
    }
    // Blood Rites: "X, Bleeding" — the only real cost string in the set
    // with a bare color word and no leading number at all; per the
    // user's own ruling this is a real, fixed "1 Bleeding" pip, not a
    // dropped/malformed segment.
    const bareColorMatch = segment.match(/^([A-Za-z]+)$/i);
    if (bareColorMatch) {
      parts.push({ number: '1', type: normalizeEffigyType(bareColorMatch[1].toLowerCase()) });
    }
  });

  return parts;
};

// A card's total printed Effigy cost as one number (faithless pips + every
// colored pip), used wherever cost needs comparing rather than paying (e.g.
// DeckBuilder's cost sort, and Humble/Pompous Contrarian's "lowest/highest
// cost card" comparison in actions.js).
export const totalCastingCost = (card) =>
  (card.castingCost?.faithless || 0) + Object.values(card.castingCost?.colored || {}).reduce((a, b) => a + b, 0);

// -- Game-specific mapping -------------------------------------------------

// Determines the game card "kind" from the free-text Card Typing column.
// Order matters: more specific keywords are checked before their broader
// parent (e.g. Deity before Being, Ethereal Conjuring before Conjuring).
export const getCardKind = (card) => {
  const typing = (getColumnData(card, ['Card Typing', 'Card typing']) || '').toLowerCase();
  if (typing.includes('deity')) return 'deity';
  if (typing.includes('armament')) return 'relic-armament';
  // "Relic, Being" (RULES.md > Card types — Training dummy, Crumbling
  // Sphinx) plays as a full Being on the board (combat, death-damage,
  // Engage/Martyr, the Being border) — checked before the plain 'relic'
  // case below. See isRelicBeing (toGameCard) for the placement/
  // summoning-sickness differences that still set it apart from an
  // ordinary Being.
  if (typing.includes('relic') && typing.includes('being')) return 'being';
  if (typing.includes('relic')) return 'relic';
  if (typing.includes('altar')) return 'altar';
  // The real CSV always separates these with a comma ("Ethereal,
  // Conjuring"), never the single phrase "ethereal conjuring" — checking
  // for both words present (same style as isRelicBeing, above) rather than
  // an exact phrase match. A literal-phrase check here previously never
  // matched any real row at all, so every one of the 31 real Ethereal
  // Conjurings was silently misclassified as a plain (main-phase-only)
  // Conjuring — see RULES.md > Conjurings for the fix and what it needed
  // to touch alongside this to avoid regressing them.
  if (typing.includes('ethereal') && typing.includes('conjuring')) return 'ethereal-conjuring';
  if (typing.includes('conjuring')) return 'conjuring';
  if (typing.includes('prophecy')) return 'prophecy';
  if (typing.includes('being')) return 'being';
  return 'unknown';
};

const toNumber = (value, fallback = 0) => {
  const n = parseInt(String(value).trim(), 10);
  return Number.isFinite(n) ? n : fallback;
};

// "2, 3, 7, 8" / "1" / "XXX" (non-Beings) -> [2, 3, 7, 8] / [1] / [].
export const parseArrows = (raw) => {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 8);
};

// Flavor text (quoted prose, often with a trailing attribution like an
// artist/author name) carries no rules meaning — it's cosmetic, the same way
// it'd be printed in italics on the physical card. Strip it before using a
// card's text for keyword/effect detection so a quoted line never gets
// mistaken for an instruction. Never used for display — the printed card
// still shows its flavor text as-is.
export const stripFlavorText = (text) => {
  if (!text) return text;
  return text
    .split('\n')
    .filter(line => !/^\s*["“].*["”]\s*(?:[-—]\s*[\w .']*)?\s*$/.test(line.trim()))
    .join('\n')
    .trim();
};

// Detects the keyword glossary (see RULES.md > Keywords) from a card's Text
// Box. This is Phase 2 groundwork: the engine can now recognize which
// keywords a card has and (for Depart/Martyr) capture their trailing effect
// text, but most of that captured text still can't be *executed* — there's
// no general effect-resolution engine yet. Only Persist is a pure state
// flag with no free-text payload, so it's the one keyword that's fully wired
// into gameplay so far (see SUMMON_BEING in actions.js). The rest are
// detected and available on `card.keywords`/`card.keywordText` so trigger
// points can reference them (e.g. Depart logs when it fires) ahead of a
// real effect resolver being built.
// Onoushara/Defective Demon: a handful of real cards phrase a self-trigger
// with their OWN printed name instead of the generic "When Summoned"/"Each
// time this moves" wording (e.g. "When Onoushara is summoned...", "When
// Defective Demon moves..."). Since parseKeywords only ever sees a card's
// own text, not its name, that second phrasing needs the name passed in
// explicitly (toGameCard, below) to recognize — this only ever matches
// when the captured word(s) between "When" and the trigger verb are
// EXACTLY the card's own printed name, so it can never misfire on
// "when an opponent's Being moves" or similar text about something else.
const escapeForRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Blanks out (same length, so any surrounding \n/position-based matching
// stays intact) any top-level-balanced parenthetical span that itself
// contains "Engage:" — see the plain engageMatch comment below for why
// this exists. Paren-nesting-aware (tracks depth) so a token description's
// own inner "(1)"-style cost doesn't throw off where the span actually
// closes. Falls back to returning the original text unmasked if the
// parens turn out unbalanced, rather than risking mangling real text.
const blankParensContainingEngage = (s) => {
  let out = '';
  let depth = 0;
  let spanStart = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') {
      if (depth === 0) spanStart = i;
      depth++;
    } else if (ch === ')' && depth > 0) {
      depth--;
      if (depth === 0) {
        const span = s.slice(spanStart, i + 1);
        out += /Engage:/i.test(span) ? ' '.repeat(span.length) : span;
        spanStart = -1;
        continue;
      }
    }
    if (depth === 0) out += ch;
  }
  return spanStart === -1 ? out : s;
};

export const parseKeywords = (textBox, cardName = null) => {
  const text = stripFlavorText(textBox) || '';
  const ownNameRe = cardName ? escapeForRegExp(cardName) : null;
  // "Depart: X", or — mechanically identical, just spelled out instead of
  // using the keyword (Thespian, Horological Horror) — "When this Being
  // dies, X" / "When this dies X". Both feed the same `depart` field rather
  // than needing their own separate trigger point, since Depart's own
  // definition already IS "when this Being dies, X happens".
  const departMatch = text.match(/(?:^|\n)\s*Depart:\s*(.+?)(?:\n|$)/i)
    || text.match(/(?:^|\n)\s*When this(?: Being)? dies,?\s*(.+?)(?:\n|$)/i);
  // "Martyr: X" (a Being's usual, effect-bearing form), or a bare "Martyr"
  // with no colon or effect at all — printed on a couple of Relics (Bag o'
  // Bones; the real CSV also typos it "Matyr" on one row, so the "r" after
  // "Ma" is optional here) meaning just "engage and sacrifice this, for
  // nothing extra". Captured into the same `martyr` field either way — the
  // colon-and-text case gets its trimmed effect text, the bare case gets
  // `''` (still real Martyr — distinct from `null`, "no Martyr at all" —
  // and resolveOrLogEffect already no-ops gracefully on an empty string).
  const martyrMatch = text.match(/(?:^|\n)\s*Mar?tyr:?\s*(.*)(?:\n|$)/i);
  // "When Summoned <effect>" — a Being's ETB trigger (RULES.md > Keywords).
  // Also matches on Armaments/Relics, which print their own "When Summoned
  // gain (N) <Name> Counters" (see armamentCounterMatch below) — harmless,
  // since only SUMMON_BEING (actions.js) ever reads this field, and only off
  // a 'being' board occupant.
  const whenSummonedMatch = text.match(/(?:^|\n)\s*When [Ss]ummoned,?\s*(.+?)(?:\n|$)/i)
    || (ownNameRe && text.match(new RegExp(`(?:^|\\n)\\s*When ${ownNameRe} is summoned,?\\s*(.+?)(?:\\n|$)`, 'i')));
  // "Whenever you conjure a Prophecy, X" (Timeline Tinker) — a Being's own
  // triggered ability firing off PLAY_PROPHECY (actions.js), same
  // real-trigger-point/generic-resolver treatment as `whenSummoned` above,
  // just keyed off a different action instead of SUMMON_BEING.
  const whenConjureProphecyMatch = text.match(/(?:^|\n)\s*Whenever you conjure a Prophecy,?\s*(.+?)(?:\n|$)/i);
  // False Testament: "When conjured you may have this enter with up to (5)
  // Time Counters." — its own printed Timer column is the literal letter
  // "X" (parsed as 0 by toNumber's own fallback), meaning this specific
  // Prophecy's real starting timer is entirely the caster's own choice at
  // cast time (0 up to this cap), not a fixed printed number — see
  // PLAY_PROPHECY, actions.js. Its own SECOND line ("Craft (1) Effigy.")
  // is a normal flip-time Prophecy effect, not part of this — already
  // handled generically once it flips, nothing special needed for it here.
  const whenConjuredEnterUpToMatch = text.match(/When conjured you may have this enter with up to\s*\(?(\d+)\)?\s+Time Counters?/i);
  // Void Channeler: "Gain (1) Crossing Counter each time you Conjure." —
  // reacts to any Conjuring cast (CAST_CONJURING), distinct from
  // whenConjureProphecy above (which only reacts to PLAY_PROPHECY).
  const onConjureMatch = text.match(/Gain\s*\(?(\d+)\)?\s+(\w+) Counters?\s+each time you Conjure/i);
  // Vaneach Hunger: "You may pay an additional (1) Formless to summon
  // 'Prophetic Hunger' in the Ethereal Realm with (1) Time Counter." — per
  // the user's own ruling, "Prophetic Hunger" is a stale name (the card
  // was renamed and this line never got updated) and just refers to
  // itself; the quoted name is matched but discarded. An alternate way to
  // summon THIS card specifically — straight into the Ethereal Realm as a
  // (shifted-shaped) Prophecy instead of a normal Being — for an extra
  // cost on top of its usual summoning cost.
  const alternateSummonProphecyMatch = text.match(
    /You may pay an additional\s*\(?(\d+)\)?\s+(\w+) to summon\s+".+?"\s+in the Ethereal Realm with\s*\(?(\d+)\)?\s+Time Counters?/i
  );
  // "Each time this moves, X" (Hoarder: "Each time this moves create a Rat
  // token on the tile it moved from.") — a Being's own reaction to its
  // *own* non-attack move (RULES.md > Combat/movement), fired from
  // MOVE_OR_ATTACK's move branch (actions.js) same real-trigger-point/
  // generic-resolver treatment as whenSummoned/whenConjureProphecy above.
  // Imneyat Dryad's own printed trigger typos its own name as "Imneyat
  // Druid" ("Dryad" -> "Druid") — tolerated the same way "Diety"/
  // "additonal" are elsewhere in this file, rather than fixing the CSV.
  const ownNameTypoRe = cardName && cardName.includes('Dryad')
    ? escapeForRegExp(cardName.replace('Dryad', 'Druid')) : null;
  const onMoveMatch = text.match(/(?:^|\n)\s*Each time this moves,?\s*(.+?)(?:\n|$)/i)
    || (ownNameRe && text.match(new RegExp(`(?:^|\\n)\\s*When ${ownNameRe} moves,?\\s*(.+?)(?:\\n|$)`, 'i')))
    || (ownNameTypoRe && text.match(new RegExp(`(?:^|\\n)\\s*When ${ownNameTypoRe} moves,?\\s*(.+?)(?:\\n|$)`, 'i')));
  // "When a Being with Dryad moves onto this, X" (Sporangium) — the
  // reverse of onMove above: a reaction to some OTHER Being's Dryad
  // attachment landing on THIS card's own tile, not this card's own
  // movement. Fired from MOVE_OR_ATTACK's Dryad-attach branch (actions.js)
  // — see triggerOnDryadAttachedOnto there.
  const onDryadAttachedOntoMatch = text.match(/(?:^|\n)\s*When a Being with Dryad moves onto this,?\s*(.+?)(?:\n|$)/i);
  // "Shift (X)" (bare — Shifting Shade, Ounati Hunger) or "Shift (X):
  // "quoted prophecy text"" (Scā-vuhk Hunger) — an Engage-costed ability
  // (RULES.md > Keywords > Shift): the Being becomes a Prophecy with X
  // Time Counters, the exact same lifecycle any other Prophecy already
  // has (RULES.md > Prophecies) — see ACTIVATE_SHIFT/
  // resolveProphecyModulateHitZero, actions.js. The quoted text, when
  // printed, becomes the shifted form's own active ability while it's a
  // Prophecy — re-parsed through this very function once a Being actually
  // shifts, so it's not captured as free text here, just the amount.
  const shiftMatch = text.match(/(?:^|\n)\s*Shift\s*\((\d+)\)\s*:\s*"(.+?)"/i)
    || text.match(/(?:^|\n)\s*Shift\s*\((\d+)\)\.?\s*(?:\n|$)/i);
  // "When this moves into the Mortal Realm, X" — the reverse trip of Shift
  // (RULES.md > Keywords > Shift): fires the instant a shifted Being
  // returns from the Ethereal Realm, in addition to landing Engaged. See
  // returnFromShift, actions.js.
  const onMovedIntoMortalRealmMatch = text.match(/(?:^|\n)\s*When this moves into the Mortal Realm,?\s*(.+?)(?:\n|$)/i);
  // Shift's own quoted "prophecy text" shape so far (Scā-vuhk Hunger: "At
  // the end of your turn remove (1) Time Counter from this") — the
  // shifted form's own self-decay, applied by applyEndOfTurnShiftDecay
  // (turn.js) instead of resolveOrLogEffect (a Prophecy's Time Counters
  // aren't a target this engine's generic effect resolver knows how to
  // touch). Tolerant of the "this loses (N) Time Counters" phrasing too
  // (Immen Gorta), not just "remove (N) ... from this".
  const endOfTurnRemoveOwnTimeCountersMatch = text.match(
    /^At the end of your turn,?\s*(?:remove\s*\(?(\d+)\)?\s+Time Counters? from this|this loses\s*\(?(\d+)\)?\s+Time Counters?)\.?$/i
  );
  // Mouth of Madness: "If a Being moves into the Mortal Realm during End
  // Phase it Shifts (X)." — a passive Relic, no "you control" (affects
  // EITHER player's Being), forcing an immediate re-Shift the instant a
  // Being's own return trip lands during the Down Tick Step. Combined
  // with Terranean Gates below, this is a deliberate, real bounce loop —
  // confirmed with the user — capped at 100 iterations as a hard safety
  // stop rather than looping forever. See applyEndPhaseShiftBounce,
  // actions.js.
  const duringEndStepForceShiftMatch = text.match(/^If a Being moves into the Mortal Realm during End Phase it Shifts\s*\(?(\d+)\)?\.?$/i);
  // Terranean Gates: "If a Being moves into the Ethereal Realm during End
  // Phase it loses (X) Time Counters" — the other half of the same bounce
  // loop, firing the instant a Being's own Shift lands during the Down
  // Tick Step.
  const duringEndStepLoseTimeCountersMatch = text.match(/^If a Being moves into the Ethereal Realm during End Phase it loses\s*\(?(\d+)\)?\s+Time Counters?\.?$/i);
  // Formless Fangs: "Any Being dealt damage by this Shifts (X)." — ruled:
  // fires for whichever side it DIDN'T occupy in combat, only if that
  // side survived the damage (its own survival is irrelevant — even if
  // this itself dies, the Being it hit still Shifts if IT lived). See
  // resolveAttackFrom, actions.js.
  const onDealsCombatDamageForceShiftMatch = text.match(/^Any Being dealt damage by this Shifts\s*\(?(\d+)\)?\.?$/i);
  // Echoes of the Boundless: "Whenever another Being dies it's controller
  // may pay its Summoning cost to Shift (X) instead of sending it to
  // Purgatory. Damage is still dealt from it dying." — a passive,
  // board-wide replacement effect (no "you control"): implemented as a
  // "you may retrieve it from Purgatory and Shift it instead" offer right
  // after the normal death pipeline (which still always deals its own
  // Lifespan damage) sends it there — see triggerEchoesOfBoundlessOffer,
  // actions.js.
  const onAnyBeingDiedMayShiftInsteadMatch = text.match(
    /^Whenever another Being dies,?\s*it'?s controller may pay its Summoning cost to Shift\s*\(?(\d+)\)?\s+instead of sending it to Purgatory\.?/i
  );
  // Armaments: "(Attached )?Being has/gains: Engage: <effect>" (or the whole
  // "Engage: effect" wrapped in quotes together) — grants the attached
  // Being a real Engage ability for as long as the Armament stays attached,
  // distinct from an Armament's own printed "Engage:" line acting on
  // itself (below). Checked first so the broader Engage patterns below
  // don't also pick up the same "Engage:" occurrence a second time.
  const grantedEngageMatch = text.match(/(?:Attached )?Being (?:has|gains):?\s*"?Engage:\s*(.+)/i);
  const grantedEngage = grantedEngageMatch ? grantedEngageMatch[1].trim().replace(/"/g, '') : null;
  // Planchette: "Being gains \"Martyr: Summon an Undead or Demon Being
  // from your Purgatory on this tile\"." — the same granted-ability shape
  // as grantedEngageMatch above, just Martyr instead of Engage. Read by
  // whatever Being currently shares Planchette's own ground-Relic tile
  // (see effectiveMartyr, actions.js), not by Planchette itself.
  const grantedMartyrMatch = text.match(/(?:Attached )?Being (?:has|gains):?\s*"?Mar?tyr:?\s*(.+)/i);
  const grantedMartyr = grantedMartyrMatch ? grantedMartyrMatch[1].trim().replace(/"/g, '') : null;
  // Planchette: "At the end of your turn lose Lifespan equal to the
  // Lifespan of the Being on this tile." — reads whatever Being currently
  // shares Planchette's own ground-Relic tile (see applyEndOfTurnGroundRelicCoLocatedLifespanLoss, turn.js).
  const endOfTurnLoseLifespanEqualToCoLocatedBeing = /At the end of your turn lose Lifespan equal to the Lifespan of the Being on this tile/i.test(text);
  // Blood Rites: "Add an Armament that costs (X) from deck to hand." —
  // per the user's own ruling, the (X) here IS the same X paid into the
  // card's own printed cost ("X, Bleeding") — search for an Armament
  // whose own total cost equals however much the caster chose to pay.
  const searchDeckArmamentCostX = /^Add an? Armament that costs\s*\(?X\)?\s+from deck to hand\.?$/im.test(text);
  // Cutlass: "When the attached Being dies sacrifice this and summon a
  // Cursed Cutlass token on this tile." — an Armament reacting to its own
  // host's death (distinct from Depart, which is the *host's* own death
  // trigger, not the equipment's) — see triggerOnAttachedBeingDied,
  // actions.js, fired from both real death paths right after the tile is
  // vacated.
  const onAttachedBeingDiedMatch = text.match(/When the attached Being dies,?\s*sacrifice this,?\s*(.+?)(?:\n|$)/i);
  // "Engage: X" — a generic activated ability (RULES.md's Engage keyword is
  // the generic "take an action" term; this is the specific printed pattern
  // for abilities costed by it, distinct from Martyr's engage-then-sacrifice
  // and from plain attacking/moving). By far the most common trigger shape
  // in the real card text after Depart, so it gets the same real trigger
  // point (see ACTIVATE_ENGAGE in actions.js). Real cards print "Engage:"
  // three different ways: bare on its own line, after an extra Lifespan
  // cost ("Pay (N) Lifespan, Engage: X" — NamKaranian Zealot), or after a
  // condition ("If you control ... you may Engage: X" — Zealot, Kalduran
  // Zealot). All three are mutually exclusive matches against the same
  // "Engage:" occurrence, checked in that order, so only one ever wins and
  // sets `engage` — the extra cost/condition (if any) is captured into its
  // own separate field instead of getting lost.
  const payLifespanEngageMatch = !grantedEngageMatch
    && text.match(/Pay\s*\(?(\d+)\)?\s+Lifespan,?\s*Engage:\s*(.+?)(?:\n|$)/i);
  // "Pay (1) Living Essence, Engage: X" (Tilled Fields) — the same
  // Lifespan-cost-then-Engage shape as payLifespanEngageMatch above, just
  // costed by real Effigy from the pool instead (see engageEffigyCost,
  // ACTIVATE_GROUND_RELIC_ENGAGE in actions.js) — distinct from
  // payEffigyCostMatch below, which has no Engage at all.
  const payEffigyEngageMatch = !grantedEngageMatch && !payLifespanEngageMatch
    && text.match(/Pay\s*\(?(\d+)\)?\s+(\w+) Essence,?\s*Engage:\s*(.+?)(?:\n|$)/i);
  // "Remove (X) Crossing Counters, Engage: Restore (X) Lifespan to
  // target." (Sanative Siphon) — X is a genuine player choice (however
  // many Counters they remove right now), the same shape
  // removeCountersSacrificeSearchMatch below already establishes for
  // Death's Decanter, just also tapping the Relic (a real printed
  // "Engage:") and reusing the EXISTING generic 'restore-lifespan-target'
  // pendingChoice for its effect instead of a Purgatory search. Excluded
  // from every plain-Engage match below it, or the bare "Restore (X)
  // Lifespan to target." fragment would also get captured as a normal
  // `engage` effect — offering a second, broken plain-Engage button
  // alongside this dedicated one. See
  // ACTIVATE_REMOVE_COUNTERS_ENGAGE_RESTORE, actions.js.
  const removeCountersEngageRestoreMatch = !grantedEngageMatch && !payLifespanEngageMatch && !payEffigyEngageMatch
    && text.match(/Remove\s*\(?X\)?\s+(\w+) Counters?,?\s*Engage:\s*Restore\s*\(?X\)?\s+Lifespan to target/i);
  const conditionalEngageMatch = !grantedEngageMatch && !payLifespanEngageMatch && !payEffigyEngageMatch && !removeCountersEngageRestoreMatch
    && text.match(/If you control\s+(.+?)\s+you may\s+Engage:\s*(.+?)(?:\n|$)/i);
  // "Engage, X: Y" — a comma (not a colon) right after "Engage" means X is
  // a *required second part of the cost*, not the effect: both "Engage"
  // and X must be paid before Y (after the real colon) happens (e.g.
  // Osteomancer: "Engage, Sacrfiice a Bag o' Bones: Add an Undead to hand
  // from your Purgatory" — the cost is Engage + sacrificing a Bag o'
  // Bones, not "sacrifice a Bag o' Bones" as a freestanding effect).
  // Doesn't collide with any pattern above — none of them match on a bare
  // "Engage," (no colon immediately after), only "Engage:".
  const engageExtraCostMatch = !grantedEngageMatch && !payLifespanEngageMatch && !payEffigyEngageMatch && !removeCountersEngageRestoreMatch && !conditionalEngageMatch
    && text.match(/(?:^|\n).*?\bEngage,\s*(.+?):\s*(.+?)(?:\n|$)/i);
  // "Remove (N) <Type> Counter(s): Engage then <effect>" (Crucible), the
  // comma+colon variant "Remove (N) <Type> Counter(s), Engage: <effect>"
  // (Ferryman's Boat), or "Remove (N) <Type> Counter, then Engage: <effect>"
  // (Mausoleum Gates — "then" appears BEFORE Engage this time, not after)
  // — the cost comes *before* Engage either way, which includes Engaging
  // (tapping) the permanent as part of paying it, before <effect>
  // resolves. Distinct from RELIC_COUNTER_MOVE_RE (actions.js), which is
  // one hardcoded effect shape for a ground Relic specifically — this is
  // generic over any effect text, for a normal board Relic (or, in
  // principle, a Being). Requires a real digit for the counter amount
  // (\d+), so it never collides with removeCountersEngageRestoreMatch
  // above (that one's own amount is the literal letter "X").
  const counterCostEngageMatch = !grantedEngageMatch && !payLifespanEngageMatch && !payEffigyEngageMatch && !removeCountersEngageRestoreMatch && !conditionalEngageMatch && !engageExtraCostMatch
    && text.match(/Remove\s*\(?(\d+)\)?\s+(\w+)\s+Counters?,?:?\s*(?:then\s+)?Engage,?:?\s*(?:then\s+)?(.+?)(?:\n|$)/i);
  // Plain "Engage: X" anywhere on its own line — checked only once neither
  // more specific shape above matched. Deliberately not anchored to the
  // very start of the line (a bare Engage's usual position) because real
  // Zealot text sometimes has other prose sharing the line and there's no
  // clean way to anchor around that without missing it.
  //
  // A summoned token's own reminder text sometimes embeds ITS "Engage: ..."
  // ability inside a parenthetical describing that token (Blooming Seed:
  // "...summon a Blooming Vine Token (0/3 Being - vine token with Engage:
  // Add (1) Living) on any tile..."; Elderflower Ancient has the same
  // shape) — the real CSV wraps that inner phrase in doubled quotes
  // (`""Engage: ...""`) as its own reminder-text convention, but CSV
  // unescaping strips those away entirely before this function ever sees
  // the text, leaving no quote character to key off. That's the TOKEN's
  // ability, not this card's own — neither of those two cards prints a
  // real top-level Engage line at all (their own abilities are "Pay (1)
  // Living:" / "Remove (1) Growth Counter:" / Depart). blankParensContainingEngage
  // (paren-nesting-aware, so the token description's own inner "(1)" cost
  // doesn't throw off the balance) blanks out any parenthetical span that
  // itself contains "Engage:" before this bare match runs, so it can never
  // mistake a token's granted ability for this card's own. The other, more
  // specific Engage patterns above all require a distinctive phrase
  // ("Pay (N) Lifespan, Engage:", "Being has Engage:", ...) immediately
  // before "Engage:" that a token-descriptor parenthetical never happens
  // to contain, so only this last catch-all needs the guard.
  const engageMatch = !grantedEngageMatch && !payLifespanEngageMatch && !payEffigyEngageMatch && !removeCountersEngageRestoreMatch && !conditionalEngageMatch && !engageExtraCostMatch && !counterCostEngageMatch
    && blankParensContainingEngage(text).match(/(?:^|\n).*?\bEngage:\s*(.+?)(?:\n|$)/i);
  const engageLifespanCost = payLifespanEngageMatch ? parseInt(payLifespanEngageMatch[1], 10) : null;
  const engageEffigyCost = payEffigyEngageMatch
    ? { color: payEffigyEngageMatch[2].toLowerCase(), amount: parseInt(payEffigyEngageMatch[1], 10) }
    : null;
  // The free-text extra cost from "Engage, X: Y" — kept as raw text (not
  // every shape is recognized/payable yet, see actions.js >
  // engageExtraCostPayable) rather than guessed at.
  const engageExtraCost = engageExtraCostMatch ? engageExtraCostMatch[1].trim() : null;
  const engageCounterCost = counterCostEngageMatch
    ? { type: counterCostEngageMatch[2].toLowerCase(), amount: parseInt(counterCostEngageMatch[1], 10) }
    : null;
  // Only two real condition phrasings exist today; an unrecognized one is
  // left unset rather than guessed at, so Engage stays available
  // unconditionally for it (an honest, documented simplification — same as
  // Faithless Altar's identical condition on its craft bonus, not a cost).
  const classifyEngageCondition = (phrase) => {
    if (/only Faithless/i.test(phrase)) return 'faithless-only';
    if (/Relic/i.test(phrase)) return 'controls-relic';
    return null;
  };
  const engageCondition = conditionalEngageMatch ? classifyEngageCondition(conditionalEngageMatch[1]) : null;
  // A card printing *more than one* independent "Engage: X" line (only
  // Osteomancer today: "Engage, Sacrfiice a Bag o' Bones: ..." and
  // "Engage, Sacrifice an Undead: ...", two genuinely separate abilities,
  // not one multi-clause one) needs all of them, not just the first the
  // single-match fields above capture. Computed independently, line by
  // line, purely additive — the singular `engage`/`engageLifespanCost`/
  // `engageCondition`/`engageExtraCost` fields above are untouched and
  // still reflect the first ability alone, so every existing single-Engage
  // card's behavior is unaffected; only code that explicitly reads
  // `engageAbilities` sees more than one.
  const engageAbilities = text.split('\n')
    .map(line => line.trim())
    .filter(line => /\bEngage[,:]/i.test(line))
    .map(line => {
      const payLifespan = line.match(/^Pay\s*\(?(\d+)\)?\s+Lifespan,?\s*Engage:\s*(.+)$/i);
      if (payLifespan) return { effect: payLifespan[2].trim(), lifespanCost: parseInt(payLifespan[1], 10), condition: null, extraCost: null };
      const conditional = line.match(/^If you control\s+(.+?)\s+you may\s+Engage:\s*(.+)$/i);
      if (conditional) return { effect: conditional[2].trim(), lifespanCost: null, condition: classifyEngageCondition(conditional[1]), extraCost: null };
      const extraCost = line.match(/^.*?\bEngage,\s*(.+?):\s*(.+)$/i);
      if (extraCost) return { effect: extraCost[2].trim(), lifespanCost: null, condition: null, extraCost: extraCost[1].trim() };
      const bare = line.match(/^.*?\bEngage:\s*(.+)$/i);
      if (bare) return { effect: bare[1].trim(), lifespanCost: null, condition: null, extraCost: null };
      return null;
    })
    .filter(Boolean);
  // Altars: "Craft (N) additional Effigy/Effigies on your turn" — a passive,
  // always-on permanent effect (no Engage cost), so it's its own keyword
  // rather than something resolved through an activation trigger. Captured
  // as a plain number so turn.js's craftEffigies can sum it across every
  // Altar the turn player controls.
  const craftBonusMatch = text.match(/Craft\s*\(?(\d+)\)?\s+additional\s+Effig(?:y|ies)/i);
  // Altars: "As an additional cost to Conjure, <effect>" — a real cost paid
  // when the Altar is placed (PLACE_ALTAR); the same shape also appears on
  // a plain Conjuring (Desperate Finale: "As an additonal cost to
  // conjure:"), read at CAST_CONJURING instead. Real printed text is
  // inconsistent about punctuation ("," vs ":") and misspells "additional"
  // two different ways ("aditional" — one d; "additonal" — missing the
  // second "i"), so the word itself is matched loosely rather than
  // requiring exact spelling either way.
  const conjureCostMatch = text.match(/As an ad{1,2}it(?:ional|onal) cost to Conjure[,:]?\s*(.+?)(?:\n|$)/i);
  // A Being/Deity's own mirror of conjureCostMatch above, but for Summon —
  // so far only ever "Sacrifice (N) Beings" (Immen Gorta), captured as a
  // plain number rather than free text like conjureCost/engage's cost
  // captures, since SUMMON_BEING (actions.js) needs a real count up front
  // to gate offering the summon at all (same "won't be offered without a
  // legal way to pay" precedent as every other additional-cost gate).
  const additionalSummonCostSacrificeBeingsMatch = text.match(/As an ad{1,2}it(?:ional|onal) cost to [Ss]ummon[,:]?\s*Sacrifice\s*\(?(\d+)\)?\s+Beings?/i);
  // Faithless Altar: "If you control only Faithless Permanents: Craft (N)
  // additional Effigy..." — a condition gating the craft bonus above,
  // distinct from a conjure cost (it's re-checked every turn the bonus would
  // apply, not paid once at placement). The real CSV spells "Permanents" as
  // "Permaments", so the word after "Faithless" is matched loosely rather
  // than requiring exact spelling.
  const craftBonusFaithlessOnly = craftBonusMatch && /If you control only Faithless \w+/i.test(text);
  // Eònion Altar: "If this has (0) Time Counters: Craft (N) additional
  // Effigy..." — the other real condition on a craft bonus, checked against
  // the Altar's own Time Counters (see armamentCounterGrant below for how
  // it gets them, and turn.js's altarCraftBonus for where this is read).
  const craftBonusZeroTimeCounters = craftBonusMatch && /If this has\s*\(?0\)?\s+Time Counters?/i.test(text);
  // Armaments: "(Attached )?Being has/gains +N/+N" — a real, additive
  // Strength/Lifespan bonus while attached (RULES.md > Card types), in the
  // same Str/Life order the rest of this schema always uses.
  const statBonusMatch = text.match(/(?:Attached )?Being (?:has|gains)\s*([+-]\d+)\/([+-]\d+)/i);
  // "When summoned/conjured gain (N) <Name> Counters" — an ETB counter
  // grant when the permanent enters play, whichever verb its own card type
  // prints: Armaments/Relics/Beings say "summoned" (e.g. "Feathers of the
  // Fallen": "When summoned gain (2) Crossing Counters."), Altars say
  // "conjured" (Eònion Altar: "When conjured gain (3) Time Counters.") —
  // same ETB semantics either way. Captured by counter name generically
  // rather than hardcoding "Crossing", so any future card using a
  // differently-named counter is picked up the same way.
  // "Enters with (2) Crossing Counters." (Mausoleum Gates) is the same ETB
  // grant, just phrased as "Enters with" instead of "When summoned/
  // conjured gain" — same field either way.
  const armamentCounterMatch = text.match(/When (?:summoned|conjured) gain\s*\(?(\d+)\)?\s+(\w+)\s+Counters?/i)
    || text.match(/Enters with\s*\(?(\d+)\)?\s+(\w+)\s+Counters?/i);
  // Appease the Masses: "All cards cost (-1) Faithless." — a board-wide
  // cost-reduction aura read live off a face-up Prophecy still holding Time
  // Counters (same source every other board-wide aura in this file already
  // reads from — see activeAllCardsCostReduction, actions.js), applying to
  // every card kind the printed "All cards" actually covers.
  const allCardsCostReductionMatch = text.match(/All cards cost\s*\(?-(\d+)\)?\s+(\w+)\.?/i);
  const allCardsCostReduction = allCardsCostReductionMatch
    ? { amount: parseInt(allCardsCostReductionMatch[1], 10), color: allCardsCostReductionMatch[2].toLowerCase() }
    : null;
  // "Mahka-Rahva's Tiger Skin": "Sacrifice this to give attached being a
  // Favored Counter until the end of turn." — a sacrifice-cost activated
  // ability (no Engage cost at all, unlike everything else here), narrow
  // enough that it's matched close to verbatim rather than generalized.
  const sacrificeForFavored = /Sacrifice this to give attached being a Favored Counter/i.test(text);
  // "Once per turn when a Time Counter is removed from a Prophecy you
  // control, add (N) <Color> Essence" (e.g. "Eònion Zealot") — a passive
  // trigger, not Engage-costed at all, reacting to Modulate ticking a
  // Prophecy down (see triggerZealotProphecyEssence in turn.js).
  const prophecyCounterMatch = text.match(/Once per turn when a Time Counter is removed from a Prophecy you control,?\s*add\s*\(?(\d+)\)?\s+(\w+)\s+Essence/i);
  // "Whenever a Time Counter is removed from a Prophecy you control add it
  // to this" (Hourglass) — a passive Relic ability, same trigger point as
  // Eònion Zealot's own Prophecy-counter-removal reaction above, just
  // collecting the Counter onto itself instead of granting Essence, and
  // with no "Once per turn" limit (every removal counts, not just the
  // first each turn).
  // Hourglass: "...add it to this." / Horologist's Apprentice: "Gain (1)
  // Time Counter whenever..." — same trigger, reversed word order.
  const collectsRemovedProphecyTimeCounters = /Whenever a Time Counter is removed from a Prophecy you control add it to this/i.test(text)
    || /Gain\s*\(?1\)?\s+Time Counter whenever a Time Counter is removed from a Prophecy you control/i.test(text);
  // "All Armaments you control move to the tile this is summoned on"
  // (Mahka-Rahva) — a static, unconditional ETB effect printed *before* its
  // own "When Summoned" sentence, so it's a separate keyword, not part of
  // `whenSummoned` above. Fully mechanical (no free text to resolve, like
  // Persist/Favored), so it's a pure boolean flag — SUMMON_BEING (actions.js)
  // resolves it directly.
  const gathersArmamentsOnSummon = /All Armaments you control move to the tile this is summoned on/i.test(text);
  // "Whenever a Being is summoned under your control, move and attach
  // Happy Hammer to that Being." — an Armament's own reaction to its
  // controller's future summons, not a one-time ETB effect (distinct from
  // gathersArmamentsOnSummon above, which fires once for the Being itself
  // being summoned). Detected generically (not hardcoded to "Happy
  // Hammer") so any future Armament phrased the same way is picked up
  // automatically — see the move trigger in placeBeingOnBoard, actions.js.
  const movesToNewlySummonedBeing = /Whenever a Being is summoned under your control,?\s*move and attach .+? to that Being/i.test(text);
  // "When a <Typing> is summoned under your control, X" (Greenseer's
  // assistant: "When a Familiar is summoned under your control draw (1)
  // card.") — a *Being's* own reaction to any OTHER Being matching a
  // printed typing being summoned under the same controller, distinct from
  // movesToNewlySummonedBeing above (an Armament's own reaction, and
  // unconditional on typing). Generic over both the typing and the effect
  // text, so any future card phrased the same way is picked up
  // automatically — see triggerTypedSummonReactions, actions.js. Anchored
  // to "When" at the start of a line (not "Whenever") so it never collides
  // with movesToNewlySummonedBeing's own "Whenever a Being is summoned..."
  // text.
  const onTypedSummonedMatch = text.match(/(?:^|\n)\s*When an?\s+(.+?)\s+is summoned under your control,?\s*(.+?)(?:\n|$)/i);
  // "Sacrifice this when you summon a Familiar." (White Whisker) — a
  // reactive Relic-level trigger (not a Being's own onTypedSummonedUnderControl
  // above), watched for by triggerSacrificeSelfOnSummonTyping (actions.js),
  // called from the same shared placeBeingOnBoard every summon path funnels
  // through.
  const sacrificeSelfOnSummonTypingMatch = text.match(/(?:^|\n)\s*Sacrifice this when you summon an?\s+(.+?)\.?\s*(?:\n|$)/i);
  // "Beings may move across this" (Shifting Sands, Tilled Fields — the real
  // CSV phrases the self-reference differently card to card: "this",
  // "this Relic", or the card's own printed name, so this just detects the
  // phrase itself rather than trying to resolve what "this" refers to,
  // since the flag means the same thing regardless of wording. A pure
  // boolean, like Persist/Favored — no free text to resolve. Relevant only
  // for a Relic; SUMMON_BEING/ATTACH_ARMAMENT never read it off anything
  // else, same as martyr/whenSummoned being harmlessly inert on cards that
  // never reach the board shape that checks them.
  const beingsMayMoveAcross = /Beings may move across\b/i.test(text);
  // "Can not attack." (Training dummy) — a static restriction, not an
  // effect resolved through resolveOrLogEffect; getLegalActions checks it
  // directly wherever it would otherwise offer an attack.
  const cannotAttack = /Can ?not attack\b/i.test(text);
  // "Can not move." (Reveler) — same static-restriction treatment as
  // cannotAttack above; getLegalActions checks it wherever it would
  // otherwise offer a move. Deliberately doesn't block a move *granted* by
  // another card (Shifting Sands' own Engage, etc.) — those don't go
  // through this same "offer a move" check at all, so a Being with this
  // flag can still be moved by an external effect, matching the real
  // rules text (confirmed with the user: the contradiction with Reveler's
  // own "Whenever this moves..." reaction is intentional).
  const cannotMove = /Can ?not move\b/i.test(text);
  // "Does not Disengage during start of turn." (Anahk-sha) — unconditional
  // and permanent (unlike doesNotDisengageWhileHasTimeCounters, which is
  // counter-gated, or Instigator's own doesNotDisengage, a self-consuming
  // per-occupant flag) — a static, printed property of the card itself,
  // checked directly off card.keywords in turn.js's disengage().
  const neverAutoDisengages = /Does not Disengage during start of turn/i.test(text);
  // "If this is Engaged at the end of the turn, sacrifice it." (Tilled
  // Fields) — a real end-of-turn self-sacrifice condition, checked in
  // endTurn (turn.js) against the occupant's own live `engaged` field. The
  // matching "Until end of turn Plants summoned on this tile come in
  // Disengaged." clause is this same card's own Engage EFFECT text
  // (captured into `engage` above, like any other Engage ability) rather
  // than a separate static field — it's resolved through
  // resolveOrLogEffect's own PLANTS_ENTER_DISENGAGED_RE, actions.js.
  const sacrificeIfEngagedAtEndOfTurn = /If this is Engaged at the end of the turn,?\s*sacrifice it/i.test(text);
  // "Whenever you Martyr a Seed, Craft (1) Effigy." (Sapling) — a Being's
  // own reaction to its controller's OWN Martyr activations, not just its
  // own — same "typing + free effect text" shape as onTypedSummonedMatch
  // above, just watching Martyr instead of summon. See
  // triggerMartyrTypedReactions, actions.js.
  const onOwnMartyrTypedMatch = text.match(/Whenever you Martyr an? (.+?),\s*(.+?)(?:\n|$)/i);
  // "When revealed on the top of your deck, <effect>" (Distant Debator) —
  // a genuinely new trigger point: this engine has no separate reveal-
  // without-drawing mechanic, so the closest real moment is the literal
  // draw itself — see triggerOnRevealedTopOfDeck, actions.js.
  const onRevealedTopOfDeckMatch = text.match(/When revealed on the top of your deck,?\s*(.+?)(?:\n|$)/i);
  // "Whenever you pay Lifespan gain +1/+1." (Ravenous Lamtukka) — a
  // passive reaction to the controller's own GENUINE Lifespan payments (an
  // optional cost deliberately spent for an ability), not damage/forced
  // Lifespan loss. See triggerLifespanPaidReactions, actions.js.
  const onLifespanPaidMatch = text.match(/Whenever you pay Lifespan,?\s*gain\s*\+?(\d+)\/\+?(\d+)/i);
  // "If you conjure a non Armament Relic on a tile this points to, Craft an
  // Effigy." (Monumental Mason) — reacts to PLACE_RELIC (the only action
  // that ever conjures a standalone, non-Armament Relic onto its own tile;
  // an Armament is always ATTACH_ARMAMENT instead, which has no tile of its
  // own to point at) landing on any tile this card's own printed Arrows
  // point to — the same "points to" geometry Green thumbed Gardener/
  // Sporangium/Nursery Attendant all use. See
  // triggerPointedRelicConjureCraftEffigy, actions.js.
  const craftEffigyOnPointedRelicConjureMatch = text.match(/If you conjure a non Armament Relic on a tile this points to,?\s*Craft\s*\(?(\d+|an?)\)?\s+Effigy/i);
  // "<Typing> Beings that <own name> Points to cost (-N) <Color> to
  // activate." (Nursery Attendant) — printed with the card's own name
  // instead of "this" (own-name substitution, same precedent as
  // onOwnMartyrTyped's siblings above); a live discount applied wherever a
  // "Pay (N) <Color>: X" ability's cost is checked/paid — see
  // pointedActivationCostReduction, actions.js.
  const seedActivationCostReductionMatch = ownNameRe && text.match(new RegExp(
    `^(.+?) Beings that ${ownNameRe} [Pp]oints to cost\\s*\\(?-?(\\d+)\\)?\\s+(\\w+) to activate\\.?$`, 'i'
  ));
  // "When this Being deals damage to an opponent, prevent that damage and
  // craft (X) Effigies where (X) is the damage that would have been
  // dealt." (Degrisch Vassal) — ruled: "deals damage to an opponent" means
  // this engine's own open-lane/non-blocking-occupant attack (the one
  // case a Being's damage actually lands on the opponent's Lifespan
  // directly, rather than another Being or its own controller's death
  // loss) — see resolveAttackFrom's own straight-through branch,
  // actions.js.
  const preventOpenLaneDamageCraftEffigyMatch = /^When this Being deals damage to an opponent,?\s*prevent that damage and craft/i.test(text);
  // "Once per turn when a Being you control dies you may have this Relic
  // gain its effect(s) until end of turn." (Wretched Remnants) — ruled:
  // copies the dying Being's WHOLE textBox (Depart, Martyr, Engage, static
  // bonuses — everything printed), not its stats/typing/name. See
  // triggerWretchedRemnantsOffer, actions.js, for how the borrowed
  // textBox is actually swapped onto the Relic's own card for the rest of
  // the turn.
  const onOwnBeingDiedGainTextBoxMatch = /^Once per turn when a Being you control dies you may have this Relic gain its effect\(s\) until end of turn\.?\s*$/i.test(text);
  // "Once per turn you may sacrifice a Vine token, summon this from
  // Purgatory on the tile that the sacrificed vine token was on" (Roots of
  // Eternity) — an activated ability that lives on the card while it's
  // sitting IN Purgatory rather than on the board (see
  // ACTIVATE_REANIMATE_FROM_PURGATORY, actions.js). Captures just the
  // required token typing generically, so any future card phrased the same
  // way (a different token typing) is picked up automatically.
  const reanimateFromPurgatoryMatch = text.match(
    /Once per turn you may sacrifice an? (\w+) token,\s*summon this from Purgatory on the tile (?:that )?the sacrificed \w+ token was on/i
  );
  // "Whenever a different Being you control Fights, gain +1/+0 until the
  // end of turn." (Spirit of War) — a Being's own reaction to another of
  // its controller's OWN Beings attacking, a genuinely temporary bonus
  // (cleared at end of turn, unlike onLifespanPaidGrowth's permanent one)
  // — see triggerAllyFightsReactions, actions.js.
  const onAllyFightsMatch = text.match(/Whenever a different Being you control Fights,?\s*gain\s*\+?(\d+)\/\+?(\d+)\s+until the end of turn/i);
  // "Whenever a Being you control Shifts, <X>" (Sanative Siphon's own
  // "Gain (1) Crossing Counter whenever a Being you control Shifts." puts
  // the effect BEFORE "whenever"; Thōgrakin Hunger's own "Whenever a
  // Being you control Shifts, except during the end step, add (1)
  // Formless Essence." puts it after, with an optional exception clause)
  // — a passive reaction to RULES.md > Keywords > Shift, fired from
  // performShift itself (actions.js) regardless of which card's own
  // ability actually caused the Shift.
  // Not anchored to the whole textBox (bare ^...$, no multiline flag) —
  // Sanative Siphon's own real printed text is two lines ("Gain (1)
  // Crossing Counter whenever a Being you control Shifts.\nRemove (X)
  // Crossing Counters, Engage: Restore (X) Lifespan to target."), so a
  // bare trailing `$` would require the WHOLE card's text to end right
  // after "Shifts." — it never does, so this silently never matched the
  // real card at all (only ever verified against hand-authored single-line
  // test fixtures that happened to end there). `(?:\n|$)` tolerates a
  // second line following, same convention every other multi-line-aware
  // pattern in this file already uses.
  const onOwnBeingShiftWheneverFirst = text.match(/(?:^|\n)\s*Whenever a Being you control Shifts,?\s*(except during the end step,?\s*)?(.+?)\.?(?:\n|$)/i);
  const onOwnBeingShiftEffectFirst = !onOwnBeingShiftWheneverFirst && text.match(/(?:^|\n)\s*(.+?)\s+whenever a Being you control Shifts\.?(?:\n|$)/i);
  // "Restless Dead has +2/+0 until end of turn for each Being that died
  // under your control this turn." — a LIVE, continuously-recomputed bonus
  // (grows the instant beingsDiedThisTurn does, same "recomputed after
  // every action" precedent as Horological Horror/Singularity's own X) —
  // see recomputeDeathCountBonuses, actions.js.
  const statBonusPerOwnDeathMatch = text.match(
    /has\s*\+?(\d+)\/\+?(\d+)\s+until end of turn for each Being that died under your control this turn/i
  );
  // "You take (1) less Lifespan Damage during the Down Tick Step." (The
  // Fountain) — "Down Tick Step" is the real end-of-turn phase's own name
  // (confirmed against the user's own turn-structure ruling): "Active
  // Player loses (1) Lifespan as the final action before the next Player
  // starts their turn." Reduces that same -1 cost for the turn player, see
  // endTurn, turn.js.
  const downTickLifespanReductionMatch = text.match(/You take\s*\(?(\d+)\)?\s+less Lifespan Damage during the Down Tick Step/i);
  // "Whenever a Being you control dies, Onoushara gains +1/+1." — matched
  // only against "this"/"it" or the card's OWN printed name specifically
  // (not any arbitrary name), so it can't misfire on some future card that
  // buffs a DIFFERENT, named Being when yours die — a genuinely different
  // targeting scope this pattern was never meant to cover. See
  // triggerOwnBeingDiedReactions, actions.js.
  const onOwnBeingDiedMatch = text.match(/Whenever a Being you control dies,?\s*(?:this|it) gains\s*\+?(\d+)\/\+?(\d+)/i)
    || (ownNameRe && text.match(new RegExp(`Whenever a Being you control dies,?\\s*${ownNameRe} gains\\s*\\+?(\\d+)\\/\\+?(\\d+)`, 'i')));
  // "Once per turn sacrifice (X) <Name>: Summon a Being from your Purgatory
  // with cost (X)" (Cemetery Physician) — a variable-cost activated ability
  // distinct from Engage: the printed "(X)" isn't a fixed number, it's
  // however many of the named permanent the player chooses to sacrifice
  // right now, and that same number is also the Purgatory search's target
  // cost. Captured by fodder name generically (not hardcoded to Bag o'
  // Bones) the same way costReduction is, above.
  const sacrificeXSummonMatch = text.match(/Once per turn sacrifice\s*\(?X\)?\s+(.+?):\s*Summon an? Being from your Purgatory with cost\s*\(?X\)?/i);
  // "Gain (1) Crossing Counter whenever a Being Dies." (Death's Decanter)
  // — no "you control" on the trigger, unlike onOwnBeingDiedMatch above:
  // ANY Being dying, either side, grants the Relic's own controller a
  // Counter. See triggerAnyBeingDiedCounterGain, actions.js.
  const gainCounterOnAnyDeathMatch = text.match(/Gain\s*\(?(\d+)\)?\s+(\w+) Counter whenever a Being [Dd]ies/i)
    // Canopic Jar's own reversed phrasing: "Whenever a Being dies add (N)
    // <Type> Counter to this." — same trigger/effect, just the "whenever a
    // Being dies" clause printed first instead of last.
    || text.match(/Whenever a Being [Dd]ies,?\s*add\s*\(?(\d+)\)?\s+(\w+) Counters?\s+to this/i);
  // "Once per turn, when a Turanga you control dies: Add a Spirit from
  // deck to hand.\nOnce per turn, when a Spirit you control dies: Add a
  // Turanga from deck to hand." (Lotus) — two independent once-per-turn
  // reactions (both real today; generic over any number via matchAll, in
  // case a future card prints just one or three), each keyed by the dying
  // Being's own typing, searching the MAIN DECK (not Purgatory) for the
  // paired typing — see triggerDeckSearchOnTypedDeath, actions.js.
  const deckSearchOnTypedDeathMatches = [...text.matchAll(
    /Once per turn,?\s*when a\s+(\w+) you control dies:?\s*Add an?\s+(\w+) from deck to hand/gi
  )];
  const deckSearchOnTypedDeath = deckSearchOnTypedDeathMatches.length > 0
    ? deckSearchOnTypedDeathMatches.map(m => ({ dyingTyping: m[1], addTyping: m[2] }))
    : null;
  // "Remove (X) Crossing Counters: Sacrifice this Relic, then add a
  // Formless Being with Conjuring cost (X) from your Purgatory to hand."
  // (Death's Decanter) — X is a genuine player choice (however many
  // Counters they remove right now), not a fixed printed number, so this
  // can't be routed through resolveOrLogEffect's static free-text
  // resolver the way a normal Engage/Depart/etc effect is — it's its own
  // dedicated activated-ability keyword, the same "variable-X, its own
  // ACTIVATE_* action" shape sacrificeXSummonMatch (Cemetery Physician)
  // above already uses, just costed by Counters instead of sacrificed
  // copies. See ACTIVATE_REMOVE_COUNTERS_SACRIFICE_SEARCH, actions.js.
  const removeCountersSacrificeSearchMatch = text.match(
    /Remove\s*\(?X\)?\s+(\w+) Counters:\s*Sacrifice this Relic,?\s*then add an?\s+(\w+) Being with Conjuring cost\s*\(?X\)?\s+from your Purgatory to hand/i
  );
  // "Pay (N) <Color>: <effect>" (Blooming Seed: "Pay (1) Living: Add (1)
  // Growth Counter.") — a bare activated ability costed by paying real
  // Effigy directly out of the pool, not Lifespan and not Engage (so it's
  // usable the same turn the Being is summoned, and any number of times so
  // long as it's affordable — see ACTIVATE_PAY_EFFIGY_COST_ABILITY,
  // actions.js). The colon right after the color word is what keeps this
  // from matching "Pay (N) Lifespan, Engage: X" (that shape has a comma
  // there, not a colon) — no explicit exclusion needed. Only recognized
  // when the captured word is a real Effigy color (EFFIGY_COLORS), so a
  // future "Pay (N) Lifespan: X" (no real card uses this shape today) falls
  // through unset rather than being misread as a color. "Burn" (Skeleton
  // Key: "Burn (2) Shifting: X") is the same real-Effigy-from-the-pool
  // cost, just a different printed verb — same mechanism either word.
  // Metal Worker: "Once per turn, you may Pay (1) Bleeding Essence: X" —
  // same bare Pay/Burn-costed ability, just with an optional "Once per
  // turn, you may " prefix (captured as `once`, gating it the same way
  // timesPerTurnAbility's own once-per-turn cap does — see
  // ACTIVATE_PAY_EFFIGY_COST_ABILITY, actions.js) and an optional trailing
  // "Essence" after the color word that Blooming Seed/Skeleton Key's own
  // plainer "Pay (N) <Color>:"/"Burn (N) <Color>:" phrasing doesn't print.
  const payEffigyCostMatch = text.match(/(?:^|\n)\s*(Once per turn,?\s*you may\s+)?(?:Pay|Burn)\s*\(?(\d+)\)?\s+(\w+)(?:\s+Essence)?:\s*(.+?)(?:\n|$)/i);
  const payEffigyCostAbility = payEffigyCostMatch && EFFIGY_COLORS.includes(payEffigyCostMatch[3].toLowerCase())
    ? { color: payEffigyCostMatch[3].toLowerCase(), amount: parseInt(payEffigyCostMatch[2], 10), effect: payEffigyCostMatch[4].trim(), once: !!payEffigyCostMatch[1] }
    : null;
  // Sha-KaRah: "Pay (5) Lifespan to move an adjacent Armament one tile in
  // any direction." — a bare, repeatable activated ability costed by real
  // Lifespan (not Engage/counters/Effigy — none of the shapes above), so it
  // needs its own capture. Phrased with "to <effect>" rather than a colon
  // (unlike payEffigyCostMatch's own "Pay (N) <Color>: X"), and never
  // collides with payLifespanEngageMatch above since that one requires a
  // literal "Engage" in the same clause.
  const payLifespanCostMatch = !payLifespanEngageMatch && text.match(/(?:^|\n)\s*Pay\s*\(?(\d+)\)?\s+Lifespan to\s+(.+?)(?:\n|$)/i);
  const payLifespanCostAbility = payLifespanCostMatch
    ? { amount: parseInt(payLifespanCostMatch[1], 10), effect: payLifespanCostMatch[2].trim() }
    : null;
  // AfterImage token: "When this Being has (0) Time Counters on it,
  // sacrifice it." — a generic self-sacrifice trigger tied to its own Time
  // Counters reaching 0, checked right after modulateOtherTimeCounters's own
  // automatic tick (turn.js). Any future card printing the same shape is
  // picked up the same way.
  const sacrificeAtZeroTimeCounters = /When this (?:Being )?has\s*\(?0\)?\s+Time Counters? on it,?\s*sacrifice it\.?/i.test(text);
  // Kalmahka: "Armaments you control are 3/1 Relic - Armaments with
  // 'Animated. Attached Being has +0/+0' and lose all other text." — a
  // live, continuously-recomputed full-card-identity rewrite of every
  // Armament the controller owns, sourced only from a face-up Prophecy
  // still holding Time Counters (see recomputeKalmahkaOverrides,
  // actions.js — same "read live off the board" source every other
  // board-wide aura in this file already uses).
  const armamentIdentityOverride = /Armaments you control are\s*\(?3\)?\/\(?1\)?\s+Relic\s*-?\s*Armaments? with\s*"?Animated\.?\s*Attached Being has\s*\+?0\/\+?0"?,?\s*and lose all other text/i.test(text);
  // "Remove (N) <Type> Counter(s): Sacrifice this, <effect>" (Blooming Seed:
  // "Remove (1) Growth Counter: Sacrifice this, summon (1) Blooming Vine
  // Token ... on any tile this points to.") — a Martyr-shaped ability (self-
  // sacrifice, then an effect) gated by a counter cost instead of Martyr's
  // usual unconditional availability, and with no Engage involved at all.
  // Distinct from counterCostEngageMatch above, which requires the literal
  // word "Engage" between the counter cost and the effect — this shape
  // requires "Sacrifice this" instead, so the two never collide. Generic
  // over the counter type and effect text, so any future card printing the
  // same shape (e.g. other Seed-family cards) is picked up automatically.
  const counterCostSacrificeMatch = text.match(/Remove\s*\(?(\d+)\)?\s+(\w+)\s+Counters?,?:?\s*Sacrifice this,?\s*(.+?)(?:\n|$)/i);
  const counterCostSacrificeAbility = counterCostSacrificeMatch
    ? { type: counterCostSacrificeMatch[2].toLowerCase(), amount: parseInt(counterCostSacrificeMatch[1], 10), effect: counterCostSacrificeMatch[3].trim() }
    : null;
  // Smithing Tools: "Engage a Being, Gain (1) Forge Counter." — a bare
  // repeatable activated ability whose cost is engaging a DIFFERENT Being
  // (same "Engage a Being" shape Strike the Ore's own Conjuring text
  // already uses, just repeatable off a permanent instead of resolved once
  // at cast), granting a counter to itself. Distinct from engageMatch/
  // engageExtraCostMatch above — neither matches this line (no colon
  // follows "Engage a Being,").
  const engageBeingGrantCounterMatch = text.match(/Engage an?\s+Being,\s*Gain\s*\(?(\d+)\)?\s+(\w+)\s+Counters?\.?/i);
  const engageBeingGrantCounter = engageBeingGrantCounterMatch
    ? { amount: parseInt(engageBeingGrantCounterMatch[1], 10), counterType: engageBeingGrantCounterMatch[2].toLowerCase() }
    : null;
  // Smithing Tools' own second line: "Engage, Remove (X) Forge Counters:
  // Add an Armament from deck to hand with conjuring cost (X)." — (X) is a
  // free choice bounded by however many counters are actually on it, unlike
  // counterCostEngageMatch above (a literal digit). Captured as its own
  // dedicated keyword rather than falling into the generic engage/
  // engageExtraCost capture above (which does also independently match this
  // same line, but can't resolve a variable-X counter removal — see
  // engageExtraCostSacrificeCell, actions.js — so it's simply never offered
  // as a button; this dedicated keyword is what actually drives play).
  const removeCountersXSearchArmamentMatch = text.match(/Engage,\s*Remove\s*\(?X\)?\s+(\w+)\s+Counters?:\s*Add an Armament from deck to hand with conjuring cost\s*\(?X\)?/i);
  const removeCountersXSearchArmament = removeCountersXSearchArmamentMatch
    ? { counterType: removeCountersXSearchArmamentMatch[1].toLowerCase() }
    : null;
  // Samara Seed / Seed of Divinity: "Remove (N) <Type> Counters, Martyr: X"
  // — martyrMatch above requires "Martyr" at the start of a line, which
  // this cost prefix on the same line breaks; same shape as
  // counterCostSacrificeMatch above, just "Martyr" instead of "Sacrifice
  // this" (Martyr's own engage-then-sacrifice already covers the
  // sacrifice, so no separate "Sacrifice this" phrase is printed).
  const counterCostMartyrMatch = text.match(/Remove\s*\(?(\d+)\)?\s+(\w+)\s+Counters?,?:?\s*Mar?tyr,?:?\s*(.+?)(?:\n|$)/i);
  const martyrCounterCost = counterCostMartyrMatch
    ? { type: counterCostMartyrMatch[2].toLowerCase(), amount: parseInt(counterCostMartyrMatch[1], 10) }
    : null;
  // Melting Clock: "Pay (N) <Color> Essence, Martyr: X" — same idea as
  // counterCostMartyrMatch above, but costed by paying real Effigy out of
  // the pool instead of spending the card's own Counters (same shape
  // payEffigyCostMatch already uses for a bare "Pay (N) Color: X" ability,
  // just with "Martyr" as the actual trigger word instead of a colon).
  const payEffigyCostMartyrMatch = text.match(/Pay\s*\(?(\d+)\)?\s+(\w+)\s+Essence,?:?\s*Mar?tyr,?:?\s*(.+?)(?:\n|$)/i);
  const martyrEffigyCost = payEffigyCostMartyrMatch && EFFIGY_COLORS.includes(payEffigyCostMartyrMatch[2].toLowerCase())
    ? { color: payEffigyCostMartyrMatch[2].toLowerCase(), amount: parseInt(payEffigyCostMartyrMatch[1], 10) }
    : null;
  // "Twice per turn Modulate (±1)." (MetaToris) — a bare, uncosted
  // activated ability (no "Engage:", no extra cost) usable up to a fixed
  // number of times per turn. Captures the whole remainder as its own
  // effect text, generic over whatever it says rather than hardcoded to
  // Modulate specifically, so it's reusable if another card ever prints
  // the same "N times per turn X" shape. Excludes prophecyCounterMatch
  // above (Eònion Zealot: "Once per turn when a Time Counter is removed
  // from a Prophecy you control, add Essence") — that "Once per turn" is
  // a soft-once-per-turn *reaction condition* on an automatic trigger, not
  // an activated ability the player chooses to use, and would otherwise
  // false-positive here (bare "Once per turn X" matches both shapes),
  // wrongly offering an "Activate" button for a purely passive card. Also
  // excludes reanimateFromPurgatoryMatch above (Roots of Eternity: "Once
  // per turn you may sacrifice a Vine token, summon this from Purgatory
  // on the tile that the sacrificed vine token was on") — that card's own
  // dedicated keyword/reducer path (ACTIVATE_REANIMATE_FROM_PURGATORY)
  // already handles it fully; without this exclusion the SAME text also
  // populated the generic timesPerTurnAbility field, which — unlike the
  // dedicated path — is only ever readable while the card is still ON THE
  // BOARD (not yet in Purgatory), offering a second, broken
  // ACTIVATE_TIMES_PER_TURN_ABILITY button that always fell through to
  // resolveOrLogEffect's "isn't automated yet" fallback.
  const TIMES_WORDS = { once: 1, twice: 2, thrice: 3 };
  const timesPerTurnMatch = !prophecyCounterMatch && !reanimateFromPurgatoryMatch
    && text.match(/(?:^|\n)\s*(Once|Twice|Thrice)\s+per\s+turn\s+(.+?)(?:\n|$)/i);
  // "You do not draw during the start of your turn" (Daylight Savings) —
  // an ongoing effect that applies for as long as a face-up Prophecy with
  // this text sits on the board with at least 1 Time Counter left (RULES.md
  // > Prophecies), not a one-time action — so it's read live off the board
  // by drawStep (turn.js) rather than resolved through resolveOrLogEffect,
  // and deliberately excluded from the per-line flip-resolution loop
  // (turn.js > resolveProphecyModulateHitZero) so it doesn't also log an
  // honest-but-noisy "isn't automated yet" every time this flips.
  const skipsControllerDraw = /do not draw during the start of your turn/i.test(text);
  // "(X) is equal to the total number of Time Counters you control"
  // (Horological Horror) — a characteristic-defining Strength/Lifespan,
  // computed once at summon (same "snapshot, not continuously recomputed"
  // precedent as Thespian's own stat-copy) rather than tracked live for the
  // rest of the Being's life — see totalTimeCountersControlledBy, actions.js.
  const xEqualsTimeCountersControlled = /\(X\) is equal to the total number of Time Counters you control/i.test(text);
  // "has -X/-X where X equals the number of Time Counters that you control"
  // (Singularity) — unlike xEqualsTimeCountersControlled above, this is a
  // subtractive penalty on top of the card's own printed Strength/Lifespan,
  // not an absolute replacement value — see recomputeXBeings, actions.js.
  const statPenaltyEqualsTimeCountersControlled = /has -X\/-X where X equals the number of Time Counters that you control/i.test(text);
  // "Gains +0/+3 if you control a Turanaga other than Darmah-Triya." — a
  // live, continuously-checked conditional bonus (RULES.md > Keywords: the
  // same "recomputed after every action" treatment as Horological Horror's
  // own X), not a one-time trigger. Deliberately does NOT capture the
  // printed typing word itself — the real CSV typos it ("Turanaga" instead
  // of "Turanga"), which would silently never match any other card's real
  // typing if stored literally — the ability is really just "another Being
  // sharing my own typing", so recomputeConditionalBonuses (actions.js)
  // derives the typing to check from the occupant's own card.typing at
  // evaluation time instead of from this regex.
  const otherSameTypingMatch = ownNameRe && text.match(new RegExp(
    `Gains?\\s*\\+?(\\d+)\\/\\+?(\\d+) if you control an?\\s+[\\w-]+\\s+other than ${ownNameRe}`, 'i'
  ));
  // "While you control an Imp, Cat, and a Rat, Menagerie Mistress has
  // +3/+6." — a live conditional bonus gated on controlling at least one of
  // EACH typing in a printed list, keyed to the card's own name (like
  // onOwnBeingDiedMatch above) since it names itself rather than saying
  // "this". The captured typing list is free text ("an Imp, Cat, and a
  // Rat") split on commas/"and" and stripped of its articles by
  // parseTypingList below.
  const allTypingsMatch = ownNameRe && text.match(new RegExp(
    `While you control (.+?),\\s+${ownNameRe} has\\s*\\+?(\\d+)\\/\\+?(\\d+)`, 'i'
  ));
  const parseTypingList = (raw) => raw
    .split(/,|\band\b/i)
    .map(s => s.trim().replace(/^an?\s+/i, ''))
    .filter(Boolean);
  // "This has +1/+1 for each other Rat you have in play." (Mischief of
  // Rats) — a live per-count bonus, same recompute treatment as the two
  // above, just scaling with how many OTHER Beings of the named typing the
  // controller has (excluding the card itself, even though it shares that
  // typing).
  const perOtherTypingMatch = text.match(/This has\s*\+?(\d+)\/\+?(\d+) for each other\s+([\w-]+) you have in play/i);
  // "Has (+1) Lifespan for each Non Armament Relic you control." (Temple
  // Guardian) — a live per-count Lifespan-only bonus (no Strength half),
  // counting real standalone Relics (RULES.md's own "Relic" card type) but
  // not an Armament acting as one while attached.
  const perNonArmamentRelicLifespanMatch = text.match(/Has\s*\(?\+?(\d+)\)?\s+Lifespan for each Non Armament Relic you control/i);
  // "Beings you control have +1/+0, if any of those beings are TreeFolk,
  // they gain +2/+0 instead." (Growth Spurt) / "Beings you control have
  // +1/+1." (Blooming Life token) — a live, continuously-recomputed
  // board-wide aura granted to every Being the SAME controller owns (not
  // "this" self-referentially, unlike otherSameTypingMatch/allTypingsMatch
  // above), for as long as its own source (a face-up Prophecy with Time
  // Counters left) stays on the board — see
  // recomputeBoardWideAuraBonuses/boardWideAuraBonusTarget, actions.js. The
  // typing-conditional override clause is optional — most cards printing
  // this shape (the tokens) don't have one.
  const boardWideAllyBonusMatch = text.match(
    /Beings you control have\s*\+?(\d+)\/\+?(\d+)(?:,\s*if any of those beings are\s+(\w+),\s*they gain\s*\+?(\d+)\/\+?(\d+) instead)?\.?/i
  );
  // "Beings you don't control have -1/-1." (Withering Life token) — same
  // live board-wide-aura shape as boardWideAllyBonusMatch above, just
  // applied to the SOURCE's controller's OPPONENT's Beings instead of
  // their own.
  const boardWideEnemyBonusMatch = text.match(/Beings you don'?t control have\s*-(\d+)\/-(\d+)\.?/i);
  // "During Combat if the opposing Being is not Faithless it has (-1)
  // Strength." (Fidian Nol) — a combat-time-only penalty to whichever
  // Being it fights (not a persisted stat change), skipped when that
  // opponent has no colored casting cost at all (isFaithlessTypedCard,
  // this file) — see combat.js's own combatOpponentStrengthPenalty.
  const combatOpponentStrengthPenaltyMatch = text.match(
    /During Combat if the opposing Being is not Faithless it has\s*\(?-(\d+)\)?\s+Strength/i
  );
  // "This gains +1/+1 whenever you Modulate (±1) except due to the
  // Modulate Step" (Temporal Anomaly) — a real permanent growth reaction,
  // same shape as onLifespanPaidGrowth/onOwnBeingDiedGrowth, fired only by
  // a player-activated Modulate (RESOLVE_MODULATE, actions.js), never by
  // the automatic per-turn Modulate Step tick (turn.js) — which is exactly
  // what "except due to the Modulate Step" carves out, since that
  // automatic tick never goes through RESOLVE_MODULATE at all.
  const onModulateGrowthMatch = text.match(/This gains\s*\+?(\d+)\/\+?(\d+) whenever you Modulate\s*\(±1\) except due to the Modulate Step/i);
  // Time Capsule: "Whenever you Modulate (-1) except due to the Modulate
  // Step, add (1) Time Counter to this." — same "except due to the
  // Modulate Step" trigger shape as onModulateGrowth above, but scoped to
  // Modulate(-1) specifically (not any Modulate) and granting itself a
  // Counter instead of stat growth.
  const onModulateMinusOneAddCounterMatch = text.match(/Whenever you Modulate\s*\(-1\) except due to the Modulate Step,?\s*add\s*\(?(\d+)\)?\s+Time Counters? to this/i);
  // Blood Moon: "Whenever a Being dies it's controller gives a different
  // target Being +1/+1." — passive, board-wide (no "you control" on the
  // trigger — reacts to any death, either side), read live off Blood
  // Moon's own face-up Prophecy occupant the same way Daylight Savings'
  // skip-draw already is (see triggerAnyBeingDiedGiveDifferentBuff,
  // actions.js), not a one-time flip effect.
  const onAnyBeingDiedGiveDifferentBuffMatch = text.match(/Whenever a Being dies,?\s*it'?s controller gives a different target Being\s*\+?(\d+)\/\+?(\d+)/i);
  // "At the end of your turn gain +1/+1 for each other Doubt you control."
  // (Lingering Doubt) — "Doubt" here isn't a printed typing word (neither
  // Lingering Doubt nor Passing Doubt is typed "Doubt" — both are "Null,
  // Being"), it's shorthand for "a card whose name contains Doubt", same
  // family-by-name-substring pattern as Skeletal Colossus' own "Bag o'
  // Bones" count. A real, permanent stat gain applied once at end of turn
  // (turn.js), not a live continuously-recomputed aura like Mischief of
  // Rats' near-identical wording — RULES.md's Down Tick Step is a discrete
  // moment, not something re-checked all game long.
  const endOfTurnGrowthPerNameMatch = text.match(/At the end of your turn gain\s*\+?(\d+)\/\+?(\d+) for each other\s+(.+?)\s+you control/i);
  // Passing Doubt: "At the end of your turn target Doubt you control is
  // dealt (1) Lifespan Damage" — "Doubt" is the same name-family reference
  // endOfTurnGrowthPerName already uses (Lingering Doubt / Passing Doubt),
  // not a printed typing word.
  const endOfTurnDamageNamedFamilyMatch = text.match(/At the end of your turn target\s+(\w+)\s+you control is dealt\s*\(?(\d+)\)?\s+Lifespan Damage/i);
  // "At the start of your turn move forward.\nAt the end of your turn move
  // backward." (Minute-taur) — a forced, unconditional move (no "may", not
  // gated by Engage/tap), not a player choice — see
  // applyForcedDirectionalMoves, turn.js. "Forward"/"backward" are
  // literally Minute-taur's own printed Arrows 1 and 5 (RULES.md's own
  // numbering: 1 = straight ahead, 5 = straight back), already
  // player-relative via computeMoveDestination (board.js), so this is
  // genuinely just "move in direction 1" / "move in direction 5" — no new
  // direction-mapping needed.
  const moveForwardAtTurnStart = /At the start of your turn move forward/i.test(text);
  const moveBackwardAtTurnEnd = /At the end of your turn move backward/i.test(text);
  // "Costs (-N) <Color> for each <Name> you control" (Skeletal Colossus:
  // "Costs (-1) Faithless for each Bag o' Bones you control.") — a static
  // cost modifier checked at the point a card is cast/summoned, not an
  // effect resolved through resolveOrLogEffect. Captured by name generically
  // (not hardcoded to Bag o' Bones) so any future card phrased the same way
  // is picked up automatically; the color name is normalized to lowercase to
  // match `castingCost`'s own field names (`faithless` or a colored key).
  // The optional "that " (Singularity: "for each Time Counter that you
  // control") covers the one real card phrased with it; effectiveCastingCost
  // (actions.js) special-cases a captured name of "Time Counter" to sum the
  // live Time-Counter total instead of counting occurrences of a card name.
  const costReductionMatch = text.match(/Costs\s*\(?-(\d+)\)?\s+(\w+)\s+for each\s+(.+?)\s+(?:that )?you control/i);

  // Deja Vu: "Return target Being that you control with cost (X) to your
  // hand, then Summon it without paying its summoning cost" — X here is
  // NOT a separate filter number, it's the card's own printed "X" casting
  // cost pip (see toGameCard's xCostColor), read back off the target Being
  // (totalCastingCost) per the user's own ruling. Kept as one dedicated
  // whole-card flag (matching Unruly/Dryad/Shift's own precedent for a
  // mechanic this specific) rather than a generic pattern, since no other
  // card in the set reprices itself off a dynamically-chosen target's cost.
  const dejaVuMatch = /(?:^|\n)\s*Return target Being that you control with cost\s*\(?X\)?\s+to your hand,?\s*then Summon it without paying its summoning cost/i.test(text);
  // The card's own separate line: targeting a Deity costs (N) additional
  // Essence of the given color — read as a surcharge added on top of the
  // combined cost computed for the dejaVu branch above.
  const dejaVuDeitySurchargeMatch = text.match(/(?:^|\n)\s*Pay\s*\(?(\d+)\)?\s+additional\s+(\w+)\s+Essence to target a Deity/i);

  const engageEffectText = payLifespanEngageMatch ? payLifespanEngageMatch[2]
    : payEffigyEngageMatch ? payEffigyEngageMatch[3]
    : conditionalEngageMatch ? conditionalEngageMatch[2]
    : engageExtraCostMatch ? engageExtraCostMatch[2]
    : counterCostEngageMatch ? counterCostEngageMatch[3]
    : engageMatch ? engageMatch[1] : null;

  return {
    animated: /(?:^|\n)\s*Animated\b/i.test(text),
    dryad: /(?:^|\n)\s*Dryad\b/i.test(text),
    persist: /(?:^|\n)\s*Persist\b/i.test(text),
    favored: /(?:^|\n)\s*Favored\b/i.test(text),
    invoke: /(?:^|\n)\s*Invoke\b/i.test(text),
    // Unruly: "Whenever this Being attacks, lose Lifespan equal to its
    // current Strength." — packaged as a real, reusable keyword at the
    // user's own request (for future cards to print the bare word
    // directly, same as Dryad/Persist/Favored/Invoke above), even though
    // Unruly Fiend's own real printed text spells it out with its own
    // name instead of the keyword itself: "When Unruly Fiend attacks you
    // lose (X) Lifespan where (X) is it's current strength" (kept
    // verbatim on the card — this only affects what gets parsed OUT of
    // it, not what's printed). See resolveAttackFrom, actions.js.
    unruly: /(?:^|\n)\s*Unruly\b/i.test(text)
      || (!!ownNameRe && new RegExp(`When ${ownNameRe} attacks,?\\s*you lose\\s*\\(?X\\)?\\s+Lifespan where\\s*\\(?X\\)?\\s+is it'?s current strength`, 'i').test(text)),
    depart: departMatch ? departMatch[1].trim() : null,
    martyr: martyrMatch ? martyrMatch[1].trim()
      : counterCostMartyrMatch ? counterCostMartyrMatch[3].trim()
      : payEffigyCostMartyrMatch ? payEffigyCostMartyrMatch[3].trim()
      : null,
    martyrCounterCost,
    martyrEffigyCost,
    whenSummoned: whenSummonedMatch ? whenSummonedMatch[1].trim() : null,
    whenConjureProphecy: whenConjureProphecyMatch ? whenConjureProphecyMatch[1].trim() : null,
    whenConjuredEnterUpTo: whenConjuredEnterUpToMatch ? parseInt(whenConjuredEnterUpToMatch[1], 10) : null,
    onMove: onMoveMatch ? onMoveMatch[1].trim() : null,
    onDryadAttachedOnto: onDryadAttachedOntoMatch ? onDryadAttachedOntoMatch[1].trim() : null,
    engage: engageEffectText ? engageEffectText.trim() : null,
    engageLifespanCost,
    engageEffigyCost,
    engageCondition,
    engageExtraCost,
    engageCounterCost,
    engageAbilities,
    shift: shiftMatch ? { amount: parseInt(shiftMatch[1], 10), effect: shiftMatch[2] ? shiftMatch[2].trim() : null } : null,
    onMovedIntoMortalRealm: onMovedIntoMortalRealmMatch ? onMovedIntoMortalRealmMatch[1].trim() : null,
    endOfTurnRemoveOwnTimeCounters: endOfTurnRemoveOwnTimeCountersMatch
      ? parseInt(endOfTurnRemoveOwnTimeCountersMatch[1] || endOfTurnRemoveOwnTimeCountersMatch[2], 10)
      : null,
    duringEndStepForceShift: duringEndStepForceShiftMatch ? parseInt(duringEndStepForceShiftMatch[1], 10) : null,
    duringEndStepLoseTimeCounters: duringEndStepLoseTimeCountersMatch ? parseInt(duringEndStepLoseTimeCountersMatch[1], 10) : null,
    onDealsCombatDamageForceShift: onDealsCombatDamageForceShiftMatch ? parseInt(onDealsCombatDamageForceShiftMatch[1], 10) : null,
    onAnyBeingDiedMayShiftInstead: onAnyBeingDiedMayShiftInsteadMatch ? parseInt(onAnyBeingDiedMayShiftInsteadMatch[1], 10) : null,
    craftBonus: craftBonusMatch ? parseInt(craftBonusMatch[1], 10) : null,
    craftBonusCondition: craftBonusFaithlessOnly ? 'faithless-only' : craftBonusZeroTimeCounters ? 'zero-time-counters' : null,
    conjureCost: conjureCostMatch ? conjureCostMatch[1].trim() : null,
    statBonus: statBonusMatch ? { strength: parseInt(statBonusMatch[1], 10), lifespan: parseInt(statBonusMatch[2], 10) } : null,
    grantedEngage,
    armamentCounterGrant: armamentCounterMatch
      ? { type: armamentCounterMatch[2].toLowerCase(), amount: parseInt(armamentCounterMatch[1], 10) }
      : null,
    sacrificeForFavored,
    onProphecyCounterRemoved: prophecyCounterMatch
      ? { type: prophecyCounterMatch[2].toLowerCase(), amount: parseInt(prophecyCounterMatch[1], 10) }
      : null,
    collectsRemovedProphecyTimeCounters,
    gathersArmamentsOnSummon,
    movesToNewlySummonedBeing,
    onTypedSummonedUnderControl: onTypedSummonedMatch
      ? { typing: onTypedSummonedMatch[1].trim(), effect: onTypedSummonedMatch[2].trim() }
      : null,
    sacrificeSelfOnSummonTyping: sacrificeSelfOnSummonTypingMatch ? sacrificeSelfOnSummonTypingMatch[1].trim() : null,
    costReduction: costReductionMatch
      ? { amount: parseInt(costReductionMatch[1], 10), color: costReductionMatch[2].toLowerCase(), name: costReductionMatch[3].trim() }
      : null,
    beingsMayMoveAcross,
    cannotAttack,
    cannotMove,
    neverAutoDisengages,
    sacrificeIfEngagedAtEndOfTurn,
    onOwnMartyrTyped: onOwnMartyrTypedMatch
      ? { typing: onOwnMartyrTypedMatch[1].trim(), effect: onOwnMartyrTypedMatch[2].trim() }
      : null,
    onRevealedTopOfDeck: onRevealedTopOfDeckMatch ? onRevealedTopOfDeckMatch[1].trim() : null,
    onLifespanPaidGrowth: onLifespanPaidMatch
      ? { strength: parseInt(onLifespanPaidMatch[1], 10), lifespan: parseInt(onLifespanPaidMatch[2], 10) }
      : null,
    reanimateOnSacrificedTypedToken: reanimateFromPurgatoryMatch
      ? { typing: reanimateFromPurgatoryMatch[1].trim() }
      : null,
    statBonusPerOwnDeathThisTurn: statBonusPerOwnDeathMatch
      ? { strength: parseInt(statBonusPerOwnDeathMatch[1], 10), lifespan: parseInt(statBonusPerOwnDeathMatch[2], 10) }
      : null,
    downTickLifespanReduction: downTickLifespanReductionMatch ? parseInt(downTickLifespanReductionMatch[1], 10) : null,
    onOwnBeingDiedGrowth: onOwnBeingDiedMatch
      ? { strength: parseInt(onOwnBeingDiedMatch[1], 10), lifespan: parseInt(onOwnBeingDiedMatch[2], 10) }
      : null,
    onAllyFights: onAllyFightsMatch
      ? { strength: parseInt(onAllyFightsMatch[1], 10), lifespan: parseInt(onAllyFightsMatch[2], 10) }
      : null,
    onOwnBeingShift: onOwnBeingShiftWheneverFirst
      ? { effect: onOwnBeingShiftWheneverFirst[2].trim(), exceptEndStep: !!onOwnBeingShiftWheneverFirst[1] }
      : onOwnBeingShiftEffectFirst
        ? { effect: onOwnBeingShiftEffectFirst[1].trim(), exceptEndStep: false }
        : null,
    sacrificeXSummon: sacrificeXSummonMatch ? { fodderName: sacrificeXSummonMatch[1].trim() } : null,
    gainCounterOnAnyBeingDeath: gainCounterOnAnyDeathMatch
      ? { type: gainCounterOnAnyDeathMatch[2].toLowerCase(), amount: parseInt(gainCounterOnAnyDeathMatch[1], 10) }
      : null,
    deckSearchOnTypedDeath,
    removeCountersSacrificeSearchTypedCost: removeCountersSacrificeSearchMatch
      ? { counterType: removeCountersSacrificeSearchMatch[1].toLowerCase(), typing: removeCountersSacrificeSearchMatch[2] }
      : null,
    removeCountersEngageRestoreLifespan: removeCountersEngageRestoreMatch
      ? { counterType: removeCountersEngageRestoreMatch[1].toLowerCase() }
      : null,
    craftEffigyOnPointedRelicConjure: craftEffigyOnPointedRelicConjureMatch
      ? { amount: /^\d+$/.test(craftEffigyOnPointedRelicConjureMatch[1]) ? parseInt(craftEffigyOnPointedRelicConjureMatch[1], 10) : 1 }
      : null,
    seedActivationCostReduction: seedActivationCostReductionMatch
      ? { typing: seedActivationCostReductionMatch[1].trim(), amount: parseInt(seedActivationCostReductionMatch[2], 10), color: seedActivationCostReductionMatch[3].toLowerCase() }
      : null,
    preventOpenLaneDamageCraftEffigy: preventOpenLaneDamageCraftEffigyMatch,
    onOwnBeingDiedGainTextBox: onOwnBeingDiedGainTextBoxMatch,
    payEffigyCostAbility,
    counterCostSacrificeAbility,
    engageBeingGrantCounter,
    removeCountersXSearchArmament,
    allCardsCostReduction,
    payLifespanCostAbility,
    sacrificeAtZeroTimeCounters,
    armamentIdentityOverride,
    timesPerTurnAbility: timesPerTurnMatch
      ? { times: TIMES_WORDS[timesPerTurnMatch[1].toLowerCase()], effect: timesPerTurnMatch[2].trim() }
      : null,
    skipsControllerDraw,
    xEqualsTimeCountersControlled,
    statPenaltyEqualsTimeCountersControlled,
    otherSameTypingBonus: otherSameTypingMatch
      ? { strength: parseInt(otherSameTypingMatch[1], 10), lifespan: parseInt(otherSameTypingMatch[2], 10) }
      : null,
    allTypingsBonus: allTypingsMatch
      ? { typings: parseTypingList(allTypingsMatch[1]), strength: parseInt(allTypingsMatch[2], 10), lifespan: parseInt(allTypingsMatch[3], 10) }
      : null,
    perOtherTypingBonus: perOtherTypingMatch
      ? { typing: perOtherTypingMatch[3], strength: parseInt(perOtherTypingMatch[1], 10), lifespan: parseInt(perOtherTypingMatch[2], 10) }
      : null,
    perNonArmamentRelicLifespan: perNonArmamentRelicLifespanMatch ? parseInt(perNonArmamentRelicLifespanMatch[1], 10) : null,
    boardWideAllyBonus: boardWideAllyBonusMatch
      ? {
          strength: parseInt(boardWideAllyBonusMatch[1], 10), lifespan: parseInt(boardWideAllyBonusMatch[2], 10),
          condTyping: boardWideAllyBonusMatch[3] || null,
          condStrength: boardWideAllyBonusMatch[3] ? parseInt(boardWideAllyBonusMatch[4], 10) : null,
          condLifespan: boardWideAllyBonusMatch[3] ? parseInt(boardWideAllyBonusMatch[5], 10) : null,
        }
      : null,
    boardWideEnemyBonus: boardWideEnemyBonusMatch
      ? { strength: -parseInt(boardWideEnemyBonusMatch[1], 10), lifespan: -parseInt(boardWideEnemyBonusMatch[2], 10) }
      : null,
    combatOpponentStrengthPenaltyIfNotFaithless: combatOpponentStrengthPenaltyMatch ? parseInt(combatOpponentStrengthPenaltyMatch[1], 10) : null,
    onModulateGrowth: onModulateGrowthMatch
      ? { strength: parseInt(onModulateGrowthMatch[1], 10), lifespan: parseInt(onModulateGrowthMatch[2], 10) }
      : null,
    endOfTurnGrowthPerName: endOfTurnGrowthPerNameMatch
      ? { strength: parseInt(endOfTurnGrowthPerNameMatch[1], 10), lifespan: parseInt(endOfTurnGrowthPerNameMatch[2], 10), namePart: endOfTurnGrowthPerNameMatch[3].trim() }
      : null,
    moveForwardAtTurnStart,
    moveBackwardAtTurnEnd,
    dejaVu: dejaVuMatch,
    dejaVuDeitySurcharge: dejaVuDeitySurchargeMatch
      ? { amount: parseInt(dejaVuDeitySurchargeMatch[1], 10), color: dejaVuDeitySurchargeMatch[2].toLowerCase() }
      : null,
    additionalSummonCostSacrificeBeings: additionalSummonCostSacrificeBeingsMatch
      ? parseInt(additionalSummonCostSacrificeBeingsMatch[1], 10)
      : null,
    onAttachedBeingDied: onAttachedBeingDiedMatch ? onAttachedBeingDiedMatch[1].trim() : null,
    onConjure: onConjureMatch
      ? { type: onConjureMatch[2].toLowerCase(), amount: parseInt(onConjureMatch[1], 10) }
      : null,
    alternateSummonAsProphecy: alternateSummonProphecyMatch
      ? { color: alternateSummonProphecyMatch[2].toLowerCase(), extraAmount: parseInt(alternateSummonProphecyMatch[1], 10), timeCounters: parseInt(alternateSummonProphecyMatch[3], 10) }
      : null,
    grantedMartyr,
    endOfTurnLoseLifespanEqualToCoLocatedBeing,
    searchDeckArmamentCostX,
    endOfTurnDamageNamedFamily: endOfTurnDamageNamedFamilyMatch
      ? { namePart: endOfTurnDamageNamedFamilyMatch[1].trim(), amount: parseInt(endOfTurnDamageNamedFamilyMatch[2], 10) }
      : null,
    onModulateMinusOneAddCounter: onModulateMinusOneAddCounterMatch ? parseInt(onModulateMinusOneAddCounterMatch[1], 10) : null,
    onAnyBeingDiedGiveDifferentBuff: onAnyBeingDiedGiveDifferentBuffMatch
      ? { strength: parseInt(onAnyBeingDiedGiveDifferentBuffMatch[1], 10), lifespan: parseInt(onAnyBeingDiedGiveDifferentBuffMatch[2], 10) }
      : null,
  };
};

// Maps a raw CSV row into a structured, game-ready card definition. Doesn't
// mutate the row — safe to call repeatedly for the same card.
export const toGameCard = (card, idx) => {
  // Trimmed once here, at the parse boundary, rather than in every
  // downstream consumer — a stray leading/trailing space in the CSV's own
  // "Card Name" column (real example: "Locust swarm " — confirmed via the
  // real CSV row) otherwise survives into `.name` untouched and silently
  // breaks anything doing exact-string name matching against it:
  // selfReferentialWhenSummonedText's own "this"-substitution (actions.js)
  // swallows that trailing space along with the matched name, turning
  // "Locust Swarm Shifts (3)." into "thisShifts (3)." — no space — which
  // no longer matches SELF_SHIFT_RE, so Locust Swarm's own printed Depart
  // silently no-ops instead of Shifting. Purgatory name lookups
  // (`player.purgatory.find(c => c.name === cardName)`), the legend-rule
  // dedup, and deck-list name matching would all have the exact same
  // failure mode for any other card sharing this CSV quirk.
  const name = (getColumnData(card, ['Card Name', 'A', 'Column A']) || `Card ${idx + 1}`).trim();
  const kind = getCardKind(card);
  const typing = (getColumnData(card, ['Card Typing', 'Card typing']) || '');
  const isToken = typing.toLowerCase().includes('token');
  const costRaw = card['Effigy Costs'] || card['effigy costs'] || card['Effigy Cost'] || card['C'] || card['Column C'] || '';
  const costParts = parseEffigyCost(costRaw);
  const colored = {};
  let faithless = 0;
  // An "X" pip (Deja Vu: "X, 2 Timeless"; Blood Rites: "X, Bleeding")
  // contributes nothing to the printed base cost — its real amount is
  // determined at cast time by whatever effect reads it (Deja Vu: the
  // target's own total cost, RULES.md's ruling). `xCostColor` records
  // WHICH slot carried the X ('' for a generic/faithless X, a color name
  // otherwise) so that effect can find it; null when a card has none.
  let xCostColor = null;
  costParts.forEach(part => {
    const isFaithless = part.type === 'faithless' || part.type === '';
    if (part.number === 'X') {
      xCostColor = isFaithless ? '' : part.type;
      return;
    }
    const value = toNumber(part.number);
    if (isFaithless) {
      faithless += value;
    } else {
      colored[part.type] = (colored[part.type] || 0) + value;
    }
  });

  return {
    id: `${name}__${idx}`,
    sourceIndex: idx,
    name,
    kind,
    typing,
    isDeity: kind === 'deity',
    // A "Relic, Being" (RULES.md > Card types) — full Being mechanics
    // (kind: 'being', above) but placed like a Relic: any Mortal Realm
    // cell instead of just the home-row summon cells, and enters
    // disengaged instead of summoning-sick (SUMMON_BEING, actions.js).
    isRelicBeing: kind === 'being' && typing.toLowerCase().includes('relic'),
    isToken,
    rarity: getColumnData(card, ['Rarity', 'rarity']),
    effigyType: getColumnData(card, ['Effigy type', 'Effigy Type', 'K', 'Column K']).toLowerCase(),
    castingCost: { faithless, colored, ...(xCostColor != null ? { xCostColor } : {}) },
    strength: toNumber(getColumnData(card, ['Strength', 'F', 'Column F'])),
    lifespan: toNumber(getColumnData(card, ['Lifespan', 'G', 'Column G'])),
    timerMax: toNumber(getColumnData(card, ['Timer', 'H', 'Column H'])),
    arrows: parseArrows(getColumnData(card, ['Arrows (Clockwise top center = 1)', 'Arrows (Clockwise top center = 1', 'Arrows', 'I', 'Column I'])),
    textBox: getColumnData(card, ['Text Box', 'E', 'Column E']),
    keywords: parseKeywords(getColumnData(card, ['Text Box', 'E', 'Column E']), name),
    raw: card,
  };
};

// Builds a fresh, game-ready token card on demand — for "summon a/an <Name>
// token" effects (e.g. Cobra's Depart: "Summon a Snake Skin token on this
// tile."), which need a real playable card object that was never a row in
// the user's CSV. Reuses `toGameCard` against a synthetic raw row shaped
// exactly like a real CSV row (same column names), so a token gets
// identical treatment to a printed card — its own `keywords` are parsed
// from `textBox` the same way, its border/typing resolve the same way, etc.
// `typing` should include "Token" (matching the real CSV's own convention,
// e.g. "Relic, Token") — not required for correctness (this always sets
// `isToken: true` explicitly regardless) but keeps the synthetic row
// consistent with what a real token row looks like.
let tokenInstanceCounter = 0;
export const createTokenCard = ({ name, typing, strength = 0, lifespan = 0, effigyCost = '', textBox = '', timer = 0, arrows = '' }) => {
  const raw = {
    'Card Name': name,
    'Card Typing': typing,
    'Effigy Costs': effigyCost,
    'Text Box': textBox,
    'Strength': String(strength),
    'Lifespan': String(lifespan),
    'Timer': String(timer),
    'Arrows (Clockwise top center = 1)': arrows,
    'Set': '',
    'Effigy type': '',
    'Rarity': 'Token',
    'Watch': '',
  };
  const card = toGameCard(raw, -1);
  const instanceId = `token-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}#${tokenInstanceCounter++}`;
  return { ...card, isToken: true, instanceId };
};

// Hand-rolled, quote-aware CSV parser (no external dependency) — the exact
// algorithm the Generator has always used, extracted so the Game parses any
// CSV the same way.
export const parseCSV = (text) => {
  const lines = [];
  let currentLine = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === '"') {
      inQuotes = !inQuotes;
      currentLine += char;
    } else if (char === '\n' && !inQuotes) {
      if (currentLine.trim()) {
        lines.push(currentLine);
      }
      currentLine = '';
    } else {
      currentLine += char;
    }
  }
  if (currentLine.trim()) {
    lines.push(currentLine);
  }

  const parseLine = (line) => {
    const result = [];
    let current = '';
    let inQ = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        // RFC4180 escaping: a doubled quote INSIDE an already-open quoted
        // field is a literal `"` in the value (e.g. Scā-vuhk Hunger's own
        // Shift text prints `Shift (1): ""At the end...""` in the raw CSV
        // for a literal `Shift (1): "At the end..."`) — collapse the pair
        // into one literal quote and consume both characters, rather than
        // just toggling inQ twice and silently dropping both (which used
        // to strip every embedded quote mark from the field, breaking any
        // regex downstream that requires them, e.g. cardData.js's own
        // shiftMatch).
        if (inQ && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQ = !inQ;
        }
      } else if (char === ',' && !inQ) {
        let value = current.trim();
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        result.push(value);
        current = '';
      } else {
        current += char;
      }
    }
    let value = current.trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    result.push(value);
    return result;
  };

  if (lines.length === 0) return [];

  const headers = parseLine(lines[0]);
  const data = [];

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const values = parseLine(lines[i]);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });
    data.push(row);
  }

  return data;
};
