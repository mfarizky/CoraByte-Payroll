'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startApp, adminClient } = require('./helpers');
const { openDatabase } = require('../src/db/connection');

let t;
let a;
let b;
before(async () => {
  t = await startApp();
  a = await adminClient(t, { org: 'PT Alpha Konsultan', username: 'alpha' });
  b = await adminClient(t, { org: 'PT Beta Konsultan', username: 'beta' });
});
after(() => t.close());

const list = (call, collection) => call('POST', '/api/store', { op: 'list', collection });

test('each organisation sees only its own data', async () => {
  // demo data is seeded for every new organisation in the test app
  const before = (await list(b, 'app/payroll/clients')).data.length;
  const made = await a('POST', '/api/clients', { name: 'PT Hanya Alpha', short_code: 'ALP' });
  assert.equal(made.status, 200);

  const aNames = (await list(a, 'core/accounts')).data.map((x) => x.name);
  const bNames = (await list(b, 'core/accounts')).data.map((x) => x.name);
  assert.ok(aNames.includes('PT Hanya Alpha'));
  assert.ok(!bNames.includes('PT Hanya Alpha'));
  assert.equal((await list(b, 'app/payroll/clients')).data.length, before);

  // the same short code is fine in another organisation
  assert.equal((await b('POST', '/api/clients', { name: 'PT Hanya Beta', short_code: 'ALP' })).status, 200);
});

test('ids from another organisation are not reachable', async () => {
  const acc = (await list(a, 'core/accounts')).data.find((x) => x.name === 'PT Hanya Alpha');
  const id = (await list(a, 'app/payroll/clients')).data.find((c) => c.account_id === acc.id).id;
  assert.equal((await b('POST', '/api/store', { op: 'get', collection: 'app/payroll/clients', key: id })).data, null);
  assert.equal((await b('POST', '/api/store', { op: 'save', collection: 'app/payroll/clients', key: id, value: { pay_day: 9 } })).status, 404);
  assert.equal((await b('PUT', '/api/clients/' + id, { name: 'Hijack' })).status, 404);

  const alphaUsers = (await a('GET', '/api/users')).data;
  assert.equal((await b('PUT', '/api/users/' + alphaUsers[0].id, { name: 'Hijack' })).status, 404);
  assert.deepEqual((await b('GET', '/api/users')).data.map((u) => u.username), ['beta']);
});

test('admins edit their organisation profile; members only read it', async () => {
  const r = await a('PUT', '/api/org', { name: 'PT Alpha', npwp: '01.234.567.8-910.000', email: 'payroll@alpha.example' });
  assert.equal(r.status, 200);
  assert.equal((await a('GET', '/api/me')).data.org.name, 'PT Alpha');
  assert.equal((await a('PUT', '/api/org', { email: 'not-an-email' })).status, 400);

  await a('POST', '/api/users', { username: 'alpha-member', name: 'M', password: 'password123', role: 'member' });
  const m = t.client();
  await m('POST', '/api/auth/login', { username: 'alpha-member', password: 'password123' });
  assert.equal((await m('GET', '/api/org')).data.name, 'PT Alpha');
  assert.equal((await m('PUT', '/api/org', { name: 'X' })).status, 403);
});

test('a v0.1 database is upgraded (one organisation, employer link)', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE documents (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (collection, id));
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO users VALUES ('u1', 'old', 'Old Admin', 'x', 'admin', 1, 'now', 'now');
    INSERT INTO documents VALUES ('app/payroll/clients', 'c1', '{"id":"c1"}', 'now');
  `);
  old.close();

  const db = openDatabase(file);
  const org = db.prepare('SELECT * FROM organizations').all();
  assert.equal(org.length, 1);
  assert.equal(db.prepare('SELECT org_id FROM users WHERE id = ?').get('u1').org_id, org[0].id);
  assert.equal(db.prepare('SELECT org_id FROM documents WHERE id = ?').get('c1').org_id, org[0].id);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '3');
  assert.ok('primary_client_id' in org[0], 'v3 adds the employer link');
  db.close();
});
