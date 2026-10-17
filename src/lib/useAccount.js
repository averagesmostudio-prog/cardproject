import { useEffect, useState, useSyncExternalStore } from 'react';
import { getAccount, onAccountChange } from './account.js';
import { onLibraryChange } from './deckLibrary.js';

export const useAccount = () => useSyncExternalStore(onAccountChange, getAccount, getAccount);

// Re-renders when an account sync rewrites the deck library underneath a
// screen that reads it fresh on every render (Library, PreconSelect).
export const useLibrarySyncRefresh = () => {
  const [, setTick] = useState(0);
  useEffect(() => onLibraryChange((source) => { if (source === 'sync') setTick((t) => t + 1); }), []);
};
