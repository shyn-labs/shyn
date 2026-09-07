import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestMeetingStart, requestMeetingStop, requestMeetingCancel } from "../src/meeting-control.js";

describe("meeting control", () => {
  it("stop and cancel write a consumable control file", () => {
    const home = mkdtempSync(join(tmpdir(), "shyn-mc-"));
    requestMeetingStop(home);
    let c = JSON.parse(readFileSync(join(home, "meeting-control.json"), "utf8"));
    expect(c.action).toBe("stop");
    expect(typeof c.ts).toBe("number");
    requestMeetingCancel(home);
    c = JSON.parse(readFileSync(join(home, "meeting-control.json"), "utf8"));
    expect(c.action).toBe("cancel");
  });

  // Cross-language contract. This file is the ONLY channel from the CLI into a
  // running Swift agent, and the two sides are compiled separately — nothing
  // but a test keeps them agreeing. The exact shapes asserted here are the
  // ones parseMeetingControl covers in
  // packages/capture-agent/Tests/CaptureCoreTests/MeetingControlTests.swift;
  // change one side and change both.
  it("start writes {action:'start'} with the title when given", () => {
    const home = mkdtempSync(join(tmpdir(), "shyn-mc-"));
    requestMeetingStart(home, "Field team standup");
    const c = JSON.parse(readFileSync(join(home, "meeting-control.json"), "utf8"));
    expect(c.action).toBe("start");
    expect(c.title).toBe("Field team standup");
    expect(typeof c.ts).toBe("number");
  });

  it("start without a title omits the key rather than writing null", () => {
    // JSON.stringify drops undefined values, and the Swift side reads title as
    // an optional String — a literal null would decode to nil the same way,
    // but omitting it keeps the file honest about what was asked for.
    const home = mkdtempSync(join(tmpdir(), "shyn-mc-"));
    requestMeetingStart(home);
    const raw = readFileSync(join(home, "meeting-control.json"), "utf8");
    expect(JSON.parse(raw).action).toBe("start");
    expect(raw).not.toContain("title");
  });
});
