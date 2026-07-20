import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { ChromeHistoryReader } from "../src/readers/chrome.js";
import { webkitToUnix } from "../src/readers/epoch.js";

// Realistic fixture: source timestamps carry sub-second precision (µs) that a
// whole-second watermark floors away. This is the boundary-overlap condition.
const unixToWebkit = (s: number) => (s + 11644473600) * 1e6 + 437123;

function makeChromeFixture(rows: { url: string; title: string; ts: number }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "shyn-chrome-"));
  const p = join(dir, "History");
  const db = new Database(p);
  db.exec(`CREATE TABLE urls (
    id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT,
    visit_count INTEGER DEFAULT 0, last_visit_time INTEGER
  )`);
  const ins = db.prepare("INSERT INTO urls(url, title, last_visit_time) VALUES (?,?,?)");
  for (const r of rows) ins.run(r.url, r.title, unixToWebkit(r.ts));
  db.close();
  return p;
}

describe("ChromeHistoryReader", () => {
  it("reads incrementally since a watermark with correct mapping", async () => {
    const p = makeChromeFixture([
      { url: "https://a.example/one", title: "Old article", ts: 1000 },
      { url: "https://b.example/two", title: "Carbon markets deep dive", ts: 2000 },
    ]);
    const reader = new ChromeHistoryReader({ historyPaths: [p] });
    expect((await reader.available()).ok).toBe(true);
    const docs = await reader.read(1500);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      source: "browser", uri: "https://b.example/two",
      title: "Carbon markets deep dive", ts: 2000,
    });
    expect(docs[0].text).toBe("Carbon markets deep dive\nhttps://b.example/two");
  });

  it("merges multiple profiles and reports unavailable when no path exists", async () => {
    const p1 = makeChromeFixture([{ url: "https://p1.example", title: "P1", ts: 3000 }]);
    const p2 = makeChromeFixture([{ url: "https://p2.example", title: "P2", ts: 4000 }]);
    const both = new ChromeHistoryReader({ historyPaths: [p1, p2] });
    expect((await both.read(0)).map(d => d.uri).sort())
      .toEqual(["https://p1.example", "https://p2.example"]);
    const none = new ChromeHistoryReader({ historyPaths: ["/nonexistent/History"] });
    const a = await none.available();
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/no Chrome history found/i);
  });

  it("skips rows with empty titles gracefully", async () => {
    const p = makeChromeFixture([{ url: "https://t.example", title: "", ts: 5000 }]);
    const docs = await new ChromeHistoryReader({ historyPaths: [p] }).read(0);
    expect(docs[0].title).toBe("https://t.example"); // falls back to url
  });

  it("re-emits the boundary row on next sync (overlap by design, deduped downstream)", async () => {
    const p = makeChromeFixture([{ url: "https://edge.example", title: "Edge", ts: 2000 }]);
    const reader = new ChromeHistoryReader({ historyPaths: [p] });
    const first = await reader.read(0);
    expect(first).toHaveLength(1);
    const wm = first[0].ts; // 2000 (floored from 2000.437123)
    const second = await reader.read(wm);
    expect(second).toHaveLength(1); // boundary overlap re-emits — this is the contract
    expect(second[0].uri).toBe("https://edge.example");
  });

  it("available() aggregates across profiles: one bad profile doesn't disable Chrome entirely", async () => {
    // Real multi-profile Macs: one profile's History can be unprobeable (a
    // stale lock, an in-progress migration, etc.) while the others are fine.
    // available() must not fail closed on the FIRST unprobeable profile —
    // read() itself is already per-profile lenient, so available() promising
    // less than that disables all Chrome ingestion over one bad profile.
    const dir = mkdtempSync(join(tmpdir(), "shyn-chrome-uncopyable2-"));
    const badPath = join(dir, "History");
    mkdirSync(badPath);
    const goodPath = makeChromeFixture([{ url: "https://good.example", title: "Good", ts: 6000 }]);
    const reader = new ChromeHistoryReader({ historyPaths: [badPath, goodPath] });
    const a = await reader.available();
    expect(a.ok).toBe(true);
    expect(a.reason).toMatch(/skipped/i);
    const docs = await reader.read(0);
    expect(docs.map((d) => d.uri)).toEqual(["https://good.example"]);
  });

  it("degrades to unavailable when the store cannot be copied", async () => {
    // A named pipe would be the textbook way to make copyFileSync fail
    // without real TCC, but empirically on this Node/macOS combo
    // copyFileSync *blocks forever* on a FIFO with no writer instead of
    // throwing — that would hang the suite. A directory reliably makes
    // copyFileSync throw synchronously (ENOTSUP) without blocking, and
    // exercises the exact same code path: available() finds the path via
    // existsSync, then copyAndOpen's copyFileSync call throws.
    const dir = mkdtempSync(join(tmpdir(), "shyn-chrome-uncopyable-"));
    const p = join(dir, "History");
    mkdirSync(p);
    const reader = new ChromeHistoryReader({ historyPaths: [p] });
    const a = await reader.available();
    expect(a.ok).toBe(false);
    expect(await reader.read(0)).toEqual([]); // never throws
  });

  it("any-ok availability names the skipped profile directories", async () => {
    // Drive the EPERM/EACCES branch: its FDA_HINT reason carries NO path, so
    // the profile name can only reach the reason via the failedLabels logic —
    // an error-message path leak (as with EISDIR) cannot fake a pass here.
    const good = makeChromeFixture([{ url: "https://ok.example", title: "OK", ts: 1000 }]);
    const profileDir = join(mkdtempSync(join(tmpdir(), "shyn-badprof-")), "Profile 2");
    mkdirSync(profileDir, { recursive: true });
    const badHistory = join(profileDir, "History");
    writeFileSync(badHistory, "locked");
    chmodSync(badHistory, 0o000); // EACCES on copy → FDA-hint branch (no path in message)
    try {
      const r = new ChromeHistoryReader({ historyPaths: [badHistory, good] });
      const a = await r.available();
      expect(a.ok).toBe(true);
      expect(a.reason).toContain("Profile 2");
    } finally { chmodSync(badHistory, 0o644); }
  });
});
