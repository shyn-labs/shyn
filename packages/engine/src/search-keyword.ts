import type Database from "better-sqlite3-multiple-ciphers";
import type { Hit, SearchQuery } from "./types.js";

const sanitizeFts = (q: string): string =>
  q.replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ").trim().split(/\s+/)
   .filter(Boolean).map((t) => `"${t}"`).join(" ");

export function keywordSearch(db: Database.Database, q: SearchQuery): Hit[] {
  const match = sanitizeFts(q.query);
  if (!match) return [];
  const conds: string[] = [];
  const params: unknown[] = [match];
  if (q.timeFrom !== undefined) { conds.push("c.ts >= ?"); params.push(q.timeFrom); }
  if (q.timeTo !== undefined) { conds.push("c.ts <= ?"); params.push(q.timeTo); }
  if (q.sources?.length) {
    conds.push(`d.source IN (${q.sources.map(() => "?").join(",")})`);
    params.push(...q.sources);
  }
  params.push(q.limit ?? 8);
  const rows = db.prepare(`
    SELECT d.id docId, c.id chunkId, d.source, d.uri, d.title, c.ts, c.text,
           -bm25(chunks_fts) score
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    JOIN documents d ON d.id = c.doc_id
    WHERE chunks_fts MATCH ? ${conds.length ? "AND " + conds.join(" AND ") : ""}
    ORDER BY bm25(chunks_fts) LIMIT ?`).all(...params);
  return rows as Hit[];
}
