import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage.js";
import { ingestDocument } from "../src/ingest.js";
import { forget } from "../src/forget.js";

describe("forget", () => {
  it("purges content from the raw db file (keyless db so bytes are inspectable)", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db");
    const db = openDatabase({ dbPath, key: null });
    const SECRET = "XyZZySecretTokenNeverElsewhere";
    ingestDocument(db, { source: "file", uri: "/s.md", title: "s", ts: 1000,
      text: `${SECRET} appears in this document body.` });
    db.pragma("wal_checkpoint(TRUNCATE)");
    expect(readFileSync(dbPath).includes(SECRET)).toBe(true);
    const r = forget(db, { source: "file" });
    expect(r.documents).toBe(1);
    db.close();
    expect(readFileSync(dbPath).includes(SECRET)).toBe(false);
    // WAL file must not retain it either
    let wal = Buffer.alloc(0);
    try { wal = readFileSync(dbPath + "-wal"); } catch { /* absent is fine */ }
    expect(wal.includes(SECRET)).toBe(false);
  });

  it("filters by time range", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db");
    const db = openDatabase({ dbPath, key: null });
    ingestDocument(db, { source: "file", uri: "/old.md", title: "o", ts: 1000, text: "old doc" });
    ingestDocument(db, { source: "file", uri: "/new.md", title: "n", ts: 9000, text: "new doc" });
    expect(forget(db, { timeFrom: 5000, timeTo: 10000 }).documents).toBe(1);
    const left = db.prepare("SELECT uri FROM documents").all() as { uri: string }[];
    expect(left).toEqual([{ uri: "/old.md" }]);
  });
});
