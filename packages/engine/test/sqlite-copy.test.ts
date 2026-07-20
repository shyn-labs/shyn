import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { bestEffortRm, copyAndOpen } from "../src/readers/sqlite-copy.js";

describe("copyAndOpen", () => {
  it("copyAndOpen survives an uncheckpointed WAL copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "shyn-wal-"));
    const src = join(dir, "History");
    const db = new Database(src);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, last_visit_time INTEGER)");
    db.prepare("INSERT INTO urls(url, title, last_visit_time) VALUES ('https://w.example','W',1)").run();
    // deliberately NO checkpoint, NO close — copy with the WAL hot
    const { db: copy, cleanup } = copyAndOpen(src);
    const n = copy.prepare("SELECT count(*) c FROM urls").get() as { c: number };
    expect(n.c).toBe(1);
    cleanup();
    db.close();
  });

  it("leaves no shyn-reader-* dir behind when the source copy fails", () => {
    // A directory reliably makes copyFileSync throw synchronously (ENOTSUP/EISDIR)
    // without blocking — same convention used by the Chrome-reader fixture.
    // copyAndOpen resolves its temp dir via os.tmpdir(), which is TMPDIR-aware
    // at call time — sandbox TMPDIR to a private directory for the duration of
    // this test so other test files' own (legitimate, momentary) shyn-reader-*
    // dirs in the real shared tmpdir can't produce a false-positive "leak".
    const realTmp = tmpdir();
    const sandbox = mkdtempSync(join(realTmp, "shyn-copyfail-sandbox-"));
    const prevTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = sandbox;
    try {
      const uncopyable = join(sandbox, "History");
      mkdirSync(uncopyable);
      expect(() => copyAndOpen(uncopyable)).toThrow();
      const leaked = readdirSync(sandbox).filter((n) => n.startsWith("shyn-reader-"));
      expect(leaked).toEqual([]);
    } finally {
      process.env.TMPDIR = prevTmpdir;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe("bestEffortRm", () => {
  it("swallows removal failures that make bare rmSync throw", () => {
    // A directory containing a chmod-000 subdirectory: rmSync cannot unlink
    // the subdir's contents, so even with { force: true } it throws
    // ENOTEMPTY on this platform (verified empirically on macOS/Node).
    const dir = mkdtempSync(join(tmpdir(), "shyn-rm-"));
    const sub = join(dir, "locked");
    mkdirSync(sub);
    writeFileSync(join(sub, "f"), "x");
    chmodSync(sub, 0o000);
    try {
      // Discrimination: prove this input makes the unguarded call throw...
      expect(() => rmSync(dir, { recursive: true, force: true })).toThrow();
      // ...and that the guarded helper swallows the same failure.
      expect(() => bestEffortRm(dir)).not.toThrow();
    } finally {
      chmodSync(sub, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
