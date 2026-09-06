import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDiagnostics, diagnosticsMailtoUrl, SUPPORT_EMAIL, type DiagnoseDeps } from "../src/diagnose.js";

const FAKE_STATUS = {
  documents: 100, chunks: 200, vectors: 190,
  pendingEmbeds: 0, failedEmbeds: 3,
  modelLoaded: false, modelDownloaded: true, modelDownloadPct: 100,
  daemonVersion: "0.3.0-alpha", protocolVersion: 1, schemaVersion: 4,
  lastMcpHelloTs: 1_780_000_000,
  readers: [
    { name: "chrome", ok: true, ingested: 5, deduped: 1 },
    { name: "safari", ok: false, reason: "needs Full Disk Access", ingested: 0, deduped: 0 },
  ],
  capture: { agent: "reporting", tcc: { ax: true, screen: false },
    meeting: { state: "idle", tcc: { mic: true, audio: true, calendar: true, ax: false }, modelReady: true } },
};

function deps(over: Partial<DiagnoseDeps> = {}): DiagnoseDeps {
  const logDir = mkdtempSync(join(tmpdir(), "shyn-diag-"));
  writeFileSync(join(logDir, "daemon.log"),
    ["boot ok", "ERROR: embed failed once", "fine line", "Error: socket hiccup",
     "SECRET CONTENT this line has no error marker"].join("\n"));
  return {
    sock: "/tmp/nope.sock", logDir, uid: 501,
    exec: (_c, args) => `state = running\nlast exit code = 0\n(${args[1]})`,
    rpc: async () => FAKE_STATUS,
    ...over,
  };
}

describe("buildDiagnostics", () => {
  it("contains every category, no content, under 80 lines", async () => {
    const text = await buildDiagnostics(deps());
    expect(text).toMatch(/daemon 0\.3\.0-alpha/);
    expect(text).toMatch(/protocol 1/);
    expect(text).toMatch(/com\.shyn\.daemon: running \(last exit 0\)/);
    expect(text).toMatch(/model: downloaded 100%/);
    expect(text).toMatch(/safari: unavailable — needs Full Disk Access/);
    expect(text).toMatch(/screen tcc: no/);
    expect(text).toMatch(/index: 100 docs/);
    expect(text).toMatch(/ERROR: embed failed once/);
    expect(text).not.toMatch(/SECRET CONTENT/); // non-error log lines never included
    expect(text.split("\n").length).toBeLessThan(80);
  });

  it("still produces services and log sections when the daemon is down", async () => {
    const text = await buildDiagnostics(deps({ rpc: async () => { throw new Error("ECONNREFUSED"); } }));
    expect(text).toMatch(/daemon: not reachable/);
    expect(text).toMatch(/com\.shyn\.daemon: running/);
    expect(text).toMatch(/ERROR: embed failed once/);
  });

  it("reports a service as not loaded when launchctl print fails", async () => {
    const text = await buildDiagnostics(deps({ exec: () => { throw new Error("Could not find service"); } }));
    expect(text).toMatch(/com\.shyn\.daemon: not loaded/);
  });

  it("classifies realistic error formats in, prose mentions out", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "shyn-diag-fmt-"));
    writeFileSync(join(logDir, "daemon.log"), [
      "model download failed: connect ETIMEDOUT",       // daemon main.ts:63 — marker is token 3
      "[error] something broke",                        // bracketed level marker
      "2026-07-11 12:00:00 ERROR whisper crashed",      // timestamp-first (Swift agents)
      "Error: ENOENT no such file",                     // classic Node error prefix
      "TypeError: Cannot read properties of undefined", // uncaught-exception crash line
      "SECRET CONTENT this line has no error marker",   // prose mention late in sentence — OUT
    ].join("\n"));
    const text = await buildDiagnostics(deps({ logDir }));
    expect(text).toMatch(/model download failed: connect ETIMEDOUT/);
    expect(text).toMatch(/\[error\] something broke/);
    expect(text).toMatch(/ERROR whisper crashed/);
    expect(text).toMatch(/Error: ENOENT no such file/);
    expect(text).toMatch(/TypeError: Cannot read properties of undefined/);
    expect(text).not.toMatch(/SECRET CONTENT/);
  });

  it("reports an unreadable log instead of throwing", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "shyn-diag-unread-"));
    // A directory named like the log file: existsSync passes, readFileSync throws EISDIR.
    mkdirSync(join(logDir, "daemon.log"));
    const text = await buildDiagnostics(deps({ logDir }));
    expect(text).toMatch(/daemon\.log: unreadable \(EISDIR\)/);
  });

  it("caps error lines at 10 per log", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "shyn-diag-cap-"));
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "daemon.log"),
      Array.from({ length: 30 }, (_, i) => `ERROR line ${i}`).join("\n"));
    const text = await buildDiagnostics(deps({ logDir }));
    expect(text).toMatch(/ERROR line 29/);
    expect(text).not.toMatch(/ERROR line 19\b/);
  });
});

describe("diagnosticsMailtoUrl", () => {
  it("targets the support address with subject, body, and the block", () => {
    const url = diagnosticsMailtoUrl("== shyn diagnostics ==\nversions: daemon x", "v9.9.9");
    expect(url.startsWith(`mailto:${SUPPORT_EMAIL}?subject=`)).toBe(true);
    expect(decodeURIComponent(url)).toContain("shyn diagnostics — v9.9.9");
    expect(decodeURIComponent(url)).toContain("versions: daemon x");
    expect(decodeURIComponent(url)).toContain("What happened");
  });

  it("truncates oversized blocks so mail clients accept the URL", () => {
    const url = diagnosticsMailtoUrl("x".repeat(20000));
    expect(url.length).toBeLessThan(12000);
    expect(decodeURIComponent(url)).toContain("[truncated");
  });
});

describe("meeting naming ladder permissions", () => {
  // Lived 2026-09-06: both rungs of the meeting naming ladder (EventKit stamp,
  // then window title) were dead — the local calendar copy was stale and
  // com.shyn.meeting had Accessibility denied — and `shyn diagnose` reported
  // neither, so the only visible symptom was meetings titled "Google Chrome
  // meeting". A permission that silently degrades naming must still print.
  it("prints the calendar and accessibility grants behind meeting titles", async () => {
    const text = await buildDiagnostics(deps());
    const line = text.split("\n").find((l) => l.startsWith("meeting:"))!;
    expect(line).toContain("calendar tcc: yes");
    expect(line).toContain("ax tcc: no");
  });
});
