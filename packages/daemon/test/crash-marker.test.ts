import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCrashMarker, consumeCrashMarker } from "../src/crash-marker.js";
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

describe("daemon_error end to end through the scrubber", () => {
  it("a marker with a path and a quoted document title leaves scrubbed", async () => {
    const h = home();
    writeCrashMarker(h, "uncaught exception",
      new Error('Unexpected token in "Quarterly salary review" at /Users/sam/clients/globex/notes.md'));
    const crash = consumeCrashMarker(h)!;
    const sent: AnalyticsRecord[] = [];
    const q = new AnalyticsQueue({ enabled: true, installId: "i", send: async (b) => { sent.push(...b); } });
    q.track("daemon_error", { agent: "daemon", outcome: "error", error: crash.label, message: crash.message, stack: crash.stack });
    await q.flush();
    const msg = String(sent[0].properties.message);
    expect(msg).not.toContain("Quarterly salary review");
    expect(msg).not.toContain("globex");
    expect(msg).not.toContain("/Users/sam");
    expect(sent[0].properties.agent).toBe("daemon");
  });
});
