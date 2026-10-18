#!/usr/bin/env -S -u SHELLOPTS -u BASHOPTS -u PS4 -u BASH_ENV -u ENV bash
# Inherited SHELLOPTS (e.g. xtrace), BASHOPTS or PS4 run code before any line here can refuse them (PS4 is
# expanded, command substitutions included, for every traced command). Run as an executable (scripts/release.sh),
# the shebang strips them before bash starts. Run as `bash scripts/release.sh`, bash 3.2 traces line 1 (set +x)
# itself, expanding an inherited PS4 once before xtrace is off; the check below then refuses. BASH_ENV is
# sourced by bash before line 1, so the shebang strips it (and ENV) too; the BASH_ENV refusal below covers `bash`.
set +x
PS4='+ '
if /usr/bin/env | /usr/bin/grep -qE '^(SHELLOPTS|BASHOPTS|PS4)='; then
  echo "release.sh: SHELLOPTS, BASHOPTS or PS4 is set in the environment; they can run code in this script; unset them" >&2; exit 1
fi
set -euo pipefail

V="${1:?usage: release.sh <version, e.g. 0.2.0-alpha> [--no-publish]}"
NO_PUBLISH=0
if [[ "${2:-}" == "--no-publish" ]]; then
  NO_PUBLISH=1
fi

# Environment that could weaken the leak gate or replace the commands that decide a release is refused before
# anything runs, so this block comes before any command a function could replace (names only, never values). node itself stays PATH-resolved: the whole build uses the same node.
if [[ -n "${BASH_ENV+set}${ENV+set}" || -n "$(/usr/bin/env | /usr/bin/grep '^BASH_FUNC_' || true)" ]]; then
  echo "release.sh: BASH_ENV, ENV or an exported shell function is set; they can replace the commands that decide the release; unset them" >&2; exit 1
fi
if [[ -n "${NODE_OPTIONS+set}" ]]; then
  echo "release.sh: NODE_OPTIONS is set; it can load code into the build and the leak gate; unset it" >&2; exit 1
fi
for var in SHYN_LEAK_DENYLIST SHYN_ARTIFACT_ALLOW; do
  if [[ -n "${!var+set}" ]]; then
    echo "release.sh: $var is set: a release is gated with the owner's default denylist and allowlist only; unset it" >&2; exit 1
  fi
done
REAL_HOME="$(/usr/bin/dscl . -read "/Users/$(/usr/bin/id -un)" NFSHomeDirectory 2>/dev/null | /usr/bin/sed -n 's/^NFSHomeDirectory: //p')"
if [[ "${HOME-}" == /Users/runner || -z "$REAL_HOME" || "${HOME-}" != "$REAL_HOME" ]]; then
  echo "release.sh: HOME is not this user's home dir (the gate reads its denylist, allowlist and home needle from it); release from the owner's machine with the real HOME" >&2; exit 1
fi
ALLOWED=("Shyn Dev")
if [[ -n "${SHYN_ALLOWED_AUTHORITIES+set}" ]]; then
  if [[ -z "${SHYN_ALLOWED_AUTHORITIES//[[:space:],]/}" ]]; then
    echo "release.sh: SHYN_ALLOWED_AUTHORITIES is set but has no entries; unset it or list identities" >&2; exit 1
  fi
  ALLOWED=()
  IFS=',' read -r -a _parts <<< "$SHYN_ALLOWED_AUTHORITIES"
  for p in "${_parts[@]}"; do p="${p#"${p%%[![:space:]]*}"}"; p="${p%"${p##*[![:space:]]}"}"; [[ -n "$p" ]] && ALLOWED+=("$p"); done
  if [[ ${#ALLOWED[@]} -eq 0 ]]; then
    echo "release.sh: SHYN_ALLOWED_AUTHORITIES is set but has no entries; unset it or list identities" >&2; exit 1
  fi
  echo "NOTICE: signing authorities set by SHYN_ALLOWED_AUTHORITIES (${#ALLOWED[@]} entries)"
fi
IDENT="${SHYN_CODESIGN_IDENTITY:-Shyn Dev}"
ok=0; for a in "${ALLOWED[@]}"; do [[ "$a" == "$IDENT" ]] && ok=1; done
if [[ $ok -ne 1 ]]; then
  echo "release.sh: the signing identity from SHYN_CODESIGN_IDENTITY is not in SHYN_ALLOWED_AUTHORITIES (unset means \"Shyn Dev\"); refusing before building" >&2; exit 1
fi

CDPATH= cd -- "$(/usr/bin/dirname -- "$0")/.."

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
# Scan what actually ships (extracted tarball + .mcpb) for the builder's identity and the private denylist, before anything can be published (dry runs too).
/usr/bin/env -u SHYN_CODESIGN -u SHYN_LIPO -u SHYN_GATE_USERNAME -u SHYN_GATE_TEST_DELAY_MS \
  node scripts/check-artifact-leaks.mjs --release --tarball "$TARBALL" --mcpb dist/shyn.mcpb \
  || { echo "release.sh: artifact leak scan failed: not publishing" >&2; exit 1; }
SHA256="$(/usr/bin/shasum -a 256 "$TARBALL" | /usr/bin/awk '{print $1}')"
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
