// Browser-safe half of the update machinery: imported by the renderer
// bundle (platform: "browser" — no node builtins allowed) and by derive.
// Filesystem/spawn helpers live in update.ts, which re-exports this file.

// NO `brew update`. It git-pulls into /opt/homebrew, and this command runs
// UNATTENDED at whatever hour the check fires — 02:08 on 2026-08-09, when an
// interruption left Homebrew's working tree gutted: bin/brew and
// Library/Homebrew/brew.sh deleted while Cellar and every shim survived, so the
// package manager was dead and only a `git checkout` inside /opt/homebrew
// brought it back. Damaging a system-wide tool is not an acceptable failure
// mode for a memory app's updater; the worst a failed upgrade should do is not
// upgrade.
//
// Dropping it is safe because the cask is version-pinned: `brew upgrade --cask`
// installs whatever the already-fetched tap says. If the tap is stale the
// upgrade is a no-op and the next check — six hours later — picks it up once
// Homebrew has refreshed itself on its own schedule. A rare delay in exchange
// for never touching Homebrew's own repository unattended.
export const UPGRADE_COMMAND = "brew upgrade --cask shyn && shyn setup";

// How often the status app re-checks for a release. Was 24h until 0.4.21, which
// meant a hotfix could sit unseen for a day — three releases shipped in one
// afternoon on 2026-08-05 and any of them could have been urgent.
//
// 6h costs 4 unauthenticated GitHub API calls per day against a 60/hour limit,
// so the budget is not the constraint; restraint is. Anything much shorter is
// polling someone else's API for no benefit, since releases are cut by hand.
export const UPDATE_CHECK_INTERVAL_MS = 6 * 3600 * 1000;

// MUST be the list endpoint, not /releases/latest. GitHub's "latest" excludes
// prereleases, and every shyn release is cut with `gh release create
// --prerelease` — so /releases/latest returned **404 Not Found** and the update
// check silently returned null from 0.4.14 (when it was written) until 0.4.20.
// Nobody noticed because a failed check is indistinguishable from "up to date".
// The list endpoint includes prereleases, newest first.
export const RELEASES_URL =
  "https://api.github.com/repos/shyn-labs/homebrew-tap/releases?per_page=10";

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

// --- Notice channel (2026-08-06) -------------------------------------------
//
// A one-way message from the maintainer to installed copies, carried in the
// release BODY of the newest release. Deliberately not a new endpoint: the app
// already fetches the release list every 24h, so this adds no network call, no
// new domain, and no privacy surface to a product whose daemon and agents never
// touch the network. It also inherits the existing `updateCheck: false` opt-out.
//
// Hard limit worth stating: this can only reach builds that ALREADY poll. It
// could not have rescued 0.4.14–0.4.19, whose release check was broken — you
// cannot fix a client by pushing to it. For those, the package manager
// (`brew upgrade`) is the only channel.
//
// Format, in the release body:
//   <!-- shyn-notice: severity=warn appliesTo=<0.4.20
//   Update required: builds before 0.4.20 cannot detect updates.
//   Run: brew upgrade --cask shyn-labs/tap/shyn
//   -->
//
// `appliesTo` (added 0.4.23) exists because the first notice shipped without it
// and was therefore shown to EVERY build, including the ones it did not apply
// to — the text said "if yours is older" while the code showed it regardless.
// A message whose audience is not expressed in the marker is a nag by
// construction, so state the range and let the app suppress it elsewhere.
export type NoticeRange = { op: "<" | "<=" | ">" | ">=" | "="; version: string };
export type Notice = {
  severity: "info" | "warn";
  text: string;
  /** Which builds this is for. Absent = everyone. */
  appliesTo?: NoticeRange;
  /** Stable id for dismissal, derived from the text. */
  key: string;
};

// Non-crypto, deliberately: this only has to be stable and agree between the
// main process and the renderer, and update-core must stay browser-safe (no
// node:crypto). Collisions are harmless — worst case one notice hides another.
export function noticeKey(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (((h << 5) + h) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// True when the notice targets this build. A MALFORMED range fails OPEN (shows
// the notice) on purpose: hiding it would fail silently — the message never
// lands and the maintainer never learns the expression was wrong — whereas
// showing it is visible and self-correcting.
export function noticeApplies(n: Notice, currentVersion: string): boolean {
  if (!n.appliesTo) return true;
  const cmp = compareShynVersions(currentVersion, n.appliesTo.version);
  if (cmp === null) {
    console.error(`[update] notice appliesTo unusable against "${currentVersion}" — showing anyway`);
    return true;
  }
  switch (n.appliesTo.op) {
    case "<":  return cmp < 0;
    case "<=": return cmp <= 0;
    case ">":  return cmp > 0;
    case ">=": return cmp >= 0;
    case "=":  return cmp === 0;
  }
}

/** Popover rows are one line; a maintainer pasting an essay gets truncated. */
export const NOTICE_MAX_CHARS = 240;

export function parseNotice(body: unknown): Notice | null {
  if (typeof body !== "string") return null;
  const m = body.match(/<!--\s*shyn-notice:([\s\S]*?)-->/);
  if (!m) return null;
  let inner = m[1];
  // Optional leading `severity=info|warn` on the first line; anything else is text.
  let severity: Notice["severity"] = "info";
  const sev = inner.match(/^\s*severity\s*=\s*(info|warn)\b/);
  if (sev) {
    severity = sev[1] as Notice["severity"];
    inner = inner.slice(sev[0].length);
  }
  // Optional `appliesTo=<0.4.20` (or <=, >, >=, =) after severity.
  let appliesTo: NoticeRange | undefined;
  const range = inner.match(/^\s*appliesTo\s*=\s*(<=|>=|<|>|=)\s*v?([0-9][^\s]*)/);
  if (range) {
    appliesTo = { op: range[1] as NoticeRange["op"], version: range[2] };
    inner = inner.slice(range[0].length);
  }
  // Collapse to a single line: the row is one line, and a stray newline in a
  // comment should not become a layout bug.
  const text = inner.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const clipped = text.length > NOTICE_MAX_CHARS
    ? `${text.slice(0, NOTICE_MAX_CHARS - 1)}…` : text;
  return { severity, text: clipped, appliesTo, key: noticeKey(clipped) };
}

export type LatestRelease = { version: string; notice: Notice | null };

// Returns null on every failure — offline is a normal state, not a warning — but
// LOGS the reason. Silence is what let a permanently-broken check (see
// RELEASES_URL) masquerade as "you are up to date" for six releases; the log line
// costs nothing and makes the next such failure diagnosable from status.log.
export async function checkLatest(fetchFn: typeof fetch): Promise<LatestRelease | null> {
  try {
    const r = await fetchFn(RELEASES_URL, { headers: { accept: "application/vnd.github+json" } });
    if (!r.ok) {
      console.error(`[update] release check failed: HTTP ${r.status}`);
      return null;
    }
    const body = await r.json();
    if (!Array.isArray(body)) {
      console.error("[update] release check failed: expected an array of releases");
      return null;
    }
    // Newest first, drafts excluded. Prereleases are KEPT — every shyn release
    // is one, so filtering them out would leave nothing.
    const rel = body.find((r: unknown) =>
      typeof (r as { tag_name?: unknown })?.tag_name === "string"
      && (r as { tag_name: string }).tag_name.length > 0
      && (r as { draft?: unknown }).draft !== true);
    if (!rel) {
      console.error("[update] release check found no usable release");
      return null;
    }
    return {
      version: (rel as { tag_name: string }).tag_name.replace(/^v/, ""),
      notice: parseNotice((rel as { body?: unknown }).body),
    };
  } catch (e) {
    console.error(`[update] release check failed: ${(e as Error)?.message ?? e}`);
    return null;
  }
}
