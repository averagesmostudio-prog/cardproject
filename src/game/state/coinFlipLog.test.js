import { describe, it, expect } from 'vitest';
import { extractCoinFlips } from './coinFlipLog.js';

const entry = (message) => ({ turn: 1, player: 'A', message });

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
