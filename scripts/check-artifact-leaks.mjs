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
// What it checks (builder values count anywhere, exact; denylist terms are
// whole words, with the printable-run noise rule inside binaries):
//   1. every file of the extracted tarball / .mcpb / --dir (contents)
//   2. the RAW decompressed tar stream and the raw .mcpb bytes (builder values
//      only): owner names, path names, link targets, extended headers
//   3. every relative path and symlink target of the extracted trees
//      (builder values and denylist terms), reported as name: / link:
//   4. the gzip header fields of the tarball (FNAME, FCOMMENT, FEXTRA):
//      builder values and denylist terms, reported as tarball-gzip-header
//   5. the code signature of every code item (bundle directories and Mach-O
//      files, scripts/lib/signing.mjs): reported as signing: <reason>
//
// Archives are refused, never partially scanned, when the listing (read from
// the tar headers / zip directory) has duplicate names, unsafe names, devices,
// fifos, entries below a symlink, or when the extracted tree differs from it
// (scripts/lib/archive.mjs).
//
// Known limits (deliberately not handled): regex punctuation boundaries, the
// <4-character rule counts characters not bytes, non-ASCII case folding,
// extraction size limits, UTF-16 and case-variant builder needles, denylist
// terms in tar headers (only builder values are scanned there; the gzip
// header gets the denylist too).
//
// Any email-shaped text is printed as <email>, and signing identities that are
// not allowed are collected as secrets before anything is printed about them.
//
// Never prints a denylist term (matches show as <denylist-term-N>, N = the
// entry's index in the file) and never prints the builder's username, home or
// checkout path (shown as <username>, <home>, <checkout>).

import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  REPO_ROOT, builderNeedles, newStats, parseDenylist, sanitizeText, scanFileRules, scanNames, scanTreeRules,
} from "./lib/artifact-scan.mjs";
import {
  TAR, UNZIP, checkTarEntries, checkZipNames, compareTree, forceRm, gunzipToFile, gzipHeaderFields, killChildren, listTar, runChild,
} from "./lib/archive.mjs";
import { allowedAuthorities, checkSigning, codesignPath, discoverCode } from "./lib/signing.mjs";

const HELP = `usage: node scripts/check-artifact-leaks.mjs [options]

Scans the shipped artifacts for the builder's username, home directory and
checkout path, and for every term of the private denylist. Exit 0 only when
there are no hits and nothing was unreadable.

With no target flags it scans the newest dist/release/shyn-v*-darwin-arm64.tar.gz
and dist/shyn.mcpb (whichever exist; at least one must).

options:
  --tarball <path>  scan this .tar.gz (decompressed, listed from its headers, extracted with tar -xf)
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
                           (* and **; the last path segment must be literal; the term must equal a
                           denylist line). Matching hits are reported as allowlisted, not failures.
  SHYN_GATE_USERNAME       override the builder username needle (tests)
  SHYN_DIST_DIR            where the default targets are looked up (default: dist/)
  SHYN_GATE_TEST_DELAY_MS  test hook: sleep this long per scanned file, and before each
                           extraction child does its work (so a signal can hit a live child)

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

signing policy (every bundle directory and Mach-O file, checked with codesign):
  1. codesign --verify --strict exits 0 (--deep added for bundle directories)
  2. and it is one of:
     - allowed identity: the only Authority= line is in SHYN_ALLOWED_AUTHORITIES
       (default "Shyn Dev") and TeamIdentifier is "not set"
     - pinned third party: an entry of THIRD_PARTY_SIGNERS in scripts/lib/signing.mjs
       (today the vendored Node runtime) with only the Apple chain above it
     - ad-hoc file: Signature=adhoc on a FILE (never on a bundle directory)
  A --tarball must contain at least one .app directory. Identity values of
  anything not allowed are never printed (<redacted>); email-shaped text is
  always printed as <email>.
  SHYN_ALLOWED_AUTHORITIES  comma separated, exact names; empty is a usage error;
                            when set, a count-only NOTICE is printed
  SHYN_CODESIGN             codesign binary (default /usr/bin/codesign; test hook)

exit codes: 0 clean, 1 hits / unreadable files / denylist or signing problem, 2 usage error
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
    const segs = glob.split("/");
    const literalSegment = segs.some((seg) => seg && !seg.includes("*"));
    const basenameLiteral = !!segs[segs.length - 1] && !segs[segs.length - 1].includes("*");
    if (!glob || !known.has(term) || !literalSegment || !basenameLiteral) { bad.push(i + 1); return; }
    const re = new RegExp("^" + glob.split("**").map((part) =>
      part.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*") + "$");
    out.push({ re, termIndex: known.get(term) });
  });
  return { entries: out, bad };
}

class Exit extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

// Everything printed that is not an already-sanitized context goes through
// san(): builder values (any case) and denylist substrings are replaced.
const sanRules = { needles: builderNeedles({ env: process.env }), denylist: [], secrets: [] };
const san = (t) => sanitizeText(t, sanRules);

let workDir = null;
const cleanup = () => {
  if (workDir) {
    forceRm(workDir);
    workDir = null;
  }
};
process.on("exit", cleanup);
for (const [sig, code] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGQUIT", 131], ["SIGTERM", 143]]) {
  process.on(sig, () => { killChildren(); cleanup(); process.exit(code); });
}

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

const plural = (n) => (n === 1 ? "y" : "ies");
const firstLine = (e) => String(e.message).split("\n")[0];

// Refuses (never partially scans) an archive whose listing is ambiguous.
function refuseListing(kind, { bad, dups }, rules) {
  if (dups.length) {
    throw new Exit(1, `refusing ${kind}: ${dups.length} duplicate entr${plural(dups.length)} (first: ${sanitizeText(dups[0], rules)})`);
  }
  if (bad.length) {
    throw new Exit(1, `refusing ${kind}: ${bad.length} entr${plural(bad.length)} would escape the extraction dir or are not files, dirs or links `
      + `(first: ${sanitizeText(bad[0], rules)})`);
  }
}

// Tarball steps: decompress, list from the headers, extract, compare the tree.
async function gunzipTarball(file, raw) {
  try { await gunzipToFile(file, raw); } catch (e) { throw new Exit(1, `cannot decompress the tarball stream: ${firstLine(e)}`); }
}
function listTarball(raw, rules) {
  let entries;
  try { entries = listTar(raw); } catch (e) { throw new Exit(1, `cannot list tarball entries: ${firstLine(e)}`); }
  refuseListing("tarball", checkTarEntries(entries), rules);
  return entries.map((e) => e.name);
}
// Test hook (SHYN_GATE_TEST_DELAY_MS): the child sleeps that long before it
// starts its real work, so a signal can be sent while a child is alive.
function hooked(cmd, args) {
  const ms = Number(process.env.SHYN_GATE_TEST_DELAY_MS) || 0;
  if (!ms) return [cmd, args];
  return ["/bin/sh", ["-c", 'sleep "$1"; shift; exec "$@"', "sh", String(ms / 1000), cmd, ...args]];
}
async function child(step, cmd, args, failMsg) {
  const [c, a] = hooked(cmd, args);
  let r;
  try { r = await runChild(c, a); } catch (e) {
    throw new Exit(1, e.message === "timed out" ? `${step} timed out` : `${failMsg}: ${firstLine(e)}`);
  }
  if (r.code !== 0) throw new Exit(1, `${failMsg}: ${firstLine({ message: r.stderr.toString("utf8").trim() || `exit ${r.code}` })}`);
  return r;
}
async function extractTarball(raw, dest) {
  mkdirSync(dest, { recursive: true });
  console.log("extracting tarball");
  await child("extracting tarball", TAR, ["-xf", raw, "--no-mac-metadata", "--no-xattrs", "--no-acls", "--no-fflags", "-C", dest],
    "extracting tarball failed");
}

// mcpb (zip) steps: list names, extract.
async function listMcpb(file, rules) {
  const r = await child("listing mcpb", UNZIP, ["-Z1", file], "cannot list mcpb entries");
  const names = r.stdout.toString("utf8").split("\n").filter(Boolean);
  refuseListing("mcpb", checkZipNames(names), rules);
  return names;
}
async function extractMcpb(file, dest) {
  mkdirSync(dest, { recursive: true });
  console.log("extracting mcpb");
  await child("extracting mcpb", UNZIP, ["-q", file, "-d", dest], "extracting mcpb failed");
}
function verifyTree(kind, root, names) {
  const problems = compareTree(root, names);
  if (problems.length) throw new Exit(1, `refusing ${kind}: ${problems.join("; ")}`);
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
    if (!hasPaths(t)) throw new Exit(2, `${t.kind} not found: ${t.path}`);
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
    if (!parsed.entries.length) {
      if (!ciMode) throw new Exit(1, `denylist at ${shownPath} has no active terms: an empty list would pass everything. Add terms, or pass --ci.`);
      denylistNote = "denylist: no active terms (--ci): only the remaining builder checks ran";
    }
    denylist = parsed.entries;
    if (denylist.length)
      denylistNote = `denylist: ${denylist.length} term(s) (never printed; reported as <denylist-term-N>)`;
  }
  const allowPath = process.env.SHYN_ARTIFACT_ALLOW ?? join(homedir(), ".config/shyn/artifact-leak-allow.txt");
  let allow = [];
  if (existsSync(allowPath)) {
    const parsed = parseAllowlist(readFileSync(allowPath, "utf8"), denylist);
    if (parsed.bad.length) {
      throw new Exit(1, `allowlist has invalid entr${parsed.bad.length === 1 ? "y" : "ies"} on line(s): ${parsed.bad.join(", ")} `
        + "(need <glob with a literal basename>|<term in the denylist>)");
    }
    allow = parsed.entries;
  }
  let allowedAuth;
  try { allowedAuth = allowedAuthorities(process.env); } catch (e) { throw new Exit(2, e.message); }
  let codesign;
  try { codesign = codesignPath(process.env); } catch (e) { throw new Exit(1, e.message); }
  const rules = { needles, denylist, secrets: sanRules.secrets, delayMs: Number(process.env.SHYN_GATE_TEST_DELAY_MS) || 0 };
  sanRules.denylist = denylist;
  console.log(`builder needles used: ${needles.map((n) => n.label).join(", ") || "none"}`
    + (ciMode && !opts.ci ? " (GitHub runner home detected: home and username dropped)" : "")
    + (opts.ci ? " (--ci: home and username dropped)" : ""));
  console.log(denylistNote);
  if (process.env.SHYN_ALLOWED_AUTHORITIES !== undefined) {
    console.log(`NOTICE: signing authorities set by SHYN_ALLOWED_AUTHORITIES (${allowedAuth.length} entries)`);
  } else console.log(`signing: allowed authorities: ${allowedAuth.join(", ")}`);

  // --- extract + scan --------------------------------------------------------
  workDir = mkdtempSync(join(tmpdir(), "shyn-artifact-gate-"));
  const stats = newStats();
  let hits = 0;
  let printed = 0;
  const perFile = new Map();
  const allowed = new Map();
  let allowlisted = 0;
  let currentLabel = "";
  rules.onHit = (h) => {
    if (h.kind === "denylist" && allow.some((a) => a.termIndex === h.termIndex && a.re.test(h.file))) {
      allowlisted++;
      const k = `${currentLabel}:${h.file}\0${h.termIndex}`;
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
  // names and link targets (and anything that is not a content offset)
  const onNameHit = (h) => {
    hits++;
    if (printed < 200) {
      printed++;
      console.log(`  ${currentLabel}:${san(h.file)}  ${h.where}:  [${h.label}]`);
    }
  };
  // builder values only, in a raw archive stream: counted in H, not in F/B
  const scanRaw = async (path, label) => {
    const prev = currentLabel;
    currentLabel = label;
    const scratch = newStats();
    await scanFileRules(path, { needles, denylist: [], onHit: rules.onHit }, scratch, "raw stream");
    stats.unreadable += scratch.unreadable;
    currentLabel = prev;
  };
  const kinds = { allowed: 0, "third-party": 0, adhoc: 0 };
  let codeItems = 0;
  const signingHit = (label, rel, reason) => {
    hits++;
    if (printed < 200) { printed++; console.log(`  ${label}:${san(rel)}  signing: ${reason}`); }
  };
  // Signing runs FIRST in every target (right after extraction and before any
  // content, name, raw-stream or gzip-header scan can print a context), so every
  // disallowed identity is a known secret before anything else is printed.
  const signTree = async (t, root) => {
    const code = discoverCode(root);
    if (t.kind === "tarball" && code.apps === 0) signingHit(t.kind, ".", "no .app in the tarball");
    for (const p of code.problems) signingHit(t.kind, p.rel, p.reason);
    for (const item of code.items) {
      codeItems++;
      const res = await checkSigning(codesign, item, allowedAuth);
      sanRules.secrets.push(...res.secrets); // before anything about the item is printed
      for (const reason of res.problems) signingHit(t.kind, item.rel, reason);
      if (res.kind) kinds[res.kind]++;
    }
  };
  for (const t of targets) {
    currentLabel = t.kind;
    let root = t.path;
    console.log(`scanning ${t.kind}: ${san(t.path)}`);
    if (t.kind === "tarball") {
      root = join(workDir, t.kind);
      const raw = join(workDir, "tarball.raw.tar");
      await gunzipTarball(t.path, raw);
      const names = listTarball(raw, rules);
      await extractTarball(raw, root);
      verifyTree("tarball", root, names);
      await signTree(t, root);
      await scanRaw(raw, "tarball-raw");
      rmSync(raw, { force: true });
      // gzip header fields (FNAME / FCOMMENT / FEXTRA): builder values and denylist
      let hdr;
      try { hdr = gzipHeaderFields(t.path); } catch (e) { throw new Exit(1, `cannot read the gzip header: ${firstLine(e)}`); }
      const hdrFile = join(workDir, "gzip-header.txt");
      writeFileSync(hdrFile, [hdr.name ?? "", hdr.comment ?? "", hdr.extra ? hdr.extra.toString("latin1") : ""].join("\n"), "latin1");
      const prev = currentLabel;
      currentLabel = "tarball-gzip-header";
      const scratch = newStats();
      await scanFileRules(hdrFile, { needles, denylist, onHit: rules.onHit }, scratch, "gzip header");
      stats.unreadable += scratch.unreadable;
      currentLabel = prev;
      rmSync(hdrFile, { force: true });
    } else if (t.kind === "mcpb") {
      root = join(workDir, t.kind);
      const names = await listMcpb(t.path, rules);
      await extractMcpb(t.path, root);
      verifyTree("mcpb", root, names);
      await signTree(t, root);
      await scanRaw(t.path, "mcpb-raw");
    }
    if (t.kind === "dir") await signTree(t, root);
    await scanTreeRules(root, rules, stats);
    scanNames(root, rules, onNameHit);
  }
  if (stats.files === 0) throw new Exit(1, "scanned 0 files: nothing to check (empty or unreadable archive?)");
  for (const [k, n] of allowed) {
    const [f, idx] = k.split("\0");
    console.log(`allowlisted: ${san(f)} x${n} (<denylist-term-${idx}>)`);
  }
  if (hits > printed) console.log(`  (${hits - printed} more hit(s) not shown; all are counted)`);
  for (const f of stats.unreadableFiles.slice(0, 20)) console.log(`  unreadable: ${san(f)}`);
  if (opts.showNoise) {
    for (const f of [...stats.noiseFiles].sort()) console.log(`  ignored binary noise in: ${san(f)}`);
  }
  console.log(`signing: ${codeItems} code items checked (${kinds.allowed} allowed identity, ${kinds["third-party"]} pinned third party, ${kinds.adhoc} ad-hoc file)`);
  console.log(`scanned ${stats.files} files, ${(stats.bytes / 1048576).toFixed(1)} MB, hits ${hits}, allowlisted ${allowlisted}, `
    + `ignored binary noise ${stats.noise}, unreadable ${stats.unreadable}`);
  if (hits === 0 && stats.unreadable === 0) {
    console.log("OK: no builder identity, denylist term or disallowed signature in the artifacts");
  } else {
    console.log("FAIL: the artifacts must not ship; fix the source of each hit and rebuild");
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (e) {
  if (e instanceof Exit) {
    console.error(`check-artifact-leaks: ${san(e.message)}`);
    process.exitCode = e.code;
  } else {
    console.error(`check-artifact-leaks: unexpected error: ${san(e?.stack ?? e)}`);
    process.exitCode = 1;
  }
} finally {
  cleanup();
}
