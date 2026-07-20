<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://shyn.day/assets/logo-dark.svg">
  <img src="https://shyn.day/assets/logo.svg" alt="shyn" width="280">
</picture>

# shyn — your Mac's memory, on tap ☀️

**Shyn is the always-on memory companion for your Mac.** It quietly
remembers what you see, hear, and read — your screen, your meetings, your
browsing, your notes — and gives your AI assistant total recall over *your*
life. Ask Claude "what did we decide in yesterday's standup?" or "where did
I read about that retention bug?" and get an answer grounded in your own
history, not the internet's.

**100% local. Zero cloud. Private by design.** Everything shyn captures
lives in an encrypted database on your Mac. Nothing is uploaded, synced, or
phoned home — the only bytes that ever leave your machine are the few
snippets relevant to a question *you* chose to ask, sent to the AI *you*
chose to ask it.

> **Status: pre-alpha.** Shyn is young, moving fast, and macOS-only
> (Apple Silicon). Expect rough edges and breaking changes. Install is a
> two-command Homebrew cask (`brew install` + `shyn setup`) — the apps are
> self-signed and re-signed locally by `shyn setup`, not Apple-notarized;
> notarized one-click installs are on the roadmap.

## Why shyn

- 🧠 **Total recall, instantly.** Hybrid search — keyword (FTS5/BM25) +
  semantic (on-device embeddings) — across everything you've captured, in
  milliseconds, over a local socket.
- 👁️ **Ambient screen memory.** A featherweight agent captures the text on
  your screen as you work — what you read, wrote, and clicked becomes
  searchable history.
- 🎙️ **Meetings, remembered.** Shyn detects your calls, records both sides
  locally, transcribes on-device with Whisper, and files a speaker-labeled
  transcript into your memory. Audio never crosses a socket and is purged
  the moment the transcript lands — text in, bytes gone.
- 🌐 **Your digital trail, connected.** Chrome and Safari history and Apple
  Notes flow in automatically; files and PDFs on demand.
- ☀️ **Glanceable peace of mind.** A frosted-glass menu bar companion shows
  everything is running — one sun in your menu bar, four live states, a
  pulsing red dot whenever a meeting is being recorded. Never silent,
  never sneaky.
- 🔒 **Consent-first capture.** Recording announces itself and is
  cancellable in its grace window. Pause everything with one click or
  `shyn pause 30m`. Exclude apps. Delete anything — `forget` is
  byte-honest: vacuumed, gone, not soft-deleted.
- ⚡ **Instant-on by design.** Keyword search works from second zero; the
  embedding model downloads in the background and results silently upgrade
  to hybrid. The model is never on the critical path.

## How it works

A background daemon owns an encrypted SQLite index (key in your macOS
Keychain) and serves JSON-RPC over a unix socket. Capture agents — screen,
meetings — and source readers — Chrome, Safari, Apple Notes — feed it.
Your AI talks to it through five MCP tools. That's the whole trick: one
private index, many memories, any MCP-speaking assistant.

| Tool | What your AI gets |
|---|---|
| `search_memory(query, …)` | Hybrid search with provenance — the workhorse |
| `recent_activity(hours?, …)` | Orientation timeline; great first call on vague questions |
| `remember(content, tags?)` | Explicit "write this down" memory |
| `forget(doc_id \| source \| time-range, confirm)` | Honest deletion; refuses without `confirm: true` |
| `memory_status()` | Health, index counts, model download %, connected sources |

## Quickstart

### Install with Homebrew (recommended)

```bash
brew install --cask shyn-labs/tap/shyn
shyn setup
```

Two commands: the cask verifies the download against its pinned checksum,
and `shyn setup` starts everything and walks you through permissions via
the ☀️ menu bar window. No Node, no Xcode, no cloning. Read the cask's
caveats — they're the honest fine print (local signing, quarantine, EDR).
Update later with `brew upgrade shyn && shyn setup`.

### Or build from source (for contributors)

```bash
pnpm install

# start the daemon (first run downloads the embedding model in the
# background; search works before that finishes)
pnpm --filter @shyn/daemon start
```

Register the MCP server with Claude Code:

```bash
claude mcp add shyn -- pnpm --dir <path-to-shyn-repo> --filter @shyn/mcp-client exec tsx src/main.ts
```

Substitute `<path-to-shyn-repo>` with the absolute path where you cloned
this repo (e.g. the output of `pwd` run from inside it).

Feed it something and ask Claude about it:

```bash
pnpm shyn ingest /absolute/path/to/some/folder
```

Use an absolute path: it's stored as the document's `uri`. Ingest accepts a
single file (`.md`, `.txt`, `.pdf`) or a directory to walk. Pull in browser
history and Apple Notes any time with `pnpm shyn sync`.

### Go full companion (daemon + agents + menu bar) — one command

```bash
pnpm setup
```

That's it: installs dependencies, creates a stable local signing identity,
builds the daemon bundle + capture agents + status app, and starts
everything under launchd. Idempotent — re-run it after every `git pull`.

Under the hood it stages and starts everything — daemon, screen agent,
meeting agent, and the menu bar status app — surviving reboots, logging to
`~/Library/Logs/shyn/`. Grant the permissions macOS asks for (Microphone +
System Audio for meetings; Screen Recording + Accessibility for screen
capture; Full Disk Access only if you want Safari/Notes — everything else
works without it, no dark patterns, no nagging).

```bash
pnpm shyn uninstall           # stop + remove, keep data
pnpm shyn uninstall --purge   # scorched earth: data, logs, keys
```

### Claude Desktop

`pnpm build:mcpb` produces `dist/shyn.mcpb` — drag it onto Claude Desktop's
Settings → Extensions page. (Registers the MCP client; the daemon must be
running via `install` above.)

## Everyday controls

```bash
pnpm shyn status                    # daemon + agents + index health
pnpm shyn search "that one thing"   # search from the terminal
pnpm shyn pause 30m                 # pause all capture (2h, until-tomorrow too); resume to undo
pnpm shyn exclude com.1password.1password   # never capture an app
pnpm shyn meeting status                    # live meeting controls (stop | cancel too)
```

…or skip the terminal entirely and click the ☀️ in your menu bar.

## The fine print (we sweat it so you don't)

- **Encryption at rest** protects against stolen disks and leaked backups —
  not against malware running as your own user. We say this out loud.
- **Meetings**: channel-based speaker labels (`Me:` / `Others:`), 10-second
  cancellable grace before any recording, 180-minute hard cap, temp audio
  byte-purged on ingest. Hindi/Hinglish speech currently lands as an
  English gist (Whisper behavior — documented, not hidden).
- **Sources that need permissions report themselves unavailable with a
  plain-language reason** instead of silently capturing nothing.
- The eval harness (`pnpm eval:keyword`, `eval:hybrid`) runs a synthetic
  corpus against pre-committed pass/fail bars for CI. It is not a benchmark
  and its numbers are not an accuracy claim.
- Accepted gaps and sharp edges live in [`docs/known-issues.md`](docs/known-issues.md) —
  honesty is a feature.

## What shyn never does

- **Phones home.** No telemetry, no analytics endpoint, no crash reporter.
  There is no server to send anything to.
- **Stores what you searched for.** Usage stats are counts in your local
  database (searches per day as a number — never the query).
- **Ships your content anywhere.** When something breaks, run `shyn diagnose`:
  it prints a copy-pasteable block of versions, service states, and
  error-log lines — zero document content — and *you* choose where to
  paste it.

## License

Apache-2.0. See `LICENSE`.
