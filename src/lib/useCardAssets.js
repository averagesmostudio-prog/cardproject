import { useEffect, useRef, useState } from 'react';
import { BORDER_IMAGE_SRC, CARD_ART_SRC, ART_BORDER_IMAGE_SRC } from './cardData.js';

// Loads Cinzel — a Roman-inspired epic-fantasy display serif (the card's
// full font, name/type line/text box/stats alike; MTG's own title font is a
// close cousin) — once per mount. Safe to call from multiple components at
// once; the browser dedupes the stylesheet/font-file fetch.
export const useCardFont = () => {
  const [fontLoaded, setFontLoaded] = useState(false);

  useEffect(() => {
    if (!document.querySelector('link[data-card-font="cinzel"]')) {
      const link = document.createElement('link');
      link.href = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;600;700&display=swap';
      link.rel = 'stylesheet';
      link.dataset.cardFont = 'cinzel';
      document.head.appendChild(link);
    }
    // cardRender.js's own weights: 500 (text box), 600 (card name),
    // bold/700 (everything else — stats, typing label, cost numerals, ...).
    Promise.all([
      document.fonts.load("500 16px 'Cinzel'"),
      document.fonts.load("600 16px 'Cinzel'"),
      document.fonts.load("700 16px 'Cinzel'"),
    ]).finally(() => setFontLoaded(true));
  }, []);

  return fontLoaded;
};

// Loads the three built-in border-art templates once per mount. Returns a
// ref holding the loaded HTMLImageElements (borderImages.current[key]) plus
// a `loaded` map for render-triggering — same shape TradingCardGenerator
// used locally before this was shared.
export const useBorderImages = () => {
  const borderImages = useRef({});
  const [loaded, setLoaded] = useState({});

  useEffect(() => {
    Object.entries(BORDER_IMAGE_SRC).forEach(([key, src]) => {
      const img = new Image();
      img.onload = () => {
        borderImages.current[key] = img;
        setLoaded(prev => ({ ...prev, [key]: true }));
      };
      img.src = src;
    });
  }, []);

  return { borderImages, loaded };
};

// Loads per-card illustration art (CARD_ART_SRC) and the matching
// transparent-art-box border variants (ART_BORDER_IMAGE_SRC) once per mount —
// same ref/loaded-map shape as useBorderImages, just keyed `art:<name>` /
// `border:<key>` so both sets can share one loaded map without colliding.
// Both are tiny (one card so far), so both load unconditionally rather than
// lazily per-card.
export const useCardArtImages = () => {
  const artImages = useRef({});
  const artBorderImages = useRef({});
  const [loaded, setLoaded] = useState({});

  useEffect(() => {
    const track = (key, src, targetRef) => {
      const img = new Image();
      img.onload = () => {
        targetRef.current[key] = img;
        setLoaded(prev => ({ ...prev, [key]: true }));
      };
      img.src = src;
    };
    Object.entries(CARD_ART_SRC).forEach(([name, src]) => track(`art:${name}`, src, artImages));
    Object.entries(ART_BORDER_IMAGE_SRC).forEach(([key, src]) => track(`border:${key}`, src, artBorderImages));
  }, []);

  return { artImages, artBorderImages, loaded };
};
