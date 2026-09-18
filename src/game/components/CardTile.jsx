import React, { useRef, useState } from 'react';
import CardThumbnail from './CardThumbnail.jsx';

const SIZE_CLASSES = { sm: 'w-16', md: 'w-24', lg: 'w-36', xl: 'w-48' };
const HOVER_WIDTH = 260;
// The hover zoom always shows the *default* portrait frame — even for an
// On Board tile — since the On Board frame deliberately omits the text box
// (see cardRender.js's isOnboard handling) to stay compact; hovering is
// exactly when the player wants to actually read the card, so it always
// shows "the original card" in full, text box included.
const HOVER_HEIGHT = Math.round(HOVER_WIDTH * 7 / 5);

export default function CardTile({
  card, currentLifespan, strength, engaged, faceDown, isOwn, horizontal, selected, dimmed, onClick, size = 'md',
  onboard = false, borderImages, borderImagesLoaded, artImages, artBorderImages, artImagesLoaded, fontLoaded,
}) {
  const dims = SIZE_CLASSES[size] || SIZE_CLASSES.md;
  const wrapRef = useRef(null);
  const [hoverPos, setHoverPos] = useState(null);

  const handleMouseEnter = () => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    let top = rect.top - HOVER_HEIGHT - 12;
    if (top < 8) top = rect.bottom + 12; // not enough room above — show below instead
    let left = rect.left + rect.width / 2 - HOVER_WIDTH / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - HOVER_WIDTH - 8));
    setHoverPos({ left, top });
  };
  const handleMouseLeave = () => setHoverPos(null);

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
        style={{ transform: engaged ? 'rotate(90deg)' : undefined }}
      >
        <CardThumbnail card={card} onboard={onboard} borderImages={borderImages} borderImagesLoaded={borderImagesLoaded} artImages={artImages} artBorderImages={artBorderImages} artImagesLoaded={artImagesLoaded} fontLoaded={fontLoaded} />
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

      {hoverPos && (
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
        </div>
      )}
    </div>
  );
}
