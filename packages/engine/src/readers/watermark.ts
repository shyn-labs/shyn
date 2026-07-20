import type Database from "better-sqlite3-multiple-ciphers";

export const DEFAULT_BACKFILL_SECONDS = 90 * 86400;
const key = (name: string) => `reader:${name}:watermark`;

export function getWatermark(
  db: Database.Database, name: string, now = Date.now() / 1000,
): number {
  const row = db.prepare("SELECT value FROM meta WHERE k=?").get(key(name)) as
    { value: string } | undefined;
  if (row) {
    const value = Number(row.value);
    if (Number.isNaN(value)) {
      console.warn(`watermark corrupted for reader '${name}': meta row value is not a number, using backfill default`);
      return Math.floor(now - DEFAULT_BACKFILL_SECONDS);
    }
    return value;
  }
  return Math.floor(now - DEFAULT_BACKFILL_SECONDS);
}

export function setWatermark(db: Database.Database, name: string, ts: number): void {
  db.prepare("INSERT OR REPLACE INTO meta(k, value) VALUES (?, ?)").run(key(name), String(ts));
}
