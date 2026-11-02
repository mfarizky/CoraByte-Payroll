'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 3;

const INDEXES = `
  CREATE INDEX IF NOT EXISTS users_org_idx ON users (org_id);
  CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
`;

/**
 * Opens (and creates, if needed) the SQLite database, upgrades an older
 * schema, and applies the current one.
 * @param {string} file  path to the .db file, or ':memory:'
 */
function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  db.exec(INDEXES);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(String(SCHEMA_VERSION));
  return db;
}

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const hasTable = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

/**
 * Upgrades an older database in place.
 *
 * v1 (single organisation) -> v2 (multi-tenant): every existing user and
 * document is moved into one organisation, "My organization", which the
 * admin can rename under Settings.
 */
function migrate(db) {
  migrateV1toV2(db);
  /* v2 -> v3: an organisation is the employer; it points at its payroll
     client row (filled in on first use, see organization-service.js). */
  if (hasTable(db, 'organizations') && !columns(db, 'organizations').includes('primary_client_id')) {
    db.exec('ALTER TABLE organizations ADD COLUMN primary_client_id TEXT');
  }
}

function migrateV1toV2(db) {
  if (!hasTable(db, 'users') || columns(db, 'users').includes('org_id')) return;

  const now = new Date().toISOString();
  const orgId = crypto.randomUUID();
  db.exec('PRAGMA foreign_keys = OFF;');
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, legal_name TEXT, npwp TEXT, address TEXT, city TEXT,
      province TEXT, phone TEXT, email TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.prepare('INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(orgId, 'My organization', now, now);

    db.exec(`CREATE TABLE users_v2 (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.prepare(`INSERT INTO users_v2 SELECT id, ?, username, display_name, password_hash, role, active, created_at, updated_at
                FROM users`).run(orgId);
    db.exec('DROP TABLE users; ALTER TABLE users_v2 RENAME TO users;');

    if (hasTable(db, 'documents') && !columns(db, 'documents').includes('org_id')) {
      db.exec(`CREATE TABLE documents_v2 (
        org_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        collection TEXT NOT NULL, id TEXT NOT NULL,
        data TEXT NOT NULL CHECK (json_valid(data)), updated_at TEXT NOT NULL,
        PRIMARY KEY (org_id, collection, id))`);
      db.prepare('INSERT INTO documents_v2 SELECT ?, collection, id, data, updated_at FROM documents').run(orgId);
      db.exec('DROP TABLE documents; ALTER TABLE documents_v2 RENAME TO documents;');
    }
  });
  db.exec('PRAGMA foreign_keys = ON;');
}

const depth = new WeakMap();

/**
 * Runs `fn` inside a transaction. Nested calls join the outer transaction.
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
function transaction(db, fn) {
  if ((depth.get(db) || 0) > 0) return fn();
  depth.set(db, 1);
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth.set(db, 0);
  }
}

module.exports = { openDatabase, transaction, SCHEMA_VERSION };
