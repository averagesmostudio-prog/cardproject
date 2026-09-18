// 5x5 board model. Rows are 1-5 top to bottom, columns 1-5 left to right.
//
//   Row 1: Player A home row      (deck r1c1, summon r1c2-4, zone r1c5)
//   Row 2: Player A front row     (Beings only)
//   Row 3: Ethereal Realm         (Prophecies only, shared, no combat)
//   Row 4: Player B front row     (mirrors Row 2)
//   Row 5: Player B home row      (zone r5c1, summon r5c2-4, deck r5c5)

export const ROWS = 5;
export const COLS = 5;

export const cellId = (row, col) => `r${row}c${col}`;

export const parseCellId = (id) => {
  const match = /^r(\d)c(\d)$/.exec(id);
  if (!match) return null;
  return { row: parseInt(match[1], 10), col: parseInt(match[2], 10) };
};

export const HOME_ROW = { A: 1, B: 5 };
export const FRONT_ROW = { A: 2, B: 4 };
export const ETHEREAL_ROW = 3;

export const EFFIGY_DECK_CELL = { A: cellId(1, 1), B: cellId(5, 5) };
export const EFFIGY_ZONE_CELL = { A: cellId(1, 5), B: cellId(5, 1) };

export const SUMMON_CELLS = {
  A: [2, 3, 4].map(col => cellId(1, col)),
  B: [2, 3, 4].map(col => cellId(5, col)),
};

export const owningPlayerOfRow = (row) => {
  if (row === 1 || row === 2) return 'A';
  if (row === 4 || row === 5) return 'B';
  return null; // Ethereal Realm has no owner
};

export const isMortalRealm = (row) => row !== ETHEREAL_ROW;

const RESERVED_CELLS = new Set([
  EFFIGY_DECK_CELL.A, EFFIGY_ZONE_CELL.A, EFFIGY_DECK_CELL.B, EFFIGY_ZONE_CELL.B,
]);

// Rows each player controls in the Mortal Realm (their home row + front row).
export const MORTAL_ROWS = { A: [1, 2], B: [4, 5] };

// Every cell a player controls in the Mortal Realm, minus the reserved
// Effigy Deck/Zone corners — where a Relic may be placed (RULES.md > Card
// types). 8 cells per player: the 3 open home-row summon cells + the full
// 5-cell front row.
export const mortalCellsFor = (playerId) => {
  const cells = [];
  MORTAL_ROWS[playerId].forEach(row => {
    for (let col = 1; col <= COLS; col++) cells.push(cellId(row, col));
  });
  return cells.filter(c => !RESERVED_CELLS.has(c));
};

export const opponentOf = (player) => (player === 'A' ? 'B' : 'A');

// Arrow directions, clockwise from the card's own "top" (= forward, printed
// on the card as position 1), as (dRow, dCol) deltas in a reference frame
// where forward = +row and the card's own right = +col:
//   1 forward, 2 forward-right, 3 right, 4 backward-right,
//   5 backward, 6 backward-left, 7 left, 8 forward-left.
const BASE_DIRECTIONS = {
  1: [1, 0],
  2: [1, 1],
  3: [0, 1],
  4: [-1, 1],
  5: [-1, 0],
  6: [-1, -1],
  7: [0, -1],
  8: [1, -1],
};

// Player B's side of the board is the 180°-rotated mirror of Player A's, so
// a card's own printed "forward"/"right" flips sign for B: forward = -row.
export const directionDelta = (playerId, dirNum) => {
  const base = BASE_DIRECTIONS[dirNum];
  if (!base) return null;
  const sign = playerId === 'A' ? 1 : -1;
  return [base[0] * sign, base[1] * sign];
};

// Arrows are purely a movement capability ("available movements when
// disengaged") — they never cross the Ethereal Realm and never attack.
// Resolves where a Being's given arrow direction leads from `fromCellId` as
// a plain reposition within its own realm. Returns null if the direction is
// illegal: out of bounds, blocked by Row 3 (Beings can't enter the Ethereal
// Realm — not even to attack, via arrows), or onto a reserved Effigy Deck/
// Zone corner cell.
export const computeMoveDestination = (playerId, fromCellId, dirNum) => {
  const { row, col } = parseCellId(fromCellId);
  const delta = directionDelta(playerId, dirNum);
  if (!delta) return null;
  const [dRow, dCol] = delta;

  const targetRow = row + dRow;
  const targetCol = col + dCol;
  if (targetRow === ETHEREAL_ROW) return null;
  if (targetRow < 1 || targetRow > ROWS || targetCol < 1 || targetCol > COLS) return null;

  const toCellId = cellId(targetRow, targetCol);
  if (RESERVED_CELLS.has(toCellId)) return null;
  return toCellId;
};

// Beings can always attack (unless a card says otherwise — not modeled
// yet), independent of their arrows. An attack always goes straight
// forward, crossing the Ethereal Realm into the mirrored cell in the same
// column on the opponent's side. Only possible from the front row (Row 2
// for A, Row 4 for B) — a Being in its home row must first move to the
// front row via its arrows before it can attack.
export const computeAttackCell = (playerId, fromCellId) => {
  const { row, col } = parseCellId(fromCellId);
  if (row === FRONT_ROW.A) return cellId(FRONT_ROW.B, col);
  if (row === FRONT_ROW.B) return cellId(FRONT_ROW.A, col);
  return null;
};
