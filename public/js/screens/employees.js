/**
 * CoraByte Payroll — Employees screen.
 *
 * List with search/filters, and the employee form: identity & tax (NIK,
 * NPWP, PTKP, employment type), bank, salary components (with effective
 * dates), BPJS enrolment, and opening tax figures for mid-year joiners.
 * Department and position come from the client's list (Home screen).
 * Sensitive numbers (NIK, NPWP, account) are masked until shown.
 * Deleting an employee is admin-only and refused once they are on a paid run.
 */
(function () {
  'use strict';

  var S = window.GKI && window.GKI.spine;
  if (!S) { console.error('[gki] employees.js: spine missing'); return; }
  var U = S.ui, el = U.el;
  /* Banks the Mandiri file can pay — read from mandiri.js (loaded after this
     file, so read at use). Fallback = Mandiri only. */
  function banks() {
    return (window.GKI && window.GKI.mandiri && window.GKI.mandiri.BANKS) ||
           { MANDIRI: { J: 'IBU', K: '', L: 'MANDIRI', len: 13, label: 'MANDIRI' } };
  }
  var store = function () { return window.GKI_STORE || window.GKI.store; };

  var BULAN3 = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  var PTKP = ['TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3'];
  /* 058's core.payroll_ter_category(), measured — not a second opinion. */
  var TER = { 'TK/0': 'A', 'TK/1': 'A', 'K/0': 'A',
              'TK/2': 'B', 'TK/3': 'B', 'K/1': 'B', 'K/2': 'B', 'K/3': 'C' };
  var PROGRAMMES = [
    { p: 'kesehatan', label: 'Kesehatan', share: true },
    { p: 'jht',       label: 'JHT',       share: true },
    { p: 'jp',        label: 'JP',        share: true },
    { p: 'jkk',       label: 'JKK',       share: false },
    { p: 'jkm',       label: 'JKM',       share: false }
  ];
  var GAJI_POKOK = 'Gaji Pokok';     // plan F6: the TK base is this component, by name

  var REQ = { employee_code: 1, full_name: 1, position: 1, start_date: 1, nik: 1, bank_code: 1, bank_account: 1, bank_account_name: 1, bank_branch_city: 1, email: 1 };   // fields marked * and required to save
  var es = { status: '', ptkp: '', sort: 'az' };   // list filters, kept while moving between list and edit
  var editing = false;               // edit page opens read-only; Edit unlocks it
  var view = 'list';                 // 'list' = rows only; 'edit' = one employee's fields (redesign 2026-10-22)
  var pointedId = null;              // row highlighted by a click; a second click clears it
  var selectedId = null;             // kept across re-mounts of this screen
  var pendingMsg = null;             // a sentence to show after a re-mount

  /* 0.037 -> "3,7%". */
  function pct(r) {
    var n = U.num(r);
    if (n === null) return '?';
    return String(Math.round(n * 10000) / 100).replace('.', ',') + '%';
  }

  function firstOfMonth() { return U.today().slice(0, 8) + '01'; }

  function mount(pane) {
    var wrap = el('div');
    pane.appendChild(wrap);
    wrap.appendChild(el('p', 'pr-msg', 'Loading…'));
    S.onClient(function () { selectedId = null; pointedId = null; view = 'list'; U.clear(pane); mount(pane); });

    Promise.all([
      S.clients(), S.client(),
      store().list('app/payroll/employees', { includeInactive: true }),
      store().list('app/payroll/components'),
      store().list('app/payroll/employee_bpjs'),
      store().list('app/payroll/bpjs_rates'),
      store().list('app/payroll/minimum_wage'),
      /* The client's positions (core/employer_jobs), set on the Home screen. */
      store().list('core/employer_jobs').then(function (x) { return { rows: x.rows, ok: true }; },
                                              function () { return { rows: [], ok: false }; })
    ]).then(function (r) {
      var c = r[1];
      var data = {
        list: r[0], client: c,
        employees: c ? r[2].rows.filter(function (e) { return e.payroll_client_id === c.id; }) : [],
        components: r[3].rows, bpjs: r[4].rows, rates: r[5].rows, wages: r[6].rows,
        jobs: r[7].rows, jobsOk: r[7].ok
      };
      draw(wrap, data);
    }).catch(function (err) {
      U.clear(wrap);
      wrap.appendChild(el('p', 'pr-msg bad', U.errText(err)));
    });
  }

  function draw(wrap, D) {
    U.clear(wrap);
    var top = el('div', 'pr-top');
    var save = el('button', 'pr-btn', 'Save changes');
    save.disabled = true;
    if (view === 'edit') {
      var back = el('button', 'pr-btn2', '\u2190 Back');
      back.type = 'button';
      back.addEventListener('click', function () {
        if (dirty() && !window.confirm('Discard the unsaved changes?')) return;
        view = 'list'; draw(wrap, D);
      });
      top.appendChild(back);
    }
    var host = wrap;                       // edit page: one big card around Back + fields
    if (view === 'edit') { host = el('div', 'pr-card pr-bigcard'); wrap.appendChild(host); }
    host.appendChild(top);
    var msg = el('p', 'pr-msg', '');
    host.appendChild(msg);
    if (pendingMsg) { msg.className = 'pr-msg bad'; msg.textContent = pendingMsg; pendingMsg = null; }
    if (!D.client) {
      msg.textContent = 'No client yet. Add one on the Home screen first.';
      return;
    }

    var on = U.today();
    var compsOf = function (id) {
      return D.components.filter(function (x) {
        return x.payroll_employee_id === id && (!x.effective_to || String(x.effective_to) >= on);
      }).sort(function (a, b) {
        if (a.name === GAJI_POKOK) return -1;
        if (b.name === GAJI_POKOK) return 1;
        return String(a.effective_from).localeCompare(String(b.effective_from)) || a.name.localeCompare(b.name);
      });
    };
    var grossFixed = function (comps) {
      return comps.reduce(function (s, x) {
        return s + ((x.is_fixed && !x.deleted) ? (U.num(x.amount) || 0) : 0);
      }, 0);
    };

    var emps = D.employees.slice().sort(function (a, b) {
      if (!!a.active !== !!b.active) return a.active ? -1 : 1;
      return String(a.employee_code).localeCompare(String(b.employee_code));
    });
    if (selectedId !== 'new' && !emps.some(function (e) { return e.id === selectedId; })) {
      selectedId = emps.length ? emps[0].id : 'new';
    }

    var lay = el('div', 'pr-lay1');
    host.appendChild(lay);

    /* ── the list ────────────────────────────────────────────────────── */
    var listCard = el('div', 'pr-card pr-list');
    var h = el('h4');
    var nActive = emps.filter(function (e) { return e.active; }).length;
    h.appendChild(el('span', null, 'EMPLOYEES · ' + nActive));
    h.appendChild(el('span', null, 'active'));
    listCard.appendChild(h);
    var srch = el('div', 'pr-srch');
    var q = el('input');
    q.placeholder = 'Search name or ID';
    q.setAttribute('aria-label', 'Search name or ID');
    srch.appendChild(q);
    srch.appendChild(el('span', 'pr-kbd', '/'));
    var tb = el('div', 'pr-tbar');           // search + Add employee on one row
    tb.appendChild(srch);
    listCard.appendChild(tb);
    var fbar = el('div', 'pr-fbar');
    function fcombo(label, items, key) {
      fbar.appendChild(window.GKI.combo({ label: label, value: es[key], items: items,
        onChange: function (v) { es[key] = v; drawRows(); } }));
    }
    fcombo('Status', [{ value: '', label: 'All status' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }], 'status');
    fcombo('PTKP', [{ value: '', label: 'All PTKP' }].concat(['TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3'].map(function (p) { return { value: p, label: p }; })), 'ptkp');
    fcombo('Sort', [{ value: 'az', label: 'Name A \u2192 Z' }, { value: 'za', label: 'Name Z \u2192 A' }], 'sort');
    tb.appendChild(fbar);                    // filters + sort on the same row as search
    var rows = el('div');
    listCard.appendChild(rows);
    function drawRows() {
      U.clear(rows);
      var t = q.value.trim().toLowerCase();
      var shown = emps.filter(function (e) {
        if (es.status === 'active' && !e.active) return false;
        if (es.status === 'inactive' && e.active) return false;
        if (es.ptkp && e.ptkp_status !== es.ptkp) return false;
        return !t || String(e.full_name).toLowerCase().indexOf(t) !== -1 ||
               String(e.employee_code).toLowerCase().indexOf(t) !== -1;
      });
      shown.sort(function (a, b) { var d = String(a.full_name).localeCompare(String(b.full_name)); return es.sort === 'za' ? -d : d; });
      if (!shown.length) rows.appendChild(el('div', 'pr-empty', emps.length ? 'No match.' : 'No employees yet.'));
      shown.forEach(function (e) {
        var r = el('div', 'pr-er' + (e.id === pointedId ? ' on' : ''));
        r.tabIndex = 0;
        r.appendChild(el('span', 'pr-av', U.initials(e.full_name)));
        var m = el('div');
        m.appendChild(el('b', null, e.full_name));
        m.appendChild(el('span', null, [e.position || '—', e.department].filter(Boolean).join(' · ')));
        /* status, pay basis and contract at a glance */
        var tg = el('div', 'pr-ertags');
        tg.appendChild(el('span', 'pr-chip ' + (e.active ? 'g' : 'n'), e.active ? 'ACTIVE' : 'INACTIVE'));
        tg.appendChild(el('span', 'pr-chip n', e.rate_type === 'daily' ? 'DAILY' : 'MONTHLY'));
        if (e.employment_type) tg.appendChild(el('span', 'pr-chip n', e.employment_type));
        m.appendChild(tg);
        r.appendChild(m);
        var rr = el('div', 'r');
        rr.appendChild(el('b', null, U.money(grossFixed(compsOf(e.id)))));
        rr.appendChild(el('span', null, e.employee_code));
        r.appendChild(rr);
        var eb = el('button', 'pr-btn2 pr-go', '\u2192'); eb.type = 'button'; eb.title = 'Open'; eb.setAttribute('aria-label', 'Open ' + e.full_name); r.appendChild(eb);
        /* a click on the row only points at it; the Edit button opens the page */
        function point() { pointedId = (pointedId === e.id) ? null : e.id; drawRows(); }
        function openEdit(ev) { if (ev) ev.stopPropagation(); selectedId = e.id; view = 'edit'; editing = false; draw(wrap, D); }
        r.addEventListener('click', point);
        eb.addEventListener('click', openEdit);
        r.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') openEdit(); });
        rows.appendChild(r);
      });
    }
    q.addEventListener('input', drawRows);
    var add = el('button', 'pr-btn', '+ Add employee');
    add.type = 'button';
    add.title = 'Import — coming';
    add.addEventListener('click', function () {
      selectedId = 'new'; view = 'edit'; editing = true; draw(wrap, D);
    });
    tb.appendChild(add);
    if (view === 'list') {
      lay.appendChild(listCard);
      drawRows();
      document.onkeydown = function (ev) {
        if (ev.key === '/' && document.activeElement && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) &&
            document.body.contains(q)) { ev.preventDefault(); q.focus(); }
      };
      return;
    }

    document.onkeydown = function (ev) {
      if (ev.key === '/' && document.activeElement && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) &&
          document.body.contains(q)) { ev.preventDefault(); q.focus(); }
    };

    /* ── the detail: working copy of one employee ────────────────────── */
    var isNew = selectedId === 'new';
    var row = isNew ? { active: true, ptkp_status: 'TK/0', bank_code: 'MANDIRI' }
                    : emps.filter(function (e) { return e.id === selectedId; })[0];
    var changed = {};
    var badDate = {};                  // DD/MM/YYYY fields that do not parse
    var emp0 = D.client && D.client.employer;   // the client's employer record (departments)
    var posHolder = el('div');                  // Position follows Department
    if (isNew) { changed.active = true; changed.ptkp_status = 'TK/0'; changed.bank_code = 'MANDIRI'; }

    var comps = (isNew ? [] : compsOf(row.id)).map(function (x) {
      return { row: x, name: x.name, amount: U.num(x.amount), is_fixed: !!x.is_fixed,
               effective_from: String(x.effective_from).slice(0, 10), deleted: false };
    });
    if (isNew) comps.push({ row: null, name: GAJI_POKOK, amount: null, is_fixed: true, effective_from: '', deleted: false });

    var bp = {};
    PROGRAMMES.forEach(function (P) {
      var ex = isNew ? null : D.bpjs.filter(function (b) {
        return b.payroll_employee_id === row.id && b.programme === P.p;
      })[0] || null;
      bp[P.p] = ex ? { row: ex, enrolled: !!ex.enrolled, by: ex.employee_share_paid_by }
                   : { row: null, enrolled: true, by: P.share ? 'employee' : 'employer' };   // statutory defaults (§9)
    });

    /* A component's "from" follows the start date: one that
       began on the old start date, or before the new one, moves with it when the
       start date changes (only then). A raise added later keeps its own date. */
    function startNow() { return String(cur('start_date') || '').slice(0, 10); }
    /* The salary first in force AFTER the start date (e.g. saved before the start
       date was moved earlier) leaves the first month with no Gaji Pokok: it follows
       the start date too, so Edit + Save repairs it. */
    var firstFrom = comps.filter(function (x) { return x.row; })
      .reduce(function (m, x) { return !m || x.effective_from < m ? x.effective_from : m; }, null);
    function followsStart(x) {
      var old = String(row.start_date || '').slice(0, 10), nw = startNow();
      if (!x.row || !nw) return false;
      if (firstFrom && firstFrom > nw && x.effective_from === firstFrom) return true;
      return nw !== old && (x.effective_from === old || x.effective_from < nw);
    }
    function fromOf(x) { return followsStart(x) ? startNow() : x.effective_from; }
    function compDirty(x) {
      if (!x.row) return !x.deleted && (x.name || x.amount !== null);
      return x.deleted || x.name !== x.row.name || x.amount !== U.num(x.row.amount) || x.is_fixed !== !!x.row.is_fixed ||
             fromOf(x) !== x.effective_from;
    }
    function bpDirty(k) {
      var b = bp[k];
      return !b.row || b.enrolled !== !!b.row.enrolled || b.by !== b.row.employee_share_paid_by;
    }
    /* Retained only so the old save/validation branches below are harmless;
       opening balances are no longer loaded, displayed or written here. */
    var opens = [];
    function dirty() {
      return Object.keys(changed).length > 0 || comps.some(compDirty) ||
             (!isNew && Object.keys(bp).some(bpDirty));
    }
    function touched() {
      save.disabled = !dirty() || S.online() === false;
      save.hidden = !dirty();
      msg.className = 'pr-msg';
      msg.textContent = dirty() ? 'Unsaved changes.' : '';
      redrawHeader();
      redrawBases();
    }
    function setField(col, val) {
      var was = row[col] == null ? '' : String(row[col]);
      var now = val == null ? '' : String(val);
      if (!isNew && was === now) delete changed[col]; else changed[col] = val;
      if (col === 'start_date') drawComps();     // the "from" dates follow it
      touched();
    }
    function cur(col) { return col in changed ? changed[col] : row[col]; }

    var lk = { set: function () {} };
    var det = el('div', 'pr-card');
    lay.appendChild(det);

    /* header */
    var dh = el('div', 'pr-dh');
    det.appendChild(dh);
    var edBtn = el('button', 'pr-btn2', 'Edit');
    edBtn.type = 'button';
    edBtn.title = 'Employee ID, name, position, department, end date, active';
    edBtn.addEventListener('click', function () {
      editing = true; who.hidden = false; lk.set(false); edBtn.hidden = true; save.hidden = !dirty(); redrawHeader();
    });
    var actBox = el('div', 'act');           // Edit and Save changes share this spot: right end of the Back row
    actBox.appendChild(edBtn); actBox.appendChild(save);
    if (view === 'edit') top.appendChild(actBox);
    /* DELETE (admin, 2026-10-29). A member can only set the employee inactive.
       The warning is built from the runs the employee is on. Paid -> refused;
       outputs -> the server refuses until that run is reopened or reset;
       draft/review -> allowed, the employee's lines on those runs go with it.
       The proxy forwards the delete only for payrolladmin. */
    if (view === 'edit' && !isNew) {
      S.isAdmin().then(function (admin) {
        /* Only an INACTIVE employee can be deleted: an active
           one has to be switched inactive and saved first. The saved state counts. */
        if (!admin || row.active) return;
        var del = el('button', 'pr-btn2 pr-danger', 'Delete');
        del.type = 'button';
        del.title = 'Admin: delete this inactive employee (not possible when on a paid run)';
        actBox.appendChild(del);
        del.addEventListener('click', function () {
          del.disabled = true;
          Promise.all([store().list('app/payroll/run_lines'), store().list('app/payroll/runs')]).then(function (r) {
            var byRun = {};
            r[1].rows.forEach(function (x) { byRun[x.id] = x; });
            var n = { draft: 0, review: 0, outputs: 0, paid: 0 };
            r[0].rows.forEach(function (l) {
              if (l.payroll_employee_id !== row.id) return;
              var run = byRun[l.run_id];
              if (!run) return;
              var st = run.status === 'locked' ? 'outputs' : run.status;
              if (n[st] !== undefined) n[st]++;
            });
            del.disabled = false;
            var counts = [['On draft or review runs', String(n.draft + n.review)], ['On runs with files made (outputs)', String(n.outputs)], ['On paid runs', String(n.paid)]];
            if (n.paid) {
              return U.confirm({ icon: '!', kicker: 'DELETE · ' + String(row.employee_code || '').toUpperCase(), title: 'This employee cannot be deleted',
                rows: counts, note: 'The employee is on a paid payroll run, which can never be changed. Keep the employee inactive instead.',
                ok: 'OK', cancel: 'Close' });
            }
            if (n.outputs) {
              return U.confirm({ icon: '!', kicker: 'DELETE · ' + String(row.employee_code || '').toUpperCase(), title: 'Reopen or reset the run first',
                rows: counts, note: 'The employee is on a run whose payslips or Mandiri file are already made. Reopen that run to Draft first (Reopen), then delete the employee.',
                ok: 'OK', cancel: 'Close' });
            }
            return U.confirm({
              icon: '!', kicker: 'DELETE · ' + String(row.employee_code || '').toUpperCase(), title: 'Delete this employee?',
              rows: counts,
              note: 'The employee, salary components, BPJS setup and PPh 21 opening balances are deleted' +
                    (n.draft + n.review ? ', and the employee is removed from those unfinished runs (recalculate them after).' : '.') +
                    ' This cannot be undone. Setting the employee inactive keeps everything.',
              typeToConfirm: row.employee_code || 'DELETE', ok: 'Delete employee', cancel: 'Cancel'
            }).then(function (ok) {
              if (!ok) return;
              del.disabled = true;
              return store().del('app/payroll/employees', row.id).then(function () {
                selectedId = null; pointedId = null; view = 'list'; editing = false;
                var pane = S.pane(); U.clear(pane); mount(pane);
              });
            });
          }).then(null, function (err) {
            del.disabled = false;
            U.confirm({ icon: '!', kicker: 'DELETE', title: 'Not deleted', note: U.errText(err), ok: 'OK', cancel: 'Close' });
          });
        });
      });
    }
    function redrawHeader() {
      U.clear(dh);
      var name = cur('full_name') || (isNew ? 'New employee' : '');
      dh.appendChild(el('span', 'pr-av', U.initials(name)));
      var m = el('div');
      m.appendChild(el('b', null, name));
      m.appendChild(el('span', null, [cur('employee_code'), cur('position'),
        cur('start_date') ? 'since ' + U.dmy(cur('start_date')) : ''].filter(Boolean).join(' · ') || '—'));
      dh.appendChild(m);
      var st = el('div', 'st');
      var chips = el('div', 'chips');
      chips.appendChild(el('span', 'pr-chip ' + (cur('active') ? 'g' : 'n'), cur('active') ? 'ACTIVE' : 'INACTIVE'));
      if (cur('department')) chips.appendChild(el('span', 'pr-chip n', String(cur('department')).toUpperCase()));
      if (cur('employment_type')) chips.appendChild(el('span', 'pr-chip n', String(cur('employment_type'))));
      if (cur('rate_type') === 'daily') chips.appendChild(el('span', 'pr-chip n', 'DAILY'));
      st.appendChild(chips);
      dh.appendChild(st);
    }

    /* who: the fields the header shows (open for a new employee) */
    /* Hidden for an existing employee until Edit is pressed — the render
       shows these in the header only. Open for a new one. */
    var who = el('div', 'pr-box pr-who');
    who.hidden = !isNew;
    var wh = el('h4');
    wh.appendChild(el('span', null, 'EMPLOYEE'));
    var act = el('div', 'pr-tog');
    act.appendChild(el('span', null, 'Active — on the payroll'));
    act.appendChild(switchFor(function () { return !!cur('active'); },
                              function (v) { setField('active', v); }));
    wh.appendChild(act);
    who.appendChild(wh);
    /* Scan KTP / NPWP (docscan.js): fills NIK, NPWP and the name for the
       user to check — read in the browser, saved only with "Save changes". */
    if (window.GKI.docscan) {
      var scan = el('div', 'pr-scan');
      var scanMsg = el('span', 'pr-scanmsg', 'KTP fills name and NIK, NPWP fills the NPWP — from a photo or PDF of the card. Check them after.');
      [['ktp', 'Scan KTP'], ['npwp', 'Scan NPWP']].forEach(function (k) {
        var fi = el('input'); fi.type = 'file'; fi.accept = 'application/pdf,image/*'; fi.hidden = true;
        var b = el('button', 'pr-btn2', k[1]); b.type = 'button';
        b.addEventListener('click', function () { fi.click(); });
        fi.addEventListener('change', function () {
          var file = fi.files && fi.files[0];
          fi.value = '';
          if (!file) return;
          scanMsg.className = 'pr-scanmsg'; scanMsg.textContent = 'Reading…';
          window.GKI.docscan.read(file, k[0], function (step) { scanMsg.textContent = step; }).then(function (res) {
            var F = res.fields, put = [];
            if (F.nik) { setField('nik', F.nik); put.push('nik'); }
            if (F.npwp) { setField('npwp', F.npwp); put.push('npwp'); }
            if (F.full_name && (k[0] === 'ktp' || !String(cur('full_name') || '').trim())) { setField('full_name', F.full_name); put.push('full_name'); }
            var UNSURE = { NIK: 'nik', NPWP: 'npwp', name: 'full_name' }, uns = (res.unsure || []).map(function (l) { return UNSURE[l]; });
            put.forEach(function (col) {
              var n = det.querySelector('input[data-col="' + col + '"]');
              if (n) { n.value = cur(col) || ''; n.classList.toggle('pr-invalid', uns.indexOf(col) !== -1); }   // orange = check closely
            });
            var how = res.method === 'ocr' ? 'Read by OCR' : 'Read from the PDF';
            scanMsg.className = 'pr-scanmsg ' + (res.missing.length ? 'bad' : 'ok');
            scanMsg.textContent = how + (res.missing.length ? '. Not found: ' + res.missing.join(', ') + ' — type them in.' : '.') +
              (res.unsure && res.unsure.length ? ' Read clearly only once — check closely: ' + res.unsure.join(', ') + '.' : '') +
              ' Check every figure against the card before saving.';
            touched();
          }, function (err) {
            scanMsg.className = 'pr-scanmsg bad';
            scanMsg.textContent = (err && err.message) || 'The card could not be read.';
          });
        });
        scan.appendChild(b); scan.appendChild(fi);
      });
      scan.appendChild(scanMsg);
      who.appendChild(scan);
    }
    var g5 = el('div', 'pr-g5');
    g5.appendChild(input('EMPLOYEE ID', 'employee_code', 'EMP-0012', true));
    g5.appendChild(input('NAME', 'full_name', 'Full name'));
    g5.appendChild(peopleDept());
    g5.appendChild(peoplePos());
    g5.appendChild(dateInput('START DATE', 'start_date'));
    g5.appendChild(dateInput('END DATE', 'end_date'));
    who.appendChild(g5);
    det.appendChild(who);

    var sub = el('div', 'pr-sub');
    det.appendChild(sub);

    /* identity & tax */
    var idb = box('IDENTITY & TAX', 'PPh 21 TER');
    var g = el('div', 'pr-g2');
    g.appendChild(sensitive('NIK', 'nik', '16 digits', true));
    g.appendChild(sensitive('NPWP / NIK-NPWP', 'npwp', 'same as NIK'));
    var pf = el('div', 'pr-f');
    pf.appendChild(el('label', null, 'PTKP STATUS'));
    var ps = el('select', 'pr-mono');
    PTKP.forEach(function (p) {
      var o = el('option', null, p + ' · TER ' + TER[p]);
      o.value = p;
      if (p === cur('ptkp_status')) o.selected = true;
      ps.appendChild(o);
    });
    ps.setAttribute('data-col', 'ptkp_status');
    ps.addEventListener('change', function () { setField('ptkp_status', ps.value); });
    pf.appendChild(ps);
    g.appendChild(pf);
    /* CONTRACT AND PAY BASIS. employment_type is
       optional (NULL = not set); rate_type decides how Gaji Pokok is read:
       a month, or a day x Hari kerja on the run (api/calc). */
    function pick(label, col, opts, onChange) {
      var f = el('div', 'pr-f');
      f.appendChild(el('label', null, label));
      var s = el('select', 'pr-mono');
      var v = cur(col) == null ? '' : String(cur(col));
      opts.forEach(function (o) {
        var op = el('option', null, o[1]); op.value = o[0];
        if (o[0] === v) op.selected = true;
        s.appendChild(op);
      });
      s.setAttribute('data-col', col);
      s.addEventListener('change', function () { setField(col, s.value === '' ? null : s.value); if (onChange) onChange(); });
      f.appendChild(s);
      return f;
    }
    g.appendChild(pick('EMPLOYMENT TYPE', 'employment_type',
      [['', '— not set'], ['PKWT', 'PKWT · fixed-term'], ['PKWTT', 'PKWTT · permanent']], redrawHeader));
    g.appendChild(pick('PAID', 'rate_type',
      [['monthly', 'Monthly'], ['daily', 'Daily · Gaji Pokok per day']], function () { drawComps(); redrawBases(); redrawHeader(); }));
    idb.appendChild(g);
    sub.appendChild(idb);

    /* bank */
    var bk = box('BANK', null);
    var bh = el('span');
    bk.querySelector('h4').appendChild(bh);
    function redrawBank() {
      U.clear(bh);
      var code = String(cur('bank_code') || '').toUpperCase(), bk = banks()[code];
      if (bk) { bh.appendChild(el('span', 'pr-dot')); bh.appendChild(document.createTextNode(bk.L + ' · ' + bk.J)); }
      else bh.appendChild(document.createTextNode((code || '—') + ' · not set up for the Mandiri file'));
    }
    var g2 = el('div', 'pr-g2');
    g2.appendChild(sensitive('ACCOUNT NO.', 'bank_account', 'Mandiri 13 · BRI 15 digits', true));
    g2.appendChild(input('NAME ON ACCOUNT', 'bank_account_name', 'AS ON THE BANK BOOK', true));
    var bc = el('div', 'pr-f');
    bc.appendChild(el('label', null, lab('BANK', 'bank_code')));
    var bank = el('select', 'pr-mono');
    bank.setAttribute('data-col', 'bank_code');
    /* The banks the Mandiri file can pay (mandiri.js BANKS, from the real file). */
    var curCode = String(cur('bank_code') || '').toUpperCase();
    Object.keys(banks()).forEach(function (k) {
      var o = el('option', null, banks()[k].label + (banks()[k].J === 'IBU' ? ' · Mandiri → Mandiri' : ' · transfer to another bank'));
      o.value = k; o.selected = curCode === k;
      bank.appendChild(o);
    });
    if (curCode && !banks()[curCode]) {              // a code saved before — shown, not silently changed
      var oo = el('option', null, curCode + ' · not set up'); oo.value = curCode; oo.selected = true; bank.appendChild(oo);
    }
    bank.addEventListener('change', function () { setField('bank_code', bank.value); redrawBank(); });
    bc.appendChild(bank);
    g2.appendChild(bc);
    g2.appendChild(input('BRANCH CITY', 'bank_branch_city', 'e.g. Lombok Tengah'));
    var full = el('div', 'pr-full');
    full.appendChild(input('EMAIL · BANK CONFIRMATION', 'email', 'name@email.com', false, 'email'));
    g2.appendChild(full);
    bk.appendChild(g2);
    sub.appendChild(bk);
    redrawBank();

    /* salary, monthly */
    var sal = box('SALARY · MONTHLY', 'IDR');
    var salTitle = sal.querySelector('h4 span');
    sal.setAttribute('data-col', 'salary');
    var compList = el('div');
    sal.appendChild(compList);
    var totLine = el('div', 'pr-comp tot');
    function drawComps() {
      U.clear(compList);
      var isDaily = cur('rate_type') === 'daily';
      salTitle.textContent = isDaily ? 'SALARY · DAILY (GAJI POKOK PER DAY)' : 'SALARY · MONTHLY';
      comps.forEach(function (x) {
        if (x.deleted) return;
        var r = el('div', 'pr-comp');
        if (x.row) {
          r.appendChild(el('span', 'nm', x.name));
        } else {
          var ni = el('input', 'nmi');
          ni.placeholder = 'Component name';
          ni.value = x.name || '';
          ni.addEventListener('input', function () { x.name = ni.value; touched(); });
          r.appendChild(ni);
        }
        var fx = el('button', 'fx' + (x.is_fixed ? ' on' : ''), 'FIXED');
        fx.type = 'button';
        fx.title = 'Fixed: counts in gross fixed and, if the client says so, in the Kesehatan base';
        fx.addEventListener('click', function () { x.is_fixed = !x.is_fixed; fx.classList.toggle('on', x.is_fixed); touched(); redrawTotal(); redrawBases(); });
        if (x.name !== GAJI_POKOK) r.appendChild(fx);
        if (x.row) r.appendChild(el('i', null, 'from ' + U.dmy(fromOf(x))));
        if (isDaily && x.name === GAJI_POKOK) r.appendChild(el('i', null, 'per day'));
        var ai = el('input');
        U.liveMoney(ai);
        ai.value = x.amount === null ? '' : U.money(x.amount);
        ai.addEventListener('input', function () {
          var v = U.parseMoney(ai.value);
          x.amount = v; x.bad = (v !== null && isNaN(v));
          touched();
          redrawTotal(); redrawBases();        // Gross fixed follows the typing
        });
        ai.addEventListener('blur', function () { if (!x.bad && x.amount !== null) ai.value = U.money(x.amount); });
        r.appendChild(ai);
        var del = el('button', 'x', '×');
        del.type = 'button';
        del.title = 'Remove this component';
        del.addEventListener('click', function () {
          if (x.row) x.deleted = true; else comps.splice(comps.indexOf(x), 1);
          drawComps(); touched();
        });
        r.appendChild(del);
        compList.appendChild(r);
      });
      redrawTotal();
    }
    function redrawTotal() {
      U.clear(totLine);
      totLine.appendChild(document.createTextNode('Gross fixed'));
      totLine.appendChild(el('b', null, U.money(grossFixed(comps.filter(function (x) { return !x.bad; })))));
    }
    sal.appendChild(totLine);
    var addc = el('button', 'pr-link', '+ Add component');
    addc.type = 'button';
    addc.addEventListener('click', function () {
      comps.push({ row: null, name: '', amount: null, is_fixed: true, effective_from: '', deleted: false });
      drawComps();
    });
    sal.appendChild(addc);
    sub.appendChild(sal);
    drawComps();

    /* BPJS per programme */
    var bpb = box('BPJS', 'employee share paid by');
    var bph = el('div', 'pr-bph');
    ['PROGRAMME', 'ENROLLED', 'EMPLOYEE SHARE'].forEach(function (t) { bph.appendChild(el('span', null, t)); });
    bpb.appendChild(bph);
    function rate(p, side) {
      var rs = D.rates.filter(function (x) { return x.programme === p && x.side === side && U.inForce(x, on); })
                      .sort(function (a, b) { return String(b.effective_from).localeCompare(String(a.effective_from)); });
      return rs[0] || null;
    }
    PROGRAMMES.forEach(function (P) {
      var line = el('div', 'pr-bp');
      var lab = el('span', null, P.label + ' ');
      var txt;
      if (P.p === 'jkk') txt = pct(D.client.settings.jkk_rate);
      else {
        var er = rate(P.p, 'employer'), ee = rate(P.p, 'employee');
        txt = er ? pct(er.rate) + (ee ? ' + ' + pct(ee.rate) : '') : 'no rate on record today';
      }
      lab.appendChild(el('i', null, txt));
      line.appendChild(lab);
      var b = bp[P.p];
      line.appendChild(switchFor(function () { return b.enrolled; },
                                 function (v) { b.enrolled = v; touched(); }));
      if (P.share) {
        var seg = el('div', 'pr-seg sm');
        ['employee', 'employer'].forEach(function (who) {
          var s = el('button', b.by === who ? 'on' : '', who === 'employee' ? 'Employee' : 'Employer');
          s.type = 'button';
          s.addEventListener('click', function () {
            b.by = who;
            Array.prototype.forEach.call(seg.children, function (k) { k.classList.remove('on'); });
            s.classList.add('on');
            touched();
          });
          seg.appendChild(s);
        });
        line.appendChild(seg);
      } else {
        line.appendChild(el('i', null, 'employer only'));
      }
      bpb.appendChild(line);
    });
    var bases = el('div', 'pr-base');
    bpb.appendChild(bases);
    sub.appendChild(bpb);

    /* Retired PPh 21 opening balance UI: the data is left untouched, but this
       screen no longer reads, shows or writes it. */
    if (false) {
    var ob = box('PPh 21 · OPENING BALANCE', 'year-end only');
    ob.setAttribute('data-col', 'openings');
    var obList = el('div');
    ob.appendChild(obList);
    var KINDS = { before_payroll: 'Before PAYROLL (GajiHub)', previous_employer: 'Previous employer (A1)' };
    function mon(k) { return BULAN3[k - 1]; }
    function drawOpens() {
      U.clear(obList);
      var shown = opens.filter(function (o) { return !o.deleted; });
      if (!shown.length) obList.appendChild(el('p', 'pr-mut pr-obnone',
        'None. Needed only for months this employee worked this year before PAYROLL, or with another employer.'));
      shown.forEach(function (o) {
        var r = el('div', 'pr-ob');
        if (o.row) {
          var x = o.row;
          var t = el('div', 'nm');
          t.appendChild(el('b', null, KINDS[x.kind] || x.kind));
          t.appendChild(el('span', null, mon(x.month_from) + '–' + mon(x.month_to) + ' ' + x.tax_year +
            (x.a1_number ? ' · A1 ' + x.a1_number : '')));
          var st0 = startNow();
          if (x.kind === 'before_payroll' && st0 && Number(st0.slice(0, 4)) === Number(x.tax_year) &&
              Number(x.month_from) < Number(st0.slice(5, 7))) {
            t.appendChild(el('em', 'pr-obbad', 'Starts before the start date (' + U.dmy(st0) + ') — the year-end PPh 21 refuses it. ' +
              'Remove it (×) and add it again with the right months.'));
          }
          r.appendChild(t);
          var f = el('div', 'amts');
          f.appendChild(el('span', null, 'Gross ' + U.money(x.gross)));
          if (x.kind === 'previous_employer') f.appendChild(el('span', null, 'Biaya jab. ' + U.money(x.occupational_cost)));
          f.appendChild(el('span', null, 'JHT+JP ' + U.money(x.pension_contrib)));
          f.appendChild(el('span', null, 'PPh 21 ' + U.money(x.pph21_withheld)));
          r.appendChild(f);
        } else {
          var g = el('div', 'pr-g4');
          function sel(label, opts, key) {
            var ff = el('div', 'pr-f'); ff.appendChild(el('label', null, label));
            var se = el('select', 'pr-mono');
            opts.forEach(function (op) { var oo = el('option', null, op[1]); oo.value = op[0]; if (String(op[0]) === String(o[key])) oo.selected = true; se.appendChild(oo); });
            se.addEventListener('change', function () { o[key] = se.value; if (key === 'kind') drawOpens(); touched(); });
            ff.appendChild(se); return ff;
          }
          function amt(label, key) {
            var ff = el('div', 'pr-f'); ff.appendChild(el('label', null, label));
            var ii = U.liveMoney(el('input', 'pr-mono'));
            ii.placeholder = '0';
            ii.value = o[key] === null || o[key] === undefined ? '' : U.money(o[key]);
            ii.addEventListener('input', function () { o[key] = U.parseMoney(ii.value); touched(); });
            ff.appendChild(ii); return ff;
          }
          var months = BULAN3.map(function (b, i) { return [i + 1, b]; });
          g.appendChild(sel('KIND', [['before_payroll', KINDS.before_payroll], ['previous_employer', KINDS.previous_employer]], 'kind'));
          g.appendChild(sel('YEAR', [[o.tax_year, String(o.tax_year)], [o.tax_year - 1, String(o.tax_year - 1)]], 'tax_year'));
          g.appendChild(sel('FROM', months, 'month_from'));
          g.appendChild(sel('TO', months, 'month_to'));
          g.appendChild(amt('GROSS (BRUTO)', 'gross'));
          if (o.kind === 'previous_employer') g.appendChild(amt('BIAYA JABATAN (A1)', 'occupational_cost'));
          g.appendChild(amt('EMPLOYEE JHT + JP', 'pension_contrib'));
          g.appendChild(amt('PPh 21 WITHHELD', 'pph21_withheld'));
          if (o.kind === 'previous_employer') {
            var fa = el('div', 'pr-f'); fa.appendChild(el('label', null, 'A1 NUMBER · OPTIONAL'));
            var ia = el('input', 'pr-mono'); ia.value = o.a1_number || '';
            ia.addEventListener('input', function () { o.a1_number = ia.value.trim() || null; touched(); });
            fa.appendChild(ia); g.appendChild(fa);
            /* Scan the A1 (docscan.js): read in the browser, fills the fields
               above for the user to check — never saved by itself. */
            if (window.GKI.docscan) {
              var sc = el('div', 'pr-f pr-a1scan');
              sc.appendChild(el('label', null, 'SCAN THE A1 · PDF / PHOTO'));
              var fi = el('input'); fi.type = 'file'; fi.accept = 'application/pdf,image/*'; fi.hidden = true;
              var sb = el('button', 'pr-btn2', o._busy ? 'Reading…' : 'Choose file');
              sb.type = 'button'; sb.disabled = !!o._busy;
              sb.addEventListener('click', function () { fi.click(); });
              fi.addEventListener('change', function () {
                var file = fi.files && fi.files[0];
                if (!file) return;
                o._busy = true; o._scan = { cls: '', text: 'Reading…' }; drawOpens();
                window.GKI.docscan.read(file, 'a1', function (step) { o._scan = { cls: '', text: step }; drawOpens(); })
                  .then(function (res) {
                    var F = res.fields;
                    ['gross', 'occupational_cost', 'pension_contrib', 'pph21_withheld', 'month_from', 'month_to', 'a1_number']
                      .forEach(function (k) { if (F[k] !== null) o[k] = F[k]; });
                    if (F.tax_year !== null) o.tax_year = F.tax_year;
                    o._scan = res.missing.length
                      ? { cls: 'bad', text: (res.method === 'ocr' ? 'Read by OCR. ' : 'Read from the PDF. ') +
                          'Not found: ' + res.missing.join(', ') + ' — type them in. Check every figure against the A1 before saving.' }
                      : { cls: 'ok', text: (res.method === 'ocr' ? 'Read by OCR' : 'Read from the PDF') +
                          ' — check every figure against the A1 before saving.' };
                  }, function (err) { o._scan = { cls: 'bad', text: (err && err.message) || 'The A1 could not be read.' }; })
                  .then(function () { o._busy = false; drawOpens(); touched(); });
              });
              sc.appendChild(sb); sc.appendChild(fi);
              g.appendChild(sc);
            }
          }
          r.appendChild(g);
          if (o._scan) {
            var sm = el('p', 'pr-msg pr-a1msg ' + (o._scan.cls || ''), o._scan.text);
            g.appendChild(sm);
          }
        }
        var del = el('button', 'x', '×');
        del.type = 'button';
        del.title = 'Remove this opening balance';
        del.addEventListener('click', function () {
          if (o.row) o.deleted = true; else opens.splice(opens.indexOf(o), 1);
          drawOpens(); touched();
        });
        r.appendChild(del);
        obList.appendChild(r);
      });
    }
    var addo = el('button', 'pr-link', '+ Add opening balance');
    addo.type = 'button';
    addo.addEventListener('click', function () {
      var y = Number(U.today().slice(0, 4));
      /* "before PAYROLL" starts at the start month when the employee joined this year */
      var st = startNow(), m0 = st && Number(st.slice(0, 4)) === y ? Number(st.slice(5, 7)) : 1;
      opens.push({ row: null, deleted: false, kind: 'before_payroll', tax_year: y, month_from: m0,
                   month_to: Math.max(m0, Number(U.today().slice(5, 7)) - 1),
                   gross: null, occupational_cost: null, pension_contrib: 0, pph21_withheld: null, a1_number: null });
      drawOpens(); touched();
    });
    ob.appendChild(addo);
    sub.appendChild(ob); drawOpens();     // also for a new employee — optional, saved after the employee row
    }

    /* The bases, as a preview of the rule (plan §3). api/calc computes. */
    function redrawBases() {
      U.clear(bases);
      bases.className = 'pr-base';
      var region = D.client.settings.bpjs_floor_region;
      var w = D.wages.filter(function (x) { return x.region === region && U.inForce(x, on); })
                     .sort(function (a, b) { return String(b.effective_from).localeCompare(String(a.effective_from)); })[0];
      var live = comps.filter(function (x) { return !x.deleted && !x.bad; });
      var gp = live.filter(function (x) { return x.name === GAJI_POKOK; });
      if (gp.length !== 1) {
        bases.className = 'pr-base bad';
        bases.textContent = gp.length ? 'Two components are named Gaji Pokok — the calculation will refuse.'
                                      : 'No component named "Gaji Pokok" — the calculation will refuse (plan F6).';
        return;
      }
      if (!w) {
        bases.className = 'pr-base bad';
        bases.textContent = 'No minimum wage on record for ' + region + ' today — the calculation will refuse.';
        return;
      }
      if (cur('rate_type') === 'daily') {
        bases.textContent = 'DAILY · Gaji Pokok ' + U.money(gp[0].amount || 0) + ' a day × Hari kerja typed on the run. ' +
          'The BPJS bases and PPh 21 (TER harian) are computed there; a run line without Hari kerja is refused.';
        return;
      }
      var GP = gp[0].amount || 0, UMP = U.num(w.amount);
      var tk = Math.max(GP, UMP);
      var others = live.filter(function (x) { return x.name !== GAJI_POKOK && x.is_fixed; })
                       .reduce(function (s, x) { return s + (x.amount || 0); }, 0);
      var incl = !!D.client.settings.kesehatan_base_includes_fixed;
      var kes = Math.max(GP + (incl ? others : 0), UMP);
      var kr = rate('kesehatan', 'employer');
      var cap = kr && U.num(kr.wage_cap);
      if (cap !== null && cap !== undefined && kes > cap) kes = cap;
      var rname = region === 'UMP_NTB' ? 'UMP NTB' : region;
      bases.appendChild(document.createTextNode('TK BASE · max(Gaji Pokok, ' + rname + ') = ' + U.money(tk)));
      bases.appendChild(el('br'));
      bases.appendChild(document.createTextNode('KES BASE · Gaji Pokok' + (incl ? ' + fixed' : '') + ' = ' + U.money(kes)));
    }

    redrawHeader();
    redrawBases();
    if (isNew) who.querySelector('input').focus();

    /* ── save ─────────────────────────────────────────────────────────── */
    save.addEventListener('click', function () {
      var problems = check();
      markInvalid(problems);
      if (problems.length) {
        msg.className = 'pr-msg bad';
        msg.textContent = '';
        msg.appendChild(el('b', null, 'Complete ' + problems.length + ' thing' + (problems.length === 1 ? '' : 's') + ' before saving:'));
        var ul = el('ul', 'pr-vlist');
        problems.forEach(function (p) { ul.appendChild(el('li', null, p.text)); });
        msg.appendChild(ul);
        if (!isNew && who.hidden && problems.some(function (p) { return WHO_COLS.indexOf(p.col) !== -1; })) { who.hidden = false; redrawHeader(); }
        if (msg.scrollIntoView) msg.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      save.disabled = true;
      msg.className = 'pr-msg';
      msg.textContent = 'Saving…';
      var s = store();
      var empId = isNew ? null : row.id;

      var value = {};
      Object.keys(changed).forEach(function (k) {
        var v = changed[k];
        if (typeof v === 'string') {
          v = v.trim();
          if (k === 'bank_code' || k === 'bank_account_name') v = v.toUpperCase();
          if (k === 'nik' || k === 'bank_account') v = v.replace(/\s/g, '');
          if (v === '') v = null;
        }
        value[k] = v;
      });
      var first;
      if (isNew) {
        value.payroll_client_id = D.client.id;
        first = s.save('app/payroll/employees', null, value);
      } else if (Object.keys(value).length) {
        value.rev = row.rev;
        first = s.save('app/payroll/employees', row.id, value);
      } else {
        first = Promise.resolve(row);
      }

      first.then(function (saved) {
        empId = saved.id;
        selectedId = empId;
        var steps = [];
        var startFrom = String(cur('start_date') || '').slice(0, 10);
        comps.forEach(function (x) {
          if (x.row && x.deleted) { steps.push(function () { return s.del('app/payroll/components', x.row.id); }); return; }
          if (x.deleted || !compDirty(x)) return;
          if (x.row) {
            var v = { rev: x.row.rev };
            if (x.name !== x.row.name) v.name = x.name.trim();
            if (x.amount !== U.num(x.row.amount)) v.amount = x.amount;
            if (x.is_fixed !== !!x.row.is_fixed) v.is_fixed = x.is_fixed;
            if (fromOf(x) !== x.effective_from) v.effective_from = fromOf(x);
            steps.push(function () { return s.save('app/payroll/components', x.row.id, v); });
          } else {
            /* A new component starts on the start date for a new employee,
               otherwise on the 1st of this month (WITA). */
            var from = isNew && startFrom ? startFrom : firstOfMonth();
            if (startFrom && from < startFrom) from = startFrom;   // never before the start date
            steps.push(function () {
              return s.save('app/payroll/components', null, {
                payroll_employee_id: empId, name: x.name.trim(), amount: x.amount,
                is_fixed: x.is_fixed, effective_from: from
              });
            });
          }
        });
        opens.forEach(function (o) {
          if (o.row && o.deleted) { steps.push(function () { return s.del('app/payroll/tax_openings', o.row.id); }); return; }
          if (o.row || o.deleted) return;
          steps.push(function () {
            return s.save('app/payroll/tax_openings', null, {
              payroll_employee_id: empId, tax_year: Number(o.tax_year), kind: o.kind,
              month_from: Number(o.month_from), month_to: Number(o.month_to),
              gross: o.gross, occupational_cost: o.kind === 'previous_employer' ? o.occupational_cost : null,
              pension_contrib: o.pension_contrib || 0, pph21_withheld: o.pph21_withheld,
              a1_number: o.kind === 'previous_employer' ? o.a1_number : null
            });
          });
        });
        Object.keys(bp).forEach(function (k) {
          var b = bp[k];
          if (b.row && !bpDirty(k)) return;
          if (b.row) {
            steps.push(function () {
              return s.save('app/payroll/employee_bpjs', b.row.id,
                { rev: b.row.rev, enrolled: b.enrolled, employee_share_paid_by: b.by });
            });
          } else {
            steps.push(function () {
              return s.save('app/payroll/employee_bpjs', null,
                { payroll_employee_id: empId, programme: k, enrolled: b.enrolled, employee_share_paid_by: b.by });
            });
          }
        });
        /* One at a time, in order: the first refusal stops the rest and is
           shown as the service worded it. */
        return steps.reduce(function (p, f) { return p.then(f); }, Promise.resolve());
      }).then(function () {
        view = 'list';
        var pane = S.pane();
        U.clear(pane);
        mount(pane);
      }).catch(function (err) {
        var text = (err && err.status === 409)
          ? 'Someone else saved this employee since you opened it. Reload the page and make the change again.'
          : U.errText(err);
        if (isNew && empId) {
          /* The employee row exists now: re-open it as an existing employee,
             so a second Save updates it instead of creating it twice. */
          selectedId = empId;
          pendingMsg = text + ' The employee was created; check the salary and BPJS below and save again.';
          var pane = S.pane();
          U.clear(pane);
          mount(pane);
          return;
        }
        msg.className = 'pr-msg bad';
        msg.textContent = text;
        save.disabled = false; save.hidden = false;
      });
    });

    /* Checks the service would also refuse, worded before the round trip. */
    /* Everything the Mandiri file and the payslip need, checked together before a save.
       Returns [{col, text}] — empty = may save. */
    var WHO_COLS = ['employee_code', 'full_name', 'position', 'end_date'];
    function markInvalid(problems) {
      var bad = {};
      problems.forEach(function (p) { bad[p.col] = true; });
      Array.prototype.forEach.call(det.querySelectorAll('[data-col]'), function (n) {
        n.classList.toggle('pr-invalid', !!bad[n.getAttribute('data-col')]);
      });
    }
    function check() {
      var out = [];
      function need(col, text) { if (!String(cur(col) == null ? '' : cur(col)).trim()) out.push({ col: col, text: text }); }
      need('employee_code', 'Employee ID is required.');
      need('full_name', 'Name is required.');
      need('position', 'Position is required.');
      Object.keys(badDate).forEach(function (c) { out.push({ col: c, text: 'Dates are DD/MM/YYYY, e.g. 01/10/2026.' }); });
      need('start_date', 'Start date is required.');
      if (cur('start_date') && cur('end_date') && String(cur('end_date')) < String(cur('start_date'))) {
        out.push({ col: 'end_date', text: 'An end date cannot fall before the start date.' });
      }
      need('ptkp_status', 'PTKP status is required.');
      var nik = String(cur('nik') || '').replace(/\s/g, '');
      if (!nik) out.push({ col: 'nik', text: 'NIK is required.' });
      else if (!/^\d{16}$/.test(nik)) out.push({ col: 'nik', text: 'NIK is 16 digits.' });
      need('bank_code', 'Bank is required.');
      var acct = String(cur('bank_account') || '').replace(/\s/g, '');
      if (!acct) out.push({ col: 'bank_account', text: 'Account number is required.' });
      else {
        var bkv = banks()[String(cur('bank_code') || '').toUpperCase()];
        if (!bkv) out.push({ col: 'bank_code', text: 'Choose one of the listed banks — the Mandiri file pays those only.' });
        else if (!new RegExp('^\\d{' + bkv.len + '}$').test(acct)) {
          out.push({ col: 'bank_account', text: 'A ' + bkv.label + ' account number is ' + bkv.len + ' digits.' });
        }
      }
      need('bank_account_name', 'Name on account is required.');
      need('bank_branch_city', 'Branch city is required (Mandiri file, column M).');
      var em = String(cur('email') || '').trim();
      if (!em) out.push({ col: 'email', text: 'Email is required (Mandiri transfer confirmation, column R).' });
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) out.push({ col: 'email', text: 'That email address does not look complete.' });
      var live = comps.filter(function (x) { return !x.deleted; });
      var gp = live.filter(function (x) { return String(x.name || '').trim() === GAJI_POKOK; })[0];
      if (!gp || !(gp.amount > 0)) out.push({ col: 'salary', text: 'Salary needs a "' + GAJI_POKOK + '" component with an amount above 0.' });
      live.forEach(function (x) {
        if (x.bad) out.push({ col: 'salary', text: 'A component amount must be a whole number of rupiah.' });
        else if (!String(x.name || '').trim()) out.push({ col: 'salary', text: 'A salary component needs a name.' });
        else if (x.amount === null) out.push({ col: 'salary', text: 'Component "' + x.name + '" needs a monthly amount.' });
      });
      opens.forEach(function (o) {
        if (o.row || o.deleted) return;
        var bad = function (v) { return v === null || v === undefined || isNaN(v); };
        if (Number(o.month_to) < Number(o.month_from)) out.push({ col: 'openings', text: 'An opening balance ends before it starts.' });
        var st = startNow();
        if (o.kind === 'before_payroll' && st && Number(st.slice(0, 4)) === Number(o.tax_year) &&
            Number(o.month_from) < Number(st.slice(5, 7))) {
          out.push({ col: 'openings', text: 'A "before PAYROLL" opening balance cannot start before the start date (' +
            U.dmy(st) + '). Income from another employer goes in a "Previous employer (A1)" balance.' });
        }
        if (bad(o.gross)) out.push({ col: 'openings', text: 'An opening balance needs its gross (bruto).' });
        if (bad(o.pph21_withheld)) out.push({ col: 'openings', text: 'An opening balance needs the PPh 21 withheld (0 if none).' });
        if (bad(o.pension_contrib)) out.push({ col: 'openings', text: 'An opening balance needs the employee JHT + JP (0 if none).' });
        if (o.kind === 'previous_employer' && bad(o.occupational_cost))
          out.push({ col: 'openings', text: 'A previous employer\'s opening balance needs the biaya jabatan from its A1.' });
      });
      return out;
    }

    /* ── builders ─────────────────────────────────────────────────────── */
    function box(title, right) {
      var d = el('div', 'pr-box');
      var h4 = el('h4');
      h4.appendChild(el('span', null, title));
      if (right) h4.appendChild(el('span', null, right));
      d.appendChild(h4);
      return d;
    }
    function lab(label, col) { return label + (REQ[col] ? ' *' : ''); }
    function input(label, col, ph, mono, type) {
      var f = el('div', 'pr-f');
      f.appendChild(el('label', null, lab(label, col)));
      var i = el('input', mono ? 'pr-mono' : null);
      i.setAttribute('data-col', col);
      i.type = type || 'text';
      i.placeholder = ph || '';
      i.autocomplete = 'off';
      i.value = cur(col) == null ? '' : String(cur(col));
      i.addEventListener('input', function () { setField(col, i.value); });
      f.appendChild(i);
      return f;
    }
    /* DATES ARE TYPED DD/MM/YYYY and stored YYYY-MM-DD.
       The value is a real date (YYYY-MM-DD). The box shows DD/MM/YYYY whatever the
       computer's locale; the calendar button opens a native type=date picker that
       carries the same value. */
    function isoOf(dmyText) {
      var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(dmyText || '').trim());
      if (!m) return null;
      var d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
      if (d.getUTCFullYear() !== +m[3] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[1]) return null;
      return m[3] + '-' + m[2] + '-' + m[1];
    }
    function dateInput(label, col) {
      var f = el('div', 'pr-f');
      f.appendChild(el('label', null, lab(label, col)));
      var i = el('input', 'pr-mono');
      i.setAttribute('data-col', col);
      i.type = 'text'; i.inputMode = 'numeric'; i.maxLength = 10; i.autocomplete = 'off';
      i.placeholder = 'DD/MM/YYYY';
      i.value = cur(col) ? U.dmy(cur(col)) : '';
      i.addEventListener('input', function () {
        var d = i.value.replace(/\D/g, '').slice(0, 8);
        i.value = d.length > 4 ? d.slice(0, 2) + '/' + d.slice(2, 4) + '/' + d.slice(4)
                : d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d;
      });
      i.addEventListener('change', function () {
        var v = i.value.trim();
        if (!v) { delete badDate[col]; i.classList.remove('pr-invalid'); setField(col, null); return; }
        var iso = isoOf(v);
        if (!iso) { badDate[col] = true; i.classList.add('pr-invalid'); touched(); return; }
        delete badDate[col]; i.classList.remove('pr-invalid');
        i.value = U.dmy(iso);
        setField(col, iso);
      });
      var row = el('div', 'pr-datebox');
      row.appendChild(i);
      var pk = document.createElement('input');
      pk.type = 'date'; pk.tabIndex = -1; pk.className = 'pr-datepick';
      pk.setAttribute('aria-label', label + ' calendar');
      pk.value = cur(col) ? String(cur(col)).slice(0, 10) : '';
      pk.addEventListener('change', function () {
        if (!pk.value) return;
        delete badDate[col]; i.classList.remove('pr-invalid');
        i.value = U.dmy(pk.value);
        setField(col, pk.value);
      });
      i.addEventListener('change', function () { var iso = isoOf(i.value.trim()); pk.value = iso || ''; });
      var bt = el('button', 'pr-datebtn', '\u25A6');
      bt.type = 'button'; bt.title = 'Pick a date';
      bt.addEventListener('click', function () {
        if (pk.showPicker) { try { pk.showPicker(); return; } catch (e) { /* fall through */ } }
        pk.focus(); pk.click();
      });
      row.appendChild(bt); row.appendChild(pk);
      f.appendChild(row);
      return f;
    }
    /* DEPARTMENT AND POSITION COME FROM THE CLIENT: core/employers.departments
       and core/employer_jobs, edited on the Home screen. No free text. A
       value saved before that is not in the list is shown as such, never
       silently changed. */
    function peopleSelect(label, col, opts, emptyText, onPick) {
      var f = el('div', 'pr-f');
      f.appendChild(el('label', null, lab(label, col)));
      var s = el('select');
      s.setAttribute('data-col', col);
      var now = cur(col) == null ? '' : String(cur(col));
      var o0 = el('option', null, opts.length ? '— choose' : emptyText); o0.value = ''; s.appendChild(o0);
      if (now && opts.indexOf(now) === -1) {
        var ox = el('option', null, now + ' (not in the client\'s list)'); ox.value = now; s.appendChild(ox);
      }
      opts.forEach(function (v) { var o = el('option', null, v); o.value = v; s.appendChild(o); });
      s.value = now;
      s.disabled = !opts.length && !now;
      s.addEventListener('change', function () { setField(col, s.value || null); if (onPick) onPick(); });
      f.appendChild(s);
      return f;
    }
    function deptList() {
      return emp0 && Array.isArray(emp0.departments) ? emp0.departments.filter(Boolean) : [];
    }
    function jobList() {
      if (!emp0) return [];
      var mine = (D.jobs || []).filter(function (j) { return j.employer_id === emp0.id && j.active !== false; });
      var d = cur('department');
      var inDept = d ? mine.filter(function (j) { return j.department === d; }) : [];
      return (inDept.length ? inDept : mine).map(function (j) { return j.title; })
        .filter(function (t, k, a) { return t && a.indexOf(t) === k; }).sort();
    }
    function peopleDept() {
      return peopleSelect('DEPARTMENT', 'department', deptList(),
        emp0 ? 'No departments yet — add them on the Home screen' : 'Set up departments on the Home screen',
        function () {
          if (cur('position') && jobList().indexOf(String(cur('position'))) === -1) setField('position', null);   // a job of another department
          U.clear(posHolder); posHolder.appendChild(peoplePosField());
        });
    }
    function peoplePosField() {
      return peopleSelect('POSITION', 'position', jobList(),
        !emp0 ? 'Set up positions on the Home screen'
        : !D.jobsOk ? 'Positions could not be read' : 'No positions yet — add them on the Home screen');
    }
    function peoplePos() { U.clear(posHolder); posHolder.appendChild(peoplePosField()); return posHolder; }
    function sensitive(label, col, ph, numeric) {
      var f = el('div', 'pr-f');
      f.appendChild(el('label', null, lab(label, col)));
      var wrap = el('div', 'pr-sensitive');
      var i = el('input', 'pr-mono');
      i.setAttribute('data-col', col);
      i.autocomplete = 'off';
      i.type = 'password';
      if (numeric) i.inputMode = 'numeric';
      i.placeholder = ph || '';
      i.value = cur(col) == null ? '' : String(cur(col));
      i.addEventListener('input', function () { setField(col, i.value); });
      var eye = el('button', 'pr-eye', '◉');
      eye.type = 'button';
      eye.title = 'Show value';
      eye.setAttribute('aria-label', 'Show value');
      eye.setAttribute('aria-pressed', 'false');
      eye.addEventListener('click', function () {
        var show = i.type === 'password';
        i.type = show ? 'text' : 'password';
        eye.textContent = show ? '◉̸' : '◉';
        eye.title = show ? 'Hide value' : 'Show value';
        eye.setAttribute('aria-label', eye.title);
        eye.setAttribute('aria-pressed', String(show));
      });
      wrap.appendChild(i); wrap.appendChild(eye);
      f.appendChild(wrap);
      return f;
    }
    function switchFor(get, set) {
      var sw = el('button', 'pr-sw' + (get() ? '' : ' off'));
      sw.type = 'button';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', String(get()));
      sw.addEventListener('click', function () {
        set(!get());
        sw.classList.toggle('off', !get());
        sw.setAttribute('aria-checked', String(get()));
      });
      return sw;
    }

    drawRows();
    save.disabled = !dirty() || S.online() === false;
    save.hidden = !dirty();
    redrawHeader();
    if (!isNew && firstFrom && startNow() && firstFrom > startNow()) {
      msg.className = 'pr-msg bad';
      msg.textContent = 'The salary starts on ' + U.dmy(firstFrom) + ', after the start date ' + U.dmy(startNow()) +
        ' — the first month has no Gaji Pokok and the run refuses it. Press Edit, then Save changes: the salary moves to the start date.';
    }

    lk = GKI.lock(det, '.pr-dh');
    lk.set(!isNew && !editing);
    edBtn.hidden = isNew || editing;
    if (!isNew && !editing) { save.hidden = true; who.hidden = true; }
  }

  S.register({ id: 'employees', label: 'Employees', title: 'Employees of the client', mount: mount });
}());
