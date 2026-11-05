import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIELDS, defaultSettings, validatePatch, settingsFromConfig, applyPatch, parseListText,
} from "../src/settings-schema.js";
import { readSettings, saveSettings } from "../src/settings.js";
import { renderSettings } from "../renderer/settings-render.js";

const home = () => mkdtempSync(join(tmpdir(), "shyn-set-"));
const cfgOf = (h: string) => JSON.parse(readFileSync(join(h, "capture.json"), "utf8"));

describe("settings schema", () => {
  it("every field has a unique key and a default of the right type", () => {
    expect(new Set(FIELDS.map((f) => f.key)).size).toBe(FIELDS.length);
    for (const f of FIELDS) {
      if (f.kind === "bool") expect(typeof f.default).toBe("boolean");
      if (f.kind === "int") { expect(typeof f.default).toBe("number"); expect(f.min).toBeLessThanOrEqual(f.default as number); expect(f.max).toBeGreaterThanOrEqual(f.default as number); }
      if (f.kind === "list") expect(Array.isArray(f.default)).toBe(true);
      if (f.kind === "choice") expect(f.choices!.some((c) => c.value === f.default)).toBe(true);
    }
  });

  it("does not offer retentionDays (nothing enforces it)", () => {
    expect(FIELDS.some((f) => f.key === "retentionDays")).toBe(false);
  });

  it("absent keys show defaults; wrong types fall back; unknown model stays visible", () => {
    expect(settingsFromConfig({})).toEqual(defaultSettings());
    const s = settingsFromConfig({ pollIntervalSeconds: "fast", meeting: { whisperModel: "large-v3", diarization: "yes", excludeApps: ["a.b", 3] } });
    expect(s.pollIntervalSeconds).toBe(30);
    expect(s.diarization).toBe(false);
    expect(s.whisperModel).toBe("large-v3");
    expect(s.excludeApps).toEqual(["a.b"]);
  });

  it("validates ranges, types, choices and refuses unknown keys", () => {
    expect(validatePatch({ pollIntervalSeconds: 2 }).ok).toBe(false);
    expect(validatePatch({ pollIntervalSeconds: 10.5 }).ok).toBe(false);
    expect(validatePatch({ diarization: "on" }).ok).toBe(false);
    expect(validatePatch({ whisperModel: "huge" }).ok).toBe(false);
    expect(validatePatch({ retentionDays: 7 }).ok).toBe(false);
    expect(validatePatch({ pollIntervalSeconds: 60, whisperModel: "small" }).ok).toBe(true);
    expect(validatePatch(null).ok).toBe(false);
  });

  it("refuses a bad bundle id and an invalid title regex, so no exclude is silently dead", () => {
    const b = validatePatch({ excludeBundleIds: ["not a bundle"] });
    expect(b.ok).toBe(false);
    const r = validatePatch({ excludeTitlePatterns: ["(unclosed"] });
    expect(r.ok).toBe(false);
    const ok = validatePatch({ excludeBundleIds: ["com.x.y", "com.x.y"], excludeTitlePatterns: ["payroll", "\\bhr\\b"] });
    expect(ok.ok && ok.patch.excludeBundleIds).toEqual(["com.x.y"]);   // deduped
  });

  it("parseListText trims, drops blanks, dedupes, keeps order", () => {
    expect(parseListText(" a.b \n\n c.d\r\na.b\n")).toEqual(["a.b", "c.d"]);
  });

  it("applyPatch puts meeting keys under meeting and keeps keys it does not own", () => {
    const out = applyPatch({ pausedUntil: 5, meeting: { echoCancellation: false, whisperModel: "small" } },
      { diarization: true, pollIntervalSeconds: 45 });
    expect(out).toEqual({ pausedUntil: 5, pollIntervalSeconds: 45,
      meeting: { echoCancellation: false, whisperModel: "small", diarization: true } });
  });
});

describe("settings io", () => {
  it("round-trips and preserves unrelated keys and the meeting object", () => {
    const h = home();
    writeFileSync(join(h, "capture.json"), JSON.stringify({ autoUpdate: true, pausedUntil: 9,
      meeting: { whisperModel: "large-v3_turbo", excludeApps: ["com.pais.handy"] } }));
    const r = saveSettings(h, { diarization: true, excludeBundleIds: ["com.a.b"] });
    expect(r.ok).toBe(true);
    const c = cfgOf(h);
    expect(c.pausedUntil).toBe(9);
    expect(c.autoUpdate).toBe(true);
    expect(c.meeting.whisperModel).toBe("large-v3_turbo");
    expect(c.meeting.excludeApps).toEqual(["com.pais.handy"]);
    expect(c.meeting.diarization).toBe(true);
    expect(readSettings(h).excludeBundleIds).toEqual(["com.a.b"]);
  });

  it("creates capture.json when absent and leaves no temp file", () => {
    const h = home();
    expect(saveSettings(h, { autoUpdate: true }).ok).toBe(true);
    expect(cfgOf(h)).toEqual({ autoUpdate: true });
    expect(existsSync(join(h, "capture.json.tmp"))).toBe(false);
  });

  it("refuses to overwrite a capture.json that does not parse", () => {
    const h = home();
    writeFileSync(join(h, "capture.json"), "{ not json");
    const r = saveSettings(h, { autoUpdate: true });
    expect(r.ok).toBe(false);
    expect(readFileSync(join(h, "capture.json"), "utf8")).toBe("{ not json");
  });

  it("writes nothing when validation fails", () => {
    const h = home();
    expect(saveSettings(h, { pollIntervalSeconds: 1 }).ok).toBe(false);
    expect(existsSync(join(h, "capture.json"))).toBe(false);
  });
});

describe("settings render", () => {
  const base = { settings: defaultSettings(), analytics: true as boolean | null, errors: {}, advancedOpen: false, status: "" };
  it("shows groups, hides Advanced fields until opened", () => {
    const html = renderSettings(base);
    expect(html).toContain("Transcription model");
    expect(html).not.toContain("End a meeting after silence of");
    expect(renderSettings({ ...base, advancedOpen: true })).toContain("End a meeting after silence of");
  });
  it("escapes list content and shows per-field errors", () => {
    const s = { ...base.settings, excludeBundleIds: ['<img src=x onerror=1>'] };
    const html = renderSettings({ ...base, settings: s, errors: { excludeBundleIds: 'bad "x"' } });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
    expect(html).toContain("bad &quot;x&quot;");
  });
  it("says analytics is unavailable rather than drawing a switch that cannot work", () => {
    const html = renderSettings({ ...base, analytics: null });
    expect(html).not.toContain('name="analytics"');
    expect(html).toContain("Unavailable");
  });
  it("lists a custom whisper model instead of silently resetting it", () => {
    const html = renderSettings({ ...base, settings: { ...base.settings, whisperModel: "large-v3" } });
    expect(html).toContain("large-v3 (custom)");
  });
});
