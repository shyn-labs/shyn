import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pauseCapture, resumeCapture, addExclude, parseDuration } from "../src/capture-config.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "shyn-cc-")), "capture.json");

describe("capture config commands", () => {
  it("parseDuration handles 30m / 2h / until-tomorrow", () => {
    expect(parseDuration("30m", 0)).toBe(1800);
    expect(parseDuration("2h", 0)).toBe(7200);
    // until-tomorrow = next local midnight; assert it lands in (0, 24h]
    const d = parseDuration("until-tomorrow", Math.floor(Date.now() / 1000));
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(86400);
    expect(() => parseDuration("soon", 0)).toThrow();
  });

  it("pause writes pausedUntil; resume clears it; unknown keys survive", () => {
    const p = tmp();
    writeFileSync(p, JSON.stringify({ retentionDays: 14, futureKey: true }));
    pauseCapture(p, "30m", 1000);
    let cfg = JSON.parse(readFileSync(p, "utf8"));
    expect(cfg.pausedUntil).toBe(1000 + 1800);
    expect(cfg.retentionDays).toBe(14);
    expect(cfg.futureKey).toBe(true);
    resumeCapture(p);
    cfg = JSON.parse(readFileSync(p, "utf8"));
    expect(cfg.pausedUntil).toBeUndefined();
  });

  it("exclude rejects an invalid title regex instead of silently failing open", () => {
    const p = tmp();
    writeFileSync(p, JSON.stringify({ excludeTitlePatterns: [] }));
    expect(() => addExclude(p, "Salary [Confidential")).toThrow(/invalid title regex/i);
    // nothing persisted — the bad pattern must not land as a dead exclude
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    expect(cfg.excludeTitlePatterns).not.toContain("Salary [Confidential");
  });

  it("exclude appends bundle ids vs title regexes by shape, deduped", () => {
    const p = tmp();
    addExclude(p, "com.spotify.client");        // dotted, no spaces → bundle id
    addExclude(p, "com.spotify.client");
    addExclude(p, "secret project");            // anything else → title pattern
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    expect(cfg.excludeBundleIds).toEqual(["com.spotify.client"]);
    expect(cfg.excludeTitlePatterns).toEqual(["secret project"]);
  });
});
