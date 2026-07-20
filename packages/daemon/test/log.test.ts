import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStampedWriter, makeCrashHandler, rotateLogIfOversized, sweepLogDir } from "../src/log.js";

describe("stamped logging", () => {
  it("prefixes each line with an ISO timestamp and formats like console", () => {
    const out: string[] = [];
    const log = makeStampedWriter((s) => out.push(s), () => new Date("2026-07-20T12:00:00.000Z"));
    log("shynd listening on %s", "/tmp/x.sock");
    expect(out).toEqual(["2026-07-20T12:00:00.000Z shynd listening on /tmp/x.sock\n"]);
  });

  it("formats Error args with their stack, like console.error", () => {
    const out: string[] = [];
    const log = makeStampedWriter((s) => out.push(s), () => new Date(0));
    log("drain failed:", new Error("boom"));
    expect(out[0]).toContain("drain failed:");
    expect(out[0]).toContain("Error: boom");
    expect(out[0]).toContain("at ");
  });

  it("swallows write failures instead of throwing (ENOSPC must drop the line, not the daemon)", () => {
    // Node's own console is built with ignoreErrors=true; replacing it must
    // not turn a full disk into a crash loop.
    const log = makeStampedWriter(() => { throw new Error("ENOSPC"); }, () => new Date(0));
    expect(() => log("anything")).not.toThrow();
  });
});

describe("crash handler", () => {
  // The 12 unstamped crash footers of 2026-07-19 were Node's own fatal
  // output. Installing a handler suppresses that; ours must log the error
  // (stamped, synchronously — a piped stderr drops async writes on exit)
  // and still exit 1 so launchd's KeepAlive relaunch behavior is preserved.
  it("logs the fatal error under its label and exits 1", () => {
    const logged: unknown[][] = [];
    const exits: number[] = [];
    const handler = makeCrashHandler("uncaught exception",
      (...a: unknown[]) => logged.push(a), (c: number) => exits.push(c));
    handler(new Error("kaboom"));
    expect(String(logged[0][0])).toContain("uncaught exception");
    expect(logged[0].some((a) => a instanceof Error && a.message === "kaboom")).toBe(true);
    expect(exits).toEqual([1]);
  });

  it("still exits 1 when the log write itself fails", () => {
    const exits: number[] = [];
    const handler = makeCrashHandler("uncaught exception",
      () => { throw new Error("disk full"); }, (c: number) => exits.push(c));
    expect(() => handler(new Error("kaboom"))).not.toThrow();
    expect(exits).toEqual([1]);
  });
});

describe("rotateLogIfOversized", () => {
  it("moves an oversized log aside to <path>.1 and truncates — never destroys evidence", () => {
    // A crash line written seconds before a KeepAlive relaunch must survive
    // the relaunch's rotation (truncate-only wiped it — review finding).
    const p = join(mkdtempSync(join(tmpdir(), "shyn-log-")), "daemon.log");
    writeFileSync(p, "old boot evidence\n".repeat(64));
    expect(rotateLogIfOversized(p, 100)).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("");
    expect(readFileSync(p + ".1", "utf8")).toContain("old boot evidence");
  });

  it("keeps exactly one prior generation (overwrites <path>.1)", () => {
    const p = join(mkdtempSync(join(tmpdir(), "shyn-log-")), "daemon.log");
    writeFileSync(p + ".1", "generation A");
    writeFileSync(p, "generation B ".repeat(16));
    rotateLogIfOversized(p, 100);
    expect(readFileSync(p + ".1", "utf8")).toContain("generation B");
    expect(readFileSync(p + ".1", "utf8")).not.toContain("generation A");
  });

  it("leaves a log under the limit alone", () => {
    const p = join(mkdtempSync(join(tmpdir(), "shyn-log-")), "daemon.log");
    writeFileSync(p, "keep me");
    expect(rotateLogIfOversized(p, 1024)).toBe(false);
    expect(readFileSync(p, "utf8")).toBe("keep me");
    expect(existsSync(p + ".1")).toBe(false);
  });

  it("no-ops on a missing file or undefined path (dev runs)", () => {
    const dir = mkdtempSync(join(tmpdir(), "shyn-log-"));
    expect(rotateLogIfOversized(join(dir, "nope.log"), 1024)).toBe(false);
    expect(rotateLogIfOversized(undefined, 1024)).toBe(false);
    expect(existsSync(join(dir, "nope.log"))).toBe(false);
  });
});

describe("sweepLogDir", () => {
  it("rotates every oversized *.log in the daemon log's directory, not just the daemon's own", () => {
    // capture.log / meeting.log / status.log share the same never-rotating
    // launchd O_APPEND setup; the daemon is the only long-lived process in a
    // position to sweep them (review finding).
    const dir = mkdtempSync(join(tmpdir(), "shyn-log-"));
    writeFileSync(join(dir, "daemon.log"), "d".repeat(200));
    writeFileSync(join(dir, "status.log"), "s".repeat(200));
    writeFileSync(join(dir, "capture.log"), "small");
    writeFileSync(join(dir, "notes.txt"), "n".repeat(200));
    const rotated = sweepLogDir(join(dir, "daemon.log"), 100);
    expect(rotated.sort()).toEqual(["daemon.log", "status.log"]);
    expect(readFileSync(join(dir, "status.log"), "utf8")).toBe("");
    expect(readFileSync(join(dir, "status.log.1"), "utf8")).toContain("s");
    expect(readFileSync(join(dir, "capture.log"), "utf8")).toBe("small");
    expect(existsSync(join(dir, "notes.txt.1"))).toBe(false);
  });

  it("no-ops without a path", () => {
    expect(sweepLogDir(undefined, 100)).toEqual([]);
  });
});
