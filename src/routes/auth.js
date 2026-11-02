'use strict';

const { HttpError } = require('../services/errors');

const COOKIE = 'cb_session';

function sessionCookie(token, expires) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}`;
}
const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/** Sign-in, sign-out, organisation registration and the current user. */
function registerAuthRoutes(router, { auth, users, orgs, allowSignup }) {
  router.add('GET', '/api/auth/state', ({ user }) => ({
    needsSetup: auth.needsSetup(),
    allowSignup: allowSignup || auth.needsSetup(),
    user: user || null,
  }), { public: true });

  /* Registers a new organisation with its first admin, and signs them in.
     Always allowed on a brand-new installation; afterwards only when
     ALLOW_SIGNUP is on. */
  router.add('POST', '/api/auth/register', ({ body, setHeader }) => {
    if (!allowSignup && !auth.needsSetup()) throw new HttpError(403, 'Registering new organisations is turned off on this server.');
    const { org, user } = orgs.register(body);
    const s = auth.issueSession(user.id);
    setHeader('Set-Cookie', sessionCookie(s.token, s.expires));
    return { org, user };
  }, { public: true });

  router.add('POST', '/api/auth/login', ({ body, setHeader }) => {
    const s = auth.login(body.username, body.password);
    setHeader('Set-Cookie', sessionCookie(s.token, s.expires));
    return { user: s.user };
  }, { public: true });

  router.add('POST', '/api/auth/logout', ({ token, setHeader }) => {
    auth.logout(token);
    setHeader('Set-Cookie', clearCookie());
    return { ok: true };
  }, { public: true });

  router.add('GET', '/api/me', ({ user }) => {
    const org = orgs.get(user.orgId);
    return { user, org: { id: org.id, name: org.name, primary_client_id: org.primary_client_id } };
  });

  router.add('POST', '/api/me/password', ({ user, body }) =>
    users.changeOwnPassword(user.id, body.current, body.next));
}

module.exports = { registerAuthRoutes, COOKIE };
