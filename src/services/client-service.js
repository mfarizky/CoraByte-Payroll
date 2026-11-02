'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('./errors');
const { transaction } = require('../db/connection');
const { COLLECTIONS: C } = require('./store-service');

/*
 * A payroll client is three rows that always move together:
 *   core/accounts        the company (name, NPWP, short code, city)
 *   core/employers       its employer record (legal name, departments)
 *   app/payroll/clients  its payroll settings (JKK, pay day, debit account…)
 * plus its positions in core/employer_jobs. This service creates and edits
 * the identity side; payroll settings are saved through the store as before.
 */

const DEFAULT_SETTINGS = {
  jkk_rate: '0.002400',
  bpjs_floor_region: 'UMP_NTB',
  kesehatan_base_includes_fixed: false,
  pay_day: 25,
  cutoff_day: 20,
  bank_code: 'MANDIRI',
  debit_account: null,
  contact_name: null,
  contact_email: null,
  file_format: 'format_lama',
  proration_basis: 'calendar_days',
};

const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());
const upper = (v) => clean(v).toUpperCase();

function normaliseIdentity(input) {
  const name = clean(input.name);
  if (!name) throw new HttpError(400, 'A client needs a name.');
  const shortCode = upper(input.short_code).replace(/[^A-Z0-9]/g, '');
  if (shortCode && !/^[A-Z0-9]{2,8}$/.test(shortCode)) throw new HttpError(400, 'A short code is 2–8 letters or digits.');
  const npwp = clean(input.npwp);
  const departments = [...new Set((Array.isArray(input.departments) ? input.departments : []).map(upper).filter(Boolean))];
  const positions = (Array.isArray(input.positions) ? input.positions : [])
    .map((p) => ({ department: upper(p.department), title: clean(p.title) }))
    .filter((p) => p.title);
  for (const p of positions) if (p.department && !departments.includes(p.department)) departments.push(p.department);
  return {
    name, shortCode, npwp, departments, positions,
    legalName: clean(input.legal_name) || name,
    city: clean(input.city) || null,
    province: clean(input.province) || null,
  };
}

function createClientService({ db, documents }) {
  /* Each method takes the organisation first; all reads/writes stay inside it. */

  function assertShortCodeFree(docs, code, exceptAccountId) {
    if (!code) return;
    const taken = docs.list(C.accounts).some((a) => a.short_code === code && a.id !== exceptAccountId);
    if (taken) throw new HttpError(409, `The short code ${code} is already used by another client.`);
  }

  function syncPositions(docs, employerId, positions) {
    const existing = docs.list(C.jobs).filter((j) => j.employer_id === employerId);
    const key = (p) => p.department + '|' + p.title.toLowerCase();
    const wanted = new Map(positions.map((p) => [key(p), p]));
    for (const job of existing) {
      const k = key({ department: job.department || '', title: job.title || '' });
      const active = wanted.has(k);
      if (job.active !== active) docs.put(C.jobs, { ...job, active });
      wanted.delete(k);
    }
    for (const p of wanted.values()) {
      docs.put(C.jobs, { id: crypto.randomUUID(), employer_id: employerId, title: p.title, department: p.department, active: true });
    }
  }

  function create(orgId, input) {
    const docs = documents.forOrg(orgId);
    const id = normaliseIdentity(input);
    return transaction(db, () => {
      assertShortCodeFree(docs, id.shortCode);
      const at = new Date().toISOString();
      const account = {
        id: crypto.randomUUID(), code: id.shortCode, short_code: id.shortCode, name: id.name, npwp: id.npwp,
        city: id.city, province: id.province, payroll_client: true, created_at: at,
      };
      const employer = {
        id: crypto.randomUUID(), account_id: account.id, label: id.name, effective_legal_name: id.legalName,
        effective_npwp: id.npwp, departments: id.departments, active: true, logo: null, created_at: at,
      };
      const settings = { ...DEFAULT_SETTINGS, ...pickSettings(input.settings), id: crypto.randomUUID(),
        account_id: account.id, rev: 1, created_at: at };
      docs.put(C.accounts, account);
      docs.put(C.employers, employer);
      docs.put(C.clients, settings);
      syncPositions(docs, employer.id, id.positions);
      return { id: settings.id, account_id: account.id };
    });
  }

  function update(orgId, clientId, input) {
    const docs = documents.forOrg(orgId);
    const id = normaliseIdentity(input);
    return transaction(db, () => {
      const settings = docs.get(C.clients, clientId);
      if (!settings) throw new HttpError(404, 'That client does not exist.');
      const account = docs.get(C.accounts, settings.account_id);
      if (!account) throw new HttpError(404, 'That client has no company record.');
      assertShortCodeFree(docs, id.shortCode, account.id);
      docs.put(C.accounts, { ...account, name: id.name, npwp: id.npwp, code: id.shortCode, short_code: id.shortCode,
        city: id.city, province: id.province });
      let employer = docs.list(C.employers).find((e) => e.account_id === account.id);
      employer = { ...(employer || { id: crypto.randomUUID(), account_id: account.id, active: true, logo: null }),
        label: id.name, effective_legal_name: id.legalName, effective_npwp: id.npwp, departments: id.departments };
      docs.put(C.employers, employer);
      syncPositions(docs, employer.id, id.positions);
      return { id: clientId, account_id: account.id };
    });
  }

  /** Archive hides a client from every list; its history stays intact. */
  function setArchived(orgId, clientId, archived) {
    const docs = documents.forOrg(orgId);
    return transaction(db, () => {
      const settings = docs.get(C.clients, clientId);
      if (!settings) throw new HttpError(404, 'That client does not exist.');
      const account = docs.get(C.accounts, settings.account_id);
      docs.put(C.accounts, { ...account, payroll_client: !archived });
      return { id: clientId, archived: !!archived };
    });
  }

  /** Copies the organisation's identity onto its employer record (account + employer). */
  function patchIdentity(orgId, clientId, org) {
    const docs = documents.forOrg(orgId);
    return transaction(db, () => {
      const settings = docs.get(C.clients, clientId);
      if (!settings) throw new HttpError(404, 'That client does not exist.');
      const account = docs.get(C.accounts, settings.account_id) || { id: settings.account_id, payroll_client: true };
      const legal = clean(org.legal_name) || clean(org.name);
      docs.put(C.accounts, { ...account, name: clean(org.name), npwp: clean(org.npwp), city: org.city || null,
        province: org.province || null, address: org.address || null });
      const employer = docs.list(C.employers).find((e) => e.account_id === account.id);
      if (employer) {
        docs.put(C.employers, { ...employer, label: clean(org.name), effective_legal_name: legal, effective_npwp: clean(org.npwp) });
      }
      return { id: clientId };
    });
  }

  /** Short code (bank file names), departments and positions of one client. */
  function setStructure(orgId, clientId, input) {
    const docs = documents.forOrg(orgId);
    const settings = docs.get(C.clients, clientId);
    if (!settings) throw new HttpError(404, 'That client does not exist.');
    const account = docs.get(C.accounts, settings.account_id) || {};
    const id = normaliseIdentity({ ...input, name: account.name || 'x' });
    return transaction(db, () => {
      assertShortCodeFree(docs, id.shortCode, account.id);
      docs.put(C.accounts, { ...account, code: id.shortCode, short_code: id.shortCode });
      let employer = docs.list(C.employers).find((e) => e.account_id === account.id);
      employer = { ...(employer || { id: crypto.randomUUID(), account_id: account.id, active: true, logo: null,
        label: account.name, effective_legal_name: account.name }), departments: id.departments };
      docs.put(C.employers, employer);
      syncPositions(docs, employer.id, id.positions);
      return { id: clientId, short_code: id.shortCode, departments: id.departments, positions: id.positions };
    });
  }

  return { create, update, setArchived, patchIdentity, setStructure };
}

function pickSettings(s) {
  const out = {};
  if (!s || typeof s !== 'object') return out;
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (s[k] !== undefined) out[k] = s[k];
  return out;
}

module.exports = { createClientService, DEFAULT_SETTINGS };
