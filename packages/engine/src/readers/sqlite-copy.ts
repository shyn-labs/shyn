import Database from "better-sqlite3-multiple-ciphers";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export function copyAndOpen(sourcePath: string): { db: Database.Database; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "shyn-reader-"));
  try {
    const dest = join(dir, basename(sourcePath));
    copyFileSync(sourcePath, dest);
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(sourcePath + suffix)) copyFileSync(sourcePath + suffix, dest + suffix);
    let readonlyDb: Database.Database | undefined;
    let db: Database.Database;
    try {
      readonlyDb = new Database(dest, { readonly: true });
      // Construction alone can succeed even when the copy needs WAL recovery
      // (a write journal) — the failure only surfaces on first query. Force
      // that recovery now with a harmless statement so we catch it here rather
      // than at first real use.
      readonlyDb.pragma("schema_version");
      db = readonlyDb;
    } catch {
      // Readonly open (or the validating query) can fail if WAL recovery is
      // needed. This is our private temp copy, so opening writable is safe.
      if (readonlyDb) readonlyDb.close();
      db = new Database(dest);
    }
    // Success path: use bestEffortRm, not a bare rmSync — a cleanup failure
    // after a successful read must not throw and void an otherwise-passing
    // call. The temp dir is disposable either way; a lingering one is a
    // lesser evil than surfacing a spurious error post-success.
    return { db, cleanup: () => { db.close(); bestEffortRm(dir); } };
  } catch (err) {
    // Any failure after the temp dir was created (copy failure, or a
    // WAL-recovery failure on both the readonly and writable open attempts)
    // must not leave the dir behind — a leaked dir is, worst case, a
    // plaintext copy of the user's history/notes store sitting in $TMPDIR.
    // Cleanup itself failing must not mask the original error — the copy
    // failure is what the caller needs to see, a lingering temp dir is a
    // lesser evil than losing that signal.
    bestEffortRm(dir);
    throw err;
  }
}

// Best-effort recursive removal: swallows failures because it only ever runs
// on a cleanup path where a more important original error is in flight (or
// about to be thrown). A lingering temp dir is a lesser evil than masking
// that signal.
export function bestEffortRm(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); }
  catch { /* dir may linger; the caller's original error matters more */ }
}

// copyAndOpen can throw past an earlier accessSync() gate: real TCC often
// lets access()/stat() succeed while the actual open/copy fails EPERM (the
// permission check surfaces later than the plain access check). Shared by
// all readers' available() so each reports a consistent, non-throwing
// unavailable reason instead of letting the throw escape.
export function copyFailureReason(err: unknown, fdaHint: string, storeName: string): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EPERM" || code === "EACCES") return fdaHint;
  const message = err instanceof Error ? err.message : String(err);
  return `cannot read ${storeName} store: ${message}`;
}
