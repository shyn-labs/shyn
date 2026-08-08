import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createGzip, createGunzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type Database from "better-sqlite3-multiple-ciphers";
import { joinChunks } from "./document.js";

// Encrypted export/import — the way memory gets OUT.
//
// Until now there was none, and the consequence was severe: the store is
// SQLCipher-encrypted with a random 32-byte key generated once and kept in the
// login Keychain. Lose that entry — dead Mac, keychain reset, a migration that
// does not carry it — and every document is unreadable forever, with no way to
// move a corpus to a new machine even deliberately. A product that can forget
// your memory on request should be able to hand it back.
//
// The passphrase is deliberately NOT the Keychain key: that key is precisely
// what the disaster scenario destroys, so an archive sealed with it would be
// useless in the case it exists for. The user chooses a passphrase they can
// write down.
//
// scrypt (N=2^15) + AES-256-GCM. GCM is authenticated, so a truncated or edited
// archive fails loudly on import instead of yielding half a memory.

export const ARCHIVE_MAGIC = "SHYNARC1";
const SALT_LEN = 16, IV_LEN = 12, TAG_LEN = 16, KEY_LEN = 32;
const SCRYPT_N = 32768, SCRYPT_r = 8, SCRYPT_p = 1;

export type ArchiveDoc = {
  source: string; uri: string; title: string; ts: number;
  meta?: Record<string, unknown>; text: string;
};

const deriveKey = (passphrase: string, salt: Buffer): Buffer =>
  scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, maxmem: 128 * 1024 * 1024 });

/// Every document, reassembled from its chunks. A generator so a large corpus is
/// never held in memory at once — 34k documents of transcripts and pages is not
/// a thing to buffer.
export function* archiveRows(db: Database.Database): Generator<ArchiveDoc> {
  const docs = db.prepare(
    "SELECT id, source, uri, title, ts, meta_json FROM documents ORDER BY id"
  ).iterate() as Iterable<{ id: number; source: string; uri: string; title: string; ts: number; meta_json: string }>;
  const chunkStmt = db.prepare("SELECT text FROM chunks WHERE doc_id = ? ORDER BY pos");
  for (const d of docs) {
    const texts = (chunkStmt.all(d.id) as { text: string }[]).map((t) => t.text);
    let meta: Record<string, unknown> | undefined;
    try { meta = d.meta_json ? JSON.parse(d.meta_json) : undefined; } catch { meta = undefined; }
    yield { source: d.source, uri: d.uri, title: d.title, ts: d.ts, meta, text: joinChunks(texts) };
  }
}

/// Writes: magic | salt | iv | tag | gzip(JSONL) — the tag sits in the header so
/// the body can be streamed straight out, and is filled in after the cipher
/// finishes. Returns the number of documents written.
export async function exportArchive(
  db: Database.Database, passphrase: string, path: string
): Promise<number> {
  if (!passphrase) throw new Error("export requires a passphrase");
  const salt = randomBytes(SALT_LEN), iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);

  let count = 0;
  const source = Readable.from((function* () {
    for (const row of archiveRows(db)) { count++; yield JSON.stringify(row) + "\n"; }
  })());

  const out = createWriteStream(path);
  // Placeholder tag: rewritten below once GCM has produced the real one.
  out.write(Buffer.concat([Buffer.from(ARCHIVE_MAGIC, "utf8"), salt, iv, Buffer.alloc(TAG_LEN)]));
  await pipeline(source, createGzip(), cipher, out);

  const { promises: fsp } = await import("node:fs");
  const fh = await fsp.open(path, "r+");
  try { await fh.write(cipher.getAuthTag(), 0, TAG_LEN, ARCHIVE_MAGIC.length + SALT_LEN + IV_LEN); }
  finally { await fh.close(); }
  return count;
}

export type ImportResult = { imported: number; deduped: number };

/// Streams an archive back in. `ingest` is the caller's own ingest path, so an
/// import is exactly a re-ingest: dedup by (source, uri) makes it idempotent,
/// and restoring onto a populated store merges rather than duplicating.
export async function importArchive(
  path: string, passphrase: string,
  ingest: (doc: ArchiveDoc) => { deduped: boolean }
): Promise<ImportResult> {
  if (!passphrase) throw new Error("import requires a passphrase");
  const { promises: fsp } = await import("node:fs");
  const headerLen = ARCHIVE_MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;
  const fh = await fsp.open(path, "r");
  const header = Buffer.alloc(headerLen);
  try { await fh.read(header, 0, headerLen, 0); } finally { await fh.close(); }

  const magic = header.subarray(0, ARCHIVE_MAGIC.length);
  if (!timingSafeEqual(magic, Buffer.from(ARCHIVE_MAGIC, "utf8")))
    throw new Error("not a shyn archive (bad magic)");
  let o = ARCHIVE_MAGIC.length;
  const salt = header.subarray(o, o += SALT_LEN);
  const iv = header.subarray(o, o += IV_LEN);
  const tag = header.subarray(o, o += TAG_LEN);

  const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);

  const result: ImportResult = { imported: 0, deduped: 0 };
  let buf = "";
  const consume = async function* (src: AsyncIterable<Buffer>) {
    for await (const piece of src) {
      buf += piece.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const doc = JSON.parse(line) as ArchiveDoc;
        if (ingest(doc).deduped) result.deduped++; else result.imported++;
      }
    }
    if (buf.trim()) {
      const doc = JSON.parse(buf) as ArchiveDoc;
      if (ingest(doc).deduped) result.deduped++; else result.imported++;
    }
  };

  try {
    // The GCM tag is only verified when the cipher stream ends, so a wrong
    // passphrase or a tampered body surfaces here rather than as silent garbage.
    await pipeline(
      createReadStream(path, { start: headerLen }),
      decipher, createGunzip(),
      async (src: AsyncIterable<Buffer>) => { for await (const _ of consume(src)) { /* drained */ } });
  } catch (e) {
    const m = (e as Error)?.message ?? "";
    // A corrupted body usually fails at GUNZIP first — garbage plaintext has a
    // bad CRC — so "incorrect data check" and friends mean the same thing to a
    // user as a failed auth tag: this archive will not open.
    if (/auth|tag|bad decrypt|incorrect (header|data check)|unexpected end|invalid|checksum|inflate/i.test(m))
      throw new Error("wrong passphrase, or the archive is corrupt");
    throw e;
  }
  return result;
}
