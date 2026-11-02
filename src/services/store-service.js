'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('./errors');
const { transaction } = require('../db/connection');

/*
 * The store: list / get / save / del over the payroll collections, with the
 * rules that keep payroll data consistent. This is the single gate for every
 * write — the browser and the calculation both come through here.
 *
 * Every request is bound to the signed-in user's organisation (user.orgId).
 *
 * Rules enforced:
 *  - optimistic locking: a save carrying `rev` must match the stored `rev`;
 *  - a run moves draft <-> review <-> outputs -> paid, and nowhere else;
 *  - a run can reach `outputs` only when every line is reviewed with a net pay;
 *  - one live run per client, month and run type;
 *  - a paid run, its lines, items and BPJS rows are frozen;
 *  - only admins delete runs or employees; nothing on a paid run is deleted;
 *  - every run transition is written to run_activity, attributed to the user.
 */

const C = {
  accounts: 'core/accounts',
  employers: 'core/employers',
  jobs: 'core/employer_jobs',
  clients: 'app/payroll/clients',
  employees: 'app/payroll/employees',
  components: 'app/payroll/components',
  employeeBpjs: 'app/payroll/employee_bpjs',
  taxOpenings: 'app/payroll/tax_openings',
  runs: 'app/payroll/runs',
  lines: 'app/payroll/run_lines',
  items: 'app/payroll/run_items',
  runBpjs: 'app/payroll/run_bpjs',
  activity: 'app/payroll/run_activity',
};

/** Reference tables: readable by everyone, never written through the store. */
const REFERENCE = ['bpjs_rates', 'jkk_classes', 'minimum_wage', 'ptkp', 'ter_rates', 'pph21_brackets', 'ter_daily']
  .map((k) => 'app/payroll/' + k);

const KNOWN = new Set([...Object.values(C), ...REFERENCE]);

const FROZEN = 'This run is marked paid and cannot change. Make a correction run instead.';

/** Allowed status moves. */
const MOVES = { draft: ['review'], review: ['draft', 'outputs'], outputs: ['draft', 'review', 'paid'], paid: [] };

const now = () => new Date().toISOString();
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const month = (v) => String(v || '').slice(0, 10);

function createStoreService({ db, documents }) {
  /* The rules, bound to one organisation's documents. */
  function scope(docs) {

    function logActivity(runId, event, note, user) {
      docs.put(C.activity, {
        id: crypto.randomUUID(), run_id: runId, event, note: note || null, at: now(),
        by_oid: user.id, by_upn: user.username, by_name: user.name, rev: 1,
      });
    }

    function runOfLine(lineId) {
      const line = docs.get(C.lines, lineId);
      return line ? docs.get(C.runs, line.run_id) : null;
    }

    function assertNotFrozen(collection, row, value) {
      const src = row || value || {};
      let run = null;
      if (collection === C.lines) run = docs.get(C.runs, src.run_id);
      else if (collection === C.items || collection === C.runBpjs) run = runOfLine(src.run_line_id);
      if (run && run.status === 'paid') throw new HttpError(409, FROZEN);
    }

    function moveRun(run, to, user) {
      const from = run.status;
      if (from === to) return;
      if (from === 'paid') throw new HttpError(403, 'A paid run cannot be reopened. Make a correction run instead.');
      if (!(MOVES[from] || []).includes(to)) throw new HttpError(409, 'A payroll run cannot move straight to that status.');
      if (to === 'outputs') {
        const lines = docs.list(C.lines).filter((l) => l.run_id === run.id);
        const ready = lines.length > 0 && lines.every((l) => l.reviewed && l.net_pay !== null && l.net_pay !== undefined);
        if (!ready) throw new HttpError(409, 'This run cannot go to outputs yet. Every employee has to be reviewed and have a net pay.');
      }
      run.status = to;
      if (to === 'paid') Object.assign(run, { paid_at: now(), paid_by_oid: user.id, paid_by_name: user.name });

      const event = {
        'draft>review': ['sent_to_review'],
        'review>outputs': ['confirmed'],
        'outputs>draft': ['reopened', 'Reopened to draft'],
        'outputs>review': ['reopened', 'Reopened to review'],
      }[from + '>' + to] || (to === 'paid' ? ['marked_paid'] : null);
      if (event) logActivity(run.id, event[0], event[1], user);
    }

    function lineIdsOf(predicate) {
      return new Set(docs.list(C.lines).filter(predicate).map((l) => l.id));
    }

    function purgeRun(runId) {
      const ids = lineIdsOf((l) => l.run_id === runId);
      docs.removeWhere(C.items, (r) => ids.has(r.run_line_id));
      docs.removeWhere(C.runBpjs, (r) => ids.has(r.run_line_id));
      docs.removeWhere(C.lines, (l) => l.run_id === runId);
      docs.removeWhere(C.activity, (a) => a.run_id === runId);
      docs.remove(C.runs, runId);
    }

    /* ── operations ────────────────────────────────────────────────────── */

    function list(collection, options) {
      let rows = docs.list(collection);
      if (collection === C.employees && !(options && options.includeInactive)) rows = rows.filter((e) => e.active !== false);
      if (collection === C.runs) {
        rows.sort((a, b) => String(b.period_month).localeCompare(String(a.period_month)) || b.sequence - a.sequence);
      }
      return rows;
    }

    function createRun(v, user) {
      const type = v.run_type || 'regular';
      const period = month(v.period_month);
      if (!/^\d{4}-\d{2}-01$/.test(period)) throw new HttpError(409, 'A payroll month must be the first of the month.');
      const same = docs.list(C.runs).filter((r) =>
        r.payroll_client_id === v.payroll_client_id && month(r.period_month) === period && (r.run_type || 'regular') === type);
      if (same.some((r) => !r.superseded_by_run_id)) {
        throw new HttpError(409, 'That client already has a live run of that type for that month. Supersede it before starting another.');
      }
      const run = {
        id: crypto.randomUUID(), payroll_client_id: v.payroll_client_id, period_month: period, run_type: type,
        sequence: same.length + 1, status: 'draft', pay_date: v.pay_date || null, cutoff_date: v.cutoff_date || null,
        notes: v.notes || null, superseded_by_run_id: null, paid_at: null, paid_by_oid: null, paid_by_name: null,
        rev: 1, created_at: now(),
      };
      docs.put(C.runs, run);
      logActivity(run.id, 'drafted', null, user);
      return run;
    }

    function save(collection, key, value, user) {
      if (REFERENCE.includes(collection)) throw new HttpError(403, 'Reference tables are read-only.');
      const v = clone(value) || {};
      const row = key ? docs.get(collection, key) : null;
      if (key && !row) throw new HttpError(404, 'That record does not exist.');
      if (row && v.rev !== undefined && v.rev !== null && Number(v.rev) !== Number(row.rev)) {
        throw new HttpError(409, 'Someone else changed this record. Reload and try again.');
      }
      assertNotFrozen(collection, row, v);

      if (collection === C.runs) {
        if (!row) return createRun(v, user);
        if (row.status === 'paid') throw new HttpError(409, FROZEN);
        for (const k of ['pay_date', 'cutoff_date', 'notes']) if (v[k] !== undefined) row[k] = v[k];
        if (v.status) moveRun(row, v.status, user);
        row.rev = Number(row.rev || 1) + 1;
        return docs.put(C.runs, row);
      }

      if (collection === C.activity) {
        const entry = { id: crypto.randomUUID(), run_id: v.run_id, event: v.event, note: v.note || null, at: now(),
          by_oid: user.id, by_upn: user.username, by_name: user.name, rev: 1 };
        return docs.put(C.activity, entry);
      }

      if (!row) {
        if (collection === C.employees) {
          if (v.active === undefined) v.active = true;
          if (!v.employee_code) v.employee_code = nextEmployeeCode();
        }
        if (collection === C.items && v.kind === undefined) v.kind = null;
        const fresh = { ...v, id: v.id || crypto.randomUUID(), rev: 1, created_at: now() };
        return docs.put(collection, fresh);
      }

      for (const k of Object.keys(v)) if (k !== 'rev' && k !== 'id') row[k] = v[k];
      row.rev = Number(row.rev || 1) + 1;
      return docs.put(collection, row);
    }

    function nextEmployeeCode() {
      const max = docs.list(C.employees)
        .map((e) => Number(String(e.employee_code || '').replace(/\D/g, '')) || 0)
        .reduce((a, b) => Math.max(a, b), 0);
      return 'EMP-' + String(max + 1).padStart(4, '0');
    }

    function del(collection, key, user) {
      if (REFERENCE.includes(collection)) throw new HttpError(403, 'Reference tables are read-only.');
      if ((collection === C.runs || collection === C.employees) && user.role !== 'admin') {
        throw new HttpError(403, 'Only an admin can delete or reset a run or an employee.');
      }
      const target = docs.get(collection, key);
      if (!target) return { deleted: false, id: key };
      assertNotFrozen(collection, target, null);

      if (collection === C.runs) {
        if (target.status === 'paid') throw new HttpError(409, 'This run is marked paid and cannot be reset.');
        purgeRun(target.id);
        return { deleted: true, id: key };
      }

      if (collection === C.employees) {
        const lines = docs.list(C.lines).filter((l) => l.payroll_employee_id === key);
        const onPaid = lines.some((l) => { const r = docs.get(C.runs, l.run_id); return r && r.status === 'paid'; });
        if (onPaid) throw new HttpError(409, 'This employee is on a paid payroll run and cannot be deleted. Set the employee inactive instead.');
        const ids = new Set(lines.map((l) => l.id));
        docs.removeWhere(C.items, (r) => ids.has(r.run_line_id));
        docs.removeWhere(C.runBpjs, (r) => ids.has(r.run_line_id));
        docs.removeWhere(C.lines, (l) => l.payroll_employee_id === key);
        for (const c of [C.components, C.employeeBpjs, C.taxOpenings]) docs.removeWhere(c, (r) => r.payroll_employee_id === key);
      }

      docs.remove(collection, key);
      return { deleted: true, id: key };
    }


    return { list, save, del, get: (collection, id) => docs.get(collection, id) };
  }

  /**
   * Executes one store request.
   * @param {{op:string, collection:string, key?:string|null, value?:any}} req
   * @param {{id:string, orgId:string, username:string, name:string, role:string}} user
   */
  function handle(req, user) {
    const { op, collection } = req || {};
    if (!KNOWN.has(collection)) throw new HttpError(404, 'That collection does not exist.');
    const ops = scope(documents.forOrg(user.orgId));
    switch (op) {
      case 'list': return ops.list(collection, req.value);
      case 'get': return ops.get(collection, req.key);
      case 'save': return transaction(db, () => ops.save(collection, req.key, req.value, user));
      case 'del': return transaction(db, () => ops.del(collection, req.key, user));
      default: throw new HttpError(400, `The store does not know the operation "${String(op).slice(0, 20)}".`);
    }
  }

  return { handle, collections: C, reference: REFERENCE };
}

module.exports = { createStoreService, COLLECTIONS: C, REFERENCE };
