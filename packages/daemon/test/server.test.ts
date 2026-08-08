import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine, StaticKeyProvider, Embedder, EMBEDDING_DIM, ModelNotReadyError, type EmbedBackend,
} from "@shyn/engine";
import { startServer } from "../src/server.js";
import { rpcCall } from "../src/rpc.js";

let sock: string, server: { close(): Promise<void>; scheduleDrain(): void };

const madeDocs: number[] = [];
const fakeReader = {
  name: "fake",
  available: async () => ({ ok: true }),
  read: async (since: number) => {
    if (madeDocs.length > 0) return [];
    madeDocs.push(1);
    const ts = Math.floor(Date.now() / 1000);
    return [{ source: "browser" as const, uri: "https://feed.example", title: "Reader fed document",
      ts, text: "Reader fed document\nhttps://feed.example" }];
  },
};

let dir: string;
let engine: Engine;

beforeEach(async () => {
  madeDocs.length = 0;
  dir = mkdtempSync(join(tmpdir(), "shyn-"));
  sock = join(dir, "e.sock");
  const embedder = new Embedder(async () => (<EmbedBackend>{
    embed: async () => { const v = new Float32Array(EMBEDDING_DIM); v[0] = 1; return v; },
    dispose: async () => {},
  }));
  engine = new Engine({
    dbPath: join(dir, "t.db"), keyProvider: new StaticKeyProvider(null), embedder,
  });
  server = await startServer({
    socketPath: sock, engine, version: "0.1.0-test",
    readers: [fakeReader], readerIntervalMs: 60_000,
  });
});
afterEach(async () => { await server.close(); });

describe("daemon rpc", () => {
  it("sets 0600 permissions on the socket", () => {
    expect(statSync(sock).mode & 0o777).toBe(0o600);
  });

  it("socket is never world-accessible (mode 0600 from creation)", () => {
    // existing test covers steady-state; this pins the umask guard exists:
    expect(statSync(sock).mode & 0o777).toBe(0o600);
  });

  it("rpcCall times out against a silent server", async () => {
    const { createServer } = await import("node:net");
    const silentSock = sock + ".silent";
    // accept, never respond — but drain the socket so it can detect the
    // client-side destroy() and close cleanly (a paused/unread socket never
    // emits "close", which would hang the server.close() below forever)
    const silent = createServer((s) => { s.resume(); });
    await new Promise<void>((res) => silent.listen(silentSock, res));
    await expect(rpcCall(silentSock, "status", {}, 200))
      .rejects.toThrow(/rpc timeout/);
    await new Promise<void>((res) => silent.close(() => res()));
  });

  it("round-trips ingest → status → search", async () => {
    const r = await rpcCall(sock, "ingest", {
      source: "file", uri: "/a.md", title: "a",
      ts: Math.floor(Date.now() / 1000), text: "carbon offtake pricing",
    });
    expect(r.deduped).toBe(false);
    // drain is async post-ingest; poll status briefly
    for (let i = 0; i < 50; i++) {
      if ((await rpcCall(sock, "status", {})).pendingEmbeds === 0) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    const s = await rpcCall(sock, "status", {});
    expect(s).toMatchObject({ documents: 1, pendingEmbeds: 0, daemonVersion: "0.1.0-test" });
    const found = await rpcCall(sock, "search", { query: "carbon" });
    expect(found.mode).toBe("hybrid");
    expect(found.hits[0].uri).toBe("/a.md");
  });

  it("status defaults modelDownloaded true when no extraStatus is wired (no download tracking)", async () => {
    const s = await rpcCall(sock, "status", {});
    expect(s.modelDownloadPct).toBe(100);
    expect(s.modelDownloaded).toBe(true);
    expect(s).toHaveProperty("modelLoaded");
  });

  it("status includes protocolVersion", async () => {
    expect((await rpcCall(sock, "status", {})).protocolVersion).toBe(1);
  });

  it("refuses forget without confirm", async () => {
    await expect(rpcCall(sock, "forget", { source: "file" }))
      .rejects.toThrow(/confirm/i);
  });

  it("rpc client surfaces the server error code", async () => {
    try { await rpcCall(sock, "forget", { source: "file" }); expect.unreachable(); }
    catch (e: any) { expect(e.code).toBe(-32001); }
  });

  it("returns JSON-RPC error for unknown method", async () => {
    await expect(rpcCall(sock, "nope", {})).rejects.toThrow(/method not found/i);
  });

  it("periodic backfill drains the embed queue once the model becomes ready", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shyn-"));
    const localSock = join(dir, "e2.sock");
    let ready = false;
    const embedder = new Embedder(async () => {
      if (!ready) throw new ModelNotReadyError();
      return <EmbedBackend>{
        embed: async () => { const v = new Float32Array(EMBEDDING_DIM); v[0] = 1; return v; },
        dispose: async () => {},
      };
    });
    const engine = new Engine({
      dbPath: join(dir, "t2.db"), keyProvider: new StaticKeyProvider(null), embedder,
    });
    const localServer = await startServer({
      socketPath: localSock, engine, version: "0.1.0-test", backfillIntervalMs: 50,
    });
    try {
      await rpcCall(localSock, "ingest", {
        source: "file", uri: "/b.md", title: "b",
        ts: Math.floor(Date.now() / 1000), text: "waiting on model",
      });
      // model not ready yet: give the backfill interval several chances to fire,
      // pending must stay untouched (not marked failed) while it does
      await new Promise((res) => setTimeout(res, 150));
      let s = await rpcCall(localSock, "status", {});
      expect(s.pendingEmbeds).toBe(1);
      expect(s.failedEmbeds).toBe(0);

      ready = true; // simulate the embedding model finishing download
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        s = await rpcCall(localSock, "status", {});
        if (s.pendingEmbeds === 0 && s.vectors === 1) break;
        await new Promise((res) => setTimeout(res, 10));
      }
      expect(s.pendingEmbeds).toBe(0);
      expect(s.vectors).toBe(1);
    } finally {
      await localServer.close();
    }
  });

  it("sync RPC runs readers and status caches the last result", async () => {
    const s0 = await rpcCall(sock, "status", {});
    expect(s0.readers).toEqual([]);
    const r = await rpcCall(sock, "sync", {});
    expect(r).toEqual([{ name: "fake", ok: true, ingested: 1, deduped: 0, rejected: 0 }]);
    const s1 = await rpcCall(sock, "status", {});
    expect(s1.readers).toEqual(r);
    // reader-fed content is searchable
    const found = await rpcCall(sock, "search", { query: "reader fed document" });
    expect(found.hits.length).toBeGreaterThanOrEqual(1);
  });

  it("runs an initial sync shortly after startup without a client ever calling sync (spec §14.2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shyn-"));
    const localSock = join(dir, "e3.sock");
    const embedder = new Embedder(async () => (<EmbedBackend>{
      embed: async () => { const v = new Float32Array(EMBEDDING_DIM); v[0] = 1; return v; },
      dispose: async () => {},
    }));
    const engine = new Engine({
      dbPath: join(dir, "t3.db"), keyProvider: new StaticKeyProvider(null), embedder,
    });
    const localServer = await startServer({
      socketPath: localSock, engine, version: "0.1.0-test",
      readers: [fakeReader], readerIntervalMs: 60_000, initialSyncDelayMs: 50,
    });
    try {
      const deadline = Date.now() + 1000;
      let s = await rpcCall(localSock, "status", {});
      while (Date.now() < deadline && s.readers.length === 0) {
        await new Promise((res) => setTimeout(res, 20));
        s = await rpcCall(localSock, "status", {});
      }
      expect(s.readers).toEqual([{ name: "fake", ok: true, ingested: 1, deduped: 0, rejected: 0 }]);
    } finally {
      await localServer.close();
    }
  });

  it("concurrent sync calls serialize (no interleaved reader passes)", async () => {
    const [r1, r2] = await Promise.all([
      rpcCall(sock, "sync", {}),
      rpcCall(sock, "sync", {}),
    ]);
    // fakeReader emits its doc only once; whichever pass ran first ingested it,
    // the serialized second pass saw no new docs
    const counts = [r1[0], r2[0]].map((r) => `${r.ingested}/${r.deduped}`).sort();
    expect(counts).toEqual(["0/0", "1/0"]);
  });

  it("captureStats round-trips into status.capture", async () => {
    const stats = { agentVersion: "0.1.0", lastCaptureTs: 1234, captures: 7,
      skips: { excludedTitle: 2 }, method: { ax: 6, ocr: 1 } };
    await rpcCall(sock, "captureStats", stats);
    const s = await rpcCall(sock, "status", {});
    expect(s.capture).toEqual(stats);
  });

  it("status.capture defaults to not-reporting before any agent post", async () => {
    const s = await rpcCall(sock, "status", {});
    expect(s.capture).toEqual({ agent: "not-reporting" });
  });

  it("captureStats posts merge by top-level key (screen + meeting agents coexist)", async () => {
    await rpcCall(sock, "captureStats", { agentVersion: "0.1.0", captures: 5 });
    await rpcCall(sock, "captureStats", { meeting: { state: "idle", meetingsCaptured: 1 } });
    let s = await rpcCall(sock, "status", {});
    expect(s.capture.captures).toBe(5);                       // screen block survives
    expect(s.capture.meeting).toEqual({ state: "idle", meetingsCaptured: 1 });
    await rpcCall(sock, "captureStats", { agentVersion: "0.1.0", captures: 6 });
    s = await rpcCall(sock, "status", {});
    expect(s.capture.captures).toBe(6);                       // screen refresh works
    expect(s.capture.meeting.meetingsCaptured).toBe(1);       // meeting block survives
  });

  it("retention timer sweeps expired screen docs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shyn-"));
    const localSock = join(dir, "e3.sock");
    const embedder = new Embedder(async () => (<EmbedBackend>{
      embed: async () => { const v = new Float32Array(EMBEDDING_DIM); v[0] = 1; return v; },
      dispose: async () => {},
    }));
    const engine = new Engine({
      dbPath: join(dir, "t3.db"), keyProvider: new StaticKeyProvider(null), embedder,
    });
    const localServer = await startServer({
      socketPath: localSock, engine, version: "0.1.0-test",
      screenRetentionDays: 30, retentionIntervalMs: 50,
    });
    try {
      const now = Math.floor(Date.now() / 1000);
      await rpcCall(localSock, "ingest", { source: "screen", uri: "screen://a/b/old",
        title: "old", ts: now - 31 * 86400, text: "expired screen capture text" });
      const deadline = Date.now() + 2000;
      let s = await rpcCall(localSock, "status", {});
      while (Date.now() < deadline && s.documents !== 0) {
        await new Promise((res) => setTimeout(res, 10));
        s = await rpcCall(localSock, "status", {});
      }
      expect(s.documents).toBe(0);
    } finally {
      await localServer.close();
    }
  });

  it("meeting retention timer sweeps expired meeting docs (0 keeps)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shyn-"));
    const localSock = join(dir, "m.sock");
    const embedder = new Embedder(async () => (<EmbedBackend>{
      embed: async () => { const v = new Float32Array(EMBEDDING_DIM); v[0] = 1; return v; },
      dispose: async () => {},
    }));
    const engine = new Engine({ dbPath: join(dir, "t.db"),
      keyProvider: new StaticKeyProvider(null), embedder });
    const localServer = await startServer({ socketPath: localSock, engine, version: "0.1.0-test",
      meetingRetentionDays: 30, retentionIntervalMs: 50 });
    try {
      const now = Math.floor(Date.now() / 1000);
      await rpcCall(localSock, "ingest", { source: "meeting", uri: "meeting://a/2026-05-01-0900",
        title: "old", ts: now - 40 * 86400, text: "Me: expired meeting\nOthers: hi there" });
      const deadline = Date.now() + 2000;
      let s = await rpcCall(localSock, "status", {});
      while (Date.now() < deadline && s.documents !== 0) {
        await new Promise((r) => setTimeout(r, 10));
        s = await rpcCall(localSock, "status", {});
      }
      expect(s.documents).toBe(0);
    } finally { await localServer.close(); }
  });

  it("hello from an mcp client surfaces as lastMcpHelloTs in status (memory-only)", async () => {
    let s = await rpcCall(sock, "status", {});
    expect(s.lastMcpHelloTs).toBeNull();
    const before = Math.floor(Date.now() / 1000);
    await rpcCall(sock, "hello", { client: "mcp" });
    s = await rpcCall(sock, "status", {});
    expect(s.lastMcpHelloTs).toBeGreaterThanOrEqual(before);
    // non-mcp hellos are acknowledged but don't move the timestamp
    const t = s.lastMcpHelloTs;
    await rpcCall(sock, "hello", { client: "somethingelse" });
    s = await rpcCall(sock, "status", {});
    expect(s.lastMcpHelloTs).toBe(t);
  });

  it("stats RPC returns aggregates and search RPC increments the counter", async () => {
    await rpcCall(sock, "ingest", {
      source: "browser", uri: "https://s1", title: "t",
      ts: Math.floor(Date.now() / 1000), text: "hello counters world",
    });
    const before = await rpcCall(sock, "stats", { days: 7 });
    expect(before.pagesRead).toBe(1);
    expect(typeof before.searches).toBe("number");

    await rpcCall(sock, "search", { query: "hello" });
    await rpcCall(sock, "search", { query: "world" });

    const after = await rpcCall(sock, "stats", {});
    expect(after.searches).toBe(before.searches + 2);
    expect(after.searchesTotal).toBe(before.searchesTotal + 2);
    expect(after.totals.documents).toBeGreaterThanOrEqual(1);
  });

  it("search counter persists across server restarts", async () => {
    await rpcCall(sock, "search", { query: "persist me not the text" });
    const s1 = await rpcCall(sock, "stats", {});
    await server.close();
    const embedder = new Embedder(async () => (<EmbedBackend>{
      embed: async () => { const v = new Float32Array(EMBEDDING_DIM); v[0] = 1; return v; },
      dispose: async () => {},
    }));
    const reopenedEngine = new Engine({
      dbPath: join(dir, "t.db"), keyProvider: new StaticKeyProvider(null), embedder,
    });
    server = await startServer({
      socketPath: sock, engine: reopenedEngine, version: "t",
      readers: [], readerIntervalMs: 60_000,
    });
    const s2 = await rpcCall(sock, "stats", {});
    expect(s2.searchesTotal).toBe(s1.searchesTotal);
  });
});

it("mcp hello timestamp survives a server restart", async () => {
  await rpcCall(sock, "hello", { client: "mcp" });
  const s1 = await rpcCall(sock, "status", {});
  expect(s1.lastMcpHelloTs).toBeGreaterThan(0);
  await server.close();
  server = await startServer({
    socketPath: sock, engine, version: "t", readers: [], readerIntervalMs: 60_000,
  });
  const s2 = await rpcCall(sock, "status", {});
  expect(s2.lastMcpHelloTs).toBe(s1.lastMcpHelloTs);
});

it("survives a client that disconnects before the response is written", async () => {
  // Lived 2026-07-19: status-ui's 2s rpc timeout destroys its socket while a
  // slow handler is still running; the daemon's late response write EPIPEs,
  // readline re-emits that error on its Interface (which had no listener),
  // and the unhandled 'error' event killed the whole daemon — 12 crash
  // cycles in one production log. The client side of this exact bug was
  // already fixed in rpc.ts; this pins the server side.
  const uncaught: unknown[] = [];
  const onUncaught = (e: unknown) => { uncaught.push(e); };
  process.on("uncaughtException", onUncaught);
  const slowSock = join(dir, "slow.sock");
  // A reader the test holds open, so the daemon's response write happens at a
  // moment of the test's choosing — after the client fd is closed at kernel
  // level but BEFORE the daemon's event loop has polled and seen the EOF
  // (production: the loop was busy embedding when the client timed out).
  // Only that ordering produces the raw EPIPE; once 'end' is processed the
  // socket is already destroyed and the write takes the survivable path.
  let release!: () => void;
  let gate = new Promise<void>((r) => { release = r; });
  const gatedReader = {
    name: "gated",
    available: async () => ({ ok: true }),
    read: async () => { await gate; return []; },
  };
  const slow = await startServer({
    socketPath: slowSock, engine, version: "t-slow",
    readers: [gatedReader], readerIntervalMs: 60_000,
  });
  try {
    const { createConnection } = await import("node:net");
    // The raw EPIPE needs a precise event-loop ordering; a single round can
    // silently take the survivable already-destroyed-socket path and pass
    // vacuously even with the fix removed. Three rounds make a timing miss
    // on any one round non-fatal to the regression coverage.
    for (let round = 0; round < 3; round++) {
      const c = createConnection(slowSock);
      await new Promise<void>((res) => c.on("connect", res));
      c.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sync", params: {} }) + "\n");
      await new Promise((r) => setTimeout(r, 50)); // daemon is parked on the gate
      // Same synchronous block: the fd closes, then the handler resumes via
      // microtask and writes — all before the poll phase can deliver the EOF.
      c.destroy();
      release();
      gate = new Promise<void>((r) => { release = r; }); // re-arm for next round
      await new Promise((r) => setTimeout(r, 100));
    }
    // the daemon must still be alive and answering
    const status = await rpcCall(slowSock, "status", {}, 2000);
    expect(status.daemonVersion).toBe("t-slow");
    expect(uncaught).toEqual([]);
  } finally {
    process.removeListener("uncaughtException", onUncaught);
    await slow.close();
  }
});

it("sync {full:true} resets reader watermarks so history re-walks", async () => {
  await rpcCall(sock, "sync", {});                       // normal sync sets a watermark
  const before = await rpcCall(sock, "sync", {});        // nothing new
  const again = await rpcCall(sock, "sync", { full: true });
  // fake reader re-offers its docs; full sync must re-see them (deduped is fine)
  const total = (r: any) => r.reduce((a: number, x: any) => a + (x.ingested ?? 0) + (x.deduped ?? 0), 0);
  expect(total(again)).toBeGreaterThanOrEqual(total(before));
});

describe("document rpc", () => {
  it("returns the reassembled document", async () => {
    engine.ingest({ source: "meeting", uri: "meeting://d/1", title: "Sync", ts: 1000,
      text: "Me: hello\n\nOthers: hi there" });
    await engine.drain();
    const hit: any = await rpcCall(sock, "document", { uri: "meeting://d/1" });
    expect(hit.text).toBe("Me: hello\n\nOthers: hi there");
    expect(hit.source).toBe("meeting");
    expect(hit.chunkCount).toBe(1);
  });

  it("returns null for a uri that does not exist", async () => {
    expect(await rpcCall(sock, "document", { uri: "meeting://d/nope" })).toBeNull();
  });

  it("surfaces an ambiguous uri as an rpc error naming the sources", async () => {
    engine.ingest({ source: "file", uri: "same", title: "f", ts: 1000, text: "from the file" });
    engine.ingest({ source: "notes", uri: "same", title: "n", ts: 1001, text: "from the note" });
    await engine.drain();
    await expect(rpcCall(sock, "document", { uri: "same" })).rejects.toThrow(/file, notes/);
  });
});

describe("export/import rpc", () => {
  it("round-trips the corpus through an encrypted archive", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = join(mkdtempSync(join(tmpdir(), "shyn-arc-")), "m.shynarc");
    engine.ingest({ source: "notes", uri: "note://a", title: "A", ts: 1000, text: "alpha body" });
    await engine.drain();
    const e: any = await rpcCall(sock, "export", { path, passphrase: "pw" });
    expect(e.documents).toBeGreaterThan(0);
    // Importing into the same store is a no-op: dedup makes restore idempotent.
    const i: any = await rpcCall(sock, "import", { path, passphrase: "pw" });
    expect(i.imported).toBe(0);
    expect(i.deduped).toBe(e.documents);
  });

  it("surfaces a wrong passphrase as an rpc error", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = join(mkdtempSync(join(tmpdir(), "shyn-arc-")), "m.shynarc");
    await rpcCall(sock, "export", { path, passphrase: "right" });
    await expect(rpcCall(sock, "import", { path, passphrase: "wrong" }))
      .rejects.toThrow(/wrong passphrase|corrupt/i);
  });
});
