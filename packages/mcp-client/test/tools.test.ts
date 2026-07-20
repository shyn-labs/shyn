import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Engine, StaticKeyProvider, Embedder, EMBEDDING_DIM, type EmbedBackend } from "@shyn/engine";
import { startServer } from "@shyn/daemon";
import { rpcCall } from "@shyn/daemon/rpc";
import { buildMcpServer, classifyRpcError } from "../src/tools.js";

const mcpClientPkgVersion: string = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"),
).version;

let dir: string, daemon: { close(): Promise<void> }, client: Client, sock: string;

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
  it("exposes exactly the 5 spec tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["forget", "memory_status", "recent_activity", "remember", "search_memory"]);
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
    expect(parsed).toEqual([{ name: "fake", ok: true, ingested: 0, deduped: 0 }]);
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
