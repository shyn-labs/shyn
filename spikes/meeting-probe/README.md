# meeting-probe — SP3 Task 1 spike findings

Probe for the two SP3 unknowns: (a) headless signed LaunchAgent capturing
system audio (ScreenCaptureKit audio-only) + mic (AVAudioEngine) to WAV;
(b) WhisperKit accuracy/latency on English and Hindi/Hinglish meeting audio.

Machine: M-series, macOS (Darwin 25.5), WhisperKit **0.18.0** (pinned in
Package.resolved — Task 8 must pin the same), models auto-downloaded to
`~/Documents/huggingface/models/argmaxinc/whisperkit-coreml/`.

## Verdict

- **(b) Transcription: PASS** — with the `small` multilingual default as
  planned. Details and one behavioral caveat below.
- **(a) Capture: FALLBACK ADOPTED — CoreAudio process tap, validated
  interactively.** Mic capture (AVAudioEngine tap → WAV → WhisperKit round
  trip) PASS. **SCK `.audio` output is dead on macOS 26.5.1**: with every
  TCC grant in place (Screen & System Audio Recording toggle ON, verified
  in tccd logs), and tested both as a CLI-attributed process and as the
  signed `.app` launched via `open`, the stream runs, VIDEO frames flow,
  `didStopWithError` never fires — and zero audio callbacks arrive, ever.
  The plan-anticipated fallback — a CoreAudio **process tap**
  (`CATapDescription` + `AudioHardwareCreateProcessTap` + private aggregate
  device + IOProc, macOS 14.2+, see `SystemAudioTap.swift`) — captures
  system audio digitally: a played TTS clip transcribed near-verbatim from
  the tap's WAV. **Plan amendment: Task 8's AudioRecorder uses the process
  tap for system audio (copy `SystemAudioTap.swift`), NOT ScreenCaptureKit.
  Task 8/9/11 references to Screen Recording TCC become the audio-capture
  TCC (`NSAudioCaptureUsageDescription`, "Screen & System Audio Recording"
  pane).** Bonus: no screen-recording permission needed for meetings at
  all, and no monthly SCK re-approval nag. Headless-under-launchd could
  not be executed on this machine (SentinelOne quarantine, see repro
  section) — accepted: the tap+mic path has no WindowServer/SCK
  dependency, so the risk the headless test targeted no longer exists in
  the design; the EDR question moves to Task 12 live verification.

## Hard-won capture findings (Task 8 MUST honor these)

1. **Request mic TCC explicitly** (`AVCaptureDevice.requestAccess(for: .audio)`)
   before touching `AVAudioEngine.inputNode`. Without the grant the input
   node reports a 0 Hz format and `AVAudioConverter(from:to:)!` traps —
   silent SIGTRAP (exit 133), no prompt, no stderr.
2. **Never run AVAudioConverter inside the tap callback.** The manual
   convert-then-write pattern aborts inside CoreAudio (CAVerboseAbort on
   the RealtimeMessenger queue → C++ terminate, silent SIGTRAP). Write tap
   buffers directly to an `AVAudioFile` created with the WAV settings at
   the tap's NATIVE sample rate and the tap's processing format.
3. **AVAudioFile converts sample format but NOT sample rate.** Opening the
   file as 16 kHz while the tap runs at 48 kHz writes frames 1:1 under a
   wrong-rate header (plays 3× slow). Record at native rate; WhisperKit
   resamples on load.
4. **SCK ignores the requested audio format.** It delivers its own
   (48 kHz Float32 stereo *deinterleaved* here) regardless of
   `SCStreamConfiguration.sampleRate/channelCount`. Deinterleaved stereo
   = TWO AudioBuffers, so the C `CMSampleBufferGetAudioBufferList…` call
   with a fixed-size `AudioBufferList` fails silently. Use the Swift
   `CMSampleBuffer.withAudioBufferList` overlay (correctly sized) and
   create the output `AVAudioFile` lazily from the first buffer's format.
5. **The main run loop must be serviced** while capturing. Top-level
   `await Task.sleep` starves AppKit/XPC callback delivery; SP2's agent
   ends in `NSApplication.shared.run()` for the same reason. The probe
   pumps `RunLoop.main.run(mode:before:)` during capture windows.
6. **macOS 15+/26 TCC split:** Screen Recording ≠ System Audio Recording
   (`kTCCServiceScreenCapture` vs `kTCCServiceAudioCapture`). And on 26.5,
   SCK audio delivers nothing even WITH both grants (see Verdict) — hence
   the process-tap fallback. TCC attribution gotcha: a binary exec'd from a
   shell is attributed to its ancestor app, not its own bundle — test TCC
   behavior via `open <app>` or launchd, never by direct exec.
7. **Process tap specifics** (`SystemAudioTap.swift`): global tap via
   `CATapDescription(stereoGlobalTapButExcludeProcesses: [])`, `isPrivate`,
   unmuted; wrap in a private aggregate device (`TapList` + `TapAutoStart`);
   read format from `kAudioTapPropertyFormat` (48kHz Float32 interleaved
   stereo observed); IOProc's INPUT buffer list carries the tap audio.
   Exclude-own-process is a tap-description parameter for later dedup needs.

## WhisperKit API notes (0.18.0) — Task 8 copies these

- No `WhisperKit(model:)` convenience init: use
  `WhisperKit(WhisperKitConfig(model: "small"))`.
- `transcribe(audioPath:decodeOptions:)` array-returning overload;
  `TranscriptionResult.text/.language/.segments`.
- `DecodingOptions(task: .transcribe, language: nil)` — `language: nil`
  auto-detects; `"hi"` pins the Hindi token (usePrefillPrompt defaults true).
- `"small"`/`"base"`/`"medium"` resolve to the **multilingual** variants
  (`openai_whisper-small` etc.), not `.en`.
- The verified `CMSampleBufferToPCM` implementation lives in
  `Sources/meeting-probe/main.swift` — reference for Task 8, copy verbatim.
- SCK audio-only still requires a video config (`width/height = 2`);
  `cfg.capturesAudio = true`, 16kHz mono to match Whisper input.
- Model storage: WhisperKit defaults to `~/Documents/huggingface/…`. For a
  headless agent under TCC this is risky (Documents is a protected folder);
  Task 8 should set an explicit model dir (e.g. `~/.shyn/models/whisperkit`)
  via the config's download-base rather than inherit the Documents default.

## Latency (warm process incl. model load; 24–30s clips)

| model  | English 24s clip | notes |
|--------|------------------|-------|
| base   | 7.1s  | cold first run 52.9s (download ~150MB + CoreML compile) |
| small  | 7.8s  | model cached; ~3–4s of total is process+model init |
| medium | 9.6s  | cold download 1.5GB took ~4min; first *inference* adds ~30s CoreML/ANE warmup once |

Real Hindi 30s clip, `language=hi`: small 14.3s, medium 40.7s (medium number
includes its one-time ANE warmup; steady-state is much lower). Decode is
well under real-time for all three models — a 60-min meeting transcribes in
minutes with `small`. Model load per invocation dominates short clips; the
product agent should hold one pipeline instance per transcription session.

## Accuracy (subjective)

Test audio: TTS-generated English (Samantha) and Hinglish (Aman en_IN,
Latin-script Hindi+English) at 16kHz — `hi_IN` TTS voice not installed —
plus a real spoken-Hindi clip (Wikimedia "Hindi Dengue Introduction", noisy
amateur recording).

- **English**: `small` and `medium` near-perfect (one homophone each, e.g.
  "before launch" for "before lunch"); `base` noticeably worse ("pool
  request", "demon server"). `small` is the right floor.
- **Hindi/Hinglish, auto-detect (language=nil)**: all models tend to emit an
  **English rendering** of Hindi speech — semantic gist preserved, verbatim
  wording lost (e.g. "Maine retention sweep ka kaam khatam kar diya" →
  "I finished the retention sweep"). Occasionally mid-stream it flips to
  Latin-script Hindi. Mistranslations happen ("machharon"/mosquitoes →
  "mushrooms" once at small).
- **`language=hi` pinned**: emits Devanagari, but on the noisy test clip
  spellings were heavily mangled at both `small` and `medium`; `small` also
  dropped a 15s span (decode fallback), `medium` covered the full clip.
  One flaky empty-result run observed at small+hi; not reproducible.

**Decision:** default `whisperModel: "small"`, auto-detect (no language
pin). For shyn's purpose — searchable meeting memory — the English gist is
*more* useful than misspelled Devanagari: users search in English/Latin
script. Caveat to record in the product docs: Hindi speech is stored as an
approximate English rendering, not verbatim. Re-evaluate against a real
meeting in Task 12 live verification; `whisperModel` stays configurable.

TTS audio is a weak proxy for real meeting audio (clean, single-speaker,
English-voice phonetics for the Hinglish sample). Treat these accuracy notes
as a floor-check, not a benchmark.

## (a) Headless capture — reproduction steps (user-run)

Prepped: `~/Library/Application Support/shyn/bin/meeting-probe.app` signed with the stable self-signed
"Shyn Dev" identity (already in the login keychain from SP2;
`security find-identity` lists it as "0 valid" but codesign accepts it).
NB — **SentinelOne EDR quarantines the probe binary** (deployment blocker,
not a code issue): it silently deleted the Mach-O out of the signed bundle
(leaving Info.plist + _CodeSignature) at `/tmp`, at `~/.shyn/bin`, and —
on bootstrap/execution — at `~/Library/Application Support/shyn/bin` too,
also removing the LaunchAgents plist (`sentineld_helper` in the unified
log at each deletion). Detection appears behavioral/reputation-based:
SP2's `shyn-capture.app` (same "Shyn Dev" identity, same staging dir)
keeps running untouched. **The headless launchd PASS could not be executed
on this machine without an S1 exclusion** (user/IT action —
`~/Library/Application Support/shyn/` path or the "Shyn Dev" identity).

Why this does NOT block the plan: the headless test existed to de-risk
ScreenCaptureKit's WindowServer-session dependency (SP2's CGS_REQUIRE_INIT
finding). The adopted tap+mic path uses NO ScreenCaptureKit and no
WindowServer — CoreAudio and AVAudioEngine run fine in launchd agents.
Capture mechanics are fully validated interactively (same code paths).
Residual risk moved from "macOS API" to "EDR policy at install time";
Task 12's live verification (via `shyn install`, whose staging S1 has so
far tolerated for shyn-capture) is the remaining checkpoint, and the
`shyn-meeting` agent must surface silent-death clearly in `shyn status`
(daemon reports `capture.meeting: not-reporting`).

```bash
# 1. install + bootstrap the agent (plist staged in this dir: KeepAlive + RunAtLoad, loop mode)
cp spikes/meeting-probe/com.shyn.meeting-probe.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.shyn.meeting-probe.plist
# 2. System Settings → Privacy & Security: meeting-probe must be ON under
#    Microphone AND Screen & System Audio Recording (already granted 2026-07-10;
#    the panes have no "+" — the app appears after its first request)
# 3. play any speech audio; watch /tmp/meeting-probe/loop.log for
#    non-zero mic= / system= char counts
# 4. grants must survive: launchctl kickstart -k gui/$(id -u)/com.shyn.meeting-probe
# teardown:
launchctl bootout gui/$(id -u)/com.shyn.meeting-probe
rm ~/Library/LaunchAgents/com.shyn.meeting-probe.plist
tccutil reset ScreenCapture com.shyn.meeting-probe
tccutil reset Microphone com.shyn.meeting-probe
tccutil reset All com.shyn.meeting-probe   # includes the audio-capture grant
```

PASS bar: `loop.log` shows non-zero `mic=`/`system=` while headless; grants
survive `kickstart -k`. (SCK fallback decision: ALREADY TAKEN, see Verdict —
loop mode records system audio via the process tap.)

## Probe usage

```bash
swift build -c release
.build/release/meeting-probe record <secs> <dir>     # mic + SCK system audio (dead on 26.5, kept as evidence)
.build/release/meeting-probe recordtap <secs> <dir>  # mic + process-tap system audio (the validated path)
.build/release/meeting-probe recordmic <secs> <dir>  # mic only (isolates TCC domains)
.build/release/meeting-probe transcribe <wav> [model] [language]
.build/release/meeting-probe loop [dir]              # 30s record(tap)+transcribe cycles
```
