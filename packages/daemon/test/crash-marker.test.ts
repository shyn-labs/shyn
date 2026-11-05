import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCrashMarker, consumeCrashMarker, crashFingerprint } from "../src/crash-marker.js";
import { makeCrashHandler } from "../src/log.js";
import { AnalyticsQueue, type AnalyticsRecord } from "../src/analytics.js";

const home = () => mkdtempSync(join(tmpdir(), "shyn-crash-"));

describe("crash marker", () => {
  it("round-trips once, then is gone", () => {
    const h = home();
    writeCrashMarker(h, "uncaught exception", new Error("boom"), 5_000);
    const m = consumeCrashMarker(h);
    expect(m?.label).toBe("uncaught exception");
    expect(m?.message).toBe("boom");
    expect(m?.ts).toBe(5);
    expect(consumeCrashMarker(h)).toBeNull();
  });

  it("handles a thrown non-Error and caps a runaway message", () => {
    const h = home();
    writeCrashMarker(h, "unhandled rejection", "x".repeat(50_000));
    expect(consumeCrashMarker(h)!.message.length).toBe(2000);
  });

  it("deletes an unparseable marker instead of re-reading it every boot", () => {
    const h = home();
    writeFileSync(join(h, "last-crash.json"), "{ nope");
    expect(consumeCrashMarker(h)).toBeNull();
    expect(existsSync(join(h, "last-crash.json"))).toBe(false);
  });

  it("leaves no temp file behind", () => {
    const h = home();
    writeCrashMarker(h, "x", new Error("y"));
    expect(existsSync(join(h, "last-crash.json.tmp"))).toBe(false);
  });
});

describe("crash handler onFatal", () => {
  it("runs after the log line and before the exit, and a throwing hook cannot block the exit", () => {
    const order: string[] = [];
    const handler = makeCrashHandler("uncaught exception",
      () => order.push("log"), () => order.push("exit"),
      () => { order.push("marker"); throw new Error("disk full"); });
    expect(() => handler(new Error("kaboom"))).not.toThrow();
    expect(order).toEqual(["log", "marker", "exit"]);
  });
});

describe("daemon_error fingerprint", () => {
  it("carries class, symbolic code and reduced frames, and none of the message", async () => {
    const h = home();
    const err = Object.assign(
      new Error('Unexpected token in "Quarterly salary review" at /Users/sam/clients/globex/notes.md, call Priya'),
      { code: "ERR_PARSE" });
    writeCrashMarker(h, "uncaught exception", err);
    const fp = crashFingerprint(consumeCrashMarker(h)!);
    const sent: AnalyticsRecord[] = [];
    const q = new AnalyticsQueue({ enabled: true, installId: "i", send: async (b) => { sent.push(...b); } });
    q.track("daemon_error", { agent: "daemon", outcome: "error", ...fp });
    await q.flush();
    const all = JSON.stringify(sent[0].properties);
    for (const leak of ["Quarterly", "salary", "globex", "/Users/sam", "Priya", "notes.md"])
      expect(all).not.toContain(leak);
    expect(sent[0].properties.error).toBe("uncaught exception: Error");
    expect(sent[0].properties.code).toBe("ERR_PARSE");
    expect(sent[0].properties).not.toHaveProperty("message");
  });

  it("reduces frames to function + basename:line and drops non-symbolic codes", () => {
    const fp = crashFingerprint({ label: "unhandled rejection", name: "TypeError", code: "", message: "m", ts: 1,
      stack: "TypeError: m\n    at run (/Users/sam/app/dist/main.mjs:10:5)\n    at node:internal/timers:5:1\n    at /x/y/z.js:3:4" });
    expect(fp.stack.split("\n")).toEqual(["run main.mjs:10", "<anon> node:internal/timers:5"].concat(["<anon> z.js:3"]).slice(0, 3));
    const w = home();
    writeCrashMarker(w, "x", Object.assign(new Error("e"), { code: "has spaces and /paths" }));
    expect(consumeCrashMarker(w)!.code).toBe("");
  });
});
