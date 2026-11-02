'use strict';

const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/* Loads ./.env if present (Node's built-in loader; no dependency). */
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env: defaults apply */ }

/**
 * The database lives OUTSIDE the project folder by default, so a synced
 * folder (Google Drive, OneDrive) never copies a half-written SQLite file.
 *   Windows: %LOCALAPPDATA%\CoraByte Payroll\payroll.db
 *   other:   ~/.corabyte-payroll/payroll.db
 */
function defaultDbFile() {
  const base = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CoraByte Payroll')
    : path.join(os.homedir(), '.corabyte-payroll');
  return path.join(base, 'payroll.db');
}

const config = Object.freeze({
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT) || 8080,
  dbFile: process.env.DB_FILE ? path.resolve(ROOT, process.env.DB_FILE) : defaultDbFile(),
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS) || 12,
  seedDemo: process.env.SEED_DEMO === '1' || process.env.SEED_DEMO === 'true',
  allowSignup: !['0', 'false'].includes(String(process.env.ALLOW_SIGNUP || '').toLowerCase()),
  appName: 'CoraByte Payroll',
  version: require('../package.json').version,
});

module.exports = config;
