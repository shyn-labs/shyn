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

// Provisional (the spike's in-person task never ran; plan Task 12 calibrates on
// a real recording). Erring strict is safe: every voice just stays Speaker N.
export const SELF_THRESHOLD = 0.6;
export const SELF_MARGIN = 0.2;

export const NO_SELF_PROFILE_NOTE =
  "Speakers are numbered: shyn has no sample of your voice yet. It learns one from your next call.";

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.max(1e-9, Math.sqrt(na) * Math.sqrt(nb));
}

/** The label of the speaker who is the user, or null when not certain. Each
 *  speaker scores its CLOSEST self sample; the best must clear `threshold` and
 *  beat the runner-up by `margin`. */
export function chooseSelf(
  speakers: { label: string; embedding: Float32Array }[], samples: Float32Array[],
  threshold = SELF_THRESHOLD, margin = SELF_MARGIN,
): string | null {
  if (samples.length === 0 || speakers.length === 0) return null;
  const scored = speakers
    .map((s) => ({ label: s.label, score: Math.max(...samples.map((x) => cosine(s.embedding, x))) }))
    .sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (best.score < threshold) return null;
  if (next && best.score - next.score < margin) return null;
  return best.label;
}

/** Rewrites "Speaker N:" line prefixes: the self label becomes "Me:", the rest
 *  are renumbered 1..k in their original order. Only the prefix at the start of
 *  a line is touched; a quoted "Speaker 1:" inside a line is speech. */
export function relabelInPerson(text: string, selfLabel: string | null, labels: string[]): string {
  if (selfLabel === null) return text;
  const others = labels.filter((l) => l !== selfLabel)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const renumber = new Map(others.map((l, i) => [Number(l.slice(1)), i + 1]));
  const self = Number(selfLabel.slice(1));
  return text.split("\n").map((line) => {
    const m = /^Speaker (\d+): /.exec(line);
    if (!m) return line;
    const n = Number(m[1]);
    const rest = line.slice(m[0].length);
    if (n === self) return `Me: ${rest}`;
    const k = renumber.get(n);
    return k === undefined ? line : `Speaker ${k}: ${rest}`;
  }).join("\n");
}
