# Meet Speaker Attribution via Browser Extension — Design

**Date:** 2026-09-01 · **Status:** approved ·
**Depends on:** the commit-gate rescue fix (same day, branch
`fix/meeting-commit-gate-rescue`) landing first.

## Goal

Attribute meeting transcript lines to **named people** instead of the
`Me`/`Others` two-channel split, for Google Meet calls in Chrome.

Non-goal for v1: Zoom, Teams, Webex, and in-person meetings. They keep
today's behaviour unchanged. This is a Meet-only upgrade, and the spec
should not pretend otherwise — the largest attribution failure on record
(the 2026-08-06 in-person session, 1,211 `Me:` against 31 `Others:`) is
**not** addressed by this work.

## Why an extension — the alternatives were tested, not assumed

All four were probed live against real Meet calls on 2026-09-01. Recorded
here because "we didn't think of it" and "we tried it and it doesn't work"
should not be confusable a year from now.

| Approach | Result |
|---|---|
| **Active-speaker state via macOS AX** | **Not available.** Tested with 2 participants, People panel open, names populated, 30s of speech: zero speaking/muted/presenting markers, no state change. Meet's video tiles are not accessibility objects. |
| Force full AX tree (`AXManualAccessibility`) | **Impossible.** Chrome returns `-25205` (attribute unsupported); node count unchanged (~334). No way to deepen the tree. |
| Captions via AX | **Works** — the captions ARIA live region streams text with a speaker label. Rejected as the primary mechanism: requires the user to enable captions manually (off by default, and does not persist across calls — observed), and ties attribution to Google's ASR. |
| Participant roster via AX | **Works, insufficient.** Names are readable, but only while the People side panel is open, and it says who is *present*, not who is *talking*. |

Speaker diarization on the recorded audio (WhisperKit vendors
SpeakerKit/Pyannote) is **explicitly parked** by maintainer decision —
reliability questions to be answered separately. It is the only path that
would cover Zoom/Teams/in-person, so this decision is worth revisiting; it
is not superseded by this spec.

Transport is a **native messaging host**, not a local HTTP/WebSocket
server: it avoids opening a listening port, matching the fail-closed
posture of the rest of the capture agent. Verified 2026-09-01 that this
machine's Chrome has no managed policy blocking extensions or user-level
native hosts (six are already installed, including Granola's).

## Architecture

```
Meet tab (content script)
  → background service worker  (long-lived native port)
    → native messaging host    (small Swift stdio binary)
      → FILE DROP in the session dir
        → shyn-meeting agent   (reads each tick / at transcribe time)
```

**File drop, not daemon RPC.** The daemon is the corpus: durable,
searchable documents. Live call presence and an ephemeral speaker timeline
are neither, and routing them through the daemon breaks three things:

1. **The purge promise.** Speaker events are meeting content with real
   names. Shipped to the daemon as they arrive, they would survive
   `shyn meeting cancel`, survive the `paused`/`excludedApp` branch that
   explicitly discards live recordings "privacy first", and survive a
   phantom purge. Writing them into the **session dir** instead means
   `purgeAudio(sessionDir:)` deletes them with the WAVs on every path, for
   free.
2. **Daemon-restart resilience.** `lastAgentPost`/`lastCaptureStats` are
   memory-only by design. The audio path already survives a dead daemon
   (ring buffer, sidecars); a daemon-routed speaker path would not.
3. **A retention race.** Transcription can start hours later
   (`retryPendingTranscription`) while the retention sweep runs hourly.

## Components

1. **`packages/meet-extension/`** — MV3, `host_permissions:
   ["https://meet.google.com/*"]` only. No `tabs`, no `activeTab`, no
   `<all_urls>`. Content script + background service worker.
   **Not** `extension/` — that path is already the Claude Desktop MCPB
   bundle.
2. **Native messaging host** — small Swift stdio binary, packaged like the
   existing `shyn-meeting`/`shyn-capture` apps, manifest written by
   `shyn setup` into Chrome's `NativeMessagingHosts/`. Pins the extension
   ID in `allowed_origins`; the extension pins a `"key"` in its manifest so
   the ID is stable across reloads.
3. **`shyn-meeting` changes** — consume presence each tick; consume the
   speaker timeline at transcribe time.
4. **Merge (CaptureCore, pure)** — attach names to segments. Unit-testable
   with no browser involved.

## Data flow

### Speaker timeline (the point of the feature)

Content script observes Meet's active-speaker DOM state and the
participant roster, emitting `{v, callId, speaker, tsStart, tsEnd}` spans.
These are drained into `sessionDir/speakers.jsonl` by the agent each tick
while recording.

At transcribe time the agent loads that file, maps wall-clock to audio
time, and attaches names to `.others` segments.

**Clock alignment is mandatory and currently missing.** Whisper segment
`start` is seconds into `system.wav`; speaker events are wall-clock epoch.
`sessionStart` is captured in `startPreroll` *before* `recorder.start()`,
which then starts the tap and may await mic authorization — so
`system.wav` t=0 is an unmeasured offset after `sessionStart`. Fix:
`AudioRecorder` captures the wall-clock instant immediately after the
system tap starts (`systemEpochZero`) and the merge uses that. Every merge
inherits the bias otherwise.

**Merge rules:**
- Match a `.others` segment to the speaker span covering its midpoint.
- **Refuse on ambiguity.** If two or more distinct speakers overlap one
  Whisper segment (Whisper does not split on speaker change), label it
  `Others`. Never guess. This mirrors `farSideLabel`'s existing rule that
  `named` requires *exactly one* other participant — attributing a
  sentence to the wrong person is the failure class the whole
  `unattributed` design exists to prevent.
- **Never name a `.me` segment** from this data, and drop spans whose
  speaker is the current user.
- Route names through `attendeeDisplayName` so no email address can enter
  by this path.
- No speaker file, or the file covers only part of the call → fall back to
  today's `Me`/`Others`/`unattributed`/named-1:1 for the uncovered part.
  Captions-style partial coverage is fine and expected.
- Add a `speakerNote` marking the transcript as caption/extension-derived
  attribution. These documents are read by an LLM over MCP, which will
  otherwise assert "X said Y" as fact.

### Presence (secondary)

Content script heartbeats while a call is live (leave-call control present
vs. pre-join lobby), written to
`~/Library/Application Support/shyn/meet/presence-<profile>.json`, one file
per writer so two Chrome profiles never race. The agent unions them and
treats `now - ts > 45s` as stale.

**Hard rule: presence may START and COMMIT a session; it must NEVER END
one.** If Chrome crashes, the extension is disabled, or the worker is
killed, presence goes stale — that must not discard a live recording.
`endSilenceSeconds` already handles ending and has no "browser died"
failure mode.

Presence is **additive only**. Its marginal value is now small, since the
commit-gate rescue fix already recovers the muted-listener case via
CoreAudio output-stream attribution. Build it last; consider dropping it.

### callId scoping

Two Chrome profiles in two different calls simultaneously is realistic
(work + personal). shyn records one session. Rule: pick the single
`callId` whose presence window best overlaps the session; **if two callIds
each overlap ≥ 50% of the session, attach no names at all.** Reuse
`matchMeetingEvent`'s existing ≥-half threshold rather than inventing a
second one. Dedupe on `(callId, speaker, tsStart)` — the same call open in
two tabs is a common accident.

## Error handling and degradation

**MV3 service-worker lifetime.** An active `runtime.connect` port keeps the
worker alive, and a native port qualifies — self-sustaining exactly while a
call is live. Do not rely on it alone: put the heartbeat `setInterval` in
the **content script** (never suspended), reconnect on port disconnect, and
use a 15s heartbeat with a 45–60s TTL. `chrome.alarms` has a 30s floor and
cannot drive this. Verify injection works in the **Chrome PWA/app-window**
context — observed Meet calls run as the PWA
(`com.google.Chrome.app.kjgfgldnnfoeklkmfkjfagphfepbbdan`, observed), not a
normal tab.

**Silent scraper breakage is the most likely long-term failure.** Google
changes this DOM without notice. Four requirements:

1. **Selector tiers**, tried in order, winning tier recorded per session:
   ARIA/role attributes first (an accessibility contract Google has
   obligations around), then `jsname`/`jscontroller`, then a structural
   heuristic.
2. **A liveness assertion, not just an error handler.** The killer failure
   is "observer attached, zero events ever produced". If presence has been
   active ≥ 5 minutes and zero speaker spans were emitted, log
   operator-visibly — *not* behind `SHYN_MEETING_DEBUG`. This is the
   lesson `finishCalendarSync` already records: a new subsystem whose only
   feedback is behind a debug flag cannot be told apart from one that never
   ran. Surface `speakerSpansSeen` in `MeetingStats`.
3. **Version the contract** (`v` per record) so a bad transcript months
   later is traceable to a scraper generation.
4. **Distinguish "nobody spoke" from "scraper broken"** — they look
   identical to a MutationObserver.

## Privacy and consent

- Speaker data lives in the session dir and is purged with the audio on
  every path: cancel, pause, excluded-app, phantom purge, post-ingest.
- Names are roster names, routed through `attendeeDisplayName`; no email
  addresses.
- Observer scoped to the participant/speaker UI only — never the chat
  panel.
- Nothing leaves the machine: extension → native host → local file.
- **Third-party sensitivity escalates here, deliberately.** The audio path
  already records others; this adds *named* attribution, which materially
  changes how sensitive the stored artifact is. Recorded as an accepted
  trade-off rather than arriving as a side effect.
- Ships config-flagged, default off, until the live checklist passes.

## Testing

- **Merge: pure and unit-tested** — golden-file tests from a real call plus
  a speaker-span fixture. Includes the multi-speaker-in-one-segment refusal
  and the two-profile no-attribution case.
- **Clock alignment**: `systemEpochZero` correctness test.
- **Scraper: record-and-replay.** Capture one real MutationRecord sequence
  as a fixture and run the parser against it in CI. It will go stale when
  Google changes the DOM; the point is catching *parser* regressions.
- **A dry-run period.** A flag that collects spans and logs a diff against
  the shipped transcript **without merging**. Read the diffs across real
  meetings, then tune. This is the "harness before real work" equivalent
  for a non-audio change, and it is cheap.
- **New section in `docs/meeting-verification.md`**: extension disabled
  (exact current behaviour), enabled mid-call, Chrome quit mid-call
  (recording must survive), both profiles live, PWA vs. normal tab.

## Open risks

1. Meet's DOM will change without notice. Tiers + a loud liveness signal
   mitigate; they do not eliminate.
2. Chrome Web Store distribution is unaddressed here — unlisted vs. listed,
   review latency, and how `shyn setup` handles a missing extension all
   need answering before ship.
3. Enterprise policy is clear on *this* machine but not for other users;
   `NativeMessagingUserLevelHosts: false` would break the host for them.
   Detect and report rather than fail silently.
4. Zoom, Teams and in-person meetings remain unattributed. The parked
   diarization decision is the only thing that closes that gap.
5. `ensureMicAlive()` restarts the mic engine without silence padding, so
   the mic timeline compresses relative to wall clock after a dropout
   (pre-existing; logged separately in `known-issues.md`). The merge
   touches only `.others` so it dodges this, but any future mic-side
   attribution inherits it.
