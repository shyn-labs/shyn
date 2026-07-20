import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage.js";
import { getWatermark, setWatermark, DEFAULT_BACKFILL_SECONDS } from "../src/readers/watermark.js";
import { webkitToUnix, macToUnix } from "../src/readers/epoch.js";

describe("watermarks", () => {
  it("defaults to now minus 90 days, then persists set values", () => {
    const db = openDatabase({ dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"), key: null });
    const now = 1_751_400_000;
    expect(getWatermark(db, "chrome", now)).toBe(now - DEFAULT_BACKFILL_SECONDS);
    setWatermark(db, "chrome", 1_751_000_000);
    expect(getWatermark(db, "chrome", now)).toBe(1_751_000_000);
    expect(getWatermark(db, "safari", now)).toBe(now - DEFAULT_BACKFILL_SECONDS); // independent keys
  });

  it("returns default backfill on corrupted (non-numeric) meta value", () => {
    const db = openDatabase({ dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"), key: null });
    const now = 1_751_400_000;
    // Directly corrupt a watermark meta row with garbage data
    db.prepare("INSERT INTO meta(k, value) VALUES (?, ?)").run("reader:corrupted:watermark", "garbage");
    const result = getWatermark(db, "corrupted", now);
    expect(result).toBe(now - DEFAULT_BACKFILL_SECONDS);
  });
});

describe("epoch converters", () => {
  it("converts WebKit microseconds (Chrome)", () => {
    // 2026-07-01T00:00:00Z == unix 1782864000... use a known pair instead:
    // unix 0 == webkit 11644473600e6
    expect(webkitToUnix(11644473600e6)).toBe(0);
    expect(webkitToUnix(11644473600e6 + 1_751_400_000e6)).toBe(1_751_400_000);
  });
  it("converts Mac absolute time (Safari/Notes)", () => {
    expect(macToUnix(0)).toBe(978307200);
    expect(macToUnix(1_000_000)).toBe(978307200 + 1_000_000);
  });
});
