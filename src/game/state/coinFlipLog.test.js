import { describe, it, expect } from 'vitest';
import { extractCoinFlips, initialHold, advanceHold, releaseHold, resolveOldestFlip } from './coinFlipLog.js';

const entry = (message) => ({ turn: 1, player: 'A', message });
// a stand-in for the engine state: only `log` matters to the hold, `board` lets us tell snapshots apart
const stateWith = (board, ...messages) => ({ board, log: messages.map(entry) });

describe('extractCoinFlips', () => {
  it('reads heads and tails from a card-driven flip, keeping the source text', () => {
    const out = extractCoinFlips([
      entry("Ambiguity's Conjure flips a coin: heads."),
      entry("Illegible Grimoire's Engage flips a coin: tails."),
    ]);
    expect(out).toEqual([
      { source: "Ambiguity's Conjure", heads: true },
      { source: "Illegible Grimoire's Engage", heads: false },
    ]);
  });

  it('ignores the start-of-game flip and every unrelated log line', () => {
    expect(extractCoinFlips([
      entry('Coin flip: A goes first.'),
      entry("Witching Well's Engage draws a card."),
      entry('Player A attacks.'),
      { turn: 0, player: null },
    ])).toEqual([]);
  });

  it('returns several flips from one batch of entries, in order', () => {
    const out = extractCoinFlips([
      entry("Witching Well's Engage flips a coin: tails."),
      entry('Something else happens.'),
      entry("Witching Well's Engage flips a coin: heads."),
    ]);
    expect(out.map(f => f.heads)).toEqual([false, true]);
  });
});

describe('coin-flip display hold', () => {
  const before = stateWith('before', 'Coin flip: A goes first.');
  const flipped = stateWith('after-flip', 'Coin flip: A goes first.', "Witching Well's Engage flips a coin: heads.", 'A draws a card.');

  it('just follows the live state while no coin flip is involved', () => {
    const next = stateWith('moved', 'Coin flip: A goes first.', 'A attacks.');
    const hold = advanceHold(initialHold(before), next);
    expect(hold.shown).toBe(next);
    expect(hold.pending).toEqual([]);
  });

  it('freezes the screen on the pre-flip state the moment a flip lands in the log', () => {
    const hold = advanceHold(initialHold(before), flipped);
    expect(hold.shown).toBe(before);          // the heads result (and its draw) is NOT on screen yet
    expect(hold.pending).toEqual([{ source: "Witching Well's Engage", heads: true, seq: 1 }]);
    expect(hold.prevLive).toBe(flipped);
  });

  it('keeps holding through further live changes while a toss is still playing', () => {
    const held = advanceHold(initialHold(before), flipped);
    const later = stateWith('ai-acted', ...flipped.log.map(e => e.message), 'B summons a Being.');
    const hold = advanceHold(held, later);
    expect(hold.shown).toBe(before);
    expect(hold.pending).toHaveLength(1);
    expect(hold.prevLive).toBe(later);
  });

  it('catches the screen up to the latest live state once the toss is resolved', () => {
    let hold = advanceHold(initialHold(before), flipped);
    const later = stateWith('ai-acted', ...flipped.log.map(e => e.message), 'B summons a Being.');
    hold = advanceHold(hold, later);
    expect(releaseHold(hold, later).shown).toBe(before);              // still pending: no release
    hold = resolveOldestFlip(hold);
    expect(hold.pending).toEqual([]);
    expect(releaseHold(hold, later).shown).toBe(later);               // now it reveals everything at once
  });

  it('queues two flips from one update and plays them oldest first', () => {
    const two = stateWith('after-two', ...before.log.map(e => e.message),
      "Illegible Grimoire's Engage flips a coin: heads.", "Illegible Grimoire's Engage flips a coin: tails.");
    let hold = advanceHold(initialHold(before), two);
    expect(hold.pending.map(f => [f.heads, f.seq])).toEqual([[true, 1], [false, 2]]);
    hold = resolveOldestFlip(hold);
    expect(hold.pending.map(f => f.heads)).toEqual([false]);
    expect(releaseHold(hold, two).shown).toBe(before);                // second toss still to come
    hold = resolveOldestFlip(hold);
    expect(releaseHold(hold, two).shown).toBe(two);
  });

  it('numbers each toss uniquely across separate flips', () => {
    let hold = advanceHold(initialHold(before), flipped);
    hold = releaseHold(resolveOldestFlip(hold), flipped);
    const again = stateWith('again', ...flipped.log.map(e => e.message), "Witching Well's Engage flips a coin: tails.");
    hold = advanceHold(hold, again);
    expect(hold.pending.map(f => f.seq)).toEqual([2]);
  });

  it('resets cleanly when the log restarts (a new match)', () => {
    const held = advanceHold(initialHold(before), flipped);
    const fresh = stateWith('new-match', 'Coin flip: B goes first.');
    const hold = advanceHold(held, fresh);
    expect(hold.shown).toBe(fresh);
    expect(hold.pending).toEqual([]);
  });

  it('returns the same hold object when the live state has not changed', () => {
    const hold = initialHold(before);
    expect(advanceHold(hold, before)).toBe(hold);
  });
});
