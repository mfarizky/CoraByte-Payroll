/**
 * CoraByte Payroll — Settings: the organisation (one login = one organisation
 * = one employer). Profile, payroll settings, departments & positions.
 * Admins edit; members read. Everything here is invisible to other organisations.
 */
(function () {
  'use strict';

  var S = window.GKI && window.GKI.spine;
  if (!S) return;
  var U = S.ui, el = U.el;

  var FIELDS = [
    ['name', 'ORGANIZATION NAME', 'Shown in the header'],
    ['legal_name', 'LEGAL NAME', 'e.g. PT Contoh Konsultan Indonesia'],
    ['npwp', 'NPWP', '00.000.000.0-000.000'],
    ['phone', 'PHONE', '+62 …'],
    ['email', 'EMAIL', 'payroll@company.co.id'],
    ['address', 'ADDRESS', 'Street, number'],
    ['city', 'CITY', ''],
    ['province', 'PROVINCE', '']
  ];

  function mount(pane) {
    var wrap = el('div');
    pane.appendChild(wrap);
    wrap.appendChild(el('p', 'pr-msg', 'Loading…'));
    Promise.all([S.me(), U.api('GET', '/api/org'), S.reloadClients().then(function () { return S.client(); }),
      window.GKI.store.list('core/employer_jobs'), window.GKI.store.list('app/payroll/minimum_wage')]).then(function (r) {
      draw(wrap, r[0], r[1]);
      drawPayroll(wrap, r[0], r[2], r[3].rows, r[4].rows);
    },
      function (err) { U.clear(wrap); wrap.appendChild(el('p', 'pr-msg bad', U.errText(err))); });
  }

  function draw(wrap, me, org) {
    U.clear(wrap);
    var admin = me && me.role === 'admin';

    var card = el('div', 'pr-card cb-settings');
    var h = el('h4');
    h.appendChild(el('span', null, 'ORGANIZATION'));
    h.appendChild(el('span', null, admin ? 'admins can edit' : 'read only · ask an admin to change'));
    card.appendChild(h);

    var grid = el('div', 'cb-settings-grid');
    var inputs = {};
    FIELDS.forEach(function (f) {
      var w = el('div', 'pr-f' + (f[0] === 'address' || f[0] === 'email' ? ' cb-wide' : ''));
      var lab = el('label', null, f[1]);
      lab.htmlFor = 'org-' + f[0];
      w.appendChild(lab);
      var i = el('input');
      i.id = 'org-' + f[0];
      i.value = org[f[0]] || '';
      i.placeholder = f[2];
      i.readOnly = !admin;
      if (f[0] === 'email') i.type = 'email';
      inputs[f[0]] = i;
      w.appendChild(i);
      grid.appendChild(w);
    });
    card.appendChild(grid);

    var msg = el('p', 'pr-msg', '');
    card.appendChild(msg);
    if (admin) {
      var acts = el('div', 'pr-acts');
      var save = el('button', 'pr-btn', 'Save changes');
      save.type = 'button';
      save.addEventListener('click', function () {
        var body = {};
        Object.keys(inputs).forEach(function (k) { body[k] = inputs[k].value; });
        save.disabled = true;
        msg.className = 'pr-msg'; msg.textContent = 'Saving…';
        U.api('PUT', '/api/org', body).then(function () {
          msg.textContent = '';
          S.refreshIdentity();
          S.toast('Organization saved.');
        }, function (err) {
          msg.className = 'pr-msg bad'; msg.textContent = U.errText(err);
        }).then(function () { save.disabled = false; });
      });
      acts.appendChild(save);
      card.appendChild(acts);
    }
    wrap.appendChild(card);

    var about = el('div', 'pr-card cb-settings');
    var h2 = el('h4');
    h2.appendChild(el('span', null, 'TENANT'));
    about.appendChild(h2);
    [['Organization ID', org.id], ['Created', U.dmy(String(org.created_at || '').slice(0, 10))],
     ['Data isolation', 'Employees, payroll runs and users of this organization are not visible to any other organization.']]
      .forEach(function (r) {
        var kv = el('div', 'pr-kv');
        kv.appendChild(el('span', null, r[0]));
        kv.appendChild(el('b', r[0] === 'Organization ID' ? 'cb-mono' : null, r[1]));
        about.appendChild(kv);
      });
    wrap.appendChild(about);
  }

  var JKK = [['0.002400', '0,24% · very low risk'], ['0.005400', '0,54% · low'], ['0.008900', '0,89% · medium'],
             ['0.012700', '1,27% · high'], ['0.017400', '1,74% · very high']];
  var REGION = { UMP_NTB: 'UMP Nusa Tenggara Barat' };

  function field(grid, label, input, wide) {
    var w = el('div', 'pr-f' + (wide ? ' cb-wide' : ''));
    w.appendChild(el('label', null, label));
    w.appendChild(input);
    grid.appendChild(w);
    return input;
  }
  function input(value, ph) { var i = el('input'); i.value = value == null ? '' : String(value); i.placeholder = ph || ''; return i; }
  function select(opts, value) {
    var s = el('select');
    opts.forEach(function (o) { var x = el('option', null, o[1]); x.value = o[0]; s.appendChild(x); });
    s.value = value;
    return s;
  }

  /* Payroll settings + departments & positions of the organisation's employer record. */
  function drawPayroll(wrap, me, c, jobs, wages) {
    if (!c) return;
    var admin = me && me.role === 'admin';
    var set = c.settings || {};
    var card = el('div', 'pr-card cb-settings');
    var h = el('h4');
    h.appendChild(el('span', null, 'PAYROLL'));
    h.appendChild(el('span', null, 'used by every payroll run'));
    card.appendChild(h);

    var grid = el('div', 'cb-settings-grid');
    var shortCode = field(grid, 'SHORT CODE · IN BANK FILE NAMES', input(c.shortCode, 'e.g. NPK'));
    var debit = field(grid, 'MANDIRI DEBIT ACCOUNT · 13 DIGITS', input(set.debit_account, '1230000000000'));
    var payDay = field(grid, 'PAY DAY', input(set.pay_day, '1–31'));
    var cutoff = field(grid, 'CUT-OFF DAY', input(set.cutoff_day, '1–31'));
    var jkkKey = (Number(set.jkk_rate) || 0.0024).toFixed(6);
    var jkk = field(grid, 'JKK RISK CLASS', select(JKK, jkkKey));
    var regions = {};
    wages.forEach(function (w) { regions[w.region] = true; });
    if (set.bpjs_floor_region) regions[set.bpjs_floor_region] = true;
    var region = field(grid, 'BPJS WAGE FLOOR', select(Object.keys(regions).sort().map(function (k) { return [k, REGION[k] || k]; }),
      set.bpjs_floor_region || 'UMP_NTB'));
    var kes = field(grid, 'BPJS KESEHATAN BASE', select([['true', 'Basic salary + fixed allowances'], ['false', 'Basic salary only']],
      String(!!set.kesehatan_base_includes_fixed)), true);

    var depts = (c.employer && c.employer.departments) || [];
    var mine = jobs.filter(function (j) { return c.employer && j.employer_id === c.employer.id && j.active !== false; });
    var lines = [];
    depts.forEach(function (d) {
      var js = mine.filter(function (j) { return j.department === d; });
      if (!js.length) lines.push(d);
      js.forEach(function (j) { lines.push(d + ' / ' + j.title); });
    });
    var org = el('textarea', 'cb-textarea');
    org.rows = 6;
    org.value = lines.join('\n');
    org.placeholder = 'FINANCE / Accountant\nOPERATIONS / Driver';
    field(grid, 'DEPARTMENTS & POSITIONS · ONE PER LINE: DEPARTMENT / Position', org, true);
    card.appendChild(grid);

    [shortCode, debit, payDay, cutoff, org].forEach(function (i) { i.readOnly = !admin; });
    [jkk, region, kes].forEach(function (i) { i.disabled = !admin; });

    var msg = el('p', 'pr-msg', '');
    card.appendChild(msg);
    if (admin) {
      var acts = el('div', 'pr-acts');
      var save = el('button', 'pr-btn', 'Save payroll settings');
      save.type = 'button';
      save.addEventListener('click', function () {
        var departments = [], positions = [];
        org.value.split(/\r?\n/).forEach(function (line) {
          line = line.trim(); if (!line) return;
          var i = line.indexOf('/');
          var d = (i === -1 ? line : line.slice(0, i)).trim().toUpperCase();
          var t = i === -1 ? '' : line.slice(i + 1).trim();
          if (d && departments.indexOf(d) === -1) departments.push(d);
          if (t) positions.push({ department: d, title: t });
        });
        var acct = debit.value.replace(/\s/g, '');
        var pd = payDay.value.trim() === '' ? null : Number(payDay.value);
        var cd = cutoff.value.trim() === '' ? null : Number(cutoff.value);
        var bad = acct && !/^\d{13}$/.test(acct) ? 'A Mandiri debit account is 13 digits.'
          : [pd, cd].some(function (n) { return n !== null && !(n >= 1 && n <= 31 && Math.floor(n) === n); })
            ? 'Pay day and cut-off day are days of the month, 1 to 31.' : '';
        if (bad) { msg.className = 'pr-msg bad'; msg.textContent = bad; return; }
        save.disabled = true;
        msg.className = 'pr-msg'; msg.textContent = 'Saving…';
        U.api('PUT', '/api/org/structure', { short_code: shortCode.value, departments: departments, positions: positions })
          .then(function () {
            return window.GKI.store.save('app/payroll/clients', c.id, {
              rev: set.rev, debit_account: acct || null, pay_day: pd, cutoff_day: cd, jkk_rate: jkk.value,
              bpjs_floor_region: region.value, kesehatan_base_includes_fixed: kes.value === 'true'
            });
          }).then(function () {
            S.toast('Payroll settings saved.');
            var pane = S.pane(); U.clear(pane); mount(pane);
          }, function (err) {
            msg.className = 'pr-msg bad'; msg.textContent = U.errText(err); save.disabled = false;
          });
      });
      acts.appendChild(save);
      card.appendChild(acts);
    }
    /* payroll settings sit between the profile and the tenant card */
    wrap.insertBefore(card, wrap.lastChild);
  }

  S.register({ id: 'settings', label: 'Settings', mount: mount });
}());
