// Shared byte scanner for built artifacts: finds the builder's machine
// identity (macOS username, home directory, checkout path) inside a tree of
// shipped files, text or binary alike.
//
// Why it exists: release builds once embedded the builder's checkout path
// (debug-map stabs in the Swift binaries, pnpm shims and metadata in the
// daemon bundle). Those were fixed at the source; this module is how the
// fix is PROVED, by scanning the real artifacts instead of trusting flags.
//
// Used by:
//   scripts/check-build-paths.mjs    seed check over dist/ (build hygiene)
//   scripts/check-artifact-leaks.mjs the release gate (extends this module)
//
// API (keep it small; callers add policy on top):
//   builderNeedles({ env })  -> [{ label, value }]
//       The identity strings of the machine running the scan, derived at run
//       time, never written down: label "username" (os.userInfo().username,
//       or env SHYN_GATE_USERNAME so tests can use a synthetic name), "home"
//       (os.homedir()) and "checkout" (this repo's root). Empty values and
//       duplicates are dropped.
//   scanDir(root, needles, { maxContext = 60 }) -> [{ file, offset, needle, context }]
//       Walks root (symlinks are NOT followed, so nothing outside root is
//       read and nothing is counted twice), reads every regular file as a
//       Buffer and reports every case-sensitive byte match of every needle.
//       `needles` is an array of strings or { label, value }; `needle` in a
//       hit is the label (or the value, for plain strings). `file` is
//       relative to root; `offset` is the byte offset; `context` is up to
//       maxContext bytes around the match with non-printable bytes shown as
//       "." (binary-safe, one line). A context can contain the needle itself:
//       print it through redact() when output may be shared.
//   scanFile(path, needles, opts) -> hits for one file (file = path as given)
//   redact(text, needles) -> text with each needle value replaced by <label>
//   opts.stats: pass { files: 0, bytes: 0 } to scanDir/scanFile to have it
//       count what was read (callers report "scanned F files, B bytes").
// Needles shorter than a few characters will match random bytes in large
// binaries; the release gate adds its own noise rule on top of these hits.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function builderNeedles({ env = process.env } = {}) {
  const candidates = [
    { label: "username", value: env.SHYN_GATE_USERNAME || userInfo().username },
    { label: "home", value: homedir() },
    { label: "checkout", value: REPO_ROOT },
  ];
  const seen = new Set();
  return candidates.filter(({ value }) => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

const normalize = (needles) =>
  needles.map((n) => (typeof n === "string" ? { label: n, value: n } : n))
    .filter((n) => n.value)
    .map((n) => ({ ...n, bytes: Buffer.from(n.value, "utf8") }));

function contextAt(buf, offset, len, maxContext) {
  const pad = Math.max(0, Math.floor((maxContext - len) / 2));
  const start = Math.max(0, offset - pad);
  const end = Math.min(buf.length, offset + len + pad);
  let s = "";
  for (let i = start; i < end; i++) {
    const b = buf[i];
    s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
  }
  return s;
}

export function scanFile(path, needles, { maxContext = 60, stats, as = path } = {}) {
  const buf = readFileSync(path);
  if (stats) { stats.files++; stats.bytes += buf.length; }
  const hits = [];
  for (const n of normalize(needles)) {
    for (let i = buf.indexOf(n.bytes); i !== -1; i = buf.indexOf(n.bytes, i + 1))
      hits.push({ file: as, offset: i, needle: n.label, context: contextAt(buf, i, n.bytes.length, maxContext) });
  }
  return hits;
}

export function scanDir(root, needles, opts = {}) {
  const hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) hits.push(...scanFile(p, needles, { ...opts, as: relative(root, p) }));
      // symlinks, sockets, fifos: skipped on purpose (see header)
    }
  };
  if (lstatSync(root).isDirectory()) walk(root);
  else hits.push(...scanFile(root, needles, opts));
  return hits;
}

export function redact(text, needles) {
  // longest first, so the home path is replaced before the username inside it
  const ns = normalize(needles).sort((a, b) => b.value.length - a.value.length);
  for (const n of ns) text = text.split(n.value).join(`<${n.label}>`);
  return text;
}
