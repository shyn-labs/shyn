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
//
// Gate API (async, streaming, used by scripts/check-artifact-leaks.mjs):
//   parseDenylist(text) -> { entries: [{ index, re, reCtx }], badLines: [n] }
//       One regex per non-comment line (case-insensitive, WHOLE WORD: no ASCII
//       letter or digit directly before or after a match; non-ASCII terms are
//       matched as their UTF-8 bytes). A term shorter than 4 characters is
//       never matched inside binary files: always ignored noise. `index` is the
//       entry's position, the only thing the gate ever prints about a term.
//       badLines are 1-based line numbers of invalid regexes (never content).
//   scanTreeRules(root, rules, stats) / scanFileRules(path, rules, stats)
//       rules = { needles, denylist, onHit(hit), delayMs }. Builder needles
//       (case-sensitive bytes) count wherever they occur, text or binary.
//       Denylist regexes match anywhere in text files; in BINARY files (a NUL
//       in the first 8 KiB) a match counts only when it lies inside a run of
//       >= 6 printable ASCII bytes (0x20-0x7e, tab) that contains it, else it
//       is ignored binary noise: counted in stats.noise, never dropped
//       silently. Files are decoded in 16 MiB chunks with a 64 KiB overlap so
//       a match straddling a chunk boundary is still found. Unreadable files
//       are counted in stats.unreadable. hit = { file, offset, kind
//       ("builder"|"denylist"), label, context() } and context() is already
//       sanitized: denylist matches show as <denylist-term-N>, builder values
//       as <label>. stats = { files, bytes, noise, unreadable, noiseFiles:Set,
//       unreadableFiles:[] } (see newStats()).
//   sanitizeText(text, rules) -> text with builder values and denylist matches
//       replaced (use for any file name or message that may be printed).
//       rules.secrets = [{ label, value }] (signing identities found at run
//       time) are replaced by <label> (case-insensitive), and anything shaped
//       like an email address is always replaced by <email>.

import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
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
      else if (e.isFile()) {
        // loop, never hits.push(...arr): spreading a huge array throws RangeError
        for (const h of scanFile(p, needles, { ...opts, as: relative(root, p) })) hits.push(h);
      }
      // symlinks, sockets, fifos: skipped on purpose (see header)
    }
  };
  if (lstatSync(root).isDirectory()) walk(root);
  else for (const h of scanFile(root, needles, opts)) hits.push(h);
  return hits;
}

export function redact(text, needles) {
  // longest first, so the home path is replaced before the username inside it
  const ns = normalize(needles).sort((a, b) => b.value.length - a.value.length);
  for (const n of ns) text = text.split(n.value).join(`<${n.label}>`);
  return text;
}

// ---------------------------------------------------------------------------
// Gate API
// ---------------------------------------------------------------------------

const CHUNK = 16 * 1024 * 1024;
const OVERLAP = 64 * 1024;
const WINDOW = 120;
const RUN_MIN = 6;
const tick = () => new Promise((r) => setImmediate(r));
const isPrint = (b) => (b >= 0x20 && b <= 0x7e) || b === 9;

export const newStats = () => ({
  files: 0, bytes: 0, noise: 0, unreadable: 0, noiseFiles: new Set(), unreadableFiles: [],
});

const WORD_L = "(?<![A-Za-z0-9])";
const WORD_R = "(?![A-Za-z0-9])";

export function parseDenylist(text) {
  const entries = [];
  const badLines = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    try {
      new RegExp(line, "i"); // validate the line as the owner wrote it
      // Files are decoded as latin1 (1 char = 1 byte), so a non-ASCII term is
      // matched as its UTF-8 byte sequence. Whole-word: no ASCII letter or
      // digit directly before or after the match.
      const bare = Buffer.from(line, "utf8").toString("latin1");
      const src = `${WORD_L}(?:${bare})${WORD_R}`;
      entries.push({
        index: entries.length, term: line, short: [...line].length < 4,
        // re: whole-word, decides hits. reCtx: ANY substring, case-insensitive,
        // used only to hide terms in printed text.
        re: new RegExp(src, "gi"), reCtx: new RegExp(bare, "gi"),
      });
    } catch {
      badLines.push(i + 1);
    }
  });
  return { entries, badLines };
}

// Replace builder values and denylist matches in `w`; `own` ({start,end,label})
// is the span of the hit itself. Returns the sanitized text and where `own`
// starts in it.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
function sanitizeSpans(w, own, { needles = [], denylist = [], secrets = [] }) {
  const spans = own ? [{ ...own, first: true }] : [];
  const lw = w.toLowerCase();
  const ci = lw.length === w.length;
  for (const n of normalize(needles)) {
    const v = Buffer.from(n.value, "utf8").toString("latin1");
    const hay = ci ? lw : w;
    const nd = ci ? v.toLowerCase() : v;
    if (nd.length !== v.length) continue;
    for (let i = hay.indexOf(nd); i !== -1; i = hay.indexOf(nd, i + 1))
      spans.push({ start: i, end: i + v.length, label: `<${n.label}>` });
  }
  // signing identities collected at run time (case-insensitive, <label>)
  for (const n of normalize(secrets)) {
    const v = Buffer.from(n.value, "utf8").toString("latin1");
    const hay = ci ? lw : w;
    const nd = ci ? v.toLowerCase() : v;
    if (nd.length !== v.length) continue;
    for (let i = hay.indexOf(nd); i !== -1; i = hay.indexOf(nd, i + 1))
      spans.push({ start: i, end: i + v.length, label: `<${n.label}>` });
  }
  // any email address, always
  for (const m of w.matchAll(EMAIL_RE)) spans.push({ start: m.index, end: m.index + m[0].length, label: "<email>" });
  for (const d of denylist) {
    d.reCtx.lastIndex = 0;
    let m;
    while ((m = d.reCtx.exec(w)) !== null) {
      if (m[0].length === 0) { d.reCtx.lastIndex++; continue; }
      spans.push({ start: m.index, end: m.index + m[0].length, label: `<denylist-term-${d.index}>` });
    }
  }
  spans.sort((a, b) => a.start - b.start || (b.first ? 1 : 0) - (a.first ? 1 : 0) || b.end - a.end);
  let out = "";
  let cursor = 0;
  let q = 0;
  for (const s of spans) {
    // an overlapping span that reaches past the previous one: its tail is
    // covered by the previous label (never left in clear text)
    if (s.start < cursor) { if (s.end > cursor) cursor = s.end; continue; }
    out += w.slice(cursor, s.start);
    if (own && s.first) q = out.length;
    out += s.label;
    cursor = s.end;
  }
  out += w.slice(cursor);
  return { text: out, q };
}

// For file names, messages and paths (JS strings): builder values (any case)
// and any substring occurrence of a denylist term become placeholders.
export function sanitizeText(text, rules) {
  const l = Buffer.from(String(text), "utf8").toString("latin1");
  return Buffer.from(sanitizeSpans(l, null, rules).text, "latin1").toString("utf8");
}

// Names and symlink targets of an extracted tree (never file contents):
// builder values anywhere (exact), denylist terms whole-word. onHit({ file,
// where: "name"|"link", kind, label, termIndex }).
export function scanNames(root, rules, onHit) {
  const { needles = [], denylist = [] } = rules;
  const ns = normalize(needles);
  const check = (file, where, text) => {
    for (const n of ns) if (text.includes(n.value)) onHit({ file, where, kind: "builder", label: n.label });
    const l = Buffer.from(text, "utf8").toString("latin1");
    for (const d of denylist) {
      d.re.lastIndex = 0;
      if (d.re.test(l)) onHit({ file, where, kind: "denylist", label: `denylist-term-${d.index}`, termIndex: d.index });
    }
  };
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      const rel = relative(root, p);
      check(rel, "name", rel);
      if (e.isSymbolicLink()) {
        try { check(rel, "link", readlinkSync(p)); } catch { /* unreadable link: ignore */ }
      } else if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
}

function printableSlice(buf, start, end) {
  let s = "";
  for (let i = start; i < end; i++) s += isPrint(buf[i]) ? String.fromCharCode(buf[i]) : ".";
  return s;
}

function contextFor(buf, off, len, label, rules, maxContext) {
  const ws = Math.max(0, off - WINDOW);
  const we = Math.min(buf.length, off + len + WINDOW);
  const w = printableSlice(buf, ws, we);
  const { text, q } = sanitizeSpans(w, { start: off - ws, end: off - ws + len, label }, rules);
  const from = Math.max(0, q - Math.floor(maxContext / 3));
  return text.slice(from, from + maxContext);
}

function inPrintableRun(buf, start, end) {
  // inside the match itself, UTF-8 bytes of a non-ASCII term count as printable
  for (let i = start; i < end; i++) if (!isPrint(buf[i]) && buf[i] < 0x80) return false;
  let len = end - start;
  for (let i = start - 1; i >= 0 && len < RUN_MIN && isPrint(buf[i]); i--) len++;
  for (let i = end; i < buf.length && len < RUN_MIN && isPrint(buf[i]); i++) len++;
  return len >= RUN_MIN;
}

export async function scanFileRules(path, rules, stats, as = path) {
  const { needles = [], denylist = [], onHit, maxContext = 60 } = rules;
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    stats.unreadable++;
    stats.unreadableFiles.push(as);
    return;
  }
  stats.files++;
  stats.bytes += buf.length;
  const binary = buf.subarray(0, 8192).includes(0);
  const emit = (off, len, kind, label, ownLabel, termIndex) =>
    onHit({ file: as, offset: off, kind, label, termIndex, context: () => contextFor(buf, off, len, ownLabel, rules, maxContext) });

  for (const n of normalize(needles)) {
    for (let i = buf.indexOf(n.bytes); i !== -1; i = buf.indexOf(n.bytes, i + 1))
      emit(i, n.bytes.length, "builder", n.label, `<${n.label}>`);
  }
  if (!denylist.length) return;
  for (let cs = 0; cs < buf.length; cs += CHUNK) {
    const owned = Math.min(CHUNK, buf.length - cs);
    const s = buf.latin1Slice(cs, Math.min(buf.length, cs + CHUNK + OVERLAP));
    for (const d of denylist) {
      d.re.lastIndex = 0;
      let m;
      while ((m = d.re.exec(s)) !== null) {
        if (m.index >= owned) break;
        if (m[0].length === 0) { d.re.lastIndex++; continue; }
        const off = cs + m.index;
        if (binary && (d.short || !inPrintableRun(buf, off, off + m[0].length))) {
          stats.noise++;
          stats.noiseFiles.add(as);
        } else {
          emit(off, m[0].length, "denylist", `denylist-term-${d.index}`, `<denylist-term-${d.index}>`, d.index);
        }
      }
    }
    await tick();
  }
}

export async function scanTreeRules(root, rules, stats) {
  const walk = async (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      stats.unreadable++;
      stats.unreadableFiles.push(relative(root, dir) || ".");
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        if (rules.delayMs) await new Promise((r) => setTimeout(r, rules.delayMs));
        await scanFileRules(p, rules, stats, relative(root, p));
        await tick();
      }
      // symlinks, sockets, fifos: skipped on purpose (see header)
    }
  };
  await walk(root);
}
