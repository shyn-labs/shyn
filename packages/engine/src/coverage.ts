import type Database from "better-sqlite3-multiple-ciphers";

// Coverage: the record of when shyn was actually watching.
//
// Live finding 2026-08-05: asked to reconstruct a day, recall could answer 10 of
// 24 hours and presented the other 14 as silence. Absence of documents is
// ambiguous — asleep, powered off, daemon down, agent crashed, or a genuinely
// quiet hour all look identical. A heartbeat makes the difference legible: rows
// exist while the daemon is alive, and a hole in the series IS the evidence that
// nothing was being observed.
//
// Sleep needs no macOS API: the daemon is suspended along with the machine, so a
// wall-clock jump between consecutive beats is exactly the interval that went
// unwatched.

// Nominal seconds between heartbeats. The daemon's interval must match; the gap
// threshold is derived from it rather than hardcoded so one knob moves both.
export const HEARTBEAT_SECONDS = 60;
// Tolerate scheduler jitter and a couple of missed beats before calling it a
// gap. Three beats keeps a busy event loop from manufacturing fake sleep.
export const GAP_FACTOR = 3;

export type CoverageGap = { from: number; to: number; seconds: number };
export type CoverageReport = {
  windowFrom: number;
  windowTo: number;
  observedSeconds: number;
  unobservedSeconds: number;
  gaps: CoverageGap[];
  /** Seconds where the daemon was up but a given agent was not reporting. */
  agentDownSeconds: Record<string, number>;
};

export function recordBeat(
  db: Database.Database, agents: string[], now: number
): void {
  // OR REPLACE: two beats in the same second are the same observation, not two.
  db.prepare("INSERT OR REPLACE INTO coverage(ts, agents) VALUES (?, ?)")
    .run(now, agents.slice().sort().join(","));
}

export function sweepCoverage(db: Database.Database, retentionDays: number): number {
  if (retentionDays <= 0) return 0;   // 0 or less means keep forever, as elsewhere
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  return db.prepare("DELETE FROM coverage WHERE ts < ?").run(cutoff).changes;
}

// Gaps within [from, to], including the leading and trailing edges: a window
// that starts before the first beat was not observed at its start, and that is
// the single most common real case (the machine was asleep until 11am).
export function coverageReport(
  db: Database.Database,
  p: { timeFrom: number; timeTo: number; expectAgents?: string[]; now?: number }
): CoverageReport {
  const now = p.now ?? Math.floor(Date.now() / 1000);
  const from = p.timeFrom;
  // The future was not "unobserved", it simply has not happened yet.
  const to = Math.min(p.timeTo, now);
  const threshold = HEARTBEAT_SECONDS * GAP_FACTOR;
  const empty: CoverageReport = {
    windowFrom: from, windowTo: to,
    observedSeconds: 0, unobservedSeconds: Math.max(0, to - from),
    gaps: to > from ? [{ from, to, seconds: to - from }] : [],
    agentDownSeconds: {},
  };
  if (to <= from) return { ...empty, gaps: [], unobservedSeconds: 0 };

  const beats = db.prepare(
    "SELECT ts, agents FROM coverage WHERE ts >= ? AND ts <= ? ORDER BY ts ASC"
  ).all(from, to) as { ts: number; agents: string }[];
  if (!beats.length) return empty;

  const gaps: CoverageGap[] = [];
  const push = (a: number, b: number) => {
    if (b - a > threshold) gaps.push({ from: a, to: b, seconds: b - a });
  };
  push(from, beats[0].ts);                       // leading edge
  for (let i = 1; i < beats.length; i++) push(beats[i - 1].ts, beats[i].ts);
  push(beats[beats.length - 1].ts, to);          // trailing edge

  const unobserved = gaps.reduce((n, g) => n + g.seconds, 0);

  // Per-agent downtime: beats exist (daemon up) but the agent was absent from
  // them. Each such beat stands for one heartbeat interval of not capturing.
  const agentDownSeconds: Record<string, number> = {};
  for (const agent of p.expectAgents ?? []) {
    const missing = beats.filter((b) => !b.agents.split(",").includes(agent)).length;
    if (missing) agentDownSeconds[agent] = missing * HEARTBEAT_SECONDS;
  }

  return {
    windowFrom: from, windowTo: to,
    observedSeconds: Math.max(0, (to - from) - unobserved),
    unobservedSeconds: unobserved,
    gaps, agentDownSeconds,
  };
}
