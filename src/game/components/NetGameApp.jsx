import React, { useEffect, useState } from 'react';
import NetLobby from './NetLobby.jsx';
import DeckImport from './DeckImport.jsx';
import PreconSelect from './PreconSelect.jsx';
import DeckBuilder from './DeckBuilder.jsx';
import NetCoinFlip from './NetCoinFlip.jsx';
import Match from './Match.jsx';
import { createInitialState } from '../engine/actions.js';
import { buildMainDeckList, buildEffigyDeckList } from '../engine/deck.js';

// Sibling to GameApp.jsx for a two-player-over-the-network match —
// GameApp.jsx itself gets zero changes. Reuses DeckImport/PreconSelect/
// DeckBuilder exactly as GameApp.jsx does, swapping in NetLobby in place of
// the AI-deck-pick step and NetCoinFlip in place of CoinFlip.
//
// Host is always seat A, peer is always seat B (fixed at pairing in
// NetLobby). Only the host ever calls createInitialState — it's the one
// client with both decks once the peer's 'deck-chosen' message arrives —
// and sends the entire resulting state to the peer, who adopts it directly
// rather than deriving it itself (same "relay the result, not the
// recipe" principle the mid-match net-sync in useGameEngine.js/Match.jsx
// relies on, for the same reason: unrepeatable randomness, here in the
// initial shuffle rather than gameReducer).
export default function NetGameApp({ onExitToMenu }) {
  const [screen, setScreen] = useState('lobby'); // 'lobby' | 'import' | 'select' | 'build' | 'waitingForPeerDeck' | 'coinflip' | 'match'
  const [pool, setPool] = useState([]);
  const [seedDeck, setSeedDeck] = useState(null);
  const [net, setNet] = useState(null); // { gameChannel, relayClient, netRole, mySeat }
  const [myDeck, setMyDeck] = useState(null); // { entries, effigyCounts }
  const [peerDeck, setPeerDeck] = useState(null); // { entries, effigyCounts } — set once the peer's own pick arrives
  const [peerCoinFlipResult, setPeerCoinFlipResult] = useState(null); // {result, startingPlayer} — peer-side only
  const [matchState, setMatchState] = useState(null);
  const [opponentGoneBeforeMatch, setOpponentGoneBeforeMatch] = useState(false);

  // Long-lived listener, active for the whole net match regardless of
  // which screen is showing — a message can legitimately arrive before the
  // screen that "expects" it is even mounted (e.g. the peer finishes
  // picking a deck before the host does).
  useEffect(() => {
    if (!net) return;
    const offMessage = net.gameChannel.onMessage((msg) => {
      if (msg.kind === 'deck-chosen') setPeerDeck({ entries: msg.entries, effigyCounts: msg.effigyCounts });
      if (msg.kind === 'coin-flip-result') setPeerCoinFlipResult({ result: msg.result, startingPlayer: msg.startingPlayer });
      if (msg.kind === 'match-start') { setMatchState(msg.state); setScreen('match'); }
    });
    const onGone = () => setOpponentGoneBeforeMatch(true);
    const offPeerGone = net.gameChannel.onPeerDisconnected(onGone);
    const offClose = net.gameChannel.onClose(onGone);
    return () => { offMessage(); offPeerGone(); offClose(); };
  }, [net]);

  // Host-only: once both decks are known, move on to the coin flip.
  useEffect(() => {
    if (!net || net.netRole !== 'host') return;
    if (screen !== 'waitingForPeerDeck') return;
    if (myDeck && peerDeck) setScreen('coinflip');
  }, [net, screen, myDeck, peerDeck]);

  // Peer-only: once the host's coin-flip result arrives, move on too (the
  // host may still be mid-flip UI on its own screen — this client just
  // shows NetCoinFlip in its "waiting/result" states, see that component).
  useEffect(() => {
    if (!net || net.netRole !== 'peer') return;
    if (screen !== 'waitingForPeerDeck') return;
    if (peerCoinFlipResult) setScreen('coinflip');
  }, [net, screen, peerCoinFlipResult]);

  const handlePaired = (paired) => {
    setNet(paired);
    setScreen('import');
  };

  const handleImported = (cards) => {
    setPool(cards);
    setScreen('select');
  };

  const handleDeckChosen = ({ entries, effigyCounts }) => {
    setMyDeck({ entries, effigyCounts });
    net.gameChannel.send({ kind: 'deck-chosen', entries, effigyCounts });
    setScreen('waitingForPeerDeck');
  };

  // Host only — peer never reaches this (its screen flips to 'match' the
  // moment the 'match-start' message lands, via the listener above).
  const handleCoinFlipResolved = (startingPlayer) => {
    const mainDeckA = buildMainDeckList(myDeck.entries);
    const effigyDeckA = buildEffigyDeckList(myDeck.effigyCounts);
    const mainDeckB = buildMainDeckList(peerDeck.entries);
    const effigyDeckB = buildEffigyDeckList(peerDeck.effigyCounts);
    const initialState = createInitialState({ mainDeckA, effigyDeckA, mainDeckB, effigyDeckB, startingPlayer, alwaysOfferPriorityTo: ['A', 'B'] });
    net.gameChannel.send({ kind: 'match-start', state: initialState });
    setMatchState(initialState);
    setScreen('match');
  };

  if (screen === 'lobby') {
    return <NetLobby onPaired={handlePaired} onBack={onExitToMenu} />;
  }

  if (opponentGoneBeforeMatch && screen !== 'match') {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-black p-8 short:p-2">
        <div className="text-center bg-white rounded-lg shadow p-8 max-w-lg">
          <h2 className="text-2xl font-bold text-stone-800 mb-2">Opponent disconnected</h2>
          <p className="text-sm text-stone-500 mb-4">The connection to your opponent was lost before the match started.</p>
          <button onClick={onExitToMenu} className="px-4 py-2 border border-stone-300 rounded-lg">Back to menu</button>
        </div>
      </div>
    );
  }

  if (screen === 'import') {
    return <DeckImport onImported={handleImported} onBack={onExitToMenu} />;
  }
  if (screen === 'select') {
    return (
      <PreconSelect
        pool={pool}
        onStart={handleDeckChosen}
        onCustom={() => { setSeedDeck(null); setScreen('build'); }}
        onEdit={(seed) => { setSeedDeck(seed); setScreen('build'); }}
        onBack={onExitToMenu}
        competitiveMode={false}
        onToggleCompetitiveMode={() => {}}
        aiDifficulty="standard"
        onChangeAiDifficulty={() => {}}
      />
    );
  }
  if (screen === 'build') {
    return <DeckBuilder pool={pool} seedDeck={seedDeck} onStart={handleDeckChosen} onBack={() => setScreen('select')} />;
  }
  if (screen === 'waitingForPeerDeck') {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-black p-8 short:p-2">
        <div className="max-w-md w-full text-center bg-white rounded-lg shadow p-8">
          <h2 className="text-lg font-bold text-stone-800 mb-2">Deck locked in</h2>
          <p className="text-sm text-stone-500 animate-pulse">Waiting for your opponent to finish their deck…</p>
        </div>
      </div>
    );
  }
  if (screen === 'coinflip') {
    return (
      <NetCoinFlip
        netRole={net.netRole}
        mySeat={net.mySeat}
        peerResult={peerCoinFlipResult}
        onHostResolved={({ result, startingPlayer }) => net.gameChannel.send({ kind: 'coin-flip-result', result, startingPlayer })}
        onResolved={net.netRole === 'host' ? handleCoinFlipResolved : () => {}}
      />
    );
  }

  return (
    <Match
      initialState={matchState}
      onExit={onExitToMenu}
      onRematch={null}
      deckEntries={myDeck?.entries}
      competitiveMode={false}
      aiDifficulty="standard"
      netRole={net.netRole}
      mySeat={net.mySeat}
      gameChannel={net.gameChannel}
      onOpponentDisconnected={() => {}}
    />
  );
}
