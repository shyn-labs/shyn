import type Database from "better-sqlite3-multiple-ciphers";
import { sumCounters, dayKey } from "./counters.js";

export type StatsResult = {
  days: number;
  since: number; // epoch seconds
  pagesRead: number; // browser docs in window — the popover/CLI shared number
  docsBySource: Record<string, number>;
  docsPerDay: { day: string; count: number }[];
  meetings: number;
  meetingSeconds: number; // 0 when meeting docs carry no durationSec meta
  searches: number; // in window (per-day counters)
  searchesTotal: number; // lifetime
  totals: { documents: number; chunks: number; vectors: number };
};

export function getStats(
  db: Database.Database,
  opts: { days?: number; now?: number } = {},
): StatsResult {
  const days = opts.days ?? 7;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const since = now - days * 86400;

  const bySource = db.prepare(
    "SELECT source, COUNT(*) c FROM documents WHERE ts >= ? GROUP BY source"
  ).all(since) as { source: string; c: number }[];
  const docsBySource: Record<string, number> = {};
  for (const r of bySource) docsBySource[r.source] = r.c;

  const perDay = db.prepare(
    "SELECT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') day, COUNT(*) c " +
    "FROM documents WHERE ts >= ? GROUP BY day ORDER BY day"
  ).all(since) as { day: string; c: number }[];

  const mtg = db.prepare(
    "SELECT COUNT(*) c, COALESCE(SUM(COALESCE(json_extract(meta_json, '$.durationSec'), 0)), 0) dur " +
    "FROM documents WHERE source = 'meeting' AND ts >= ?"
  ).get(since) as { c: number; dur: number };

  const totals = {
    documents: (db.prepare("SELECT COUNT(*) c FROM documents").get() as { c: number }).c,
    chunks: (db.prepare("SELECT COUNT(*) c FROM chunks").get() as { c: number }).c,
    vectors: (db.prepare("SELECT COUNT(*) c FROM chunk_vectors").get() as { c: number }).c,
  };

  return {
    days,
    since,
    pagesRead: docsBySource["browser"] ?? 0,
    docsBySource,
    docsPerDay: perDay.map((r) => ({ day: r.day, count: r.c })),
    meetings: mtg.c,
    meetingSeconds: mtg.dur,
    searches: sumCounters(db, "search:", `search:${dayKey(since)}`),
    searchesTotal: sumCounters(db, "search:"),
    totals,
  };
}
