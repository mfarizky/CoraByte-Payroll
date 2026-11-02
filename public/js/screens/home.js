/**
 * CoraByte Payroll — Home: the organisation's dashboard.
 * Headcount, this month's payroll status, the latest run's totals, recent
 * runs (a row opens the run) and what still needs setting up.
 */
(function () {
  'use strict';

  var S = window.GKI && window.GKI.spine;
  if (!S) return;
  var U = S.ui, el = U.el;
  var store = function () { return window.GKI.store; };

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
                'September', 'October', 'November', 'December'];
  var STATUS = { draft: 'Draft', review: 'Review', outputs: 'Outputs', locked: 'Outputs', paid: 'Paid' };
  var TYPE = { regular: 'Regular', thr: 'THR', bonus: 'Bonus' };

  function monthName(p) { return MONTHS[Number(String(p).slice(5, 7)) - 1] + ' ' + String(p).slice(0, 4); }

  function mount(pane) {
    var wrap = el('div', 'cb-dash');
    pane.appendChild(wrap);
    wrap.appendChild(el('p', 'pr-msg', 'Loading…'));
    Promise.all([
      S.client(), U.api('GET', '/api/org'),
      store().list('app/payroll/employees'),
      store().list('app/payroll/runs'),
      store().list('app/payroll/run_lines'),
      store().list('app/payroll/run_bpjs')
    ]).then(function (r) {
      draw(wrap, { client: r[0], org: r[1], employees: r[2].rows, runs: r[3].rows, lines: r[4].rows, bpjs: r[5].rows });
    }).catch(function (err) {
      U.clear(wrap);
      wrap.appendChild(el('p', 'pr-msg bad', U.errText(err)));
    });
  }

  /* Totals of one run, from its stored lines. */
  function totals(run, D) {
    var lines = D.lines.filter(function (l) { return l.run_id === run.id; });
    var ids = {};
    lines.forEach(function (l) { ids[l.id] = true; });
    var t = { employees: lines.length, gross: 0, net: 0, pph21: 0, employerBpjs: 0 };
    lines.forEach(function (l) { t.gross += U.num(l.gross_pay) || 0; t.net += U.num(l.net_pay) || 0; t.pph21 += U.num(l.pph21) || 0; });
    D.bpjs.forEach(function (b) { if (ids[b.run_line_id]) t.employerBpjs += U.num(b.employer_amount) || 0; });
    t.cost = t.gross + t.employerBpjs;
    return t;
  }

  function tile(label, value, sub, tone) {
    var d = el('div', 'cb-tile' + (tone ? ' ' + tone : ''));
    d.appendChild(el('span', 'cb-tile-label', label));
    d.appendChild(el('b', 'cb-tile-value', value));
    d.appendChild(el('span', 'cb-tile-sub', sub || ''));
    return d;
  }

  function openRun(run) {
    try { sessionStorage.setItem('cb.openRun', JSON.stringify({ period: String(run.period_month).slice(0, 10), id: run.id })); }
    catch (e) { /* the run screen opens on the current month */ }
    location.hash = '#/run';
  }

  function draw(wrap, D) {
    U.clear(wrap);
    var c = D.client;
    var runs = D.runs.filter(function (r) { return c && r.payroll_client_id === c.id && !r.superseded_by_run_id; });
    var emps = D.employees.filter(function (e) { return c && e.payroll_client_id === c.id; });
    var thisMonth = U.today().slice(0, 8) + '01';
    var current = runs.filter(function (r) { return String(r.period_month).slice(0, 10) === thisMonth && (r.run_type || 'regular') === 'regular'; })[0];
    var latest = runs[0] || null;                         // the store lists newest first
    var lt = latest ? totals(latest, D) : null;

    /* heading */
    var head = el('div', 'cb-dash-head');
    var h = el('div');
    h.appendChild(el('h1', null, 'Dashboard'));
    h.appendChild(el('p', null, (D.org ? D.org.name + ' · ' : '') + U.dmy(U.today())));
    head.appendChild(h);
    var acts = el('div', 'cb-dash-acts');
    var addEmp = el('a', 'pr-btn2', '+ Add employee'); addEmp.href = '#/employees';
    var startRun = el('a', 'pr-btn', current ? 'Open ' + monthName(thisMonth) + ' payroll' : 'Start ' + monthName(thisMonth) + ' payroll');
    startRun.href = '#/run';
    if (current) startRun.addEventListener('click', function (ev) { ev.preventDefault(); openRun(current); });
    acts.appendChild(addEmp); acts.appendChild(startRun);
    head.appendChild(acts);
    wrap.appendChild(head);

    /* tiles */
    var daily = emps.filter(function (e) { return e.rate_type === 'daily'; }).length;
    var tiles = el('div', 'cb-tiles');
    tiles.appendChild(tile('Active employees', String(emps.length), daily ? daily + ' paid daily' : 'all paid monthly'));
    tiles.appendChild(tile('Payroll ' + monthName(thisMonth), current ? STATUS[current.status] || current.status : 'Not started',
      current ? 'pay date ' + (current.pay_date ? U.dmy(current.pay_date) : '—') : 'start it from the button above',
      current && current.status === 'paid' ? 'ok' : (current ? 'busy' : 'todo')));
    tiles.appendChild(tile('Net pay · latest run', lt ? 'Rp ' + U.money(lt.net) : '—', latest ? monthName(latest.period_month) : 'no run yet'));
    tiles.appendChild(tile('Employer cost · latest run', lt ? 'Rp ' + U.money(lt.cost) : '—',
      lt ? 'PPh 21 Rp ' + U.money(lt.pph21) : ''));
    wrap.appendChild(tiles);

    var cols = el('div', 'cb-dash-cols');

    /* recent runs */
    var rc = el('div', 'pr-card');
    var rh = el('h4'); rh.appendChild(el('span', null, 'RECENT PAYROLL RUNS')); rh.appendChild(el('span', null, 'open a row'));
    rc.appendChild(rh);
    if (!runs.length) rc.appendChild(el('p', 'pr-msg', 'No payroll run yet.'));
    else {
      var tbl = el('table', 'pr-tbl cb-runs');
      var tr0 = el('tr');
      ['Month', 'Type', 'Status', 'Employees', 'Gross', 'Net pay'].forEach(function (x) { tr0.appendChild(el('th', null, x)); });
      var th = el('thead'); th.appendChild(tr0); tbl.appendChild(th);
      var tb = el('tbody');
      runs.slice(0, 8).forEach(function (r) {
        var t = totals(r, D);
        var tr = el('tr');
        tr.tabIndex = 0;
        tr.appendChild(el('td', null, monthName(r.period_month)));
        tr.appendChild(el('td', null, TYPE[r.run_type || 'regular'] || r.run_type));
        var st = el('td'); st.appendChild(el('span', 'pr-chip ' + (r.status === 'paid' ? 'g' : 'n'), (STATUS[r.status] || r.status).toUpperCase()));
        tr.appendChild(st);
        tr.appendChild(el('td', null, String(t.employees)));
        tr.appendChild(el('td', null, U.money(t.gross)));
        tr.appendChild(el('td', 'net', U.money(t.net)));
        tr.addEventListener('click', function () { openRun(r); });
        tr.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') openRun(r); });
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      rc.appendChild(tbl);
    }
    cols.appendChild(rc);

    /* setup */
    var sc = el('div', 'pr-card');
    var sh = el('h4'); sh.appendChild(el('span', null, 'SETUP')); sc.appendChild(sh);
    var set = (c && c.settings) || {};
    var depts = (c && c.employer && c.employer.departments) || [];
    [[!!(D.org && D.org.npwp), 'Organization NPWP', '#/settings'],
     [!!(c && c.shortCode), 'Short code (bank file name)', '#/settings'],
     [/^\d{13}$/.test(String(set.debit_account || '')), 'Mandiri debit account', '#/settings'],
     [depts.length > 0, 'Departments & positions', '#/settings'],
     [emps.length > 0, 'At least one employee', '#/employees']].forEach(function (x) {
      var row = el('div', 'pr-ck');
      row.appendChild(el('span', 'ic ' + (x[0] ? 'y' : 'w'), x[0] ? '✓' : '!'));
      row.appendChild(document.createTextNode(x[1]));
      if (!x[0]) { var a = el('a', 'cb-link', 'Set up'); a.href = x[2]; var b = el('b'); b.appendChild(a); row.appendChild(b); }
      sc.appendChild(row);
    });
    cols.appendChild(sc);
    wrap.appendChild(cols);
  }

  S.register({ id: 'home', label: 'Home', title: 'Dashboard', mount: mount });
}());
