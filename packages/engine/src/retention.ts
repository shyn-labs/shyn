import type Database from "better-sqlite3-multiple-ciphers";
import { forget } from "./forget.js";

// Rolling-window purge for the screen source (spec §3.4). Reuses forget()
// so deletion stays byte-honest (cascade + orphan sweep + VACUUM + WAL
// truncate). The count pre-check keeps the hourly timer from paying a
// VACUUM when nothing expired.
export function sweepScreenRetention(
  db: Database.Database, retentionDays: number
): { documents: number } {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  const { c } = db.prepare(
    "SELECT count(*) c FROM documents WHERE source='screen' AND ts <= ?"
  ).get(cutoff) as { c: number };
  if (c === 0) return { documents: 0 };
  return forget(db, { source: "screen", timeTo: cutoff });
}

// Rolling-window purge for the meeting source (spec §Retention). Meetings are
// high-value: retentionDays <= 0 means KEEP FOREVER (retention disabled) — this
// is deliberately different from screen, where the daemon treats 0 as purge-all.
export function sweepMeetingRetention(
  db: Database.Database, retentionDays: number
): { documents: number } {
  if (retentionDays <= 0) return { documents: 0 };
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  const { c } = db.prepare(
    "SELECT count(*) c FROM documents WHERE source='meeting' AND ts <= ?"
  ).get(cutoff) as { c: number };
  if (c === 0) return { documents: 0 };
  return forget(db, { source: "meeting", timeTo: cutoff });
}
