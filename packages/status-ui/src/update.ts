import { existsSync, readFileSync, rmSync } from "node:fs";
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
