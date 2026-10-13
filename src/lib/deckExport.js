// Shared deck-list interchange format between the card Generator (export)
// and the Game's deckbuilder (import) — plain enough that a hand-written
// list works too.

export const DECK_EXPORT_FORMAT = 'tcg-deck';
// Version 2 adds `effigyDeck` (per-color Effigy counts) next to `mainDeck` —
// a game deck is a Main Deck AND an Effigy Deck, and an export that dropped
// the Effigy half couldn't be played as exported. Version 1 files (main deck
// only, e.g. from the Generator) still import fine.
export const DECK_EXPORT_VERSION = 2;

export const buildDeckExport = (entries, { effigyCounts = null, name = null } = {}) => ({
  format: DECK_EXPORT_FORMAT,
  version: DECK_EXPORT_VERSION,
  exportedAt: new Date().toISOString(),
  ...(name ? { name } : {}),
  mainDeck: entries.map(({ name: cardName, count }) => ({ name: cardName, count })),
  ...(effigyCounts ? {
    effigyDeck: Object.fromEntries(
      Object.entries(effigyCounts).map(([color, n]) => [color, Math.max(0, Math.floor(Number(n)) || 0)]).filter(([, n]) => n > 0)
    ),
  } : {}),
});

// Reads the Effigy half of an export: a { color: count } object. Returns null
// when absent or unusable; unknown colors are dropped and counts floored.
const parseEffigyDeck = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const counts = {};
  Object.entries(raw).forEach(([color, n]) => {
    const count = Math.floor(Number(n));
    if (typeof color === 'string' && color && Number.isFinite(count) && count > 0) counts[color.toLowerCase()] = count;
  });
  return Object.keys(counts).length > 0 ? counts : null;
};

// Same as parseDeckImport but also returns the Effigy Deck when the file has
// one: { entries, effigyCounts } (effigyCounts null for a main-deck-only file,
// a plain "3x Card Name" list, or a v1 export).
export const parseDeckImportFull = (text) => {
  const entries = parseDeckImport(text);
  let effigyCounts = null;
  if (text.trim().startsWith('{')) {
    try { effigyCounts = parseEffigyDeck(JSON.parse(text.trim()).effigyDeck); } catch { effigyCounts = null; }
  }
  return { entries, effigyCounts };
};

// Parses either the JSON export above, or a plain "3x Card Name" / "3 Card
// Name" per line .txt list (the format the Generator's own decklist
// download already produces, and simple enough to hand-write). Returns
// [{ name, count }]; throws an Error with a user-facing message on failure.
export const parseDeckImport = (text) => {
  const trimmed = text.trim();

  if (trimmed.startsWith('{')) {
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch {
      throw new Error('That file isn\'t valid JSON.');
    }
    if (!Array.isArray(data.mainDeck)) {
      throw new Error('That JSON file doesn\'t have a "mainDeck" list.');
    }
    const entries = data.mainDeck
      .map(e => ({ name: String(e?.name || '').trim(), count: parseInt(e?.count, 10) }))
      .filter(e => e.name && Number.isFinite(e.count) && e.count > 0);
    if (entries.length === 0) throw new Error('That deck file has no cards in it.');
    return entries;
  }

  const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
  const entries = [];
  lines.forEach(line => {
    const match = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    if (match) {
      entries.push({ name: match[2].trim(), count: parseInt(match[1], 10) });
    }
  });
  if (entries.length === 0) {
    throw new Error('Couldn\'t find any "3x Card Name" style lines in that file.');
  }
  return entries;
};
