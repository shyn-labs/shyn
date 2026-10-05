# Diarization Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer, with numbers, whether Nemotron 3 Diarization (via FluidAudio) is good enough and light enough to build speaker diarization v1. The deliverable is a findings note and a go/no-go, not shippable code.

**Architecture:**
- A throwaway Swift CLI at `spikes/diarization-probe/`, modelled on `spikes/meeting-probe/`.
- It links **both** WhisperKit `exact 0.18.0` and FluidAudio in one binary. That proves the two packages coexist and reuses WhisperKit's 16 kHz loader, which is the one production uses.
- Scoring uses a small Python script (`pyannote.metrics` via `uv`).
- Real-call measurements compare the installed `shyn-meeting transcribe` diagnostic against the probe, each run under `/usr/bin/time -l`.

**Tech Stack:**
- Swift 6 / SwiftPM, macOS 14
- FluidAudio ≥ 0.17.5 (`Nemotron3Diarizer`, speaker embedders)
- WhisperKit 0.18.0 (audio loading only)
- Python 3 via `uv` (`pyannote.metrics`)

**Spec:** `docs/superpowers/specs/2026-10-05-speaker-diarization-v1-design.md` (§Spike is what this plan implements)

## Global Constraints

- WhisperKit stays pinned `exact: "0.18.0"`. Do not bump it to make FluidAudio resolve.
- **No production code changes.** Nothing under `packages/` is modified by this plan.
- Spike code lives on branch `spike/diarization` only. It is never merged to `main` and never pushed without the maintainer's go-ahead.
- Real recordings contain other people's voices:
  - They live only in `~/Library/Application Support/shyn-spike/`, never in the repo.
  - They are deleted in Task 6.
  - No real transcript text, names or audio goes into any committed file.
- Commits are made as `shynbot <hello@shyn.day>`.
  - Stage in one shell call; run `node scripts/check-identity-leak.mjs` and commit in a separate call.
  - Never `git add -A`.
- Pass criteria (spec, verbatim): "on a real ~45-minute multi-party call, total transcript wall time increases **< 10%** and peak RSS does **not** increase over Whisper alone."
- If the pass criteria fail, stop after Task 6 with a no-go. Do not tune the criteria to pass.

## Review Focus

1. **Long meetings.** `processComplete` takes the whole session as one `[Float]`. A 3-hour meeting (the `maxDurationMinutes=180` cap) is about 690 MB of samples before the model runs.
   - Expected: peak RSS stays under Whisper's.
   - Pinned by Task 4 Step 6 (a synthetic 2-hour run).
2. **Silent or near-silent channel** (in-person sessions have a silent `system.wav`).
   - Expected: zero segments, no crash, no hallucinated speaker.
   - Pinned by Task 2 Step 6.
3. **Native-rate stereo input.** Production WAVs are written at the device's native rate and channel count (often 48 kHz stereo), not 16 kHz mono.
   - Expected: the loader downmixes and resamples, and timestamps stay on the original timeline.
   - Pinned by Task 2 Step 5 (a 48 kHz stereo file must give the same segment times as its 16 kHz mono version).
4. **Codec-compressed far-side audio.** A mixed Meet/Zoom stream differs from the benchmark audio.
   - Expected: speaker splits still hold.
   - Measured only on the real call (Task 4); there is no synthetic proxy.
5. **Mixed-language in-person speech.**
   - Expected: speaker boundaries do not follow language switches.
   - Pinned by Task 5 Step 4's manual check.

---

## File Structure

```
spikes/diarization-probe/
  .gitignore              # .build/, *.wav, *.rttm outputs, results/
  Package.swift           # WhisperKit exact 0.18.0 + FluidAudio from 0.17.5
  README.md               # what this is, how to run, "throwaway, never merge"
  Sources/diarization-probe/
    main.swift            # subcommand dispatch only
    Audio.swift           # load16k(path) via WhisperKit AudioProcessor; peakRSS()
    Diarize.swift         # run Nemotron3 → [Turn]; JSON + RTTM writers
    Assign.swift          # whisper-line → speaker overlap assignment (pure)
    Embed.swift           # per-speaker embeddings, cosine, campp|wespeaker switch
  scripts/
    fetch-ami.sh          # downloads one AMI meeting + reference RTTM
    score_der.py          # DER via pyannote.metrics
    keep-sessions.sh      # copies meeting-tmp/session-* before purge (spike-only)
```

`Assign.swift` is pure, so it is the one file with unit tests. Everything else is measurement code, judged by its output.

---

### Task 1: Dependency coexistence (gate A)

**Files:**
- Create: `spikes/diarization-probe/Package.swift`
- Create: `spikes/diarization-probe/.gitignore`
- Create: `spikes/diarization-probe/README.md`
- Create: `spikes/diarization-probe/Sources/diarization-probe/main.swift`

**Interfaces:**
- Produces: a buildable executable `diarization-probe` importing both `WhisperKit` and `FluidAudio`.

- [ ] **Step 1: Create the branch**

```bash
cd ~/Documents/Code/shyn && git switch -c spike/diarization
```

- [ ] **Step 2: Write `Package.swift`**

```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "diarization-probe",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/argmaxinc/WhisperKit", exact: "0.18.0"),
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.17.5"),
    ],
    targets: [
        .executableTarget(name: "diarization-probe", dependencies: [
            .product(name: "WhisperKit", package: "WhisperKit"),
            .product(name: "FluidAudio", package: "FluidAudio"),
        ], path: "Sources/diarization-probe"),
        .testTarget(name: "diarization-probeTests", dependencies: ["diarization-probe"],
                    path: "Tests/diarization-probeTests"),
    ]
)
```

- [ ] **Step 3: Write `.gitignore` and `README.md`**

`.gitignore`:
```
.build/
results/
*.wav
*.rttm
```

`README.md`:
```markdown
# diarization-probe (THROWAWAY)

Spike for docs/superpowers/specs/2026-10-05-speaker-diarization-v1-design.md.
Lives on branch spike/diarization only; never merged. Real recordings are
never stored here — they live in ~/Library/Application Support/shyn-spike/.

    swift build -c release
    .build/release/diarization-probe diarize <wav> [--config fast32|offline]
    .build/release/diarization-probe rttm <wav> <uri> [--config ...]
    .build/release/diarization-probe label <transcribe.txt> <wav> <channel> [--config ...]
    .build/release/diarization-probe embed-rttm <wav> <rttm> --model campp|wespeaker
    .build/release/diarization-probe embed-turns <wav> [--config ...] --model campp|wespeaker
```

- [ ] **Step 4: Minimal `main.swift` that touches both modules**

```swift
import FluidAudio
import WhisperKit

let args = CommandLine.arguments
if args.count < 2 {
    print("diarization-probe: WhisperKit + FluidAudio linked")
    exit(0)
}
```

Create an empty test dir so the manifest resolves:

```bash
mkdir -p spikes/diarization-probe/Tests/diarization-probeTests && \
printf 'import Testing\n@Test func placeholderBuilds() { #expect(true) }\n' \
  > spikes/diarization-probe/Tests/diarization-probeTests/BuildTests.swift
```

- [ ] **Step 5: Resolve and build**

Run: `cd spikes/diarization-probe && swift package resolve && swift build -c release 2>&1 | tail -20 && .build/release/diarization-probe`

Expected: PASS, printing `diarization-probe: WhisperKit + FluidAudio linked`.

If resolution fails, record the conflicting package and both version ranges from the error, then go to Step 6. Otherwise skip Step 6.

- [ ] **Step 6 (only on conflict): Prove the direct Core ML fallback loads**

```bash
cd ~/Library/Application\ Support && mkdir -p shyn-spike/models && cd shyn-spike/models && \
uvx --from huggingface_hub huggingface-cli download FluidInference/nemotron-3-diarization-coreml --local-dir nemotron3
```

Remove FluidAudio from `Package.swift`, and replace `main.swift` with:

```swift
import CoreML
import Foundation

let dir = URL(fileURLWithPath: NSHomeDirectory() + "/Library/Application Support/shyn-spike/models/nemotron3")
let pkgs = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
    .filter { ["mlmodelc", "mlpackage"].contains($0.pathExtension) }
for p in pkgs {
    let compiled = p.pathExtension == "mlmodelc" ? p : try await MLModel.compileModel(at: p)
    let m = try MLModel(contentsOf: compiled)
    print(p.lastPathComponent, m.modelDescription.inputDescriptionsByName.keys.sorted(),
          m.modelDescription.outputDescriptionsByName.keys.sorted())
}
```

Run: `swift build -c release && .build/release/diarization-probe`

Expected: each model prints its input and output names. Record them in the findings. **In this case, stop the plan after Task 6 with the verdict "fallback route required"**, because the remaining tasks assume FluidAudio. A follow-up plan writes the direct wrapper.

- [ ] **Step 7: Commit**

```bash
git add spikes/diarization-probe/Package.swift spikes/diarization-probe/Package.resolved \
  spikes/diarization-probe/.gitignore spikes/diarization-probe/README.md \
  spikes/diarization-probe/Sources spikes/diarization-probe/Tests
```
```bash
node scripts/check-identity-leak.mjs && git commit -m "spike(diarization): WhisperKit 0.18.0 + FluidAudio coexist"
```

---

### Task 2: Diarize command, RSS and timing

**Files:**
- Create: `spikes/diarization-probe/Sources/diarization-probe/Audio.swift`
- Create: `spikes/diarization-probe/Sources/diarization-probe/Diarize.swift`
- Modify: `spikes/diarization-probe/Sources/diarization-probe/main.swift`

**Interfaces:**
- Produces:
  - `func load16k(_ path: String) throws -> [Float]`
  - `func peakRSSBytes() -> UInt64`
  - `struct Turn: Codable { let speaker: Int; let start: Double; let end: Double }`
  - `func diarize(_ samples: [Float], config: String) async throws -> [Turn]`
  - `func rttmLines(_ turns: [Turn], uri: String) -> [String]`

- [ ] **Step 1: Pin the FluidAudio names this plan relies on**

Run:
```bash
cd spikes/diarization-probe && grep -rn "static.*fast32\|static.*offline\|static let\|static var" .build/checkouts/FluidAudio/Sources/FluidAudio/Diarizer/Nemotron3/*Config*.swift | head -20; \
grep -rn "static func segments\|struct .*Segment" .build/checkouts/FluidAudio/Sources/FluidAudio/Diarizer/Nemotron3/ | head
```

Expected: the preset names (the docs name `fast32` and the merged PR names `offline`) and the segment struct's field names.

If the fields are not `speakerIndex`, `startTime` and `endTime`, change the three names in Step 3's `diarize` to match. Nothing else in the plan depends on them, because everything downstream uses `Turn`.

- [ ] **Step 2: Write `Audio.swift`**

```swift
import Foundation
import WhisperKit

/// 16 kHz mono Float samples — the same loader production uses
/// (Transcriber.swift: AudioProcessor.loadAudioAsFloatArray), so resampling
/// and downmix behaviour match the real pipeline.
func load16k(_ path: String) throws -> [Float] {
    try AudioProcessor.loadAudioAsFloatArray(fromPath: path)
}

/// Peak resident set size of this process. On macOS ru_maxrss is in bytes.
func peakRSSBytes() -> UInt64 {
    var u = rusage()
    getrusage(RUSAGE_SELF, &u)
    return UInt64(u.ru_maxrss)
}

func mb(_ b: UInt64) -> String { String(format: "%.0fMB", Double(b) / 1_048_576) }
```

- [ ] **Step 3: Write `Diarize.swift`**

```swift
import FluidAudio
import Foundation

struct Turn: Codable { let speaker: Int; let start: Double; let end: Double }

func nemotronConfig(_ name: String) -> Nemotron3Config {
    switch name {
    case "offline": return .offline
    default: return .fast32
    }
}

func diarize(_ samples: [Float], config name: String) async throws -> [Turn] {
    let config = nemotronConfig(name)
    let models = try await Nemotron3Models.loadFromHuggingFace(config: config)
    let diarizer = Nemotron3Diarizer(config: config, models: models)
    let (probs, frames) = try diarizer.processComplete(samples)
    return Nemotron3Diarizer.segments(probabilities: probs, frameCount: frames).map {
        Turn(speaker: $0.speakerIndex, start: Double($0.startTime), end: Double($0.endTime))
    }
}

func rttmLines(_ turns: [Turn], uri: String) -> [String] {
    turns.map {
        String(format: "SPEAKER %@ 1 %.3f %.3f <NA> <NA> spk%d <NA> <NA>",
               uri, $0.start, $0.end - $0.start, $0.speaker)
    }
}
```

- [ ] **Step 4: Wire `diarize` and `rttm` into `main.swift`**

```swift
import FluidAudio
import Foundation
import WhisperKit

let args = CommandLine.arguments
func opt(_ flag: String, _ def: String) -> String {
    if let i = args.firstIndex(of: flag), i + 1 < args.count { return args[i + 1] }
    return def
}
func fail(_ msg: String) -> Never { FileHandle.standardError.write(Data((msg + "\n").utf8)); exit(2) }

guard args.count >= 2 else { print("diarization-probe: WhisperKit + FluidAudio linked"); exit(0) }
let cmd = args[1]
let config = opt("--config", "fast32")

switch cmd {
case "diarize":
    guard args.count >= 3 else { fail("usage: diarize <wav> [--config fast32|offline]") }
    let t0 = Date()
    let samples = try load16k(args[2])
    let tLoad = Date().timeIntervalSince(t0)
    let turns = try await diarize(samples, config: config)
    let wall = Date().timeIntervalSince(t0)
    let speakers = Set(turns.map(\.speaker)).count
    let audioSec = Double(samples.count) / 16_000
    print(String(data: try JSONEncoder().encode(turns), encoding: .utf8)!)
    FileHandle.standardError.write(Data(String(
        format: "config=%@ audio=%.0fs speakers=%d turns=%d load=%.1fs wall=%.1fs rtfx=%.0f peakRSS=%@\n",
        config, audioSec, speakers, turns.count, tLoad, wall, audioSec / wall, mb(peakRSSBytes())).utf8))
case "rttm":
    guard args.count >= 4 else { fail("usage: rttm <wav> <uri> [--config ...]") }
    let turns = try await diarize(try load16k(args[2]), config: config)
    rttmLines(turns, uri: args[3]).forEach { print($0) }
default:
    fail("unknown command \(cmd)")
}
```

- [ ] **Step 5: Sample-rate check (Review Focus 3)**

```bash
cd spikes/diarization-probe && swift build -c release && D=~/Library/Application\ Support/shyn-spike && mkdir -p "$D" && \
say -v Samantha "This is the first voice speaking for a while about the schedule." -o "$D/a.aiff" && \
say -v Daniel "And this is a second voice answering with a different opinion." -o "$D/b.aiff" && \
afconvert -f WAVE -d LEI16@16000 -c 1 "$D/a.aiff" "$D/a.wav" && afconvert -f WAVE -d LEI16@16000 -c 1 "$D/b.aiff" "$D/b.wav" && \
sox "$D/a.wav" "$D/b.wav" "$D/a.wav" "$D/two16k.wav" && \
sox "$D/two16k.wav" -r 48000 -c 2 "$D/two48k-stereo.wav" && \
.build/release/diarization-probe diarize "$D/two16k.wav" > "$D/t16.json" && \
.build/release/diarization-probe diarize "$D/two48k-stereo.wav" > "$D/t48.json" && \
cat "$D/t16.json" "$D/t48.json"
```

If `sox` is missing: `brew install sox`. Record that in the findings, since the Brewfile is tracked.

Expected: both JSONs show 2 speakers, and turn boundaries agree within ±0.1 s. The stderr line shows `speakers=2`. Synthetic TTS voices are easy for the model; this step checks plumbing, not accuracy.

- [ ] **Step 6: Silence check (Review Focus 2)**

```bash
D=~/Library/Application\ Support/shyn-spike && sox -n -r 48000 -c 2 "$D/silence.wav" trim 0 120 && \
spikes/diarization-probe/.build/release/diarization-probe diarize "$D/silence.wav"
```

Expected: prints `[]`, stderr shows `speakers=0 turns=0`, exit 0. Any non-empty output is a finding: v1 would then need a gate based on `channelVerdict`.

- [ ] **Step 7: Commit**

```bash
git add spikes/diarization-probe/Sources
```
```bash
node scripts/check-identity-leak.mjs && git commit -m "spike(diarization): diarize/rttm commands with timing and peak RSS"
```

---

### Task 3: AMI baseline (DER)

**Files:**
- Create: `spikes/diarization-probe/scripts/fetch-ami.sh`
- Create: `spikes/diarization-probe/scripts/score_der.py`

**Interfaces:**
- Consumes: `diarization-probe rttm` (Task 2).
- Produces: a DER number for each preset (`fast32`, `offline`) on AMI `ES2004a`. This becomes the release-gate baseline.

- [ ] **Step 1: Write `fetch-ami.sh`**

```bash
#!/bin/zsh
set -euo pipefail
D="$HOME/Library/Application Support/shyn-spike/ami"
mkdir -p "$D"
curl -fL -o "$D/ES2004a.wav" \
  "https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/ES2004a/audio/ES2004a.Mix-Headset.wav"
curl -fL -o "$D/ES2004a.ref.rttm" \
  "https://raw.githubusercontent.com/pyannote/AMI-diarization-setup/main/only_words/rttms/test/ES2004a.rttm"
ls -la "$D"
```

- [ ] **Step 2: Write `score_der.py`**

```python
# /// script
# dependencies = ["pyannote.metrics>=3.2", "pyannote.core>=5"]
# ///
"""DER of a hypothesis RTTM against a reference RTTM, 0.25 s collar,
overlap scored (pyannote defaults for AMI 'only_words')."""
import sys
from pyannote.core import Annotation, Segment
from pyannote.metrics.diarization import DiarizationErrorRate

def load(path):
    ann = Annotation()
    for line in open(path):
        f = line.split()
        if not f or f[0] != "SPEAKER":
            continue
        start, dur = float(f[3]), float(f[4])
        ann[Segment(start, start + dur)] = f[7]
    return ann

ref, hyp = load(sys.argv[1]), load(sys.argv[2])
metric = DiarizationErrorRate(collar=0.25, skip_overlap=False)
d = metric(ref, hyp, detailed=True)
total = d["total"]
print(f"DER={d['diarization error rate']:.2%} "
      f"miss={d['missed detection']/total:.2%} "
      f"fa={d['false alarm']/total:.2%} "
      f"conf={d['confusion']/total:.2%} "
      f"ref_speakers={len(ref.labels())} hyp_speakers={len(hyp.labels())}")
```

- [ ] **Step 3: Run the baseline for both presets**

```bash
cd ~/Documents/Code/shyn/spikes/diarization-probe && chmod +x scripts/fetch-ami.sh && scripts/fetch-ami.sh && \
D=~/Library/Application\ Support/shyn-spike/ami && \
for c in fast32 offline; do \
  .build/release/diarization-probe rttm "$D/ES2004a.wav" ES2004a --config $c > "$D/hyp-$c.rttm"; \
  echo "== $c"; uv run scripts/score_der.py "$D/ES2004a.ref.rttm" "$D/hyp-$c.rttm"; \
done
```

Expected: one `DER=… ref_speakers=4 hyp_speakers=…` line per preset. A DER in the 10–25% range is plausible on AMI headset-mix. Record both numbers and the speaker counts. A `hyp_speakers` different from 4 is the speaker-merging risk showing up.

- [ ] **Step 4: Timing line for AMI**

```bash
D=~/Library/Application\ Support/shyn-spike/ami && \
spikes/diarization-probe/.build/release/diarization-probe diarize "$D/ES2004a.wav" --config offline > /dev/null
```

Record the stderr line (`audio=…s wall=…s rtfx=… peakRSS=…`).

- [ ] **Step 5: Commit**

```bash
git add spikes/diarization-probe/scripts/fetch-ami.sh spikes/diarization-probe/scripts/score_der.py
```
```bash
node scripts/check-identity-leak.mjs && git commit -m "spike(diarization): AMI ES2004a DER baseline scripts"
```

---

### Task 4: Real call against the pass criteria (gate B)

**Files:**
- Create: `spikes/diarization-probe/scripts/keep-sessions.sh`

**Interfaces:**
- Consumes: the installed `shyn-meeting` (`~/Library/Application Support/shyn/bin/shyn-meeting.app/Contents/MacOS/shyn-meeting`) and `diarization-probe diarize`.
- Produces: whisper-alone wall time and peak RSS, and diarization wall time and peak RSS, on one real multi-party call of about 45 minutes. Plus a pass/fail verdict.

- [ ] **Step 1: Write `keep-sessions.sh`**

This copies session audio aside before the agent purges it. It is read-only towards shyn: it never touches the agent, the daemon or capture.json.

```bash
#!/bin/zsh
# Spike-only: copy each meeting session dir aside while it exists, so a real
# call's mic.wav/system.wav survive the post-ship purge. Stop with Ctrl-C.
set -u
SRC="$HOME/Library/Application Support/shyn/meeting-tmp"
DST="$HOME/Library/Application Support/shyn-spike/sessions"
mkdir -p "$DST"
while true; do
  for d in "$SRC"/session-*(N/); do
    rsync -a "$d" "$DST/" 2>/dev/null
  done
  sleep 5
done
```

- [ ] **Step 2: Maintainer action: record one real call**

Run `scripts/keep-sessions.sh` in a terminal. Join a real call of about 45 minutes with **3 or more** participants. Stop the script after shyn has shipped the transcript (the session dir disappears from `meeting-tmp`).

Check that the copy is complete:

```bash
ls -la ~/Library/Application\ Support/shyn-spike/sessions/*/
```

Expected: one `session-<epoch>` dir with `mic.wav` and `system.wav`. Their sizes should be consistent with the call length (48 kHz stereo 16-bit is about 11 MB per minute).

- [ ] **Step 3: Whisper-alone measurement (the baseline)**

Run this while shyn is idle (no meeting, no transcription in progress), so two Whisper instances never compete:

```bash
S=$(ls -d ~/Library/Application\ Support/shyn-spike/sessions/session-* | tail -1) && \
/usr/bin/time -l ~/Library/Application\ Support/shyn/bin/shyn-meeting.app/Contents/MacOS/shyn-meeting \
  transcribe "$S/mic.wav" "$S/system.wav" > "$S/transcribe.txt" 2> "$S/whisper-time.txt"; \
tail -1 "$S/transcribe.txt"; grep -E "real|maximum resident" "$S/whisper-time.txt"
```

Expected: `mode=chunked model=large-v3_turbo … wall=…s`, plus `real` seconds and `maximum resident set size` in bytes. Record both.

- [ ] **Step 4: Diarization measurement**

```bash
S=$(ls -d ~/Library/Application\ Support/shyn-spike/sessions/session-* | tail -1) && \
/usr/bin/time -l spikes/diarization-probe/.build/release/diarization-probe diarize "$S/system.wav" --config offline \
  > "$S/turns.json" 2> "$S/diar-time.txt"; cat "$S/diar-time.txt" | grep -E "config=|real|maximum resident"
```

Expected: the probe's `speakers=…` line, plus `real` and `maximum resident set size`.

- [ ] **Step 5: Apply the pass criteria**

```bash
S=$(ls -d ~/Library/Application\ Support/shyn-spike/sessions/session-* | tail -1) && python3 - "$S" <<'EOF'
import re, sys, pathlib
s = pathlib.Path(sys.argv[1])
def grab(f):
    t = (s / f).read_text()
    real = float(re.search(r"([\d.]+) real", t).group(1))
    rss = int(re.search(r"(\d+)\s+maximum resident set size", t).group(1))
    return real, rss
w, d = grab("whisper-time.txt"), grab("diar-time.txt")
time_ok = d[0] < 0.10 * w[0]
rss_ok = d[1] <= w[1]
print(f"whisper: {w[0]:.0f}s {w[1]/2**20:.0f}MB | diar: {d[0]:.0f}s {d[1]/2**20:.0f}MB")
print(f"time +{d[0]/w[0]:.1%} (<10%: {'PASS' if time_ok else 'FAIL'}) | "
      f"peak RSS {'PASS' if rss_ok else 'FAIL'} | GATE B: {'PASS' if time_ok and rss_ok else 'FAIL'}")
EOF
```

Expected: one `GATE B: PASS|FAIL` line. Model download time is excluded, because models are cached after Task 2. If it reports FAIL, record it and skip to Task 6.

- [ ] **Step 6: Long-meeting memory (Review Focus 1)**

```bash
D=~/Library/Application\ Support/shyn-spike/ami && \
sox "$D/ES2004a.wav" "$D/ES2004a.wav" "$D/ES2004a.wav" "$D/ES2004a.wav" "$D/ES2004a.wav" "$D/ES2004a.wav" "$D/ES2004a.wav" "$D/long.wav" && \
soxi -D "$D/long.wav" && \
/usr/bin/time -l spikes/diarization-probe/.build/release/diarization-probe diarize "$D/long.wav" --config offline > /dev/null 2> "$D/long-time.txt"; \
grep -E "config=|real|maximum resident" "$D/long-time.txt"
```

Expected: a duration of roughly 2 hours. Peak RSS stays below Task 4 Step 3's Whisper peak. If it does not, record the number. The v1 plan then has to chunk long sessions before diarizing.

- [ ] **Step 7: Commit the script only**

```bash
git add spikes/diarization-probe/scripts/keep-sessions.sh
```
```bash
node scripts/check-identity-leak.mjs && git commit -m "spike(diarization): session keeper for real-call measurement"
```

---

### Task 5: Labelling quality, embeddings and Me selection

**Files:**
- Create: `spikes/diarization-probe/Sources/diarization-probe/Assign.swift`
- Create: `spikes/diarization-probe/Sources/diarization-probe/Embed.swift`
- Create: `spikes/diarization-probe/Tests/diarization-probeTests/AssignTests.swift`
- Modify: `spikes/diarization-probe/Sources/diarization-probe/main.swift`

**Interfaces:**
- Consumes: `Turn`, `diarize`, `load16k` (Task 2); `transcribe.txt` (Task 4 Step 3).
- Produces:
  - `struct Line { let start: Double; let channel: String; let text: String }`
  - `func parseTranscribe(_ text: String) -> [Line]`
  - `func assignSpeaker(start: Double, end: Double, turns: [Turn]) -> Int?`
  - `func embed(_ samples: [Float], ranges: [(Double, Double)], model: String) async throws -> [Float]`
  - `func cosine(_ a: [Float], _ b: [Float]) -> Float`

- [ ] **Step 1: Write the failing assignment tests**

```swift
import Testing
@testable import diarization_probe

@Test func picksSpeakerWithMostOverlap() {
    let turns = [Turn(speaker: 0, start: 0, end: 4), Turn(speaker: 1, start: 4, end: 10)]
    #expect(assignSpeaker(start: 3, end: 9, turns: turns) == 1)   // 1s vs 5s
}

@Test func overlappingSpeechGoesToLongerActive() {
    let turns = [Turn(speaker: 0, start: 0, end: 10), Turn(speaker: 1, start: 2, end: 5)]
    #expect(assignSpeaker(start: 1, end: 6, turns: turns) == 0)   // 5s vs 3s
}

@Test func noOverlapIsNil() {
    let turns = [Turn(speaker: 0, start: 0, end: 2)]
    #expect(assignSpeaker(start: 5, end: 8, turns: turns) == nil)
}

@Test func parsesTranscribeDiagnosticOutput() {
    let out = """
       0.00  Me: hello there
      12.50  Others: hi
    mode=chunked model=small segments=2 wall=3.1s
    """
    let lines = parseTranscribe(out)
    #expect(lines.count == 2)
    #expect(lines[1].start == 12.5 && lines[1].channel == "Others" && lines[1].text == "hi")
}
```

Remove the Task 1 placeholder test file:

```bash
git rm -q spikes/diarization-probe/Tests/diarization-probeTests/BuildTests.swift
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd spikes/diarization-probe && swift test 2>&1 | tail -5`

Expected: FAIL to compile, with `cannot find 'assignSpeaker' in scope`.

- [ ] **Step 3: Write `Assign.swift`**

```swift
import Foundation

struct Line { let start: Double; let channel: String; let text: String }

/// Parses `shyn-meeting transcribe` output: "%7.2f  <Me|Others>: text" lines,
/// then a trailing "mode=… wall=…" summary which is ignored.
func parseTranscribe(_ text: String) -> [Line] {
    text.split(separator: "\n").compactMap { raw in
        let s = raw.trimmingCharacters(in: .whitespaces)
        guard let sp = s.firstIndex(of: " "), let t = Double(s[..<sp]) else { return nil }
        let rest = s[sp...].trimmingCharacters(in: .whitespaces)
        guard let colon = rest.firstIndex(of: ":") else { return nil }
        return Line(start: t, channel: String(rest[..<colon]),
                    text: rest[rest.index(after: colon)...].trimmingCharacters(in: .whitespaces))
    }
}

/// Speaker with the most active time inside [start, end); nil if none overlap.
func assignSpeaker(start: Double, end: Double, turns: [Turn]) -> Int? {
    var overlap: [Int: Double] = [:]
    for t in turns {
        let o = min(end, t.end) - max(start, t.start)
        if o > 0 { overlap[t.speaker, default: 0] += o }
    }
    return overlap.max { $0.value < $1.value }?.key
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `swift test 2>&1 | tail -5`

Expected: PASS, 4 tests.

- [ ] **Step 5: Pin the embedding API names**

```bash
cd spikes/diarization-probe && grep -rln "CAMPlus\|Campplus\|campplus" .build/checkouts/FluidAudio/Sources | head; \
grep -rn "func extractEmbedding\|func embed\|public func .*embedding" .build/checkouts/FluidAudio/Sources/FluidAudio | head -20
```

Expected: the CAM++ type with its load and embed methods, and `DiarizerManager.extractEmbedding`. Write Step 6's `embed` against exactly these signatures. The two `switch` arms are the only lines that call FluidAudio.

- [ ] **Step 6: Write `Embed.swift`**

Replace the two marked calls with the signatures found in Step 5. The `switch` arms are the only FluidAudio-touching lines.

```swift
import FluidAudio
import Foundation

func slice(_ s: [Float], ranges: [(Double, Double)]) -> [Float] {
    ranges.flatMap { r -> ArraySlice<Float> in
        let a = max(0, Int(r.0 * 16_000)), b = min(s.count, Int(r.1 * 16_000))
        return a < b ? s[a..<b] : []
    }
}

func cosine(_ a: [Float], _ b: [Float]) -> Float {
    var dot: Float = 0, na: Float = 0, nb: Float = 0
    for i in 0..<min(a.count, b.count) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
    return dot / max(1e-9, na.squareRoot() * nb.squareRoot())
}

/// One embedding for the concatenated speech in `ranges`.
func embed(_ samples: [Float], ranges: [(Double, Double)], model: String) async throws -> [Float] {
    let audio = slice(samples, ranges: ranges)
    switch model {
    case "campp":
        let m = try await CAMPlusEmbedder.loadFromHuggingFace()       // ← Step 5 name
        return try m.embed(audio)                                      // ← Step 5 name
    default:
        let d = DiarizerManager()
        try await d.initialize(models: try await DiarizerModels.downloadIfNeeded())  // ← Step 5 name
        return try d.extractEmbedding(audio)
    }
}
```

- [ ] **Step 7: Add `label`, `embed-rttm` and `embed-turns` to `main.swift`**

Insert these cases before `default:`.

```swift
case "label":
    // label <transcribe.txt> <wav> <Me|Others> : diarize <wav>, tag that channel's lines
    guard args.count >= 5 else { fail("usage: label <transcribe.txt> <wav> <Me|Others> [--config ...]") }
    let lines = parseTranscribe(try String(contentsOfFile: args[2], encoding: .utf8))
        .filter { $0.channel == args[4] }
    let turns = try await diarize(try load16k(args[3]), config: config)
    for (i, l) in lines.enumerated() {
        let end = i + 1 < lines.count ? min(lines[i + 1].start, l.start + 30) : l.start + 30
        let who = assignSpeaker(start: l.start, end: end, turns: turns).map { "Speaker \($0 + 1)" } ?? "?"
        print(String(format: "%7.2f  %@: %@", l.start, who, l.text))
    }
case "embed-rttm":
    // same- vs different-speaker cosine from reference labels (objective embedder check)
    guard args.count >= 4 else { fail("usage: embed-rttm <wav> <rttm> --model campp|wespeaker") }
    let model = opt("--model", "wespeaker")
    let samples = try load16k(args[2])
    var bySpk: [String: [(Double, Double)]] = [:]
    for l in try String(contentsOfFile: args[3], encoding: .utf8).split(separator: "\n") {
        let f = l.split(separator: " ")
        guard f.count > 7, let st = Double(f[3]), let du = Double(f[4]), du >= 1.0 else { continue }
        bySpk[String(f[7]), default: []].append((st, st + du))
    }
    var halves: [(String, [Float])] = []
    for (spk, rs) in bySpk.sorted(by: { $0.key < $1.key }) {
        let mid = rs.count / 2
        halves.append((spk, try await embed(samples, ranges: Array(rs[..<mid]), model: model)))
        halves.append((spk, try await embed(samples, ranges: Array(rs[mid...]), model: model)))
    }
    var same: [Float] = [], diff: [Float] = []
    for i in 0..<halves.count { for j in (i + 1)..<halves.count {
        let c = cosine(halves[i].1, halves[j].1)
        if halves[i].0 == halves[j].0 { same.append(c) } else { diff.append(c) }
    } }
    let avg = { (x: [Float]) in x.reduce(0, +) / Float(max(1, x.count)) }
    print(String(format: "model=%@ same=%.3f (min %.3f) diff=%.3f (max %.3f) gap=%.3f",
                 model, avg(same), same.min() ?? 0, avg(diff), diff.max() ?? 0,
                 (same.min() ?? 0) - (diff.max() ?? 0)))
case "embed-turns":
    // embed-turns <wav> [--self <selfwav>...] : per-diarized-speaker embedding vs self samples
    guard args.count >= 3 else { fail("usage: embed-turns <wav> --model m [--self a.wav --self b.wav]") }
    let model = opt("--model", "wespeaker")
    let samples = try load16k(args[2])
    let turns = try await diarize(samples, config: config)
    var selfPrints: [[Float]] = []
    for (i, a) in args.enumerated() where a == "--self" && i + 1 < args.count {
        let s = try load16k(args[i + 1])
        selfPrints.append(try await embed(s, ranges: [(0, Double(s.count) / 16_000)], model: model))
    }
    var best: [(Int, Float)] = []
    for spk in Set(turns.map(\.speaker)).sorted() {
        let rs = turns.filter { $0.speaker == spk }.map { ($0.start, $0.end) }
        let secs = rs.reduce(0) { $0 + $1.1 - $1.0 }
        let e = try await embed(samples, ranges: rs, model: model)
        let m = selfPrints.map { cosine(e, $0) }.max() ?? 0
        best.append((spk, m))
        print(String(format: "Speaker %d  speech=%.0fs  maxSelfCos=%.3f", spk + 1, secs, m))
    }
    let sorted = best.sorted { $0.1 > $1.1 }
    if sorted.count >= 2 {
        print(String(format: "top=Speaker %d %.3f  runnerUp=%.3f  margin=%.3f",
                     sorted[0].0 + 1, sorted[0].1, sorted[1].1, sorted[0].1 - sorted[1].1))
    }
```

- [ ] **Step 8: Embedder comparison on AMI (objective)**

```bash
cd spikes/diarization-probe && swift build -c release && D=~/Library/Application\ Support/shyn-spike/ami && \
for m in wespeaker campp; do .build/release/diarization-probe embed-rttm "$D/ES2004a.wav" "$D/ES2004a.ref.rttm" --model $m; done
```

Expected: one line per model. **Pick the model with the larger positive `gap`** (worst same-speaker cosine minus best different-speaker cosine). If neither gap is positive, record "embeddings don't separate on AMI". The v1 Me-selection design then needs rethinking.

- [ ] **Step 9: Labelled real call (manual read)**

```bash
S=$(ls -d ~/Library/Application\ Support/shyn-spike/sessions/session-* | tail -1) && \
spikes/diarization-probe/.build/release/diarization-probe label "$S/transcribe.txt" "$S/system.wav" Others --config offline > "$S/labelled.txt" && \
head -80 "$S/labelled.txt"
```

The maintainer reads `labelled.txt` against memory of the call and records:
- the true speaker count vs `speakers=`
- any person split across two labels
- any two people merged into one label
- roughly what fraction of lines carry the wrong label

**Record counts only. No transcript text goes into the findings.**

- [ ] **Step 10: In-person recording and Me selection**

The maintainer records a 10-minute in-person conversation with 2–3 people, mixing English and Kannada, using shyn's "Start recording" while `keep-sessions.sh` runs. Then:

```bash
SS=(~/Library/Application\ Support/shyn-spike/sessions/session-*(/)) && \
INP=${SS[-1]} && CALL=${SS[1]} && \
spikes/diarization-probe/.build/release/diarization-probe embed-turns "$INP/mic.wav" --config offline \
  --model <winner from Step 8> --self "$CALL/mic.wav"
```

Expected: one line per diarized speaker with `maxSelfCos`, then `top=… margin=…`. The top speaker should be the maintainer.

Record:
- whether the top speaker is correct
- the top cosine and the margin; these set the v1 `Me` threshold and margin
- whether any speaker boundary visibly follows a language switch rather than a person (Review Focus 5). Check by running `label` on `mic.wav` with channel `Me`.

- [ ] **Step 11: Commit**

```bash
git add spikes/diarization-probe/Sources spikes/diarization-probe/Tests
```
```bash
node scripts/check-identity-leak.mjs && git commit -m "spike(diarization): segment assignment, embedder comparison, self-match probe"
```

---

### Task 6: Findings, verdict, cleanup

**Files:**
- Create (private, outside the repo): `~/Documents/Claude/work/shyn/sessions/2026/2026-10-XX-diarization-spike-findings.md`, where XX is the run date

**Interfaces:**
- Consumes: every recorded number from Tasks 1–5.
- Produces: GO / NO-GO / FALLBACK-ROUTE, plus the constants the v1 plan needs.

- [ ] **Step 1: Write the findings note**

```markdown
# Diarization spike findings — <date>

## Verdict: GO | NO-GO | FALLBACK-ROUTE

## Gate A — dependencies
FluidAudio <version> + WhisperKit 0.18.0: resolved | conflict (<package>, <ranges>)

## Gate B — real call (~<n> min, <k> participants)
whisper: <s>s / <MB> · diarization: <s>s / <MB> · time +<x>% · RSS <PASS|FAIL> · GATE B <PASS|FAIL>

## Accuracy
AMI ES2004a DER: fast32 <x>% (hyp spk <n>/4) · offline <x>% (hyp spk <n>/4)
Real call: true speakers <n>, detected <n>, splits <n>, merges <n>, ~<x>% lines mislabelled

## Embeddings
wespeaker gap <x> · campp gap <x> → chosen: <model>
Me selection: top correct <yes/no>, top cos <x>, margin <x> → v1 threshold <x>, margin <x>

## Edge cases
silence → <[] | n turns> · 48k stereo vs 16k mono boundary drift <x>s · 2h synthetic peak RSS <MB>
language-switch boundaries: <none seen | describe count only>

## Constants for the v1 plan
preset=<fast32|offline> · embedder=<model> · meThreshold=<x> · meMargin=<x> · DER gate=<baseline + 3pp>
```

Use `3pp` as the DER-gate slack, so that a model update causing a small wobble does not block a release. The spec leaves the margin to the spike. Record that choice in the note.

- [ ] **Step 2: Delete real recordings**

```bash
rm -rf ~/Library/Application\ Support/shyn-spike/sessions && ls ~/Library/Application\ Support/shyn-spike/
```

Expected: only `ami/`, `models/` (if Step 6 of Task 1 ran) and the synthetic WAVs remain. No real-call audio, transcripts or `labelled.txt`.

- [ ] **Step 3: Report to the maintainer**

Give the verdict and the constants line. On GO, the next step is the v1 implementation plan, written against these constants. On NO-GO or FALLBACK-ROUTE, stop and discuss.

The spike branch stays local. Ask before pushing it anywhere.
