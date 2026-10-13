// Rematch handshake for an online match. Either player can ask; the match only
// restarts once BOTH have (so nobody is dragged into a game they didn't want).
// The same two decks are replayed, with the other seat going first.

export const REMATCH_REQUEST_MESSAGE = 'rematch-request';

// 'idle' (nobody asked) | 'waiting' (I asked, they haven't) | 'incoming' (they
// asked, I haven't) | 'start' (both asked — the host starts the new match).
export const rematchPhase = ({ myRequested, peerRequested }) => {
  if (myRequested && peerRequested) return 'start';
  if (myRequested) return 'waiting';
  if (peerRequested) return 'incoming';
  return 'idle';
};

export const rematchStartingPlayer = (previousStartingPlayer) => (previousStartingPlayer === 'A' ? 'B' : 'A');
