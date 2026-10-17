// Drives scripts/check-artifact-leaks.mjs (the release gate) as a subprocess
// against SYNTHETIC artifacts in temp dirs. The builder's username comes from
// SHYN_GATE_USERNAME and the denylist from a temp file via SHYN_LEAK_DENYLIST,
// so no real identity, name or domain appears in this file.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
  chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../../../..");
const SCRIPT = join(ROOT, "scripts/check-artifact-leaks.mjs");
const PREFIX = "shyn-artifact-gate-";
const NAME = "builder-zq7";

let base: string;
let emptyDist: string;
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

const run = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync("node", [SCRIPT, ...args], {
    cwd: ROOT, encoding: "utf8", timeout: 25_000,
    env: { ...process.env, CI: "", SHYN_GATE_USERNAME: NAME, SHYN_LEAK_DENYLIST: D0(), SHYN_DIST_DIR: emptyDist, SHYN_ARTIFACT_ALLOW: join(base, "no-allowlist.txt"), ...env },
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};
const tarOf = (name: string, files: Record<string, Buffer | string>) => {
  const d = mkdtempSync(join(base, "src-"));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), c);
  }
  const out = join(base, name);
  execFileSync("tar", ["-czf", out, "-C", d, "."]);
  return out;
};
const gateDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX));

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "shyn-leakgate-test-"));
  emptyDist = join(base, "empty-dist");
  mkdirSync(emptyDist);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("check-artifact-leaks", () => {
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
      expect(out).toContain("allowlisted: vendor/deps/lib.c x2 (<denylist-term-0>)");
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
      for (const [lines, n] of [[["# c", "**|acme-secret"], "2"], [["*|acme-secret"], "1"], [["vendor/**|not-a-term-xyz"], "1"]] as const) {
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
    execFileSync("tar", ["-czPf", join(work, "esc.tgz"), "-C", join(work, "in/sub"), "../../payload", "f"]);
    execFileSync("tar", ["-czPf", join(work, "abs.tgz"), join(work, "payload")]);
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

  it("SIGINT during a scan cleans up and exits 130", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) files[`f${i}.txt`] = `file ${i}\n`;
    const tb = tarOf("slow.tar.gz", files);
    const before = gateDirs();
    const child = spawn("node", [SCRIPT, "--tarball", tb], {
      cwd: ROOT,
      env: { ...process.env, CI: "", SHYN_GATE_USERNAME: NAME, SHYN_LEAK_DENYLIST: D0(), SHYN_GATE_TEST_DELAY_MS: "300" },
    });
    let out = "";
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("timeout")), 20_000);
        child.stdout.on("data", (d) => {
          out += d;
          if (out.includes("scanning tarball") && !child.killed) child.kill("SIGINT");
        });
        child.on("exit", (c) => { clearTimeout(deadline); resolve(c); });
      });
      expect(code).toBe(130);
      expect(gateDirs()).toEqual(before);
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);
});
