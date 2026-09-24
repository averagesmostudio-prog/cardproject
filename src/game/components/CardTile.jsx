import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import CardThumbnail from './CardThumbnail.jsx';

// 'lg' matches Board.jsx's onboard cell width at both breakpoints (w-36 /
// sm:w-44) so onboard cards fill the tile instead of leaving a gap once the
// cell itself grows at sm:.
const SIZE_CLASSES = { sm: 'w-16', md: 'w-24', lg: 'w-36 sm:w-44', xl: 'w-48' };
// A deliberate pause before the zoom appears — a mouse merely passing over
// (or resting briefly while aiming a click) shouldn't pop up the preview;
// only a real, sustained hover should. This is the default for an onboard
// tile specifically; Hand.jsx overrides it to 0 (instant) for its own
// cards via the `hoverDelayMs` prop below — a card already in hand is
// small and known, so there's no accidental-hover risk worth guarding
// against the way there is for a crowded board.
const HOVER_DELAY_MS = 2000;
const HOVER_WIDTH = 260;
// The hover zoom always shows the *default* portrait frame — even for an
// On Board tile — since the On Board frame deliberately omits the text box
// (see cardRender.js's isOnboard handling) to stay compact; hovering is
// exactly when the player wants to actually read the card, so it always
// shows "the original card" in full, text box included.
const HOVER_HEIGHT = Math.round(HOVER_WIDTH * 7 / 5);
// An onboard tile's own hover preview is bigger than the off-board one —
// popped up beside whichever tile is hovered, same as off-board, but
// portaled to document.body (see the render below) rather than rendered
// in place: an onboard tile sits inside the board's own scrollable
// `overflow-auto` area (Match.jsx) AND its `transform: scale(...)`
// responsive-board wrapper, either of which would otherwise clip a
// preview this tall (confirmed with the user — it was getting cut off by
// the Hand row below the board). getBoundingClientRect() already returns
// real, scale-adjusted viewport coordinates regardless of where the
// element sits in the DOM, so positioning a `position: fixed` preview
// from it — same computation showPreview already uses for the off-board
// case below — needs no extra scale math; portaling to document.body is
// what actually lets it escape the board area's own clipping.
const ONBOARD_HOVER_WIDTH = 340;
const ONBOARD_HOVER_HEIGHT = Math.round(ONBOARD_HOVER_WIDTH * 7 / 5);

export default function CardTile({
  card, currentLifespan, strength, engaged, faceDown, isOwn, horizontal, selected, dimmed, onClick, size = 'md',
  // `onboard` picks the compact On Board *shape* (short aspect ratio, the
  // portal hover preview, opponent-side 180° rotation, ...) — used for a
  // card in hand too, since the hand row wants that same compact footprint.
  // `inPlay` is the separate, narrower flag for "this occupant is actually
  // sitting on the board right now" (Board.jsx only — never Hand.jsx or the
  // mulligan star layout, both onboard-shaped but not in play), which is
  // what actually picks On Board Border's stat-forward layout over Digital
  // Border's (CardThumbnail.jsx). A card in hand always stays Digital
  // Border even though it shares the same onboard shape.
  onboard = false, inPlay = false, hoverDelayMs = HOVER_DELAY_MS, disableHoverPreview = false, borderImages, borderImagesLoaded, artImages, artBorderImages, artImagesLoaded, fontLoaded,
}) {
  const dims = SIZE_CLASSES[size] || SIZE_CLASSES.md;
  const wrapRef = useRef(null);
  const [hoverPos, setHoverPos] = useState(null);
  const hoverTimerRef = useRef(null);

  const showPreview = () => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = onboard ? ONBOARD_HOVER_WIDTH : HOVER_WIDTH;
    const height = onboard ? ONBOARD_HOVER_HEIGHT : HOVER_HEIGHT;
    let top = rect.top - height - 12;
    if (top < 8) top = rect.bottom + 12; // not enough room above — show below instead
    // Clamp to the real viewport on both axes — the flip-up-or-down above
    // already handles the common case, but the onboard preview is tall
    // enough (ONBOARD_HOVER_HEIGHT) that a tile near the top or bottom
    // edge of the board can still overflow either direction otherwise.
    top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    setHoverPos({ left, top });
  };
  const handleMouseEnter = () => {
    // The mulligan screen's star layout drives its own centered expand
    // preview instead of this tile's near-tile popup — see Match.jsx.
    if (disableHoverPreview) return;
    if (hoverDelayMs <= 0) {
      showPreview();
      return;
    }
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      showPreview();
    }, hoverDelayMs);
  };
  const handleMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoverPos(null);
  };
  useEffect(() => () => { if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current); }, []);

  if (faceDown) {
    // Prophecies sit in the Ethereal Realm (Row 3), which is laid out
    // sideways relative to the rest of the board — so the card itself is
    // placed horizontal (landscape) instead of the usual portrait orientation.
    const faceDownDims = horizontal ? 'w-28 h-20' : `${dims} aspect-[5/7]`;
    // Your own face-down Prophecies are blue, the opponent's are red — same
    // at-a-glance distinction as every other owner-colored UI element.
    // Hovering your own reveals its real face (you already know what you
    // played); the opponent's stays hidden — no hover handlers at all, so
    // there's nothing to leak.
    return (
      <div
        ref={isOwn ? wrapRef : undefined}
        onClick={onClick}
        onMouseEnter={isOwn ? handleMouseEnter : undefined}
        onMouseLeave={isOwn ? handleMouseLeave : undefined}
        className={`${faceDownDims} rounded border-2 flex items-center justify-center font-semibold cursor-pointer select-none text-[10px]
          ${isOwn ? 'border-blue-900 bg-blue-700 text-blue-200' : 'border-red-900 bg-red-700 text-red-200'}`}
      >
        Prophecy
        {isOwn && hoverPos && (
          <div
            className="fixed z-[70] pointer-events-none drop-shadow-2xl"
            style={{ left: hoverPos.left, top: hoverPos.top, width: HOVER_WIDTH }}
          >
            <CardThumbnail
              card={card}
              borderImages={borderImages}
              borderImagesLoaded={borderImagesLoaded}
              artImages={artImages}
              artBorderImages={artBorderImages}
              artImagesLoaded={artImagesLoaded}
              fontLoaded={fontLoaded}
              width={HOVER_WIDTH}
              height={HOVER_HEIGHT}
            />
          </div>
        )}
      </div>
    );
  }

  // An Animated Armament (RULES.md > Keywords > Animated) acts as a Being
  // while it's the topmost entry of a Being-less pile — Board.jsx passes
  // its current Strength/Lifespan the same way it does for a real Being,
  // so it needs the same damaged/boosted badge treatment even though its
  // own card.kind is still 'relic-armament'.
  const isBeing = card.kind === 'being' || card.kind === 'deity' || !!card.keywords?.animated;
  const damaged = isBeing && currentLifespan != null && currentLifespan !== card.lifespan;
  // Armament-boosted Strength (e.g. a 1/1 with a +3/+0 Armament attached is
  // a 4/1 while it stays attached — RULES.md > Card types), shown as a
  // badge over the printed base value the same way ♥ shows boosted/damaged
  // Lifespan, since the underlying card art always prints the base stat.
  const boosted = isBeing && strength != null && strength !== card.strength;

  // An onboard tile belonging to the OTHER player (isOwn === false,
  // explicitly — never just falsy/undefined, so any onboard call site that
  // doesn't pass isOwn safely defaults to unrotated rather than guessing)
  // renders rotated 180° — Player B's side of the board is already the
  // logical mirror of Player A's (board.js's own directionDelta), but the
  // CARD ART ITSELF (cardRender.js's printed arrow glyphs) has always had
  // a fixed visual orientation regardless of owner. Without this, an
  // opponent Being's own "forward" arrow visually points toward the
  // opponent's OWN back row instead of toward the human, the opposite of
  // which direction it actually moves — confirmed with the user: composed
  // with the existing Engaged 90° rotation below, not replacing it, since
  // a card can be both an opponent's AND Engaged at once. The hover
  // preview is a separate, independent render (see showPreview/the render
  // below) and always stays upright regardless — a zoomed-in card should
  // always be legible, never upside down.
  const rotationDeg = (onboard && isOwn === false ? 180 : 0) + (engaged ? 90 : 0);

  return (
    <div
      ref={wrapRef}
      onClick={onClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`relative ${dims} cursor-pointer select-none transition rounded
        ${selected ? 'ring-2 ring-amber-400' : ''}`}
    >
      {/* Engaged cards rotate 90° in place (a "tapped" indicator) instead of
          fading — dimmed (unplayable) still fades. Both live on this inner
          wrapper only; the hover preview below is a separate fixed-position
          sibling so it always renders fully solid and upright. */}
      <div
        className={`transition-transform duration-200 ${dimmed ? 'opacity-40' : ''}`}
        style={{ transform: rotationDeg ? `rotate(${rotationDeg}deg)` : undefined }}
      >
        <CardThumbnail card={card} onboard={onboard} inPlay={inPlay} borderImages={borderImages} borderImagesLoaded={borderImagesLoaded} artImages={artImages} artBorderImages={artBorderImages} artImagesLoaded={artImagesLoaded} fontLoaded={fontLoaded} />
      </div>
      {damaged && (
        <span className="absolute bottom-1 right-1 bg-red-700 text-white text-[10px] font-bold px-1 rounded shadow z-10">
          ♥{currentLifespan}
        </span>
      )}
      {boosted && (
        <span className="absolute bottom-1 left-1 bg-amber-700 text-white text-[10px] font-bold px-1 rounded shadow z-10">
          ⚔{strength}
        </span>
      )}

      {hoverPos && (() => {
        const previewWidth = onboard ? ONBOARD_HOVER_WIDTH : HOVER_WIDTH;
        const previewHeight = onboard ? ONBOARD_HOVER_HEIGHT : HOVER_HEIGHT;
        const previewInner = (
          <>
            <CardThumbnail
              card={card}
              borderImages={borderImages}
              borderImagesLoaded={borderImagesLoaded}
              artImages={artImages}
              artBorderImages={artBorderImages}
              artImagesLoaded={artImagesLoaded}
              fontLoaded={fontLoaded}
              width={previewWidth}
              height={previewHeight}
            />
            {damaged && (
              <span className="absolute bottom-2 right-2 bg-red-700 text-white text-sm font-bold px-2 py-0.5 rounded shadow">
                ♥{currentLifespan}
              </span>
            )}
            {boosted && (
              <span className="absolute bottom-2 left-2 bg-amber-700 text-white text-sm font-bold px-2 py-0.5 rounded shadow">
                ⚔{strength}
              </span>
            )}
          </>
        );
        const preview = (
          <div
            className="fixed z-[70] pointer-events-none drop-shadow-2xl"
            style={{ left: hoverPos.left, top: hoverPos.top, width: previewWidth }}
          >
            {previewInner}
          </div>
        );
        // Portaled straight to document.body — see ONBOARD_HOVER_WIDTH's
        // own comment above for why an onboard tile specifically needs to
        // escape the board's own scroll/scale wrapper this way.
        return onboard ? createPortal(preview, document.body) : preview;
      })()}
    </div>
  );
}
