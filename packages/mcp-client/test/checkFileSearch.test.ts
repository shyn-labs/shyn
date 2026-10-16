// Drives scripts/check-file-search.mjs as a subprocess against a FAKE socket
// (synthetic data). Never touches the real thatone socket.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../../../..");
const SCRIPT = join(ROOT, "scripts/check-file-search.mjs");

let dir: string, sock: string, server: Server;
let slowSock: string, slowServer: Server;
const slowConns = new Set<import("node:net").Socket>();

const run = (args: string[], timeoutMs = 20_000) =>
  new Promise<{ code: number | null; out: string; ms: number }>((resolve, reject) => {
    const t0 = Date.now();
    const p = spawn("node", [SCRIPT, ...args], { cwd: ROOT });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("script timed out:\n" + out)); }, timeoutMs);
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, out, ms: Date.now() - t0 }); });
  });

const pids = () => {
  try {
    return execFileSync("pgrep", ["-f", "shyn-check-file-search"], { encoding: "utf8" }).trim();
  } catch { return ""; }
};

beforeAll(async () => {
  execFileSync("node", ["scripts/build-mcpb.mjs"], { cwd: ROOT, stdio: "inherit" });
  dir = mkdtempSync(join(tmpdir(), "shynfs-fake-"));
  sock = join(dir, "fake.sock");
  server = createServer((c) => {
    c.on("error", () => {});
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const req = JSON.parse(buf.slice(0, i));
      if (req.op === "ping") return void c.end('{"ok":true}\n');
      c.end(JSON.stringify({ ok: true, search: { notice: null, hits: [{
        paths: ["/Users/example/notes/sample.pdf"], kind: "pdf", score: 1, modified: 1700000000,
        anchors: [{ modality: "text", anchor: '{"page":2}', text: "Quarterly summary" }],
      }] } }) + "\n");
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  // Answers ping, never answers search: keeps a run busy so a signal can land.
  slowSock = join(dir, "slow.sock");
  slowServer = createServer((c) => {
    slowConns.add(c);
    c.on("error", () => {});
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      if (buf.includes('"op":"ping"')) { buf = ""; c.end('{"ok":true}\n'); }
    });
  });
  await new Promise<void>((r) => slowServer.listen(slowSock, r));
}, 60_000);

afterAll(() => {
  for (const c of slowConns) c.destroy();
  slowServer?.close();
  server?.close(); rmSync(dir, { recursive: true, force: true }); });

describe("scripts/check-file-search.mjs", () => {
  it("--help exits 0", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Usage/);
  });

  it("no query exits 2", async () => {
    expect((await run(["--no-build"])).code).toBe(2);
  });

  it("passes against a fake socket and cleans up", async () => {
    const r = await run(["--no-build", "--socket", sock, "sample query"]);
    expect(r.out).toMatch(/PASS search_files is listed/);
    expect(r.out).toMatch(/Quarterly summary/);
    expect(r.out).toMatch(/PASS search_files "sample query"/);
    expect(r.out).not.toMatch(/FAIL/);
    expect(r.code).toBe(0);
    const home = /temp SHYN_HOME (\S+)/.exec(r.out)?.[1];
    expect(home).toBeTruthy();
    expect(existsSync(home!)).toBe(false);
    expect(pids()).toBe("");
  }, 30_000);

  it("fails fast when the socket does not exist", async () => {
    const r = await run(["--no-build", "--socket", join(dir, "nope.sock"), "q"]);
    expect(r.out).toMatch(/FAIL search_files is listed/);
    expect(r.code).toBe(1);
    expect(r.ms).toBeLessThan(9_000);
    expect(pids()).toBe("");
  }, 30_000);

  it("--help documents every flag and the real-socket default", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    for (const f of ["--limit", "--socket", "--no-build", "--print-banner", "--help"]) expect(r.out).toContain(f);
    expect(r.out).toMatch(/WITHOUT --socket/);
    expect(r.out).toMatch(/REAL socket/);
    expect(r.out).toMatch(/private files/);
    expect(r.out).toMatch(/SHYN_FILE_SEARCH_SOCKET/);
  });

  it("banner states the socket (dry run, spawns nothing)", async () => {
    const d = await run(["--print-banner", "q"]);
    expect(d.code).toBe(0);
    expect(d.out).toMatch(/socket: default \(thatone's real socket\)/);
    expect(d.out).not.toMatch(/temp SHYN_HOME/);
    const s = await run(["--print-banner", "--socket", sock, "q"]);
    expect(s.code).toBe(0);
    expect(s.out).toContain(`socket: ${sock}`);
  });

  it("a real run prints the socket in the banner", async () => {
    const r = await run(["--no-build", "--socket", sock, "q"]);
    expect(r.out).toContain(`socket: ${sock}`);
  }, 30_000);

  it("--socket without a value exits 2", async () => {
    expect((await run(["--socket", "--no-build", "q"])).code).toBe(2);
    expect((await run(["q", "--socket"])).code).toBe(2);
  });

  it("-- makes later args queries, even -h", async () => {
    const r = await run(["--no-build", "--socket", join(dir, "nope.sock"), "--", "-h"]);
    expect(r.out).not.toMatch(/^Usage/m);
    expect(r.out).toMatch(/FAIL search_files is listed/);
    expect(r.code).toBe(1);
  }, 30_000);

  it("SIGINT mid-run exits 130, removes the temp home, leaves no child", async () => {
    const p = spawn("node", [SCRIPT, "--no-build", "--socket", slowSock, "slow query"], { cwd: ROOT });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const closed = new Promise<number | null>((r) => p.on("close", (c) => r(c)));
    try {
      const t0 = Date.now();
      while (!/PASS search_files is listed/.test(out)) {
        if (Date.now() - t0 > 15_000) throw new Error("never reached listing:\n" + out);
        await new Promise((r) => setTimeout(r, 100));
      }
      p.kill("SIGINT");
      const code = await Promise.race([closed, new Promise<string>((r) => setTimeout(() => r("timeout"), 8_000))]);
      expect(code).toBe(130);
      const home = /temp SHYN_HOME (\S+)/.exec(out)?.[1];
      expect(home).toBeTruthy();
      expect(existsSync(home!)).toBe(false);
      await new Promise((r) => setTimeout(r, 300));
      expect(pids()).toBe("");
    } finally {
      if (p.exitCode === null) p.kill("SIGKILL");
    }
  }, 40_000);
});
