import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const NAMES = [
  "iconIdleTemplate.png", "iconIdleTemplate@2x.png",
  "iconWarnTemplate.png", "iconWarnTemplate@2x.png",
  "iconRec.png", "iconRec@2x.png",
  "iconBusy.png", "iconBusy@2x.png",
];

describe("gen-icons", () => {
  it("emits valid PNGs at 18/36px with non-empty alpha", () => {
    const dir = mkdtempSync(join(tmpdir(), "shyn-icons-"));
    execFileSync(process.execPath, [join(__dirname, "..", "scripts", "gen-icons.mjs"), dir]);
    for (const name of NAMES) {
      const buf = readFileSync(join(dir, name));
      expect([...buf.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
      const expected = name.includes("@2x") ? 36 : 18;
      expect([width, height]).toEqual([expected, expected]);
      expect(buf.length).toBeGreaterThan(100);   // not a blank/degenerate image
    }
  });
});
