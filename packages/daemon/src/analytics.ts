// Anonymized usage analytics — the ONLY code path in shyn that sends
// anything off the machine.
//
// That makes this file a privacy boundary, not just a feature. The design
// rules, in priority order:
//
//   1. ONE egress point. Agents and the CLI report to the daemon; the daemon
//      is the only thing that talks to the network. Multiple senders would
//      make "what actually leaves this machine" unauditable, which is the
//      question that matters most for this product.
//   2. Event names are a CLOSED ENUM. A name built by interpolation is how
//      corpus content escapes; there is no code path that accepts one.
//   3. Properties are allow-listed by shape, not denied by pattern. Anything
//      not obviously safe is dropped rather than guessed at.
//   4. Off means off IMMEDIATELY, including anything already queued.
//
// Design: docs/superpowers/specs/2026-09-01-analytics-telemetry-design.md

/// The complete set of events that may ever be sent. Adding a name here is
/// the deliberate act that makes it sendable — nothing else can.
export const ANALYTICS_EVENTS = [
  // feature / command usage (shape only, never content)
  "search_memory_called",
  "remember_called",
  "recent_activity_called",
  "get_document_called",
  "forget_called",
  "cli_command_run",
  "mcp_client_connected",
  // capture sources
  "meeting_capture_started",
  "meeting_capture_committed",
  "meeting_capture_purged",
  "screen_capture_shipped",
  "browser_capture_shipped",
  "calendar_sync_completed",
  // crashes / errors
  "agent_crashed",
  "daemon_error",
  "transcription_failed",
  // install / version
  "daemon_started",
  "version_upgraded",
  // performance
  "search_latency_sampled",
  "embed_latency_sampled",
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

const KNOWN = new Set<string>(ANALYTICS_EVENTS);
export const isKnownEvent = (name: string): name is AnalyticsEventName => KNOWN.has(name);

// --- Scrubbing -------------------------------------------------------------

// Ported from CaptureCore's `containsSecret` (Gate.swift). The Swift backstop
// cannot be reused across the language boundary, so the pattern list is
// duplicated here deliberately; keep the two in sync when either changes.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /cfat_[A-Za-z0-9_-]{20,}/,
  /ghp_[A-Za-z0-9]{36}/,
  /github_pat_[A-Za-z0-9_]{22,}/,
  /gh[osru]_[A-Za-z0-9]{36}/,
  /sk-(ant-)?[A-Za-z0-9-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /(sk|rk|pk)_live_[0-9A-Za-z]{20,}/,
];

// Property keys whose STRING values are allowed through, and the closed set
// of values each may take. Everything else that is a string gets dropped.
//
// Allow-list rather than deny-list on purpose: a deny-list has to anticipate
// every shape of content, and the cost of being wrong here is shipping
// someone's document title or search query to a third party.
const ALLOWED_STRING_VALUES: Record<string, ReadonlySet<string>> = {
  source: new Set(["file", "browser", "notes", "conversation", "screen", "meeting", "calendar"]),
  agent: new Set(["meeting", "screen", "capture", "daemon", "mcp", "cli"]),
  outcome: new Set(["ok", "error", "timeout", "cancelled", "purged"]),
  install_method: new Set(["brew", "manual", "unknown"]),
};

// Free-text properties that are USEFUL for debugging (error messages, stack
// traces) and therefore cannot simply be dropped. Scrubbed hard instead:
// credentials redacted, home paths anonymized, truncated.
const SCRUBBED_TEXT_KEYS = new Set(["message", "stack", "code", "error"]);

function scrubText(raw: string): string {
  let s = raw;
  for (const p of SECRET_PATTERNS) s = s.replace(new RegExp(p.source, "g"), "[redacted]");
  // /Users/<name>/... carries both the username and the user's folder names,
  // which are frequently project or client names.
  s = s.replace(/\/Users\/[^/\s]+(\/[^\s:)]*)?/g, "/Users/[redacted]");
  s = s.replace(/\/home\/[^/\s]+(\/[^\s:)]*)?/g, "/home/[redacted]");
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
}

/// Reduce a property bag to what is safe to send. Numbers and booleans pass
/// (they cannot carry content); strings pass only if allow-listed or
/// scrubbable; everything else is dropped.
export function scrubProperties(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (typeof v === "number" || typeof v === "boolean") { out[k] = v; continue; }
    if (typeof v !== "string") continue;                    // objects/arrays: dropped
    if (SCRUBBED_TEXT_KEYS.has(k)) { out[k] = scrubText(v); continue; }
    const allowed = ALLOWED_STRING_VALUES[k];
    if (allowed?.has(v)) out[k] = v;                        // else: dropped
  }
  return out;
}

// --- Queue -----------------------------------------------------------------

export interface AnalyticsRecord {
  event: AnalyticsEventName;
  properties: Record<string, unknown>;
  installId: string;
  ts: number;
}

// An offline machine must not grow this without bound. Oldest-first drop:
// recent events are the ones that describe the current version's behaviour.
const MAX_PENDING = 1000;

export class AnalyticsQueue {
  private queue: AnalyticsRecord[] = [];
  private enabled: boolean;
  private readonly installId: string;
  private readonly send: (batch: AnalyticsRecord[]) => Promise<void>;

  constructor(opts: {
    enabled: boolean;
    installId: string;
    send: (batch: AnalyticsRecord[]) => Promise<void>;
  }) {
    this.enabled = opts.enabled;
    this.installId = opts.installId;
    this.send = opts.send;
  }

  pending(): number { return this.queue.length; }

  /// Toggling off DISCARDS the backlog. A user who opts out must not have
  /// the last few minutes shipped anyway — the promise is "off", not
  /// "off after one more batch".
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.queue = [];
  }

  track(event: AnalyticsEventName, properties: Record<string, unknown> = {}): void {
    if (!this.enabled) return;
    if (!isKnownEvent(event)) return;         // closed enum, silently dropped
    this.queue.push({
      event, properties: scrubProperties(properties),
      installId: this.installId, ts: Math.floor(Date.now() / 1000),
    });
    if (this.queue.length > MAX_PENDING) this.queue.splice(0, this.queue.length - MAX_PENDING);
  }

  /// Best-effort. A failed send retains the batch for the next attempt and
  /// never throws: analytics must not be able to take the daemon down or
  /// surface an error to a user who never asked for this feature.
  async flush(): Promise<void> {
    if (!this.enabled || this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    try {
      await this.send(batch);
    } catch {
      // Re-queue at the front, still bounded.
      this.queue = [...batch, ...this.queue].slice(0, MAX_PENDING);
    }
  }
}
