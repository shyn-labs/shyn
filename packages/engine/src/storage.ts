import Database from "better-sqlite3-multiple-ciphers";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const EMBEDDING_DIM = 1024;

// unicode61's default categories exclude combining marks (Mn/Mc), which shreds
// Devanagari (and other mark-dependent scripts) into fragments at index time.
// Including Mn/Mc keeps composed words intact as single FTS tokens.
const FTS_TOKENIZE = `tokenize = "unicode61 categories 'L* N* Co Mn Mc'"`;

// Shared between SCHEMA (fresh DBs) and migrate() (v1 -> v2 upgrades) so the
// trigger SQL is defined exactly once.
const TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  uri TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_hash ON documents(content_hash);
CREATE INDEX IF NOT EXISTS idx_documents_source_ts ON documents(source, ts);
-- idx_documents_source_uri is NOT created here: a pre-existing v2 database can
-- have (source,uri) duplicates from the old content-hash identity model, and
-- creating a UNIQUE index on duplicate data throws immediately. migrate()'s
-- v2->v3 step dedupes first and creates the index itself; openDatabase creates
-- it here (below, after migrate() has run) only as the fresh-database path,
-- once no duplicates can possibly exist.

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  pos INTEGER NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, content='chunks', content_rowid='id', ${FTS_TOKENIZE}
);
${TRIGGERS}

CREATE TABLE IF NOT EXISTS embed_queue (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta(k, value) VALUES ('schema_version', '5');
INSERT OR IGNORE INTO meta(k, value)
  VALUES ('embedding_model', 'qwen3-embedding-0.6b-q8_0');

CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- Observation heartbeat. One row per daemon tick, so an ABSENCE of rows is
-- itself evidence: the machine was asleep, off, or the daemon was down. Without
-- this, recall cannot tell "nothing happened" from "nothing was watching", and
-- reports a 14-hour hole as silence (live finding 2026-08-05).
-- The agents column lists which capture agents were reporting at that instant,
-- so a live daemon with a dead screen agent is distinguishable from a live one.
-- (No backticks in this block: SCHEMA is a JS template literal.)
CREATE TABLE IF NOT EXISTS coverage (
  ts INTEGER PRIMARY KEY,
  agents TEXT NOT NULL DEFAULT ''
);
`;

// Versions this build can open: older ones are migrated forward by migrate(),
// the newest is what SCHEMA writes. Add the new value here in the same commit
// that bumps SCHEMA, or a reopen of a freshly created DB is refused.
export const KNOWN_SCHEMA_VERSIONS = ["1", "2", "3", "4", "5"];

const VEC_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  month TEXT PARTITION KEY,
  embedding int8[${EMBEDDING_DIM}] distance_metric=cosine
);
`;

// Upgrades a v1 database (default unicode61, no combining marks) to v2
// (categories include Mn/Mc) by dropping and rebuilding chunks_fts from the
// external content table, inside a transaction so a failure leaves the v1
// DB intact rather than half-migrated.
//
// v2 -> v3 changes document identity from content-hash to (source, uri): it
// dedupes any pre-existing title-churn duplicates (same source+uri, multiple
// rows from the old content-hash-keyed insert path) keeping the newest by ts
// (ties broken by id), then adds the UNIQUE(source, uri) index. Each version
// step runs in its own transaction so a failure leaves the DB at the last
// fully-migrated version rather than half-upgraded.
//
// v3 -> v4 adds the counters table (opaque-key usage counters, e.g.
// "search:2026-07-11") for local stats aggregation; SCHEMA's idempotent
// CREATE TABLE IF NOT EXISTS has already created it by the time this branch
// runs, so it only records the version bump.
function migrate(db: Database.Database): void {
  for (;;) {
    const version = (
      db.prepare("SELECT value FROM meta WHERE k='schema_version'").get() as
        | { value: string }
        | undefined
    )?.value;

    if (version === "1") {
      db.transaction(() => {
        db.exec(`
          DROP TRIGGER IF EXISTS chunks_ai;
          DROP TRIGGER IF EXISTS chunks_ad;
          DROP TABLE IF EXISTS chunks_fts;
          CREATE VIRTUAL TABLE chunks_fts USING fts5(
            text, content='chunks', content_rowid='id', ${FTS_TOKENIZE}
          );
          INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild');
        `);
        db.exec(TRIGGERS);
        db.prepare("UPDATE meta SET value='2' WHERE k='schema_version'").run();
      })();
      continue;
    }

    if (version === "2") {
      db.transaction(() => {
        const dupes = db.prepare(`
          SELECT id FROM documents d WHERE EXISTS (
            SELECT 1 FROM documents d2 WHERE d2.source=d.source AND d2.uri=d.uri
            AND (d2.ts > d.ts OR (d2.ts = d.ts AND d2.id > d.id)))`).all() as { id: number }[];
        const delVec = db.prepare(
          "DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_id=?)");
        const delDoc = db.prepare("DELETE FROM documents WHERE id=?");
        for (const { id } of dupes) { delVec.run(id); delDoc.run(id); }
        db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_source_uri ON documents(source, uri)");
        db.prepare("UPDATE meta SET value='3' WHERE k='schema_version'").run();
      })();
      continue;
    }

    if (version === "3") {
      // v4 adds the counters table (created idempotently by SCHEMA above);
      // nothing to transform — just record the version.
      db.prepare("UPDATE meta SET value='4' WHERE k='schema_version'").run();
      continue;
    }

    if (version === "4") {
      // v5 adds the coverage heartbeat table (created idempotently by SCHEMA
      // above). Nothing to transform: an upgraded DB simply has no coverage
      // history before this point, which reads correctly as "not observed".
      db.prepare("UPDATE meta SET value='5' WHERE k='schema_version'").run();
      continue;
    }

    return;
  }
}

export function openDatabase(opts: { dbPath: string; key: string | null }): Database.Database {
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  const db = new Database(opts.dbPath);
  if (opts.key !== null) {
    if (!/^[A-Za-z0-9-]+$/.test(opts.key))
      throw new Error("db key must be alphanumeric (hex from Keychain)");
    db.pragma(`key='${opts.key}'`);
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  sqliteVec.load(db);

  // A pre-existing DB (has documents table) whose meta lacks schema_version is
  // unknown vintage — refuse rather than silently mis-migrate.
  const hasDocs = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='documents'")
    .get();
  if (hasDocs) {
    const hasMeta = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'")
      .get();
    const v = hasMeta
      ? (
          db
            .prepare("SELECT value FROM meta WHERE k='schema_version'")
            .get() as { value: string } | undefined
        )?.value
      : undefined;
    if (v === undefined)
      throw new Error("database has no schema_version — refusing to open (corrupt meta?)");
    // Every version this build knows how to open, current one included: the
    // current version reaches here on any reopen of a DB this build created, so
    // forgetting to add it locks the user out of their own database.
    if (!KNOWN_SCHEMA_VERSIONS.includes(v))
      throw new Error(`unsupported schema_version ${v}`);
  }

  db.exec(SCHEMA);
  db.exec(VEC_SCHEMA);
  migrate(db);
  // Safe now: fresh DBs have no duplicates, and migrate()'s v2->v3 step has
  // already deduped+created this index for upgraded DBs (no-op here for them).
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_source_uri ON documents(source, uri)");
  return db;
}
