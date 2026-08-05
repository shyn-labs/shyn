// Browser-safe half of the update machinery: imported by the renderer
// bundle (platform: "browser" — no node builtins allowed) and by derive.
// Filesystem/spawn helpers live in update.ts, which re-exports this file.

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

// --- Auto-update decision (spec 2026-08-05) -------------------------------
//
// The one-click path already existed; this decides when to take it without a
// click. It is a pure function on purpose: applying an update restarts the
// daemon and both capture agents mid-flight, so every reason to hold back has
// to be inspectable and testable rather than buried in a timer callback.

/** Hold off this long after a failed attempt before trying the same thing again. */
export const AUTO_UPDATE_RETRY_SECONDS = 6 * 3600;
/** Don't re-attempt the same version inside this window (guards a no-op upgrade loop). */
export const AUTO_UPDATE_SAME_VERSION_SECONDS = 24 * 3600;

export type AutoUpdateContext = {
  enabled: boolean;
  current: string;
  latest: string | null;
  /** An upgrade this app already kicked off is still running. */
  updating: boolean;
  /** Daemon-reported meeting state: "recording"/"transcribing" mean hands off. */
  meetingState?: string | null;
  /** Last attempt this app made, persisted across restarts. */
  lastAttempt?: { version: string; at: number } | null;
  /** Epoch of the last observed failure marker. */
  lastFailureAt?: number | null;
  brewFound: boolean;
  now: number;
};

export type AutoUpdateDecision = { run: boolean; reason: string };

export function shouldAutoUpdate(c: AutoUpdateContext): AutoUpdateDecision {
  if (!c.enabled) return { run: false, reason: "auto-update disabled" };
  if (!c.brewFound) return { run: false, reason: "brew not found" };
  if (c.updating) return { run: false, reason: "already updating" };
  if (!c.latest) return { run: false, reason: "no release information" };

  const cmp = compareShynVersions(c.latest, c.current);
  if (cmp === null) return { run: false, reason: "unparseable version" };
  if (cmp <= 0) return { run: false, reason: "already current" };

  // Never interrupt a live meeting. `shyn setup` restarts the meeting agent,
  // and a killed transcription is an unrecoverable recording on any build
  // without the pending-retry sidecar.
  if (c.meetingState === "recording" || c.meetingState === "transcribing")
    return { run: false, reason: `meeting ${c.meetingState}` };

  if (c.lastFailureAt && c.now - c.lastFailureAt < AUTO_UPDATE_RETRY_SECONDS)
    return { run: false, reason: "backing off after a failed attempt" };

  // A version that was attempted and is still on offer means the upgrade did
  // not take. Retrying every tick would fork a brew process forever.
  if (c.lastAttempt?.version === c.latest
      && c.now - c.lastAttempt.at < AUTO_UPDATE_SAME_VERSION_SECONDS)
    return { run: false, reason: "already attempted this version recently" };

  return { run: true, reason: `updating ${c.current} → ${c.latest}` };
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
