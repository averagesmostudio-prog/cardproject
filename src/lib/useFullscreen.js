import { useCallback, useEffect, useState } from 'react';

// Browser full screen (hides the address bar). Works on Android Chrome and
// desktop browsers from a user tap. iPhone Safari doesn't allow it for web
// pages, so there the button opens a hint explaining "Add to Home Screen"
// instead (see index.html / the manifest) — `needsInstall` is true until the
// app is already running standalone. Entering full screen also asks the
// browser to lock landscape, which Android only permits in full screen; the
// lock is best-effort and silently ignored where unsupported.
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

const isIos = () => {
  if (typeof navigator === 'undefined') return false;
  // iPadOS reports as a Mac with touch points.
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

const isStandalone = () => {
  if (typeof window === 'undefined') return false;
  return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
};

export const useFullscreen = () => {
  const supported = typeof document !== 'undefined'
    && !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const needsInstall = !supported && isIos() && !isStandalone();
  const [active, setActive] = useState(() => (typeof document !== 'undefined' ? !!fullscreenElement() : false));
  const [hintOpen, setHintOpen] = useState(false);

  useEffect(() => {
    const onChange = () => setActive(!!fullscreenElement());
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  const toggle = useCallback(() => {
    if (needsInstall) {
      setHintOpen(true);
      return;
    }
    try {
      if (fullscreenElement()) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        screen.orientation?.unlock?.();
      } else {
        const el = document.documentElement;
        // Called synchronously from the tap so the browser counts it as a user gesture.
        const request = (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
        Promise.resolve(request)
          .then(() => screen.orientation?.lock?.('landscape'))
          .catch(() => {});
      }
    } catch {
      // Denied or unsupported — nothing useful to surface to the player.
    }
  }, [needsInstall]);

  // Show the control on any touch device that can either go full screen or
  // needs the install hint; never hide it based on the current viewport height
  // (leaving full screen makes the viewport taller again).
  const touch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  const available = touch && (supported || needsInstall);

  return { supported, needsInstall, available, active, toggle, hintOpen, closeHint: () => setHintOpen(false) };
};
