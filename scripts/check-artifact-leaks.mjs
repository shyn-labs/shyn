#!/usr/bin/env node
// Release gate: scans the artifacts that actually ship (the extracted tarball
// and the extracted .mcpb) for the builder's machine identity and for the
// PRIVATE denylist (real names, employers, domains). A hit aborts the release
// (scripts/release.sh calls this before anything is published).
//
// The scanning itself lives in scripts/lib/artifact-scan.mjs (shared with the
// seed check scripts/check-build-paths.mjs); this file is policy and plumbing:
// targets, extraction, the denylist file, output, exit codes.
//
// Never prints a denylist term (matches show as <denylist-term-N>, N = the
// entry's index in the file) and never prints the builder's username, home or
// checkout path (shown as <username>, <home>, <checkout>).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  REPO_ROOT, builderNeedles, newStats, parseDenylist, sanitizeText, scanTreeRules,
} from "./lib/artifact-scan.mjs";

const HELP = `usage: node scripts/check-artifact-leaks.mjs [options]

Scans the shipped artifacts for the builder's username, home directory and
checkout path, and for every term of the private denylist. Exit 0 only when
there are no hits and nothing was unreadable.

With no target flags it scans the newest dist/release/shyn-v*-darwin-arm64.tar.gz
and dist/shyn.mcpb (whichever exist; at least one must).

options:
  --tarball <path>  scan this .tar.gz (extracted with tar -xzf into a temp dir)
  --mcpb <path>     scan this .mcpb (a zip, extracted with unzip -q)
  --dir <path>      scan this directory in place (no extraction)
                    (explicit targets replace the defaults; they can be combined)
  --ci              no private denylist is expected (it is absent in CI): the
                    home and username needles are dropped (vendored third-party
                    files legitimately contain /Users/runner), the checkout
                    needle and an existing denylist still apply. The same
                    happens automatically when the home dir is /Users/runner.
                    Without --ci a missing denylist is a failure.
  --show-noise      also list the files that contained ignored binary noise
                    (file names only, never terms)
  -h, --help        this text

environment:
  SHYN_LEAK_DENYLIST       denylist file (default ~/.config/shyn/leak-denylist.txt):
                           one regex per line, # comments, case-insensitive
  SHYN_ARTIFACT_ALLOW      optional owner allowlist (default ~/.config/shyn/artifact-leak-allow.txt),
                           one entry per line: <glob relative to the extraction root>|<term>
                           (* and **; needs a literal path segment; the term must equal a
                           denylist line). Matching hits are reported as allowlisted, not failures.
  SHYN_GATE_USERNAME       override the builder username needle (tests)
  SHYN_DIST_DIR            where the default targets are looked up (default: dist/)
  SHYN_GATE_TEST_DELAY_MS  test hook: sleep this long per scanned file

rules:
  denylist       terms match as whole words (no ASCII letter/digit directly
                 before or after); non-ASCII terms match as UTF-8
  text files     denylist terms match anywhere (whole word)
  binary files   (NUL in the first 8 KiB) a denylist match counts only inside a
                 run of >= 6 printable ASCII bytes that contains it; shorter
                 runs, and any term shorter than 4 characters, are "ignored
                 binary noise" (counted, never hidden)
  builder values count wherever they occur, text or binary
  output         per hit: file (relative to the extraction root), byte offset,
                 <= 60 chars of context; at most 20 hits per file and 200 in
                 total are printed but ALL are counted

exit codes: 0 clean, 1 hits / unreadable files / denylist problem, 2 usage error
`;

// Owner allowlist: `<glob relative to the extraction root>|<term>` per line.
function parseAllowlist(text, denylist) {
  const known = new Map(denylist.map((d) => [d.term.toLowerCase(), d.index]));
  const out = [];
  const bad = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const cut = line.lastIndexOf("|");
    const glob = cut > 0 ? line.slice(0, cut).trim() : "";
    const term = cut > 0 ? line.slice(cut + 1).trim().toLowerCase() : "";
    const literalSegment = glob.split("/").some((seg) => seg && !seg.includes("*"));
    if (!glob || !known.has(term) || !literalSegment) { bad.push(i + 1); return; }
    const re = new RegExp("^" + glob.split("**").map((part) =>
      part.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*") + "$");
    out.push({ re, termIndex: known.get(term) });
  });
  return { entries: out, bad };
}

class Exit extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

let workDir = null;
const cleanup = () => {
  if (workDir) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    workDir = null;
  }
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

function parseArgs(argv) {
  const o = { ci: false, showNoise: false, tarball: null, mcpb: null, dir: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--ci") o.ci = true;
    else if (a === "--show-noise") o.showNoise = true;
    else if (a === "--tarball" || a === "--mcpb" || a === "--dir") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Exit(2, `${a} needs a path (see --help)`);
      o[a.slice(2)] = resolve(v);
    } else throw new Exit(2, `unknown argument: ${a} (see --help)`);
  }
  return o;
}

function defaultTargets() {
  const dist = process.env.SHYN_DIST_DIR ? resolve(process.env.SHYN_DIST_DIR) : join(REPO_ROOT, "dist");
  const out = { tarball: null, mcpb: null };
  const rel = join(dist, "release");
  if (existsSync(rel)) {
    const found = readdirSync(rel)
      .filter((n) => /^shyn-v.*-darwin-arm64\.tar\.gz$/.test(n))
      .map((n) => ({ p: join(rel, n), t: statSync(join(rel, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (found.length) out.tarball = found[0].p;
  }
  if (existsSync(join(dist, "shyn.mcpb"))) out.mcpb = join(dist, "shyn.mcpb");
  return out;
}

const unsafeEntry = (name) =>
  name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes("..");

function extract(kind, file, dest, rules) {
  const list = kind === "tarball"
    ? ["tar", ["-tzf", file]]
    : ["unzip", ["-Z1", file]];
  let names;
  try {
    names = execFileSync(list[0], list[1], { encoding: "utf8", maxBuffer: 1 << 29, stdio: ["ignore", "pipe", "pipe"] })
      .split("\n").filter(Boolean);
  } catch (e) {
    throw new Exit(1, `cannot list ${kind} entries: ${String(e.message).split("\n")[0]}`);
  }
  const bad = names.filter(unsafeEntry);
  if (bad.length) {
    throw new Exit(1, `refusing ${kind}: ${bad.length} entr${bad.length === 1 ? "y" : "ies"} would escape the extraction dir `
      + `(first: ${sanitizeText(bad[0], rules)})`);
  }
  mkdirSync(dest, { recursive: true });
  try {
    if (kind === "tarball") execFileSync("tar", ["-xzf", file, "-C", dest], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
    else execFileSync("unzip", ["-q", file, "-d", dest], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
  } catch (e) {
    throw new Exit(1, `extracting ${kind} failed: ${String(e.message).split("\n")[0]}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); return; }

  // --- targets --------------------------------------------------------------
  const explicit = opts.tarball || opts.mcpb || opts.dir;
  const targets = [];
  if (explicit) {
    if (opts.tarball) targets.push({ kind: "tarball", path: opts.tarball });
    if (opts.mcpb) targets.push({ kind: "mcpb", path: opts.mcpb });
    if (opts.dir) targets.push({ kind: "dir", path: opts.dir });
  } else {
    const d = defaultTargets();
    if (d.tarball) targets.push({ kind: "tarball", path: d.tarball });
    if (d.mcpb) targets.push({ kind: "mcpb", path: d.mcpb });
  }
  const hasPaths = (t) => existsSync(t.path);
  for (const t of targets) {
    if (!hasPaths(t)) throw new Exit(2, `${t.kind} not found: ${t.path.replace(homedir(), "~")}`);
    if (t.kind === "dir" && !statSync(t.path).isDirectory()) throw new Exit(2, `not a directory: ${t.path}`);
  }
  if (!targets.length) throw new Exit(2, "no targets: build first (dist/release/shyn-v*-darwin-arm64.tar.gz, dist/shyn.mcpb) or pass --tarball/--mcpb/--dir");

  // --- needles and denylist --------------------------------------------------
  const runner = homedir() === "/Users/runner";
  const ciMode = opts.ci || runner;
  let needles = builderNeedles({ env: process.env });
  if (ciMode) needles = needles.filter((n) => n.label === "checkout");
  const denylistPath = process.env.SHYN_LEAK_DENYLIST ?? join(homedir(), ".config/shyn/leak-denylist.txt");
  const shownPath = denylistPath.split(homedir()).join("<home>");
  let denylist = [];
  let denylistNote;
  if (!existsSync(denylistPath)) {
    if (!ciMode) {
      throw new Exit(1, `denylist missing at ${shownPath}: the gate cannot run. Create it (one regex per line, # for comments), set SHYN_LEAK_DENYLIST, or pass --ci.`);
    }
    denylistNote = "denylist: not present (--ci): only the remaining builder checks ran";
  } else {
    const parsed = parseDenylist(readFileSync(denylistPath, "utf8"));
    if (parsed.badLines.length) {
      throw new Exit(1, `denylist has invalid regex on line(s): ${parsed.badLines.join(", ")} (${shownPath})`);
    }
    denylist = parsed.entries;
    denylistNote = `denylist: ${denylist.length} term(s) (never printed; reported as <denylist-term-N>)`;
  }
  const allowPath = process.env.SHYN_ARTIFACT_ALLOW ?? join(homedir(), ".config/shyn/artifact-leak-allow.txt");
  let allow = [];
  if (existsSync(allowPath)) {
    const parsed = parseAllowlist(readFileSync(allowPath, "utf8"), denylist);
    if (parsed.bad.length) {
      throw new Exit(1, `allowlist has invalid entr${parsed.bad.length === 1 ? "y" : "ies"} on line(s): ${parsed.bad.join(", ")} `
        + "(need <glob with a literal segment>|<term in the denylist>)");
    }
    allow = parsed.entries;
  }
  const rules = { needles, denylist, delayMs: Number(process.env.SHYN_GATE_TEST_DELAY_MS) || 0 };
  const san = (t) => sanitizeText(t, rules);
  console.log(`builder needles used: ${needles.map((n) => n.label).join(", ") || "none"}`
    + (ciMode && !opts.ci ? " (GitHub runner home detected: home and username dropped)" : "")
    + (opts.ci ? " (--ci: home and username dropped)" : ""));
  console.log(denylistNote);

  // --- extract + scan --------------------------------------------------------
  workDir = mkdtempSync(join(tmpdir(), "shyn-artifact-gate-"));
  const stats = newStats();
  let hits = 0;
  let printed = 0;
  const perFile = new Map();
  const allowed = new Map();
  let allowlisted = 0;
  rules.onHit = (h) => {
    if (h.kind === "denylist" && allow.some((a) => a.termIndex === h.termIndex && a.re.test(h.file))) {
      allowlisted++;
      const k = `${h.file}\0${h.termIndex}`;
      allowed.set(k, (allowed.get(k) ?? 0) + 1);
      return;
    }
    hits++;
    const key = `${currentLabel}:${h.file}`;
    const n = (perFile.get(key) ?? 0) + 1;
    perFile.set(key, n);
    if (n <= 20 && printed < 200) {
      printed++;
      console.log(`  ${currentLabel}:${san(h.file)}  @${h.offset}  [${h.label}]  ${h.context()}`);
    }
  };
  let currentLabel = "";
  for (const t of targets) {
    currentLabel = t.kind;
    let root = t.path;
    if (t.kind !== "dir") {
      root = join(workDir, t.kind);
      extract(t.kind, t.path, root, rules);
    }
    console.log(`scanning ${t.kind}`);
    await scanTreeRules(root, rules, stats);
  }
  for (const [k, n] of allowed) {
    const [f, idx] = k.split("\0");
    console.log(`allowlisted: ${san(f)} x${n} (<denylist-term-${idx}>)`);
  }
  if (hits > printed) console.log(`  (${hits - printed} more hit(s) not shown; all are counted)`);
  for (const f of stats.unreadableFiles.slice(0, 20)) console.log(`  unreadable: ${san(f)}`);
  if (opts.showNoise) {
    for (const f of [...stats.noiseFiles].sort()) console.log(`  ignored binary noise in: ${san(f)}`);
  }
  console.log(`scanned ${stats.files} files, ${(stats.bytes / 1048576).toFixed(1)} MB, hits ${hits}, allowlisted ${allowlisted}, `
    + `ignored binary noise ${stats.noise}, unreadable ${stats.unreadable}`);
  if (hits === 0 && stats.unreadable === 0) {
    console.log("OK: no builder identity or denylist term in the artifacts");
  } else {
    console.log("FAIL: the artifacts must not ship; fix the source of each hit and rebuild");
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (e) {
  if (e instanceof Exit) {
    console.error(`check-artifact-leaks: ${e.message}`);
    process.exitCode = e.code;
  } else {
    console.error(`check-artifact-leaks: unexpected error: ${e?.stack ?? e}`);
    process.exitCode = 1;
  }
} finally {
  cleanup();
}
