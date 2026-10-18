// Signing check for every code item of a shipped artifact: who signed it is
// part of what ships. Policy (see RELEASING.md): an allowed identity (default
// "Shyn Dev", no team), a pinned third party (the vendored Node runtime), or an
// ad-hoc signature on a plain file. Identity values are collected as secrets
// before anything about the item is printed.
import { accessSync, constants, openSync, readSync, closeSync, readdirSync, readFileSync, rmSync, mkdtempSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { runChild } from "./archive.mjs";

export const BUNDLE_SUFFIXES = [".app", ".framework", ".xpc", ".appex", ".bundle", ".plugin", ".kext", ".systemextension"];
export const MACHO_MAGICS = new Set(["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);
export const THIRD_PARTY_SIGNERS = [{ authority: "Developer ID Application: Node.js Foundation (HX7739G8FX)", team: "HX7739G8FX" }];
export const APPLE_CHAIN = ["Developer ID Certification Authority", "Apple Root CA"];
const CODESIGN_TIMEOUT_MS = 120_000;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

const isBundleName = (n) => BUNDLE_SUFFIXES.some((s) => n.toLowerCase().endsWith(s));

export function discoverCode(root) {
  const items = [], problems = [];
  let apps = 0;
  const walk = (d) => {
    let es;
    try { es = readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)); } catch { return; }
    for (const e of es) {
      const p = join(d, e.name), rel = relative(root, p);
      if (e.isSymbolicLink()) { if (isBundleName(e.name)) problems.push({ rel, reason: "bundle is a symlink" }); continue; }
      if (e.isDirectory()) {
        if (isBundleName(e.name)) { items.push({ path: p, rel, bundle: true }); if (e.name.toLowerCase().endsWith(".app")) apps++; }
        walk(p);
      } else if (e.isFile()) {
        let fd;
        try { fd = openSync(p, "r"); const b = Buffer.alloc(4); const n = readSync(fd, b, 0, 4, 0); if (n === 4 && MACHO_MAGICS.has(b.toString("hex"))) items.push({ path: p, rel, bundle: false }); }
        catch { /* unreadable: counted by the content scan */ } finally { if (fd !== undefined) closeSync(fd); }
      }
    }
  };
  walk(root);
  return { items, problems, apps };
}

export function codesignPath(env) {
  const p = env.SHYN_CODESIGN || "/usr/bin/codesign";
  try { if (!statSync(p).isFile()) throw new Error(); accessSync(p, constants.X_OK); }
  catch { throw new Error("codesign not found: the signing check cannot run, failing closed"); }
  return p;
}

export function allowedAuthorities(env) {
  if (env.SHYN_ALLOWED_AUTHORITIES === undefined) return ["Shyn Dev"];
  const list = env.SHYN_ALLOWED_AUTHORITIES.split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Error("SHYN_ALLOWED_AUTHORITIES has no entries");
  return list;
}

export const FAT_MAGICS = new Set(["cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);

export function lipoPath(env) {
  return env.SHYN_LIPO || "/usr/bin/lipo";
}

// nfat_arch of a universal (fat) Mach-O, or null for a thin file.
function fatSliceCount(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const b = Buffer.alloc(8);
    if (readSync(fd, b, 0, 8, 0) < 4) return null;
    const magic = b.toString("hex", 0, 4);
    if (!FAT_MAGICS.has(magic)) return null;
    return magic === "cafebabe" || magic === "cafebabf" ? b.readUInt32BE(4) : b.readUInt32LE(4);
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

// Printable ASCII DER string fields (UTF8String, PrintableString, T61String, IA5String; short form, >= 4 chars).
export function derStrings(der) {
  const out = [];
  for (let i = 0; i + 2 < der.length; i++) {
    const n = der[i + 1];
    if ([0x0c, 0x13, 0x14, 0x16].includes(der[i]) && n < 0x80 && n >= 4 && i + 2 + n <= der.length) {
      const v = der.subarray(i + 2, i + 2 + n);
      if (v.every((c) => c >= 0x20 && c < 0x7f)) out.push(v.toString("latin1"));
    }
  }
  return out;
}

const childFailure = (tool, e) =>
  (e?.message === "timed out" ? `${tool} timed out` : `cannot run ${tool} (${String(e?.code || e?.message || "error").split("\n")[0]})`);

// Every string field of the leaf certificate (name, organisation, team, UID): secrets, never printed. Best effort.
async function leafCertificateFields(codesign, path, arch, workDir) {
  if (!workDir) return [];
  let d;
  try {
    d = mkdtempSync(join(workDir, "certs-"));
    await runChild(codesign, ["-d", ...arch, `--extract-certificates=${join(d, "cert-")}`, path], { timeoutMs: CODESIGN_TIMEOUT_MS });
    return derStrings(readFileSync(join(d, "cert-0")));
  } catch { return []; } finally { if (d) rmSync(d, { recursive: true, force: true }); }
}

// One signature: the item itself, or one slice (arch) of a universal file.
async function checkSlice(codesign, item, allowed, arch, workDir) {
  const problems = [], secrets = [];
  const a = arch ? ["-a", arch] : [];
  let r;
  try {
    r = await runChild(codesign, ["--verify", "--strict", ...(item.bundle ? ["--deep"] : []), ...a, item.path], { timeoutMs: CODESIGN_TIMEOUT_MS });
    if (r.code !== 0) problems.push(`verification failed (codesign exit ${r.code})`);
    r = await runChild(codesign, ["-dvv", ...a, item.path], { timeoutMs: CODESIGN_TIMEOUT_MS });
  } catch (e) {
    // only a real timeout is called one; anything else (spawn EACCES, ...) is a failure to run
    return { problems: [...problems, childFailure("codesign", e)], kind: null, secrets };
  }
  const text = Buffer.concat([r.stderr, Buffer.from("\n"), r.stdout]).toString("utf8");
  if (r.code !== 0) {
    if (/code object is not signed/.test(text)) return { problems: [...problems, "unsigned"], kind: null, secrets };
    return { problems: [...problems, `cannot read the signature (codesign exit ${r.code})`], kind: null, secrets };
  }
  const lines = text.split("\n").map((l) => l.trim());
  const auth = lines.filter((l) => l.startsWith("Authority=")).map((l) => l.slice(10));
  const teams = lines.filter((l) => l.startsWith("TeamIdentifier=")).map((l) => l.slice(15));
  const adhoc = lines.includes("Signature=adhoc");
  // pinned: exactly leaf + the Developer ID chain, in order, and the one team
  const pinned = THIRD_PARTY_SIGNERS.find((s) => auth.length === 1 + APPLE_CHAIN.length && auth[0] === s.authority
    && APPLE_CHAIN.every((c, i) => auth[i + 1] === c) && teams.length === 1 && teams[0] === s.team);
  for (const x of auth) {
    if (allowed.includes(x) || APPLE_CHAIN.includes(x) || (pinned && x === pinned.authority)) continue;
    secrets.push({ label: "signing-authority", value: x });
    for (const m of x.matchAll(EMAIL)) secrets.push({ label: "email", value: m[0] });
    // pieces too, so a CN cut off at a context-window edge is still redacted
    const id = x.match(/\(([^()]+)\)\s*$/);
    if (id && id[1].length >= 4) secrets.push({ label: "signing-id", value: id[1] });
    const tail = x.includes(": ") ? x.slice(x.indexOf(": ") + 2).trim() : "";
    if (tail.length >= 4) secrets.push({ label: "signing-authority", value: tail });
    // the bare name: the tail without its trailing " (ID)"
    const bare = tail.replace(/\s*\([^()]*\)\s*$/, "").trim();
    if (bare.length >= 4 && bare !== tail) secrets.push({ label: "signing-authority", value: bare });
  }
  for (const t of teams) if (t !== "not set" && !(pinned && t === pinned.team) && t.length >= 4) secrets.push({ label: "team-id", value: t });
  if (!adhoc && auth.length) {
    for (const v of await leafCertificateFields(codesign, item.path, a, workDir)) {
      if (!allowed.includes(v)) secrets.push({ label: "cert-field", value: v });
    }
  }
  let kind = null;
  if (adhoc) {
    if (item.bundle) problems.push("ad-hoc bundle");
    else kind = "adhoc";
  } else if (!auth.length) problems.push("no signing authority reported");
  else if (pinned) {
    kind = "third-party";
    // the chain strings alone could come from a self-signed lookalike: codesign must also prove the Apple anchor
    const req = `-R=anchor apple generic and certificate leaf[subject.OU] = "${pinned.team}"`;
    try {
      const v = await runChild(codesign, ["--verify", "--strict", ...(item.bundle ? ["--deep"] : []), ...a, req, item.path], { timeoutMs: CODESIGN_TIMEOUT_MS });
      if (v.code !== 0) problems.push(`pinned third party does not satisfy its Apple anchor requirement (codesign exit ${v.code})`);
    } catch (e) { problems.push(childFailure("codesign", e)); }
  } else if (auth.length === 1 && allowed.includes(auth[0])) kind = "allowed";
  else problems.push("authority not allowed (<redacted>)");
  if (!teams.length) problems.push("TeamIdentifier not reported");
  else if (teams.some((t) => t !== "not set") && kind !== "third-party") problems.push("TeamIdentifier set (<redacted>)");
  return { problems, kind: problems.length ? null : kind, secrets };
}

// A universal (fat) file is checked slice by slice (codesign -dvv alone shows only the native slice): every
// slice must pass, and every slice's identity values are secrets. opts: { lipo, workDir }.
export async function checkSigning(codesign, item, allowed, { lipo = "/usr/bin/lipo", workDir } = {}) {
  let archs = [null];
  const nfat = item.bundle ? null : fatSliceCount(item.path);
  if (nfat !== null) {
    let r;
    try { r = await runChild(lipo, ["-archs", item.path], { timeoutMs: CODESIGN_TIMEOUT_MS }); }
    catch (e) { return { problems: [`cannot list the architectures: ${childFailure("lipo", e)}`], kind: null, secrets: [] }; }
    const list = r.code === 0 ? r.stdout.toString("utf8").trim().split(/\s+/).filter(Boolean) : [];
    if (!list.length) return { problems: [`cannot list the architectures (lipo exit ${r.code})`], kind: null, secrets: [] };
    if (list.length !== nfat) {
      return { problems: [`architecture list does not match the fat header (${list.length} listed, ${nfat} in the header)`], kind: null, secrets: [] };
    }
    archs = list;
  }
  const problems = [], secrets = [], kinds = new Set();
  for (const arch of archs) {
    const res = await checkSlice(codesign, item, allowed, arch, workDir);
    secrets.push(...res.secrets);
    for (const p of res.problems) problems.push(arch ? `${p} [slice ${arch}]` : p);
    kinds.add(res.kind);
  }
  if (!problems.length && kinds.size > 1) problems.push("slices are signed differently");
  const seen = new Set();
  const unique = secrets.filter((x) => !seen.has(x.value) && seen.add(x.value));
  return { problems, kind: problems.length ? null : [...kinds][0], secrets: unique };
}
