# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-11-02

### Changed
- One login = one organisation = one employer. The client picker is gone; employees, runs and
  payslips belong to the organisation. Extra client records stay in the database (not shown).
- **Home** is a dashboard: headcount, this month's payroll, latest totals, recent runs, setup checklist.
- Payroll settings, short code and departments & positions moved to **Settings**.
- Payroll run: the payroll month has its own row at the top; "← Back to Runs" sits where the month was.
- Payslip refresh: brand accent bar, blue headings, tinted net-pay band, Noto Sans. Same layout.

### Migration
- Schema v3 adds `organizations.primary_client_id`; an existing organisation adopts its oldest client.

## [0.2.0] — 2026-11-02

### Added
- Multi-tenancy: organisations register themselves; clients, employees, payroll runs and users
  are isolated per organisation. Usernames stay unique across the installation.
- Settings screen with the organisation profile (name, legal name, NPWP, contact, address).
- The organisation's name is shown in the header, next to the user menu.
- `ALLOW_SIGNUP` setting; `seed:demo` now creates a "Demo Consulting" organisation.
- Tests for tenant isolation, organisation settings and the database upgrade.

### Changed
- "Clients" is now **Home** in the navigation.
- New brand palette (blue #014A7F, teal #49BDB7 / #A9D2D5, green #245D5A, red #C12421)
  and the Noto Sans font.
- `POST /api/auth/setup` is replaced by `POST /api/auth/register`.

### Migration
- A v0.1 database is upgraded on start: existing users and data move into one organisation,
  "My organization".

## [0.1.0] — 2026-11-02

First standalone MVP.

### Added
- Node.js server with built-in SQLite (`node:sqlite`); zero npm dependencies.
- Username/password sign-in, first-run admin setup, admin/member roles, user management.
- Clients: create, edit identity, departments & positions, archive.
- Server-side payroll calculation (PPh 21 TER monthly/daily, Pasal 17, BPJS, THR).
- Payroll run flow Draft → Review → Outputs → Paid with server-enforced rules.
- Payslip PDFs (single and all), remittance PDF, Mandiri "Format Lama" CSV.
- Self-hosted fonts and PDF libraries: works offline.
- Scripts: `seed:demo`, `user:create`, `db:backup`. Test suite on `node:test`.
- Modern-minimal theme with left navigation.

### Removed
- Azure Static Web Apps, Entra ID sign-in, external store proxy and the GKI CORE banner.
- Email sending of payslips and bank files (download instead).
- Document scanning (OCR) on the employee form.
