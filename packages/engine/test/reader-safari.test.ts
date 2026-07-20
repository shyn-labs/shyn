import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { SafariHistoryReader } from "../src/readers/safari.js";

// Realistic fixture: source timestamps carry a sub-second remainder that a
// whole-second watermark floors away. This is the boundary-overlap condition
// (same deviation applied in Task 3's Chrome fixture).
const unixToMac = (s: number) => s - 978307200 + 0.437;

function makeSafariFixture(rows: { url: string; title: string; ts: number }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "shyn-safari-"));
  const p = join(dir, "History.db");
  const db = new Database(p);
  db.exec(`CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT NOT NULL);
           CREATE TABLE history_visits (
             id INTEGER PRIMARY KEY, history_item INTEGER NOT NULL,
             visit_time REAL NOT NULL, title TEXT)`);
  const insI = db.prepare("INSERT INTO history_items(url) VALUES (?)");
  const insV = db.prepare(
    "INSERT INTO history_visits(history_item, visit_time, title) VALUES (?,?,?)");
  for (const r of rows) {
    const { lastInsertRowid } = insI.run(r.url);
    insV.run(Number(lastInsertRowid), unixToMac(r.ts), r.title);
  }
  db.close();
  return p;
}

describe("SafariHistoryReader", () => {
  it("reads incrementally with mac-epoch conversion", async () => {
    const p = makeSafariFixture([
      { url: "https://old.example", title: "Old", ts: 1000 },
      { url: "https://new.example", title: "Fresh read", ts: 2000 },
    ]);
    const docs = await new SafariHistoryReader({ historyPath: p }).read(1500);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      source: "browser", uri: "https://new.example", title: "Fresh read", ts: 2000 });
  });

  it("collapses multiple visits to the latest per item", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shyn-safari-"));
    const p = join(dir, "History.db");
    const db = new Database(p);
    db.exec(`CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT NOT NULL);
             CREATE TABLE history_visits (
               id INTEGER PRIMARY KEY, history_item INTEGER NOT NULL,
               visit_time REAL NOT NULL, title TEXT)`);
    db.prepare("INSERT INTO history_items(url) VALUES ('https://multi.example')").run();
    db.prepare("INSERT INTO history_visits(history_item, visit_time, title) VALUES (1, ?, 'v1')")
      .run(unixToMac(1000));
    db.prepare("INSERT INTO history_visits(history_item, visit_time, title) VALUES (1, ?, 'v2')")
      .run(unixToMac(2000));
    db.close();
    const docs = await new SafariHistoryReader({ historyPath: p }).read(0);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ title: "v2", ts: 2000 });
  });

  it("reports missing file as unavailable", async () => {
    const a = await new SafariHistoryReader({ historyPath: "/nonexistent/History.db" }).available();
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/no Safari history/i);
  });

  it("degrades to unavailable when the store cannot be copied", async () => {
    // A named pipe would be the textbook way to make copyFileSync fail
    // without real TCC, but empirically on this Node/macOS combo
    // copyFileSync *blocks forever* on a FIFO with no writer instead of
    // throwing — that would hang the suite. A directory reliably makes
    // copyFileSync throw synchronously (ENOTSUP) without blocking, and
    // exercises the exact same code path: accessSync gate passes (a
    // directory is readable), copyAndOpen's copyFileSync call throws.
    const dir = mkdtempSync(join(tmpdir(), "shyn-safari-uncopyable-"));
    const p = join(dir, "History.db");
    mkdirSync(p);
    const reader = new SafariHistoryReader({ historyPath: p });
    const a = await reader.available();
    expect(a.ok).toBe(false);
    expect(await reader.read(0)).toEqual([]); // never throws
  });
});
