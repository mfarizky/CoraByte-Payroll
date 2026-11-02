/**
 * Payroll engine — pure functions, no I/O.
 *
 * Gross pay, BPJS (Kesehatan, JHT, JP, JKK, JKM; employee and employer
 * shares, floors and caps), PPh 21 with TER (monthly and daily) and the
 * Pasal 17 year-end reconciliation, THR, rounding. Rate lookups refuse
 * (throw) when no rate is in force, rather than guessing.
 * index.js feeds it data from the store; selftest.js proves it.
 */
'use strict';

var GAJI_POKOK = 'Gaji Pokok';
var PROGRAMMES = ['kesehatan', 'jht', 'jp', 'jkk', 'jkm'];
var TK = { jht: 1, jp: 1, jkk: 1, jkm: 1 };          // BPJS Ketenagakerjaan

/* 058's core.payroll_ter_category(), measured. Anything else -> refusal. */
var TER_CATEGORY = { 'TK/0': 'A', 'TK/1': 'A', 'K/0': 'A',
                     'TK/2': 'B', 'TK/3': 'B', 'K/1': 'B', 'K/2': 'B', 'K/3': 'C' };

var BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli',
             'Agustus', 'September', 'Oktober', 'November', 'Desember'];

/* A refusal is an answer, not a crash: it carries the sentence the screen
   shows, in words, and which rule produced it. */
function Refusal(sentence, code) {
  this.name = 'Refusal';
  this.message = sentence;
  this.code = code || 'refused';
}
Refusal.prototype = Object.create(Error.prototype);

function refuse(sentence, code) { throw new Refusal(sentence, code); }

/* ── exact numbers ─────────────────────────────────────────────────────── */

function cents(v) {
  var n = Number(v);
  if (v === null || v === undefined || v === '' || !isFinite(n)) return null;
  return Math.round(n * 100);
}
function micro(v) {
  var n = Number(v);
  if (v === null || v === undefined || v === '' || !isFinite(n)) return null;
  return Math.round(n * 1e6);
}
function rupiahFromCents(c) { return c / 100; }

/* base (cents) x rate (millionths) -> rupiah, HALF UP. rupiah = c*m / 1e8. */
function mulHalfUp(c, m) {
  var p = c * m;                        // <= ~1.2e9 cents x 1e6 -> safe integer
  return Math.floor((p + 50000000) / 100000000);
}
/* base (cents) x rate (millionths) -> rupiah, DOWN (PPh 21). */
function mulDown(c, m) {
  return Math.floor((c * m) / 100000000);
}

function money(r) { return Math.round(r).toLocaleString('id-ID'); }
function pct(m) { return String(m / 10000).replace('.', ',') + '%'; }
function monthName(on) { return BULAN[Number(on.slice(5, 7)) - 1] + ' ' + on.slice(0, 4); }

/* ── the lookups ─────────────────── */

function inForce(r, on) {
  var from = String(r.effective_from || '').slice(0, 10);
  var to = r.effective_to ? String(r.effective_to).slice(0, 10) : null;
  return !!from && from <= on && (!to || on <= to);
}
/* Components in force at ANY time in the run month, not only on the 1st: a
   joiner starting on the 5th has a salary row from the 5th. Same name twice =
   the latest effective_from wins. Proration handles the days. */
function componentsInMonth(rows, on, end) {
  var byName = {};
  (rows || []).forEach(function (c) {
    var from = String(c.effective_from || '').slice(0, 10);
    var to = c.effective_to ? String(c.effective_to).slice(0, 10) : null;
    if (!from || from > end || (to && to < on)) return;
    var k = String(c.name);
    if (!byName[k] || from > String(byName[k].effective_from).slice(0, 10)) byName[k] = c;
  });
  return Object.keys(byName).map(function (k) { return byName[k]; });
}
function latest(rows) {
  return rows.sort(function (a, b) {
    return String(b.effective_from).localeCompare(String(a.effective_from));
  })[0] || null;
}

function minimumWageAt(rows, region, on) {
  var r = latest(rows.filter(function (x) { return x.region === region && inForce(x, on); }));
  if (!r) refuse('No minimum wage is on record for region ' + region + ' on ' + on +
                 '. Payroll cannot be calculated without it.', 'payroll_rate_missing');
  return cents(r.amount);
}

function bpjsRateAt(rows, programme, side, on) {
  var r = latest(rows.filter(function (x) {
    return x.programme === programme && x.side === side && inForce(x, on);
  }));
  if (!r) refuse('No BPJS ' + programme + ' ' + side + ' rate is on record for ' + on +
                 '. Payroll cannot be calculated without it.', 'payroll_rate_missing');
  return { rate: micro(r.rate), cap: cents(r.wage_cap), floor: r.wage_floor_kind || null };
}

function jkkClassOk(rows, rateM, on) {
  var ok = rows.some(function (x) { return micro(x.rate) === rateM && inForce(x, on); });
  if (!ok) refuse('The client\'s JKK rate ' + pct(rateM) + ' is not one of the JKK classes on record for ' +
                  on + '. Payroll cannot be calculated without it.', 'payroll_rate_missing');
}

function terRate(rows, ptkp, grossC, on) {
  var cat = TER_CATEGORY[ptkp];
  if (!cat) refuse('PTKP status ' + ptkp + ' has no PPh 21 TER category. Payroll cannot be calculated for it.',
                   'payroll_rate_missing');
  if (grossC === null || grossC < 0) refuse('A PPh 21 TER rate needs a monthly gross of zero or more.',
                                            'payroll_rate_missing');
  var hit = rows.filter(function (t) {
    return t.category === cat && inForce(t, on) &&
           grossC >= cents(t.lower_bound) &&
           (t.upper_bound === null || t.upper_bound === undefined || grossC <= cents(t.upper_bound));
  }).sort(function (a, b) {
    return String(b.effective_from).localeCompare(String(a.effective_from)) ||
           cents(b.lower_bound) - cents(a.lower_bound);
  })[0];
  if (!hit) refuse('No PPh 21 TER band covers category ' + cat + ' at Rp ' + money(rupiahFromCents(grossC)) +
                   ' for ' + monthName(on) + '. The TER tables (PMK 168/2023) are not loaded that far. ' +
                   'A missing band is never treated as a rate of zero.', 'payroll_ter_missing');
  return { category: cat, rate: micro(hit.rate) };
}

/* ── PPh 21 for a DAILY-paid worker ──────────────
 * core.payroll_ter_daily: PP 58/2023 Lampiran D (TER harian) and PMK 168/2023
 * Pasal 12(2)b / 16(2)b. The band is found by the AVERAGE gross per day
 * worked (taxable gross / days worked); a 'ter' band's rate is applied to the
 * month's taxable gross, DOWN to the rupiah. A 'pasal17_half' band (above
 * Rp 2.500.000 a day) is REFUSED in this version — never guessed.
 * No band in force = refused, never zero. */
function terDailyRate(rows, taxableC, days, on) {
  if (!(days > 0)) refuse('A daily-paid employee needs the days worked (Hari kerja) for ' + monthName(on) +
                          ', more than 0.', 'no_days');
  var avgC = Math.floor(taxableC / days);
  var hit = (rows || []).filter(function (t) {
    return inForce(t, on) && avgC >= cents(t.lower_bound) &&
           (t.upper_bound === null || t.upper_bound === undefined || avgC <= cents(t.upper_bound));
  }).sort(function (a, b) { return String(b.effective_from).localeCompare(String(a.effective_from)); })[0];
  if (!hit) refuse('No daily PPh 21 band (TER harian) covers Rp ' + money(rupiahFromCents(avgC)) + ' a day on ' + on +
                   '. Payroll cannot be calculated without it.', 'payroll_rate_missing');
  if (hit.method !== 'ter') refuse('Rp ' + money(rupiahFromCents(avgC)) + ' a day is above Rp 2.500.000: PPh 21 is then ' +
                                   'Pasal 17 on 50% of gross (PMK 168/2023), which this version does not calculate.', 'daily_pasal17');
  return { rate: micro(hit.rate), per_day: rupiahFromCents(avgC) };
}

/* ── the last tax period: Pasal 17 on the year (PMK 168/2023) ──────────────
 * Modelled on common Indonesian payroll apps (Gadjian, Talenta, Coretax).
 *
 * In December, or in the month an employee leaves, PPh 21 is not TER:
 *   gross       = taxable gross of every month with THIS employer this year
 *                 (finished runs + the "before payroll" opening balance) + this month
 *   biaya jab.  = 5% of gross, at most Rp 500.000 x months worked (Rp 6 jt a year)
 *   pension     = employee JHT + JP of those months (also when the employer pays it)
 *   neto        = gross - biaya jabatan - pension
 *                 + neto of a previous employer this year (its A1, when given)
 *   PKP         = neto - PTKP (status of the employee, full year), DOWN to Rp 1.000, never < 0
 *   tax         = Pasal 17 layers on PKP, DOWN to the rupiah
 *   PPh 21 now  = tax - every PPh 21 already withheld this year (TER months,
 *                 opening balances, the previous employer's A1). Below zero =
 *                 over-withheld: returned to the employee with this pay.
 * NOT annualised: a joiner in the year counts only the months worked
 * (annualising is for people who become Indonesian tax residents mid-year —
 * not supported here). Every month from the start month (or January) to the
 * month before this one must be a FINISHED run (outputs or paid) or inside a
 * "before payroll" opening balance — otherwise REFUSED, never guessed.
 * input.annual = {
 *   months:   [{ period, final, taxable_gross, pension, pph21 }]   earlier runs of the year
 *   openings: [{ kind, month_from, month_to, gross, occupational_cost, pension_contrib, pph21_withheld }]
 *   ptkp: [ptkp rows], brackets: [Pasal 17 rows]
 * }
 * ==========================================================================*/
var BJ_RATE = 50000;              // 5 %, millionths
var BJ_MONTH_C = 50000000;        // Rp 500.000 a month, cents

function ptkpAt(rows, status, on) {
  var r = latest((rows || []).filter(function (x) { return x.ptkp_status === status && inForce(x, on); }));
  if (!r) refuse('No PTKP amount is on record for status ' + status + ' on ' + on +
                 '. The year-end PPh 21 cannot be calculated without it.', 'payroll_rate_missing');
  return cents(r.annual_amount);
}

/* Pasal 17 layers, in force on `on`: from 0, no gap, the top one open. */
function art17(rows, pkpRp, on) {
  var rs = (rows || []).filter(function (x) { return inForce(x, on); })
    .sort(function (a, b) { return cents(a.lower_bound) - cents(b.lower_bound); });
  var whole = rs.length > 0 && cents(rs[0].lower_bound) === 0 &&
              (rs[rs.length - 1].upper_bound === null || rs[rs.length - 1].upper_bound === undefined);
  for (var i = 1; whole && i < rs.length; i++) {
    if (cents(rs[i].lower_bound) !== cents(rs[i - 1].upper_bound) + 1) whole = false;
  }
  if (!whole) refuse('The Pasal 17 rate table is not complete for ' + monthName(on) +
                     '. The year-end PPh 21 cannot be calculated without it.', 'payroll_rate_missing');
  var sumM = 0, prevUp = 0, layers = [];
  rs.forEach(function (r) {
    var up = (r.upper_bound === null || r.upper_bound === undefined) ? null : cents(r.upper_bound) / 100;
    var top = up === null ? pkpRp : Math.min(pkpRp, up);
    var w = Math.max(0, top - prevUp);
    if (w > 0) { sumM += w * micro(r.rate); layers.push({ width: w, rate: micro(r.rate), tax: Math.floor(w * micro(r.rate) / 1e6) }); }
    if (up !== null) prevUp = up;
  });
  return { tax: Math.floor(sumM / 1e6), layers: layers };
}

function annualPph(input, on, start, taxableC, pensionRp) {
  var A = input.annual || {};
  var year = on.slice(0, 4), month = Number(on.slice(5, 7));
  var first = start.slice(0, 4) === year ? Number(start.slice(5, 7)) : 1;
  var cover = {};                       // month -> 'run' | 'opening'
  var grossC = taxableC, pensionC = pensionRp * 100, withheld = 0;

  (A.months || []).forEach(function (m) {
    var p = String(m.period).slice(0, 10);
    if (p.slice(0, 4) !== year || p >= on) return;
    if (!m.final) refuse('The ' + monthName(p) + ' run is not finished yet (outputs or paid). ' +
                         'The year-end PPh 21 needs every earlier month finished: open ' + monthName(p) +
                         ' in Payroll run and take it to Outputs or Paid first.', 'year_open');
    cover[Number(p.slice(5, 7))] = 'run';
    grossC += cents(m.taxable_gross) || 0;
    pensionC += cents(m.pension) || 0;
    withheld += Math.round(Number(m.pph21) || 0);
  });

  var prevNetoC = 0, nOpen = 0;
  (A.openings || []).forEach(function (o) {
    var g = cents(o.gross), pc = cents(o.pension_contrib), w = cents(o.pph21_withheld);
    if (g === null || g < 0 || pc === null || pc < 0 || w === null || w < 0)
      refuse('An opening balance (saldo awal PPh 21) has no valid amount.', 'bad_input');
    if (o.kind === 'previous_employer') {
      var bj = cents(o.occupational_cost);
      if (bj === null || bj < 0) refuse('An opening balance from a previous employer needs its biaya jabatan (from the A1).', 'bad_input');
      prevNetoC += g - bj - pc;
      withheld += Math.round(w / 100);
      return;
    }
    if (o.kind !== 'before_payroll') refuse('An opening balance is either "before payroll" or "previous employer".', 'bad_input');
    var f = Number(o.month_from), t = Number(o.month_to);
    if (!(f >= 1 && t >= f && t <= 12)) refuse('An opening balance has no valid months.', 'bad_input');
    for (var k = f; k <= t; k++) {
      if (k < first) refuse('The "before PAYROLL" opening balance covers ' + BULAN[k - 1] + ' ' + year +
        ', but this employee started on ' + start + ' — it can only cover ' + BULAN[first - 1] + ' to ' +
        BULAN[month - 2] + ' ' + year + '. Fix the months in Employees → PPh 21 opening balance, or the start date. ' +
        '(Income from another employer before that is a "Previous employer (A1)" balance.)', 'year_overlap');
      if (k >= month) refuse('The opening balance covers ' + BULAN[k - 1] + ' ' + year + ', which is not before ' +
        monthName(on) + '. It can only cover the months before the month being calculated.', 'year_overlap');
      if (cover[k]) refuse(BULAN[k - 1] + ' ' + year + ' is both in a payroll run and in an opening balance. Keep one.', 'year_overlap');
      cover[k] = 'opening';
    }
    nOpen++;
    grossC += g; pensionC += pc; withheld += Math.round(w / 100);
  });

  for (var mm = first; mm < month; mm++) {
    if (!cover[mm]) refuse('There is no finished payroll run and no opening balance for ' + BULAN[mm - 1] + ' ' + year +
      '. The year-end PPh 21 needs every month this employee worked. Add an opening balance (Employees → PPh 21 opening balance) or finish that run.',
      'year_gap');
  }

  var months = month - first + 1;
  var bjC = Math.min(Math.floor(grossC * BJ_RATE / 1e6), BJ_MONTH_C * months);
  var netoC = grossC - bjC - pensionC;
  var ptkpC = ptkpAt(A.ptkp, input.ptkp, on);
  var pkpRp = Math.floor((netoC + prevNetoC - ptkpC) / 100 / 1000) * 1000;
  if (pkpRp < 0) pkpRp = 0;
  var t17 = art17(A.brackets, pkpRp, on);
  return {
    method: 'annual', months: months, month_from: first, month_to: month,
    gross: grossC / 100, occupational_cost: bjC / 100, pension: pensionC / 100, neto: netoC / 100,
    previous_neto: prevNetoC / 100, ptkp: ptkpC / 100, pkp: pkpRp,
    tax_year: t17.tax, layers: t17.layers, withheld: withheld,
    pph21: t17.tax - withheld, openings: nOpen
  };
}

/* ── the calculation ───────────────────────────────────────────────────── */
/*
 * input = {
 *   period:        'YYYY-MM-01'
 *   start_date, end_date            the employee's (end may be null)
 *   ptkp:          'K/1'
 *   jkk_rate:      the client's, e.g. '0.00240'
 *   floor_region:  'UMP_NTB'
 *   kes_includes_fixed: true
 *   components:    [{ name, amount, is_fixed }]   in force on the period
 *   items:         [{ label, amount, sign }]      this line's variable items
 *   enrolment:     { kesehatan: { enrolled, by }, jht: …, jp: …, jkk: …, jkm: … }
 *   rates:         { bpjs: [], jkk: [], wage: [], ter: [] }   the listed rows
 * }
 * -> result (see the return at the end) or throws a Refusal.
 */
function calculate(input) {
  var on = String(input.period || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-01$/.test(on)) refuse('A payroll month must be the first of the month.', 'bad_input');
  var month = Number(on.slice(5, 7));
  var periodEnd = lastDay(on);

  /* Proration handling */
  var start = String(input.start_date || '').slice(0, 10);
  var end = input.end_date ? String(input.end_date).slice(0, 10) : null;
  if (!start || start > periodEnd || (end && end < on)) {
    refuse('This employee is not employed in ' + monthName(on) + '.', 'not_employed');
  }

  var totalDays = Number(periodEnd.slice(8, 10));
  var joinedInside = start > on && start <= periodEnd;
  var leftInside = !!end && end >= on && end < periodEnd;

  var daysWorked = (input.days_worked !== undefined && input.days_worked !== null && input.days_worked !== '') ? Number(input.days_worked) : null;
  var daysInPeriod = (input.days_in_period !== undefined && input.days_in_period !== null && input.days_in_period !== '') ? Number(input.days_in_period) : null;

  if (daysWorked !== null && daysInPeriod === null) {
    daysInPeriod = totalDays;
  }

  if (daysWorked === null && (joinedInside || leftInside)) {
    var startDay = joinedInside ? Number(start.slice(8, 10)) : 1;
    var endDay = leftInside ? Number(end.slice(8, 10)) : totalDays;
    daysWorked = Math.max(0, endDay - startDay + 1);
    daysInPeriod = totalDays;
  }

  if (daysWorked !== null && daysInPeriod !== null) {
    if (daysWorked < 0 || daysInPeriod <= 0 || daysWorked > daysInPeriod) {
      refuse('Hari kerja tidak valid: ' + daysWorked + ' dari ' + daysInPeriod + '.', 'bad_input');
    }
  }

  /* DAILY: Gaji Pokok is a rate per day x days worked — that IS the
     part month, so nothing is prorated; the days must be typed in. A daily
     worker is a pegawai tidak tetap: no year-end Pasal 17 recalculation. */
  var daily = input.rate_type === 'daily';
  if (daily && !(input.days_worked !== null && input.days_worked !== undefined && input.days_worked !== '' && Number(input.days_worked) > 0)) refuse('A daily-paid employee needs the days worked (Hari kerja) for ' +
                                         monthName(on) + ', more than 0.', 'no_days');
  var isProrated = !daily && daysWorked !== null && daysInPeriod !== null && daysWorked < daysInPeriod;

  /* The last tax period of the year for this employee: December, or the
     month they leave. PPh 21 is then Pasal 17 on the year, not TER (annualPph). */
  var finalPeriod = !daily && (month === 12 || (!!end && end <= periodEnd && end >= on));
  if (finalPeriod && !input.annual) {
    refuse('The last tax period (December, or the month an employee leaves) needs the year-end PPh 21 ' +
           'recalculation, and its year data was not given.', 'december');
  }

  /* inputs */
  var comps = input.components || [];
  var gp = comps.filter(function (c) { return c.name === GAJI_POKOK; });
  if (gp.length === 0) refuse('No salary component named "Gaji Pokok" is in force for ' + monthName(on) +
                              '. The BPJS base cannot be found without it.', 'no_gaji_pokok');
  if (gp.length > 1) refuse('Two salary components named "Gaji Pokok" are in force for ' + monthName(on) +
                            '. Keep one.', 'two_gaji_pokok');

  var fixedC = 0, componentsC = 0, otherFixedC = 0;
  var proratedComps = [];
  var GP = 0;

  comps.forEach(function (c) {
    var fullC = cents(c.amount);
    if (fullC === null || fullC < 0) refuse('A salary component has no valid amount.', 'bad_input');
    var actRp = (daily && c.name === GAJI_POKOK) ? Math.round(Number(c.amount) * daysWorked)
              : isProrated ? Math.round((Number(c.amount) * daysWorked) / daysInPeriod) : (fullC / 100);
    var actC = actRp * 100;
    componentsC += actC;
    if (c.is_fixed) fixedC += actC;
    if (c.name === GAJI_POKOK) GP = actC;
    else if (c.is_fixed) otherFixedC += actC;

    proratedComps.push({
      name: c.name,
      amount: actRp,
      full_amount: fullC / 100,
      is_fixed: !!c.is_fixed
    });
  });

  var plusC = 0, minusC = 0;
  (input.items || []).forEach(function (it) {
    var a = cents(it.amount);
    if (a === null || a < 0) refuse('A variable item has no valid amount.', 'bad_input');
    if (it.sign === '+') plusC += a;
    else if (it.sign === '-') minusC += a;
    else refuse('A variable item either adds or deducts.', 'bad_input');
  });

  var grossC = componentsC + plusC - minusC;
  if (grossC < 0) refuse('The deductions are larger than the pay. A negative gross is never paid.', 'negative');

  /* bases */
  var R = input.rates || {};
  var ump = minimumWageAt(R.wage || [], input.floor_region, on);
  var jkkRate = micro(input.jkk_rate);
  var tkRaw = GP;
  var kesRaw = GP + (input.kes_includes_fixed ? otherFixedC : 0);

  function baseFor(raw, row) {
    var b = raw;
    if (row && row.floor === 'minimum_wage' && b < ump) b = ump;
    if (row && row.cap !== null && b > row.cap) b = row.cap;
    return b;
  }

  /* programmes */
  var enrol = input.enrolment || {};
  var lines = [];
  var employerRp = 0, employeeDeductRp = 0, employerPaysEmployeeRp = 0, taxableAddRp = 0;
  var taxableParts = [];

  /* BPJS THIS MONTH: when the line lists its
     ticked programmes, an unticked one is calculated as not this month (0).
     No list given (the selftest's base case) = enrolment alone decides. */
  var ticked = Array.isArray(input.bpjs_programmes) ? input.bpjs_programmes : null;
  PROGRAMMES.forEach(function (p) {
    var e = enrol[p] || { enrolled: false, by: p in TK && (p === 'jkk' || p === 'jkm') ? 'employer' : 'employee' };
    if (ticked && ticked.indexOf(p) === -1) e = { enrolled: false, by: e.by };
    var by = (p === 'jkk' || p === 'jkm') ? 'employer' : (e.by === 'employer' ? 'employer' : 'employee');
    if (!e.enrolled) {
      lines.push({ programme: p, enrolled: false, wage_base: null, employee_amount: 0,
                   employer_amount: 0, employee_share_paid_by: by });
      return;
    }
    var erRate, eeRate = null, erRow = null, eeRow = null, base;
    if (p === 'jkk') {
      jkkClassOk(R.jkk || [], jkkRate, on);
      erRate = jkkRate;
      base = tkRaw < ump ? ump : tkRaw;                 // TK floor; JKK has no cap
    } else {
      erRow = bpjsRateAt(R.bpjs || [], p, 'employer', on);
      erRate = erRow.rate;
      if (p !== 'jkm') { eeRow = bpjsRateAt(R.bpjs || [], p, 'employee', on); eeRate = eeRow.rate; }
      base = baseFor(p === 'kesehatan' ? kesRaw : tkRaw, erRow);
    }
    var er = mulHalfUp(base, erRate);
    var ee = eeRate === null ? 0 : mulHalfUp(eeRow ? baseFor(p === 'kesehatan' ? kesRaw : tkRaw, eeRow) : base, eeRate);

    employerRp += er;
    if (ee) {
      if (by === 'employer') { employerPaysEmployeeRp += ee; taxableAddRp += ee; }
      else employeeDeductRp += ee;
    }
    /* ⚠️ OPERATOR RULING 2026-10-28: the employer's JHT and JP are ALSO added
       to taxable gross, with every other employer contribution. This departs
       from PP 58/2023 / PMK 168/2023 (employer JHT and JP are not PPh 21
       income); the operator was told so and chose it. Was: Kes, JKK, JKM only. */
    taxableAddRp += er;

    lines.push({
      programme: p, enrolled: true, wage_base: rupiahFromCents(base),
      employee_amount: ee, employer_amount: er, employee_share_paid_by: by,
      employer_rate: erRate, employee_rate: eeRate
    });
  });

  var grossRp = grossC / 100;
  var taxableC = grossC + taxableAddRp * 100;
  /* THR / bonus runs of the same month ("PPh 21 digabung
     nanti di reguler"). The month's tax is found on the COMBINED taxable gross;
     this run carries what the other runs have not already withheld. This run's
     own taxable_gross stays its own — the other runs read it. */
  var offTaxC = input.offcycle ? (cents(input.offcycle.taxable_gross) || 0) : 0;
  var offPph = input.offcycle ? Math.round(Number(input.offcycle.pph21 || 0)) : 0;
  var combinedC = taxableC + offTaxC;
  var ter = null, annual = null, pph;
  if (finalPeriod) {
    /* employee JHT + JP of this month, whoever pays it */
    var pensionRp = lines.reduce(function (s, l) {
      return s + ((l.programme === 'jht' || l.programme === 'jp') ? l.employee_amount : 0);
    }, 0);
    annual = annualPph(input, on, start, combinedC, pensionRp);
    pph = annual.pph21;                         // below zero = returned to the employee
  } else if (daily) {
    ter = terDailyRate(R.ter_daily || [], combinedC, daysWorked, on);
    ter.category = null;
    pph = mulDown(combinedC, ter.rate);
  } else {
    ter = terRate(R.ter || [], input.ptkp, combinedC, on);
    pph = mulDown(combinedC, ter.rate);
  }
  var totalPph = pph;
  pph = totalPph - offPph;
  if (pph < 0 && !annual) {
    refuse('The month\'s THR/bonus run already withheld more PPh 21 than the whole month needs. Recalculate that run, then this one.', 'offcycle_negative');
  }

  var netC = grossC - employeeDeductRp * 100 - pph * 100;
  if (netC < 0) refuse('The deductions are larger than the pay. A negative net is never paid.', 'negative');

  var tkLine = lines.filter(function (l) { return l.programme === 'jht' && l.enrolled; })[0] ||
               lines.filter(function (l) { return TK[l.programme] && l.enrolled; })[0];
  var kesLine = lines.filter(function (l) { return l.programme === 'kesehatan' && l.enrolled; })[0];

  return {
    period: on,
    ter_category: daily ? null : (ter ? ter.category : (TER_CATEGORY[input.ptkp] || null)),
    ter_rate: ter ? ter.rate : null,            // millionths; null in the last period
    pph21_method: annual ? 'annual' : 'ter',     // 'ter' also for TER harian
    rate_type: daily ? 'daily' : 'monthly',
    annual: annual,                             // the year-end working, or null
    bpjs_wage_floor: rupiahFromCents(ump),
    days_worked: daysWorked,
    days_in_period: daysInPeriod,
    is_prorated: isProrated,
    components: proratedComps,
    gross_fixed: fixedC / 100,
    components_total: componentsC / 100,
    variable: (plusC - minusC) / 100,
    gross_pay: grossRp,
    taxable_gross: taxableC / 100,
    taxable_bpjs: taxableAddRp,                 // "Tunjangan BPJS" on the payslip
    pph21: pph,
    offcycle_taxable: offTaxC / 100, offcycle_pph: offPph, total_pph: totalPph,
    employee_bpjs: employeeDeductRp,            // deducted from pay
    employer_pays_employee_bpjs: employerPaysEmployeeRp,
    employer_bpjs: employerRp + employerPaysEmployeeRp,   // the client's whole BPJS cost
    net_pay: netC / 100,
    tk_base: tkLine ? tkLine.wage_base : rupiahFromCents(tkRaw < ump ? ump : tkRaw),
    kes_base: kesLine ? kesLine.wage_base : null,
    bpjs: lines
  };
}

/* ── THR (run_type 'thr') ─────────────────────────────
 * A THR run is a SEPARATE run in the month, with its own pay date. Two things:
 *
 * 1. THE AMOUNT (Permenaker 6/2016, as agreed): service is counted in WHOLE
 *    months up to the pay date. 12 months or more = one month's wage; 1 to 11
 *    months = months / 12 x one month's wage; under 1 month = no THR (the
 *    employee is not on the run). One month's wage = Gaji Pokok + the fixed
 *    allowances in force that month (never prorated, no variable items). A
 *    DAILY worker has no monthly wage: the average monthly fixed pay of his
 *    finished regular runs (up to the last 12) stands in, and with none the
 *    amount is left to be typed in as an item — never guessed.
 *
 * 2. THE TAX. THR carries NO BPJS (it is not upah for BPJS) and is paid on top
 *    of the month's regular pay, so PPh 21 is found on the COMBINED month:
 *      PPh 21 of this run = tax(regular taxable gross + THR) - what the
 *      month's other runs already withheld.
 *    tax() is TER monthly (or TER harian for a daily worker). In the last tax
 *    period (December, or the month a person leaves) it is the year-end Pasal
 *    17 working, with the combined gross. The regular run is READ, never
 *    changed: it keeps its own tax; this run carries the difference.
 *    If the regular line is missing the run REFUSES — never a guess.
 * ==========================================================================*/
function wholeMonths(start, ref) {
  var ys = Number(start.slice(0, 4)), ms = Number(start.slice(5, 7)), ds = Number(start.slice(8, 10));
  var yr = Number(ref.slice(0, 4)), mr = Number(ref.slice(5, 7)), dr = Number(ref.slice(8, 10));
  var m = (yr - ys) * 12 + (mr - ms);
  if (dr < ds) m--;
  return m < 0 ? 0 : m;
}

/* input = { start_date, end_date, ref, rate_type, components[], history[] }
   history = monthly fixed pay (rupiah) of finished regular runs, for a daily worker. */
function thrAmount(input) {
  var ref = String(input.ref || '').slice(0, 10);
  var start = String(input.start_date || '').slice(0, 10);
  var end = input.end_date ? String(input.end_date).slice(0, 10) : null;
  if (!start || !ref || start > ref || (end && end < ref)) {
    return { eligible: false, months: 0, reason: 'not_employed' };
  }
  var months = wholeMonths(start, ref);
  if (months < 1) return { eligible: false, months: months, reason: 'under_one_month' };
  var used = Math.min(months, 12);
  if (input.rate_type === 'daily') {
    var hist = (input.history || []).filter(function (h) { return h !== null && isFinite(Number(h)); });
    if (!hist.length) return { eligible: true, months: months, used: used, wage: null, amount: null, basis: 'daily', reason: 'no_history' };
    var sumC = hist.reduce(function (t, h) { return t + Math.round(Number(h) * 100); }, 0);
    var wageC = Math.round(sumC / hist.length);
    return { eligible: true, months: months, used: used, wage: wageC / 100,
             amount: Math.round(Math.round(wageC * used / 12) / 100), basis: 'daily', history_months: hist.length };
  }
  var comps = input.components || [];
  var wageSum = 0;
  comps.forEach(function (c) {
    if (c.name === GAJI_POKOK || c.is_fixed) {
      var a = cents(c.amount);
      if (a === null || a < 0) refuse('A salary component has no valid amount.', 'bad_input');
      wageSum += a;
    }
  });
  if (!comps.some(function (c) { return c.name === GAJI_POKOK; })) {
    refuse('No salary component named "Gaji Pokok" is in force, so one month\'s wage for the THR cannot be found.', 'no_gaji_pokok');
  }
  return { eligible: true, months: months, used: used, wage: wageSum / 100,
           amount: Math.round(Math.round(wageSum * used / 12) / 100), basis: 'monthly' };
}

/* input = { period, start_date, end_date, ptkp, rate_type, components[] (the THR line), items[],
             regular: { taxable_gross, pph21, pension, days_worked } | null,
             others_pph, rates:{ ter, ter_daily }, annual } -> result, or throws a Refusal. */
function calculateThr(input) {
  var on = String(input.period || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-01$/.test(on)) refuse('A payroll month must be the first of the month.', 'bad_input');
  var month = Number(on.slice(5, 7));
  var periodEnd = lastDay(on);
  var start = String(input.start_date || '').slice(0, 10);
  var end = input.end_date ? String(input.end_date).slice(0, 10) : null;
  if (!start || start > periodEnd || (end && end < on)) refuse('This employee is not employed in ' + monthName(on) + '.', 'not_employed');
  var daily = input.rate_type === 'daily';
  var R = input.rates || {};

  var thrC = 0, proratedComps = [];
  (input.components || []).forEach(function (c) {
    var a = cents(c.amount);
    if (a === null || a < 0) refuse('The THR amount is not valid.', 'bad_input');
    thrC += a;
    proratedComps.push({ name: c.name, amount: a / 100, full_amount: a / 100, is_fixed: true });
  });
  var plusC = 0, minusC = 0;
  (input.items || []).forEach(function (it) {
    var a = cents(it.amount);
    if (a === null || a < 0) refuse('A variable item has no valid amount.', 'bad_input');
    if (it.sign === '+') plusC += a;
    else if (it.sign === '-') minusC += a;
    else refuse('A variable item either adds or deducts.', 'bad_input');
  });
  var grossC = thrC + plusC - minusC;
  if (grossC <= 0) {
    refuse('There is no THR amount for this employee. Add the THR as an item, or Restart the run to rebuild it from the service months.', 'no_thr');
  }

  /* The month's regular line, when it has figures. Without it the THR is taxed
     ALONE now (TER on the THR) and the regular run absorbs it when it is
     calculated. Daily workers and the last tax period
     need the regular line (days worked / year-end working), so they refuse. */
  var reg = input.regular;
  var hasReg = !!reg && reg.taxable_gross !== null && reg.taxable_gross !== undefined && reg.pph21 !== null && reg.pph21 !== undefined;
  var regTaxC = hasReg ? cents(reg.taxable_gross) : 0;
  var regPph = hasReg ? Math.round(Number(reg.pph21)) : 0;
  var othersPph = Math.round(Number(input.others_pph || 0));
  var othersTaxC = cents(input.others_taxable || 0) || 0;
  var combinedC = regTaxC + othersTaxC + grossC;

  var finalPeriod = !daily && (month === 12 || (!!end && end <= periodEnd && end >= on));
  var ter = null, annual = null, totalPph;
  if (!hasReg && (daily || finalPeriod)) {
    refuse('The regular run for ' + monthName(on) + ' has no calculated line for this employee. ' + (daily
      ? 'A daily worker\'s PPh 21 needs the days worked, so calculate the regular run first.'
      : 'This is the last tax period, whose PPh 21 is a year-end working on the whole month, so calculate the regular run first.'), 'no_regular');
  }
  if (finalPeriod) {
    if (!input.annual) {
      refuse('The last tax period (December, or the month an employee leaves) needs the year-end PPh 21 recalculation, ' +
             'and its year data was not given.', 'december');
    }
    annual = annualPph(input, on, start, combinedC, Math.round(Number(reg.pension || 0)));
    totalPph = annual.pph21;
  } else if (daily) {
    ter = terDailyRate(R.ter_daily || [], combinedC, Number(reg.days_worked), on);
    ter.category = null;
    totalPph = mulDown(combinedC, ter.rate);
  } else {
    ter = terRate(R.ter || [], input.ptkp, combinedC, on);
    totalPph = mulDown(combinedC, ter.rate);
  }

  var pph = totalPph - regPph - othersPph;
  if (pph < 0 && !annual) {
    refuse('The regular run already withheld more PPh 21 than the whole month needs. Recalculate the regular run, then this one.', 'offcycle_negative');
  }
  var netC = grossC - pph * 100;
  if (netC < 0) refuse('The deductions are larger than the pay. A negative net is never paid.', 'negative');

  return {
    period: on, kind: 'thr',
    ter_category: daily ? null : (ter ? ter.category : (TER_CATEGORY[input.ptkp] || null)),
    ter_rate: ter ? ter.rate : null,
    pph21_method: annual ? 'annual' : 'ter',
    rate_type: daily ? 'daily' : 'monthly',
    annual: annual,
    bpjs_wage_floor: null,
    days_worked: null, days_in_period: null, is_prorated: false,
    components: proratedComps,
    gross_fixed: thrC / 100,
    components_total: thrC / 100,
    variable: (plusC - minusC) / 100,
    gross_pay: grossC / 100,
    taxable_gross: grossC / 100,
    taxable_bpjs: 0,
    pph21: pph,
    employee_bpjs: 0, employer_pays_employee_bpjs: 0, employer_bpjs: 0,
    net_pay: netC / 100,
    tk_base: null, kes_base: null,
    bpjs: [],
    has_regular: hasReg,
    regular_taxable: regTaxC / 100,
    combined_taxable: combinedC / 100,
    regular_pph: regPph, others_pph: othersPph, total_pph: totalPph
  };
}

function lastDay(on) {
  var y = Number(on.slice(0, 4)), m = Number(on.slice(5, 7));
  var d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return on.slice(0, 8) + String(d).padStart(2, '0');
}

module.exports = {
  calculate: calculate,
  calculateThr: calculateThr,
  thrAmount: thrAmount,
  wholeMonths: wholeMonths,
  Refusal: Refusal,
  TER_CATEGORY: TER_CATEGORY,
  GAJI_POKOK: GAJI_POKOK,
  lastDay: lastDay,
  inForce: inForce,
  componentsInMonth: componentsInMonth,
  monthName: monthName,
  isFinalPeriod: function (on, endDate) {
    var ym = String(on).slice(0, 7);
    return Number(String(on).slice(5, 7)) === 12 || (!!endDate && String(endDate).slice(0, 7) === ym);
  }
};
