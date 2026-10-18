# Releasing

One page. No placeholders — every check below must actually be run before
tagging, on the machine doing the release (M-series Mac).

**Cut a release:** `scripts/release.sh <version>` (e.g. `scripts/release.sh
0.2.0`) runs the automated gates (typecheck, `pnpm -r test`, `eval:keyword`,
`test:e2e`), builds the `dist/` daemon bundle and `.mcpb` extension, tars the
daemon, and cuts a `gh release create --prerelease` with both artifacts
attached. It prints the new tarball's sha256 as a reminder to update
`Formula/shyn.rb`'s pinned hash — it does not edit the formula itself.
`eval:hybrid` and `eval:latency` are **not** run by the script (see below) —
run them by hand before a real release. Pass `--no-publish`
(`scripts/release.sh <version> --no-publish`) to run gates + build artifacts
without cutting the GitHub release, for a dry-run.

## Checklist

- [ ] **All CI green.** `pnpm typecheck && pnpm -r test && pnpm test:e2e` —
      every workspace package, plus the real-daemon-subprocess e2e suite.
- [ ] **`pnpm eval:hybrid` ≥ 0.8, run locally with the real model.** CI does
      not run this (it needs the ~640MB embedding model downloaded and
      warm); run it by hand and read the printed `recall@5 (hybrid): X.XXX`
      line against the `0.8` bar. `pnpm eval:keyword` (bar `0.6`) is cheap
      enough to run in CI and should already be green from the step above.
- [ ] **`pnpm eval:latency` p95 < 500ms, run locally on M-series.** Not in
      CI (multi-minute runtime building a 100k-chunk synthetic DB, and
      results vary with hardware). This is the release gate for search
      latency at scale — a fresh pass, not a cached number from last
      release. If it fails: this is a pre-committed bar, do not raise it.
      Profile (start with `vectorSearch` in `packages/engine/src/search.ts`
      — brute-force scan across the `chunk_vectors` table is the likely
      culprit once queries don't supply `timeFrom`/`timeTo` to narrow the
      month partition) and fix or explicitly hold the release.
- [ ] **`pnpm test:e2e` green** (also covered by the CI-green step, called
      out separately because it's easy to skip when iterating locally —
      it spawns a real daemon subprocess and is the closest thing to a
      smoke test of the shipped artifact).
- [ ] **Version bump.** Bump the version in every published package's
      `package.json` (`packages/engine`, `packages/daemon`, `packages/cli`,
      `packages/mcp-client`) **and `extension/manifest.json`** (the `.mcpb`
      self-identifies from it — missed in v0.3.0-alpha, caught live) to the
      same release version. Keep them in
      lockstep — there is exactly one client and one daemon version in play
      at a time (see `docs/known-issues.md`, Plan A section, on why socket
      protocol versioning is still deferred).
- [ ] **Artifact leak scan.** `node scripts/check-artifact-leaks.mjs`
      extracts the built tarball and `.mcpb` and scans the contents of
      every file, the raw archive streams (owner names, path names, link
      targets, headers), the gzip header and every extracted path and
      symlink target for the builder's username, home dir and checkout
      path (anywhere, exact) plus every term of the private denylist
      (`~/.config/shyn/leak-denylist.txt`, kept OUTSIDE this repo on
      purpose; whole words, and inside binaries only within a run of 6+
      printable bytes, shorter matches are counted as "ignored binary
      noise"). An empty denylist or an empty archive fails, and an archive
      whose listing is ambiguous (duplicates, devices, fifos, entries below
      a symlink, a tree that differs from its listing) is refused, not
      partially scanned. Any hit aborts the release; fix the source of the
      hit and rebuild, never edit the scan. Vendored third-party
      coincidences go in the owner allowlist
      (`~/.config/shyn/artifact-leak-allow.txt`), also outside the repo.
      - **Signing policy.** Every code item (bundle directory or Mach-O
        file) must pass `codesign --verify --strict` and be one of three
        kinds: signed by an allowed identity (`SHYN_ALLOWED_AUTHORITIES`,
        comma separated, default `Shyn Dev`, the only authority and no
        team id); a pinned third-party signer (the list
        `THIRD_PARTY_SIGNERS` in `scripts/lib/signing.mjs`, today the
        vendored Node runtime); or an ad-hoc signed file (never an ad-hoc
        bundle). A tarball must contain at least one `.app`. Identities of
        anything not allowed are printed as `<redacted>`.
      - **`--release`.** `scripts/release.sh` runs the gate with
        `--release`: the gate then exits 2 without scanning if
        `SHYN_LEAK_DENYLIST` or `SHYN_ARTIFACT_ALLOW` is set (even empty),
        if `--ci` is passed, or if the home dir is `/Users/runner`.
        Without `--release` the gate prints a `NOTICE` for each override
        and for CI mode, and a `WARNING: test override active: <NAME>` for
        each test hook (`SHYN_CODESIGN`, `SHYN_GATE_USERNAME`,
        `SHYN_GATE_TEST_DELAY_MS`); `release.sh` strips the hooks. On a CI
        runner pass `--ci` (no private files there, home/username needles
        dropped), never with `--release`.
      - **`release.sh` refusals.** Before any build step or git check it
        refuses (exit 1, naming the variable only): `BASH_ENV`, `ENV` or
        any shell function defined; `NODE_OPTIONS`; the two override
        variables; a `HOME` that is not the account's real home directory
        (or is `/Users/runner`); an empty `SHYN_ALLOWED_AUTHORITIES`; and a
        signing identity (`SHYN_CODESIGN_IDENTITY`, default `Shyn Dev`) that
        is not in the allowed list. A non-empty `SHYN_ALLOWED_AUTHORITIES`
        prints a count-only `NOTICE`.
      - **Accepted risk: PATH `node`.** The gate runs under the same
        PATH-resolved `node` as the whole build; a hostile `node` on PATH
        would defeat every check, so release from a clean shell.
      - **sha256.** The gate prints `sha256: <hex>` for the tarball and
        the `.mcpb`, computed from the private copy it extracted.
        `release.sh` prints the tarball's `shasum -a 256`; confirm the two
        match before publishing.
      - **Denylist syntax.** The denylist is shared with a Python gate, so
        every line must be a regex valid in BOTH JavaScript and Python
        `re`. There is no dialect validator.
      - **ReDoS.** Denylist lines are the owner's own regexes; keep them
        simple literals. Nested quantifiers can make a scan hang.
- [ ] **Tag.** `git tag vX.Y.Z && git push --tags` once the above are all
      green and the version bump is committed. Write a short tag message
      summarizing what shipped (new readers, new commands, fixed bugs) —
      future-you diffing tags is the changelog until there's a proper one.

- [ ] **Rebuild natives against the current node ABI.** `pnpm rebuild
      better-sqlite3-multiple-ciphers`, then load-check it (a bare
      `node -e "require('better-sqlite3-multiple-ciphers')(':memory:')"`
      from packages/engine). A Homebrew node major bump silently breaks the
      prebuilt natives (lived on 2026-07-10: NODE_MODULE_VERSION 139 vs 147
      crashed every suite and would have crash-looped the staged daemon on
      its next restart). Also re-run `pnpm build:dist` AFTER the rebuild so
      the staged bundle carries the fresh natives.
- [ ] **Artifact completeness.** Resolved 2026-07-11: `scripts/release.sh` now builds and publishes ALL artifacts (payload tarball incl. apps + vendored node, `.mcpb`) to `$SHYN_TAP_REPO` and updates the cask. Verify the dry-run output lists them.
- [ ] **Tap publish sanity.** After release: `brew update && brew install --cask shyn-labs/tap/shyn` on this machine installs the new version; `shyn setup` re-stages; grants persist.
- [ ] **MCP Registry.** Update `server.json`: bump `version` and both the
      release-URL `identifier` and `fileSha256` of the new `shyn.mcpb`
      (`openssl dgst -sha256 dist/shyn.mcpb`). Then
      `mcp-publisher login dns --domain shyn.day --private-key <hex of ~/.config/mcp-publisher/shyn-day-ed25519.pem>`
      and `mcp-publisher publish`. Auth is the DNS TXT record on shyn.day's
      apex (namespace `day.shyn/*`) — GitHub-org auth was bugged at first
      publish (registry issue #1468). Tokens live 5 minutes: login and
      publish in one sitting. PulseMCP and other aggregators ingest from
      this registry; no separate submissions needed.
- [ ] **Version bump excludes `@shyn/status-ui`** — it is private and
      pinned `0.0.0`, deliberately outside the four-package lockstep.
- [ ] **Live file-search sanity.** With thatone running,
      `node scripts/check-file-search.mjs "<query>"`: the script exits 0 and
      prints at least one hit for a query you know matches (it skips the
      memory_status check because it runs against a throwaway SHYN_HOME);
      separately, in your real MCP client, `memory_status` ends with
      `file search: ready (thatone)`.
- [ ] **Live meeting sanity.** Since v0.2.0 the meeting agent's detection is
      voice-verified (pre-roll commit gate); before tagging, confirm the
      most recent real meeting auto-ended and produced a transcript
      (`pnpm shyn meeting status`, `pnpm shyn search "<something said>"`).
- [ ] **`pnpm check:meeting-titles` green.** The step above asks whether a
      transcript EXISTS. It passed on every release through September 2026 —
      including the week seven consecutive meetings shipped as "Google Chrome
      meeting · <date>", because a transcript existed every time and nobody
      checked whether it could be found by name. This asks the harder
      question: did every recent meeting get a title from a real source, or
      did some fall through every rung of the ladder onto the app-name
      fallback? Needs a running daemon and real captured meetings, so it is a
      manual gate like the evals, not part of `release.sh`. A failure is not
      necessarily a code defect — the two permission rungs (calendar, ax) and
      the browser reader that feeds the tab rung are all environmental — but
      it is always worth understanding before shipping.

- [ ] **`pnpm check:diarization` green** (AMI ES2004a DER <= 15%; spike baseline 11.7% with
      1.0s bridging). Build first: `cd packages/capture-agent && swift build -c release`,
      because the gate scores `.build/release/shyn-meeting`. Needs the AMI clip under
      `~/Library/Application Support/shyn-spike/ami` and the diarizer models in the gate's
      isolated home (it never touches the real shyn home; `SHYN_HOME` overrides). One-time
      download: `SHYN_HOME="$HOME/Library/Application Support/shyn-spike/home"
      packages/capture-agent/.build/release/shyn-meeting diarize <wav> --download`.
      Exit 0 = within the gate, 1 = DER over it, 2 = setup or tool failure. Manual gate,
      like the evals.

- [ ] **Entry-point changes get a live run, not just tests.** If a commit
      touches an agent's `Entry.swift` / `@main` or how its loops are started,
      run the debug binary against a temp `SHYN_HOME` with a fake daemon
      socket and watch the RPCs: one `captureStats` at start, then `ingest` +
      `captureStats` per tick (capture), or the equivalent for the meeting
      agent. Unit tests cannot see this: on 2026-09-21 all 171 passed while a
      `Task {}` created inside the main-actor run function inherited the actor
      and queued behind `NSApplication.run()` forever — one heartbeat, then
      silence. The installed previous binary under the same harness is the
      control.

## Notes

- Plan C shipped the packaging basics: `pnpm build:dist` (daemon bundle),
  `pnpm build:mcpb` (Claude Desktop extension), agent + status apps, local
  Homebrew formula, and `scripts/release.sh`. Still deferred to Plan D:
  Developer ID signing, notarization, a real tap / one-click installer.
  Until then a release is: tag a commit a user can `git clone` +
  `pnpm setup` from.
- `eval:hybrid` and `eval:latency` are deliberately kept out of CI (model
  download + multi-minute runtime + hardware variance) but are release
  gates, not optional. Do not tag on the strength of `eval:keyword` alone.
