import { describe, it, expect } from "vitest";
import { parseAttendees, startActionArg } from "../renderer/record-form.js";
import { parseMeetingStartArg } from "../src/controls.js";

// The form's only output is one action argument; the main process turns it
// into the control file. Both ends pinned here so the renderer and main
// cannot drift apart.
describe("record form", () => {
  it("splits a comma list into trimmed, non-empty names", () => {
    expect(parseAttendees(" Maya R, Dev P,, ,Sam K ")).toEqual(["Maya R", "Dev P", "Sam K"]);
    expect(parseAttendees("")).toEqual([]);
  });

  it("builds the start argument, omitting what was left blank", () => {
    expect(JSON.parse(startActionArg("Day 5", "Maya R, Dev P")))
      .toEqual({ title: "Day 5", attendees: ["Maya R", "Dev P"] });
    expect(JSON.parse(startActionArg("  ", ""))).toEqual({});
  });

  it("main parses the argument, and tolerates the old bare action", () => {
    expect(parseMeetingStartArg(JSON.stringify({ title: "Day 5", attendees: ["Maya R"] })))
      .toEqual({ title: "Day 5", attendees: ["Maya R"] });
    expect(parseMeetingStartArg(undefined)).toEqual({});
    expect(parseMeetingStartArg("not json")).toEqual({});
    expect(parseMeetingStartArg(JSON.stringify({ attendees: "Maya" }))).toEqual({});
  });
});
