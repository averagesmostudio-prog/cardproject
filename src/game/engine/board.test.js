import { describe, it, expect } from 'vitest';
import { cellId, computeMoveDestination, computeAttackCell, EFFIGY_DECK_CELL, EFFIGY_ZONE_CELL } from './board.js';

describe('computeMoveDestination (arrows — repositioning only)', () => {
  it('moves forward (direction 1) within a player\'s own realm', () => {
    // Player A: forward = +row. r1c3 (home) -> r2c3 (front).
    expect(computeMoveDestination('A', cellId(1, 3), 1)).toBe(cellId(2, 3));
  });

  it('never crosses the Ethereal Realm, even via the straight-forward direction', () => {
    expect(computeMoveDestination('A', cellId(2, 3), 1)).toBeNull();
  });

  it('never crosses the Ethereal Realm via a diagonal either', () => {
    expect(computeMoveDestination('A', cellId(2, 1), 2)).toBeNull();
    expect(computeMoveDestination('A', cellId(2, 3), 8)).toBeNull();
  });

  it('mirrors forward for Player B (whose home row is 5, front row 4)', () => {
    expect(computeMoveDestination('B', cellId(5, 3), 1)).toBe(cellId(4, 3));
    expect(computeMoveDestination('B', cellId(4, 3), 1)).toBeNull(); // would cross into Row 3
  });

  it('a sideways direction within the front row is a plain reposition', () => {
    expect(computeMoveDestination('A', cellId(2, 2), 3)).toBe(cellId(2, 3));
  });

  it('rejects a reposition onto a reserved Effigy Deck/Zone corner cell', () => {
    // r1c2, direction 7 (left) -> r1c1, which is Player A's Effigy Deck cell.
    expect(computeMoveDestination('A', cellId(1, 2), 7)).toBeNull();
  });

  it('rejects a direction that would go out of bounds', () => {
    expect(computeMoveDestination('A', cellId(1, 1), 8)).toBeNull(); // forward-left off the left edge
  });

  it('returns null for an invalid direction number', () => {
    expect(computeMoveDestination('A', cellId(2, 3), 0)).toBeNull();
    expect(computeMoveDestination('A', cellId(2, 3), 9)).toBeNull();
  });
});

describe('computeAttackCell (always available from the front row, regardless of arrows)', () => {
  it('attacks straight across into the mirrored front-row cell', () => {
    expect(computeAttackCell('A', cellId(2, 3))).toBe(cellId(4, 3));
    expect(computeAttackCell('B', cellId(4, 3))).toBe(cellId(2, 3));
  });

  it('is null from the home row — must reach the front row first', () => {
    expect(computeAttackCell('A', cellId(1, 3))).toBeNull();
    expect(computeAttackCell('B', cellId(5, 3))).toBeNull();
  });

  it('is null from the Ethereal Realm', () => {
    expect(computeAttackCell('A', cellId(3, 3))).toBeNull();
  });

  it('reserved cells only exist in home rows, never front rows — sanity check', () => {
    expect(EFFIGY_DECK_CELL.A).toBe(cellId(1, 1));
    expect(EFFIGY_ZONE_CELL.A).toBe(cellId(1, 5));
  });
});
