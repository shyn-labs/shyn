import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { UPGRADE_COMMAND } from "./update-core.js";

// All update machinery lives in the STATUS APP (spec 2026-07-24): the
// daemon and agents make no network requests, ever — keep it that way.

export * from "./update-core.js";

export function readUpdateCheckEnabled(home: string): boolean {
  try {
    const cfg = JSON.parse(readFileSync(join(home, "capture.json"), "utf8"));
    return cfg.updateCheck !== false;
  } catch { return true; }
}

// Applying an update restarts the daemon and both capture agents, so unlike the
// CHECK (on by default) it is opt-in: `"autoUpdate": true` in capture.json.
// Checking without applying stays the default for anyone who wants to decide.
export function readAutoUpdateEnabled(home: string): boolean {
  try {
    const cfg = JSON.parse(readFileSync(join(home, "capture.json"), "utf8"));
    return cfg.autoUpdate === true;
  } catch { return false; }
}

// Last auto-update attempt, persisted because the upgrade restarts this very
// app: in-memory state would reset and re-fire on every relaunch.
export type UpdateAttempt = { version: string; at: number };

export function readUpdateAttempt(home: string): UpdateAttempt | null {
  try {
    const a = JSON.parse(readFileSync(join(home, "update-attempt.json"), "utf8"));
    return typeof a?.version === "string" && typeof a?.at === "number" ? a : null;
  } catch { return null; }
}

export function writeUpdateAttempt(home: string, a: UpdateAttempt): void {
  try { writeFileSync(join(home, "update-attempt.json"), JSON.stringify(a) + "\n"); }
  catch { /* best-effort: a lost record only risks one extra attempt */ }
}

// One-shot marker written by the detached upgrade shell on failure —
// consumed (deleted) on read, same idiom as meeting-control.json.
export function consumeUpdateFailed(home: string): boolean {
  const p = join(home, "update-failed.json");
  if (!existsSync(p)) return false;
  rmSync(p, { force: true });
  return true;
}

export function upgradeShell(home: string): string {
  const log = join(homedir(), "Library", "Logs", "shyn", "update.log");
  const marker = join(home, "update-failed.json");
  return `(${UPGRADE_COMMAND}) >> "${log}" 2>&1 || echo "{\\"failedAt\\":$(date +%s)}" > "${marker}"`;
}

export function findBrew(): string | null {
  for (const p of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"])
    if (existsSync(p)) return p;
  return null;
}
