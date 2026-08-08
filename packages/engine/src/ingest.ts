import { createHash } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { chunkFor } from "./chunk.js";
import { isPlumbingUri, canonicalUri, stripScreenFurniture, metaHeader } from "./hygiene.js";
import type { IngestDoc } from "./types.js";

export function ingestDocument(
  db: Database.Database, doc: IngestDoc,
  opts?: { skipHygiene?: boolean }
): { docId: number; chunks: number; deduped: boolean; rejected?: string } {
  // Hygiene runs BEFORE the identity hash and the (source, uri) lookup, so a
  // canonicalised URL replaces its twin instead of sitting beside it, and
  // stripped text does not change the dedup hash on every capture.
  // Measured against the real corpus — see hygiene.ts for the numbers and for
  // the rule that was rejected because it would have destroyed 4,992 emails.
  // Hygiene is a policy for LIVE CAPTURE, not for a restore. Applying today's
  // rules to an archive rewrites history: a live export/restore of the real
  // corpus lost 3,449 documents (34,593 exported, 31,144 restored) because
  // rules written after those documents were captured rejected and merged them
  // on the way back in. A backup that does not return what you backed up is not
  // a backup, so importArchive passes skipHygiene.
  if (!opts?.skipHygiene) {
  if (isPlumbingUri(doc.uri)) {
    // Reported, not silent: a rejection the caller cannot see is how a filter
    // quietly eats real data for weeks without anyone noticing.
    return { docId: 0, chunks: 0, deduped: false, rejected: "auth/redirect plumbing" };
  }
  doc = { ...doc, uri: canonicalUri(doc.uri) };
  if (doc.source === "screen") doc = { ...doc, text: stripScreenFurniture(doc.text) };
  const header = metaHeader(doc.meta as Record<string, unknown> | undefined);
  // Idempotent on purpose: an archive restore re-ingests text that ALREADY
  // carries the header, and prepending a second copy corrupts the document.
  // True of any repeated ingest of previously-hygiened text, not just imports.
  if (header && !doc.text.startsWith(header)) doc = { ...doc, text: `${header}\n\n${doc.text}` };
  }

  const hash = createHash("sha256")
    .update(doc.source).update("\0").update(doc.uri).update("\0").update(doc.text)
    .digest("hex");
  const existing = db.prepare(
    "SELECT id, ts, content_hash, meta_json FROM documents WHERE source=? AND uri=?"
  ).get(doc.source, doc.uri) as
    { id: number; ts: number; content_hash: string; meta_json: string } | undefined;

  if (existing && existing.content_hash === hash) {
    const newTags = doc.meta?.tags as string[] | undefined;
    if (doc.ts > existing.ts || newTags?.length) {
      db.transaction(() => {
        if (doc.ts > existing.ts) {
          db.prepare("UPDATE documents SET ts=? WHERE id=?").run(doc.ts, existing.id);
          db.prepare("UPDATE chunks SET ts=? WHERE doc_id=?").run(doc.ts, existing.id);
        }
        // Same content, possibly different tags (e.g. a repeated "remember"
        // with a new tag) — merge into the existing meta rather than
        // overwriting, so this UPDATE runs regardless of whether ts advanced.
        if (newTags?.length) {
          const meta = JSON.parse(existing.meta_json || "{}");
          const tags = [...new Set([...(meta.tags ?? []), ...newTags])];
          db.prepare("UPDATE documents SET meta_json=? WHERE id=?")
            .run(JSON.stringify({ ...meta, tags }), existing.id);
        }
      })();
    }
    return { docId: existing.id, chunks: 0, deduped: true };
  }

  const chunks = chunkFor(doc.source, doc.text);
  const insChunks = (docId: number) => {
    const insChunk = db.prepare("INSERT INTO chunks(doc_id, pos, text, ts) VALUES (?,?,?,?)");
    const insQueue = db.prepare("INSERT INTO embed_queue(chunk_id) VALUES (?)");
    chunks.forEach((text, pos) => {
      const { lastInsertRowid: cid } = insChunk.run(docId, pos, text, doc.ts);
      insQueue.run(Number(cid));
    });
  };

  if (existing) {
    // same (source,uri), new content → replace in place
    //
    // Guard: an older-ts replace is skipped entirely (stale row loses).
    // Chrome and Safari both emit source "browser" for history — without
    // this guard, differing title snapshots of the same URL (one browser's
    // sync running behind the other's) ping-pong replaces between readers
    // and regress the document's ts on every pass.
    if (doc.ts < existing.ts) {
      return { docId: existing.id, chunks: 0, deduped: true };
    }
    db.transaction(() => {
      db.prepare(
        "DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_id=?)"
      ).run(existing.id);
      db.prepare("DELETE FROM chunks WHERE doc_id=?").run(existing.id); // FTS trigger + queue cascade
      db.prepare(
        "UPDATE documents SET title=?, ts=?, content_hash=?, meta_json=? WHERE id=?"
      ).run(doc.title, doc.ts, hash, JSON.stringify(doc.meta ?? {}), existing.id);
      insChunks(existing.id);
    })();
    return { docId: existing.id, chunks: chunks.length, deduped: false };
  }

  const docId = db.transaction(() => {
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO documents(source, uri, title, ts, content_hash, meta_json)
       VALUES (?,?,?,?,?,?)`
    ).run(doc.source, doc.uri, doc.title, doc.ts, hash, JSON.stringify(doc.meta ?? {}));
    insChunks(Number(lastInsertRowid));
    return Number(lastInsertRowid);
  })();
  return { docId, chunks: chunks.length, deduped: false };
}
