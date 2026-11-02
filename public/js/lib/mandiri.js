/**
 * CoraByte Payroll — Bank Mandiri "Format Lama" payroll CSV.
 *   GKI.mandiri.build({ client, run, rows:[{ employee, net }] })
 *     -> { ok, text, fileName, count, total, checks[], problems[], warnings[] }
 *   GKI.mandiri.download(result)
 * The file is measured against the format before it is offered.
 * Never open and re-save the CSV in Excel: it turns account numbers into 1.23E+12.
 */
(function () {
  'use strict';

  var FIELDS = 44;                              // A..AR
  var COL = {};                                 // 'A' -> 0 … 'AR' -> 43
  (function () {
    var L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (var i = 0; i < FIELDS; i++) COL[i < 26 ? L[i] : 'A' + L[i - 26]] = i;
  }());

  function q(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }
  function line(cells) {
    var a = new Array(FIELDS);
    for (var i = 0; i < FIELDS; i++) a[i] = '';
    Object.keys(cells).forEach(function (k) { a[COL[k]] = cells[k]; });
    return a.map(q).join(',');
  }
  function digits(v) { return String(v || '').replace(/\s/g, ''); }

  /* One row per bank, exactly as the real file has it. Add a bank only from a
     real, accepted file — never from a guess. */
  var BANKS = {
    MANDIRI: { J: 'IBU', K: '',         L: 'MANDIRI', len: 13, label: 'MANDIRI' },
    BRI:     { J: 'LBU', K: 'BRINIDJA', L: 'BRI',     len: 15, label: 'BRI' },
    /* 2026-10-29: the common banks, added on his word — J 'LBU' like
       BRI, K the BIC from Mandiri's KOPRA bank list (Frequent Selections),
       L and the digit count as the operator confirmed them. Mandiri and BRI
       above are untouched. */
    BCA:     { J: 'LBU', K: 'CENAIDJA', L: 'BCA',        len: 10, label: 'BCA' },
    BNI:     { J: 'LBU', K: 'BNINIDJA', L: 'BNI',        len: 10, label: 'BNI' },
    CIMB:    { J: 'LBU', K: 'BNIAIDJA', L: 'CIMB NIAGA', len: 13, label: 'CIMB NIAGA' },
    BSI:     { J: 'LBU', K: 'BSMDIDJA', L: 'BSI',        len: 10, label: 'BSI' }
  };

  /*
   * build({ client, run, rows: [{ employee, net }] })
   *   -> { ok, text, fileName, count, total, problems[], warnings[], checks[] }
   * problems block the download; warnings do not.
   */
  function build(d) {
    var problems = [], warnings = [];
    var s = d.client.settings || {};
    var debit = digits(s.debit_account);
    if (!/^\d{13}$/.test(debit)) problems.push('The client\'s Mandiri debit account is not 13 digits (Clients → Payment).');
    if (String(s.bank_code || 'MANDIRI').toUpperCase() !== 'MANDIRI') problems.push('The client\'s bank is not Mandiri.');
    var pay = String(d.run.pay_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pay)) problems.push('The run has no pay date — set the pay day on Clients before the run is started.');
    var short = String(d.client.shortCode || '').trim();
    if (!short) problems.push('The client has no short code; set it under Home → open the client → Edit details (the file name needs it: MANDIRI-<CODE>-YYYY-MM.csv).');

    var body = [], total = 0;
    d.rows.forEach(function (r) {
      var e = r.employee, id = e.employee_code;
      var acct = digits(e.bank_account);
      var net = Number(r.net);
      var code = String(e.bank_code || '').toUpperCase(), bk = BANKS[code];
      if (!bk) { problems.push(id + ': bank "' + (code || '—') + '" is not set up for the Mandiri file (Mandiri, BRI, BCA, BNI, CIMB Niaga and BSI only).'); return; }
      if (!new RegExp('^\\d{' + bk.len + '}$').test(acct)) {
        problems.push(id + ': the ' + bk.label + ' account number is not ' + bk.len + ' digits.'); return;
      }
      if (!(net > 0) || Math.round(net) !== net) { problems.push(id + ': no whole net pay to transfer.'); return; }
      var name = String(e.bank_account_name || e.full_name || '').trim().toUpperCase();
      if (!name) { problems.push(id + ': no name on the account.'); return; }
      if (!String(e.bank_branch_city || '').trim()) warnings.push(id + ': branch city is empty (column M).');
      if (!String(e.email || '').trim()) warnings.push(id + ': no email for Mandiri\'s transfer confirmation (column R).');
      total += net;
      body.push(line({
        A: acct, B: name, F: 'IDR', G: String(net), H: 'Pembayaran Gaji',
        J: bk.J, K: bk.K, L: bk.L, M: String(e.bank_branch_city || '').trim(),
        Q: 'N', R: String(e.email || '').trim(), V: 'Y', AM: 'OUR', AN: '1', AO: 'E'
      }));
    });
    if (!d.rows.length) problems.push('There are no transfers on this run.');

    var header = line({ A: 'P', B: pay.replace(/-/g, ''), C: debit, D: String(body.length), E: String(total) });
    var text = [header].concat(body).join('\n') + '\n';
    var checks = measure(text, body.length, total);
    checks.forEach(function (c) { if (!c.ok) problems.push('Format check failed: ' + c.label + '.'); });

    return {
      ok: !problems.length, text: text, count: body.length, total: total,
      fileName: 'MANDIRI-' + short + (d.run.run_type === 'thr' ? '-THR' : '') + '-' + String(d.run.period_month).slice(0, 7) + '.csv',
      problems: problems, warnings: warnings, checks: checks
    };
  }

  /* Parse the file back and measure it — never trust the builder. */
  function measure(text, n, total) {
    var lines = text.split('\n');
    var trailing = lines[lines.length - 1] === '';
    if (trailing) lines.pop();
    function fields(l) {
      var out = [], i = 0;
      while (i < l.length) {
        if (l[i] !== '"') return null;                       // every field quoted
        var j = i + 1, v = '';
        for (;;) {
          if (j >= l.length) return null;
          if (l[j] === '"') { if (l[j + 1] === '"') { v += '"'; j += 2; continue; } break; }
          v += l[j++];
        }
        out.push(v);
        j++;
        if (j < l.length && l[j] !== ',') return null;
        i = j + 1;
        if (j === l.length - 1) return null;                 // a trailing comma
      }
      return out;
    }
    var parsed = lines.map(fields);
    var head = parsed[0] || [];
    var sumG = parsed.slice(1).reduce(function (s, f) { return s + (f ? Number(f[COL.G]) : NaN); }, 0);
    return [
      { label: 'every line has 44 fields, all quoted', ok: parsed.every(function (f) { return f && f.length === FIELDS; }) },
      { label: 'LF only, trailing newline', ok: text.indexOf('\r') === -1 && trailing },
      { label: 'no BOM', ok: text.charCodeAt(0) !== 0xFEFF },
      { label: 'header D = number of rows', ok: head[COL.D] === String(n) && parsed.length - 1 === n },
      { label: 'header E = sum of column G', ok: head[COL.E] === String(total) && sumG === total },
      { label: 'accounts are all digits at their bank\'s length (Mandiri 13 · BRI 15 · BCA 10 · BNI 10 · CIMB Niaga 13 · BSI 10), never 1.61E+12', ok: parsed.slice(1).every(function (f) {
          var bk = null;
          if (f) Object.keys(BANKS).forEach(function (k) { if (BANKS[k].L === f[COL.L]) bk = BANKS[k]; });
          return !!bk &&new RegExp('^\\d{' + bk.len + '}$').test(f[COL.A]) && f[COL.J] === bk.J && f[COL.K] === bk.K;
        }) }
    ];
  }

  /* Hand the file to the user. A Blob of a JS string is UTF-8 with NO BOM. */
  function download(result) {
    var blob = new Blob([result.text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = result.fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.parentNode.removeChild(a); }, 1000);
  }

  if (!window.GKI) window.GKI = {};
  window.GKI.mandiri = { build: build, download: download, measure: measure, BANKS: BANKS };
}());
