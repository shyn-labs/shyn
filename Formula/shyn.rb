# LOCAL DRY-RUN ARTIFACT
#
# This formula snapshots a single local build of the daemon on one machine
# (darwin-arm64, 2026-07-02). The url and sha256 are specific to this dist/
# tarball, which is gitignored and not committed; rebuilds will produce
# different hashes. This is NOT a release artifact.
#
# The real release pipeline — versioning, distribution, and reproducible
# builds of this formula — is Task 8's responsibility. This formula exists
# only for local testing and dry-runs.
#
# INSTALLATION NOTE: `brew install --formula ./Formula/shyn.rb` is rejected
# on Homebrew ≥6 (HOMEBREW_FORBID_PACKAGES_FROM_PATHS). Workaround:
#
#   brew tap-new local/shyn
#   cp Formula/shyn.rb $(brew --repository local/shyn)/Formula/
#   brew install local/shyn/shyn
#   # ... (use and test) ...
#   brew untap local/shyn
#
# This is test-scaffolding, not production procedure. A real release (Task 8)
# will properly tap the formula and provide the standard install path.

class Shyn < Formula
  desc "Fully local ambient memory for every AI (unsigned dev build)"
  homepage "https://theshyn.com"
  url "file:///path/to/shyn/dist/shyn-daemon-v0.2.0-alpha-darwin-arm64.tar.gz"
  version "0.2.0-alpha"
  sha256 "3d6b5a1d5fcb40cfbff8a797155e82a21c9c84f1b8f1928b0aaa236b91a0c8d1"
  # WARNING — runtime-ABI coupling (2026-07-02 incident, docs/known-issues.md):
  # this generic `depends_on "node"` tracks whatever Node major homebrew-core
  # currently calls "node" (a rolling target). During the Task 9 local
  # dry-run, installing this formula silently bumped the machine's global
  # node 25.4.0 -> 26.4.0; the dist tarball's *prebuilt* native addons
  # (better-sqlite3-multiple-ciphers, node-llama-cpp, @reflink/reflink),
  # built against Node 25's ABI (NODE_MODULE_VERSION 141), then failed at
  # boot with ERR_DLOPEN_FAILED under Node 26 (needs 147) — and the same
  # upgrade ABI-broke the dev repo's own node_modules until a clean pnpm
  # reinstall + dist rebuild against node 26. The bundled natives and the
  # `node` this formula pulls in MUST agree on ABI; today that holds only
  # because both were (re)built on the same machine on the same day.
  # Homebrew only keeps versioned formulae for even/LTS majors (node@18/20/
  # 22/24), so pinning to an arbitrary odd major isn't reliably possible.
  # Plan D must either (a) rebuild the natives against a pinned LTS
  # `node@NN` at package time and depends_on that exact formula, referencing
  # `Formula["node@NN"].opt_bin/"node"` in the wrapper instead of ambient
  # `node`, or (b) vendor/carry a specific Node runtime inside the tarball
  # and not depend on brew's `node` at all.
  depends_on "node"

  def install
    # NOTE: the tarball's single top-level "daemon/" directory is stripped by
    # Homebrew's tar-unpack strategy, so buildpath already IS the daemon
    # contents (verified via ohai-debug: pwd was .../daemon, Dir["daemon/*"]
    # was always empty). Install everything in buildpath, not "daemon/*".
    libexec.install Dir["*"]
    (bin/"shynd").write <<~SH
      #!/bin/bash
      exec node "#{libexec}/daemon.mjs" "$@"
    SH
  end

  def caveats
    <<~EOS
      Unsigned dev build. Start the daemon: shynd (or use launchd via the repo CLI).
      The `shyn` CLI ships with the repo until Plan D packages it.
    EOS
  end
end
