import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.js";
import { StaticKeyProvider } from "../src/keys.js";
import { Embedder, type EmbedBackend } from "../src/embedder.js";
import { EMBEDDING_DIM } from "../src/storage.js";

describe("Engine facade", () => {
  it("wires ingest → drain → search → status → forget", async () => {
    const embedder = new Embedder(async () => (<EmbedBackend>{
      embed: async () => { const v = new Float32Array(EMBEDDING_DIM); v[0] = 1; return v; },
      dispose: async () => {},
    }));
    const e = new Engine({
      dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"),
      keyProvider: new StaticKeyProvider(null),
      embedder,
    });
    e.ingest({ source: "file", uri: "/a.md", title: "a",
      ts: Math.floor(Date.now() / 1000), text: "carbon offtake pricing" });
    await e.drain();
    const s1 = e.status();
    expect(s1).toMatchObject({ documents: 1, pendingEmbeds: 0, vectors: 1 });
    const r = await e.search({ query: "carbon" });
    expect(r.hits.length).toBe(1);
    expect(e.forget({ docId: r.hits[0].docId }).documents).toBe(1);
    expect(e.status().documents).toBe(0);
    await e.close();
  });

  it("close() waits for an in-flight drain", async () => {
    let resolveEmbed!: () => void;
    const gate = new Promise<void>((res) => { resolveEmbed = res; });
    let embedFinished = false;
    const embedder = new Embedder(async () => (<EmbedBackend>{
      embed: async () => { await gate; embedFinished = true;
        const v = new Float32Array(EMBEDDING_DIM); v[0] = 1; return v; },
      dispose: async () => {},
    }));
    const e = new Engine({
      dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"),
      keyProvider: new StaticKeyProvider(null), embedder,
    });
    e.ingest({ source: "file", uri: "/a.md", title: "a",
      ts: Math.floor(Date.now() / 1000), text: "text" });
    const inFlight = e.drain();          // blocks on gate
    const closing = e.close();           // must wait for drain
    let closed = false;
    void closing.then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(false);          // close still waiting
    resolveEmbed();
    await inFlight;
    await closing;
    expect(embedFinished).toBe(true);    // drain completed before close finished
  });

  it("lists recent documents", async () => {
    const embedder = new Embedder(async () => (<EmbedBackend>{
      embed: async () => new Float32Array(EMBEDDING_DIM), dispose: async () => {},
    }));
    const e = new Engine({
      dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"),
      keyProvider: new StaticKeyProvider(null), embedder,
    });
    const now = Math.floor(Date.now() / 1000);
    e.ingest({ source: "file", uri: "/old.md", title: "old", ts: now - 100 * 3600, text: "old" });
    e.ingest({ source: "file", uri: "/new.md", title: "new", ts: now - 3600, text: "new" });
    const r = e.recent({ hours: 24 });
    expect(r.map((d) => d.uri)).toEqual(["/new.md"]);
    await e.close();
  });

  // Reconstructing a specific past window (live finding 2026-08-05: a day
  // replay could only sample it via ranked search) needs an explicit window,
  // chronological order, and paging that does not silently truncate.
  it("enumerates an explicit past window, in order, with paging", async () => {
    const embedder = new Embedder(async () => (<EmbedBackend>{
      embed: async () => new Float32Array(EMBEDDING_DIM), dispose: async () => {},
    }));
    const e = new Engine({
      dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"),
      keyProvider: new StaticKeyProvider(null), embedder,
    });
    const day = 1_754_000_000;            // fixed epoch: no now() in assertions
    for (let i = 0; i < 5; i++) {
      e.ingest({ source: "screen", uri: `/h${i}`, title: `h${i}`, ts: day + i * 3600, text: `hour ${i}` });
    }
    e.ingest({ source: "screen", uri: "/outside", title: "outside", ts: day + 99 * 3600, text: "later" });

    // Window is inclusive on both ends and excludes anything outside it.
    const win = e.recent({ timeFrom: day + 3600, timeTo: day + 3 * 3600, order: "asc" });
    expect(win.map((d) => d.uri)).toEqual(["/h1", "/h2", "/h3"]);

    // asc/desc are mirror images of the same window.
    expect(e.recent({ timeFrom: day, timeTo: day + 4 * 3600, order: "desc" }).map((d) => d.uri))
      .toEqual(["/h4", "/h3", "/h2", "/h1", "/h0"]);

    // Paging covers the window exactly once, with no overlap or hole.
    const p1 = e.recent({ timeFrom: day, timeTo: day + 4 * 3600, order: "asc", limit: 2 });
    const p2 = e.recent({ timeFrom: day, timeTo: day + 4 * 3600, order: "asc", limit: 2, offset: 2 });
    const p3 = e.recent({ timeFrom: day, timeTo: day + 4 * 3600, order: "asc", limit: 2, offset: 4 });
    expect([...p1, ...p2, ...p3].map((d) => d.uri)).toEqual(["/h0", "/h1", "/h2", "/h3", "/h4"]);

    // timeFrom wins over the `hours` shorthand rather than intersecting with it:
    // `hours` is relative to now, and these fixtures are not.
    expect(e.recent({ hours: 1, timeFrom: day, timeTo: day + 4 * 3600 }).length).toBe(5);
    await e.close();
  });

  it("clamps recent() paging to sane bounds", async () => {
    const embedder = new Embedder(async () => (<EmbedBackend>{
      embed: async () => new Float32Array(EMBEDDING_DIM), dispose: async () => {},
    }));
    const e = new Engine({
      dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"),
      keyProvider: new StaticKeyProvider(null), embedder,
    });
    const day = 1_754_000_000;
    e.ingest({ source: "file", uri: "/a", title: "a", ts: day, text: "a" });
    // Absurd/invalid paging must not throw or return an unbounded result.
    expect(e.recent({ timeFrom: day - 10, limit: 10_000 }).length).toBe(1);
    expect(e.recent({ timeFrom: day - 10, limit: 0 }).length).toBe(1);       // clamped to >= 1
    expect(e.recent({ timeFrom: day - 10, offset: -5 }).length).toBe(1);     // clamped to >= 0
    await e.close();
  });

  it("syncReaders ingests, advances watermark, and reports unavailable readers", async () => {
    const embedder = new Embedder(async () => (<EmbedBackend>{
      embed: async () => new Float32Array(EMBEDDING_DIM), dispose: async () => {},
    }));
    const e = new Engine({
      dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"),
      keyProvider: new StaticKeyProvider(null), embedder,
    });
    const now = Math.floor(Date.now() / 1000);
    let lastSince = -1;
    const fake = {
      name: "fake",
      available: async () => ({ ok: true }),
      read: async (since: number) => {
        lastSince = since;
        return since >= now - 10 ? [] : [
          { source: "browser" as const, uri: "https://x", title: "X", ts: now - 5, text: "X\nhttps://x" },
        ];
      },
    };
    const dead = { name: "dead", available: async () => ({ ok: false, reason: "nope" }),
      read: async () => [] };

    const r1 = await e.syncReaders([fake, dead]);
    expect(r1).toEqual([
      { name: "fake", ok: true, ingested: 1, deduped: 0, rejected: 0 },
      { name: "dead", ok: false, reason: "nope", ingested: 0, deduped: 0, rejected: 0 },
    ]);
    const r2 = await e.syncReaders([fake]);      // watermark advanced to now-5
    expect(lastSince).toBe(now - 5);
    expect(r2[0]).toMatchObject({ ingested: 0 });
    await e.close();
  });

  it("re-ingesting a re-emitted boundary row via syncReaders is a no-op (dedup)", async () => {
    const embedder = new Embedder(async () => (<EmbedBackend>{
      embed: async () => new Float32Array(EMBEDDING_DIM), dispose: async () => {},
    }));
    const e = new Engine({
      dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"),
      keyProvider: new StaticKeyProvider(null), embedder,
    });
    const doc = {
      source: "browser" as const, uri: "https://edge.example", title: "Edge",
      ts: 2000, text: "Edge\nhttps://edge.example",
    };
    // A reader that always re-emits the same boundary row (per readers/types.ts
    // overlap semantics), regardless of the watermark passed in.
    const repeating = { name: "repeating", available: async () => ({ ok: true }),
      read: async () => [doc] };

    const r1 = await e.syncReaders([repeating]);
    expect(r1).toEqual([{ name: "repeating", ok: true, ingested: 1, deduped: 0, rejected: 0 }]);
    const r2 = await e.syncReaders([repeating]);
    expect(r2).toEqual([{ name: "repeating", ok: true, ingested: 0, deduped: 1, rejected: 0 }]);
    const count = (e as any).db.prepare("SELECT count(*) c FROM documents").get().c;
    expect(count).toBe(1);
    await e.close();
  });

  it("syncReaders passes through an ok-with-warning reason", async () => {
    const embedder = new Embedder(async () => (<EmbedBackend>{
      embed: async () => new Float32Array(EMBEDDING_DIM), dispose: async () => {},
    }));
    const e = new Engine({
      dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"),
      keyProvider: new StaticKeyProvider(null), embedder,
    });
    const warny = { name: "warny",
      available: async () => ({ ok: true, reason: "skipped 1 unreadable profile(s): Profile 2" }),
      read: async () => [] };
    const r = await e.syncReaders([warny]);
    expect(r[0].ok).toBe(true);
    expect(r[0].reason).toMatch(/Profile 2/);
    await e.close();
  });
});
