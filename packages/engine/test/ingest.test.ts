import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, EMBEDDING_DIM } from "../src/storage.js";
import { ingestDocument } from "../src/ingest.js";
import { Embedder, type EmbedBackend } from "../src/embedder.js";
import { drainEmbedQueue } from "../src/embed-worker.js";
import type Database from "better-sqlite3-multiple-ciphers";

let db: Database.Database;
beforeEach(() => {
  db = openDatabase({ dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"), key: null });
});

const doc = {
  source: "file" as const, uri: "/tmp/note.md", title: "note",
  ts: 1751400000, text: "# Carbon\n\nVoluntary carbon markets are growing fast.",
};

describe("ingestDocument", () => {
  it("stores document, chunks, fts rows, and queues embeddings", () => {
    const r = ingestDocument(db, doc);
    expect(r.deduped).toBe(false);
    expect(r.chunks).toBeGreaterThan(0);
    const ftsHits = db.prepare(
      "SELECT count(*) c FROM chunks_fts WHERE chunks_fts MATCH 'carbon'"
    ).get() as { c: number };
    expect(ftsHits.c).toBeGreaterThan(0);
    const queued = db.prepare(
      "SELECT count(*) c FROM embed_queue WHERE state='pending'"
    ).get() as { c: number };
    expect(queued.c).toBe(r.chunks);
  });

  it("dedups identical content", () => {
    const first = ingestDocument(db, doc);
    const second = ingestDocument(db, doc);
    expect(second).toEqual({ docId: first.docId, chunks: 0, deduped: true });
    const docs = db.prepare("SELECT count(*) c FROM documents").get() as { c: number };
    expect(docs.c).toBe(1);
  });

  it("re-ingests when content changes", () => {
    // Same (source,uri) identity, new content: replaces in place (not a new document) —
    // see "replaces a document when the same (source,uri) re-ingests with new content" below.
    ingestDocument(db, doc);
    const r = ingestDocument(db, { ...doc, text: doc.text + " New paragraph." });
    expect(r.deduped).toBe(false);
    const docs = db.prepare("SELECT count(*) c FROM documents").get() as { c: number };
    expect(docs.c).toBe(1);
  });

  it("refreshes ts on dedup when the new visit is newer", () => {
    const first = ingestDocument(db, doc);
    const r = ingestDocument(db, { ...doc, ts: doc.ts + 5000 });
    expect(r).toEqual({ docId: first.docId, chunks: 0, deduped: true });
    const d = db.prepare("SELECT ts FROM documents WHERE id=?").get(first.docId) as { ts: number };
    expect(d.ts).toBe(doc.ts + 5000);
    const c = db.prepare("SELECT ts FROM chunks WHERE doc_id=?").get(first.docId) as { ts: number };
    expect(c.ts).toBe(doc.ts + 5000);
  });

  it("does not regress ts on dedup with an older visit", () => {
    const first = ingestDocument(db, doc);
    ingestDocument(db, { ...doc, ts: doc.ts - 5000 });
    const d = db.prepare("SELECT ts FROM documents WHERE id=?").get(first.docId) as { ts: number };
    expect(d.ts).toBe(doc.ts);
  });

  it("replaces a document when the same (source,uri) re-ingests with new content", async () => {
    const first = ingestDocument(db, { source: "browser", uri: "https://churn.example",
      title: "(3) Inbox", ts: 1000, text: "(3) Inbox\nhttps://churn.example" });
    const second = ingestDocument(db, { source: "browser", uri: "https://churn.example",
      title: "(4) Inbox", ts: 2000, text: "(4) Inbox\nhttps://churn.example" });
    expect(second.docId).toBe(first.docId);
    expect(second.deduped).toBe(false);
    const docs = db.prepare("SELECT count(*) c FROM documents").get() as { c: number };
    expect(docs.c).toBe(1);
    const doc = db.prepare("SELECT title, ts FROM documents WHERE id=?").get(first.docId) as any;
    expect(doc).toEqual({ title: "(4) Inbox", ts: 2000 });
    // old chunk text gone from FTS
    const old = db.prepare(`SELECT count(*) c FROM chunks_fts WHERE chunks_fts MATCH '"3"'`).get() as any;
    expect(old.c).toBe(0);
  });

  it("skips a same-(source,uri) replace when the new content's ts is older (stale row loses)", () => {
    // Chrome and Safari both emit source "browser" — without this guard, a
    // stale-ts snapshot of the same URL (e.g. the other browser's history
    // sync running behind) would replace a newer row and regress its ts.
    const first = ingestDocument(db, { source: "browser", uri: "https://race.example",
      title: "A", ts: 2000, text: "A body" });
    const stale = ingestDocument(db, { source: "browser", uri: "https://race.example",
      title: "B", ts: 1000, text: "B body" });
    expect(stale).toEqual({ docId: first.docId, chunks: 0, deduped: true });
    const row = db.prepare("SELECT title, ts, content_hash FROM documents WHERE id=?")
      .get(first.docId) as any;
    expect(row.title).toBe("A");
    expect(row.ts).toBe(2000);
    const firstRow = db.prepare("SELECT content_hash FROM documents WHERE id=?").get(first.docId) as any;
    expect(row.content_hash).toBe(firstRow.content_hash);
    // A subsequent newer-ts replace with the same content still goes through.
    const replaced = ingestDocument(db, { source: "browser", uri: "https://race.example",
      title: "B", ts: 3000, text: "B body" });
    expect(replaced.docId).toBe(first.docId);
    expect(replaced.deduped).toBe(false);
    const after = db.prepare("SELECT title, ts FROM documents WHERE id=?").get(first.docId) as any;
    expect(after).toEqual({ title: "B", ts: 3000 });
  });

  it("replacement purges old vectors and queues new chunks", async () => {
    const embedder = new Embedder(async () => (<EmbedBackend>{
      embed: async () => { const v = new Float32Array(EMBEDDING_DIM); v[0] = 1; return v; },
      dispose: async () => {},
    }));
    ingestDocument(db, { source: "browser", uri: "https://v.example", title: "old",
      ts: 1000, text: "old\nhttps://v.example" });
    await drainEmbedQueue(db, embedder);
    ingestDocument(db, { source: "browser", uri: "https://v.example", title: "new",
      ts: 2000, text: "new\nhttps://v.example" });
    const vecs = db.prepare("SELECT count(*) c FROM chunk_vectors").get() as { c: number };
    expect(vecs.c).toBe(0); // old vector purged, new one only queued
    const pending = db.prepare("SELECT count(*) c FROM embed_queue WHERE state='pending'").get() as { c: number };
    expect(pending.c).toBe(1);
    await embedder.dispose();
  });

  it("merges meta tags on dedup", () => {
    ingestDocument(db, { source: "conversation", uri: "conversation://abc", title: "t",
      ts: 1000, text: "a fact", meta: { tags: ["health"] } });
    ingestDocument(db, { source: "conversation", uri: "conversation://abc", title: "t",
      ts: 1000, text: "a fact", meta: { tags: ["fitness"] } });
    const m = JSON.parse((db.prepare("SELECT meta_json FROM documents WHERE uri='conversation://abc'")
      .get() as any).meta_json);
    expect(m.tags.sort()).toEqual(["fitness", "health"]);
  });

  it("merges tags on dedup even when ts is older, without regressing ts", () => {
    ingestDocument(db, { source: "conversation", uri: "conversation://xyz", title: "t",
      ts: 2000, text: "a fact", meta: { tags: ["a"] } });
    ingestDocument(db, { source: "conversation", uri: "conversation://xyz", title: "t",
      ts: 1000, text: "a fact", meta: { tags: ["b"] } });
    const row = db.prepare("SELECT ts, meta_json FROM documents WHERE uri='conversation://xyz'").get() as any;
    expect(row.ts).toBe(2000); // no regression
    expect(JSON.parse(row.meta_json).tags.sort()).toEqual(["a", "b"]); // merge still fired
  });
});

describe("screen hour-bucket identity", () => {
  const uri = "screen://com.google.Chrome/abc123def456/2026-07-09-06";
  it("same bucket, new content → REPLACE (one doc, latest text wins)", () => {
    const a = ingestDocument(db, { source: "screen", uri, title: "Chrome — Gmail",
      ts: 1000, text: "first screen state with some content here" });
    const b = ingestDocument(db, { source: "screen", uri, title: "Chrome — Gmail",
      ts: 1030, text: "second screen state, different content entirely" });
    expect(b.docId).toBe(a.docId);
    expect(b.deduped).toBe(false);
    const n = db.prepare("SELECT count(*) c FROM documents WHERE source='screen'").get() as { c: number };
    expect(n.c).toBe(1);
    const chunk = db.prepare(
      "SELECT text FROM chunks WHERE doc_id=? ORDER BY pos").get(a.docId) as { text: string };
    expect(chunk.text).toContain("second screen state");
  });
  it("next hour bucket → new doc", () => {
    ingestDocument(db, { source: "screen", uri, title: "t", ts: 1000, text: "state one" });
    ingestDocument(db, { source: "screen",
      uri: "screen://com.google.Chrome/abc123def456/2026-07-09-07",
      title: "t", ts: 4600, text: "state two" });
    const n = db.prepare("SELECT count(*) c FROM documents WHERE source='screen'").get() as { c: number };
    expect(n.c).toBe(2);
  });
});

describe("meeting source identity", () => {
  const uri = "meeting://us.zoom.xos/2026-07-10-1430";
  it("same meeting uri REPLACEs (re-transcribe overwrites, one doc)", () => {
    const a = ingestDocument(db, { source: "meeting", uri, title: "Zoom meeting · 10 Jul 14:30",
      ts: 1000, text: "Me: hello everyone\nOthers: hi, shall we start" });
    const b = ingestDocument(db, { source: "meeting", uri, title: "Zoom meeting · 10 Jul 14:30",
      ts: 1000, text: "Me: hello everyone\nOthers: hi, shall we start the standup now" });
    expect(b.docId).toBe(a.docId);
    const n = db.prepare("SELECT count(*) c FROM documents WHERE source='meeting'").get() as { c: number };
    expect(n.c).toBe(1);
    const chunk = db.prepare("SELECT text FROM chunks WHERE doc_id=? ORDER BY pos").get(a.docId) as { text: string };
    expect(chunk.text).toContain("start the standup now");
  });
});
