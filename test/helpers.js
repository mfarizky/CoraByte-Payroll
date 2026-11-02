'use strict';

const path = require('node:path');
const { createApp } = require('../src/app');

/**
 * Starts the app on a random port with a fresh in-memory database.
 * Returns { app, base, client(), close() }; client() keeps its own cookie.
 */
async function startApp({ seedDemo = true } = {}) {
  const app = createApp({
    dbFile: ':memory:',
    publicDir: path.join(__dirname, '..', 'public'),
    sessionTtlHours: 1,
    seedDemo,
    log: () => {},
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  function client() {
    let cookie = '';
    return async function call(method, url, body) {
      const res = await fetch(base + url, {
        method,
        headers: { 'Content-Type': 'application/json', cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let data = text;
      try { data = JSON.parse(text); } catch { /* text/plain error */ }
      return { status: res.status, data, headers: res.headers };
    };
  }

  return { app, base, client, close: () => app.close() };
}

/** Registers an organisation and returns its admin client (signed in). */
async function adminClient(t, { org = 'Org A', username = 'admin' } = {}) {
  const call = t.client();
  const r = await call('POST', '/api/auth/register', { org_name: org, username, name: 'Admin', password: 'password123' });
  if (r.status !== 200) throw new Error('register failed: ' + JSON.stringify(r.data));
  return call;
}

module.exports = { startApp, adminClient };
