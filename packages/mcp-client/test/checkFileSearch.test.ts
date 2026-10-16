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
}, 60_000);

afterAll(() => { server?.close(); rmSync(dir, { recursive: true, force: true }); });

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
});
