import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage.js";
import { ingestDocument } from "../src/ingest.js";
import { keywordSearch } from "../src/search-keyword.js";
import type Database from "better-sqlite3-multiple-ciphers";

let db: Database.Database;
beforeEach(() => {
  db = openDatabase({ dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"), key: null });
  ingestDocument(db, { source: "file", uri: "/a.md", title: "carbon notes",
    ts: 1000, text: "Voluntary carbon markets and soil credit pricing." });
  ingestDocument(db, { source: "browser", uri: "https://x.com/1", title: "biryani",
    ts: 2000, text: "Chicken biryani recipe | cooking site visit" });
  ingestDocument(db, { source: "file", uri: "/b.md", title: "carbon later",
    ts: 3000, text: "Carbon removal buyers negotiate long-term offtakes." });
});

describe("keywordSearch", () => {
  it("ranks matching docs with provenance", () => {
    const hits = keywordSearch(db, { query: "carbon markets" });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].uri).toBe("/a.md");
    expect(hits[0]).toMatchObject({ source: "file", title: "carbon notes", ts: 1000 });
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it("applies time and source filters as pushdowns", () => {
    expect(keywordSearch(db, { query: "carbon", timeFrom: 2500 })
      .map(h => h.uri)).toEqual(["/b.md"]);
    expect(keywordSearch(db, { query: "biryani", sources: ["file"] })).toEqual([]);
  });

  it("does not crash on FTS special characters", () => {
    expect(() => keywordSearch(db, { query: 'carbon "AND* (NEAR' })).not.toThrow();
  });

  it("returns [] for special-characters-only queries", () => {
    expect(keywordSearch(db, { query: "!@#$%^&*()" })).toEqual([]);
  });

  it("preserves Devanagari words (combining marks intact)", () => {
    ingestDocument(db, { source: "notes", uri: "/hi.md", title: "hindi",
      ts: 4000, text: "कार्बन बाजार पर टिप्पणी" });
    const hits = keywordSearch(db, { query: "कार्बन" });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].uri).toBe("/hi.md");
  });

  it("does not false-positive on scattered Devanagari fragments", () => {
    ingestDocument(db, { source: "notes", uri: "/hi-real.md", title: "hindi",
      ts: 4000, text: "कार्बन बाजार पर टिप्पणी" });
    ingestDocument(db, { source: "notes", uri: "/hi-fragments.md", title: "fragments",
      ts: 4100, text: "बन गया र क अलग शब्द" });
    const hits = keywordSearch(db, { query: "कार्बन" });
    expect(hits.map(h => h.uri)).toContain("/hi-real.md");
    expect(hits.map(h => h.uri)).not.toContain("/hi-fragments.md");
  });

  it("requires ALL query tokens to match (implicit AND)", () => {
    // 'carbon' appears in /a.md; 'unicorn' appears nowhere
    expect(keywordSearch(db, { query: "carbon unicorn" })).toEqual([]);
  });

  it("indexes Devanagari words whole (tokenizer categories include marks)", () => {
    ingestDocument(db, { source: "notes", uri: "/hi2.md", title: "hindi2",
      ts: 6000, text: "कार्बन बाजार पर टिप्पणी" });
    // a fragment query must NOT match a whole-word index entry
    const frag = db.prepare(
      `SELECT count(*) c FROM chunks_fts WHERE chunks_fts MATCH '"क"'`).get() as { c: number };
    expect(frag.c).toBe(0);
    // the whole word matches
    expect(keywordSearch(db, { query: "कार्बन" }).map(h => h.uri)).toContain("/hi2.md");
  });
});
