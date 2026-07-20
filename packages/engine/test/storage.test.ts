import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { openDatabase } from "../src/storage.js";

const tmpDb = () => join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db");

describe("openDatabase", () => {
  it("creates schema idempotently", () => {
    const dbPath = tmpDb();
    const db = openDatabase({ dbPath, key: "k".repeat(32) });
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name"
    ).all().map((r: any) => r.name);
    for (const t of ["documents", "chunks", "embed_queue", "meta"])
      expect(tables).toContain(t);
    // vec0 + fts5 virtual tables exist
    expect(() => db.prepare("SELECT count(*) FROM chunk_vectors").get()).not.toThrow();
    expect(() => db.prepare("SELECT count(*) FROM chunks_fts").get()).not.toThrow();
    db.close();
    // reopen: migrations must be idempotent
    const db2 = openDatabase({ dbPath, key: "k".repeat(32) });
    db2.close();
  });

  it("rejects wrong key", () => {
    const dbPath = tmpDb();
    openDatabase({ dbPath, key: "correct-key-0123456789abcdef000" }).close();
    expect(() => {
      const bad = new Database(dbPath);
      bad.pragma(`key='wrong'`);
      bad.prepare("SELECT count(*) FROM documents").get();
    }).toThrow();
  });

  it("supports keyless mode for tests", () => {
    const db = openDatabase({ dbPath: tmpDb(), key: null });
    expect(db.prepare("SELECT value FROM meta WHERE k='schema_version'").get())
      .toEqual({ value: "4" });
    db.close();
  });

  it("rejects keys that could break the pragma", () => {
    expect(() => openDatabase({ dbPath: tmpDb(), key: "bad'key" })).toThrow(/alphanumeric/);
  });

  it("migrates a v1 database through v2 to v3 preserving FTS content", () => {
    const dbPath = tmpDb();
    // build a v1 db: current code path but force old schema by... simplest: create with
    // openDatabase (v2), then simulate v1: drop fts, recreate WITHOUT categories, set version 1
    const db = openDatabase({ dbPath, key: null });
    db.exec(`DROP TRIGGER chunks_ai; DROP TRIGGER chunks_ad; DROP TABLE chunks_fts;
      CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id');
      CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text); END;
      CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
      UPDATE meta SET value='1' WHERE k='schema_version';`);
    db.prepare("INSERT INTO documents(source, uri, title, ts, content_hash) VALUES ('file','/m.md','m',1,'h1')").run();
    db.prepare("INSERT INTO chunks(doc_id, pos, text, ts) VALUES (1, 0, 'legacy content survives migration', 1)").run();
    db.close();

    const db2 = openDatabase({ dbPath, key: null });
    expect((db2.prepare("SELECT value FROM meta WHERE k='schema_version'").get() as any).value).toBe("4");
    const hit = db2.prepare("SELECT count(*) c FROM chunks_fts WHERE chunks_fts MATCH 'legacy'").get() as any;
    expect(hit.c).toBe(1);
    db2.close();
  });

  it("refuses a pre-existing DB with missing schema_version", () => {
    const dbPath = tmpDb();
    const db = openDatabase({ dbPath, key: null });
    db.prepare("DELETE FROM meta WHERE k='schema_version'").run();
    db.close();
    expect(() => openDatabase({ dbPath, key: null })).toThrow(/no schema_version/);
  });

  it("refuses an unknown future schema_version", () => {
    const dbPath = tmpDb();
    const db = openDatabase({ dbPath, key: null });
    db.prepare("UPDATE meta SET value='99' WHERE k='schema_version'").run();
    db.close();
    expect(() => openDatabase({ dbPath, key: null })).toThrow(/unsupported schema_version 99/);
  });

  it("migrates v2→v3: dedupes (source,uri) keeping newest, adds unique index", () => {
    const dbPath = tmpDb();
    const db = openDatabase({ dbPath, key: null });
    // simulate a v2 DB with title-churn duplicates
    db.exec("DROP INDEX IF EXISTS idx_documents_source_uri");
    db.prepare("UPDATE meta SET value='2' WHERE k='schema_version'").run();
    const ins = db.prepare(
      "INSERT INTO documents(source, uri, title, ts, content_hash) VALUES ('browser', 'https://d.example', ?, ?, ?)");
    ins.run("(1) Inbox", 1000, "h1"); ins.run("(2) Inbox", 2000, "h2"); ins.run("(3) Inbox", 3000, "h3");
    db.close();
    const db2 = openDatabase({ dbPath, key: null });
    expect((db2.prepare("SELECT value FROM meta WHERE k='schema_version'").get() as any).value).toBe("4");
    const rows = db2.prepare("SELECT title FROM documents WHERE uri='https://d.example'").all() as any[];
    expect(rows).toEqual([{ title: "(3) Inbox" }]); // newest kept
    // unique index enforced
    expect(() => db2.prepare(
      "INSERT INTO documents(source, uri, title, ts, content_hash) VALUES ('browser','https://d.example','x',4000,'h4')"
    ).run()).toThrow(/UNIQUE/);
    db2.close();
  });

  it("migrates v3 to v4: counters table exists, schema_version bumped, data intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "shyn-mig4-"));
    const dbPath = join(dir, "t.db");
    // Build a v3 DB with a document, then force the version marker back to '3'.
    let db = openDatabase({ dbPath, key: null });
    db.prepare(
      "INSERT INTO documents (source, uri, title, ts, content_hash, meta_json) VALUES ('file','/a','',1,'h','{}')"
    ).run();
    db.prepare("DROP TABLE IF EXISTS counters").run();
    db.prepare("UPDATE meta SET value='3' WHERE k='schema_version'").run();
    db.close();

    db = openDatabase({ dbPath, key: null });
    const v = db.prepare("SELECT value FROM meta WHERE k='schema_version'").get() as { value: string };
    expect(v.value).toBe("4");
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='counters'").get()).toBeTruthy();
    expect((db.prepare("SELECT COUNT(*) c FROM documents").get() as { c: number }).c).toBe(1);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
