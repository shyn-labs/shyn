import type Database from "better-sqlite3-multiple-ciphers";

// The user's own voice, and nothing else (spec 2026-10-05, Privacy). Samples
// arrive from calls with >= 30 s of mic speech; the 20 most recent are kept so
// AirPods, a laptop mic and a bad line all have a recent match.
export const SELF_SAMPLE_CAP = 20;

export function decodeEmbedding(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  const out = new Float32Array(Math.floor(buf.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

function selfProfileId(db: Database.Database, now: number): number {
  const row = db.prepare("SELECT id FROM voice_profiles WHERE is_self = 1").get() as { id: number } | undefined;
  if (row) return row.id;
  return Number(db.prepare(
    "INSERT INTO voice_profiles(name, is_self, created_ts, updated_ts) VALUES (NULL, 1, ?, ?)",
  ).run(now, now).lastInsertRowid);
}

export function addSelfSample(db: Database.Database, embedding: Float32Array, speechSec: number, ts: number): void {
  db.transaction(() => {
    const id = selfProfileId(db, ts);
    db.prepare("INSERT INTO voice_samples(profile_id, embedding, speech_sec, ts) VALUES (?, ?, ?, ?)")
      .run(id, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength), speechSec, ts);
    db.prepare(`DELETE FROM voice_samples WHERE profile_id = ? AND id NOT IN (
                  SELECT id FROM voice_samples WHERE profile_id = ? ORDER BY ts DESC, id DESC LIMIT ?)`)
      .run(id, id, SELF_SAMPLE_CAP);
    db.prepare("UPDATE voice_profiles SET updated_ts = ? WHERE id = ?").run(ts, id);
  })();
}

export function selfSamples(db: Database.Database): Float32Array[] {
  const rows = db.prepare(`SELECT s.embedding FROM voice_samples s JOIN voice_profiles p ON p.id = s.profile_id
                           WHERE p.is_self = 1 ORDER BY s.ts DESC, s.id DESC`).all() as { embedding: Buffer }[];
  return rows.map(({ embedding: b }) => {
    const copy = Buffer.from(b);
    return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
  });
}

export function forgetSelf(db: Database.Database): { removed: number } {
  const r = db.prepare("DELETE FROM voice_profiles WHERE is_self = 1").run();
  return { removed: r.changes };
}
