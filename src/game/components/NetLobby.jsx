import React, { useEffect, useRef, useState } from 'react';
import { createRelayClient, createGameChannel } from '../net/relayClient.js';
import { getRelayAddress, setRelayAddress } from '../../lib/relayAddress.js';

// Host/join pairing screen for a two-player-over-the-network match — the
// net-mode counterpart to picking "vs AI" in GameApp.jsx. Visual shell
// modeled on CoinFlip.jsx's (full-bleed black backdrop, centered white
// rounded-lg shadow card, max-w-md).
//
// Host is always seat A, peer is always seat B — fixed at pairing, not
// coin-flip-derived. Seat assignment (which player-id each client renders
// as "me") is orthogonal to turn order (who goes first, which the coin
// flip after this screen decides) — keeping them separate means "who's
// authoritative for building the initial state" is simply "whoever
// hosted," with no extra negotiation.
//
// onPaired({ gameChannel, relayClient, netRole, mySeat }) fires once the
// relay server reports both sides connected.
export default function NetLobby({ onPaired, onBack }) {
  const [mode, setMode] = useState(null); // null | 'host' | 'join'
  const [address, setAddress] = useState(getRelayAddress());
  const [joinCode, setJoinCode] = useState('');
  const [roomCode, setRoomCode] = useState(null); // host's own code, once created
  const [status, setStatus] = useState('idle'); // 'idle' | 'connecting' | 'waiting' | 'error'
  const [error, setError] = useState(null);
  const clientRef = useRef(null);
  // Set synchronously (not via setStatus) the instant onPaired is called —
  // onPaired's own setNet/setScreen in NetGameApp lands in the SAME React
  // batch as this component's own setStatus('paired') below, so NetLobby
  // can unmount before a 'paired'-status render of it ever actually
  // commits; a statusRef fed from a render-timed effect would still read
  // the previous, pre-paired status at cleanup time. This ref sidesteps
  // that entirely by not depending on React's render/commit timing at all.
  const handedOffRef = useRef(false);

  // Unmount-only teardown (empty deps — a [status] dep here would rerun
  // this cleanup on every status TRANSITION, not just on unmount, closing
  // the socket moments after it opens).
  useEffect(() => () => {
    // Only tear down a connection that never got handed off to onPaired —
    // once paired, the caller (NetGameApp) owns the relayClient's lifetime.
    if (clientRef.current && !handedOffRef.current) clientRef.current.close();
  }, []);

  const startHost = () => {
    setRelayAddress(address);
    setMode('host');
    setStatus('connecting');
    setError(null);
    const relayClient = createRelayClient(address);
    clientRef.current = relayClient;
    relayClient.onOpen(() => {
      relayClient.send({ type: 'create-room' });
    });
    relayClient.onMessage((msg) => {
      if (msg.type === 'room-created') {
        setRoomCode(msg.code);
        setStatus('waiting');
      }
      if (msg.type === 'paired') {
        handedOffRef.current = true;
        setStatus('paired');
        onPaired({ gameChannel: createGameChannel(relayClient), relayClient, netRole: 'host', mySeat: 'A' });
      }
    });
    relayClient.onClose(() => {
      setStatus((s) => (s === 'paired' ? s : 'error'));
      setError('Lost connection to the relay server.');
    });
  };

  const startJoin = () => {
    setRelayAddress(address);
    setMode('join');
  };

  const attemptJoin = () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) return;
    setStatus('connecting');
    setError(null);
    const relayClient = createRelayClient(address);
    clientRef.current = relayClient;
    relayClient.onOpen(() => {
      relayClient.send({ type: 'join-room', code });
    });
    relayClient.onMessage((msg) => {
      if (msg.type === 'join-error') {
        setStatus('error');
        setError(msg.reason === 'full' ? 'That room already has two players.' : 'No room found with that code.');
      }
      if (msg.type === 'paired') {
        handedOffRef.current = true;
        setStatus('paired');
        onPaired({ gameChannel: createGameChannel(relayClient), relayClient, netRole: 'peer', mySeat: 'B' });
      }
    });
    relayClient.onClose(() => {
      setStatus((s) => (s === 'paired' ? s : 'error'));
      setError('Lost connection to the relay server.');
    });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-black p-8">
      <div className="max-w-md w-full text-center bg-white rounded-lg shadow p-8">
        <h2 className="text-lg font-bold text-stone-800 mb-1">Play Online</h2>
        <p className="text-sm text-stone-500 mb-6">Host a match, or join with a code.</p>

        {mode === null && (
          <>
            <label className="block text-left text-xs text-stone-500 mb-1">Relay server address</label>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full mb-6 px-3 py-2 border border-stone-300 rounded-lg text-sm font-mono"
              placeholder="ws://localhost:8787"
            />
            <div className="flex gap-3 justify-center">
              <button onClick={startHost} className="px-5 py-2 bg-amber-600 text-white rounded-lg font-semibold hover:bg-amber-700 transition">
                Host a match
              </button>
              <button onClick={startJoin} className="px-5 py-2 border border-stone-300 rounded-lg font-semibold hover:bg-stone-50 transition">
                Join a match
              </button>
            </div>
          </>
        )}

        {mode === 'host' && (
          <>
            {status === 'connecting' && <p className="text-sm text-stone-500">Connecting…</p>}
            {status === 'waiting' && (
              <>
                <p className="text-sm text-stone-600 mb-2">Share this code with your opponent:</p>
                <div className="text-3xl font-mono font-bold tracking-widest text-stone-800 mb-4">{roomCode}</div>
                <p className="text-sm text-stone-500 animate-pulse">Waiting for opponent…</p>
              </>
            )}
          </>
        )}

        {mode === 'join' && status !== 'connecting' && status !== 'paired' && (
          <>
            <label className="block text-left text-xs text-stone-500 mb-1">Room code</label>
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              className="w-full mb-4 px-3 py-2 border border-stone-300 rounded-lg text-sm font-mono uppercase tracking-widest text-center"
              placeholder="ABCD"
              maxLength={4}
            />
            <button onClick={attemptJoin} className="px-5 py-2 bg-amber-600 text-white rounded-lg font-semibold hover:bg-amber-700 transition">
              Connect
            </button>
          </>
        )}

        {mode === 'join' && status === 'connecting' && <p className="text-sm text-stone-500">Connecting…</p>}

        {status === 'error' && (
          <p className="text-sm text-red-500 mt-4">{error}</p>
        )}

        <div className="mt-6">
          <button onClick={onBack} className="text-xs text-stone-400 hover:text-stone-600">← Menu</button>
        </div>
      </div>
    </div>
  );
}
