import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileSearch, FILE_KINDS } from "../src/fileSearch.js";

let dir: string, sock: string, server: Server | undefined;
let conns: Set<Socket>;
let received: any[];
let rawLines: string[];

type Handler = (line: string, c: Socket) => void;

const listen = (handler: Handler) =>
  new Promise<void>((resolve) => {
    server = createServer((c) => {
      conns.add(c);
      c.on("close", () => conns.delete(c));
      c.on("error", () => {});
      let buf = "";
      c.on("data", (d) => {
        buf += d.toString("utf8");
        const i = buf.indexOf("\n");
        if (i >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          rawLines.push(line);
          try {
            received.push(JSON.parse(line));
          } catch {
            received.push({ unparsable: line });
          }
          handler(line, c);
        }
      });
    });
    server.listen(sock, resolve);
  });

const okReply = (hits: any[] = [], notice: string | null = null) =>
  JSON.stringify({ ok: true, search: { hits, notice } }) + "\n";

const hit = {
  paths: ["/Users/example/docs/a.pdf"],
  kind: "pdf",
  score: 0.5,
  modified: 1700000000,
  anchors: [{ modality: "text", anchor: '{"page":3}', text: "hello example.com", viaKeyword: true, viaVector: false }],
};

const settle = async () => {
  for (let i = 0; i < 50 && conns.size > 0; i++) await new Promise((r) => setTimeout(r, 10));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shyn-"));
  sock = join(dir, "q.sock");
  conns = new Set();
  received = [];
  rawLines = [];
  server = undefined;
});

afterEach(async () => {
  for (const c of conns) c.destroy();
  if (server) await new Promise((r) => server!.close(r));
  rmSync(dir, { recursive: true, force: true });
});

describe("createFileSearch", () => {
  it("exports the kinds tuple", () => {
    expect(FILE_KINDS).toEqual(["image", "pdf", "document", "audio", "video", "text", "code"]);
  });

  it("parses an ok reply and drops viaKeyword/viaVector", async () => {
    await listen((_l, c) => c.end(okReply([hit], "model loading")));
    const fs = createFileSearch(sock);
    const r = await fs.search({ query: "hello" });
    expect(r.notice).toBe("model loading");
    expect(r.hits).toEqual([
      {
        paths: ["/Users/example/docs/a.pdf"],
        kind: "pdf",
        score: 0.5,
        modified: 1700000000,
        anchors: [{ modality: "text", anchor: '{"page":3}', text: "hello example.com" }],
      },
    ]);
    expect(received[0]).toEqual({
      v: 1,
      op: "search",
      query: { query: "hello", kinds: [], limit: 10 },
    });
  });

  it("omits notice when null", async () => {
    await listen((_l, c) => c.end(okReply([])));
    const r = await createFileSearch(sock).search({ query: "x" });
    expect(r).toEqual({ hits: [] });
  });

  it("surfaces ok:false messages truncated to 200 chars", async () => {
    await listen((_l, c) => c.end(JSON.stringify({ ok: false, error: "e".repeat(500) }) + "\n"));
    const err = await createFileSearch(sock).search({ query: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message.startsWith("file search: ")).toBe(true);
    expect(err.message.length).toBeLessThanOrEqual("file search: ".length + 200);
    expect(err.message).toContain("eeee");
  });

  it("handles a reply split over several chunks", async () => {
    await listen(async (_l, c) => {
      const s = okReply([hit]);
      for (let i = 0; i < s.length; i += 7) {
        c.write(s.slice(i, i + 7));
        await new Promise((r) => setTimeout(r, 2));
      }
    });
    const r = await createFileSearch(sock).search({ query: "x" });
    expect(r.hits).toHaveLength(1);
  });

  it("rejects when the connection closes without a newline", async () => {
    await listen((_l, c) => c.end('{"ok":true'));
    await expect(createFileSearch(sock).search({ query: "x" })).rejects.toThrow(/^file search: /);
  });

  it("rejects an early close with no data", async () => {
    await listen((_l, c) => c.end());
    await expect(createFileSearch(sock).search({ query: "x" })).rejects.toThrow(/^file search: /);
  });

  it("rejects a 2 MB reply and destroys the socket", async () => {
    await listen((_l, c) => c.write("a".repeat(2 * 1024 * 1024)));
    await expect(createFileSearch(sock).search({ query: "x" })).rejects.toThrow(/too large|exceed/);
    await settle();
    expect(conns.size).toBe(0);
  });

  it("rejects a garbage reply", async () => {
    await listen((_l, c) => c.end("not json\n"));
    await expect(createFileSearch(sock).search({ query: "x" })).rejects.toThrow(/^file search: /);
  });

  it("rejects an ok reply with no search payload", async () => {
    await listen((_l, c) => c.end('{"ok":true}\n'));
    await expect(createFileSearch(sock).search({ query: "x" })).rejects.toThrow(/^file search: /);
  });

  it("times out when the server never answers, and leaves no connection", async () => {
    await listen(() => {});
    const t0 = Date.now();
    await expect(createFileSearch(sock, { queryMs: 100 }).search({ query: "x" })).rejects.toThrow(
      /^file search: thatone did not answer in 0 s \(it may still be loading its model or busy indexing; try again shortly\)$/,
    );
    expect(Date.now() - t0).toBeLessThan(1000);
    await settle();
    expect(conns.size).toBe(0);
  });

  it("leaves no connection after success or ok:false", async () => {
    let fail = false;
    await listen((_l, c) =>
      c.write(fail ? JSON.stringify({ ok: false, error: "busy" }) + "\n" : okReply([])));
    await createFileSearch(sock).search({ query: "x" });
    await settle();
    expect(conns.size).toBe(0);
    fail = true;
    await expect(createFileSearch(sock).search({ query: "x" })).rejects.toThrow(/busy/);
    await settle();
    expect(conns.size).toBe(0);
  });

  it("stale socket file with no server: ping false, search rejects fast", async () => {
    // a regular file is not a socket
    writeFileSync(sock, "");
    const fs = createFileSearch(sock);
    expect(fs.socketPresent()).toBe(false);
    expect(await fs.ping()).toBe(false);
    await expect(fs.search({ query: "x" })).rejects.toThrow(/^file search: /);
  });

  it("socket file left behind by a dead server: ping false, search rejects fast", async () => {
    await listen(() => {});
    // close listener but keep the socket inode: unlink happens on close, so recreate via a raw listen then kill without unlink
    const { spawnSync } = await import("node:child_process");
    const s2 = join(dir, "stale.sock");
    spawnSync(process.execPath, [
      "-e",
      `const n=require("net");const s=n.createServer().listen(${JSON.stringify(s2)},()=>process.kill(process.pid,"SIGKILL"));`,
    ], { timeout: 20_000 });
    const fs = createFileSearch(s2);
    expect(fs.socketPresent()).toBe(true);
    const t0 = Date.now();
    expect(await fs.ping()).toBe(false);
    await expect(fs.search({ query: "x" })).rejects.toThrow(/^file search: /);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("missing path: socketPresent false, ping false", async () => {
    const fs = createFileSearch(join(dir, "nope.sock"));
    expect(fs.socketPresent()).toBe(false);
    expect(await fs.ping()).toBe(false);
    await expect(fs.search({ query: "x" })).rejects.toThrow(/^file search: /);
  });

  it("empty-string path: ping false, search rejects", async () => {
    const fs = createFileSearch("");
    expect(fs.socketPresent()).toBe(false);
    expect(await fs.ping()).toBe(false);
    await expect(fs.search({ query: "x" })).rejects.toThrow(/^file search: /);
  });

  it("ping true on {ok:true}, false on ok:false, false on garbage, false on timeout", async () => {
    let mode = "ok";
    await listen((_l, c) => {
      if (mode === "ok") c.write('{"ok":true}\n');
      else if (mode === "no") c.write('{"ok":false,"error":"x"}\n');
      else if (mode === "garbage") c.write("zzz\n");
    });
    const fs = createFileSearch(sock, { connectMs: 100 });
    expect(await fs.ping()).toBe(true);
    mode = "no";
    expect(await fs.ping()).toBe(false);
    mode = "garbage";
    expect(await fs.ping()).toBe(false);
    mode = "silent";
    expect(await fs.ping()).toBe(false);
    await settle();
    expect(conns.size).toBe(0);
    expect(received.every((m) => m.op === "ping" && m.v === 1)).toBe(true);
  });

  it("a query with newline and NUL arrives as exactly one JSON line", async () => {
    await listen((_l, c) => c.end(okReply([])));
    await createFileSearch(sock).search({ query: "a\nb\u0000c" });
    expect(rawLines).toHaveLength(1);
    expect(received[0].query.query).toBe("a\nb\u0000c");
  });

  it("clamps limit to 1..20 and floors non-integers", async () => {
    await listen((_l, c) => c.end(okReply([])));
    const fs = createFileSearch(sock);
    await fs.search({ query: "x", limit: 0 });
    await fs.search({ query: "x", limit: 500 });
    await fs.search({ query: "x", limit: 7.9 });
    await fs.search({ query: "x", limit: Number.NaN });
    expect(received.map((m) => m.query.limit)).toEqual([1, 20, 7, 10]);
  });

  it("drops unknown kinds and passes folder", async () => {
    await listen((_l, c) => c.end(okReply([])));
    await createFileSearch(sock).search({
      query: "x",
      kinds: ["pdf", "exe", "audio", "../x", "code"],
      folder: "/Users/example/docs",
    });
    expect(received[0].query.kinds).toEqual(["pdf", "audio", "code"]);
    expect(received[0].query.folder).toBe("/Users/example/docs");
  });

  it("sends folder only when it is a non-empty string, never since", async () => {
    await listen((_l, c) => c.end(okReply([])));
    const fs = createFileSearch(sock);
    await fs.search({ query: "x", folder: "" });
    await fs.search({ query: "x" });
    await fs.search({ query: "x", folder: "/Users/example/docs" });
    expect("folder" in received[0].query).toBe(false);
    expect("folder" in received[1].query).toBe(false);
    expect(received[2].query.folder).toBe("/Users/example/docs");
    for (const m of received) {
      expect("since" in m.query).toBe(false);
      expect(Object.keys(m.query)).toEqual(expect.arrayContaining(["query", "kinds", "limit"]));
    }
  });

  it("trims the query, caps at 2000 chars, rejects empty without connecting", async () => {
    await listen((_l, c) => c.end(okReply([])));
    const fs = createFileSearch(sock);
    await fs.search({ query: "  padded  " });
    await fs.search({ query: "y".repeat(5000) });
    expect(received[0].query.query).toBe("padded");
    expect(received[1].query.query).toHaveLength(2000);
    await expect(fs.search({ query: "   " })).rejects.toThrow(/^file search: /);
    expect(received).toHaveLength(2);
  });

  it("only ever writes search and ping ops", async () => {
    await listen((l, c) => c.end(JSON.parse(l).op === "ping" ? '{"ok":true}\n' : okReply([])));
    const fs = createFileSearch(sock);
    await fs.ping();
    await fs.search({ query: "x", kinds: ["image"], folder: "/tmp/x", limit: 3 });
    await fs.search({ query: "y" }).catch(() => {});
    expect(new Set(received.map((m) => m.op))).toEqual(new Set(["ping", "search"]));
    expect(received.every((m) => m.v === 1)).toBe(true);
  });
});
