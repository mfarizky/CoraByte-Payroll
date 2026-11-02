'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, adminClient } = require('./helpers');
const { hashPassword, verifyPassword } = require('../src/services/auth-service');

let t;
before(async () => { t = await startApp(); });
after(() => t.close());

test('passwords are hashed with scrypt and verified', () => {
  const h = hashPassword('correct horse');
  assert.match(h, /^scrypt\$/);
  assert.equal(verifyPassword('correct horse', h), true);
  assert.equal(verifyPassword('wrong', h), false);
});

test('a new database asks for setup and refuses data without a session', async () => {
  const call = t.client();
  assert.deepEqual((await call('GET', '/api/auth/state')).data, { needsSetup: true, allowSignup: true, user: null });
  assert.equal((await call('POST', '/api/store', { op: 'list', collection: 'app/payroll/clients' })).status, 401);
});

test('registering an organisation creates its admin; then sign-in works', async () => {
  const admin = await adminClient(t);
  const me = (await admin('GET', '/api/me')).data;
  assert.equal(me.user.role, 'admin');
  assert.equal(me.org.name, 'Org A');

  const taken = await t.client()('POST', '/api/auth/register', { org_name: 'X', username: 'admin', name: 'X', password: 'password123' });
  assert.equal(taken.status, 409, 'usernames are unique across organisations');

  const call = t.client();
  assert.equal((await call('POST', '/api/auth/login', { username: 'admin', password: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'ADMIN', password: 'password123' })).status, 200);
  assert.equal((await call('POST', '/api/auth/logout', {})).status, 200);
  assert.equal((await call('GET', '/api/me')).status, 401);
});

test('members cannot manage users or delete employees', async () => {
  const admin = t.client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'password123' });
  const created = await admin('POST', '/api/users', { username: 'member1', name: 'Member', password: 'password123', role: 'member' });
  assert.equal(created.status, 200);

  const member = t.client();
  await member('POST', '/api/auth/login', { username: 'member1', password: 'password123' });
  assert.equal((await member('GET', '/api/users')).status, 403);
  const del = await member('POST', '/api/store', { op: 'del', collection: 'app/payroll/employees', key: 'em-demo-1' });
  assert.equal(del.status, 403);
});

test('the last active admin cannot be demoted', async () => {
  const admin = t.client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'password123' });
  const me = (await admin('GET', '/api/me')).data.user;
  const r = await admin('PUT', '/api/users/' + me.id, { role: 'member' });
  assert.equal(r.status, 409);
});

test('cross-site POSTs are refused', async () => {
  const res = await fetch(t.base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ username: 'admin', password: 'password123' }),
  });
  assert.equal(res.status, 403);
});
