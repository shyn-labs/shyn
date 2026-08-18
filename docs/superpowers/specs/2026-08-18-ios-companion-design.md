# shyn iOS companion — design

**Date**: 2026-08-18 · **Status**: approved design, pre-implementation
**Decision path**: recall first, capture second · full offline recall · no shyn
servers, ever · iCloud Drive folder as transport (CloudKit deferred — it
requires the paid Apple Developer Program, currently blocked on enrollment
payment) · Apple on-device Foundation Models for answers.

## Purpose

A phone-side window into the same memory the Mac builds: ask your memory
anything on the commute with zero connectivity (recall), and feed phone-side
life back into it (capture). The companion must not weaken shyn's core claim —
local-first, minimal egress, no shyn-operated infrastructure, auditable.

## Non-goals (v1)

- No shyn relay/server component. Rejected outright: it converts
  "nothing to trust" into "trust us", the one wedge shyn has.
- No remote MCP bridge (`shyn serve --remote` or any internet-reachable
  endpoint), now or as a phase-3 maybe. Decided 2026-08-18: shyn keeps zero
  listening surfaces — no OAuth server to get wrong, no tunnel hostname to be
  scanned, no component whose compromise exposes the corpus. Claude-on-mobile
  integration is structurally impossible without one (Claude connects to
  connectors from Anthropic's cloud), so the on-device pipeline in §4 is the
  mobile answer, not a stopgap.
- No CloudKit in v1 (needs paid dev program). The design upgrades to it
  cleanly later: transport swaps, replica/crypto/UX layers carry over.
- No conversation threading in the ask UI; each ask is standalone.
- No iOS Safari extension in v1/v2 (per-site prompts + background limits gut
  ambient capture; reassess phase 3).
- No subscription mechanics; that decision lands with App Store distribution.

## Architecture overview

```
Mac                          user's iCloud Drive               iPhone
────────────────────────    ─────────────────────    ─────────────────────────
daemon ──ingest/forget──▶   shyn/index/  (Mac→phone)  ──▶ sync engine ──▶ replica
  │   snapshots + deltas       snapshot-<epoch>.shynsync         (SQLCipher:
  │   (file I/O only; the      delta-<epoch>-<n>.shynsync         docs, chunks,
  │   OS does the syncing)                                        vectors, FTS5)
  │                                                                   │
  └──watch/ingest/delete◀── shyn/outbox/ (phone→Mac) ◀── captures ────┘
                            capture-<uuid>.shynsync      (share sheet, voice,
                            shyn/pairing.json             photo OCR)
                            (metadata only, no secrets)
```

Everything in the folder is ciphertext. Apple syncs bytes it cannot read.

## 1. Sync format & keys

- **Envelope**: same construction as the existing archive
  (`packages/engine/src/archive.ts`): AES-256-GCM over gzipped JSONL, streamed;
  tampering/truncation fails loudly on GCM auth. New magic `SHYNSYNC1`.
- **Key**: a random 32-byte *sync key* — NOT passphrase-derived (scrypt per
  file is pointless here; the disaster-recovery archive with its passphrase
  remains a separate feature). Minted on the Mac, stored in the login
  Keychain, displayed once as a QR in the status popover; phone scans it into
  the iOS Keychain. Key rotation = re-pair (new QR, fresh snapshot).
- **`index/`** (Mac → phone):
  - `snapshot-<epoch>.shynsync` — full corpus: documents + chunks + int8
    chunk vectors (the phone must never re-embed the corpus) + the text FTS5
    is built from.
  - `delta-<epoch>-<n>.shynsync` — ordered doc-level upserts and **deletes**
    keyed by `uri`. `shyn forget` MUST propagate; deletes are first-class.
  - Compaction: when accumulated deltas exceed a size threshold the daemon
    writes a fresh snapshot and prunes old files.
- **`outbox/`** (phone → Mac): `capture-<uuid>.shynsync`, each containing one
  `IngestPayload`-shaped JSON document.
- **`pairing.json`**: schema version, current snapshot epoch, device ids.
  Metadata only — never secrets, never content.
- Scale check: ~36k docs / 50k int8×1024 vectors ≈ ~50MB vectors + compressed
  text; comfortably within iCloud Drive behavior.

## 2. Mac side

- **Daemon sync module** (`packages/daemon` or engine-level): on ingest and
  forget, append to the open delta file (debounced); snapshot on threshold.
  Pure local file I/O — the daemon's "no network requests, ever" invariant is
  untouched; macOS uploads the folder.
- **Outbox ingestion**: daemon watches `outbox/`, decrypts, feeds payloads
  through the NORMAL ingest pipeline (dedup, chunking, embedding — phone
  captures are indistinguishable from any reader downstream), deletes each
  file on successful ingest. Auth-failed files are quarantined loudly
  (operator-visible log), never silently dropped.
- **Config**: opt-in via `capture.json` → `"iosSync": { "folder": "<path>" }`.
- **Status popover**: pairing QR, sync health row (last export, folder
  reachable, outbox backlog), enable/disable.

## 3. iOS app

SwiftUI, monorepo at `packages/ios-app` (keeps sync format + cross-platform
fixtures in one repo). Minimum OS pinned by the Foundation Models framework;
older devices get retrieval-only mode. Three units:

- **Store**: SQLCipher SQLite; tables mirror the Mac where it matters
  (`documents`, `chunks`, `chunk_vectors` via sqlite-vec, FTS5 built locally
  from synced text). DB key in the iOS Keychain.
- **Sync engine**: security-scoped bookmark to the user-picked folder
  (document picker — no iCloud entitlement needed); pulls on foreground +
  `BGAppRefreshTask`; applies snapshot/deltas transactionally with the epoch
  in a meta table; a delta failing GCM auth is discarded whole.
- **Query embedder**: Qwen3-embedding-0.6B quantized (~350MB) via llama.cpp
  SPM, downloaded on first run (WhisperKit pattern — never bundled). Same
  vector space as Mac chunk vectors; instruction prefix on queries only
  (existing gotcha). Absent model or old device → FTS-only, honestly labeled.

## 4. Retrieval + answer pipeline

Ask box → hybrid retrieval (FTS + vector, reciprocal-rank fusion, mirroring
the Mac) → top-K snippets → Apple **Foundation Models** on-device session
synthesizes a streamed answer from the snippets. Zero egress, no API keys.
Every answer shows its source snippets (title/time, tappable to full doc).
Toggle + automatic fallback to pure retrieval. No threading in v1.

## 5. Captures (phase 2, in this order)

All captures write one encrypted `IngestPayload` file to an app-group inbox;
the main app relays it into `outbox/` (extensions cannot reliably hold the
security-scoped folder grant themselves).

1. **Share sheet** — URL/text/screenshot from any app; the phone's
   browser-reader equivalent. Highest leverage, cheapest.
2. **Voice notes** — Speech framework on-device transcription; audio purged
   after transcript ships (same byte-honesty as Mac meetings).
3. **Photo OCR** — Vision framework; camera + photo-picker entry points.

Safari extension: parked, reassess phase 3.

## 6. Testing

- **Golden files in-repo**: Node writes fixtures (snapshot, deltas including
  deletes, a tampered file); Swift tests must read them. Cross-platform crypto
  proven in CI, not on a real phone.
- Unit: delta apply/merge, forget propagation, epoch handling — both sides.
- E2E: Mac exporter → temp folder → replay into the iOS store in simulator.
- Live validation: pair the maintainer's own phone first; confirm a
  `shyn forget` on the Mac removes the doc from the phone within one sync
  cycle before any wider use.

## 7. Distribution & sequencing

1. **v1 (recall)**: sections 1–4, minus the Mac outbox watcher (nothing writes
   to `outbox/` until captures exist). Personal sideload (7-day re-signs until
   the Shyn-bot Apple Developer payment clears). Mac-side code rides the
   normal release train.
2. **v2 (capture)**: section 5 in the order listed, plus the Mac outbox
   watcher from section 2.
3. **Later**: CloudKit transport upgrade + TestFlight + App Store once the dev
   program unblocks; subscription decision made then, not before.

## Open questions (tracked, not blocking)

- ~~Exact iOS minimum (Foundation Models device floor)~~ — pinned 2026-08-18:
  **iOS 26.0+, Apple Intelligence-capable hardware (iPhone 15 Pro or newer)**,
  gated at runtime via `SystemLanguageModel.default.availability` with
  retrieval-only fallback on `.unavailable`. On-device model context is small
  (~4k tokens): top-K snippet selection must stay tight. Never use
  `PrivateCloudComputeLanguageModel` — it leaves the device.
- Snapshot/delta size thresholds — pick from real corpus measurements.
- Whether the popover QR pairing can reuse the existing controls IPC or needs
  a new surface.
