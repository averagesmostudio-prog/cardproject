import React, { useEffect, useRef, useState } from 'react';
import { getBorderTypeForCard, resolveCardArt } from '../../lib/cardData.js';
import { renderCardOnCanvas, DEFAULT_POSITIONS, ONBOARD_CARD_PX_WIDTH, ONBOARD_CARD_PX_HEIGHT } from '../../lib/cardRender.js';

const THUMB_WIDTH = 180;
const THUMB_HEIGHT = 252;
// The On Board frame is a shorter, near-square card face (750x720, vs. the
// default portrait 750x1050) — used on the board itself so a full row of
// occupants takes noticeably less vertical space (see Board.jsx's cell
// dims). Scaled to the same THUMB_WIDTH so it drops in wherever a thumbnail
// would otherwise go.
const ONBOARD_THUMB_WIDTH = THUMB_WIDTH;
const ONBOARD_THUMB_HEIGHT = Math.round(THUMB_WIDTH * ONBOARD_CARD_PX_HEIGHT / ONBOARD_CARD_PX_WIDTH);

// Renders the exact same card art as the Generator — same border template,
// same pip/text layout — at thumbnail size (or a custom width/height), from
// a game card's raw CSV row. `onboard` switches to the shorter On Board
// frame/shape (cardRender.js's isOnboard handling) — used for the Hand row
// too, which wants that same compact footprint. `inPlay` (Board.jsx only —
// never Hand.jsx, never any preview) is the separate, narrower flag that
// actually picks On Board Border's stat-forward layout for a Being/
// Armament (cardRender.js's appliesStatSwap) instead of Digital Border's —
// a card in hand keeps Digital Border even though it's onboard-shaped, and
// only something genuinely sitting on the board gets the swap.
export default function CardThumbnail({ card, borderImages, borderImagesLoaded, artImages, artBorderImages, artImagesLoaded, fontLoaded, onboard = false, inPlay = false, width, height }) {
  const canvasRef = useRef(null);
  const [rendered, setRendered] = useState(false);
  const w = width ?? (onboard ? ONBOARD_THUMB_WIDTH : THUMB_WIDTH);
  const h = height ?? (onboard ? ONBOARD_THUMB_HEIGHT : THUMB_HEIGHT);

  useEffect(() => {
    if (!fontLoaded) return;
    // 'onboardStats' (cardRender.js's own appliesStatSwap) only actually
    // swaps in the stat-forward layout for a Being/Armament — anything else
    // renders pixel-identical to plain 'onboard' (Digital Border), so it's
    // always safe to ask for it here rather than re-deriving the card's own
    // kind just to guess in advance.
    const style = !onboard ? 'default' : (inPlay ? 'onboardStats' : 'onboard');
    // artImages/artBorderImages/artImagesLoaded are optional — callers that
    // haven't been updated to load them (or a card with no CARD_ART_SRC
    // entry) fall straight through to the plain border image, unchanged.
    const art = artImages && artBorderImages && artImagesLoaded
      ? resolveCardArt(card.raw, style, artImages, artBorderImages, artImagesLoaded)
      : null;
    const key = getBorderTypeForCard(card.raw, style);
    const img = art ? art.artBorderImg : borderImages.current[key];
    if (!img || !(art || borderImagesLoaded[key])) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderCardOnCanvas(canvas, card.raw, img, DEFAULT_POSITIONS, w, h, style, art?.artImg, art?.artBoxRect);
    setRendered(true);
  }, [card, borderImages, borderImagesLoaded, artImages, artBorderImages, artImagesLoaded, fontLoaded, w, h, onboard, inPlay]);

  return (
    <div className={`relative w-full ${onboard ? 'aspect-[750/720]' : 'aspect-[5/7]'} bg-stone-100 rounded overflow-hidden`}>
      <canvas ref={canvasRef} className={`w-full h-full ${rendered ? '' : 'invisible'}`} />
      {!rendered && (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] text-stone-400">
          Loading…
        </div>
      )}
    </div>
  );
}
