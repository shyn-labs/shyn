// Signing check for every code item of a shipped artifact: who signed it is
// part of what ships. Policy (see RELEASING.md): an allowed identity (default
// "Shyn Dev", no team), a pinned third party (the vendored Node runtime), or an
// ad-hoc signature on a plain file. Identity values are collected as secrets
// before anything about the item is printed.
import { accessSync, constants, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
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

export async function checkSigning(codesign, item, allowed) {
  const problems = [], secrets = [];
  let r;
  try {
    r = await runChild(codesign, ["--verify", "--strict", ...(item.bundle ? ["--deep"] : []), item.path], { timeoutMs: CODESIGN_TIMEOUT_MS });
    if (r.code !== 0) problems.push(`verification failed (codesign exit ${r.code})`);
    r = await runChild(codesign, ["-dvv", item.path], { timeoutMs: CODESIGN_TIMEOUT_MS });
  } catch { return { problems: [...problems, "codesign timed out"], kind: null, secrets }; }
  const text = Buffer.concat([r.stderr, Buffer.from("\n"), r.stdout]).toString("utf8");
  if (r.code !== 0) {
    if (/code object is not signed/.test(text)) return { problems: [...problems, "unsigned"], kind: null, secrets };
    return { problems: [...problems, `cannot read the signature (codesign exit ${r.code})`], kind: null, secrets };
  }
  const lines = text.split("\n").map((l) => l.trim());
  const auth = lines.filter((l) => l.startsWith("Authority=")).map((l) => l.slice(10));
  const teams = lines.filter((l) => l.startsWith("TeamIdentifier=")).map((l) => l.slice(15));
  const adhoc = lines.includes("Signature=adhoc");
  const pinned = auth.length && THIRD_PARTY_SIGNERS.find((s) => s.authority === auth[0] && teams.length === 1 && teams[0] === s.team);
  for (const a of auth) {
    if (allowed.includes(a) || APPLE_CHAIN.includes(a) || (pinned && a === pinned.authority)) continue;
    secrets.push({ label: "signing-authority", value: a });
    for (const m of a.matchAll(EMAIL)) secrets.push({ label: "email", value: m[0] });
  }
  for (const t of teams) if (t !== "not set" && !(pinned && t === pinned.team) && t.length >= 4) secrets.push({ label: "team-id", value: t });
  let kind = null;
  if (adhoc) {
    if (item.bundle) problems.push("ad-hoc bundle");
    else kind = "adhoc";
  } else if (!auth.length) problems.push("no signing authority reported");
  else if (pinned && auth.slice(1).every((a) => APPLE_CHAIN.includes(a))) kind = "third-party";
  else if (auth.length === 1 && allowed.includes(auth[0])) kind = "allowed";
  else problems.push("authority not allowed (<redacted>)");
  if (!teams.length) problems.push("TeamIdentifier not reported");
  else if (teams.some((t) => t !== "not set") && kind !== "third-party") problems.push("TeamIdentifier set (<redacted>)");
  return { problems, kind: problems.length ? null : kind, secrets };
}
