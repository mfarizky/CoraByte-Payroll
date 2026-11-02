/**
 * Payroll engine self-test: one fictional employee with known figures,
 * checked line by line. Shown on the run screen and used by `npm test`.
 */
'use strict';

var engine = require('./engine');

var RATES = {
  bpjs: [
    { programme: 'jht', side: 'employer', rate: '0.037000', wage_cap: null, wage_floor_kind: 'minimum_wage', effective_from: '2015-07-01', effective_to: null },
    { programme: 'jht', side: 'employee', rate: '0.020000', wage_cap: null, wage_floor_kind: 'minimum_wage', effective_from: '2015-07-01', effective_to: null },
    { programme: 'jkm', side: 'employer', rate: '0.003000', wage_cap: null, wage_floor_kind: 'minimum_wage', effective_from: '2015-07-01', effective_to: null },
    { programme: 'kesehatan', side: 'employer', rate: '0.040000', wage_cap: '12000000.00', wage_floor_kind: 'minimum_wage', effective_from: '2020-01-01', effective_to: null },
    { programme: 'kesehatan', side: 'employee', rate: '0.010000', wage_cap: '12000000.00', wage_floor_kind: 'minimum_wage', effective_from: '2020-01-01', effective_to: null },
    { programme: 'jp', side: 'employer', rate: '0.020000', wage_cap: '11086300.00', wage_floor_kind: 'minimum_wage', effective_from: '2026-03-01', effective_to: null },
    { programme: 'jp', side: 'employee', rate: '0.010000', wage_cap: '11086300.00', wage_floor_kind: 'minimum_wage', effective_from: '2026-03-01', effective_to: null }
  ],
  jkk: [
    { class_code: 'I', rate: '0.002400', effective_from: '2015-07-01', effective_to: null },
    { class_code: 'II', rate: '0.005400', effective_from: '2015-07-01', effective_to: null },
    { class_code: 'III', rate: '0.008900', effective_from: '2015-07-01', effective_to: null },
    { class_code: 'IV', rate: '0.012700', effective_from: '2015-07-01', effective_to: null },
    { class_code: 'V', rate: '0.017400', effective_from: '2015-07-01', effective_to: null }
  ],
  wage: [
    { region: 'UMP_NTB', amount: '2602931.00', effective_from: '2025-01-01', effective_to: '2025-12-31' },
    { region: 'UMP_NTB', amount: '2673861.00', effective_from: '2026-01-01', effective_to: null }
  ],
  ter: [
    { category: 'A', lower_bound: '0.00', upper_bound: '5400000.00', rate: '0.000000', effective_from: '2024-01-01', effective_to: null },
    { category: 'B', lower_bound: '0.00', upper_bound: '6200000.00', rate: '0.000000', effective_from: '2024-01-01', effective_to: null },
    { category: 'C', lower_bound: '0.00', upper_bound: '6600000.00', rate: '0.000000', effective_from: '2024-01-01', effective_to: null }
  ],
  /* 070 seed copy: PP 58/2023 Lampiran D (TER harian), PMK 168/2023 Pasal 12(2)b */
  ter_daily: [
    { lower_bound: '0.00', upper_bound: '450000.00', method: 'ter', rate: '0.000000', effective_from: '2024-01-01', effective_to: null },
    { lower_bound: '450000.01', upper_bound: '2500000.00', method: 'ter', rate: '0.005000', effective_from: '2024-01-01', effective_to: null },
    { lower_bound: '2500000.01', upper_bound: null, method: 'pasal17_half', rate: null, effective_from: '2024-01-01', effective_to: null }
  ]
};

/* Year-end PPh 21 (PROTOTYPE 2026-10-23): PTKP (PMK 101/2016) and Pasal 17 (UU 7/2021) copies. */
var PTKP = [
  { ptkp_status: 'TK/0', annual_amount: '54000000.00', effective_from: '2016-01-01', effective_to: null },
  { ptkp_status: 'K/3', annual_amount: '72000000.00', effective_from: '2016-01-01', effective_to: null }
];
var ART17 = [
  { lower_bound: '0.00', upper_bound: '60000000.00', rate: '0.050000', effective_from: '2022-01-01', effective_to: null },
  { lower_bound: '60000000.01', upper_bound: '250000000.00', rate: '0.150000', effective_from: '2022-01-01', effective_to: null },
  { lower_bound: '250000000.01', upper_bound: '500000000.00', rate: '0.250000', effective_from: '2022-01-01', effective_to: null },
  { lower_bound: '500000000.01', upper_bound: '5000000000.00', rate: '0.300000', effective_from: '2022-01-01', effective_to: null },
  { lower_bound: '5000000000.01', upper_bound: null, rate: '0.350000', effective_from: '2022-01-01', effective_to: null }
];

function all(enrolled, kesBy) {
  return {
    kesehatan: { enrolled: enrolled, by: kesBy || 'employee' },
    jht: { enrolled: enrolled, by: 'employee' }, jp: { enrolled: enrolled, by: 'employee' },
    jkk: { enrolled: enrolled, by: 'employer' }, jkm: { enrolled: enrolled, by: 'employer' }
  };
}

/* Budi Santoso (fictional), October 2026 — PROTOTYPE: round numbers (gaji pokok 5.000.000,
   transport 500.000, lembur 500.000; K/3 = TER C). Not the renders' original case. */
var BUDI = {
  period: '2026-10-01', start_date: '2025-03-01', end_date: null, ptkp: 'K/3',
  jkk_rate: '0.00240', floor_region: 'UMP_NTB', kes_includes_fixed: true,
  components: [
    { name: 'Gaji Pokok', amount: '5000000.00', is_fixed: true },
    { name: 'Tunjangan Transportasi', amount: '500000.00', is_fixed: true }
  ],
  items: [{ label: 'Lembur', amount: '500000.00', sign: '+' }],
  enrolment: all(true, 'employer'),
  rates: RATES
};

function variant(over) {
  var o = JSON.parse(JSON.stringify(BUDI));
  Object.keys(over).forEach(function (k) { o[k] = over[k]; });
  return o;
}

function refusedWith(input, code) {
  try { engine.calculate(input); return { ok: false, got: 'calculated' }; }
  catch (e) {
    if (!(e instanceof engine.Refusal)) return { ok: false, got: 'error' };
    return { ok: e.code === code, got: e.code };
  }
}

function run() {
  var checks = [];
  function eq(label, got, want) {
    checks.push({ label: label, ok: got === want, got: got, want: want });
  }

  var r = engine.calculate(BUDI);
  eq('Gross pay', r.gross_pay, 6000000);
  /* + employer JHT 185.000 and JP 100.000 */
  eq('Taxable gross', r.taxable_gross, 6587000);
  eq('Net pay', r.net_pay, 5850000);
  eq('Employer BPJS', r.employer_bpjs, 587000);
  eq('Employee BPJS deducted', r.employee_bpjs, 150000);
  eq('PPh 21 (TER C 0 %)', r.pph21, 0);

  /* TER A boundary: no BPJS, so taxable gross = Gaji Pokok exactly. */
  var a0 = engine.calculate(variant({ ptkp: 'TK/0', items: [], enrolment: all(false),
    components: [{ name: 'Gaji Pokok', amount: '5400000.00', is_fixed: true }] }));
  eq('TER A at 5.400.000 = 0 %', a0.pph21, 0);
  var a1 = refusedWith(variant({ ptkp: 'TK/0', items: [], enrolment: all(false),
    components: [{ name: 'Gaji Pokok', amount: '5400001.00', is_fixed: true }] }), 'payroll_ter_missing');
  checks.push({ label: 'TER A at 5.400.001 refused', ok: a1.ok, got: a1.got, want: 'payroll_ter_missing' });

  var jp = refusedWith(variant({ period: '2026-02-01' }), 'payroll_rate_missing');
  checks.push({ label: 'JP before 2026-03-01 refused', ok: jp.ok, got: jp.got, want: 'payroll_rate_missing' });

  var dec = refusedWith(variant({ period: '2026-12-01' }), 'december');
  checks.push({ label: 'December without year data refused', ok: dec.ok, got: dec.got, want: 'december' });

  /* Year-end, fictional joiner (Budi Santoso, TK/0, from 1 Oct 2026, Gaji Pokok 20.000.000, no BPJS):
     Oct + Nov TER A 9 % = 1.800.000 each. Dec: gross 60.000.000 · biaya jabatan capped 3 x 500.000
     = 1.500.000 · neto 58.500.000 · PTKP 54.000.000 · PKP 4.500.000 · tax 5 % 225.000 ·
     withheld 3.600.000 -> PPh 21 Dec -3.375.000 (returned) · net 23.375.000. Not annualised. */
  var J = { period: '2026-12-01', start_date: '2026-10-01', end_date: null, ptkp: 'TK/0', items: [],
            enrolment: all(false), components: [{ name: 'Gaji Pokok', amount: '20000000.00', is_fixed: true }] };
  function yr(extraOpen, months) {
    return { months: months || [
               { period: '2026-10-01', final: true, taxable_gross: '20000000.00', pension: 0, pph21: '1800000.00' },
               { period: '2026-11-01', final: true, taxable_gross: '20000000.00', pension: 0, pph21: '1800000.00' }],
             openings: extraOpen || [], ptkp: PTKP, brackets: ART17 };
  }
  var j1 = engine.calculate(variant(Object.assign({}, J, { annual: yr() })));
  eq('Year-end joiner: biaya jabatan capped per month', j1.annual.occupational_cost, 1500000);
  eq('Year-end joiner: PKP', j1.annual.pkp, 4500000);
  eq('Year-end joiner: PPh 21 Dec (returned)', j1.pph21, -3375000);
  eq('Year-end joiner: net pay', j1.net_pay, 23375000);

  /* + a previous employer's A1 (Jan-Sep): gross 90.000.000, biaya jabatan 4.500.000, pension 2.700.000,
     PPh 21 3.000.000 -> neto 82.800.000 + 58.500.000 - 54.000.000 = PKP 87.300.000 ->
     3.000.000 + 27.300.000 x 15 % = 7.095.000 - 6.600.000 withheld = 495.000. */
  var j2 = engine.calculate(variant(Object.assign({}, J, { annual: yr([{ kind: 'previous_employer', month_from: 1, month_to: 9,
    gross: '90000000.00', occupational_cost: '4500000.00', pension_contrib: '2700000.00', pph21_withheld: '3000000.00' }]) })));
  eq('Year-end with previous employer A1: PPh 21 Dec', j2.pph21, 495000);

  var gap = refusedWith(variant(Object.assign({}, J, { annual: yr(null, [
    { period: '2026-11-01', final: true, taxable_gross: '20000000.00', pension: 0, pph21: '1800000.00' }]) })), 'year_gap');
  checks.push({ label: 'Year-end with a missing month refused', ok: gap.ok, got: gap.got, want: 'year_gap' });
  var opn = refusedWith(variant(Object.assign({}, J, { annual: yr(null, [
    { period: '2026-10-01', final: true, taxable_gross: '20000000.00', pension: 0, pph21: '1800000.00' },
    { period: '2026-11-01', final: false, taxable_gross: '20000000.00', pension: 0, pph21: '1800000.00' }]) })), 'year_open');
  checks.push({ label: 'Year-end with an unfinished run refused', ok: opn.ok, got: opn.got, want: 'year_open' });

  var rPr = engine.calculate(variant({ start_date: '2026-10-15' }));
  eq('Joiner inside the month: days worked 17/31', rPr.days_worked, 17);
  eq('Joiner inside the month: prorated gross pay', rPr.gross_pay, 3516129);

  var rCust = engine.calculate(variant({ days_worked: 10, days_in_period: 30 }));
  eq('Custom hari kerja: 10/30 gross pay', rCust.gross_pay, 2333334);

  /* DAILY, fictional: Gaji Pokok 600.000 a day x 20 days, no BPJS ->
     gross 12.000.000 · 600.000 a day = band 0,5 % -> PPh 21 60.000 · net 11.940.000.
     December does not trigger the year-end for a daily worker. */
  var D = { rate_type: 'daily', ptkp: 'TK/0', items: [], enrolment: all(false), days_worked: 20,
            components: [{ name: 'Gaji Pokok', amount: '600000.00', is_fixed: true }] };
  var d1 = engine.calculate(variant(D));
  eq('Daily: 600.000 x 20 days gross', d1.gross_pay, 12000000);
  eq('Daily: TER harian 0,5 % PPh 21', d1.pph21, 60000);
  eq('Daily: net pay', d1.net_pay, 11940000);
  var d2 = engine.calculate(variant(Object.assign({}, D, { components: [{ name: 'Gaji Pokok', amount: '450000.00', is_fixed: true }] })));
  eq('Daily: 450.000 a day = 0 %', d2.pph21, 0);
  var d3 = refusedWith(variant(Object.assign({}, D, { days_worked: null })), 'no_days');
  checks.push({ label: 'Daily without days worked refused', ok: d3.ok, got: d3.got, want: 'no_days' });
  var d4 = refusedWith(variant(Object.assign({}, D, { components: [{ name: 'Gaji Pokok', amount: '3000000.00', is_fixed: true }], days_worked: 2 })), 'daily_pasal17');
  checks.push({ label: 'Daily above 2.500.000 a day refused', ok: d4.ok, got: d4.got, want: 'daily_pasal17' });
  var d5 = engine.calculate(variant(Object.assign({}, D, { period: '2026-12-01' })));
  eq('Daily in December: still TER harian', d5.pph21, 60000);

  /* BPJS this month: only Kesehatan ticked -> JHT/JP/JKK/JKM 0.
     Kes base 5.500.000 (Gaji Pokok + fixed): employer 4 % 220.000, employee 1 % 55.000 paid by employer. */
  var t1 = engine.calculate(variant({ bpjs_programmes: ['kesehatan'] }));
  eq('BPJS this month: only Kesehatan ticked, employer BPJS', t1.employer_bpjs, 275000);
  eq('BPJS this month: only Kesehatan ticked, employee deduction', t1.employee_bpjs, 0);
  var t0 = engine.calculate(variant({ bpjs_programmes: [] }));
  eq('BPJS this month: nothing ticked, employer BPJS', t0.employer_bpjs, 0);

  /* Joiner on the 5th (Budi Santoso): the salary row starts 2026-10-05 and is still found for October. */
  var jm = engine.componentsInMonth([
    { name: 'Gaji Pokok', amount: '5000000.00', effective_from: '2026-10-05', effective_to: null },
    { name: 'Gaji Pokok', amount: '4000000.00', effective_from: '2026-01-01', effective_to: '2026-10-04' },
    { name: 'Tunjangan', amount: '100000.00', effective_from: '2026-11-01', effective_to: null }], '2026-10-01', '2026-10-31');
  eq('Joiner on the 5th: one Gaji Pokok found', jm.length, 1);
  eq('Joiner on the 5th: the latest row wins', jm[0].amount, '5000000.00');

  /* THR (2026-10-29): the amount, then the tax on top of the regular month.
     Rate rows below are a test copy: A has a 0 % first band and a 3 % band to 20.000.000. */
  var wageComps = [{ name: 'Gaji Pokok', amount: '5000000.00', is_fixed: true }, { name: 'Tunjangan Tetap', amount: '1000000.00', is_fixed: true },
                   { name: 'Uang Makan', amount: '700000.00', is_fixed: false }];
  var th2 = engine.thrAmount({ start_date: '2026-01-15', ref: '2026-03-16', rate_type: 'monthly', components: wageComps });
  eq('THR: 2 whole months = 2/12 of Gaji Pokok + fixed (6.000.000)', th2.amount, 1000000);
  eq('THR: whole months count', th2.months, 2);
  var th14 = engine.thrAmount({ start_date: '2025-01-01', ref: '2026-03-16', rate_type: 'monthly', components: wageComps });
  eq('THR: 12 months or more = one month\'s wage', th14.amount, 6000000);
  var th0 = engine.thrAmount({ start_date: '2026-03-02', ref: '2026-03-16', rate_type: 'monthly', components: wageComps });
  eq('THR: under one month = not eligible', th0.eligible, false);
  var thd = engine.thrAmount({ start_date: '2025-01-01', ref: '2026-03-16', rate_type: 'daily', components: [], history: [3000000, 3600000] });
  eq('THR daily: average of the finished months', thd.amount, 3300000);
  var thn = engine.thrAmount({ start_date: '2025-01-01', ref: '2026-03-16', rate_type: 'daily', components: [], history: [] });
  eq('THR daily with no history: no amount (typed by hand)', thn.amount, null);

  var TER2 = [{ category: 'A', lower_bound: '0.00', upper_bound: '5400000.00', rate: '0.000000', effective_from: '2024-01-01', effective_to: null },
              { category: 'A', lower_bound: '5400000.01', upper_bound: '20000000.00', rate: '0.030000', effective_from: '2024-01-01', effective_to: null }];
  var THR = { period: '2026-03-01', start_date: '2025-01-01', end_date: null, ptkp: 'TK/0', rate_type: 'monthly',
              components: [{ name: 'THR', amount: '6000000.00', is_fixed: true }], items: [],
              regular: { taxable_gross: '5000000.00', pph21: 0, pension: 0 }, others_pph: 0, rates: { ter: TER2, ter_daily: RATES.ter_daily } };
  function thrVariant(o) { var x = {}; Object.keys(THR).forEach(function (k) { x[k] = THR[k]; }); Object.keys(o).forEach(function (k) { x[k] = o[k]; }); return x; }
  var tr = engine.calculateThr(THR);
  eq('THR run: PPh 21 = TER on the combined 11.000.000 (3 %) less the regular 0', tr.pph21, 330000);
  eq('THR run: gross pay', tr.gross_pay, 6000000);
  eq('THR run: net pay', tr.net_pay, 5670000);
  eq('THR run: no BPJS', tr.employer_bpjs + tr.employee_bpjs, 0);
  var tr2 = engine.calculateThr(thrVariant({ regular: { taxable_gross: '12000000.00', pph21: 360000, pension: 0 }, items: [{ label: 'Penyesuaian', amount: '1000000.00', sign: '-' }] }));
  eq('THR run: regular PPh 21 already withheld is taken off (3 % of 17.000.000 - 360.000)', tr2.pph21, 150000);
  eq('THR run: an item adjusts the gross', tr2.gross_pay, 5000000);
  var ts = engine.calculateThr(thrVariant({ regular: null }));
  eq('THR run before the regular run: taxed alone, TER on 6.000.000 (3 %)', ts.pph21, 180000);
  eq('THR run before the regular run: no regular line flagged', ts.has_regular, false);
  var nr = (function () { try { engine.calculateThr(thrVariant({ regular: null, period: '2026-12-01' })); return 'calculated'; } catch (e) { return e.code; } })();
  eq('THR run in the last period without a regular line refused', nr, 'no_regular');
  var nd = (function () { try { engine.calculateThr(thrVariant({ regular: null, rate_type: 'daily' })); return 'calculated'; } catch (e) { return e.code; } })();
  eq('THR run for a daily worker without a regular line refused', nd, 'no_regular');
  var ro = engine.calculate(variant({ offcycle: { taxable_gross: '10000.00', pph21: 0 } }));
  var rn = engine.calculate(BUDI);
  eq('regular run absorbs the month\'s THR: carries total tax less what the THR withheld (0 here)', ro.pph21 + 0, ro.total_pph);
  eq('regular run keeps its own taxable gross', ro.taxable_gross, rn.taxable_gross);
  eq('regular run without THR: unchanged', rn.pph21, rn.total_pph);
  var nz = (function () { try { engine.calculateThr(thrVariant({ components: [] })); return 'calculated'; } catch (e) { return e.code; } })();
  eq('THR run with no amount refused', nz, 'no_thr');
  var ng = (function () { try { engine.calculateThr(thrVariant({ regular: { taxable_gross: '5000000.00', pph21: 900000, pension: 0 } })); return 'calculated'; } catch (e) { return e.code; } })();
  eq('THR run: regular PPh 21 above the combined month refused', ng, 'offcycle_negative');
  var td = (function () { try { engine.calculateThr(thrVariant({ period: '2026-12-01' })); return 'calculated'; } catch (e) { return e.code; } })();
  eq('THR run in December without year data refused', td, 'december');

  return {
    ok: checks.every(function (c) { return c.ok; }),
    figures: { gross_pay: r.gross_pay, taxable_gross: r.taxable_gross,
               net_pay: r.net_pay, employer_bpjs: r.employer_bpjs },
    checks: checks
  };
}

module.exports = { run: run };

/* `node api/calc/selftest.js` prints the same result. */
if (require.main === module) {
  var out = run();
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = out.ok ? 0 : 1;
}
