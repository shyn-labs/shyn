// Plan C Task 6: integration test for the actual `.mcpb` bundle output —
// not the in-process buildMcpServer() unit tests in tools.test.ts, but the
// real bundled extension/server/index.mjs file, spawned as a subprocess and
// driven over stdio exactly as Claude Desktop would, against a real daemon
// (not a fake/stub Engine) on a temp SHYN_HOME. Building takes a few seconds
// (esbuild bundling packages/mcp-client/src/main.ts) — acceptable for one
// integration test, and it's what actually proves the shipped artifact
// works, as opposed to just the source it was built from.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Engine, StaticKeyProvider, Embedder, EMBEDDING_DIM, type EmbedBackend } from "@shyn/engine";
import { startServer } from "@shyn/daemon";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "../../../..");
const SERVER_ENTRY = join(REPO_ROOT, "extension/server/index.mjs");

let dir: string;
let daemon: { close(): Promise<void> };
let client: Client;
let transport: StdioClientTransport;

beforeAll(() => {
  // Build the real .mcpb server bundle once for this file's tests.
  execFileSync("node", ["scripts/build-mcpb.mjs"], { cwd: REPO_ROOT, stdio: "inherit" });
}, 60_000);

afterEach(async () => {
  await client?.close();
  await daemon?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("mcpb bundle (real subprocess, real daemon)", () => {
  it("spawned extension/server/index.mjs talks MCP over stdio to a real daemon", async () => {
    dir = mkdtempSync(join(tmpdir(), "shyn-mcpb-"));
    const embedder = new Embedder(async () => (<EmbedBackend>{
      embed: async () => { const v = new Float32Array(EMBEDDING_DIM); v[0] = 1; return v; },
      dispose: async () => {},
    }));
    const engine = new Engine({
      dbPath: join(dir, "e.db"), keyProvider: new StaticKeyProvider(null), embedder,
    });
    daemon = await startServer({
      socketPath: join(dir, "shyn.sock"), engine, version: "t",
    });

    // SHYN_HOME drives both the daemon's socket path above and — inside the
    // spawned bundle — shynHome()'s own socket path computation (main.ts:
    // join(shynHome(), "shyn.sock")), so both sides agree on the same socket
    // without the test needing to know the bundle's internals.
    transport = new StdioClientTransport({
      command: "node",
      args: [SERVER_ENTRY],
      env: { ...process.env, SHYN_HOME: dir },
    });
    client = new Client({ name: "bundle-test", version: "0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["forget", "get_document", "memory_status", "recent_activity", "remember", "search_memory"]);

    await client.callTool({ name: "remember",
      arguments: { content: "Sam ships the shyn mcpb bundle" } });
    const r = await client.callTool({ name: "search_memory",
      arguments: { query: "mcpb bundle" } });
    const text = (r.content as Array<{ type: string; text: string }>)
      .map((c) => c.text).join("\n");
    expect(text).toMatch(/mode: (hybrid|keyword-only)/);
    expect(text).toMatch(/mcpb bundle/);
  }, 30_000);
});
