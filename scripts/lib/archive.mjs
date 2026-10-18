// Archive handling for the release gate: list a tar from its own headers,
// refuse entries that could escape or confuse extraction, extract with
// metadata off, and prove the extracted tree equals the listing.
import { spawn } from "node:child_process";
import {
  chmodSync, closeSync, createReadStream, createWriteStream, lstatSync, openSync, readdirSync, readSync, rmSync, statSync,
} from "node:fs";
import { join, relative } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";

export const TAR = "/usr/bin/tar";
export const UNZIP = "/usr/bin/unzip";

export const unsafeName = (n) =>
  n.startsWith("/") || /^[A-Za-z]:/.test(n) || n.split(/[\\/]/).includes("..") || /[\n\r\\]/.test(n);
export const normName = (n) => { while (n.startsWith("./")) n = n.slice(2); return n.replace(/\/+$/, ""); };

// A .tar.gz must be exactly ONE gzip member with nothing after it: Node's gunzip silently ignores trailing
// bytes and decompresses further members, so bytes the scan never sees could ride along. Thrown errors
// with .refuse = true mean "not a single clean gzip member" (the gate refuses the archive).
const refuse = (msg) => Object.assign(new Error(msg), { refuse: true });

// Parses the whole gzip header (no size cap): { name, comment, extra, length }.
export function gzipHeaderFields(gz) {
  const fd = openSync(gz, "r");
  try {
    let buf = Buffer.alloc(0);
    let eof = false;
    const ensure = (n) => {
      while (buf.length < n && !eof) {
        const c = Buffer.alloc(65536);
        const got = readSync(fd, c, 0, c.length, buf.length);
        if (got === 0) eof = true;
        buf = Buffer.concat([buf, c.subarray(0, got)]);
      }
      if (buf.length < n) throw refuse("truncated gzip header");
    };
    ensure(10);
    if (buf[0] !== 0x1f || buf[1] !== 0x8b) throw refuse("not a gzip file");
    if (buf[2] !== 8) throw refuse("gzip compression method is not deflate");
    const flg = buf[3];
    if (flg & 0xe0) throw refuse("gzip header has reserved flag bits set");
    let p = 10;
    let extra = null, name = null, comment = null;
    if (flg & 0x04) { ensure(p + 2); const xlen = buf.readUInt16LE(p); ensure(p + 2 + xlen); extra = Buffer.from(buf.subarray(p + 2, p + 2 + xlen)); p += 2 + xlen; }
    const cstr = () => {
      let e;
      for (;;) { e = buf.indexOf(0, p); if (e >= 0) break; ensure(buf.length + 1); }
      const v = buf.latin1Slice(p, e);
      p = e + 1;
      return v;
    };
    if (flg & 0x08) name = cstr();
    if (flg & 0x10) comment = cstr();
    if (flg & 0x02) { ensure(p + 2); p += 2; } // FHCRC
    return { name, comment, extra, length: p };
  } finally { closeSync(fd); }
}

// Decompresses the single member of `gz` into `out` and proves it was the only thing in the file:
// header + deflate data consumed + 8-byte trailer == file size, and the trailer's CRC32 and ISIZE match.
export async function gunzipToFile(gz, out) {
  const hdr = gzipHeaderFields(gz);
  const size = statSync(gz).size;
  const inflate = zlib.createInflateRaw();
  let crc = 0, isize = 0;
  const tally = new Transform({
    transform(chunk, _enc, cb) { crc = crc32(chunk, crc); isize = (isize + chunk.length) >>> 0; cb(null, chunk); },
  });
  await pipeline(createReadStream(gz, { start: hdr.length }), inflate, tally, createWriteStream(out));
  const end = hdr.length + inflate.bytesWritten;
  if (end + 8 > size) throw refuse("the gzip member has no complete trailer");
  if (end + 8 < size) throw refuse(`${size - end - 8} byte(s) after the gzip member (a second member or trailing data); a .tar.gz must be exactly one gzip member`);
  const t = Buffer.alloc(8);
  const fd = openSync(gz, "r");
  try { readSync(fd, t, 0, 8, end); } finally { closeSync(fd); }
  if (t.readUInt32LE(0) !== crc >>> 0 || t.readUInt32LE(4) !== isize) throw refuse("gzip trailer CRC32/size does not match the data");
}

// zlib.crc32 is Node >= 22.2; a table fallback keeps older 22.x working.
let crcTable;
function crc32(buf, prev) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf, prev);
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const field = (h, off, len) => {
  const s = h.subarray(off, off + len);
  const z = s.indexOf(0);
  return s.toString("utf8", 0, z < 0 ? len : z);
};
const octal = (h, off, len) => parseInt(field(h, off, len).trim() || "0", 8);

function paxRecords(buf) {
  const out = {};
  let p = 0;
  while (p < buf.length) {
    const sp = buf.indexOf(0x20, p);
    if (sp < 0) break;
    const len = parseInt(buf.toString("ascii", p, sp), 10);
    if (!len) break;
    const rec = buf.toString("utf8", sp + 1, p + len - 1);
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    p += len;
  }
  return out;
}

export function listTar(rawPath) {
  const fd = openSync(rawPath, "r");
  const entries = [];
  try {
    const h = Buffer.alloc(512);
    let pos = 0, zeros = 0, pending = {};
    for (;;) {
      if (readSync(fd, h, 0, 512, pos) < 512) break;
      pos += 512;
      if (h.every((x) => x === 0)) { if (++zeros === 2) break; continue; }
      zeros = 0;
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
      if (sum !== octal(h, 148, 8)) throw new Error("corrupt tar header");
      const type = String.fromCharCode(h[156] || 0x30);
      const size = octal(h, 124, 12);
      const body = () => { const b = Buffer.alloc(size); readSync(fd, b, 0, size, pos); return b; };
      if (type === "x") Object.assign(pending, paxRecords(body()));
      else if (type === "g") { /* global pax header: ignored */ }
      else if (type === "L") pending.path = body().toString("utf8").replace(/\0.*$/s, "");
      else if (type === "K") pending.linkpath = body().toString("utf8").replace(/\0.*$/s, "");
      else {
        const prefix = field(h, 345, 155);
        const base = field(h, 0, 100);
        entries.push({
          name: pending.path ?? (prefix ? `${prefix}/${base}` : base),
          type,
          linkname: pending.linkpath ?? field(h, 157, 100),
        });
        pending = {};
      }
      pos += Math.ceil(size / 512) * 512;
    }
  } finally { closeSync(fd); }
  return entries;
}

export function checkTarEntries(entries) {
  const bad = [], dups = [], seen = new Set(), links = new Set();
  for (const e of entries) {
    const k = normName(e.name);
    if (k && k !== ".") { if (seen.has(k)) dups.push(e.name); seen.add(k); }
    if (unsafeName(e.name) || e.type === "3" || e.type === "4" || e.type === "6") bad.push(e.name);
    else if (e.type === "1" && unsafeName(e.linkname)) bad.push(e.name);
    if (e.type === "2") links.add(k);
  }
  if (links.size) {
    for (const e of entries) {
      const parts = normName(e.name).split("/");
      for (let i = 1; i < parts.length; i++) {
        if (links.has(parts.slice(0, i).join("/"))) { bad.push(e.name); break; }
      }
    }
  }
  return { bad, dups };
}

export function checkZipNames(names) {
  const bad = names.filter(unsafeName), dups = [], seen = new Set();
  for (const n of names) {
    const k = normName(n);
    if (seen.has(k)) dups.push(n);
    seen.add(k);
  }
  return { bad, dups };
}

export function compareTree(dest, names) {
  const expected = new Set();
  for (const n of names) {
    const k = normName(n);
    if (!k || k === ".") continue;
    const parts = k.split("/");
    for (let i = 1; i <= parts.length; i++) expected.add(parts.slice(0, i).join("/"));
  }
  const actual = new Set();
  let odd = 0, unreadable = 0;
  const walk = (d) => {
    let es;
    try { es = readdirSync(d, { withFileTypes: true }); } catch { unreadable++; return; }
    for (const e of es) {
      const p = join(d, e.name);
      actual.add(relative(dest, p));
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else if (!e.isFile()) odd++;
    }
  };
  walk(dest);
  const missing = [...expected].filter((x) => !actual.has(x)).length;
  const extra = [...actual].filter((x) => !expected.has(x)).length;
  const problems = [];
  if (missing || extra) problems.push(`extracted tree differs from the listing: ${missing} missing, ${extra} extra`);
  if (odd) problems.push(`${odd} extracted entr${odd === 1 ? "y is" : "ies are"} not a regular file, directory or symlink`);
  if (unreadable) problems.push(`${unreadable} extracted director${unreadable === 1 ? "y" : "ies"} unreadable`);
  return problems;
}

// Child processes are tracked so a signal handler can kill them; a timeout
// kills the child and rejects with Error("timed out").
const live = new Set();
export function runChild(cmd, args, { timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    live.add(p);
    const out = [], err = [];
    let timedOut = false;
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    const t = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, timeoutMs);
    p.on("error", (e) => { clearTimeout(t); live.delete(p); reject(e); });
    p.on("close", (code) => {
      clearTimeout(t); live.delete(p);
      if (timedOut) reject(new Error("timed out"));
      else resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}
export function killChildren() {
  for (const p of live) { try { p.kill("SIGKILL"); } catch { /* already gone */ } }
  live.clear();
}

// Extracted trees can hold read-only directories: chmod every directory (never
// following symlinks) so rmSync can remove them.
function makeWritable(p) {
  let st;
  try { st = lstatSync(p); } catch { return; }
  if (!st.isDirectory()) return;
  try { chmodSync(p, 0o700); } catch { /* best effort */ }
  let names = [];
  try { names = readdirSync(p); } catch { return; }
  for (const n of names) makeWritable(join(p, n));
}
export function forceRm(p) {
  makeWritable(p);
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
}
