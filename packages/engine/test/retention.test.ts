import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage.js";
import { ingestDocument } from "../src/ingest.js";
import { sweepScreenRetention, sweepMeetingRetention } from "../src/retention.js";
import type Database from "better-sqlite3-multiple-ciphers";

describe("screen retention sweep", () => {
  const now = Math.floor(Date.now() / 1000);
  let db: Database.Database, dbPath: string;
  beforeEach(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db");
    db = openDatabase({ dbPath, key: null });
  });

  it("purges only screen docs older than the window; other sources untouched", () => {
    ingestDocument(db, { source: "screen", uri: "screen://a/b/old", title: "old",
      ts: now - 31 * 86400, text: "UNIQUE_OLD_SCREEN_PAYLOAD" });
    ingestDocument(db, { source: "screen", uri: "screen://a/b/new", title: "new",
      ts: now - 86400, text: "recent screen text" });
    ingestDocument(db, { source: "browser", uri: "https://x.example", title: "b",
      ts: now - 31 * 86400, text: "old browser doc stays forever" });
    const r = sweepScreenRetention(db, 30);
    expect(r.documents).toBe(1);
    const left = db.prepare("SELECT source, uri FROM documents ORDER BY uri").all();
    expect(left).toHaveLength(2);
    db.close();
    expect(readFileSync(dbPath).includes(Buffer.from("UNIQUE_OLD_SCREEN_PAYLOAD"))).toBe(false);
  });

  it("no-ops (no VACUUM churn) when nothing is expired", () => {
    ingestDocument(db, { source: "screen", uri: "screen://a/b/new", title: "n",
      ts: now, text: "fresh" });
    expect(sweepScreenRetention(db, 30).documents).toBe(0);
  });

  it("meeting retention: 0 keeps everything; positive N purges older meetings only", () => {
    ingestDocument(db, { source: "meeting", uri: "meeting://a/2026-05-01-0900", title: "old",
      ts: now - 40 * 86400, text: "Me: OLD_MEETING_PAYLOAD\nOthers: hi" });
    ingestDocument(db, { source: "meeting", uri: "meeting://a/2026-07-01-0900", title: "new",
      ts: now - 2 * 86400, text: "Me: recent meeting\nOthers: hi" });
    expect(sweepMeetingRetention(db, 0).documents).toBe(0);   // 0 = keep forever
    expect(sweepMeetingRetention(db, -5).documents).toBe(0);  // negative = keep
    expect(sweepMeetingRetention(db, 30).documents).toBe(1);  // purge the 40-day-old one
    const left = db.prepare("SELECT count(*) c FROM documents WHERE source='meeting'").get() as { c: number };
    expect(left.c).toBe(1);
  });
});
