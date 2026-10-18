// Archive handling for the release gate: list a tar from its own headers,
// refuse entries that could escape or confuse extraction, extract with
// metadata off, and prove the extracted tree equals the listing.
import { closeSync, createReadStream, createWriteStream, openSync, readdirSync, readSync } from "node:fs";
import { join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

export const TAR = "/usr/bin/tar";
export const UNZIP = "/usr/bin/unzip";

export const unsafeName = (n) =>
  n.startsWith("/") || /^[A-Za-z]:/.test(n) || n.split(/[\\/]/).includes("..") || /[\n\r\\]/.test(n);
export const normName = (n) => { while (n.startsWith("./")) n = n.slice(2); return n.replace(/\/+$/, ""); };

export async function gunzipToFile(gz, out) {
  await pipeline(createReadStream(gz), createGunzip(), createWriteStream(out));
}

export function gzipHeaderFields(gz) {
  const fd = openSync(gz, "r");
  try {
    const head = Buffer.alloc(65536);
    const n = readSync(fd, head, 0, head.length, 0);
    const b = head.subarray(0, n);
    if (b.length < 10 || b[0] !== 0x1f || b[1] !== 0x8b) throw new Error("not a gzip file");
    const flg = b[3];
    let p = 10;
    let extra = null, name = null, comment = null;
    if (flg & 0x04) { const xlen = b.readUInt16LE(p); extra = b.subarray(p + 2, p + 2 + xlen); p += 2 + xlen; }
    const cstr = () => {
      const e = b.indexOf(0, p);
      const s = b.latin1Slice(p, e < 0 ? b.length : e);
      p = e < 0 ? b.length : e + 1;
      return s;
    };
    if (flg & 0x08) name = cstr();
    if (flg & 0x10) comment = cstr();
    return { name, comment, extra };
  } finally { closeSync(fd); }
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
