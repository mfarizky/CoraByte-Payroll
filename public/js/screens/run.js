/**
 * CoraByte Payroll — Payroll run screen.
 *
 * Steps: 1 Draft (variable pay, days worked) → 2 Review (check every line,
 * mark reviewed) → 3 Outputs (outputs.js) → 4 Paid (frozen).
 * Figures come from the server (/api/calc); this screen never computes pay.
 * A run moves to outputs only when every line is reviewed with a net pay —
 * the server refuses otherwise. Reset/delete is admin-only.
 */
(function () {
  'use strict';

  var S = window.GKI && window.GKI.spine;
  if (!S) { console.error('[gki] run.js: spine missing'); return; }
  var U = S.ui, el = U.el;
  var store = function () { return window.GKI_STORE || window.GKI.store; };

  var BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli',
               'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  var TER = { 'TK/0': 'A', 'TK/1': 'A', 'K/0': 'A', 'TK/2': 'B', 'TK/3': 'B', 'K/1': 'B', 'K/2': 'B', 'K/3': 'C' };

  var period = U.today().slice(0, 8) + '01';     // kept across re-mounts
  var selectedLine = null;
  var runSel = null;                              // the run open on screen; null = the month's history
  var selftestPromise = null;
  var TYPE_LABEL = { regular: 'REGULAR', thr: 'THR', bonus: 'BONUS' };

  function monthName(on) { return BULAN[Number(on.slice(5, 7)) - 1] + ' ' + on.slice(0, 4); }
  function shift(on, by) {
    var y = Number(on.slice(0, 4)), m = Number(on.slice(5, 7)) - 1 + by;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + '-' + String(m + 1).padStart(2, '0') + '-01';
  }
  function dayIn(on, day) {
    if (!day) return null;
    var y = Number(on.slice(0, 4)), m = Number(on.slice(5, 7));
    var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return on.slice(0, 8) + String(Math.min(Number(day), last)).padStart(2, '0');
  }
  function signed(v) { return v > 0 ? '+' + U.money(v) : v < 0 ? '−' + U.money(-v) : '0'; }
  function pct(r) { var x = U.num(r); return x === null ? '?' : String(Math.round(x * 1e6) / 1e4).replace('.', ',') + '%'; }
  function inForce(r, on) { return U.inForce(r, on); }
  function when(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    var f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Makassar', day: '2-digit', month: '2-digit', year: 'numeric',
                                               hour: '2-digit', minute: '2-digit', hour12: false });
    var p = {}; f.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    return p.day + '/' + p.month + '/' + p.year + ' ' + p.hour + ':' + p.minute;
  }

  function selftest() {
    if (!selftestPromise) {
      selftestPromise = store().action('calc', { action: 'selftest' });
      selftestPromise.catch(function () { selftestPromise = null; });
    }
    return selftestPromise;
  }

  /* ── mount: find the run, recompute while it is open, read it back ─────── */
  function mount(pane) {
    /* The dashboard can hand over a run to open: { period: 'YYYY-MM-01', id }. */
    try {
      var hand = JSON.parse(sessionStorage.getItem('cb.openRun') || 'null');
      sessionStorage.removeItem('cb.openRun');
      if (hand && hand.period) { period = hand.period; runSel = hand.id || null; selectedLine = null; }
    } catch (e) { /* storage unavailable: open the current month */ }
    var wrap = el('div');
    pane.appendChild(wrap);
    wrap.appendChild(el('p', 'pr-msg', 'Loading…'));
    S.onClient(function () { selectedLine = null; runSel = null; U.clear(pane); mount(pane); });

    var ctx = {};
    Promise.all([S.clients(), S.client(), store().list('app/payroll/runs')]).then(function (r) {
      ctx.list = r[0]; ctx.client = r[1];
      ctx.runs = ctx.client ? liveRuns(r[2].rows, ctx.client.id, period) : [];
      ctx.run = runSel ? ctx.runs.filter(function (x) { return x.id === runSel; })[0] || null : null;
      if (!ctx.run) runSel = null;
      var open = ctx.run && (ctx.run.status === 'draft' || ctx.run.status === 'review');
      return open ? store().action('calc', { action: 'compute', run_id: ctx.run.id }) : null;
    }).then(function (computed) {
      ctx.computed = computed;
      ctx.refusals = {};
      if (computed) computed.lines.forEach(function (l) { if (l.refusal) ctx.refusals[l.line_id] = l.refusal.sentence; });
      return Promise.all([
        store().list('app/payroll/employees', { includeInactive: true }),
        store().list('app/payroll/run_lines'),
        store().list('app/payroll/run_items'),
        store().list('app/payroll/run_bpjs'),
        store().list('app/payroll/bpjs_rates'),
        store().list('app/payroll/ter_rates'),
        ctx.run ? store().get('app/payroll/runs', ctx.run.id) : Promise.resolve({ row: null }),
        store().list('app/payroll/ter_daily'),       // 070: daily-paid workers
        store().list('app/payroll/employee_bpjs')    // 071: what may be ticked
      ]);
    }).then(function (r) {
      ctx.employees = r[0].rows; ctx.allLines = r[1].rows; ctx.items = r[2].rows;
      ctx.bpjs = r[3].rows; ctx.rates = r[4].rows; ctx.ter = r[5].rows;
      if (r[6].row) ctx.run = r[6].row;
      ctx.terDaily = r[7].rows;
      ctx.enrol = r[8].rows;
      draw(wrap, ctx);
    }).catch(function (err) {
      U.clear(wrap);
      if (ctx.list) wrap.appendChild(topRow(ctx, null));
      wrap.appendChild(el('p', 'pr-msg bad', U.errText(err)));
    });
  }

  /* The month's live runs for this client — one per type, Regular first.
     A run that was superseded by a correction is not shown. */
  var TYPE_ORDER = { regular: 0, thr: 1, bonus: 2 };
  function liveRuns(runs, clientId, on) {
    return runs.filter(function (x) {
      return x.payroll_client_id === clientId && String(x.period_month).slice(0, 10) === on && !x.superseded_by_run_id;
    }).sort(function (a, b) {
      return (TYPE_ORDER[a.run_type || 'regular'] || 0) - (TYPE_ORDER[b.run_type || 'regular'] || 0) ||
             Number(b.sequence) - Number(a.sequence);
    });
  }
  function isThr(run) { return !!run && run.run_type === 'thr'; }

  /* ── one model per line, built from the STORED rows ─────────────────── */
  function models(ctx) {
    var run = ctx.run;
    var emps = {};
    ctx.employees.forEach(function (e) { emps[e.id] = e; });
    return ctx.allLines.filter(function (l) { return l.run_id === run.id; }).map(function (l) {
      var items = ctx.items.filter(function (it) { return it.run_line_id === l.id; });
      var bp = ctx.bpjs.filter(function (b) { return b.run_line_id === l.id; });
      var variable = items.reduce(function (s, it) { return s + (it.sign === '-' ? -1 : 1) * (U.num(it.amount) || 0); }, 0);
      var fixed = (l.components || []).reduce(function (s, c) { return s + (c.is_fixed ? (U.num(c.amount) || 0) : 0); }, 0);
      var eeDed = 0, er = 0, erPaysEe = 0;
      bp.forEach(function (b) {
        er += U.num(b.employer_amount) || 0;
        if (b.employee_share_paid_by === 'employer') erPaysEe += U.num(b.employee_amount) || 0;
        else eeDed += U.num(b.employee_amount) || 0;
      });
      var on = String(run.period_month).slice(0, 10);
      var taxable = U.num(l.taxable_gross);
      /* THR / bonus runs of the month are taxed together with the regular run
: the rate is looked up on the COMBINED taxable
         gross, and the regular run carries what the others did not withhold. */
      var offT = 0, offP = 0;
      if (!isThr(run) && taxable !== null) {
        (ctx.runs || []).forEach(function (o) {
          if (o.id === run.id || (o.run_type || 'regular') === 'regular') return;
          ctx.allLines.filter(function (x) { return x.run_id === o.id && x.payroll_employee_id === l.payroll_employee_id; }).forEach(function (x) {
            offT += U.num(x.taxable_gross) || 0; offP += Math.round(U.num(x.pph21) || 0);
          });
        });
      }
      var taxRate = taxable === null ? null : taxable + offT;
      /* DAILY: api/calc writes ter_category NULL for TER harian. */
      var daily = (emps[l.payroll_employee_id] || {}).rate_type === 'daily' || (l.ter_category == null && l.pph21_method === 'ter');
      var cat = daily ? null : (l.ter_category || TER[l.ptkp_status]);
      var dw = U.num(l.days_worked);
      var ter = taxable === null ? null : daily ? (dw > 0 ? (ctx.terDaily || []).filter(function (t) {
        var avg = Math.floor(taxRate / dw * 100) / 100;
        return t.method === 'ter' && inForce(t, on) && avg >= U.num(t.lower_bound) &&
               (t.upper_bound === null || avg <= U.num(t.upper_bound));
      }).sort(function (a, b) { return String(b.effective_from).localeCompare(String(a.effective_from)); })[0] : null)
      : ctx.ter.filter(function (t) {
        return t.category === cat && inForce(t, on) && taxRate >= U.num(t.lower_bound) &&
               (t.upper_bound === null || taxRate <= U.num(t.upper_bound));
      }).sort(function (a, b) { return String(b.effective_from).localeCompare(String(a.effective_from)); })[0];
      var jht = bp.filter(function (b) { return b.programme === 'jht'; })[0];
      return {
        line: l, emp: emps[l.payroll_employee_id] || { full_name: '?', employee_code: '?' },
        items: items, bpjs: bp,
        refusal: (ctx.refusals || {})[l.id] || (l.net_pay === null ? 'Not calculated.' : null),
        gross_fixed: fixed, variable: variable,
        gross_pay: U.num(l.gross_pay), taxable_gross: taxable, pph21: U.num(l.pph21), net_pay: U.num(l.net_pay),
        employee_bpjs: eeDed, employer_bpjs: er + erPaysEe, ter_category: cat, daily: daily,
        ter_rate: (ter && !l.pph21_annual && !isThr(run)) ? U.num(ter.rate) : null,
        off_taxable: offT, off_pph: offP,
        annual: l.pph21_annual || null,          // year-end working (Pasal 17), PROPOSED column
        tk_base: jht ? U.num(jht.wage_base) : null, floor: U.num(l.bpjs_wage_floor),
        reviewed: !!l.reviewed
      };
    }).sort(function (a, b) { return String(a.emp.employee_code).localeCompare(String(b.emp.employee_code)); });
  }

  function totals(ms) {
    var t = { gross_fixed: 0, variable: 0, gross_pay: 0, employee_bpjs: 0, pph21: 0, net_pay: 0, employer_bpjs: 0 };
    ms.forEach(function (m) {
      if (m.refusal) return;
      t.gross_fixed += m.gross_fixed; t.variable += m.variable; t.gross_pay += m.gross_pay;
      t.employee_bpjs += m.employee_bpjs; t.pph21 += m.pph21; t.net_pay += m.net_pay; t.employer_bpjs += m.employer_bpjs;
    });
    t.remit = t.employer_bpjs + t.employee_bpjs;
    t.cost = t.gross_pay + t.employer_bpjs;
    return t;
  }

  /* ── the header: payroll month on its own row; below it the bar with
     ← Runs (when a run is open) · steps · actions ─────────────────────── */
  function topRow(ctx, status) {
    var head = el('div', 'pr-runhead');
    var top = el('div', 'pr-top run');
    var per = el('div', 'pr-per');
    var prev = el('button', null, '◂'); prev.type = 'button'; prev.title = 'Previous month';
    var next = el('button', null, '▸'); next.type = 'button'; next.title = 'Next month';
    prev.addEventListener('click', function () { period = shift(period, -1); selectedLine = null; runSel = null; remount(); });
    next.addEventListener('click', function () { period = shift(period, 1); selectedLine = null; runSel = null; remount(); });
    per.appendChild(prev);
    var pl = el('div', 'cb-period-label');
    pl.appendChild(el('small', null, 'PAYROLL MONTH'));
    pl.appendChild(el('b', null, monthName(period)));
    per.appendChild(pl);
    per.appendChild(next);
    per.classList.add('cb-period');
    head.appendChild(per);

    /* 066: no lock step. 'locked' is history (a run still in it reads as Outputs);
       PAID is the last step and shows every step done. */
    var stage = { draft: 1, review: 2, locked: 3, outputs: 3, paid: 5 }[status] || 0;
    var steps = el('div', 'pr-steps');
    ['DRAFT', 'REVIEW', 'OUTPUTS', 'PAID'].forEach(function (t, i) {
      if (i) steps.appendChild(el('span', 'pr-ln' + (i < stage ? ' done' : '')));
      var s = el('div', 'pr-stp' + (i + 1 < stage ? ' done' : (i + 1 === stage ? ' on' : '')));
      s.appendChild(el('i', null, i + 1 < stage ? '✓' : String(i + 1)));
      s.appendChild(document.createTextNode(t));
      steps.appendChild(s);
    });
    top.appendChild(steps);                             // period · steps (middle) · buttons
    head.appendChild(top);
    top.__head = head;
    return top;
  }

  /* RESET RUN (admin, 2026-10-29). Only at step 1 (Inputs, a draft run): from
     Review on there is no button — Reopen to Inputs first. Deletes the whole run — lines, items, BPJS and
     activity — as if it had never been made. A run that is paid NOW is refused
     by the server. Only an audit line survives. The
     proxy forwards the delete only for payrolladmin; a member never sees this. */
  function addReset(wrap, msg, ctx) {
    S.isAdmin().then(function (admin) {
      if (!admin) return;
      /* A round icon, top right, just left of the calc self-test chip. */
      var b = el('button', 'pr-rstc' + (wrap.querySelector('.pr-stc') ? '' : ' solo'), '\u21BA');
      b.type = 'button';
      b.title = 'Reset run (admin): delete this run completely, as if it had never been made';
      b.setAttribute('aria-label', 'Reset run');
      wrap.appendChild(b);
      b.addEventListener('click', function () {
        U.confirm({
          icon: '!',
          kicker: 'RESET · ' + monthName(period).toUpperCase(),
          title: 'Reset this run completely?',
          rows: [['Run month', monthName(period)], ['Status', String(ctx.run.status).toUpperCase()]],
          note: 'The run, its lines, variable inputs, BPJS rows, payslip and Mandiri history and its activity log are deleted, as if this month had never been run. This cannot be undone. Only a one-line admin audit entry remains. A run past Inputs has to be reopened first; a paid run cannot be reset.',
          typeToConfirm: monthName(period),
          ok: 'Reset run',
          cancel: 'Cancel'
        }).then(function (ok) {
          if (!ok) return;
          b.disabled = true;
          msg.className = 'pr-msg'; msg.textContent = 'Resetting the run…';
          store().del('app/payroll/runs', ctx.run.id).then(function () { runSel = null; remount(); }, function (err) {
            b.disabled = false; fail(msg)(err);
          });
        });
      });
    });
  }

  function remount() { var pane = S.pane(); U.clear(pane); mount(pane); }

  /* IN-PLACE REFRESH. After a save in step 1 the
     compute has already run (the caller passes its result): reload only
     what a compute changes — the run, its lines, items and BPJS rows — and
     redraw while the old screen stays up. Scroll position, the selected
     employee and the field that had focus are kept, so only figures move.
     Employees and rate tables are not refetched; a compute does not touch
     them. Month, client, Restart and the status buttons still remount. */
  function refresh(wrap, ctx, computed) {
    ctx.computed = computed;
    ctx.refusals = {};
    if (computed) computed.lines.forEach(function (l) { if (l.refusal) ctx.refusals[l.line_id] = l.refusal.sentence; });
    return Promise.all([
      store().list('app/payroll/run_lines'),
      store().list('app/payroll/run_items'),
      store().list('app/payroll/run_bpjs'),
      store().get('app/payroll/runs', ctx.run.id)
    ]).then(function (r) {
      ctx.allLines = r[0].rows; ctx.items = r[1].rows; ctx.bpjs = r[2].rows;
      if (r[3].row) ctx.run = r[3].row;
      var pane = S.pane();
      var sx = window.scrollX, sy = window.scrollY, st = pane ? pane.scrollTop : 0;
      var fa = document.activeElement, fk = fa && fa.getAttribute ? fa.getAttribute('data-k') : null;
      var h = wrap.offsetHeight;
      wrap.style.minHeight = h + 'px';            // no collapse while the content is swapped
      draw(wrap, ctx);
      if (pane) pane.scrollTop = st;
      window.scrollTo(sx, sy);
      if (fk) { var f = wrap.querySelector('[data-k="' + fk + '"]'); if (f) f.focus(); }
      wrap.style.minHeight = '';
    });
  }

  /* Calc self-test: a small corner badge (hover / click opens the card with the figures).
     A failing test is never tucked away: it becomes a red card in the page. */
  function selftestStrip(wrap) {
    wrap.style.position = 'relative';
    var box = el('div', 'pr-stc');
    wrap.appendChild(box);
    var chip = el('button', 'pr-stc-chip', '\u2713');
    chip.type = 'button';
    chip.title = 'Calc self-test …';
    chip.setAttribute('aria-label', 'Calc self-test');
    box.appendChild(chip);
    chip.addEventListener('click', function () { box.classList.toggle('open'); });
    selftest().then(function (r) {
      var f = r.figures || {}, cs = r.checks || [];
      var pass = cs.filter(function (c) { return c.ok; }).length;
      if (!r.ok) {
        box.parentNode.removeChild(box);
        var rs = wrap.querySelector('.pr-rstc'); if (rs) rs.classList.add('solo');
        var bad = el('div', 'pr-card pr-selftest-card bad');
        var h = el('div', 'pr-st-head');
        h.appendChild(el('span', 'pr-bad', 'CALC SELF-TEST \u2717'));
        h.appendChild(el('span', 'pr-st-t', pass + '/' + cs.length + ' checks passed \u2014 do not trust this run until it is fixed'));
        bad.appendChild(h);
        cs.filter(function (c) { return !c.ok; }).forEach(function (c) {
          bad.appendChild(el('div', 'pr-warncard', c.label + ': got ' + c.got + ', expected ' + c.want));
        });
        wrap.insertBefore(bad, wrap.children[1] || null);
        return;
      }
      chip.title = 'Calc self-test passed ' + pass + '/' + cs.length;
      var pop = el('div', 'pr-card pr-stc-pop');
      var head = el('div', 'pr-st-head');
      head.appendChild(el('span', 'pr-ok', 'CALC SELF-TEST \u2713'));
      head.appendChild(el('span', 'pr-st-t', 'Fictional case run through the calculation \u2014 proves the engine still gives the known figures'));
      pop.appendChild(head);
      var g = el('div', 'pr-st-grid');
      [['GROSS PAY', U.money(f.gross_pay)], ['TAXABLE GROSS', U.money(f.taxable_gross)], ['NET PAY', U.money(f.net_pay)],
       ['EMPLOYER BPJS', U.money(f.employer_bpjs)], ['CHECKS', pass + '/' + cs.length]].forEach(function (x) {
        var d = el('div', 'pr-st-i');
        d.appendChild(el('i', null, x[0]));
        d.appendChild(el('b', null, x[1]));
        g.appendChild(d);
      });
      pop.appendChild(g);
      box.appendChild(pop);
    }).catch(function (err) {
      box.parentNode.removeChild(box);
      var bad = el('div', 'pr-card pr-selftest-card bad');
      bad.appendChild(el('div', 'pr-warncard', 'CALC SELF-TEST could not run \u2014 ' + U.errText(err)));
      wrap.insertBefore(bad, wrap.children[1] || null);
    });
  }

  /* ── draw ──────────────────────────────────────────────────────────── */
  function draw(wrap, ctx) {
    U.clear(wrap);
    if (!ctx.client) {
      wrap.appendChild(el('p', 'pr-msg', 'The organization is not set up yet. Open Settings first.'));
      return;
    }
    var status = ctx.run ? ctx.run.status : null;
    var top = topRow(ctx, status);
    wrap.appendChild(top.__head);
    var msg = el('p', 'pr-msg', '');
    wrap.appendChild(msg);
    selftestStrip(wrap);

    if (!ctx.run) return drawHistory(wrap, top, msg, ctx);
    /* back to the month's runs, at the left of the bar */
    var hist = el('button', 'pr-sec cb-back', '\u2190 Back to Runs'); hist.type = 'button'; hist.title = 'The month\'s runs';
    hist.addEventListener('click', function () { runSel = null; selectedLine = null; remount(); });
    top.insertBefore(hist, top.firstChild);
    if (status === 'draft') addReset(wrap, msg, ctx);      /* Inputs only */
    var ms = models(ctx);
    if (!ms.some(function (m) { return m.line.id === selectedLine; })) selectedLine = ms.length ? ms[0].line.id : null;
    if (status === 'draft') return drawInputs(wrap, top, msg, ctx, ms);
    if (status === 'review') return drawReview(wrap, top, msg, ctx, ms);
    return drawLocked(wrap, top, msg, ctx, ms);
  }

  function fail(msg, btn) {
    return function (err) {
      msg.className = 'pr-msg bad';
      msg.textContent = U.errText(err);
      if (btn) btn.disabled = false;
    };
  }

  /* THE MONTH'S RUNS. Opens before any run is: a row per
     run with its type, its step and its pay date; a row opens that run. Start
     run offers the types — one live run of each per month (enforced by the server). */
  var STEP_LABEL = { draft: 'DRAFT', review: 'REVIEW', locked: 'OUTPUTS', outputs: 'OUTPUTS', paid: 'PAID' };

  function startMenu(ctx, btn, msg) {
    var has = {};
    ctx.runs.forEach(function (r) { has[r.run_type || 'regular'] = r; });
    var pop = el('div', 'pr-startmenu');
    pop.setAttribute('role', 'menu');
    [{ t: 'regular', name: 'Regular', sub: 'The monthly payroll' },
     { t: 'thr', name: 'THR', sub: 'Religious holiday allowance · its own pay date' },
     { t: 'bonus', name: 'Bonus', sub: 'Not built yet' }].forEach(function (o) {
      var why = has[o.t] ? 'Already started this month'
              : o.t === 'bonus' ? 'Not built yet'
              : '';
      var b = el('button', 'pr-sm-i'); b.type = 'button'; b.disabled = !!why;
      b.appendChild(el('b', null, o.name));
      b.appendChild(el('small', null, why || o.sub));
      b.addEventListener('click', function () {
        pop.parentNode && pop.parentNode.removeChild(pop);
        btn.disabled = true;
        msg.className = 'pr-msg'; msg.textContent = 'Starting the ' + o.name + ' run…';
        var s = ctx.client.settings;
        var pay = o.t === 'thr' && has.regular && has.regular.pay_date ? String(has.regular.pay_date).slice(0, 10)
                                                                        : dayIn(shift(period, 1), s.pay_day);
        store().save('app/payroll/runs', null, {
          payroll_client_id: ctx.client.id, period_month: period, run_type: o.t, status: 'draft',
          pay_date: pay, cutoff_date: o.t === 'regular' ? dayIn(period, s.cutoff_day) : null
        }).then(function (row) { runSel = row && row.id ? row.id : null; remount(); }, fail(msg, btn));
      });
      pop.appendChild(b);
    });
    return pop;
  }

  function drawHistory(wrap, top, msg, ctx) {
    var b = el('button', 'pr-btn go', 'Start run'); b.type = 'button';
    top.appendChild(b);
    var pop = null;
    function close() { if (pop && pop.parentNode) pop.parentNode.removeChild(pop); pop = null; document.removeEventListener('mousedown', away, true); }
    function away(e) { if (pop && !pop.contains(e.target) && e.target !== b) close(); }
    b.addEventListener('click', function () {
      if (pop) return close();
      pop = startMenu(ctx, b, msg);
      top.appendChild(pop);
      document.addEventListener('mousedown', away, true);
    });

    var card = el('div', 'pr-card');
    var h = el('h4'); h.appendChild(el('span', null, 'RUNS · ' + monthName(period).toUpperCase()));
    h.appendChild(el('span', null, ctx.runs.length ? ctx.runs.length + (ctx.runs.length === 1 ? ' RUN' : ' RUNS') : ''));
    card.appendChild(h);
    if (!ctx.runs.length) {
      card.appendChild(el('p', 'pr-msg', 'There is no payroll run for ' + ctx.client.name + ' in ' + monthName(period) +
        ' yet. Start one: Regular is the monthly payroll — every employee employed in the month is added and calculated.'));
    }
    ctx.runs.forEach(function (r) {
      var type = r.run_type || 'regular';
      var n = ctx.allLines ? ctx.allLines.filter(function (l) { return l.run_id === r.id; }).length : 0;
      var row = el('button', 'pr-rrow'); row.type = 'button';
      row.appendChild(el('span', 'pr-rtype ' + type, TYPE_LABEL[type] || String(type).toUpperCase()));
      var mid = el('span', 'pr-rmid');
      mid.appendChild(el('b', null, STEP_LABEL[r.status] || String(r.status).toUpperCase()));
      mid.appendChild(el('small', null, (r.pay_date ? 'pay date ' + U.dmy(r.pay_date) : 'no pay date') + ' · ' + n + (n === 1 ? ' employee' : ' employees')));
      row.appendChild(mid);
      row.appendChild(el('span', 'pr-ropen', 'Open →'));
      row.addEventListener('click', function () { runSel = r.id; selectedLine = null; remount(); });
      card.appendChild(row);
    });
    wrap.appendChild(card);
  }

  /* PAY DATE: the day the money is paid — it is B1 of the
     Mandiri file. Edited here, only while the run is a draft (the inputs step);
     shown as DD/MM/YYYY, held as a real date, with a native type=date picker
     behind the calendar button. */
  function isoOfDmy(t) {
    var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(t || '').trim());
    if (!m) return null;
    var d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
    if (d.getUTCFullYear() !== +m[3] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[1]) return null;
    return m[3] + '-' + m[2] + '-' + m[1];
  }
  function payDateField(r) {
    var box = el('span', 'pr-hdate');
    box.appendChild(el('label', null, 'PAY DATE'));
    var i = el('input', 'pr-mono');
    i.type = 'text'; i.inputMode = 'numeric'; i.maxLength = 10; i.autocomplete = 'off'; i.placeholder = 'DD/MM/YYYY';
    i.value = r.pay_date ? U.dmy(r.pay_date) : '';
    var pk = document.createElement('input');
    pk.type = 'date'; pk.tabIndex = -1; pk.className = 'pr-datepick';
    pk.value = r.pay_date ? String(r.pay_date).slice(0, 10) : '';
    var bt = el('button', 'pr-datebtn', '\u25A6'); bt.type = 'button'; bt.title = 'Pick a date';
    var note = el('small', 'pr-hnote', '');
    function commit(iso) {
      if (!iso) { i.classList.add('pr-invalid'); note.textContent = 'DD/MM/YYYY, e.g. 01/11/2026.'; return; }
      i.classList.remove('pr-invalid'); note.textContent = '';
      i.value = U.dmy(iso); pk.value = iso;
      if (iso === String(r.pay_date || '').slice(0, 10)) return;
      i.disabled = true; note.textContent = 'Saving…';
      store().save('app/payroll/runs', r.id, { pay_date: iso, rev: r.rev }).then(function (row) {
        r.pay_date = iso;
        if (row && row.rev !== undefined && row.rev !== null) { r.rev = row.rev; i.disabled = false; note.textContent = 'Saved'; }
        else remount();                       /* no new rev came back: reload rather than risk a stale one */
      }, function (err) { i.disabled = false; i.classList.add('pr-invalid'); note.textContent = U.errText(err); });
    }
    i.addEventListener('input', function () {
      var d = i.value.replace(/\D/g, '').slice(0, 8);
      i.value = d.length > 4 ? d.slice(0, 2) + '/' + d.slice(2, 4) + '/' + d.slice(4)
              : d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d;
    });
    i.addEventListener('change', function () { commit(isoOfDmy(i.value)); });
    pk.addEventListener('change', function () { if (pk.value) commit(pk.value); });
    bt.addEventListener('click', function () {
      if (pk.showPicker) { try { pk.showPicker(); return; } catch (e) { /* fall through */ } }
      pk.focus(); pk.click();
    });
    box.appendChild(i); box.appendChild(bt); box.appendChild(pk); box.appendChild(note);
    return box;
  }

  /* The run table (render: run). editable = draft. */
  function runTable(ctx, ms, editable, onPick) {
    var card = el('div', 'pr-card');
    var h = el('h4');
    var thr = isThr(ctx.run);
    h.appendChild(el('span', null, (thr ? 'THR RUN' : 'RUN') + ' · ' + monthName(period).toUpperCase() + ' · ' + ms.length + ' EMPLOYEES'));
    var r = ctx.run;
    var hr = el('span', 'pr-hdates');
    if (r.cutoff_date) hr.appendChild(el('span', null, 'cut-off ' + U.dmy(r.cutoff_date)));
    if (editable && r.status === 'draft') hr.appendChild(payDateField(r)); /* inputs step only */
    else if (r.pay_date) hr.appendChild(el('span', null, 'pay date ' + U.dmy(r.pay_date)));
    h.appendChild(hr);
    card.appendChild(h);
    var t = el('table', 'pr-tbl');
    var thead = el('thead'), tr = el('tr');
    (thr ? ['EMPLOYEE', 'THR', 'ADJUSTMENT', 'GROSS PAY', 'PPh 21', 'NET PAY']
         : ['EMPLOYEE', 'GROSS FIXED', 'VARIABLE', 'GROSS PAY', 'BPJS EMP.', 'PPh 21', 'NET PAY']).forEach(function (x) { tr.appendChild(el('th', null, x)); });
    thead.appendChild(tr); t.appendChild(thead);
    var tb = el('tbody');
    ms.forEach(function (m) {
      var row = el('tr', m.line.id === selectedLine ? 'on' : '');
      var td = el('td'), nm = el('div', 'pr-nm');
      nm.appendChild(el('span', 'pr-av', U.initials(m.emp.full_name)));
      var w = el('div'); w.appendChild(el('b', null, m.emp.full_name));
      var svc = '';
      if (thr && ctx.computed) {
        var cl = ctx.computed.lines.filter(function (x) { return x.line_id === m.line.id; })[0];
        var basis = cl && cl.result && cl.result.thr_basis;
        if (basis) svc = ' · ' + basis.months + (basis.months === 1 ? ' month' : ' months') + (basis.months > 12 ? '' : ' of service');
      }
      w.appendChild(el('span', null, m.emp.employee_code + svc));
      nm.appendChild(w); td.appendChild(nm); row.appendChild(td);
      if (m.refusal) {
        var rf = el('td', 'refused');
        rf.appendChild(el('div', 'pr-warncard', m.refusal));
        rf.colSpan = thr ? 5 : 6;
        row.appendChild(rf);
      } else {
        row.appendChild(el('td', null, U.money(m.gross_fixed)));
        row.appendChild(el('td', m.variable > 0 ? 'pr-pos' : m.variable < 0 ? 'pr-neg' : 'pr-mut', signed(m.variable)));
        row.appendChild(el('td', null, U.money(m.gross_pay)));
        if (!thr) row.appendChild(el('td', m.employee_bpjs ? 'pr-neg' : 'pr-mut', m.employee_bpjs ? '−' + U.money(m.employee_bpjs) : '0'));
        row.appendChild(el('td', m.pph21 ? null : 'pr-mut', U.money(m.pph21)));
        row.appendChild(el('td', 'net', U.money(m.net_pay)));
      }
      row.addEventListener('click', function () { selectedLine = m.line.id; onPick(); });
      tb.appendChild(row);
    });
    t.appendChild(tb);
    var T = totals(ms);
    var tf = el('tfoot'), fr = el('tr');
    fr.appendChild(el('td', null, 'Total'));
    fr.appendChild(el('td', null, U.money(T.gross_fixed)));
    fr.appendChild(el('td', null, signed(T.variable)));
    fr.appendChild(el('td', null, U.money(T.gross_pay)));
    if (!thr) fr.appendChild(el('td', T.employee_bpjs ? 'pr-neg' : 'pr-mut', T.employee_bpjs ? '−' + U.money(T.employee_bpjs) : '0'));
    fr.appendChild(el('td', T.pph21 ? null : 'pr-mut', U.money(T.pph21)));
    fr.appendChild(el('td', 'net', U.money(T.net_pay)));
    tf.appendChild(fr); t.appendChild(tf);
    card.appendChild(t);
    card.appendChild(el('div', 'pr-note', thr
      ? 'THR · whole months of service up to the pay date ÷ 12 × one month\'s wage (Gaji Pokok + fixed allowances), 12 months or more = one month · ' +
        'no BPJS · PPh 21 = TER on the THR alone until the regular run exists; the regular run then adds the THR to the month\'s tax and carries the difference · figures computed by api/calc'
      : 'PPh 21 · TER monthly · December or a leaver\'s last month = Pasal 17 on the year (prototype) · ' +
      'Every employer BPJS contribution, and any employee share it pays, is added to taxable gross · figures computed by api/calc'));
    return card;
  }

  function totalsCard(T, full, thrView) {
    var c = el('div', 'pr-card pr-mt');
    var h = el('h4'); h.appendChild(el('span', null, 'RUN TOTALS')); h.appendChild(el('span', null, 'IDR'));
    c.appendChild(h);
    function kv(label, v, big) {
      var d = el('div', 'pr-kv' + (big ? ' big' : ''));
      d.appendChild(el('span', null, label)); d.appendChild(el('b', null, U.money(v)));
      c.appendChild(d);
    }
    kv('Transfer to employees · Mandiri', T.net_pay);
    if (!thrView) {
      kv('Employer BPJS cost', T.employer_bpjs);
      if (full) { kv('BPJS to remit (emp. + employer)', T.remit); kv('PPh 21 to remit', T.pph21); }
    } else if (full) kv('PPh 21 to remit', T.pph21);
    kv('Total cost to client', T.cost, true);
    return c;
  }

  /* THR run: the amount, then the tax, line by line — every figure is api/calc's
     (the compute that was just made), nothing is computed here. */
  function breakdownThr(card, ctx, m) {
    var cl = ctx.computed ? ctx.computed.lines.filter(function (x) { return x.line_id === m.line.id; })[0] : null;
    var r = cl && cl.result;
    function kv(label, small, v, big) {
      var d = el('div', 'pr-kv' + (big ? ' big' : ''));
      d.appendChild(el('span', null, label));
      if (small) d.appendChild(el('small', null, small));
      d.appendChild(el('b', null, v));
      card.appendChild(d);
    }
    function sub(label, v, detail) {
      var d = el('div', 'pr-kv pr-kvsub');
      var sp = el('span', null, label);
      if (detail) sp.appendChild(el('small', null, detail));
      d.appendChild(sp); d.appendChild(el('b', null, v));
      card.appendChild(d);
    }
    function neg(v) { return v ? '−' + U.money(v) : '0'; }
    if (!r) { card.appendChild(el('div', 'pr-mut', 'The working is shown while the run is a draft or in review.')); return; }
    var tb = r.thr_basis;
    kv('THR', null, U.money(r.gross_fixed));
    if (tb && tb.amount !== null && tb.amount !== undefined) {
      sub('Service up to ' + U.dmy(tb.ref), tb.months + (tb.months === 1 ? ' month' : ' months'),
          tb.months > 12 ? 'counted as 12' : 'whole months');
      sub(tb.basis === 'daily' ? 'One month\'s wage · average of finished runs' : 'One month\'s wage', U.money(tb.wage),
          tb.basis === 'daily' ? 'daily worker' : 'Gaji Pokok + fixed allowances');
      sub('THR', U.money(tb.amount), tb.used + ' ÷ 12 × ' + U.money(tb.wage));
    } else if (tb) {
      sub('No finished regular run to average', '—', 'daily worker · add the THR as an item');
    }
    if (r.variable) sub('Adjustments (items)', signed(r.variable));
    kv('Gross pay', null, U.money(r.gross_pay));

    kv('PPh 21 on this run', null, U.money(r.pph21));
    if (r.has_regular) sub('Regular taxable gross', U.money(r.regular_taxable));
    sub(r.has_regular ? '+ THR' : 'THR · taxed on its own for now', U.money(r.gross_pay));
    if (r.has_regular) sub('Combined taxable gross', U.money(r.combined_taxable));
    if (r.annual) sub('Month\'s PPh 21 · Pasal 17, year-end', U.money(r.total_pph), 'PKP ' + U.money(r.annual.pkp));
    else if (r.rate_type === 'daily') sub('Month\'s PPh 21 · TER harian' + (r.ter_rate !== null ? ' ' + pct(r.ter_rate / 1e6) : ''), U.money(r.total_pph));
    else sub('Month\'s PPh 21 · TER ' + r.ter_category + (r.ter_rate !== null ? ' ' + pct(r.ter_rate / 1e6) : ''), U.money(r.total_pph));
    if (r.has_regular || r.regular_pph + r.others_pph) sub('Less: already in the month\'s other runs', neg(r.regular_pph + r.others_pph));
    kv('Net pay', null, U.money(r.net_pay), true);
    card.appendChild(el('div', 'pr-mini', 'NO BPJS ON A THR RUN'));
    if (!r.has_regular) card.appendChild(el('div', 'pr-mini pr-note', 'THE REGULAR RUN ADDS THIS THR TO THE MONTH\'S TAX WHEN IT IS CALCULATED'));
  }

  /* The breakdown to net pay, for the selected line (render: run, right). */
  function breakdown(card, ctx, m) {
    card.appendChild(el('div', 'pr-mini', 'BREAKDOWN'));
    if (m.refusal) { card.appendChild(el('div', 'pr-refusal', m.refusal)); return; }
    if (isThr(ctx.run)) return breakdownThr(card, ctx, m);
    var on = String(ctx.run.period_month).slice(0, 10);
    function rateOf(p, side) {
      return ctx.rates.filter(function (r) { return r.programme === p && r.side === side && inForce(r, on); })
        .sort(function (a, b) { return String(b.effective_from).localeCompare(String(a.effective_from)); })[0];
    }
    /* BPJS, LINE BY LINE — the same shape as the
       year-end Pasal 17 working: each total, then its parts underneath, one
       programme per line with its rate and base. Every amount is api/calc's
       run_bpjs row; nothing is computed here, and the parts add up to the
       total above them. */
    var NAME = { kesehatan: 'Kesehatan', jht: 'JHT', jp: 'JP', jkk: 'JKK', jkm: 'JKM' };
    var ORDER = ['kesehatan', 'jht', 'jp', 'jkk', 'jkm'];
    var by = {};
    m.bpjs.forEach(function (b) { by[b.programme] = b; });
    function amt(p, k) { return by[p] ? (U.num(by[p][k]) || 0) : 0; }
    function paidByEr(p) { return by[p] && by[p].employee_share_paid_by === 'employer'; }
    function rLabel(p, side) {
      if (p === 'jkk') return side === 'employer' && m.line.jkk_rate != null ? pct(m.line.jkk_rate) : '';
      var r = rateOf(p, side); return r ? pct(r.rate) : '';
    }
    function of(p) { return by[p] && by[p].wage_base != null ? ' × ' + U.money(by[p].wage_base) : ''; }
    function calc(p, side) { return (rLabel(p, side) + of(p)).trim(); }
    function kv(label, small, v, big) {
      var d = el('div', 'pr-kv' + (big ? ' big' : ''));
      d.appendChild(el('span', null, label));
      if (small) d.appendChild(el('small', null, small));
      d.appendChild(el('b', null, v));
      card.appendChild(d);
    }
    /* label on the left, its working (rate × base) on a small second line,
       the amount on the right — nothing wider than the 380px side card */
    function sub(label, v, detail) {
      var d = el('div', 'pr-kv pr-kvsub');
      var sp = el('span', null, label);
      if (detail) sp.appendChild(el('small', null, detail));
      d.appendChild(sp); d.appendChild(el('b', null, v));
      card.appendChild(d);
    }
    function neg(v) { return v ? '−' + U.money(v) : '0'; }
    function pos(v) { return '+' + U.money(v); }

    kv('Gross pay', null, U.money(m.gross_pay));

    /* taxable: EVERY employer contribution (Kes, JHT, JP, JKK, JKM — JHT and
       JP by operator ruling 2026-10-28), and any employee share the employer pays */
    kv('Taxable gross', null, U.money(m.taxable_gross));
    ORDER.forEach(function (p) {
      var er = amt(p, 'employer_amount'), ee = amt(p, 'employee_amount');
      if (er) {
        sub('+ ' + NAME[p] + ' · employer', pos(er), calc(p, 'employer'));
      }
      if (p !== 'jkk' && p !== 'jkm' && ee && paidByEr(p)) {
        sub('+ ' + NAME[p] + ' · employee, paid by employer', pos(ee), calc(p, 'employee'));
      }
    });

    if (m.annual) yearEnd(m);
    else if (m.daily) {
      kv('PPh 21 · TER harian' + (m.ter_rate !== null ? ' ' + pct(m.ter_rate) : ''), null, U.money(m.pph21));
      if (m.line.days_worked) sub('Average a day', U.money(Math.floor(m.taxable_gross / m.line.days_worked)),
                                  U.money(m.taxable_gross) + ' ÷ ' + m.line.days_worked + ' days');
    }
    else kv('PPh 21 · TER ' + m.ter_category + (m.ter_rate !== null ? ' ' + pct(m.ter_rate) : ''), null, U.money(m.pph21));
    if (m.off_taxable && !m.annual) {
      sub('Taxable gross + THR / bonus runs of the month', U.money(m.taxable_gross + m.off_taxable));
      sub('Month\'s PPh 21 on the combined', U.money(m.pph21 + m.off_pph));
      sub('Less: withheld in the THR / bonus run', neg(m.off_pph));
    }

    /* deducted from pay: the employee shares the employee pays */
    kv('BPJS employee share', null, neg(m.employee_bpjs));
    ORDER.forEach(function (p) {
      var ee = amt(p, 'employee_amount');
      if (p !== 'jkk' && p !== 'jkm' && ee && !paidByEr(p)) sub(NAME[p], neg(ee), calc(p, 'employee'));
    });

    kv('Net pay', null, U.money(m.net_pay), true);

    /* the client's cost, not deducted from pay */
    card.appendChild(el('div', 'pr-mini', 'EMPLOYER BPJS · NOT DEDUCTED'));
    kv('Employer BPJS', null, U.money(m.employer_bpjs));
    var off = [];
    ORDER.forEach(function (p) {
      var er = amt(p, 'employer_amount'), ee = amt(p, 'employee_amount');
      if (!er && !ee) { off.push(NAME[p]); return; }
      if (er) sub(NAME[p], U.money(er), calc(p, 'employer'));
      if (ee && paidByEr(p) && p !== 'jkk' && p !== 'jkm') sub(NAME[p] + ' · employee share', U.money(ee), calc(p, 'employee'));
    });
    if (off.length) sub('Not counted this month · ' + off.join(', '), '—');

    /* Year-end PPh 21 (PROTOTYPE 2026-10-23): the working, line by line. */
    function yearEnd(m) {
      var A = m.annual;
      var mo = BULAN[A.month_from - 1].slice(0, 3) + '–' + BULAN[A.month_to - 1].slice(0, 3);
      kv('PPh 21 · Pasal 17, year-end', A.pph21 < 0 ? 'over-withheld — returned with this pay' : null,
         A.pph21 < 0 ? '+' + U.money(-A.pph21) : U.money(A.pph21));
      sub('Gross · ' + mo + ' (' + A.months + ' mo.)', U.money(A.gross));
      sub('Biaya jabatan 5%, max 500.000 / mo.', neg(A.occupational_cost));
      if (A.pension) sub('Employee JHT + JP', neg(A.pension));
      if (A.previous_neto) sub('Neto, previous employer (A1)', '+' + U.money(A.previous_neto));
      sub('PTKP ' + (m.line.ptkp_status || ''), neg(A.ptkp));
      sub('PKP (down to 1.000)', U.money(A.pkp));
      sub('Tax for the year · Pasal 17', U.money(A.tax_year));
      sub('Already withheld this year', neg(A.withheld));
    }
  }

  /* ── step 1 · INPUTS ───────────────────────────────────────────────── */
  function drawInputs(wrap, top, msg, ctx, ms) {
    var go = el('button', 'pr-btn go', 'Review run');
    var restart = el('button', 'pr-sec', 'Restart run');
    var excl = ctx.computed && ctx.computed.excluded ? ctx.computed.excluded : [];
    top.appendChild(restart);
    top.appendChild(go);
    var refused = ms.filter(function (m) { return m.refusal; });
    if (!ms.length) {
      go.disabled = true;
      msg.textContent = isThr(ctx.run) ? 'No employee is eligible for THR at the pay date (one whole month of service is needed).'
                                       : 'No employee is employed in ' + monthName(period) + '.';
    }
    else if (refused.length) {
      go.disabled = true; msg.className = 'pr-msg bad';
      msg.textContent = refused.length + ' of ' + ms.length + ' lines are refused — the reason is in the table. Fix the input, and the line is recalculated.';
    }
    go.addEventListener('click', function () {
      go.disabled = true;
      store().save('app/payroll/runs', ctx.run.id, { status: 'review', rev: ctx.run.rev }).then(remount, fail(msg, go));
    });
    restart.addEventListener('click', function () {
      U.confirm({
        icon: '↻',
        kicker: 'RESTART · ' + monthName(period).toUpperCase(),
        title: 'Restart this draft run?',
        rows: [['Employee lines cleared', String(ms.length)], ['Run month', monthName(period)]],
        note: isThr(ctx.run)
          ? 'This clears the lines and variable inputs, then rebuilds the THR run from the employees eligible at the pay date. The pay date and the month stay the same.'
          : 'This also clears the line BPJS calculations and variable inputs, then rebuilds the draft from the current employee master. The client and month stay the same.',
        ok: 'Restart run',
        cancel: 'Cancel'
      }).then(function (ok) {
        if (!ok) return;
        restart.disabled = true; go.disabled = true;
        msg.className = 'pr-msg'; msg.textContent = 'Restarting the draft run…';
        return store().action('calc', { action: 'restart', run_id: ctx.run.id }).then(remount, function (err) {
          restart.disabled = false; go.disabled = false; fail(msg)(err);
        });
      });
    });

    if (excl.length && !refused.length && ms.length) {
      msg.className = 'pr-msg';
      msg.textContent = excl.length + (excl.length === 1 ? ' employee is' : ' employees are') + ' not on this run: under one whole month of service at the pay date.';
    }
    var lay = el('div', 'pr-lay2');
    wrap.appendChild(lay);
    var left = el('div');
    left.appendChild(runTable(ctx, ms, true, function () { draw(wrap, ctx); }));
    left.appendChild(totalsCard(totals(ms), true, isThr(ctx.run)));
    lay.appendChild(left);

    var side = el('div', 'pr-side');
    lay.appendChild(side);
    var m = ms.filter(function (x) { return x.line.id === selectedLine; })[0];
    if (!m) return;
    var card = el('div', 'pr-card');
    var h = el('h4'); h.appendChild(el('span', null, 'VARIABLE · ' + String(m.emp.full_name).toUpperCase()));
    h.appendChild(el('span', null, 'this month'));
    card.appendChild(h);

    var busy = false;
    function recompute(p) {
      if (busy) return;
      busy = true;
      msg.className = 'pr-msg'; msg.textContent = 'Recalculating…';
      p.then(function (c) { return refresh(wrap, ctx, c); }).catch(function (err) { busy = false; fail(msg)(err); });
    }

    m.items.forEach(function (it) {
      var r = el('div', 'pr-vi');
      var lab = el('input'); lab.value = it.label; lab.setAttribute('aria-label', 'Item'); lab.setAttribute('data-k', 'lab-' + it.id);
      var sg = el('button', 'sg', it.sign === '-' ? '−' : '+'); sg.type = 'button'; sg.setAttribute('data-k', 'sg-' + it.id);
      sg.title = it.sign === '-' ? 'Deducts — press to make it add' : 'Adds — press to make it deduct';
      var a = U.liveMoney(el('input', 'amt')); a.value = U.money(it.amount); a.setAttribute('aria-label', 'Amount'); a.setAttribute('data-k', 'amt-' + it.id);
      var x = el('button', 'x', '×'); x.type = 'button'; x.title = 'Remove this item';
      function save(v) {
        v.rev = it.rev;
        recompute(store().save('app/payroll/run_items', it.id, v).then(function () {
          return store().action('calc', { action: 'compute', run_id: ctx.run.id });
        }));
      }
      lab.addEventListener('change', function () { if (lab.value.trim()) save({ label: lab.value.trim() }); });
      sg.addEventListener('click', function () { save({ sign: it.sign === '-' ? '+' : '-' }); });
      a.addEventListener('change', function () {
        var v = U.parseMoney(a.value);
        if (v === null || isNaN(v)) { a.value = U.money(it.amount); return; }
        save({ amount: v });
      });
      x.addEventListener('click', function () {
        recompute(store().del('app/payroll/run_items', it.id).then(function () {
          return store().action('calc', { action: 'compute', run_id: ctx.run.id });
        }));
      });
      r.appendChild(lab); r.appendChild(sg); r.appendChild(a); r.appendChild(x);
      card.appendChild(r);
    });
    var add = el('button', 'pr-addv', '+ Add item');
    add.type = 'button';
    /* A new item is drafted in place and saved once it has a name and an
       amount; the sign button says whether it adds or deducts. */
    add.addEventListener('click', function () {
      var r = el('div', 'pr-vi');
      var lab = el('input'); lab.placeholder = 'Lembur, Unpaid leave…'; lab.setAttribute('aria-label', 'Item');
      var sign = '+';
      var sg = el('button', 'sg', '+'); sg.type = 'button'; sg.title = 'Adds — press to make it deduct';
      var a = U.liveMoney(el('input', 'amt')); a.placeholder = '0'; a.setAttribute('aria-label', 'Amount');
      var x = el('button', 'x', '×'); x.type = 'button';
      sg.addEventListener('click', function () {
        sign = sign === '+' ? '-' : '+';
        sg.textContent = sign === '-' ? '−' : '+';
        sg.title = sign === '-' ? 'Deducts — press to make it add' : 'Adds — press to make it deduct';
      });
      x.addEventListener('click', function () { r.parentNode.removeChild(r); add.disabled = false; });
      function trySave() {
        var v = U.parseMoney(a.value);
        if (!lab.value.trim() || v === null || isNaN(v)) return;
        recompute(store().save('app/payroll/run_items', null, {
          run_line_id: m.line.id, label: lab.value.trim(), amount: v, sign: sign
        }).then(function () { return store().action('calc', { action: 'compute', run_id: ctx.run.id }); }));
      }
      a.addEventListener('change', trySave);
      lab.addEventListener('change', trySave);
      r.appendChild(lab); r.appendChild(sg); r.appendChild(a); r.appendChild(x);
      card.insertBefore(r, add);
      add.disabled = true;
      lab.focus();
    });
    card.appendChild(add);

    if (isThr(ctx.run)) {
      /* THR: no days worked, no BPJS. A person's own change to the amount is an item above. */
      card.appendChild(el('div', 'pr-mut pr-thrnote', 'The THR amount comes from the service months at the pay date. To change one person\'s amount, add an item above (+ adds, − deducts).'));
      breakdown(card, ctx, m);
      side.appendChild(card);
      return;
    }
    /* Hari kerja: memprorata Gaji Pokok & tunjangan tetap. */
    var days = el('div', 'pr-days');
    days.appendChild(el('span', null, 'Hari kerja'));
    var onStr = String(ctx.run.period_month).slice(0, 10);
    var y0 = Number(onStr.slice(0, 4)), m0 = Number(onStr.slice(5, 7));
    var daysInMonth = new Date(Date.UTC(y0, m0, 0)).getUTCDate();
    var dw = el('input'); dw.inputMode = 'numeric'; dw.value = m.line.days_worked == null ? '' : m.line.days_worked;
    var dp = el('input'); dp.inputMode = 'numeric'; dp.value = m.line.days_in_period == null ? '' : m.line.days_in_period;
    dp.placeholder = String(daysInMonth);
    dw.setAttribute('aria-label', 'Days worked'); dp.setAttribute('aria-label', 'Days in period');
    dw.setAttribute('data-k', 'dw'); dp.setAttribute('data-k', 'dp');
    days.appendChild(dw); days.appendChild(el('span', null, 'dari')); days.appendChild(dp);
    days.appendChild(el('small', 'pr-mut', m.daily ? 'DAILY · wajib diisi: Gaji Pokok per hari × hari kerja'
                                                 : 'kosong = satu bulan penuh (' + daysInMonth + ' hari)'));
    function saveDays() {
      var a = dw.value.trim() === '' ? null : Number(dw.value), b = dp.value.trim() === '' ? null : Number(dp.value);
      if (a !== null && b === null) b = daysInMonth;
      if (a === null && b !== null) b = null;
      if ((a !== null && !(a >= 0 && a <= 31 && Math.floor(a) === a)) || (b !== null && !(b >= 1 && b <= 31 && Math.floor(b) === b))) {
        msg.className = 'pr-msg bad'; msg.textContent = 'Days are whole numbers: worked 0–31, out of 1–31.'; return;
      }
      if (a !== null && b !== null && a > b) { msg.className = 'pr-msg bad'; msg.textContent = 'More days worked than the period has.'; return; }
      msg.className = 'pr-msg'; msg.textContent = 'Recalculating…';
      store().save('app/payroll/run_lines', m.line.id, { days_worked: a, days_in_period: b, rev: m.line.rev })
        .then(function () { return store().action('calc', { action: 'compute', run_id: ctx.run.id }); })
        .then(function (c) { return refresh(wrap, ctx, c); })
        .catch(fail(msg));
    }
    dw.addEventListener('change', saveDays); dp.addEventListener('change', saveDays);
    card.appendChild(days);

    /* BPJS THIS MONTH: opt-in per programme. Only
       the programmes the employee is enrolled in (Employees) are offered; a
       programme is calculated only when ticked. Nothing is ticked on a new
       line. Ticking saves the line and recalculates in place. */
    var PNAME = { kesehatan: 'Kesehatan', jht: 'JHT', jp: 'JP', jkk: 'JKK', jkm: 'JKM' };
    var ticked = Array.isArray(m.line.bpjs_programmes) ? m.line.bpjs_programmes.slice() : [];
    var offer = ['kesehatan', 'jht', 'jp', 'jkk', 'jkm'].filter(function (p) {
      var r = (ctx.enrol || []).filter(function (b) { return b.payroll_employee_id === m.line.payroll_employee_id && b.programme === p; })[0];
      return r ? !!r.enrolled : true;            // no row yet = the statutory default, as api/calc reads it
    });
    var bx = el('div', 'pr-bpick');
    bx.appendChild(el('span', 'pr-bpick-h', 'BPJS bulan ini'));
    if (!offer.length) bx.appendChild(el('small', 'pr-mut', 'Tidak ikut program BPJS (Employees).'));
    offer.forEach(function (p) {
      var lb = el('label');
      var cb = el('input'); cb.type = 'checkbox'; cb.checked = ticked.indexOf(p) !== -1;
      cb.setAttribute('data-k', 'bp-' + p);
      cb.addEventListener('change', function () {
        var next = offer.filter(function (q) { return q === p ? cb.checked : ticked.indexOf(q) !== -1; });
        msg.className = 'pr-msg'; msg.textContent = 'Recalculating…';
        store().save('app/payroll/run_lines', m.line.id, { bpjs_programmes: next, rev: m.line.rev })
          .then(function () { return store().action('calc', { action: 'compute', run_id: ctx.run.id }); })
          .then(function (c) { return refresh(wrap, ctx, c); })
          .catch(fail(msg));
      });
      lb.appendChild(cb); lb.appendChild(document.createTextNode(PNAME[p]));
      bx.appendChild(lb);
    });
    card.appendChild(bx);

    breakdown(card, ctx, m);
    side.appendChild(card);
  }

  /* ── step 2 · REVIEW → OUTPUTS ─────────────────────────────────────── */
  function drawReview(wrap, top, msg, ctx, ms) {
    var back = el('button', 'pr-sec', '← Back'); back.type = 'button';
    var n = ms.filter(function (m) { return m.reviewed; }).length;
    var refused = ms.filter(function (m) { return m.refusal; }).length;
    var lock = el('button', 'pr-btn', 'Outputs →');
    lock.title = n + '/' + ms.length + ' reviewed';
    back.title = 'Back to draft';
    /* The Mandiri file is test-built here, so a problem stops the run in Review —
       Outputs is not reachable until the file can be made. */
    var mres = window.GKI.mandiri.build({
      client: ctx.client, run: ctx.run,
      rows: ms.filter(function (m) { return !m.refusal; }).map(function (m) { return { employee: m.emp, net: m.net_pay }; })
    });
    var ready = ms.length && n === ms.length && !refused && mres.ok;
    if (!ready) { lock.disabled = true; lock.classList.add('dis'); }
    top.appendChild(back); top.appendChild(lock);
    if (refused) { msg.className = 'pr-msg bad'; msg.textContent = 'A line is refused. Go back to draft to fix it.'; }
    else if (!mres.ok) { msg.className = 'pr-msg bad'; msg.textContent = 'Fix the failed checks before going to Outputs.'; }

    back.addEventListener('click', function () {
      back.disabled = true;
      store().save('app/payroll/runs', ctx.run.id, { status: 'draft', rev: ctx.run.rev }).then(remount, fail(msg, back));
    });
    lock.addEventListener('click', function () {
      /* The app's own pop-up (spine ui.confirm). Counts and totals only — no
         person's name on it. 066: no lock; the run can be reopened until paid. */
      var T = totals(ms);
      lock.disabled = true;
      U.confirm({
        icon: '📄',
        kicker: 'OUTPUTS · ' + monthName(period).toUpperCase(),
        title: 'Go to outputs for ' + monthName(period) + (isThr(ctx.run) ? ' · THR' : '') + '?',
        rows: [
          ['Client', ctx.client.name],
          ['Employees', n + '/' + ms.length + ' reviewed'],
          ['Mandiri transfer', U.money(T.net_pay)],
          ['PPh 21', U.money(T.pph21)]
        ],
        note: 'Payslips, the Mandiri file and the remittance are made from these figures. Until the run is marked paid it can be reopened (logged); once paid it is frozen.',
        ok: 'Outputs →',
        cancel: 'Cancel'
      }).then(function (yes) {
        if (!yes) { lock.disabled = false; return; }
        store().save('app/payroll/runs', ctx.run.id, { status: 'outputs', rev: ctx.run.rev }).then(remount, fail(msg, lock));
      });
    });

    var lay = el('div', 'pr-lay3');
    wrap.appendChild(lay);
    var left = el('div');
    lay.appendChild(left);

    /* checks */
    var cc = el('div', 'pr-card');
    var ch = el('h4'); var chl = el('span', null, 'CHECKS'); var chr = el('span');
    ch.appendChild(chl); ch.appendChild(chr); cc.appendChild(ch);
    var nOk = 0, nWarn = 0;
    function check(kind, text, small, right) {
      var d = el('div', 'pr-ck');
      d.appendChild(el('span', 'ic ' + kind, kind === 'y' ? '✓' : kind === 'w' ? '!' : '✗'));
      if (small) { var w = el('div', null, text); w.appendChild(el('small', null, small)); d.appendChild(w); }
      else d.appendChild(document.createTextNode(text));
      if (right) d.appendChild(typeof right === 'string' ? el('b', null, right) : right);
      cc.appendChild(d);
      if (kind === 'y') nOk++; else nWarn++;
    }
    var N = ms.length;
    if (mres.ok) check('y', 'Mandiri file can be made', null, mres.count + ' transfers');
    mres.problems.forEach(function (pr) {
      var link = null;
      if (/debit account|pay date|short code|bank is not/.test(pr)) { link = el('a', null, 'Client settings \u2197'); link.href = '#/home'; }
      else if (/^[A-Z]+-\d+:/.test(pr)) { link = el('a', null, 'Employees \u2197'); link.href = '#/employees'; }
      check('n', pr, 'Blocks Outputs until fixed', link);
    });
    mres.warnings.forEach(function (w) { check('w', w, 'Does not block outputs', null); });
    if (!isThr(ctx.run)) {
      var floorOk = ms.filter(function (m) { return !m.refusal && m.tk_base !== null && m.floor !== null && m.tk_base >= m.floor; }).length;
      var tkN = ms.filter(function (m) { return m.tk_base !== null; }).length;
      var fl = ms.filter(function (m) { return m.floor !== null; })[0];
      check(floorOk === tkN ? 'y' : 'n', 'BPJS TK base ≥ ' + (ctx.client.settings.bpjs_floor_region === 'UMP_NTB' ? 'UMP NTB' : ctx.client.settings.bpjs_floor_region) +
            (fl ? ' (Rp ' + U.money(fl.floor) + ')' : ''), null, floorOk + '/' + tkN);
    }
    var T = totals(ms);
    if (refused) check('n', 'A line is refused, so the net pay total is incomplete', 'Fix it in Draft', U.money(T.net_pay));
    if (!String(ctx.client.settings.contact_email || '').trim()) {
      var a = el('a', null, 'Client settings ↗'); a.href = '#/home';
      check('w', 'Payroll contact email missing', 'Does not block outputs · needed before payslips are sent', a);
    }
    chr.textContent = nOk + ' ok' + (nWarn ? ' · ' + nWarn + (nWarn === 1 ? ' issue' : ' issues') : '');
    left.appendChild(cc);

    /* review list */
    var rc = el('div', 'pr-card pr-mt');
    var rh = el('h4'); rh.appendChild(el('span', null, 'EMPLOYEES · REVIEW'));
    rh.appendChild(el('span', null, n + ' of ' + N + ' reviewed'));
    rc.appendChild(rh);
    ms.forEach(function (m) {
      var r = el('div', 'pr-rv' + (m.line.id === selectedLine ? ' on' : ''));
      r.appendChild(el('span', 'pr-av', U.initials(m.emp.full_name)));
      var w = el('div'); w.appendChild(el('b', null, m.emp.full_name));
      w.appendChild(el('span', null, m.emp.employee_code + (m.refusal ? ' · refused' : ' · net ' + U.money(m.net_pay))));
      r.appendChild(w);
      var rr = el('div', 'r');
      var b = el('button', m.reviewed ? 'pr-chip g' : 'pr-mk', m.reviewed ? '✓ REVIEWED' : 'Mark reviewed');
      b.type = 'button';
      b.title = m.reviewed ? 'Press to take the review back' : '';
      b.disabled = !!m.refusal;
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        b.disabled = true;
        store().action('calc', { action: 'review', line_id: m.line.id, reviewed: !m.reviewed })
          .then(remount, fail(msg, b));
      });
      rr.appendChild(b); r.appendChild(rr);
      r.addEventListener('click', function () { selectedLine = m.line.id; draw(wrap, ctx); });
      rc.appendChild(r);
    });
    rc.appendChild(el('div', 'pr-note', 'OUTPUTS · payslips + Mandiri file made from these figures · reopen until paid, logged · PAID freezes the run'));
    left.appendChild(rc);
    left.appendChild(totalsCard(T, false, isThr(ctx.run)));

    lay.appendChild(preview(ctx, ms, function () { draw(wrap, ctx); }));
  }

  /* The payslip preview (approved §7 layout, scaled) with ◂ ▸. */
  function preview(ctx, ms, redraw) {
    var card = el('div', 'pr-card pr-prev');
    var i = Math.max(0, ms.map(function (m) { return m.line.id; }).indexOf(selectedLine));
    var nav = el('div', 'pr-pnav');
    nav.appendChild(el('span', null, 'PAYSLIP PREVIEW · ' + (ms.length ? i + 1 : 0) + ' / ' + ms.length));
    nav.appendChild(el('span', 'sp'));
    var p = el('button', null, '◂'), q = el('button', null, '▸'), pdf = el('button', null, 'PDF ↗');
    p.type = q.type = pdf.type = 'button';
    p.addEventListener('click', function () { if (ms.length) { selectedLine = ms[(i - 1 + ms.length) % ms.length].line.id; redraw(); } });
    q.addEventListener('click', function () { if (ms.length) { selectedLine = ms[(i + 1) % ms.length].line.id; redraw(); } });
    /* A PDF is made only in Outputs or Paid; in Inputs / Review it would be a
       payslip for numbers still being worked. */
    var locked = ['locked', 'outputs', 'paid'].indexOf(ctx.run.status) !== -1;
    var mm = ms[i];
    pdf.disabled = !locked || !mm || !!mm.refusal || !window.GKI.pdfdoc;
    pdf.title = locked ? 'Downloads the payslip PDF' : 'The PDF is made in Outputs';
    pdf.addEventListener('click', function () {
      var per = String(ctx.run.period_month).slice(0, 10), label = pdf.textContent;
      pdf.disabled = true; pdf.textContent = '…';
      window.GKI.pdfdoc.payslipPdf({ client: ctx.client, employee: mm.emp, line: mm.line, bpjs: mm.bpjs, items: mm.items,
        rates: ctx.rates, ter_rate: mm.ter_rate, period: per, run_type: ctx.run.run_type, made: U.today() }).then(function (b) {
        window.GKI.pdfdoc.download(b, window.GKI.payslip.fileName(per, mm.emp.employee_code, ctx.run.run_type));
      }, function (err) {
        msg.className = 'pr-msg bad'; msg.textContent = 'The payslip PDF could not be made: ' + err.message;
      }).then(function () { pdf.disabled = false; pdf.textContent = label; });
    });
    nav.appendChild(p); nav.appendChild(q); nav.appendChild(pdf);
    card.appendChild(nav);
    var paper = el('div', 'pr-paper');
    var m = ms[i];
    if (m && !m.refusal && window.GKI.payslip) {
      var f = el('iframe');
      f.title = 'Payslip preview';
      f.setAttribute('sandbox', 'allow-same-origin');
      f.srcdoc = window.GKI.payslip.html({
        client: ctx.client, employee: m.emp, line: m.line, bpjs: m.bpjs, items: m.items,
        rates: ctx.rates, ter_rate: m.ter_rate, period: String(ctx.run.period_month).slice(0, 10), run_type: ctx.run.run_type, made: U.today()
      }, location.origin + '/');
      paper.appendChild(f);
    } else if (m) {
      paper.appendChild(el('div', 'pr-refusal', m.refusal || ''));
    }
    card.appendChild(paper);
    return card;
  }

  /* ── steps 3–4 · OUTPUTS and PAID (outputs.js) ─────────────────────── */
  function drawLocked(wrap, top, msg, ctx, ms) {
    /* Push 3: step 4 OUTPUTS (outputs.js). Without it, the read-only view. */
    if (window.GKI.outputs) {
      return window.GKI.outputs.draw({ wrap: wrap, top: top, msg: msg, ctx: ctx, ms: ms,
                                       totals: totals, monthName: monthName, remount: remount });
    }
    var r = ctx.run;
    top.appendChild(el('span', 'pr-chip k', String(r.status).toUpperCase()));
    msg.textContent = 'Outputs could not load (outputs.js missing). Figures are read only here.';
    var lay = el('div', 'pr-lay3');
    wrap.appendChild(lay);
    var left = el('div');
    left.appendChild(runTable(ctx, ms, false, function () { draw(wrap, ctx); }));
    left.appendChild(totalsCard(totals(ms), true, isThr(ctx.run)));
    lay.appendChild(left);
    lay.appendChild(preview(ctx, ms, function () { draw(wrap, ctx); }));
  }

  S.register({ id: 'run', label: 'Payroll run', title: 'Payroll run · review & outputs', mount: mount });
}());
