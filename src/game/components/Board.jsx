import React from 'react';
import { cellId, parseCellId, ROWS, COLS, EFFIGY_DECK_CELL, EFFIGY_ZONE_CELL, SUMMON_CELLS } from '../../game/engine/board.js';
import { effectiveStrength } from '../../game/engine/combat.js';
import { animatedTopEntry, actorView } from '../../game/engine/actions.js';
import { EFFIGY_COLORS, EFFIGY_TYPE_COLORS } from '../../lib/cardData.js';
import CardTile from './CardTile.jsx';

const cellOwner = (id, cellMap) => {
  if (id === cellMap.A) return 'A';
  if (id === cellMap.B) return 'B';
  return null;
};

const effigyDeckOwnerForCell = (id) => cellOwner(id, EFFIGY_DECK_CELL);
const effigyZoneOwnerForCell = (id) => cellOwner(id, EFFIGY_ZONE_CELL);

const STACK_LAYERS = 5; // purely visual shorthand for "a stack of many cards"

// The attack-lunge animation (index.css > .attack-lunge) is a generic
// lift-push-return keyframe driven entirely by these two CSS custom
// properties — this just picks their sign/magnitude from the attacker's
// and target's row/col so the push always leans toward the actual target
// instead of always going, say, straight up. Rows run 1 (bottom, Player
// A's home row) to 5 (top, Player B's) per board.js's own layout comment,
// so a *higher* target row means the push has to go *up* on screen
// (negative Y) — this is a stylized partial lunge, not a real distance
// (a Row 2 -> Row 4 attack crosses the whole Ethereal Realm; animating
// that literally would be a much bigger, slower motion than this reads as).
const LUNGE_Y_PX = 46;
const LUNGE_X_PX = 26;
const lungeOffsetFor = (fromCellId, toCellId) => {
  const from = parseCellId(fromCellId);
  const to = toCellId && parseCellId(toCellId);
  if (!from || !to) return { x: 0, y: 0 };
  const rowSign = Math.sign(to.row - from.row);
  const colSign = Math.sign(to.col - from.col);
  return { x: colSign * LUNGE_X_PX, y: -rowSign * LUNGE_Y_PX };
};

// The layered card-back illustration shared by both the Effigy Deck (always
// showing a stack — it's a real deck of unknown-until-flipped cards) and the
// Effigy Zone breakdown below (only once there's actually a card to
// illustrate — an empty Zone has no cards to look like a stack of).
function StackBacking() {
  return (
    <>
      {Array.from({ length: STACK_LAYERS }).map((_, i) => (
        <div
          key={i}
          className="absolute inset-x-0 bottom-0 h-20 rounded border border-stone-400 bg-stone-200"
          style={{ bottom: i * 2 }}
        />
      ))}
    </>
  );
}

function EffigyDeckStack({ count }) {
  return (
    <div className="relative w-24 h-24 sm:w-28 sm:h-28">
      <StackBacking />
      <div className="absolute inset-x-0 flex items-center justify-center text-2xl font-extrabold text-stone-800" style={{ bottom: (STACK_LAYERS - 1) * 2 + 30 }}>
        {count}
      </div>
    </div>
  );
}

// A small letter+count "coin" for a Counter (Crossing, Forge, ...) sitting
// on a card — "C2" for 2 Crossing Counters, "F3" for 3 Forge Counters. Only
// the initial letter is shown (per the card's convention), not the full
// name, to stay legible at this size; the full name is still in the
// tooltip. Positioned opposite the existing armament-count/Effigy-pool
// badges (top-left) so the two never collide. Favored isn't a real Counter
// (no `counters.favor` — it's the separate `favorCounter` boolean) so it
// never reaches this component at all; it gets its own FavoredBubble below.
const COUNTER_LABELS = {};
function CounterBadges({ counters }) {
  const entries = Object.entries(counters || {}).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  return (
    <div className="absolute -bottom-2 -right-2 z-10 flex gap-1.5">
      {entries.map(([type, n]) => {
        const label = COUNTER_LABELS[type] || type[0].toUpperCase();
        return (
          <span
            key={type}
            className="flex items-center justify-center min-w-[30px] h-[30px] px-1.5 rounded-full bg-stone-800 text-white text-sm font-bold border-2 border-white shadow"
            title={`${n} ${type[0].toUpperCase()}${type.slice(1)} Counter${n === 1 ? '' : 's'}`}
          >
            {label}{n}
          </span>
        );
      })}
    </div>
  );
}

// The impact burst shown over a Being for the brief window useStagedBoard.js
// holds its pre-damage self on screen — `flash` is `{ amount, dying }` for
// the cell this render currently occupies, or undefined the rest of the
// time. Two overlapping rotated squares form an 8-point starburst (a
// Hearthstone-style "hit" badge) with the damage number popped on top;
// `dying` additionally washes the tile red so a killing blow reads
// differently from a Being that's merely damaged and staying on the board.
function DamageFlash({ flash }) {
  if (!flash) return null;
  return (
    <>
      {flash.dying && (
        <div className="absolute inset-0 z-20 bg-red-900/40 rounded pointer-events-none animate-pulse" />
      )}
      <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
        <div className="relative w-12 h-12 damage-burst-pop">
          <div className="absolute inset-0 bg-gradient-to-br from-amber-300 via-orange-500 to-red-600 rounded-md shadow-[0_0_6px_rgba(0,0,0,0.6)] rotate-45" />
          <div className="absolute inset-0 bg-gradient-to-br from-amber-300 via-orange-500 to-red-600 rounded-md shadow-[0_0_6px_rgba(0,0,0,0.6)]" />
          <div
            className="absolute inset-0 flex items-center justify-center text-red-600 font-extrabold text-lg"
            style={{ textShadow: '0 0 2px #000, 0 0 3px #000, 0 1px 1px #000' }}
          >
            -{flash.amount}
          </div>
        </div>
      </div>
    </>
  );
}

// Favored (RULES.md > Keywords): "The next time this Being would take
// damage, prevent it and remove Favored" — a persistent board fact, not a
// one-off trigger, so this renders continuously for as long as
// `occupant.favorCounter` is true instead of playing once and fading. A
// soft shimmering forcefield hugging the card, Hearthstone Divine-Shield
// in spirit — z-15, between the armament/counter badges (z-10) and
// DamageFlash (z-20) so a damage burst still reads on top of it (in
// practice the two rarely overlap: dealDamageToBeing strips favorCounter
// the instant it actually blocks a hit, so the shield is usually already
// gone by the time a flash would show — this ordering just covers the
// edge case defensively).
function FavoredBubble({ active }) {
  if (!active) return null;
  return (
    <div className="absolute -inset-2 z-[15] rounded-2xl pointer-events-none">
      <div className="absolute inset-0 rounded-2xl favored-bubble-glow" />
      <div className="absolute inset-0 rounded-2xl favored-bubble-ring" />
    </div>
  );
}

function EffigyZoneBreakdown({ pool }) {
  const counts = {};
  pool.forEach(e => { counts[e.effigyType] = (counts[e.effigyType] || 0) + 1; });
  const present = EFFIGY_COLORS.filter(color => counts[color] > 0);

  if (present.length === 0) {
    return <span className="text-[10px] text-stone-400 uppercase tracking-wide px-1 text-center">Effigy Zone</span>;
  }

  // Available (crafted) Effigies really are a small stack of face-up cards
  // sitting in the Zone — same card-stack illustration as the Effigy Deck,
  // just with the per-color counts overlaid instead of a single total.
  return (
    <div className="relative w-24 h-24 sm:w-28 sm:h-28">
      <StackBacking />
      <div
        className="absolute inset-x-0 grid grid-cols-2 gap-x-3 gap-y-1 justify-items-center"
        style={{ bottom: (STACK_LAYERS - 1) * 2 + 28 }}
      >
        {present.map(color => (
          <span key={color} className="text-2xl font-extrabold" style={{ color: EFFIGY_TYPE_COLORS[color] }}>
            {counts[color]}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function Board({ state, displayBoard, flashes, lastAttack, viewerId, highlightCells, selectedCell, toggledCells, respondingCellId, onCellClick, onCellDoubleClick, borderImages, borderImagesLoaded, artImages, artBorderImages, artImagesLoaded, fontLoaded }) {
  const rows = [];
  // `displayBoard` (useStagedBoard.js) is a momentarily-lagged view of
  // state.board for a Being that just took damage or died — falls back to
  // the real board when no staged view was passed in (e.g. any future
  // caller that doesn't need this). Everything else on `state` (altars,
  // groundRelics, players' Effigy piles) is read live as always; only board
  // occupant rendering itself is ever staged.
  const board = displayBoard || state.board;
  // Rendered top-to-bottom as Row 5 -> Row 1: the opponent's side (Rows 4-5)
  // sits at the top of the screen, farthest away, while the human player's
  // own side (Rows 1-2) sits at the bottom, right above their Hand.
  for (let row = ROWS; row >= 1; row--) {
    const cells = [];
    for (let col = 1; col <= COLS; col++) {
      const id = cellId(row, col);
      const occupant = board[id];
      // A "Beings may move across this" Relic (RULES.md > Keywords) — lives
      // outside `board` entirely, so it's read separately and can coexist
      // with a real board occupant on the very same tile.
      const groundRelic = state.groundRelics?.[id];
      const isHighlighted = highlightCells.has(id);
      const isSelected = selectedCell === id;
      // Currently toggled "in" for a multi-select choice (e.g. Cemetery
      // Physician's own "sacrifice any number of <Name>" — RULES.md >
      // Keywords) — a distinct, filled ring so a toggled-in tile reads
      // differently from a merely-selectable one.
      const isToggled = toggledCells?.has(id);
      // The specific cell an open reactive window's pending effect is about
      // (see Match.jsx's respondingCellId) — its own yellow ring, distinct
      // from both the red toggled-in ring and the green target-selection
      // ring below, so "what am I being asked to respond to" reads clearly
      // even when that same cell also happens to be a legal target.
      const isRespondingTo = respondingCellId === id;
      const effigyDeckOwner = effigyDeckOwnerForCell(id);
      const effigyZoneOwner = effigyZoneOwnerForCell(id);
      const isEthereal = row === 3;
      const isSummonCell = SUMMON_CELLS.A.includes(id) || SUMMON_CELLS.B.includes(id);
      // `lastAttack` (useGameEngine.js) names only the attacking cell — its
      // own occupant branch below (being or an Animated armament-stack;
      // nothing else can attack) applies this as a keyed wrapper so the
      // lunge (index.css > .attack-lunge) replays from scratch every time,
      // even for a second attack from the same cell in a row.
      const isAttacking = lastAttack?.fromCellId === id;
      const lungeOffset = isAttacking ? lungeOffsetFor(lastAttack.fromCellId, lastAttack.toCellId) : null;

      cells.push(
        <div
          key={id}
          onClick={() => onCellClick(id)}
          onDoubleClick={() => onCellDoubleClick?.(id)}
          className={`relative rounded flex items-center justify-center
            ${isEthereal ? 'w-36 h-24 sm:w-44 sm:h-28 bg-indigo-950/20' : 'w-36 h-[138px] sm:w-44 sm:h-[169px] bg-emerald-900/10'}
            ${isToggled ? 'ring-4 ring-red-500 ring-inset' : isRespondingTo ? 'ring-4 ring-yellow-400 ring-inset' : isHighlighted ? 'ring-2 ring-green-400 ring-inset' : 'ring-1 ring-stone-300'}
            ${isSummonCell && !occupant ? 'bg-amber-50' : ''}`}
        >
          {occupant?.type === 'being' && (
            <div
              key={isAttacking ? `atk-${lastAttack.seq}` : undefined}
              className={`relative ${isAttacking ? 'attack-lunge' : ''}`}
              style={isAttacking ? { '--lunge-x': `${lungeOffset.x}px`, '--lunge-y': `${lungeOffset.y}px` } : undefined}
            >
              <CardTile
                card={occupant.card}
                currentLifespan={occupant.currentLifespan}
                strength={effectiveStrength(occupant)}
                engaged={occupant.engaged}
                selected={isSelected}
                onboard
                size="lg"
                borderImages={borderImages}
                borderImagesLoaded={borderImagesLoaded}
                artImages={artImages}
                artBorderImages={artBorderImages}
                artImagesLoaded={artImagesLoaded}
                fontLoaded={fontLoaded}
              />
              {occupant.armaments?.length > 0 && (
                <span
                  className="absolute -top-1 -left-1 z-10 bg-stone-700 text-white text-[9px] font-bold px-1 rounded-full shadow"
                  title={`${occupant.armaments.map(a => a.card.name).join(', ')} — double-click to open`}
                >
                  ⚔ {occupant.armaments.length}
                </span>
              )}
              <CounterBadges counters={occupant.counters} />
              <FavoredBubble active={!!occupant.favorCounter} />
              <DamageFlash flash={flashes?.[id]} />
            </div>
          )}
          {occupant?.type === 'prophecy' && (
            <div className="relative">
              {occupant.faceDown ? (
                <CardTile
                  card={occupant.card}
                  faceDown
                  isOwn={occupant.ownerId === viewerId}
                  horizontal
                  borderImages={borderImages}
                  borderImagesLoaded={borderImagesLoaded}
                  artImages={artImages}
                  artBorderImages={artBorderImages}
                  artImagesLoaded={artImagesLoaded}
                  fontLoaded={fontLoaded}
                />
              ) : (
                // Flipped face up (RULES.md > Prophecies) — shows its real
                // card face, same compact frame every other board occupant
                // uses, sized down to fit the shorter Ethereal Realm cell.
                <CardTile
                  card={occupant.card}
                  size="md"
                  onboard
                  borderImages={borderImages}
                  borderImagesLoaded={borderImagesLoaded}
                  artImages={artImages}
                  artBorderImages={artBorderImages}
                  artImagesLoaded={artImagesLoaded}
                  fontLoaded={fontLoaded}
                />
              )}
              <CounterBadges counters={{ time: occupant.timer }} />
            </div>
          )}
          {occupant?.type === 'relic' && (
            <div className="relative">
              <CardTile
                card={occupant.card}
                engaged={occupant.engaged}
                selected={isSelected}
                onboard
                size="lg"
                borderImages={borderImages}
                borderImagesLoaded={borderImagesLoaded}
                artImages={artImages}
                artBorderImages={artBorderImages}
                artImagesLoaded={artImagesLoaded}
                fontLoaded={fontLoaded}
              />
              <CounterBadges counters={occupant.counters} />
            </div>
          )}
          {occupant?.type === 'armament-stack' && (() => {
            // An Animated top (RULES.md > Keywords > Animated) is acting as
            // a Being — show its current Strength/Lifespan the same way a
            // real Being's are shown, computed the exact same way combat
            // itself does (actorView + effectiveStrength), including any
            // Strength bonus from Armaments stacked underneath it. A plain
            // (non-Animated) top has neither — it's just equipment.
            const animated = animatedTopEntry(occupant);
            const view = animated ? actorView(occupant) : null;
            return (
            <div
              key={isAttacking ? `atk-${lastAttack.seq}` : undefined}
              className={`relative ${isAttacking ? 'attack-lunge' : ''}`}
              style={isAttacking ? { '--lunge-x': `${lungeOffset.x}px`, '--lunge-y': `${lungeOffset.y}px` } : undefined}
            >
              <CardTile
                card={occupant.armaments[occupant.armaments.length - 1].card}
                currentLifespan={view?.currentLifespan}
                strength={view ? effectiveStrength(view) : undefined}
                // The topmost entry's own tapped state — meaningful either
                // way: an Animated one acting as a Being (RULES.md >
                // Keywords) shows tapped after moving/attacking, and a
                // plain Armament with its own "Engage: X" shows tapped
                // after that fires too.
                engaged={occupant.armaments[occupant.armaments.length - 1].engaged}
                selected={isSelected}
                onboard
                size="lg"
                borderImages={borderImages}
                borderImagesLoaded={borderImagesLoaded}
                artImages={artImages}
                artBorderImages={artBorderImages}
                artImagesLoaded={artImagesLoaded}
                fontLoaded={fontLoaded}
              />
              {occupant.armaments.length > 1 && (
                <span
                  className="absolute -top-1 -left-1 z-10 bg-stone-700 text-white text-[9px] font-bold px-1 rounded-full shadow"
                  title={`${occupant.armaments.map(a => a.card.name).join(', ')} — double-click to open`}
                >
                  ⚔ {occupant.armaments.length}
                </span>
              )}
              <CounterBadges counters={occupant.armaments[occupant.armaments.length - 1].counters} />
            </div>
            );
          })()}
          {!occupant && effigyDeckOwner && (
            <EffigyDeckStack count={state.players[effigyDeckOwner].effigyDeck.length} />
          )}
          {!occupant && effigyZoneOwner && (
            <EffigyZoneBreakdown pool={state.players[effigyZoneOwner].effigyPool} />
          )}
          {!occupant && groundRelic && (
            <div className="relative">
              <CardTile
                card={groundRelic.card}
                engaged={groundRelic.engaged}
                selected={isSelected}
                onboard
                size="lg"
                borderImages={borderImages}
                borderImagesLoaded={borderImagesLoaded}
                artImages={artImages}
                artBorderImages={artBorderImages}
                artImagesLoaded={artImagesLoaded}
                fontLoaded={fontLoaded}
              />
              <CounterBadges counters={groundRelic.counters} />
            </div>
          )}
          {occupant && groundRelic && (
            // A Being (or anything else) sharing this tile with the ground
            // Relic — it stays right where it was (RULES.md > Keywords),
            // just visually tucked into the corner opposite the
            // armament-count badge so it doesn't collide with it.
            <span
              className="absolute -top-1 -right-1 z-10 bg-amber-800 text-white text-[9px] font-bold px-1 rounded-full shadow"
              title={`${groundRelic.card.name} is also on this tile`}
            >
              ◆
            </span>
          )}
        </div>
      );
    }
    rows.push(
      <div key={row} className="flex gap-1">
        {cells}
      </div>
    );
  }

  return (
    // The cell tints (emerald/indigo at low opacity) are designed to
    // composite over a light backdrop — give the board its own fixed light
    // background so it always renders with the same tones regardless of the
    // surrounding page's own background color.
    <div className="flex flex-col gap-1 items-center bg-stone-100 p-2 rounded-lg">
      {rows}
    </div>
  );
}
