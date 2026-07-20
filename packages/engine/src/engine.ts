import type Database from "better-sqlite3-multiple-ciphers";
import { openDatabase } from "./storage.js";
import type { KeyProvider } from "./keys.js";
import type { Embedder } from "./embedder.js";
import { ingestDocument } from "./ingest.js";
import { search as runSearch } from "./search.js";
import { forget as runForget, type ForgetSelector } from "./forget.js";
import { sweepScreenRetention, sweepMeetingRetention } from "./retention.js";
import { drainEmbedQueue } from "./embed-worker.js";
import { getWatermark, setWatermark } from "./readers/watermark.js";
import type { Reader } from "./readers/types.js";
import type { IngestDoc, SearchQuery, SearchResult } from "./types.js";
import { getStats, type StatsResult } from "./stats.js";
import { bumpCounter, dayKey } from "./counters.js";

export type EngineStatus = {
  documents: number; chunks: number; vectors: number;
  pendingEmbeds: number; failedEmbeds: number;
  modelLoaded: boolean; schemaVersion: string;
};

export type SyncResult = {
  name: string; ok: boolean; reason?: string; ingested: number; deduped: number;
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

  recent(p: { hours?: number; sources?: string[] }) {
    const since = Math.floor(Date.now() / 1000) - (p.hours ?? 24) * 3600;
    const conds = ["ts >= ?"]; const params: unknown[] = [since];
    if (p.sources?.length) {
      conds.push(`source IN (${p.sources.map(() => "?").join(",")})`);
      params.push(...p.sources);
    }
    return this.db.prepare(
      `SELECT id docId, source, uri, title, ts FROM documents
       WHERE ${conds.join(" AND ")} ORDER BY ts DESC LIMIT 50`
    ).all(...params) as { docId: number; source: string; uri: string; title: string; ts: number }[];
  }

  async syncReaders(readers: Reader[]): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    for (const reader of readers) {
      try {
        const a = await reader.available();
        if (!a.ok) {
          results.push({ name: reader.name, ok: false, reason: a.reason, ingested: 0, deduped: 0 });
          continue;
        }
        const docs = await reader.read(getWatermark(this.db, reader.name));
        let ingested = 0, deduped = 0, maxTs = 0;
        for (const doc of docs) {
          const r = this.ingest(doc);
          if (r.deduped) deduped++; else ingested++;
          if (doc.ts > maxTs) maxTs = doc.ts;
        }
        if (docs.length > 0) setWatermark(this.db, reader.name, maxTs);
        results.push({ name: reader.name, ok: true, ...(a.reason ? { reason: a.reason } : {}), ingested, deduped });
      } catch (err: any) {
        results.push({ name: reader.name, ok: false,
          reason: err?.message ?? "reader failed", ingested: 0, deduped: 0 });
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
