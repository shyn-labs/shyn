# Known issues

Tracked at the plan-a-core final review (2026-07-02). These are accepted
gaps, not silent bugs discovered later — each was seen, judged non-blocking
for Plan A, and recorded here instead of fixed on the spot.

## Logged (Plan A, not yet fixed)

- Empty-text document row is untested: `ingestDocument` with `text: ""`
  produces zero chunks and is never exercised by a test.
- Embedder's idle-timer disposal is a stale-closure no-op if `acquire()` is
  called again before the timer fires and the backend is replaced — the old
  timer still fires and calls `dispose()` on whatever `this.backend` is by
  then.
- Embed-worker retries are head-of-line: a single row stuck below its
  attempts ceiling blocks the rest of the batch behind it, since the loop
  returns (backs off) on the first non-`ModelNotReadyError` failure rather
  than continuing past it. **User decision pending**: plan-mandated
  return-on-first-error vs. skip-the-row-and-continue.
- `forget`/`search` selectors with `timeFrom > timeTo` silently return zero
  rows instead of rejecting the nonsensical range.
- `forget`'s SQL column-qualifier rewrite (`where.replace(/\b(id|source|ts)\b/g, "d.$1")`)
  is a regex over a hand-built WHERE clause — brittle if a future selector
  reuses one of those bare words in an unexpected position.
- `Engine.drain()` after `Engine.close()` is unguarded: nothing stops a
  caller from scheduling a drain against a closed database handle.
- Raw error text (socket errors, SQLite errors) reaches local CLI/MCP
  clients for everything except the daemon-down case fixed in this batch —
  still true for e.g. a corrupt-DB error surfacing verbatim.
- CLI `forget` has no scripting escape hatch (e.g. `--yes`) for non-TTY
  callers; it always requires an interactive confirmation.
- `NaN` selector values (e.g. a malformed `--doc` flag) are accepted
  silently and passed through to SQL rather than rejected with a clear error.
- Direct single-file ingest via the CLI bypasses the `.md`/`.txt` extension
  filter that directory-walk ingestion applies — only a directory walk
  filters by extension.
- `forget`'s synchronous `VACUUM` blocks the daemon's event loop for the
  duration of the vacuum (fine at Plan A's scale; needs an async/background
  approach at Plan B scale).
- `status.modelDownloadPct` reports `0` (not `100`) under
  `SHYN_SKIP_MODEL_DOWNLOAD=1`, even though the model step is being
  skipped entirely — cosmetic, but confusing in that mode.

## Plan B (deferred by design)

- `embedding_version` tagging and daemon/CLI socket protocol versioning are
  both deferred to Plan B — Plan A has exactly one client and one daemon
  version in play at a time.

## Logged (Plan B, not yet fixed)

- Dedup's ts-refresh (`ingestDocument` bumping an existing document's `ts`
  on re-ingest) does not move that document's vectors to a new month
  partition — they stay filed under the month they were originally
  embedded in. A time-ranged search that prunes by month can therefore miss
  a re-ingested chunk whose *content* ts now falls outside the partition it
  physically lives in. Marginal skew, not a correctness break for
  unranged search.
- The Notes reader depends on the undocumented `NoteStore.sqlite` schema
  (`ZICCLOUDSYNCINGOBJECT` / `ZICNOTEDATA` table and column names, reverse
  engineered, not an Apple-published contract). It degrades to `unavailable
  ("unsupported Notes schema")` on any mismatch rather than crashing, but a
  macOS release that changes the schema silently stops ingesting Notes
  until this file is revisited.
- The protobuf text extractor (`extractLongestString`,
  `packages/engine/src/readers/protobuf-text.ts`) that pulls note bodies
  out of the gzipped Notes blob has known edge cases from a schema-less
  wire-format walk: a container whose child parse comes back structurally
  valid but empty falls back to treating its own raw bytes as leaf text,
  which can occasionally outrank the real text found elsewhere in the
  message; a length-delimited field can rarely truncate mid-string if a
  leading content byte happens to decode as a plausible length varint; and
  depth-capped recursion (depth ≥ 6) can leave a short framing-noise prefix
  glued onto otherwise-real text. None of these have produced visibly wrong
  search results in testing, but none are proven absent either.
- Safari/Notes readers call `copyAndOpen` **three** times per sync pass, not
  twice: `syncReaders` calls `available()` once itself, then `read()` calls
  `await this.available()` again internally before doing its own
  `copyAndOpen` for the actual read — each of those three calls copies the
  store off disk. Chrome's `read()` doesn't re-call `available()`, so it
  doesn't hit the same ×3, but its cost scales with profile count: a sync
  pass copies each of the N found profiles once via `available()`'s
  per-profile probe and once more via `read()`'s own copy, so N+1 profile
  copies happen per sync pass at minimum. Wasted I/O, not a correctness
  issue, but worth collapsing if sync frequency ever increases.
- `status.readers` resets to `[]` on every daemon restart and stays that way
  until the first sync pass completes (whether the periodic timer, the
  startup initial-sync, or a manual `shyn sync`) — `memory_status` briefly
  under-reports reader health right after a restart even if the previous
  session's readers were all healthy.
- A schema-version refusal (the daemon detecting an incompatible on-disk DB
  schema and declining to start) combined with `KeepAlive` produces a crash
  loop: launchd keeps relaunching a daemon that keeps refusing to start.
  The failure is log-only — nothing surfaces the loop to the user beyond
  `~/Library/Logs/shyn/daemon.log`.
- A transient reader failure on one sync pass overwrites `status.readers`
  with that failure entry, erasing the ingested/deduped counts from the
  last successful pass — `memory_status` briefly looks worse than reality
  until the next successful sync overwrites it again. `syncReaders` /
  `runSync` replace `lastSync` wholesale rather than merging.
- The Notes reader's FDA-hint branch (`accessSync` throwing after
  `existsSync` passes — the real-TCC-denied case) has no e2e test; it's
  exercised only by unit tests that mock the throw, not by an actual
  FDA-denied filesystem state.

## Logged (Plan C, not yet fixed)

- **Replace path with older ts drops tags** — when a document is re-ingested
  with the same `(source, uri)` but an *older* ts and changed content, the
  replace is skipped (stale-ts guard) and any new `meta.tags` are dropped with
  it. Unreachable today: only the `conversation` source carries tags and its
  uris are content-derived, so changed content always means a new uri (fresh
  insert). Becomes real only if a future source combines stable uris with tags.
- **Stale bundle preferred over source** — `shyn install` prefers
  `dist/daemon/daemon.mjs` over the tsx dev path with no freshness check; a
  stale bundle silently wins over edited source. Workaround: rebuild with
  `pnpm build:dist` or delete `dist/` to force tsx evaluation of source.
- **Mitigated, not fixed** — the launchd plist installed by `shyn install`
  used to pin the daemon's `process.execPath` (the Node binary path at
  install time) rather than resolving `node` at launch, so `brew upgrade
  node` moving or removing that exact binary produced a silent `KeepAlive`
  relaunch-fail loop. This fired live on 2026-07-02: a brew-triggered node
  upgrade (25.4.0 → 26.4.0, the same upgrade documented in the dist-bundle
  ABI item below) rewrote `/opt/homebrew/Cellar/node/25.4.0/...` out from
  under a plist that had pinned it. Task 10 mitigates by having
  `daemonProgramArguments` prefer the stable `/opt/homebrew/bin/node`
  symlink over `process.execPath` when it exists, falling back to
  `process.execPath` otherwise (`packages/cli/src/launchd.ts`) — the
  symlink survives a `brew upgrade node` (it's rewritten to point at the
  new Cellar version, not removed), so a plist built against it keeps
  resolving after an upgrade. This is not a full fix: it only helps
  Homebrew-managed Node on the default prefix, and does nothing for a
  non-Homebrew Node install or a machine where `/opt/homebrew/bin/node`
  doesn't exist (falls straight back to the old pinned-path behavior).
  Fully fixed only when Plan D's packaged daemon carries its own runtime
  and stops depending on any system `node` at all.
- Dist-bundle/Homebrew formula ABI coupling to build-time node: the
  `dist/daemon` bundle's native addons (`better-sqlite3-multiple-ciphers`,
  `node-llama-cpp`, `@reflink/reflink`) are prebuilt against whatever Node
  ABI was active at build time, but `Formula/shyn.rb`'s `depends_on "node"`
  tracks brew's rolling `node` formula — the same node 25→26 incident above
  also broke the formula's tarball until it was rebuilt and repinned
  (commit `e5e50f5`). The formula and the bundle it installs only agree on
  ABI because both happened to be rebuilt on the same machine on the same
  day; there is no mechanism enforcing that going forward. This is a Plan D
  driver: either rebuild the natives against a pinned LTS `node@NN` and
  `depends_on` that exact formula, or vendor a specific Node runtime inside
  the tarball instead of depending on brew's `node` at all.

## Fixed (Plan B)

- FTS5's Devanagari-aware tokenizer: index-side tokenization was
  Latin-oriented and dropped combining marks. Fixed via a v1→v2 schema
  migration with index rebuild (commit `b0a9834`, Task 9).

## Fixed (Plan C)

- Browser title-churn corpus bloat: ingest now upserts on `(source, uri)`
  with in-place replacement (update row, purge old chunks/vectors, re-chunk
  + re-queue) instead of treating each title variant as a new document. A
  v2→v3 migration dedupes any pre-existing `(source, uri)` duplicates
  (keeping newest by `ts`) before adding the `UNIQUE(source, uri)` index.
  Commit `12db324`; live-verified deduping 35 real duplicate documents on
  migration.
- `SyncResult.reason` wasn't plumbed through for the `ok: true` case —
  an availability warning (e.g. Chrome's "skipped N unreadable profile(s)")
  reached `status.readers` only when a reader failed outright, not when it
  partially succeeded. `Engine.syncReaders` now carries `reason` through on
  success too. Commit `33dead8`.
- `copyAndOpen`'s temp-dir cleanup (`rmSync` on copy failure) could itself
  throw and mask the original copy error. Extracted into a `bestEffortRm`
  helper that swallows cleanup failures so the original error always
  surfaces to the caller. Commits `33dead8`, `5181d21`.
- `remember`'s re-ingest of identical content with new tags used to
  overwrite `meta_json` rather than merge — a repeated `remember` call with
  a different tag silently dropped the earlier tag. `ingestDocument` now
  merges tag sets (union, deduped) into the existing document's meta on a
  content-hash match. Commit `33dead8`.
- `ensureModel` didn't re-hash a cached model file that already existed on
  disk (`existsSync(dest)` short-circuited past verification) — a locally
  corrupted or tampered cache was never re-verified. It now hashes the
  cached file before returning and re-downloads on a mismatch. Commit
  `44d29df`.
- The MCP `forget` handler's refusal detection was a substring match on the
  daemon's error text (`/confirm/i.test(e.message)`), fragile to wording
  changes. Daemon RPC errors now carry a `code`
  (`packages/daemon/src/rpc.ts`), and a `classifyRpcError` helper
  discriminates by code instead of message text. Commits `33dead8`,
  `5181d21`.

## Fixed in this batch (applied, not just logged)

- **launchd daemon hung at startup with zero log output** (`sample` showed
  the main thread wedged in `node::fs::Open` before ever reaching the
  `console.log("shynd listening...")` line), while running the identical
  `dist/daemon/daemon.mjs` from an interactive terminal worked instantly.
  Root cause: macOS TCC gates a process's *first* synchronous read of a
  file under `~/Documents` behind a consent decision, and a headless
  launchd agent has no session to show that consent prompt in — the
  decision never resolves, so the read (and the whole process, since
  Node's own ESM loader does an open+read to load the entry script) blocks
  in the kernel forever. Confirmed by reproducing the identical hang with
  a throwaway `fs.readFileSync` under `~/Documents`, run only as a
  LaunchAgent — no shyn code involved — while the same probe from an
  interactive terminal (Terminal's own already-resolved TCC identity
  covers the read) returned instantly. A git checkout at
  `~/Documents/Code/shyn` puts the built daemon bundle, and its
  `node_modules` native addons (loaded the same synchronous way), squarely
  inside that protected folder. The cwd/env-based hypotheses considered
  going in (an ESM `package.json` JSON import, a cwd- or env-dependent
  path resolution) were tested and ruled out: the JSON import is fully
  inlined by esbuild at build time (confirmed by grepping the bundle), and
  reproducing launchd's exact captured environment/cwd/stdio from a
  terminal never hung. Fix: `shyn install` now stages the resolved daemon
  program under `shynHome()` (`~/Library/Application Support/shyn/bin/daemon`,
  not TCC-protected) before writing the launchd plist, via
  `stageDaemonProgram()` in `packages/cli/src/launchd.ts`, and points
  `ProgramArguments` at the staged copy instead of the repo checkout.
  Staging must preserve pnpm's `node_modules` symlink structure verbatim
  (`fs.cpSync(..., { verbatimSymlinks: true })`) rather than dereferencing
  it — dereferencing (whether `cpSync`'s `dereference: true` or the system
  `cp -RL`) was tried first and broke a different way, detaching each
  linked native-addon package from the `.pnpm/<pkg>/node_modules/`
  sibling directory its own `require()` walk-up depends on (confirmed
  live: `better-sqlite3-multiple-ciphers`'s `require("bindings")` started
  failing with `MODULE_NOT_FOUND` once dereferencing flattened it out of
  its `.pnpm` sibling). `verbatimSymlinks: true` keeps each symlink's
  relative target text unchanged, which still resolves correctly once the
  whole tree it points within is copied alongside it.
- README quickstart now uses an absolute path for `ingest` (was a relative
  path example that resolves against the CLI's CWD, not a stable location).
- `zod` range in `packages/mcp-client` bumped to `^3.25.0`.
- Root `package.json`'s native deps (`better-sqlite3-multiple-ciphers`,
  `node-llama-cpp`, `sqlite-vec`) were spike leftovers with no runtime
  consumer at the root — moved from `dependencies` to `devDependencies`.

## Before the public flip (Plan D)

Controller-run checklist, not subagent-run — collected here at the Plan C
final review so none of it gets lost between now and the actual flip to a
public repo.

- [x] Commit authorship: resolved 2026-07-20 by publishing as a fresh
  single-commit history (the private dev repo with the old authorship
  stays private as an archive).
- [x] Scrubbed the local-machine `file://` URL in `Formula/shyn.rb`
  (2026-07-20).
- [x] Scrubbed machine-specific paths in `docs/dist-bundle.md`
  (2026-07-20).
- [x] Internal planning docs (`docs/superpowers/`) removed from the repo
  entirely and archived privately (2026-07-20).
- [ ] `v0.2.0-alpha`'s existing GitHub release tag points at a pre-Plan-C
  base commit — a throwaway artifact from the dry run that predates
  `release.sh`'s tag-targeting guard (clean tree + pushed HEAD +
  `--target`, added in this batch). Not retagged/deleted by this batch —
  that's a controller decision at merge.
- [ ] `pnpm -r test` overwrites `dist/shyn.mcpb`: the mcpb bundle test
  builds the bundle in place as part of the test run, so anything relying
  on `dist/shyn.mcpb` being a specific prior build (e.g. a release artifact
  staged for upload) can get silently clobbered by a routine test run.
- [ ] The launchd stable-symlink mitigation (`stableNodePath()` in
  `packages/cli/src/launchd.ts`, preferring `/opt/homebrew/bin/node` over
  `process.execPath`) fixes the exec-not-found relaunch loop from a Node
  major bump, but can convert it into a different failure mode instead: if
  the stable symlink now resolves to a newer Node major than the one the
  bundled native addons were compiled against, launchd will happily keep
  execing a real binary that then fails to boot with `ERR_DLOPEN_FAILED`
  (the same ABI-mismatch class of failure as the runtime-ABI-coupling entry
  above) — a running daemon, not a silent no-op, but still broken.

## SP2 screen-capture — accepted minors (whole-branch review 2026-07-10)

- **stats.captures can overcount vs. docs actually stored.** `Pipeline.decide()`
  increments `captures` before `ship()`; if the daemon is down the payload is
  re-buffered but already counted. Telemetry-only; the store stays correct.
- **Static-content windows never advance their hour bucket.** The `unchanged`
  dedup keys on `sha256(text)` (not the hour), so a window whose text clears the
  80-char gate once and then never changes is captured once and skipped forever.
  Intended (no change → no capture); noted so the hour-bucket granularity isn't
  mistaken for a per-hour guarantee on static windows.
- **Actively-changing windows re-chunk + re-embed the whole bucket doc.** Within
  an hour, each content change REPLACEs the doc (delete all chunks/vectors,
  re-queue all chunks to embed). For a constantly-changing window (log tail,
  subtitles) at the 2s debounce this is embedding churn. Mitigated by the
  debounce + `unchanged` gate; no incremental-diff. Revisit if it shows up in
  beta CPU/volume.
- **capture.json writes are non-atomic.** A tick reading mid-write gets partial
  JSON → `CaptureConfig.load` falls back to defaults for that one tick (briefly
  dropping pausedUntil/excludes). Single-tick, very low probability.

## Logged (SP3 meeting-transcription, 2026-07-10)

- **SentinelOne EDR quarantines fresh agent binaries** on this dev machine:
  the SP3 spike's `meeting-probe` binary was silently deleted out of its
  signed bundle at `/tmp`, `~/.shyn/bin`, AND (on launchd bootstrap)
  `~/Library/Application Support/shyn/bin` — the LaunchAgents plist was
  removed too. Detection looks behavioral/reputation-based: SP2's
  `shyn-capture.app` (same "Shyn Dev" identity, same staging dir) keeps
  running. Consequence: the spike's headless-launchd PASS could not be
  executed; accepted because the adopted capture path (CoreAudio process
  tap + AVAudioEngine, no ScreenCaptureKit) has no WindowServer dependency
  — the risk that test targeted. `shyn-meeting` under `shyn install` may
  need an S1 exclusion (path or signing-identity) from IT; Task 12 live
  verification is the checkpoint. The daemon already surfaces a dead agent
  as `capture.meeting: "not-reporting"`.

## Logged (SP4 status-ui, 2026-07-11)

- **Post-daemon-restart "screen agent not reporting" warning** in the status
  UI until the screen agent ships its next capture: agent stats live in
  daemon memory and the screen agent posts only on ship (the meeting agent
  posts every tick, so it reappears in seconds). Truthful and self-healing,
  but alarming wording for a routine state. Candidate fix batched with the
  next Swift agent change: heartbeat-post per tick (like the meeting agent)
  or a softer "restarted recently" row. Also verify the transcribing tray
  glyph live during the next real meeting (recording-only card is the
  intended behavior; busy glyph shows without a card).

## Logged (SP3 detection quality, 2026-07-11)

- **Sustained non-speech audio (music/video playback) still counts as
  channel activity** for meeting detection/continuation: VoiceActivity
  discriminates by sustain (speech vs typing clicks/dings) but cannot tell
  music from speech without real VAD/ML. Consequences: music playing after
  a call delays auto-end until the mic channel also goes quiet for 60s;
  a phantom start needs BOTH channels voiced (commit gate), so music alone
  no longer creates one, but music + sustained mic voice (e.g. talking to
  someone in the room) can. maxDurationMinutes caps the damage. Revisit
  with a real VAD if it bites in practice.
  UPDATE 2026-07-22: it bit — speaker audio + Slack frontmost entered a
  phantom pre-roll via the listen-only booster (speaker→mic bleed can voice
  both channels). Slack removed from the booster list (89de722); the
  real-VAD revisit still stands for the remaining two-channel case.
  UPDATE 2026-08-05: the same bleed was corrupting TRANSCRIPTS, not just
  detection — see the SP8 entry below. AEC was tried as a capture-level fix and
  REVERTED the same day (see the AEC entry above); the phantom-preroll surface is
  therefore unchanged, and the real-VAD revisit still stands.

## Whisper "quality gates" were dead code — shipped 0.4.18, removed 0.4.22

Three per-segment gates (`noSpeechProb > 0.6`, `avgLogprob < -1.0`,
`compressionRatio > 2.4`) rejected **zero** segments across three real runs: a
3-minute synthetic meeting, a 349-segment session, and a recovered 70-minute
meeting. Probing WhisperKit 0.18.0 directly explains it:

```
noSpeech=0.0000  logprob=-0.1557  compression=2.0000  | The quarterly review starts now.
noSpeech=0.0000  logprob=-0.1557  compression=2.0000  | Retention improved by four points.
```

`noSpeechProb` is always **0**, so `0 <= 0.6` passed everything. `avgLogprob` and
`compressionRatio` are **identical across every segment** — result-level values
replicated onto segments, not per-segment measurements — so a per-segment
threshold on them can only pass everything or delete the entire channel. A gate
whose only two outcomes are "no effect" and "total loss" is a cliff, not a filter.

The plan that introduced them said the fields were "verified present on
TranscriptionSegment". True of the type, false of the values — the same mistake
class as the release-check bug: a unit test that proves the parser while the real
input never has that shape.

Removed. What survives is what measurably works: `isNonSpeechAnnotation`,
`collapseRepeats` (114 runs collapsed on the 70-minute meeting) and
`dropEchoDuplicates` (5 mic echoes dropped in the mock, proven by segment
arithmetic: 11 kept → 6 lines).

Also note: 20 seconds of **digital** silence produced no segments at all, so pure
silence is not the hallucination source. The `you` / `Thank you.` filler comes
from near-silence with room noise. Any future gate must be built against that,
not against zeroed decoder fields.

## Interrupted recordings were unrecoverable — fixed 0.4.22

The retry sidecar was written only when *transcription* failed. A session killed
while **recording** (crash, reboot, `shyn setup` during an upgrade) left orphaned
WAVs with no sidecar: nothing retried them, and the startup 24h sweep deleted
them silently.

This cost a real 70-minute meeting on 2026-08-06 — an onboarding session for new
joiners, interrupted by the 0.4.20 install at 13:49 and found only because the
file sizes (404MB + 807MB) looked wrong for a mock. It was recovered by hand-
writing a sidecar; the retry then transcribed and ingested it in ~15 minutes.

Fixed two ways: the sidecar is now written at **commit** time (not pre-roll — an
unverified pre-roll is ambient noise and should still be discarded), with
`end: 0` meaning "still recording" and `inferredEnd` recovering the duration from
the WAV mtimes. And `shyn setup` now asks a live meeting to stop cleanly before
replacing the agents, best-effort and non-blocking, because a clean handoff beats
a recovery.

## AEC (voice processing) degraded a LIVE call — shipped 0.4.18, reverted 0.4.19

**Do not re-attempt AEC the way 0.4.18 did.** `AVAudioInputNode.setVoiceProcessingEnabled(true)`
was added to cancel speaker→mic bleed at the source. On its first exposure to a real
meeting the user reported a **persistent tone that rose and fell, audible to him during
the call**, while using the laptop mic.

Two mechanisms, both inherent to the API rather than to our wiring:

1. **AUVoiceProcessingIO reconfigures the SHARED input device**, so its effects are not
   confined to our capture. Meet/Zoom holding the same mic inherit the altered stream.
   Our risk assessment said "worst case, that meeting's *recording* is degraded" — wrong.
   The live call was degraded.
2. **You cannot take just the echo canceller.** VPIO bundles AEC with automatic gain
   control and noise suppression; AGC riding the level up and down is exactly the
   "increasing and decreasing" the user heard. The tone most likely came from
   `eng.outputNode.setVoiceProcessingEnabled(true)` — putting the OUTPUT node into
   voice-processing mode, a speculative line that changed what he heard, not just what
   was captured.

What did work as designed: the `echoCancellation` config flag and the do/catch fallback.
They covered the case where macOS **refuses** voice processing. Nobody considered the
case where it **succeeds and is harmful** — that was the gap.

Reverted in 0.4.19: the voice-processing calls, the `start(echoCancellation:)` parameter
and the `MeetingConfig.echoCancellation` flag are all gone. Speaker→mic bleed remains
handled after the fact by `dropEchoDuplicates` (CaptureCore), which is pure, tested, and
structurally incapable of touching live audio.

**If AEC is ever attempted again:** never on the output node; never with a real meeting
as the test. Build a harness (`say` through the speakers, no human on the far end),
measure mic-channel energy with and without, and confirm a concurrent call is unaffected
before shipping. Process rule this cost us: **an audio-path change must not have its
first live exposure be real work.**

## Logged (SP8 meeting transcript fidelity, 2026-08-05)

- **Pending meeting audio is bounded by the 24h orphan sweep.** When
  transcription fails for infra reasons (model absent, offline) the session
  audio is kept with a `pending.json` sidecar and retried while idle, gated on
  the model being present locally. `sweepOrphanAudio` runs at agent STARTUP
  only, so a pending session is purged on the first launch after it turns 24h
  old — a meeting whose model never arrives inside a day is still lost.
  Accepted: keeping raw meeting audio around for days would undercut the
  byte-honest purge promise. `maxPendingAttempts` (5) additionally caps a
  present-but-unusable model from re-transcribing forever.
- **Echo dedupe is threshold-based, tuned against one real transcript.**
  `dropEchoDuplicates` drops a mic segment when a system segment within 2.5s
  scores >= 0.6 token overlap, both sides >= 4 tokens. Short affirmations are
  deliberately exempt, so a duplicated "yes, absolutely" pair still appears on
  both channels. Retune when more bleed transcripts exist.
- ~~**AEC is unverified…**~~ RESOLVED THE HARD WAY 2026-08-05: it was verified
  on hardware by degrading a live call, and reverted in 0.4.19. See the AEC entry
  above. Left here as the trail from "unverified" to "reverted".

## Logged (SP5 distribution, 2026-07-11)

- **Vendored node adds ~145MB extracted to the release payload.** Accepted
  by design — ABI parity across machines beats artifact size; revisit if
  artifact size becomes a distribution problem.

## Embedding outage after a transient node-llama-cpp import failure (observed 2026-07-11, v0.3.0-alpha)

Symptom: `failedEmbeds` climbs, `modelLoaded: false` persists, and
`~/Library/Logs/shyn/daemon.log` repeats `ERR_MODULE_NOT_FOUND: Cannot find
package 'lifecycle-utils'` — while a fresh process on the same staged tree
imports node-llama-cpp fine. One transient import failure (first drain firing
around `shyn setup`'s re-stage window) sticks for the life of the daemon
process; the Embedder itself clears `loading` on failure and retries, so the
persistence is at the module-loader layer, not ours. Search degrades to
keyword-only for new content (degraded ladder masks it).

Remedy: `launchctl kickstart -k gui/$UID/com.shyn.daemon`. `shyn diagnose`
surfaces the error lines.

FIXED 2026-07-11 (commit 13bbe44) after it reproduced deterministically on a
fresh install: the import failure is now tagged, consumes no embed attempts,
and (since v0.4.2) heals IN-PROCESS: the first failure falls back to a
CJS-resolved, cache-busted file-URL import — a fresh module job that loads
where the bare specifier stays poisoned (validated on the staged tree).
The restart ladder (15-min cooldown) remains as backstop only. v0.4.1's
restart-based heal never converged — launchd respawns stayed poisoned
while shell/kickstart contexts resolved fine (responsible-process trust
difference, likely EDR-related). Chunks that exhausted attempts during past
outages re-enqueue on every boot. Ships in the release after v0.4.0-alpha.

## "Node.js Foundation" in Login Items / background-activity notifications

macOS Background Task Management attributes the daemon's LaunchAgent by the
code signature of its executable — the vendored nodejs.org binary, signed by
"Node.js Foundation". Accepted by design (2026-07-11): keeping the official
notarized signature is an integrity feature; re-signing with the local "Shyn
Dev" identity would remove the only Apple-notarized signature in the payload.
Mitigation: explained in the cask caveats; consider a Shyn-Dev-signed daemon
wrapper .app when Developer ID signing lands (Plan D).

## "Connect Claude" step un-checks after every daemon restart

`lastMcpHelloTs` is memory-only, so upgrades/restarts reset the onboarding
step until the next real Claude session fires a hello (the registration
itself is unaffected — cosmetic regression only). Fix for a future release:
persist the timestamp to a small file under shynHome (same pattern as
onboarding-throttle.json) and load it at boot.

## Calendar notes can contain third-party email addresses (accepted, 2026-08-08)

`attendeeDisplayName` guarantees that every field shyn RENDERS — attendees and
organizer — carries no contactable address. It cannot clean the invite BODY: a
sender who types "Organizer: Someone (someone@example.org)" into the description
has put an address in free text, and stripping addresses out of prose would
mangle legitimate content (a shared mailbox to write to, a support alias in an
agenda). Two such events exist in the live corpus; both are external workshop
invites.

Consequence to be aware of: meeting and calendar documents go to an LLM over MCP
on recall, so an address a third party wrote into an invite body travels with it.
Accepted rather than fixed — redacting free text is a bigger and riskier
behaviour than the guarantee this rule actually makes, which is that shyn never
ADDS an address of its own.
