import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, EMBEDDING_DIM } from "../src/storage.js";
import { ingestDocument } from "../src/ingest.js";
import { Embedder, ModelNotReadyError, type EmbedBackend } from "../src/embedder.js";
import { drainEmbedQueue } from "../src/embed-worker.js";
import type Database from "better-sqlite3-multiple-ciphers";

let db: Database.Database;
beforeEach(() => {
  db = openDatabase({ dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"), key: null });
});

const stubEmbedder = (fail = false) => new Embedder(async () => (<EmbedBackend>{
  embed: async (t) => {
    if (fail) throw new Error("boom");
    const v = new Float32Array(EMBEDDING_DIM);
    v[0] = t.includes("carbon") ? 0.9 : -0.9;
    return v;
  },
  dispose: async () => {},
}));

describe("drainEmbedQueue", () => {
  it("embeds pending chunks into partitioned vec table", async () => {
    ingestDocument(db, { source: "file", uri: "/a.md", title: "a",
      ts: Date.UTC(2026, 6, 1) / 1000, text: "carbon markets note" });
    const r = await drainEmbedQueue(db, stubEmbedder());
    expect(r).toEqual({ embedded: 1, failed: 0 });
    const row = db.prepare("SELECT month FROM chunk_vectors LIMIT 1").get() as { month: string };
    expect(row.month).toBe("2026-07");
    const pending = db.prepare("SELECT count(*) c FROM embed_queue WHERE state='pending'")
      .get() as { c: number };
    expect(pending.c).toBe(0);
  });

  it("marks failed after 3 attempts", async () => {
    ingestDocument(db, { source: "file", uri: "/a.md", title: "a", ts: 1000, text: "x" });
    for (let i = 0; i < 3; i++) await drainEmbedQueue(db, stubEmbedder(true));
    const row = db.prepare("SELECT state, attempts FROM embed_queue").get() as any;
    expect(row).toEqual({ state: "failed", attempts: 3 });
  });

  it("does not count model-not-ready as a row failure", async () => {
    ingestDocument(db, { source: "file", uri: "/a.md", title: "a", ts: 1000, text: "x" });
    const notReadyEmbedder = new Embedder(async () => { throw new ModelNotReadyError(); });
    for (let i = 0; i < 5; i++) await drainEmbedQueue(db, notReadyEmbedder);
    const row = db.prepare("SELECT state, attempts FROM embed_queue").get() as any;
    expect(row).toEqual({ state: "pending", attempts: 0 });
  });
});
