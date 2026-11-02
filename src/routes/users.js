'use strict';

/** User management and organisation settings — admins of the organisation only. */
function registerUserRoutes(router, { users, orgs }) {
  router.add('GET', '/api/users', ({ user }) => users.list(user.orgId), { admin: true });
  router.add('POST', '/api/users', ({ user, body }) => users.create(user.orgId, body), { admin: true });
  router.add('PUT', '/api/users/:id', ({ params, body, user }) => users.update(params.id, body, user), { admin: true });

  router.add('GET', '/api/org', ({ user }) => orgs.get(user.orgId));
  router.add('PUT', '/api/org', ({ user, body }) => orgs.update(user.orgId, body), { admin: true });
  router.add('PUT', '/api/org/structure', ({ user, body }) => orgs.setStructure(user.orgId, body), { admin: true });
}

module.exports = { registerUserRoutes };
