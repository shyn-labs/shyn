import type Database from "better-sqlite3-multiple-ciphers";
import type { Embedder } from "./embedder.js";
import { keywordSearch } from "./search-keyword.js";
import type { Hit, SearchQuery, SearchResult } from "./types.js";

const RRF_K = 60, RECENCY_WEIGHT = 0.05, RECENCY_HALF_DAYS = 30, PER_DOC_CAP = 2;

function monthsBetween(fromSec: number, toSec: number): string[] {
  const out: string[] = [];
  const d = new Date(fromSec * 1000); d.setUTCDate(1);
  const end = new Date(toSec * 1000);
  while (d <= end) { out.push(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() + 1); }
  return out;
}

function vectorSearch(
  db: Database.Database, qvec: Int8Array, q: SearchQuery
): Hit[] {
  const k = (q.limit ?? 8) * 4;
  const conds: string[] = [];
  const params: unknown[] = [Buffer.from(qvec.buffer), k];
  if (q.timeFrom !== undefined && q.timeTo !== undefined) {
    const months = monthsBetween(q.timeFrom, q.timeTo);
    conds.push(`v.month IN (${months.map(() => "?").join(",")})`);
    params.splice(1, 0, ...months); // month params go inside the vec query
  }
  const inner = `
    SELECT v.chunk_id, v.distance FROM chunk_vectors v
    WHERE v.embedding MATCH vec_int8(?) ${conds.length ? "AND " + conds.join(" AND ") : ""} AND k = ?`;
  const outerConds: string[] = [];
  if (q.timeFrom !== undefined) { outerConds.push("c.ts >= ?"); params.push(q.timeFrom); }
  if (q.timeTo !== undefined) { outerConds.push("c.ts <= ?"); params.push(q.timeTo); }
  if (q.sources?.length) {
    outerConds.push(`d.source IN (${q.sources.map(() => "?").join(",")})`);
    params.push(...q.sources);
  }
  const rows = db.prepare(`
    SELECT d.id docId, c.id chunkId, d.source, d.uri, d.title, c.ts, c.text,
           1.0 - i.distance score
    FROM (${inner}) i
    JOIN chunks c ON c.id = i.chunk_id
    JOIN documents d ON d.id = c.doc_id
    ${outerConds.length ? "WHERE " + outerConds.join(" AND ") : ""}
    ORDER BY i.distance ASC`).all(...params);
  return rows as Hit[];
}

function fuse(lanes: Hit[][], nowSec: number, limit: number): Hit[] {
  const byChunk = new Map<number, { hit: Hit; rrf: number }>();
  for (const lane of lanes)
    lane.forEach((hit, rank) => {
      const cur = byChunk.get(hit.chunkId) ?? { hit, rrf: 0 };
      cur.rrf += 1 / (RRF_K + rank + 1);
      byChunk.set(hit.chunkId, cur);
    });
  const scored = [...byChunk.values()].map(({ hit, rrf }) => {
    const ageDays = Math.max(0, (nowSec - hit.ts) / 86400);
    return { ...hit, score: rrf + RECENCY_WEIGHT * Math.exp(-ageDays / RECENCY_HALF_DAYS) };
  }).sort((a, b) => b.score - a.score);
  const perDoc = new Map<number, number>();
  const out: Hit[] = [];
  for (const h of scored) {
    const n = perDoc.get(h.docId) ?? 0;
    if (n >= PER_DOC_CAP) continue;
    perDoc.set(h.docId, n + 1);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

export async function search(
  db: Database.Database, embedder: Embedder, q: SearchQuery,
  now = Date.now() / 1000,
): Promise<SearchResult> {
  const limit = q.limit ?? 8;
  const kw = keywordSearch(db, { ...q, limit: limit * 4 });
  let qvec: Int8Array | null = null;
  try { qvec = await embedder.embedQuery(q.query); } catch { /* degraded mode */ }
  if (!qvec) return { mode: "keyword-only", hits: fuse([kw], now, limit) };
  const vec = vectorSearch(db, qvec, q);
  return { mode: "hybrid", hits: fuse([kw, vec], now, limit) };
}
