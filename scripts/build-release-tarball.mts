// Assembles the self-contained release tarball from an already-built dist/
// tree: dist/daemon (Task 2, vendored node included), dist/capture/*.app,
// dist/status/*.app, plus natives-free CLI + MCP bundles. This script does
// NOT build those pieces — it fails loudly if any input is missing.
//
// Payload layout mirrors dist/ so installDaemon/installCaptureAgent/
// installMeetingAgent/installStatusApp run with repoRoot = payloadRoot,
// unmodified (spec amendment recorded in Task 1 / Task 4).
import { execFileSync } from "node:child_process";
import {
  cpSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync, readdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!ROOT.endsWith("/shyn")) throw new Error(`Refusing: resolved root is not the shyn project: ${ROOT}`);

const version = JSON.parse(readFileSync(join(ROOT, "packages/daemon/package.json"), "utf8")).version;
const STAGE = join(ROOT, "dist/release/.stage/shyn");
const OUT = join(ROOT, `dist/release/shyn-v${version}-darwin-arm64.tar.gz`);
rmSync(join(ROOT, "dist/release"), { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// Every input must already exist — this script assembles, it does not build.
const need = [
  "dist/daemon/daemon.mjs", "dist/daemon/bin/shynd",
  "dist/capture/shyn-capture.app/Contents/MacOS/shyn-capture",
  "dist/capture/shyn-meeting.app/Contents/MacOS/shyn-meeting",
  "dist/status/shyn-status.app/Contents/MacOS/shyn-status",
];
for (const f of need) if (!existsSync(join(ROOT, f)))
  throw new Error(`missing input ${f} — run pnpm build:dist && pnpm build-capture && pnpm build:status first`);

// payload carries a real dist/ (spec amendment, Task 1 / Task 4 fix)
cpSync(join(ROOT, "dist/daemon"), join(STAGE, "dist/daemon"), { recursive: true, verbatimSymlinks: true });
cpSync(join(ROOT, "dist/capture"), join(STAGE, "dist/capture"), { recursive: true, verbatimSymlinks: true });
cpSync(join(ROOT, "dist/status"), join(STAGE, "dist/status"), { recursive: true, verbatimSymlinks: true });

// CLI + MCP bundles (natives-free; the CLI guard proves the invariant in CI-adjacent runs)
const banner = { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" };
mkdirSync(join(STAGE, "cli"), { recursive: true });
await build({ entryPoints: [join(ROOT, "packages/cli/src/main.ts")], bundle: true, platform: "node",
  target: "node22", format: "esm", outfile: join(STAGE, "cli/main.mjs"), banner, logLevel: "silent" });
mkdirSync(join(STAGE, "mcp"), { recursive: true });
await build({ entryPoints: [join(ROOT, "packages/mcp-client/src/main.ts")], bundle: true, platform: "node",
  target: "node22", format: "esm", outfile: join(STAGE, "mcp/index.mjs"), banner, logLevel: "silent" });
for (const f of ["cli/main.mjs", "mcp/index.mjs"]) {
  const text = readFileSync(join(STAGE, f), "utf8");
  for (const n of ["better-sqlite3-multiple-ciphers", "sqlite-vec", "node-llama-cpp"])
    if (text.includes(n)) throw new Error(`packaging regression: ${f} contains native module ${n}`);
}

// packaging guard: no natives inside the .apps (mirrors build-status-app.mts)
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".node") ? [join(d, e.name)] : []);
for (const appDir of ["dist/capture", "dist/status"])
  for (const found of walk(join(STAGE, appDir)))
    throw new Error(`packaging regression: native module inside app payload: ${found}`);

// shims + signing script
mkdirSync(join(STAGE, "bin"), { recursive: true });
writeFileSync(join(STAGE, "bin/shyn"), `#!/bin/sh
# shyn CLI shim — self-contained: uses the payload's vendored node.
# Resolve symlinks to this script first (brew's binary stanza links it into
# PATH), so DIR is the real payload root, not the symlink's directory.
SELF="$0"
while [ -L "$SELF" ]; do
  LINK="$(readlink "$SELF")"
  case "$LINK" in /*) SELF="$LINK" ;; *) SELF="$(dirname "$SELF")/$LINK" ;; esac
done
DIR="$(cd "$(dirname "$SELF")/.." && pwd -P)"
export SHYN_PAYLOAD="$DIR"
exec "$DIR/dist/daemon/bin/shynd" "$DIR/cli/main.mjs" "$@"
`);
chmodSync(join(STAGE, "bin/shyn"), 0o755);
mkdirSync(join(STAGE, "setup"), { recursive: true });
cpSync(join(ROOT, "scripts/setup-signing.sh"), join(STAGE, "setup/setup-signing.sh"));

execFileSync("tar", ["-czf", OUT, "-C", join(ROOT, "dist/release/.stage"), "shyn"]);
rmSync(join(ROOT, "dist/release/.stage"), { recursive: true, force: true });
const sha = execFileSync("shasum", ["-a", "256", OUT]).toString().split(/\s+/)[0];
console.log(`release tarball: ${OUT}`);
console.log(`sha256: ${sha}`);
