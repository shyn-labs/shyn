#!/usr/bin/env bash
# Creates a STABLE self-signed code-signing identity ("Shyn Dev") in the login
# keychain. Signing every build with the same identity gives the capture agent a
# stable "designated requirement", so macOS TCC grants (Accessibility, Screen
# Recording) persist across rebuilds instead of resetting every time — WITHOUT a
# paid Apple Developer ID. (A Developer ID + notarization is only needed to
# distribute the signed app to *other* machines.)
#
# One-time, local, offline. Safe to re-run (no-ops if the identity exists).
# Then: SHYN_CODESIGN_IDENTITY="Shyn Dev" pnpm build-capture && shyn install
set -euo pipefail

CERT_NAME="Shyn Dev"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -c "$CERT_NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "✓ Signing identity '$CERT_NAME' already exists — nothing to do."
  exit 0
fi

echo "▶︎ Creating self-signed code-signing identity '$CERT_NAME'…"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/openssl.cnf" <<EOF
[ req ]
distinguished_name = dn
x509_extensions = v3
prompt = no
[ dn ]
CN = $CERT_NAME
[ v3 ]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/openssl.cnf" >/dev/null 2>&1

openssl pkcs12 -export -legacy -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -name "$CERT_NAME" -out "$TMP/identity.p12" -passout pass:shyn >/dev/null 2>&1 || \
openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -name "$CERT_NAME" -out "$TMP/identity.p12" -passout pass:shyn >/dev/null 2>&1

# -A: allow codesign to use the key without a per-use prompt (local dev cert).
security import "$TMP/identity.p12" -k "$KEYCHAIN" -P shyn -A -T /usr/bin/codesign >/dev/null 2>&1

# Authorize the key's partition list so codesign can use it non-interactively.
# Without this, codesign blocks on a GUI keychain dialog every build (which a
# headless/background build can't answer). Prompts once for your login-keychain
# password. (Same step Macda ships separately in its README.)
echo "▶︎ Authorizing codesign to use the key (enter your login/keychain password if prompted)…"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s "$KEYCHAIN" >/dev/null 2>&1 || \
  echo "  (partition-list step needs your password — if it didn't prompt, run it manually; see below)"

echo "✓ Created '$CERT_NAME'. Build signed: SHYN_CODESIGN_IDENTITY=\"$CERT_NAME\" pnpm build-capture"
