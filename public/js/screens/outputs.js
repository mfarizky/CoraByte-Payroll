/**
 * CoraByte Payroll — Outputs (step 3 of a run), shown by run.js.
 *
 *  - payslips: one PDF per employee (pdfdoc.js), or all of them at once
 *  - the Mandiri "Format Lama" CSV bank file (mandiri.js)
 *  - the remittance summary (BPJS + PPh 21) on screen and as a PDF
 *  - the run's activity log
 *  - "Reopen" (back to review) and "Mark paid" (freezes the run)
 *
 * Generating a file is recorded in the activity log with counts only.
 */
(function () {
  'use strict';

  var S = window.GKI && window.GKI.spine;
  if (!S) { console.error('[gki] outputs.js: spine missing'); return; }
  var U = S.ui, el = U.el;
  var store = function () { return window.GKI_STORE || window.GKI.store; };

  /* [event, label, shown as pending until it happens] — 066's activity CHECK. */
  var EVENTS = [
    ['locked', 'Run locked (before 066)', false],
    ['unlocked', 'Unlocked', false],
    ['drafted', 'Draft', false],
    ['sent_to_review', 'Sent to review', false],
    ['confirmed', 'Confirmed', false],
    ['reopened', 'Reopened', false],
    ['payslips_generated', 'Payslips generated', true],
    ['mandiri_generated', 'Mandiri file generated', true],
    ['marked_paid', 'Marked paid (transfer done)', true]
  ];

  function hm(iso) {
    if (!iso) return '—';
    var f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Makassar', day: '2-digit', month: '2-digit', year: 'numeric',
                                               hour: '2-digit', minute: '2-digit', hour12: false });
    var p = {}; f.formatToParts(new Date(iso)).forEach(function (x) { p[x.type] = x.value; });
    return p.day + '/' + p.month + '/' + p.year + ' ' + p.hour + ':' + p.minute;      // DD/MM/YYYY
  }
  function pct(r) { var x = U.num(r); return x === null ? '' : String(Math.round(x * 1e6) / 1e4).replace('.', ',') + '%'; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /*
   * env = { wrap, top, msg, ctx, ms, totals(ms), monthName(on), remount() }
   *   ctx.run, ctx.client, ctx.rates; ms = one model per line (run.js models())
   */
  function draw(env) {
    var ctx = env.ctx, ms = env.ms, run = ctx.run, on = String(run.period_month).slice(0, 10);
    var month = env.monthName(on) + (run.run_type === 'thr' ? ' · THR' : '');
    var client = ctx.client, settings = client.settings || {};
    var thrRun = run.run_type === 'thr';
    var paid = run.status === 'paid';
    var ok = ms.filter(function (m) { return !m.refusal; });

    /* the status chip and, while not paid, Reopen + Mark paid */
    var reopen = null, payBtn = null;
    if (paid) {
      var pk = el('span', 'pr-chip g', '✓ PAID');
      pk.style.marginLeft = 'auto';
      env.top.appendChild(pk);
      /* the time and who marked it paid live in ACTIVITY only (marked_paid) */
      env.msg.className = 'pr-msg';
      env.msg.textContent = 'Paid — this run is frozen. Files can still be downloaded. A change needs a correction run.';
    } else {
      reopen = el('button', 'pr-sec', '← Reopen');
      reopen.type = 'button';
      reopen.style.marginLeft = 'auto';
      payBtn = el('button', 'pr-btn', '✓ Mark paid');
      payBtn.type = 'button';
      payBtn.disabled = true;           // enabled once both files are made (loadActivity)
      payBtn.title = 'Make the payslips and the Mandiri file first.';
      env.top.appendChild(reopen);
      env.top.appendChild(payBtn);
      reopen.addEventListener('click', function () {
        reopen.disabled = true;
        U.confirm({
          icon: '↩',
          kicker: 'REOPEN · ' + month.toUpperCase(),
          title: 'Reopen ' + month + '?',
          rows: [['Client', client.name], ['Goes back to', 'Review']],
          note: 'The figures can change again. Payslips and the Mandiri file made so far become stale — make them again after. Logged as "reopened".',
          ok: '↩ Reopen',
          cancel: 'Cancel'
        }).then(function (yes) {
          if (!yes) { reopen.disabled = false; return; }
          store().save('app/payroll/runs', run.id, { status: 'review', rev: run.rev }).then(env.remount, function (err) {
            env.msg.className = 'pr-msg bad'; env.msg.textContent = U.errText(err); reopen.disabled = false;
          });
        });
      });
      payBtn.addEventListener('click', function () {
        var T = env.totals(ms);
        payBtn.disabled = true;
        U.confirm({
          icon: '✓',
          kicker: 'MARK PAID · ' + month.toUpperCase(),
          title: 'Mark ' + month + ' paid?',
          rows: [
            ['Client', client.name],
            ['Employees', String(ok.length)],
            ['Mandiri transfer', U.money(T.net_pay)],
            ['Pay date', run.pay_date ? U.dmy(run.pay_date) : '—']
          ],
          note: 'Only when the transfer is done. The run is then frozen: a change needs a correction run.',
          ok: '✓ Mark paid',
          cancel: 'Cancel'
        }).then(function (yes) {
          if (!yes) { payBtn.disabled = false; return; }
          store().save('app/payroll/runs', run.id, { status: 'paid', rev: run.rev }).then(env.remount, function (err) {
            env.msg.className = 'pr-msg bad'; env.msg.textContent = U.errText(err); payBtn.disabled = false;
          });
        });
      });
    }

    if (ok.length !== ms.length) {
      env.msg.className = 'pr-msg bad';
      env.msg.textContent = 'A line has no net pay. Outputs are not made from an incomplete run — reopen it.';
    }

    var lay = el('div', 'pr-lay4');
    env.wrap.appendChild(lay);
    var colL = el('div', 'pr-side'), colR = el('div', 'pr-side');
    lay.appendChild(colL); lay.appendChild(colR);

    function slip(m) {
      return { client: client, employee: m.emp, line: m.line, bpjs: m.bpjs, items: m.items,
               rates: ctx.rates, ter_rate: m.ter_rate, period: on, run_type: run.run_type, made: U.today() };
    }
    function say(cls, text) { env.msg.className = 'pr-msg' + (cls ? ' ' + cls : ''); env.msg.textContent = text; }
    var activity = null;               // filled below, read by log()
    /* The last time the run was reopened or unlocked: a file made before it is stale. */
    function since() {
      return (activity || []).filter(function (a) { return a.event === 'reopened' || a.event === 'unlocked'; })
        .map(function (a) { return String(a.at); }).sort().pop() || '';
    }
    function fresh(event) {
      var t = since();
      return (activity || []).some(function (a) { return a.event === event && String(a.at) > t; });
    }
    function log(event, note) {
      var have = fresh(event);
      var p = have ? Promise.resolve() : store().save('app/payroll/run_activity', null, { run_id: run.id, event: event, note: note });
      return p.then(function () {
        if (!have) loadActivity();
      }).catch(function (err) {
        env.msg.className = 'pr-msg bad';
        env.msg.textContent = 'The file was made, but the activity log refused the entry: ' + U.errText(err);
      });
    }

    /* ── payslips ──────────────────────────────────────────────────── */
    var pc = card('PAYSLIPS · ' + ok.length + ' PDF', 'no password');
    ok.forEach(function (m) {
      var name = window.GKI.payslip.fileName(on, m.emp.employee_code, run.run_type);
      var r = el('div', 'pr-fl');
      r.appendChild(el('span', 'pr-fi', 'PDF'));
      var w = el('div');
      w.appendChild(el('b', null, name));
      w.appendChild(el('span', null, m.emp.full_name + ' · net ' + U.money(m.net_pay)));
      r.appendChild(w);
      var b = el('button', 'pr-dl', '↓');
      b.type = 'button';
      b.title = 'Downloads ' + name;
      b.addEventListener('click', function () {
        b.disabled = true; b.textContent = '…';
        say('', 'Making the PDF…');
        window.GKI.pdfdoc.payslipPdf(slip(m)).then(function (pdf) {
          window.GKI.pdfdoc.download(pdf, name);
          say('', '');
          log('payslips_generated', ok.length + ' payslips');
        }, function (err) { say('bad', 'The payslip PDF could not be made: ' + err.message); })
          .then(function () { b.disabled = false; b.textContent = '↓'; });
      });
      r.appendChild(b);
      pc.appendChild(r);
    });
    var acts = el('div', 'pr-acts');
    var all = el('button', 'pr-btn', '↓ Download all payslips');
    all.type = 'button';
    all.disabled = ok.length !== ms.length || !ok.length;
    all.title = 'Downloads every payslip PDF, one file per employee';
    all.addEventListener('click', function () {
      all.disabled = true;
      var i = 0;
      ok.reduce(function (p, m) {
        return p.then(function () {
          say('', 'Making the PDFs… ' + (++i) + ' of ' + ok.length);
          return window.GKI.pdfdoc.payslipPdf(slip(m)).then(function (pdf) {
            window.GKI.pdfdoc.download(pdf, window.GKI.payslip.fileName(on, m.emp.employee_code, run.run_type));
          });
        });
      }, Promise.resolve()).then(function () {
        say('ok', ok.length + ' payslips downloaded.');
        log('payslips_generated', ok.length + ' payslips').then(loadActivity);
      }, function (err) { say('bad', 'The payslip PDFs could not be made: ' + err.message); })
        .then(function () { all.disabled = false; });
    });
    acts.appendChild(all);
    pc.appendChild(acts);
    pc.appendChild(el('div', 'pr-note', 'PDF made in this browser from the payslip preview itself (the same page, the run\'s figures) — an image of the page, so its text is not selectable.'));
    colL.appendChild(pc);

    /* ── Mandiri file ──────────────────────────────────────────────── */
    var mc = card('MANDIRI BANK FILE', null);
    var mh = mc.querySelector('h4');
    var mhs = el('span'); mhs.appendChild(el('span', 'pr-dot')); mhs.appendChild(document.createTextNode('FORMAT LAMA'));
    mh.appendChild(mhs);
    var res = window.GKI.mandiri.build({
      client: client, run: run,
      rows: ok.map(function (m) { return { employee: m.emp, net: m.net_pay }; })
    });
    var fr = el('div', 'pr-fl');
    fr.appendChild(el('span', 'pr-fi csv', 'CSV'));
    var fw = el('div');
    fw.appendChild(el('b', null, res.fileName));
    fw.appendChild(el('span', null, res.count + ' transfers · total ' + U.money(res.total) +
      (settings.debit_account ? ' · debit ' + U.mask(settings.debit_account, 4).replace('•••• •••• ', '') : '') +
      (run.pay_date ? ' · date ' + U.dmy(run.pay_date) : '')));
    fr.appendChild(fw);
    var dl = el('button', 'pr-dl', '↓ CSV');
    dl.type = 'button';
    dl.disabled = !res.ok;
    dl.addEventListener('click', function () {
      window.GKI.mandiri.download(res);
      log('mandiri_generated', res.count + ' transfers · total ' + U.money(res.total));
    });
    fr.appendChild(dl);
    mc.appendChild(fr);
    /* Passing checks are not shown here. A failure is shown only if it gets this far;
       Review already blocks Outputs until the file can be made (run.js drawReview). */
    var fmtBad = res.checks.filter(function (c) { return !c.ok; });
    if (fmtBad.length) ck(mc, 'n', 'Format check failed', fmtBad.map(function (c) { return c.label; }).join(' · '), 'spec §8');
    res.problems.forEach(function (p) { ck(mc, 'n', p, 'The file is not offered until this is fixed.', null); });
    res.warnings.forEach(function (p) { ck(mc, 'w', p, 'Does not block the file.', null); });
    mc.appendChild(el('div', 'pr-note', 'Client uploads to Mandiri · Mandiri emails each employee its own transfer confirmation · ' +
      'never open and re-save the CSV in Excel (it turns accounts into 1.61E+12)'));
    colL.appendChild(mc);

    /* ── remittance ────────────────────────────────────────────────── */
    var R = remittance(ctx, ok, on);
    var rc = card('REMITTANCE · TO PAY', 'IDR');
    rt(rc, ['BPJS KETENAGAKERJAAN', 'EMPLOYER', 'EMPLOYEE'], 'h');
    R.tk.forEach(function (x) { rt(rc, [x.label, x.er, x.ee]); });
    rt(rc, ['Subtotal · ' + U.money(R.tkEr + R.tkEe), R.tkEr, R.tkEe], 's');
    rt(rc, ['BPJS KESEHATAN', '', ''], 'h');
    if (R.kes) rt(rc, [R.kes.label, R.kes.er, R.kes.ee]);
    else rt(rc, ['Nobody enrolled', null, null]);
    rt(rc, ['PPh 21', '', ''], 'h');
    rt(rc, [R.pphLabel + ' · ' + ok.length + ' employees', null, R.pph]);
    var tot = el('div', 'pr-kv big');
    tot.appendChild(el('span', null, 'Total to remit'));
    tot.appendChild(el('b', null, U.money(R.total)));
    rc.appendChild(tot);
    var ra = el('div', 'pr-acts');
    var rb = el('button', 'pr-sec', '↓ Remittance summary (PDF)');
    rb.type = 'button';
    rb.addEventListener('click', function () {
      var spec = remSpec(client, month, on, ok.length, R, thrRun);
      rb.disabled = true; say('', 'Making the PDF…');
      window.GKI.pdfdoc.remittancePdf(spec).then(function (pdf) {
        window.GKI.pdfdoc.download(pdf, spec.title + '.pdf'); say('', '');
      }, function (err) { say('bad', 'The remittance PDF could not be made: ' + err.message); })
        .then(function () { rb.disabled = false; });
    });
    ra.appendChild(rb);
    rc.appendChild(ra);
    /* Layout (2026-10-21, operator): left = Payslips, Remittance, Mandiri;
       right = Activity alone; 2:1 (app.css .pr-lay4). */
    colL.insertBefore(rc, mc);

    /* ── activity ──────────────────────────────────────────────────── */
    var ac = card('ACTIVITY', 'this run');
    var al = el('div');
    ac.appendChild(al);
    colR.appendChild(ac);
    function loadActivity() {
      store().list('app/payroll/run_activity').then(function (r) {
        activity = r.rows.filter(function (a) { return a.run_id === run.id; })
          .sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
        U.clear(al);
        activity.forEach(function (a) {
          var label = (EVENTS.filter(function (e) { return e[0] === a.event; })[0] || [a.event, a.event])[1];
          lg(al, hm(a.at), label, a.note || '', false, a.by_name);
        });
        /* pending = not done since the last reopen */
        EVENTS.forEach(function (e) { if (e[2] && !fresh(e[0])) lg(al, '—', e[1], null, true); });
        var bothMade = fresh('payslips_generated') && fresh('mandiri_generated');
        if (payBtn) {
          /* TEMPORARY (prototype): paid can be marked as soon as the payslips are generated;
             the Mandiri file is not required yet. Real rule: both files (bothMade). */
          var canPay = fresh('payslips_generated');
          payBtn.disabled = !canPay || ok.length !== ms.length;
          payBtn.title = canPay ? 'Mark the run paid once the transfer is done.' : 'Make the payslips first.';
        }
        var stale = since() && (activity.some(function (a) { return a.event === 'payslips_generated' || a.event === 'mandiri_generated'; })) && !fresh('payslips_generated');
        if (stale && !paid && ok.length === ms.length) {
          env.msg.className = 'pr-msg bad';
          env.msg.textContent = 'The run was reopened after files were made. Download the payslips again before sending them.';
        }
      }).catch(function (err) { U.clear(al); al.appendChild(el('p', 'pr-msg bad', U.errText(err))); });
    }
    loadActivity();
  }

  /* Sums of the run's stored BPJS results. The employer column is what the client
     pays (its own share and any employee share it carries); the employee
     column is what was deducted from pay — as the render shows. */
  function remittance(ctx, ms, on) {
    var acc = {};
    ['jkk', 'jkm', 'jht', 'jp', 'kesehatan'].forEach(function (p) { acc[p] = { er: 0, ee: 0, carried: 0, eeTotal: 0, any: false }; });
    ms.forEach(function (m) {
      m.bpjs.forEach(function (b) {
        var a = acc[b.programme]; if (!a) return;
        var er = U.num(b.employer_amount) || 0, ee = U.num(b.employee_amount) || 0;
        if (er || ee) a.any = true;
        a.er += er;
        if (b.employee_share_paid_by === 'employer') { a.er += ee; a.carried += ee; } else a.ee += ee;
        a.eeTotal += ee;
      });
    });
    function rate(p, side) {
      var r = ctx.rates.filter(function (x) { return x.programme === p && x.side === side && U.inForce(x, on); })
        .sort(function (a, b) { return String(b.effective_from).localeCompare(String(a.effective_from)); })[0];
      return r ? pct(r.rate) : '';
    }
    var jkk = pct(ctx.client.settings.jkk_rate);
    var tk = [
      { p: 'jkk', label: 'JKK ' + jkk }, { p: 'jkm', label: 'JKM ' + rate('jkm', 'employer') },
      { p: 'jht', label: 'JHT ' + rate('jht', 'employer') + ' · ' + rate('jht', 'employee') },
      { p: 'jp', label: 'JP ' + rate('jp', 'employer') + ' · ' + rate('jp', 'employee') }
    ].map(function (x) {
      var a = acc[x.p];
      var hasEe = x.p === 'jht' || x.p === 'jp';
      return { label: x.label + (a.carried && !a.ee ? ' (employee share paid by employer)' : ''),
               er: a.er, ee: hasEe ? a.ee : null };
    });
    var tkEr = tk.reduce(function (s, x) { return s + x.er; }, 0);
    var tkEe = tk.reduce(function (s, x) { return s + (x.ee || 0); }, 0);
    var k = acc.kesehatan;
    var kes = k.any ? {
      label: 'Kesehatan ' + rate('kesehatan', 'employer') + ' + ' + rate('kesehatan', 'employee') +
             (k.carried && !k.ee ? ' (paid by employer)' : ''),
      er: k.er, ee: k.ee || null
    } : null;
    var pph = ms.reduce(function (s, m) { return s + (m.pph21 || 0); }, 0);
    var kesTotal = kes ? kes.er + (kes.ee || 0) : 0;
    var nYe = ms.filter(function (m) { return m.annual; }).length;   // year-end lines (Pasal 17)
    var pphLabel = !nYe ? 'TER' : (nYe === ms.length ? 'Pasal 17 (year-end)' : 'TER + Pasal 17 (year-end)');
    return { tk: tk, tkEr: tkEr, tkEe: tkEe, kes: kes, pph: pph, pphLabel: pphLabel, total: tkEr + tkEe + kesTotal + pph };
  }

  /* The remittance for pdfdoc.js — the rows remittanceDoc drew, as data. */
  function remSpec(client, month, on, n, R, thr) {
    function m(v) { return v === null || v === '' ? '—' : U.money(v); }
    var rows = [{ kind: 'h', c: ['BPJS KETENAGAKERJAAN', 'EMPLOYER', 'EMPLOYEE'] }];
    R.tk.forEach(function (x) { rows.push({ kind: 'r', c: [x.label, m(x.er), m(x.ee)] }); });
    rows.push({ kind: 't', c: ['Subtotal', m(R.tkEr), m(R.tkEe)] });
    rows.push({ kind: 'h', c: ['BPJS KESEHATAN', '', ''] });
    rows.push(R.kes ? { kind: 'r', c: [R.kes.label, m(R.kes.er), m(R.kes.ee)] } : { kind: 'r', c: ['Nobody enrolled', '—', '—'] });
    rows.push({ kind: 'h', c: ['PPh 21', '', ''] });
    rows.push({ kind: 'r', c: [R.pphLabel + ' · ' + n + ' employees', '—', m(R.pph)] });
    var legal = client.legalName || client.name;
    return { title: 'REMITTANCE-' + (client.shortCode || 'CLIENT') + (thr ? '-THR' : '') + '-' + on.slice(0, 7), legal: legal,
             legalUpper: String(legal).toUpperCase(), place: '', npwp: client.npwp || '', logo: null,
             period: month, rows: rows, total: U.money(R.total), made: U.dmy(U.today()),
             note: 'BPJS Ketenagakerjaan, BPJS Kesehatan and PPh 21 for the ' + month + (thr ? ' THR' : '') + ' run · ' + n +
                   ' employees. Made by CoraByte Payroll from the run\'s figures.' };
  }

  /* The remittance as a printable A4 page — kept for reference; the PDF is remSpec + pdfdoc.js. */
  function remittanceDoc(client, month, on, n, R) {
    function cell(v) { return v === null ? '—' : esc(U.money(v)); }
    function row(c, cls) {
      return '<tr' + (cls ? ' class="' + cls + '"' : '') + '><td>' + esc(c[0]) + '</td><td class="ps-n">' +
        cell(c[1]) + '</td><td class="ps-n">' + cell(c[2]) + '</td></tr>';
    }
    var rows = ['<tr class="rm-h"><td>BPJS KETENAGAKERJAAN</td><td class="ps-n">EMPLOYER</td><td class="ps-n">EMPLOYEE</td></tr>'];
    R.tk.forEach(function (x) { rows.push(row([x.label, x.er, x.ee])); });
    rows.push(row(['Subtotal', R.tkEr, R.tkEe], 'ps-t'));
    rows.push('<tr class="rm-h"><td>BPJS KESEHATAN</td><td></td><td></td></tr>');
    rows.push(R.kes ? row([R.kes.label, R.kes.er, R.kes.ee]) : row(['Nobody enrolled', null, null]));
    rows.push('<tr class="rm-h"><td>PPh 21</td><td></td><td></td></tr>');
    rows.push(row([R.pphLabel + ' · ' + n + ' employees', null, R.pph]));
    var short = client.shortCode || 'CLIENT';
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><base href="' + esc(location.origin + '/') + '">' +
      '<title>REMITTANCE-' + esc(short) + '-' + on.slice(0, 7) + '</title>' +
      '<link rel="stylesheet" href="css/fonts.css">' +
      '<link rel="stylesheet" href="css/app.css"></head><body class="ps-body"><div class="ps-pg">' +
      '<div class="ps-hd"><div class="ps-co"><div><b>' + esc(String(client.legalName || client.name).toUpperCase()) + '</b>' +
      '<span>' + (client.npwp ? 'NPWP ' + esc(client.npwp) : '') + '</span></div></div>' +
      '<div class="ps-tt"><b>REMITTANCE · TO PAY</b><strong>' + esc(month) + '</strong></div></div>' +
      '<div class="rm"><table>' + rows.join('') + '</table>' +
      '<div class="ps-net"><span>TOTAL TO REMIT</span><b><small>Rp</small>' + esc(U.money(R.total)) + '</b></div>' +
      '<div class="ps-note">BPJS Ketenagakerjaan, BPJS Kesehatan and PPh 21 for the ' + esc(month) + ' run · ' +
      n + ' employees. Made by CoraByte Payroll from the run\'s figures.</div></div>' +
      '<div class="ps-foot"><span>' + esc(client.legalName || client.name) + '</span><span>Dibuat ' +
      esc(U.dmy(U.today())) + '</span><span></span></div></div></body></html>';
  }

  /* ── builders ──────────────────────────────────────────────────────── */
  function isoDay(iso) {
    var f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Makassar', year: 'numeric', month: '2-digit', day: '2-digit' });
    return f.format(new Date(iso));
  }
  function card(title, right) {
    var d = el('div', 'pr-card');
    var h = el('h4');
    h.appendChild(el('span', null, title));
    if (right) h.appendChild(el('span', null, right));
    d.appendChild(h);
    return d;
  }
  function ck(parent, kind, text, small, right) {
    var d = el('div', 'pr-ck');
    d.appendChild(el('span', 'ic ' + kind, kind === 'y' ? '✓' : kind === 'w' ? '!' : '✗'));
    if (small) { var w = el('div', null, text); w.appendChild(el('small', null, small)); d.appendChild(w); }
    else d.appendChild(document.createTextNode(text));
    if (right) d.appendChild(el('b', null, right));
    parent.appendChild(d);
  }
  function rt(parent, c, cls) {
    var d = el('div', 'pr-rt' + (cls ? ' ' + cls : ''));
    d.appendChild(el('span', null, c[0]));
    [c[1], c[2]].forEach(function (v) {
      if (cls === 'h') { d.appendChild(el('span', null, v)); return; }
      d.appendChild(el('b', v === null ? 'pr-mut' : null, v === null ? '—' : U.money(v)));
    });
    parent.appendChild(d);
  }
  function lg(parent, t, label, small, pending, by) {
    var d = el('div', 'pr-lg' + (pending ? ' p' : ''));
    var ti = el('i', null, t);
    /* Who did it, under the time: "by RIZKY" — the first name, upper case. */
    var first = by ? String(by).trim().split(/\s+/)[0].toUpperCase() : '';
    if (first) ti.appendChild(el('small', null, 'by ' + first));
    d.appendChild(ti);
    d.appendChild(el('span', 'd' + (pending ? ' p' : '')));
    var s = el('span', null, label);
    if (small) s.appendChild(el('small', null, small));
    d.appendChild(s);
    parent.appendChild(d);
  }

  if (!window.GKI) window.GKI = {};
  window.GKI.outputs = { draw: draw, remittance: remittance };
}());
