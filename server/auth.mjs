// Accounts for the relay server: username/password and Google sign-in,
// stateless signed session tokens, and a per-account deck store. Pure Node
// built-ins only (this image ships nothing but `ws`) — a JSON file on disk
// is plenty for the number of accounts a card game's relay will ever hold.
import { scrypt, randomBytes, timingSafeEqual, createHmac, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

const scryptAsync = promisify(scrypt);

export class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const MAX_DECKS = 100;
const MAX_TOMBSTONES = 500;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const cleanDisplayName = (raw) => {
  const cleaned = String(raw ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24);
  return cleaned || 'Player';
};

export const hashPassword = async (password) => {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
};

export const verifyPassword = async (password, stored) => {
  const [scheme, saltHex, keyHex] = String(stored || '').split(':');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
};

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export const signToken = (secret, userId, now = Date.now(), ttlMs = TOKEN_TTL_MS) => {
  const payload = b64url(JSON.stringify({ uid: userId, exp: now + ttlMs }));
  const sig = b64url(createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
};

export const verifyToken = (secret, token, now = Date.now()) => {
  if (typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', secret).update(payload).digest();
  let given;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof uid === 'string' && typeof exp === 'number' && exp > now ? uid : null;
  } catch {
    return null;
  }
};

// Sliding-window attempt counter, keyed by caller (IP). In memory only —
// a restart forgiving a locked-out client is fine.
export class RateLimiter {
  constructor({ max = 10, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  // Records an attempt; false once the key is over its budget.
  allow(key) {
    const t = this.now();
    const recent = (this.hits.get(key) || []).filter((ts) => t - ts < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}

// users.json shape: { users: { [id]: record } } — see createRecord below.
export class UserStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'users.json');
    this.users = new Map();
    this.byName = new Map();
    this.byGoogle = new Map();
    this.writeChain = Promise.resolve();
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      for (const record of Object.values(data.users || {})) this.index(record);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  index(record) {
    this.users.set(record.id, record);
    if (record.usernameLower) this.byName.set(record.usernameLower, record.id);
    if (record.googleSub) this.byGoogle.set(record.googleSub, record.id);
  }

  persist() {
    const snapshot = JSON.stringify({ users: Object.fromEntries(this.users) });
    const tmp = `${this.file}.tmp`;
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        await writeFile(tmp, snapshot, { mode: 0o600 });
        await rename(tmp, this.file);
      });
    return this.writeChain;
  }

  findById(id) {
    return this.users.get(id) || null;
  }

  findByUsername(username) {
    const id = this.byName.get(String(username).toLowerCase());
    return id ? this.users.get(id) : null;
  }

  async createPasswordUser(username, passwordHash) {
    if (this.byName.has(username.toLowerCase())) return null;
    const record = {
      id: randomUUID(),
      username,
      usernameLower: username.toLowerCase(),
      passwordHash,
      googleSub: null,
      displayName: username,
      decks: [],
      deleted: {},
      createdAt: new Date().toISOString(),
    };
    this.index(record);
    await this.persist();
    return record;
  }

  async findOrCreateGoogleUser(sub, name) {
    const existingId = this.byGoogle.get(sub);
    if (existingId) return this.users.get(existingId);
    const record = {
      id: randomUUID(),
      username: null,
      usernameLower: null,
      passwordHash: null,
      googleSub: sub,
      displayName: cleanDisplayName(name),
      decks: [],
      deleted: {},
      createdAt: new Date().toISOString(),
    };
    this.index(record);
    await this.persist();
    return record;
  }

  async setDecks(id, { decks, deleted }) {
    const record = this.users.get(id);
    record.decks = decks;
    record.deleted = deleted;
    await this.persist();
  }
}

export const validateDecksPayload = (body) => {
  const decks = body?.decks;
  const deleted = body?.deleted ?? {};
  if (!Array.isArray(decks) || decks.length > MAX_DECKS) throw new AuthError(400, 'bad-decks', 'Invalid deck list.');
  for (const d of decks) {
    if (!d || typeof d !== 'object' || typeof d.id !== 'string' || d.id.length > 80 || typeof d.updatedAt !== 'string') {
      throw new AuthError(400, 'bad-decks', 'Invalid deck list.');
    }
  }
  if (!deleted || typeof deleted !== 'object' || Array.isArray(deleted)) throw new AuthError(400, 'bad-decks', 'Invalid deck list.');
  const entries = Object.entries(deleted);
  if (entries.length > MAX_TOMBSTONES || entries.some(([k, v]) => k.length > 80 || typeof v !== 'string')) {
    throw new AuthError(400, 'bad-decks', 'Invalid deck list.');
  }
  return { decks, deleted: Object.fromEntries(entries) };
};

export const verifyGoogleIdToken = async (idToken, { clientId, fetchImpl = fetch, now = Date.now() }) => {
  const res = await fetchImpl(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!res.ok) throw new AuthError(401, 'bad-google-token', 'Google sign-in could not be verified.');
  const info = await res.json();
  const issuerOk = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
  if (info.aud !== clientId || !issuerOk || !info.sub || Number(info.exp) * 1000 <= now) {
    throw new AuthError(401, 'bad-google-token', 'Google sign-in could not be verified.');
  }
  return { sub: String(info.sub), name: info.given_name || info.name || 'Player' };
};

const publicUser = (record) => ({ id: record.id, username: record.username, displayName: record.displayName });

export class AuthService {
  constructor({ store, secret, googleClientId = null, fetchImpl = fetch, now = () => Date.now() }) {
    this.store = store;
    this.secret = secret;
    this.googleClientId = googleClientId;
    this.fetchImpl = fetchImpl;
    this.now = now;
    // Burned on a missing username so "no such user" and "wrong password"
    // cost about the same time.
    this.dummyHash = hashPassword('not-a-real-password');
  }

  issue(record) {
    return { token: signToken(this.secret, record.id, this.now()), user: publicUser(record) };
  }

  async register(username, password) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      throw new AuthError(400, 'bad-username', 'Usernames are 3–20 letters, numbers, _ or -.');
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      throw new AuthError(400, 'bad-password', `Passwords need at least ${MIN_PASSWORD} characters.`);
    }
    const record = await this.store.createPasswordUser(username, await hashPassword(password));
    if (!record) throw new AuthError(409, 'username-taken', 'That username is already taken.');
    return this.issue(record);
  }

  async login(username, password) {
    const record = typeof username === 'string' ? this.store.findByUsername(username) : null;
    const ok = typeof password === 'string'
      && await verifyPassword(password, record?.passwordHash ?? await this.dummyHash);
    if (!record || !ok) throw new AuthError(401, 'bad-credentials', 'Wrong username or password.');
    return this.issue(record);
  }

  async google(idToken) {
    if (!this.googleClientId) throw new AuthError(501, 'google-disabled', 'Google sign-in is not set up on this server.');
    if (typeof idToken !== 'string') throw new AuthError(400, 'bad-google-token', 'Missing Google credential.');
    const { sub, name } = await verifyGoogleIdToken(idToken, { clientId: this.googleClientId, fetchImpl: this.fetchImpl, now: this.now() });
    return this.issue(await this.store.findOrCreateGoogleUser(sub, name));
  }

  userFromToken(token) {
    const id = verifyToken(this.secret, token, this.now());
    return id ? this.store.findById(id) : null;
  }
}

// A persistent signing secret: AUTH_SECRET if set, else one generated and
// kept next to the user file so tokens survive restarts.
export const loadSecret = async (dir, fromEnv) => {
  if (fromEnv) return fromEnv;
  const file = path.join(dir, 'secret.key');
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const secret = randomBytes(32).toString('hex');
  await mkdir(dir, { recursive: true });
  await writeFile(file, secret, { mode: 0o600 });
  return secret;
};
