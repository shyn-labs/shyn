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
- [ ] **Live meeting sanity.** Since v0.2.0 the meeting agent's detection is
      voice-verified (pre-roll commit gate); before tagging, confirm the
      most recent real meeting auto-ended and produced a transcript
      (`pnpm shyn meeting status`, `pnpm shyn search "<something said>"`).

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
