import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// All update machinery lives in the STATUS APP (spec 2026-07-24): the
// daemon and agents make no network requests, ever — keep it that way.

export const UPGRADE_COMMAND = "brew update && brew upgrade --cask shyn && shyn setup";

export const RELEASES_URL =
  "https://api.github.com/repos/shyn-labs/homebrew-tap/releases/latest";

// "0.4.13-alpha" scheme: compare the numeric dotted prefix, ignore the
// suffix. null on malformed input — a bad tag must never look like an update.
export function compareShynVersions(a: string, b: string): number | null {
  const parse = (s: string): number[] | null => {
    const m = s.replace(/^v/, "").match(/^(\d+(?:\.\d+)*)/);
    return m ? m[1].split(".").map(Number) : null;
  };
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

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

// Silent on every failure: offline is a normal state, never a warning.
export async function checkLatest(fetchFn: typeof fetch): Promise<string | null> {
  try {
    const r = await fetchFn(RELEASES_URL, { headers: { accept: "application/vnd.github+json" } });
    if (!r.ok) return null;
    const tag = (await r.json() as { tag_name?: unknown })?.tag_name;
    return typeof tag === "string" && tag.length > 0 ? tag.replace(/^v/, "") : null;
  } catch { return null; }
}
