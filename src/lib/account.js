// Optional account for the relay server (server/auth.mjs): sign in to show
// your name in online matches and to sync saved decks across devices. The
// token lives in localStorage like every other piece of client state here;
// nothing in the app requires being signed in.
import { getRelayAddress } from './relayAddress.js';

const ACCOUNT_KEY = 'scripturas-account';

const listeners = new Set();
let cached;

const load = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(ACCOUNT_KEY) || 'null');
    return parsed?.token && parsed?.user ? parsed : null;
  } catch {
    return null;
  }
};

const store = (account) => {
  cached = account;
  try {
    if (account) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
    else localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    // Storage unavailable — the session just won't survive a reload.
  }
  listeners.forEach((fn) => fn());
};

// { token, user: { id, username, displayName } } or null. A stable object
// between changes, so it is safe as a useSyncExternalStore snapshot.
export const getAccount = () => {
  if (cached === undefined) cached = load();
  return cached;
};

export const getAuthToken = () => getAccount()?.token || null;

export const onAccountChange = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

// ws://host:port -> http://host:port, wss://host -> https://host: the
// account API lives on the same server and port as the relay.
export const apiBase = (relayAddress = getRelayAddress()) =>
  relayAddress.trim().replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/+$/, '');

export class AccountApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const apiRequest = async (method, route, { body, token } = {}) => {
  let res;
  try {
    res = await fetch(`${apiBase()}${route}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new AccountApiError(0, "Couldn't reach the server — check your connection.");
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    // Non-JSON error page (a proxy in front, say) — fall through to the generic message.
  }
  if (!res.ok) throw new AccountApiError(res.status, data.message || 'Something went wrong — try again.');
  return data;
};

export const register = async (username, password) => {
  store(await apiRequest('POST', '/auth/register', { body: { username, password } }));
};

export const login = async (username, password) => {
  store(await apiRequest('POST', '/auth/login', { body: { username, password } }));
};

export const loginWithGoogle = async (credential) => {
  store(await apiRequest('POST', '/auth/google', { body: { credential } }));
};

export const signOut = () => store(null);

export const fetchAuthConfig = () => apiRequest('GET', '/auth/config');
