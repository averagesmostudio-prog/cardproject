import React, { useEffect, useRef, useState } from 'react';
import { createRelayClient, createGameChannel } from '../net/relayClient.js';
import { getRelayAddress, setRelayAddress } from '../../lib/relayAddress.js';

// Host/join/quick-match pairing screen for a two-player-over-the-network
// match — the net-mode counterpart to picking "vs AI" in GameApp.jsx.
// Visual shell modeled on CoinFlip.jsx's (full-bleed black backdrop,
// centered white rounded-lg shadow card, max-w-md).
//
// Three ways to pair up: host (get a code to share), join (enter a
// friend's code), or quick match (the relay server auto-pairs you with
// whoever else is looking right now — server/roomRegistry.mjs's
// quickMatchQueue). Host/join let two people who already know each other
// play; quick match doesn't need that, at the cost of playing a stranger
// under this app's trusted, no-anti-cheat design — same tradeoff flagged
// when this was scoped.
//
// Host is always seat A, peer is always seat B. For host/join the client
// picks its own role up front (hosting = seat A, joining = seat B); quick
// match can't know in advance which side of the pairing it'll be, so the
// server tells every path its role in the 'paired' message itself (`role:
// 'host'|'peer'`) and all three handlers below read it the same way,
// rather than host/join continuing to assume their role locally.
//
// onPaired({ gameChannel, relayClient, netRole, mySeat }) fires once the
// relay server reports both sides connected.
export default function NetLobby({ onPaired, onBack }) {
  const [mode, setMode] = useState(null); // null | 'host' | 'join' | 'quick'
  const [address, setAddress] = useState(getRelayAddress());
  const [joinCode, setJoinCode] = useState('');
  const [roomCode, setRoomCode] = useState(null); // host's own code, once created
  const [status, setStatus] = useState('idle'); // 'idle' | 'connecting' | 'waiting' | 'searching' | 'error'
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
        onPaired({ gameChannel: createGameChannel(relayClient), relayClient, netRole: msg.role, mySeat: msg.role === 'host' ? 'A' : 'B' });
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
        onPaired({ gameChannel: createGameChannel(relayClient), relayClient, netRole: msg.role, mySeat: msg.role === 'host' ? 'A' : 'B' });
      }
    });
    relayClient.onClose(() => {
      setStatus((s) => (s === 'paired' ? s : 'error'));
      setError('Lost connection to the relay server.');
    });
  };

  const startQuickMatch = () => {
    setRelayAddress(address);
    setMode('quick');
    setStatus('connecting');
    setError(null);
    const relayClient = createRelayClient(address);
    clientRef.current = relayClient;
    relayClient.onOpen(() => {
      relayClient.send({ type: 'find-match' });
    });
    relayClient.onMessage((msg) => {
      if (msg.type === 'searching') {
        setStatus('searching');
      }
      if (msg.type === 'paired') {
        handedOffRef.current = true;
        setStatus('paired');
        onPaired({ gameChannel: createGameChannel(relayClient), relayClient, netRole: msg.role, mySeat: msg.role === 'host' ? 'A' : 'B' });
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
        <p className="text-sm text-stone-500 mb-6">Find an opponent automatically, or play a friend directly.</p>

        {mode === null && (
          <>
            <label className="block text-left text-xs text-stone-500 mb-1">Relay server address</label>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full mb-6 px-3 py-2 border border-stone-300 rounded-lg text-sm font-mono"
              placeholder="ws://localhost:8787"
            />
            <button
              onClick={startQuickMatch}
              className="w-full mb-5 px-5 py-2.5 bg-amber-600 text-white rounded-lg font-semibold hover:bg-amber-700 transition"
            >
              Quick Match
            </button>
            <div className="flex items-center gap-3 mb-5">
              <div className="flex-1 h-px bg-stone-200" />
              <span className="text-xs text-stone-400 uppercase tracking-wide">Or play a friend</span>
              <div className="flex-1 h-px bg-stone-200" />
            </div>
            <div className="flex gap-3 justify-center">
              <button onClick={startHost} className="px-5 py-2 border border-stone-300 rounded-lg font-semibold hover:bg-stone-50 transition">
                Host a match
              </button>
              <button onClick={startJoin} className="px-5 py-2 border border-stone-300 rounded-lg font-semibold hover:bg-stone-50 transition">
                Join a match
              </button>
            </div>
          </>
        )}

        {mode === 'quick' && (
          <>
            {status === 'connecting' && <p className="text-sm text-stone-500">Connecting…</p>}
            {status === 'searching' && <p className="text-sm text-stone-500 animate-pulse">Searching for an opponent…</p>}
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
