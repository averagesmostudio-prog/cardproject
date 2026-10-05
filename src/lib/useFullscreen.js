import { useCallback, useEffect, useState } from 'react';

// Browser full screen (hides the address bar). Works on Android Chrome and
// desktop browsers from a user tap; iPhone Safari doesn't allow it for web
// pages (use "Add to Home Screen" there — see index.html / the manifest), so
// `supported` is false and the button stays hidden. Entering full screen also
// asks the browser to lock landscape, which Android only permits in full
// screen; the lock is best-effort and silently ignored where unsupported.
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

export const useFullscreen = () => {
  const supported = typeof document !== 'undefined'
    && !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const [active, setActive] = useState(() => (typeof document !== 'undefined' ? !!fullscreenElement() : false));

  useEffect(() => {
    const onChange = () => setActive(!!fullscreenElement());
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  const toggle = useCallback(async () => {
    try {
      if (fullscreenElement()) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        screen.orientation?.unlock?.();
      } else {
        const el = document.documentElement;
        await (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
        await screen.orientation?.lock?.('landscape').catch(() => {});
      }
    } catch {
      // Denied or unsupported — nothing useful to surface to the player.
    }
  }, []);

  return { supported, active, toggle };
};
