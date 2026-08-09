import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareShynVersions, readUpdateCheckEnabled, consumeUpdateFailed,
  upgradeShell, UPGRADE_COMMAND, checkLatest, RELEASES_URL,
  readAutoUpdateEnabled, readUpdateAttempt, writeUpdateAttempt,
  shouldAutoUpdate, AUTO_UPDATE_RETRY_SECONDS, AUTO_UPDATE_SAME_VERSION_SECONDS,
  parseNotice, NOTICE_MAX_CHARS, UPDATE_CHECK_INTERVAL_MS,
  noticeApplies, noticeKey, readDismissedNotices, dismissNotice,
  type AutoUpdateContext, type Notice,
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

  it("re-checks often enough for a hotfix, without hammering the API", () => {
    const hours = UPDATE_CHECK_INTERVAL_MS / 3_600_000;
    expect(hours).toBeLessThanOrEqual(6);       // a hotfix must not wait a day
    expect(hours).toBeGreaterThanOrEqual(1);    // releases are cut by hand; polling faster buys nothing
    // Unauthenticated GitHub allows 60 requests/hour. Stay far under it.
    expect(24 / hours).toBeLessThan(30);
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
    const n = parseNotice("Release notes here.\n<!-- shyn-notice: Coffee break, back in ten. -->\nMore notes.")!;
    expect(n.severity).toBe("info");
    expect(n.text).toBe("Coffee break, back in ten.");
    expect(n.key).toBeTruthy();
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
    expect(r!.notice!.severity).toBe("warn");
    expect(r!.notice!.text).toBe("upgrade by hand once");
  });
  it("null notice when the newest release has no marker", async () => {
    const r = await checkLatest(ok([{ tag_name: "v0.4.20-alpha", draft: false, body: "plain notes" }]));
    expect(r!.notice).toBeNull();
  });
});

// --- notice targeting + dismissal (0.4.23) ----------------------------------
// Both exist because the first notice shipped with neither: it was shown to
// every build including ones it did not apply to, and could not be closed.

describe("noticeApplies", () => {
  const n = (over: Partial<Notice> = {}): Notice =>
    ({ severity: "info", text: "t", key: "k", ...over }) as Notice;

  it("shows a notice with no range to everyone", () => {
    expect(noticeApplies(n(), "0.4.22-alpha")).toBe(true);
  });

  it("targets older builds with < — the case that was shipped wrong", () => {
    const old = n({ appliesTo: { op: "<", version: "0.4.20" } });
    expect(noticeApplies(old, "0.4.19-alpha")).toBe(true);    // needs to hear it
    expect(noticeApplies(old, "0.4.20-alpha")).toBe(false);   // does not
    expect(noticeApplies(old, "0.4.22-alpha")).toBe(false);   // the build that was wrongly nagged
  });

  it("handles the other operators", () => {
    expect(noticeApplies(n({ appliesTo: { op: "<=", version: "0.4.20" } }), "0.4.20-alpha")).toBe(true);
    expect(noticeApplies(n({ appliesTo: { op: ">", version: "0.4.20" } }), "0.4.22-alpha")).toBe(true);
    expect(noticeApplies(n({ appliesTo: { op: ">=", version: "0.4.22" } }), "0.4.22-alpha")).toBe(true);
    expect(noticeApplies(n({ appliesTo: { op: "=", version: "0.4.21" } }), "0.4.21-alpha")).toBe(true);
    expect(noticeApplies(n({ appliesTo: { op: "=", version: "0.4.21" } }), "0.4.22-alpha")).toBe(false);
  });

  it("fails OPEN on an unusable version, rather than swallowing the message", () => {
    // Hiding would fail silently: the message never lands and the maintainer
    // never learns the expression was wrong.
    expect(noticeApplies(n({ appliesTo: { op: "<", version: "0.4.20" } }), "nightly")).toBe(true);
  });
});

describe("parseNotice appliesTo", () => {
  it("parses severity and range together, and keeps the text clean", () => {
    const n = parseNotice(`<!-- shyn-notice: severity=warn appliesTo=<0.4.20
      Builds before 0.4.20 cannot detect updates. Run brew upgrade. -->`)!;
    expect(n.severity).toBe("warn");
    expect(n.appliesTo).toEqual({ op: "<", version: "0.4.20" });
    expect(n.text).toBe("Builds before 0.4.20 cannot detect updates. Run brew upgrade.");
  });

  it("tolerates a v prefix and leaves appliesTo absent when not given", () => {
    expect(parseNotice("<!-- shyn-notice: appliesTo=>=v0.5.0 new thing -->")!.appliesTo)
      .toEqual({ op: ">=", version: "0.5.0" });
    expect(parseNotice("<!-- shyn-notice: plain message -->")!.appliesTo).toBeUndefined();
  });

  it("gives every notice a stable key derived from its text", () => {
    const a = parseNotice("<!-- shyn-notice: same words -->")!;
    const b = parseNotice("<!-- shyn-notice: severity=warn same words -->")!;
    expect(a.key).toBe(b.key);                       // key follows text, not severity
    expect(a.key).toBe(noticeKey("same words"));
    expect(parseNotice("<!-- shyn-notice: other words -->")!.key).not.toBe(a.key);
  });
});

describe("notice dismissal", () => {
  it("remembers a dismissal, ignores duplicates, and caps the log", () => {
    const h = home();
    expect(readDismissedNotices(h)).toEqual([]);
    dismissNotice(h, "abc");
    dismissNotice(h, "abc");
    expect(readDismissedNotices(h)).toEqual(["abc"]);
    for (let i = 0; i < 60; i++) dismissNotice(h, `k${i}`);
    const keys = readDismissedNotices(h);
    expect(keys.length).toBe(50);                    // capped, oldest dropped
    expect(keys).toContain("k59");
    expect(keys).not.toContain("abc");
  });

  it("treats a corrupt or absent file as nothing dismissed", () => {
    const h = home();
    writeFileSync(join(h, "dismissed-notices.json"), "{not an array}");
    expect(readDismissedNotices(h)).toEqual([]);
  });
});

describe("upgrade command safety", () => {
  it("never runs `brew update` — it must not touch Homebrew's own repo unattended", () => {
    // Lived 2026-08-09: the unattended 02:08 upgrade was interrupted mid-flight
    // and left /opt/homebrew's working tree gutted — bin/brew and
    // Library/Homebrew/brew.sh deleted, Cellar and shims intact — so the package
    // manager was dead until a git checkout restored it. The worst a failed
    // upgrade may do is not upgrade.
    expect(UPGRADE_COMMAND).not.toMatch(/brew\s+update/);
    expect(UPGRADE_COMMAND).toContain("brew upgrade --cask shyn");
    expect(UPGRADE_COMMAND).toContain("shyn setup");
  });

  it("still fails closed: setup only runs if the upgrade succeeded", () => {
    // && not ; — a half-applied upgrade must not be followed by a setup that
    // restages from an incomplete payload.
    expect(UPGRADE_COMMAND).toMatch(/brew upgrade --cask shyn\s*&&\s*shyn setup/);
  });
});
