import { describe, it, expect } from "vitest";
import { deriveView, type DaemonStatus, type DeriveContext, CLAUDE_ADD_COMMAND } from "../src/derive.js";

export const NOW = 1_783_700_000;

export const baseCtx = (over: Partial<DeriveContext> = {}): DeriveContext => ({
  installed: { capture: true, meeting: true },
  pausedUntil: null,
  now: NOW,
  claudeCommand: CLAUDE_ADD_COMMAND,
  meetingModel: "small",
  ...over,
});

export const healthyStatus = (over: Partial<DaemonStatus> = {}): DaemonStatus => ({
  documents: 16951, chunks: 42000, vectors: 41000,
  pendingEmbeds: 0, failedEmbeds: 0, modelLoaded: true,
  daemonVersion: "0.2.0", modelDownloadPct: 100, modelDownloaded: true,
  lastMcpHelloTs: null,
  readers: [
    { name: "chrome", ok: true, ingested: 3, deduped: 10 },
    { name: "safari", ok: false, reason: "needs Full Disk Access", ingested: 0, deduped: 0 },
  ],
  capture: {
    agentVersion: "0.1.0", lastCaptureTs: NOW - 120, captures: 42,
    tcc: { ax: true, screen: true },
    meeting: { state: "idle", meetingsCaptured: 2, lastTranscribedTs: NOW - 3600,
               modelReady: true, tcc: { mic: true, audio: true } },
  },
  ...over,
});

describe("deriveView core", () => {
  it("daemon down → warning tray, err row with start hint", () => {
    const vm = deriveView({ ok: false }, baseCtx());
    expect(vm.tray).toBe("warning");
    expect(vm.verdict).toBe("daemon not running");
    expect(vm.rows[0]).toMatchObject({ label: "Daemon", tone: "err" });
    expect(vm.rows[0].hint).toContain("shyn");
    expect(vm.meeting).toBeNull();
    expect(vm.setup.kind).toBe("unavailable");
  });

  it("healthy → healthy tray, all-systems verdict, ok rows, reader reason surfaced", () => {
    const vm = deriveView({ ok: true, status: healthyStatus() }, baseCtx());
    expect(vm.tray).toBe("healthy");
    expect(vm.verdict).toBe("all systems go");
    expect(vm.rows.find((r) => r.label === "Daemon")).toMatchObject({ tone: "ok" });
    expect(vm.rows.find((r) => r.label === "Screen capture")).toMatchObject({ tone: "ok", value: "2 min ago" });
    expect(vm.rows.find((r) => r.label === "Safari")).toMatchObject({
      tone: "warn", value: "unavailable", hint: "needs Full Disk Access",
    });
    expect(vm.stats[0].value).toContain("16,951");
    expect(vm.paused).toBe(false);
  });
});

describe("deriveView state matrix", () => {
  const withMeeting = (m: object) => healthyStatus({
    capture: { ...healthyStatus().capture,
      meeting: { ...healthyStatus().capture.meeting!, ...m } },
  });

  it("recording → recording tray outranks warnings (consent-first), live card populated", () => {
    const st = withMeeting({ state: "recording", sessionStartedAt: NOW - 300, sessionApp: "Google Meet" });
    st.capture.tcc = { ax: false, screen: false };   // concurrent warning
    const vm = deriveView({ ok: true, status: st }, baseCtx());
    expect(vm.tray).toBe("recording");
    expect(vm.verdict).toBe("recording meeting");
    expect(vm.meeting).toEqual({ app: "Google Meet", startedAt: NOW - 300, state: "recording" });
  });

  it("transcribing (agent clears session fields before this state) → transcribing tray, no card", () => {
    const vm = deriveView({ ok: true,
      status: withMeeting({ state: "transcribing" }) },
      baseCtx());
    expect(vm.tray).toBe("transcribing");
    expect(vm.meeting).toBeNull();
  });

  it("recording without sessionStartedAt (older agent) → tray still recording, no card", () => {
    const vm = deriveView({ ok: true, status: withMeeting({ state: "recording" }) }, baseCtx());
    expect(vm.tray).toBe("recording");
    expect(vm.meeting).toBeNull();
  });

  it("agent not-reporting → warning ONLY when installed", () => {
    const st = healthyStatus({ capture: { agent: "not-reporting" } });
    const on = deriveView({ ok: true, status: st }, baseCtx());
    expect(on.tray).toBe("warning");
    expect(on.rows.filter((r) => r.value === "not reporting")).toHaveLength(2);
    const off = deriveView({ ok: true, status: st },
      baseCtx({ installed: { capture: false, meeting: false } }));
    expect(off.tray).toBe("healthy");
    expect(off.rows.some((r) => r.value === "not reporting")).toBe(false);
  });

  it("mic TCC missing → warning with Settings hint; audio-unverified is muted, not warning", () => {
    const vm = deriveView({ ok: true,
      status: withMeeting({ tcc: { mic: false, audio: false } }) }, baseCtx());
    expect(vm.tray).toBe("warning");
    expect(vm.rows.find((r) => r.label === "Meeting agent")!.hint).toContain("Microphone");
    const vm2 = deriveView({ ok: true,
      status: withMeeting({ tcc: { mic: true, audio: false } }) }, baseCtx());
    expect(vm2.tray).toBe("healthy");
    expect(vm2.rows.find((r) => r.label === "System audio")).toMatchObject({ tone: "muted" });
  });

  it("paused → healthy tray (intentional state), paused verdict + flag", () => {
    const vm = deriveView({ ok: true, status: healthyStatus() },
      baseCtx({ pausedUntil: NOW + 1800 }));
    expect(vm.tray).toBe("healthy");
    expect(vm.verdict).toBe("capture paused");
    expect(vm.paused).toBe(true);
    expect(vm.rows.find((r) => r.label === "Screen capture")).toMatchObject({ value: "paused", tone: "muted" });
  });

  it("expired pause is not paused", () => {
    const vm = deriveView({ ok: true, status: healthyStatus() },
      baseCtx({ pausedUntil: NOW - 5 }));
    expect(vm.paused).toBe(false);
  });

  it("model downloading + pending embeds → muted stats rows, not warnings (degraded ladder)", () => {
    const vm = deriveView({ ok: true,
      status: healthyStatus({ modelDownloadPct: 37, pendingEmbeds: 120 }) }, baseCtx());
    expect(vm.tray).toBe("healthy");
    expect(vm.stats.find((r) => r.label === "Model download")).toMatchObject({ value: "37%", tone: "muted" });
    expect(vm.stats.find((r) => r.label === "Embedding")).toMatchObject({ value: "120 pending", tone: "muted" });
  });

  it("unavailable reader with no reason → value unavailable, no hint", () => {
    const st = healthyStatus({
      readers: [{ name: "notes", ok: false, ingested: 0, deduped: 0 }],
    });
    const vm = deriveView({ ok: true, status: st }, baseCtx());
    const row = vm.rows.find((r) => r.label === "Apple Notes")!;
    expect(row).toMatchObject({ tone: "warn", value: "unavailable" });
    expect(row.hint).toBeUndefined();
  });

  it("reader display names map to friendly labels; unknown ids pass through as-is", () => {
    const st = healthyStatus({
      readers: [
        { name: "chrome", ok: true, ingested: 1, deduped: 0 },
        { name: "safari", ok: true, ingested: 1, deduped: 0 },
        { name: "notes", ok: true, ingested: 1, deduped: 0 },
        { name: "mystery-reader", ok: true, ingested: 1, deduped: 0 },
      ],
    });
    const vm = deriveView({ ok: true, status: st }, baseCtx());
    expect(vm.rows.find((r) => r.label === "Chrome")).toBeTruthy();
    expect(vm.rows.find((r) => r.label === "Safari")).toBeTruthy();
    expect(vm.rows.find((r) => r.label === "Apple Notes")).toBeTruthy();
    expect(vm.rows.find((r) => r.label === "mystery-reader")).toBeTruthy();
  });

  it("screen TCC missing → warning with Screen & System Audio hint", () => {
    const st = healthyStatus();
    st.capture.tcc = { ax: true, screen: false };
    const vm = deriveView({ ok: true, status: st }, baseCtx());
    expect(vm.tray).toBe("warning");
    expect(vm.rows.find((r) => r.label === "Screen capture")!.hint).toContain("Screen & System Audio");
  });
});

describe("setup derivation (onboarding)", () => {
  const withStatus = (over: Partial<DaemonStatus> = {}) =>
    deriveView({ ok: true, status: { ...healthyStatus(), lastMcpHelloTs: null, ...over } }, baseCtx());
  const step = (vm: ReturnType<typeof deriveView>, id: string) => {
    if (vm.setup.kind !== "steps") throw new Error(`setup is ${vm.setup.kind}`);
    return vm.setup.steps.find((s) => s.id === id)!;
  };

  it("healthy-but-unconnected fixture: docs indexed, models ready, grants ok → only claude pending", () => {
    const vm = withStatus();
    expect(vm.setup.kind).toBe("steps");
    expect(step(vm, "audio").state).toBe("done");
    expect(step(vm, "screen").state).toBe("done");
    expect(step(vm, "models").state).toBe("done");
    expect(step(vm, "claude").state).toBe("todo");
    expect(step(vm, "claude").action).toMatchObject({ kind: "copy" });
    expect(step(vm, "recall").state).toBe("locked"); // gated on claude, not just docs
  });

  it("hello + docs but mic missing → recall DONE and still carries the prompt action", () => {
    const st = healthyStatus();
    st.capture.meeting!.tcc = { mic: false, audio: false };   // keeps setup incomplete
    const vm = deriveView({ ok: true, status: { ...st, lastMcpHelloTs: NOW - 60 } }, baseCtx());
    expect(step(vm, "claude").state).toBe("done");
    const recall = step(vm, "recall");
    expect(recall.state).toBe("done");   // they CAN recall — celebrate, don't gate
    expect(recall.action).toEqual({ kind: "copy", text: "what was I reading in the last hour?" });
  });

  it("hello seen with docs indexed and all grants → complete", () => {
    const vm = withStatus({ lastMcpHelloTs: NOW - 60 });
    expect(vm.setup.kind).toBe("complete");
  });

  it("claude done but zero documents → recall waiting, not complete", () => {
    const vm = withStatus({ lastMcpHelloTs: NOW - 60, documents: 0, vectors: 0 });
    expect(step(vm, "recall").state).toBe("waiting");
  });

  it("mic missing → audio todo with settings action; audio-tcc note never blocks", () => {
    const st = healthyStatus();
    st.capture.meeting!.tcc = { mic: false, audio: false };
    const vm = deriveView({ ok: true, status: { ...st, lastMcpHelloTs: null } }, baseCtx());
    const audio = step(vm, "audio");
    expect(audio.state).toBe("todo");
    expect(audio.action).toEqual({ kind: "settings", pane: "microphone" });
  });

  it("screen/ax missing → settings action for the right pane", () => {
    const st = healthyStatus();
    st.capture.tcc = { ax: false, screen: true };
    const vm = deriveView({ ok: true, status: { ...st, lastMcpHelloTs: null } }, baseCtx());
    expect(step(vm, "screen").state).toBe("todo");
    expect(step(vm, "screen").action).toEqual({ kind: "settings", pane: "accessibility" });
  });

  it("models: embedding downloading OR whisperDownloading → busy", () => {
    const a = withStatus({ modelDownloadPct: 40 });
    expect(step(a, "models").state).toBe("busy");
    const st = healthyStatus();
    st.capture.meeting!.modelReady = false;
    st.capture.meeting!.whisperDownloading = true;
    const b = deriveView({ ok: true, status: { ...st, lastMcpHelloTs: null } }, baseCtx());
    expect(step(b, "models").state).toBe("busy");
  });

  it("agent installed but not reporting → waiting, never a false todo", () => {
    const vm = deriveView({ ok: true,
      status: { ...healthyStatus({ capture: { agent: "not-reporting" } }), lastMcpHelloTs: null } },
      baseCtx());
    expect(step(vm, "audio").state).toBe("waiting");
    expect(step(vm, "screen").state).toBe("waiting");
  });

  it("agents not installed → their permission steps drop out of the list", () => {
    const vm = deriveView({ ok: true, status: { ...healthyStatus(), lastMcpHelloTs: null } },
      baseCtx({ installed: { capture: false, meeting: false } }));
    if (vm.setup.kind !== "steps") throw new Error("expected steps");
    expect(vm.setup.steps.map((s) => s.id)).toEqual(["models", "claude", "recall"]);
  });

  it("daemon down → unavailable", () => {
    expect(deriveView({ ok: false }, baseCtx()).setup).toEqual({ kind: "unavailable" });
  });

  it("done/total count is accurate", () => {
    const vm = withStatus();
    if (vm.setup.kind !== "steps") throw new Error("expected steps");
    expect(vm.setup.total).toBe(5);
    expect(vm.setup.done).toBe(3);   // audio, screen, models
  });

  it("claude step copies ctx.claudeCommand verbatim (shim-aware installs)", () => {
    const cmd = 'claude mcp add shyn -- "/Users/x/Library/Application Support/shyn/bin/shyn-mcp"';
    const vm = deriveView({ ok: true, status: { ...healthyStatus(), lastMcpHelloTs: null } },
      baseCtx({ claudeCommand: cmd }));
    expect(step(vm, "claude").action).toEqual({ kind: "copy", text: cmd });
  });
});

describe("week section derivation", () => {
  it("derives a This-week section when stats are present", () => {
    const vm = deriveView(
      { ok: true, status: healthyStatus(), stats: { pagesRead: 42, meetings: 3, meetingSeconds: 1800, searches: 7 } },
      baseCtx(),
    );
    const labels = vm.week.map((r) => r.label);
    expect(labels).toEqual(["Pages read", "Meetings", "Searches"]);
    expect(vm.week[0].value).toBe("42");
    expect(vm.week[1].value).toBe("3 · 30 min");
    expect(vm.week[2].value).toBe("7");
  });

  it("week section is empty when stats are absent (older daemon) or daemon down", () => {
    expect(deriveView({ ok: true, status: healthyStatus() }, baseCtx()).week).toEqual([]);
    expect(deriveView({ ok: false }, baseCtx()).week).toEqual([]);
  });
});

describe("diagnostics flag", () => {
  it("offers Copy diagnostics only in warning states", () => {
    const healthy = deriveView({ ok: true, status: healthyStatus() }, baseCtx());
    expect(healthy.diagnostics).toBe(false);
    const down = deriveView({ ok: false }, baseCtx());
    expect(down.diagnostics).toBe(true);
  });
});

it("todo permission steps offer the reveal-apps fallback", () => {
  const vm = deriveView(
    { ok: true, status: healthyStatus({ capture: { agent: "reporting", captures: 1, tcc: { ax: false, screen: false },
      meeting: { state: "idle", meetingsCaptured: 0, lastTranscribedTs: 0, modelReady: true, tcc: { mic: false, audio: false } } } }) },
    baseCtx(),
  );
  if (vm.setup.kind !== "steps") throw new Error("expected steps");
  const perm = vm.setup.steps.filter((st) => st.id === "audio" || st.id === "screen");
  expect(perm.length).toBeGreaterThan(0);
  for (const st of perm) {
    expect(st.state).toBe("todo");
    expect(st.secondaryAction).toEqual({ kind: "reveal-apps" });
    expect(st.optionalNote).toMatch(/drag it from the apps folder/);
  }
});

describe("meeting model choice (language-framed setting)", () => {
  const withMeeting = (m: object) => healthyStatus({
    capture: { ...healthyStatus().capture,
      meeting: { ...healthyStatus().capture.meeting!, ...m } },
  });

  it("default: standard selected, not busy, no note", () => {
    const vm = deriveView({ ok: true, status: healthyStatus() }, baseCtx());
    expect(vm.modelChoice).toEqual({ selected: "standard", busy: false });
  });

  it("multilingual selected + downloading → busy with honest interim note", () => {
    const vm = deriveView(
      { ok: true, status: withMeeting({ modelReady: false, whisperDownloading: true }) },
      baseCtx({ meetingModel: "large-v3" }));
    expect(vm.modelChoice).toMatchObject({ selected: "multilingual", busy: true });
    expect(vm.modelChoice!.note).toContain("Standard");
  });

  it("multilingual selected, not ready, not downloading → next-meeting note", () => {
    const vm = deriveView(
      { ok: true, status: withMeeting({ modelReady: false }) },
      baseCtx({ meetingModel: "large-v3" }));
    expect(vm.modelChoice).toMatchObject({ selected: "multilingual", busy: false });
    expect(vm.modelChoice!.note).toContain("next meeting");
  });

  it("multilingual selected and ready → no note", () => {
    const vm = deriveView(
      { ok: true, status: withMeeting({ modelReady: true }) },
      baseCtx({ meetingModel: "large-v3" }));
    expect(vm.modelChoice).toEqual({ selected: "multilingual", busy: false });
  });

  it("power-user custom model → custom, named in note, both buttons unselected", () => {
    const vm = deriveView({ ok: true, status: healthyStatus() },
      baseCtx({ meetingModel: "medium" }));
    expect(vm.modelChoice).toMatchObject({ selected: "custom", busy: false });
    expect(vm.modelChoice!.note).toContain("medium");
  });

  it("meeting agent not installed or not reporting → null", () => {
    const vm1 = deriveView({ ok: true, status: healthyStatus() },
      baseCtx({ installed: { capture: true, meeting: false } }));
    expect(vm1.modelChoice).toBeNull();
    const noBlock = healthyStatus();
    delete (noBlock.capture as { meeting?: unknown }).meeting;
    const vm2 = deriveView({ ok: true, status: noBlock }, baseCtx());
    expect(vm2.modelChoice).toBeNull();
  });
});

describe("calendar access (meeting stamping)", () => {
  const withMeeting = (m: object) => healthyStatus({
    capture: { ...healthyStatus().capture,
      meeting: { ...healthyStatus().capture.meeting!, ...m } },
  });

  it("calendar false → muted informational row, never a warning", () => {
    const vm = deriveView({ ok: true,
      status: withMeeting({ tcc: { mic: true, audio: true, calendar: false } }) }, baseCtx());
    expect(vm.tray).toBe("healthy");
    const row = vm.rows.find((r) => r.label === "Calendar")!;
    expect(row).toMatchObject({ tone: "muted" });
    expect(row.value).toContain("meetings won't be titled");
  });

  it("calendar true → no row; older agent without the key → no row", () => {
    const withCal = deriveView({ ok: true,
      status: withMeeting({ tcc: { mic: true, audio: true, calendar: true } }) }, baseCtx());
    expect(withCal.rows.find((r) => r.label === "Calendar")).toBeUndefined();
    const oldAgent = deriveView({ ok: true, status: healthyStatus() }, baseCtx());
    expect(oldAgent.rows.find((r) => r.label === "Calendar")).toBeUndefined();
  });
});
