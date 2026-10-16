import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { Engine, StaticKeyProvider, Embedder, EMBEDDING_DIM, type EmbedBackend } from "@shyn/engine";
import { startServer } from "@shyn/daemon";
import { rpcCall } from "@shyn/daemon/rpc";
import { buildMcpServer, classifyRpcError } from "../src/tools.js";

// Never let a test reach the real file-search app's default socket: servers
// built without an explicit fileSearchSocket fall back to this env var, which
// points at a path that never exists.
const noFileSearchDir = mkdtempSync(join(tmpdir(), "shynfs-none-"));
process.env.SHYN_FILE_SEARCH_SOCKET = join(noFileSearchDir, "none.sock");
afterAll(() => rmSync(noFileSearchDir, { recursive: true, force: true }));

const mcpClientPkgVersion: string = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"),
).version;

let dir: string, daemon: { close(): Promise<void> }, client: Client, sock: string;
// Kept for coverage tests, which need to stamp heartbeats at synthetic times.
let engineRef: Engine;

const fakeReader = {
  name: "fake",
  available: async () => ({ ok: true }),
  read: async () => [],
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "shyn-"));
  sock = join(dir, "e.sock");
  const embedder = new Embedder(async () => (<EmbedBackend>{
    embed: async () => { const v = new Float32Array(EMBEDDING_DIM); v[0] = 1; return v; },
    dispose: async () => {},
  }));
  const engine = new Engine({
    dbPath: join(dir, "e.db"), keyProvider: new StaticKeyProvider(null), embedder,
  });
  engineRef = engine;
  daemon = await startServer({
    socketPath: sock, engine, version: "t",
    readers: [fakeReader], readerIntervalMs: 60_000,
  });
  const mcp = buildMcpServer(sock);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([mcp.connect(st), client.connect(ct)]);
});
afterEach(async () => { await client.close(); await daemon.close(); });

const text = (r: any) => r.content.map((c: any) => c.text).join("\n");

describe("mcp tools", () => {
  it("exposes exactly the 6 spec tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["forget", "get_document", "memory_status", "recent_activity", "remember", "search_memory"]);
  });

  it("remember → search_memory round-trip with provenance and mode", async () => {
    await client.callTool({ name: "remember",
      arguments: { content: "Sam prefers filter coffee over espresso" } });
    const r = await client.callTool({ name: "search_memory",
      arguments: { query: "coffee preference" } });
    const t = text(r);
    expect(t).toMatch(/mode: (hybrid|keyword-only)/);
    expect(t).toMatch(/filter coffee/);
    expect(t).toMatch(/source: conversation/);
  });

  it("forget refuses without confirm and works with it", async () => {
    await client.callTool({ name: "remember", arguments: { content: "temp fact" } });
    const refused = await client.callTool({ name: "forget",
      arguments: { source: "conversation", confirm: false } });
    expect(text(refused)).toMatch(/confirm/i);
    const ok = await client.callTool({ name: "forget",
      arguments: { source: "conversation", confirm: true } });
    expect(text(ok)).toMatch(/forgotten: 1/);
  });

  it("remember dedups identical content, distinguishes different content", async () => {
    const first = await client.callTool({ name: "remember",
      arguments: { content: "Sam's father lives in Springfield" } });
    expect(text(first)).toBe("remembered");
    const second = await client.callTool({ name: "remember",
      arguments: { content: "Sam's father lives in Springfield" } });
    expect(text(second)).toBe("already remembered");
    const different = await client.callTool({ name: "remember",
      arguments: { content: "Sam's son is four years old" } });
    expect(text(different)).toBe("remembered");
    const r = await client.callTool({ name: "recent_activity", arguments: { hours: 1 } });
    const uris = text(r).match(/conversation:\/\/\S+/g) ?? [];
    expect(new Set(uris).size).toBe(2);
  });

  it("recent_activity lists ingested docs", async () => {
    await client.callTool({ name: "remember", arguments: { content: "fresh fact" } });
    const r = await client.callTool({ name: "recent_activity", arguments: { hours: 1 } });
    expect(text(r)).toMatch(/conversation:\/\//);
  });

  it("recent_activity enumerates an explicit window and flags a full page", async () => {
    for (const c of ["window fact one", "window fact two", "window fact three"]) {
      await client.callTool({ name: "remember", arguments: { content: c } });
    }
    // An explicit window around now, replayed forwards.
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const asc = await client.callTool({ name: "recent_activity",
      arguments: { time_from: from, time_to: to, order: "asc", sources: ["conversation"] } });
    expect(text(asc)).toMatch(/conversation:\/\//);

    // A page filled exactly to the limit must announce that more may remain,
    // rather than reading as complete coverage.
    const capped = await client.callTool({ name: "recent_activity",
      arguments: { time_from: from, time_to: to, limit: 1, sources: ["conversation"] } });
    expect(text(capped)).toMatch(/page full at 1.*offset: 1/s);

    // A window in the distant past is empty, not an error.
    const empty = await client.callTool({ name: "recent_activity",
      arguments: { time_from: "2001-01-01", time_to: "2001-01-02" } });
    expect(text(empty)).toMatch(/nothing ingested/);
  });

  // The failure this whole feature exists for: on 2026-08-05 a day replay found
  // 14 empty hours and reported them as silence, with no way to say whether the
  // machine was asleep or the agent was dead.
  it("recent_activity explains an empty window instead of just reporting silence", async () => {
    const r = await client.callTool({ name: "recent_activity",
      arguments: { time_from: "2026-01-01T00:00:00Z", time_to: "2026-01-01T06:00:00Z" } });
    const t = text(r);
    expect(t).toMatch(/nothing ingested/);
    expect(t).toMatch(/coverage: shyn was not observing for 6h00m/);
    expect(t).toMatch(/asleep, powered off, or daemon down/);
  });

  it("recent_activity stays quiet about coverage when the window was fully watched", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (let t = now - 3600; t <= now; t += 60) engineRef.beat(["screen"], t);
    await client.callTool({ name: "remember", arguments: { content: "watched-window fact" } });
    const r = await client.callTool({ name: "recent_activity", arguments: { hours: 1 } });
    const t = text(r);
    expect(t).toMatch(/conversation:\/\//);
    expect(t).not.toMatch(/coverage:/);
  });

  it("recent_activity distinguishes a dead agent from a sleeping machine", async () => {
    // Daemon up and beating the whole window, but the screen agent never
    // appears in those beats — the case a 0-byte capture.log could not report.
    await rpcCall(sock, "captureStats", { screen: { state: "idle" } });
    const now = Math.floor(Date.now() / 1000);
    for (let t = now - 1800; t <= now; t += 60) engineRef.beat([], t);
    const r = await client.callTool({ name: "recent_activity", arguments: { hours: 1 } });
    const t = text(r);
    expect(t).toMatch(/the screen agent was not reporting/);
    expect(t).toMatch(/nothing was captured then/);
  });

  it("recent_activity rejects an unparseable timestamp with guidance", async () => {
    const r = await client.callTool({ name: "recent_activity",
      arguments: { time_from: "last tuesday" } });
    expect(text(r)).toMatch(/invalid time_from.*ISO 8601/s);
  });

  it("memory_status reports counts", async () => {
    const r = await client.callTool({ name: "memory_status", arguments: {} });
    expect(text(r)).toMatch(/documents/);
  });

  it("memory_status renders the readers array as parseable JSON, not [object Object]", async () => {
    await rpcCall(sock, "sync", {}); // populate status.readers with a real per-reader result object
    const r = await client.callTool({ name: "memory_status", arguments: {} });
    const t = text(r);
    expect(t).not.toMatch(/\[object Object\]/);
    const readersLine = t.split("\n").find((l: string) => l.startsWith("readers:"));
    expect(readersLine).toBeDefined();
    const parsed = JSON.parse(readersLine!.slice("readers: ".length));
    expect(parsed).toEqual([{ name: "fake", ok: true, ingested: 0, deduped: 0, rejected: 0 }]);
  });

  it("memory_status returns a friendly message when the daemon socket is missing", async () => {
    const noDaemonMcp = buildMcpServer(join(dir, "no-such.sock"));
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    const client2 = new Client({ name: "test2", version: "0" });
    await Promise.all([noDaemonMcp.connect(st2), client2.connect(ct2)]);
    try {
      const r = await client2.callTool({ name: "memory_status", arguments: {} });
      expect(text(r)).toBe(
        "error: the shyn daemon is not running on this machine — install it with `shyn install` from the shyn repo, or start it manually");
    } finally {
      await client2.close();
    }
  });

  it("search_memory accepts date-only and offset ISO timestamps", async () => {
    await client.callTool({ name: "remember", arguments: { content: "timeline fact" } });
    const r1 = await client.callTool({ name: "search_memory",
      arguments: { query: "timeline", time_from: "2020-01-01" } });
    expect(text(r1)).toMatch(/timeline fact/);
    const r2 = await client.callTool({ name: "search_memory",
      arguments: { query: "timeline", time_from: "2020-01-01T00:00:00+05:30" } });
    expect(text(r2)).toMatch(/timeline fact/);
  });

  it("search_memory rejects garbage dates with a helpful text reply", async () => {
    const r = await client.callTool({ name: "search_memory",
      arguments: { query: "x", time_from: "next Tuesday-ish" } });
    expect(text(r)).toMatch(/invalid time_from/);
  });

  it("advertises its own package.json version to the MCP client, not a hardcoded literal", () => {
    expect(client.getServerVersion()?.version).toBe(mcpClientPkgVersion);
  });

  it("classifies refusals by code, never by message text", () => {
    // Discriminating both ways: a -32001 error with NO refusal keywords must
    // still route to refused, and a code-less error whose message contains
    // "confirm" must NOT — the old /confirm/i regex fails both halves.
    expect(classifyRpcError(Object.assign(new Error("no keyword here"), { code: -32001 })))
      .toBe("refused");
    expect(classifyRpcError(new Error("please confirm your request"))).toBe("error");
  });
});

describe("get_document", () => {
  it("returns the whole document, not a 400-char excerpt", async () => {
    const body = Array.from({ length: 300 }, (_, i) => `Me: line ${i}`).join("\n\n");
    engineRef.ingest({ source: "meeting", uri: "meeting://g/1", title: "Sync", ts: 1000, text: body });
    await engineRef.drain();
    const t = text(await client.callTool({ name: "get_document",
      arguments: { uri: "meeting://g/1" } }));
    expect(t).toContain("Me: line 0");
    expect(t).toContain("Me: line 299");        // the whole thing, not the head
    expect(t).toContain("source: meeting");
    expect(t).not.toContain("truncated");
  });

  it("truncates with an offset footer when longer than max_chars", async () => {
    engineRef.ingest({ source: "file", uri: "/long.md", title: "long", ts: 1000,
      text: "x".repeat(120) });
    await engineRef.drain();
    const t = text(await client.callTool({ name: "get_document",
      arguments: { uri: "/long.md", max_chars: 50 } }));
    expect(t).toContain("truncated, 70 characters remaining, call again with offset=50");
  });

  it("pages with offset", async () => {
    engineRef.ingest({ source: "file", uri: "/page.md", title: "page", ts: 1000,
      text: "ABCDEFGHIJ" });
    await engineRef.drain();
    const t = text(await client.callTool({ name: "get_document",
      arguments: { uri: "/page.md", offset: 5 } }));
    expect(t).toContain("FGHIJ");
    expect(t).not.toContain("ABCDE\n");
  });

  it("reports a miss without throwing", async () => {
    const t = text(await client.callTool({ name: "get_document", arguments: { uri: "gone" } }));
    expect(t).toBe('no document with uri "gone"');
  });

  it("requires uri or doc_id", async () => {
    const t = text(await client.callTool({ name: "get_document", arguments: {} }));
    expect(t).toContain("requires uri or doc_id");
  });

  it("surfaces an ambiguous uri as an error naming the sources", async () => {
    engineRef.ingest({ source: "file", uri: "dup", title: "f", ts: 1000, text: "file body" });
    engineRef.ingest({ source: "notes", uri: "dup", title: "n", ts: 1001, text: "note body" });
    await engineRef.drain();
    expect(text(await client.callTool({ name: "get_document", arguments: { uri: "dup" } })))
      .toMatch(/file, notes/);
    expect(text(await client.callTool({ name: "get_document",
      arguments: { uri: "dup", source: "notes" } }))).toContain("note body");
  });
});

describe("search_files", () => {
  let fsDir: string, fsSock: string;
  let fake: Server | undefined;
  let fakeConns: Set<Socket>;
  let fsReceived: any[];
  let extra: { client: Client; mcp: ReturnType<typeof buildMcpServer> }[];

  type FakeMode = "answer" | "hang" | "slam";
  const startFake = (onSearch: (req: any) => any = () => ({ ok: true, search: { hits: [], notice: null } }),
    mode: FakeMode = "answer") =>
    new Promise<void>((resolve) => {
      fake = createServer((c) => {
        fakeConns.add(c);
        c.on("close", () => fakeConns.delete(c));
        c.on("error", () => {});
        if (mode === "slam") { c.destroy(); return; }
        let buf = "";
        c.on("data", (d) => {
          buf += d.toString("utf8");
          const i = buf.indexOf("\n");
          if (i < 0) return;
          const req = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          fsReceived.push(req);
          if (mode === "hang") return;
          const r = req.op === "ping" ? { ok: true } : onSearch(req);
          c.write(JSON.stringify(r) + "\n");
        });
      });
      fake.listen(fsSock, resolve);
    });
  const stopFake = async () => {
    if (!fake) return;
    for (const c of fakeConns) c.destroy();
    await new Promise<void>((r) => fake!.close(() => r()));
    fake = undefined;
  };

  const connect = async (opts: { fileSearchSocket?: string; detectEveryMs?: number } = {}) => {
    const mcp = buildMcpServer(sock, { fileSearchSocket: fsSock, detectEveryMs: 25, ...opts });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "fs-test", version: "0" });
    const changes = { n: 0 };
    c.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changes.n++; });
    await Promise.all([mcp.connect(st), c.connect(ct)]);
    extra.push({ client: c, mcp });
    return { c, changes };
  };

  const until = async (cond: () => boolean | Promise<boolean>, ms = 2000) => {
    const deadline = Date.now() + ms;
    while (!(await cond())) {
      if (Date.now() > deadline) throw new Error("condition not met in time");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const listed = async (c: Client) =>
    (await c.listTools()).tools.some((t) => t.name === "search_files");

  beforeEach(() => {
    fsDir = mkdtempSync(join(tmpdir(), "shynfs-"));
    fsSock = join(fsDir, "f.sock");
    fakeConns = new Set();
    fsReceived = [];
    extra = [];
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const e of extra) await e.client.close();
    await stopFake();
    rmSync(fsDir, { recursive: true, force: true });
  });

  it("is absent when no socket exists", async () => {
    const { c, changes } = await connect();
    await pause(100);
    expect(await listed(c)).toBe(false);
    expect(changes.n).toBe(0);
    // The shared client (env default, nothing there) never lists it either.
    expect(await listed(client)).toBe(false);
  });

  it("is absent when the socket is present but dead", async () => {
    await startFake(undefined, "slam");
    const { c, changes } = await connect();
    await pause(100);
    expect(await listed(c)).toBe(false);
    expect(changes.n).toBe(0);
  });

  it("appears when the service starts and goes when it stops, one list_changed per flip", async () => {
    const { c, changes } = await connect();
    await pause(60);
    expect(await listed(c)).toBe(false);
    await startFake();
    await until(() => listed(c));
    await until(() => changes.n >= 1);
    await pause(100);            // several more detection rounds, no state change
    expect(changes.n).toBe(1);
    await stopFake();
    await until(async () => !(await listed(c)));
    await until(() => changes.n >= 2);
    await pause(100);
    expect(changes.n).toBe(2);
  });

  it("is listed straight away when the service already answers, with the thatone description", async () => {
    await startFake();
    const { c } = await connect();
    await until(() => listed(c));
    const t = (await c.listTools()).tools.find((x) => x.name === "search_files")!;
    expect(t.description).toBe(
      "Find files on the user's Mac by describing them: photos by what they show, PDFs and documents " +
      "by their text, recordings and videos by what is said or shown. Returns paths, the kind, the time " +
      "inside the file for recordings and videos, and a short snippet. Needs the thatone app (a separate " +
      "local file-search app) to be running.");
  });

  it("falls back to SHYN_FILE_SEARCH_SOCKET when no socket option is given", async () => {
    await startFake();
    const prev = process.env.SHYN_FILE_SEARCH_SOCKET;
    process.env.SHYN_FILE_SEARCH_SOCKET = fsSock;
    try {
      const { c } = await connect({ fileSearchSocket: undefined });
      await until(() => listed(c));
    } finally {
      process.env.SHYN_FILE_SEARCH_SOCKET = prev;
    }
  });

  it("a hanging ping does not delay search_memory", async () => {
    await startFake(undefined, "hang");
    const { c } = await connect();
    await until(() => fakeConns.size > 0);   // a ping is in flight and will not be answered
    const t0 = Date.now();
    const r = await c.callTool({ name: "search_memory", arguments: { query: "anything" } });
    expect(text(r)).toMatch(/mode: /);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("does not start a new ping while one is still in flight", async () => {
    await startFake(undefined, "hang");
    await connect({ detectEveryMs: 10 });
    await pause(200);
    expect(fsReceived.filter((r) => r.op === "ping").length).toBe(1);
  });

  it("formats path, Photos, recording, video and PDF hits, with the notice", async () => {
    await startFake(() => ({
      ok: true,
      search: {
        notice: "the index is still being built",
        hits: [
          { paths: ["/Users/example/notes/plan.md"], kind: "document", score: 0.9, modified: 1700000000,
            anchors: [{ modality: "text", anchor: '{"heading":"Goals"}', text: "Sam wants\n  the   plan\tdone" }] },
          { paths: ["photos:ABC-123/IMG_0042.HEIC"], kind: "image", score: 0.8, modified: 1700000000,
            anchors: [{ modality: "image", anchor: "{}", text: "a dog on a beach" }] },
          { paths: ["/Users/example/rec/standup.m4a"], kind: "audio", score: 0.7, modified: 1700000000,
            anchors: [{ modality: "audio", anchor: '{"t0":133.4,"t1":160}', text: "we ship on friday" }] },
          { paths: ["/Users/example/video/talk.mp4"], kind: "video", score: 0.6, modified: 1700000000,
            anchors: [
              { modality: "video", anchor: "not json", text: "" },
              { modality: "video", anchor: '{"t0":3725,"t1":3730}', text: "thanks for coming" },
            ] },
          { paths: ["/Users/example/docs/report.pdf"], kind: "pdf", score: 0.5, modified: 1700000000,
            anchors: [{ modality: "text", anchor: '{"page":3}', text: "see example.com for details" }] },
        ],
      },
    }));
    const { c } = await connect();
    await until(() => listed(c));
    const r = await c.callTool({ name: "search_files",
      arguments: { query: "  plan  ", kinds: ["document", "pdf"], folder: "/Users/example", limit: 5 } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe([
      "- plan.md (document) /Users/example/notes",
      "  path: /Users/example/notes/plan.md",
      "  Sam wants the plan done",
      "- IMG_0042.HEIC (image)",
      "  in: Apple Photos, IMG_0042.HEIC",
      "  a dog on a beach",
      "- standup.m4a (audio) /Users/example/rec",
      "  path: /Users/example/rec/standup.m4a",
      "  at: 02:13",
      "  we ship on friday",
      "- talk.mp4 (video) /Users/example/video",
      "  path: /Users/example/video/talk.mp4",
      "  at: 1:02:05",
      "  thanks for coming",
      "- report.pdf (pdf) /Users/example/docs",
      "  path: /Users/example/docs/report.pdf",
      "  page: 3",
      "  see example.com for details",
      "note: the index is still being built",
    ].join("\n"));
    expect(text(r)).not.toContain("photos:");
    // Only query, kinds, folder and limit go to the service; the query is trimmed.
    const req = fsReceived.find((x) => x.op === "search");
    expect(req.query).toEqual({ query: "plan", kinds: ["document", "pdf"], folder: "/Users/example",
      limit: 5 });
  });

  it("cuts the snippet at 300 characters and shortens the home folder to ~", async () => {
    await startFake(() => ({ ok: true, search: { notice: null, hits: [
      { paths: ["/Users/example/notes/long.txt"], kind: "text", score: 1, modified: 0,
        anchors: [{ modality: "text", anchor: "{", text: "word ".repeat(100) }] },
    ] } }));
    const { c } = await connect();
    await until(() => listed(c));
    const prevHome = process.env.HOME;
    process.env.HOME = "/Users/example";
    let t: string;
    try {
      t = text(await c.callTool({ name: "search_files", arguments: { query: "long" } }));
    } finally {
      process.env.HOME = prevHome;
    }
    const lines = t.split("\n");
    expect(lines[0]).toBe("- long.txt (text) ~/notes");
    expect(lines[1]).toBe("  path: /Users/example/notes/long.txt");
    expect(lines[2]).toBe("  " + "word ".repeat(100).slice(0, 300));
    expect(lines).toHaveLength(3);
  });

  it("says no files found for zero hits", async () => {
    await startFake();
    const { c } = await connect();
    await until(() => listed(c));
    expect(text(await c.callTool({ name: "search_files", arguments: { query: "nothing" } })))
      .toBe("no files found");
  });

  it("turns a service error into an error: reply", async () => {
    await startFake(() => ({ ok: false, error: "index is busy" }));
    const { c } = await connect();
    await until(() => listed(c));
    expect(text(await c.callTool({ name: "search_files", arguments: { query: "x" } })))
      .toBe("error: file search: index is busy");
  });

  it("rejects an empty query without asking the service", async () => {
    await startFake();
    const { c } = await connect();
    await until(() => listed(c));
    expect(text(await c.callTool({ name: "search_files", arguments: { query: "   " } })))
      .toBe("error: query is empty");
    expect(fsReceived.some((x) => x.op === "search")).toBe(false);
  });

  it("rejects invalid arguments through the schema", async () => {
    await startFake();
    const { c } = await connect();
    await until(() => listed(c));
    for (const args of [{ query: "x", limit: 50 }, { query: "x", limit: 0 }, { query: "x", kinds: ["spreadsheet"] },
      { query: 3 }, {}]) {
      const r = await c.callTool({ name: "search_files", arguments: args as any });
      expect(r.isError).toBe(true);
    }
    expect(fsReceived.some((x) => x.op === "search")).toBe(false);
  });

  it("a call to the disabled tool is refused by the SDK", async () => {
    const { c } = await connect();
    await pause(60);
    // The SDK's own refusal for a registered-but-disabled tool. Before the tool
    // existed this said "not found", so the text pins the disabled state.
    const r: any = await c.callTool({ name: "search_files", arguments: { query: "x" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Tool search_files disabled");
  });

  const oneShot = async (hits: any[]) => {
    await startFake(() => ({ ok: true, search: { notice: null, hits } }));
    const { c } = await connect();
    await until(() => listed(c));
    return text(await c.callTool({ name: "search_files", arguments: { query: "x" } }));
  };
  const h = (paths: string[], anchors: any[] = [], kind = "image") =>
    ({ paths, kind, score: 1, modified: 0, anchors });

  it("shows a Photos name after the LAST slash and never any part of the id", async () => {
    const id = "9F3C1A2B-0000-4000-8000-123456789ABC";
    const t = await oneShot([h([`photos:${id}/L0/001/IMG 8481.HEIC`],
      [{ modality: "image", anchor: "{}", text: "a red kite" }])]);
    expect(t).toBe([
      "- IMG 8481.HEIC (image)",
      "  in: Apple Photos, IMG 8481.HEIC",
      "  a red kite",
    ].join("\n"));
    expect(t).not.toContain("L0/001");
    expect(t).not.toContain("9F3C");
    expect(t).not.toContain("photos:");
  });

  it("shows just Apple Photos for a photos: path with no slash", async () => {
    const t = await oneShot([h(["photos:9F3C1A2B-0000-4000-8000-123456789ABC"])]);
    expect(t).toBe("- Apple Photos (image)\n  in: Apple Photos");
    expect(t).not.toContain("9F3C");
  });

  it("skips a hit with no paths", async () => {
    const t = await oneShot([h([]), h(["/Users/example/pics/a.png"])]);
    expect(t).toBe("- a.png (image) /Users/example/pics\n  path: /Users/example/pics/a.png");
  });

  it("cuts the snippet on a code point, not inside an emoji", async () => {
    const t = await oneShot([h(["/Users/example/a.txt"],
      [{ modality: "text", anchor: "{}", text: "a".repeat(299) + "\u{1F600}" + "tail" }], "text")]);
    const snippet = t.split("\n")[2];
    expect(snippet).toBe("  " + "a".repeat(299) + "\u{1F600}");
    expect(snippet).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("shows page only when it is a positive integer", async () => {
    const pageHit = (page: number) => h([`/Users/example/p${page}.pdf`],
      [{ modality: "text", anchor: JSON.stringify({ page }), text: "" }], "pdf");
    const t = await oneShot([pageHit(0), pageHit(-1), pageHit(2.5), pageHit(3)]);
    expect(t.match(/page: /g)).toHaveLength(1);
    expect(t).toContain("  page: 3");
  });

  it("a call that reaches the handler after the service stopped says it is not available", async () => {
    await startFake();
    const { c, changes } = await connect({ detectEveryMs: 60_000 });
    await until(() => listed(c));
    await stopFake();
    expect(text(await c.callTool({ name: "search_files", arguments: { query: "x" } })))
      .toBe("error: file search is not available (is thatone running?)");
    // The handler's discovery also takes the tool out of the list.
    await until(() => changes.n >= 2);
    expect(await listed(c)).toBe(false);
  });

  it("uses an unref'd timer and stops pinging once the transport closes", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    await startFake();
    const { c } = await connect();
    const timer = spy.mock.results.at(-1)!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    await until(() => fsReceived.filter((r) => r.op === "ping").length >= 3);
    await c.close();
    await pause(30);               // let an in-flight ping finish
    const after = fsReceived.length;
    await pause(150);              // six intervals' worth
    expect(fsReceived.length).toBe(after);
  });

  describe("folder normalisation", () => {
    const withHome = async (home: string, fn: () => Promise<void>) => {
      const prev = process.env.HOME;
      process.env.HOME = home;
      try { await fn(); } finally { process.env.HOME = prev; }
    };
    const run = async (...folders: string[]) => {
      await startFake();
      const { c } = await connect();
      await until(() => listed(c));
      let last = "";
      for (const folder of folders)
        last = text(await c.callTool({ name: "search_files", arguments: { query: "x", folder } }));
      return last;
    };
    const sent = () => fsReceived.filter((r) => r.op === "search");

    it("expands ~/x with the home directory", async () => {
      await withHome("/Users/example", async () => {
        await run("~/x");
        expect(sent()[0].query.folder).toBe("/Users/example/x");
      });
    });

    it("expands ~ alone and trims surrounding whitespace", async () => {
      await withHome("/Users/example", async () => {
        await run("  ~  ");
        expect(sent()[0].query.folder).toBe("/Users/example");
      });
    });

    it("refuses a relative folder without contacting the service", async () => {
      expect(await run("Documents")).toBe("error: folder must be an absolute path (or start with ~)");
      expect(fsReceived.some((r) => r.op === "search")).toBe(false);
    });

    it("treats an empty or blank folder as not given", async () => {
      await run("", "   ");
      expect(sent()).toHaveLength(2);
      for (const r of sent()) expect("folder" in r.query).toBe(false);
    });

    it("resolves a symlinked folder to its real path", async () => {
      const real = join(fsDir, "real");
      mkdirSync(real);
      symlinkSync(real, join(fsDir, "link"));
      await run(join(fsDir, "link"));
      expect(sent()[0].query.folder).toBe(realpathSync(real));
    });

    it("passes a nonexistent absolute folder through unchanged", async () => {
      await run("/Users/example/does/not/exist");
      expect(sent()[0].query.folder).toBe("/Users/example/does/not/exist");
    });
  });

  it("shows a Photos hit with an empty name as plain Apple Photos, with no id", async () => {
    const t = await oneShot([h(["photos:9F3C1A2B-0000-4000-8000-123456789ABC/"]), h(["photos:"])]);
    expect(t).toBe([
      "- Apple Photos (image)", "  in: Apple Photos",
      "- Apple Photos (image)", "  in: Apple Photos",
    ].join("\n"));
    expect(t).not.toContain("9F3C");
  });

  it("cannot be made to forge reply lines through a file name, notice or error", async () => {
    await startFake(() => ({ ok: true, search: { notice: "n\n  path: /evil " + "z".repeat(400), hits: [
      { paths: ["/Users/example/d\nir/a\n  path: /x"], kind: "text", score: 1, modified: 0,
        anchors: [{ modality: "text", anchor: "{}", text: "ok" }] },
    ] } }));
    const { c } = await connect();
    await until(() => listed(c));
    const t = text(await c.callTool({ name: "search_files", arguments: { query: "x" } }));
    const lines: string[] = t.split("\n");
    expect(lines.filter((l) => l.startsWith("  path:"))).toHaveLength(1);
    expect(lines[0]).toBe("- x (text) /Users/example/d ir/a path: ");
    expect(lines[1]).toBe("  path: /Users/example/d ir/a path: /x");
    const note = lines.find((l) => l.startsWith("note: "))!;
    expect(lines.at(-1)).toBe(note);
    expect(note.length).toBeLessThanOrEqual("note: ".length + 200);
    expect(note.startsWith("note: n path: /evil z")).toBe(true);
  });

  it("sanitises a service error message", async () => {
    await startFake(() => ({ ok: false, error: "bad\nerror: forged\u0000" }));
    const { c } = await connect();
    await until(() => listed(c));
    const t = text(await c.callTool({ name: "search_files", arguments: { query: "x" } }));
    expect(t).toBe("error: file search: bad error: forged");
    expect(t).not.toContain("\n");
  });

  it("takes the time chip, page and snippet from the same anchor", async () => {
    const t = await oneShot([h(["/Users/example/v.mp4"], [
      { modality: "video", anchor: '{"t0":600,"t1":601}', text: "" },
      { modality: "audio", anchor: '{"t0":30,"t1":31}', text: "said at half a minute" },
    ], "video")]);
    expect(t).toBe([
      "- v.mp4 (video) /Users/example",
      "  path: /Users/example/v.mp4",
      "  at: 00:30",
      "  said at half a minute",
    ].join("\n"));
  });

  it("falls back to the first anchor when none has text", async () => {
    const t = await oneShot([h(["/Users/example/v.mp4"], [
      { modality: "video", anchor: '{"t0":600}', text: "" },
      { modality: "video", anchor: '{"t0":700}', text: "  " },
    ], "video")]);
    expect(t.split("\n")).toEqual(["- v.mp4 (video) /Users/example", "  path: /Users/example/v.mp4", "  at: 10:00"]);
  });

  it("memory_status updates the tool list at once when the service came up", async () => {
    const { c } = await connect({ detectEveryMs: 60_000 });
    await pause(60);
    expect(await listed(c)).toBe(false);
    await startFake();
    const t = text(await c.callTool({ name: "memory_status", arguments: {} }));
    expect(t.split("\n").at(-1)).toBe("file search: ready (thatone)");
    await until(() => listed(c), 500);
  });

  it("fileSearchReady resolves after the first detection, so the first list has the tool", async () => {
    await startFake();
    const mcp = buildMcpServer(sock, { fileSearchSocket: fsSock, detectEveryMs: 60_000 });
    await mcp.fileSearchReady;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "fs-test", version: "0" });
    await Promise.all([mcp.connect(st), c.connect(ct)]);
    extra.push({ client: c, mcp });
    expect(await listed(c)).toBe(true);
  });

  it("fileSearchReady resolves (never rejects) when there is no service", async () => {
    const mcp = buildMcpServer(sock, { fileSearchSocket: join(fsDir, "none.sock"), detectEveryMs: 60_000 });
    await expect(mcp.fileSearchReady).resolves.toBeUndefined();
  });

  describe("memory_status file search line", () => {
    const status = async (c: Client) => text(await c.callTool({ name: "memory_status", arguments: {} }));

    it("no socket: the old text plus exactly one 'not installed' line", async () => {
      const s = await rpcCall(sock, "status", {});
      const fmt = (v: unknown) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));
      const oldText = Object.entries(s).map(([k, v]) => `${k}: ${fmt(v)}`).join("\n");
      const { c } = await connect({ detectEveryMs: 60_000 });
      expect(await status(c)).toBe(`${oldText}\nfile search: not installed (thatone)`);
    });

    it("socket answering ping: ready", async () => {
      await startFake();
      const { c } = await connect({ detectEveryMs: 60_000 });
      const t = await status(c);
      expect(t.split("\n").at(-1)).toBe("file search: ready (thatone)");
      expect(t).toMatch(/documents/);
    });

    it("socket present but not answering: not running, within the ping bound", async () => {
      await startFake(undefined, "slam");
      const { c } = await connect({ detectEveryMs: 60_000 });
      expect((await status(c)).split("\n").at(-1)).toBe("file search: not running (thatone)");
    });

    it("a hanging ping is bounded and never fails memory_status", async () => {
      await startFake(undefined, "hang");
      const { c } = await connect({ detectEveryMs: 60_000 });
      const t0 = Date.now();
      const t = await status(c);
      expect(Date.now() - t0).toBeLessThan(2500);
      expect(t.split("\n").at(-1)).toBe("file search: not running (thatone)");
      expect(t).toMatch(/documents/);
    });

    it("daemon down: the error reply is unchanged and has no file search line", async () => {
      await startFake();
      const mcp = buildMcpServer(join(dir, "no-such.sock"), { fileSearchSocket: fsSock, detectEveryMs: 60_000 });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "fs-test", version: "0" });
      await Promise.all([mcp.connect(st), c.connect(ct)]);
      extra.push({ client: c, mcp });
      expect(await status(c)).toBe(
        "error: the shyn daemon is not running on this machine — install it with `shyn install` from the shyn repo, or start it manually");
    });
  });
});
