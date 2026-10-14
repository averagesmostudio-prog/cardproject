import { EFFIGY_COLORS } from './cardData.js';

export const EFFIGY_LABELS = {
  bleeding: 'Bleeding',
  timeless: 'Timeless',
  formless: 'Formless',
  living: 'Living',
  shifting: 'Shifting',
};

// The card face an Effigy is shown with in the Deck Builder: a CSV-shaped row
// in the same column layout cardRender.js already reads, so the Effigy can be
// drawn by the exact same renderer as every other card (on the Altar/Conjuring
// border — see EffigyCardCanvas).
export const buildEffigyCardRow = (color) => {
  const label = EFFIGY_LABELS[color] || color;
  return {
    'Card Name': `${label} Effigy`,
    'Card Typing': 'Effigy',
    'Effigy Costs': `1 ${label}`,
    'Casting Cost': '1',
    'Text Box': `Engage: Add one ${label} Essence.\nIf this is engaged at start of the End Step shuffle it into your Effigy Deck`,
    'Strength': 'XXX',
    'Lifespan': 'XXX',
    'Timer': 'XXX',
    'Arrows (Clockwise top center = 1)': 'XXX',
    'Set': '1',
    'Effigy type': label,
    'Rarity': 'C',
    'Watch': '0',
  };
};

export const EFFIGY_CARD_COLORS = EFFIGY_COLORS;
