import { defineConfig } from "vitest/config";

// Root vitest config exists for ONE reason: keep test discovery out of
// `.worktrees/`.
//
// `pnpm test:e2e` runs `vitest run test/e2e.test.ts`, and vitest resolves
// that as a glob — so a git worktree checked out under `.worktrees/` gets
// its copy of the same file collected too. Caught cutting 0.5.0-alpha: the
// release gate failed on `.worktrees/ios-sync-mac/test/e2e.test.ts`
// asserting the daemon reports the version in ITS package.json, which was
// pinned to the previous release.
//
// The failure was loud that time, which was luck. The same glob would just
// as happily run a STALE PASSING copy of a suite and report the release
// green on code that is not being shipped.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", ".worktrees/**", "**/.build/**"],
  },
});
