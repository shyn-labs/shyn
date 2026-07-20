import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { rpcCall, isDaemonDownError } from "@shyn/daemon/rpc";
// Static JSON import so scripts/build-mcpb.mjs's esbuild bundle inlines the
// version as a literal at build time — see packages/daemon/src/main.ts for
// why a createRequire(import.meta.url) runtime read would break once bundled
// into extension/server/index.mjs (wrong directory relative to package.json).
import pkg from "../package.json" with { type: "json" };

const DAEMON_DOWN_MESSAGE =
  "the shyn daemon is not running on this machine — install it with `shyn install` from the shyn repo, or start it manually";

// Refusals are routed by the daemon's JSON-RPC error CODE, never by message
// text: -32001 is the daemon's "refused" code (see daemon server.ts). A
// message that merely mentions "confirm" must still classify as a plain error.
export const classifyRpcError = (e: unknown): "refused" | "error" =>
  (e as any)?.code === -32001 ? "refused" : "error";

const fmtHit = (h: any) =>
  `- [${new Date(h.ts * 1000).toISOString()}] ${h.title || h.uri}\n` +
  `  source: ${h.source} | uri: ${h.uri} | doc: ${h.docId}\n` +
  `  ${h.text.slice(0, 400)}`;

export function buildMcpServer(socketPath: string): McpServer {
  const server = new McpServer({ name: "shyn", version: pkg.version });
  // Rewrites a dead-socket/missing-daemon connection error into a friendly,
  // consistent message before it hits any handler's `error: ${e.message}` reply
  // — callers should never see a raw ECONNREFUSED/ENOENT.
  const call = async (method: string, params: unknown) => {
    try {
      return await rpcCall(socketPath, method, params);
    } catch (e: any) {
      throw isDaemonDownError(e) ? new Error(DAEMON_DOWN_MESSAGE) : e;
    }
  };
  const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

  const parseWhen = (s: string | undefined, field: string): number | undefined => {
    if (s === undefined) return undefined;
    const ms = Date.parse(s);
    if (Number.isNaN(ms))
      throw new Error(`invalid ${field}: "${s}" — use ISO 8601 (e.g. 2026-07-01 or 2026-07-01T10:00:00+05:30)`);
    return ms / 1000;
  };

  server.registerTool("search_memory", {
    description:
      "Search the user's local memory (files, notes, saved facts) with hybrid keyword+semantic retrieval. " +
      "The workhorse tool. For vague questions, call recent_activity first to orient, then search with a sharpened query. " +
      "Resolve relative dates ('last Tuesday') into ISO timestamps yourself via time_from/time_to " +
      "(ISO 8601 date or datetime, offsets allowed).",
    inputSchema: {
      query: z.string(),
      time_from: z.string().describe("ISO 8601 date or datetime, offsets allowed").optional(),
      time_to: z.string().describe("ISO 8601 date or datetime, offsets allowed").optional(),
      sources: z.array(z.enum(["file", "browser", "notes", "conversation", "screen", "meeting"])).optional(),
      limit: z.number().int().min(1).max(25).optional(),
    },
  }, async (a) => {
    try {
      const timeFrom = parseWhen(a.time_from, "time_from");
      const timeTo = parseWhen(a.time_to, "time_to");
      const r = await call("search", {
        query: a.query, limit: a.limit, sources: a.sources,
        timeFrom, timeTo,
      });
      return reply(`mode: ${r.mode}\n` +
        (r.hits.length ? r.hits.map(fmtHit).join("\n") : "no results"));
    } catch (e: any) {
      return reply(`error: ${e.message}`);
    }
  });

  server.registerTool("recent_activity", {
    description:
      "List documents recently added to memory. Call this FIRST for vague or broad questions " +
      "('what was I working on') to orient, then drill in with search_memory.",
    inputSchema: {
      hours: z.number().int().min(1).max(720).optional(),
      sources: z.array(z.enum(["file", "browser", "notes", "conversation", "screen", "meeting"])).optional(),
    },
  }, async (a) => {
    try {
      const docs = await call("recent", { hours: a.hours, sources: a.sources });
      return reply(docs.length
        ? docs.map((d: any) =>
            `- [${new Date(d.ts * 1000).toISOString()}] ${d.title || d.uri} (${d.source}) ${d.uri}`
          ).join("\n")
        : "nothing ingested in that window");
    } catch (e: any) {
      return reply(`error: ${e.message}`);
    }
  });

  server.registerTool("remember", {
    description: "Save an explicit fact or note to the user's local memory for future recall.",
    inputSchema: { content: z.string(), tags: z.array(z.string()).optional() },
  }, async (a) => {
    try {
      const ts = Math.floor(Date.now() / 1000);
      // Content-hash-derived uri (deviation from the plan's timestamp+random
      // sketch, decided at final review): identical remembers now hash to the
      // same uri, so the engine's content-hash dedup fires and "already
      // remembered" becomes reachable instead of flooding search results with
      // duplicates of the same fact.
      const contentHash = createHash("sha256").update(a.content).digest("hex").slice(0, 16);
      const r = await call("ingest", {
        source: "conversation", uri: `conversation://${contentHash}`,
        title: a.content.slice(0, 60), ts, text: a.content, meta: { tags: a.tags ?? [] },
      });
      return reply(r.deduped ? "already remembered" : "remembered");
    } catch (e: any) {
      return reply(`error: ${e.message}`);
    }
  });

  server.registerTool("forget", {
    description:
      "Permanently delete documents from memory (purged from disk, not soft-deleted). " +
      "Requires confirm: true — always ask the user before confirming. " +
      "time_from/time_to accept ISO 8601 date or datetime, offsets allowed.",
    inputSchema: {
      doc_id: z.number().int().optional(),
      source: z.enum(["file", "browser", "notes", "conversation", "screen", "meeting"]).optional(),
      time_from: z.string().describe("ISO 8601 date or datetime, offsets allowed").optional(),
      time_to: z.string().describe("ISO 8601 date or datetime, offsets allowed").optional(),
      confirm: z.boolean(),
    },
  }, async (a) => {
    try {
      const timeFrom = parseWhen(a.time_from, "time_from");
      const timeTo = parseWhen(a.time_to, "time_to");
      const r = await call("forget", {
        docId: a.doc_id, source: a.source, confirm: a.confirm,
        timeFrom, timeTo,
      });
      return reply(`forgotten: ${r.documents} document(s), purged from disk`);
    } catch (e: any) {
      // Note: call()'s daemon-down rewrite already replaces the raw socket
      // error with DAEMON_DOWN_MESSAGE (no .code), so it falls through to the
      // generic `error: ...` branch below correctly.
      return reply(`${classifyRpcError(e)}: ${e.message}`);
    }
  });

  server.registerTool("memory_status", {
    description:
      "Daemon health: document/vector counts, pending embeddings, model download progress. " +
      "modelLoaded=false with modelDownloaded=true just means the model is idle-unloaded; " +
      "it loads on demand.",
    inputSchema: {},
  }, async () => {
    try {
      const s = await call("status", {});
      // Object.entries + template-literal interpolation stringifies non-scalars
      // via their default toString (arrays/objects become "[object Object]");
      // JSON.stringify keeps them readable and machine-parseable.
      const fmt = (v: unknown) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));
      return reply(Object.entries(s).map(([k, v]) => `${k}: ${fmt(v)}`).join("\n"));
    } catch (e: any) {
      return reply(`error: ${e.message}`);
    }
  });

  return server;
}
