import { readFileSync, writeFileSync } from "node:fs";

// Restart-once guard for EmbedBackendUnavailableError: a fresh process is
// the only cure for node's cached import rejection, but if a restart did
// NOT cure it we must not crash-loop — keyword-only search (the degraded
// ladder's floor) beats a flapping daemon. The marker records the last
// self-restart; within the cooldown we stay up and stay degraded.
export const EMBED_RESTART_COOLDOWN_MS = 15 * 60_000;

export function shouldRestartForEmbedFailure(
  markerPath: string,
  nowMs: number,
  cooldownMs = EMBED_RESTART_COOLDOWN_MS,
): boolean {
  try {
    const { ts } = JSON.parse(readFileSync(markerPath, "utf8"));
    if (typeof ts === "number" && nowMs - ts < cooldownMs) return false;
  } catch { /* no/invalid marker → first failure, restart is allowed */ }
  writeFileSync(markerPath, JSON.stringify({ ts: nowMs }) + "\n");
  return true;
}
