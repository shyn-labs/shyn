# Speaker Diarization v1 (Nemotron 3) — Design

**Date:** 2026-10-05 · **Status:** draft, awaiting review ·
**Gate:** the spike in §Spike passes before any v1 code lands.

## Goal

Split the far side of a meeting into distinct speakers, and split in-person recordings
(single mic) into `Me` and others. Today a call is two labels (`Me` / `Others`), and an
in-person session is one unattributed block.

v1 output:

```
Me: …
Speaker 1: …
Speaker 2: …
```

**Non-goals for v1** (planned for v2, under a separate spec, only if v1's labels hold up on real
calls):
- named speakers across meetings
- voice profiles of other people
- relabelling past meetings
- any naming UI or MCP tool

## Why now, and why this model

Diarization was parked in September because it was not yet a priority. Pyannote, which
WhisperKit vendors through SpeakerKit, was never actually evaluated. The 2026-09-01 Meet
attribution spec recorded that diarization "is the only path that would cover
Zoom/Teams/in-person". This spec reopens that path.

**NVIDIA Nemotron 3 Diarization** was released 2026-09-23.
- It is end-to-end: one pass, with no segmentation → embedding → clustering pipeline to tune.
  The clustering step is where most diarization reliability problems live.
- 100M parameters, up to 8 speakers, 10 ms frames, 16 kHz mono input.
- Weights are under **OpenMDW 1.1**, which allows commercial use and redistribution. The
  earlier preview build was evaluation-only and is not used.
- Training data includes English plus several Indic languages, including Hindi, Kannada and
  Telugu.
- Labels follow first-arrival order, so they are not stable across sessions. That is
  acceptable for v1.

**Runtime: FluidAudio** (Swift).
- `Nemotron3Diarizer`, offline preset (30.4 s buffer), merged upstream 2026-09-23.
- Upstream reports 9.47% DER at ~900× real time on M-series.
- FluidAudio is used **only** for diarization and speaker embeddings.

**WhisperKit stays for ASR.** FluidAudio's ASR (Parakeet v3) covers 25 European languages
and none of the Indic ones that shyn's auto-detect currently handles.

**Fallback** if FluidAudio cannot coexist with the exact `WhisperKit 0.18.0` pin: load the
Nemotron Core ML model directly and write a thin wrapper, plus our own embedding step. The
design below does not change in that case.

## Architecture

The diarization step goes in `runTranscription` (`shyn-meeting/Agent.swift`):
- **after** `transcribeMeeting` returns
- **before** `farSideLabel` / `assembleTranscript`

At that point both WAVs are still on disk; the first purge on the success path happens only
after `ship()`.

Constraints:
- It runs **inside `withSystemAwake`**, like transcription, because a sleeping Mac once
  stretched a 25-minute job to 4h40m.
- It runs **after Whisper has finished**, in the same serialized `transcribeTask` chain. The
  diarizer is loaded, run, and released. It is never resident alongside Whisper.

Division of labour:

| Component | Responsibility |
|---|---|
| `shyn-meeting` (Swift) | Diarize, assign speakers to Whisper segments, extract embeddings, emit neutral labels. Stateless: holds no profiles. |
| daemon (TS) | Owns identity. Stores the user's own voice samples. Decides which in-person speaker is `Me`. Renders final labels into the stored text. |

The daemon owns identity because v2's relabelling can only happen where both the profiles
and the meetings live. v1 sets up that split without building v2.

## Behaviour

### Calls (system channel has speech)

- Diarize the **system** channel only, and label its speakers `Speaker 1…N` in arrival order.
- The **mic** channel stays `Me`, unchanged. It is not diarized on calls.
- **1:1 naming is preserved.** Today, a call with exactly one other calendar attendee labels
  the far side with that attendee's name (`farSideLabel` → `.named`). In v1:
  - **One** far-side voice and one other attendee: keep the name, same as today.
  - **Two or more** far-side voices on a "1:1": `Speaker 1/2…`, with attendees still in the
    meta header. A name is never attached to an ambiguous voice.

### In-person (system channel silent)

- Diarize the **mic** channel.
- The daemon compares each mic speaker's embedding against the user's self-profile. The
  match becomes `Me`; the rest become `Speaker N`.
- `Me` is assigned only when the best match clears a threshold **and** beats the runner-up by
  a margin. Both values are set from spike data. If either test fails, every speaker is
  `Speaker N`.
- If no self-profile exists yet, every speaker is `Speaker N` and the transcript carries a
  one-line note explaining why. This uses the existing note mechanism, like `speakerNote`.

### Self-profile

- On calls, if the mic channel has **≥ 30 s** of voiced speech, the agent sends one embedding
  of it.
- The daemon keeps the **20 most recent** samples (FIFO).
- Matching uses the closest sample, not a centroid, so the same person on AirPods, a laptop
  mic and a bad line still match.
- **Other people's embeddings are discarded after labelling. v1 stores no voiceprint except
  the user's own.**

### Segment → speaker assignment

- Each Whisper segment (start/end on the original timeline, chunk offsets already applied)
  takes the diarized speaker with the **most active frames** inside its span.
- During overlapping speech, the segment goes to whoever was active longer.
- A segment that spans a speaker change gets one label. Splitting segments is deferred until
  the spike shows it matters.

### Enablement

- New setting `capture.json` → `meeting.diarization: false` by default, hot-reloaded like
  `whisperModel`.
- A popover toggle sets it. Enabling it triggers a model download through the existing
  predownload gate pattern (`ModelPredownloadGate`).
- When the setting is off, the `speakers` field is **absent** and the wire is byte-identical
  to today.

## Data model

### Wire (agent → daemon)

The existing `ingest` RPC gains an optional `speakers` param. It is sent only for
`source:"meeting"` with diarization on. Transcript and embeddings travel in one call, so they
are buffered and retried together by the `RingBuffer`.

```
speakers: [{
  label: "S1",                    // matches "Speaker 1:" lines in text
  channel: "system" | "mic",
  embedding: <base64 float32>,
  speechSec: number
}]
selfSample?: { embedding: <base64 float32>, speechSec: number }   // calls only, ≥ 30 s
```

- Text carries **neutral** labels (`Me:` / `Speaker N:` / 1:1 name).
- For in-person sessions the daemon rewrites the matched `Speaker N:` to `Me:` before
  chunking.
- `meeting-e2e.test.ts` is updated field-for-field.

### Storage (schema v5 → v6)

```
voice_profiles(id INTEGER PK, name TEXT, is_self INTEGER, created_ts, updated_ts)
voice_samples(id INTEGER PK, profile_id → voice_profiles ON DELETE CASCADE,
              embedding BLOB, speech_sec REAL, ts)
```

- In v1, only the `is_self = 1` row exists. The tables are shaped for v2 so v2 needs no
  schema change.
- Migration follows the existing pattern:
  - add the tables to `SCHEMA` with `IF NOT EXISTS`
  - add a `"5"` step to `migrate()`
  - add `"6"` to `KNOWN_SCHEMA_VERSIONS`
- Everything lives in the encrypted `shyn.db` (multiple-ciphers, Keychain key).

Footprint: an embedding is ~1 KB, so the self-profile is ≤ ~20 KB. v1 adds nothing per meeting.

## Error handling

The rule: diarization never costs a transcript.

| Case | Behaviour |
|---|---|
| Model missing, load failure, crash, timeout | Fall back to today's `Me`/`Others` assembly. Log to `meeting.log`. Ship normally, without a `speakers` field. |
| Transcription retry (`retryPendingTranscription`) | Re-runs diarization from the WAVs; no special handling. |
| Mic speech < 30 s on a call | No `selfSample`. |
| In-person `Me` ambiguous | All `Speaker N`. |
| Daemon down | Payload, including `speakers`, waits in the existing buffer. |
| User removes their voice | `shyn voice forget-self` (CLI) deletes the self-profile. Turning diarization off in the popover offers the same. |

## Privacy

- In v1 the only biometric stored is the **user's own** voice, locally, encrypted, and
  deletable with one command.
- Third-party embeddings exist in memory during labelling, then are discarded.
- README copy:
  - "speaker separation is off until you turn it on"
  - "shyn stores a voiceprint of your own voice only, to tell you apart in in-person
    meetings"

## Known limits (stated in the README)

- **Hybrid rooms:** on a call, everyone sharing the user's mic is `Me`, because the mic is not
  diarized on calls.
- More than 8 distinct voices get merged.
- `Speaker 1` in one meeting is unrelated to `Speaker 1` in another. Fixing that is v2's job.

## Spike (gate for everything above)

Throwaway code under `spikes/diarization-probe/` (gitignored build products), modelled on
`spikes/meeting-probe/`.

1. **Dependency resolution.** Does a package depending on both `WhisperKit exact 0.18.0` and
   FluidAudio resolve and build? If not, prove the direct Core ML fallback loads the model.
2. **Baseline.** Diarization error rate on an AMI meeting-corpus clip with reference labels.
   This number becomes the release-gate threshold.
3. **Real call.** Requires temporarily keeping a session's WAVs, via a spike-only flag or a
   manual recording.
   - **Pass criteria:** on a real ~45-minute multi-party call, total transcript wall time
     increases **< 10%** and peak RSS does **not** increase over Whisper alone.
   - **Amended 2026-10-05 (maintainer decision, after the first real-call run):**
     - **Time** is measured *within* each run as diarization-stage seconds ÷ Whisper-stage
       seconds, median over runs, which must be **< 10%**. Comparing wall time across separate
       runs could not resolve a 1–2% cost, because Whisper alone varied ±20% run to run (331–494 s
       on the same 18-minute call).
     - **Memory:** a ~67 MB in-process footprint increase from the diarizer is accepted.
       Whisper's Core ML weights are wired on the Neural Engine and invisible to in-process
       metrics.
4. **In-person** mixed-language recording: speaker splits, plus `Me` selection with a
   hand-built self-profile.
5. **Embedding model choice:** FluidAudio's bundled speaker embedding vs. NVIDIA TitaNet,
   judged on same-speaker vs. different-speaker cosine separation on the recordings above.
   Also produces the `Me` threshold and margin.

If criterion 3 fails, stop. Findings are recorded before v1 implementation begins.

## Testing

- **CaptureCore (no model):**
  - segment → speaker overlap assignment
  - 1:1 preserve / fallback rules
  - neutral label rendering
  - the in-person `Me` threshold + margin decision, using synthetic embeddings
- **Engine:**
  - v5 → v6 migration (fresh database and upgrade)
  - FIFO cap of 20 samples
  - `Me` rewrite before chunking
  - `forget-self`
  - `meeting-e2e` wire test
- **Fake-daemon RPC trace against the installed binary** (per RELEASING.md, after the 0.5.9
  lesson).
- **New release gate:** diarization error rate on the AMI clip ≤ the spike baseline plus a
  margin. `pnpm check:meeting-titles` still passes.
- **Live, before tagging:** one multi-party call and one in-person session. The step only
  reads WAVs after the session ends and touches no audio device.

## Open risks

- FluidAudio and the `WhisperKit 0.18.0` exact pin may not resolve together. The fallback is
  above.
- Speaker-count accuracy is 87.5% upstream on the offline preset. Quiet participants may merge
  into another speaker. The spike measures how often.
- Far-side audio is codec-compressed and often a single mixed stream, which differs from the
  model's benchmark conditions.
- Mic bleed of far-side audio is not an issue on calls, because the mic is not diarized there.
  It does matter for in-person sessions that have a speaker playing audio.
