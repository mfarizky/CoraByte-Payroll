'use strict';

const calc = require('../calc');
const { HttpError } = require('../services/errors');

/** The store, the calculation and client identity — all scoped to the user's organisation. */
function registerPayrollRoutes(router, { store, clients, log }) {
  /* POST /api/store { op, collection, key, value } — answers the bare data. */
  router.add('POST', '/api/store', ({ body, user }) => store.handle(body, user));

  /* POST /api/calc { action, ... } — the calculation reads and writes
     through the same store, so it obeys exactly the same rules. */
  router.add('POST', '/api/calc', async ({ body, user, res }) => {
    const storeFn = async (op, collection, key, value) => {
      try {
        return store.handle({ op, collection, key, value }, user);
      } catch (e) {
        if (e instanceof HttpError) throw new calc.StoreFail(e.status, e.message);
        throw e;
      }
    };
    const out = await calc.handle(body, { store: storeFn, user, log });
    if (out.status !== 200) throw new HttpError(out.status, out.body);
    return out.body;
  });

  router.add('POST', '/api/clients', ({ user, body }) => clients.create(user.orgId, body));
  router.add('PUT', '/api/clients/:id', ({ user, params, body }) => clients.update(user.orgId, params.id, body));
  router.add('POST', '/api/clients/:id/archive',
    ({ user, params, body }) => clients.setArchived(user.orgId, params.id, body.archived !== false), { admin: true });
}

module.exports = { registerPayrollRoutes };
