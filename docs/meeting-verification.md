# Meeting transcription — live verification (SP3, Task 12)

Run on the real machine after `shyn install`. Every step must be recorded
with its observed result before SP3 is called done (exit criteria mirror
`docs/superpowers/specs/2026-07-10-meeting-transcription-design.md`).

Context from the spike (`spikes/meeting-probe/README.md`):
- System audio comes from a **CoreAudio process tap**, not ScreenCaptureKit
  (SCK audio is dead on macOS 26.5). Grants needed: **Microphone** and
  **Screen & System Audio Recording** (the audio half; no screen grant is
  actually used).
- **SentinelOne caveat:** S1 quarantined the spike's probe binary on
  execution (binary deleted out of the signed bundle, plist removed).
  `shyn-capture.app` staged by `shyn install` has been tolerated so far —
  if `shyn-meeting.app` disappears after install (symptom: `shyn meeting
  status` says `not-reporting`, `~/.shyn/bin/...MacOS/` empty, LaunchAgents
  plist gone), an S1 exclusion for `~/Library/Application Support/shyn/`
  (or the "Shyn Dev" identity) is required from IT. See
  `docs/known-issues.md` (SP3 section).

## Checklist

1. [ ] **Install.** `bash scripts/setup-signing.sh` (once) →
   `SHYN_CODESIGN_IDENTITY="Shyn Dev" pnpm build-capture && pnpm build:dist`
   → `shyn install`. Verify all three services print `installed and
   started`; verify the staged binary still exists ~2 min later
   (SentinelOne check):
   `ls "$HOME/Library/Application Support/shyn/bin/shyn-meeting.app/Contents/MacOS/"`.
2. [ ] **Grants.** System Settings → Privacy & Security: `shyn-meeting`
   toggled ON under **Microphone** and **Screen & System Audio Recording**
   (approve the prompts on the agent's first detection instead, if shown).
3. [ ] **Detection + grace.** Join a real (or played-back) call with speech
   both directions. Within ~10s of both mic and system audio being live, a
   "Meeting detected" notification appears; recording starts ~10s later
   unless `shyn meeting cancel`. `shyn meeting status` shows
   `"state": "recording"`.
4. [ ] **Transcript lands.** End the call (or `shyn meeting stop`). Within
   the transcription window (≈ minutes; model downloads on first use —
   `modelReady` in `shyn meeting status`): `capture.meeting.meetingsCaptured`
   increments; `shyn search "<something said>"` returns a `meeting` doc
   titled `<App> meeting · <local datetime>` with `Me:`/`Others:` labels.
   Record transcript quality (incl. any Hindi/Hinglish spoken — expected:
   English gist, see spike accuracy notes).
5. [ ] **Audio purge (byte-honest).**
   `ls "$HOME/Library/Application Support/shyn/meeting-tmp"` is empty after
   ingest. Kill the agent mid-recording (`launchctl kickstart -k
   gui/$(id -u)/com.shyn.meeting` while recording), restart: orphaned
   session dir swept at startup (>24h) or purged on next completed cycle.
6. [ ] **Consent controls.** During grace: `shyn meeting cancel` → no
   transcript, session dir gone. `shyn pause 30m` → detection stops and a
   live recording is canceled+purged (privacy-first); `shyn resume`
   restores. An app in `capture.json`'s `meeting.excludeApps` frontmost →
   no recording of that call.
7. [ ] **Daemon-down buffering.** Stop the daemon mid-meeting; end the
   meeting → transcript buffered (audio retained); start the daemon →
   transcript lands on a later tick, audio then purged. No audio bytes ever
   cross the socket (transcript-only ingest payload).
8. [ ] **Grant persistence.** Rebuild + `shyn install` again (same "Shyn
   Dev" identity) → mic/system-audio grants still effective, no re-prompt.

## Results

Run 2026-07-10 (macOS 26.5.1, M-series, SentinelOne active):

1. **Install: PASS.** All three services installed and started; meeting
   agent ran headless under launchd; staged binary + plist intact after
   2 min (SentinelOne tolerated the properly-installed app — quarantine
   only ever hit the spike's ad-hoc-staged probe).
2. **Grants: PASS.** Mic + system-audio prompts appeared on first
   recording start and were approved; both reflected in
   `shyn meeting status` (`tcc: { mic: true, audio: true }`).
3. **Detection + grace: PASS.** Real Google Meet call (Chrome PWA);
   detection → candidate → recording; `state: "recording"` in status;
   session WAVs grew in `meeting-tmp/session-<ts>` (mic 9 MB / system
   56 MB over ~5 min).
4. **Transcript: PASS (with findings fixed).** `shyn meeting stop` ended
   the session; model (~482 MB) downloaded on first use; transcript landed
   as `meeting://…/2026-07-10-1519`, title "Google Meet meeting · 10 Jul
   2026 at 15:19", searchable in hybrid mode with `Me:`/`Others:` labels;
   spoken phrase ("quarterly retention decision") found. Hindi/Hinglish
   not exercised (English call). Findings fixed on the branch during this
   run: auto-end never fired (agent's own taps kept the device probes
   active — replaced with recorded-audio ActivityMeter), [BLANK_AUDIO]/
   [Pause] filler segments (now filtered), agent hang when the daemon
   restarts mid-tick (DaemonClient .waiting fail-fast), status stuck on
   "recording" during minutes-long transcription (posts "transcribing").
5. **Audio purge: PASS** (post-ingest: `meeting-tmp` empty; transcript
   ingested). Mid-record kill + 24h orphan sweep: covered by
   `sweepOrphanAudio` at startup; not separately exercised live.
6. **Consent: PARTIAL.** `shyn meeting stop` verified live (control file
   consumed, session ended + transcribed). `cancel` and `pause`/exclude
   paths are unit-tested; not exercised live.
7. **Daemon-down buffering: NOT exercised live.** Ring-buffer + retry
   covered by design and unit tests; the daemon-restart hang it exposed
   was found and fixed (see 4).
8. **Grant persistence: PASS (mic).** Rebuild + reinstall with the same
   "Shyn Dev" identity → agent reported within seconds, `mic: true`
   without re-prompt. System-audio grant re-confirms on next recording.

**Auto-end (60s silence) with the ActivityMeter fix is the one behavior
not yet observed live** — verify on the next natural meeting: after the
call ends, `shyn meeting status` should go recording → transcribing →
idle without a manual `stop`.

## SP8 transcript fidelity — live checks (2026-08-05, PENDING)

Prompted by reading back a real captured meeting (4 Aug 2026): the transcript
double-transcribed the far end onto the mic channel and labeled half of it
`Me`, the doc title fell back to `Google Meet meeting · 4 Aug 2026 at 16:03`
(so it could not be found by searching the meeting name), and `meeting.log`
held one undatable transcriber failure.

Run these on the next real meeting, **on laptop speakers** (headphones hide
the bleed this is meant to fix), with `SHYN_MEETING_DEBUG=1`:

1. [x] **AEC — FAILED, REVERTED in 0.4.19 (2026-08-05).** Verified on hardware
   the hard way: during a real call on the laptop mic the user heard a persistent
   tone rising and falling. AUVoiceProcessingIO reconfigures the SHARED input
   device, so its AGC and a tone reached the live call, not just our recording.
   Voice processing, the `start(echoCancellation:)` parameter and the config flag
   are all removed. Speaker→mic bleed stays handled by `dropEchoDuplicates`.
   Full post-mortem in `docs/known-issues.md`. **Never test an audio-path change
   on real work again — build a `say`-through-speakers harness first.**
2. [ ] **No duplicate pairs.** The shipped transcript must not contain
   near-identical `Me:`/`Others:` lines seconds apart. (Short affirmations are
   exempt by design.)
3. [ ] **Title.** Doc title carries the real meeting name. The `stamp:` debug
   line names which source won (eventkit / window / none) plus the Calendars
   TCC state; `none` with a real meeting open is the case to chase.
4. [ ] **Searchability.** `search_memory` on the meeting's own name returns
   the meeting doc. This is the check that failed on 4 Aug.
5. [ ] **Log lines** carry an ISO-8601 local timestamp, and a transcriber
   failure appears without `SHYN_MEETING_DEBUG` set.
6. [ ] **Offline-failure drill.** Move `~/Library/Application
   Support/shyn/models/whisperkit` aside, go offline, record a 60s meeting,
   stop it. Expect: audio KEPT in `meeting-tmp`, `pending.json` written,
   failure logged. Restore the model, wait a tick, expect the retry to
   transcribe and ship, and `meeting-tmp` to end up empty.

## Commit-gate rescue (2026-09-01)

Motivated by a live loss: the 60-minute "Biochar Roadmap Review" on
Meet-in-Chrome (2026-08-31 15:35 IST) was purged whole —
`verification failed (mic=false sys=true) — phantom, purging` — because the
user listened silently and Chrome is deliberately absent from
`meetingBundleIds`. The gate now accepts three additional forms of evidence
(mic-unavailable, a conferencing app holding an input stream, a live
conferencing calendar event) and re-evaluates them every tick instead of
snapshotting at pre-roll.

These are property READS — no device opened, nothing shared reconfigured —
so the AEC class of risk does not apply. The harness is still cheap, so run
it before trusting the signal on real work.

**Harness (no real meeting at risk):** open a solo Meet room in Chrome, mute
yourself, and drive the far side with `say` through the speakers.

1. [ ] **Bundle ids are OBSERVED, not guessed.** With a muted Meet call live,
   dump the input holders and confirm a `com.google.Chrome*` process appears
   with `conferencing=true`. **This is the load-bearing assumption**: if
   Chrome releases the input stream while muted, the mic-attribution rescue
   does not fire for exactly the case it was built for, and the calendar
   term is carrying the fix alone. Record the real ids seen.
2. [ ] **The regression itself.** Muted + far-side voice for > grace+30s must
   COMMIT, not purge. `meeting.log` should show no `verification failed`
   line for that session.
3. [ ] **Phantom protection intact.** Play music/YouTube in Chrome with no
   call and no calendar event: must still purge at grace+30s
   (`rescue=false` in the log line).
4. [ ] **Calendar false positive.** During a scheduled call you did NOT join,
   play a video. The calendar term will fire — confirm the far-side-voice
   requirement still keeps this from committing silence, and note if a
   junk transcript ships anyway (that is the accepted trade of this term).
5. [ ] **Ambient mic-holders stay excluded.** With Granola / Wispr Flow
   running but no call, confirm they never appear as `conferencing=true`.
   (Observed 2026-09-01: both were running and held NO input stream, so
   they are on-demand grabbers, not permanent holders.)
6. [ ] **Dead-mic path.** Force the mic engine dead mid-session (switch input
   device); the session must still commit on system audio alone.
