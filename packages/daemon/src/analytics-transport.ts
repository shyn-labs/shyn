import type { AnalyticsRecord } from "./analytics.js";

// PostHog Cloud transport.
//
// OPEN DECISION (2026-09-01): how the project key reaches a shipped build.
// PostHog project keys are write-only ingest keys and are designed to be
// public — every web SDK embeds one in client JS. So a literal in source is
// the normal pattern for this specific kind of key, and a key inside a
// distributed binary is extractable no matter what we do.
//
// It is NOT in source here anyway, for two reasons: shyn's repo is public and
// the project's standing rule is that credentials live as references rather
// than literals; and leaving it out keeps the choice reversible. Until it is
// decided, the key comes from the environment and an ABSENT key simply means
// no transport — the queue still works, still scrubs, still respects consent,
// and drops its batches. That is a deliberately safe default: a
// misconfigured build sends nothing rather than sending somewhere wrong.
const KEY = process.env.SHYN_POSTHOG_KEY;
// Default US because shyn's project is US. The region is NOT cosmetic and a
// wrong one cannot be noticed at runtime: PostHog's ingest endpoint answers
// 200 from either region whether or not the key belongs to it, so a
// misregioned build looks perfectly healthy and drops every event. Verified
// 2026-09-01 by posting the same key to both hosts — both returned
// {"status":"Ok"}. Override via SHYN_POSTHOG_HOST if the project moves.
const HOST = process.env.SHYN_POSTHOG_HOST ?? "https://us.i.posthog.com";

export const analyticsTransportConfigured = (): boolean => !!KEY;

/// Batch-send to PostHog's capture endpoint. Returns normally on success;
/// THROWS on failure so AnalyticsQueue re-queues the batch.
export function makeAnalyticsSender(): (batch: AnalyticsRecord[]) => Promise<void> {
  return async (batch) => {
    if (!KEY) return;   // no transport configured: drop, do not retry forever
    const res = await fetch(`${HOST}/batch/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // PostHog's batch shape. `distinct_id` is the anonymous install id and
      // nothing else — no email, no hostname, no hardware identifier.
      body: JSON.stringify({
        api_key: KEY,
        batch: batch.map((r) => ({
          event: r.event,
          distinct_id: r.installId,
          timestamp: new Date(r.ts * 1000).toISOString(),
          properties: { ...r.properties, $process_person_profile: false },
        })),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`posthog ${res.status}`);
  };
}

/// How this copy of shyn was installed. Inferred from the binary's path —
/// the cask installs under the Homebrew prefix.
export function detectInstallMethod(): "brew" | "manual" | "unknown" {
  try {
    const p = process.execPath;
    if (p.includes("/Caskroom/") || p.includes("/opt/homebrew/")) return "brew";
    return "manual";
  } catch { return "unknown"; }
}

/// Ten minutes: frequent enough that a crash shortly after an event still
/// ships it, rare enough to be invisible on battery.
export const ANALYTICS_FLUSH_MS = 10 * 60 * 1000;
