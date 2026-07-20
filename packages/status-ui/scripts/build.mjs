// Bundles main (ESM), preload (CJS — sandbox requires it), renderer (IIFE),
// copies static assets, generates tray icons. esbuild inlines the workspace
// imports (@shyn/daemon/rpc, @shyn/engine/paths — both pure JS; the engine
// BARREL must never be imported: it drags native modules).
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(PKG, "dist");
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const common = { bundle: true, platform: "node", external: ["electron"], logLevel: "silent" };
await build({ ...common, entryPoints: [join(PKG, "src/main.ts")], format: "esm", outfile: join(DIST, "main.mjs") });
await build({ ...common, entryPoints: [join(PKG, "src/preload.ts")], format: "cjs", outfile: join(DIST, "preload.cjs") });
await build({ bundle: true, platform: "browser", format: "iife", logLevel: "silent",
  entryPoints: [join(PKG, "renderer/index.ts")], outfile: join(DIST, "renderer.js") });
await build({ bundle: true, platform: "browser", format: "iife", logLevel: "silent",
  entryPoints: [join(PKG, "renderer/onboarding.ts")], outfile: join(DIST, "onboarding.js") });

cpSync(join(PKG, "renderer/index.html"), join(DIST, "index.html"));
cpSync(join(PKG, "renderer/styles.css"), join(DIST, "styles.css"));
cpSync(join(PKG, "renderer/onboarding.html"), join(DIST, "onboarding.html"));
execFileSync(process.execPath, [join(PKG, "scripts/gen-icons.mjs"), join(DIST, "assets")]);
console.log("build → dist/");
