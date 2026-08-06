import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareShynVersions, readUpdateCheckEnabled, consumeUpdateFailed,
  upgradeShell, UPGRADE_COMMAND, checkLatest, RELEASES_URL,
  readAutoUpdateEnabled, readUpdateAttempt, writeUpdateAttempt,
  shouldAutoUpdate, AUTO_UPDATE_RETRY_SECONDS, AUTO_UPDATE_SAME_VERSION_SECONDS,
  parseNotice, NOTICE_MAX_CHARS,
  type AutoUpdateContext,
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

  it("takes the newest tag from the release LIST, v stripped", async () => {
    // Newest first, as GitHub returns it.
    expect((await checkLatest(ok([
      { tag_name: "v0.4.19-alpha", prerelease: true, draft: false },
      { tag_name: "v0.4.18-alpha", prerelease: true, draft: false },
    ])))!.version).toBe("0.4.19-alpha");
  });

  it("KEEPS prereleases — every shyn release is one", async () => {
    // The bug this replaces: /releases/latest excludes prereleases, so it 404'd
    // on a repo where all releases are prereleases, and the check returned null
    // from 0.4.14 to 0.4.20 while looking exactly like "you are up to date".
    expect((await checkLatest(ok([{ tag_name: "v0.5.0-alpha", prerelease: true, draft: false }])))!.version)
      .toBe("0.5.0-alpha");
  });

  it("skips drafts", async () => {
    expect((await checkLatest(ok([
      { tag_name: "v0.9.9-alpha", prerelease: true, draft: true },
      { tag_name: "v0.4.19-alpha", prerelease: true, draft: false },
    ])))!.version).toBe("0.4.19-alpha");
  });

  it("null on non-200, throw, empty list, or a non-array body", async () => {
    const notFound = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    const boom = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await checkLatest(notFound)).toBeNull();
    expect(await checkLatest(boom)).toBeNull();
    expect(await checkLatest(ok([]))).toBeNull();
    expect(await checkLatest(ok({ tag_name: "v1.0.0" }))).toBeNull();   // single object, not a list
    expect(await checkLatest(ok([{ nope: 1 }]))).toBeNull();
  });

  it("polls the list endpoint, never /releases/latest", async () => {
    // Guards the regression directly: /releases/latest cannot see prereleases.
    expect(RELEASES_URL).toContain("/releases?");
    expect(RELEASES_URL).not.toContain("/releases/latest");
  });
});

// --- auto-update decision ---------------------------------------------------
// Applying an update restarts the daemon and both capture agents, so every
// refusal below is a data-loss or thrash guard, not a nicety.

const NOW = 1_754_000_000;
const ctx = (over: Partial<AutoUpdateContext> = {}): AutoUpdateContext => ({
  enabled: true, current: "0.4.14-alpha", latest: "0.4.16-alpha",
  updating: false, meetingState: "idle", lastAttempt: null, lastFailureAt: null,
  brewFound: true, now: NOW, ...over,
});

describe("shouldAutoUpdate", () => {
  it("updates when a newer version is out and nothing is in the way", () => {
    const d = shouldAutoUpdate(ctx());
    expect(d.run).toBe(true);
    expect(d.reason).toMatch(/0\.4\.14-alpha → 0\.4\.16-alpha/);
  });

  it("is opt-in: does nothing unless explicitly enabled", () => {
    expect(shouldAutoUpdate(ctx({ enabled: false })).run).toBe(false);
  });

  it("never interrupts a live meeting", () => {
    for (const state of ["recording", "transcribing"]) {
      const d = shouldAutoUpdate(ctx({ meetingState: state }));
      expect(d.run).toBe(false);
      expect(d.reason).toContain(state);
    }
    // Idle and paused are fine to update through.
    expect(shouldAutoUpdate(ctx({ meetingState: "idle" })).run).toBe(true);
    expect(shouldAutoUpdate(ctx({ meetingState: "paused" })).run).toBe(true);
  });

  it("holds off when already current, older, or unparseable", () => {
    expect(shouldAutoUpdate(ctx({ latest: "0.4.14-alpha" })).run).toBe(false);
    expect(shouldAutoUpdate(ctx({ latest: "0.4.13-alpha" })).run).toBe(false);
    expect(shouldAutoUpdate(ctx({ latest: "garbage" })).run).toBe(false);
    // Daemon down: main.ts passes an empty current rather than guessing.
    expect(shouldAutoUpdate(ctx({ current: "" })).run).toBe(false);
  });

  it("does not stack upgrades or run without brew", () => {
    expect(shouldAutoUpdate(ctx({ updating: true })).run).toBe(false);
    expect(shouldAutoUpdate(ctx({ brewFound: false })).run).toBe(false);
  });

  it("backs off after a failure, then tries again", () => {
    expect(shouldAutoUpdate(ctx({ lastFailureAt: NOW - 60 })).run).toBe(false);
    expect(shouldAutoUpdate(ctx({ lastFailureAt: NOW - AUTO_UPDATE_RETRY_SECONDS - 1 })).run)
      .toBe(true);
  });

  it("will not re-attempt the same version in a loop", () => {
    // The upgrade ran but the version on offer did not change — retrying every
    // 3s tick would fork brew forever.
    const attempted = { version: "0.4.16-alpha", at: NOW - 60 };
    expect(shouldAutoUpdate(ctx({ lastAttempt: attempted })).run).toBe(false);
    // A different version is a fresh opportunity, immediately.
    expect(shouldAutoUpdate(ctx({ lastAttempt: attempted, latest: "0.4.17-alpha" })).run)
      .toBe(true);
    // And the same version becomes fair game again after the window.
    expect(shouldAutoUpdate(ctx({
      lastAttempt: { version: "0.4.16-alpha", at: NOW - AUTO_UPDATE_SAME_VERSION_SECONDS - 1 },
    })).run).toBe(true);
  });
});

describe("auto-update config and attempt record", () => {
  it("defaults to off, and reads an explicit opt-in", () => {
    const h = home();
    expect(readAutoUpdateEnabled(h)).toBe(false);              // no config file
    writeFileSync(join(h, "capture.json"), JSON.stringify({ meeting: {} }));
    expect(readAutoUpdateEnabled(h)).toBe(false);              // key absent
    writeFileSync(join(h, "capture.json"), JSON.stringify({ autoUpdate: true }));
    expect(readAutoUpdateEnabled(h)).toBe(true);
    writeFileSync(join(h, "capture.json"), "{ not json");
    expect(readAutoUpdateEnabled(h)).toBe(false);              // corrupt = off
  });

  it("round-trips the attempt record and shrugs off a corrupt one", () => {
    const h = home();
    expect(readUpdateAttempt(h)).toBeNull();
    writeUpdateAttempt(h, { version: "0.4.16-alpha", at: NOW });
    expect(readUpdateAttempt(h)).toEqual({ version: "0.4.16-alpha", at: NOW });
    writeFileSync(join(h, "update-attempt.json"), "{ nope");
    expect(readUpdateAttempt(h)).toBeNull();
  });
});

// --- maintainer notice channel ----------------------------------------------
// A one-way message riding in the newest release body. No new endpoint, so no
// new privacy surface — and it can only ever reach builds that already poll.

describe("parseNotice", () => {
  it("extracts text and defaults to info severity", () => {
    const n = parseNotice("Release notes here.\n<!-- shyn-notice: Coffee break, back in ten. -->\nMore notes.");
    expect(n).toEqual({ severity: "info", text: "Coffee break, back in ten." });
  });

  it("reads an explicit severity and collapses multi-line bodies to one line", () => {
    const n = parseNotice(`<!-- shyn-notice: severity=warn
      Update required: builds before 0.4.20 cannot detect updates.
      Run: brew upgrade --cask shyn-labs/tap/shyn
      -->`);
    expect(n!.severity).toBe("warn");
    expect(n!.text).toBe(
      "Update required: builds before 0.4.20 cannot detect updates. Run: brew upgrade --cask shyn-labs/tap/shyn");
    expect(n!.text).not.toContain("\n");
  });

  it("returns null when there is no marker, no text, or no string body", () => {
    expect(parseNotice("just ordinary release notes")).toBeNull();
    expect(parseNotice("<!-- shyn-notice: -->")).toBeNull();
    expect(parseNotice("<!-- shyn-notice: severity=warn -->")).toBeNull();
    expect(parseNotice(undefined)).toBeNull();
    expect(parseNotice(42)).toBeNull();
  });

  it("truncates an over-long notice rather than breaking the row", () => {
    const n = parseNotice(`<!-- shyn-notice: ${"x".repeat(400)} -->`);
    expect(n!.text.length).toBe(NOTICE_MAX_CHARS);
    expect(n!.text.endsWith("\u2026")).toBe(true);
  });

  it("ignores an unknown severity value rather than failing the whole notice", () => {
    const n = parseNotice("<!-- shyn-notice: severity=catastrophe the sky is falling -->");
    expect(n!.severity).toBe("info");
    expect(n!.text).toContain("the sky is falling");
  });
});

describe("checkLatest notice plumbing", () => {
  const ok = (body: unknown) => (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
  it("carries a notice out of the newest release body", async () => {
    const r = await checkLatest(ok([
      { tag_name: "v0.4.20-alpha", draft: false, body: "<!-- shyn-notice: severity=warn upgrade by hand once -->" },
      { tag_name: "v0.4.19-alpha", draft: false, body: "<!-- shyn-notice: stale, must be ignored -->" },
    ]));
    expect(r!.version).toBe("0.4.20-alpha");
    expect(r!.notice).toEqual({ severity: "warn", text: "upgrade by hand once" });
  });
  it("null notice when the newest release has no marker", async () => {
    const r = await checkLatest(ok([{ tag_name: "v0.4.20-alpha", draft: false, body: "plain notes" }]));
    expect(r!.notice).toBeNull();
  });
});
