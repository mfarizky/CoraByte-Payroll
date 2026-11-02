/**
 * CoraByte Payroll — Home screen: the organisation's clients.
 *
 * List: search, filters, "+ Add client". Detail: the company identity
 * (name, legal name, NPWP, short code, city), its departments & positions
 * (used by the Employees form), and its payroll settings (contact, debit
 * account, pay/cut-off day, JKK rate, BPJS floor).
 *
 * Identity goes through /api/clients; settings through the store with the
 * row's `rev` (optimistic locking). Account numbers are masked until focused.
 */
(function () {
  'use strict';

  var S = window.GKI && window.GKI.spine;
  if (!S) { console.error('[gki] clients.js: spine missing'); return; }
  var U = S.ui, el = U.el;
  var store = function () { return window.GKI_STORE || window.GKI.store; };

  /* The five JKK classes as rates (057's CHECK, PP 44/2015 art.29). */
  var JKK = [['0.00240', '0,24%'], ['0.00540', '0,54%'], ['0.00890', '0,89%'],
             ['0.01270', '1,27%'], ['0.01740', '1,74%']];

  /* Region keys → words. Anything not here is shown as its key. */
  var REGION = { UMP_NTB: 'UMP Nusa Tenggara Barat' };

  var cs = { jkk: '', run: '', sort: 'az' };   // list filters, kept while moving between list and edit
  var pointedOn = false;          // a click highlights the CURRENT client's row (and makes it the client Employees / Run show); a second click clears it
  var editing = false;            // edit page opens read-only; the Edit button unlocks it
  var view = 'list';
  var jobs = [];                  // core/employer_jobs, for the Departments & positions card              // 'list' = rows with search + filters; 'edit' = one client's fields (redesign 2026-10-22)

  function jkkKey(v) { var n = U.num(v); return n === null ? '' : n.toFixed(5); }

  function mount(pane) {
    var wrap = el('div');
    pane.appendChild(wrap);
    wrap.appendChild(el('p', 'pr-msg', 'Loading…'));
    S.onClient(function () { U.clear(pane); mount(pane); });

    Promise.all([
      S.clients(),
      S.client(),
      store().list('app/payroll/employees'),
      store().list('app/payroll/runs'),
      store().list('app/payroll/minimum_wage'),
      store().list('core/employer_jobs')
    ]).then(function (r) {
      jobs = r[5].rows;
      draw(wrap, r[0], r[1], r[2].rows, r[3].rows, r[4].rows);
    }).catch(function (err) {
      U.clear(wrap);
      wrap.appendChild(el('p', 'pr-msg bad', U.errText(err)));
    });
  }

  function drawList(wrap, list, current, employees, runs) {
    var thisMonth = U.today().slice(0, 7);
    var top = el('div', 'pr-top pr-listtop');
    var srch = el('div', 'pr-srch');
    var q = el('input');
    q.placeholder = 'Search client name';
    q.setAttribute('aria-label', 'Search client name');
    srch.appendChild(q);
    srch.appendChild(el('span', 'pr-kbd', '/'));
    top.appendChild(srch);
    function filter(label, opts, key) {
      var h = {};
      Object.defineProperty(h, 'value', { get: function () { return cs[key]; } });
      top.appendChild(window.GKI.combo({
        label: label, value: cs[key],
        items: opts.map(function (o) { return { value: o[0], label: o[1] }; }),
        onChange: function (v) { cs[key] = v; drawRows(); }
      }));
      return h;
    }
    var fJkk = filter('JKK rate', [['', 'All JKK rates']].concat(JKK.map(function (j) { return [j[0], 'JKK ' + j[1]]; })), 'jkk');
    var fRun = filter('Run this month', [['', 'Any run status'], ['has', 'Has run this month'], ['none', 'No run this month']], 'run');
    var fSort = filter('Sort', [['az', 'Name A \u2192 Z'], ['za', 'Name Z \u2192 A']], 'sort');
    var card = el('div', 'pr-card pr-list');
    var h = el('h4');
    var hc = el('span', null, 'CLIENTS');
    h.appendChild(hc);
    var addBtn = el('button', 'pr-btn', '+ Add client');
    addBtn.type = 'button';
    addBtn.addEventListener('click', addClient);
    top.appendChild(addBtn);
    card.appendChild(h);
    card.appendChild(top);          // search + filters + sort in one row, inside the list card
    var rows = el('div');
    card.appendChild(rows);
    wrap.appendChild(card);
    function drawRows() {
      U.clear(rows);
      var t = q.value.trim().toLowerCase();
      var shown = list.filter(function (c) {
        var runsOf = runs.filter(function (x) { return x.payroll_client_id === c.id; });
        var hasThis = runsOf.some(function (x) { return String(x.period_month).slice(0, 7) === thisMonth; });
        if (t && (String(c.name) + ' ' + String(c.legalName) + ' ' + String(c.shortCode)).toLowerCase().indexOf(t) === -1) return false;
        if (fJkk.value && jkkKey(c.settings.jkk_rate) !== jkkKey(fJkk.value)) return false;
        if (fRun.value === 'has' && !hasThis) return false;
        if (fRun.value === 'none' && hasThis) return false;
        return true;
      });
      shown.sort(function (a, b) { var d = String(a.name).localeCompare(String(b.name)); return fSort.value === 'za' ? -d : d; });
      hc.textContent = 'CLIENTS · ' + shown.length + (shown.length !== list.length ? ' of ' + list.length : '');
      if (!shown.length) rows.appendChild(el('div', 'pr-empty', list.length ? 'No match.' : 'No clients yet. Click "+ Add client" to add the first one.'));
      shown.forEach(function (c) {
        var r = el('div', 'pr-er' + (pointedOn && current && current.id === c.id ? ' on' : ''));
        r.tabIndex = 0;
        r.appendChild(S.logo(c));
        var m = el('div');
        m.appendChild(el('b', null, c.name));
        var a = c.account || {};
        m.appendChild(el('span', null, [c.legalName !== c.name ? c.legalName : '', a.city].filter(Boolean).join(' · ') || '—'));
        r.appendChild(m);
        var mine = employees.filter(function (e) { return e.payroll_client_id === c.id; }).length;
        var last = runs.filter(function (x) { return x.payroll_client_id === c.id; })
                       .map(function (x) { return String(x.period_month).slice(0, 7); }).sort().pop();
        var rr = el('div', 'r');
        rr.appendChild(el('b', null, mine + ' employee' + (mine === 1 ? '' : 's') + ' · JKK ' + (JKK.filter(function (j) { return jkkKey(j[0]) === jkkKey(c.settings.jkk_rate); })[0] || ['', '—'])[1]));
        rr.appendChild(el('span', null, 'PAY DAY ' + (c.settings.pay_day || '—') + ' · LAST RUN ' + (last ? monthShort(last) : '—')));
        r.appendChild(rr);
        var eb = el('button', 'pr-btn2 pr-go', '\u2192'); eb.type = 'button'; eb.title = 'Open'; eb.setAttribute('aria-label', 'Open ' + c.name); r.appendChild(eb);
        eb.addEventListener('click', function (ev) { ev.stopPropagation(); open(); });
        function open() {
          view = 'edit'; editing = false;
          if (current && current.id === c.id) { var p = S.pane(); U.clear(p); mount(p); }
          else S.setClient(c.id);
        }
        r.addEventListener('click', function () {
          var isOn = pointedOn && current && current.id === c.id;
          if (isOn) { pointedOn = false; drawRows(); return; }       // second click: orange off, client stays
          pointedOn = true;
          if (current && current.id === c.id) drawRows(); else S.setClient(c.id);   // remounts with this row orange
        });
        r.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') open(); });
        rows.appendChild(r);
      });
    }
    q.addEventListener('input', drawRows);
    document.onkeydown = function (ev) {
      if (ev.key === '/' && document.activeElement && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) &&
          document.body.contains(q)) { ev.preventDefault(); q.focus(); }
    };
    drawRows();
  }

  function draw(wrap, list, c, employees, runs, wages) {
    U.clear(wrap);
    if (view === 'list') { drawList(wrap, list, c, employees, runs); return; }
    var top = el('div', 'pr-top');
    var back = el('button', 'pr-btn2', '\u2190 Back');
    back.type = 'button';
    top.appendChild(back);
    var edit = el('button', 'pr-btn2', 'Edit');
    edit.type = 'button';
    var save = el('button', 'pr-btn', 'Save changes');
    save.disabled = true;
    var actBox = el('div', 'act');          // Edit and Save changes share the right end of the Back row
    actBox.appendChild(edit); actBox.appendChild(save);
    top.appendChild(actBox);
    var big = el('div', 'pr-card pr-bigcard');
    wrap.appendChild(big);
    big.appendChild(top);
    back.addEventListener('click', function () {
      if (Object.keys(changed).length && !window.confirm('Discard the unsaved changes?')) return;
      view = 'list'; draw(wrap, list, c, employees, runs, wages);
    });
    var msg = el('p', 'pr-msg', '');
    big.appendChild(msg);

    if (!c) {
      msg.textContent = 'No clients yet. Go back and click "+ Add client".';
      return;
    }

    var row = c.settings;           // the settings row as last read
    var changed = {};               // column -> new value, only what moved

    function mark(col, val) {
      var was = row[col] == null ? '' : String(row[col]);
      var now = val == null ? '' : String(val);
      if (col === 'jkk_rate') { was = jkkKey(row[col]); now = jkkKey(val); }
      if (was === now) delete changed[col]; else changed[col] = val;
      save.disabled = !Object.keys(changed).length || S.online() === false;
      save.hidden = !Object.keys(changed).length;
      msg.className = 'pr-msg';
      msg.textContent = Object.keys(changed).length ? 'Unsaved changes.' : '';
    }

    var grid = el('div', 'pr-grid');
    big.appendChild(grid);
    save.hidden = true;             // shown once something changes
    var lk = GKI.lock(grid, '.pr-id');
    lk.set(!editing);
    edit.hidden = editing;
    edit.addEventListener('click', function () { editing = true; lk.set(false); edit.hidden = true; });

    /* ── identity (company record) ────────────────────────────────────── */
    var id = el('div', 'pr-card pr-id');
    id.appendChild(S.logo(c));
    var who = el('div');
    who.appendChild(el('b', null, String(c.legalName || c.name).toUpperCase()));
    var a = c.account || {};
    var place = [a.city, a.province].filter(Boolean).join(', ');
    who.appendChild(el('span', null, [place, c.npwp ? 'NPWP ' + c.npwp : ''].filter(Boolean).join(' · ') || '—'));
    var idActs = el('span', 'pr-src cb-idacts');
    idActs.appendChild(document.createTextNode(c.shortCode ? 'Short code ' + c.shortCode + '  ·  ' : 'No short code  ·  '));
    var editId = el('button', 'cb-link', 'Edit details');
    editId.type = 'button';
    editId.addEventListener('click', function () { editIdentity(c); });
    idActs.appendChild(editId);
    S.isAdmin().then(function (admin) {
      if (!admin) return;
      idActs.appendChild(document.createTextNode('  ·  '));
      var arch = el('button', 'cb-link cb-danger', 'Archive client');
      arch.type = 'button';
      arch.addEventListener('click', function () { archiveClient(c); });
      idActs.appendChild(arch);
    });
    who.appendChild(idActs);
    id.appendChild(who);

    var mine = employees.filter(function (e) { return e.payroll_client_id === c.id; });
    var last = runs.filter(function (x) { return x.payroll_client_id === c.id; })
                   .map(function (x) { return String(x.period_month).slice(0, 7); }).sort().pop();
    var stats = el('div', 'pr-stats');
    [['EMPLOYEES', String(mine.length)],
     ['PAY DAY', row.pay_day ? String(row.pay_day) : '—'],
     ['LAST RUN', last ? monthShort(last) : '—']].forEach(function (s) {
      var d = el('div', 'pr-stat');
      d.appendChild(el('i', null, s[0]));
      d.appendChild(el('b', null, s[1]));
      stats.appendChild(d);
    });
    id.appendChild(stats);
    grid.appendChild(id);

    /* ── payroll contact ─────────────────────────────────────────────── */
    var contact = card('PAYROLL CONTACT', 'receives payslips');
    contact.appendChild(field('NAME', 'contact_name', '—'));
    contact.appendChild(field('EMAIL', 'contact_email', 'name@client.co.id', 'email'));
    contact.appendChild(field('PHONE · OPTIONAL', 'contact_phone', '—', 'tel'));
    grid.appendChild(contact);

    /* ── payment ─────────────────────────────────────────────────────── */
    var bank = String(row.bank_code || 'MANDIRI');
    var pay = card('PAYMENT', null);
    var h = pay.querySelector('h4');
    var hb = el('span');
    hb.appendChild(el('span', 'pr-dot'));
    hb.appendChild(document.createTextNode(bank));
    h.appendChild(hb);
    pay.appendChild(maskedField('DEBIT ACCOUNT', 'debit_account'));
    var g = el('div', 'pr-g2');
    g.appendChild(field('PAY DAY', 'pay_day', '1–31', 'number', true));
    g.appendChild(field('CUT-OFF DAY', 'cutoff_day', '1–31', 'number', true));
    pay.appendChild(g);
    var ff = el('div', 'pr-f');
    ff.appendChild(el('label', null, 'FILE FORMAT'));
    var fi = el('input', 'pr-mono');
    fi.readOnly = true;
    fi.value = row.file_format === 'format_lama' ? 'Mandiri · Format Lama CSV' : String(row.file_format || '');
    ff.appendChild(fi);
    pay.appendChild(ff);
    grid.appendChild(pay);

    /* ── BPJS & tax ──────────────────────────────────────────────────── */
    var tax = card('BPJS & TAX', 'per client');
    var jf = el('div', 'pr-f');
    jf.appendChild(el('label', null, 'JKK RATE'));
    var seg = el('div', 'pr-seg');
    var cur = jkkKey(row.jkk_rate);
    JKK.forEach(function (j) {
      var b = el('button', j[0] === cur ? 'on' : '', j[1]);
      b.type = 'button';
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(seg.children, function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        mark('jkk_rate', j[0]);
      });
      seg.appendChild(b);
    });
    jf.appendChild(seg);
    tax.appendChild(jf);

    var rf = el('div', 'pr-f');
    rf.appendChild(el('label', null, 'BPJS FLOOR'));
    var rsel = el('select');
    var on = U.today();
    var regions = {};
    wages.forEach(function (w) {
      if (U.inForce(w, on)) regions[w.region] = w;
      else if (!regions[w.region]) regions[w.region] = null;
    });
    if (row.bpjs_floor_region && !(row.bpjs_floor_region in regions)) regions[row.bpjs_floor_region] = null;
    Object.keys(regions).sort().forEach(function (k) {
      var w = regions[k];
      var o = el('option', null, (REGION[k] || k) + (w ? ' · Rp ' + U.money(w.amount) : ' · no amount in force today'));
      o.value = k;
      if (k === row.bpjs_floor_region) o.selected = true;
      rsel.appendChild(o);
    });
    rsel.addEventListener('change', function () { mark('bpjs_floor_region', rsel.value); });
    rf.appendChild(rsel);
    tax.appendChild(rf);

    tax.appendChild(toggle('Kesehatan base includes fixed allowances', 'kesehatan_base_includes_fixed'));
    grid.appendChild(tax);

    /* ── departments & positions (the choices on the Employees form) ───── */
    var org = card('DEPARTMENTS & POSITIONS', null);
    org.classList.add('cb-org');
    var depts = (c.employer && c.employer.departments) || [];
    var mineJobs = jobsOf(c);
    if (!depts.length && !mineJobs.length) {
      org.appendChild(el('p', 'pr-msg', 'None yet. Add them so the Employees form can offer them.'));
    }
    depts.forEach(function (d) {
      var line = el('div', 'pr-kv');
      line.appendChild(el('span', null, d));
      line.appendChild(el('b', null, mineJobs.filter(function (j) { return j.department === d; })
        .map(function (j) { return j.title; }).join(', ') || '—'));
      org.appendChild(line);
    });
    var orgEdit = el('button', 'pr-btn2', 'Edit departments & positions');
    orgEdit.type = 'button';
    orgEdit.addEventListener('click', function () { editIdentity(c, true); });
    org.appendChild(orgEdit);
    grid.appendChild(org);

    /* ── save: the changed columns only, with the rev read ───────────── */
    save.addEventListener('click', function () {
      var cols = Object.keys(changed);
      if (!cols.length) return;
      var value = { rev: row.rev };
      for (var i = 0; i < cols.length; i++) {
        var col = cols[i], v = changed[col];
        if (col === 'pay_day' || col === 'cutoff_day') {
          v = v === '' ? null : Number(v);
          if (v !== null && !(v >= 1 && v <= 31 && Math.floor(v) === v)) {
            msg.className = 'pr-msg bad';
            msg.textContent = 'A ' + (col === 'pay_day' ? 'pay' : 'cut-off') + ' day is a day of the month, 1 to 31.';
            return;
          }
        }
        if (col === 'debit_account') {
          v = String(v || '').replace(/\s/g, '');
          if (v && !/^\d{13}$/.test(v)) {
            msg.className = 'pr-msg bad';
            msg.textContent = 'A Mandiri debit account is 13 digits.';
            return;
          }
          if (!v) v = null;
        }
        if (typeof v === 'string' && v.trim() === '' ) v = null;
        value[col] = v;
      }
      save.disabled = true;
      msg.className = 'pr-msg';
      msg.textContent = 'Saving…';
      store().save('app/payroll/clients', c.id, value).then(function () {
        return S.reloadClients();
      }).then(function () {
        var pane = S.pane();
        U.clear(pane);
        mount(pane);
      }).catch(function (err) {
        msg.className = 'pr-msg bad';
        msg.textContent = err && err.status === 409
          ? 'Someone else saved this client since you opened it. Reload the page and make the change again.'
          : U.errText(err);
        save.disabled = false;
      });
    });

    /* ── small builders ───────────────────────────────────────────────── */
    function card(title, right) {
      var d = el('div', 'pr-card');
      var h4 = el('h4');
      h4.appendChild(el('span', null, title));
      if (right) h4.appendChild(el('span', null, right));
      d.appendChild(h4);
      return d;
    }

    function field(label, col, ph, type, mono) {
      var f = el('div', 'pr-f');
      f.appendChild(el('label', null, label));
      var i = el('input', mono ? 'pr-mono' : null);
      i.type = type || 'text';
      if (type === 'number') { i.min = 1; i.max = 31; i.step = 1; }
      i.placeholder = ph || '';
      i.value = row[col] == null ? '' : String(row[col]);
      i.addEventListener('input', function () { mark(col, i.value); });
      f.appendChild(i);
      return f;
    }

    function maskedField(label, col) {
      var f = el('div', 'pr-f');
      f.appendChild(el('label', null, label));
      var i = el('input', 'pr-mono');
      i.inputMode = 'numeric';
      i.autocomplete = 'off';
      var value = row[col] == null ? '' : String(row[col]);
      function shown() { i.value = value ? U.mask(value, 4) : ''; }
      i.placeholder = '13 digits';
      shown();
      i.addEventListener('focus', function () { i.value = value; });
      i.addEventListener('input', function () { value = i.value; mark(col, value.replace(/\s/g, '')); });
      i.addEventListener('blur', shown);
      f.appendChild(i);
      return f;
    }

    function toggle(label, col) {
      var t = el('div', 'pr-tog');
      t.appendChild(el('span', null, label));
      var val = !!row[col];
      var sw = el('button', 'pr-sw' + (val ? '' : ' off'));
      sw.type = 'button';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', String(val));
      sw.setAttribute('aria-label', label);
      sw.addEventListener('click', function () {
        val = !val;
        sw.classList.toggle('off', !val);
        sw.setAttribute('aria-checked', String(val));
        if (val === !!row[col]) delete changed[col]; else changed[col] = val;
        save.disabled = !Object.keys(changed).length || S.online() === false;
        save.hidden = !Object.keys(changed).length;
        msg.className = 'pr-msg';
        msg.textContent = Object.keys(changed).length ? 'Unsaved changes.' : '';
      });
      t.appendChild(sw);
      return t;
    }
  }

  /* ── identity: add / edit / archive ───────────────────────────────── */

  function jobsOf(c) {
    if (!c || !c.employer) return [];
    return jobs.filter(function (j) { return j.employer_id === c.employer.id && j.active !== false; });
  }

  /* "FINANCE / Accountant" per line; a line without "/" is a department only. */
  function orgText(c) {
    var depts = (c && c.employer && c.employer.departments) || [];
    var js = jobsOf(c);
    var lines = [];
    depts.forEach(function (d) {
      var mine = js.filter(function (j) { return j.department === d; });
      if (!mine.length) lines.push(d);
      mine.forEach(function (j) { lines.push(d + ' / ' + j.title); });
    });
    js.filter(function (j) { return depts.indexOf(j.department) === -1; })
      .forEach(function (j) { lines.push((j.department || '') + ' / ' + j.title); });
    return lines.join('\n');
  }

  function parseOrg(text) {
    var departments = [], positions = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (!line) return;
      var i = line.indexOf('/');
      var d = (i === -1 ? line : line.slice(0, i)).trim().toUpperCase();
      var t = i === -1 ? '' : line.slice(i + 1).trim();
      if (d && departments.indexOf(d) === -1) departments.push(d);
      if (t) positions.push({ department: d, title: t });
    });
    return { departments: departments, positions: positions };
  }

  function identityFields(c) {
    var a = (c && c.account) || {};
    return [
      { name: 'name', label: 'CLIENT NAME', value: c ? c.name : '', placeholder: 'PT Contoh Sejahtera' },
      { name: 'legal_name', label: 'LEGAL NAME · ON PAYSLIPS', value: c ? c.legalName : '', placeholder: 'Same as the name if empty' },
      { name: 'short_code', label: 'SHORT CODE · 2–8 LETTERS, USED IN FILE NAMES', value: c ? c.shortCode : '', placeholder: 'CTH' },
      { name: 'npwp', label: 'NPWP', value: c ? c.npwp : '', placeholder: '00.000.000.0-000.000' },
      { name: 'city', label: 'CITY', value: a.city || '' },
      { name: 'province', label: 'PROVINCE', value: a.province || '' },
      { name: 'org', label: 'DEPARTMENTS & POSITIONS', type: 'textarea', value: c ? orgText(c) : '', rows: 6,
        placeholder: 'FINANCE / Accountant\nFINANCE / Finance Manager\nOPERATIONS / Driver',
        hint: 'One per line: DEPARTMENT / Position. A line without "/" adds a department only.' }
    ];
  }

  function identityBody(v) {
    var org = parseOrg(v.org);
    return { name: v.name, legal_name: v.legal_name, short_code: v.short_code, npwp: v.npwp, city: v.city,
             province: v.province, departments: org.departments, positions: org.positions };
  }

  function reopen() {
    var pane = S.pane();
    U.clear(pane);
    mount(pane);
  }

  function addClient() {
    U.form({
      title: 'Add client', ok: 'Add client',
      note: 'Payroll settings (pay day, debit account, JKK) can be filled in on the next page.',
      fields: identityFields(null),
      submit: function (v) { return U.api('POST', '/api/clients', identityBody(v)); }
    }).then(function (r) {
      if (!r || !r.id) return;
      S.reloadClients().then(function () {
        view = 'edit'; editing = true;
        S.setClient(r.id);
        reopen();
        S.toast('Client added.');
      });
    });
  }

  function editIdentity(c, focusOrg) {
    U.form({
      title: focusOrg ? 'Departments & positions' : 'Edit client details', ok: 'Save',
      fields: identityFields(c),
      submit: function (v) { return U.api('PUT', '/api/clients/' + encodeURIComponent(c.id), identityBody(v)); }
    }).then(function (r) {
      if (!r) return;
      S.reloadClients().then(function () { reopen(); S.toast('Saved.'); });
    });
  }

  function archiveClient(c) {
    U.confirm({
      title: 'Archive ' + c.name + '?', ok: 'Archive', icon: '!',
      note: 'The client disappears from every list. Its employees, runs and payslips are kept.'
    }).then(function (yes) {
      if (!yes) return;
      U.api('POST', '/api/clients/' + encodeURIComponent(c.id) + '/archive', { archived: true }).then(function () {
        view = 'list';
        return S.reloadClients();
      }).then(reopen, function (err) { window.alert(U.errText(err)); });
    });
  }

  /* "2026-09" -> "SEP 26" (render). */
  function monthShort(ym) {
    var m = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    return m[Number(ym.slice(5, 7)) - 1] + ' ' + ym.slice(2, 4);
  }

  /* Opening Home from the navigation always starts at the client list. */
  S.register({ id: 'home', label: 'Home', title: 'Clients', mount: function (pane) { view = 'list'; mount(pane); } });
}());
