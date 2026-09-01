import { describe, expect, test, vi } from "vitest";
import type { AnalyticsRecord } from "../src/analytics.js";
import {
  ANALYTICS_EVENTS, isKnownEvent, scrubProperties, AnalyticsQueue,
} from "../src/analytics.js";

// Anonymized usage analytics. This is the ONLY code path in shyn that sends
// anything off the machine, so the tests here are the privacy contract, not
// just correctness checks: what may leave, what must never leave, and the
// guarantee that "off" means off immediately.

describe("event names are a closed set", () => {
  test("known events pass, anything else is rejected", () => {
    expect(isKnownEvent("search_memory_called")).toBe(true);
    expect(isKnownEvent("meeting_capture_started")).toBe(true);
    // Freeform names are the leak vector: an event name built from user
    // content would carry that content off the machine. Only the enum ships.
    expect(isKnownEvent("search: how do I fix my marriage")).toBe(false);
    expect(isKnownEvent("")).toBe(false);
  });

  test("no event name in the enum looks like content", () => {
    // Guards against a future edit adding an interpolated name.
    for (const e of ANALYTICS_EVENTS) {
      expect(e).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("scrubbing", () => {
  test("redacts credentials that reach an error property", () => {
    const out = scrubProperties({
      message: "auth failed for sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(JSON.stringify(out)).not.toContain("sk-ant-api03");
    expect(JSON.stringify(out)).toContain("[redacted]");
  });

  test("redacts home-directory paths that carry the username", () => {
    const out = scrubProperties({
      stack: "at load (/Users/somebody/Documents/Claude/secret-project/x.ts:3)",
    });
    expect(JSON.stringify(out)).not.toContain("somebody");
    expect(JSON.stringify(out)).not.toContain("secret-project");
  });

  test("drops free text that is not an allowed shape", () => {
    // A property carrying a document title or query would be corpus content.
    const out = scrubProperties({ query: "quarterly revenue for Globex" });
    expect(JSON.stringify(out)).not.toContain("Globex");
  });

  test("keeps plain scalars that carry no content", () => {
    const out = scrubProperties({ count: 5, ok: true, source: "meeting" });
    expect(out).toEqual({ count: 5, ok: true, source: "meeting" });
  });
});

describe("queue and kill-switch", () => {
  const mkQueue = (
    enabled: boolean,
    send: (batch: AnalyticsRecord[]) => Promise<void> = async () => {},
  ) => {
    const spy = vi.fn(send);
    return { q: new AnalyticsQueue({ enabled, installId: "test-install", send: spy }), send: spy };
  };

  test("queues and flushes known events", async () => {
    const { q, send } = mkQueue(true);
    q.track("search_memory_called");
    q.track("meeting_capture_started");
    await q.flush();
    expect(send).toHaveBeenCalledTimes(1);
    const batch = send.mock.calls[0][0];
    expect(batch).toHaveLength(2);
    expect(batch[0].installId).toBe("test-install");
  });

  test("disabled means nothing is queued and nothing is sent", async () => {
    const { q, send } = mkQueue(false);
    q.track("search_memory_called");
    await q.flush();
    expect(send).not.toHaveBeenCalled();
    expect(q.pending()).toBe(0);
  });

  test("turning it off DISCARDS what was already queued", async () => {
    // The spec's atomicity promise: no in-flight batch sneaks out after a
    // toggle-off. A user who opts out must not have their last few minutes
    // shipped anyway.
    const { q, send } = mkQueue(true);
    q.track("search_memory_called");
    expect(q.pending()).toBe(1);
    q.setEnabled(false);
    expect(q.pending()).toBe(0);
    await q.flush();
    expect(send).not.toHaveBeenCalled();
  });

  test("unknown events are dropped rather than sent", async () => {
    const { q, send } = mkQueue(true);
    q.track("something_invented" as any);
    await q.flush();
    expect(send).not.toHaveBeenCalled();
  });

  test("a failed send does not lose the batch or throw", async () => {
    const send = vi.fn(async () => { throw new Error("network down"); });
    const q = new AnalyticsQueue({ enabled: true, installId: "i", send });
    q.track("search_memory_called");
    await expect(q.flush()).resolves.toBeUndefined();
    expect(q.pending()).toBe(1);   // retained for the next flush
  });

  test("the queue is bounded so an offline machine cannot grow it forever", async () => {
    const { q } = mkQueue(true);
    for (let i = 0; i < 5000; i++) q.track("search_memory_called");
    expect(q.pending()).toBeLessThanOrEqual(1000);
  });
});

// End-to-end through the real server: the unit tests above prove the queue,
// but not that the daemon's call sites actually reach it. A silently
// unwired tracker would pass every test above.
describe("call sites reach a real queue", () => {
  test("search/recent/document/forget emit, and carry no content", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Engine, StaticKeyProvider, Embedder, EMBEDDING_DIM } = await import("@shyn/engine");
    const { startServer } = await import("../src/server.js");
    const { rpcCall } = await import("../src/rpc.js");

    const dir = mkdtempSync(join(tmpdir(), "shyn-an-"));
    const sock = join(dir, "e.sock");
    const embedder = new Embedder(async () => ({
      embed: async () => { const v = new Float32Array(EMBEDDING_DIM); v[0] = 1; return v; },
      dispose: async () => {},
    }) as any);
    const engine = new Engine({
      dbPath: join(dir, "t.db"), keyProvider: new StaticKeyProvider(null), embedder,
    });
    const sent: any[] = [];
    const q = new AnalyticsQueue({
      enabled: true, installId: "e2e",
      send: async (b) => { sent.push(...b); },
    });
    const server = await startServer({
      socketPath: sock, engine, version: "test", analytics: q, readers: [],
    });
    try {
      await rpcCall(sock, "search", { query: "a private search phrase", limit: 1 });
      await rpcCall(sock, "recent", { hours: 1 });
      await rpcCall(sock, "forget", { confirm: true, source: "screen" });
      await q.flush();

      const names = sent.map((r) => r.event);
      expect(names).toContain("search_memory_called");
      expect(names).toContain("recent_activity_called");
      expect(names).toContain("forget_called");
      // The whole point: the query text must be nowhere in what would ship.
      expect(JSON.stringify(sent)).not.toContain("private search phrase");
    } finally {
      await server.close(); await engine.close();
    }
  });
});

// Found by auditing REAL crash payloads (2026-09-01), not imagined ones.
// The README, the first-run dialog and shyn.day all promise "no content, no
// file paths". These are the cases that promise did not survive.
describe("scrubbing holds against real error shapes", () => {
  test("JSON.parse errors must not carry the file's contents", () => {
    // Node embeds a snippet of the parsed text in the message. A user's
    // malformed note or config would otherwise ship its first characters.
    let msg = "";
    try { JSON.parse("SECRETXY not json at all"); }
    catch (e: any) { msg = e.message; }
    // Precondition: Node really does echo the text, truncated to ~10 chars.
    // The marker is kept short deliberately so it survives that truncation.
    expect(msg).toContain("SECRETXY");
    const out = scrubProperties({ message: msg });
    expect(JSON.stringify(out)).not.toContain("SECRETXY");
  });

  test("absolute paths outside the home directory are scrubbed too", () => {
    const out = scrubProperties({
      stack: "at read (/Volumes/BigDisk/ClientName/contract.md:1:1)\n"
           + "at load (/opt/private-notes/journal.md:2:2)",
    });
    const s = JSON.stringify(out);
    expect(s).not.toContain("ClientName");
    expect(s).not.toContain("contract");
    expect(s).not.toContain("private-notes");
    expect(s).not.toContain("journal");
  });

  test("a quoted document title in an error message does not survive", () => {
    const out = scrubProperties({
      message: 'failed to ingest "Q3 board deck — Globex acquisition.pdf"',
    });
    expect(JSON.stringify(out)).not.toContain("Globex");
    expect(JSON.stringify(out)).not.toContain("board deck");
  });

  test("the error SHAPE still survives, or this is useless for debugging", () => {
    const out = scrubProperties({
      message: "ENOENT: no such file or directory, open '/Users/sam/x.md'",
      stack: "Error: ENOENT\n    at readFileSync (node:fs:539:20)",
    });
    expect(String(out.message)).toContain("ENOENT");
    expect(String(out.stack)).toContain("readFileSync");
    expect(String(out.stack)).toContain("node:fs");   // node internals are not user data
  });
});

// Cross-language contract. The Swift agents call analytics.track with string
// literals; the daemon drops names it does not recognise, silently and by
// design (so a version-skewed agent cannot error). That silence is exactly
// what makes drift invisible: rename an event here, or typo one there, and
// the data just quietly stops arriving. This reads the Swift source and
// checks every literal it sends is a name this daemon knows.
describe("swift agents only emit events the daemon knows", () => {
  test("every client.track(...) literal is in ANALYTICS_EVENTS", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join: j } = await import("node:path");
    const root = j(import.meta.dirname, "../../capture-agent/Sources");

    const swiftFiles: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = j(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (e.endsWith(".swift")) swiftFiles.push(p);
      }
    };
    walk(root);

    const emitted = new Set<string>();
    for (const f of swiftFiles) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\.track\(\s*"([a-z0-9_]+)"/g)) emitted.add(m[1]);
    }

    // Guard the guard: if this finds nothing, the regex broke, not the code.
    expect(emitted.size).toBeGreaterThan(0);
    for (const e of emitted) {
      expect(ANALYTICS_EVENTS, `Swift emits "${e}" but the daemon does not know it`)
        .toContain(e as never);
    }
  });
});
