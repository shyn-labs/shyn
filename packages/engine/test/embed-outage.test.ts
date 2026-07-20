import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage.js";
import { Embedder, EmbedBackendUnavailableError, type EmbedBackend } from "../src/embedder.js";
import { drainEmbedQueue } from "../src/embed-worker.js";
import { ingestDocument } from "../src/ingest.js";
import type Database from "better-sqlite3-multiple-ciphers";

const modErr = () => Object.assign(new Error("Cannot find package 'lifecycle-utils'"), { code: "ERR_MODULE_NOT_FOUND" });

describe("embed backend outage", () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shyn-outage-"));
    db = openDatabase({ dbPath: join(dir, "t.db"), key: null });
    ingestDocument(db, { source: "file", uri: "/a.md", title: "a", ts: 1, text: "hello outage world" });
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("acquire tags ERR_MODULE_NOT_FOUND and still allows retry", async () => {
    let calls = 0;
    const embedder = new Embedder(async () => {
      calls++;
      if (calls === 1) throw modErr();
      return <EmbedBackend>{ embed: async () => new Float32Array(1024), dispose: async () => {} };
    });
    await expect(embedder.embedDoc("x")).rejects.toBeInstanceOf(EmbedBackendUnavailableError);
    await expect(embedder.embedDoc("x")).resolves.toBeInstanceOf(Int8Array); // retry not memoized
  });

  it("drain propagates the tagged error without consuming attempts", async () => {
    const embedder = new Embedder(async () => { throw modErr(); });
    await expect(drainEmbedQueue(db, embedder)).rejects.toBeInstanceOf(EmbedBackendUnavailableError);
    const row = db.prepare("SELECT state, attempts FROM embed_queue LIMIT 1").get() as { state: string; attempts: number };
    expect(row.state).toBe("pending");
    expect(row.attempts).toBe(0);
  });

  it("other embed errors still consume attempts (3 strikes to failed)", async () => {
    const embedder = new Embedder(async () =>
      (<EmbedBackend>{ embed: async () => { throw new Error("boom"); }, dispose: async () => {} }));
    for (let i = 0; i < 3; i++) await drainEmbedQueue(db, embedder);
    const row = db.prepare("SELECT state, attempts FROM embed_queue LIMIT 1").get() as { state: string; attempts: number };
    expect(row.state).toBe("failed");
    expect(row.attempts).toBe(3);
    // boot-time recovery gives them a fresh set
    const n = db.prepare("UPDATE embed_queue SET state='pending', attempts=0 WHERE state='failed'").run().changes;
    expect(n).toBe(1);
  });
});
