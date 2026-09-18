// Shared deck-list interchange format between the card Generator (export)
// and the Game's deckbuilder (import) — plain enough that a hand-written
// list works too.

export const DECK_EXPORT_FORMAT = 'tcg-deck';
export const DECK_EXPORT_VERSION = 1;

export const buildDeckExport = (entries) => ({
  format: DECK_EXPORT_FORMAT,
  version: DECK_EXPORT_VERSION,
  exportedAt: new Date().toISOString(),
  mainDeck: entries.map(({ name, count }) => ({ name, count })),
});

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
