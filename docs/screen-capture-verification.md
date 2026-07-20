# Screen Capture (SP2) — Verification Record

Two layers of verification: an automated e2e that freezes the wire contract
(done, in CI), and a live checklist that needs a real GUI session + TCC grants
on the machine (pending — see the signing gate below).

## Automated e2e — DONE ✅

`packages/daemon/test/screen-e2e.test.ts` — a Node "fake agent" speaks the exact
wire shapes `DaemonClient` sends (Task 7), against a real temp daemon over a real
socket. Proves, minus TCC:

- hour-bucket **REPLACE** (same bucket uri, new text → one doc, latest wins)
- next-hour bucket → new doc
- `captureStats` round-trips into `status.capture` (exact `Stats` shape incl. `tcc`)
- 31-day-old screen doc **swept** by the retention timer; its text no longer
  keyword-searchable (byte-honest via `forget`)
- newest capture searchable as a `screen` doc with the agent's title

Full workspace at time of writing: **JS 138 + Swift 10, typecheck clean.**

## Scope update (2026-07-10): OCR UNBLOCKED via free self-signed cert ✅

**Correction to the earlier "defer OCR" call.** The spike only tested *ad-hoc*
signing (`codesign -s -`, no stable identity) — that gets no effective Screen
Recording grant. But the real requirement is a **stable signing identity**, not a
*paid* Developer ID. A **free local self-signed cert** ("Shyn Dev", created by
`scripts/setup-signing.sh` — the approach lifted from the `themacdaa`/Macda repo)
gives a stable designated requirement that TCC honors. (Developer ID +
notarization is only needed to *distribute* to other machines.)

**Verified live (2026-07-10):** built the agent `codesign --sign "Shyn Dev"`,
installed, granted Screen Recording → `shyn status` shows
`tcc.screen: true, method.ocr: 4` — OCR captured and ingested real screenshots
via SCK+Vision. The `-3801` denial that blocked the ad-hoc build is gone. **OCR
ships now, no Developer ID, no cost.**

Setup (one-time): `bash scripts/setup-signing.sh` then a one-time
`security set-key-partition-list -S apple-tool:,apple:,codesign: -s ~/Library/Keychains/login.keychain-db`
(enter login password) so codesign can use the key non-interactively. Build:
`SHYN_CODESIGN_IDENTITY="Shyn Dev" pnpm build-capture`. Grants persist across
rebuilds because the identity is stable.

## Live checklist — VERIFIED (signed agent, AX + OCR) — 2026-07-10

Ran on the real machine with the "Shyn Dev"-signed agent. Both grants effective
and persistent across rebuilds (stable identity).

1. [x] `SHYN_CODESIGN_IDENTITY="Shyn Dev" pnpm build-capture && pnpm build:dist`
   → `shyn install` → both agents bootstrapped; Accessibility **and** Screen
   Recording granted to the staged app. Grants persisted across a subsequent
   rebuild/redeploy with no re-grant.
2. [x] **[GATE]** AX capture live-verified (`method.ax` climbing, e.g. 89 captures
   AX-primary); `shyn search` returned real captured content (Warp session,
   Finder path) as `screen` docs — a content answer, not just a title. — criterion 2
   (Multi-hour beta soak is ongoing, but the capability is proven.)
3. [x] Privacy drill — criterion 4. Both denylist axes live-verified:
   - **bundle-id**: System Settings (`com.apple.systempreferences`) auto-skipped, `skips.excludedApp` climbing.
   - **title-regex**: a window titled "razorpay payment secure checkout" was
     focused → `skips.excludedTitle` incremented by 1 and a search for its unique
     content token returned **0** matching screen docs (its content was never
     ingested). Gate fires on title *before* any content read.
   (Spot-checking your own 1Password + a real payment page is still worthwhile,
   but the gate mechanism itself is proven on both paths.)
4. [x] `shyn pause 30m` halted capture (`captures` flat, `skips.paused` incremented);
   `shyn resume` cleared it and capture resumed.
5. [x] CPU: sampled ~0% idle, 2.2% peak during a capture tick, 31 MB RSS — well
   under ~3% avg. — criterion 6
6. [x] Volume: ~4 screen docs over ~25 min heavy use (hour-bucket REPLACE collapses
   repeats); projects well under 300/day. Multi-day beta count will confirm. — criterion 3
7. [ ] `shyn uninstall --purge` no-trace test — **consciously deferred.**
   Important: `--purge` deletes the **entire** `shynHome` (the whole ~16.7k-doc
   memory store — browser/notes/screen — plus the keychain key), not just screen
   docs. Running it now would wipe your live memory + stop the beta, so it's not
   worth it as a checkbox. The teardown paths (plist bootout + removal, staged-app
   removal, home/keychain purge) are unit-tested in `launchd.test.ts`. Run for
   real only when you actually want to decommission Shyn. — criterion 7

**Net:** 6 of 7 criteria verified (5 live + retention via unit/e2e; privacy drill
live on both denylist axes). Only #7 remains, and it's intentionally not run
because it's destructive to your live store — covered by unit tests instead.

## OCR fast-follow (deferred)

When a Developer ID Application cert exists: (1) `security find-identity -v -p
codesigning` confirms it; (2) `SHYN_CODESIGN_IDENTITY="Developer ID Application:
<name> (<team>)" pnpm build-capture && shyn install`; (3) grant Screen Recording
to the staged app; (4) confirm `shyn status` shows `method.ocr > 0` on a
sparse-AX app (e.g. Preview/Finder). No source changes expected.

## Exit criteria status (spec §7)

1. Spike — **PASS**: headless capture viable (NSApp `.accessory` fix); AX-primary
   validated live (`method.ax` with Accessibility); **OCR validated live** on a
   free self-signed cert (`tcc.screen:true, method.ocr:4`). Full AX+OCR in scope.
2. Content-question-after-use — AX capture live-verified (captured Warp/Finder
   text, searchable); OCR capture live-verified (Preview). ~2h soak still nice-to-have.
3. ≤ 300 docs/day — projected well under via hour-bucket REPLACE (≈4 docs in ~25min
   heavy use); multi-day beta count pending.
4. Payment/password drill — **DONE**: both denylist axes live-verified (bundle-id
   System Settings auto-skip; title-regex "razorpay" window skipped, 0 docs ingested).
5. 31-day byte-absent sweep — **DONE** (retention unit test + e2e retention step).
6. ≤ ~3% CPU — **DONE** (sampled ~0% idle, 2.2% peak during a tick, 31MB RSS).
7. `uninstall --purge` no trace — install/uninstall unit-tested; **live pending** (deferred — agent kept running for beta).
