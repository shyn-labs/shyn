import { format } from "node:util";
import { statSync, truncateSync, copyFileSync, readdirSync, writeSync } from "node:fs";
import { join, dirname, basename } from "node:path";

// The 2026-07-19 crash-loop investigation stalled on one gap: daemon.log had
// 24 "shynd listening" lines and 12 crash footers, and no way to place any of
// them in time. Everything here exists to close that gap. Scope caveat:
// node-llama-cpp's native code writes its init spam directly to fd 2,
// bypassing console — those lines stay unstamped by design (identifiable by
// shape; intercepting them would need fd-level tricks not worth it pre-alpha).
//
// This module must stay import-light (node builtins only) so log-install.ts
// can run it before any heavyweight import can crash unstamped.

export function makeStampedWriter(
  write: (s: string) => void, now: () => Date = () => new Date(),
): (...args: unknown[]) => void {
  // Swallow write failures: Node's own console is built with
  // ignoreErrors=true, and replacing it must not turn a full disk (ENOSPC on
  // the log file) into an exception from inside every console.log caller —
  // which the crash handler would then turn into a daemon crash loop.
  return (...args) => {
    try { write(`${now().toISOString()} ${format(...args)}\n`); } catch { /* drop the line, keep the daemon */ }
  };
}

export function installStampedConsole(now: () => Date = () => new Date()): void {
  // Async stream errors (EPIPE on a vanished consumer) arrive as 'error'
  // events, not throws — leave them handled so they can't kill the process.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  console.log = makeStampedWriter((s) => process.stdout.write(s), now);
  console.error = makeStampedWriter((s) => process.stderr.write(s), now);
  console.warn = console.error;
}

// Node's own fatal output (the pre-2026-07-19 crash footers) is unstamped and
// always will be; installing a handler suppresses it, so the handler must log
// the error itself and still exit 1 to keep launchd's KeepAlive relaunch
// semantics. The default log path uses writeSync(2): a piped stderr buffers
// async writes and process.exit drops them — the crash reason must be flushed
// before the exit, not queued behind it.
export function makeCrashHandler(
  label: string,
  log: (...args: unknown[]) => void =
    makeStampedWriter((s) => writeSync(2, s)),
  exit: (code: number) => void = (c) => process.exit(c),
): (err: unknown) => void {
  return (err) => {
    try { log(`fatal: ${label}:`, err); } catch { /* exit anyway */ }
    exit(1);
  };
}

export function installCrashLogging(): void {
  process.on("uncaughtException", makeCrashHandler("uncaught exception"));
  process.on("unhandledRejection", makeCrashHandler("unhandled rejection"));
}

// launchd never rotates StandardOutPath targets (1.1MB accumulated in 9 days
// of pre-alpha). Rotation moves the oversized log aside to `<path>.1` (one
// generation) and truncates — never truncate-only: during a KeepAlive crash
// loop the previous boot's stamped fatal line is written seconds before the
// relaunch rotates, and wiping it would delete exactly the evidence this
// module exists to preserve. Truncating the original (rather than renaming
// it) is deliberate: every writer holds an O_APPEND fd to this inode, and a
// rename would drag those fds along to the rotated file.
export function rotateLogIfOversized(path: string | undefined, maxBytes = 5 * 1024 * 1024): boolean {
  if (!path) return false;
  try {
    if (statSync(path).size <= maxBytes) return false;
    copyFileSync(path, `${path}.1`);
    truncateSync(path);
    return true;
  } catch { return false; }
}

// capture.log / meeting.log / status.log share the daemon's never-rotating
// launchd setup, and the daemon is the only long-lived process positioned to
// bound them — sweep every *.log sibling of the daemon's own log. Safe while
// the other agents run: their O_APPEND fds land at the new EOF after
// truncation, same as the daemon's own.
export function sweepLogDir(daemonLogPath: string | undefined, maxBytes?: number): string[] {
  if (!daemonLogPath) return [];
  let names: string[];
  try { names = readdirSync(dirname(daemonLogPath)); } catch { return []; }
  return names
    .filter((n) => n.endsWith(".log"))
    .filter((n) => rotateLogIfOversized(join(dirname(daemonLogPath), n), maxBytes))
    .map((n) => basename(n));
}
