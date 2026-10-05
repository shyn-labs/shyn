# Speaker Diarization v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split a meeting's far side into `Speaker 1…N` (calls) and an in-person mic recording into `Me` + `Speaker N`, behind an off-by-default setting, without ever costing a transcript.

**Architecture:** After Whisper finishes, `shyn-meeting` runs Nemotron 3 (FluidAudio, offline preset) on ONE channel (system on calls, mic in person), bridges same-speaker gaps, assigns each Whisper segment to the speaker with the most overlap, embeds each speaker with WeSpeaker, and ships neutral labels plus embeddings in the existing `ingest` call. The daemon owns identity: it keeps the user's own voice samples (FIFO 20), picks which in-person speaker is `Me` (threshold + margin), rewrites that speaker's lines to `Me:` before chunking, and discards every other embedding.

**Tech Stack:** Swift 6 / SwiftPM (macOS 14), FluidAudio ≥ 0.17.5 (`Nemotron3Diarizer`, `DiarizerManager` WeSpeaker), WhisperKit `exact: "1.1.0"` (unchanged), TypeScript daemon/engine (vitest), better-sqlite3-multiple-ciphers, Electron status UI.

**Spec:** `docs/superpowers/specs/2026-10-05-speaker-diarization-v1-design.md`. Spike code to crib from: branch `spike/diarization`, `spikes/diarization-probe/Sources/diarization-probe/{Diarize,Assign,Embed}.swift`.

## Global Constraints

- WhisperKit stays `exact: "1.1.0"`. Do not bump or loosen it.
- `meeting.diarization` defaults to **`false`**. With it off, the `ingest` wire is **byte-identical** to 0.5.19: no `speakers`, no `selfSample` keys at all.
- Diarization **never costs a transcript**: any diarizer error, missing model, or timeout falls back to today's `Me`/`Others` assembly and ships normally, logging one `[diarizer]` line to `meeting.log`.
- Diarization runs **after** Whisper in the same `transcribeTask` chain, inside its own `withSystemAwake(reason:)`, and its models are released before `runTranscription` returns. Never resident alongside Whisper.
- The diarizer **never downloads at transcription time**. Models are fetched only by the predownload path; transcription loads only when the ready marker exists.
- Models live under `<SHYN_HOME>/models/fluidaudio/`, never FluidAudio's default `~/Library/Application Support/FluidAudio`.
- v1 stores **no voiceprint except the user's own**. Other speakers' embeddings are dropped after labelling, in the same request.
- Self-profile: keep the **20 most recent** samples; match by **closest sample**, not centroid; a call contributes a sample only with **≥ 30 s** of voiced mic speech.
- Labels: text uses `Me:` / `Speaker N:` / the 1:1 attendee name. A name is never attached to an ambiguous voice (≥ 2 far-side voices).
- Schema goes **v5 → v6**; tables `voice_profiles`, `voice_samples` exactly as the spec defines them.
- Commits as `shynbot <hello@shyn.day>`. Stage in one Bash call, commit in the next (identity-leak hook). Fixtures use `Acme`/`Sam`/`example.com`, never real names.
- README copy, verbatim: "speaker separation is off until you turn it on" and "shyn stores a voiceprint of your own voice only, to tell you apart in in-person meetings".

### Decisions carried in from the spike (2026-10-05)

- **Same-speaker gap bridging of 1.0 s** before assignment. AMI ES2004a raw DER 25.2% (nearly all missed speech from splits at short pauses) → 11.7% bridged.
- **Embedder: WeSpeaker** via `DiarizerManager.extractSpeakerEmbedding` (same/different separation gap 0.556 vs CAM++ 0.128). Fixed 10 s input: embed in 160 000-sample windows, L2-normalise each, length-weighted mean, renormalise; drop a tail < 16 000 samples when other material exists.
- `Nemotron3Diarizer.segments(threshold: 0.5, minDurationSeconds: 0.2)`.
- **`Me` threshold 0.60, margin 0.20 are provisional.** The spike's in-person task never ran, so Task 12 calibrates them on a real recording. The direction of error is safe: too strict means every voice stays `Speaker N`.

## Review Focus

1. **A transcript with diarization on but the model never downloaded.** The user flips the toggle and immediately has a meeting. Expect today's `Me`/`Others` transcript, no error banner, one `[diarizer] skipped: model not ready` log line. Test in Task 7 (`diarizationPlan` returns `.skip` when not ready).
2. **One far-side voice on a 1:1 vs two voices on a "1:1".** Expect the attendee's name only with exactly one voice; `Speaker 1/2` otherwise, with attendees still in the meta header. Test in Task 2.
3. **A segment with no overlapping diarized turn** (Whisper heard words the diarizer called silence). Expect it to keep its channel label (`Others` → still rendered, never dropped). Test in Task 2 (`voice == nil` falls back).
4. **In-person session before any self-profile exists.** Expect every speaker `Speaker N` plus a one-line note saying why; an existing profile that matches nobody clearly adds NO note. Tests in Task 9 (engine `relabelInPerson(null)` unchanged; e2e "before any self sample").
5. **Retry after a daemon outage.** The buffered payload must still carry `speakers`/`selfSample` and produce the same stored text. Test in Task 6 (`IngestPayload` round-trips through `RingBuffer`) and Task 9 (the daemon rewrite is idempotent on re-ingest of the same uri).

---

## File Structure

**Swift (`packages/capture-agent`)**
- `Package.swift`: add FluidAudio, link it into `shyn-meeting` only.
- `Sources/CaptureCore/Diarization.swift` (new): pure types and logic. `DiarizedTurn`, `bridgeTurns`, `assignVoices`, `voiceSpans`, `l2normalized`, `windowedMean`, `encodeEmbedding`.
- `Sources/CaptureCore/TranscriptAssembler.swift`: `TranscriptSegment.voice`, `FarSideLabel.speakers`, labelling rules.
- `Sources/CaptureCore/MeetingConfig.swift`: `diarization: Bool = false`.
- `Sources/CaptureCore/Pipeline.swift`: `IngestPayload.speakers` / `.selfSample` and their types.
- `Sources/CaptureCore/DaemonClient.swift`: send the two keys only when present.
- `Sources/CaptureCore/DiarizationPlan.swift` (new): `diarizationPlan(...)`, the pure decision of whether, and on which channel, to diarize.
- `Sources/shyn-meeting/Diarizer.swift` (new): the FluidAudio-touching code. Model presence, predownload, run, embed.
- `Sources/shyn-meeting/Agent.swift`: predownload gate wiring, `runTranscription` integration, stats.
- `Sources/shyn-meeting/Entry.swift`: `shyn-meeting diarize <wav>` diagnostic.
- `Sources/CaptureCore/MeetingUploader.swift`: `MeetingStats.diarizerDownloading` / `.diarizerReady`.

**TypeScript**
- `packages/engine/src/storage.ts`: v6 tables + migrate step.
- `packages/engine/src/voice.ts` (new): self-sample store, `chooseSelf`, `relabelInPerson`.
- `packages/engine/src/engine.ts`: `ingestMeetingSpeakers`, `forgetSelfVoice`.
- `packages/daemon/src/server.ts`: `ingest` strips and handles `speakers`/`selfSample`; new `voice.forgetSelf`.
- `packages/cli/src/main.ts`: `shyn voice forget-self`.
- `packages/status-ui/src/{controls,derive,main}.ts`, `renderer/render.ts`: "Speaker separation" toggle.
- `scripts/check-diarization.mjs` (new) + `package.json` script: AMI DER release gate.
- `README.md`, `RELEASING.md`, `docs/known-issues.md`: copy, gate, limits.

---

### Task 1: FluidAudio dependency and pure diarization core

**Files:**
- Modify: `packages/capture-agent/Package.swift`
- Create: `packages/capture-agent/Sources/CaptureCore/Diarization.swift`
- Test: `packages/capture-agent/Tests/CaptureCoreTests/DiarizationTests.swift`

**Interfaces:**
- Produces:
  - `public struct DiarizedTurn: Sendable, Equatable { public let speaker: Int; public let start: Double; public let end: Double }`
  - `public func bridgeTurns(_ turns: [DiarizedTurn], gapSeconds: Double = 1.0) -> [DiarizedTurn]`
  - `public func dominantSpeaker(start: Double, end: Double, turns: [DiarizedTurn]) -> Int?`
  - `public func arrivalOrder(_ turns: [DiarizedTurn]) -> [Int: Int]` (raw speaker index → 1-based label number)
  - `public func speechRanges(speaker: Int, turns: [DiarizedTurn]) -> [(Double, Double)]`
  - `public func l2normalized(_ v: [Float]) -> [Float]`
  - `public func cosine(_ a: [Float], _ b: [Float]) -> Float`
  - `public func windowedMean(_ audio: [Float], window: Int, minTail: Int, embed: ([Float]) throws -> [Float]) throws -> [Float]`
  - `public func encodeEmbedding(_ v: [Float]) -> String` (base64 of little-endian float32)

- [ ] **Step 1: Add FluidAudio to the package**

In `Package.swift`, add the dependency after the WhisperKit line, and add the product to the `shyn-meeting` target only:

```swift
        .package(url: "https://github.com/argmaxinc/WhisperKit", exact: "1.1.0"),
        // Diarization + speaker embeddings only (spec 2026-10-05). ASR stays WhisperKit.
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.17.5"),
```

```swift
          .executableTarget(name: "shyn-meeting", dependencies: [
              "CaptureCore", .product(name: "WhisperKit", package: "WhisperKit"),
              .product(name: "FluidAudio", package: "FluidAudio"),
          ]),
```

Run: `cd packages/capture-agent && swift package resolve && swift build -c release 2>&1 | grep -E 'error:|Build complete'`
Expected: `Build complete!` (the spike proved FluidAudio 0.17.5 + WhisperKit 1.1.0 coexist).

- [ ] **Step 2: Write the failing tests**

`Tests/CaptureCoreTests/DiarizationTests.swift`:

```swift
import Testing
import Foundation
@testable import CaptureCore

private func t(_ s: Int, _ a: Double, _ b: Double) -> DiarizedTurn { DiarizedTurn(speaker: s, start: a, end: b) }

@Test func bridgingMergesShortSameSpeakerGapsOnly() {
    // Spike, AMI ES2004a: the model splits a speaker at short pauses; bridging 1.0s
    // took DER 25.2% → 11.7%. A different speaker in the gap must not be swallowed.
    let turns = [t(0, 0, 2), t(0, 2.6, 4), t(1, 4.2, 5), t(0, 7, 8)]
    #expect(bridgeTurns(turns) == [t(0, 0, 4), t(1, 4.2, 5), t(0, 7, 8)])
}

@Test func bridgingKeepsOverlappingSpeakersApart() {
    let turns = [t(0, 0, 3), t(1, 2, 4), t(0, 4.5, 6)]
    #expect(bridgeTurns(turns) == [t(0, 0, 6), t(1, 2, 4)])
}

@Test func dominantSpeakerIsWhoeverTalkedLongestInsideTheSpan() {
    let turns = [t(0, 0, 3), t(1, 2, 10)]
    #expect(dominantSpeaker(start: 1, end: 6, turns: turns) == 1)   // speaker 1: 4s, speaker 0: 2s
    #expect(dominantSpeaker(start: 0, end: 2.5, turns: turns) == 0)
}

@Test func anExactTieGoesToTheLowerSpeaker() {
    let turns = [t(1, 0, 1), t(0, 1, 2)]
    #expect(dominantSpeaker(start: 0, end: 2, turns: turns) == 0)
}

@Test func aSpanWithNoTurnHasNoSpeaker() {
    #expect(dominantSpeaker(start: 5, end: 6, turns: [t(0, 0, 1)]) == nil)
}

@Test func labelsFollowFirstArrivalNotModelIndex() {
    // Nemotron's index is arbitrary; "Speaker 1" must be whoever spoke first.
    let turns = [t(3, 5, 6), t(1, 0, 1), t(3, 2, 3)]
    #expect(arrivalOrder(turns) == [1: 1, 3: 2])
}

@Test func speechRangesAreOneSpeakersTurnsInOrder() {
    let turns = [t(0, 4, 5), t(1, 0, 1), t(0, 0.5, 2)]
    let r = speechRanges(speaker: 0, turns: turns)
    #expect(r.map(\.0) == [0.5, 4]); #expect(r.map(\.1) == [2, 5])
}

@Test func windowedMeanWeightsByLengthAndDropsATinyTail() throws {
    // Two full windows embed to orthogonal unit vectors; a 1-sample tail is dropped.
    var calls = 0
    let v = try windowedMean([Float](repeating: 0, count: 21), window: 10, minTail: 2) { _ in
        calls += 1; return calls == 1 ? [1, 0] : [0, 1]
    }
    #expect(calls == 2)
    #expect(abs(v[0] - v[1]) < 1e-6)
    #expect(abs(v[0] * v[0] + v[1] * v[1] - 1) < 1e-5)
}

@Test func windowedMeanOfNothingThrows() {
    #expect(throws: (any Error).self) { _ = try windowedMean([], window: 10, minTail: 2) { _ in [1] } }
}

@Test func cosineOfANormalisedVectorWithItselfIsOne() {
    let v = l2normalized([3, 4])
    #expect(abs(cosine(v, v) - 1) < 1e-6)
    #expect(abs(cosine([1, 0], [0, 1])) < 1e-6)
}

@Test func embeddingsEncodeAsLittleEndianFloat32Base64() {
    // 1.0f = 0x3F800000 → bytes 00 00 80 3F
    #expect(encodeEmbedding([1]) == Data([0, 0, 0x80, 0x3F]).base64EncodedString())
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/capture-agent && swift build --build-tests 2>&1 | grep -E 'error:' | head -3`
Expected: `cannot find 'DiarizedTurn' in scope` (and similar).

- [ ] **Step 4: Write the implementation**

`Sources/CaptureCore/Diarization.swift`:

```swift
import Foundation

// Pure half of speaker diarization (spec 2026-10-05). Nothing here touches a
// model, so it is all testable; shyn-meeting/Diarizer.swift owns FluidAudio.

/// One stretch of one speaker, on the channel's own timeline (seconds).
public struct DiarizedTurn: Sendable, Equatable {
    public let speaker: Int
    public let start: Double
    public let end: Double
    public init(speaker: Int, start: Double, end: Double) {
        self.speaker = speaker; self.start = start; self.end = end
    }
}

/// Merges a speaker's consecutive turns separated by <= `gapSeconds`. Nemotron
/// splits one speaker at short pauses; on the AMI spike clip bridging 1.0s took
/// DER from 25.2% to 11.7%. Turns of OTHER speakers are left alone, so an
/// interjection inside the gap still exists; overlap is how real meetings sound.
public func bridgeTurns(_ turns: [DiarizedTurn], gapSeconds: Double = 1.0) -> [DiarizedTurn] {
    var bySpeaker: [Int: [DiarizedTurn]] = [:]
    for t in turns { bySpeaker[t.speaker, default: []].append(t) }
    var out: [DiarizedTurn] = []
    for (speaker, ts) in bySpeaker {
        let sorted = ts.sorted { $0.start < $1.start }
        var cur = sorted[0]
        for n in sorted.dropFirst() {
            if n.start - cur.end <= gapSeconds {
                cur = DiarizedTurn(speaker: speaker, start: cur.start, end: max(cur.end, n.end))
            } else { out.append(cur); cur = n }
        }
        out.append(cur)
    }
    return out.sorted { $0.start != $1.start ? $0.start < $1.start : $0.speaker < $1.speaker }
}

/// The speaker with the most active time inside [start, end); nil if none
/// overlaps. An exact tie goes to the lower index (Dictionary order is not
/// deterministic, and a label must not flip between two runs).
public func dominantSpeaker(start: Double, end: Double, turns: [DiarizedTurn]) -> Int? {
    var overlap: [Int: Double] = [:]
    for t in turns {
        let o = min(end, t.end) - max(start, t.start)
        if o > 0 { overlap[t.speaker, default: 0] += o }
    }
    return overlap.max { $0.value != $1.value ? $0.value < $1.value : $0.key > $1.key }?.key
}

/// Raw model index → 1-based label in order of first appearance, so
/// "Speaker 1" is whoever spoke first in this meeting.
public func arrivalOrder(_ turns: [DiarizedTurn]) -> [Int: Int] {
    var order: [Int: Int] = [:]
    for t in turns.sorted(by: { $0.start < $1.start }) where order[t.speaker] == nil {
        order[t.speaker] = order.count + 1
    }
    return order
}

/// One speaker's turns as (start, end) pairs in time order.
public func speechRanges(speaker: Int, turns: [DiarizedTurn]) -> [(Double, Double)] {
    turns.filter { $0.speaker == speaker }.sorted { $0.start < $1.start }.map { ($0.start, $0.end) }
}

public func l2normalized(_ v: [Float]) -> [Float] {
    let n = max(1e-9, v.reduce(0) { $0 + $1 * $1 }.squareRoot())
    return v.map { $0 / n }
}

public func cosine(_ a: [Float], _ b: [Float]) -> Float {
    var dot: Float = 0, na: Float = 0, nb: Float = 0
    for i in 0..<min(a.count, b.count) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
    return dot / max(1e-9, na.squareRoot() * nb.squareRoot())
}

public struct EmbeddingError: Error, CustomStringConvertible {
    public let description: String
}

/// WeSpeaker's Core ML model takes a FIXED 10 s input and silently truncates
/// longer audio (spike Embed.swift notes), so a speaker's speech is embedded in
/// `window`-sample pieces, each L2-normalised, then length-weighted and
/// renormalised. A tail shorter than `minTail` is dropped when there is other
/// material: a repeat-padded scrap would be dominated by its own repetition.
public func windowedMean(_ audio: [Float], window: Int, minTail: Int,
                         embed: ([Float]) throws -> [Float]) throws -> [Float] {
    var sum: [Float] = []
    var total: Float = 0
    var start = 0
    while start < audio.count {
        let end = min(audio.count, start + window)
        if end - start < minTail && start > 0 { break }
        let e = l2normalized(try embed(Array(audio[start..<end])))
        if sum.isEmpty { sum = [Float](repeating: 0, count: e.count) }
        let w = Float(end - start)
        for i in 0..<min(sum.count, e.count) { sum[i] += e[i] * w }
        total += w
        start = end
    }
    guard total > 0 else { throw EmbeddingError(description: "no audio to embed") }
    return l2normalized(sum)
}

/// Wire form of an embedding: base64 of little-endian float32 (spec, Data model).
public func encodeEmbedding(_ v: [Float]) -> String {
    var d = Data(capacity: v.count * 4)
    for f in v { withUnsafeBytes(of: f.bitPattern.littleEndian) { d.append(contentsOf: $0) } }
    return d.base64EncodedString()
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/capture-agent && swift test 2>&1 | grep -E 'Test run with|✘' | head -5`
Expected: every run line `passed`, no `✘`.

- [ ] **Step 6: Commit**

```bash
git add packages/capture-agent/Package.swift packages/capture-agent/Package.resolved packages/capture-agent/Sources/CaptureCore/Diarization.swift packages/capture-agent/Tests/CaptureCoreTests/DiarizationTests.swift
```
```bash
git commit -m "feat(meeting): pure diarization core (bridge, assign, arrival order, embeddings) + FluidAudio dep"
```

---

### Task 2: Voice-aware segments and labelling rules

**Files:**
- Modify: `packages/capture-agent/Sources/CaptureCore/TranscriptAssembler.swift`
- Test: `packages/capture-agent/Tests/CaptureCoreTests/TranscriptAssemblerTests.swift`

**Interfaces:**
- Consumes: `DiarizedTurn`, `dominantSpeaker`, `arrivalOrder` (Task 1).
- Produces:
  - `TranscriptSegment.voice: Int?` (1-based diarized label; `nil` = not diarized). New init parameter `voice: Int? = nil`; every existing call site compiles unchanged.
  - `public func assignVoices(_ segments: [TranscriptSegment], channel: Speaker, turns: [DiarizedTurn]) -> [TranscriptSegment]`
  - `FarSideLabel.speakers`: render `Speaker N:` for any segment with a `voice`, `Me:` for mic segments without one, `Others:` for far-side segments without one.
  - `public func farSideLabel(_ segments: [TranscriptSegment], others: [String], diarized: Bool) -> FarSideLabel` (the existing 2-arg function stays and forwards with `diarized: false`).

- [ ] **Step 1: Write the failing tests**

Append to `TranscriptAssemblerTests.swift`:

```swift
private func seg(_ s: Double, _ e: Double, _ who: Speaker, _ text: String, voice: Int? = nil) -> TranscriptSegment {
    TranscriptSegment(start: s, end: e, speaker: who, text: text, voice: voice)
}

@Test func assignVoicesLabelsOnlyTheDiarizedChannelInArrivalOrder() {
    let segs = [seg(0, 2, .others, "hi all"), seg(1, 2, .me, "hello"), seg(5, 7, .others, "second voice")]
    let turns = [DiarizedTurn(speaker: 4, start: 4, end: 8), DiarizedTurn(speaker: 2, start: 0, end: 3)]
    let out = assignVoices(segs, channel: .others, turns: turns)
    #expect(out.map(\.voice) == [1, nil, 2])     // speaker 2 arrived first → Speaker 1
}

@Test func aSegmentNoTurnCoversKeepsItsChannelLabel() {
    // Review focus 3: Whisper heard words the diarizer called silence. Never drop them.
    let out = assignVoices([seg(10, 11, .others, "late words")], channel: .others,
                           turns: [DiarizedTurn(speaker: 0, start: 0, end: 1)])
    #expect(out[0].voice == nil)
    #expect(assembleTranscript(out, farSide: .speakers) == "Others: late words")
}

@Test func oneFarVoiceOnAOneToOneKeepsTheName() {
    let segs = [seg(0, 1, .me, "hi"), seg(1, 2, .others, "hey", voice: 1)]
    #expect(farSideLabel(segs, others: ["Sam K"], diarized: true) == .named("Sam K"))
}

@Test func twoFarVoicesOnAOneToOneNeverGetTheName() {
    // Review focus 2: a name is never attached to an ambiguous voice.
    let segs = [seg(1, 2, .others, "hey", voice: 1), seg(3, 4, .others, "me too", voice: 2)]
    #expect(farSideLabel(segs, others: ["Sam K"], diarized: true) == .speakers)
}

@Test func aDiarizedInPersonSessionIsSpeakersNotUnattributed() {
    let segs = [seg(0, 1, .me, "shall we", voice: 1), seg(1, 2, .me, "yes", voice: 2)]
    #expect(farSideLabel(segs, others: [], diarized: true) == .speakers)
    #expect(assembleTranscript(segs, farSide: .speakers) == "Speaker 1: shall we\nSpeaker 2: yes")
    #expect(speakerNote(.speakers) == nil)
}

@Test func onACallTheMicStaysMeAndTheFarSideIsNumbered() {
    let segs = [seg(0, 1, .me, "morning"), seg(1, 2, .others, "morning", voice: 1),
                seg(2, 3, .others, "hi from me", voice: 2)]
    #expect(assembleTranscript(segs, farSide: .speakers)
            == "Me: morning\nSpeaker 1: morning\nSpeaker 2: hi from me")
}

@Test func diarizationOffKeepsTodaysLabels() {
    let segs = [seg(0, 1, .me, "a"), seg(1, 2, .others, "b")]
    #expect(farSideLabel(segs, others: [], diarized: false) == farSideLabel(segs, others: []))
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/capture-agent && swift build --build-tests 2>&1 | grep -E 'error:' | head -3`
Expected: `extra argument 'voice' in call` / `type 'FarSideLabel' has no member 'speakers'`.

- [ ] **Step 3: Implement**

In `TranscriptSegment`, add the stored property and init parameter (keep every existing doc comment):

```swift
    public let text: String
    /// The diarized speaker label (1-based, arrival order) when this segment's
    /// channel was diarized; nil otherwise, including a segment no turn covered.
    public let voice: Int?
    public init(start: Double, end: Double? = nil, speaker: Speaker, text: String, voice: Int? = nil) {
        self.start = start; self.end = end; self.speaker = speaker; self.text = text; self.voice = voice
    }
```

Add the case to `FarSideLabel`, after `unattributed`:

```swift
    /// Diarization ran: speakers are rendered "Speaker N" from each segment's
    /// voice. The mic stays "Me" on calls because it is not diarized there.
    case speakers
```

Below the existing `farSideLabel`, add the diarized variant, and make the old one forward:

```swift
/// With `diarized`, one far-side voice on a 1:1 keeps the attendee's name, as
/// before; two or more voices on a "1:1" become Speaker N, because which of
/// them is the named person is exactly what we cannot know.
public func farSideLabel(_ segments: [TranscriptSegment], others: [String], diarized: Bool) -> FarSideLabel {
    guard diarized, segments.contains(where: { $0.voice != nil }) else {
        return farSideLabel(segments, others: others)
    }
    let farVoices = Set(segments.filter { $0.speaker == .others }.compactMap(\.voice))
    if farVoices.count == 1, others.count == 1,
       !others[0].trimmingCharacters(in: .whitespaces).isEmpty {
        return .named(others[0])
    }
    return .speakers
}

/// Stamps `voice` on every segment of `channel` from the diarized turns; the
/// other channel is untouched. A segment no turn overlaps keeps voice nil and
/// therefore its channel label: words are never dropped for a missing turn.
public func assignVoices(_ segments: [TranscriptSegment], channel: Speaker,
                         turns: [DiarizedTurn]) -> [TranscriptSegment] {
    let order = arrivalOrder(turns)
    return segments.map { s in
        guard s.speaker == channel,
              let raw = dominantSpeaker(start: s.start, end: s.end ?? s.start, turns: turns),
              let n = order[raw] else { return s }
        return TranscriptSegment(start: s.start, end: s.end, speaker: s.speaker, text: s.text, voice: n)
    }
}
```

In `assembleTranscript`, add the case before `case .others:`:

```swift
    case .speakers:
        return ordered
            .map { s in
                let who = s.voice.map { "Speaker \($0)" } ?? s.speaker.rawValue
                return "\(who): \(s.text)"
            }
            .joined(separator: "\n")
```

`speakerNote` already returns nil for every case but `.unattributed`; confirm its `switch`/`if` needs no change (if it is a `switch`, add `case .speakers: return nil`).

Note for `assignVoices` on a segment with `end == nil`: `dominantSpeaker(start:end:)` gets a zero-length span and returns nil, so the segment keeps its channel label. Both production call sites always set `end`, so this is only the defensive path.

- [ ] **Step 4: Run tests**

Run: `cd packages/capture-agent && swift test 2>&1 | grep -E 'Test run with|✘' | head -5`
Expected: all pass, including every pre-existing `TranscriptAssemblerTests`.

- [ ] **Step 5: Commit**

```bash
git add packages/capture-agent/Sources/CaptureCore/TranscriptAssembler.swift packages/capture-agent/Tests/CaptureCoreTests/TranscriptAssemblerTests.swift
```
```bash
git commit -m "feat(meeting): segments carry a diarized voice; Speaker N labelling with 1:1 name rules"
```

---

### Task 3: `meeting.diarization` setting

**Files:**
- Modify: `packages/capture-agent/Sources/CaptureCore/MeetingConfig.swift`
- Test: `packages/capture-agent/Tests/CaptureCoreTests/MeetingConfigTests.swift`

**Interfaces:**
- Produces: `MeetingConfig.diarization: Bool` (default `false`, decoded with `decodeIfPresent`).

- [ ] **Step 1: Write the failing test**

```swift
@Test func diarizationIsOffUnlessTurnedOn() throws {
    #expect(MeetingConfig.defaults.diarization == false)
    let on = try JSONDecoder().decode(MeetingConfig.self, from: Data(#"{"diarization": true}"#.utf8))
    #expect(on.diarization == true)
    let other = try JSONDecoder().decode(MeetingConfig.self, from: Data(#"{"whisperModel": "small"}"#.utf8))
    #expect(other.diarization == false)
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/capture-agent && swift build --build-tests 2>&1 | grep -E 'error:' | head -2`
Expected: `value of type 'MeetingConfig' has no member 'diarization'`.

- [ ] **Step 3: Implement**

In `MeetingConfig`, follow the exact shape of `chunkedTranscription`: add the property with default `false`, add `diarization` to `CodingKeys` (if the struct declares them explicitly), and add to the custom `init(from:)`:

```swift
        diarization = try c.decodeIfPresent(Bool.self, forKey: .diarization) ?? false
```

With a property comment:

```swift
    /// Speaker separation (spec 2026-10-05). Off by default: when false the
    /// ingest wire is byte-identical to 0.5.19 and no model is downloaded.
    public var diarization: Bool = false
```

If `MeetingConfig` has a memberwise `init(...)` used by tests, add `diarization: Bool = false` as its last parameter.

- [ ] **Step 4: Run tests**

Run: `cd packages/capture-agent && swift test 2>&1 | grep -E 'Test run with|✘' | head -5`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/capture-agent/Sources/CaptureCore/MeetingConfig.swift packages/capture-agent/Tests/CaptureCoreTests/MeetingConfigTests.swift
```
```bash
git commit -m "feat(meeting): meeting.diarization setting, off by default"
```

---

### Task 4: FluidAudio diarizer, local model store, and diagnostic

**Files:**
- Create: `packages/capture-agent/Sources/shyn-meeting/Diarizer.swift`
- Modify: `packages/capture-agent/Sources/shyn-meeting/Entry.swift` (add `diarize` diagnostic subcommand)

**Interfaces:**
- Consumes: `DiarizedTurn`, `bridgeTurns`, `speechRanges`, `windowedMean` (Task 1).
- Produces (all internal to `shyn-meeting`):
  - `let diarizerModelDir: URL` = `<home>/models/fluidaudio`
  - `func diarizerModelsReady(dir: URL) -> Bool`
  - `func downloadDiarizerModels(dir: URL) async -> Bool`
  - `struct ChannelDiarization { let turns: [DiarizedTurn]; let embeddings: [Int: (embedding: [Float], speechSec: Double)] }`
  - `func diarizeChannel(samples: [Float], dir: URL) async throws -> ChannelDiarization`
  - `func embedSpeech(samples: [Float], ranges: [(Double, Double)], dir: URL) async throws -> [Float]`

This task touches FluidAudio, which has no fake, so its test is the `diarize` diagnostic run against real audio (Step 4), like `shyn-meeting transcribe` for Whisper.

- [ ] **Step 1: Write `Diarizer.swift`**

```swift
import CaptureCore
import FluidAudio
import Foundation

// The only file that touches FluidAudio. Everything decidable without a model
// lives in CaptureCore/Diarization.swift.
//
// Models live under SHYN_HOME, never FluidAudio's default Application Support
// folder: uninstall --purge must take them, and the agent must never download
// while transcribing (lived 2026-09-22: a hub check during load made the same
// binary take 9s or 49s). Only downloadDiarizerModels fetches; it writes the
// ready marker LAST, so an interrupted download reads as not ready.

let diarizerModelDir = URL(fileURLWithPath: home + "/models/fluidaudio")
private let readyMarker = ".shyn-diarizer-ready"

func diarizerModelsReady(dir: URL) -> Bool {
    FileManager.default.fileExists(atPath: dir.appendingPathComponent(readyMarker).path)
}

/// Fetches Nemotron 3 (offline preset) and the WeSpeaker embedder into `dir`.
/// Background-only (predownload gate); never called on the transcription path.
func downloadDiarizerModels(dir: URL) async -> Bool {
    do {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        _ = try await Nemotron3Models.loadFromHuggingFace(config: .offline, cacheDirectory: dir)
        _ = try await DiarizerModels.downloadIfNeeded(to: dir.appendingPathComponent("wespeaker"))
        try Data("1\n".utf8).write(to: dir.appendingPathComponent(readyMarker), options: .atomic)
        return true
    } catch {
        FileHandle.standardError.write(Data(logLine("[diarizer] model download failed: \(error)").utf8))
        return false
    }
}

struct ChannelDiarization {
    let turns: [DiarizedTurn]
    /// Raw speaker index → its embedding and seconds of speech.
    let embeddings: [Int: (embedding: [Float], speechSec: Double)]
}

// WeSpeaker's fixed 10 s input (spike Embed.swift): 160_000 samples at 16 kHz.
private let wespeakerWindow = 160_000
private let wespeakerMinTail = 16_000

/// Diarizes one 16 kHz mono channel and embeds every speaker found. Loads both
/// models, uses them, and lets them go out of scope before returning: never
/// resident beside Whisper. Throws on any model failure; the caller falls back.
func diarizeChannel(samples: [Float], dir: URL) async throws -> ChannelDiarization {
    guard diarizerModelsReady(dir: dir) else {
        throw EmbeddingError(description: "diarizer models not ready")
    }
    let config = Nemotron3Config.offline
    let models = try await Nemotron3Models.loadFromHuggingFace(config: config, cacheDirectory: dir)
    let diarizer = Nemotron3Diarizer(config: config, models: models)
    let (probs, frames) = try diarizer.processComplete(samples)
    let raw = Nemotron3Diarizer.segments(
        probabilities: probs, frameCount: frames, threshold: 0.5, minDurationSeconds: 0.2
    ).map { DiarizedTurn(speaker: $0.speakerIndex, start: Double($0.startSeconds), end: Double($0.endSeconds)) }
    let turns = bridgeTurns(raw)

    let manager = DiarizerManager()
    manager.initialize(models: try await DiarizerModels.downloadIfNeeded(to: dir.appendingPathComponent("wespeaker")))
    var embeddings: [Int: (embedding: [Float], speechSec: Double)] = [:]
    for speaker in Set(turns.map(\.speaker)) {
        let ranges = speechRanges(speaker: speaker, turns: turns)
        let audio = slice(samples, ranges: ranges)
        guard !audio.isEmpty else { continue }
        let e = try windowedMean(audio, window: wespeakerWindow, minTail: wespeakerMinTail) {
            try manager.extractSpeakerEmbedding(from: $0)
        }
        embeddings[speaker] = (e, ranges.reduce(0) { $0 + ($1.1 - $1.0) })
    }
    return ChannelDiarization(turns: turns, embeddings: embeddings)
}

/// One embedding of the given speech ranges (the user's self-sample on calls).
func embedSpeech(samples: [Float], ranges: [(Double, Double)], dir: URL) async throws -> [Float] {
    guard diarizerModelsReady(dir: dir) else {
        throw EmbeddingError(description: "diarizer models not ready")
    }
    let manager = DiarizerManager()
    manager.initialize(models: try await DiarizerModels.downloadIfNeeded(to: dir.appendingPathComponent("wespeaker")))
    return try windowedMean(slice(samples, ranges: ranges), window: wespeakerWindow, minTail: wespeakerMinTail) {
        try manager.extractSpeakerEmbedding(from: $0)
    }
}

private func slice(_ s: [Float], ranges: [(Double, Double)]) -> [Float] {
    ranges.flatMap { r -> ArraySlice<Float> in
        let a = max(0, Int(r.0 * 16_000)), b = min(s.count, Int(r.1 * 16_000))
        return a < b ? s[a..<b] : []
    }
}
```

`EmbeddingError` is the public error type from `CaptureCore/Diarization.swift`, reused here so there is one error type for "no diarization".

- [ ] **Step 2: Add the diagnostic to `Entry.swift`**

Find the existing `transcribe` diagnostic branch (the `shyn-meeting transcribe a.wav b.wav [--whole]` handler) and add a sibling branch with the same structure:

```swift
        if args.count >= 2, args[0] == "diarize" {
            // shyn-meeting diarize <wav> [--download]: one channel → turns + per-speaker
            // speech seconds. --download fetches models first (diagnostic only).
            let path = args[1]
            if args.contains("--download") { _ = await downloadDiarizerModels(dir: diarizerModelDir) }
            do {
                let samples = try AudioProcessor.loadAudioAsFloatArray(fromPath: path)
                let t0 = Date()
                let d = try await diarizeChannel(samples: samples, dir: diarizerModelDir)
                for t in d.turns { print(String(format: "%8.2f %8.2f  S%d", t.start, t.end, t.speaker)) }
                for (s, e) in d.embeddings.sorted(by: { $0.key < $1.key }) {
                    print(String(format: "speaker S%d speech=%.1fs dim=%d", s, e.speechSec, e.embedding.count))
                }
                print(String(format: "turns=%d speakers=%d wall=%.1fs", d.turns.count, d.embeddings.count,
                             Date().timeIntervalSince(t0)))
                exit(0)
            } catch {
                FileHandle.standardError.write(Data("diarize failed: \(error)\n".utf8)); exit(1)
            }
        }
```

Also add an `rttm` flag so the release gate (Task 11) can score it: when `args.contains("--rttm")`, print each turn as `SPEAKER <uri> 1 <start> <dur> <NA> <NA> spk<N> <NA> <NA>` instead of the table, with `<uri>` = the file's basename without extension.

```swift
                if args.contains("--rttm") {
                    let uri = URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
                    for t in d.turns {
                        print(String(format: "SPEAKER %@ 1 %.3f %.3f <NA> <NA> spk%d <NA> <NA>",
                                     uri, t.start, t.end - t.start, t.speaker))
                    }
                    exit(0)
                }
```

(Place the `--rttm` block immediately after `let d = …`.)

- [ ] **Step 3: Build**

Run: `cd packages/capture-agent && swift build -c release 2>&1 | grep -E 'error:|Build complete'`
Expected: `Build complete!`

- [ ] **Step 4: Verify on real audio, including fully offline**

```bash
cd packages/capture-agent
B=.build/release/shyn-meeting
AMI="$HOME/Library/Application Support/shyn-spike/ami/ES2004a.wav"
SHYN_HOME=$(mktemp -d) $B diarize "$AMI" --download | tail -6
```
Expected: `speakers=4` (spike: 4/4 on ES2004a), four `speaker S… speech=` lines with the same `dim=` (WeSpeaker; 256 expected), wall well under a minute (spike: ~16 s for 2 h of audio, plus the one-time download).

Then prove the transcription path never touches the network, using the same temp home:

```bash
H=<the temp dir printed above, or re-run with a fixed one: export SHYN_HOME=/tmp/shyn-diar-test>
sandbox-exec -p '(version 1)(allow default)(deny network*)' env SHYN_HOME="$H" $B diarize "$AMI" | tail -1
```
Expected: the same `turns=… speakers=4` line. Any network error here means a load path downloads at runtime; fix that before continuing (it violates a Global Constraint).

If the AMI clip is absent, fetch it with the spike's `spikes/diarization-probe/scripts/fetch-ami.sh` from branch `spike/diarization`.

- [ ] **Step 5: Commit**

```bash
git add packages/capture-agent/Sources/shyn-meeting/Diarizer.swift packages/capture-agent/Sources/shyn-meeting/Entry.swift
```
```bash
git commit -m "feat(meeting): Nemotron 3 + WeSpeaker diarizer under SHYN_HOME, offline load, diarize diagnostic"
```

---

### Task 5: Diarizer model predownload and stats

**Files:**
- Modify: `packages/capture-agent/Sources/shyn-meeting/Agent.swift` (beside `maybeKickPredownload`, ~659-689)
- Modify: `packages/capture-agent/Sources/CaptureCore/MeetingUploader.swift` (`MeetingStats`, ~54)
- Test: `packages/capture-agent/Tests/CaptureCoreTests/MeetingPayloadTests.swift` (stats encoding) or the file that already tests `MeetingStats` encoding

**Interfaces:**
- Consumes: `diarizerModelsReady`, `downloadDiarizerModels`, `diarizerModelDir` (Task 4); `MeetingConfig.diarization` (Task 3); `ModelPredownloadGate` (existing).
- Produces: `MeetingStats.diarizerDownloading: Bool?`, `MeetingStats.diarizerReady: Bool?`. Both are nil when diarization is off, so the stats wire is unchanged for users who never enable it.

- [ ] **Step 1: Write the failing test**

Find the existing test that encodes `MeetingStats` (grep `whisperDownloading` under `Tests/`) and add next to it:

```swift
@Test func diarizerStatsAreAbsentUntilSet() throws {
    var s = MeetingStats()
    var json = String(data: try JSONEncoder().encode(s), encoding: .utf8)!
    #expect(!json.contains("diarizer"))
    s.diarizerReady = true
    s.diarizerDownloading = false
    json = String(data: try JSONEncoder().encode(s), encoding: .utf8)!
    #expect(json.contains("\"diarizerReady\":true"))
}
```

If `MeetingStats` is not `Encodable` but serialized by hand into a dictionary, assert on that dictionary instead, mirroring how the existing `whisperDownloading` test does it.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/capture-agent && swift build --build-tests 2>&1 | grep error: | head -2`
Expected: `has no member 'diarizerReady'`.

- [ ] **Step 3: Implement**

`MeetingStats`, beside `whisperDownloading`:

```swift
    /// nil unless meeting.diarization is on (stats wire unchanged otherwise).
    public var diarizerDownloading: Bool? = nil
    public var diarizerReady: Bool? = nil
```

If `MeetingStats` is hand-serialized, add both keys only when non-nil, exactly like `whisperDownloading`.

`Agent.swift`, next to `predownloadGate`:

```swift
    // Second gate: one inFlight flag per model, and the diarizer must never wait
    // behind (or block) a Whisper download.
    private var diarizerGate = ModelPredownloadGate()

    func maybeKickDiarizerPredownload() async {
        let cfg = MeetingConfig.load(from: configPath)
        guard cfg.diarization else {
            if stats.diarizerReady != nil || stats.diarizerDownloading != nil {
                stats.diarizerReady = nil; stats.diarizerDownloading = nil
            }
            return
        }
        let ready = diarizerModelsReady(dir: diarizerModelDir)
        stats.diarizerReady = ready
        guard diarizerGate.shouldKick(present: ready, now: Int(Date().timeIntervalSince1970)) else { return }
        stats.diarizerDownloading = true
        Task.detached(priority: .background) {
            let ok = await downloadDiarizerModels(dir: diarizerModelDir)
            await self.finishDiarizerPredownload(success: ok)
        }
    }

    private func finishDiarizerPredownload(success: Bool) async {
        diarizerGate.finished(success: success, now: Int(Date().timeIntervalSince1970))
        stats.diarizerDownloading = false
        stats.diarizerReady = diarizerModelsReady(dir: diarizerModelDir)
        await postStats(state: reportedMeetingState(
            detector: detector.state, manualLive: manualSession && sessionDir != nil,
            pendingTranscriptions: pendingTranscriptions))
    }
```

In the 3-second loop (~Agent.swift:748-754), add `await agent.maybeKickDiarizerPredownload()` right after `maybeKickPredownload()`, using the same receiver name the loop uses.

- [ ] **Step 4: Run tests and build**

Run: `cd packages/capture-agent && swift test 2>&1 | grep -E 'Test run with|✘' | head -5 && swift build -c release 2>&1 | grep -E 'error:|Build complete'`
Expected: all pass; `Build complete!`

- [ ] **Step 5: Commit**

```bash
git add packages/capture-agent/Sources/shyn-meeting/Agent.swift packages/capture-agent/Sources/CaptureCore/MeetingUploader.swift packages/capture-agent/Tests/CaptureCoreTests/
```
```bash
git commit -m "feat(meeting): diarizer models predownload behind their own gate when diarization is on"
```

---

### Task 6: Speakers on the ingest wire

**Files:**
- Modify: `packages/capture-agent/Sources/CaptureCore/Pipeline.swift` (`IngestPayload`)
- Modify: `packages/capture-agent/Sources/CaptureCore/DaemonClient.swift:59-62`
- Test: `packages/capture-agent/Tests/CaptureCoreTests/MeetingPayloadTests.swift`

**Interfaces:**
- Produces:
  - `public struct SpeakerPayload: Sendable, Equatable { public let label: String; public let channel: String; public let embedding: String; public let speechSec: Double }` (`label` like `"S1"`, `channel` `"system"|"mic"`, `embedding` base64 float32)
  - `public struct VoiceSamplePayload: Sendable, Equatable { public let embedding: String; public let speechSec: Double }`
  - `IngestPayload.speakers: [SpeakerPayload]?`, `IngestPayload.selfSample: VoiceSamplePayload?` (both default nil; existing init call sites compile unchanged)
  - `public func ingestParams(_ p: IngestPayload) -> [String: Any]` (the dictionary `DaemonClient.ingest` sends; pulled out so it is testable)

- [ ] **Step 1: Write the failing tests**

```swift
@Test func ingestParamsWithoutSpeakersAreExactlyTodays() {
    let p = IngestPayload(source: "meeting", uri: "meeting://x/1", title: "t", ts: 1, text: "Me: hi", meta: ["a": "b"])
    #expect(Set(ingestParams(p).keys) == ["source", "uri", "title", "ts", "text", "meta"])
}

@Test func speakersAndSelfSampleTravelWithTheTranscript() {
    let p = IngestPayload(source: "meeting", uri: "meeting://x/1", title: "t", ts: 1, text: "Speaker 1: hi",
                          meta: [:],
                          speakers: [SpeakerPayload(label: "S1", channel: "mic", embedding: "AACAPw==", speechSec: 40)],
                          selfSample: VoiceSamplePayload(embedding: "AACAPw==", speechSec: 31))
    let d = ingestParams(p)
    let s = d["speakers"] as? [[String: Any]]
    #expect(s?.first?["label"] as? String == "S1")
    #expect(s?.first?["channel"] as? String == "mic")
    #expect((d["selfSample"] as? [String: Any])?["speechSec"] as? Double == 31)
}

@Test func aBufferedPayloadKeepsItsSpeakers() {
    // Review focus 5: daemon down → RingBuffer → retry must not lose speakers.
    var buf = RingBuffer<IngestPayload>(capacity: 2)
    buf.append(IngestPayload(source: "meeting", uri: "u", title: "t", ts: 1, text: "x", meta: [:],
                             speakers: [SpeakerPayload(label: "S1", channel: "system", embedding: "", speechSec: 1)]))
    #expect(buf.drain().first?.speakers?.count == 1)
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/capture-agent && swift build --build-tests 2>&1 | grep error: | head -2`
Expected: `cannot find 'ingestParams' in scope`.

- [ ] **Step 3: Implement**

`Pipeline.swift`, replace `IngestPayload` with (keeping its position):

```swift
/// One diarized speaker as sent to the daemon. Other people's embeddings exist
/// only for the length of this request: the daemon labels with them and drops them.
public struct SpeakerPayload: Sendable, Equatable {
    public let label: String       // "S1", matches "Speaker 1:" in text
    public let channel: String     // "system" | "mic"
    public let embedding: String   // base64 float32 LE
    public let speechSec: Double
    public init(label: String, channel: String, embedding: String, speechSec: Double) {
        self.label = label; self.channel = channel; self.embedding = embedding; self.speechSec = speechSec
    }
}

/// A sample of the user's own voice (calls only, ≥ 30 s of mic speech).
public struct VoiceSamplePayload: Sendable, Equatable {
    public let embedding: String
    public let speechSec: Double
    public init(embedding: String, speechSec: Double) { self.embedding = embedding; self.speechSec = speechSec }
}

public struct IngestPayload: Sendable {
    public let source: String
    public let uri: String, title: String, ts: Int, text: String
    public let meta: [String: String]
    /// Only for source "meeting" with diarization on; nil keeps the wire as before.
    public let speakers: [SpeakerPayload]?
    public let selfSample: VoiceSamplePayload?
    public init(source: String = "screen", uri: String, title: String,
                ts: Int, text: String, meta: [String: String],
                speakers: [SpeakerPayload]? = nil, selfSample: VoiceSamplePayload? = nil) {
        self.source = source; self.uri = uri; self.title = title
        self.ts = ts; self.text = text; self.meta = meta
        self.speakers = speakers; self.selfSample = selfSample
    }
}

/// The `ingest` params. Keys for speakers/selfSample appear only when set, so
/// with diarization off the wire is byte-identical to 0.5.19.
public func ingestParams(_ p: IngestPayload) -> [String: Any] {
    var d: [String: Any] = ["source": p.source, "uri": p.uri, "title": p.title,
                            "ts": p.ts, "text": p.text, "meta": p.meta]
    if let s = p.speakers {
        d["speakers"] = s.map { ["label": $0.label, "channel": $0.channel,
                                 "embedding": $0.embedding, "speechSec": $0.speechSec] as [String: Any] }
    }
    if let v = p.selfSample { d["selfSample"] = ["embedding": v.embedding, "speechSec": v.speechSec] }
    return d
}
```

`DaemonClient.swift`:

```swift
    public func ingest(_ p: IngestPayload) async throws {
        _ = try await call(method: "ingest", params: ingestParams(p))
    }
```

- [ ] **Step 4: Run tests**

Run: `cd packages/capture-agent && swift test 2>&1 | grep -E 'Test run with|✘' | head -5`
Expected: all pass, including the existing `MeetingPayloadTests`.

- [ ] **Step 5: Commit**

```bash
git add packages/capture-agent/Sources/CaptureCore/Pipeline.swift packages/capture-agent/Sources/CaptureCore/DaemonClient.swift packages/capture-agent/Tests/CaptureCoreTests/MeetingPayloadTests.swift
```
```bash
git commit -m "feat(meeting): optional speakers + selfSample on the ingest wire, absent when unset"
```

---

### Task 7: Diarize in `runTranscription`

**Files:**
- Create: `packages/capture-agent/Sources/CaptureCore/DiarizationPlan.swift`
- Modify: `packages/capture-agent/Sources/shyn-meeting/Agent.swift` (`runTranscription`, 447-544)
- Test: `packages/capture-agent/Tests/CaptureCoreTests/DiarizationPlanTests.swift`

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces:
  - `public enum DiarizationPlan: Equatable, Sendable { case skip(String); case diarize(Speaker) }`
  - `public func diarizationPlan(enabled: Bool, modelsReady: Bool, segments: [TranscriptSegment]) -> DiarizationPlan`
  - `public let selfSampleMinSeconds: Double = 30`

- [ ] **Step 1: Write the failing tests**

`Tests/CaptureCoreTests/DiarizationPlanTests.swift`:

```swift
import Testing
@testable import CaptureCore

private let call = [TranscriptSegment(start: 0, end: 1, speaker: .me, text: "hi"),
                    TranscriptSegment(start: 1, end: 2, speaker: .others, text: "hello")]
private let room = [TranscriptSegment(start: 0, end: 1, speaker: .me, text: "hi")]

@Test func offMeansSkipWithoutAReasonWorthLogging() {
    #expect(diarizationPlan(enabled: false, modelsReady: true, segments: call) == .skip("off"))
}

@Test func onButModelNotReadyFallsBackToTodaysLabels() {
    // Review focus 1: the user flips the toggle and has a meeting before the download ends.
    #expect(diarizationPlan(enabled: true, modelsReady: false, segments: call) == .skip("model not ready"))
}

@Test func aCallDiarizesTheFarSide() {
    #expect(diarizationPlan(enabled: true, modelsReady: true, segments: call) == .diarize(.others))
}

@Test func inPersonDiarizesTheMic() {
    #expect(diarizationPlan(enabled: true, modelsReady: true, segments: room) == .diarize(.me))
}

@Test func nothingSaidNothingToDiarize() {
    #expect(diarizationPlan(enabled: true, modelsReady: true, segments: []) == .skip("no speech"))
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/capture-agent && swift build --build-tests 2>&1 | grep error: | head -2`
Expected: `cannot find 'diarizationPlan' in scope`.

- [ ] **Step 3: Implement the plan function**

`Sources/CaptureCore/DiarizationPlan.swift`:

```swift
import Foundation

/// Whether, and which channel, to diarize after Whisper. Calls diarize the far
/// side only (the mic stays Me, since a hybrid room on one mic is a stated v1
/// limit); a session with no far-side speech diarizes the mic.
public enum DiarizationPlan: Equatable, Sendable {
    case skip(String)
    case diarize(Speaker)
}

/// A call contributes a self-sample only with this much voiced mic speech.
public let selfSampleMinSeconds: Double = 30

public func diarizationPlan(enabled: Bool, modelsReady: Bool,
                            segments: [TranscriptSegment]) -> DiarizationPlan {
    guard enabled else { return .skip("off") }
    guard !segments.isEmpty else { return .skip("no speech") }
    guard modelsReady else { return .skip("model not ready") }
    return segments.contains(where: { $0.speaker == .others }) ? .diarize(.others) : .diarize(.me)
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/capture-agent && swift test 2>&1 | grep -E 'Test run with|✘' | head -5`
Expected: all pass.

- [ ] **Step 5: Integrate into `runTranscription`**

In `Agent.swift`, add this private helper inside `MeetingAgent`:

```swift
    /// Diarization never costs a transcript: every failure returns the input
    /// segments untouched and nil speakers, and the caller assembles as before.
    private func diarize(_ segs: [TranscriptSegment], urls: (mic: URL, system: URL), cfg: MeetingConfig)
        async -> (segs: [TranscriptSegment], speakers: [SpeakerPayload]?, selfSample: VoiceSamplePayload?) {
        let plan = diarizationPlan(enabled: cfg.diarization,
                                   modelsReady: diarizerModelsReady(dir: diarizerModelDir), segments: segs)
        guard case .diarize(let channel) = plan else {
            if case .skip(let why) = plan, why != "off" { logErr("[diarizer] skipped: \(why)") }
            return (segs, nil, nil)
        }
        let channelURL = channel == .others ? urls.system : urls.mic
        let wire = channel == .others ? "system" : "mic"
        do {
            return try await withSystemAwake(reason: "shyn: separating speakers") {
                let t0 = ProcessInfo.processInfo.systemUptime
                let samples = try AudioProcessor.loadAudioAsFloatArray(fromPath: channelURL.path)
                let d = try await diarizeChannel(samples: samples, dir: diarizerModelDir)
                let order = arrivalOrder(d.turns)
                let labelled = assignVoices(segs, channel: channel, turns: d.turns)
                let speakers = d.embeddings.compactMap { raw, e -> SpeakerPayload? in
                    guard let n = order[raw] else { return nil }
                    return SpeakerPayload(label: "S\(n)", channel: wire,
                                          embedding: encodeEmbedding(e.embedding), speechSec: e.speechSec)
                }.sorted { $0.label < $1.label }
                var selfSample: VoiceSamplePayload? = nil
                if channel == .others {
                    let mic = try AudioProcessor.loadAudioAsFloatArray(fromPath: urls.mic.path)
                    let chunks = voicedChunks(samples: mic, sampleRate: 16_000)
                    let voiced = voicedSeconds(chunks)
                    if voiced >= selfSampleMinSeconds {
                        let e = try await embedSpeech(samples: mic, ranges: chunks.map { ($0.startSec, $0.endSec) },
                                                      dir: diarizerModelDir)
                        selfSample = VoiceSamplePayload(embedding: encodeEmbedding(e), speechSec: voiced)
                    }
                }
                logErr(String(format: "[diarizer] %@: %d speakers, %d turns, took %.1fs%@",
                              wire, order.count, d.turns.count, ProcessInfo.processInfo.systemUptime - t0,
                              selfSample == nil ? "" : "; self sample"))
                return (labelled, speakers, selfSample)
            }
        } catch {
            logErr("[diarizer] failed, shipping without speakers: \(error)")
            return (segs, nil, nil)
        }
    }
```

In `runTranscription`, change the labelling lines (476-478) from:

```swift
let label = farSideLabel(segs, others: stampEarly?.others ?? [])
var transcript = assembleTranscript(segs, farSide: label)
```

to:

```swift
let diar = await diarize(segs, urls: urls, cfg: cfg)
let label = farSideLabel(diar.segs, others: stampEarly?.others ?? [], diarized: diar.speakers != nil)
var transcript = assembleTranscript(diar.segs, farSide: label)
```

Keep `negligibleSpeechNote(segs, …)` reading the original `segs` (same words either way).

Change the payload build (530-534) to attach speakers. Because `meetingPayload` returns an `IngestPayload` whose fields are `let`, rebuild it:

```swift
let base = meetingPayload(bundleId: bundleId, appName: appName,
                          startEpoch: start, endEpoch: end, transcript: transcript,
                          eventTitle: chosen.title,
                          attendees: meetingAttendees(manual: manualAttendees,
                                                      calendar: stamp?.attendees ?? []))
let payload = IngestPayload(source: base.source, uri: base.uri, title: base.title, ts: base.ts,
                            text: base.text, meta: base.meta,
                            speakers: diar.speakers, selfSample: diar.selfSample)
```

If the speaker label decision used `.named`, do NOT send far-side `speakers` (the name already covers it). The daemon then only stores the self-sample:

```swift
let shippedSpeakers: [SpeakerPayload]? = { if case .named = label { return nil }; return diar.speakers }()
```

Use `shippedSpeakers` in place of `diar.speakers` in the `IngestPayload(...)` above.

`voicedChunks`, `voicedSeconds` are CaptureCore (`AudioSegmenter.swift:23,121`); `AudioProcessor` is WhisperKit, already imported by the agent's transcriber.

- [ ] **Step 6: Build and run all tests**

Run: `cd packages/capture-agent && swift build -c release 2>&1 | grep -E 'error:|Build complete' && swift test 2>&1 | grep -E 'Test run with|✘' | head -5`
Expected: `Build complete!`; all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/capture-agent/Sources/CaptureCore/DiarizationPlan.swift packages/capture-agent/Sources/shyn-meeting/Agent.swift packages/capture-agent/Tests/CaptureCoreTests/DiarizationPlanTests.swift
```
```bash
git commit -m "feat(meeting): diarize after Whisper inside its own awake hold; fall back on any failure"
```

---

### Task 8: Voice tables (schema v6) and the self-profile store

**Files:**
- Modify: `packages/engine/src/storage.ts` (SCHEMA ~24-82, version insert line 63, `KNOWN_SCHEMA_VERSIONS` line 88, `migrate` line 114)
- Create: `packages/engine/src/voice.ts`
- Test: `packages/engine/test/voice.test.ts`, `packages/engine/test/storage.test.ts`

**Interfaces:**
- Produces (`voice.ts`):
  - `export const SELF_SAMPLE_CAP = 20`
  - `export function decodeEmbedding(b64: string): Float32Array`
  - `export function addSelfSample(db, embedding: Float32Array, speechSec: number, ts: number): void`
  - `export function selfSamples(db): Float32Array[]`
  - `export function forgetSelf(db): { removed: number }`

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/voice.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage.js";
import { addSelfSample, selfSamples, forgetSelf, decodeEmbedding, SELF_SAMPLE_CAP } from "../src/voice.js";

const db = () => openDatabase({ dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"), key: null });
const vec = (...xs: number[]) => Float32Array.from(xs);

describe("self voice profile", () => {
  it("decodes base64 little-endian float32 (wire format from the agent)", () => {
    expect(Array.from(decodeEmbedding(Buffer.from([0, 0, 0x80, 0x3f]).toString("base64")))).toEqual([1]);
  });

  it("keeps the 20 most recent samples, dropping the oldest", () => {
    const d = db();
    for (let i = 0; i < SELF_SAMPLE_CAP + 3; i++) addSelfSample(d, vec(i, 0), 40, 1000 + i);
    const s = selfSamples(d);
    expect(s).toHaveLength(SELF_SAMPLE_CAP);
    expect(s.map((v) => v[0])).not.toContain(0);
    expect(s.map((v) => v[0])).toContain(SELF_SAMPLE_CAP + 2);
  });

  it("forget-self removes the profile and every sample", () => {
    const d = db();
    addSelfSample(d, vec(1, 0), 40, 1);
    expect(forgetSelf(d).removed).toBe(1);
    expect(selfSamples(d)).toEqual([]);
    expect(d.prepare("SELECT COUNT(*) n FROM voice_profiles").get()).toEqual({ n: 0 });
  });
});
```

Add to `storage.test.ts`:

```ts
it("v6 has the voice tables on a fresh database", () => {
  const d = openDatabase({ dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"), key: null });
  expect((d.prepare("SELECT value FROM meta WHERE k='schema_version'").get() as any).value).toBe("6");
  d.prepare("SELECT id, name, is_self, created_ts, updated_ts FROM voice_profiles").all();
  d.prepare("SELECT id, profile_id, embedding, speech_sec, ts FROM voice_samples").all();
});

it("a v5 database upgrades to v6 with voice tables", () => {
  const path = join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db");
  const d = openDatabase({ dbPath: path, key: null });
  d.exec("DROP TABLE voice_samples; DROP TABLE voice_profiles;");
  d.prepare("UPDATE meta SET value='5' WHERE k='schema_version'").run();
  d.close();
  const again = openDatabase({ dbPath: path, key: null });
  expect((again.prepare("SELECT value FROM meta WHERE k='schema_version'").get() as any).value).toBe("6");
  again.prepare("SELECT COUNT(*) FROM voice_samples").get();
});
```

(Use the imports `storage.test.ts` already has; add `mkdtempSync`/`tmpdir`/`join` if absent.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @shyn/engine test -- voice storage 2>&1 | tail -8`
Expected: FAIL. `Cannot find module '../src/voice.js'`, and schema_version `5` ≠ `6`.

- [ ] **Step 3: Implement the schema**

In `storage.ts` `SCHEMA`, after the `coverage` table:

```sql
-- v6: speaker diarization (spec 2026-10-05). v1 only ever holds the user's own
-- profile (is_self = 1); the shape is v2's so v2 needs no migration.
CREATE TABLE IF NOT EXISTS voice_profiles (
  id INTEGER PRIMARY KEY,
  name TEXT,
  is_self INTEGER NOT NULL DEFAULT 0,
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS voice_samples (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES voice_profiles(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  speech_sec REAL NOT NULL,
  ts INTEGER NOT NULL
);
```

Change line 63's `'5'` to `'6'`. Change line 88 to `export const KNOWN_SCHEMA_VERSIONS = ["1", "2", "3", "4", "5", "6"];`. In `migrate`, after the `version === "4"` block:

```ts
    if (version === "5") {
      // v6 adds voice_profiles / voice_samples (created idempotently by SCHEMA
      // above). Nothing to transform: no voice was ever stored before v6.
      db.prepare("UPDATE meta SET value='6' WHERE k='schema_version'").run();
      continue;
    }
```

- [ ] **Step 4: Implement `voice.ts`**

```ts
import type Database from "better-sqlite3-multiple-ciphers";

// The user's own voice, and nothing else (spec 2026-10-05, Privacy). Samples
// arrive from calls with >= 30 s of mic speech; the 20 most recent are kept so
// AirPods, a laptop mic and a bad line all have a recent match.
export const SELF_SAMPLE_CAP = 20;

export function decodeEmbedding(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  const out = new Float32Array(Math.floor(buf.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

function selfProfileId(db: Database.Database, now: number): number {
  const row = db.prepare("SELECT id FROM voice_profiles WHERE is_self = 1").get() as { id: number } | undefined;
  if (row) return row.id;
  return Number(db.prepare(
    "INSERT INTO voice_profiles(name, is_self, created_ts, updated_ts) VALUES (NULL, 1, ?, ?)",
  ).run(now, now).lastInsertRowid);
}

export function addSelfSample(db: Database.Database, embedding: Float32Array, speechSec: number, ts: number): void {
  db.transaction(() => {
    const id = selfProfileId(db, ts);
    db.prepare("INSERT INTO voice_samples(profile_id, embedding, speech_sec, ts) VALUES (?, ?, ?, ?)")
      .run(id, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength), speechSec, ts);
    db.prepare(`DELETE FROM voice_samples WHERE profile_id = ? AND id NOT IN (
                  SELECT id FROM voice_samples WHERE profile_id = ? ORDER BY ts DESC, id DESC LIMIT ?)`)
      .run(id, id, SELF_SAMPLE_CAP);
    db.prepare("UPDATE voice_profiles SET updated_ts = ? WHERE id = ?").run(ts, id);
  })();
}

export function selfSamples(db: Database.Database): Float32Array[] {
  const rows = db.prepare(`SELECT s.embedding FROM voice_samples s JOIN voice_profiles p ON p.id = s.profile_id
                           WHERE p.is_self = 1 ORDER BY s.ts DESC, s.id DESC`).all() as { embedding: Buffer }[];
  return rows.map(({ embedding: b }) => {
    const copy = Buffer.from(b);
    return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
  });
}

export function forgetSelf(db: Database.Database): { removed: number } {
  const r = db.prepare("DELETE FROM voice_profiles WHERE is_self = 1").run();
  return { removed: r.changes };
}
```

`ON DELETE CASCADE` removes samples because `openDatabase` sets `foreign_keys = ON`.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @shyn/engine test 2>&1 | grep -E 'Tests +[0-9]+|FAIL'`
Expected: all pass. Fix any existing test that asserts schema version `"5"` by changing it to `"6"`.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/storage.ts packages/engine/src/voice.ts packages/engine/test/voice.test.ts packages/engine/test/storage.test.ts
```
```bash
git commit -m "feat(engine): schema v6 voice tables; self-profile store with a 20-sample FIFO and forget"
```

---

### Task 9: Daemon resolves `Me` and strips embeddings

**Files:**
- Modify: `packages/engine/src/voice.ts` (add `chooseSelf`, `relabelInPerson`)
- Modify: `packages/engine/src/engine.ts` (add `ingestMeeting`, `forgetSelfVoice`)
- Modify: `packages/daemon/src/server.ts:94` (`ingest` handler)
- Test: `packages/engine/test/voice.test.ts`, `packages/daemon/test/meeting-e2e.test.ts`

**Interfaces:**
- Consumes: Task 8.
- Produces:
  - `export const SELF_THRESHOLD = 0.6; export const SELF_MARGIN = 0.2;` (provisional, Task 12 calibrates)
  - `export function chooseSelf(speakers: { label: string; embedding: Float32Array }[], samples: Float32Array[], threshold?: number, margin?: number): string | null`
  - `export function relabelInPerson(text: string, selfLabel: string | null, labels: string[]): string` (null → text unchanged)
  - `export const NO_SELF_PROFILE_NOTE: string` (prepended by `Engine.ingestMeeting` only when NO self sample exists; an ambiguous match adds no note)
  - `Engine.ingestMeeting(p: IngestDoc & { speakers?: WireSpeaker[]; selfSample?: WireSample }): IngestResult`
  - `Engine.forgetSelfVoice(): { removed: number }`

- [ ] **Step 1: Write the failing engine tests**

Append to `voice.test.ts`:

```ts
import { chooseSelf, relabelInPerson, NO_SELF_PROFILE_NOTE } from "../src/voice.js";

const unit = (...xs: number[]) => { const v = vec(...xs); const n = Math.hypot(...xs); return v.map((x) => x / n); };

describe("choosing Me in an in-person session", () => {
  const me = unit(1, 0, 0), other = unit(0, 1, 0);
  it("picks the speaker closest to any self sample when it clears threshold and margin", () => {
    expect(chooseSelf([{ label: "S1", embedding: other }, { label: "S2", embedding: unit(0.95, 0.05, 0) }], [me])).toBe("S2");
  });
  it("matches the closest sample, not the centroid", () => {
    const airpods = unit(1, 0, 0), laptop = unit(0, 0, 1);   // centroid would match neither well
    expect(chooseSelf([{ label: "S1", embedding: unit(0, 0.02, 1) }], [airpods, laptop])).toBe("S1");
  });
  it("is null when two speakers are too close to call", () => {
    expect(chooseSelf([{ label: "S1", embedding: unit(1, 0.1, 0) }, { label: "S2", embedding: unit(1, 0.12, 0) }], [me])).toBeNull();
  });
  it("is null below threshold and with no samples", () => {
    expect(chooseSelf([{ label: "S1", embedding: other }], [me])).toBeNull();
    expect(chooseSelf([{ label: "S1", embedding: me }], [])).toBeNull();
  });
});

describe("relabelling in-person lines", () => {
  const text = "Speaker 1: hello\nSpeaker 2: hi there\nSpeaker 3: yes\nSpeaker 2: Speaker 1: is quoted";
  it("turns the self speaker into Me and renumbers the rest in order", () => {
    expect(relabelInPerson(text, "S2", ["S1", "S2", "S3"]))
      .toBe("Speaker 1: hello\nMe: hi there\nSpeaker 2: yes\nMe: Speaker 1: is quoted");
  });
  it("leaves every Speaker N alone when Me is not certain", () => {
    expect(relabelInPerson("Speaker 1: hello", null, ["S1"])).toBe("Speaker 1: hello");
  });
  it("is idempotent on a retried payload (same text in, same text out)", () => {
    // Review focus 5.
    const once = relabelInPerson(text, "S2", ["S1", "S2", "S3"]);
    expect(relabelInPerson(text, "S2", ["S1", "S2", "S3"])).toBe(once);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @shyn/engine test -- voice 2>&1 | tail -5`
Expected: FAIL, `chooseSelf is not a function` (or not exported).

- [ ] **Step 3: Implement `chooseSelf` / `relabelInPerson`**

Append to `voice.ts`:

```ts
// Provisional (the spike's in-person task never ran; plan Task 12 calibrates on
// a real recording). Erring strict is safe: every voice just stays Speaker N.
export const SELF_THRESHOLD = 0.6;
export const SELF_MARGIN = 0.2;

export const NO_SELF_PROFILE_NOTE =
  "Speakers are numbered: shyn has no sample of your voice yet. It learns one from your next call.";

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.max(1e-9, Math.sqrt(na) * Math.sqrt(nb));
}

/** The label of the speaker who is the user, or null when not certain. Each
 *  speaker scores its CLOSEST self sample; the best must clear `threshold` and
 *  beat the runner-up by `margin`. */
export function chooseSelf(
  speakers: { label: string; embedding: Float32Array }[], samples: Float32Array[],
  threshold = SELF_THRESHOLD, margin = SELF_MARGIN,
): string | null {
  if (samples.length === 0 || speakers.length === 0) return null;
  const scored = speakers
    .map((s) => ({ label: s.label, score: Math.max(...samples.map((x) => cosine(s.embedding, x))) }))
    .sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (best.score < threshold) return null;
  if (next && best.score - next.score < margin) return null;
  return best.label;
}

/** Rewrites "Speaker N:" line prefixes: the self label becomes "Me:", the rest
 *  are renumbered 1..k in their original order. Only the prefix at the start of
 *  a line is touched; a quoted "Speaker 1:" inside a line is speech. */
export function relabelInPerson(text: string, selfLabel: string | null, labels: string[]): string {
  if (selfLabel === null) return text;
  const others = labels.filter((l) => l !== selfLabel)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const renumber = new Map(others.map((l, i) => [Number(l.slice(1)), i + 1]));
  const self = Number(selfLabel.slice(1));
  return text.split("\n").map((line) => {
    const m = /^Speaker (\d+): /.exec(line);
    if (!m) return line;
    const n = Number(m[1]);
    const rest = line.slice(m[0].length);
    if (n === self) return `Me: ${rest}`;
    const k = renumber.get(n);
    return k === undefined ? line : `Speaker ${k}: ${rest}`;
  }).join("\n");
}
```

- [ ] **Step 4: Implement `Engine.ingestMeeting` / `forgetSelfVoice`**

In `engine.ts`, import from `./voice.js` and add to the class:

```ts
import { addSelfSample, selfSamples, forgetSelf, decodeEmbedding, chooseSelf, relabelInPerson } from "./voice.js";

export type WireSpeaker = { label: string; channel: "system" | "mic"; embedding: string; speechSec: number };
export type WireSample = { embedding: string; speechSec: number };
```

```ts
  /** Meeting ingest with diarization extras. Stores ONLY the user's own sample;
   *  far-side and in-person embeddings are used to label, then dropped here. */
  ingestMeeting(p: IngestDoc & { speakers?: WireSpeaker[]; selfSample?: WireSample }) {
    const { speakers, selfSample, ...doc } = p;
    if (selfSample?.embedding && selfSample.speechSec >= 30) {
      addSelfSample(this.db, decodeEmbedding(selfSample.embedding), selfSample.speechSec, doc.ts);
    }
    const mic = (speakers ?? []).filter((s) => s.channel === "mic");
    if (mic.length > 0) {
      const samples = selfSamples(this.db);
      if (samples.length === 0) {
        // Review focus 4: no profile yet → numbered speakers plus a note saying why.
        doc.text = `[${NO_SELF_PROFILE_NOTE}]\n\n${doc.text}`;
      } else {
        // Ambiguous match → chooseSelf is null → text unchanged, no note (spec).
        const self = chooseSelf(mic.map((s) => ({ label: s.label, embedding: decodeEmbedding(s.embedding) })), samples);
        doc.text = relabelInPerson(doc.text, self, mic.map((s) => s.label));
      }
    }
    return ingestDocument(this.db, doc);
  }

  forgetSelfVoice() { return forgetSelf(this.db); }
```

In `server.ts:94`, route meetings with extras through it; everything else is unchanged:

```ts
    ingest: (p) => {
      const r = p?.source === "meeting" && (p.speakers || p.selfSample)
        ? engine.ingestMeeting(p) : engine.ingest(p);
      scheduleDrain(); return r;
    },
    "voice.forgetSelf": (p) => {
      if (p?.confirm !== true) throw Object.assign(new Error("voice.forgetSelf requires confirm: true"), { code: -32001 });
      return engine.forgetSelfVoice();
    },
```

(Match the exact error-construction idiom the existing `forget` handler uses on the line below 128; copy it rather than this sketch if it differs.)

- [ ] **Step 5: Write the e2e wire test**

Append inside the `describe` in `packages/daemon/test/meeting-e2e.test.ts`:

```ts
  it("diarized in-person meeting: Me resolved from the self sample, embeddings never stored", async () => {
    const f32 = (...xs: number[]) => Buffer.from(Float32Array.from(xs).buffer).toString("base64");
    // A call teaches the user's voice.
    await rpcCall(sock, "ingest", { ...meetingPayload("meeting://us.zoom.xos/2026-10-05-1000", "Zoom call",
      "Me: morning\nSpeaker 1: hi", now - 3600, now - 1800),
      speakers: [{ label: "S1", channel: "system", embedding: f32(0, 1, 0), speechSec: 40 }],
      selfSample: { embedding: f32(1, 0, 0), speechSec: 45 } });
    // An in-person session: S2 is the user.
    const uri = "meeting://call/2026-10-05-1100";
    await rpcCall(sock, "ingest", { ...meetingPayload(uri, "Recording",
      "Speaker 1: shall we\nSpeaker 2: yes let us\nSpeaker 3: agreed", now - 1200, now),
      speakers: [{ label: "S1", channel: "mic", embedding: f32(0, 1, 0), speechSec: 20 },
                 { label: "S2", channel: "mic", embedding: f32(0.98, 0.02, 0), speechSec: 30 },
                 { label: "S3", channel: "mic", embedding: f32(0, 0, 1), speechSec: 10 }] });
    const doc = await rpcCall(sock, "document", { uri });
    expect(doc.text).toContain("Speaker 1: shall we\nMe: yes let us\nSpeaker 2: agreed");
    expect(JSON.stringify(doc)).not.toContain(f32(0, 1, 0));   // no embedding leaks into stored text
  });

  it("in-person before any self sample: numbered speakers plus a note", async () => {
    const f32 = (...xs: number[]) => Buffer.from(Float32Array.from(xs).buffer).toString("base64");
    const uri = "meeting://call/2026-10-05-0900";
    await rpcCall(sock, "ingest", { ...meetingPayload(uri, "Recording", "Speaker 1: hi\nSpeaker 2: hello", now - 600, now),
      speakers: [{ label: "S1", channel: "mic", embedding: f32(1, 0), speechSec: 20 },
                 { label: "S2", channel: "mic", embedding: f32(0, 1), speechSec: 20 }] });
    const doc = await rpcCall(sock, "document", { uri });
    expect(doc.text).toContain("no sample of your voice yet");
    expect(doc.text).toContain("Speaker 1: hi\nSpeaker 2: hello");
  });

  it("an ingest without speakers is untouched (wire byte-identical when diarization is off)", async () => {
    const uri = "meeting://us.zoom.xos/2026-10-05-1200";
    await rpcCall(sock, "ingest", meetingPayload(uri, "Zoom call", "Me: a\nOthers: b", now - 600, now));
    const doc = await rpcCall(sock, "document", { uri });
    expect(doc.text).toContain("Me: a\nOthers: b");
  });
```

(`doc.text` includes the meta header that hygiene prepends; `toContain` tolerates it.)

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @shyn/engine test 2>&1 | grep -E 'Tests +[0-9]+|FAIL' && pnpm --filter @shyn/daemon test 2>&1 | grep -E 'Tests +[0-9]+|FAIL'`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/voice.ts packages/engine/src/engine.ts packages/daemon/src/server.ts packages/engine/test/voice.test.ts packages/daemon/test/meeting-e2e.test.ts
```
```bash
git commit -m "feat(daemon): resolve Me for in-person meetings from the self profile; store only the user's voice"
```

---

### Task 10: `shyn voice forget-self` and the popover toggle

**Files:**
- Modify: `packages/cli/src/main.ts` (beside `cmdForget` ~166-189, dispatch ~346-370, usage ~370)
- Modify: `packages/status-ui/src/controls.ts:43-62`, `src/main.ts:208,320-344`, `src/derive.ts`, `renderer/render.ts:76-90`
- Test: `packages/cli/test/cli.test.ts`, `packages/status-ui/test/controls.test.ts`, `packages/status-ui/test/render.test.ts`

**Interfaces:**
- Consumes: daemon `voice.forgetSelf` (Task 9); `MeetingStats.diarizerReady/diarizerDownloading` (Task 5).
- Produces: `readMeetingDiarization(home): boolean`, `setMeetingDiarization(home, on: boolean): void`; view-model field `diarization: { on: boolean; note: string | null }`; action `meeting-diarization` with arg `"on" | "off"`.

- [ ] **Step 1: Write the failing tests**

`packages/status-ui/test/controls.test.ts`, mirroring the existing whisperModel contract test:

```ts
it("meeting.diarization contract (matches MeetingConfig.load): default off, toggles, keeps other keys", () => {
  const home = mkdtempSync(join(tmpdir(), "shyn-ui-"));
  expect(readMeetingDiarization(home)).toBe(false);
  setMeetingModel(home, "large-v3_turbo");
  setMeetingDiarization(home, true);
  const cfg = JSON.parse(readFileSync(join(home, "capture.json"), "utf8"));
  expect(cfg.meeting).toEqual({ whisperModel: "large-v3_turbo", diarization: true });
  setMeetingDiarization(home, false);
  expect(readMeetingDiarization(home)).toBe(false);
});
```

`packages/status-ui/test/render.test.ts`, mirroring an existing section test:

```ts
it("renders the speaker separation toggle with its download note", () => {
  const html = render({ ...baseViewModel(), diarization: { on: true, note: "Downloading speaker model…" } });
  expect(html).toContain('data-action="meeting-diarization"');
  expect(html).toContain("Speaker separation");
  expect(html).toContain("Downloading speaker model…");
});
```

(Use whatever helper the existing render tests use to build a base view model; if it is named differently, use that name.)

`packages/cli/test/cli.test.ts`:

```ts
it("voice forget-self refuses without an interactive terminal", async () => {
  const out: string[] = [];
  await runCli(["voice", "forget-self"], (s) => out.push(String(s)));
  expect(out.join("\n")).toContain("requires an interactive terminal");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @shyn/status-ui test 2>&1 | tail -4; pnpm --filter @shyn/cli test 2>&1 | tail -4`
Expected: FAIL (missing exports / missing output).

- [ ] **Step 3: Implement controls and view model**

`controls.ts`:

```ts
export function readMeetingDiarization(home: string): boolean {
  const m = readCfg(home).meeting;
  return !!(m && typeof m === "object" && (m as Record<string, unknown>).diarization === true);
}

export function setMeetingDiarization(home: string, on: boolean): void {
  const cfg = readCfg(home);
  const meeting = cfg.meeting && typeof cfg.meeting === "object"
    ? (cfg.meeting as Record<string, unknown>) : {};
  writeCfg(home, { ...cfg, meeting: { ...meeting, diarization: on } });
}
```

`main.ts:208` ctx: add `meetingDiarization: readMeetingDiarization(home),`. In the `ipcMain.on("action")` chain, beside `meeting-model`:

```ts
      else if (name === "meeting-diarization") setMeetingDiarization(home, arg === "on");
```

`derive.ts`: add `diarization: { on: boolean; note: string | null }` to `ViewModel`, and derive it next to `modelChoice`:

```ts
  const diarization = {
    on: ctx.meetingDiarization,
    note: !ctx.meetingDiarization ? null
      : m?.diarizerDownloading ? "Downloading speaker model…"
      : m?.diarizerReady === false ? "Speaker model not downloaded yet"
      : null,
  };
```

(`m` is the same meeting-stats object `modelChoice` reads `whisperDownloading` from; use that variable's actual name.)

`render.ts`, after `modelSection`:

```ts
const d = vm.diarization;
const diarSection = `
<section class="stats"><h2 class="section-lab">Speaker separation</h2>
  <div class="seg">
    <button data-action="meeting-diarization" data-arg="off" class="${d.on ? "" : "selected"}">Off</button>
    <button data-action="meeting-diarization" data-arg="on" class="${d.on ? "selected" : ""}">On</button>
  </div>
  <div class="seg-hint">Labels Speaker 1, 2… · stores a voiceprint of your own voice only</div>
  ${d.note ? `<div class="seg-hint model-note">${esc(d.note)}</div>` : ""}
</section>`;
```

Insert `${diarSection}` immediately after `${modelSection}` where the template composes sections.

- [ ] **Step 4: Implement the CLI command**

Above `runCli`, modelled on `cmdForget`:

```ts
async function cmdVoiceForgetSelf(print: (s: string) => void) {
  if (!process.stdin.isTTY) return print("aborted: voice forget-self requires an interactive terminal to confirm");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  print("This deletes shyn's sample of your own voice. In-person meetings go back to Speaker 1, 2…");
  const answer = await new Promise<string>((res) => rl.question("Type 'yes' to confirm: ", res));
  rl.close();
  if (answer.trim() !== "yes") return print("aborted");
  const r = await rpcCall(sock(), "voice.forgetSelf", { confirm: true });
  print(r.removed ? "your voice sample is deleted" : "no voice sample was stored");
}
```

(Use the same `readline` import `cmdForget` uses.) In the dispatch chain:

```ts
    if (cmd === "voice") {
      if (rest[0] === "forget-self") return await cmdVoiceForgetSelf(print);
      return print("usage: shyn voice forget-self");
    }
```

Add `voice forget-self` to the usage string at ~line 370.

- [ ] **Step 5: Run tests**

Run: `pnpm -r test 2>&1 | grep -E 'Tests +[0-9]+ (passed|failed)|FAIL'`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/main.ts packages/cli/test/cli.test.ts packages/status-ui/src packages/status-ui/renderer/render.ts packages/status-ui/test
```
```bash
git commit -m "feat: speaker separation toggle in the popover and shyn voice forget-self"
```

---

### Task 11: DER release gate, README, RELEASING, known limits

**Files:**
- Create: `scripts/check-diarization.mjs`
- Modify: root `package.json` (scripts), `RELEASING.md`, `README.md` (~196-219 "Meetings" bullet, ~187 Everyday controls), `docs/known-issues.md`

**Interfaces:**
- Consumes: `shyn-meeting diarize <wav> --rttm` (Task 4).

- [ ] **Step 1: Write the gate script**

`scripts/check-diarization.mjs`:

```js
#!/usr/bin/env node
// Release gate (spec 2026-10-05): DER on the AMI ES2004a clip must stay within
// the spike baseline. Spike: 11.7% with 1.0s same-speaker bridging; gate 15%.
// Needs: the AMI clip + reference RTTM (spikes/diarization-probe/scripts/fetch-ami.sh on
// branch spike/diarization), the diarizer models downloaded, and `uv`.
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const AMI = process.env.SHYN_AMI_DIR ?? join(process.env.HOME, "Library/Application Support/shyn-spike/ami");
const wav = join(AMI, "ES2004a.wav"), ref = join(AMI, "ES2004a.ref.rttm");
const bin = "packages/capture-agent/.build/release/shyn-meeting";
const GATE = 0.15;
for (const f of [wav, ref, bin]) if (!existsSync(f)) { console.error(`missing: ${f}`); process.exit(2); }

const hyp = join(mkdtempSync(join(tmpdir(), "shyn-der-")), "hyp.rttm");
writeFileSync(hyp, execFileSync(bin, ["diarize", wav, "--rttm"], { encoding: "utf8" }));
const der = Number(execFileSync("uv", ["run", "--with", "pyannote.metrics", "python3", "-c",
  `import sys
from pyannote.database.util import load_rttm
from pyannote.metrics.diarization import DiarizationErrorRate
r = list(load_rttm(sys.argv[1]).values())[0]; h = list(load_rttm(sys.argv[2]).values())[0]
print(DiarizationErrorRate()(r, h))`, ref, hyp], { encoding: "utf8" }).trim());
console.log(`DER ${(der * 100).toFixed(1)}% — gate ${(GATE * 100).toFixed(0)}%`);
process.exit(der <= GATE ? 0 : 1);
```

If `pyannote.database` is not pulled in by `pyannote.metrics`, add `--with pyannote.database` to the `uv run` arguments; the spike's `scripts/score_der.py` on branch `spike/diarization` is the working reference.

Root `package.json` scripts: `"check:diarization": "node scripts/check-diarization.mjs"`.

- [ ] **Step 2: Run the gate**

Run: `cd packages/capture-agent && swift build -c release && cd ../.. && pnpm check:diarization`
Expected: `DER 1x.x% — gate 15%`, exit 0. If DER exceeds 15%, stop. The production path differs from the spike, and that difference must be found before this ships.

- [ ] **Step 3: RELEASING.md**

Add after the `check:meeting-titles` bullet:

```markdown
- [ ] **`pnpm check:diarization` green** (AMI ES2004a DER ≤ 15%; spike baseline 11.7% with
      1.0s bridging). Needs the AMI clip under `~/Library/Application Support/shyn-spike/ami`
      and the diarizer models (`shyn-meeting diarize <wav> --download` once). Manual gate,
      like the evals.
```

- [ ] **Step 4: README and known limits**

In the README "Meetings" fine-print bullet (~196-219), add:

```markdown
  **Speaker separation** (off until you turn it on, in the menu bar under "Speaker separation").
  On calls, the other side is split into `Speaker 1`, `Speaker 2`…; your microphone stays `Me:`,
  and a 1:1 with a single voice keeps the attendee's name. In person, everyone on your
  microphone is separated, and shyn picks out which one is you. Speaker separation is off
  until you turn it on. shyn stores a voiceprint of your own voice only, to tell you apart
  in in-person meetings. It learns it from your calls; `shyn voice forget-self` deletes it.
  Other people's voices are used to number them and then discarded.
```

Under "Everyday controls" (~187), add `shyn voice forget-self   # delete shyn's sample of your voice`.

`docs/known-issues.md`, a new section:

```markdown
## Speaker separation (v1)

- **Hybrid rooms:** on a call, everyone sharing your microphone is `Me`; the mic is not separated on calls.
- More than 8 distinct voices are merged.
- `Speaker 1` in one meeting is unrelated to `Speaker 1` in another.
- A segment that spans a change of speaker gets one label.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/check-diarization.mjs package.json RELEASING.md README.md docs/known-issues.md
```
```bash
git commit -m "docs+gate: speaker separation copy, known limits, AMI DER release gate"
```

---

### Task 12: Live verification and `Me` calibration

No new code unless a check fails. Every step reads WAVs after a session ends and touches no audio device on the user's Mac.

- [ ] **Step 1: Full gates**

Run from the repo root:

```bash
pnpm typecheck && pnpm -r test && pnpm test:e2e
(cd packages/capture-agent && swift test 2>&1 | grep -E 'Test run with|✘')
pnpm eval:hybrid; pnpm eval:latency; pnpm check:diarization
```
Expected: all green; hybrid ≥ 0.8; p95 < 500 ms; DER ≤ 15%.

- [ ] **Step 2: Fake-daemon RPC trace (RELEASING.md, entry-point rule)**

`runTranscription` changed, so watch the meeting agent's RPCs against a throwaway home:

```bash
H=$(mktemp -d); S="$H/shyn.sock"
python3 -c '
import socket,os,sys,json
s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen()
while True:
  c,_=s.accept(); f=c.makefile("rw")
  for line in f:
    r=json.loads(line); p=r.get("params",{})
    print(r["method"], sorted(p.keys()), flush=True)
    f.write(json.dumps({"jsonrpc":"2.0","id":r["id"],"result":{}})+"\n"); f.flush()
' "$S" &
SHYN_HOME="$H" packages/capture-agent/.build/release/shyn-meeting &
sleep 15; kill %2 %1
```
Expected: a `captureStats` at start and every few seconds; no crash; keys show no `diarizer*` because `capture.json` is absent (diarization off). Then write `{"meeting":{"diarization":true}}` to `$H/capture.json`, rerun, and expect `captureStats` to start carrying the meeting block with `diarizerDownloading`/`diarizerReady`.

- [ ] **Step 3: Install the build and record two sessions (maintainer)**

After the release build is installed (`shyn setup`) and Speaker separation is turned on and the model has finished downloading:
1. One multi-party call (3+ people). Check `meeting.log` for `[diarizer] system: N speakers`, and `shyn search` the meeting: far-side lines read `Speaker 1/2…`, mic lines `Me:`.
2. One in-person session via Start recording, ≥ 10 minutes, mixing English and Kannada. Before it, have at least one call of ≥ 30 s of the maintainer speaking (that is what creates the self sample).

- [ ] **Step 4: Calibrate `SELF_THRESHOLD` / `SELF_MARGIN`**

For the in-person session, log the scores the daemon computed. Temporarily (do not commit) add to `Engine.ingestMeeting` before `relabelInPerson`:

```ts
console.error("[voice] scores", mic.map((s) => ({ label: s.label,
  score: Math.max(...selfSamples(this.db).map((x) => cosineForDebug(decodeEmbedding(s.embedding), x))) })));
```

(Export `cosine` from `voice.ts` as `cosineForDebug` for this step only.) Re-ingest by retrying the session (or re-running the diagnostic). Read the daemon log for the maintainer's own score versus the best other speaker's score. Set:
- `SELF_THRESHOLD` = the maintainer's score minus 0.10, rounded down to 0.05.
- `SELF_MARGIN` = half the gap between the maintainer and the best other speaker, rounded down to 0.05, minimum 0.10.

Update the constants and the "provisional" comment with the measured numbers and date, remove the debug log, and run `pnpm --filter @shyn/engine test`. Adjust the `chooseSelf` unit fixtures only if a changed constant makes one of them invalid.

- [ ] **Step 5: Commit the calibration**

```bash
git add packages/engine/src/voice.ts packages/engine/test/voice.test.ts
```
```bash
git commit -m "feat(engine): calibrate the in-person Me threshold and margin on a real recording"
```

- [ ] **Step 6: Record findings**

Append to `work/shyn/sessions/2026/2026-10-05-speaker-diarization-nemotron.md` in the knowledge base: DER, speaker counts on both live sessions, diarizer time as a fraction of Whisper time from `meeting.log`, and the calibrated threshold/margin.
