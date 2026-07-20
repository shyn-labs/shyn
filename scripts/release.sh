#!/usr/bin/env bash
set -euo pipefail

V="${1:?usage: release.sh <version, e.g. 0.2.0-alpha> [--no-publish]}"
NO_PUBLISH=0
if [[ "${2:-}" == "--no-publish" ]]; then
  NO_PUBLISH=1
fi

cd "$(dirname "$0")/.."

echo "== tag-target safety checks =="
# A dirty tree or an unpushed HEAD would let `gh release create` tag a commit
# that isn't the one actually reviewed/built here — e.g. the v0.2.0-alpha
# release incident, which tagged a pre-Plan-C base because HEAD had moved on
# without anyone re-running release.sh. Both checks must pass before we let
# gh anywhere near tag creation.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "release.sh: working tree is not clean — commit or stash before releasing" >&2
  exit 1
fi
if ! upstream=$(git rev-parse '@{u}' 2>/dev/null); then
  echo "release.sh: current branch has no upstream — push it first" >&2
  exit 1
fi
if [[ "$(git rev-parse HEAD)" != "$upstream" ]]; then
  echo "release.sh: HEAD is not pushed to its upstream — push before releasing" >&2
  exit 1
fi

echo "== gates =="
pnpm typecheck && pnpm -r test && pnpm eval:keyword
SHYN_SKIP_MODEL_DOWNLOAD=1 pnpm test:e2e
echo "NOTE: eval:hybrid and eval:latency are manual release gates — run them before a REAL release (RELEASING.md)."

echo "== artifacts =="
pnpm build:dist
SHYN_CODESIGN_IDENTITY="${SHYN_CODESIGN_IDENTITY:-Shyn Dev}" pnpm build-capture
SHYN_CODESIGN_IDENTITY="${SHYN_CODESIGN_IDENTITY:-Shyn Dev}" pnpm build:status
pnpm build:mcpb
pnpm build:release

TARBALL=$(ls dist/release/shyn-v*-darwin-arm64.tar.gz)
[[ "$TARBALL" == *"shyn-v${V}-darwin-arm64"* ]] || { echo "version mismatch: arg v${V} vs built $(basename "$TARBALL") — bump package versions first"; exit 1; }
SHA256="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
echo "$SHA256  $TARBALL"

# The tap repo slug lives HERE and only here (spec: one-string org migration).
SHYN_TAP_REPO="${SHYN_TAP_REPO:-shyn-labs/homebrew-tap}"

# Render the cask from the in-repo template.
CASK=$(mktemp)
sed -e "s/@VERSION@/${V}/" -e "s/@SHA256@/${SHA256}/" -e "s|@TAP_REPO@|${SHYN_TAP_REPO}|" \
  packaging/tap/Casks/shyn.rb > "$CASK"

if [[ "$NO_PUBLISH" -eq 1 ]]; then
  echo "== publish (skipped: --no-publish) =="
  echo "Would: gh release create v${V} on ${SHYN_TAP_REPO} with $TARBALL + dist/shyn.mcpb"
  echo "Would: commit rendered Casks/shyn.rb to ${SHYN_TAP_REPO}"
  echo "Rendered cask at: $CASK"
  exit 0
fi

echo "== publish to ${SHYN_TAP_REPO} =="

# Update the cask in the tap BEFORE creating the release: on a brand-new tap
# repo (Task 9 creates it empty), `gh release create` 422s with no commits
# to tag, but this contents-API PUT creates the repo's first commit itself.
# The cask render only needs $V + the tarball's sha256, both already known.
ENC=$(base64 < "$CASK")
SHA_OLD=$(gh api "repos/${SHYN_TAP_REPO}/contents/Casks/shyn.rb" --jq .sha 2>/dev/null || true)
if [[ -n "$SHA_OLD" ]]; then
  gh api -X PUT "repos/${SHYN_TAP_REPO}/contents/Casks/shyn.rb" \
    -f message="shyn v${V}" -f content="$ENC" -f sha="$SHA_OLD" >/dev/null
else
  gh api -X PUT "repos/${SHYN_TAP_REPO}/contents/Casks/shyn.rb" \
    -f message="shyn v${V}" -f content="$ENC" >/dev/null
fi

gh release create "v${V}" --repo "$SHYN_TAP_REPO" --prerelease --title "shyn v${V}" \
  --notes "Pre-alpha dev build for Apple Silicon. Install: brew install --cask ${SHYN_TAP_REPO%%/*}/tap/shyn && shyn setup" \
  "$TARBALL" "dist/shyn.mcpb"

echo "== done: brew install --cask ${SHYN_TAP_REPO%%/*}/tap/shyn =="
