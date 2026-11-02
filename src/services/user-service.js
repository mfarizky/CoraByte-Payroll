'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('./errors');
const { hashPassword, verifyPassword, assertPassword } = require('./auth-service');
const { transaction } = require('../db/connection');

const ROLES = ['admin', 'member'];
const USERNAME = /^[a-z0-9._-]{3,32}$/;

function createUserService({ db }) {
  const q = {
    all: db.prepare('SELECT * FROM users WHERE org_id = ? ORDER BY display_name COLLATE NOCASE'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    byName: db.prepare('SELECT id FROM users WHERE username = ?'),
    insert: db.prepare(`INSERT INTO users (id, org_id, username, display_name, password_hash, role, active, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`),
    update: db.prepare('UPDATE users SET display_name = ?, role = ?, active = ?, updated_at = ? WHERE id = ?'),
    setPassword: db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?'),
    activeAdmins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND role = 'admin' AND active = 1"),
    dropSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  };

  const view = (r) => ({ id: r.id, username: r.username, name: r.display_name, role: r.role, active: !!r.active,
    created_at: r.created_at });

  /** Users of one organisation. */
  function list(orgId) {
    return q.all.all(orgId).map(view);
  }

  /** Creates a user inside `orgId`. Usernames are unique across all organisations. */
  function create(orgId, { username, name, password, role }) {
    const u = String(username || '').trim().toLowerCase();
    if (!USERNAME.test(u)) throw new HttpError(400, 'A username is 3–32 characters: letters, digits, dot, dash or underscore.');
    if (!String(name || '').trim()) throw new HttpError(400, 'Every user needs a display name.');
    if (!ROLES.includes(role)) throw new HttpError(400, 'A role is admin or member.');
    assertPassword(password);
    if (q.byName.get(u)) throw new HttpError(409, 'That username is already taken.');
    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    q.insert.run(id, orgId, u, String(name).trim(), hashPassword(password), role, at, at);
    return view(q.byId.get(id));
  }

  function update(id, patch, actor) {
    return transaction(db, () => {
      const row = q.byId.get(id);
      if (!row || row.org_id !== actor.orgId) throw new HttpError(404, 'That user does not exist.');
      const name = patch.name !== undefined ? String(patch.name).trim() : row.display_name;
      const role = patch.role !== undefined ? patch.role : row.role;
      const active = patch.active !== undefined ? (patch.active ? 1 : 0) : row.active;
      if (!name) throw new HttpError(400, 'Every user needs a display name.');
      if (!ROLES.includes(role)) throw new HttpError(400, 'A role is admin or member.');
      if (id === actor.id && (role !== 'admin' || !active)) {
        throw new HttpError(409, 'You cannot remove your own admin role or deactivate yourself.');
      }
      const losingAdmin = row.role === 'admin' && row.active === 1 && (role !== 'admin' || !active);
      if (losingAdmin && q.activeAdmins.get(row.org_id).n <= 1) throw new HttpError(409, 'There must always be at least one active admin.');

      q.update.run(name, role, active, new Date().toISOString(), id);
      if (patch.password) {
        assertPassword(patch.password);
        q.setPassword.run(hashPassword(patch.password), new Date().toISOString(), id);
      }
      if (!active || patch.password) q.dropSessions.run(id);
      return view(q.byId.get(id));
    });
  }

  function changeOwnPassword(userId, current, next) {
    const row = q.byId.get(userId);
    if (!row || !verifyPassword(current, row.password_hash)) throw new HttpError(400, 'The current password is not correct.');
    assertPassword(next);
    q.setPassword.run(hashPassword(next), new Date().toISOString(), userId);
    return { ok: true };
  }

  return { list, create, update, changeOwnPassword };
}

module.exports = { createUserService };
