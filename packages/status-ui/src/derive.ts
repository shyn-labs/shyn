export type DaemonStatus = {
  documents: number; chunks: number; vectors: number;
  pendingEmbeds: number; failedEmbeds: number;
  modelLoaded: boolean; daemonVersion: string;
  modelDownloadPct: number; modelDownloaded: boolean;
  lastMcpHelloTs: number | null;
  readers: { name: string; ok: boolean; reason?: string; ingested: number; deduped: number }[];
  capture: {
    agent?: string;
    agentVersion?: string; lastCaptureTs?: number; captures?: number;
    tcc?: { ax?: boolean; screen?: boolean };
    meeting?: MeetingBlock;
  };
};

export type MeetingBlock = {
  state: string; meetingsCaptured: number; lastTranscribedTs: number;
  modelReady: boolean;
  tcc: { mic: boolean; audio: boolean; calendar?: boolean };  // calendar: agents ≥ stamping
  sessionStartedAt?: number; sessionApp?: string;
  whisperDownloading?: boolean;
};

export type WeekStats = {
  pagesRead: number; meetings: number; meetingSeconds: number; searches: number;
};
export type PollResult =
  | { ok: true; status: DaemonStatus; stats?: WeekStats }
  | { ok: false };
export type Tone = "ok" | "warn" | "err" | "muted";
export type Row = { label: string; value: string; tone: Tone; hint?: string };
export type TrayState = "healthy" | "recording" | "transcribing" | "warning";

export type SettingsPane = "microphone" | "screen-recording" | "accessibility";
export type SetupAction = { kind: "settings"; pane: SettingsPane } | { kind: "copy"; text: string } | { kind: "reveal-apps" };
export type SetupStepState = "done" | "todo" | "busy" | "locked" | "waiting";
export type SetupStep = {
  id: "audio" | "screen" | "models" | "claude" | "recall";
  title: string; detail: string; state: SetupStepState;
  action?: SetupAction; secondaryAction?: SetupAction; optionalNote?: string;
};
export type SetupView =
  | { kind: "steps"; steps: SetupStep[]; done: number; total: number }
  | { kind: "complete" }
  | { kind: "unavailable" };

// Meeting transcription model, framed by language, not model jargon
// (spec 2026-07-23): "standard" = whisper small, "multilingual" = large-v3,
// "custom" = any other value a power user set in capture.json by hand.
export type ModelChoice = {
  selected: "standard" | "multilingual" | "custom";
  busy: boolean;      // whisperDownloading — the pre-download is in flight
  note?: string;      // honest interim state; absent when nothing to say
};

export type ViewModel = {
  tray: TrayState;
  verdict: string;
  meeting: { app: string; startedAt: number; state: "recording" } | null;
  rows: Row[];
  stats: Row[];
  week: Row[];
  paused: boolean;
  modelChoice: ModelChoice | null;
  setup: SetupView;
  diagnostics: boolean;
};

export type DeriveContext = {
  installed: { capture: boolean; meeting: boolean };
  pausedUntil: number | null;  // epoch seconds, from capture.json
  now: number;                 // epoch seconds
  claudeCommand: string;       // claude mcp add command, shim-aware
  meetingModel: string;        // capture.json meeting.whisperModel ("small" default)
};

const READER_DISPLAY_NAMES: Record<string, string> = {
  chrome: "Chrome", safari: "Safari", notes: "Apple Notes",
};
const readerDisplayName = (name: string): string => READER_DISPLAY_NAMES[name] ?? name;

export const RECALL_PROMPT = "what was I reading in the last hour?";
export const CLAUDE_ADD_COMMAND =
  "claude mcp add shyn -- pnpm --dir <path-to-shyn-repo> --filter @shyn/mcp-client exec tsx src/main.ts";

const START_HINT = "start it: shyn install (or pnpm --filter @shyn/daemon start)";
const MIC_HINT = "System Settings → Privacy & Security → Microphone";
const SCREEN_HINT = "System Settings → Privacy & Security → Screen & System Audio Recording";
const SILENT_HINT = "agent installed but silent — crashed or quarantined? (see known-issues.md)";

export function deriveView(poll: PollResult, ctx: DeriveContext): ViewModel {
  if (!poll.ok) {
    return {
      tray: "warning", verdict: "daemon not running", meeting: null,
      rows: [{ label: "Daemon", value: "unreachable", tone: "err", hint: START_HINT }],
      stats: [], week: [], paused: false, modelChoice: null,
      setup: { kind: "unavailable" },
      diagnostics: true,
    };
  }
  const s = poll.status;
  const rows: Row[] = [];
  const problems: string[] = [];
  const paused = ctx.pausedUntil !== null && ctx.pausedUntil > ctx.now;

  rows.push({ label: "Daemon", value: `v${s.daemonVersion}`, tone: "ok" });

  const cap = s.capture ?? {};
  if (ctx.installed.capture) {
    if (typeof cap.captures === "number") {
      const tccWarn = cap.tcc?.ax === false || cap.tcc?.screen === false;
      if (tccWarn) {
        rows.push({ label: "Screen capture", value: "permission missing", tone: "warn", hint: SCREEN_HINT });
        problems.push("screen capture permission");
      } else {
        const ago = typeof cap.lastCaptureTs === "number" && cap.lastCaptureTs > 0
          ? agoText(ctx.now - cap.lastCaptureTs) : "no captures yet";
        rows.push({ label: "Screen capture", value: paused ? "paused" : ago, tone: paused ? "muted" : "ok" });
      }
    } else {
      rows.push({ label: "Screen capture", value: "not reporting", tone: "warn", hint: SILENT_HINT });
      problems.push("screen agent not reporting");
    }
  }

  const m = cap.meeting;
  let meeting: ViewModel["meeting"] = null;
  if (ctx.installed.meeting) {
    if (m) {
      if (m.tcc.mic === false) {
        rows.push({ label: "Meeting agent", value: "mic permission missing", tone: "warn", hint: MIC_HINT });
        problems.push("microphone permission");
      } else if (m.state === "recording" || m.state === "transcribing") {
        rows.push({ label: "Meeting agent", value: m.state, tone: m.state === "recording" ? "err" : "ok" });
        // Live card is recording-only: the Swift agent clears sessionStartedAt/
        // sessionApp in endSession BEFORE posting state "transcribing", so a
        // transcribing status never carries session fields — asserting a card
        // for it would be unreachable. See docs/superpowers/specs/2026-07-10-status-ui-design.md.
        if (m.state === "recording" && m.sessionStartedAt)
          meeting = { app: m.sessionApp ?? "Call", startedAt: m.sessionStartedAt, state: m.state };
      } else {
        rows.push({
          label: "Meeting agent",
          value: `${m.meetingsCaptured} captured${m.modelReady ? "" : " · model not ready"}`,
          tone: "ok",
        });
        // Live-verification finding: tcc.audio only turns true on the first
        // successful recording — false at boot is NOT a problem state.
        if (m.tcc.audio === false)
          rows.push({ label: "System audio", value: "unverified until first meeting", tone: "muted" });
        // Calendar access is optional (stamping only) — informational, never
        // a warning. Older agents don't report the key: say nothing.
        if (m.tcc.calendar === false)
          rows.push({ label: "Calendar", value: "not granted", tone: "muted",
            hint: "optional — without it, meetings won't be titled from your calendar" });
      }
    } else {
      rows.push({ label: "Meeting agent", value: "not reporting", tone: "warn", hint: SILENT_HINT });
      problems.push("meeting agent not reporting");
    }
  }

  // Unavailable readers surface their plain-language reason but are NOT
  // problems — declining FDA is a supported state (CLAUDE.md invariant).
  for (const r of s.readers ?? []) {
    const label = readerDisplayName(r.name);
    rows.push(r.ok
      ? { label, value: r.ingested > 0 ? `ok · ${r.ingested} new` : "ok", tone: "ok" }
      : { label, value: "unavailable", tone: "warn", ...(r.reason ? { hint: r.reason } : {}) });
  }

  const stats: Row[] = [{
    label: "Index",
    value: `${s.documents.toLocaleString("en-US")} docs · ${s.vectors.toLocaleString("en-US")} vectors`,
    tone: "muted",
  }];
  if (s.pendingEmbeds > 0) stats.push({ label: "Embedding", value: `${s.pendingEmbeds} pending`, tone: "muted" });
  if (s.modelDownloadPct < 100) stats.push({ label: "Model download", value: `${s.modelDownloadPct}%`, tone: "muted" });

  const week: Row[] = [];
  if (poll.ok && poll.stats) {
    const w = poll.stats;
    week.push({ label: "Pages read", value: w.pagesRead.toLocaleString("en-US"), tone: "muted" });
    week.push({
      label: "Meetings",
      value: w.meetingSeconds > 0 ? `${w.meetings} · ${Math.round(w.meetingSeconds / 60)} min` : String(w.meetings),
      tone: "muted",
    });
    week.push({ label: "Searches", value: w.searches.toLocaleString("en-US"), tone: "muted" });
  }

  // Meeting model choice: only meaningful when the agent is installed and
  // reporting (modelReady tracks the CURRENTLY CONFIGURED model — the Swift
  // agent re-reads capture.json on every stats post, so a switch here flips
  // modelReady false until the new model is on disk).
  let modelChoice: ModelChoice | null = null;
  if (ctx.installed.meeting && m) {
    const selected: ModelChoice["selected"] =
      ctx.meetingModel === "large-v3" ? "multilingual"
      : ctx.meetingModel === "small" ? "standard" : "custom";
    const busy = m.whisperDownloading === true;
    let note: string | undefined;
    if (selected === "custom")
      note = `custom model "${ctx.meetingModel}" set in capture.json`;
    else if (busy)
      note = selected === "multilingual"
        ? "downloading the Multilingual model — meetings still use Standard until it finishes"
        : "downloading the transcription model…";
    else if (!m.modelReady)
      note = "the model downloads at your next meeting — that transcript will take longer";
    modelChoice = { selected, busy, ...(note !== undefined ? { note } : {}) };
  }

  const tray: TrayState =
    m?.state === "recording" ? "recording"
    : m?.state === "transcribing" ? "transcribing"
    : problems.length > 0 ? "warning" : "healthy";
  const diagnostics = tray === "warning" || !poll.ok;

  const verdict =
    tray === "recording" ? "recording meeting"
    : tray === "transcribing" ? "transcribing meeting"
    : problems.length > 0 ? problems[0]
    : paused ? "capture paused" : "all systems go";

  // Setup derivation
  const steps: SetupStep[] = [];
  const meetingReported = m !== undefined;
  const screenReported = typeof cap.captures === "number";

  if (ctx.installed.meeting) {
    steps.push(!meetingReported
      ? { id: "audio", title: "Microphone & system audio", state: "waiting",
          detail: "waiting for the meeting agent to report…" }
      : m!.tcc.mic
        ? { id: "audio", title: "Microphone & system audio", state: "done",
            detail: "meetings will be transcribed",
            optionalNote: m!.tcc.audio ? undefined : "system audio verifies itself at your first meeting" }
        : { id: "audio", title: "Microphone & system audio", state: "todo",
            detail: "allow shyn-meeting to hear your calls",
            action: { kind: "settings", pane: "microphone" },
            secondaryAction: { kind: "reveal-apps" },
            optionalNote: "if shyn-meeting isn't listed, drag it from the apps folder onto the Settings list" });
  }

  if (ctx.installed.capture) {
    const ax = cap.tcc?.ax === true, screenOk = cap.tcc?.screen === true;
    steps.push(!screenReported
      ? { id: "screen", title: "Screen recording & Accessibility", state: "waiting",
          detail: "waiting for the capture agent to report…" }
      : ax && screenOk
        ? { id: "screen", title: "Screen recording & Accessibility", state: "done",
            detail: "what you read becomes searchable",
            optionalNote: s.readers?.some((r) => !r.ok)
              ? "optional: Full Disk Access adds Safari & Apple Notes" : undefined }
        : { id: "screen", title: "Screen recording & Accessibility", state: "todo",
            detail: "allow shyn-capture to read your screen",
            action: { kind: "settings", pane: ax ? "screen-recording" : "accessibility" },
            secondaryAction: { kind: "reveal-apps" },
            optionalNote: "if shyn-capture isn't listed, drag it from the apps folder onto the Settings list" });
  }

  const whisperBusy = m?.whisperDownloading === true;
  const modelsDone = s.modelDownloadPct >= 100 && (m === undefined || m.modelReady);
  steps.push(modelsDone
    ? { id: "models", title: "Memory models", state: "done", detail: "hybrid search + transcription ready" }
    : { id: "models", title: "Memory models",
        state: s.modelDownloadPct < 100 || whisperBusy ? "busy" : "waiting",
        detail: s.modelDownloadPct < 100
          ? `downloading… ${s.modelDownloadPct}% · search already works`
          : "downloading the transcription model…" });

  const claudeDone = typeof s.lastMcpHelloTs === "number";
  steps.push(claudeDone
    ? { id: "claude", title: "Connect Claude", state: "done", detail: "Claude has talked to shyn" }
    : { id: "claude", title: "Connect Claude", state: "todo",
        detail: "run this once, then restart Claude",
        action: { kind: "copy", text: ctx.claudeCommand } });

  // Recall is DONE once it's possible (claude + docs) — the prompt stays on
  // the done step, and the completion view repeats it, so it's never
  // vaporized before the user reads it.
  steps.push(!claudeDone
    ? { id: "recall", title: "Try your first recall", state: "locked",
        detail: "unlocks when Claude is connected" }
    : s.documents > 0
      ? { id: "recall", title: "Try your first recall", state: "done",
          detail: "paste this into Claude", action: { kind: "copy", text: RECALL_PROMPT } }
      : { id: "recall", title: "Try your first recall", state: "waiting",
          detail: "waiting for the first memories to be indexed…" });

  const done = steps.filter((st) => st.state === "done").length;
  const complete = steps.every((st) => st.state === "done");
  const setup: SetupView = complete ? { kind: "complete" }
    : { kind: "steps", steps, done, total: steps.length };

  return { tray, verdict, meeting, rows, stats, week, paused, modelChoice, setup, diagnostics };
}

function agoText(sec: number): string {
  if (sec < 90) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} d ago`;
}
