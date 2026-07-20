import type Database from "better-sqlite3-multiple-ciphers";
import { EmbedBackendUnavailableError, ModelNotReadyError, type Embedder } from "./embedder.js";

export async function drainEmbedQueue(
  db: Database.Database, embedder: Embedder, batch = 32
): Promise<{ embedded: number; failed: number }> {
  let embedded = 0, failed = 0;

  // sqlite-vec quirks (Spike 1b): int8 blobs MUST be wrapped in vec_int8(),
  // and vec0 INTEGER PRIMARY KEY requires BigInt binding.
  //
  // The INSERT is gated on an EXISTS check against embed_queue and wrapped in
  // the same transaction as the state UPDATE. This closes a race with
  // forget(): forget's DELETE+VACUUM can complete while we're mid-await on
  // embedDoc() below (chunks/embed_queue rows cascade-deleted, but chunk_vectors
  // has no FK so nothing would otherwise remove a vector we then insert for a
  // row that no longer exists). If the EXISTS check fails, the chunk was
  // forgotten mid-embed: skip the state UPDATE too (the row is gone via
  // cascade anyway) and don't count it as embedded.
  const insertIfPending = db.prepare(`
    INSERT INTO chunk_vectors(chunk_id, month, embedding)
    SELECT ?, ?, vec_int8(?)
    WHERE EXISTS (SELECT 1 FROM embed_queue WHERE chunk_id = ? AND state = 'pending')
  `);
  const markDone = db.prepare("UPDATE embed_queue SET state='done' WHERE chunk_id=?");
  const commitEmbed = db.transaction((id: number, month: string, buf: Buffer): boolean => {
    const info = insertIfPending.run(BigInt(id), month, buf, BigInt(id));
    if (info.changes > 0) markDone.run(id);
    return info.changes > 0;
  });

  for (;;) {
    const rows = db.prepare(`
      SELECT q.chunk_id id, c.text, c.ts FROM embed_queue q
      JOIN chunks c ON c.id = q.chunk_id
      WHERE q.state='pending' ORDER BY q.chunk_id ASC LIMIT ?`).all(batch) as
      { id: number; text: string; ts: number }[];
    if (rows.length === 0) return { embedded, failed };
    for (const row of rows) {
      try {
        const vec = await embedder.embedDoc(row.text);
        const month = new Date(row.ts * 1000).toISOString().slice(0, 7);
        if (commitEmbed(row.id, month, Buffer.from(vec.buffer))) embedded++;
      } catch (err) {
        if (err instanceof ModelNotReadyError) return { embedded, failed }; // transient infra state; row is fine, just stop draining
        // Backend import poisoned for this process: no attempt is consumed
        // (rows stay pending) and the error propagates so the daemon can
        // restart itself — the only thing that clears node's module cache.
        if (err instanceof EmbedBackendUnavailableError) throw err;
        console.error(`embed failed (chunk ${row.id}):`, err);
        const r = db.prepare(
          `UPDATE embed_queue SET attempts = attempts + 1,
             state = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END
           WHERE chunk_id=? RETURNING state`).get(row.id) as { state: string };
        if (r.state === "failed") failed++;
        else return { embedded, failed }; // back off; caller retries later
      }
    }
  }
}
