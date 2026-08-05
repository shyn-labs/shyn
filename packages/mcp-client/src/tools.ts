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

  // Human-readable coverage footnote for a window. Returns "" when the window
  // was fully observed, when the daemon predates the coverage method, or on any
  // failure: this annotates an answer, it must never replace one.
  const fmtDuration = (s: number) =>
    s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, "0")}m`
      : `${Math.max(1, Math.round(s / 60))}m`;
  const coverageNote = async (from: number, to: number): Promise<string> => {
    if (!(to > from)) return "";
    try {
      const c = await call("coverage", { timeFrom: from, timeTo: to });
      const parts: string[] = [];
      if (c?.unobservedSeconds > 0) {
        const biggest = (c.gaps ?? []).reduce(
          (m: any, g: any) => (!m || g.seconds > m.seconds ? g : m), null);
        parts.push(
          `shyn was not observing for ${fmtDuration(c.unobservedSeconds)} of this window` +
          (biggest
            ? ` (largest gap ${new Date(biggest.from * 1000).toISOString()} → ` +
              `${new Date(biggest.to * 1000).toISOString()})`
            : "") +
          " — machine asleep, powered off, or daemon down");
      }
      for (const [agent, secs] of Object.entries(c?.agentDownSeconds ?? {})) {
        parts.push(`the ${agent} agent was not reporting for ${fmtDuration(secs as number)} ` +
          "while the daemon was up — nothing was captured then");
      }
      return parts.length ? `\n\ncoverage: ${parts.join("; ")}.` : "";
    } catch {
      return "";   // older daemon, or coverage unavailable: stay silent
    }
  };

  server.registerTool("recent_activity", {
    description:
      "Enumerate documents in a time window, in timestamp order. Call this FIRST for vague or broad " +
      "questions ('what was I working on') to orient, then drill in with search_memory. " +
      "Unlike search_memory this is NOT ranked by relevance — it returns everything in the window, " +
      "so it is the right tool for reconstructing a specific period ('what did I do between 13:00 " +
      "and 16:00 yesterday'). Use time_from/time_to for an explicit past window (ISO 8601, offsets " +
      "allowed) and order:'asc' to replay a day forwards; `hours` is a lookback-from-now shorthand. " +
      "Page with limit/offset — the reply says so when more rows remain.",
    inputSchema: {
      hours: z.number().int().min(1).max(720).optional(),
      sources: z.array(z.enum(["file", "browser", "notes", "conversation", "screen", "meeting"])).optional(),
      time_from: z.string().describe("ISO 8601 date or datetime, offsets allowed").optional(),
      time_to: z.string().describe("ISO 8601 date or datetime, offsets allowed").optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
      order: z.enum(["asc", "desc"]).describe("asc replays a window forwards; default desc").optional(),
    },
  }, async (a) => {
    try {
      const timeFrom = parseWhen(a.time_from, "time_from");
      const timeTo = parseWhen(a.time_to, "time_to");
      const limit = a.limit ?? 50;
      const docs = await call("recent", {
        hours: a.hours, sources: a.sources, timeFrom, timeTo,
        limit, offset: a.offset, order: a.order,
      });
      // Why a window is thin matters as much as what is in it: an empty hour
      // because you were asleep is a different fact from an empty hour you
      // worked through with a dead agent. Best-effort — an older daemon has no
      // coverage method, and a missing note must not fail the listing.
      const now = Math.floor(Date.now() / 1000);
      const from = timeFrom ?? now - (a.hours ?? 24) * 3600;
      const note = await coverageNote(from, Math.min(timeTo ?? now, now));
      if (!docs.length) return reply("nothing ingested in that window" + note);
      const lines = docs.map((d: any) =>
        `- [${new Date(d.ts * 1000).toISOString()}] ${d.title || d.uri} (${d.source}) ${d.uri}`
      ).join("\n");
      // Never let a page cap masquerade as "that was everything" — a silent
      // truncation reads as complete coverage when it is not.
      const more = docs.length === limit
        ? `\n(page full at ${limit}; more rows may remain — repeat with offset: ${(a.offset ?? 0) + limit})`
        : "";
      return reply(lines + more + note);
    } catch (e: any) {
      return reply(`error: ${e.message}`);
    }
  });

  server.registerTool("get_document", {
    description:
      "Read a whole document from memory by uri or doc_id — search_memory returns only matching " +
      "excerpts, so use this when you need the complete text (a full meeting transcript, a whole note). " +
      "Both uri and doc_id come from search_memory and recent_activity results. Long documents are " +
      "truncated with an offset footer; call again with that offset to page through the rest.",
    inputSchema: {
      uri: z.string().optional(),
      doc_id: z.number().int().optional(),
      source: z.enum(["file", "browser", "notes", "conversation", "screen", "meeting"])
        .describe("disambiguates a uri that exists under more than one source").optional(),
      offset: z.number().int().min(0).describe("character offset into the document").optional(),
      max_chars: z.number().int().min(1).max(200_000).optional(),
    },
  }, async (a) => {
    try {
      if (a.uri === undefined && a.doc_id === undefined)
        return reply("error: get_document requires uri or doc_id");
      const d = await call("document", { uri: a.uri, docId: a.doc_id, source: a.source });
      if (d === null)
        return reply(a.uri !== undefined
          ? `no document with uri "${a.uri}"`
          : `no document with doc_id ${a.doc_id}`);
      const offset = a.offset ?? 0;
      const max = a.max_chars ?? 50_000;
      const slice = d.text.slice(offset, offset + max);
      const rest = d.text.length - (offset + slice.length);
      const header =
        `[${new Date(d.ts * 1000).toISOString()}] ${d.title || d.uri}\n` +
        `source: ${d.source} | uri: ${d.uri} | doc: ${d.docId} | ${d.text.length} chars, ${d.chunkCount} chunks\n\n`;
      const footer = rest > 0
        ? `\n\n…truncated, ${rest} characters remaining, call again with offset=${offset + slice.length}`
        : "";
      return reply(header + slice + footer);
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
