import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine, StaticKeyProvider, Embedder, EMBEDDING_DIM, type EmbedBackend,
} from "@shyn/engine";
import { startServer } from "../src/server.js";
import { rpcCall } from "../src/rpc.js";

// The daemon's half of coverage (see engine coverage.ts for the gap maths):
// it must stamp a beat the moment it comes up, keep stamping on an interval,
// and record WHICH agents were reporting at each beat — otherwise a live daemon
// with a dead capture agent is indistinguishable from a healthy one.

let sock: string, server: { close(): Promise<void> }, engine: Engine;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "shyn-cov-"));
  sock = join(dir, "e.sock");
  const embedder = new Embedder(async () => (<EmbedBackend>{
    embed: async () => new Float32Array(EMBEDDING_DIM), dispose: async () => {},
  }));
  engine = new Engine({
    dbPath: join(dir, "t.db"), keyProvider: new StaticKeyProvider(null), embedder,
  });
  server = await startServer({
    socketPath: sock, engine, version: "0.1.0-test",
    heartbeatIntervalMs: 25,       // fast beat so the test stays quick
    retentionIntervalMs: 3_600_000,
  });
});
afterEach(async () => { await server.close(); });

const beatCount = () =>
  (engine as any).db.prepare("SELECT COUNT(*) c FROM coverage").get().c as number;

describe("coverage heartbeat (daemon)", () => {
  it("beats at startup and keeps beating", async () => {
    // Startup beat is synchronous with startServer: no waiting required for the
    // first one, which is the point — a daemon that just came up has stamped it.
    expect(beatCount()).toBeGreaterThanOrEqual(1);
    const before = beatCount();
    // Beats are keyed by SECOND (two in one second are one observation), so a
    // sub-second interval cannot produce new rows. Cross a second boundary to
    // observe the interval firing at all.
    await new Promise((r) => setTimeout(r, 1_100));
    expect(beatCount()).toBeGreaterThan(before);
  });

  it("records which agents were reporting, and drops them when they go quiet", async () => {
    await rpcCall(sock, "captureStats", { screen: { state: "idle" } });
    await new Promise((r) => setTimeout(r, 80));
    const withAgent = (engine as any).db
      .prepare("SELECT agents FROM coverage WHERE agents LIKE '%screen%'").all();
    expect(withAgent.length).toBeGreaterThan(0);
  });

  it("serves a coverage report over the socket", async () => {
    const now = Math.floor(Date.now() / 1000);
    const r: any = await rpcCall(sock, "coverage", { timeFrom: now - 7200, timeTo: now });
    // Two hours back, a daemon seconds old: almost all of it was unobserved,
    // and that is the honest answer rather than an empty one.
    expect(r.unobservedSeconds).toBeGreaterThan(3600);
    expect(r.gaps.length).toBeGreaterThan(0);
    expect(r.windowTo).toBeLessThanOrEqual(now);
  });

  it("sweeps beats older than the retention window", async () => {
    engine.beat(["screen"], Math.floor(Date.now() / 1000) - 500 * 86400);
    const before = beatCount();
    expect(engine.sweepCoverage(400)).toBe(1);
    expect(beatCount()).toBe(before - 1);
  });
});
