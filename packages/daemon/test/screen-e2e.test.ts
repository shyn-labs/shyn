import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine, StaticKeyProvider, Embedder, EMBEDDING_DIM, type EmbedBackend,
} from "@shyn/engine";
import { startServer } from "../src/server.js";
import { rpcCall } from "../src/rpc.js";

// A Node "fake agent" that speaks the exact wire shapes DaemonClient (Task 7)
// sends. This is the contract freeze for the Swift agent ⇄ daemon boundary —
// every payload here must match DaemonClient.ingest / postStats field-for-field.

let sock: string, server: { close(): Promise<void>; scheduleDrain(): void };

const now = Math.floor(Date.now() / 1000);

// mirrors DaemonClient.ingest params
const screenPayload = (uri: string, title: string, text: string, ts: number) => ({
  source: "screen", uri, title, ts, text,
  meta: { app: "TestApp", bundleId: "com.test.app", windowTitle: "Fake Window", method: "ax" },
});

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "shyn-se2e-"));
  sock = join(dir, "e.sock");
  const embedder = new Embedder(async () => (<EmbedBackend>{
    embed: async () => { const v = new Float32Array(EMBEDDING_DIM); v[0] = 1; return v; },
    dispose: async () => {},
  }));
  const engine = new Engine({
    dbPath: join(dir, "t.db"), keyProvider: new StaticKeyProvider(null), embedder,
  });
  server = await startServer({
    socketPath: sock, engine, version: "0.1.0-test",
    screenRetentionDays: 30, retentionIntervalMs: 500,
  });
});
afterEach(async () => { await server.close(); });

describe("screen capture e2e (fake agent → real daemon)", () => {
  it("full screen loop: bucket REPLACE, stats, retention, keyword search", async () => {
    const bucket1 = "screen://com.test.app/aaaaaaaaaaaa/2026-07-09-06";
    const bucket2 = "screen://com.test.app/aaaaaaaaaaaa/2026-07-09-07";
    const bucketOld = "screen://com.test.app/bbbbbbbbbbbb/2026-06-01-00";

    // 1. same bucket, different text → REPLACE (documents grows by 1, not 2)
    await rpcCall(sock, "ingest", screenPayload(bucket1, "TestApp — Fake Window",
      "alpha alpha the earliest screen state with enough words to clear the length gate", now));
    await rpcCall(sock, "ingest", screenPayload(bucket1, "TestApp — Fake Window",
      "beta beta the replacement screen state with enough words to clear the length gate", now + 30));
    let s = await rpcCall(sock, "status", {});
    expect(s.documents).toBe(1);

    // 2. next hour bucket → new doc
    await rpcCall(sock, "ingest", screenPayload(bucket2, "TestApp — Fake Window",
      "gamma gamma distinctive newest capture content with plenty of searchable words here", now));
    s = await rpcCall(sock, "status", {});
    expect(s.documents).toBe(2);

    // 3. captureStats round-trips into status.capture (exact Stats wire shape)
    const stats = { agentVersion: "0.1.0", lastCaptureTs: now, captures: 3,
      skips: { unchanged: 1 }, method: { ax: 3, ocr: 0 }, tcc: { ax: true, screen: false } };
    await rpcCall(sock, "captureStats", stats);
    s = await rpcCall(sock, "status", {});
    expect(s.capture).toEqual(stats);

    // 4. a 31-day-old screen doc → retention timer sweeps it byte-honest
    await rpcCall(sock, "ingest", screenPayload(bucketOld, "TestApp — Old",
      "OLDPAYLOAD_deadbeef this expired screen text must be purged by retention", now - 31 * 86400));
    s = await rpcCall(sock, "status", {});
    expect(s.documents).toBe(3);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && s.documents !== 2) {
      await new Promise((r) => setTimeout(r, 20));
      s = await rpcCall(sock, "status", {});
    }
    expect(s.documents).toBe(2);
    // expired text no longer keyword-searchable
    const gone = await rpcCall(sock, "search", { query: "OLDPAYLOAD_deadbeef" });
    expect(gone.hits.some((h: any) => h.uri === bucketOld)).toBe(false);

    // 5. newest capture is searchable as a screen doc with the agent's title
    const found = await rpcCall(sock, "search", { query: "gamma distinctive newest capture" });
    const hit = found.hits.find((h: any) => h.source === "screen");
    expect(hit).toBeTruthy();
    expect(hit.title).toBe("TestApp — Fake Window");
    expect(hit.uri).toBe(bucket2);
  });
});
