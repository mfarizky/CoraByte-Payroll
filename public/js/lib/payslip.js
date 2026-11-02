/**
 * CoraByte Payroll — payslip document (HTML, A4).
 *   GKI.payslip.html(data, baseHref) -> full HTML document
 *   GKI.payslip.model(data), .fileName(period, code, runType), .terbilang(n)
 * Styled by app.css (.ps-* rules); identity numbers stay masked.
 */
(function () {
  'use strict';

  var BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli',
               'Agustus', 'September', 'Oktober', 'November', 'Desember'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function n(v) { var x = Number(v); return v === null || v === undefined || v === '' || !isFinite(x) ? null : x; }
  function rp(v) { var x = n(v); return x === null ? '—' : Math.round(x).toLocaleString('id-ID'); }
  function pct(r) { var x = n(r); return x === null ? '' : String(Math.round(x * 1e6) / 1e4).replace('.', ',') + '%'; }
  function tanggal(d) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
    return m ? Number(m[3]) + ' ' + BULAN[Number(m[2]) - 1] + ' ' + m[1] : '';
  }
  function bulan(on) { return BULAN[Number(String(on).slice(5, 7)) - 1] + ' ' + String(on).slice(0, 4); }
  function last4(v) { var s = String(v || '').replace(/\s/g, ''); return s ? s.slice(-4) : ''; }

  /* Terbilang — the net in Indonesian words, ending "rupiah". */
  var SATU = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas'];
  function words(x) {
    x = Math.floor(x);
    if (x < 12) return SATU[x];
    if (x < 20) return words(x - 10) + ' belas';
    if (x < 100) return words(Math.floor(x / 10)) + ' puluh' + (x % 10 ? ' ' + words(x % 10) : '');
    if (x < 200) return 'seratus' + (x - 100 ? ' ' + words(x - 100) : '');
    if (x < 1000) return words(Math.floor(x / 100)) + ' ratus' + (x % 100 ? ' ' + words(x % 100) : '');
    if (x < 2000) return 'seribu' + (x - 1000 ? ' ' + words(x - 1000) : '');
    if (x < 1e6) return words(Math.floor(x / 1000)) + ' ribu' + (x % 1000 ? ' ' + words(x % 1000) : '');
    if (x < 1e9) return words(Math.floor(x / 1e6)) + ' juta' + (x % 1e6 ? ' ' + words(x % 1e6) : '');
    if (x < 1e12) return words(Math.floor(x / 1e9)) + ' miliar' + (x % 1e9 ? ' ' + words(x % 1e9) : '');
    return String(x);
  }
  function terbilang(v) {
    var x = Math.round(n(v) || 0);
    var w = x === 0 ? 'nol' : words(x);
    return w.charAt(0).toUpperCase() + w.slice(1) + ' rupiah';
  }

  /* The rate row in force on `on` for programme/side (labels only). */
  function rateOf(rows, p, side, on) {
    return (rows || []).filter(function (r) {
      var from = String(r.effective_from || '').slice(0, 10), to = r.effective_to ? String(r.effective_to).slice(0, 10) : null;
      return r.programme === p && r.side === side && from <= on && (!to || on <= to);
    }).sort(function (a, b) { return String(b.effective_from).localeCompare(String(a.effective_from)); })[0] || null;
  }

  /*
   * d = {
   *   client:   GKI.spine client object (legalName, name, npwp, logo, account)
   *   employee: the employee row
   *   line:     the run line (components snapshot, figures, ter_category, days_*)
   *   bpjs:     the line's run_bpjs rows
   *   items:    the line's run_items
   *   rates:    app/payroll/bpjs_rates rows
   *   ter_rate: the TER rate applied (fraction), when known
   *   period:   'YYYY-MM-01'
   *   made:     'YYYY-MM-DD' — the date the payslip is made
   * }
   */
  /* The payslip's CONTENT, once: html() (preview) and pdfdoc.js (the .docx the
     PDF is converted from) both draw THIS — they cannot differ in a figure. */
  function model(d) {
    var L = d.line, E = d.employee, C = d.client, on = String(d.period).slice(0, 10);
    var a = C.account || {};
    var by = {};
    (d.bpjs || []).forEach(function (b) { by[b.programme] = b; });
    function amt(p, k) { return by[p] ? (n(by[p][k]) || 0) : 0; }
    function on_(p) { return by[p] && (amt(p, 'employer_amount') > 0 || amt(p, 'employee_amount') > 0); }
    function paidBy(p) { return by[p] ? by[p].employee_share_paid_by : 'employee'; }
    function erPct(p) { var r = p === 'jkk' ? { rate: L.jkk_rate } : rateOf(d.rates, p, 'employer', on); return r ? pct(r.rate) : ''; }
    function eePct(p) { var r = rateOf(d.rates, p, 'employee', on); return r ? pct(r.rate) : ''; }

    /* Penghasilan */
    var earn = [];
    /* DAILY: api/calc writes ter_category NULL for TER harian. */
    var daily = E.rate_type === 'daily' || (L.ter_category == null && L.pph21_method === 'ter');
    (L.components || []).forEach(function (c) {
      var nm = c.name;
      if (daily && c.name === 'Gaji Pokok' && L.days_worked && c.full_amount != null) {
        nm = 'Gaji Pokok (' + L.days_worked + ' hari × Rp ' + rp(c.full_amount) + ')';
      }
      earn.push([nm, rp(c.amount)]);
    });
    (d.items || []).forEach(function (it) {
      earn.push([it.label, (it.sign === '-' ? '−' : '') + rp(it.amount)]);
    });
    /* BPJS ON THE PAYSLIP: one line per programme,
       named "BPJS Kesehatan", "JKK BPJS Ketenagakerjaan" …, NO rates.
       Penghasilan: every employer contribution (JHT and JP included — operator
       ruling 2026-10-28) plus any employee share the employer pays; the same
       total comes off again, itemised per programme and side, so net pay is
       untouched. Potongan: the employee shares the employee pays. */
    var BPJS_NAME = { kesehatan: 'BPJS Kesehatan', jht: 'JHT BPJS Ketenagakerjaan', jp: 'JP BPJS Ketenagakerjaan',
                      jkk: 'JKK BPJS Ketenagakerjaan', jkm: 'JKM BPJS Ketenagakerjaan' };
    var BPJS_ORDER = ['kesehatan', 'jkk', 'jkm', 'jht', 'jp'];
    var taxable = 0;
    BPJS_ORDER.forEach(function (p) {
      if (!on_(p)) return;
      var er0 = amt(p, 'employer_amount'), ee0 = paidBy(p) === 'employer' ? amt(p, 'employee_amount') : 0;
      if (er0) { earn.push([BPJS_NAME[p] + ' - Perusahaan', rp(er0)]); taxable += er0; }
      if (ee0) { earn.push([BPJS_NAME[p] + ' - Karyawan', rp(ee0)]); taxable += ee0; }
    });

    /* Potongan — PPh 21 on top, then BPJS, every line saying
       Karyawan or Perusahaan. */
    var ded = [], dedTotal = 0;
    var thr = d.run_type === 'thr';           /* THR run (2026-10-29): its own slip, no BPJS */
    var terLabel = thr ? 'PPh 21 (THR)' : 'PPh 21 (TER ' + (L.ter_category || '?') +
                   (d.ter_rate !== null && d.ter_rate !== undefined ? ' ' + pct(d.ter_rate) : '') + ')';
    var YA = L.pph21_annual || null;          // year-end (Pasal 17), PROTOTYPE 2026-10-23
    if (YA) terLabel = 'PPh 21 (Pasal 17, masa pajak terakhir)';
    else if (daily && !thr) terLabel = 'PPh 21 (TER harian' + (d.ter_rate !== null && d.ter_rate !== undefined ? ' ' + pct(d.ter_rate) : '') + ')';
    if (YA && n(L.pph21) < 0) ded.push(['Kelebihan PPh 21 dikembalikan (Pasal 17)', '−' + rp(-n(L.pph21))]);
    else ded.push([terLabel, rp(L.pph21)]);
    dedTotal += n(L.pph21) || 0;
    /* The employee's own share, when the employee pays it. */
    BPJS_ORDER.forEach(function (p) {
      if (on_(p) && paidBy(p) === 'employee' && amt(p, 'employee_amount')) {
        ded.push([BPJS_NAME[p] + ' - Karyawan', rp(amt(p, 'employee_amount'))]);
        dedTotal += amt(p, 'employee_amount');
      }
    });
    /* What the employer pays comes off again, itemised per programme and side. */
    BPJS_ORDER.forEach(function (p) {
      if (!on_(p)) return;
      var er = amt(p, 'employer_amount'), ee = paidBy(p) === 'employer' ? amt(p, 'employee_amount') : 0;
      if (er) { ded.push([BPJS_NAME[p] + ' - Perusahaan', rp(er)]); dedTotal += er; }
      if (ee) { ded.push([BPJS_NAME[p] + ' - Karyawan', rp(ee)]); dedTotal += ee; }
    });

    var who = [
      ['Nama', E.full_name], ['No. Karyawan', E.employee_code], ['Jabatan', E.position || '—'],
      ['Departemen', E.department || '—'], ['Status PTKP', L.ptkp_status],
      ['NPWP / NIK', (E.npwp || E.nik) ? '•••• •••• •••• ' + last4(E.npwp || E.nik) : '—']
    ];
    if (L.days_worked !== null && L.days_worked !== undefined && L.days_in_period) {
      who.push(['Hari kerja', L.days_worked + ' dari ' + L.days_in_period]);
    }
    who.push(['Mulai bekerja', tanggal(E.start_date)]);

    var tkBase = by.jht && n(by.jht.wage_base) !== null ? by.jht.wage_base
               : (by.jp && n(by.jp.wage_base) !== null ? by.jp.wage_base : null);
    var notes = [];
    if (tkBase !== null) notes.push('Dasar upah BPJS Ketenagakerjaan Rp ' + rp(tkBase));
    if (by.kesehatan && n(by.kesehatan.wage_base) !== null) notes.push('BPJS Kesehatan Rp ' + rp(by.kesehatan.wage_base));
    if (YA) notes.push('PPh 21 masa pajak terakhir dihitung ulang setahun (Pasal 17): PKP Rp ' + rp(YA.pkp) +
                       ', PPh 21 setahun Rp ' + rp(YA.tax_year) + ', sudah dipotong Rp ' + rp(YA.withheld) + '.');
    else if (daily) notes.push('Pegawai harian: PPh 21 dihitung dengan tarif efektif harian (TER harian, PP 58/2023).');
    else notes.push('PPh 21 dihitung dengan tarif efektif (TER) kategori ' + (L.ter_category || '?') + '.');

    var legal = C.legalName || C.name;
    var place = [a.city, a.province].filter(Boolean).join(', ');
    var bank = String(E.bank_code || '').toUpperCase() === 'MANDIRI' ? 'Bank Mandiri' : 'Bank ' + (E.bank_code || '');

    return {
      on: on, code: E.employee_code, title: 'SLIP-' + (thr ? 'THR-' : '') + on.slice(0, 7) + '-' + E.employee_code,
      heading: thr ? 'SLIP THR' : 'SLIP GAJI',
      logo: C.logo || null, legal: legal, legalUpper: String(legal).toUpperCase(), place: place,
      npwp: C.npwp || '', period: bulan(on), who: who,
      earn: earn, earnTotal: rp(L.taxable_gross),
      ded: ded, dedTotal: dedTotal < 0 ? '−' + rp(-dedTotal) : rp(dedTotal),
      net: rp(L.net_pay), words: terbilang(L.net_pay),
      bank: bank, account4: last4(E.bank_account), accountName: E.bank_account_name || E.full_name,
      notes: notes.join(' · '), made: tanggal(d.made)
    };
  }

  function html(d, baseHref) {
    var M = model(d);
    function rows(list, total, label) {
      return '<table>' + list.map(function (r) {
        return '<tr><td>' + esc(r[0]) + '</td><td class="ps-n">' + esc(r[1]) + '</td></tr>';
      }).join('') + '<tr class="ps-t"><td>' + label + '</td><td class="ps-n">' + total + '</td></tr></table>';
    }
    return '<!doctype html><html lang="id"><head><meta charset="utf-8">' +
      (baseHref ? '<base href="' + esc(baseHref) + '">' : '') +
      '<title>' + esc(M.title) + '</title>' +
      '<link rel="stylesheet" href="css/fonts.css">' +
      '<link rel="stylesheet" href="css/app.css"></head><body class="ps-body"><div class="ps-pg">' +
      '<div class="ps-hd"><div class="ps-co">' + (M.logo ? '<img src="' + esc(M.logo) + '" alt="">' : '') +
      '<div><b>' + esc(M.legalUpper) + '</b><span>' + esc(M.place) +
      (M.npwp ? '<br>NPWP ' + esc(M.npwp) : '') + '</span></div></div>' +
      '<div class="ps-tt"><b>' + esc(M.heading) + '</b><strong>' + M.period + '</strong></div></div>' +
      '<div class="ps-who">' + M.who.map(function (w) {
        return '<div><i>' + esc(w[0]) + '</i><b>' + esc(w[1]) + '</b></div>';
      }).join('') + '</div>' +
      '<div class="ps-cols"><div><h3><span>PENGHASILAN</span><span>Rp</span></h3>' +
      rows(M.earn, M.earnTotal, 'Total penghasilan') + '</div>' +
      '<div><h3><span>POTONGAN</span><span>Rp</span></h3>' + rows(M.ded, M.dedTotal, 'Total potongan') + '</div></div>' +
      '<div class="ps-net"><span>GAJI BERSIH DITERIMA</span><b><small>Rp</small>' + M.net + '</b></div>' +
      '<div class="ps-meta"><span><i>' + esc(M.words) + '</i></span><span>Ditransfer ke <b>' +
      esc(M.bank) + ' ••••• ' + esc(M.account4) + '</b> a.n. <b>' +
      esc(M.accountName) + '</b></span></div>' +
      '<div class="ps-foot"><span>' + esc(M.legal) + '</span><span>Dibuat ' + M.made + '</span><span></span></div>' +
      '</div></body></html>';
  }

  /* THE PDF — BROWSER PRINT. The approved
     payslip PDF was itself made by Chromium's print (measured: Creator
     Chromium, Producer Skia/PDF), so printing the same HTML reproduces it.
     A4 and the margins are the document's own @page (app.css); the
     document title is SLIP-YYYY-MM-EMP-nnnn, so "Save as PDF" proposes
     that name. Returns false when the browser blocked the window. */
  function print(d, docHtml) {   // docHtml: an already-built document (the remittance)
    /* A blob: URL, not document.write into about:blank — measured: a written
       about:blank window never loaded app.css (0 stylesheets), so the page
       printed unstyled. A blob document is a real page of this origin: its
       <base> resolves app.css and the fonts, and its <title> names the PDF. */
    var doc = docHtml || html(d, location.origin + '/');
    var url = URL.createObjectURL(new Blob([doc], { type: 'text/html;charset=utf-8' }));
    var w = window.open(url, '_blank');
    if (!w) { URL.revokeObjectURL(url); return false; }
    var fired = false;
    function go() {
      if (fired) return;
      fired = true;
      try { w.focus(); w.print(); } catch (e) { /* the user can still press Ctrl+P */ }
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    }
    w.addEventListener('load', function () {
      if (w.document.fonts && w.document.fonts.ready) w.document.fonts.ready.then(function () { setTimeout(go, 150); });
      else setTimeout(go, 400);
    });
    setTimeout(go, 6000);              // never leave the user waiting on a font
    return true;
  }

  /* The file name, by ID only. */
  function fileName(period, code, runType) {
    return 'SLIP-' + (runType === 'thr' ? 'THR-' : '') + String(period).slice(0, 7) + '-' + code + '.pdf';
  }

  if (!window.GKI) window.GKI = {};        // never reassign: store.js owns it
  window.GKI.payslip = { html: html, model: model, print: print, fileName: fileName, terbilang: terbilang };
}());
