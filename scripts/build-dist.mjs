// Plan C Task 5 spike: bundle the daemon into a self-contained dist/daemon/
// directory that boots with only a bare system `node` — no repo, no
// node_modules, no tsx. See docs/dist-bundle.md for the full writeup of why
// this script looks the way it does; short version of the deviations from
// the task-5-brief.md sketch:
//
//  1. format: "esm" (not "cjs") + outfile daemon.mjs — main.ts has a
//     top-level `await startServer(...)`, which esbuild's cjs output
//     rejects outright ("Top-level await is currently not supported with
//     the 'cjs' output format").
//  2. Native deps are carried via `pnpm deploy --prod`, not a hand-rolled
//     walk of each native's package.json `dependencies`. node-llama-cpp
//     alone has ~25 runtime deps, several of which have their own deps, and
//     pnpm has already solved exactly this resolution problem — `pnpm
//     deploy` is pnpm's own supported mechanism for producing a pruned,
//     production-only, deploy-ready node_modules for one workspace package.
//     Reimplementing its resolver by hand would be more code, and more
//     fragile, for no benefit.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, symlinkSync,
  readlinkSync, unlinkSync, realpathSync, renameSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist/daemon");
const DEPLOY_SCRATCH = join(ROOT, "dist/.deploy-scratch");
const NATIVE = ["better-sqlite3-multiple-ciphers", "sqlite-vec", "node-llama-cpp"];

rmSync(DIST, { recursive: true, force: true });
rmSync(DEPLOY_SCRATCH, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

console.log("[1/4] bundling packages/daemon/src/main.ts -> dist/daemon/daemon.mjs");
await build({
  entryPoints: [join(ROOT, "packages/daemon/src/main.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm", // top-level await in main.ts rules out format: "cjs"
  outfile: join(DIST, "daemon.mjs"),
  external: NATIVE,
  banner: { js: "// shyn daemon — bundled by scripts/build-dist.mjs; native deps in ./node_modules" },
  logLevel: "info",
});

console.log("[2/4] pnpm deploy --prod (resolves native deps + their transitive deps)");
execFileSync(
  "pnpm",
  ["--filter", "@shyn/daemon", "deploy", DEPLOY_SCRATCH, "--prod"],
  { cwd: ROOT, stdio: "inherit" },
);

if (!existsSync(join(DEPLOY_SCRATCH, "node_modules")))
  throw new Error("pnpm deploy did not produce a node_modules directory");

console.log("[3/4] copying deployed node_modules into dist/daemon/");
// NOT dereferenced with cpSync's own dereference flag: pnpm's node_modules
// is a graph of symlinks (workspace links + hoisted transitive deps under
// .pnpm/node_modules), and naive dereferencing would physically duplicate
// every shared transitive dep instead of sharing it via the store — a much
// bigger copy for no benefit.
cpSync(join(DEPLOY_SCRATCH, "node_modules"), join(DIST, "node_modules"), { recursive: true });

// KINK: unlike a normal `pnpm install` (which links its virtual store with
// *relative* symlinks, portable by construction), `pnpm deploy` links its
// virtual store with ABSOLUTE symlinks baked to DEPLOY_SCRATCH's path. The
// cpSync above copied the symlinks as-is (same absolute targets) — every
// one of them now dangles, pointing at a scratch dir we're about to delete.
// Rewrite each one to a path-independent *relative* symlink so dist/daemon
// stays correct after the scratch dir is gone and remains movable as a
// whole (matches the intent of a "self-contained" bundle).
console.log("    rewriting deploy-scratch-absolute symlinks -> relative");
const SCRATCH_NM = join(DEPLOY_SCRATCH, "node_modules");
const DIST_NM = join(DIST, "node_modules");
let rewritten = 0;
function fixSymlinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const target = readlinkSync(full);
      if (target.startsWith(SCRATCH_NM)) {
        const newAbsTarget = DIST_NM + target.slice(SCRATCH_NM.length);
        const rel = relative(dirname(full), newAbsTarget);
        unlinkSync(full);
        symlinkSync(rel, full);
        rewritten++;
      }
      // else: not a scratch-absolute link (e.g. already relative) — leave it.
    } else if (entry.isDirectory()) {
      fixSymlinks(full);
    }
  }
}
fixSymlinks(DIST_NM);
console.log(`    rewrote ${rewritten} symlinks`);

// @shyn/engine's TS source is already inlined into daemon.mjs by esbuild —
// the copy in node_modules is dead weight (source .ts files, not even
// runnable directly by node). Drop it to save space.
rmSync(join(DIST, "node_modules/@shyn"), { recursive: true, force: true });
for (const d of readdirSync(join(DIST, "node_modules/.pnpm")))
  if (d.startsWith("@shyn+engine@"))
    rmSync(join(DIST, "node_modules/.pnpm", d), { recursive: true, force: true });

// KINK: pnpm places each of the 3 natives inside @shyn/engine's own private
// node_modules (they're @shyn/engine's direct deps, not hoisted), e.g.
// node_modules/.pnpm/@shyn+engine@.../node_modules/node-llama-cpp. That's
// invisible to daemon.mjs's plain `import "node-llama-cpp"`: daemon.mjs is
// bundled to dist/daemon/daemon.mjs, and node's ancestor-directory module
// resolution walking up from THAT file's location never passes through
// @shyn/engine's own node_modules — only through dist/daemon/node_modules
// directly. So: add a top-level symlink for each native pointing into the
// .pnpm store we just copied, exactly mirroring what a real top-level pnpm
// dependency looks like (see the repo root's own node_modules/<native> ->
// .pnpm/<native>@<version>/node_modules/<native> symlinks for comparison).
for (const pkg of NATIVE) {
  const pnpmDir = join(DIST, "node_modules/.pnpm");
  const match = readdirSync(pnpmDir).find((d) => d.startsWith(`${pkg}@`));
  if (!match) throw new Error(`could not find ${pkg} in copied .pnpm store — deploy didn't resolve it`);
  symlinkSync(join(".pnpm", match, "node_modules", pkg), join(DIST, "node_modules", pkg));
}

// Final integrity sweep: the two rewrite/prune passes above only handle the
// cases they were written for (scratch-absolute targets; @shyn/engine's own
// tree). They don't cover every way a symlink can end up wrong:
//   - pruning @shyn/engine's directories (above) leaves pnpm's *hoisted*
//     mapping link at node_modules/.pnpm/node_modules/@shyn/engine pointing
//     at a now-deleted target — dangling.
//   - some workspace-package symlinks (e.g. @shyn/daemon's own entry) were
//     never scratch-absolute to begin with — pnpm links them straight at
//     the live repo path (e.g. /…/shyn/packages/daemon), so the "rewrite
//     scratch-absolute targets" pass above never touches them, and they
//     silently escape dist/daemon, breaking the "self-contained/movable"
//     claim.
// Rather than special-case every such path, sweep the whole tree: drop any
// symlink that doesn't resolve to somewhere inside DIST, then assert none
// remain. This is what actually proves relocatability, not the individual
// rewrite passes above.
function* walkLinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isSymbolicLink()) yield p;
    else if (entry.isDirectory()) yield* walkLinks(p);
  }
}
const DIST_REAL = realpathSync(DIST);
let integrityRemoved = 0;
for (const link of [...walkLinks(DIST)]) {
  let ok = false;
  let targetStr = "<dangling>";
  try {
    const target = realpathSync(link);
    targetStr = target;
    ok = target.startsWith(DIST_REAL + "/") || target === DIST_REAL;
  } catch {
    // dangling — target doesn't exist at all
  }
  if (!ok) {
    unlinkSync(link);
    console.log(`    removed: ${link} -> ${targetStr}`);
    integrityRemoved++;
  }
}
console.log(`    integrity sweep: removed ${integrityRemoved} dangling/escaping symlink(s)`);

// Assert the invariant the sweep above is supposed to guarantee: every
// remaining symlink resolves to a real target inside dist/daemon. If the
// sweep's removal of a bad link broke something the daemon actually needs
// at runtime, that's a real bug in the deploy/rewrite logic upstream — the
// boot smoke test (see docs/dist-bundle.md) is what catches that, not this
// assertion. This assertion only proves the tree is self-contained.
for (const link of [...walkLinks(DIST)]) {
  const target = realpathSync(link); // throws if still dangling — sweep above should have removed all of these
  if (!(target.startsWith(DIST_REAL + "/") || target === DIST_REAL))
    throw new Error(`symlink escapes dist: ${link} -> ${target}`);
}

writeFileSync(
  join(DIST, "package.json"),
  JSON.stringify({ name: "shyn-daemon-dist", type: "module" }, null, 2) + "\n",
);

rmSync(DEPLOY_SCRATCH, { recursive: true, force: true });
// KINK: `pnpm deploy` also miscomputes .bin symlink paths for the *deployed*
// package's own devDep-only bins (tsc/tsserver — irrelevant to us, --prod
// excludes them anyway) relative to packages/daemon/ instead of the repo
// root, leaving an empty packages/daemon/dist/.deploy-scratch/ stub behind.
// Harmless (nothing we need lives there) but stray; clean it up.
rmSync(join(ROOT, "packages/daemon/dist/.deploy-scratch"), { recursive: true, force: true });

// [4/4] Vendor the official nodejs.org runtime into the bundle.
// WHY OFFICIAL: /opt/homebrew/bin/node links @rpath/libnode + brew-only
// dylibs (llhttp, libuv, ada — verified with otool) and is NOT portable.
// WHY THIS EXACT VERSION: the natives in node_modules were built by the
// host's node — same version ⇒ same NODE_MODULE_VERSION ⇒ no ABI drift
// (the 2026-07-10 incident class, permanently closed for users).
const NODE_V = process.versions.node;
const CACHE = join(ROOT, "dist/.node-cache");
const tarName = `node-v${NODE_V}-darwin-arm64.tar.gz`;
const cachedTar = join(CACHE, tarName);
mkdirSync(CACHE, { recursive: true });
if (!existsSync(cachedTar)) {
  console.log(`[4/4] downloading official node v${NODE_V} (once, cached)…`);
  const base = `https://nodejs.org/dist/v${NODE_V}`;
  const [tarBuf, shaText] = await Promise.all([
    fetch(`${base}/${tarName}`).then((r) => {
      if (!r.ok) throw new Error(`node download failed: ${r.status} ${base}/${tarName}`);
      return r.arrayBuffer();
    }),
    fetch(`${base}/SHASUMS256.txt`).then((r) => {
      if (!r.ok) throw new Error(`SHASUMS256 download failed: ${r.status}`);
      return r.text();
    }),
  ]);
  const expected = shaText.split("\n").find((l) => l.endsWith(tarName))?.split(/\s+/)[0];
  if (!expected) throw new Error(`no SHASUMS256 entry for ${tarName}`);
  const actual = createHash("sha256").update(Buffer.from(tarBuf)).digest("hex");
  if (actual !== expected) throw new Error(`node tarball sha mismatch: ${actual} != ${expected}`);
  writeFileSync(cachedTar, Buffer.from(tarBuf));
} else {
  console.log(`[4/4] vendoring node v${NODE_V} (cached)`);
}
mkdirSync(join(DIST, "bin"), { recursive: true });
execFileSync("tar", ["-xzf", cachedTar, "-C", join(DIST, "bin"),
  "--strip-components", "2", `node-v${NODE_V}-darwin-arm64/bin/node`]);
// Rename the interpreter: macOS names processes and TCC entries after the
// executable FILE, so a daemon running as "node" is unidentifiable in
// Activity Monitor / Full Disk Access. Node doesn't care about its binary
// name, and the embedded signature stays valid across a rename.
renameSync(join(DIST, "bin/node"), join(DIST, "bin/shynd"));
execFileSync(join(DIST, "bin/shynd"), ["--version"]); // sanity: it executes
console.log(`vendored node v${NODE_V} -> dist/daemon/bin/shynd`);

console.log(`done: ${DIST}`);
