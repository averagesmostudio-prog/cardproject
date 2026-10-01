// Persistent storage for the relay server address — plain localStorage,
// matching deckLibrary.js's/csvSource.js's existing convention (no
// Electron IPC/preload infra for this app, and none needed here either).

const ADDRESS_KEY = 'scripturas-relay-address';
// The deployed relay (server/relay.mjs on the Bluehost VPS, behind nginx +
// Let's Encrypt TLS at relay.scripturastcg.com) — so "Play Online" works
// out of the box for real matches. ws://localhost:8787 (server/relay.mjs
// run locally via `npm run relay`) still works fine by typing it into the
// relay-address field; it's just no longer what a fresh install defaults to.
const DEFAULT_ADDRESS = 'wss://relay.scripturastcg.com';

export const getRelayAddress = () => {
  try {
    return localStorage.getItem(ADDRESS_KEY) || DEFAULT_ADDRESS;
  } catch {
    return DEFAULT_ADDRESS;
  }
};

export const setRelayAddress = (address) => {
  try {
    localStorage.setItem(ADDRESS_KEY, address);
  } catch {
    // Storage unavailable — the field just won't remember the last value.
  }
};
