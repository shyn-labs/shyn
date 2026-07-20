# capture-probe — Task 1 spike findings

De-risks the two unknowns before real code (spec §6, plan Task 1):
(a) does a **headless LaunchAgent `.app`** get + keep Accessibility + Screen
Recording and can SCK capture from it; (b) is **AX** the common text path or
is **OCR** (sets CPU expectations).

## Decision: PARTIAL PASS — AX path viable headless; OCR/Screen-Recording
## blocked on code-signing (required amendment before Task 6)

A headless LaunchAgent **does** run and capture text, **provided** the
process establishes a GUI session before touching AppKit/CG/SCK (see "CGS
crash"). **However, the OCR path is blocked**: an **ad-hoc-signed** app
(`TeamIdentifier=not set`) is **not** granted effective Screen Recording on
this macOS (Darwin 25 / Tahoe) even with the toggle **ON** in System
Settings — every `SCScreenshotManager` call returns
`-3801 "user declined TCCs"` and re-prompts. Verified with **both** launch
methods (direct-exec of the inner binary **and** LaunchServices `open` for
correct bundle attribution) — same result. The cdhash of bundle and inner
binary match, so identity isn't the issue; the **unstable ad-hoc signature
is**. macOS shows the toggle but won't authorize screen capture for an app
without a stable signing identity.

### Required amendment before Task 6

- **The real capture agent must ship Developer-ID-signed** (stable signing
  identity) for the OCR/Screen-Recording path to work at all. Ad-hoc is
  insufficient. This couples SP2 to the signing/distribution story (Plan D).
- If no Developer ID is available, the product **degrades to AX-only**,
  which is the common path anyway (see quality table) — OCR fallback simply
  stays dark until signed. The menubar-agent fallback (spec §6) does **not**
  fix this; it's a signing problem, not a session-visibility problem.
- OCR **code** is proven correct: a run whose responsible process already
  held Screen Recording captured real text (`chars=634`).

## AX vs OCR quality (interactive, Step 3)

Measured with each app frontmost (`capture-probe ax`), run from a terminal
that already holds Accessibility:

| App | Bundle | AX chars | Notes |
|---|---|---|---|
| Google Chrome | com.google.Chrome | ~12,006 | Rich: full page text + nav + bookmarks. AX path. |
| Claude (desktop, Electron) | — | ~3,572 | Rich: sidebar, chat titles, body. AX path. |
| Granola (Electron) | — | ~2,014 | Moderate: nav + note labels. AX path. |
| Warp (terminal) | dev.warp.Warp-Stable | ~1,800–2,400 | Command input + scrollback. AX path. |
| Finder | — | ~54 | Sparse (file names only) → **below 80-char threshold → OCR fallback**. |

**Conclusion:** AX is the common, cheap path for text-bearing apps
(browsers, Electron, terminals, native doc apps). OCR is the fallback for
sparse-AX surfaces (Finder, image viewers, PDF/canvas). CPU expectation:
AX dominant and inexpensive; OCR rare. The plan's 80-char AX→OCR threshold
discriminates correctly on this corpus.

## CGS crash — required design amendment for Task 6

A launchd-spawned process that calls `NSWorkspace.shared.frontmostApplication`
/ SCK / CoreGraphics **without first establishing a GUI session** crashes:

```
Assertion failed: (did_initialize), function CGS_REQUIRE_INIT,
file CGInitialization.c, line 44.
```

**Fix (validated here, adopt in Task 6):** at process start, before any
capture,

```swift
let nsApp = NSApplication.shared
nsApp.setActivationPolicy(.accessory)   // WindowServer connection; no Dock/menubar
```

After this, the agent runs headless under launchd and logs `ax`/`ocr` lines
with no crash. This is stronger than relying on the bundle's `LSUIElement`
key alone — when launchd execs the inner Mach-O directly, `LSUIElement` is
not enough to init CGS; the runtime `.accessory` policy is required.

## launchd / TCC operational notes

- **`KeepAlive` is mandatory** for the agent plist. Toggling a TCC grant in
  System Settings makes macOS **terminate** the target process to
  re-evaluate permissions; with only `RunAtLoad` it never comes back.
  With `KeepAlive`, launchd relaunches it (this doubles as the
  "survives `launchctl kickstart -k`" check).
- **Ad-hoc re-signing resets TCC grants.** TCC keys an ad-hoc-signed app on
  its cdhash; every `codesign --force --sign -` changes the cdhash and
  invalidates prior grants. Task 6's real agent must ship with a **stable**
  signature (Developer ID or a persistent ad-hoc identity) so grants stick.
- The staged spike app lives outside `~/Documents` (at
  `~/Library/Application Support/shyn-capture-probe/`) to avoid the known
  launchd-under-Documents TCC read hang (see main repo's launchd-hang fix).

## Screen Recording headless — prompt-storm finding (Task 6 requirement)

On this macOS (Darwin 25 / Tahoe), first-run behaviour for the headless agent:

- The combined **"Screen & System Audio Recording"** pane makes it easy to
  enable **audio only** — the first grant attempt registered as
  `kTCCServiceAudioCapture` (allowed) with **no** `kTCCServiceScreenCapture`,
  so screen capture stayed denied.
- A headless agent that calls `SCScreenshotManager` on every loop tick while
  screen capture is **not** granted triggers a **repeating modal prompt**
  ("capture-probe would like to record this computer's screen and audio")
  every cycle — disruptive.

**Task 6 requirements (adopt):**
- **Preflight** with `CGPreflightScreenCaptureAccess()` before ever touching
  SCK; if false, call `CGRequestScreenCaptureAccess()` **once**, then go
  dormant / AX-only. Never loop-call SCK ungranted.
- Treat OCR as a genuine fallback: with AX as the common path (validated
  above), the product is useful even while screen recording is denied.

OCR code path itself is **proven correct**: a direct one-shot `ocr` run
captured real text (`chars=634`) once screen capture was available.

## PENDING (live): TCC grant + soak

Grant **Accessibility** and **Screen & System Audio Recording** to
`~/Library/Application Support/shyn-capture-probe/capture-probe.app`, then
the loop will emit real `ax | <n≥80>` and `ocr | <n>` lines. Remaining PASS
clauses to confirm once granted:
- OCR returns a plausible char count headless (Screen Recording effective).
- Grants survive `launchctl kickstart -k` (re-approval nag wording/cadence,
  if any, to be recorded here).

Log: `~/Library/Application Support/shyn-capture-probe/capture-probe.log`.
