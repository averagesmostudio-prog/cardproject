import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { LINEN_BG } from '../lib/deckBuilderStyle.js';
import { login, register, loginWithGoogle, signOut, fetchAuthConfig, refreshAccount, addPasswordLogin } from '../lib/account.js';
import { useAccount } from '../lib/useAccount.js';
import { syncDecks } from '../lib/deckSync.js';

// Google's sign-in button only works from a real web origin — the packaged
// desktop app loads from file://, which Google rejects.
const canUseGoogle = () => typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol);

const loadGoogleScript = () => new Promise((resolve, reject) => {
  if (window.google?.accounts?.id) return resolve();
  const script = document.createElement('script');
  script.src = 'https://accounts.google.com/gsi/client';
  script.async = true;
  script.onload = resolve;
  script.onerror = () => reject(new Error("Couldn't load Google sign-in."));
  document.head.appendChild(script);
});

const inputClass = 'w-full px-3 py-2 border-2 border-black bg-white/70 rounded-lg text-sm';
const primaryClass = 'w-full px-4 py-2 border-2 border-black bg-[#393938] text-white rounded-lg font-bold hover:bg-black transition disabled:opacity-50';

// Sign in / create account / signed-in summary. Accounts are optional: they
// put your name on you in online matches and sync saved decks across devices.
export default function AccountDialog({ open, onClose }) {
  const account = useAccount();
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [syncNote, setSyncNote] = useState('');
  const [googleClientId, setGoogleClientId] = useState(null);
  const googleButtonRef = useRef(null);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const signedIn = !!account;
  useEffect(() => {
    if (open && signedIn) refreshAccount();
  }, [open, signedIn]);

  useEffect(() => {
    if (!open || account || !canUseGoogle()) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const { googleClientId: clientId } = await fetchAuthConfig();
        if (!clientId || cancelled) return;
        await loadGoogleScript();
        if (cancelled || !googleButtonRef.current) return;
        setGoogleClientId(clientId);
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: async ({ credential }) => {
            setError('');
            try {
              await loginWithGoogle(credential);
            } catch (err) {
              setError(err.message);
            }
          },
        });
        window.google.accounts.id.renderButton(googleButtonRef.current, { theme: 'outline', size: 'large', text: 'continue_with', width: 280 });
      } catch {
        // No server / no Google configured: the form below still works.
      }
    })();
    return () => { cancelled = true; };
  }, [open, account]);

  if (!open) return null;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await (mode === 'register' ? register : login)(username.trim(), password);
      setPassword('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submitPasswordLogin = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await addPasswordLogin(newUsername.trim(), newPassword);
      setNewPassword('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setSyncNote('Syncing…');
    const result = await syncDecks();
    setSyncNote(result.synced ? 'Decks are up to date.' : `Couldn't sync: ${result.error || 'try again.'}`);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="border-[6px] border-black rounded-md shadow-2xl p-6 max-w-sm w-full relative text-left"
        style={{ background: LINEN_BG, fontFamily: 'Georgia, serif' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={onClose} className="absolute top-3 right-3 p-1.5 rounded-full bg-white/60 hover:bg-white/90" aria-label="Close">
          <X className="w-5 h-5" />
        </button>

        {account ? (
          <div>
            <h2 className="text-lg font-bold text-stone-900 mb-1">Signed in</h2>
            <p className="text-sm text-stone-800 mb-4">
              You're <span className="font-bold">{account.user.displayName}</span>. Opponents see this name in online matches, and your saved decks sync to this account.
            </p>
            {account.user.hasPassword === false && (
              <form onSubmit={submitPasswordLogin} className="mb-4 p-3 border-2 border-black rounded-lg bg-white/40">
                <h3 className="text-sm font-bold text-stone-900 mb-1">Use this account in the desktop app</h3>
                <p className="text-xs text-stone-800 mb-3">The desktop apps can't use Google sign-in. Pick a username and password and you can sign in to this same account there.</p>
                <input className={`${inputClass} mb-2`} placeholder="Username" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} autoComplete="username" maxLength={20} aria-label="New username" />
                <input type="password" className={`${inputClass} mb-2`} placeholder="Password (8+ characters)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" aria-label="New password" />
                {error && <p className="text-xs font-bold text-red-800 mb-2">{error}</p>}
                <button type="submit" disabled={busy || !newUsername || !newPassword} className={primaryClass}>{busy ? 'One moment…' : 'Create login'}</button>
              </form>
            )}
            {account.user.username && <p className="text-xs text-stone-800 mb-3">Username: <span className="font-bold">{account.user.username}</span> — sign in with it on any device.</p>}
            <button onClick={syncNow} className={`${primaryClass} mb-2`}>Sync decks now</button>
            {syncNote && <p className="text-xs text-stone-800 mb-2">{syncNote}</p>}
            <button
              onClick={() => { signOut(); setSyncNote(''); }}
              className="w-full px-4 py-2 border-2 border-black bg-white/60 hover:bg-white/90 rounded-lg text-sm font-bold text-stone-900"
            >
              Sign out
            </button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <h2 className="text-lg font-bold text-stone-900 mb-1">{mode === 'register' ? 'Create an account' : 'Sign in'}</h2>
            <p className="text-sm text-stone-800 mb-4">Optional — shows your name in online matches and syncs your decks across devices.</p>
            <label className="block text-xs font-bold text-stone-800 mb-1" htmlFor="acct-username">Username</label>
            <input id="acct-username" className={`${inputClass} mb-3`} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus maxLength={20} />
            <label className="block text-xs font-bold text-stone-800 mb-1" htmlFor="acct-password">Password</label>
            <input id="acct-password" type="password" className={`${inputClass} mb-3`} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} />
            {mode === 'register' && <p className="text-xs text-stone-700 -mt-2 mb-3">3–20 letters, numbers, _ or - · password at least 8 characters.</p>}
            {error && <p className="text-xs font-bold text-red-800 mb-3">{error}</p>}
            <button type="submit" disabled={busy || !username || !password} className={primaryClass}>
              {busy ? 'One moment…' : mode === 'register' ? 'Create account' : 'Sign in'}
            </button>
            <button
              type="button"
              onClick={() => { setMode(mode === 'register' ? 'login' : 'register'); setError(''); }}
              className="w-full mt-3 text-xs font-bold text-stone-900 hover:underline"
            >
              {mode === 'register' ? 'Already have an account? Sign in' : 'New here? Create an account'}
            </button>
            {canUseGoogle() ? (
              <div className="mt-4 flex flex-col items-center">
                {googleClientId && <div className="flex items-center gap-3 w-full mb-3"><div className="flex-1 h-0.5 bg-black/40" /><span className="text-xs font-bold text-stone-800 uppercase">or</span><div className="flex-1 h-0.5 bg-black/40" /></div>}
                <div ref={googleButtonRef} />
              </div>
            ) : (
              <p className="text-xs text-stone-700 mt-4">Google sign-in is available on the web version.</p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
