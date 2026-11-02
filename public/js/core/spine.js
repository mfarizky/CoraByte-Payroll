/**
 * CoraByte Payroll — app shell ("spine").
 *
 * Builds the chrome (header with the signed-in user, left navigation, body
 * pane, status bar), routes #/<screen> to a registered screen, and shares
 * what every screen needs:
 *   - GKI.spine.clients() / client() / setClient(): the payroll clients and
 *     the one currently selected (shared across screens)
 *   - GKI.spine.ui: DOM and formatting helpers, confirm and form dialogs
 *   - GKI.spine.me() / isAdmin(): the signed-in user
 *
 * Personal data (names, NIK, NPWP, accounts, amounts) is never written to
 * the console or the status bar from here.
 */
(function () {
  'use strict';

  var CFG = window.GKI_CONFIG || {};
  if (!window.GKI) window.GKI = {};        // store.js normally created it

  /* Screens register themselves: { id, label, title, mount(pane) }. */
  var screens = {};
  var els = {};
  var staleAt = null;
  var lastOnline;

  /* ── helpers (also published as GKI.spine.ui) ──────────────────────────── */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function hhmm(ms) {
    var d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' +
           String(d.getMinutes()).padStart(2, '0');
  }

  function initials(name) {
    var local = String(name || '').trim().split('@')[0];
    var parts = local.split(/[\s._-]+/).filter(Boolean);
    if (!parts.length) return '··';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  /* Postgres numeric arrives as a string ("3400000.00"). null stays null. */
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  /* 4150000 -> "4.150.000" (Indonesian grouping, whole rupiah). */
  function money(v) {
    var n = num(v);
    if (n === null) return '—';
    return Math.round(n).toLocaleString('id-ID');
  }

  /* "4.150.000" / "4150000" / "4,150,000" -> 4150000. Not a number -> NaN. */
  function parseMoney(s) {
    var t = String(s == null ? '' : s).replace(/[.\s,]/g, '');
    if (t === '') return null;
    return /^\d+$/.test(t) ? Number(t) : NaN;
  }

  /* A rupiah amount field groups its digits WHILE typing (5000000 -> 5.000.000),
     no Enter needed. Only digits are kept; the caret stays after the same digit.
     Bind it BEFORE the field's own 'input' listener, which then reads the grouped
     text through parseMoney. Not for NIK, NPWP, account numbers or day counts. */
  function group(d) { return d.replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function liveMoney(inp) {
    inp.inputMode = 'numeric';
    inp.autocomplete = 'off';
    inp.addEventListener('input', function () {
      var v = inp.value, at = inp.selectionStart == null ? v.length : inp.selectionStart;
      var before = v.slice(0, at).replace(/\D/g, '').length;
      var d = v.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
      if (d.length < v.slice(0, at).replace(/\D/g, '').length) before = Math.min(before, d.length);
      var out = group(d);
      if (out === v) return;
      inp.value = out;
      var pos = 0, seen = 0;
      while (pos < out.length && seen < before) { if (/\d/.test(out[pos])) seen++; pos++; }
      if (document.activeElement === inp) { try { inp.setSelectionRange(pos, pos); } catch (e) {} }
    });
    return inp;
  }

  /* Personal numbers are shown masked to their last four. */
  function mask(v, keep) {
    var s = String(v || '').replace(/\s/g, '');
    if (!s) return '';
    keep = keep || 4;
    return '•••• •••• •••• ' + s.slice(-keep);
  }

  /* Today on the app's clock (Asia/Makassar), as YYYY-MM-DD. */
  function today() {
    var f = new Intl.DateTimeFormat('en-CA', {
      timeZone: CFG.TIME_ZONE || 'Asia/Makassar',
      year: 'numeric', month: '2-digit', day: '2-digit'
    });
    return f.format(new Date());
  }

  /* "2025-03-01" -> "01-03-2025" (the renders' date style). */
  function dmy(d) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';      // DD/MM/YYYY everywhere on screen
  }

  /* Is a dated row in force on `on` (YYYY-MM-DD)? Same test as 059's lookups. */
  function inForce(row, on) {
    var from = String(row.effective_from || '').slice(0, 10);
    var to = row.effective_to ? String(row.effective_to).slice(0, 10) : null;
    return from && from <= on && (!to || on <= to);
  }

  /* The sentence to show for a failed store call: the service's own text
     (§5.2) when it answered, otherwise what failed. Never a value. */
  function errText(err) {
    if (!err) return 'Something failed.';
    if (err.status === 0) return 'The store could not be reached. Nothing was saved.';
    var b = String(err.body || '').trim();
    if (b && b.charAt(0) !== '{' && b.charAt(0) !== '[' && b.length < 400) return b;
    return 'The store answered ' + err.status + '.';
  }

  /* ── confirm(): the app's own pop-up (2026-10-21, operator) ──────────────
     Replaces window.confirm for consequential acts. Resolves true on the
     confirm button, false on Cancel, Esc or a click outside the card.
     o = { icon, kicker, title, rows: [[label, value], …], note, ok, cancel }
     ⚠️ rows carry counts and totals only — never a name, NIK or account.
     Styles: app.css .pr-modal*, tokens only. */
  function confirmBox(o) {
    o = o || {};
    return new Promise(function (resolve) {
      var back = el('div', 'pr-modal-back');
      var card = el('div', 'pr-modal');
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      var head = el('div', 'pr-modal-head');
      if (o.icon) head.appendChild(el('div', 'pr-modal-icon', o.icon));
      var ht = el('div');
      if (o.kicker) ht.appendChild(el('div', 'pr-modal-kicker', o.kicker));
      var h = el('h3', 'pr-modal-title', o.title || 'Are you sure?');
      h.id = 'pr-modal-title';
      card.setAttribute('aria-labelledby', h.id);
      ht.appendChild(h);
      head.appendChild(ht);
      card.appendChild(head);
      if (o.rows && o.rows.length) {
        var dl = el('dl', 'pr-modal-rows');
        o.rows.forEach(function (r) {
          var row = el('div');
          row.appendChild(el('dt', null, r[0]));
          row.appendChild(el('dd', null, r[1]));
          dl.appendChild(row);
        });
        card.appendChild(dl);
      }
      if (o.note) card.appendChild(el('p', 'pr-modal-note', o.note));
      /* o.typeToConfirm: the OK button stays off until this text is typed (a
         destructive action: reset a run, delete an employee). */
      var typed = null;
      if (o.typeToConfirm) {
        var tw = el('div', 'pr-modal-type');
        tw.appendChild(el('label', null, 'Type  ' + o.typeToConfirm + '  to continue'));
        typed = el('input'); typed.type = 'text'; typed.autocomplete = 'off'; typed.spellcheck = false;
        tw.appendChild(typed);
        card.appendChild(tw);
      }
      var foot = el('div', 'pr-modal-foot');
      var no = el('button', 'pr-btn2', o.cancel || 'Cancel'); no.type = 'button';
      var yes = el('button', 'pr-btn', o.ok || 'Confirm'); yes.type = 'button';
      foot.appendChild(no); foot.appendChild(yes);
      if (typed) {
        yes.disabled = true;
        typed.addEventListener('input', function () {
          yes.disabled = typed.value.trim().toLowerCase() !== String(o.typeToConfirm).trim().toLowerCase();
        });
      }
      card.appendChild(foot);
      back.appendChild(card);

      var before = document.activeElement;
      function done(v) {
        document.removeEventListener('keydown', key, true);
        back.classList.remove('in');
        setTimeout(function () { if (back.parentNode) back.parentNode.removeChild(back); }, 160);
        if (before && before.focus) { try { before.focus(); } catch (e) {} }
        resolve(v);
      }
      function key(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); done(false); }
        else if (ev.key === 'Tab') {            /* keep focus inside the card */
          ev.preventDefault();
          var ring = (typed ? [typed, no, yes] : [no, yes]).filter(function (x) { return !x.disabled; });
          var at = ring.indexOf(document.activeElement);
          ring[(at + (ev.shiftKey ? ring.length - 1 : 1)) % ring.length].focus();
        }
      }
      no.addEventListener('click', function () { done(false); });
      yes.addEventListener('click', function () { if (!yes.disabled) done(true); });
      back.addEventListener('mousedown', function (ev) { if (ev.target === back) done(false); });
      document.addEventListener('keydown', key, true);
      document.body.appendChild(back);
      requestAnimationFrame(function () { back.classList.add('in'); });
      (typed || no).focus();                     /* the safe choice has focus (the box, when one must be typed) */
    });
  }

  /* A small form in a dialog. Resolves with { name: value } or null.
     fields: [{ name, label, type: 'text'|'password'|'select'|'textarea', value, options: [[value, label]], placeholder, hint }]
     o.submit(values) may return a Promise; a rejection shows its message in
     the dialog and keeps it open. */
  function formDialog(o) {
    return new Promise(function (resolve) {
      var back = el('div', 'pr-modal-back');
      var card = el('form', 'pr-modal cb-form-modal');
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.noValidate = true;
      var head = el('div', 'pr-modal-head');
      var h = el('h3', 'pr-modal-title', o.title || '');
      head.appendChild(h);
      card.appendChild(head);
      if (o.note) card.appendChild(el('p', 'pr-modal-note', o.note));
      var inputs = {};
      (o.fields || []).forEach(function (f) {
        var w = el('div', 'pr-f');
        var lab = el('label', null, f.label);
        lab.htmlFor = 'cb-f-' + f.name;
        w.appendChild(lab);
        var i;
        if (f.type === 'select') {
          i = el('select');
          (f.options || []).forEach(function (op) { var x = el('option', null, op[1]); x.value = op[0]; i.appendChild(x); });
        } else if (f.type === 'textarea') {
          i = el('textarea', 'cb-textarea');
          i.rows = f.rows || 6;
          if (f.placeholder) i.placeholder = f.placeholder;
        } else {
          i = el('input');
          i.type = f.type || 'text';
          if (f.type === 'password') i.autocomplete = 'new-password';
          if (f.placeholder) i.placeholder = f.placeholder;
        }
        i.id = 'cb-f-' + f.name;
        if (f.value != null) i.value = f.value;
        inputs[f.name] = i;
        w.appendChild(i);
        if (f.hint) w.appendChild(el('small', 'cb-hint', f.hint));
        card.appendChild(w);
      });
      var msg = el('p', 'pr-msg bad cb-form-msg', '');
      card.appendChild(msg);
      var foot = el('div', 'pr-modal-foot');
      var no = el('button', 'pr-btn2', o.cancel || 'Cancel'); no.type = 'button';
      var yes = el('button', 'pr-btn', o.ok || 'Save'); yes.type = 'submit';
      foot.appendChild(no); foot.appendChild(yes);
      card.appendChild(foot);
      back.appendChild(card);

      function close(v) {
        document.removeEventListener('keydown', key, true);
        if (back.parentNode) back.parentNode.removeChild(back);
        resolve(v);
      }
      function key(ev) { if (ev.key === 'Escape') { ev.preventDefault(); close(null); } }
      card.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var values = {};
        Object.keys(inputs).forEach(function (k) { values[k] = inputs[k].value; });
        if (!o.submit) return close(values);
        yes.disabled = true; msg.textContent = '';
        Promise.resolve(o.submit(values)).then(function (r) { close(r === undefined ? values : r); },
          function (err) { yes.disabled = false; msg.textContent = errText(err); });
      });
      no.addEventListener('click', function () { close(null); });
      back.addEventListener('mousedown', function (ev) { if (ev.target === back) close(null); });
      document.addEventListener('keydown', key, true);
      document.body.appendChild(back);
      requestAnimationFrame(function () { back.classList.add('in'); });
      var first = card.querySelector('input,select');
      if (first) first.focus();
    });
  }

  /* JSON call to the server; errors carry { status, body } like store errors. */
  function api(method, url, body) {
    return fetch(url, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.text().then(function (t) {
        if (r.status === 401 && url.indexOf('/api/auth/') !== 0) { location.href = '/login'; }
        if (!r.ok) { var e = new Error(t || ('HTTP ' + r.status)); e.status = r.status; e.body = t; throw e; }
        return t ? JSON.parse(t) : null;
      });
    });
  }

  var ui = {
    el: el, clear: clear, initials: initials, num: num, money: money,
    parseMoney: parseMoney, liveMoney: liveMoney, mask: mask, today: today, dmy: dmy,
    inForce: inForce, errText: errText, confirm: confirmBox, form: formDialog, api: api
  };

  /* ── the one per-app colour ───────────────────────────────────────────── */
  function applyAccent() {  // the brand colour from config.js
    var accent = (CFG.BRANDING && CFG.BRANDING.accent) || '';
    if (accent) {
      document.documentElement.style.setProperty('--gki-module', accent);
    }
  }

  /* ── chrome ───────────────────────────────────────────────────────────── */

  function buildChrome() {
    /* 'pr' scopes app.css — every rule there is under .gki-app.pr. */
    var app = el('div', 'gki-app pr');
    els.app = app;

    /* Header: brand left, signed-in user (with its menu) right. */
    var bar = el('header', 'cb-header');
    var brand = el('a', 'cb-brand');
    brand.href = '#/';
    brand.appendChild(el('span', 'cb-mark', 'C'));
    brand.appendChild(el('span', 'cb-name', CFG.BRAND || 'CoraByte'));
    brand.appendChild(el('span', 'cb-product', CFG.MODULE || 'Payroll'));
    bar.appendChild(brand);

    var right = el('div', 'cb-header-right');
    /* The organisation (tenant) this session works in; opens its settings. */
    els.org = el('a', 'cb-org');
    els.org.href = '#/settings';
    els.org.title = 'Organization settings';
    els.org.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 17V4.5A1.5 1.5 0 0 1 4.5 3h6A1.5 1.5 0 0 1 12 4.5V17M12 8h3.5A1.5 1.5 0 0 1 17 9.5V17M2 17h16M6 6h3M6 9h3M6 12h3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    els.orgName = el('span', 'cb-org-name', '');
    els.org.appendChild(els.orgName);
    right.appendChild(els.org);
    els.userBtn = el('button', 'cb-user');
    els.userBtn.type = 'button';
    els.userBtn.setAttribute('aria-haspopup', 'menu');
    els.avatar = el('span', 'cb-avatar', '··');
    els.userName = el('span', 'cb-user-name', '');
    els.userBtn.appendChild(els.avatar);
    els.userBtn.appendChild(els.userName);
    els.userBtn.appendChild(el('span', 'cb-caret', '▾'));
    right.appendChild(els.userBtn);
    els.userMenu = el('div', 'cb-menu');
    els.userMenu.setAttribute('role', 'menu');
    els.userMenu.hidden = true;
    right.appendChild(els.userMenu);
    bar.appendChild(right);
    app.appendChild(bar);
    buildUserMenu();

    /* Left navigation. */
    els.tabs = el('nav', 'gki-gnav pr-sidenav');
    els.tabs.setAttribute('aria-label', 'Screens');

    var body = el('div', 'gki-body');
    var side = el('aside', 'pr-rail');
    side.appendChild(els.tabs);
    body.appendChild(side);
    els.pane = el('main', 'gki-pane');
    body.appendChild(els.pane);
    app.appendChild(body);

    /* STATUS BAR — app name left, store probe, identity and environment right. */
    var sbar = el('div', 'gki-statusbar');
    sbar.appendChild(el('span', 'gki-modchip', CFG.APP_NAME || ''));
    els.probe = el('span', null, 'store …');
    sbar.appendChild(els.probe);
    els.status = el('span', null, '');
    sbar.appendChild(els.status);
    els.who = el('span', 'gki-statusbar-right', CFG.ENV || '');
    sbar.appendChild(els.who);
    app.appendChild(sbar);

    document.body.appendChild(app);
  }

  /* ── identity ─────────────────────────────────────────────────────────── */

  var mePromise = null;

  /* The signed-in user: { id, username, name, role }. A 401 sends the
     browser to the sign-in page. */
  var lastMe = null;
  var lastOrg = null;
  function readMe() {
    if (mePromise) return mePromise;
    mePromise = api('GET', '/api/me').then(function (r) {
      lastMe = (r && r.user) || null;
      lastOrg = (r && r.org) || null;
      return lastMe;
    })
      .catch(function () { return null; });
    return mePromise;
  }

  function loadIdentity() {
    readMe().then(function (me) {
      if (!me) return;
      els.avatar.textContent = initials(me.name || me.username);
      els.userName.textContent = me.name || me.username;
      els.userBtn.title = me.username + ' · ' + me.role;
      els.orgName.textContent = lastOrg ? lastOrg.name : '';
      if (lastOrg) document.title = lastOrg.name + ' · ' + (CFG.APP_NAME || '');
      clear(els.who);
      els.who.appendChild(el('b', null, me.name || me.username));
      els.who.appendChild(document.createTextNode('  ·  ' + (me.role === 'admin' ? 'Admin' : 'Member') +
        '  ·  v' + (CFG.VERSION || '')));
      renderTabs(currentId());
    }).catch(function () { /* the chrome renders without it */ });
  }

  function buildUserMenu() {
    function item(label, fn) {
      var b = el('button', 'cb-menu-item', label);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', function () { els.userMenu.hidden = true; fn(); });
      els.userMenu.appendChild(b);
    }
    item('Change password', changePassword);
    item('Sign out', function () {
      api('POST', '/api/auth/logout', {}).then(function () { location.href = '/login'; },
        function () { location.href = '/login'; });
    });
    els.userBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      els.userMenu.hidden = !els.userMenu.hidden;
    });
    document.addEventListener('click', function () { els.userMenu.hidden = true; });
  }

  function changePassword() {
    formDialog({
      title: 'Change password',
      ok: 'Change password',
      fields: [
        { name: 'current', label: 'CURRENT PASSWORD', type: 'password' },
        { name: 'next', label: 'NEW PASSWORD · AT LEAST 8 CHARACTERS', type: 'password' },
        { name: 'again', label: 'NEW PASSWORD AGAIN', type: 'password' }
      ],
      submit: function (v) {
        if (v.next !== v.again) return Promise.reject(new Error('The two new passwords are not the same.'));
        return api('POST', '/api/me/password', { current: v.current, next: v.next });
      }
    }).then(function (r) { if (r) toast('Password changed.'); });
  }

  function toast(text) {
    var t = el('div', 'cb-toast', text);
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2600);
  }

  /* ── degrade band (accessor §4) ───────────────────────────────────────
     What PAYROLL permits on stale data: NOTHING. app/payroll/* is never
     cached (store.js, plan F2), so a payroll read with no answer fails; the
     band says so and the screens disable their saves while it shows. */

  function storeOnline() {
    var s = window.GKI_STORE || (window.GKI && window.GKI.store);
    if (!s) return null;
    try { return s.status().online; } catch (e) { return null; }
  }

  function renderBand() {
    if (els.band && els.band.parentNode) els.band.parentNode.removeChild(els.band);
    els.band = null;
    if (storeOnline() !== false) return;
    var band = el('div', 'gki-alert gki-alert--warn');
    band.setAttribute('role', 'status');
    band.appendChild(el('span', 'gki-alert-ic', '!'));
    band.appendChild(el('span', null,
      'The server is not responding. Check that the CoraByte Payroll window (start.bat) is still running.' +
      (staleAt ? ' Client names shown are from ' + hhmm(staleAt) + '.' : '')));
    els.band = band;
    els.pane.insertBefore(band, els.pane.firstChild);
  }

  function renderStatus() {
    if (!els.status) return;
    els.status.textContent = storeOnline() === false ? '  ·  store offline' : '';
  }

  function reportCachedAt(cachedAt) {
    if (cachedAt != null) staleAt = cachedAt;
    renderBand();
    renderStatus();
  }

  function watchStatus() {
    lastOnline = storeOnline();
    window.setInterval(function () {
      var now = storeOnline();
      if (now === lastOnline) return;
      lastOnline = now;
      renderBand();
      renderStatus();
    }, 2000);
  }

  /* ── routing ──────────────────────────────────────────────────────────── */

  function emptyState(title, line) {
    var wrap = el('div', 'gki-empty');
    var box = el('div', 'gki-empty-in');
    box.appendChild(el('h2', null, title));
    box.appendChild(el('p', null, line));
    wrap.appendChild(box);
    return wrap;
  }

  function currentId() {
    var m = /^#\/([a-z0-9-]+)/.exec(window.location.hash || '');
    return m ? m[1] : null;
  }

  /* The tabs come from config.js (the spec: Clients · Employees · Payroll
     run). A tab with no registered screen is disabled and says "coming". */
  function renderTabs(activeId) {
    clear(els.tabs);
    (CFG.TABS || []).forEach(function (t) {
      if (t.adminOnly && !(lastMe && lastMe.role === 'admin')) return;
      var a = el('a', null, t.label);
      if (screens[t.id]) {
        a.href = '#/' + t.id;
      } else {
        a.setAttribute('aria-disabled', 'true');
        a.title = 'coming';
      }
      if (t.id === activeId) a.setAttribute('aria-current', 'page');
      els.tabs.appendChild(a);
    });
  }

  function firstScreen() {
    var tabs = CFG.TABS || [];
    for (var i = 0; i < tabs.length; i++) if (screens[tabs[i].id]) return tabs[i].id;
    return null;
  }

  function route() {
    if (!els.pane) return;
    var id = currentId();
    if (!id || !screens[id]) {
      var home = firstScreen();
      if (home && id !== home) { window.location.hash = '#/' + home; return; }
    }
    renderTabs(id && screens[id] ? id : null);
    clear(els.pane);
    els.band = null;

    var screen = id && screens[id];
    if (screen) {
      try {
        screen.mount(els.pane);
      } catch (e) {
        clear(els.pane);
        els.pane.appendChild(emptyState('That screen failed to open',
          String((e && e.message) || e)));
        console.error('[app] mount failed: ' + id);
      }
    } else {
      els.pane.appendChild(emptyState('Nothing here yet', ''));
    }
    renderBand();
  }

  /* ── the store probe — a connection check shown in the status bar ── */
  var PROBE = [
    'core/accounts', 'core/employers',
    'app/payroll/clients', 'app/payroll/employees', 'app/payroll/components',
    'app/payroll/employee_bpjs', 'app/payroll/runs', 'app/payroll/run_lines',
    'app/payroll/run_items', 'app/payroll/run_bpjs', 'app/payroll/run_activity',
    'app/payroll/bpjs_rates', 'app/payroll/jkk_classes', 'app/payroll/minimum_wage',
    'app/payroll/ptkp', 'app/payroll/ter_rates'
  ];

  function probe() {
    var s = window.GKI_STORE || (window.GKI && window.GKI.store);
    if (!s) {
      els.probe.textContent = '  ·  store accessor missing';
      els.probe.className = 'pr-st-bad';
      return;
    }
    var ok = 0, done = 0, failed = [];
    function show() {
      if (done < PROBE.length) return;
      els.probe.textContent = ok === PROBE.length ? '  ·  ● Connected'
        : '  ·  ● Some data could not be read: ' + failed.join(', ');
      els.probe.className = ok === PROBE.length ? 'pr-st-ok' : 'pr-st-bad';
    }
    PROBE.forEach(function (c) {
      s.list(c).then(function (r) {
        ok++; done++;
        
        if (r.stale) reportCachedAt(r.cachedAt);
        show();
      }).catch(function (err) {
        done++;
        failed.push(c.replace('app/payroll/', '') + ' (' + err.status + ')');
        console.error('[app] ' + c + ' failed status=' + err.status);
        renderBand();
        renderStatus();
        show();
      });
    });
  }

  /* ── the payroll clients, shared by every screen ─────────────────────
     A client is a row of app/payroll/clients (its payroll settings), joined
     to its company record core/accounts (name, NPWP, short code) and its
     employer record core/employers (legal name, departments). Loaded
     once per page and on reloadClients(). The selected client is shared:
     switching it on one screen switches it on all. Only its id is
     remembered in this browser — an id is not personal data. */
  var clientsPromise = null;
  var currentClientId = null;
  var clientListeners = [];
  var PICK_KEY = 'gki.payroll.client';

  function loadClients() {
    var s = window.GKI_STORE || (window.GKI && window.GKI.store);
    if (!s) return Promise.reject(new Error('The store accessor is missing.'));
    clientsPromise = Promise.all([
      s.list('app/payroll/clients'),
      s.list('core/accounts'),
      s.list('core/employers'),
      readMe()
    ]).then(function (r) {
      var accounts = {}, employers = {};
      r[1].rows.forEach(function (a) { accounts[a.id] = a; });
      r[2].rows.forEach(function (e) { if (!employers[e.account_id]) employers[e.account_id] = e; });
      /* An archived client (payroll_client === false) is hidden from every
         list; its history stays. Archiving again in reverse brings it back. */
      var list = r[0].rows.filter(function (c) {
        var a = accounts[c.account_id];
        return !!a && a.payroll_client !== false;
      }).map(function (c) {
        var a = accounts[c.account_id] || null;
        var e = employers[c.account_id] || null;
        return {
          id: c.id,
          settings: c,
          account: a,
          employer: e,
          name: (a && a.name) || '(no company record)',
          legalName: (e && e.effective_legal_name) || (a && a.name) || '',
          npwp: (e && e.effective_npwp) || (a && a.npwp) || '',
          logo: (e && e.logo) || null,
          shortCode: (a && a.short_code) || ''
        };
      }).sort(function (x, y) { return x.name.localeCompare(y.name); });
      /* One organisation = one employer: the screens always work on the
         organisation's primary client (other client rows stay in the data). */
      currentClientId = lastOrg ? lastOrg.primary_client_id : (list[0] ? list[0].id : null);
      return list;
    });
    clientsPromise.catch(function () { clientsPromise = null; });
    return clientsPromise;
  }

  function clients() { return clientsPromise || loadClients(); }
  function reloadClients() { clientsPromise = null; return loadClients(); }

  function client() {
    return clients().then(function (list) {
      for (var i = 0; i < list.length; i++) if (list[i].id === currentClientId) return list[i];
      return null;
    });
  }

  function setClient(id) {
    if (id === currentClientId) return;
    currentClientId = id;
    try { localStorage.setItem(PICK_KEY, id); } catch (e) {}
    clientListeners.slice().forEach(function (fn) { try { fn(id); } catch (e) {} });
  }

  /* The mounted screen's one listener. Only one screen is mounted at a time,
     so a new subscription REPLACES the old one — a screen that re-mounts
     itself never stacks a second listener. */
  function onClient(fn) { clientListeners = [fn]; }

  /* Placeholder when core.employers.logo is empty: the initials of the client's
     name, legal prefix (PT, CV, UD, PD) skipped, at most 3 letters.
     PT GANA KU INDONESIA -> GKI. One word -> its first 2 letters. */
  function clientInitials(name) {
    var words = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
    while (words.length > 1 && /^(PT|CV|UD|PD|FA)\.?$/i.test(words[0])) words.shift();
    if (!words.length) return '··';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return words.slice(0, 3).map(function (w) { return w[0]; }).join('').toUpperCase();
  }

  function logoNode(c, cls) {
    if (c && c.logo) {
      var img = el('img', cls || null);
      img.src = c.logo;
      img.alt = '';
      return img;
    }
    var txt = c ? clientInitials(c.name) : '··';
    var sp = el('span', 'pr-logo0' + (cls ? ' ' + cls : ''), txt);
    sp.setAttribute('data-len', String(txt.length));
    return sp;
  }

  /* The top-left picker (renders: logo, name, ▾; ⌘K / Ctrl+K opens it). A native
     select lies over it, so the keyboard and screen readers work. ⌘K / Ctrl+K
     focuses it. */
  /* The client picker is not shown: one organisation = one employer. Kept as
     a no-op so screens built for several clients keep working. */
  function picker() {
    return document.createDocumentFragment();
  }

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k' && els.pickSelect &&
        document.body.contains(els.pickSelect)) {
      e.preventDefault();
      els.pickSelect.focus(); els.pickSelect.click();
    }
  });

  /* ── public surface ───────────────────────────────────────────────────── */

  function register(screen) {
    if (!screen || !screen.id || typeof screen.mount !== 'function') {
      console.warn('[app] register() needs { id, mount }');
      return;
    }
    screens[screen.id] = screen;
    if (els.pane) route();
  }

  function start() {
    document.documentElement.lang = 'en';
    applyAccent();
    buildChrome();
    loadIdentity();
    window.addEventListener('hashchange', function () { clientListeners = []; route(); });
    route();
    probe();
    watchStatus();
  }

  window.GKI.spine = {
    register: register,
    reportCachedAt: reportCachedAt,
    online: storeOnline,
    isAdmin: function () { return readMe().then(function (me) { return !!me && me.role === 'admin'; }); },
    me: readMe,
    org: function () { return readMe().then(function () { return lastOrg; }); },
    refreshIdentity: function () { mePromise = null; loadIdentity(); },
    toast: toast,
    pane: function () { return els.pane; },
    clients: clients,
    reloadClients: reloadClients,
    client: client,
    setClient: setClient,
    onClient: onClient,
    picker: picker,
    logo: logoNode,
    ui: ui
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}());
