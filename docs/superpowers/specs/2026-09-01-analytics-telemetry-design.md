# Shyn Anonymized Usage Analytics — Design

**Date:** 2026-09-01 · **Status:** approved ·
**Supersedes:** `2026-07-11-insights-diagnostics-design.md`'s telemetry
non-goal (see "Relationship to the July decision" below). The local
`stats`/`shyn diagnose` pieces of that doc are unaffected and stay as-is.

## Goal

Give the maintainer real visibility into "who's using what" across the
public install base — feature/command usage, crash reports, install/version
metadata, performance metrics — to fix bugs and maintain product quality.
This is a deliberate, disclosed addition of a network-facing capability to
a product whose pitch is "100% local, zero cloud, private by design," not
an incremental tweak. Treated with the corresponding weight.

## Relationship to the July decision

The 2026-07-11 insights/diagnostics design recorded, on the record: *"NO
server, NO endpoint, NO automated sending of anything, ever, in this
sub-project. If fleet telemetry is ever wanted, that is a separate,
deliberate future decision: opt-in at onboarding (default OFF),
company-hosted endpoint, inspectable payloads, and an honestly amended
README."* This is that deliberate future decision.

It departs from the July default in one respect, decided explicitly after
the tension was raised: instead of an unchecked opt-in prompt (default
OFF), the first-run dialog ships with the toggle **pre-checked** —
visible and disclosed, not buried in settings, but on for anyone who
doesn't touch it. This trades some of July's privacy-maximizing default
for materially better data coverage, while keeping the part of the July
decision that mattered most: nothing ships silently. The user sees the
toggle, in an explicit dialog, before any event leaves the machine.

The company-hosted-endpoint expectation is also revised: PostHog Cloud
(third-party SaaS) instead of a self-hosted endpoint, chosen for zero
ops burden. Data leaves shyn's own infra boundary; see "Privacy and
consent."

## Data collected

Four categories, each a **fixed enum of event names** — never freeform
strings, so corpus content has no path into an event:

1. **Feature/command usage** — which MCP tools get called
   (`search_memory`, `remember`, etc.), which capture sources are enabled
   (screen/browser/meeting/calendar), CLI command frequency. Shape of
   usage, never content — `search_memory_called`, never the query text.
2. **Crash reports / errors** — Swift/TS crash signatures, error codes,
   stack traces, scrubbed (see below) before leaving the process.
3. **Install/version metadata** — OS version, shyn version, install
   method (brew cask vs. manual), the anonymous install ID.
4. **Performance metrics** — the latency numbers already computed
   internally for eval gates (recall@5, p50/p95 query latency),
   aggregated across the install base instead of staying local to each
   maintainer eval run.

## Architecture

Centralize event emission in the **daemon**, not in each Swift agent or
CLI command. The daemon already aggregates heartbeats and `captureStats`
from every agent (mic, meeting, screen, browser, calendar) over the
existing `shyn.sock` — it's already the hub. Agents/CLI report structured
events to a new `analytics.track {event, properties}` RPC method; the
daemon batches and flushes to PostHog Cloud on an interval via
`posthog-node`.

Rejected: each component (CLI, each Swift agent) sending directly to
PostHog independently. That multiplies egress points, which makes "what
actually leaves this machine" — the single most important audit for this
product — much harder to reason about and enforce consistently. One
egress point, one place to kill-switch, one place to scrub.

## Identity

- On first daemon start (after consent — see below), generate a random
  UUID (`installId`), stored locally. Never derived from anything
  identifying: no email, no hostname, no hardware serial.
- Every event: `{event, properties, installId, shynVersion, os}`.

## Consent surface

- **First-run dialog**, not a buried settings toggle and not a silent
  default. States plainly what's collected (the four categories above)
  and where to change it later. Toggle **pre-checked on**.
- No `installId` is generated and no event is queued until the dialog has
  been shown and dismissed (either way) — consent state must exist before
  any data path can activate, even at the pre-checked default.
- Config flag `analytics.enabled` in the existing `capture.json`/
  `CaptureConfig`, mirrors the dialog's initial state, changeable anytime
  in settings after. Toggling off stops the flush loop immediately — same
  atomicity as the existing `pausedUntil` pattern; no in-flight batch
  sneaks out after a toggle-off.

## Scrubbing

Reuse existing infrastructure rather than build new:

- The `containsSecret` fail-closed backstop (`Gate.swift`) runs over any
  event property that could carry freeform text (error messages, stack
  traces) before it leaves the process.
- The identity-leak denylist (`~/.config/shyn/leak-denylist.txt`) is
  consulted the same way for analytics as it already is elsewhere.
- Stack traces get file paths and any embedded string literals stripped
  before transmission — signature and location only.

## Testing

- Daemon: unit tests for the batching/flush logic and the
  `analytics.enabled` kill-switch, including the in-flight-batch case.
- Consent gating: no `installId` and no queued event exist before the
  first-run dialog has been shown and answered.
- Scrubbing: extend the existing secret/denylist test suites to cover
  analytics event properties specifically.
- Manual: verify events land in the PostHog dashboard end-to-end from a
  real install; verify opt-out is immediate and durable across daemon
  restarts.

## Downstream doc changes (tracked here, not done in this spec)

- `extension/manifest.json`'s description ("Fully local ambient memory...
  only snippets relevant to questions you ask are shared with the AI you
  ask") becomes inaccurate the moment this ships and needs rewording.
- README's "100% local. Zero cloud. Private by design." line needs
  amending to accurately state what now leaves the machine, on what
  default, and how to disable it — an "honest amendment," per the July
  decision's own phrasing, not a quiet drop.
- shyn.day website copy likely carries the same claim and needs the same
  pass.
- These are implementation-plan line items, not resolved by this spec —
  the actual wording needs the real UI copy from the first-run dialog to
  stay consistent.

## Exit criteria

1. A fresh install shows the first-run dialog before any daemon-side
   analytics state exists; dismissing either way (on or off) is durable
   across restarts.
2. Toggling off in settings stops all outbound events immediately,
   including anything already batched.
3. No event payload, in a scrub test suite, contains corpus content,
   file-path PII, or an identifiable string from the leak denylist.
4. README, extension manifest, and website copy accurately describe the
   shipped behavior — no stale "zero cloud" claim survives launch.
