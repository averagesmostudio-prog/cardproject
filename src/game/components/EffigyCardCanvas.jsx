import React, { useEffect, useRef, useState } from 'react';
import { renderCardOnCanvas, DEFAULT_POSITIONS } from '../../lib/cardRender.js';
import { buildEffigyCardRow } from '../../lib/effigyCard.js';

// Draws an Effigy's card face with the same renderer (and the Altar's
// Conjuring border) the rest of the cards use, so it matches them exactly.
export default function EffigyCardCanvas({ color, borderImages, borderImagesLoaded, fontLoaded, width = 480, height = 672 }) {
  const canvasRef = useRef(null);
  const [rendered, setRendered] = useState(false);
  const borderReady = !!borderImagesLoaded.conjuring;

  useEffect(() => {
    if (!fontLoaded || !borderReady) return;
    const img = borderImages.current.conjuring;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    renderCardOnCanvas(canvas, buildEffigyCardRow(color), img, DEFAULT_POSITIONS, width, height, 'default', null, null);
    setRendered(true);
  }, [color, borderImages, borderReady, fontLoaded, width, height]);

  return (
    <div className="relative w-full aspect-[5/7] bg-stone-100 rounded overflow-hidden">
      <canvas ref={canvasRef} className={`w-full h-full ${rendered ? '' : 'invisible'}`} />
      {!rendered && (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] text-stone-400">
          Loading…
        </div>
      )}
    </div>
  );
}
