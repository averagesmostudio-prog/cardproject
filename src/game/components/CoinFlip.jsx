import React, { useEffect, useState } from 'react';

// A short interactive coin-flip sequence run before the match is created
// (so hands are dealt only once turn order is settled — RULES.md > Turn
// structure). Whoever is randomly chosen to "call it" — the human or the
// AI, 50/50 — picks Heads or Tails; if the flip matches their call they win
// the flip and choose who goes first, otherwise the other player does.
// `onResolved(startingPlayer)` fires once that choice is made.
export default function CoinFlip({ onResolved }) {
  const [caller] = useState(() => (Math.random() < 0.5 ? 'human' : 'ai'));
  const [call, setCall] = useState(null); // 'heads' | 'tails' once called
  const [result, setResult] = useState(null); // 'heads' | 'tails' once flipped

  const winner = result && call ? (call === result ? caller : (caller === 'human' ? 'ai' : 'human')) : null;
  // Derived, not stored — true for exactly the window between a call coming
  // in and the flip landing.
  const flipping = !!call && !result;

  // The AI calls its own side automatically, after a beat so the "who
  // calls it" reveal isn't instant.
  useEffect(() => {
    if (caller !== 'ai' || call) return;
    const t = setTimeout(() => setCall(Math.random() < 0.5 ? 'heads' : 'tails'), 900);
    return () => clearTimeout(t);
  }, [caller, call]);

  // Once a call is in (either side), flip the coin after a short delay.
  useEffect(() => {
    if (!call || result) return;
    const t = setTimeout(() => {
      setResult(Math.random() < 0.5 ? 'heads' : 'tails');
    }, 1100);
    return () => clearTimeout(t);
  }, [call, result]);

  // If the AI wins, it always elects to go first — the simplest sensible
  // default, same spirit as the rest of this engine's greedy AI (ai.js).
  useEffect(() => {
    if (winner !== 'ai') return;
    const t = setTimeout(() => onResolved('B'), 1400);
    return () => clearTimeout(t);
  }, [winner, onResolved]);

  const label = (side) => (side === 'heads' ? 'Heads' : 'Tails');

  return (
    <div className="min-h-screen flex items-center justify-center bg-black p-8">
      <div className="max-w-md w-full text-center bg-white rounded-lg shadow p-8">
        <h2 className="text-lg font-bold text-stone-800 mb-1">Coin flip</h2>
        <p className="text-sm text-stone-500 mb-6">The winner decides who goes first.</p>

        <div
          className={`mx-auto mb-6 w-24 h-24 rounded-full border-4 border-stone-800 flex items-center justify-center
            text-2xl font-bold text-stone-800 bg-amber-100 transition-transform duration-300
            ${flipping ? 'animate-spin' : ''}`}
        >
          {result ? label(result) : '?'}
        </div>

        {!call && caller === 'human' && (
          <>
            <p className="text-sm text-stone-600 mb-4">You call it — heads or tails?</p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => setCall('heads')}
                className="px-5 py-2 bg-stone-800 text-white rounded-lg font-semibold hover:bg-stone-700 transition"
              >
                Heads
              </button>
              <button
                onClick={() => setCall('tails')}
                className="px-5 py-2 bg-stone-800 text-white rounded-lg font-semibold hover:bg-stone-700 transition"
              >
                Tails
              </button>
            </div>
          </>
        )}

        {!call && caller === 'ai' && (
          <p className="text-sm text-stone-500 italic">Opponent is calling it…</p>
        )}

        {call && !result && (
          <p className="text-sm text-stone-500">
            {caller === 'human' ? 'You call' : 'Opponent calls'} <span className="font-semibold text-stone-700">{label(call)}</span> — flipping…
          </p>
        )}

        {result && !winner && (
          <p className="text-sm text-stone-500">Landed on {label(result)}…</p>
        )}

        {winner === 'human' && (
          <>
            <p className="text-sm text-stone-700 mb-4 font-semibold">
              It's {label(result)} — you {call === result ? 'called it right' : "didn't call it, but won anyway"}! You go first, or let the opponent?
            </p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => onResolved('A')}
                className="px-5 py-2 bg-amber-600 text-white rounded-lg font-semibold hover:bg-amber-700 transition"
              >
                I go first
              </button>
              <button
                onClick={() => onResolved('B')}
                className="px-5 py-2 border border-stone-300 rounded-lg font-semibold hover:bg-stone-50 transition"
              >
                Opponent goes first
              </button>
            </div>
          </>
        )}

        {winner === 'ai' && (
          <p className="text-sm text-stone-700 font-semibold">
            It's {label(result)} — the opponent wins the flip and chooses to go first.
          </p>
        )}
      </div>
    </div>
  );
}
