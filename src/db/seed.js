'use strict';

const crypto = require('node:crypto');
const { transaction } = require('./connection');
const REFERENCE = require('./reference-data.json');

/*
 * Reference data: the tax and BPJS tables the calculation reads
 * (BPJS rates, JKK classes, minimum wage, PTKP, TER monthly/daily, Pasal 17).
 * Inserted once, when a table is empty. To update a rate, add a row with a
 * new effective_from and close the old one with effective_to.
 */
function seedReference(db, documents) {
  return transaction(db, () => {
    let inserted = 0;
    for (const [table, rows] of Object.entries(REFERENCE)) {
      const collection = 'app/payroll/' + table;
      if (documents.count(collection) > 0) continue;
      for (const row of rows) {
        documents.put(collection, { ...row, id: crypto.randomUUID() });
        inserted++;
      }
    }
    return inserted;
  });
}

/**
 * Demo data for one organisation: six fictional employees (one daily-paid,
 * one inactive), their salary components, departments and positions, and
 * filled-in payroll settings on the organisation's employer record.
 * Does nothing if the organisation already has employees.
 * @param {string} clientId  the organisation's primary client (employer) id
 */
function seedDemo(db, documents, clientId) {
  if (documents.count('app/payroll/employees') > 0) return 0;
  const settings = documents.get('app/payroll/clients', clientId);
  if (!settings) throw new Error('seedDemo: the employer record does not exist');
  const at = new Date().toISOString();
  const put = (c, row) => documents.put(c, { rev: 1, created_at: at, ...row });

  return transaction(db, () => {
    const account = documents.get('core/accounts', settings.account_id) || { id: settings.account_id };
    documents.put('core/accounts', { ...account, short_code: account.short_code || 'DEMO', code: account.code || 'DEMO',
      npwp: account.npwp || '00.000.000.0-000.000', city: account.city || 'Mataram', province: account.province || 'NTB' });
    const employer = documents.list('core/employers').find((e) => e.account_id === account.id);
    documents.put('core/employers', { ...employer, departments: ['FINANCE', 'OPERATIONS', 'SALES'],
      effective_npwp: employer.effective_npwp || '00.000.000.0-000.000' });
    [['Accountant', 'FINANCE'], ['Finance Manager', 'FINANCE'], ['Driver', 'OPERATIONS'],
     ['Sales Executive', 'SALES'], ['Admin Officer', 'OPERATIONS']].forEach(([title, department], i) =>
      put('core/employer_jobs', { id: 'job-demo-' + (i + 1), employer_id: employer.id, title, department, active: true }));

    documents.put('app/payroll/clients', { ...settings, jkk_rate: '0.002400', bpjs_floor_region: 'UMP_NTB', cutoff_day: 20,
      pay_day: 1, bank_code: 'MANDIRI', debit_account: '1230000000001', kesehatan_base_includes_fixed: true,
      file_format: 'format_lama', proration_basis: 'calendar_days', rev: Number(settings.rev || 1) + 1 });

    const emp = (id, code, name, position, department, ptkp, start, rate, type, bank, account, extra = {}) =>
      put('app/payroll/employees', {
        id, payroll_client_id: clientId, employee_code: code, full_name: name, position, department,
        ptkp_status: ptkp, start_date: start, end_date: null, active: true, rate_type: rate, employment_type: type,
        nik: '9999999999999' + code.slice(-3), npwp: '9999999999999' + code.slice(-3), bank_code: bank,
        bank_account: account, bank_account_name: name.toUpperCase(), bank_branch_city: 'Mataram',
        email: name.split(' ')[0].toLowerCase() + '@example.com', ...extra });
    emp('em-demo-1', 'EMP-0012', 'Budi Santoso', 'Finance Manager', 'FINANCE', 'K/1', '2023-03-01', 'monthly', 'PKWTT', 'MANDIRI', '1230000012345');
    emp('em-demo-2', 'EMP-0013', 'Siti Rahayu', 'Accountant', 'FINANCE', 'TK/0', '2025-01-15', 'monthly', 'PKWTT', 'MANDIRI', '1230000067890');
    emp('em-demo-3', 'EMP-0014', 'Agus Pratama', 'Sales Executive', 'SALES', 'K/2', '2024-06-10', 'monthly', 'PKWTT', 'BCA', '1234567890');
    emp('em-demo-4', 'EMP-0015', 'Dewi Lestari', 'Admin Officer', 'OPERATIONS', 'TK/0', '2026-08-05', 'monthly', 'PKWT', 'BRI', '123456789012345');
    emp('em-demo-5', 'EMP-0016', 'Joko Widodo Contoh', 'Driver', 'OPERATIONS', 'K/0', '2025-09-01', 'daily', 'PKWT', 'BNI', '1234567801');
    emp('em-demo-6', 'EMP-0017', 'Rina Marlina', 'Admin Officer', 'OPERATIONS', 'TK/1', '2022-02-01', 'monthly', 'PKWTT', 'MANDIRI', '1230000054321',
      { active: false, end_date: '2026-06-30' });

    const comp = (id, employee, name, amount, fixed, from) => put('app/payroll/components', {
      id, payroll_employee_id: employee, name, amount: String(amount), is_fixed: fixed, effective_from: from, effective_to: null });
    comp('k-demo-1', 'em-demo-1', 'Gaji Pokok', 9000000, true, '2023-03-01');
    comp('k-demo-2', 'em-demo-1', 'Tunjangan Jabatan', 1500000, true, '2023-03-01');
    comp('k-demo-3', 'em-demo-2', 'Gaji Pokok', 5000000, true, '2025-01-15');
    comp('k-demo-4', 'em-demo-2', 'Tunjangan Transportasi', 500000, true, '2025-01-15');
    comp('k-demo-5', 'em-demo-3', 'Gaji Pokok', 4000000, true, '2024-06-10');
    comp('k-demo-6', 'em-demo-3', 'Tunjangan Makan', 600000, false, '2024-06-10');
    comp('k-demo-7', 'em-demo-4', 'Gaji Pokok', 3200000, true, '2026-08-05');
    comp('k-demo-8', 'em-demo-5', 'Gaji Pokok', 150000, true, '2025-09-01');
    comp('k-demo-9', 'em-demo-6', 'Gaji Pokok', 4500000, true, '2022-02-01');
    return 6;
  });
}

module.exports = { seedReference, seedDemo };
