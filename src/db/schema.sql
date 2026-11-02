-- CoraByte Payroll — database schema (SQLite), version 3.
-- Applied on every start; every statement is idempotent. Upgrades from an
-- older database are handled in connection.js (migrate()).

PRAGMA foreign_keys = ON;

-- Tenants: one organisation = one employer. Each sees only its own data.
-- primary_client_id points at the organisation's employer record in the
-- payroll data (app/payroll/clients); see services/organization-service.js.
CREATE TABLE IF NOT EXISTS organizations (
  id         TEXT PRIMARY KEY,
  primary_client_id TEXT,
  name       TEXT NOT NULL,
  legal_name TEXT,
  npwp       TEXT,
  address    TEXT,
  city       TEXT,
  province   TEXT,
  phone      TEXT,
  email      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- People who can sign in. A user belongs to exactly one organisation;
-- usernames are unique across the whole installation.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Signed-in sessions. Only a SHA-256 of the cookie token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Payroll data, one JSON document per row, grouped by organisation and
-- collection (clients, employees, runs, run_lines, rate tables, ...). The
-- business rules that protect these rows live in services/store-service.js.
CREATE TABLE IF NOT EXISTS documents (
  org_id     TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       TEXT NOT NULL CHECK (json_valid(data)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, collection, id)
);

-- Small key/value facts about this database (schema version).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
