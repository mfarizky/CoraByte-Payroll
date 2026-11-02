'use strict';

/**
 * Writes a consistent copy of the database (safe while the app is running).
 *
 *   npm run db:backup                 -> backups/payroll-YYYYMMDD-HHMMSS.db
 *   npm run db:backup -- D:\Backups   -> into that folder
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const { openDatabase } = require('../src/db/connection');

const dir = path.resolve(process.argv[2] || path.join(config.root, 'backups'));
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const target = path.join(dir, `payroll-${stamp}.db`);

const db = openDatabase(config.dbFile);
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();
console.log(`Backup written: ${target}`);
