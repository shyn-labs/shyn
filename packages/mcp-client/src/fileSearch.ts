import { connect } from "node:net";
import { statSync } from "node:fs";

// Read-only client for an external file-search service's private query socket
// (newline-delimited JSON, protocol v1). It only ever writes the `search` and
// `ping` ops. Node built-ins only: this package is bundled to pure JS.

export const FILE_KINDS = ["image", "pdf", "document", "audio", "video", "text"] as const;

export type FileHit = {
  paths: string[];
  kind: string;
  score: number;
  modified: number;
  anchors: { modality: string; anchor: string; text: string }[];
};

export type FileSearchQuery = {
  query: string;
  kinds?: string[];
  folder?: string;
  limit?: number;
};

export type FileSearchOpts = { connectMs?: number; queryMs?: number; maxReplyBytes?: number };

const MAX_QUERY_CHARS = 2000;
const DEFAULT_LIMIT = 10;
const MAX_ERROR_CHARS = 200;

const fail = (reason: string) => new Error(`file search: ${reason}`);

export function createFileSearch(socketPath: string, opts: FileSearchOpts = {}) {
  const connectMs = opts.connectMs ?? 1000;
  const queryMs = opts.queryMs ?? 20000;
  const maxReplyBytes = opts.maxReplyBytes ?? 1024 * 1024;

  const socketPresent = (): boolean => {
    if (!socketPath) return false;
    try {
      return statSync(socketPath).isSocket();
    } catch {
      return false;
    }
  };

  // One connection, one request line, first reply line back. A single timer
  // bounds the whole call; every exit path clears it and destroys the socket.
  const exchange = (request: unknown, ms: number): Promise<any> =>
    new Promise((resolve, reject) => {
      if (!socketPresent()) return reject(fail("search service is not running (no socket)"));
      const sock = connect(socketPath);
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (err: Error | null, value?: any) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sock.destroy();
        err ? reject(err) : resolve(value);
      };
      const timer = setTimeout(() => finish(fail(`timed out after ${ms} ms`)), ms);
      sock.on("error", (e: any) => finish(fail(`connection failed (${e?.code ?? e?.message ?? "error"})`)));
      sock.on("close", () => finish(fail("connection closed before a reply")));
      sock.on("connect", () => sock.write(JSON.stringify(request) + "\n"));
      sock.on("data", (d: Buffer) => {
        size += d.length;
        if (size > maxReplyBytes) return finish(fail(`reply too large (over ${maxReplyBytes} bytes)`));
        chunks.push(d);
        const nl = d.indexOf(0x0a);
        if (nl < 0) return;
        const all = Buffer.concat(chunks);
        const end = all.indexOf(0x0a);
        let parsed: any;
        try {
          parsed = JSON.parse(all.subarray(0, end).toString("utf8"));
        } catch {
          return finish(fail("reply was not valid JSON"));
        }
        finish(null, parsed);
      });
    });

  const ping = async (): Promise<boolean> => {
    try {
      const r = await exchange({ v: 1, op: "ping" }, connectMs);
      return r?.ok === true;
    } catch {
      return false;
    }
  };

  const search = async (q: FileSearchQuery): Promise<{ hits: FileHit[]; notice?: string }> => {
    const query = String(q?.query ?? "").trim().slice(0, MAX_QUERY_CHARS);
    if (!query) throw fail("query is empty");
    const n = Math.floor(Number(q.limit ?? DEFAULT_LIMIT));
    const limit = Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : DEFAULT_LIMIT;
    const kinds = (q.kinds ?? []).filter((k) => (FILE_KINDS as readonly string[]).includes(k));
    const reply = await exchange(
      { v: 1, op: "search", query: { query, kinds, folder: q.folder ?? null, since: null, limit } },
      queryMs,
    );
    if (reply?.ok !== true) {
      throw fail(String(reply?.error ?? "service reported an error").slice(0, MAX_ERROR_CHARS));
    }
    const s = reply.search;
    if (!s || !Array.isArray(s.hits)) throw fail("reply had no search result");
    const hits: FileHit[] = s.hits.map((h: any) => ({
      paths: Array.isArray(h.paths) ? h.paths.map(String) : [],
      kind: String(h.kind ?? ""),
      score: Number(h.score ?? 0),
      modified: Number(h.modified ?? 0),
      anchors: (Array.isArray(h.anchors) ? h.anchors : []).map((a: any) => ({
        modality: String(a.modality ?? ""),
        anchor: String(a.anchor ?? ""),
        text: String(a.text ?? ""),
      })),
    }));
    return typeof s.notice === "string" && s.notice ? { hits, notice: s.notice } : { hits };
  };

  return { socketPresent, ping, search };
}
