'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('./errors');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MIN_PASSWORD = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;

/* ── passwords ─────────────────────────────────────────────────────────── */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(expected, actual);
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new HttpError(400, `A password needs at least ${MIN_PASSWORD} characters.`);
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ── service ───────────────────────────────────────────────────────────── */

function createAuthService({ db, sessionTtlHours }) {
  const q = {
    orgCount: db.prepare('SELECT COUNT(*) AS n FROM organizations'),
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    sessionUser: db.prepare(`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  };

  /** username -> { fails, first } — simple brute-force brake, in memory. */
  const attempts = new Map();

  function publicUser(row) {
    return row && { id: row.id, orgId: row.org_id, username: row.username, name: row.display_name, role: row.role,
      active: !!row.active };
  }

  /** True on a brand-new installation: no organisation registered yet. */
  function needsSetup() {
    return q.orgCount.get().n === 0;
  }

  function issueSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const created = new Date();
    const expires = new Date(created.getTime() + sessionTtlHours * 3600 * 1000);
    q.insertSession.run(sha256(token), userId, created.toISOString(), expires.toISOString());
    q.deleteExpired.run(created.toISOString());
    return { token, expires };
  }

  function login(username, password) {
    const key = String(username || '').trim().toLowerCase();
    const a = attempts.get(key);
    if (a && a.fails >= LOGIN_MAX_FAILS && Date.now() - a.first < LOGIN_WINDOW_MS) {
      throw new HttpError(429, 'Too many failed sign-ins. Wait 15 minutes and try again.');
    }
    const row = q.userByName.get(key);
    const ok = !!row && row.active === 1 && verifyPassword(password, row.password_hash);
    if (!ok) {
      const cur = a && Date.now() - a.first < LOGIN_WINDOW_MS ? a : { fails: 0, first: Date.now() };
      cur.fails++;
      attempts.set(key, cur);
      throw new HttpError(401, 'Wrong username or password.');
    }
    attempts.delete(key);
    return { user: publicUser(row), ...issueSession(row.id) };
  }

  function userForToken(token) {
    if (!token) return null;
    return publicUser(q.sessionUser.get(sha256(token), new Date().toISOString()));
  }

  function logout(token) {
    if (token) q.deleteSession.run(sha256(token));
  }

  return { needsSetup, login, logout, userForToken, issueSession, publicUser };
}

module.exports = { createAuthService, hashPassword, verifyPassword, assertPassword };
