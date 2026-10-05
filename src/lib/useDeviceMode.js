import { useEffect, useState } from 'react';

// Phone-sized touch screens held sideways. Matches by pointer type + height,
// not user-agent, so a short desktop window never triggers it. `?compact=1`
// (or localStorage scripturas-force-compact=1) forces it on for testing in a
// desktop browser.
const COMPACT_QUERY = '(pointer: coarse) and (max-height: 600px)';
const PORTRAIT_QUERY = '(pointer: coarse) and (orientation: portrait) and (max-width: 700px)';

const forced = () => {
  try {
    if (new URLSearchParams(window.location.search).get('compact') === '1') return true;
    return window.localStorage.getItem('scripturas-force-compact') === '1';
  } catch {
    return false;
  }
};

const useMedia = (query, force) => {
  const read = () => (force ? true : typeof window !== 'undefined' && window.matchMedia(query).matches);
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (force) return undefined;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query, force]);
  return force ? true : matches;
};

export const useCompactLandscape = () => useMedia(COMPACT_QUERY, forced());

export const useRotateNeeded = () => {
  const portrait = useMedia(PORTRAIT_QUERY, false);
  return portrait && !forced();
};
