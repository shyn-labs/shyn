import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pauseCapture, resumeCapture, readPausedUntil, meetingStop, meetingCancel,
  readMeetingModel, setMeetingModel,
} from "../src/controls.js";

const NOW = 1_783_700_000;
const home = () => mkdtempSync(join(tmpdir(), "shyn-sui-"));

describe("controls: capture.json contract (matches cli capture-config)", () => {
  it("pause merges pausedUntil into existing config without clobbering", () => {
    const h = home();
    writeFileSync(join(h, "capture.json"),
      JSON.stringify({ excludeBundleIds: ["com.x.y"], meeting: { whisperModel: "small" } }));
    pauseCapture(h, "30m", NOW);
    const cfg = JSON.parse(readFileSync(join(h, "capture.json"), "utf8"));
    expect(cfg.pausedUntil).toBe(NOW + 1800);
    expect(cfg.excludeBundleIds).toEqual(["com.x.y"]);   // preserved
    expect(cfg.meeting.whisperModel).toBe("small");       // preserved
    expect(readPausedUntil(h)).toBe(NOW + 1800);
  });

  it("2h and until-tomorrow durations; resume deletes the key", () => {
    const h = home();
    pauseCapture(h, "2h", NOW);
    expect(readPausedUntil(h)).toBe(NOW + 7200);
    pauseCapture(h, "until-tomorrow", NOW);
    const until = readPausedUntil(h)!;
    const midnight = new Date((NOW + 86400) * 1000); midnight.setHours(0, 0, 0, 0);
    expect(until).toBe(Math.floor(midnight.getTime() / 1000));
    resumeCapture(h);
    expect(readPausedUntil(h)).toBeNull();
    expect("pausedUntil" in JSON.parse(readFileSync(join(h, "capture.json"), "utf8"))).toBe(false);
  });

  it("missing/corrupt capture.json tolerated", () => {
    const h = home();
    expect(readPausedUntil(h)).toBeNull();
    writeFileSync(join(h, "capture.json"), "{not json");
    pauseCapture(h, "30m", NOW);
    expect(readPausedUntil(h)).toBe(NOW + 1800);
  });
});

describe("controls: meeting.whisperModel contract (matches MeetingConfig.load)", () => {
  it("defaults to small when file or meeting object is missing", () => {
    const h = home();
    expect(readMeetingModel(h)).toBe("small");
    writeFileSync(join(h, "capture.json"), JSON.stringify({ pausedUntil: NOW }));
    expect(readMeetingModel(h)).toBe("small");
  });

  it("set merges whisperModel into meeting without clobbering siblings", () => {
    const h = home();
    writeFileSync(join(h, "capture.json"), JSON.stringify({
      pausedUntil: NOW,
      meeting: { excludeApps: ["com.a.b"], endSilenceSeconds: 90 },
    }));
    setMeetingModel(h, "large-v3");
    const cfg = JSON.parse(readFileSync(join(h, "capture.json"), "utf8"));
    expect(cfg.meeting.whisperModel).toBe("large-v3");
    expect(cfg.meeting.excludeApps).toEqual(["com.a.b"]);      // preserved
    expect(cfg.meeting.endSilenceSeconds).toBe(90);             // preserved
    expect(cfg.pausedUntil).toBe(NOW);                          // preserved
    expect(readMeetingModel(h)).toBe("large-v3");
    setMeetingModel(h, "small");
    expect(readMeetingModel(h)).toBe("small");
  });

  it("corrupt capture.json tolerated", () => {
    const h = home();
    writeFileSync(join(h, "capture.json"), "{not json");
    expect(readMeetingModel(h)).toBe("small");
    setMeetingModel(h, "large-v3");
    expect(readMeetingModel(h)).toBe("large-v3");
  });
});

describe("controls: meeting-control.json contract (matches cli meeting-control)", () => {
  it("stop and cancel write the consumable one-shot file", () => {
    const h = home();
    meetingStop(h);
    let c = JSON.parse(readFileSync(join(h, "meeting-control.json"), "utf8"));
    expect(c.action).toBe("stop");
    expect(typeof c.ts).toBe("number");
    meetingCancel(h);
    c = JSON.parse(readFileSync(join(h, "meeting-control.json"), "utf8"));
    expect(c.action).toBe("cancel");
  });
});
