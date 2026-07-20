import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, readdirSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

// Recursively find files matching a predicate — used below to assert no
// native (.node) modules snuck into the packaged app. lstatSync (not
// statSync): the tree is copied with verbatimSymlinks, so entries can be
// relative symlinks — we classify by the entry itself, not by following it.
function findFiles(dir: string, predicate: (name: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = lstatSync(p);
    if (st.isDirectory()) findFiles(p, predicate, out);
    else if (predicate(entry)) out.push(p);
  }
  return out;
}

// cwd-anchored like build-capture-app.mts — a stray rmSync must never land
// outside the repo.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!ROOT.endsWith("/shyn")) {
  throw new Error(`Refusing to build: resolved root is not the shyn project: ${ROOT}`);
}
const PKG = join(ROOT, "packages/status-ui");

execFileSync("pnpm", ["--filter", "@shyn/status-ui", "build"], { stdio: "inherit", cwd: ROOT });
execFileSync("pnpm", ["--filter", "@shyn/status-ui", "exec", "electron-builder", "--dir"],
  { stdio: "inherit", cwd: ROOT, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } });

// electron-builder emits release/mac[-arm64]/shyn-status.app — locate it.
const macDir = readdirSync(join(PKG, "release")).find((d) => d.startsWith("mac"));
if (!macDir) throw new Error("electron-builder produced no mac output");
const srcApp = join(PKG, "release", macDir, "shyn-status.app");

rmSync(join(ROOT, "dist/status"), { recursive: true, force: true });
mkdirSync(join(ROOT, "dist/status"), { recursive: true });
// verbatimSymlinks: Electron.app frameworks are symlink-structured; see the
// long rationale in packages/cli/src/launchd.ts stageDaemonProgram.
cpSync(srcApp, join(ROOT, "dist/status/shyn-status.app"), { recursive: true, verbatimSymlinks: true });

// Packaging regression guard: the status app must stay pure JS (mcp-client-
// style constraint) — if a native module leaks in via a transitive dep, fail
// the build loudly rather than shipping an .app that breaks on another Mac.
const nativeModules = findFiles(join(ROOT, "dist/status/shyn-status.app"), (name) => name.endsWith(".node"));
if (nativeModules.length > 0) {
  throw new Error(
    `packaging regression: native modules inside shyn-status.app:\n${nativeModules.join("\n")}`,
  );
}

// --deep: sign the nested Electron frameworks too (self-signed dev identity,
// same stability rationale as the Swift agents).
const identity = process.env.SHYN_CODESIGN_IDENTITY ?? "-";
execFileSync("codesign", ["--force", "--deep", "--sign", identity,
  join(ROOT, "dist/status/shyn-status.app")], { stdio: "inherit", cwd: ROOT });
console.log(identity === "-"
  ? "dist/status/shyn-status.app ready (ad-hoc — set SHYN_CODESIGN_IDENTITY for stable TCC identity)"
  : `dist/status/shyn-status.app ready (signed: ${identity})`);
