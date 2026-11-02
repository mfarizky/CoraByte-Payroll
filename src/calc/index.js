/**
 * Payroll calculation service — the only place figures are computed.
 *
 * Runs on the server, never in the browser. It reads the master data and the
 * run through the injected `store` (the same rules as /api/store), calls the
 * pure engine (engine.js) and writes the results to the run lines while the
 * run is still draft or review. A paid run is refused by the store itself.
 *
 *   { action: 'compute',  run_id }             -> { run, lines[], totals }
 *   { action: 'restart',  run_id }             -> a fresh calculation
 *   { action: 'review',   line_id, reviewed }  -> the saved line
 *   { action: 'selftest' }                     -> the engine's fictional proof
 *
 * Personal data passes through here: log lines carry the action, counts and
 * status codes only — never a name, NIK, account number or amount.
 */
'use strict';

var engine = require('./engine');
var selftest = require('./selftest');

var PROGRAMMES = ['kesehatan', 'jht', 'jp', 'jkk', 'jkm'];

/** A store call was refused: carries the HTTP status and a one-line reason. */
function StoreFail(status, sentence) {
  this.status = status;
  this.sentence = sentence;
}

/**
 * @param {object} body              the request body ({ action, ... })
 * @param {object} deps
 * @param {Function} deps.store      async (op, collection, key, value) => data; throws StoreFail
 * @param {{id:string,name:string}} deps.user  the signed-in user
 * @param {Function} [deps.log]
 * @returns {Promise<{status:number, body:any}>}  body is an object (200) or a sentence (error)
 */
async function handle(body, deps) {
  var log = (deps && deps.log) || function () {};
  var context = { log: log };
  var fail = function (status, sentence) { return { status: status, body: sentence }; };

  if (!body || typeof body.action !== 'string') return fail(400, 'The request names no "action".');

  if (body.action === 'selftest') {
    try { return { status: 200, body: selftest.run() }; }
    catch (e) { return fail(500, 'The self-test could not run.'); }
  }

  var store = deps.store;
  try {
    if (body.action === 'compute') return { status: 200, body: await compute(store, body.run_id, context) };
    if (body.action === 'restart') return { status: 200, body: await restart(store, body.run_id, context) };
    if (body.action === 'review')  return { status: 200, body: await review(store, body.line_id, body.reviewed === true, deps.user) };
    return fail(400, 'The calculation does not know the action "' + String(body.action).slice(0, 40) + '".');
  } catch (e) {
    if (e instanceof StoreFail) {
      log('[calc] ' + body.action + ' store refused ' + e.status);
      return fail(e.status, e.sentence);
    }
    if (e && e.http) return fail(e.http, e.message);
    log('[calc] ' + body.action + ' failed: ' + (e && (e.stack || e.name)));
    return fail(500, 'The calculation failed unexpectedly. Nothing more was saved.');
  }
}

module.exports = { handle: handle, StoreFail: StoreFail };

function stop(http, sentence) { var e = new Error(sentence); e.http = http; return e; }

function num(v) { return v === null || v === undefined || v === '' ? null : Number(v); }

/* ── restart ─────────────────────────────────────────────────────────────
 * A restart is deliberately narrower than a new run: its identity, period and
 * client stay put. It clears the old draft's calculated rows and variable
 * inputs child-first, then compute() rebuilds it from the current employee
 * master. A failed delete leaves a draft that can safely be restarted again.
 */
async function restart(store, runId, context) {
  if (!runId) throw stop(400, 'The request names no run.');
  var run = await store('get', 'app/payroll/runs', runId);
  if (!run) throw stop(404, 'That run does not exist.');
  if (run.status !== 'draft') {
    throw stop(409, 'Only a draft run can be restarted. Review and later runs keep their recorded lines.');
  }

  var lists = await Promise.all([
    store('list', 'app/payroll/run_lines'),
    store('list', 'app/payroll/run_items'),
    store('list', 'app/payroll/run_bpjs')
  ]);
  var lines = lists[0].filter(function (line) { return line.run_id === run.id; });
  var ids = {};
  lines.forEach(function (line) { ids[line.id] = true; });
  var items = lists[1].filter(function (item) { return ids[item.run_line_id]; });
  var bpjs = lists[2].filter(function (row) { return ids[row.run_line_id]; });

  for (var i = 0; i < items.length; i++) await store('del', 'app/payroll/run_items', items[i].id);
  for (var j = 0; j < bpjs.length; j++) await store('del', 'app/payroll/run_bpjs', bpjs[j].id);
  for (var k = 0; k < lines.length; k++) await store('del', 'app/payroll/run_lines', lines[k].id);

  context.log('[calc] restart lines=' + lines.length + ' items=' + items.length + ' bpjs=' + bpjs.length);
  return compute(store, run.id, context);
}

/* This employee's year with this client: every earlier run line of the
   year (its run finished or not — the engine refuses an unfinished one),
   the opening balances, and the rate rows. Personal figures stay here.
   ⚠️ Runs of EVERY type count (a THR run of an earlier month is income of the year). */
function yearFactory(lists, client, run, on) {
  var year = on.slice(0, 4);
  var yearRuns = lists[11].filter(function (r) {
    var p = String(r.period_month).slice(0, 10);
    return r.payroll_client_id === client.id && r.id !== run.id && p.slice(0, 4) === year && p < on;
  });
  return function yearOf(emp) {
    var months = [];
    yearRuns.forEach(function (r) {
      lists[4].filter(function (l) { return l.run_id === r.id && l.payroll_employee_id === emp.id; }).forEach(function (l) {
        var pension = lists[6].filter(function (b) {
          return b.run_line_id === l.id && (b.programme === 'jht' || b.programme === 'jp');
        }).reduce(function (s, b) { return s + (num(b.employee_amount) || 0); }, 0);
        months.push({ period: String(r.period_month).slice(0, 10), final: r.status === 'outputs' || r.status === 'paid',
                      taxable_gross: l.taxable_gross, pension: pension, pph21: l.pph21 });
      });
    });
    var openings = lists[12].filter(function (o) {
      return o.payroll_employee_id === emp.id && String(o.tax_year) === year;
    });
    return { months: months, openings: openings, ptkp: lists[13], brackets: lists[14] };
  };
}

/* ── compute ───────────────────────────────────────────────────────────── */

async function compute(store, runId, context) {
  if (!runId) throw stop(400, 'The request names no run.');
  var run = await store('get', 'app/payroll/runs', runId);
  if (!run) throw stop(404, 'That run does not exist.');
  if (run.status !== 'draft' && run.status !== 'review') {
    throw stop(409, 'This run is ' + run.status + '. Its figures are frozen and cannot be recalculated.');
  }
  var on = String(run.period_month).slice(0, 10);
  var end = engine.lastDay(on);

  var lists = await Promise.all([
    store('list', 'app/payroll/clients'),
    store('list', 'app/payroll/employees', null, { includeInactive: true }),
    store('list', 'app/payroll/components'),
    store('list', 'app/payroll/employee_bpjs'),
    store('list', 'app/payroll/run_lines'),
    store('list', 'app/payroll/run_items'),
    store('list', 'app/payroll/run_bpjs'),
    store('list', 'app/payroll/bpjs_rates'),
    store('list', 'app/payroll/jkk_classes'),
    store('list', 'app/payroll/minimum_wage'),
    store('list', 'app/payroll/ter_rates'),
    /* the year-end PPh 21 (PROTOTYPE 2026-10-23): earlier runs, opening
       balances, PTKP and Pasal 17 — read always, used only in a last period */
    store('list', 'app/payroll/runs'),
    store('list', 'app/payroll/tax_openings'),
    store('list', 'app/payroll/ptkp'),
    store('list', 'app/payroll/pph21_brackets'),
    store('list', 'app/payroll/ter_daily')           // 070: daily-paid workers
  ]);
  var client = lists[0].filter(function (c) { return c.id === run.payroll_client_id; })[0];
  if (!client) throw stop(404, 'That run\'s client has no payroll settings.');
  var rates = { bpjs: lists[7], jkk: lists[8], wage: lists[9], ter: lists[10], ter_daily: lists[15] };

  if (run.run_type === 'bonus') throw stop(409, 'Bonus runs are not built yet.');
  if (run.run_type === 'thr') return computeThr(store, run, lists, client, rates, on, end, context);

  /* Who is on the run: the client's employees employed on any day of the
     month (an inactive employee with no end date is not). Ordinary recompute
     retains existing lines; restart() removes them first to rebuild solely
     from the current employee master. */
  var employees = lists[1].filter(function (e) { return e.payroll_client_id === client.id; });
  var lines = lists[4].filter(function (l) { return l.run_id === run.id; });
  var onRun = employees.filter(function (e) {
    var s = String(e.start_date || '').slice(0, 10), t = e.end_date ? String(e.end_date).slice(0, 10) : null;
    var inMonth = s && s <= end && (!t || t >= on);
    return inMonth && (e.active || t) ||
           lines.some(function (l) { return l.payroll_employee_id === e.id; });
  }).sort(function (a, b) { return String(a.employee_code).localeCompare(String(b.employee_code)); });

  var yearOf = yearFactory(lists, client, run, on);

  /* the month's THR / bonus runs: this run's tax is found on the combined
     month, less what they already withheld */
  var offRuns = lists[11].filter(function (r) {
    return r.payroll_client_id === client.id && String(r.period_month).slice(0, 10) === on &&
           !r.superseded_by_run_id && r.id !== run.id && (r.run_type || 'regular') !== 'regular';
  });
  function offcycleOf(empId) {
    var t = 0, p = 0;
    offRuns.forEach(function (r) {
      lists[4].filter(function (l) { return l.run_id === r.id && l.payroll_employee_id === empId; }).forEach(function (l) {
        t += num(l.taxable_gross) || 0; p += Math.round(num(l.pph21) || 0);
      });
    });
    return { taxable_gross: t, pph21: p };
  }

  var out = [];
  for (var i = 0; i < onRun.length; i++) {
    var emp = onRun[i];
    var line = lines.filter(function (l) { return l.payroll_employee_id === emp.id; })[0] || null;
    var comps = engine.componentsInMonth(lists[2].filter(function (c) { return c.payroll_employee_id === emp.id; }), on, end);
    var enrolRows = lists[3].filter(function (b) { return b.payroll_employee_id === emp.id; });
    var enrolment = {};
    PROGRAMMES.forEach(function (p) {
      var r = enrolRows.filter(function (b) { return b.programme === p; })[0];
      /* No row yet = the statutory default the Employees screen shows. */
      enrolment[p] = r ? { enrolled: !!r.enrolled, by: r.employee_share_paid_by }
                       : { enrolled: true, by: (p === 'jkk' || p === 'jkm') ? 'employer' : 'employee' };
    });
    var items = line ? lists[5].filter(function (it) { return it.run_line_id === line.id; }) : [];

    var result = null, refusal = null;
    try {
      result = engine.calculate({
        period: on, start_date: emp.start_date, end_date: emp.end_date, ptkp: emp.ptkp_status,
        rate_type: emp.rate_type === 'daily' ? 'daily' : 'monthly',
        jkk_rate: client.jkk_rate, floor_region: client.bpjs_floor_region,
        kes_includes_fixed: !!client.kesehatan_base_includes_fixed,
        days_worked: line ? line.days_worked : null,
        days_in_period: line ? line.days_in_period : null,
        /* 071: ticked this month. A new line has none yet: it starts with
           every enrolled programme ticked, the same list it is saved with. */
        bpjs_programmes: line && Array.isArray(line.bpjs_programmes) ? line.bpjs_programmes
                       : PROGRAMMES.filter(function (p) { return enrolment[p].enrolled; }),
        components: comps.map(function (c) { return { name: c.name, amount: c.amount, is_fixed: !!c.is_fixed }; }),
        items: items.map(function (it) { return { label: it.label, amount: it.amount, sign: it.sign }; }),
        enrolment: enrolment, rates: rates, offcycle: offcycleOf(emp.id),
        annual: emp.rate_type !== 'daily' && engine.isFinalPeriod(on, emp.end_date) ? yearOf(emp) : null
      });
    } catch (e) {
      if (!(e instanceof engine.Refusal)) throw e;
      refusal = { code: e.code, sentence: e.message };
    }

    /* The frozen inputs, and the figures — or NULL figures on a refusal, so
       the server's lock (every line needs a net) cannot pass on stale ones. */
    var value = {
      ptkp_status: emp.ptkp_status,
      ter_category: emp.rate_type === 'daily' ? null : (engine.TER_CATEGORY[emp.ptkp_status] || null),   // null = TER harian
      jkk_rate: client.jkk_rate,
      bpjs_wage_floor: result ? result.bpjs_wage_floor : null,
      components: result ? result.components : comps.map(function (c) { return { name: c.name, amount: num(c.amount), is_fixed: !!c.is_fixed }; }),
      gross_pay: result ? result.gross_pay : null,
      taxable_gross: result ? result.taxable_gross : null,
      pph21: result ? result.pph21 : null,
      net_pay: result ? result.net_pay : null,
      days_worked: result ? result.days_worked : (line ? line.days_worked : null),
      days_in_period: result ? result.days_in_period : (line ? line.days_in_period : null),
      /* Extra columns: how PPh 21 was found, and the year-end working */
      pph21_method: result ? result.pph21_method : null,
      pph21_annual: result ? result.annual : null
    };

    if (!line) {
      value.run_id = run.id;
      value.payroll_employee_id = emp.id;
      /* BPJS this month starts TICKED for every enrolled programme (operator,
         2026-10-28; was nothing ticked). Lines that already exist keep theirs. */
      value.bpjs_programmes = PROGRAMMES.filter(function (p) { return enrolment[p].enrolled; });
      line = await store('save', 'app/payroll/run_lines', null, value);
    } else {
      var moved = ['gross_pay', 'taxable_gross', 'pph21', 'net_pay', 'days_worked', 'days_in_period'].some(function (k) {
        return num(line[k]) !== value[k];
      });
      /* A figure that moved needs looking at again: recomputing un-reviews. */
      if (moved && line.reviewed) {
        value.reviewed = false; value.reviewed_at = null;
        value.reviewed_by_oid = null; value.reviewed_by_name = null;
      }
      value.rev = line.rev;
      line = await store('save', 'app/payroll/run_lines', line.id, value);
    }

    /* The five BPJS results, one row per programme. */
    var existing = lists[6].filter(function (b) { return b.run_line_id === line.id; });
    for (var k = 0; k < PROGRAMMES.length; k++) {
      var p = PROGRAMMES[k];
      var ex = existing.filter(function (b) { return b.programme === p; })[0];
      var r = result ? result.bpjs.filter(function (b) { return b.programme === p; })[0] : null;
      var v = r ? { wage_base: r.wage_base, employee_amount: r.employee_amount,
                    employer_amount: r.employer_amount, employee_share_paid_by: r.employee_share_paid_by }
                : { wage_base: null, employee_amount: 0, employer_amount: 0 };
      if (ex) { v.rev = ex.rev; await store('save', 'app/payroll/run_bpjs', ex.id, v); }
      else if (r) { v.run_line_id = line.id; v.programme = p; await store('save', 'app/payroll/run_bpjs', null, v); }
    }

    out.push({ line_id: line.id, employee_id: emp.id, refusal: refusal, result: result,
               reviewed: !!line.reviewed,
               days_worked: value.days_worked, days_in_period: value.days_in_period });
  }

  context.log('[calc] compute lines=' + out.length + ' refused=' +
              out.filter(function (l) { return l.refusal; }).length);
  return { run_id: run.id, period: on, lines: out, totals: totals(out) };
}


/* ── compute · THR run ───────────────────────────────────────────────────────
 * Who is on it: the client's employees who are eligible at the run's PAY DATE
 * (employed that day, at least one whole month of service). The amount comes
 * from the service months and ONE MONTH'S WAGE (engine.thrAmount), is kept on
 * the line as the component "THR", and is rebuilt on every compute, so editing
 * the pay date changes it. A person's own adjustment is an ordinary run item.
 * No BPJS rows are written. PPh 21 is found on top of the month's regular run
 * (engine.calculateThr); the regular run is only read.
 * lists = the same sixteen reads compute() makes. */
async function computeThr(store, run, lists, client, rates, on, end, context) {
  var ref = run.pay_date ? String(run.pay_date).slice(0, 10) : end;
  var employees = lists[1].filter(function (e) { return e.payroll_client_id === client.id; });
  var lines = lists[4].filter(function (l) { return l.run_id === run.id; });

  /* the month's regular run (live) and the month's other off-cycle runs */
  var sameMonth = lists[11].filter(function (r) {
    return r.payroll_client_id === client.id && String(r.period_month).slice(0, 10) === on &&
           !r.superseded_by_run_id && r.id !== run.id;
  });
  var regRun = sameMonth.filter(function (r) { return (r.run_type || 'regular') === 'regular'; })[0] || null;
  var otherRuns = sameMonth.filter(function (r) { return (r.run_type || 'regular') !== 'regular'; });
  var yearOf = yearFactory(lists, client, run, on);

  /* a daily worker's history: monthly fixed pay of finished regular runs, the last 12 months before this one */
  var from = (function () {
    var y = Number(on.slice(0, 4)), m = Number(on.slice(5, 7)) - 12;
    while (m < 1) { m += 12; y--; }
    return y + '-' + String(m).padStart(2, '0') + '-01';
  }());
  var histRuns = lists[11].filter(function (r) {
    var p = String(r.period_month).slice(0, 10);
    return r.payroll_client_id === client.id && (r.run_type || 'regular') === 'regular' && !r.superseded_by_run_id &&
           (r.status === 'outputs' || r.status === 'paid') && p >= from && p < on;
  });
  function history(emp) {
    var h = [];
    histRuns.forEach(function (r) {
      lists[4].filter(function (l) { return l.run_id === r.id && l.payroll_employee_id === emp.id; }).forEach(function (l) {
        h.push((l.components || []).reduce(function (t, c) { return t + (c.is_fixed ? (num(c.amount) || 0) : 0); }, 0));
      });
    });
    return h;
  }

  var onRun = [], excluded = [];
  employees.forEach(function (e) {
    var comps = engine.componentsInMonth(lists[2].filter(function (c) { return c.payroll_employee_id === e.id; }), on, end);
    var has = lines.some(function (l) { return l.payroll_employee_id === e.id; });
    var t = null, err = null;
    try {
      t = engine.thrAmount({ start_date: e.start_date, end_date: e.end_date, ref: ref, rate_type: e.rate_type === 'daily' ? 'daily' : 'monthly',
                             components: comps, history: e.rate_type === 'daily' ? history(e) : null });
    } catch (x) { if (!(x instanceof engine.Refusal)) throw x; err = x; }
    if (has || (t && t.eligible && (e.active || e.end_date))) onRun.push({ emp: e, comps: comps, thr: t, err: err });
    else if (e.active && t && !t.eligible && t.reason === 'under_one_month') excluded.push({ employee_id: e.id, reason: t.reason, months: t.months });
  });
  onRun.sort(function (a, b) { return String(a.emp.employee_code).localeCompare(String(b.emp.employee_code)); });

  var out = [];
  for (var i = 0; i < onRun.length; i++) {
    var emp = onRun[i].emp, t = onRun[i].thr;
    var line = lines.filter(function (l) { return l.payroll_employee_id === emp.id; })[0] || null;
    var items = line ? lists[5].filter(function (it) { return it.run_line_id === line.id; }) : [];

    /* the regular run's line for this person: what the month already holds */
    var regLine = regRun ? lists[4].filter(function (l) { return l.run_id === regRun.id && l.payroll_employee_id === emp.id; })[0] || null : null;
    var regular = regLine ? {
      taxable_gross: regLine.taxable_gross, pph21: regLine.pph21, days_worked: regLine.days_worked,
      pension: lists[6].filter(function (b) { return b.run_line_id === regLine.id && (b.programme === 'jht' || b.programme === 'jp'); })
                 .reduce(function (s, b) { return s + (num(b.employee_amount) || 0); }, 0)
    } : null;
    var othersPph = 0, othersTax = 0;
    otherRuns.forEach(function (r) {
      lists[4].filter(function (l) { return l.run_id === r.id && l.payroll_employee_id === emp.id; }).forEach(function (l) {
        othersPph += Math.round(num(l.pph21) || 0); othersTax += num(l.taxable_gross) || 0;
      });
    });

    var result = null, refusal = null;
    try {
      if (onRun[i].err) throw onRun[i].err;
      if (!t.eligible) {
        throw new engine.Refusal(t.reason === 'under_one_month'
          ? 'Under one whole month of service at the pay date (' + t.months + '), so no THR. Restart the run to rebuild the list.'
          : 'Not employed on the pay date, so no THR. Restart the run to rebuild the list.', 'thr_not_eligible');
      }
      result = engine.calculateThr({
        period: on, start_date: emp.start_date, end_date: emp.end_date, ptkp: emp.ptkp_status,
        rate_type: emp.rate_type === 'daily' ? 'daily' : 'monthly',
        components: t.amount ? [{ name: 'THR', amount: t.amount, is_fixed: true }] : [],
        items: items.map(function (it) { return { label: it.label, amount: it.amount, sign: it.sign }; }),
        regular: regular, others_pph: othersPph, others_taxable: othersTax,
        rates: { ter: rates.ter, ter_daily: rates.ter_daily },
        annual: emp.rate_type !== 'daily' && engine.isFinalPeriod(on, emp.end_date) ? yearOf(emp) : null
      });
      result.thr_basis = { months: t.months, used: t.used, wage: t.wage, amount: t.amount, basis: t.basis, ref: ref };
    } catch (e) {
      if (!(e instanceof engine.Refusal)) throw e;
      refusal = { code: e.code, sentence: e.message };
    }

    var value = {
      ptkp_status: emp.ptkp_status,
      ter_category: emp.rate_type === 'daily' ? null : (engine.TER_CATEGORY[emp.ptkp_status] || null),
      jkk_rate: client.jkk_rate,
      bpjs_wage_floor: null,
      components: result ? result.components : [],
      gross_pay: result ? result.gross_pay : null,
      taxable_gross: result ? result.taxable_gross : null,
      pph21: result ? result.pph21 : null,
      net_pay: result ? result.net_pay : null,
      days_worked: null, days_in_period: null,
      pph21_method: result ? result.pph21_method : null,
      pph21_annual: result ? result.annual : null,
      bpjs_programmes: []
    };
    if (!line) {
      value.run_id = run.id; value.payroll_employee_id = emp.id;
      line = await store('save', 'app/payroll/run_lines', null, value);
    } else {
      var moved = ['gross_pay', 'taxable_gross', 'pph21', 'net_pay'].some(function (k) { return num(line[k]) !== value[k]; });
      if (moved && line.reviewed) {
        value.reviewed = false; value.reviewed_at = null; value.reviewed_by_oid = null; value.reviewed_by_name = null;
      }
      value.rev = line.rev;
      line = await store('save', 'app/payroll/run_lines', line.id, value);
    }
    out.push({ line_id: line.id, employee_id: emp.id, refusal: refusal, result: result, reviewed: !!line.reviewed,
               days_worked: null, days_in_period: null });
  }

  context.log('[calc] compute thr lines=' + out.length + ' refused=' + out.filter(function (l) { return l.refusal; }).length +
              ' excluded=' + excluded.length);
  return { run_id: run.id, period: on, run_type: 'thr', pay_date: ref, lines: out, excluded: excluded, totals: totals(out) };
}

function totals(lines) {
  var t = { lines: lines.length, refused: 0, gross_fixed: 0, variable: 0, gross_pay: 0, employee_bpjs: 0,
            pph21: 0, net_pay: 0, employer_bpjs: 0, bpjs_remit: 0, cost: 0 };
  lines.forEach(function (l) {
    if (!l.result) { t.refused++; return; }
    var r = l.result;
    t.gross_fixed += r.gross_fixed; t.variable += r.variable; t.gross_pay += r.gross_pay;
    t.employee_bpjs += r.employee_bpjs; t.pph21 += r.pph21; t.net_pay += r.net_pay;
    t.employer_bpjs += r.employer_bpjs;
  });
  t.bpjs_remit = t.employer_bpjs + t.employee_bpjs;
  t.cost = t.gross_pay + t.employer_bpjs;
  return t;
}

/* ── review: who reviewed comes from the session, never from the browser ── */

async function review(store, lineId, reviewed, user) {
  if (!lineId) throw stop(400, 'The request names no run line.');
  var line = await store('get', 'app/payroll/run_lines', lineId);
  if (!line) throw stop(404, 'That run line does not exist.');
  if (reviewed && (line.net_pay === null || line.net_pay === undefined)) {
    throw stop(409, 'This line has no net pay calculated, so it cannot be marked reviewed.');
  }
  var me = { oid: user && user.id, name: user && user.name };
  if (reviewed && !me.oid) throw stop(401, 'There is no signed-in reviewer on this request.');
  var value = reviewed
    ? { reviewed: true, reviewed_at: new Date().toISOString(), reviewed_by_oid: me.oid, reviewed_by_name: me.name }
    : { reviewed: false, reviewed_at: null, reviewed_by_oid: null, reviewed_by_name: null };
  value.rev = line.rev;
  var saved = await store('save', 'app/payroll/run_lines', lineId, value);
  return { line_id: saved.id, reviewed: !!saved.reviewed, reviewed_by_name: saved.reviewed_by_name };
}
