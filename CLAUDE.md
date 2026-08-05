# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Shyn is a local-first memory layer for MCP-speaking AI assistants (Claude Code, Claude Desktop). A background daemon indexes content (files, browser history, Apple Notes, screen capture) into an encrypted SQLite database on macOS, serving hybrid keyword (FTS5/BM25) + semantic (embedding) search over a unix socket. macOS-only; requires an M-series Mac for the full stack.

## Commands

```bash
pnpm install                       # Node >= 22, pnpm 9

pnpm typecheck                     # tsc --noEmit across all packages
pnpm -r test                       # vitest per package
pnpm --filter @shyn/engine test    # one package
pnpm --filter @shyn/engine exec vitest run test/search.test.ts   # one file
pnpm test:e2e                      # spawns a real daemon subprocess (test/e2e.test.ts)
                                   # set SHYN_SKIP_MODEL_DOWNLOAD=1 to avoid the ~640MB model fetch

# Swift capture agent (separate toolchain, not run by pnpm test)
cd packages/capture-agent && swift test

# Evals — synthetic corpus with pre-committed pass/fail bars, NOT accuracy benchmarks
pnpm eval:keyword                  # cheap, runs in CI, bar 0.6
pnpm eval:hybrid                   # needs real model downloaded; bar 0.8 recall@5; local only
pnpm eval:latency                  # multi-minute, M-series only; p95 < 500ms; local only

# Run the daemon in the foreground
pnpm --filter @shyn/daemon start

# Build artifacts
pnpm build:dist                    # self-contained daemon bundle (scripts/build-dist.mjs)
pnpm build:mcpb                    # Claude Desktop extension → dist/shyn.mcpb
pnpm build-capture                 # Swift capture agent .app

# Release (see RELEASING.md for the full checklist)
scripts/release.sh <version> [--no-publish]
```

There is no build step for development: package `bin` entries point at `src/main.ts` and everything runs via `tsx`. TypeScript is strict, `module: NodeNext` — intra-package imports need explicit `.js` extensions.

## Architecture

pnpm monorepo with a strict dependency direction: `engine` ← `daemon` ← (`cli`, `mcp-client`).

- **`packages/engine`** — the core library, everything stateful lives here. `Engine` (src/engine.ts) wraps an encrypted SQLite DB (`better-sqlite3-multiple-ciphers`, key from macOS Keychain via `KeyProvider`) with `sqlite-vec` for vectors and FTS5 for keyword search. Ingestion chunks documents and enqueues embedding work; `drainEmbedQueue` backfills vectors asynchronously using `node-llama-cpp`. `src/readers/` holds source readers (Chrome, Safari, Apple Notes) that implement the `Reader` interface with an `available()` health check and watermark-based incremental sync (default 90-day backfill). Public API is the barrel in `src/index.ts`; `@shyn/engine/paths` is a deliberate natives-free subpath export.
- **`packages/daemon`** — long-running process owning one `Engine`. `server.ts` is a JSON-RPC-over-unix-socket server (`~/.shyn/shyn.sock`, mode 0600) with handlers for ingest/search/recent/forget/sync/status/captureStats. It schedules embed-queue drains, periodic reader sweeps, and screen-capture retention sweeps.
- **`packages/mcp-client`** — thin stdio MCP server exposing the five tools (`search_memory`, `recent_activity`, `remember`, `forget`, `memory_status`) by forwarding to the daemon socket. **Must stay pure JS** — it gets bundled into the `.mcpb` extension by esbuild, and pulling in the engine barrel drags in native modules and breaks the build (see the comment in `src/main.ts` before adding imports).
- **`packages/cli`** — `shyn` command: `ingest` (files/PDFs), `sync`, `install`/`uninstall` (launchd plist management in `launchd.ts`).
- **`packages/capture-agent`** — Swift 6 SPM package (macOS 14+), separate from the pnpm workspace. `CaptureCore` is the testable pipeline (gating, normalization, dedup ring buffer); `shyn-capture` is the executable doing AX reading / OCR and posting to the daemon socket.
- **`extension/`** — `.mcpb` manifest + bundled server. **`test/e2e.test.ts`** — end-to-end suite against a real daemon subprocess; closest thing to a smoke test of the shipped artifact.

Key design invariant — the **degraded ladder**: keyword search must work from second zero with no model; the embedding model downloads in the background, vectors backfill via the embed queue, and every search response carries `mode: "hybrid" | "keyword-only"`. Don't put the model on the critical path of anything.

Sources that need macOS permissions (Safari history, Notes → Full Disk Access) must report themselves unavailable with a plain-language `reason` rather than silently producing nothing.

## Development workflow

- Design docs live in `docs/superpowers/specs/`, implementation plans in `docs/superpowers/plans/` (dated files). Work is organized in plan phases (Plan A core, screen capture, meeting transcription, …); branches are named `sp<N>-<feature>`. Read the current branch's spec + plan before implementing.
- `docs/known-issues.md` records accepted gaps judged non-blocking — check it before "fixing" something that may be a recorded decision, and add to it when deferring instead of fixing.
- `spikes/` holds throwaway probe code; it is not production code and not under test.
- CI (`.github/workflows/ci.yml`, macos-14): typecheck, `pnpm -r test`, e2e (with `SHYN_SKIP_MODEL_DOWNLOAD=1`), `eval:keyword`. `eval:hybrid` and `eval:latency` run only locally before a release; their bars are pre-committed — if one fails, fix the code or hold the release, never raise the bar.
- Published packages (`engine`, `daemon`, `cli`, `mcp-client`) version in lockstep — exactly one client/daemon version pair is in play at a time.

### Identity hygiene (this repo is public)

Everything here ships under the project identity, not a personal one. Commits
are authored as `shynbot <hello@shyn.day>`; **never** `git add -A` (it sweeps up
local scratch), and never commit as anyone else.

Test fixtures, sample data, and code comments use placeholders — `Acme`,
`Globex`, `Sam`, `example.com`. Never a real person, employer, customer,
domain, meeting title, or file path from the machine you happen to be on. This
matters most for capture-agent work, where the natural move is to paste in
whatever the agent just recorded: that is exactly how a real company name
reached a public commit once (scrubbed 2026-08-05).

`scripts/check-identity-leak.mjs` enforces it — wired as a pre-commit and
commit-msg hook via `git config core.hooksPath .githooks`, and again in CI. It
reads a private denylist from `~/.config/shyn/leak-denylist.txt` (deliberately
not in the repo). If it fires, rename the fixture; do not weaken the guard.

---

## Workflow Orchestration

### 1. Plan Mode Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately — don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes — don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests — then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

## Task Management

1. **Plan First**: Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to `tasks/todo.md`
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.
