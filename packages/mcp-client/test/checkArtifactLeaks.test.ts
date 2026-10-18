// Drives scripts/check-artifact-leaks.mjs (the release gate) as a subprocess
// against SYNTHETIC artifacts in temp dirs. The builder's username comes from
// SHYN_GATE_USERNAME and the denylist from a temp file via SHYN_LEAK_DENYLIST,
// so no real identity, name or domain appears in this file.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
  chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../../../..");
const SCRIPT = join(ROOT, "scripts/check-artifact-leaks.mjs");
const PREFIX = "shyn-artifact-gate-";
const NAME = "builder-zq7";

let base: string;
let emptyDist: string;
let codesignDir: string;
let shimPath: string;
const deny = (name: string, ...terms: string[]) => {
  const p = join(base, name);
  writeFileSync(p, `# synthetic denylist\n${terms.join("\n")}\n`);
  return p;
};
const D0 = () => deny("deny-acme.txt", "acme-secret");

const allow = (name: string, ...lines: string[]) => {
  const p = join(base, name);
  writeFileSync(p, `# synthetic allowlist\n${lines.join("\n")}\n`);
  return p;
};

// The ONE place that builds the environment of every spawned gate process:
// synthetic builder name, temp denylist, temp allowlist. Nothing may fall back
// to the owner's real ~/.config/shyn files (a test below enforces it).
// SHYN_ALLOWED_AUTHORITIES is deliberately NOT set (unset means the default
// "Shyn Dev"); tests that need a value pass it explicitly.
const baseEnv = (extra: Record<string, string> = {}) => ({
  ...process.env, CI: "", SHYN_GATE_USERNAME: NAME, SHYN_LEAK_DENYLIST: D0(),
  SHYN_DIST_DIR: emptyDist, SHYN_ARTIFACT_ALLOW: join(base, "no-allowlist.txt"),
  SHYN_CODESIGN: shimPath, FAKE_CODESIGN_DIR: codesignDir, ...extra,
});

const run = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync("node", [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", timeout: 25_000, env: baseEnv(env) });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};
// bsdtar without AppleDouble (._x) members, which the gate would (rightly) refuse.
const bsdtar = (args: string[]) =>
  execFileSync("/usr/bin/tar", ["--no-mac-metadata", "--no-xattrs", ...args], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
const tarOf = (name: string, files: Record<string, Buffer | string>, { app = true } = {}) => {
  const d = mkdtempSync(join(base, "src-"));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), c);
  }
  if (app) mkdirSync(join(d, "Fake.app"), { recursive: true });
  const out = join(base, name);
  bsdtar(["-czf", out, "-C", d, "."]);
  return out;
};
// Sets the FNAME field of a gzip member (FLG bit 0x08) to `fname`.
const withGzName = (gz: Buffer, fname: string) =>
  Buffer.concat([gz.subarray(0, 3), Buffer.from([gz[3] | 0x08]), gz.subarray(4, 10), Buffer.from(fname + "\0", "latin1"), gz.subarray(10)]);
// Builds a .tar.gz from explicit entries (type: "0" file, "2" symlink, "5" dir, "6" fifo, "3" chr),
// so fifo/device/duplicate entries can be produced without mkfifo or root.
const rawTarOf = (name: string, entries: { name: string; type?: string; body?: string; link?: string }[],
  gzName?: string) => {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? "");
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, "utf8");
    h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write(e.type ?? "0", 156);
    if (e.link) h.write(e.link, 157, 100, "utf8");
    h.write("ustar\0" + "00", 257);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const tar = Buffer.concat(blocks);
  const out = join(base, name);
  writeFileSync(out, gzName === undefined ? gzipSync(tar) : withGzName(gzipSync(tar), gzName));
  return out;
};
const gateDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX));

// Fake codesign: --verify exits FAKE_CODESIGN_VERIFY_RC (default 0); -dvv prints
// $FAKE_CODESIGN_DIR/<basename>.dvv (or default.dvv) to stderr; anything else exits 1.
const SHIM = `#!/bin/sh
for a; do last="$a"; done
case "$1" in
  --verify) exit "\${FAKE_CODESIGN_VERIFY_RC:-0}" ;;
  -dvv) f="$FAKE_CODESIGN_DIR/$(basename "$last").dvv"; [ -f "$f" ] || f="$FAKE_CODESIGN_DIR/default.dvv"; cat "$f" >&2; exit 0 ;;
esac
exit 1
`;
const DVV_SHYN = "Executable=/x\nIdentifier=t\nAuthority=Shyn Dev\nTeamIdentifier=not set\n";
const DVV_ADHOC = "Executable=/x\nIdentifier=t\nSignature=adhoc\nTeamIdentifier=not set\n";
const DVV_NODE = "Executable=/x\nAuthority=Developer ID Application: Node.js Foundation (HX7739G8FX)\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTeamIdentifier=HX7739G8FX\n";
const DVV_PERSONAL = "Executable=/x\nAuthority=Apple Development: sam-zq7@example.com (QQ7ZQ7ZQ7Z)\nAuthority=Apple Worldwide Developer Relations Certification Authority\nAuthority=Apple Root CA\nTeamIdentifier=ZQ7ZQ7ZQ7Q\n";
const MACHO = Buffer.concat([Buffer.from("cffaedfe", "hex"), Buffer.alloc(60)]);
const dvv = (file: string, body: string) => writeFileSync(join(codesignDir, `${file}.dvv`), body);

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "shyn-leakgate-test-"));
  emptyDist = join(base, "empty-dist");
  mkdirSync(emptyDist);
  codesignDir = join(base, "codesign");
  mkdirSync(codesignDir);
  shimPath = join(codesignDir, "codesign");
  writeFileSync(shimPath, SHIM);
  chmodSync(shimPath, 0o755);
  dvv("default", DVV_SHYN);
});
afterEach(() => {
  for (const f of readdirSync(codesignDir)) if (f.endsWith(".dvv")) rmSync(join(codesignDir, f));
  dvv("default", DVV_SHYN);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("check-artifact-leaks", () => {
  it("refuses duplicates, devices, fifos and entries below a symlink", () => {
    const cases = [
      rawTarOf("dup.tar.gz", [{ name: "Fake.app/", type: "5" }, { name: "a.txt", body: "x" }, { name: "./a.txt", body: "y" }]),
      rawTarOf("fifo.tar.gz", [{ name: "Fake.app/", type: "5" }, { name: "p", type: "6" }]),
      rawTarOf("chr.tar.gz", [{ name: "Fake.app/", type: "5" }, { name: "d", type: "3" }]),
      rawTarOf("below.tar.gz", [{ name: "Fake.app/", type: "5" }, { name: "l", type: "2", link: "/tmp" }, { name: "l/x.txt", body: "x" }]),
    ];
    for (const tb of cases) {
      const before = gateDirs();
      const { code, out } = run(["--tarball", tb]);
      expect(code).toBe(1);
      expect(out).toMatch(/refusing tarball/);
      expect(out).not.toMatch(/^scanned /m);
      expect(gateDirs()).toEqual(before);
    }
  });

  it("a tree that differs from the listing is refused (AppleDouble member)", () => {
    const tb = rawTarOf("ad.tar.gz", [{ name: "Fake.app/", type: "5" }, { name: "._a.txt", body: "\x00\x05\x16\x07" }, { name: "a.txt", body: "x" }]);
    const { code, out } = run(["--tarball", tb]);
    expect(code).toBe(1);
    expect(out).toMatch(/extracted tree differs from the listing: \d+ missing, \d+ extra/);
  });

  it("gzip header FNAME with the builder path is a hit, and a denylist term there too", () => {
    const files = [{ name: "Fake.app/", type: "5" }, { name: "a.txt", body: "x\n" }];
    let r = run(["--tarball", rawTarOf("fn1.tar.gz", files, `/Users/${NAME}/x.tar`)]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/tarball-gzip-header/);
    expect(r.out).not.toContain(NAME);
    r = run(["--tarball", rawTarOf("fn2.tar.gz", files, "acme-secret.tar")]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("<denylist-term-0>");
    r = run(["--tarball", rawTarOf("fn3.tar.gz", files, "plain.tar")]);
    expect(r.code).toBe(0);
  });

  it("pax long names are listed and checked", () => {
    const long = "d/".repeat(70) + "f.txt"; // > 100 bytes: bsdtar writes a pax header
    const tb = tarOf("long.tar.gz", { [long]: "acme-secret\n" });
    const { code, out } = run(["--tarball", tb]);
    expect(code).toBe(1);
    expect(out).toContain("<denylist-term-0>");
  });

  it("a zip with duplicate or ../ names is refused", () => {
    // Built by hand: /usr/bin/zip -g replaces instead of adding a second entry.
    const zipOf = (name: string, names: string[]) => {
      const locals: Buffer[] = [], cds: Buffer[] = [];
      let off = 0;
      for (const n of names) {
        const nb = Buffer.from(n), body = Buffer.from("x");
        const crc = 0x8c736521; // crc32("x")
        const l = Buffer.alloc(30);
        l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(10, 4); l.writeUInt32LE(crc, 14);
        l.writeUInt32LE(1, 18); l.writeUInt32LE(1, 22); l.writeUInt16LE(nb.length, 26);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(10, 4); c.writeUInt16LE(10, 6); c.writeUInt32LE(crc, 16);
        c.writeUInt32LE(1, 20); c.writeUInt32LE(1, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
        locals.push(l, nb, body); cds.push(c, nb);
        off += 30 + nb.length + 1;
      }
      const cd = Buffer.concat(cds);
      const e = Buffer.alloc(22);
      e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(names.length, 8); e.writeUInt16LE(names.length, 10);
      e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
      const out = join(base, name);
      writeFileSync(out, Buffer.concat([...locals, cd, e]));
      return out;
    };
    let r = run(["--mcpb", zipOf("dup.mcpb", ["a.txt", "a.txt"])]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/refusing mcpb: .*duplicate/);
    r = run(["--mcpb", zipOf("esc.mcpb", ["a.txt", "../evil.txt"])]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/refusing mcpb: .*escape/);
  });


  it("a clean app plus ad-hoc dylib plus the pinned Node runtime passes, with a signing summary", () => {
    dvv("lib.dylib", DVV_ADHOC); dvv("shynd", DVV_NODE);
    const tb = tarOf("sig-ok.tar.gz", { "Fake.app/Contents/MacOS/Fake": MACHO, "lib.dylib": MACHO, "bin/shynd": MACHO });
    const { code, out } = run(["--tarball", tb]);
    expect(code).toBe(0);
    // Fake.app (bundle) + Fake.app/Contents/MacOS/Fake (default.dvv: Shyn Dev) + lib.dylib + bin/shynd
    expect(out).toMatch(/^signing: 4 code items checked \(2 allowed identity, 1 pinned third party, 1 ad-hoc file\)/m);
    expect(out).toMatch(/^OK: no builder identity, denylist term or disallowed signature in the artifacts/m);
  });

  it("personal identity on a nested dylib fails and prints nothing identifying", () => {
    dvv("lib.dylib", DVV_PERSONAL);
    const tb = tarOf("sig-personal.tar.gz", { "Fake.app/Contents/Frameworks/lib.dylib": MACHO });
    const { code, out } = run(["--tarball", tb]);
    expect(code).toBe(1);
    expect(out).toMatch(/signing: authority not allowed \(<redacted>\)/);
    expect(out).toMatch(/signing: TeamIdentifier set \(<redacted>\)/);
    for (const s of ["sam-zq7", "example.com", "QQ7ZQ7ZQ7Z", "ZQ7ZQ7ZQ7Q", "Apple Development:"]) expect(out).not.toContain(s);
  });

  it("an ad-hoc bundle, an unsigned item, a failed verify and a tarball without an app all fail", () => {
    dvv("Fake.app", DVV_ADHOC);
    expect(run(["--tarball", tarOf("sig-adhoc-app.tar.gz", {})]).out).toMatch(/signing: ad-hoc bundle/);
    dvv("Fake.app", "Executable=/x\n");
    expect(run(["--tarball", tarOf("sig-none.tar.gz", {})]).out).toMatch(/signing: no signing authority reported/);
    dvv("Fake.app", DVV_SHYN);
    const r = run(["--tarball", tarOf("sig-verify.tar.gz", {})], { FAKE_CODESIGN_VERIFY_RC: "3" });
    expect(r.code).toBe(1); expect(r.out).toMatch(/signing: verification failed \(codesign exit 3\)/);
    const n = run(["--tarball", tarOf("sig-noapp.tar.gz", { "a.txt": "x" }, { app: false })]);
    expect(n.code).toBe(1); expect(n.out).toMatch(/no \.app in the tarball/);
  });

  it("a third-party identity that is not pinned fails; a pinned authority with another team fails", () => {
    dvv("x.dylib", DVV_NODE.replace("Node.js Foundation (HX7739G8FX)", "Other Vendor (AB12CD34EF)").replace("TeamIdentifier=HX7739G8FX", "TeamIdentifier=AB12CD34EF"));
    expect(run(["--tarball", tarOf("tp1.tar.gz", { "x.dylib": MACHO })]).code).toBe(1);
    dvv("x.dylib", DVV_NODE.replace("TeamIdentifier=HX7739G8FX", "TeamIdentifier=AB12CD34EF"));
    expect(run(["--tarball", tarOf("tp2.tar.gz", { "x.dylib": MACHO })]).code).toBe(1);
  });

  it("SHYN_ALLOWED_AUTHORITIES: empty is a usage error, a widened list prints a count-only notice", () => {
    for (const v of ["", " ", ",", " , ,"]) expect(run(["--tarball", tarOf("aa.tar.gz", {})], { SHYN_ALLOWED_AUTHORITIES: v }).code).toBe(2);
    dvv("Fake.app", DVV_SHYN.replace("Shyn Dev", "Neutral Test Identity"));
    const r = run(["--tarball", tarOf("aa2.tar.gz", { "a.txt": "x" })], { SHYN_ALLOWED_AUTHORITIES: "Shyn Dev, Neutral Test Identity" });
    expect(r.code).toBe(0);
    expect(r.out.split("\n").filter((l) => l.startsWith("NOTICE: signing"))).toEqual(["NOTICE: signing authorities set by SHYN_ALLOWED_AUTHORITIES (2 entries)"]);
    expect(r.out).not.toContain("Neutral Test Identity");
    // unset: default list is printed, no notice
    const d = run(["--tarball", tarOf("aa3.tar.gz", { "a.txt": "x" })]);
    expect(d.out).toMatch(/^signing: allowed authorities: Shyn Dev$/m);
    expect(d.out).not.toContain("NOTICE: signing");
  });

  it("a missing codesign fails closed; an mcpb without code passes; an mcpb with a personal identity fails", () => {
    expect(run(["--tarball", tarOf("cs.tar.gz", {})], { SHYN_CODESIGN: join(base, "nope") }).code).toBe(1);
    const d = mkdtempSync(join(base, "mcpb-"));
    writeFileSync(join(d, "manifest.json"), "{}\n");
    const clean = join(base, "clean.mcpb");
    execFileSync("zip", ["-qr", clean, "."], { cwd: d });
    const ok = run(["--mcpb", clean]);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/^signing: 0 code items checked \(0 allowed identity, 0 pinned third party, 0 ad-hoc file\)/m);
    writeFileSync(join(d, "lib.dylib"), MACHO);
    dvv("lib.dylib", DVV_PERSONAL);
    const bad = join(base, "code.mcpb");
    execFileSync("zip", ["-qr", bad, "."], { cwd: d });
    const r = run(["--mcpb", bad]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/mcpb:lib\.dylib {2}signing: authority not allowed \(<redacted>\)/);
    expect(r.out).not.toContain("sam-zq7");
  });

  it("an email address anywhere in printed text is redacted", () => {
    // a name hit (builder name inside a file name that also holds an email)
    const r = run(["--tarball", tarOf("mail2.tar.gz", { [`${NAME}-sam@example.com`]: "x" })]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/<email>/);
    expect(r.out).not.toContain("example.com");
    expect(r.out).not.toContain("sam@");
    // a content hit whose printed context holds an email
    const c = run(["--tarball", tarOf("mail3.tar.gz", { "a.txt": "mail sam-zq7@example.com about acme-secret now\n" })]);
    expect(c.code).toBe(1);
    expect(c.out).toContain("<denylist-term-0>");
    expect(c.out).toMatch(/<email>/);
    expect(c.out).not.toContain("example.com");
  });

  it("a content hit next to a signing identity inside a Mach-O prints none of the identity (signing runs before any scan prints)", () => {
    const blob = Buffer.concat([
      MACHO, Buffer.from("Apple Development: sam-zq7@example.com (QQ7ZQ7ZQ7Z)"), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]),
      Buffer.from("ZQ7ZQ7ZQ7Q"), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]), Buffer.from("acme-secret"),
    ]);
    dvv("lib.dylib", DVV_PERSONAL);
    const r = run(["--tarball", tarOf("sig-ctx.tar.gz", { "Fake.app/Contents/Frameworks/lib.dylib": blob })]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("<denylist-term-0>"); // the content hit did fire and print
    for (const x of ["QQ7ZQ7ZQ7Z", "ZQ7ZQ7ZQ7Q", "sam-zq7", "example.com", "Apple Development:"]) expect(r.out).not.toContain(x);
  });

  it("a codesign that cannot be run is not reported as a timeout", () => {
    const noexec = join(base, "codesign-noexec");
    // executable bit passes codesignPath; a bad interpreter makes the spawn itself fail
    writeFileSync(noexec, "#!/nonexistent/interpreter\n"); chmodSync(noexec, 0o755);
    const r = run(["--tarball", tarOf("sig-noexec.tar.gz", {})], { SHYN_CODESIGN: noexec });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/signing: (cannot run codesign \(|verification failed|cannot read the signature)/);
    expect(r.out).not.toContain("codesign timed out");
  });

  it("--help documents the flags and exits 0", () => {
    const { code, out } = run(["--help"]);
    expect(code).toBe(0);
    for (const f of ["--tarball", "--mcpb", "--dir", "--ci", "--show-noise", "SHYN_LEAK_DENYLIST"]) expect(out).toContain(f);
  });

  it("exits 2 with no targets, an unknown flag, or a missing explicit path", () => {
    expect(run([]).code).toBe(2);
    expect(run(["--bogus"]).code).toBe(2);
    expect(run(["--tarball"]).code).toBe(2);
    expect(run(["--tarball", join(base, "nope.tar.gz")]).code).toBe(2);
  });

  it("a text hit fails with offset and context, the term shown as <denylist-term-0>", () => {
    const tb = tarOf("text.tar.gz", { "a/readme.txt": "line one\nsee the acme-secret vendor\n" });
    const { code, out } = run(["--tarball", tb]);
    expect(code).toBe(1);
    // "line one\nsee the " is 17 bytes
    expect(out).toMatch(/tarball:a\/readme\.txt {2}@17 {2}\[denylist-term-0\] {2}.*<denylist-term-0>/);
    expect(out).not.toContain("acme-secret");
    expect(out).toMatch(/scanned 1 files, \S+ MB, hits 1, allowlisted 0, ignored binary noise 0, unreadable 0/);
  });

  it("a binary hit inside a 12-char printable run counts", () => {
    const blob = Buffer.concat([Buffer.from([0xcf, 0xfa, 0, 0xff]), Buffer.from("x-acme-secret"), Buffer.from([0, 1])]);
    const tb = tarOf("bin.tar.gz", { "bin/blob": blob });
    const { code, out } = run(["--tarball", tb]);
    expect(code).toBe(1);
    expect(out).toMatch(/blob {2}@6 /);
    expect(out).toMatch(/hits 1, allowlisted 0, ignored binary noise 0/);
  });

  it("a short term inside 3 coincidental bytes of a binary blob is ignored noise, and counted", () => {
    const dl = deny("deny-short.txt", "zqx");
    const blob = Buffer.from([0, 0xff, 1, 0x7a, 0x71, 0x78, 2, 0xfe, 0]);
    const tb = tarOf("noise.tar.gz", { "bin/blob": blob });
    const { code, out } = run(["--tarball", tb, "--show-noise"], { SHYN_LEAK_DENYLIST: dl });
    expect(code).toBe(0);
    expect(out).toMatch(/hits 0, allowlisted 0, ignored binary noise 1, unreadable 0/);
    expect(out).toContain("ignored binary noise in: bin/blob");
    expect(out).not.toContain("zqx");
  });

  it("the builder username in a binary blob with 4 printable bytes around it is still a hit", () => {
    const blob = Buffer.from([0, 0xff, 0x61, 0x62, 0x7a, 0x71, 0x37, 0x63, 0x64, 1, 0]); // ab zq7 cd
    const tb = tarOf("builder.tar.gz", { "bin/blob": blob });
    const { code, out } = run(["--tarball", tb], { SHYN_GATE_USERNAME: "zq7" });
    expect(code).toBe(1);
    expect(out).toMatch(/blob {2}@4 {2}\[username\] {2}.*ab<username>cd/);
    expect(out).not.toMatch(/zq7/);
  });

  it("matches straddling a 64 MiB offset are found (builder value and denylist term)", () => {
    const dir = mkdtempSync(join(base, "big-"));
    const at = 64 * 1024 * 1024;
    const fd = openSync(join(dir, "big.dat"), "w");
    const chunk = Buffer.alloc(1024 * 1024, 0x2e);
    for (let i = 0; i < 64; i++) writeSync(fd, chunk);
    // a denylist term split across the (chunk-aligned) 64 MiB boundary, and a
    // builder value just before it
    writeSync(fd, Buffer.from("acme-secret"), 0, 11, at - 5);
    writeSync(fd, Buffer.from(NAME), 0, NAME.length, at - 100);
    closeSync(fd);
    const { code, out } = run(["--dir", dir]);
    expect(code).toBe(1);
    expect(out).toContain(`@${at - 5} `);
    expect(out).toContain(`@${at - 100} `);
    expect(out).toContain("[username]");
    expect(out).toContain("[denylist-term-0]");
    expect(out).toMatch(/hits 2, /);
  }, 40_000);

  it("matches whole words only: inside an identifier is no hit; next to _ / . - is a hit", () => {
    const d = mkdtempSync(join(base, "word-"));
    writeFileSync(join(d, "ident.txt"), "myacme-secretly acme-secretive xacme-secret acme-secret9\n");
    expect(run(["--dir", d]).code).toBe(0);
    writeFileSync(join(d, "edge.txt"), "a_acme-secret b/acme-secret.c ACME-SECRET\n");
    const { code, out } = run(["--dir", d]);
    expect(code).toBe(1);
    expect(out).toMatch(/hits 3, /);
  });

  it("a denylist term under 4 characters is never matched in a binary, but is in text", () => {
    const dl = deny("deny-3.txt", "zqx");
    const d = mkdtempSync(join(base, "short-"));
    writeFileSync(join(d, "b.bin"), Buffer.concat([Buffer.from([0, 1]), Buffer.from("long printable run zqx and more"), Buffer.from([0])]));
    const a = run(["--dir", d], { SHYN_LEAK_DENYLIST: dl });
    expect(a.code).toBe(0);
    expect(a.out).toMatch(/hits 0, allowlisted 0, ignored binary noise 1, /);
    writeFileSync(join(d, "t.txt"), "see zqx here\n");
    expect(run(["--dir", d], { SHYN_LEAK_DENYLIST: dl }).code).toBe(1);
  });

  it("a non-ASCII denylist term matches as UTF-8 in text and binary files", () => {
    const dl = deny("deny-utf8.txt", "caf\u00e9-geheim");
    const d = mkdtempSync(join(base, "utf8-"));
    writeFileSync(join(d, "t.txt"), "the caf\u00e9-geheim file\n");
    writeFileSync(join(d, "b.bin"), Buffer.concat([Buffer.from([0, 1]), Buffer.from("xx caf\u00e9-geheim xx"), Buffer.from([0])]));
    const { code, out } = run(["--dir", d], { SHYN_LEAK_DENYLIST: dl });
    expect(code).toBe(1);
    expect(out).toMatch(/hits 2, /);
    expect(out).not.toContain("geheim");
  });

  describe("owner allowlist", () => {
    const setup = () => {
      const d = mkdtempSync(join(base, "al-"));
      mkdirSync(join(d, "vendor/deps"), { recursive: true });
      writeFileSync(join(d, "vendor/deps/lib.c"), "/* acme-secret */\n/* acme-secret */\n");
      return d;
    };
    it("a matching entry is reported, not a failure", () => {
      const d = setup();
      const { code, out } = run(["--dir", d], { SHYN_ARTIFACT_ALLOW: allow("al1.txt", "vendor/**/lib.c|ACME-secret") });
      expect(code).toBe(0);
      expect(out).toContain("allowlisted: dir:vendor/deps/lib.c x2 (<denylist-term-0>)");
      expect(out).toContain("scanned 1 files, 0.0 MB, hits 0, allowlisted 2, ignored binary noise 0, unreadable 0");
    });
    it("an entry for a different file still leaves a hit", () => {
      const d = setup();
      const { code, out } = run(["--dir", d], { SHYN_ARTIFACT_ALLOW: allow("al2.txt", "vendor/deps/other.c|acme-secret") });
      expect(code).toBe(1);
      expect(out).toMatch(/hits 2, allowlisted 0/);
    });
    it("rejects a bare ** or *, and a term that is not in the denylist (line number only)", () => {
      const d = setup();
      for (const [lines, n] of [[["# c", "**|acme-secret"], "2"], [["*|acme-secret"], "1"], [["vendor/**|not-a-term-xyz"], "1"], [["vendor/deps/*.c|acme-secret"], "1"], [["vendor/**/**|acme-secret"], "1"]] as const) {
        const { code, out } = run(["--dir", d], { SHYN_ARTIFACT_ALLOW: allow("al3.txt", ...lines) });
        expect(code).toBe(1);
        expect(out).toContain(`line(s): ${Number(n) + 1}`);
        expect(out).not.toContain("not-a-term-xyz");
      }
    });
    it("an absent allowlist file has no effect", () => {
      expect(run(["--dir", setup()]).code).toBe(1);
    });
  });

  it("every spawned process gets the synthetic env from baseEnv (no fallback to ~/.config/shyn)", () => {
    const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const spawns = src.match(/\bspawn(Sync)?\(\s*"node"/g) ?? [];
    const withEnv = src.match(/\bspawn(Sync)?\(\s*"node"[^;]*?env: baseEnv\(/g) ?? [];
    expect(spawns.length).toBeGreaterThan(0);
    expect(withEnv.length).toBe(spawns.length);
    for (const k of ["SHYN_GATE_USERNAME", "SHYN_LEAK_DENYLIST", "SHYN_ARTIFACT_ALLOW", "SHYN_CODESIGN"]) expect((baseEnv() as Record<string, string>)[k]).toBeTruthy();
    expect((baseEnv() as Record<string, string>).SHYN_CODESIGN.startsWith(base + "/")).toBe(true);
    expect((baseEnv({}) as Record<string, string | undefined>).SHYN_ALLOWED_AUTHORITIES).toBe(process.env.SHYN_ALLOWED_AUTHORITIES);
  });

  it("an owner name in a tar header is found by the raw-stream scan", () => {
    const d = mkdtempSync(join(base, "own-"));
    writeFileSync(join(d, "a.txt"), "nothing\n");
    const tb = join(base, "owner.tar.gz");
    bsdtar(["--uname", NAME, "--gname", "staff", "-czf", tb, "-C", d, "."]);
    const { code, out } = run(["--tarball", tb]);
    expect(code).toBe(1);
    expect(out).toMatch(/tarball-raw:raw stream {2}@\d+ {2}\[username\]/);
    expect(out).not.toContain(NAME);
  });

  it("a symlink target containing the username is a link: hit; a denylist term in a directory name is a name: hit", () => {
    const d = mkdtempSync(join(base, "lnk-"));
    writeFileSync(join(d, "a.txt"), "nothing\n");
    symlinkSync(`/Users/${NAME}/x`, join(d, "dangling"));
    mkdirSync(join(d, "dir-acme-secret"));
    writeFileSync(join(d, "dir-acme-secret/b.txt"), "clean\n");
    const tb = join(base, "links.tar.gz");
    bsdtar(["-czf", tb, "-C", d, "."]);
    const { code, out } = run(["--tarball", tb]);
    expect(code).toBe(1);
    expect(out).toMatch(/tarball:dangling {2}link: {2}\[username\]/);
    expect(out).toMatch(/tarball:dir-<denylist-term-0> {2}name: {2}\[denylist-term-0\]/);
    expect(out).not.toContain(NAME);
    expect(out).not.toContain("acme-secret");
  });

  it("a zip entry name containing the username is a hit", () => {
    const d = mkdtempSync(join(base, "zn-"));
    writeFileSync(join(d, `${NAME}.txt`), "x\n");
    const mcpb = join(base, "named.mcpb");
    execFileSync("zip", ["-qr", mcpb, "."], { cwd: d });
    const { code, out } = run(["--mcpb", mcpb]);
    expect(code).toBe(1);
    expect(out).toMatch(/<username>\.txt {2}name:/);
    expect(out).not.toContain(NAME);
  });

  it("an empty denylist fails like a missing one; --ci passes with the notice", () => {
    const dl = deny("deny-empty.txt");
    const tb = tarOf("clean5.tar.gz", { "a.txt": "x\n" });
    const a = run(["--tarball", tb], { SHYN_LEAK_DENYLIST: dl });
    expect(a.code).toBe(1);
    expect(a.out).toContain("no active terms");
    const b = run(["--tarball", tb, "--ci"], { SHYN_LEAK_DENYLIST: dl });
    expect(b.code).toBe(0);
    expect(b.out).toContain("no active terms (--ci)");
  });

  it("an archive with zero files fails, even with --ci", () => {
    const d = mkdtempSync(join(base, "emptyar-"));
    const tb = join(base, "empty.tar.gz");
    bsdtar(["-czf", tb, "-C", d, "."]);
    expect(run(["--tarball", tb]).code).toBe(1);
    const r = run(["--tarball", tb, "--ci"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("scanned 0 files");
  });

  it("hides builder values and denylist substrings everywhere it prints (contexts, names, errors)", () => {
    const d = mkdtempSync(join(base, "hyg-"));
    writeFileSync(join(d, "t.txt"), "acme-secret next to xAcme-SecretLy and acme-secret\n");
    const a = run(["--dir", d]);
    expect(a.code).toBe(1);
    expect(a.out.toLowerCase()).not.toContain("acme-secret");
    const m = run(["--tarball", join(base, `missing-${NAME}-ACME-secret.tar.gz`)]);
    expect(m.code).toBe(2);
    expect(m.out).not.toContain(NAME);
    expect(m.out).toContain("<username>");
  });

  it("a clean tarball exits 0 with exact counts in the summary line", () => {
    const tb = tarOf("clean.tar.gz", { "a.txt": "nothing\n", "d/b.txt": "to see\n", "d/e/c.bin": Buffer.from([0, 1, 2, 3]) });
    const { code, out } = run(["--tarball", tb]);
    expect(code).toBe(0);
    expect(out).toContain("scanned 3 files, 0.0 MB, hits 0, allowlisted 0, ignored binary noise 0, unreadable 0");
    expect(out).toContain("builder needles used: username, home, checkout");
    expect(out).toContain("denylist: 1 term(s)");
  });

  it("refuses a tarball with a ../ or absolute entry and writes nothing outside the temp dir", () => {
    const work = mkdtempSync(join(base, "esc-"));
    mkdirSync(join(work, "in/sub"), { recursive: true });
    writeFileSync(join(work, "in/sub/f"), "hi");
    writeFileSync(join(work, "payload"), "escaped");
    bsdtar(["-czPf", join(work, "esc.tgz"), "-C", join(work, "in/sub"), "../../payload", "f"]);
    bsdtar(["-czPf", join(work, "abs.tgz"), join(work, "payload")]);
    for (const f of ["esc.tgz", "abs.tgz"]) {
      const before = readdirSync(work).sort();
      const { code, out } = run(["--tarball", join(work, f)]);
      expect(code).toBe(1);
      expect(out).toContain("refusing tarball");
      expect(readdirSync(work).sort()).toEqual(before);
      expect(existsSync(join(work, "in/payload"))).toBe(false);
    }
  });

  it("a hit inside a zip .mcpb is reported", () => {
    const d = mkdtempSync(join(base, "zip-"));
    mkdirSync(join(d, "server"));
    writeFileSync(join(d, "server/index.js"), `const x = "${NAME}";\n`);
    writeFileSync(join(d, "manifest.json"), "{}\n");
    const mcpb = join(base, "x.mcpb");
    execFileSync("zip", ["-qr", mcpb, "."], { cwd: d });
    const { code, out } = run(["--mcpb", mcpb]);
    expect(code).toBe(1);
    expect(out).toMatch(/mcpb:server\/index\.js {2}@\d+ {2}\[username\]/);
    expect(out).toMatch(/scanned 2 files/);
  });

  it("an unreadable file is reported and fails the run", () => {
    if (process.getuid?.() === 0) return;
    const d = mkdtempSync(join(base, "unread-"));
    writeFileSync(join(d, "ok.txt"), "fine\n");
    writeFileSync(join(d, "locked.txt"), "x\n");
    chmodSync(join(d, "locked.txt"), 0o000);
    const { code, out } = run(["--dir", d]);
    chmodSync(join(d, "locked.txt"), 0o644);
    expect(code).toBe(1);
    expect(out).toMatch(/hits 0, allowlisted 0, ignored binary noise 0, unreadable 1/);
    expect(out).toContain("unreadable: locked.txt");
  });

  it("a missing denylist fails without --ci; --ci passes and says only builder checks ran", () => {
    const tb = tarOf("clean2.tar.gz", { "a.txt": "nothing\n" });
    const missing = { SHYN_LEAK_DENYLIST: join(base, "no-such-denylist.txt") };
    const a = run(["--tarball", tb], missing);
    expect(a.code).toBe(1);
    expect(a.out).toContain("denylist missing");
    const b = run(["--tarball", tb, "--ci"], missing);
    expect(b.code).toBe(0);
    expect(b.out).toContain("only the remaining builder checks ran");
    expect(b.out).toContain("builder needles used: checkout");
  });

  it("an invalid denylist regex fails naming the line, not the content", () => {
    const dl = deny("deny-bad.txt", "fine-term", "bad(secret-regex");
    const tb = tarOf("clean3.tar.gz", { "a.txt": "nothing\n" });
    const { code, out } = run(["--tarball", tb], { SHYN_LEAK_DENYLIST: dl });
    expect(code).toBe(1);
    expect(out).toContain("line(s): 3");
    expect(out).not.toContain("secret-regex");
  });

  it("removes its temp extraction dir on success and on failure", () => {
    const before = gateDirs();
    run(["--tarball", tarOf("c4.tar.gz", { "a.txt": "x\n" })]);
    run(["--tarball", tarOf("h4.tar.gz", { "a.txt": "acme-secret\n" })]);
    expect(gateDirs()).toEqual(before);
  });

  for (const [sig, code] of [["SIGINT", 130], ["SIGHUP", 129], ["SIGQUIT", 131], ["SIGTERM", 143]] as const) {
    it(`${sig} during a scan cleans up and exits ${code}`, async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 40; i++) files[`f${i}.txt`] = `file ${i}\n`;
      const tb = tarOf(`slow-${sig}.tar.gz`, files);
      const before = gateDirs();
      const child = spawn("node", [SCRIPT, "--tarball", tb], { cwd: ROOT, env: baseEnv({ SHYN_GATE_TEST_DELAY_MS: "300" }) });
      let out = "";
      try {
        const got = await new Promise<number | null>((resolve, reject) => {
          const deadline = setTimeout(() => reject(new Error("timeout")), 20_000);
          child.stdout.on("data", (d) => { out += d; if (out.includes("scanning tarball") && !child.killed) child.kill(sig); });
          child.on("exit", (c) => { clearTimeout(deadline); resolve(c); });
        });
        expect(got).toBe(code);
        expect(gateDirs()).toEqual(before);
      } finally { child.kill("SIGKILL"); }
    }, 30_000);
  }

  it("removes a temp dir holding read-only extracted directories", () => {
    const d = mkdtempSync(join(base, "ro-"));
    mkdirSync(join(d, "Fake.app")); mkdirSync(join(d, "locked")); writeFileSync(join(d, "locked", "a.txt"), "x");
    chmodSync(join(d, "locked"), 0o555);
    const tb = join(base, "ro.tar.gz");
    bsdtar(["-czf", tb, "-C", d, "."]);
    chmodSync(join(d, "locked"), 0o755);
    const before = gateDirs();
    run(["--tarball", tb]);
    expect(gateDirs()).toEqual(before);
  });

  it("a signal while the extraction child runs kills it and cleans up", async () => {
    // the hook keeps the extraction child alive (sleep, then exec tar) so the signal lands on a live child
    const tb = tarOf("child.tar.gz", { "a.txt": "x\n" });
    const before = gateDirs();
    const child = spawn("node", [SCRIPT, "--tarball", tb], { cwd: ROOT, env: baseEnv({ SHYN_GATE_TEST_DELAY_MS: "3000" }) });
    let out = "";
    try {
      const got = await new Promise<number | null>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("timeout")), 20_000);
        child.stdout.on("data", (d) => {
          out += d;
          if (out.includes("extracting tarball") && !child.killed) {
            // give the child a moment to be spawned, and prove it is alive before signalling
            setTimeout(() => {
              const alive = spawnSync("pgrep", ["-f", `${PREFIX}.*tarball.raw.tar`]).status === 0;
              if (!alive) { reject(new Error("extraction child was not running")); return; }
              child.kill("SIGHUP");
            }, 300);
          }
        });
        child.on("exit", (c) => { clearTimeout(deadline); resolve(c); });
      });
      expect(got).toBe(129);
      expect(gateDirs()).toEqual(before);
      expect(spawnSync("pgrep", ["-f", `${PREFIX}.*tarball.raw.tar`]).status).not.toBe(0);
    } finally { child.kill("SIGKILL"); }
  }, 30_000);
});
