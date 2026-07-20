import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage.js";
import { bumpCounter, sumCounters, dayKey } from "../src/counters.js";
import { getStats } from "../src/stats.js";
import type Database from "better-sqlite3-multiple-ciphers";

const DAY = 86400;

describe("counters", () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shyn-counters-"));
    db = openDatabase({ dbPath: join(dir, "t.db"), key: null });
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("bump creates then increments; sum honors prefix and fromKey", () => {
    bumpCounter(db, "search:2026-07-01");
    bumpCounter(db, "search:2026-07-01");
    bumpCounter(db, "search:2026-07-08");
    bumpCounter(db, "other:2026-07-08");
    expect(sumCounters(db, "search:")).toBe(3);
    expect(sumCounters(db, "search:", "search:2026-07-05")).toBe(1);
    expect(sumCounters(db, "nope:")).toBe(0);
  });

  it("dayKey is YYYY-MM-DD and lexicographically chronological", () => {
    const a = dayKey(1_770_000_000);
    expect(a).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dayKey(1_770_000_000) < dayKey(1_770_000_000 + 3 * DAY)).toBe(true);
  });
});

describe("stats", () => {
  let dir: string;
  let db: Database.Database;
  const NOW = 1_780_000_000;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shyn-stats-"));
    db = openDatabase({ dbPath: join(dir, "t.db"), key: null });
    const ins = db.prepare(
      "INSERT INTO documents (source, uri, title, ts, content_hash, meta_json) VALUES (?,?,?,?,?,?)");
    ins.run("browser", "https://a", "", NOW - DAY, "h1", "{}");
    ins.run("browser", "https://b", "", NOW - 2 * DAY, "h2", "{}");
    ins.run("file", "/x.md", "", NOW - DAY, "h3", "{}");
    ins.run("meeting", "meeting://m1", "", NOW - 3 * DAY, "h4", JSON.stringify({ durationSec: 600 }));
    ins.run("meeting", "meeting://m2", "", NOW - 30 * DAY, "h5", JSON.stringify({ durationSec: 999 }));
    ins.run("browser", "https://old", "", NOW - 30 * DAY, "h6", "{}");
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("windows by days, groups by source, extracts meeting duration, reads counters", () => {
    bumpCounter(db, `search:${dayKey(NOW - DAY)}`);
    bumpCounter(db, `search:${dayKey(NOW - DAY)}`);
    bumpCounter(db, `search:${dayKey(NOW - 20 * DAY)}`);
    const s = getStats(db, { days: 7, now: NOW });
    expect(s.days).toBe(7);
    expect(s.since).toBe(NOW - 7 * DAY);
    expect(s.docsBySource).toEqual({ browser: 2, file: 1, meeting: 1 });
    expect(s.pagesRead).toBe(2);
    expect(s.meetings).toBe(1);
    expect(s.meetingSeconds).toBe(600);
    expect(s.searches).toBe(2);
    expect(s.searchesTotal).toBe(3);
    expect(s.totals.documents).toBe(6);
    const dayTotal = s.docsPerDay.reduce((a, d) => a + d.count, 0);
    expect(dayTotal).toBe(4); // only in-window docs
  });

  it("defaults: 7 days, empty DB yields zeros", () => {
    db.prepare("DELETE FROM documents").run();
    const s = getStats(db, { now: NOW });
    expect(s.days).toBe(7);
    expect(s.pagesRead).toBe(0);
    expect(s.meetings).toBe(0);
    expect(s.searches).toBe(0);
    expect(s.docsPerDay).toEqual([]);
  });
});
