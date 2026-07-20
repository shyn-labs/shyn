#!/usr/bin/env bash
# One-command companion setup: deps → signing identity → build daemon bundle,
# capture/meeting agents, and menu bar status app → install everything under
# launchd. Idempotent — safe to re-run after pulling updates (it re-stages
# and restarts the services).
set -euo pipefail
cd "$(dirname "$0")/.."

command -v pnpm >/dev/null || { echo "pnpm not found — install Node >= 22 and pnpm 9 first"; exit 1; }
command -v swift >/dev/null || { echo "swift not found — install Xcode command line tools first"; exit 1; }

echo "▶︎ installing dependencies…"
pnpm install

echo "▶︎ ensuring local signing identity (keeps macOS permission grants stable)…"
bash scripts/setup-signing.sh

export SHYN_CODESIGN_IDENTITY="${SHYN_CODESIGN_IDENTITY:-Shyn Dev}"
echo "▶︎ building daemon bundle, capture agents, and status app…"
pnpm build:dist
pnpm build-capture
pnpm build:status

echo "▶︎ installing launchd services (daemon + screen + meeting + status)…"
node --import tsx packages/cli/src/main.ts install

cat <<'EOF'

✓ shyn is running. Next steps:

  1. Grant permissions when macOS asks (System Settings → Privacy & Security):
     · Microphone + Screen & System Audio Recording → meeting transcription
     · Screen Recording + Accessibility → screen capture
     · Full Disk Access (optional) → Safari history + Apple Notes
  2. Look for the ☀️ in your menu bar — click it to see everything's healthy.
  3. Connect your AI:
     claude mcp add shyn -- pnpm --dir "$(pwd)" --filter @shyn/mcp-client exec tsx src/main.ts

  Everyday: pnpm shyn status | search "…" | pause 30m | resume | meeting status
EOF
