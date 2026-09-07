#!/usr/bin/env node
// Release gate: are recent meetings actually FINDABLE by name?
//
// RELEASING.md has had a "live meeting sanity" step since v0.2.0 — confirm the
// most recent real meeting produced a transcript. That gate passed on every
// release through September 2026, including the week when seven consecutive
// meetings shipped as "Google Chrome meeting · 5 Sep 2026 at 17:09". It asked
// whether a transcript EXISTED. It never asked whether anyone could find it,
// and unfindable was the entire bug.
//
// So this asks the harder question. A meeting titled by any real source
// renders as "<name> · <app> · <when>"; one that fell through every rung of
// the ladder renders as "<app> meeting · <when>" (see meetingPayload in
// CaptureCore/MeetingPayload.swift — the two branches of one `map`). The
// second shape is machine-detectable, so it does not need a human to notice
// it, which is precisely what went wrong.
//
// Usage:  node scripts/check-meeting-titles.mjs [--days N] [--allow N]
//   --days   how far back to look (default 14)
//   --allow  tolerated fallback-titled meetings (default 0)
//
// Exit 0 = every meeting in the window carries a real name (or there were no
// meetings, which this reports rather than passing silently).

import { connect } from "node:net";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const num = (flag, dflt) => {
  const i = args.indexOf(flag);
  if (i === -1) return dflt;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : dflt;
};
const days = num("--days", 14);
const allow = num("--allow", 0);

const sock = process.env.SHYN_SOCK
  ?? join(process.env.SHYN_HOME ?? join(homedir(), "Library", "Application Support", "shyn"),
          "shyn.sock");

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const c = connect(sock);
    let buf = "";
    const t = setTimeout(() => { c.destroy(); reject(new Error("timeout")); }, 15_000);
    c.on("error", (e) => { clearTimeout(t); reject(e); });
    c.on("connect", () => c.write(JSON.stringify(
      { jsonrpc: "2.0", id: 1, method, params }) + "\n"));
    c.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(t);
      c.end();
      const msg = JSON.parse(buf.slice(0, nl));
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    });
  });
}

// The fallback shape, anchored: the first " · "-separated segment ends in
// " meeting". A real title would have to be literally named "<something>
// meeting" AND sit in first position to false-positive here, which is worth
// the trade — a false alarm costs a glance, a miss costs a week.
const isFallbackTitled = (title) => /^.+ meeting · /.test(title);

const timeFrom = Math.floor(Date.now() / 1000) - days * 86_400;

let rows;
try {
  rows = await rpc("recent", { timeFrom, sources: ["meeting"], limit: 200, order: "desc" });
} catch (e) {
  console.error(`meeting-title check: cannot reach the daemon at ${sock} — ${e.message}`);
  console.error("start it (`shyn setup`) and re-run; this gate needs real captured meetings.");
  process.exit(1);
}

if (!rows.length) {
  // Not a pass. The gate's whole purpose is evidence from a real meeting; no
  // meetings means no evidence, and saying "OK" here is how the old gate
  // managed to be green while broken.
  console.error(`meeting-title check: NO meetings captured in the last ${days} days.`);
  console.error("Nothing to verify — record one before tagging, or widen --days.");
  process.exit(1);
}

const fallback = rows.filter((r) => isFallbackTitled(r.title));
const named = rows.length - fallback.length;

console.log(`meetings in the last ${days} days: ${rows.length} — ${named} named, ${fallback.length} fallback-titled`);
for (const r of fallback) console.log(`  UNNAMED  ${r.title}`);

if (fallback.length > allow) {
  console.error("");
  console.error(`FAIL: ${fallback.length} meeting(s) fell through every rung of the title ladder.`);
  console.error("Those documents cannot be found by the name anyone knows them by.");
  console.error("Check `shyn diagnose` for the meeting line: calendar tcc and ax tcc are the");
  console.error("two permission rungs, and the browser reader feeds the tab rung above them.");
  process.exit(1);
}

console.log("meeting-title check OK");
