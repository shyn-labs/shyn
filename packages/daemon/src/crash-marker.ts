import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A dying process cannot send analytics: the queue is in memory, the flush is
// async, and the crash handler must exit at once so launchd relaunches us. So
// the crash path only drops a small marker file, and the NEXT daemon start
// reports it as `daemon_error` (if the user is opted in) and deletes it.
//
// Light on purpose: log-install.ts runs before anything heavyweight loads, and
// a module that can itself crash at import would recreate the unstamped-crash
// gap that module exists to close. Node builtins only.
//
// The marker holds the RAW message and stack, like daemon.log already does. It
// goes through scrubProperties() before leaving the machine; this file never
// does. It is only written while consent is on, and is deleted unread when
// consent has since been withdrawn.

const FILE = "last-crash.json";
const MAX = 2000;   // enough for a stack; keeps a runaway message from filling the disk

export interface CrashMarker { label: string; message: string; stack: string; ts: number }

export function writeCrashMarker(home: string, label: string, err: unknown, now = Date.now()): void {
  const e = err instanceof Error ? err : new Error(String(err));
  const m: CrashMarker = {
    label, message: String(e.message).slice(0, MAX), stack: String(e.stack ?? "").slice(0, MAX),
    ts: Math.floor(now / 1000),
  };
  // Rename so a crash inside the crash handler never leaves half a file.
  const tmp = join(home, FILE + ".tmp");
  writeFileSync(tmp, JSON.stringify(m));
  renameSync(tmp, join(home, FILE));
}

/// Returns the marker and deletes it. A marker that will not parse is deleted
/// too: a stuck file must not be re-read on every boot.
export function consumeCrashMarker(home: string): CrashMarker | null {
  const p = join(home, FILE);
  if (!existsSync(p)) return null;
  let out: CrashMarker | null = null;
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    if (v && typeof v.label === "string" && typeof v.message === "string")
      out = { label: v.label, message: v.message, stack: typeof v.stack === "string" ? v.stack : "", ts: Number(v.ts) || 0 };
  } catch { /* fall through: delete it */ }
  rmSync(p, { force: true });
  return out;
}
