// Persistent storage for the relay server address — plain localStorage,
// matching deckLibrary.js's/csvSource.js's existing convention (no
// Electron IPC/preload infra for this app, and none needed here either).

const ADDRESS_KEY = 'scripturas-relay-address';
const DEFAULT_ADDRESS = 'ws://localhost:8787';

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
