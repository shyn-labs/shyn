import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, EMBEDDING_DIM } from "../src/storage.js";
import { ingestDocument } from "../src/ingest.js";
import { Embedder, type EmbedBackend } from "../src/embedder.js";
import { drainEmbedQueue } from "../src/embed-worker.js";
import { search } from "../src/search.js";
import type Database from "better-sqlite3-multiple-ciphers";

// Deterministic fake embeddings: direction encodes topic.
const topicVec = (topic: "carbon" | "food" | "other"): Float32Array => {
  const v = new Float32Array(EMBEDDING_DIM);
  if (topic === "carbon") v[0] = 1; else if (topic === "food") v[1] = 1; else v[2] = 1;
  return v;
};
const topicOf = (t: string) =>
  /carbon|offtake|soil/i.test(t) ? "carbon" : /biryani|recipe/i.test(t) ? "food" : "other";

let db: Database.Database;
let embedder: Embedder;
beforeEach(async () => {
  db = openDatabase({ dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"), key: null });
  embedder = new Embedder(async () => (<EmbedBackend>{
    embed: async (t) => topicVec(topicOf(t)),
    dispose: async () => {},
  }));
  const now = Math.floor(Date.now() / 1000);
  // Semantically relevant but shares no keywords with the query "carbon":
  ingestDocument(db, { source: "file", uri: "/offtakes.md", title: "offtakes",
    ts: now - 3600, text: "Buyers negotiate soil credit offtakes years ahead." });
  ingestDocument(db, { source: "browser", uri: "https://food", title: "biryani",
    ts: now - 3600, text: "Chicken biryani recipe steps" });
  await drainEmbedQueue(db, embedder);
});

describe("search", () => {
  it("returns hybrid mode and finds semantic match lacking query keywords", async () => {
    const r = await search(db, embedder, { query: "carbon" });
    expect(r.mode).toBe("hybrid");
    expect(r.hits.map(h => h.uri)).toContain("/offtakes.md");
    expect(r.hits[0].uri).not.toBe("https://food");
  });

  it("falls back to keyword-only when embedder unavailable", async () => {
    const broken = new Embedder(async () => { throw new Error("no model"); });
    const r = await search(db, broken, { query: "biryani recipe" });
    expect(r.mode).toBe("keyword-only");
    expect(r.hits[0].uri).toBe("https://food");
  });

  it("caps hits per document at 2", async () => {
    const now = Math.floor(Date.now() / 1000);
    const long = Array.from({ length: 10 }, (_, i) =>
      `# Part ${i}\n\ncarbon soil offtake paragraph ${"detail ".repeat(120)}`).join("\n\n");
    ingestDocument(db, { source: "file", uri: "/long.md", title: "long", ts: now, text: long });
    await drainEmbedQueue(db, embedder);
    const r = await search(db, embedder, { query: "carbon offtake", limit: 8 });
    expect(r.hits.filter(h => h.uri === "/long.md").length).toBeLessThanOrEqual(2);
  });
});
