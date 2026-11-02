'use strict';

const http = require('node:http');
const path = require('node:path');

const { openDatabase } = require('./db/connection');
const { createDocuments } = require('./db/documents');
const { createStoreService } = require('./services/store-service');
const { createAuthService } = require('./services/auth-service');
const { createUserService } = require('./services/user-service');
const { createClientService } = require('./services/client-service');
const { createOrganizationService } = require('./services/organization-service');
const { HttpError } = require('./services/errors');
const { createRouter } = require('./http/router');
const { readJson, parseCookies, assertSameOrigin } = require('./http/request');
const { json, text, redirect } = require('./http/respond');
const { serveStatic, sendFile } = require('./http/static');
const { registerAuthRoutes, COOKIE } = require('./routes/auth');
const { registerPayrollRoutes } = require('./routes/payroll');
const { registerUserRoutes } = require('./routes/users');

/**
 * Wires the database, services and routes into an http.Server.
 * Kept separate from server.js so tests can start it on a random port.
 *
 * @param {object} opts
 * @param {string} opts.dbFile
 * @param {string} opts.publicDir
 * @param {number} opts.sessionTtlHours
 * @param {boolean} [opts.seedDemo]     new organisations start with the demo data
 * @param {boolean} [opts.allowSignup]  anyone may register a new organisation
 * @param {Function} [opts.log]
 */
function createApp(opts) {
  const log = opts.log || ((...a) => console.log(new Date().toISOString(), ...a));

  const db = openDatabase(opts.dbFile);
  const documents = createDocuments(db);
  const users = createUserService({ db });
  const clients = createClientService({ db, documents });

  const services = {
    store: createStoreService({ db, documents }),
    auth: createAuthService({ db, sessionTtlHours: opts.sessionTtlHours }),
    users,
    clients,
    orgs: createOrganizationService({ db, documents, users, clients, seedDemoOnRegister: !!opts.seedDemo }),
    allowSignup: opts.allowSignup !== false,
    log,
  };

  const router = createRouter();
  registerAuthRoutes(router, services);
  registerPayrollRoutes(router, services);
  registerUserRoutes(router, services);
  router.add('GET', '/api/health', () => ({ ok: true }), { public: true });

  const pages = {
    index: path.join(opts.publicDir, 'index.html'),
    login: path.join(opts.publicDir, 'login.html'),
  };

  async function handleApi(req, res, url, user, token) {
    const found = router.match(req.method, url.pathname);
    if (!found) return text(res, 404, 'There is no such endpoint.');
    if (found === 'method') return text(res, 405, 'That method is not allowed here.');
    if (!found.options.public && !user) return text(res, 401, 'Sign in to continue.');
    if (found.options.admin && user.role !== 'admin') return text(res, 403, 'Only an admin can do that.');

    const headers = {};
    const body = req.method === 'GET' ? {} : await readJson(req);
    if (req.method !== 'GET') assertSameOrigin(req);
    const result = await found.handler({
      req, res, url, user, token, body, params: found.params,
      setHeader: (k, v) => { headers[k] = v; },
    });
    json(res, 200, result, headers);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const token = parseCookies(req.headers.cookie)[COOKIE] || null;
    const user = services.auth.userForToken(token);

    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, user, token);
      if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'That method is not allowed here.');

      if (url.pathname === '/' || url.pathname === '/index.html') {
        return user ? sendFile(res, pages.index) : redirect(res, '/login');
      }
      if (url.pathname === '/login') {
        return user ? redirect(res, '/') : sendFile(res, pages.login);
      }
      if (serveStatic(req, res, opts.publicDir, url.pathname)) return;
      return text(res, 404, 'Not found.');
    } catch (err) {
      if (err instanceof HttpError) return text(res, err.status, err.message);
      log('[error]', req.method, url.pathname, err && err.stack);
      return text(res, 500, 'Something went wrong on the server. Nothing was saved.');
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });

  return {
    server,
    db,
    services,
    close() {
      return new Promise((resolve) => server.close(() => { db.close(); resolve(); }));
    },
  };
}

module.exports = { createApp };
