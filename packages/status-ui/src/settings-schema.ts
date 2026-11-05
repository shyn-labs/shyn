// The settings window's contract with capture.json. Pure (no fs, no electron)
// so the main process validates with exactly the table the renderer draws
// from, and so the tests need no fixtures.
//
// Defaults here MIRROR the Swift ones (CaptureCore/Config.swift and
// MeetingConfig.swift). The agents stay the authority at read time: a key we
// never write keeps its Swift default. These values are only what the window
// SHOWS for a key that is absent, so if a Swift default changes, change it here.

export type Scope = "top" | "meeting";
export type FieldKind = "bool" | "int" | "choice" | "list";
export type ListKind = "bundleIds" | "titlePatterns";

export interface FieldSpec {
  key: string;
  scope: Scope;
  kind: FieldKind;
  label: string;
  hint?: string;
  default: boolean | number | string | string[];
  advanced?: boolean;
  min?: number; max?: number; unit?: string;     // int
  choices?: { value: string; label: string }[];   // choice
  list?: ListKind;                                // list
}

export const FIELDS: readonly FieldSpec[] = [
  // --- Meetings -----------------------------------------------------------
  { key: "enabled", scope: "meeting", kind: "bool", label: "Record meetings", default: true,
    hint: "Detects calls and transcribes them on this Mac." },
  { key: "whisperModel", scope: "meeting", kind: "choice", label: "Transcription model",
    default: "small",
    choices: [{ value: "small", label: "Small (fast)" }, { value: "large-v3_turbo", label: "Multilingual (slower)" }],
    hint: "Multilingual copes with Hindi, Kannada and mixed speech." },
  { key: "diarization", scope: "meeting", kind: "bool", label: "Separate speakers", default: false,
    hint: "Labels who spoke in each meeting. Downloads a small model on first use." },
  { key: "calendarSync", scope: "meeting", kind: "bool", label: "Add calendar events to memory", default: true },
  { key: "excludeApps", scope: "meeting", kind: "list", list: "bundleIds", default: [],
    label: "Never treat these apps as a meeting",
    hint: "Bundle IDs, one per line. Dictation tools belong here." },
  // --- Capture ------------------------------------------------------------
  { key: "excludeBundleIds", scope: "top", kind: "list", list: "bundleIds", default: [],
    label: "Never capture these apps",
    hint: "Bundle IDs, one per line. Password managers are already excluded." },
  { key: "excludeTitlePatterns", scope: "top", kind: "list", list: "titlePatterns", default: [],
    label: "Never capture windows whose title matches",
    hint: "Regular expressions, one per line, case-insensitive. Banking and credential pages are already excluded." },
  // `retentionDays` is deliberately NOT here: the Swift config decodes it but
  // nothing enforces it (checked 2026-11-05), so a control would promise a
  // deletion that never happens. Add it when retention is actually implemented.
  // --- Updates ------------------------------------------------------------
  { key: "autoUpdate", scope: "top", kind: "bool", label: "Install updates automatically", default: false,
    hint: "Off means shyn tells you an update exists and waits." },
  // --- Advanced -----------------------------------------------------------
  { key: "chunkedTranscription", scope: "meeting", kind: "bool", advanced: true, default: true,
    label: "Transcribe voiced stretches only",
    hint: "Turn off only if speech is being missed on your hardware." },
  { key: "pollIntervalSeconds", scope: "top", kind: "int", advanced: true, default: 30,
    min: 5, max: 3600, unit: "seconds", label: "Check pages and notes every" },
  { key: "titleWatchIntervalSeconds", scope: "top", kind: "int", advanced: true, default: 3,
    min: 1, max: 60, unit: "seconds", label: "Check the front window every" },
  { key: "graceSeconds", scope: "meeting", kind: "int", advanced: true, default: 10,
    min: 0, max: 120, unit: "seconds", label: "Wait before a call counts as a meeting" },
  { key: "candidateSeconds", scope: "meeting", kind: "int", advanced: true, default: 10,
    min: 1, max: 120, unit: "seconds", label: "Confirm a candidate call for" },
  { key: "endSilenceSeconds", scope: "meeting", kind: "int", advanced: true, default: 60,
    min: 10, max: 600, unit: "seconds", label: "End a meeting after silence of" },
  { key: "maxDurationMinutes", scope: "meeting", kind: "int", advanced: true, default: 180,
    min: 10, max: 720, unit: "minutes", label: "Stop recording after" },
];

export type SettingValue = boolean | number | string | string[];
export type Settings = Record<string, SettingValue>;
export type Patch = Record<string, SettingValue>;

const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

export const defaultSettings = (): Settings =>
  Object.fromEntries(FIELDS.map((f) => [f.key, Array.isArray(f.default) ? [...f.default] : f.default]));

// Same shape check as `shyn exclude` (cli/src/capture-config.ts).
export const isBundleId = (v: string) => /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(v);

/// One line per entry, blanks dropped, duplicates removed, order kept.
export function parseListText(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function checkList(f: FieldSpec, v: unknown): string | null {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return "Expected a list of text lines";
  for (const item of v as string[]) {
    if (f.list === "bundleIds") {
      if (!isBundleId(item)) return `"${item}" is not a bundle ID (looks like com.company.app)`;
    } else {
      // Title patterns are regexes the agent applies. An invalid one would be a
      // silently dead exclude, and a privacy gate must not fail open, so refuse
      // it here rather than save it. Same flags the agent uses: case-insensitive.
      try { new RegExp(item, "i"); }
      catch { return `"${item}" is not a valid pattern`; }
    }
  }
  return null;
}

export type Validation =
  | { ok: true; patch: Patch }
  | { ok: false; errors: Record<string, string> };

/// Validates a patch of changed fields. Unknown keys are refused rather than
/// ignored: a typo in a key must not look like a saved setting.
export function validatePatch(raw: unknown): Validation {
  const errors: Record<string, string> = {};
  const patch: Patch = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: { _: "Nothing to save" } };
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    const f = BY_KEY.get(key);
    if (!f) { errors[key] = "Unknown setting"; continue; }
    switch (f.kind) {
      case "bool":
        if (typeof v !== "boolean") errors[key] = "Must be on or off"; else patch[key] = v;
        break;
      case "int":
        if (typeof v !== "number" || !Number.isInteger(v)) errors[key] = "Must be a whole number";
        else if (v < f.min! || v > f.max!) errors[key] = `Must be between ${f.min} and ${f.max} ${f.unit ?? ""}`.trim();
        else patch[key] = v;
        break;
      case "choice":
        if (typeof v !== "string" || !f.choices!.some((c) => c.value === v)) errors[key] = "Not an available choice";
        else patch[key] = v;
        break;
      case "list": {
        const bad = checkList(f, v);
        if (bad) errors[key] = bad; else patch[key] = [...new Set((v as string[]).map((s) => s.trim()))];
        break;
      }
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, patch };
}

/// Folds a raw capture.json into the values the window shows. Anything of the
/// wrong type falls back to the default, mirroring the Swift decoders'
/// tolerance, so a hand-edited file never breaks the window.
export function settingsFromConfig(cfg: Record<string, unknown>): Settings {
  const out = defaultSettings();
  const meeting = cfg.meeting && typeof cfg.meeting === "object" ? (cfg.meeting as Record<string, unknown>) : {};
  for (const f of FIELDS) {
    const v = (f.scope === "meeting" ? meeting : cfg)[f.key];
    if (v === undefined) continue;
    if (f.kind === "bool" && typeof v === "boolean") out[f.key] = v;
    else if (f.kind === "int" && typeof v === "number" && Number.isFinite(v)) out[f.key] = Math.trunc(v);
    else if (f.kind === "choice" && typeof v === "string" && v) out[f.key] = v;   // keep an unknown model visible
    else if (f.kind === "list" && Array.isArray(v)) out[f.key] = v.filter((x): x is string => typeof x === "string");
  }
  return out;
}

/// Applies a validated patch to a raw config. Keys the window does not own
/// (pausedUntil, a stale echoCancellation, anything a newer build added) pass
/// through untouched.
export function applyPatch(cfg: Record<string, unknown>, patch: Patch): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cfg };
  const meeting: Record<string, unknown> =
    cfg.meeting && typeof cfg.meeting === "object" ? { ...(cfg.meeting as Record<string, unknown>) } : {};
  for (const [key, v] of Object.entries(patch)) {
    if (BY_KEY.get(key)!.scope === "meeting") meeting[key] = v; else out[key] = v;
  }
  if (Object.keys(meeting).length) out.meeting = meeting;
  return out;
}
