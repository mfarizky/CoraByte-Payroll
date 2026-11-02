'use strict';

const { HttpError } = require('./errors');
const { transaction } = require('../db/connection');
const { seedReference, seedDemo } = require('../db/seed');
const { COLLECTIONS: C } = require('./store-service');

const FIELDS = ['name', 'legal_name', 'npwp', 'address', 'city', 'province', 'phone', 'email'];
const clean = (v) => (v === undefined || v === null ? null : String(v).trim() || null);

/**
 * Organisations (tenants). One organisation = one employer: its employees,
 * payroll runs and payslips belong to it.
 *
 * In the payroll data the employer is a "client" row (app/payroll/clients +
 * core/accounts + core/employers) — the model that supports several clients
 * per organisation later. Today every organisation has exactly one, its
 * PRIMARY client, created on registration and kept in sync with the profile.
 */
function createOrganizationService({ db, documents, users, clients, seedDemoOnRegister }) {
  const q = {
    count: db.prepare('SELECT COUNT(*) AS n FROM organizations'),
    byId: db.prepare('SELECT * FROM organizations WHERE id = ?'),
    insert: db.prepare('INSERT INTO organizations (id, name, legal_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
    update: db.prepare(`UPDATE organizations SET name = ?, legal_name = ?, npwp = ?, address = ?, city = ?, province = ?,
                        phone = ?, email = ?, updated_at = ? WHERE id = ?`),
    setPrimary: db.prepare('UPDATE organizations SET primary_client_id = ? WHERE id = ?'),
  };

  const view = (r) => r && {
    id: r.id, name: r.name, legal_name: r.legal_name, npwp: r.npwp, address: r.address, city: r.city,
    province: r.province, phone: r.phone, email: r.email, created_at: r.created_at,
    primary_client_id: r.primary_client_id,
  };

  function count() {
    return q.count.get().n;
  }

  /**
   * Makes sure the organisation has its primary client and returns its id.
   * An organisation upgraded from an older version adopts its oldest client,
   * so no existing data is hidden.
   */
  function ensurePrimary(orgId) {
    const row = q.byId.get(orgId);
    if (!row) throw new HttpError(404, 'That organisation does not exist.');
    const docs = documents.forOrg(orgId);
    if (row.primary_client_id && docs.get(C.clients, row.primary_client_id)) return row.primary_client_id;

    return transaction(db, () => {
      const existing = docs.list(C.clients).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
      const id = existing ? existing.id
        : clients.create(orgId, { name: row.name, legal_name: row.legal_name, npwp: row.npwp, city: row.city,
          province: row.province }).id;
      q.setPrimary.run(id, orgId);
      return id;
    });
  }

  function get(orgId) {
    ensurePrimary(orgId);
    return view(q.byId.get(orgId));
  }

  /** Creates an organisation, its first admin and its employer record. Returns { org, user }. */
  function register({ org_name, name, username, password }) {
    const orgName = clean(org_name);
    if (!orgName) throw new HttpError(400, 'Enter the organisation name.');
    return transaction(db, () => {
      const id = require('node:crypto').randomUUID();
      const at = new Date().toISOString();
      q.insert.run(id, orgName, orgName, at, at);
      const user = users.create(id, { username, name, password, role: 'admin' });
      const docs = documents.forOrg(id);
      seedReference(db, docs);
      const clientId = ensurePrimary(id);
      if (seedDemoOnRegister) seedDemo(db, docs, clientId);
      return { org: view(q.byId.get(id)), user };
    });
  }

  function update(orgId, patch) {
    const cur = get(orgId);
    const next = {};
    for (const f of FIELDS) next[f] = patch[f] !== undefined ? clean(patch[f]) : cur[f];
    if (!next.name) throw new HttpError(400, 'The organisation needs a name.');
    if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) throw new HttpError(400, 'That email address does not look right.');
    return transaction(db, () => {
      q.update.run(next.name, next.legal_name, next.npwp, next.address, next.city, next.province, next.phone, next.email,
        new Date().toISOString(), orgId);
      clients.patchIdentity(orgId, cur.primary_client_id, next);   // payslips show the employer's identity
      return get(orgId);
    });
  }

  /** Short code, departments and positions of the organisation (as employer). */
  function setStructure(orgId, input) {
    return clients.setStructure(orgId, ensurePrimary(orgId), input);
  }

  return { count, get, register, update, setStructure, ensurePrimary };
}

module.exports = { createOrganizationService };
