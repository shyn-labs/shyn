import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareShynVersions, readUpdateCheckEnabled, consumeUpdateFailed,
  upgradeShell, UPGRADE_COMMAND, checkLatest,
} from "../src/update.js";

const home = () => mkdtempSync(join(tmpdir(), "shyn-upd-"));

describe("compareShynVersions", () => {
  it("orders the 0.4.x-alpha scheme numerically, suffix ignored", () => {
    expect(compareShynVersions("0.4.13-alpha", "0.4.14-alpha")).toBeLessThan(0);
    expect(compareShynVersions("v0.4.14-alpha", "0.4.14-alpha")).toBe(0);
    expect(compareShynVersions("0.5.0-alpha", "0.4.99-alpha")).toBeGreaterThan(0);
    expect(compareShynVersions("0.10.0", "0.9.9")).toBeGreaterThan(0); // numeric, not lexical
  });
  it("malformed input → null, never a bogus order", () => {
    expect(compareShynVersions("nightly", "0.4.14")).toBeNull();
    expect(compareShynVersions("0.4.14", "")).toBeNull();
  });
});

describe("readUpdateCheckEnabled", () => {
  it("default on; only explicit false disables; corrupt file tolerated", () => {
    const h = home();
    expect(readUpdateCheckEnabled(h)).toBe(true);
    writeFileSync(join(h, "capture.json"), JSON.stringify({ updateCheck: false }));
    expect(readUpdateCheckEnabled(h)).toBe(false);
    writeFileSync(join(h, "capture.json"), "{not json");
    expect(readUpdateCheckEnabled(h)).toBe(true);
  });
});

describe("consumeUpdateFailed", () => {
  it("one-shot: true once, file deleted, then false", () => {
    const h = home();
    expect(consumeUpdateFailed(h)).toBe(false);
    writeFileSync(join(h, "update-failed.json"), '{"failedAt":1}');
    expect(consumeUpdateFailed(h)).toBe(true);
    expect(existsSync(join(h, "update-failed.json"))).toBe(false);
    expect(consumeUpdateFailed(h)).toBe(false);
  });
});

describe("upgradeShell", () => {
  it("contains the verbatim command, the log, and the failure marker write", () => {
    const line = upgradeShell("/Users/x/Library/Application Support/shyn");
    expect(line).toContain(UPGRADE_COMMAND);
    expect(line).toContain("Logs/shyn/update.log");
    expect(line).toContain("update-failed.json");
  });
});

describe("checkLatest", () => {
  const ok = (body: unknown) => (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
  it("returns the tag with v stripped", async () => {
    expect(await checkLatest(ok({ tag_name: "v0.4.14-alpha" }))).toBe("0.4.14-alpha");
  });
  it("silent null on non-200, throw, or garbage", async () => {
    const notFound = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    const boom = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await checkLatest(notFound)).toBeNull();
    expect(await checkLatest(boom)).toBeNull();
    expect(await checkLatest(ok({ nope: 1 }))).toBeNull();
  });
});
