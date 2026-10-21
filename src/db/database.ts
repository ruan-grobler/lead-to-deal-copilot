import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Each entry runs once, in order. PRAGMA user_version records how far a database has got. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    route TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    inbound_json TEXT NOT NULL,
    extraction_json TEXT,
    contact_id TEXT,
    company_id TEXT,
    deal_id TEXT,
    note_id TEXT,
    dedupe_match TEXT,
    merged_into_deal_id TEXT,
    slack_channel TEXT,
    slack_ts TEXT,
    card_posted_at TEXT,
    decided_by TEXT,
    decided_at TEXT,
    assigned_to TEXT,
    assigned_at TEXT,
    reminded_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    duplicate_hits INTEGER NOT NULL DEFAULT 0,
    received_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    latency_ms INTEGER
  );
  CREATE INDEX leads_status_idx ON leads (status);
  CREATE INDEX leads_received_idx ON leads (received_at);

  CREATE TABLE dead_letters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads (id),
    stage TEXT NOT NULL,
    error TEXT NOT NULL,
    http_status INTEGER,
    attempts INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    replayed_at TEXT,
    replay_outcome TEXT
  );
  CREATE INDEX dead_letters_pending_idx ON dead_letters (replayed_at);

  CREATE TABLE digests (
    digest_date TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    slack_ts TEXT
  );
  `,
];

const migrate = (db: DatabaseSync): void => {
  const row = db.prepare('PRAGMA user_version').get();
  const current = typeof row?.user_version === 'number' ? row.user_version : 0;
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version] ?? '');
      db.exec(`PRAGMA user_version = ${String(version + 1)}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
};

/** Opens (and migrates) the SQLite database. Pass ':memory:' for tests and the demo. */
export const openDatabase = (path: string): DatabaseSync => {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  migrate(db);
  return db;
};
