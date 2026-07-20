import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, StaticKeyProvider, Embedder, EMBEDDING_DIM, type EmbedBackend } from "@shyn/engine";
import { startServer } from "@shyn/daemon";
import { runCli } from "../src/main.js";

let dir: string, server: { close(): Promise<void> }, out: string[];

const madeDocs: number[] = [];
const fakeReader = {
  name: "fake",
  available: async () => ({ ok: true }),
  read: async (since: number) => {
    if (madeDocs.length > 0) return [];
    madeDocs.push(1);
    const ts = Math.floor(Date.now() / 1000);
    return [{ source: "browser" as const, uri: "https://feed.example", title: "Reader fed document",
      ts, text: "Reader fed document\nhttps://feed.example" }];
  },
};

beforeEach(async () => {
  madeDocs.length = 0;
  dir = mkdtempSync(join(tmpdir(), "shyn-"));
  process.env.SHYN_HOME = dir;
  const embedder = new Embedder(async () => (<EmbedBackend>{
    embed: async () => { const v = new Float32Array(EMBEDDING_DIM); v[0] = 1; return v; },
    dispose: async () => {},
  }));
  const engine = new Engine({
    dbPath: join(dir, "shyn.db"), keyProvider: new StaticKeyProvider(null), embedder,
  });
  server = await startServer({
    socketPath: join(dir, "shyn.sock"), engine, version: "t",
    readers: [fakeReader], readerIntervalMs: 60_000,
  });
  out = [];
});
afterEach(async () => { await server.close(); });

const print = (s: string) => out.push(s);

describe("shyn cli", () => {
  it("ingests a directory of markdown and reports status", async () => {
    const docs = join(dir, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "a.md"), "# Carbon\n\ncarbon offtake pricing");
    writeFileSync(join(docs, "b.txt"), "biryani recipe");
    writeFileSync(join(docs, "c.pdf"), "ignored in plan A");
    await runCli(["ingest", docs], print);
    expect(out.join("\n")).toMatch(/a\.md.*ingested/);
    expect(out.join("\n")).toMatch(/b\.txt.*ingested/);
    expect(out.join("\n")).toMatch(/c\.pdf: skipped/);
    out = [];
    await runCli(["status"], print);
    expect(out.join("\n")).toMatch(/documents:\s*2/);
  });

  it("searches", async () => {
    const docs = join(dir, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "a.md"), "carbon offtake pricing");
    await runCli(["ingest", docs], print);
    out = [];
    await runCli(["search", "carbon"], print);
    expect(out.join("\n")).toMatch(/a\.md/);
  });

  it("forget rejects dangling flags loudly", async () => {
    await runCli(["forget", "--source", "--doc", "5"], print);
    expect(out.join("\n")).toMatch(/--source requires a value/);
  });

  it("forget rejects unknown flags", async () => {
    await runCli(["forget", "--nuke", "everything"], print);
    expect(out.join("\n")).toMatch(/unknown flag --nuke/);
  });

  it("forget requires a selector", async () => {
    await runCli(["forget"], print);
    expect(out.join("\n")).toMatch(/requires at least one selector/);
  });

  it("forget aborts without a TTY instead of hanging", async () => {
    await runCli(["forget", "--source", "file"], print);
    expect(out.join("\n")).toMatch(/interactive terminal/);
  });

  it("prints a friendly message when no daemon is running", async () => {
    const noDaemonDir = mkdtempSync(join(tmpdir(), "shyn-nodaemon-"));
    const prevHome = process.env.SHYN_HOME;
    process.env.SHYN_HOME = noDaemonDir;
    try {
      await runCli(["status"], print);
    } finally {
      process.env.SHYN_HOME = prevHome;
    }
    expect(out.join("\n")).toBe(
      "shyn daemon is not running — start it with: pnpm --filter @shyn/daemon start");
  });

  it("sync prints per-reader summaries", async () => {
    await runCli(["sync"], print);
    expect(out.join("\n")).toMatch(/fake: 1 ingested, 0 unchanged/);
  });

  it("status prints the readers array as parseable JSON, not [object Object]", async () => {
    await runCli(["sync"], print);
    out = [];
    await runCli(["status"], print);
    const readersLine = out.find((l) => l.startsWith("readers:"));
    expect(readersLine).toBeDefined();
    expect(readersLine).not.toMatch(/\[object Object\]/);
    const jsonPart = readersLine!.slice("readers: ".length);
    const parsed = JSON.parse(jsonPart);
    expect(parsed).toEqual([{ name: "fake", ok: true, ingested: 1, deduped: 0 }]);
  });

  it("install redirects to `shyn setup` under a payload install instead of installing", async () => {
    const prevPayload = process.env.SHYN_PAYLOAD;
    process.env.SHYN_PAYLOAD = "/tmp/fake-payload";
    try {
      await runCli(["install"], print);
    } finally {
      if (prevPayload === undefined) delete process.env.SHYN_PAYLOAD;
      else process.env.SHYN_PAYLOAD = prevPayload;
    }
    expect(out.join("\n")).toMatch(/install is for repo checkouts — run: shyn setup/);
  });

  it("stats prints the weekly numbers from the stats RPC", async () => {
    const docs = join(dir, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "a.md"), "carbon offtake pricing");
    await runCli(["ingest", docs], print);
    out = [];
    await runCli(["search", "carbon"], print);
    out = [];
    await runCli(["stats"], print);
    const text = out.join("\n");
    expect(text).toMatch(/last 7 days/);
    expect(text).toMatch(/pages read:\s*\d+/);
    expect(text).toMatch(/meetings:\s*\d+/);
    expect(text).toMatch(/searches:\s*\d+/);
    expect(text).toMatch(/index total:\s*\d+ docs/);
  });

  it("stats --days validates its argument", async () => {
    await runCli(["stats", "--days", "banana"], print);
    expect(out.join("\n")).toMatch(/--days requires a positive integer/);
  });
});
