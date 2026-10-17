// Drives scripts/check-build-paths.mjs (and through it the shared scanner
// scripts/lib/artifact-scan.mjs) as a subprocess against SYNTHETIC artifacts
// in a temp dir. The builder's username is injected through
// SHYN_GATE_USERNAME so no real identity appears in this file.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../../../..");
const SCRIPT = join(ROOT, "scripts/check-build-paths.mjs");
const NAME = "builder-zq7";

const run = (args: string[]) => {
  const r = spawnSync("node", [SCRIPT, ...args], {
    cwd: ROOT, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, SHYN_GATE_USERNAME: NAME },
  });
  return { code: r.status, out: r.stdout + r.stderr };
};

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "shyn-buildpaths-"));
  mkdirSync(join(dir, "leaky/bin"), { recursive: true });
  writeFileSync(join(dir, "leaky/bin/shim"), `#!/bin/sh\nexport NODE_PATH="/Users/${NAME}/src/node_modules"\n`);
  // Mach-O-ish blob: the name sits between non-printable bytes
  const blob = Buffer.concat([
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 1]),
    Buffer.from(`/Users/${NAME}/x.o`), Buffer.from([0, 0xff, 0x01]),
  ]);
  writeFileSync(join(dir, "leaky/blob"), blob);
  mkdirSync(join(dir, "clean"));
  writeFileSync(join(dir, "clean/a.txt"), "nothing to see here\n");
  // a symlink to a leaky file outside the scanned root must not be followed
  mkdirSync(join(dir, "linked"));
  symlinkSync(join(dir, "leaky/blob"), join(dir, "linked/blob"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("check-build-paths", () => {
  it("fails on the username in text and binary files, with offsets, without printing it", () => {
    const { code, out } = run([join(dir, "leaky")]);
    expect(code).toBe(1);
    expect(out).toMatch(/hits 2 \{"username":2,/);
    expect(out).toMatch(/bin\/shim\s+x1\s+@\d+\s+.*\/Users\/<username>\/src/);
    expect(out).toMatch(/blob\s+x1\s+@15\s/);
    expect(out).not.toContain(NAME);
    expect(out).toContain("FAIL: 2 hit(s)");
  });

  it("passes a clean tree and reports what it scanned", () => {
    const { code, out } = run([join(dir, "clean")]);
    expect(code).toBe(0);
    expect(out).toMatch(/scanned 1 files, .* hits 0/);
    expect(out).toContain("OK: no builder paths found");
  });

  it("does not follow symlinks out of the scanned tree", () => {
    const { code } = run([join(dir, "linked")]);
    expect(code).toBe(0);
  });

  it("exits 2 on a missing path", () => {
    expect(run([join(dir, "nope")]).code).toBe(2);
  });
});
