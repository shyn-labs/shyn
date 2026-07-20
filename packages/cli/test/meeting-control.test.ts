import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestMeetingStop, requestMeetingCancel } from "../src/meeting-control.js";

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
});
