// Cosmetic-only helpers for Library-saved decks: a color derived from the
// deck's own Effigy mix, and a random icon picked once at save time and
// persisted on the record (deckLibrary.js) — never re-randomized on
// re-render. Precons (precons.js) already carry their own explicit
// `color`/`icon`, so this module is only ever used for saved decks.
import {
  Shield, Crown, Flame, Zap, Snowflake, Skull, Ghost, Swords, Axe, Hammer,
  Wand2, BookOpen, ScrollText, Gem, Anchor, Feather, Bird, Rat, Moon, Sun,
  Star, Crosshair, Castle,
} from 'lucide-react';
import { EFFIGY_COLORS } from './cardData.js';

export const DECK_ICON_MAP = {
  shield: Shield, crown: Crown, flame: Flame, zap: Zap, snowflake: Snowflake,
  skull: Skull, ghost: Ghost, swords: Swords, axe: Axe, hammer: Hammer,
  wand: Wand2, book: BookOpen, scroll: ScrollText, gem: Gem, anchor: Anchor,
  feather: Feather, bird: Bird, rat: Rat, moon: Moon, sun: Sun, star: Star,
  crosshair: Crosshair, castle: Castle,
};
const ICON_KEYS = Object.keys(DECK_ICON_MAP);

export const pickRandomIconKey = (rng = Math.random) => ICON_KEYS[Math.floor(rng() * ICON_KEYS.length)];
export const getDeckIcon = (key) => DECK_ICON_MAP[key] || Shield;

// Highest-count Effigy color, ties broken by EFFIGY_COLORS' own declared
// order (matches this codebase's existing "first in EFFIGY_COLORS wins a
// tie" convention elsewhere).
export const deriveDominantColor = (effigyCounts) => {
  let best = EFFIGY_COLORS[0];
  let bestCount = -1;
  EFFIGY_COLORS.forEach(c => {
    const n = effigyCounts?.[c] || 0;
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  });
  return best;
};
