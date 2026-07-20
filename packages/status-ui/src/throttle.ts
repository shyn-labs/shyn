import { existsSync, readFileSync, writeFileSync } from "node:fs";

// UI-throttle state, deliberately NOT setup state (spec): deleting the file
// merely re-allows one auto-open. Setup completion itself is always derived.
export function shouldAutoOpen(lastTs: number | null, nowEpoch: number): boolean {
  return lastTs === null || nowEpoch - lastTs >= 86_400;
}

export function readThrottle(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")).lastAutoOpenTs;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch { return null; }
}

export function writeThrottle(path: string, ts: number): void {
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(readFileSync(path, "utf8")); } catch { /* fresh */ }
  writeFileSync(path, JSON.stringify({ ...cfg, lastAutoOpenTs: ts }) + "\n");
}

export function readCompletedOnce(path: string): boolean {
  if (!existsSync(path)) return false;
  try { return JSON.parse(readFileSync(path, "utf8")).completedOnce === true; } catch { return false; }
}

export function writeCompletedOnce(path: string): void {
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(readFileSync(path, "utf8")); } catch { /* fresh */ }
  writeFileSync(path, JSON.stringify({ ...cfg, completedOnce: true }) + "\n");
}
