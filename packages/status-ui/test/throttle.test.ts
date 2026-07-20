import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldAutoOpen, readThrottle, writeThrottle, readCompletedOnce, writeCompletedOnce,
} from "../src/throttle.js";

const NOW = 1_783_800_000;

describe("onboarding auto-open throttle", () => {
  it("opens when never opened, not within 24h, again after 24h", () => {
    expect(shouldAutoOpen(null, NOW)).toBe(true);
    expect(shouldAutoOpen(NOW - 3600, NOW)).toBe(false);
    expect(shouldAutoOpen(NOW - 86_400, NOW)).toBe(true);
  });

  it("round-trips through the throttle file; missing/corrupt reads as null", () => {
    const p = join(mkdtempSync(join(tmpdir(), "shyn-thr-")), "onboarding-throttle.json");
    expect(readThrottle(p)).toBeNull();
    writeThrottle(p, NOW);
    expect(readThrottle(p)).toBe(NOW);
  });
});

describe("completedOnce marker", () => {
  it("reads false when the file is missing or corrupt", () => {
    const dir = mkdtempSync(join(tmpdir(), "shyn-thr-"));
    const missing = join(dir, "missing.json");
    expect(readCompletedOnce(missing)).toBe(false);

    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{not json");
    expect(readCompletedOnce(corrupt)).toBe(false);
  });

  it("writeCompletedOnce then readCompletedOnce is true", () => {
    const p = join(mkdtempSync(join(tmpdir(), "shyn-thr-")), "onboarding-throttle.json");
    expect(readCompletedOnce(p)).toBe(false);
    writeCompletedOnce(p);
    expect(readCompletedOnce(p)).toBe(true);
  });

  it("writeThrottle after writeCompletedOnce preserves completedOnce", () => {
    const p = join(mkdtempSync(join(tmpdir(), "shyn-thr-")), "onboarding-throttle.json");
    writeCompletedOnce(p);
    writeThrottle(p, NOW);
    expect(readCompletedOnce(p)).toBe(true);
    expect(readThrottle(p)).toBe(NOW);
  });

  it("writeCompletedOnce after writeThrottle preserves lastAutoOpenTs", () => {
    const p = join(mkdtempSync(join(tmpdir(), "shyn-thr-")), "onboarding-throttle.json");
    writeThrottle(p, NOW);
    writeCompletedOnce(p);
    expect(readThrottle(p)).toBe(NOW);
    expect(readCompletedOnce(p)).toBe(true);
  });
});
