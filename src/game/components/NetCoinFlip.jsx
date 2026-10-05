import React, { useEffect, useState } from 'react';

// Net-mode counterpart to CoinFlip.jsx — NOT a retrofit of it. CoinFlip's
// own state machine is tightly built around two independently-Math.random()'d
// roles (a caller and a flip) that don't map cleanly onto "only one side's
// randomness counts," so this is a small fresh component instead. Only the
// host ever calls Math.random(); NetGameApp (which owns all of this
// match's networking, and outlives any one screen) relays the result to the
// peer and hands it back down as `peerResult`.
//
// This component is purely presentational/host-random — it does no
// gameChannel listening of its own. A peer's `coin-flip-result` message can
// arrive before this screen is even mounted (NetGameApp only switches to
// 'coinflip' once its own long-lived listener has stored the result), so
// `peerResult` is passed in already-resolved rather than awaited here.
//
// `netRole`: 'host' | 'peer'. `mySeat`: 'A' | 'B' (this client's own seat).
// `peerResult`: {result, startingPlayer} | null — only meaningful for the
// peer. `onHostResolved({result, startingPlayer})` — host-only, fires once
// the host's own choice is made, so NetGameApp can relay it.
// `onResolved(startingPlayer)` fires once the outcome is known on this
// client, however it got here — same shape as CoinFlip.jsx's own
// onResolved.
export default function NetCoinFlip({ netRole, mySeat, peerResult, onHostResolved, onResolved }) {
  const isHost = netRole === 'host';
  const [call, setCall] = useState(null); // host's own call: 'heads' | 'tails'
  const [hostResult, setHostResult] = useState(null);
  const [hostStartingPlayer, setHostStartingPlayer] = useState(null);

  const result = isHost ? hostResult : peerResult?.result ?? null;
  const startingPlayer = isHost ? hostStartingPlayer : peerResult?.startingPlayer ?? null;
  const flipping = isHost && !!call && !hostResult;

  // Host flips automatically, after a beat so it isn't instant.
  useEffect(() => {
    if (!isHost || call) return;
    const t = setTimeout(() => setCall(Math.random() < 0.5 ? 'heads' : 'tails'), 600);
    return () => clearTimeout(t);
  }, [isHost, call]);

  useEffect(() => {
    if (!isHost || !call || hostResult) return;
    const t = setTimeout(() => setHostResult(Math.random() < 0.5 ? 'heads' : 'tails'), 1100);
    return () => clearTimeout(t);
  }, [isHost, call, hostResult]);

  const chooseStartingPlayer = (player) => {
    setHostStartingPlayer(player);
    onHostResolved({ result: hostResult, startingPlayer: player });
  };

  useEffect(() => {
    if (!startingPlayer) return;
    const t = setTimeout(() => onResolved(startingPlayer), 900);
    return () => clearTimeout(t);
  }, [startingPlayer, onResolved]);

  const label = (side) => (side === 'heads' ? 'Heads' : 'Tails');
  const meLabel = (player) => (player === mySeat ? 'You go' : 'Opponent goes');

  return (
    <div className="min-h-dvh flex items-center justify-center bg-black p-8 short:p-2">
      <div className="max-w-md w-full text-center bg-white rounded-lg shadow p-8">
        <h2 className="text-lg font-bold text-stone-800 mb-1">Coin flip</h2>
        <p className="text-sm text-stone-500 mb-6">The host's flip decides who goes first.</p>

        <div
          className={`mx-auto mb-6 w-24 h-24 rounded-full border-4 border-stone-800 flex items-center justify-center
            text-2xl font-bold text-stone-800 bg-amber-100 transition-transform duration-300
            ${flipping ? 'animate-spin' : ''}`}
        >
          {result ? label(result) : '?'}
        </div>

        {isHost && !result && <p className="text-sm text-stone-500 italic">Flipping…</p>}
        {!isHost && !result && <p className="text-sm text-stone-500 italic">Waiting on the host's flip…</p>}

        {result && !startingPlayer && isHost && (
          <>
            <p className="text-sm text-stone-700 mb-4 font-semibold">It's {label(result)} — who goes first?</p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => chooseStartingPlayer(mySeat)}
                className="px-5 py-2 bg-amber-600 text-white rounded-lg font-semibold hover:bg-amber-700 transition"
              >
                I go first
              </button>
              <button
                onClick={() => chooseStartingPlayer(mySeat === 'A' ? 'B' : 'A')}
                className="px-5 py-2 border border-stone-300 rounded-lg font-semibold hover:bg-stone-50 transition"
              >
                Opponent goes first
              </button>
            </div>
          </>
        )}

        {result && !startingPlayer && !isHost && (
          <p className="text-sm text-stone-500">It's {label(result)} — waiting on the host to choose who goes first…</p>
        )}

        {startingPlayer && (
          <p className="text-sm text-stone-700 font-semibold">
            It's {label(result)} — {meLabel(startingPlayer).toLowerCase()} first.
          </p>
        )}
      </div>
    </div>
  );
}
