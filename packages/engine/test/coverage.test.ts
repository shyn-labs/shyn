import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage.js";
import {
  recordBeat, coverageReport, sweepCoverage, HEARTBEAT_SECONDS, GAP_FACTOR,
} from "../src/coverage.js";

const db = () => openDatabase({ dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"), key: null });
const DAY = 1_754_000_000;          // fixed epoch; nothing here depends on now()

// Fills [from, to) with beats at the nominal cadence.
const beatRange = (d: any, from: number, to: number, agents = ["screen", "meeting"]) => {
  for (let t = from; t < to; t += HEARTBEAT_SECONDS) recordBeat(d, agents, t);
};

describe("coverage", () => {
  it("reports full observation when beats are dense", () => {
    const d = db();
    beatRange(d, DAY, DAY + 3600);
    const r = coverageReport(d, { timeFrom: DAY, timeTo: DAY + 3600, now: DAY + 7200 });
    expect(r.gaps).toEqual([]);
    expect(r.unobservedSeconds).toBe(0);
    expect(r.observedSeconds).toBe(3600);
  });

  it("finds the gap where the machine stopped being watched", () => {
    const d = db();
    beatRange(d, DAY, DAY + 1800);                  // watched for 30 min
    beatRange(d, DAY + 5400, DAY + 7200);           // resumed an hour later
    const r = coverageReport(d, { timeFrom: DAY, timeTo: DAY + 7200, now: DAY + 7200 });
    expect(r.gaps.length).toBe(1);
    expect(r.gaps[0].seconds).toBeGreaterThan(3500);
    expect(r.unobservedSeconds).toBe(r.gaps[0].seconds);
    expect(r.observedSeconds).toBe(7200 - r.gaps[0].seconds);
  });

  it("treats a window that begins before the first beat as unobserved at the start", () => {
    // The real shape of 2026-08-05: nothing from 21:00 until the lid opened.
    const d = db();
    const openedLid = DAY + 14 * 3600;
    beatRange(d, openedLid, openedLid + 1800);
    const r = coverageReport(d, { timeFrom: DAY, timeTo: openedLid + 1800, now: openedLid + 1800 });
    expect(r.gaps.length).toBe(1);
    expect(r.gaps[0].from).toBe(DAY);
    expect(r.gaps[0].to).toBe(openedLid);
    expect(r.gaps[0].seconds).toBe(14 * 3600);
  });

  it("treats a window that ends after the last beat as unobserved at the end", () => {
    const d = db();
    beatRange(d, DAY, DAY + 600);
    const r = coverageReport(d, { timeFrom: DAY, timeTo: DAY + 3600, now: DAY + 3600 });
    expect(r.gaps.length).toBe(1);
    expect(r.gaps[0].to).toBe(DAY + 3600);
  });

  it("never counts the future as unobserved", () => {
    const d = db();
    beatRange(d, DAY, DAY + 600);
    // Window runs an hour past `now`; only the elapsed part can be judged.
    const r = coverageReport(d, { timeFrom: DAY, timeTo: DAY + 7200, now: DAY + 660 });
    expect(r.windowTo).toBe(DAY + 660);
    expect(r.gaps).toEqual([]);
  });

  it("reports no coverage at all when there are no beats", () => {
    const d = db();
    const r = coverageReport(d, { timeFrom: DAY, timeTo: DAY + 3600, now: DAY + 3600 });
    expect(r.observedSeconds).toBe(0);
    expect(r.unobservedSeconds).toBe(3600);
    expect(r.gaps).toEqual([{ from: DAY, to: DAY + 3600, seconds: 3600 }]);
  });

  it("tolerates jitter and a couple of missed beats", () => {
    const d = db();
    // One beat skipped: below the GAP_FACTOR threshold, so not a gap.
    recordBeat(d, ["screen"], DAY);
    recordBeat(d, ["screen"], DAY + HEARTBEAT_SECONDS * (GAP_FACTOR - 1));
    const r = coverageReport(d, {
      timeFrom: DAY, timeTo: DAY + HEARTBEAT_SECONDS * (GAP_FACTOR - 1), now: DAY + 7200,
    });
    expect(r.gaps).toEqual([]);
  });

  it("distinguishes a live daemon with a dead agent from a dead daemon", () => {
    const d = db();
    // Daemon alive throughout, but the screen agent stopped reporting halfway —
    // the case the 0-byte capture.log could not tell anyone about.
    beatRange(d, DAY, DAY + 1800, ["screen", "meeting"]);
    beatRange(d, DAY + 1800, DAY + 3600, ["meeting"]);
    const r = coverageReport(d, {
      timeFrom: DAY, timeTo: DAY + 3600, now: DAY + 3600,
      expectAgents: ["screen", "meeting"],
    });
    expect(r.gaps).toEqual([]);                       // the daemon never went dark
    expect(r.agentDownSeconds.screen).toBe(1800);     // but capture did
    expect(r.agentDownSeconds.meeting).toBeUndefined();
  });

  it("collapses two beats in the same second into one observation", () => {
    const d = db();
    recordBeat(d, ["screen"], DAY);
    recordBeat(d, ["screen", "meeting"], DAY);
    const rows = d.prepare("SELECT ts, agents FROM coverage").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].agents).toBe("meeting,screen");    // stored sorted, last wins
  });

  it("sweeps old beats but keeps forever when retention is disabled", () => {
    const d = db();
    const now = Math.floor(Date.now() / 1000);
    recordBeat(d, ["screen"], now - 40 * 86400);
    recordBeat(d, ["screen"], now - 3600);
    expect(sweepCoverage(d, 0)).toBe(0);              // 0 = keep forever
    expect(sweepCoverage(d, 30)).toBe(1);
    expect((d.prepare("SELECT COUNT(*) c FROM coverage").get() as any).c).toBe(1);
  });
});
