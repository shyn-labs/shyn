<a href="https://shyn.day"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://shyn.day/assets/logo-dark.svg">
  <img src="https://shyn.day/assets/logo.svg" alt="shyn" width="280">
</picture></a>

# shyn — your Mac's memory, on tap ☀️

**[shyn.day](https://shyn.day)** · macOS (Apple Silicon) · pre-alpha · [Elastic License 2.0](LICENSE)

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
  the moment the transcript lands — text in, bytes gone. Grant Calendar
  access and transcripts get titled from the event they belong to
  ("Sprint standup", attendees included) — read from your Mac's own
  calendar store, no Google API, nothing leaves the machine.
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

### Other clients, including fully local models

Shyn is a standard stdio MCP server — any MCP client works, and your memory
never has to touch a paid API at all. Tested so far:

- **Claude Code / Claude Desktop** — daily drivers, best-in-class at knowing
  *when* to reach into memory unprompted.
- **Qwen3 14B running locally** (MLX on Apple Silicon) via Open WebUI, with
  [mcpo](https://github.com/open-webui/mcpo) bridging MCP to OpenAPI:

  ```bash
  uvx mcpo --port 8600 -- "$HOME/Library/Application Support/shyn/bin/shyn-mcp"
  # then add http://localhost:8600 as a tool server in Open WebUI
  ```

Honest notes from testing: retrieval quality is identical everywhere — the
ranking runs inside the daemon, not the model. What varies is the driver.
Smaller local models answer well when you're explicit ("search my memory
for…") but are less reliable at deciding to search on their own, and
thinking-mode models may need their reasoning reined in (`/no_think` for
Qwen3). Budget ~10GB of unified memory for a 14B model alongside the daemon.

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
  byte-purged on ingest. Transcription defaults to Whisper `small`; at that
  size Hindi/Hinglish and other non-English speech often lands as an English
  gist (documented, not hidden). For markedly better multilingual
  transcripts, click **Multilingual** under "Meeting language" in the menu
  bar popover (a ~3GB one-time download that starts immediately; the
  popover says plainly which model your next meeting will use). Same
  switch by hand: `"meeting": { "whisperModel": "large-v3" }` in
  `~/Library/Application Support/shyn/capture.json`; `medium` is the
  middle ground. Config hot-reloads, no restart.
- **Meeting titles are optional and layered**: the calendar event first
  (needs Calendar access), the call window's title second (needs
  Accessibility), plain "app · date" otherwise. Decline everything and
  meetings still transcribe fine.
- **The menu bar app checks GitHub once a day for a newer release** — a
  plain unauthenticated request for the latest version number; nothing
  about you or your machine rides along. Turn it off with
  `"updateCheck": false` in capture.json. The capture agents and the
  daemon make no network requests, ever.
- **Sources that need permissions report themselves unavailable with a
  plain-language reason** instead of silently capturing nothing.
- The eval harness (`pnpm eval:keyword`, `eval:hybrid`) runs a synthetic
  corpus against pre-committed pass/fail bars for CI. It is not a benchmark
  and its numbers are not an accuracy claim.
- Accepted gaps and sharp edges live in [`docs/known-issues.md`](docs/known-issues.md) —
  honesty is a feature.

## What shyn never does

- **Phones home.** No telemetry, no analytics endpoint, no crash reporter.
  There is no server to send anything to. The one outbound request in the
  whole system is the menu bar app's daily version check against GitHub
  (see the fine print) — it carries nothing and turns off with one config
  key.
- **Stores what you searched for.** Usage stats are counts in your local
  database (searches per day as a number — never the query).
- **Ships your content anywhere.** When something breaks, run `shyn diagnose`:
  it prints a copy-pasteable block of versions, service states, and
  error-log lines — zero document content — and *you* choose where to
  paste it.

## License

[Elastic License 2.0](LICENSE) (source-available).

In plain words: use it, read it, modify it, share it — personally or at
work, for free. What you may not do is sell shyn or offer it to others as
a commercial or managed service; that right stays with the project. The
full text is one page and worth reading.
