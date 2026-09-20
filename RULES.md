# Game Rules Spec (draft)

This is the working ruleset for the custom TCG built alongside the Trading Card
Generator. It's derived from the card CSV schema already used by the generator
(Casting Cost, Strength, Lifespan, Timer, Arrows, Card Typing, Effigy Type,
Rarity) plus design decisions made in conversation. Sections marked
**[ASSUMPTION]** are calls made to keep scope moving — flag any that are wrong.
Sections marked **[OPEN]** are unresolved and need an answer before that part
of the engine is built.

## Zones (per player, mirrored)

- **Main Deck** — 40 cards. Max 3 copies of any card, except Deities (max 2).
  Sits off-grid, player's right side.
- **Purgatory** (graveyard) — off-grid, sits directly in front of the Main
  Deck. Any card that resolves, dies, or is destroyed goes here unless the
  card states otherwise (Beings on death, resolved Prophecies, used
  Conjurings, destroyed Relics/Altars — all of it).
- **Hand** — starts at 5 cards (opening hand), refilled by the draw step.
- **Board** — 5×5 grid, shared:
  - Row 1: Player A home row.
  - Row 2: Player A front row.
  - Row 3: **Ethereal Realm** — Prophecies only, face-down, no Beings/combat.
    Which of its 5 cells a Prophecy is played into is the **player's own
    choice** (`PLAY_PROPHECY` offers one legal action per empty Ethereal
    cell, same as any other card-placement action) — this matters for real
    once a Prophecy resolves, since its own arrows then target specific
    Mortal Realm tiles relative to *which* Ethereal cell it was sitting in
    (see Combat > Prophecy orientation, and Al khali the Empty under
    Keywords > Token creation).
  - Row 4: Player B front row (mirrors Row 2).
  - Row 5: Player B home row (mirrors Row 1).
  - **Effigy Deck & Zone are ON the grid**, in the home row's corner cells:
    - Player A: deck at **Row 1 Col 1**, flips face-up into the **Effigy
      Zone at Row 1 Col 5**.
    - Player B: deck at **Row 5 Col 5**, flips face-up into the **Effigy
      Zone at Row 5 Col 1** (180°-rotated mirror of Player A's layout).
    - Altars are played into the face-up **Effigy Zone** cell (not the deck
      cell).
  - That leaves **Row 1 Col 2/3/4** (Player A) and **Row 5 Col 2/3/4**
    (Player B) as the open cells where Beings are summoned.

## Card types

| Type | MTG-equivalent | Notes |
|---|---|---|
| Being | Creature | Summons into home row (Row 1/5), enters **engaged**. Moves per its printed arrows; moving engages it. |
| Deity | Legendary/powerful Being | Sub-type of Being. Does **not** enter engaged on summon. |
| Prophecy | Trap (face-down) | Played face-down in Row 3 with a time counter. `Modulate -1` each controller turn; hits 0 → flips face up and resolves its printed text — if that grants it its own new Time Counters ("Gain (N) Time Counters"), it stays face-up on the same tile, ticking those down the same way, until *they* hit 0 → Purgatory. No "Gain" clause (e.g. Al khali the Empty) → straight to Purgatory in one step, same as before. See Keywords for the full mechanism. |
| Conjuring | Sorcery | Main-phase speed. |
| Ethereal Conjuring | Instant | Playable on **either player's turn**, in response to any action (full instant-speed/reactive). |
| Altar | Land | **Not tied to a board cell at all** (see `state.altars`, below) — a player may control any number of Altars at once, and their "Craft (N) additional Effigy" bonuses simply stack. A passive permanent (no Engage, no summoning sickness): the bonus applies automatically every controller turn. The Effigy Zone board cell (Row 1 Col 5 for A, Row 5 Col 1 for B) still exists, purely as the visual breakdown of the player's crafted Effigy pool — Altars no longer occupy it. |
| Relic | Artifact | Placed on any empty cell the player controls in the Mortal Realm (Rows 1,2,4,5). Enters play disengaged (no summoning sickness); if it carries "Engage: X" text, it can activate that ability the same turn. |
| Relic, Being | Artifact Creature | A Relic that plays as a full Being on the board — combat (blocks/deals/takes damage), death-damage to its controller on death, Engage/Martyr, the Being border (not the Relic one). Placed like a plain Relic (any Mortal Realm cell, front row included) and enters disengaged like a Deity, unlike a normal Being's home-row-only, enters-tapped summon (`card.isRelicBeing`, `getCardKind`/`toGameCard`/`getBorderTypeForCard` in cardData.js). Two real examples: Training dummy ("Can not attack" — a new static `cannotAttack` keyword), Crumbling Sphinx (a normal printed Engage ability). |
| Relic – Armament | Equipment/Tool | Placed under a Being (stacks on an occupied cell) or on top of other Armaments. Some grant "Beings may move across this" text; not universal. |

## Keywords

Reusable vocabulary printed on card text (like MTG keywords) — shorthand for
a fixed chunk of rules text so cards don't have to spell it out every time.
Most of these still need a general card-text effects engine (see Phase 2
below) before they can actually run. Current implementation status:

- `parseKeywords()` in `src/lib/cardData.js` detects all of these from a
  card's Text Box (regex-based) and stores them on `card.keywords` — so the
  engine knows which keywords a card has, even for the ones it can't act on
  yet.
- **Persist** is fully wired: a pure state flag with no free-text effect to
  execute, so `SUMMON_BEING` already checks it (a Persist Being enters
  disengaged, same as a Deity).
- **Favored** is fully wired: a Being with the bare keyword gains a Favor
  Counter on summon (`SUMMON_BEING`), and mutual combat
  (`MOVE_OR_ATTACK`) checks each side for one — a Favor Counter fully
  prevents that side's damage instance and is consumed, before the
  attacker/defender-dies checks run.
- **Depart** and **Martyr** have real trigger points with a genuine
  mechanical cost: Depart fires (either side of combat, or a Martyr
  sacrifice) and Martyr is a real player action (`ACTIVATE_MARTYR`: engages
  and sacrifices the Being, costs a disengaged Being same as attacking). Both
  log that the trigger fired and what their captured effect text says, but
  don't execute that free-text payload — real per-card text (see the CSV) is
  varied enough (multi-clause, cross-references other keywords, grants
  keywords to *other* cards) that a general resolver for arbitrary text isn't
  attempted; a curated per-card effect author or a much larger keyword
  vocabulary would be needed first.
- **Conjurings** resolve the same way: cast (`CAST_CONJURING`) pays the cost
  and moves the card straight to Purgatory, logging the same
  not-yet-automated notice.
- **Engage: "X"** (the generic activated-ability pattern printed on ~40 cards
  in the real set — by far the most common trigger shape after Depart) has
  a real trigger point too: `ACTIVATE_ENGAGE` engages the Being (its action
  for the turn, same cost as attacking) and resolves "X" the same way
  Depart/Martyr do. Relics print this pattern too (e.g. "Dial of Metatoris":
  `Engage: Modulate (±1) on a target you control`), and `ACTIVATE_ENGAGE`
  fires for them identically — a placed Relic has no summoning-sickness rule
  (unlike a Being), so it can Engage the turn it's placed. `disengage()`
  untaps both engaged Beings and engaged Relics at the start of their
  controller's turn.
- **Modulate (±X)** is now a real, executable effect wherever it's the
  recognized payload of a Depart/Martyr/Engage/Conjuring trigger: it parks
  the game on `pendingChoice` (`kind: 'modulate'`) until the acting player
  picks one of their own Prophecies as the target (`RESOLVE_MODULATE`) — a
  "±" sign offers both +1 and -1 as separate choices. A Prophecy Modulated
  to 0 resolves into Purgatory exactly like the automatic per-turn step.
  Own-only by default, UNLESS the card's own printed text contains no "you
  control" wording at all anywhere (Charge Forward, Roll Back, the
  Conjuring literally named "Modulate", MetaToris) — those can target
  either player's Time Counter instead, per the real CSV's own internal
  contrast (Hurry Up and Wait spells out "This may only target Time
  Counters that you control" as an explicit second clause exactly when
  that restriction is meant to apply, and leaves it off otherwise).
- **Add (N) &lt;Color&gt; Essence** — the Zealot pattern (all six printed
  Zealots use some form of this as their Engage payload) — is a real,
  executable effect: it grants N effigies of the named color straight into
  the acting player's pool. Unlike an Altar's "Craft" (below), this is a
  **temporary** grant, good only until end of the turn it's granted — marked
  `temporary: true` so `endTurn` (turn.js) strips any left unspent from the
  pool instead of carrying them forward, and keeps a spent one out of the
  real Effigy Deck it never belonged to when shuffling spent effigies back.
  "Faithless" counts as a real color here too (some Zealots grant it) and
  works as a wildcard, payable against any card's generic pip. All six
  Zealots' full printed text is real now, not just the core Essence grant:
  - **Chained clauses** ("X, then Y") resolve *both* clauses in order
    instead of only the first recognized one — e.g. "Rhak-tùrin Zealot":
    "Add (1) Bleeding Essence then deal (1) Damage to this" grants the
    Essence *and* deals the self-damage (see "Deal (N) Damage to this"
    above, which this reuses via `context.selfCellId`). `resolveOrLogEffect`
    tries the whole, unsplit text against every single-clause pattern first
    (so a pattern that deliberately spans its own "then" — the Crossing-
    Counter-move pattern — still gets first look), and only falls back to
    splitting on "then" if the whole text didn't match; each clause then
    resolves independently through the same resolver, recursively. This
    also fixed the identical gap in Darmah-Triya Bracers' granted Engage.
  - **"Pay (N) Lifespan, Engage: X"** (NamKaranian Zealot) is a real extra
    cost (`card.keywords.engageLifespanCost`) — paid when `ACTIVATE_ENGAGE`
    resolves, and gated the same way Mulligan's own Lifespan cost is
    (refused, not offered, if it would drop to 0 or below — not left as a
    genuinely game-losing legal play).
  - **"If you control ... you may Engage: X"** (Zealot: only Faithless
    permanents; Kalduran Zealot: a non-Armament Relic) is a real condition
    (`card.keywords.engageCondition`, one of `'faithless-only'` or
    `'controls-relic'`) re-checked fresh in `getLegalActions` and again in
    the `ACTIVATE_ENGAGE` reducer case every time — not locked in once. An
    unrecognized condition phrase is left unset (Engage stays available
    unconditionally for it) rather than guessed at.
  - **"Once per turn when a Time Counter is removed from a Prophecy you
    control, add Essence"** (Eònion Zealot) is a real passive trigger — not
    Engage-costed at all — wired into both places a Prophecy's Time Counter
    can actually decrease: the automatic per-turn tick (`modulate()` in
    turn.js) and a Modulate-as-effect resolution with a negative delta
    (`RESOLVE_MODULATE` in actions.js, only when `delta < 0` — adding a
    counter doesn't count as "removed"). "You" is the Prophecy's controller,
    not necessarily whoever's turn it is. The once-per-turn limit is a real
    `usedProphecyTrigger` flag on the Zealot's own board occupant, reset at
    the very start of its controller's own turn (before that turn's own
    automatic tick runs, so a trigger firing during that same `beginTurn`
    call isn't immediately un-used again by the same step).
  - Detecting "Engage:" itself got more permissive to make all of this
    possible: real Zealot text puts a cost or condition on the *same line*
    before "Engage:" ("Pay (2) Lifespan, Engage: ..."; "If you control ...
    you may Engage: ..."), which the old line-start-anchored pattern missed
    entirely — those cards weren't even recognized as having an Engage
    ability at all before this pass.
- **Target Effigy that you control Engages, then add (1) Essence of its
  typing** (Effigial Conservator) — ruled: "Target Effigy" means a real
  Effigy pool pip, not a board occupant (nothing in the set is actually
  typed "Effigy"), and this is what lets a player protect one specific
  color pip they don't want spent. **Implemented**: Effigy pool entries can
  now individually carry their own `engaged` flag
  (`engageEffigyAddEssence`, actions.js), which `canPayCost`/`payCost`/
  the Faithless-selection helpers all read through one shared choke point
  (`payablePool`) — an Engaged pip is invisible to every cost payment in
  the game until it's untapped, same "can't act while engaged" idea as a
  board occupant. It untaps at the normal Disengage Step (turn.js), the
  same lifecycle as any other Engaged permanent, not a one-turn-only
  effect. The granted Essence itself is the ordinary Zealot-style
  temporary grant above — good only until end of turn.
- **When this Being deals damage to an opponent, prevent that damage and
  craft (X) Effigies where (X) is the damage that would have been dealt**
  (Degrisch Vassal) — ruled: "deals damage to an opponent" is this
  engine's own straight-through/open-lane attack (the only case a Being's
  damage actually lands on the opponent's Lifespan directly, rather than
  on another Being or its own controller's death loss). **Implemented** in
  `resolveAttackFrom`'s own open-lane branch — the Effigies crafted are
  capped at however many are left in the Effigy Deck, same as every other
  Craft.
- **Once per turn when a Being you control dies you may have this Relic
  gain its effect(s) until end of turn** (Wretched Remnants) — ruled:
  copies the dying Being's WHOLE textBox (Depart, Martyr, Engage, a static
  bonus — everything `parseKeywords` would derive from it), not its own
  stats/typing/name. **Implemented** by swapping `card.keywords`/
  `card.textBox` on the Relic's own occupant for the rest of the turn
  (`grantBorrowedTextBox`, actions.js) — the same single-choke-point trick
  "Drown out the Screams"'s own ability-suppression already uses, just in
  reverse, so every existing keyword read in the file picks up a borrowed
  ability for free. The dying Being's own name is substituted for "this"
  first, so a self-referential effect now correctly means whatever's
  currently carrying it. Gated once per turn per Relic
  (`wretchedRemnantsUsedThisTurn`, reset at the start of its controller's
  next turn) and skipped with an honest log if a pendingChoice is already
  claimed (e.g. by the dying Being's own Depart) — this engine tracks only
  one pendingChoice at a time.
- **Craft (N) additional Effigy on your turn** — the Altar pattern (all six
  printed Altars use this as their core effect, alongside various extra
  conjure costs/conditions) — is implemented as its own keyword
  (`card.keywords.craftBonus`), separate from the Engage/Depart/Martyr
  trigger system since it's a passive, always-on effect with no activation
  cost. `craftEffigies` (turn.js, part of `beginTurn`) sums `craftBonus`
  across every Altar the turn player controls and adds it to that turn's
  normal flip count — so unlike a Zealot's temporary "Add", this really is
  the ordinary per-turn Craft step just flipping extra cards, meaning the
  effigies it produces are real Effigy Deck draws that linger in the pool
  and shuffle back on spend exactly like any other effigy. It only ever
  fires on the controlling player's own turn (never the opponent's), and
  only during that begin-turn craft step.
  - **Faithless Altar**'s version of the bonus is conditional ("If you
    control only Faithless Permanents") — `card.keywords.craftBonusCondition
    === 'faithless-only'`, checked fresh every craft step (not locked in at
    placement) against every card the player controls, including Armaments
    stacked on Beings. A card counts as "Faithless" if its casting cost has
    no colored pips at all (`castingCost.colored` is empty) — it can still
    cost plain Faithless pips.
  - **Eònion Altar**'s version is gated behind its own Time Counters ("When
    conjured gain (3) Time Counters... If this has (0) Time Counters:
    Craft...") — **implemented**. `card.keywords.armamentCounterGrant` (the
    same field Feathers of the Fallen/Crucible use for their own ETB counter
    grants — the parsing regex now accepts "When conjured gain..." as well
    as "When summoned gain...", since an Altar is *conjured* rather than
    *summoned*) seeds an Altar occupant's own `counters: { time: 3 }` in
    `PLACE_ALTAR`. `modulateAltarTimeCounters` (turn.js, part of
    `beginTurn`, right after the Prophecy `modulate` step it mirrors) ticks
    every Altar the turn player controls down by 1 each of their own turns,
    floored at 0 — the same automatic "Modulate -1" mechanic Prophecies use
    (RULES.md's own Modulate keyword entry), just applied to an Altar's
    Time Counters instead of a Prophecy's printed timer. `craftBonus:
    'zero-time-counters'` (a new `craftBonusCondition` value alongside
    `'faithless-only'`) then gates the bonus on that specific Altar's own
    `counters.time === 0` — checked per-Altar, not board-wide like
    Faithless Altar's condition is.
- **Costs (-N) &lt;Color&gt; for each &lt;Name&gt; you control** (Skeletal
  Colossus: "Costs (-1) Faithless for each Bag o' Bones you control.") — a
  static cost modifier, not a trigger-point effect (nothing to resolve
  through `resolveOrLogEffect` — it's captured as its own
  `card.keywords.costReduction: { amount, color, name }` field, checked
  fresh at every point a card's affordability matters (`getLegalActions`'
  own `SUMMON_BEING` offer, and again inside `SUMMON_BEING` itself when it
  actually pays) rather than stored anywhere, so it always reflects the
  current board. **Implemented.** Scans every permanent the player
  controls by name — a Being/Relic/Altar's own card, or any Armament
  entry attached to one (including a freestanding pile) — generically, not
  hardcoded to Bag o' Bones specifically; `color` is either `'faithless'`
  or one of the card's own `castingCost.colored` keys, and a reduction
  never drops a cost component below 0.
- **As an additional cost to Conjure, &lt;effect&gt;** — three of the six
  Altars pay a real extra cost when placed (`card.keywords.conjureCost`,
  parsed the same way as Depart/Martyr/Engage's trailing text; the real CSV
  spells "additional" as "aditional" on one card, so the word is matched
  loosely). Resolved via the same `resolveOrLogEffect` trigger resolver as
  everything else, called from `PLACE_ALTAR` right after the Altar is
  placed — all three patterns are now genuinely executed:
  - **Kalduran Altar** ("send the top (3) cards of your deck to your
    Purgatory") mills real cards off the Main Deck into Purgatory. Milling
    fewer than N when the deck is nearly empty is a silent no-op, not a
    block — matching the draw-from-empty-deck penalty's graceful-degradation
    precedent elsewhere in this engine, rather than a hard refusal.
  - **NamKaranian Altar** ("discard a card at random") discards a real,
    randomly-chosen card from hand to Purgatory. An empty hand is a silent
    no-op for the same reason.
  - **Rhak-tùrin Altar** ("Deal (3) Damage to a Turanga you control") deals
    real damage to a Being of the named typing the player controls
    (`DAMAGE_TARGET_RE` in actions.js — generalized to "a &lt;Typing&gt; you
    control", not hardcoded to Turanga), mirroring `MOVE_OR_ATTACK`'s own
    death handling (dies below 0 Lifespan, owner takes its base Lifespan,
    Depart fires, Armaments stay behind). Unlike mill/discard, this **does**
    gate placement — real "additional cost" semantics — so `PLACE_ALTAR`
    both refuses to offer this Altar (`getLegalActions`) and refuses to
    place it (the reducer case, independently) unless the player controls
    at least one legal target. Exactly one candidate auto-resolves; more
    than one parks a `pendingChoice` (`kind: 'damage-target'`) for the
    player to pick which one takes the damage. Not checked against a Favor
    Counter — Favored's only wired trigger point today is mutual combat
    resolution, not this pattern.
- **Being has/gains +N/+N** — the Armament stat-bonus pattern (8 of the 16
  printed Armaments use some form of this) — is a real, additive Strength/
  Lifespan bonus while the Armament stays attached (`card.keywords.statBonus`,
  parsed the same "Attached "-optional way as the other Armament patterns).
  Strength is never stored anywhere — `effectiveStrength(occupant)`
  (combat.js) sums the base card plus every attached Armament's bonus fresh
  wherever combat reads it (mutual combat, attacking into an open lane, the
  AI's own scoring), so a 1/1 with a +3/+0 Armament attached really is a 4/1
  for as long as it stays attached, and reverts the instant it's gone
  (currently only by the Being dying — there's no detach-while-alive action
  in this engine). Lifespan is different: it's a depleting pool
  (`currentLifespan`), so a bonus is applied immediately when the Armament
  attaches (`SUMMON_BEING` onto a waiting pile, `MOVE_OR_ATTACK` onto one, or
  `ATTACH_ARMAMENT` directly) rather than computed fresh each time — a
  positive bonus heals on the spot, and a negative one (e.g. "Gargantuan
  hammer": +6/-3) is dealt as real damage through the same death pipeline as
  combat, so equipping something with a Lifespan penalty can kill the Being
  immediately if it's lethal. The board (`CardTile`/`Board.jsx`) shows the
  boosted Strength as a ⚔ badge over the printed base value, the same way a
  ♥ badge already showed boosted/damaged Lifespan.
- **Being has/gains: Engage: "X"** — the Armament-granted-ability pattern
  (Darmah-Triya Bracers, Brick, Shovel, Soulless Scissors) — grants the
  attached Being a real Engage ability for as long as it stays attached
  (`card.keywords.grantedEngage`, distinct from an Armament's own printed
  "Engage:" line acting on itself — see the next bullet).
  `effectiveEngage(occupant)` (actions.js) checks the Being's own Engage
  keyword first, falling back to the first attached Armament that grants
  one — used by both `getLegalActions` and `ACTIVATE_ENGAGE` itself, so a
  Being with no Engage of its own still gets a real Engage action once one
  is attached. Simplification: a Being carrying more than one
  Engage-granting Armament at once isn't disambiguated (picks the first);
  no real card in the set currently creates that combination.
- **Armaments are independently engageable permanents of their own** —
  e.g. "Feathers of the Fallen": "Engage: Remove (1) Crossing Counter, then
  move attached Being one tile in any direction." Each Armament is stored on
  its occupant as a `{ card, engaged }` wrapper (not a bare card) so it can
  carry its own tap state, separate from the Being it's attached to (or with
  no Being at all — an Armament sitting in a freestanding pile is just as
  engageable). `ACTIVATE_ARMAMENT_ENGAGE` (cellId + armamentInstanceId)
  engages that one Armament and resolves its own `card.keywords.engage`
  text the same way `ACTIVATE_ENGAGE` does — the attached Being's own
  engaged state is untouched, so a Being can be fully engaged (having
  attacked, say) while an unrelated Armament on it still activates freely.
  `disengage()` (turn.js, part of `beginTurn`) untaps every engaged
  Armament the turn player controls, on Beings and freestanding piles alike.
  - **UI**: double-clicking any stack that carries at least one Armament (a
    Being with Armaments attached, or a freestanding pile) opens an expanded
    view (`Match.jsx`) showing every card in it side by side — the Being (if
    any) plus each Armament — so a specific one can be selected. Clicking
    the Being closes the view and selects it as normal (its usual Move/
    Attack/Martyr/Engage options appear below the board); each Armament
    shows its own Engage and/or Sacrifice button inline when it has a legal
    one, plus any counters it's carrying.
- **Feathers of the Fallen is now fully real**: "When summoned gain (2)
  Crossing Counters" is a genuine ETB — `card.keywords.armamentCounterGrant`
  (parsed generically by counter name, not hardcoded to "Crossing") seeds
  `entry.counters` the moment `ATTACH_ARMAMENT` attaches it. Its own Engage,
  "Remove (1) Crossing Counter, then move attached Being one tile in any
  direction" (`ARMAMENT_COUNTER_MOVE_RE` in actions.js), spends the counter
  (logging "has no ... Counters left" and stopping there if it's out) and
  then relocates the attached Being to any of the (up to 8) adjacent Mortal
  Realm cells the player chooses — computed the same way arrow-based
  movement is (`computeMoveDestination`), but *not* gated by the Being's own
  printed arrows, since this is the Armament's benefit, not the Being's own
  move action. For that same reason `moveBeingFreely` (actions.js) doesn't
  set `engaged: true` on the Being — it keeps whatever action it still has
  for the turn. Exactly one legal destination resolves immediately; more
  than one parks a `pendingChoice` (`kind: 'free-move'`) with its own picker
  modal in `Match.jsx`.
- **"Deal (N) Damage to this"** — self-damage, where "this" is the Being
  whose own ability text it's part of (e.g. "Darmah-Triya Bracers":
  "Attached Being has: Engage: Deal (2) Damage to this, then add (1)
  Bleeding Essence"). `resolveOrLogEffect` now takes an optional `context`
  (`{ selfCellId, armamentInstanceId }`), passed in by `ACTIVATE_ENGAGE`
  (when the effect belongs to a Being, own or granted) and
  `ACTIVATE_ARMAMENT_ENGAGE`, so patterns like this one know which Being
  "this" refers to. Simplification: only the *first* recognized clause in a
  chained effect still resolves (the established one-clause-per-trigger
  rule) — for Darmah-Triya Bracers specifically, the essence-grant clause is
  checked earlier in the pattern order than self-damage, so it's the one
  that fires; the self-damage pattern itself is real and will fire on its
  own for any future card whose Engage text is just "Deal N Damage to this"
  with nothing recognized ahead of it.
- **"Sacrifice this to give attached being a Favored Counter until the end
  of turn"** ("Mahka-Rahva's Tiger Skin") — a sacrifice-cost activated
  ability with no Engage cost at all, so `card.keywords.sacrificeForFavored`
  is matched close to verbatim rather than generalized. A new
  `ACTIVATE_ARMAMENT_SACRIFICE` action removes the Armament and sets
  `favorCounter: true` on the attached Being — reusing the real Favored
  mechanic that already exists. Simplification: "until the end of turn"
  isn't enforced — same as the base Favored keyword, the counter just sits
  until consumed by combat rather than expiring if unused.
- **Animated, Dryad, Shift, and Invoke are all fully wired** (see their own
  entries below) — Invoke's own two-phase resolution (search-and-choose,
  *then* a free/pointed placement) is real via `resolveInvoke`/
  `invokeCardOnto`/`placeInvokedCard` (actions.js), covering a named card
  (Classic Familiar), a Faithless-filtered typing (Faithless Invocation), a
  cost-ceiling typing landing on a pointed tile (Kernel), and a typing
  landing on a pointed tile with no cost ceiling (Crathean Cultivator,
  Midnight Mass).

- **Animated** — While in the Mortal Realm, this (normally a Relic–Armament)
  is treated as a Being: it has its own Strength/Lifespan, other Beings may
  still move onto its tile, and any effect that targets a Being or an
  Armament may target it. **Implemented**, scoped exactly to the printed
  reminder text's own conditions: it only acts as a Being while it's the
  **topmost entry of a Being-less pile** (`type: 'armament-stack'`) — never
  while attached under a real Being (ordinary equipment there, regardless
  of its own Animated keyword), and never from hand/deck/Purgatory. It's a
  status read fresh off whatever card currently sits on top, not a stored
  flag, so it naturally turns on/off as the pile changes — no separate
  bookkeeping needed when a Being picks the pile up (it becomes a `being`
  occupant) or a non-Animated Armament ends up on top.
  - **Move/attack**: `getLegalActions` offers the same `MOVE_OR_ATTACK`
    actions a real Being would get, using the topmost entry's own printed
    arrows and its own per-entry `engaged` flag (the same one
    `ACTIVATE_ARMAMENT_ENGAGE` already tracks) — none of a real Being's
    *other* abilities (Martyr, a generic printed/granted Engage ability)
    apply. `MOVE_OR_ATTACK` itself reads a lightweight synthetic
    `{ card, currentLifespan, armaments }` view of the topmost entry for
    all combat math (`combat.js`'s helpers run unchanged against it —
    Strength bonuses from Armaments stacked *underneath* it still apply,
    same as a real Being's own equipment), then writes `engaged`/
    `currentLifespan` back onto that one entry specifically, never onto the
    occupant itself.
  - **Blocks combat, unlike a plain Armament**: RULES.md's own "a Relic or
    freestanding Armament pile doesn't block an attack" rule (see Combat,
    below) explicitly excludes this case — an Animated-and-topmost pile
    *does* block, with real mutual combat, exactly like a Being would.
  - **Death**: below 0 Lifespan, it's removed (only that one entry — any
    Armaments stacked underneath stay behind as an ordinary pile,
    themselves becoming the new "topmost" and able to start acting if one
    of *them* is also Animated), its card goes to Purgatory, and its
    controller takes its own base printed Lifespan as damage — identical to
    a Being's own death pipeline. A Depart keyword on the Animated card
    itself would fire too (none of the three real Animated cards happen to
    have one, but the trigger point is wired for consistency).
  - Simplification: the printed reminder text's "sometimes a text box can
    be removed via another effect" edge case isn't separately modeled —
    the Animated check just reads whatever card object currently occupies
    that slot, so if some future effect ever swapped in a textless card
    there, this would already reflect that correctly without new work; no
    card in the real set currently does this, so it's untested.
  - **Stacking order**: `ATTACH_ARMAMENT` always keeps whichever entry is
    Animated as the topmost one, rather than the plain "newest attachment
    goes on top" rule every other Armament follows. Attaching a **new**
    Animated Armament still goes on top as normal (the common case, and how
    it becomes the acting entry to begin with); attaching a **non**-Animated
    one onto a pile whose current top *is* Animated slots the new entry in
    just below it instead of bumping it out of "topmost" — otherwise
    equipping something would silently stop the Animated one from acting,
    which isn't how equipping onto an active permanent is supposed to work.
    A buried Armament (Animated or not) still grants its own printed
    "Being gains +N/+N" to whatever's currently on top either way — the
    Strength half already fell out for free from `armamentStrengthBonus`
    summing every entry in the pile regardless of position; the Lifespan
    half needed a small dedicated helper
    (`applyLifespanBonusToArmamentEntry`), since the existing
    `applyNewArmamentsLifespanBonus` only ever knew how to write onto a
    real Being's own `currentLifespan`, not an armament-stack's topmost
    entry. A freshly-attached **new** Animated entry also now inherits any
    Lifespan bonus the pile it's landing on already carries (it starts at
    `card.lifespan + existingLifespanBonus`, not just its own printed base)
    — the mirror-image case of a bonus arriving *after* it.
  - **Board display**: an Animated top's current Strength/Lifespan render
    the same damaged/boosted badges a real Being's do (`Board.jsx` passes
    `actorView(occupant)` + `effectiveStrength` the exact shape combat
    itself uses; `CardTile.jsx`'s own `isBeing` check now also accepts
    `card.keywords?.animated`, since the underlying card is still
    `kind: 'relic-armament'`).
  - **Free-move eligibility**: an Armament-granted "Remove (N) Counter(s),
    then move attached Being one tile in any direction" (Feathers of the
    Fallen) now recognizes an Animated top as a valid "attached Being" to
    move too, not just a real one — `freeMoveEligible(occupant)` (a new
    shared check, actions.js) replaces the old `occupant.type === 'being'`
    gate everywhere this cost pattern is checked (the resolver branch,
    `RESOLVE_FREE_MOVE`), and `moveBeingFreely`'s own log line reads the
    acting card's name off `occupant.card` (a real Being) or the topmost
    armament entry (an armament-stack), whichever shape it's given. The
    whole pile — Feathers itself included — moves together, same as it
    already did for a real Being's Armaments.
- **Dryad** — This Being may move onto another Being with the TreeFolk, Vine,
  or Seed typing (stacking on its tile, like an Armament would). While
  attached this way, it gains that Being's Strength and Lifespan on top of
  its own. **Implemented**, as a real MOVE_OR_ATTACK destination
  (`dryadAttachTargetOk`, actions.js) — scoped to the mover's own Beings
  only (the real card text doesn't say "you control", but attaching onto an
  opponent's Being would collide with this engine's "moving onto an
  opponent's tile is an attack" rule, so this is a documented
  simplification). Unlike an Animated Armament, the whole pile stays
  `type: 'being'` — the mover keeps its own textBox/abilities and can
  still move/attack normally, no special-casing needed anywhere else. The
  Strength bonus is live (recomputed fresh every time, via
  `dryadAttachedStrengthBonus`, combat.js — reading the mount's own full
  effective Strength, including whatever it's carrying); the Lifespan bonus
  is instead applied once as an immediate heal at the moment of attaching
  (`applyDryadAttachLifespanBonus`, actions.js), same "never computed live,
  never clawed back on detach" precedent Armament Lifespan bonuses already
  establish. Unlike equipped Armaments, a mount is a shared TILE POSITION,
  not worn equipment: it stays behind on the origin tile (returned there
  unharmed via `dropDryadAttached`) the instant its rider moves away again,
  rather than travelling along — same helper as the dies/sacrificed/
  returns-to-hand cases just below, all of which the mount was never
  actually harmed by either. Sporangium's own "When a
  Being with Dryad moves onto this, X" reaction (`onDryadAttachedOnto`)
  fires at the moment of a successful attach.
- **Shift (X)** — an Engage-costed ability: the Being becomes a Prophecy
  with X Time Counters, moving to the Ethereal Realm. Real reminder text,
  found verbatim on Shifting Shade's own flavor line: *"Engage: Move this
  onto a tile in the Ethereal Realm, it becomes a Prophecy, then gains (X)
  Time Counter(s) and 'When this has (0) Time Counters on it move it onto
  a tile in the Mortal Realm Engaged'; While it is a Prophecy it loses all
  other text and typings."* **Core mechanic implemented**, now with every
  real card that uses it wired too: Shifting Shade, Scā-vuhk Hunger, Immen
  Gorta, Údarik Hunger, Mouth of Madness, and the "Whenever a Being you
  control Shifts" reactions (Sanative Siphon's both clauses, Thōgrakin
  Hunger). Deliberately
  reuses the EXISTING Prophecy occupant shape end to end — same `timer`
  field, same automatic per-turn tick, same
  `resolveProphecyModulateHitZero` (actions.js) two-phase lifecycle any
  printed Prophecy already has — rather than inventing a parallel one, so
  a shifted Being is trivially a legal target for anything that already
  targets a Prophecy (Blasphemy and friends). `ACTIVATE_SHIFT` moves the
  Being onto any empty Ethereal Realm tile (same free-choice-among-5-cells
  precedent `PLAY_PROPHECY` already uses) and overwrites `card.textBox`/
  `card.keywords` on a fresh synthetic card (re-parsed from the Shift's own
  quoted text, if printed, through `parseKeywords` — the same
  single-choke-point trick `grantBorrowedTextBox`/Wretched Remnants uses)
  — literally "loses all other text and typings," and the ORIGINAL card is
  stashed on `shiftedFromCard` so `returnFromShift` can reconstruct it.
  Equipped Armaments (and any Dryad mount) are left behind on the origin
  tile, same as every other way a Being leaves the board. On the return
  trip — `resolveProphecyModulateHitZero`'s own `!faceDown` branch checks
  for `shiftedFromCard` before falling back to its normal "send to
  Purgatory" ending — the Being reconstitutes at full printed Lifespan (a
  Prophecy tracks no damage of its own) on any empty Mortal Realm tile of
  its controller's, landing Engaged, then resolves its own separate "When
  this moves into the Mortal Realm, X" line (`onMovedIntoMortalRealm`) if
  printed. A card's own quoted "Shift (X): 'At the end of your turn
  remove (N) Time Counter(s) from this'" becomes a real self-decay
  (`endOfTurnRemoveOwnTimeCounters`, applied by `applyEndOfTurnShiftDecay`,
  turn.js, in the Down Tick Step) — separate from, and resolved before,
  the ordinary automatic Modulate -1 tick every Prophecy still gets at the
  start of its controller's next turn.

  Also landed: **"Whenever a Being you control Shifts, X"**
  (`onOwnBeingShift`, Sanative Siphon's own first clause and Thōgrakin
  Hunger's own "except during the end step" exception) fires from
  `performShift` itself for every Shift regardless of what caused it —
  Sanative Siphon is a Relic, not a Being, so this reaction scan covers
  both shapes, unlike most reaction scans in this file. **Forcing another
  Being to Shift** (Chains of the Unbound: "Target Being an opponent
  controls Shifts (1)") reuses the exact same `performShift`/
  `offerOrPerformShift` machinery via a new `shiftOverride` parameter — an
  explicit `{amount, effect}` that stands in for the target's own printed
  `card.keywords.shift` (most forced targets don't have Shift printed on
  them at all). The affected player — not whoever forced it — picks the
  Ethereal Realm landing tile, same "the affected player chooses" precedent
  a forced sacrifice (Venefica) already establishes. **"Give a different
  &lt;Typing&gt; you control +S/+L"** with no Lifespan-cost prefix (Ounati
  Hunger's own "When this moves into the Mortal Realm give a different
  Hunger you control +1/+1") is a new, separate pattern from the existing
  paid/optional `buff-ally` one (Lamtukka Gentleman) — mandatory, and its
  own pendingChoice stores the exact candidate cell list rather than
  re-deriving it, so a multi-candidate offer can't drift from the
  typing filter that opened it.

  Also landed: **Immen Gorta + Mouth of Madness + Terranean Gates form a
  real, deliberate bounce loop** (confirmed intentional with the user,
  not a bug to guard against) — Immen Gorta's own quoted Shift decay
  keeps returning it to the Mortal Realm, where its own "deal (1) damage
  to any target" fires every time; Mouth of Madness
  (`duringEndStepForceShift`) immediately Shifts it back out; Terranean
  Gates (`duringEndStepLoseTimeCounters`) immediately zeroes its fresh
  Time Counter, sending it straight back for another lap. Both Relics are
  passive and printed with no "you control", so either player's copy
  affects any Being's Shift during End Phase. The whole cascade resolves
  synchronously within one End Phase — `duringEndStep`/`bounceCount`
  thread through the whole Shift/return call chain
  (performShift/offerOrPerformShift/placeReturnedFromShift/
  returnFromShift/resolveProphecyModulateHitZero), always auto-picking a
  destination instead of ever opening a pendingChoice (a 100-iteration
  cascade has no natural pause point), and "deal (N) damage to any
  target" auto-targets the shifted Being's owner's opponent directly
  (`context.autoTargetOpponentId`) instead of the normal player-choice
  path. Capped at exactly 100 real activations (the user's own
  instruction) as a hard safety stop rather than looping forever — a
  real 50-Lifespan opponent is comfortably lethal well before the cap.
  **Tiarlish Hunger's own "copy the effect(s) of target Being an
  opponent controls until the end of your next turn"** functions like
  Wretched Remnants (ruled by the user) — copies the target's WHOLE
  textBox via the same `parseKeywords`-swap trick
  (`grantCopiedEffectUntilNextTurn`) — but with a real two-turn-cycle
  duration instead of one: a self-consuming `copiedEffectSkipNextClear`
  flag (same philosophy as Instigator's own `doesNotDisengage`), scoped
  to only the copying player's own `endTurn` (never the opponent's), so
  it takes exactly two of the copier's own turns — the one it was
  granted on, then their next — to actually clear.

  Also landed since: **Formless Fangs** ("Any Being dealt damage by this
  Shifts (X)") — fires from `resolveAttackFrom` for whichever side it
  didn't occupy in combat, gated only on that side surviving the damage
  (Formless Fangs' own survival is irrelevant — even if it dies in the
  same mutual combat, the Being it hit still Shifts if it lived); never
  fires for open-lane damage, which never hits a Being at all.
  **Echoes of the Boundless** ("Whenever another Being dies its
  controller may pay its Summoning cost to Shift (X) instead of sending
  it to Purgatory. Damage is still dealt from it dying.") — implemented
  as a "you may retrieve it from Purgatory and Shift it instead" offer
  right after the normal death pipeline (which always deals its own
  Lifespan damage and sends the card to Purgatory first) — pulling that
  SAME card back out and placing it as a shifted Prophecy produces an
  identical end state to a true mid-pipeline replacement, without needing
  to intercept the death pipeline itself. Passive and board-wide (no "you
  control"), and "another" excludes only Echoes of the Boundless' own
  death, not a second copy of it elsewhere. **Údarik Hunger** ("Engage:
  Target Being you control Shifts (1), then loses (1) Time Counter; if it
  moves into the Mortal Realm this turn Disengage it. This ability can
  not target a Being named Udarik Hunger.") — a real three-step chain
  (target -> Ethereal destination -> Mortal Realm destination) that
  always resolves the whole way in one action, since Shift(1) immediately
  followed by losing 1 more Time Counter always hits 0: the target lands
  Engaged as normal, per Shift's own default ending, and is THEN
  explicitly Disengaged as a separate follow-up step (ruled by the user:
  "returns the being engaged and then based on the ability it then
  disengages"). A new `postShiftLoseAmount`/`disengageOnReturn` pair
  threads through the whole Shift/return call chain alongside
  `duringEndStep`/`bounceCount`, defaulting to off everywhere else, so
  the Disengage step still applies even when either half needs its own
  real player choice along the way.
- **Unruly** — "Whenever this Being attacks, lose Lifespan equal to its
  current Strength." Packaged as a real, reusable keyword at the user's
  own request, for future cards to print the bare word directly (same as
  Dryad/Persist/Favored/Invoke) — Unruly Fiend's own real printed text
  spells it out with its own name instead ("When Unruly Fiend attacks you
  lose (X) Lifespan where (X) is it's current strength") and stays
  exactly as printed; only what gets *parsed out of it* changed.
  **Implemented** in `resolveAttackFrom` itself — a real cost of
  attacking at all, unconditional on the outcome (open lane, mutual
  combat, even the Being's own death moments later), reading its live
  effective Strength (bonuses included), not just its printed base.
- **Persist** — This Being does not Engage when it enters the Mortal Realm
  (summon, or moving in from elsewhere) — an exception to the normal "enters
  engaged" default, same idea as the exemption Deities already get, but as a
  keyword any Being can carry. **Implemented.**
- **Favored** — Gain a Favor Counter. The next time this Being would take
  damage, remove the Favor Counter instead and prevent that damage.
  **Implemented.**
- **Depart: "X"** — When this Being dies, "X" happens. Also printed as
  "When this Being dies, X" on a couple of real cards (Thespian,
  Horological Horror) — same field either way. **Trigger point
  implemented**, and "X" now executes for real wherever it matches a
  recognized effect pattern (draw, deck/Purgatory search, token creation,
  a direct Lifespan swing, etc.) — see the fuller "When Summoned: 'X'"
  entry below for the shared resolver this and every other trigger point
  (Martyr, Engage, When Summoned, Conjurings) all go through.
- **Martyr: "X"** — Engage this Being, then sacrifice it: "X" happens. (Costs
  an Engage as part of activating it, so it needs to be disengaged first,
  same as attacking.) **Trigger point implemented** as a real player action
  (`ACTIVATE_MARTYR`), and "X" resolves through the same shared resolver as
  Depart above — real wherever it matches a recognized pattern.
  - Also printed as a **bare "Martyr"** with no colon or effect text at all
    — currently only Bag o' Bones (the real CSV also typos it "Matyr" on
    one row; both spellings are accepted) — meaning "engage and sacrifice
    this, for nothing extra." Captured as `keywords.martyr === ''`,
    distinct from `null` ("no Martyr at all") — resolveOrLogEffect already
    no-ops gracefully on an empty string, so this needed no special-casing
    beyond checking `!= null` instead of plain truthiness wherever
    `keywords.martyr` is read.
  - `ACTIVATE_MARTYR` works on a **Relic**, not just a Being — a Relic has
    no summoning-sickness rule (same as its own Engage), so it can Martyr
    the same turn it's placed. Real example: **Grave robber**'s "Summon an
    Undead Being on this tile from your Purgatory" is genuine reanimation
    — straight onto the board, not to hand (contrast the "Add X to hand
    from Purgatory" search pattern) — reusing a new shared
    `placeBeingOnBoard` helper (factored out of `SUMMON_BEING`) so the
    reanimated Being's own When Summoned/Persist/Favored/Mahka-style
    Armament-gathering all fire exactly the same way a normally-cast
    Being's would, not a parallel, easily-drifting reimplementation. A new
    `summon-from-purgatory` pendingChoice offers a choice when more than
    one Being of the named typing sits in Purgatory.
- **Invoke** — Search your deck for a card of the named type, reveal it, add
  it to hand, then immediately summon/conjure it (a tutor plus a free
  cast/summon in one).
- **Modulate (±X)** — Add or remove X Time Counters from a target card. This
  is the same mechanic as the turn structure's automatic "Modulate −1" step,
  generalized into a keyword so card effects can apply it (any sign, any
  target) outside of that step. **Implemented** as a recognized effect
  payload (see above) — not a standalone printed keyword on its own line, so
  there's no `card.keywords.modulate` flag; it's matched inside whatever
  triggered it (Depart/Martyr/Engage/a Conjuring's text).
- **Shift (X): "Effect"** — Engage this card, then move it onto an Ethereal
  Realm tile: it becomes a Prophecy (losing all other text and typings while
  it is one), gains 1 Time Counter, and gains "When this has 0 Time Counters,
  move it onto a Mortal Realm tile, Engaged" (i.e. it flips back into what it
  was, entering play already engaged).
- **Engage: "X"** — A generic activated ability: engage this card (its
  action for the turn), then "X" happens. Printed on both Beings and Relics
  (e.g. "Dial of Metatoris"). **Trigger point implemented**
  (`ACTIVATE_ENGAGE`, fires and resolves "X" the same way Depart/Martyr do,
  for either occupant type) — distinct from the *generic term* "Engage"
  below, which just means "using up a Being's (or engageable Relic's) action
  for the turn."
- **Engage** *(generic term)* — The generic term for taking an action with a
  Being (moving, attacking, activating an Engage-costed ability like Martyr
  or the "Engage: X" pattern above) or a Relic that carries "Engage: X" text.
  A Being can only take one Engage action per turn, since doing so engages
  it and it can't act again until it's
  disengaged (start of its controller's next turn).
- **Engage, X: Y** — a comma (not a colon) right after "Engage" means X is a
  *required second part of the cost*, not the effect: both Engage and X
  must be paid before Y happens (e.g. Osteomancer: "Engage, Sacrfiice a Bag
  o' Bones: Add an Undead to hand from your Purgatory" — the cost is Engage
  + sacrificing a Bag o' Bones, not "sacrifice a Bag o' Bones" as a
  freestanding effect). Captured into its own `engageExtraCost` field,
  distinct from `engage` (the real effect, Y). **Real** for the one
  recognized cost shape, "Sacrifice a/an &lt;Name-or-Typing&gt;" — gates
  whether the ability is even offered (no legal permanent to sacrifice ⇒
  not offered, same graceful non-offer precedent as every other unpayable
  cost) and actually removes the sacrificed permanent (through the real
  death pipeline for a Being, or just removed for anything else) before
  resolving the effect. Confirmed working end-to-end (live-simulated, not
  just pattern-matched): **Osteomancer**'s first Engage ability
  ("Sacrfiice a Bag o' Bones: Add an Undead to hand from your Purgatory" —
  the effect reuses a new `SEARCH_FROM_PURGATORY_RE` pattern, the exact
  same search-and-choose machinery as "Add X to hand from deck", just
  searching Purgatory instead) really sacrifices the Bag o' Bones and
  really searches — if it ever finds "no Undead in Purgatory" that's
  because there genuinely isn't one (e.g. Ditch Digger "Steve" himself is
  printed **Human**, not Undead, so his own corpse never qualifies), not
  because the mechanism is broken. Two more real cards use this shape but
  stay unrecognized (their whole Engage ability isn't offered, same as
  before this pattern existed) because their cost needs a primitive this
  engine used to be missing entirely: **Vadē Rah**'s "Sacrifice the Being
  on this tile" needs a Relic and a Being to share one board cell — this
  engine's board is one-occupant-per-cell, *except* now for "Beings may
  move across this" Relics specifically (see Keywords > "Beings may move
  across this", below) — Vadē Rah's own cost shape doesn't use that
  mechanism, so it's still an unrecognized gap, but the same underlying
  co-location primitive is now proven to work for the one case that needed
  it. **Smithing Tools**' "Remove (X) Forge Counters" needed Relic-level
  counters — that primitive **now exists** (see "Beings may move across
  this" > Shifting Sands, below, which uses it for real), but
  `engageExtraCostSacrificeCell` (the function gating whether an
  "Engage, X: Y" ability is even offered) still only recognizes the
  "Sacrifice a/an &lt;Name-or-Typing&gt;" shape, not "Remove (X) &lt;Type&gt;
  Counters" as an extra cost — so Smithing Tools is a smaller remaining
  lift than before (the hard primitive is built, it just needs its own
  cost-matching branch), not a fully separate blocker anymore. When more
  than one permanent matches the sacrifice cost, the first one found is
  used rather than offering a choice — none of the real cards using this
  pattern make that choice meaningful in practice.
  - **Osteomancer's two independent "Engage, X: Y" lines are both real
    now**: `parseKeywords` captures every Engage-shaped line on a card into
    a new `keywords.engageAbilities` array (purely additive — the existing
    singular `engage`/`engageExtraCost`/etc. fields still just reflect the
    first, so every other card's behavior is unchanged), and
    `getLegalActions`/`ACTIVATE_ENGAGE` offer/activate each entry
    independently (an `action.abilityIndex` picks which one) when a card
    has more than one. Both of Osteomancer's independent "Engage, X: Y"
    lines are fully real now: the first (sacrifice a Bag o' Bones, search
    Purgatory for an Undead), and the second ("Engage, Sacrifice an Undead:
    Summon a different Undead from your Purgatory") via a dedicated
    `SUMMON_DIFFERENT_TYPED_FROM_PURGATORY_RE` pattern that excludes
    whichever Undead was just sacrificed to pay the same Engage's own extra
    cost (`context.excludeName`), so it can't just re-summon the identical
    card it consumed. `Match.jsx` shows one Engage button per ability when a
    card has more than one, each with its own effect text.
- **When Summoned: "X"** — A Being's ETB (enter-the-battlefield) trigger,
  fired by `SUMMON_BEING` right after it's placed on the board (with the
  Being's own printed name substituted for "this"/"it" first, so a card
  naming itself directly — e.g. "Wounded Turanga": "deal (2) Damage to
  Wounded Turanga" — resolves through the same self-damage path as one that
  says "this"). **28 of the 31 real "When Summoned" Beings are real,
  executable effects**, not just logged:
  - Damage/board-state: self-damage ("this"/"it"/the card's own name), "deal
    (N) Damage to all other Beings" (Quake Goliath), "deal (N) damage to
    target Being" — any Being on the board, either owner (Massive/Medium/Mini
    Mage) — reusing the "Deal N Damage to a &lt;Typing&gt; you control"
    machinery's `damage-target` pending-choice, generalized to accept "no
    typing/ownership filter" instead of a hardcoded new kind.
  - **"If you control a Prophecy, X"** (Clock Tower Custodian, Massive/
    Medium/Mini Mage, Sneaky Peek) is a real, reusable conditional wrapper —
    checked, stripped, and recursed on the remainder — not hardcoded per
    card, so any future card with the same prefix picks it up automatically.
  - **"Gain (N) Lifespan"** / **"lose (N) Lifespan"** / **"take (N)
    Lifespan Damage"** — a direct Lifespan swing for the effect's own
    controller (not combat damage to a Being — an adjustment to the
    player's own total, same kind of change the end-step pass cost already
    makes). One generic pattern feeds any trigger point's text this way,
    not hardcoded per card. Real example: **Thespian**'s "When this Being
    dies you lose (4) Lifespan" — printed as an alternate phrasing of
    Depart ("When this Being dies, X" feeds the same `depart` field as
    "Depart: X" — see Depart below), so it's a real Depart trigger under
    the hood, not a bespoke death-trigger mechanism of its own.
  - Card draw/deck manipulation: "draw (N) card(s)" (backed by the same
    draw-from-empty Lifespan penalty as the normal draw step), "discard a/
    (1) card at random" (both real spellings), "put (1) card from hand on
    the bottom of deck" (Weaver's second clause), "look at the top card,
    then shuffle or keep" (Inquisitive Prodigy), "look at the top (N) cards,
    return them in the same order" (Seeress — a real no-op, since the order
    genuinely doesn't change), "reveal the top of your deck, if it's a
    &lt;Typing&gt; add it to hand" (Farm hand), and the Contrarians' "reveal
    the top of each deck, lowest/highest cost draws it, tie draws both"
    (a new `totalCastingCost` helper in cardData.js sums every pip into one
    comparable number).
  - Favored: "become Favored" (self, permanent — Favorite Son) vs. "target
    Being you control becomes Favored until end of turn" (IkVarem) are two
    genuinely different real effects, not the same thing worded twice — the
    temporary one is stripped again at its granter's own end of turn
    (`endTurn` in turn.js), the same temporary-until-end-of-turn precedent
    as a Zealot's Engage-granted Essence.
  - Optional ("you may") effects share one generic mechanism: a
    `pendingChoice.optional: true` flag plus a `RESOLVE_DECLINE` action that
    always accompanies the real candidates, so any current or future "you
    may" trigger gets a Decline option for free. Real optional effects:
    Vaticinator ("you may target a Prophecy and reveal it" — log-only, no
    state change, since Prophecies are always modeled face-down already),
    Cro-āsik Hunger ("you may sacrifice a Prophecy you control, then destroy
    target non Deity Being (Lifespan damage is not dealt)" — offered only
    when a legal Prophecy *and* a legal target both exist, same graceful
    non-offer precedent as Rhak-tùrin Altar's damage cost), and Lamtukka
    Gentleman ("you may pay (3) Lifespan to give a different demon or imp
    you control +1/+1" — gated the same "can't drop to 0" way as every other
    Lifespan cost in the engine).
  - Forced sacrifice/destroy, without dealing death-damage to the Being's
    owner: a new shared `destroyBeing` helper (mirrors `dealDamageToBeing`'s
    death branch — Purgatory, Depart, dropped Armaments — minus the owner-
    Lifespan-loss step). Venefica's "target opponent sacrifices a Being" is
    resolved by the *opponent*, not the caster — the engine already supports
    a pendingChoice belonging to a player outside their own turn (a
    defending Being's Depart can fire mid-attack the same way), so this
    needed no new plumbing beyond its own modal.
  - Instigator's "engage target non Deity Being, until the start of your
    next turn it gains 'This does not disengage during Disengage Step'" is
    modeled as a **self-consuming flag** (`doesNotDisengage`): `disengage()`
    skips untapping the occupant once, then clears the flag — a deliberate
    simplification of the literal "until the start of *your* next turn"
    (which would need tracking whose turn-start clears it), but produces an
    identical real-game outcome every time, since Disengage is always the
    first thing that would otherwise untap it.
  - Thespian's "this Being's Strength and Lifespan becomes equal to target
    Being you control" is a real, absolute stat override — a new
    `strengthOverride` field `effectiveStrength` (combat.js) reads in place
    of the card's own printed Strength when present (Armament/permanent
    bonuses still stack on top of it normally), plus setting
    `currentLifespan` directly. Its *separate* "When this Being dies you
    lose (4) Lifespan" clause is a distinct, non-"When Summoned" death
    trigger this round doesn't add — a known gap, not a bug.
  - MetaToris's "Shuffle (N) cards into deck from your Purgatory... or draw
    (M) Cards" is a real, mandatory (no "you may") either/or between two
    fixed, differently-sized options — its "(can not target MetaToris)"
    parenthetical is a dead clause here (a just-summoned Being can't already
    be in its own controller's Purgatory) and is safely ignored.
  - **Bone collector**'s "summon a Bag o' Bones token" is now a real,
    executed effect — see **Token creation**, below, for the mechanism.
  - **Tiny Forge Master**'s "sacrifice an Armament, then draw (1) card" is a
    required cost gating a real effect, not two independent clauses —
    matched as one whole pattern (like Cro-āsik Hunger's compound ability
    above), so the generic "then"-split never gets a chance to resolve
    "draw (1) card" for free without the sacrifice ever being paid (the
    bug this replaces: DRAW_CARDS_RE isn't anchored, so it would otherwise
    match "draw (1) card" as a bare substring before the cost was even
    considered). Scans every Armament the player controls anywhere on the
    board — another Being, or a freestanding pile — the same way Mahka-
    Rahva's own gathering scan does; no Armament at all means the whole
    thing is a no-op (no draw either, same graceful non-offer precedent as
    every other unpayable cost), exactly one auto-resolves, and more than
    one offers a new `sacrifice-armament` pendingChoice.
  - **Mahka-Rahva**'s "this Deity immediately moves without engaging" (the
    real CSV misspells it "Diety") is now a real, executed effect — same
    "relocate without engaging" primitive as an Armament's own free move
    (e.g. Feathers of the Fallen), just triggered by summoning instead of
    spending Counters, offering the existing `free-move` pendingChoice when
    more than one destination is legal. A Deity already enters play
    disengaged on its own (see above), so this free move leaves her ready
    to still take a real action the same turn afterward — net **two
    actions on the turn she's summoned** (the free move, plus her own
    normal move-or-attack), only one of which can ever be an attack, since
    the free move itself never is one. Her *other* clause — "All Armaments
    you control move to the tile this is summoned on" — is now real too: a
    separate, always-on static ability printed *before* "When Summoned"
    (its own `gathersArmamentsOnSummon` boolean keyword, not part of the
    `whenSummoned` capture at all — a pure state flag like Persist/Favored,
    no free text to resolve). `SUMMON_BEING` scans every occupant the
    controller owns anywhere on the board — the same board-wide ownerId
    scan Faithless Altar's "only Faithless Permanents" check
    (`controlsOnlyFaithlessPermanents`, turn.js) already uses, just
    collecting Armaments instead of checking Faithless-ness — and strips
    each one off wherever it's attached (another Being, or a freestanding
    pile, which is removed entirely once emptied) onto Mahka's own summon
    tile, resolved *before* her "moves without engaging" trigger, so the
    freshly-gathered Armaments then travel with her when she relocates.
    One deliberate simplification: a moved Armament's Lifespan stat bonus
    (if any) stays banked on whichever Being it was already granted to —
    the previous host's `currentLifespan` isn't clawed back — the same "no
    reversal on detach" precedent `ACTIVATE_ARMAMENT_SACRIFICE` already
    established, so this doesn't introduce a new inconsistency; a Strength
    bonus needs no such handling, since combat.js always computes it live
    from wherever the Armament currently sits.
  - **Formerly "Tier D" (all 3 since closed):** this section used to list
    Jirahperā, Crathea, and Green thumbed Gardener as blocked on Arrow-based
    "points to" targeting and (for Crathea) continuous static bonuses from a
    created token. Both underlying primitives were built in later rounds —
    "points to" targeting is `computeMoveDestination(ownerId, fromCellId,
    dir)` over a card's own printed arrows (see Al khali the Empty, below,
    and the Combat/movement note on Prophecy orientation), and continuous
    static bonuses are the board-wide aura primitive (see Growth Spurt,
    below) — and all three cards are now real: Jirahperā's own "you may
    summon (2) 0/2 Vine tokens on tiles this points to" (`MAY_SUMMON_VINE_
    POINTED_RE`), Green thumbed Gardener's "add (1) Growth Counter to a Seed
    this points to" (`ADD_COUNTER_TYPED_POINTED_RE`), and Crathea's own
    created Blooming/Withering Life tokens applying their board-wide aura
    live off the token itself.

- **Token creation** — "summon a/an &lt;Name&gt; token" effects (printed on
  many cards beyond Beings' own When Summoned text — Depart, Engage, and
  Martyr triggers all use the same phrasing too) build and place a real,
  fully playable card that was never a row in the user's CSV. A fixed
  catalog (`TOKEN_REGISTRY` in actions.js), not a parser for the printed
  reminder-text grammar — the real set phrases each token's inline spec
  differently ("1 cost Relic - Martyr.", "Cost 2 Bleeding - Relic -
  Armament- Animated Being gains +1/+1", "0/3 Being - vine token with
  'Engage: Add (1) Living'"), so adding a new token is a new registry
  entry, not a new parsing rule. `createTokenCard` (cardData.js) builds
  each one by constructing a synthetic raw CSV-row-shaped object and
  running it through the exact same `toGameCard`/`parseKeywords` every
  printed card goes through — a token's own granted abilities (a stat
  bonus, an Engage line, etc.) are real and work exactly like a printed
  card's, for free. **Real now:** "on this tile" (the trigger source's own
  cell — Cobra's Depart) and the common case with no named location
  (defaults to an empty Mortal Realm cell the player controls, offering a
  choice when more than one is legal — Bone collector, Cookie, Ditch
  Digger "Steve"), plus "add a/an &lt;Name&gt; token ... to hand" (Grave
  robber). A token name not in the registry logs the same honest "isn't
  automated yet" fallback as any other unrecognized effect, so an
  unimplemented token never silently does nothing without saying so.
  Cataloged tokens have grown well past the original set (Bag o' Bones,
  Snake Skin, Cursed Cutlass, Vine, Shifting Sands) to also include Vassal,
  Afterimage, Blooming Vine, Rat, Passing Doubt, and the Blooming/Withering
  Life Prophecy-tokens — check `TOKEN_REGISTRY` in actions.js for the
  current, authoritative list rather than this doc, since it grows every
  time a new card needs one. Vine is real reachable via Jirahperā's own
  pointed multi-summon, Spreading Roots' own "on tiles you control" mass
  placement, and Sporangium's own single pointed summon — the Arrow-based
  "points to" targeting this whole family needed is wired now (see the
  Tier D note above). **Bag o' Bones' own registry entry now includes
  `textBox: 'Martyr'`** — a fixed self-inflicted bug, not a card-text
  question: `createTokenCard` builds a card entirely from the fields passed
  to it, and the entry originally passed no `textBox` at all, so every
  summoned Bag o' Bones token silently had `keywords.martyr === null` (no
  Martyr) despite the real printed token reading "1 cost Relic - Martyr."
  — every card that summons one (Bone collector, Cookie, Ditch Digger
  "Steve", Grave robber, May Break my Bones) was affected.
  **"Choose a tile" is a board-native choice, not a modal**: the legal
  empty tiles themselves highlight (amber ring, same as a hand card's legal
  destinations) and clicking one resolves `RESOLVE_TOKEN_LOCATION`
  directly (`Match.jsx`'s `highlightCells`/`onCellClick`, gated on
  `pendingChoice.kind === 'token-location'`) — replacing the earlier
  plain-list modal, which worked but didn't show *where* each option was
  on the board at a glance.

- **Prophecies' full two-phase Time Counter lifecycle** — confirmed with
  the user directly, since the CSV text alone genuinely reads two
  different ways (see the git history around this note for the earlier,
  narrower "just Al khali" version this replaced). A Prophecy's own "# T"
  badge is one continuous resource across *both* halves of its life, not
  reset between them:
  1. **Face-down** (`faceDown: true`) — same as always: placed with its
     printed Timer as `timer`, ticks down 1 per controller turn
     (`modulate()`, turn.js).
  2. **Flip, at 0** — resolves its *entire* printed text box as a one-time
     trigger, through the same shared `resolveOrLogEffect` every other
     trigger point uses, but **one line at a time** rather than the whole
     blob in one call: real Prophecy text is usually 2–3 independent
     sentences on separate lines, not chained with "then", so only
     resolving the first pattern that matched the whole blob would silently
     drop the rest. `resolveProphecyModulateHitZero` (actions.js, exported
     for turn.js's own `modulate()` and shared with a card-granted
     "Modulate (±X)" effect landing on 0 too — `RESOLVE_MODULATE`) does
     this: flips `faceDown` to `false` first, splits `stripFlavorText`d text
     on `\n`, and resolves each non-empty line independently, threading
     state through.
  3. **"Gain (N) Time Counters"** (`GAIN_TIME_COUNTERS_RE`) is the specific
     line that gives it a real, nonzero Time Counter total for the face-up
     half below — captured generically, not hardcoded per card. A
     Prophecy with no such line (**Al khali the Empty**, **Orbital
     Acceleration**) never gains any, so it's fully resolved immediately
     and goes to Purgatory in this same step, exactly as it always has.
  4. **Face-up, ≥1 Time Counter** (`faceDown: false`) — stays on its
     Ethereal Realm tile, rendered with its real card face (`Board.jsx`'s
     `occupant.faceDown` check — previously hardcoded to always show the
     card back) instead of the face-down placeholder. Still ticks down 1
     per controller turn, the *same* `modulate()` step, just finalizing
     differently at 0 this time (see below) — Eònion Zealot's own "when a
     Time Counter is removed from a Prophecy" trigger doesn't care which
     phase it's in, so it already fires correctly either way.
  5. **Face-up, hits 0** — already resolved back at the flip; this is just
     cleanup, straight to Purgatory, no second effect.
  - **Al khali the Empty** still works exactly as before (no behavior
    change) — its "Summon a/an &lt;Name&gt; token on all tiles this points
    to" line resolves same as any other line, then (no Gain clause) it
    goes straight to Purgatory in one step. Its own arrows still resolve
    via `computeMoveDestination(ownerId, cell, dir)`, landing one token per
    direction, skipping any already-occupied tile (in `board` *or*
    `groundRelics`).
  - **Daylight Savings** ("Gain (3) Time Counters. Draw three Cards. You do
    not draw during the start of your turn.") — the middle line uses
    `DRAW_CARDS_RE`, widened to also accept a handful of spelled-out
    numbers (`one`–`five`) alongside digits, since this is the one real
    card that prints "three" instead of "(3)". The third line is a
    genuinely *ongoing* effect while face-up (not a one-time action), so
    it's deliberately excluded from the per-line resolution loop (it would
    otherwise just log a spurious "isn't automated yet" every time this
    flips) and instead captured as `card.keywords.skipsControllerDraw`
    (cardData.js), read live off the board by `drawStep` (turn.js): any
    face-up Prophecy the turn player controls with that keyword and ≥1
    Time Counter skips that turn's draw. Stops applying the instant that
    specific Prophecy's own Time Counters run out and it leaves — nothing
    to unset.
  - **Orbital Acceleration** ("All players draw a card. Craft (1) Effigy.
    You may Modulate (-1).") — "All players draw" is a new
    `ALL_PLAYERS_DRAW_RE` pattern (checked before the single-player
    `DRAW_CARDS_RE`, which would otherwise match its own "draw a card"
    tail), calling both players' draws through a shared `drawCardsFor`
    helper the two patterns now both use. "Craft (N) Effigy" (no
    "additional... on your turn") is a new one-time `CRAFT_EFFIGY_RE`
    pattern, naturally distinct from an Altar's own always-on
    `craftBonus` wording — drafts straight from the caster's own Effigy
    Deck into their pool once. **"You may Modulate (-1)" is a known,
    deferred gap** — falls through to the honest "isn't automated yet"
    log; it would need its own optional target-a-Prophecy pendingChoice,
    scoped out this round since the card's two core clauses already work.
  - **Horological Horror** ("(X) is equal to the total number of Time
    Counters you control") — a characteristic-defining Strength/Lifespan,
    computed **once at summon** via a new `totalTimeCountersControlledBy`
    helper (every Prophecy this player owns, face-down or face-up alike,
    since both phases use the same `timer` field, plus every Altar's own
    Time Counters — the only two places Time Counters live today), and
    written onto `strengthOverride` + `currentLifespan` at
    `placeBeingOnBoard` time — the same "snapshot, not continuously
    recomputed" precedent Thespian's own stat-copy already established,
    not a live-tracked value for the rest of its life. Its death-damage
    still reads the printed `card.lifespan` (0 for an X/X card), same
    documented simplification Armament/permanent Lifespan bonuses already
    accept.
  - **Formerly listed here as deferred (all since closed except two):**
    Kalmahka, Growth Spurt, Natures Bounty, Appease the Masses, Blood Moon,
    Chronostasis, The Roots Remember's nested "if this has (0) Time
    Counters, conjure a Prophecy from Purgatory" trigger, Hourglass,
    Horologist's Apprentice, and Pause are all real now (see their own
    entries elsewhere in this doc and the wave write-ups below). **Two
    genuine gaps remain:**
    - **The Persistence of Memory** ("Beings do not enter the Mortal Realm
      engaged") — no general "Beings enter disengaged" rule change exists
      yet; only the narrow Tilled Fields "a Plant lands here" case
      (`groundRelics[cellId].plantsEnterDisengagedUntilEndOfTurn`) does.
    - **Prophesize** (a Being conjured *as* a face-up Prophecy — the
      opposite direction from a Prophecy resolving into a Being) — part of
      the still-open "negate a summon/Prophecy, convert it to/from a
      face-up Prophecy" conversion subsystem, alongside Delay, Waning
      Words, and Rewrite the Past (see "Second wave" and "Third wave"
      below).
- **Shifting Sands** (the token Al khali creates, and a real drawable card
  in its own right) is the first "Beings may move across this" Relic
  (RULES.md > Keywords) to actually exist on the board, so it's also the
  first real exercise of that whole mechanic end-to-end: enters with 2
  Crossing Counters (`armamentCounterGrant`, same field a "When summoned
  gain (N) Counters" Armament already used — now also read by `PLACE_RELIC`
  and the relic branch of `placeTokenOnBoard`, not just `ATTACH_ARMAMENT`),
  and its own "Engage: Remove (1) Crossing Counter, then move target Being
  you control to this tile" is real too — a new `RELIC_COUNTER_MOVE_RE`
  pattern (the ground-Relic analog of `ARMAMENT_COUNTER_MOVE_RE`), gated on
  having enough of its own Counters (`groundRelicEngageCostPayable`),
  spending them, and then either auto-resolving or offering a new
  `move-target-being` pendingChoice when the controller has more than one
  Being to choose from. A dedicated `ACTIVATE_GROUND_RELIC_ENGAGE` action
  (parallel to `ACTIVATE_ENGAGE`, since a ground Relic lives outside
  `board` and so can't reuse that reducer case directly) handles the
  activation itself. **The `move-target-being` pendingChoice had no
  `Match.jsx` UI at all for its first round** — the engine-side choice
  (`getLegalActions` offering `RESOLVE_MOVE_TARGET_BEING`) worked and was
  test-covered, but nothing rendered it, so a controller with more than one
  Being genuinely couldn't resolve the choice in the actual app (it auto-
  resolved fine with exactly one candidate, which is why this wasn't
  caught earlier). Fixed with a modal mirroring the existing
  `free-move`/`summon-from-purgatory` pattern.
- **Deja Vu** ("Return target Being that you control with cost (X) to your
  hand, then Summon it without paying its summoning cost. Pay (2)
  additional Timeless Essence to target a Deity.") — the first card whose
  own printed cost includes a genuine **X pip** (`"X, 2 Timeless"`), and
  the user's own ruling on it: the (X) IS the target's own total casting
  cost, read back at cast time, not a separate filter number — "the first
  instance of a cast widening midway through" (legal targets depend on the
  combined cost, which itself depends on which target is picked).
  - `toGameCard` (cardData.js) was **silently dropping an X cost pip**
    entirely (treated as value 0, no marker kept) — a real, pre-existing
    gap this card exposed. Fixed with a new `castingCost.xCostColor` field:
    `''` when X was printed in the generic/faithless slot (Deja Vu's own
    case), a color name when printed with one, and the key is absent
    entirely for any card with no X cost at all. (Blood Rites also prints
    an X cost — `"X, Bleeding"` — its bare "Bleeding" segment with no
    leading number was silently unparseable at the time; fixed later, in
    the "Re-audit round" section below, once Blood Rites' own mechanic was
    actually built — `parseEffigyCost` now treats a bare color word with
    no leading number as a real, fixed "1 <color>" pip, the only real cost
    string in the set that needs it.)
  - `dejaVuCombinedCost` (actions.js) computes the real cost for a given
    target on the fly: Deja Vu's own printed cost, plus the target's own
    `totalCastingCost` folded into whichever slot `xCostColor` names, plus
    a further (2) Timeless surcharge (`dejaVuDeitySurcharge`, its own
    separate printed line) when the target is a Deity — which is also what
    makes a Deity a legal target at all here, the one deliberate exception
    to "target Being" normally excluding Deities elsewhere in this engine.
  - `dejaVuCandidates` restricts the legal-target set up front to only the
    player's own Beings (Deities included) whose *combined* cost is
    actually payable — checked both before ever offering `CAST_CONJURING`
    for this card (the graceful non-offer precedent every other
    additional-cost gate uses) and again as the frozen candidate list on
    the `deja-vu-target` pendingChoice it opens.
  - Casting it pays **nothing** up front — the card just leaves hand
    (irreversibly committed, same as any Conjuring) into a pendingChoice;
    the whole combined cost is paid only once a target is actually chosen
    (`RESOLVE_DEJA_VU_TARGET`), since it can't be known before then. On
    resolution: any Armaments/Dryad mount on the target are dropped in
    place (same as any other "leaves the board" event), then the target is
    summoned right back on the exact same tile for free via the same
    `placeBeingOnBoard` every normal summon uses — **unconditional and
    immediate**, per the user's own ruling ("the summoning can not be
    stopped since it is a part of the card resolution"), so its own When
    Summoned retriggers exactly like a fresh real summon. One documented
    edge case left as-is (no real card combination exercises it today): if
    the target had a Dryad rider attached, the rider is left behind on the
    tile as normal, but `placeBeingOnBoard`'s own "something's still
    there" branch then treats it as a sacrifice-and-overwrite (the
    existing Lesser Summoning Circle precedent) rather than re-attaching
    the returning Being onto it.
- **Immen Gorta, the Boundless Hunger** — "As an additional cost to
  summon, Sacrifice (2) Beings." A Being/Deity's own mirror of an Altar's
  `conjureCost` (a real *additional* cost paid on top of the normal
  summoning cost), captured as a plain count
  (`keywords.additionalSummonCostSacrificeBeings`) rather than free text,
  since `SUMMON_BEING` needs a real number up front to gate offering the
  summon at all — same graceful non-offer precedent as every other
  additional-cost gate (Desperate Finale, Strike Down, Deja Vu above):
  never offered without at least that many of the player's own Beings
  already on board. The normal summoning cost (5 Formless) is paid first,
  same order Desperate Finale's own additional-cost precedent uses, but
  placement itself waits on a new `summon-sacrifice-cost` pendingChoice —
  click a highlighted own Being to sacrifice one at a time (reusing the
  same click-a-highlighted-tile board interaction as every other
  single-target choice, not a toggle-then-confirm picker, since the count
  is always exactly 2, never variable), resolving automatically and
  placing Immen Gorta (retriggering When Summoned normally) once enough
  are picked. The card object itself is stashed directly on the
  pendingChoice, since by this point it's no longer in hand, Purgatory, or
  anywhere else to look back up.

## Re-audit round — 22 more gaps closed

Following the Deja Vu / Immen Gorta round, every card in the set was
re-checked directly against the live parser and reducer (not trusted from
a prior status doc), surfacing 86 real gaps across 70 cards — most of them
small (a CSV typo breaking a regex, a second clause silently dropped after
the first matched) rather than missing subsystems. 22 of the
straightforward ones were closed in this same pass (the rest — ones
needing a genuinely new subsystem, like continuous board-wide auras or a
"becomes a face-up Prophecy" conversion, or ones whose own printed
wording was ambiguous enough to need a ruling — are tracked in the "Still
Unwired" doc, not here):

- **Imneyat Dryad** — its own trigger text typos its own name ("Imneyat
  Druid"); tolerated the same way "Diety"/"additonal" already are.
- **Samara Seed / Seed of Divinity** — "Remove (N) Counters, Martyr: X" on
  one line broke `martyrMatch`'s own line-start anchor; new
  `martyrCounterCost` keyword + a real gate/spend in `ACTIVATE_MARTYR`.
- **Melting Clock** — "Pay (N) Essence, Martyr: X" gets the same treatment
  via a sibling `martyrEffigyCost` keyword — was resolving for free before.
- **Canopic Jar** — its own "Whenever a Being dies add (N) Counter to
  this" (reversed word order from the one existing pattern) now parses.
- **Saan tachīan Hunger** — bare "Gain +N/+N" is a real, permanent,
  stacking self-buff via the existing `permanentBonus` primitive.
- **Onagīous Hunger** — bare "Discard a &lt;Typing&gt;" (no attached draw)
  is its own pattern now, reusing `discard-kind-draw`'s shape with
  `drawCount: 0` — distinct from `matchesDiscardKind` (`card.kind`, e.g.
  Relic/Conjuring) via a new `matchesDiscardTyping` (`card.typing`).
- **Pangs of Hunger** — "Deal (N) damage to all Beings" is a real
  board-wide hit, either side, no "you control" qualifier.
- **Cycle of Hunger** — "Shuffle (N) &lt;Typing&gt;s..." (a fixed plural
  count) reuses the existing "up to N" toggle picker.
- **Cursed Commission** — `SUMMON_TOKEN_POINTED_RE` widened to accept "a
  tile" (singular), not just "any tile", this points to.
- **Smite** — new `DESTROY_BEING_POINTED_RE`, reusing the existing
  `sacrifice-pointed-target` shape and `destroyBeing`'s own no-death-damage
  ending (matches the card's own parenthetical exactly).
- **Locust swarm** — "Depart: Locust Swarm Shifts (3)" pulls the
  just-departed card back out of Purgatory and Shifts it, reusing Echoes
  of the Boundless' own `offerOrShiftFromPurgatory` machinery — Depart (and
  a face-up Prophecy's own flip-trigger lines) now runs the card's own
  name-substitution (`selfReferentialWhenSummonedText`) first, same as
  When Summoned/onMove already do, so this needed no bespoke pattern.
- **Cutlass** — "When the attached Being dies sacrifice this and summon a
  token on this tile" is a new Armament reaction point
  (`triggerOnAttachedBeingDied`), wired into all four real death paths
  (`dealDamageToBeing`, `destroyBeing`, and both branches of
  `resolveAttackFrom`'s own combat resolution).
- **Void Channeler** — "Gain (1) Crossing Counter each time you Conjure"
  is a new trigger point fired from `CAST_CONJURING`.
- **For the Greater Good** — "Discard a Being: Draw one card. If you
  discarded a Turanga draw one additional card." — the bonus draw is
  checked against whichever specific card actually got discarded.
- **Erroneous Evocation** — its own trailing "your opponent summons a
  Vassal token" no longer gets silently dropped by the leading deck
  search; also exposed a second bug — its own redundant "Demon *Being*"
  phrasing doesn't literally substring-match the real "Demon, Being"
  typing, so the query strips a trailing " Being" before searching.
- **Book of Mahatzu** — "Discard a Spirit, add a Turanga to hand from your
  Purgatory" now enforces the discard as a real cost gating the search
  (was resolving the search for free).
- **Skeptical Scrawling** — bare "Discard (1) Card" (own choice, no "at
  random") and "return a &lt;X&gt; from Purgatory to hand" (the reverse
  word order of the existing "Add X to hand from Purgatory") are both new,
  small, reusable patterns.
- **Seasons of Regrowth** — "Discard your hand then draw cards equal to
  the number of cards that you discarded" is its own single pattern
  (excluded from the generic "then"-split, since the draw count depends on
  the discard that JUST happened).
- **Rejuvinating Waters / Festival of Monatssa** — "Gain (N) Lifespan for
  each &lt;Typing list&gt; you control" / "Draw (N) Card for each Being
  you control with &lt;Keyword&gt;" both scale with a real live count
  instead of resolving as a flat amount.

## Second wave — 9 cards closed after the user's own rulings

The 11 items the re-audit round couldn't resolve on its own (2 needing a
genuinely new subsystem, 9 needing a call only the user could make) got
those rulings, and all 9 of the card-specific ones are now built. The 2
subsystem questions (a continuous board-wide aura; a "becomes a face-up
Prophecy" conversion) were still open as of this wave. **Update:** the
board-wide aura primitive was built in the "Fifth wave" below and is fully
closed; the face-up-Prophecy conversion is still the one open subsystem gap
(Delay, Waning Words, Rewrite the Past, Prophesize).

- **Boknea Druid** — "Dryad. This may be summoned directly onto another
  TreeFolk, Vine, or Seed." Ruled: the same Dryad-attach a move onto one
  would trigger, offered as an extra legal `SUMMON_BEING` destination.
  `placeBeingOnBoard` now has a real Dryad-attach branch (previously only
  `MOVE_OR_ATTACK`'s own move logic could attach) — same
  `dryadAttachTargetOk`/`applyDryadAttachLifespanBonus`/
  `triggerOnDryadAttachedOnto` machinery either path reaches.
- **Vaneach Hunger** — "You may pay an additional (1) Formless to summon
  'Prophetic Hunger' in the Ethereal Realm with (1) Time Counter." Ruled:
  "Prophetic Hunger" is a stale name from before the card was renamed and
  just refers to itself — a genuine alternate summon mode. New
  `SUMMON_AS_PROPHECY` action, offered alongside the normal `SUMMON_BEING`
  whenever the combined (base + extra) cost is affordable; places the card
  straight into the Ethereal Realm via the exact same
  `offerOrShiftFromPurgatory` machinery Echoes of the Boundless already
  uses (a shifted-shaped Prophecy, never touching Purgatory at all since
  it came straight from hand).
- **Vicious Vittles** — "As an additional cost to summon your next Hunger
  this turn, sacrifice this and summon the hunger on this tile." Ruled:
  sacrifices itself and the next Hunger lands directly on its own tile.
  A new one-shot state flag (`nextHungerFreeSummonOnTile`, cleared at end
  of turn like `nextBeingCostReduction`) — `SUMMON_BEING` offers the
  flagged tile as an extra destination for any Hunger-typed hand card,
  and consuming it sacrifices Vicious Vittles (by instance, not name —
  it could in principle die before then) right before placing the Hunger.
- **Envoy of the Hungers** — "switch this Being with a Hunger you
  control." Ruled: a real board-position swap, each Being keeping its own
  stats/counters/engaged state — new `SWITCH_WITH_TYPED_RE` pattern.
- **Grand Germination** — "Trigger all Martyr abilities on Seeds you
  control ignoring costs." Ruled: every matching Seed's own Martyr text
  resolves for real, but none of them are sacrificed, and any additional
  cost before the colon (`martyrCounterCost`/`martyrEffigyCost`) is
  waived too — a new pattern that calls `resolveOrLogEffect` directly per
  Seed instead of going through `ACTIVATE_MARTYR` at all.
- **Conscription** — "All Beings move forward if possible. Any that move
  do not disengage during disengage step. If none move, choose two
  Beings they Engage in combat." Ruled: the controller chooses, one Being
  per side. Both this and Tactical Withdraw's own "All Beings move
  backward" share a new mass-move pattern (every Being on board, either
  side, checked against its own printed Arrows); since the Prophecy
  flip-trigger resolves each line of text as an independent
  `resolveOrLogEffect` call, whether anything actually moved is threaded
  to the following "If none move..." line via a one-shot scratch flag on
  state itself (`lastMassMoveNoneMoved`). The forced-combat fallback
  reuses `effectiveStrength`/`dealDamageToBeing` directly (a new
  `forceCombatBetween` helper) — a deliberately simplified Strength trade,
  not a full copy of `resolveAttackFrom`'s own Favor Counter/Unruly/
  combat-reaction handling, since nothing in this specific forced
  engagement calls for those.
- **Planchette** — confirmed to already print "Beings may move across
  this" (the co-location clause was already there, just missed on a first
  read). Both of its other clauses are now real: "lose Lifespan equal to
  the Lifespan of the Being on this tile" is a new end-of-turn scan over
  `state.groundRelics` (`applyEndOfTurnGroundRelicCoLocatedLifespanLoss`,
  turn.js); "Being gains 'Martyr: X'" is a new granted-Martyr primitive
  (`grantedMartyr` keyword + `effectiveMartyr` helper, actions.js) — the
  first "a ground Relic grants an ability to whatever Being shares its
  tile" case in the engine, mirroring the existing granted-Engage-via-
  Armament shape but sourced from `groundRelics` instead.
- **Brick** — "Engage: Deal (1) Damge to target Being, then move Brick to
  the tile occupied by the targeted Being." Ruled: the move happens
  regardless of whether the target died. Matched as one whole pattern
  (excluded from the generic then-split, since the move needs to know
  which tile the damage half actually targeted) with the CSV's own
  "Damge" typo tolerated inline; a new `moveNamedArmamentToTile` helper
  relocates it to a freestanding pile if the target died, or onto the
  target's own pile if it survived.
- **Blood Rites** — "Add an Armament that costs (X) from deck to hand,"
  cost "X, Bleeding." Ruled: (X) is the same X paid into the card's own
  cost — search for an Armament costing exactly however much was paid.
  Two real gaps this exposed and fixed along the way: `parseEffigyCost`
  was silently dropping a bare color word with no leading number at all
  (only Blood Rites' own "Bleeding" segment in the whole set does this —
  now a real, fixed "1 Bleeding" pip); and casting it needed a genuinely
  new "the caster freely picks a non-negative integer, pays that much
  generic Essence, then the picked value drives a search filter" primitive
  (`choose-x-value` pendingChoice) — nothing else in the engine lets a
  player choose an arbitrary X rather than deriving one from a target or a
  board count. Reuses the *existing* `search` pendingChoice's own
  `costFilter` field (Death's Decanter) for the actual deck search, rather
  than inventing a new search mechanism.

## Third wave — 12 more Still Unwired gaps closed

Continuing "Still Unwired" cleanup with no further rulings needed — every
card here was buildable directly from its printed text. Two open
subsystem-level questions (a continuous board-wide aura; a "becomes a
face-up Prophecy" conversion) were still deferred as of this wave, unchanged
from the Second wave. **Update:** the board-wide aura primitive closed in
the "Fifth wave" below; the face-up-Prophecy conversion remains open.

- **Passing Doubt** — "At the end of your turn target Doubt you control
  is dealt (1) Lifespan Damage." New end-of-turn scan
  (`applyEndOfTurnDamageNamedFamily`, turn.js) over the turn player's own
  Beings whose name contains a printed family word ("Doubt"), excluding
  itself — real Lifespan damage via the now-exported `dealDamageToBeing`.
- **Illegible Grimoire** / **Witching Well** — "Flip a coin, if heads X,
  if tails Y." A new fully generic `GENERIC_COIN_FLIP_RE`, checked before
  the pre-existing hardcoded `COIN_FLIP_DAMAGE_RE` (which still wins for
  its own card): flips randomly, then recurses `resolveOrLogEffect` on
  whichever branch's text. Witching Well's own tails clause ("look at the
  top card of your opponents deck, you may have them shuffle") reuses
  Foresight's pre-existing `shuffle-or-keep` pendingChoice — that shared
  pattern was widened to also accept "your opponents deck" and a comma
  instead of a period before "you may", both real phrasings this card
  needed that Foresight's own text didn't exercise.
- **Exactly on TIme** — "Add a Timless Being that costs (3) or more from
  deck to hand" (typo and redundant "Being" suffix both tolerated, same
  treatment as Erroneous Evocation/Skeptical Scrawling). New
  `minCostFilter` field on the existing `search` pendingChoice (a floor,
  alongside Death's Decanter's exact-match `costFilter`) — now enforced
  in `RESOLVE_CHOICE`'s reducer itself, not just the legal-actions filter,
  so a candidate below the floor can never be selected even off a
  hand-crafted action.
- **Time Capsule** — "Whenever you Modulate (-1) except due to the
  Modulate Step, add (1) Time Counter to this." New
  `triggerModulateMinusOneCounterGain`, fired from all 3 real
  player-activated `RESOLVE_MODULATE` sites (altar/Prophecy/other
  occupant), never from the automatic per-turn tick — same "except due to
  the Modulate Step" exclusion Temporal Anomaly's own growth trigger
  already established.
- **Time Keeper** — "Modulate (±1) a target this points to." New
  `MODULATE_POINTED_RE`, checked before the bare `MODULATE_RE`: opens the
  existing `modulate` pendingChoice with a new `allowedCells` field
  (Arrow-derived), respected by both real offering sites (board occupant
  and altar) so only the pointed permanent is ever selectable.
- **Horologist's Apprentice** — two abilities. "Gain (1) Time Counter
  whenever a Time Counter is removed from a Prophecy you control" reuses
  Hourglass's existing `collectsRemovedProphecyTimeCounters` keyword,
  widened to also match this card's reversed phrasing, and
  `triggerHourglassCollection` widened to scan Beings, not just Relics.
  "Once per turn remove (3) Time Counters: Shuffle a random card from
  hand into deck, then draw (1) Card" is a new generic
  `REMOVE_OWN_COUNTERS_THEN_RE` ("Remove (N) Type Counters: effect",
  colon-separated) plus a new bare `SHUFFLE_RANDOM_HAND_CARD_INTO_DECK_RE`
  for the first half of its own "then".
- **Balance the Scales** — "Sacrifice a Being: Each opponent sacrifices a
  Being" — omits "you control" on the cost and says "Each" instead of
  "target" on the effect (a 2-player-game synonym). Both the existing
  `SACRIFICE_BEING_COST_RE` and `OPPONENT_SACRIFICE_RE` widened to accept
  either phrasing.
- **Blood Moon** — "Gain (1) Time Counter. Whenever a Being dies its
  controller gives a different target Being +1/+1" — the second line is a
  genuine passive, board-wide reaction with no "you control" on its own
  trigger (fires off ANY death, either side, buffing whichever side lost
  the Being). New `triggerAnyBeingDiedGiveDifferentBuff`, sourced by
  scanning for a live face-up Prophecy carrying the keyword — the same
  "read live off the board, not a stored flag" precedent
  `controllerSkipsDraw` (Daylight Savings) already established. Wired
  into all 5 real death trigger points (`dealDamageToBeing`,
  `destroyBeing`, both `resolveAttackFrom` death branches,
  `ACTIVATE_MARTYR`); the Prophecy flip-trigger's own per-line loop skips
  this line so it isn't also resolved as a one-time effect.
- **Canopic Jar** — second ability, "Engage: Remove (4) Crossing Counters
  Shuffle a Being from Purgatory into it's owners deck, they draw (1)
  card" — no punctuation between the counter cost and the effect. New
  `REMOVE_OWN_COUNTERS_SHUFFLE_PURGATORY_DRAW_RE`, a bespoke match for
  this exact unpunctuated shape. **Had to be checked before the
  unanchored `DRAW_CARDS_RE`** — its own trailing "draw (1) card" would
  otherwise match as a bare substring of the whole text and silently
  skip the counter spend and Purgatory shuffle entirely, the same
  ordering hazard Book of Mahatzu's discard clause hit in the Re-audit
  round (and the same fix the generic coin flip above needed for the
  identical reason).
- **May Break my Bones** — "Choose a Being this points to, destroy it and
  Summon a Bag o' Bones token on that tile." New
  `DESTROY_POINTED_SUMMON_TOKEN_HERE_RE` + `destroy-pointed-summon-token`
  pendingChoice: destroys the target via the existing `destroyBeing`,
  then places the named token (`TOKEN_REGISTRY` lookup) on that same
  now-vacated tile via `placeTokenOnBoard`.
- **Mirage Visage** — "Choose (2) Beings this points to, become Favored."
  New `FAVOR_POINTED_MULTI_RE` + `favor-pointed-toggle` pendingChoice
  (toggle-then-confirm, like the existing typed-buff toggles): when the
  number of pointed Beings is at or under the printed count, all of them
  become Favored automatically with no choice needed; above that count,
  the player toggles up to the printed maximum before confirming.
- **Stuck-pendingChoice safety net** — with ~150 call sites now opening a
  `pendingChoice`, a future one that skips its own "no legal candidates,
  fall back to a log line" check would otherwise deadlock the whole game:
  once a `pendingChoice` exists, `getLegalActions` returns nothing at all
  for anyone but its own owner, and the AI's own turn loop
  (`useGameEngine.js`) just silently does nothing when it has no legal
  move to make — freezing a bot-owned choice forever with no way for the
  human to intervene either. `gameReducer` now runs a
  `clearStuckPendingChoice` pass after every action: if a `pendingChoice`
  is left standing with zero legal actions for its own owner, it's
  cleared automatically with a log line, rather than trusting every
  effect (present and future) to have gotten its own zero-candidate check
  right.

## Fourth wave — 12 more cards closed, plus one previously-stale gap

Continuing "Still Unwired" cleanup with no rulings needed. This round's
biggest find wasn't a new card at all: **Vadē Rah** had been marked
blocked by a comment claiming "a Relic and a Being to share one board cell"
was impossible — but the Being-Relic co-location primitive (`groundRelics`,
see below) had already solved exactly that, in an earlier round, for a
different card (Planchette). The comment was simply never updated when
that landed, so a genuinely-buildable card sat marked as blocked. Re-
checking every remaining "blocked" claim against the LIVE code rather than
trusting an older comment or doc is worth doing periodically for exactly
this reason.

- **Metal Worker** — "Once per turn, you may Pay (1) Bleeding Essence: The
  next Relic you summon this turn costs (-2) Faithless." The cost-
  reduction half was already built (`nextRelicCostReduction`, from an
  earlier round); the gap was purely in *reaching* it — the existing
  `payEffigyCostAbility` pattern only recognized "Pay (N) &lt;Color&gt;:"
  (no words in between), and this card's own "Once per turn, you may " prefix
  plus a trailing "Essence" before the colon broke the match entirely.
  Both are now optional pieces of the same regex; the "Once per turn"
  case reuses `timesPerTurnAbility`'s own `timesPerTurnUsed` counter/reset,
  just capped at 1 instead of a printed N.
- **Strike the Ore** — "Engage a Being you control: Draw (1) card." The
  unanchored `DRAW_CARDS_RE` was matching the effect half as a bare
  substring and drawing unconditionally, never enforcing the Engage cost —
  the same ordering hazard as Canopic Jar/the generic coin flip in the
  Third wave, fixed the same way (checked earlier, opens a
  `sacrifice-being-cost`-shaped `engage-being-cost` pendingChoice when more
  than one of the caster's own Beings could pay it).
- **Collapsing Bridge** — "Engage: Remove (1) Crossing Counter, you may
  summon a Being on a tile that Collapsing Bridge points to." The counter-
  removal half worked; the summon half never did. New
  `summon-hand-being-pointed` pendingChoice (any affordable Being from
  hand, restricted to the pointed tile, `optional: true`) — a genuinely
  reusable primitive for any future "you may summon a Being on a tile X
  points to" card, not just this one.
- **Hurry Up and Wait** — "Modulate (-1) and Modulate (+1)." The generic
  Modulate resolver only ever reads the FIRST `Modulate (N)` in a line
  (real "and"-joined clauses like this one are rare enough that a generic
  "and"-split felt riskier than a bespoke anchor). New `thenDelta` field on
  the existing `modulate` pendingChoice — the same "thread a continuation
  through the choice itself" shape Time Capsule's own same-delta `repeat`
  already established, just for a *different* second delta instead of a
  repeat of the first.
- **Propagate** — "If you control a TreeFolk, draw (1) Card.\nIf you
  control a Vine, add a TreeFollk to hand from your Purgatory.\nIf you
  control both you may do both." A plain Conjuring's whole textBox
  resolves as ONE string (unlike a Prophecy's own flip-trigger, which
  splits per line) — so whichever generic pattern matched anywhere in the
  combined text won, regardless of which line's own condition it
  belonged to. Bespoke two-condition split (not a generic newline split,
  which risks wrongly breaking apart other cards' genuinely-linked
  multi-line text) plus a new generic `hasOwnTyping` helper (mirroring
  `hasOwnProphecy`); the CSV's own "TreeFollk" typo tolerated inline.
- **The Roots Remember** — "Gain (1) Time Counter.\n If there are (0) Time
  Counters on this conjure a (Living) Prophecy from your Purgatory." A
  real, subtle ordering question: since the FIRST line's own "Gain (1)
  Time Counter" always runs before the second line is even reached, the
  second line's condition is checked AFTER that gain already happened —
  meaning under normal play this line is essentially unreachable (the gain
  always makes the Time Counter count nonzero first). Built to genuinely
  re-check the live count at the moment it resolves, not hardcoded true,
  so it behaves correctly whatever order the surrounding lines actually
  leave the board in, rather than taking the printed condition on faith.
  New `conjureProphecyFromPurgatory` helper — a REAL conjure (keeps its
  own printed text, flips and resolves normally later), distinct from
  `shiftFromPurgatory`'s existing Shift-shaped placement (which
  deliberately loses all other text).
- **Shovel** — "Being gains: 'Engage: Sacrifice Shovel, then reveal the
  top (3) cards of your deck, you may add any Relics revealed to hand,
  shuffle the others back into your deck'." A granted-Engage Armament
  naming ITSELF by its own printed name in the granted text — but the
  `cardName` resolveOrLogEffect receives for a granted-Engage ability is
  the WEARER's name (see ACTIVATE_ENGAGE), not the Armament's, so the
  usual self-name substitution doesn't apply here at all. Captured the
  Armament's own name directly out of the "Sacrifice X" clause instead of
  relying on `cardName` matching anything. The reveal/shuffle half reuses
  the exact same shape `REVEAL_TOP_SEED_TO_HAND_SHUFFLE_RE` (Farm Hand)
  already established, just filtered to Relics instead of Seed Beings.
- **White Whisker** — "Engage: Add a Familiar to hand from deck.\nSacrifice
  this when you summon a Familiar." The search half worked; the reactive
  sacrifice half didn't exist as a trigger point at all. New
  `sacrificeSelfOnSummonTyping` keyword + `triggerSacrificeSelfOnSummonTyping`,
  called from the shared `placeBeingOnBoard` right alongside the existing
  `triggerTypedSummonReactions` (a Being's own version of the same idea) —
  so it fires off EVERY summon path (SUMMON_BEING, Deja Vu, Invoke, Boknea
  Druid's Dryad-attach, etc.), not just the obvious one.
- **Willing Sacrifice** — "Until end of turn target Being gains: 'Martyr:
  Craft (1) Effigy'." No "you control" on the target, so either player's
  Being is legal. New `grantedMartyrUntilEndOfTurn` occupant field, read by
  `effectiveMartyr` alongside its existing permanent `grantedMartyr`
  (groundRelic) fallback — cleared at end of turn (turn.js), same
  either-owner unconditional-clear treatment as `strengthSetUntilEndOfTurn`
  and friends.
- **Engrave** — "Beings you control gain 'Depart: Summon a Bag o' Bones
  token'." A ONE-TIME grant (this is an Ethereal Conjuring, resolved once
  on cast, not a continuous aura) applied directly onto every Being the
  caster controls at that exact moment — a Being summoned afterward never
  sees it, matching the printed present-tense "gain" rather than a
  standing rule. New `grantedDepart` occupant field, read by
  `logDepartIfPresent` alongside the card's own printed `depart` keyword;
  threaded through all 4 of that function's "minimal occupant" call sites
  (`dealDamageToBeing`, both `resolveAttackFrom` combat-death branches),
  since only one of the five real call sites was already passing the full
  occupant object.
- **Natures Bounty** — "Gain (1) Time Counter\nTreeFolk, Vine, and Seeds
  you control gain: 'Engage: add (1) Living'." Same one-time-grant shape
  as Engrave, just filtered to a list of typings instead of every Being,
  and granting Engage instead of Depart — new `grantedEngage` occupant
  field, read by `effectiveEngage` alongside its existing Armament-granted
  fallback.
- **Vadē Rah** — "If this is engaged at the end of the turn sacrifice it.
  \nEngage, Sacrifice the Being on this tile: add a Rhak-tùrin Deity to
  hand from deck that shares a type with the sacrificed Being.\n Beings
  may move across Vadē Rah." Two of the three lines were already fully
  working from earlier rounds (`sacrificeIfEngagedAtEndOfTurn`,
  `beingsMayMoveAcross`) — only the middle Engage ability was ever
  unreachable, and only because of the stale "can't co-locate" comment
  described above. New `SACRIFICE_CO_LOCATED_BEING_RE` shape for
  `groundRelicEngageCostPayable`/`ACTIVATE_GROUND_RELIC_ENGAGE` (sacrifices
  whatever Being shares THIS Relic's own tile, as opposed to
  `SACRIFICE_NAMED_RE`'s board-wide name/typing search for every other
  "Engage, Sacrifice X: Y" card), plus a new `sharedTypings` filter on the
  existing `search` pendingChoice (alongside Death's Decanter's
  `costFilter` and Exactly on TIme's `minCostFilter`) so the deck search
  is restricted to whatever typing the just-sacrificed Being carried.

## Fifth wave — a new board-wide aura primitive, plus three real bugs a live playtest found

This round mixed two things: closing 4 more Still Unwired gaps that all
needed the SAME new primitive, and three real bugs the user found by
actually playing (not from the audit list) — two silent gaps and one
genuinely wrong ruling this session had shipped in an earlier round.

**New primitive: live board-wide Being-stat auras** (`boardWideAllyBonus`/
`boardWideEnemyBonus` keywords, `recomputeBoardWideAuraBonuses`/
`boardWideAuraBonusTarget`, wired into `gameReducer`'s wrapper and
`beginTurn` right alongside `recomputeConditionalBonuses`, same
`dealDamageToBeing`-routed Strength-live/Lifespan-baked-in split every
other live bonus in this file already uses). A source is only "live" while
it's a face-up Prophecy still holding Time Counters — same "read live off
the board, not a stored flag" convention Daylight Savings/Blood Moon's own
ongoing passives already established. Closed:
- **Growth Spurt** — "Beings you control have +1/+0, if any of those
  beings are TreeFolk, they gain +2/+0 instead." The typing-conditional
  override is optional on the keyword; most cards using this shape (the
  two tokens below) don't have one.
- **Crathea** — "When summoned create a face up Blooming Life token... or
  a Withering Life token...." New `create-token-choice` pendingChoice (a
  fixed 2-option choice, generic over any future "create X token... or Y
  token..." card) plus a new `'prophecy'` branch on `placeTokenOnBoard`
  (a created-face-up Prophecy token starts with its full printed Time
  Counters already showing, unlike a normally-CAST one, which starts
  face-down waiting to flip) and a new `ethereal-token-location`
  pendingChoice (the existing `token-location` kind hardcodes Mortal Realm
  cells, so it can't be reused for a Prophecy token's Ethereal Realm
  placement). `createTokenCard` (cardData.js) gained an optional `timer`
  param — it always hardcoded Timer to 0 before, which no Prophecy-kind
  token could ever need until this one.
- **Blooming Life** / **Withering Life** (tokens) — `boardWideAllyBonus`/
  `boardWideEnemyBonus` respectively, new `TOKEN_REGISTRY` entries.

**Bugs a live playtest found, not the audit:**
- **Happy Hammer didn't move onto an Animated Armament landing on an empty
  tile.** Its real "whenever a Being is summoned under your control, move
  and attach to that Being" trigger was already fully built and tested —
  but only ever fired from `placeBeingOnBoard` (a normal Being/Deity).
  Dancing Swords ("Animated... treated as a Being while in the Mortal
  Realm") lands via `ATTACH_ARMAMENT` instead, which never called it. Now
  does, whenever an Animated Armament lands on a previously EMPTY tile
  (making it the acting top of a brand-new pile — a real Being being
  summoned) — attaching onto an existing Being or existing pile doesn't
  qualify, since a Being was already there either way.
- **Mausoleum Gates' own "you may summon Undead from your Purgatory until
  the end of your turn" window had no button anywhere in the app.** The
  engine side (`SUMMON_TYPED_FROM_PURGATORY_WINDOW_RE`,
  `summonTypedFromPurgatoryWindows`, `ACTIVATE_SUMMON_TYPED_FROM_PURGATORY_WINDOW`)
  was fully built and correctly offered by `getLegalActions` — but nothing
  in Match.jsx ever dispatched it, the same "real, tested engine mechanic,
  zero UI wiring" gap the Shift-family actions hit in an earlier round.
  Clicking an eligible Purgatory entry while the window is open now
  dispatches it directly (a single click — unlike Roots of Eternity's own
  two-step reanimate-then-pick-a-tile flow, this either places immediately
  or opens the already-wired `token-location` choice on its own).
- **Singularity survived at 0 Lifespan instead of dying.** "has -X/-X
  where X equals the number of Time Counters that you control"
  (`recomputeXBeings`) used to floor the live Lifespan penalty at 0 and
  leave it sitting on the board, a DELIBERATE decision from an earlier
  round ("a pre-existing, tested 'floor at 0, don't die' precedent") — but
  RULES.md is explicit that a Being's Lifespan hitting 0 is a real death,
  no exception carved out for a stat-penalty-driven one. Now routed
  through the same `dealDamageToBeing`-based death pipeline Horological
  Horror's own live-X case (the `isAbsolute` branch right above it in the
  same function) already used — Depart, owner Lifespan loss, and Purgatory
  all fire for real once the penalty reaches its own printed Lifespan.

## Sixth wave — attached-Armament-level Martyr (Armor Animus)

Closes one more Still Unwired gap: **Armor Animus** — "Martyr: Being this
is attatched to gains 'Depart: Summon this in the Mortal Realm engaged'."
This needed a genuinely new primitive: every existing Martyr in this
engine belongs to a whole board occupant (a Being or a standalone Relic —
`effectiveMartyr`/`ACTIVATE_MARTYR`), but Armor Animus's own Martyr
belongs to the ARMAMENT ITSELF, sitting inside its wearer's `armaments`
array — engaging and sacrificing it must leave the wearer completely
untouched, not destroy the whole occupant.

- New `ACTIVATE_ARMAMENT_MARTYR` action, offered per-entry (an
  `occupant.armaments` scan alongside the existing
  `ACTIVATE_ARMAMENT_ENGAGE`/`ACTIVATE_ARMAMENT_SACRIFICE` ones), reusing
  `martyrCostPayable` directly against the Armament entry's own
  `card.keywords`/`counters` (the same shape a board occupant already has,
  so no new cost-check logic was needed) and mirroring `ACTIVATE_MARTYR`'s
  own cost/log shape — just splicing the sacrificed entry out of
  `armaments` instead of clearing a whole cell, and with no Purgatory add
  for it (same "just removed" precedent `ACTIVATE_ARMAMENT_SACRIFICE`
  already established for Tiger Skin's own sacrifice-for-Favored).
- New single-target "Being this is attatched to gains 'Depart: X'"
  pattern (the CSV's own "attatched" typo tolerated inline) — same
  `grantedDepart` field Engrave's board-wide grant already introduced,
  just applied to one Being (`context.selfCellId`, set to the WEARER's own
  cell by `ACTIVATE_ARMAMENT_MARTYR`) instead of every controlled Being.
- New "Summon this in the Mortal Realm engaged" pattern for when that
  granted Depart actually fires later — by the time any Depart resolves,
  the dying Being is already sitting in Purgatory (the normal death
  pipeline sends it there before `logDepartIfPresent` ever runs), so it's
  found there by name, same "pull the just-departed card back out of
  Purgatory" precedent Locust swarm's own Depart-triggered Shift already
  used, just placed normally (`placeBeingOnBoard`) instead of shifted. A
  new `forceEngaged` field on the existing `token-location` pendingChoice
  guarantees it lands engaged even for a Persist Being (whose own default
  placement rule would otherwise leave it disengaged).
- **UI wiring landed in the same pass this time**, not a follow-up gap —
  `ACTIVATE_ARMAMENT_ENGAGE`/`ACTIVATE_ARMAMENT_SACRIFICE` already had
  dedicated buttons in the expanded-Armament-stack view (Match.jsx); a
  matching "Martyr" button was added right alongside them so this doesn't
  become another real-but-invisible mechanic the way Mausoleum Gates' own
  Purgatory-summon window did.

HeartWood Locket shares the same Armament-level Martyr activation gap and
is now unblocked by this primitive too — its own remaining piece (a real
"damage dealt to this Being is dealt directly to its controller instead"
redirect effect) is a separate, still-unbuilt mechanism.

## Seventh wave — two more gaps closed

- **Scā-vuhk Hunger** — "When this moves into the Mortal Realm, sacrifice
  this and create (2) Scā-vuhk Hunger tokens." The trigger point
  (`onMovedIntoMortalRealm`) and the sacrifice half
  (`SACRIFICE_THIS_THEN_RE`) both already existed; the token-creation half
  didn't, for two small reasons: the generic `SUMMON_TOKEN_RE` catch-all
  only recognized "summon," not "create" (now widened — the two verbs are
  already used interchangeably elsewhere in this same CSV, e.g. Hoarder's
  own "create a Rat token"), and `SACRIFICE_THIS_THEN_RE`'s own captured
  effect text kept a stray leading "and" (this card phrases the connector
  as "sacrifice this AND X" instead of the usual comma), which nothing
  downstream expected — stripped at that one call site. New
  `TOKEN_REGISTRY` entry for the token itself, sharing the real card's own
  textBox so a created token can keep chaining the same behavior a real
  copy would.
- **False Testament** — "When conjured you may have this enter with up to
  (5) Time Counters." Its own printed Timer column is the literal letter
  "X" (parsed as 0), meaning its REAL starting Time Counter total is
  entirely the caster's own choice at cast time, not a fixed number. New
  `whenConjuredEnterUpTo` keyword + `choose-prophecy-timer` pendingChoice
  (offered as PLAY_PROPHECY's own tail step, 0 through the printed cap) —
  choosing 0 immediately flips it face up and resolves its own second line
  ("Craft (1) Effigy.") the normal way, same two-phase Prophecy lifecycle
  every other card already follows once a real starting timer is set.

## Being-Relic co-location ("Beings may move across this")

- A Relic printing **"Beings may move across this"** (Shifting Sands,
  Tilled Fields) is placed into a new, separate top-level state field,
  **`groundRelics`** (keyed by cellId — see `createInitialState`'s own
  comment), instead of the normal `board`. This is a deliberately minimal
  way to represent "a Being and a Relic sharing one tile" without a much
  larger rewrite of the one-occupant-per-cell model everywhere else in the
  engine: since a groundRelic-only cell reads as completely empty in
  `board`, every existing occupancy check (movement/summon legality, "does
  this lane block an attack", Armament-attach targeting) already treats it
  as empty with **zero changes needed elsewhere** — and the groundRelic
  entry itself is never touched by any of that, so it genuinely "remains on
  its starting tile even after a Being moves onto/across it," exactly as
  printed. `PLACE_RELIC` and the relic branch of `placeTokenOnBoard` branch
  on `card.keywords.beingsMayMoveAcross` to decide which of the two
  dictionaries a newly-placed Relic goes into; everything else about
  placing it (cost, counters) is identical either way.
- A ground Relic can still carry its own Engage ability (see Shifting
  Sands, above) — offered by a parallel `getLegalActions` block iterating
  `state.groundRelics` instead of `state.board`, and activated via
  `ACTIVATE_GROUND_RELIC_ENGAGE`. `Match.jsx` treats a ground Relic as
  selectable the same way a board Relic is (`isSelectableGroundRelic`),
  but only when nothing from `board` already occupies that same tile —
  a Being sharing the tile takes selection priority, matching how the cell
  visually renders (`Board.jsx`: the Being's own tile art is primary, with
  a small ◆ badge in the corner marking that a Relic is also there).
- **Known simplification**: only "Beings may move across this" is modeled
  as ground-relic co-location. A Relic without that text still fully
  blocks a tile the normal way, unaffected by any of this.
- Al khali the Empty's own arrow-based token summon (see Keywords > Token
  creation) still lands a Shifting Sands token on a tile a Being already
  occupies, co-locating into `groundRelics` instead of being skipped —
  matching how placing one from hand onto an occupied tile already worked.
  Any *other* token still needs a genuinely empty tile.

## Cemetery Physician's own variable-X sacrifice ability

"Once per turn sacrifice (X) Bag o' Bones: Summon a Being from your
Purgatory with cost (X)" — the printed "(X)" is a real variable, not a
fixed number: the player picks how many of the named permanent to sacrifice
right now, and that same count is the Purgatory search's target cost. This
needed a wholly new activated-ability shape (`card.keywords.sacrificeXSummon:
{ fodderName }`, cardData.js), distinct from Engage/Martyr in every way —
not gated by Engage/tap at all, and not a fixed cost.

- **The 3-stage flow**: `ACTIVATE_SACRIFICE_X_SUMMON` opens a
  `'sacrifice-x-toggle'` pendingChoice with an empty `selected: []`;
  `RESOLVE_SACRIFICE_X_TOGGLE` toggles any of the player's own named-Relic
  cells in or out of it (a genuine multi-select, not a single-resolve
  choice like every other pendingChoice kind); `RESOLVE_SACRIFICE_X_CONFIRM`
  — only offered once `selected.length > 0` *and* at least one Purgatory
  Being's `totalCastingCost` (cardData.js) matches that exact count, so the
  player is never let commit to a guaranteed whiff — sacrifices every
  selected cell (`sacrificeOccupantAt`, reused from the existing "Engage,
  Sacrifice a &lt;Name&gt;" cost machinery), flags the source Being
  `usedSacrificeXThisTurn: true`, then searches.
- **Which Being, if more than one matches**: a second pendingChoice,
  `'summon-from-purgatory-cost'` (`{ playerId, cardName, cost }`, no fixed
  cellId), offered via `RESOLVE_SUMMON_FROM_PURGATORY_COST` — a sibling of
  the existing `'summon-from-purgatory'`/`SUMMON_FROM_PURGATORY_RE` kind
  (Grave robber's Martyr), just keyed by cost instead of typing text and
  with no "on this tile" destination baked in.
- **Where to land it**: since the card never says "on this tile," the
  destination is chosen the same way a plain "summon a token" effect with
  no named location is (see Keywords > Token creation) — reusing the
  *same* `'token-location'` pendingChoice kind via a new
  `purgatoryInstanceId` payload alongside its existing `tokenName` one
  (`RESOLVE_TOKEN_LOCATION` branches on which is present). One empty
  Mortal Realm cell places directly; more than one opens the same
  highlighted-tile-click UI Cookie's Bag o' Bones placement already uses.
  `summonFromPurgatoryToOpenCell` (actions.js) is the shared helper behind
  both this and the "which Being" stage above — the card stays in
  Purgatory until it's actually placed, not removed early.
- **Once per turn**: `occupant.usedSacrificeXThisTurn` resets in
  `disengage()` (turn.js) for the ability's own controller at the start of
  their next turn, the same step `doesNotDisengage` resets in — even
  though this ability isn't gated by Engage/tap at all, so it needed its
  own flag rather than reusing `engaged`.
- **UI**: a "Sacrifice" trigger button sits alongside Martyr/Engage in the
  relocated ability panel (see Match.jsx layout, below); while the toggle
  choice is open, every fodder tile the player controls highlights amber
  (selectable) or fills solid red (`toggledCells` prop, Board.jsx — a new,
  distinct ring style from the normal amber "legal destination" highlight)
  when clicked into the selection, and a non-blocking banner shows the
  current count with Confirm/Cancel buttons.

## Crucible's counter-cost Engage: "Remove (N) &lt;Type&gt; Counter(s): Engage then &lt;effect&gt;"

A second real activated-ability cost shape, distinct from Shifting Sands'
`RELIC_COUNTER_MOVE_RE` (which is one hardcoded effect for a ground Relic
specifically): here the cost — spending the Relic's own Counters — comes
*before* the colon and includes Engaging (tapping) it as part of paying,
then whatever text follows resolves as a normal, generic effect. Captured
as `card.keywords.engageCounterCost: { type, amount }` (cardData.js,
`counterCostEngageMatch`, checked before the plain "Engage: X" pattern so
it wins deterministically), alongside the ordinary `engage` field holding
just the effect text. `getLegalActions`' board-Relic Engage-offering block
and `ACTIVATE_ENGAGE` both gate/pay it the same way `engageExtraCost`
already works, just checking/spending `occupant.counters[type]` instead of
sacrificing a permanent. Crucible itself: "When Summoned gain (2) Forge
Counters" (already worked, via the pre-existing `armamentCounterGrant`
field) + "Remove (1) Forge Counter: Engage then add an Armament to hand
from your Purgatory" (the new part) — the effect text alone already
matches `SEARCH_FROM_PURGATORY_RE`, so no new effect-resolution code was
needed, only the new cost shape.

## Effigy (resource) system

- 5 colors: **Bleeding, Timeless, Formless, Living, Shifting** — a Being's
  colored cost pips must be paid with matching-color available effigies.
  **Faithless** (white/numeric) pips pay with any color unless a card says
  otherwise.
- **Craft Effigies** step: flip 1 effigy face-up from your Effigy Deck
  (available to spend). **Both players craft during every Craft Effigies
  step, not just the turn player** — the step itself runs once per turn
  (alternating between players, per the Turn Structure below), but its
  base flip applies to both, so over a full round each player nets the
  same number of effigies as the other. **First turn of the game only,
  the starting player alone flips 2 instead of 1** — the second player
  still just crafts their normal base 1 during that same step, same as
  every other step (see Keywords' Zealot section for the exact same "only
  the game's first turn, not each player's" distinction elsewhere — the
  bonus is scoped even narrower than that: it's the *starting player's*
  bonus specifically, not a blanket "whoever crafts during turn 1's step"
  bonus). An Altar's own "Craft (N) additional Effigy" bonus stays
  exclusive to its controller's own turn, matching its printed "on your
  turn" (see Card types > Altars).
- Spending an effigy shuffles it back into the Effigy Deck **at end step**
  (not immediately on use).
- Unspent effigies remain face-up and carry over turn to turn until spent.
- **Effigy Deck build**: 15 cards total, assembled by the player before the
  game. Any mix of the 5 colors is legal (1 color up to all 5), the only
  constraint is the deck must be exactly 15 cards.

## Turn structure

1. **Modulate −1** — decrement time counters on your Prophecies (an Altar's
   own Time Counters tick down here too — see Keywords). A face-down
   Prophecy hitting 0 flips face up and resolves its printed text — it
   only goes to Purgatory immediately if that grants it no new Time
   Counters of its own; otherwise it stays face-up, ticking those down the
   same way, until *they* hit 0.
2. **Disengage** — untap all your engaged permanents.
3. **Craft Effigies** — flip 1 effigy face up — **both players**, not just
   whoever's turn it is (see Effigy system, above); only the starting
   player flips 2 on the game's first turn, and only an Altar's extra flip
   is turn-player-exclusive.
4. **Draw** — draw 1 card. **Skipped entirely on the game's first turn**
   (the starting player already has their dealt opening hand and doesn't
   draw on top of it) — the second player's own first turn (turn 2) draws
   normally, same as every turn after. Drawing from an empty Main Deck:
   lose 10 Lifespan (not an automatic loss unless it drops you to 0).
5. **Main Phase** — play Beings/Prophecies/Altars/Relics/Conjurings, move/
   attack with Beings, cast Ethereal Conjurings, resolve triggers. Combat and
   movement can happen at any point in this phase (no separate combat step).
6. **End step** — Lifespan −1 (cost of passing the turn). Effigies spent this
   turn are shuffled back into the Effigy Deck.

## Combat

- A Being attacks by moving into the mirrored lane cell on the opponent's
  side (e.g. Col 1 Row 2 → Col 1 Row 4), per its printed arrows. Row 3 is
  skipped entirely — it has no Beings.
- If an opposing Being occupies the target cell: **both deal their Strength
  to each other simultaneously** (mutual damage, no first strike).
- Damage persists across turns — no automatic healing between turns.
- If a Being's Lifespan is reduced to 0, it dies (→ Purgatory) and **its
  controller** then takes damage to their own Lifespan total equal to that
  Being's **base (printed) Lifespan**, unless the card states otherwise.
- If the target lane cell is empty, damage goes directly to the opponent's
  Lifespan total. **A Relic or freestanding Armament pile doesn't block
  either** — only an opposing *Being* does. Either one sitting in the lane
  is left completely untouched and the attack passes straight through to
  the opponent's Lifespan, exactly as if the cell were empty. The one
  exception: an **Animated** Armament pile (RULES.md > Keywords) *does*
  block, with real mutual combat, exactly like a Being — it's treated as
  one while it's the topmost entry of that pile. A "Beings may move across
  this" Relic (Shifting Sands, Tilled Fields — RULES.md > Keywords) never
  blocks either, for a more literal reason than the other two: it isn't
  tracked on the board grid at all, so there's nothing there for the
  attack (or a Being's own movement) to even see.
- A Being must be **disengaged** to attack. Starting an attack engages it
  (same trigger as moving).
- A resolving **Prophecy**'s own arrows (see "Summon a token on all tiles
  this points to", Card types below) use the exact same owner-relative
  convention a Being's arrows already do: direction 1 (12 o'clock/forward)
  always lands on the *opponent's* front row, direction 5 (6 o'clock/
  backward) on the *controller's own* — reusing `computeMoveDestination`
  unchanged, just starting from the Prophecy's own Ethereal Realm cell
  instead of a Mortal Realm one. This also answers the "what does
  Arrow-based 'points to' targeting even mean geometrically" design
  question Phase 1 originally left open (see Keywords > Token creation).

## Lifespan / win condition

- Starting Lifespan: **50** per player.
- End step costs 1 Lifespan (cost of passing the turn).
- Drawing from an empty deck costs 10 Lifespan.
- A player loses when their Lifespan reaches 0.
- **Mulligan**: before the game starts, a player may shuffle their hand back
  and redraw 5, at a cost of 5 Lifespan. Repeatable, except a player may not
  take a mulligan that would drop them to 0 Lifespan.
- **Turn order**: decided by a coin flip — implemented as a real interactive
  step (`CoinFlip.jsx`) before hands are dealt at all: `createInitialState`
  (which deals the opening hands) only runs once the flip resolves, so
  nobody's opening hand is visible while it's still being decided. Whoever
  calls it is picked 50/50 (the human calls Heads/Tails themselves; the AI's
  call is random too, just not player-controlled), the flip itself is
  50/50, and the winner — whoever called it right, or the other side if the
  caller was wrong — chooses who goes first. If the AI wins, it always
  elects to go first (the simplest sensible default, same spirit as the
  rest of this engine's greedy AI — see `ai.js`).

## Deck construction

- Main Deck: exactly 40 cards, max 3 copies per card (max 2 for Deities).
- Effigy Deck: exactly 15 cards, built separately, any mix of the 5 colors.
- Beings summon onto an open cell in Row 1 Col 2/3/4 (Player A) or Row 5 Col
  2/3/4 (Player B) — the three home-row cells not occupied by the Effigy
  Deck/Zone.

---

## Proposed build phases

Given the depth here, building this as one pass is risky — better to get a
real playable loop working first, then layer in the rest.

**Phase 1 (MVP, local vs. AI):**
- Board (5×5, Mortal/Ethereal realms), Beings, summoning, movement/arrows,
  engage/disengage, combat (mutual damage, death → owner damage, direct life
  damage), Effigy resource system, Lifespan/win condition, full turn
  structure, Prophecies (face-down + timer + resolve).
- A simple AI opponent (rule-based: valid-move evaluation, not deep search).
- Deck import from the existing card CSV (filtered to playable types),
  deckbuilder respecting the 40+15 / 3-copy (2 for Deities) constraints.

**Phase 2 (in progress):**
- **Relics** — implemented: placed on any empty Mortal Realm cell the player
  controls (`PLACE_RELIC`), excluding the reserved Effigy Deck/Zone corners.
  Enters play disengaged; a Relic carrying "Engage: X" text can activate it
  the same turn (`ACTIVATE_ENGAGE`, same code path as a Being's Engage — see
  Keywords).
- **Relic–Armaments** — implemented: play on any of the player's own Mortal
  Realm cells (`ATTACH_ARMAMENT`) — empty, on their own Being, or stacking on
  their own Armament pile — and move with the Being they're attached to. A
  Being's Armaments stay behind as a freestanding pile when it dies, and a
  Being can pick up a waiting pile by summoning or moving onto it. Real
  behavior now (see Keywords): a Strength/Lifespan stat bonus ("Being gains
  +N/+N"), a granted Engage ability on the Being ("Being gains: Engage: X"),
  an Armament's *own* independent Engage ability (each Armament is its own
  engageable permanent, `ACTIVATE_ARMAMENT_ENGAGE`), self-damage effects
  ("Deal N Damage to this"), a sacrifice-for-Favored-Counter pattern
  (`ACTIVATE_ARMAMENT_SACRIFICE`), and Feathers of the Fallen's full
  Crossing-Counter-spend-to-move effect. The board UI's
  double-click-to-expand view lets a specific card in a stack be selected
  for any of these. Happy Hammer's own "move and attach to that Being"
  trigger IS real (`moveAutoAttachArmaments`, called from `placeBeingOnBoard`
  for a normal Being AND from `ATTACH_ARMAMENT` when an Animated Armament
  lands on a previously empty tile — RULES.md > Keywords > Animated's own
  "treated as a Being" makes that count as a real Being being summoned too,
  for any "a Being is summoned under your control" reaction, not just this
  one card). "Beings may move across this"-style text, and any other
  per-card text on a specific Armament beyond the patterns above (Cutlass's
  death trigger, Brick's targeted damage + self-relocation, Shovel's
  reveal-top-3, Armor Animus/HeartWood Locket's Armament-level Martyr),
  isn't executed.
- **Conjurings** — implemented: cast at main-phase speed (`CAST_CONJURING`),
  pays cost and resolves straight to Purgatory. Effect text is executed
  where recognized (see Keywords > "Add X to hand from deck" / Modulate).
- **Ethereal Conjurings** — fully implemented, including their own defining
  feature: real reactive/instant-speed timing. `CAST_CONJURING`'s own effect
  text is wired the same way any other Conjuring's is (Deja Vu, Willing
  Sacrifice, Engrave, Dendrify, Pause, Regress, Freeze Frame, Read the
  Bones, Drown out the Screams, Afterimage, and more), and on top of that,
  `state.reactiveWindow` (`manageReactiveWindow`, actions.js) now gives a
  real priority/reactive-window concept: after ANY action either player
  takes, the other player gets one optional chance to respond by casting an
  affordable `kind: 'ethereal-conjuring'` card from hand — and if they do,
  the original actor gets the same chance to respond to THAT, alternating
  indefinitely (real, unlimited-depth chaining) until whoever currently
  holds it either has nothing to cast or explicitly passes
  (`PASS_PRIORITY`). This is not a literal LIFO stack of unresolved
  effects — every reactive cast resolves immediately through the exact same
  `CAST_CONJURING` reducer case a normal cast uses; chaining is achieved by
  "does anyone want to respond to what just happened," asked once per
  event, a documented simplification since no real card in this set needs
  deferred/queued resolution. The window auto-closes within the same
  dispatch whenever its current holder has nothing real to cast (mirrors
  `clearStuckPendingChoice`'s own "auto-resolve what nobody can act on"
  philosophy), so in the overwhelming majority of actions it's completely
  invisible — it only surfaces when there's a real decision to make. Two
  deliberate scope boundaries: a window never opens mid-`pendingChoice` (a
  multi-step choice chain stays one atomic unit, same as today, until it
  fully resolves), and `PASS_TURN`'s own `beginTurn`/`endTurn` pipeline
  stays atomic too (no window opens around the draw/Modulate/craft/
  disengage steps bundled into ending a turn) — a natural, separate future
  task if windows around turn-transition steps themselves are ever wanted.
- **Altars** — implemented: placed into the player's own Effigy Zone cell
  only (`PLACE_ALTAR`), a single reserved slot per player. Its "Craft (N)
  additional Effigy on your turn" bonus (`card.keywords.craftBonus`) applies
  automatically every controller turn as part of the normal craft-effigies
  step — real Effigy Deck draws that linger in the pool like any other
  effigy, unlike a Zealot's temporary "Add" (see Keywords), and Faithless
  Altar's "only if you control only Faithless Permanents" condition on it is
  enforced too. Its "additional cost to Conjure"
  (`card.keywords.conjureCost`) is resolved right after placement: milling
  (Kalduran), random discard (NamKaranian), and damage-to-a-target
  (Rhak-tùrin) are all real, executed effects now — the damage cost also
  genuinely gates placement (won't offer/won't place without a legal
  target), matching real "additional cost" semantics. All 6 printed Altars
  are now fully correct end-to-end, including **Eònion Altar**'s own
  Time-Counter-gated craft bonus (see Keywords) — a player may also now
  control any number of Altars at once (RULES.md > Card types, below),
  their bonuses simply stacking.
- Every 6 real Altars' printed cards, by name: Arbosalis (fully correct, no
  extra clauses), NamKaranian and Kalduran (fully correct, conjure cost
  executed), Faithless (fully correct, condition enforced), Rhak-tùrin
  (fully correct, damage cost executed and gates placement), Eònion (**not**
  correct — craft bonus fires immediately instead of after 3 Time Counters
  tick down).
- **Board rendering** — occupants on the board (Board.jsx) now render with
  the Generator's "On Board" border frame/layout instead of the default
  portrait one (`CardTile`/`CardThumbnail`'s new `onboard` prop, threaded
  through to `renderCardOnCanvas`'s existing `borderStyle` support) — a
  shorter, near-square card face (750×720 vs. the default 750×1050)
  purpose-built for a compact board, so a full row of occupants now takes
  meaningfully less vertical space (Mortal Realm cells: 157px → 108px tall
  at the `sm` breakpoint). Scoped to the board only — the Hand row, the
  expanded-stack modal, and the deck builder's previews all still use the
  default portrait frame.
- **Counter badges** — any Counter type (Crossing, Forge, the Time Counters
  on a face-down Prophecy, and any future one) now renders as a small
  letter+count bubble in the bottom-right corner of its card (`Board.jsx`'s
  `CounterBadges`, opposite the existing armament-count/Effigy-pool badges
  in the top-left so neither ever collides) — "C2" for 2 Crossing Counters,
  "F3" for 3 Forge, "T1" for a Prophecy on its last tick before resolving.
  One generic component fed whatever `{ type: count }` object is relevant
  (a Relic/armament-stack top entry's own `counters` field, or a synthetic
  `{ time: occupant.timer }` for a Prophecy, which doesn't otherwise use
  that field shape) rather than a bespoke badge per Counter type.
- **Ability panel placement** — the Martyr/Engage/Sacrifice buttons for a
  selected cell (`martyrAction`/`engageActions`/`sacrificeXAction`,
  Match.jsx) render just above the human player's own Lifespan badge in
  the board's right-hand info column, not at the very top of the screen
  above the header — closer to the board itself and the player's own Life
  total, where attention already is while playing, rather than requiring a
  glance away from the action.
- **Multi-select board choices** (Cemetery Physician's own sacrifice
  toggle — see Keywords, above) get their own visual distinct from the
  normal amber "legal destination" highlight: a toggled-in tile fills with
  a solid red ring (`toggledCells` prop, `Board.jsx`), so "selectable" and
  "currently selected" read differently at a glance during a multi-click
  selection, unlike every other pendingChoice kind (which resolves in one
  click).
- **Altars viewer** — since Altars no longer occupy a board cell (Card
  types, above), each player's own pile gets a small clickable "Altars"
  `CardPile` badge next to their Purgatory one, opening a modal that lists
  every Altar they control with its own Craft bonus (and current Counters,
  for Eònion Altar) — mirroring the existing Purgatory-viewer pattern.
- **Bug (fixed): every Altar was genuinely unplayable in the live app right
  after the "not tied to a board cell" refactor above** — the engine side
  (`getLegalActions`/`PLACE_ALTAR`) was correct and fully test-covered the
  whole time, but `Match.jsx`'s own `CELL_TARGET_TYPES` array (which
  decides whether clicking a hand card waits for a follow-up cell click, or
  a `CAST_CONJURING`-style card resolves the instant it's clicked) still
  listed `'PLACE_ALTAR'` from before the refactor, back when it still
  carried a `cellId`. Clicking an Altar in hand entered cell-selection mode
  with nothing to highlight (`PLACE_ALTAR` actions have no `cellId` at all
  now) and no cell click could ever complete it — a real player-facing
  regression invisible to every engine-level test, since none of them
  exercise `Match.jsx`. Fixed by treating `PLACE_ALTAR` the same way
  `CAST_CONJURING` already is in `onHandSelect` (dispatches immediately,
  no cell target) and removing it from `CELL_TARGET_TYPES`. Verified live
  in the browser afterward, not just re-run against the existing test
  suite — this class of bug (a correct reducer, a stale assumption in the
  one UI file with no test coverage) doesn't show up any other way.
- **Beings' "When Summoned" triggers** — implemented: `SUMMON_BEING` fires
  the trigger right after placement (see Keywords > "When Summoned: 'X'"
  for the full mechanism breakdown). All 31 of the real set's printed "When
  Summoned" Beings resolve for real now (damage, draw, deck manipulation,
  Favored, optional/"you may" effects with a shared Decline mechanism,
  forced sacrifice/destroy without death-damage, a self-consuming "skip the
  next Disengage" status, an absolute Strength/Lifespan stat-copy, "moves
  without engaging" (Mahka-Rahva — reusing an Armament's own free-move
  primitive), token creation, and — the last 3 to close, formerly a "Tier
  D" gap here — Jirahperā and Green thumbed Gardener's own Arrow-based
  "points to" targeting and Crathea's own continuous static effect from a
  created token; see the "Formerly Tier D" note under Keywords > Token
  creation, above). Mahka-Rahva's *other* clause — "All Armaments you control
  move to the tile this is summoned on" — is now real too: a separate
  static ability outside the `whenSummoned` capture entirely (its own
  `gathersArmamentsOnSummon` boolean keyword), resolved before her "moves
  without engaging" trigger so the gathered Armaments travel with her when
  she relocates (see Keywords > "When Summoned: 'X'" for the full
  mechanism).
- **Token creation** — implemented as a general, reusable primitive
  (`createTokenCard` in cardData.js + a `TOKEN_REGISTRY` catalog in
  actions.js — see Keywords > "Token creation"), not scoped to When
  Summoned specifically: any trigger point (Depart, Engage, Martyr, When
  Summoned) that resolves a card's text through the shared
  `resolveOrLogEffect` picks up "summon a token" the same way. Currently
  wired for Bone collector, Cookie, Ditch Digger "Steve" (all Bag o'
  Bones), Cobra (Snake Skin, via Depart, "on this tile"), and Grave robber
  (Bag o' Bones to hand instead of the board).
- Keyword glossary: Persist and Favored are fully implemented. Depart,
  Martyr, and the generic "Engage: X" pattern all have real trigger points
  (mechanical cost fully resolved, including a Zealot's extra Lifespan cost
  or board-state condition on Engage itself, or a required "Engage, X: Y"
  second cost like Osteomancer's — see Keywords above) and execute their
  payload wherever it matches a recognized effect ("Add X to hand from
  deck" or from Purgatory, Modulate, "Add (N) Color Essence" — the Zealot
  bonus-effigy pattern, now with correct chained "then" follow-up clauses
  like self-damage) — otherwise it's logged, not executed. **This
  paragraph's own card-by-card Engage coverage count (originally "7 of 29
  fully real, 4 partially, the rest not automated") is stale and predates
  many later rounds of gap-closing** (Osteomancer, for one, is fully real
  now, not partial — see Keywords above) — treat the per-card counts here
  as historical, not current; a fresh audit against the CSV would be needed
  for an accurate number. Eònion Zealot's passive (non-Engage) once-per-turn
  Prophecy-counter trigger is also fully implemented (see Keywords above).
  Altars' "Craft (N) additional Effigy" is its own always-on keyword outside
  that trigger system (see above). Animated, Dryad, Invoke, and Shift are
  all fully wired to real gameplay logic now too (see their own entries
  under Keywords, above) — none of them are still "just detected."

**Phase 3:**
- Online multiplayer (defer per your earlier answer — local-only for now).
