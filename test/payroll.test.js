'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, adminClient } = require('./helpers');
const selftest = require('../src/calc/selftest');

let t;
let admin;
let employer;   // the organisation's employer record (its primary client)
before(async () => {
  t = await startApp();
  admin = await adminClient(t);
  employer = (await admin('GET', '/api/me')).data.org.primary_client_id;
});
after(() => t.close());

const store = (op, collection, key, value) => admin('POST', '/api/store', { op, collection, key, value });

test('the engine self-test passes', () => {
  const r = selftest.run();
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
});

test('reference rate tables are seeded and read-only', async () => {
  const ter = await store('list', 'app/payroll/ter_rates');
  assert.ok(ter.data.length > 100);
  assert.equal((await store('save', 'app/payroll/ter_rates', null, { x: 1 })).status, 403);
});

test('a new organisation has its employer record, in sync with the profile', async () => {
  assert.ok(employer);
  await admin('PUT', '/api/org', { name: 'PT Uji Payroll', npwp: '01.111.111.1-111.000' });
  const settings = (await store('get', 'app/payroll/clients', employer)).data;
  const account = (await store('get', 'core/accounts', settings.account_id)).data;
  assert.equal(account.name, 'PT Uji Payroll');
  assert.equal(account.npwp, '01.111.111.1-111.000');

  const r = await admin('PUT', '/api/org/structure', { short_code: 'upj', departments: ['HR'],
    positions: [{ department: 'HR', title: 'Recruiter' }] });
  assert.equal(r.status, 200);
  assert.equal((await store('get', 'core/accounts', settings.account_id)).data.short_code, 'UPJ');
});

test('extra clients can still be created, and short codes stay unique', async () => {
  const r = await admin('POST', '/api/clients', {
    name: 'PT Uji Coba', short_code: 'UJI', positions: [{ department: 'hr', title: 'Staff' }],
  });
  assert.equal(r.status, 200);
  const clients = (await store('list', 'app/payroll/clients')).data;
  assert.ok(clients.some((c) => c.id === r.data.id && c.pay_day === 25));
  const jobs = (await store('list', 'core/employer_jobs')).data;
  assert.ok(jobs.some((j) => j.title === 'Staff' && j.department === 'HR'));

  assert.equal((await admin('POST', '/api/clients', { name: 'Other', short_code: 'uji' })).status, 409);
  assert.equal((await admin('POST', '/api/clients', { name: 'Other', short_code: 'upj' })).status, 409);
  assert.equal((await admin('POST', '/api/clients', { name: '' })).status, 400);
});

test('a stale rev is refused (optimistic locking)', async () => {
  const c = (await store('get', 'app/payroll/clients', employer)).data;
  assert.equal((await store('save', 'app/payroll/clients', c.id, { rev: c.rev, pay_day: 2 })).status, 200);
  const stale = await store('save', 'app/payroll/clients', c.id, { rev: c.rev, pay_day: 3 });
  assert.equal(stale.status, 409);
});

test('a full run: compute → review → outputs → paid, then frozen', async () => {
  const run = (await store('save', 'app/payroll/runs', null,
    { payroll_client_id: employer, period_month: '2026-10-01', pay_date: '2026-11-01' })).data;
  assert.equal(run.status, 'draft');

  const dup = await store('save', 'app/payroll/runs', null, { payroll_client_id: employer, period_month: '2026-10-01' });
  assert.equal(dup.status, 409, 'one live run per client, month and type');

  let calc = await admin('POST', '/api/calc', { action: 'compute', run_id: run.id });
  assert.equal(calc.status, 200);
  assert.equal(calc.data.lines.length, 5);

  // the daily-paid worker needs days worked before he gets a net pay
  const lines = (await store('list', 'app/payroll/run_lines')).data.filter((l) => l.run_id === run.id);
  const daily = lines.find((l) => l.payroll_employee_id === 'em-demo-5');
  assert.equal(daily.net_pay ?? null, null);
  await store('save', 'app/payroll/run_lines', daily.id, { rev: daily.rev, days_worked: 22, days_in_period: 30 });
  calc = await admin('POST', '/api/calc', { action: 'compute', run_id: run.id });
  assert.equal(calc.data.totals.refused, 0);
  assert.equal(calc.data.totals.net_pay, 25767720);

  let r = (await store('get', 'app/payroll/runs', run.id)).data;
  r = (await store('save', 'app/payroll/runs', run.id, { rev: r.rev, status: 'review' })).data;

  const early = await store('save', 'app/payroll/runs', run.id, { rev: r.rev, status: 'outputs' });
  assert.equal(early.status, 409, 'outputs needs every line reviewed');

  for (const line of (await store('list', 'app/payroll/run_lines')).data.filter((l) => l.run_id === run.id)) {
    assert.equal((await admin('POST', '/api/calc', { action: 'review', line_id: line.id, reviewed: true })).status, 200);
  }
  r = (await store('save', 'app/payroll/runs', run.id, { rev: r.rev, status: 'outputs' })).data;
  r = (await store('save', 'app/payroll/runs', run.id, { rev: r.rev, status: 'paid' })).data;
  assert.equal(r.status, 'paid');

  assert.equal((await store('save', 'app/payroll/runs', run.id, { rev: r.rev, notes: 'x' })).status, 409);
  const line = (await store('list', 'app/payroll/run_lines')).data.find((l) => l.run_id === run.id);
  assert.equal((await store('save', 'app/payroll/run_lines', line.id, { rev: line.rev, days_worked: 1 })).status, 409);
  assert.equal((await store('del', 'app/payroll/runs', run.id)).status, 409);
  assert.equal((await store('del', 'app/payroll/employees', 'em-demo-1')).status, 409,
    'an employee on a paid run cannot be deleted');

  const events = (await store('list', 'app/payroll/run_activity')).data.filter((a) => a.run_id === run.id).map((a) => a.event);
  assert.deepEqual(events, ['drafted', 'sent_to_review', 'confirmed', 'marked_paid']);
});
