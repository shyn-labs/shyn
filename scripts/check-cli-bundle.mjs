// Bundles the CLI exactly the way the release tarball will (Task 6) and
// fails if any native-module identifier leaks into the output — the same
// trap build-mcpb.mjs guards against for the MCP server. Run in CI-adjacent
// contexts freely: pure esbuild, no artifacts kept.
import { build } from "esbuild";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE = ["better-sqlite3-multiple-ciphers", "sqlite-vec", "node-llama-cpp"];
const out = join(mkdtempSync(join(tmpdir(), "shyn-cli-guard-")), "main.mjs");

await build({
  entryPoints: [join(ROOT, "packages/cli/src/main.ts")],
  bundle: true, platform: "node", target: "node22", format: "esm",
  outfile: out,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "silent",
});

const text = readFileSync(out, "utf8");
const leaked = NATIVE.filter((n) => text.includes(n));
rmSync(dirname(out), { recursive: true, force: true });
if (leaked.length) {
  console.error(`CLI bundle leaked native modules: ${leaked.join(", ")} — check for @shyn/engine barrel imports`);
  process.exit(1);
}
console.log("cli bundle: natives-free OK");
