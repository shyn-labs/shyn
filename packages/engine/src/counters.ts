import type Database from "better-sqlite3-multiple-ciphers";

// Counts only — keys are opaque labels like "search:2026-07-11".
// Never store query text, content, or anything derived from either.

export function bumpCounter(db: Database.Database, key: string): void {
  db.prepare(
    "INSERT INTO counters (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1"
  ).run(key);
}

export function sumCounters(db: Database.Database, prefix: string, fromKey?: string): number {
  const row = fromKey
    ? db.prepare("SELECT COALESCE(SUM(value),0) s FROM counters WHERE key LIKE ? || '%' AND key >= ?")
        .get(prefix, fromKey)
    : db.prepare("SELECT COALESCE(SUM(value),0) s FROM counters WHERE key LIKE ? || '%'").get(prefix);
  return (row as { s: number }).s;
}

// Local-time YYYY-MM-DD: "this week" means the user's week. en-CA formats
// as YYYY-MM-DD, which sorts lexicographically = chronologically.
export const dayKey = (tsSec: number): string =>
  new Date(tsSec * 1000).toLocaleDateString("en-CA");
