import { describe, it, expect } from "vitest";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendHello, startHelloLoop } from "../src/hello.js";

describe("hello handshake", () => {
  it("sends hello {client:'mcp'} and resolves on ack", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "shyn-hello-")), "s.sock");
    let seen: any = null;
    const server = createServer((c) => c.on("data", (d) => {
      const req = JSON.parse(d.toString());
      seen = req;
      c.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }) + "\n");
    }));
    await new Promise<void>((res) => server.listen(sock, res));
    try {
      await sendHello(sock);
      expect(seen.method).toBe("hello");
      expect(seen.params).toEqual({ client: "mcp" });
    } finally { server.close(); }
  });

  it("never throws when the daemon is down (startup must not break)", async () => {
    await expect(sendHello(join(mkdtempSync(join(tmpdir(), "shyn-hello-")), "no.sock")))
      .resolves.toBe(false);
  });

  // Lived 2026-07-17: the shim's single fire-and-forget hello landed while the
  // daemon was mid-crash-loop, was silently dropped, and status.lastMcpHelloTs
  // stayed stale for the shim's multi-day lifetime. The loop must retry until
  // the daemon acks, then keep refreshing so "last hello" tracks liveness.
  it("retries until a daemon appears, then stamps hello", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "shyn-hello-")), "late.sock");
    const stop = startHelloLoop(sock, { retryMs: 40, refreshMs: 60_000 });
    await new Promise((r) => setTimeout(r, 100));   // a few attempts fail: no listener yet
    const hellos: any[] = [];
    const server = createServer((c) => c.on("data", (d) => {
      const req = JSON.parse(d.toString());
      hellos.push(req);
      c.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }) + "\n");
    }));
    await new Promise<void>((res) => server.listen(sock, res));
    try {
      await new Promise((r) => setTimeout(r, 150)); // next retry should now succeed
      expect(hellos.length).toBeGreaterThan(0);
      expect(hellos[0].method).toBe("hello");
      expect(hellos[0].params).toEqual({ client: "mcp" });
    } finally { stop(); server.close(); }
  });

  it("keeps refreshing hello after the first ack", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "shyn-hello-")), "fresh.sock");
    let count = 0;
    const server = createServer((c) => c.on("data", (d) => {
      const req = JSON.parse(d.toString());
      count++;
      c.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }) + "\n");
    }));
    await new Promise<void>((res) => server.listen(sock, res));
    const stop = startHelloLoop(sock, { retryMs: 40, refreshMs: 60 });
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(count).toBeGreaterThanOrEqual(2);
    } finally { stop(); server.close(); }
  });

  it("stop() halts the loop", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "shyn-hello-")), "stop.sock");
    let count = 0;
    const server = createServer((c) => c.on("data", (d) => {
      const req = JSON.parse(d.toString());
      count++;
      c.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }) + "\n");
    }));
    await new Promise<void>((res) => server.listen(sock, res));
    const stop = startHelloLoop(sock, { retryMs: 20, refreshMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    // A hello dispatched just before stop() may still be in flight — let it
    // land before snapshotting, or the assertion races timer drift (flaky
    // under CI load).
    await new Promise((r) => setTimeout(r, 50));
    const at = count;
    await new Promise((r) => setTimeout(r, 100));
    try { expect(count).toBe(at); } finally { server.close(); }
  });
});
