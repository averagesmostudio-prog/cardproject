import React from 'react';
import { cellId, ROWS, COLS, EFFIGY_DECK_CELL, EFFIGY_ZONE_CELL, SUMMON_CELLS } from '../../game/engine/board.js';
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
          className="absolute inset-x-0 bottom-0 h-14 rounded border border-stone-400 bg-stone-200"
          style={{ bottom: i * 2 }}
        />
      ))}
    </>
  );
}

function EffigyDeckStack({ count }) {
  return (
    <div className="relative w-14 h-20">
      <StackBacking />
      <div className="absolute inset-x-0 flex items-center justify-center text-lg font-extrabold text-stone-800" style={{ bottom: (STACK_LAYERS - 1) * 2 + 20 }}>
        {count}
      </div>
    </div>
  );
}

// A small letter+count bubble for a Counter (Crossing, Forge, ...) sitting
// on a card — "C2" for 2 Crossing Counters, "F3" for 3 Forge Counters. Only
// the initial letter is shown (per the card's convention), not the full
// name, to stay legible at this size; the full name is still in the
// tooltip. Positioned opposite the existing armament-count/Effigy-pool
// badges (top-left) so the two never collide.
function CounterBadges({ counters }) {
  const entries = Object.entries(counters || {}).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  return (
    <div className="absolute -bottom-1 -right-1 z-10 flex gap-0.5">
      {entries.map(([type, n]) => (
        <span
          key={type}
          className="flex items-center justify-center min-w-[16px] h-4 px-0.5 rounded-full bg-stone-800 text-white text-[9px] font-bold border border-white shadow"
          title={`${n} ${type[0].toUpperCase()}${type.slice(1)} Counter${n === 1 ? '' : 's'}`}
        >
          {type[0].toUpperCase()}{n}
        </span>
      ))}
    </div>
  );
}

function EffigyZoneBreakdown({ pool }) {
  const counts = {};
  pool.forEach(e => { counts[e.effigyType] = (counts[e.effigyType] || 0) + 1; });
  const present = EFFIGY_COLORS.filter(color => counts[color] > 0);

  if (present.length === 0) {
    return <span className="text-[9px] text-stone-400 uppercase tracking-wide px-1 text-center">Effigy Zone</span>;
  }

  // Available (crafted) Effigies really are a small stack of face-up cards
  // sitting in the Zone — same card-stack illustration as the Effigy Deck,
  // just with the per-color counts overlaid instead of a single total.
  return (
    <div className="relative w-14 h-20">
      <StackBacking />
      <div
        className="absolute inset-x-0 grid grid-cols-2 gap-x-2 gap-y-0.5 justify-items-center"
        style={{ bottom: (STACK_LAYERS - 1) * 2 + 18 }}
      >
        {present.map(color => (
          <span key={color} className="text-lg font-extrabold" style={{ color: EFFIGY_TYPE_COLORS[color] }}>
            {counts[color]}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function Board({ state, viewerId, highlightCells, selectedCell, toggledCells, onCellClick, onCellDoubleClick, borderImages, borderImagesLoaded, artImages, artBorderImages, artImagesLoaded, fontLoaded }) {
  const rows = [];
  // Rendered top-to-bottom as Row 5 -> Row 1: the opponent's side (Rows 4-5)
  // sits at the top of the screen, farthest away, while the human player's
  // own side (Rows 1-2) sits at the bottom, right above their Hand.
  for (let row = ROWS; row >= 1; row--) {
    const cells = [];
    for (let col = 1; col <= COLS; col++) {
      const id = cellId(row, col);
      const occupant = state.board[id];
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
      const effigyDeckOwner = effigyDeckOwnerForCell(id);
      const effigyZoneOwner = effigyZoneOwnerForCell(id);
      const isEthereal = row === 3;
      const isSummonCell = SUMMON_CELLS.A.includes(id) || SUMMON_CELLS.B.includes(id);

      cells.push(
        <div
          key={id}
          onClick={() => onCellClick(id)}
          onDoubleClick={() => onCellDoubleClick?.(id)}
          className={`relative rounded flex items-center justify-center
            ${isEthereal ? 'w-36 h-24 sm:w-44 sm:h-28 bg-indigo-950/20' : 'w-36 h-[138px] sm:w-44 sm:h-[169px] bg-emerald-900/10'}
            ${isToggled ? 'ring-4 ring-red-500 ring-inset' : isHighlighted ? 'ring-2 ring-amber-400 ring-inset' : 'ring-1 ring-stone-300'}
            ${isSummonCell && !occupant ? 'bg-amber-50' : ''}`}
        >
          {occupant?.type === 'being' && (
            <div className="relative">
              <CardTile
                card={occupant.card}
                currentLifespan={occupant.currentLifespan}
                strength={effectiveStrength(occupant)}
                engaged={occupant.engaged}
                selected={isSelected}
                onboard
                size="lg"
                onClick={() => onCellClick(id)}
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
                  onClick={() => onCellClick(id)}
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
                  onClick={() => onCellClick(id)}
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
                onClick={() => onCellClick(id)}
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
            <div className="relative">
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
                onClick={() => onCellClick(id)}
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
                onClick={() => onCellClick(id)}
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
