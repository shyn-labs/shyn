import type Database from "better-sqlite3-multiple-ciphers";
import { openDatabase } from "./storage.js";
import type { KeyProvider } from "./keys.js";
import type { Embedder } from "./embedder.js";
import { ingestDocument } from "./ingest.js";
import { search as runSearch } from "./search.js";
import { forget as runForget, type ForgetSelector } from "./forget.js";
import { sweepScreenRetention, sweepMeetingRetention } from "./retention.js";
import { recordBeat, coverageReport, sweepCoverage } from "./coverage.js";
import { joinChunks, type DocumentResult } from "./document.js";
import { drainEmbedQueue } from "./embed-worker.js";
import { getWatermark, setWatermark } from "./readers/watermark.js";
import type { Reader } from "./readers/types.js";
import type { IngestDoc, SearchQuery, SearchResult } from "./types.js";

// Ceiling on a single recent() page. High enough that an hour of dense screen
// capture fits in one call, low enough that a runaway query cannot try to push
// the whole corpus through the JSON-RPC socket.
export const RECENT_MAX_LIMIT = 500;
import { getStats, type StatsResult } from "./stats.js";
import { bumpCounter, dayKey } from "./counters.js";

export type EngineStatus = {
  documents: number; chunks: number; vectors: number;
  pendingEmbeds: number; failedEmbeds: number;
  modelLoaded: boolean; schemaVersion: string;
};

export type SyncResult = {
  name: string; ok: boolean; reason?: string; ingested: number; deduped: number;
  /** Dropped by ingest hygiene (auth/redirect plumbing). Counted separately so
   *  "ingested" never claims credit for a document that was thrown away. */
  rejected: number;
};

export class Engine {
  private db: Database.Database;
  private embedder: Embedder;
  private draining: Promise<void> = Promise.resolve();

  constructor(opts: { dbPath: string; keyProvider: KeyProvider; embedder: Embedder }) {
    this.db = openDatabase({ dbPath: opts.dbPath, key: opts.keyProvider.getKey() });
    this.embedder = opts.embedder;
  }

  ingest(doc: IngestDoc) { return ingestDocument(this.db, doc); }
  search(q: SearchQuery): Promise<SearchResult> { return runSearch(this.db, this.embedder, q); }
  forget(sel: ForgetSelector) { return runForget(this.db, sel); }
  stats(p: { days?: number } = {}): StatsResult { return getStats(this.db, p); }
  // Give chunks that exhausted their attempts (e.g. during an embed-backend
  // outage) a fresh set on the next daemon boot.
  // Full-backfill support: zero a reader's watermark so its next sync
  // re-walks all history (user-invoked via `shyn sync --full`).
  resetReaderWatermark(name: string): void { setWatermark(this.db, name, 0); }
  retryFailedEmbeds(): number {
    return this.db.prepare("UPDATE embed_queue SET state='pending', attempts=0 WHERE state='failed'").run().changes;
  }
  countSearch(now?: number): void { bumpCounter(this.db, `search:${dayKey(now ?? Math.floor(Date.now() / 1000))}`); }
  sweepScreen(retentionDays: number) { return sweepScreenRetention(this.db, retentionDays); }
  sweepMeeting(retentionDays: number) { return sweepMeetingRetention(this.db, retentionDays); }
  sweepCoverage(retentionDays: number) { return sweepCoverage(this.db, retentionDays); }

  // Observation heartbeat + the gap report derived from it. See coverage.ts:
  // without this, an empty window is indistinguishable from an unwatched one.
  beat(agents: string[], now?: number): void {
    recordBeat(this.db, agents, now ?? Math.floor(Date.now() / 1000));
  }
  coverage(p: { timeFrom: number; timeTo: number; expectAgents?: string[]; now?: number }) {
    return coverageReport(this.db, p);
  }

  // Enumerate documents in a time window. `hours` is the lookback-from-now
  // shorthand; timeFrom/timeTo express an explicit past window, which is what
  // reconstructing a specific day needs. Without those, "what did I do between
  // 13:00 and 16:00 yesterday" can only be approximated by ranked search, and a
  // ranked sample is not an enumeration (live finding 2026-08-05: reconstructing
  // one day this way returned whatever the query happened to favour).
  //
  // Paging exists because the old hardcoded LIMIT 50 silently truncated: a busy
  // hour of screen capture exceeds it on its own, so a caller had no way to know
  // whether it had seen the window or just the top of it.
  recent(p: {
    hours?: number; sources?: string[];
    timeFrom?: number; timeTo?: number;
    limit?: number; offset?: number;
    order?: "asc" | "desc";
  }) {
    const conds: string[] = []; const params: unknown[] = [];
    // An explicit window wins; `hours` only applies when timeFrom is absent.
    if (p.timeFrom !== undefined) { conds.push("ts >= ?"); params.push(p.timeFrom); }
    else { conds.push("ts >= ?"); params.push(Math.floor(Date.now() / 1000) - (p.hours ?? 24) * 3600); }
    if (p.timeTo !== undefined) { conds.push("ts <= ?"); params.push(p.timeTo); }
    if (p.sources?.length) {
      conds.push(`source IN (${p.sources.map(() => "?").join(",")})`);
      params.push(...p.sources);
    }
    // Cap rather than trust the caller: an unbounded query on a screen-capture
    // corpus can return six figures of rows through a JSON-RPC socket.
    const limit = Math.min(Math.max(p.limit ?? 50, 1), RECENT_MAX_LIMIT);
    const offset = Math.max(p.offset ?? 0, 0);
    // Chronological ascending is the natural order for replaying a day; desc
    // stays the default so existing callers are unaffected.
    const dir = p.order === "asc" ? "ASC" : "DESC";
    return this.db.prepare(
      `SELECT id docId, source, uri, title, ts FROM documents
       WHERE ${conds.join(" AND ")} ORDER BY ts ${dir}, id ${dir} LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as
      { docId: number; source: string; uri: string; title: string; ts: number }[];
  }

  // Whole-document read. Chunks are the only place text lives (documents has
  // no text column), so the rows are reassembled with joinChunks.
  // (source, uri) is the unique pair — a bare uri can legitimately match two
  // sources, and silently picking one would hand back the wrong document.
  document(p: { docId?: number; uri?: string; source?: string }): DocumentResult | null {
    const cols = "SELECT id docId, source, uri, title, ts FROM documents";
    type Row = { docId: number; source: string; uri: string; title: string; ts: number };
    let row: Row | undefined;
    if (p.docId !== undefined) {
      row = this.db.prepare(`${cols} WHERE id = ?`).get(p.docId) as Row | undefined;
    } else if (p.uri !== undefined) {
      const rows = (p.source !== undefined
        ? this.db.prepare(`${cols} WHERE uri = ? AND source = ?`).all(p.uri, p.source)
        : this.db.prepare(`${cols} WHERE uri = ?`).all(p.uri)) as Row[];
      if (rows.length > 1) {
        const sources = rows.map((r) => r.source).sort().join(", ");
        throw new Error(
          `uri "${p.uri}" matches ${rows.length} documents across sources: ${sources} — pass source to disambiguate`);
      }
      row = rows[0];
    } else {
      throw new Error("document requires docId or uri");
    }
    if (!row) return null;
    const texts = this.db.prepare(
      "SELECT text FROM chunks WHERE doc_id = ? ORDER BY pos").all(row.docId) as { text: string }[];
    return { ...row, text: joinChunks(texts.map((t) => t.text)), chunkCount: texts.length };
  }

  async syncReaders(readers: Reader[]): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    for (const reader of readers) {
      try {
        const a = await reader.available();
        if (!a.ok) {
          results.push({ name: reader.name, ok: false, reason: a.reason, ingested: 0, deduped: 0, rejected: 0 });
          continue;
        }
        const docs = await reader.read(getWatermark(this.db, reader.name));
        let ingested = 0, deduped = 0, rejected = 0, maxTs = 0;
        for (const doc of docs) {
          const r = this.ingest(doc);
          if (r.rejected) rejected++; else if (r.deduped) deduped++; else ingested++;
          if (doc.ts > maxTs) maxTs = doc.ts;
        }
        if (docs.length > 0) setWatermark(this.db, reader.name, maxTs);
        results.push({ name: reader.name, ok: true, ...(a.reason ? { reason: a.reason } : {}), ingested, deduped, rejected });
      } catch (err: any) {
        results.push({ name: reader.name, ok: false,
          reason: err?.message ?? "reader failed", ingested: 0, deduped: 0, rejected: 0 });
      }
    }
    return results;
  }

  async drain() {
    const run = this.draining.then(async () => { await drainEmbedQueue(this.db, this.embedder); });
    this.draining = run.catch(() => {});
    return run;
  }

  status(): EngineStatus {
    const one = (sql: string) => (this.db.prepare(sql).get() as { c: number }).c;
    return {
      documents: one("SELECT count(*) c FROM documents"),
      chunks: one("SELECT count(*) c FROM chunks"),
      vectors: one("SELECT count(*) c FROM chunk_vectors"),
      pendingEmbeds: one("SELECT count(*) c FROM embed_queue WHERE state='pending'"),
      failedEmbeds: one("SELECT count(*) c FROM embed_queue WHERE state='failed'"),
      modelLoaded: this.embedder.isReady(),
      schemaVersion: (this.db.prepare("SELECT value FROM meta WHERE k='schema_version'")
        .get() as { value: string }).value,
    };
  }

  async close() {
    await this.draining.catch(() => {});
    await this.embedder.dispose();
    this.db.close();
  }
}
