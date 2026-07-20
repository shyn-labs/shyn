// Plan C Task 6: bundle the MCP client into a Claude Desktop `.mcpb`
// extension. Deviations from the task-6-brief.md sketch, and why:
//
//  1. format: "esm" + outfile server/index.mjs (not "cjs" + index.js) —
//     packages/mcp-client/src/main.ts has a top-level `await
//     server.connect(...)`, which esbuild's cjs output format rejects
//     outright ("Top-level await is currently not supported with the 'cjs'
//     output format"). Same issue, same fix, as scripts/build-dist.mjs's
//     Kink 1 for the daemon bundle — see docs/dist-bundle.md. The
//     manifest's entry_point/mcp_config.args are updated to match
//     (server/index.mjs instead of server/index.js).
//  2. No native deps to carry alongside: @modelcontextprotocol/sdk and zod
//     are pure JS, so — unlike the daemon bundle — nothing needs to be
//     esbuild `external` and there's no node_modules/ to copy into
//     extension/. The whole server is the single bundled .mjs file.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXTENSION = join(ROOT, "extension");
const SERVER_DIR = join(EXTENSION, "server");

console.log("[1/2] bundling packages/mcp-client/src/main.ts -> extension/server/index.mjs");
rmSync(SERVER_DIR, { recursive: true, force: true });
mkdirSync(SERVER_DIR, { recursive: true });
await build({
  entryPoints: [join(ROOT, "packages/mcp-client/src/main.ts")],
  bundle: true,
  platform: "node",
  target: "node22", // matches the repo's engines.node >=22 (and build-dist.mjs's daemon bundle)
  format: "esm", // top-level await in main.ts rules out format: "cjs" — see comment above
  outfile: join(SERVER_DIR, "index.mjs"),
  banner: { js: "// shyn MCP client — bundled by scripts/build-mcpb.mjs" },
  logLevel: "info",
});
// extension/server has no package.json of its own to set "type": "module"
// on — the manifest's mcp_config always invokes it by explicit .mjs path
// (`node .../server/index.mjs`), and node treats a file with that extension
// as ESM regardless of the nearest package.json, so none is needed.

console.log("[2/2] packing extension/ -> dist/shyn.mcpb");
mkdirSync(join(ROOT, "dist"), { recursive: true });
const outFile = join(ROOT, "dist/shyn.mcpb");
rmSync(outFile, { force: true });
execFileSync("npx", ["-y", "@anthropic-ai/mcpb", "pack", EXTENSION, outFile], {
  cwd: ROOT,
  stdio: "inherit",
});
console.log(`done: ${outFile}`);
