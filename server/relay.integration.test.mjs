import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createRelayServer } from './relay.mjs';
import { RateLimiter, hashPassword, verifyPassword, signToken, verifyToken, verifyGoogleIdToken, cleanDisplayName } from './auth.mjs';

let relay;
let dir;
let base;
const fakeGoogle = {};

const api = async (method, route, { body, token } = {}) => {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const connect = () => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const w = waiters.shift();
    if (w) w(msg); else inbox.push(msg);
  });
  ws.on('open', () => resolve({
    send: (m) => ws.send(JSON.stringify(m)),
    next: () => new Promise((r) => { const m = inbox.shift(); if (m) r(m); else waiters.push(r); }),
    close: () => ws.close(),
  }));
});

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'relay-test-'));
  relay = await createRelayServer({
    port: 0,
    dataDir: dir,
    secret: 'test-secret',
    googleClientId: 'client-123',
    authLimiter: new RateLimiter({ max: 1000 }),
    fetchImpl: async (url) => {
      const idToken = new URL(url).searchParams.get('id_token');
      const info = fakeGoogle[idToken];
      return info ? { ok: true, json: async () => info } : { ok: false, json: async () => ({}) };
    },
  });
  base = `http://127.0.0.1:${relay.port}`;
});

afterAll(async () => {
  await relay.close();
  await rm(dir, { recursive: true, force: true });
});

describe('password + token primitives', () => {
  it('verifies the right password only', async () => {
    const stored = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', stored)).toBe(true);
    expect(await verifyPassword('wrong horse', stored)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('round-trips a token, and rejects tampering, a wrong secret and expiry', () => {
    const token = signToken('s', 'user-1', 1000, 500);
    expect(verifyToken('s', token, 1200)).toBe('user-1');
    expect(verifyToken('other', token, 1200)).toBeNull();
    expect(verifyToken('s', token, 1600)).toBeNull();
    const [payload, sig] = token.split('.');
    expect(verifyToken('s', `${payload}x.${sig}`, 1200)).toBeNull();
    expect(verifyToken('s', 'nonsense', 1200)).toBeNull();
  });

  it('cleans display names', () => {
    expect(cleanDisplayName('  <b>Ana</b>\n ')).toBe('bAna/b');
    expect(cleanDisplayName('')).toBe('Player');
    expect(cleanDisplayName('x'.repeat(40))).toHaveLength(24);
  });

  it('rate limiter blocks past its budget and recovers after the window', () => {
    let t = 0;
    const limiter = new RateLimiter({ max: 2, windowMs: 100, now: () => t });
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(false);
    expect(limiter.allow('other')).toBe(true);
    t = 150;
    expect(limiter.allow('ip')).toBe(true);
  });

  it('rejects a Google token for the wrong audience, issuer or an expired one', async () => {
    const f = (info) => async () => ({ ok: true, json: async () => info });
    const good = { aud: 'c', iss: 'accounts.google.com', sub: '1', exp: String(Math.floor(Date.now() / 1000) + 600), given_name: 'Ana' };
    expect((await verifyGoogleIdToken('t', { clientId: 'c', fetchImpl: f(good) })).sub).toBe('1');
    await expect(verifyGoogleIdToken('t', { clientId: 'c', fetchImpl: f({ ...good, aud: 'other' }) })).rejects.toThrow();
    await expect(verifyGoogleIdToken('t', { clientId: 'c', fetchImpl: f({ ...good, iss: 'evil.com' }) })).rejects.toThrow();
    await expect(verifyGoogleIdToken('t', { clientId: 'c', fetchImpl: f({ ...good, exp: '1' }) })).rejects.toThrow();
  });
});

describe('accounts over HTTP', () => {
  it('registers, rejects a duplicate (case-insensitive), then logs in', async () => {
    const reg = await api('POST', '/auth/register', { body: { username: 'Ana_1', password: 'longenough' } });
    expect(reg.status).toBe(200);
    expect(reg.body.user.displayName).toBe('Ana_1');
    expect(reg.body.token).toBeTruthy();

    const dup = await api('POST', '/auth/register', { body: { username: 'ana_1', password: 'longenough' } });
    expect(dup.status).toBe(409);

    const login = await api('POST', '/auth/login', { body: { username: 'ANA_1', password: 'longenough' } });
    expect(login.status).toBe(200);
    expect((await api('GET', '/auth/me', { token: login.body.token })).body.user.username).toBe('Ana_1');
  });

  it('rejects bad usernames, short passwords and wrong credentials', async () => {
    expect((await api('POST', '/auth/register', { body: { username: 'a b', password: 'longenough' } })).status).toBe(400);
    expect((await api('POST', '/auth/register', { body: { username: 'okname', password: 'short' } })).status).toBe(400);
    expect((await api('POST', '/auth/login', { body: { username: 'Ana_1', password: 'wrongwrong' } })).status).toBe(401);
    expect((await api('POST', '/auth/login', { body: { username: 'nobody', password: 'wrongwrong' } })).status).toBe(401);
  });

  it('signs in with Google, reusing the same account the second time', async () => {
    fakeGoogle['good-credential'] = { aud: 'client-123', iss: 'https://accounts.google.com', sub: 'g-1', exp: String(Math.floor(Date.now() / 1000) + 600), given_name: 'Gwen' };
    const first = await api('POST', '/auth/google', { body: { credential: 'good-credential' } });
    expect(first.status).toBe(200);
    expect(first.body.user.displayName).toBe('Gwen');
    const second = await api('POST', '/auth/google', { body: { credential: 'good-credential' } });
    expect(second.body.user.id).toBe(first.body.user.id);
    expect((await api('POST', '/auth/google', { body: { credential: 'forged' } })).status).toBe(401);
    expect((await api('GET', '/auth/config')).body.googleClientId).toBe('client-123');
  });

  it('stores and returns an account\'s decks, and refuses them without a token', async () => {
    const { body: { token } } = await api('POST', '/auth/register', { body: { username: 'decker', password: 'longenough' } });
    expect((await api('GET', '/decks')).status).toBe(401);
    const payload = { decks: [{ id: 'deck-1', name: 'Sphinx Aggro', updatedAt: '2026-10-17T00:00:00.000Z' }], deleted: { 'deck-0': '2026-10-16T00:00:00.000Z' } };
    expect((await api('PUT', '/decks', { token, body: payload })).status).toBe(200);
    expect((await api('GET', '/decks', { token })).body).toEqual(payload);
    expect((await api('PUT', '/decks', { token, body: { decks: 'nope' } })).status).toBe(400);
  });

  it('persists accounts across a restart', async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), 'relay-restart-'));
    const make = () => createRelayServer({ port: 0, dataDir: other, secret: 's', authLimiter: new RateLimiter({ max: 100 }) });
    const first = await make();
    const reg = await (await fetch(`http://127.0.0.1:${first.port}/auth/register`, { method: 'POST', body: JSON.stringify({ username: 'keeper', password: 'longenough' }) })).json();
    await first.close();
    const second = await make();
    const me = await (await fetch(`http://127.0.0.1:${second.port}/auth/me`, { headers: { Authorization: `Bearer ${reg.token}` } })).json();
    await second.close();
    await rm(other, { recursive: true, force: true });
    expect(me.user.username).toBe('keeper');
  });

  it('rate-limits repeated auth attempts', async () => {
    const limited = await createRelayServer({ port: 0, dataDir: dir, secret: 'test-secret', authLimiter: new RateLimiter({ max: 2 }) });
    const hit = () => fetch(`http://127.0.0.1:${limited.port}/auth/login`, { method: 'POST', body: JSON.stringify({ username: 'x', password: 'y' }) });
    expect((await hit()).status).toBe(401);
    expect((await hit()).status).toBe(401);
    expect((await hit()).status).toBe(429);
    await limited.close();
  });
});

describe('matchmaking with names', () => {
  it('tells each signed-in player their opponent\'s name (quick match)', async () => {
    const a = (await api('POST', '/auth/register', { body: { username: 'Alice', password: 'longenough' } })).body.token;
    const b = (await api('POST', '/auth/register', { body: { username: 'Bob', password: 'longenough' } })).body.token;
    const wa = await connect();
    const wb = await connect();
    wa.send({ type: 'find-match', token: a });
    expect((await wa.next()).type).toBe('searching');
    wb.send({ type: 'find-match', token: b });
    expect(await wa.next()).toEqual({ type: 'paired', role: 'host', opponentName: 'Bob' });
    expect(await wb.next()).toEqual({ type: 'paired', role: 'peer', opponentName: 'Alice' });
    wa.close();
    wb.close();
  });

  it('names the host/join path too, and leaves guests (and bad tokens) unnamed', async () => {
    const a = (await api('POST', '/auth/register', { body: { username: 'Hosty', password: 'longenough' } })).body.token;
    const host = await connect();
    host.send({ type: 'create-room', token: a });
    const { code } = await host.next();
    const guest = await connect();
    guest.send({ type: 'join-room', code, token: 'forged.token' });
    expect(await guest.next()).toEqual({ type: 'paired', role: 'peer', opponentName: 'Hosty' });
    expect(await host.next()).toEqual({ type: 'paired', role: 'host' });
    host.close();
    guest.close();
  });
});
