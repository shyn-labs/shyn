import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, EMBEDDING_DIM } from "../src/storage.js";
import { ingestDocument } from "../src/ingest.js";
import { Embedder, type EmbedBackend } from "../src/embedder.js";
import { drainEmbedQueue } from "../src/embed-worker.js";
import { forget } from "../src/forget.js";

describe("forget racing an in-flight drain", () => {
  it("does not persist an orphan vector for a chunk forgotten mid-embed", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db");
    const db = openDatabase({ dbPath, key: null });
    const SECRET = "RaceOrphanSecretNeverElsewhere";

    let releaseGate!: () => void;
    const gate = new Promise<void>((res) => { releaseGate = res; });
    const embedder = new Embedder(async () => (<EmbedBackend>{
      embed: async () => {
        await gate; // simulates a slow embed call in flight
        const v = new Float32Array(EMBEDDING_DIM);
        v[0] = 0.5;
        return v;
      },
      dispose: async () => {},
    }));

    ingestDocument(db, {
      source: "file", uri: "/race.md", title: "race", ts: 1000,
      text: `${SECRET} appears in this document body.`,
    });

    // Start the drain; its first embedDoc() call will suspend on `gate` above.
    const drainPromise = drainEmbedQueue(db, embedder);

    // Flush pending microtasks/timers so drainEmbedQueue actually reaches the
    // gated await before we race the forget below.
    await new Promise((r) => setTimeout(r, 0));

    const r = forget(db, { source: "file" });
    expect(r.documents).toBe(1);

    releaseGate();
    await drainPromise;

    const count = (db.prepare("SELECT count(*) c FROM chunk_vectors").get() as { c: number }).c;
    expect(count).toBe(0);

    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    expect(readFileSync(dbPath).includes(SECRET)).toBe(false);
  });
});
