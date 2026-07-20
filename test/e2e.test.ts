import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rpcCall } from "../packages/daemon/src/rpc.js";

const daemonPkgVersion: string = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../packages/daemon/package.json"), "utf8"),
).version;

let home: string, daemon: ChildProcess;
const sock = () => join(home, "shyn.sock");

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "shyn-e2e-"));
  daemon = spawn("pnpm", ["--filter", "@shyn/daemon", "start"], {
    env: {
      ...process.env,
      SHYN_HOME: home,
      SHYN_TEST_NO_KEYCHAIN: "1",
      SHYN_SKIP_MODEL_DOWNLOAD: "1",
    },
    stdio: "inherit",
    detached: true,
  });
  for (let i = 0; i < 280 && !existsSync(sock()); i++)
    await new Promise((r) => setTimeout(r, 100));
  expect(existsSync(sock())).toBe(true);
}, 30_000);

afterAll(() => {
  try {
    process.kill(-daemon.pid!, "SIGTERM");
  } catch {
    daemon.kill("SIGTERM");
  }
});

describe("e2e: real daemon subprocess", () => {
  it("ingest → keyword search works immediately (degraded ladder rung 1)", async () => {
    const docs = join(home, "docs"); mkdirSync(docs);
    writeFileSync(join(docs, "meeting.md"),
      "# Standup\n\nDecided to ship the shyn alpha to five friendly users by August.");
    await rpcCall(sock(), "ingest", {
      source: "file", uri: join(docs, "meeting.md"), title: "meeting",
      ts: Math.floor(Date.now() / 1000),
      text: "# Standup\n\nDecided to ship the shyn alpha to five friendly users by August.",
    });
    const r = await rpcCall(sock(), "search", { query: "alpha friendly users" });
    // model almost certainly not downloaded in a fresh temp home → keyword-only
    expect(["keyword-only", "hybrid"]).toContain(r.mode);
    expect(r.hits[0].uri).toContain("meeting.md");
  });

  it("status exposes the degraded-ladder state", async () => {
    const s = await rpcCall(sock(), "status", {});
    // SHYN_SKIP_MODEL_DOWNLOAD=1 means the download never even starts, so
    // both derived fields should read as "not there yet".
    expect(s.modelDownloadPct).toBe(0);
    expect(s.modelDownloaded).toBe(false);
    expect(s.modelLoaded).toBe(false);
    expect(s.documents).toBeGreaterThanOrEqual(1);
  });

  it("daemonVersion tracks the daemon package's own package.json version", async () => {
    const s = await rpcCall(sock(), "status", {});
    expect(s.daemonVersion).toBe(daemonPkgVersion);
  });
});
