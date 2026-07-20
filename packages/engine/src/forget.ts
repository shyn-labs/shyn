import type Database from "better-sqlite3-multiple-ciphers";

export type ForgetSelector = {
  docId?: number; source?: string; timeFrom?: number; timeTo?: number;
};

export function forget(db: Database.Database, sel: ForgetSelector): { documents: number } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (sel.docId !== undefined) { conds.push("id = ?"); params.push(sel.docId); }
  if (sel.source !== undefined) { conds.push("source = ?"); params.push(sel.source); }
  if (sel.timeFrom !== undefined) { conds.push("ts >= ?"); params.push(sel.timeFrom); }
  if (sel.timeTo !== undefined) { conds.push("ts <= ?"); params.push(sel.timeTo); }
  if (conds.length === 0) throw new Error("forget requires at least one selector");
  const where = conds.join(" AND ");

  const del = db.transaction(() => {
    db.prepare(`
      DELETE FROM chunk_vectors WHERE chunk_id IN
        (SELECT c.id FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE ${where.replace(/\b(id|source|ts)\b/g, "d.$1")})
    `).run(...params);
    const { changes } = db.prepare(`DELETE FROM documents WHERE ${where}`).run(...params);
    // Belt-and-braces: catch any chunk_vectors rows left orphaned by a race
    // with an in-flight embed-worker drain (see embed-worker.ts's
    // EXISTS-guarded insert for the primary fix). vec0 has no FK to chunks,
    // so nothing else would ever clean these up.
    db.prepare(`DELETE FROM chunk_vectors WHERE chunk_id NOT IN (SELECT id FROM chunks)`).run();
    return changes;
  });
  const documents = del();
  db.exec("VACUUM");
  db.pragma("wal_checkpoint(TRUNCATE)");
  return { documents };
}
