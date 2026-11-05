// The settings window's markup. Pure (state in, HTML out) so it is testable
// without a DOM; renderer/settings.ts is only wiring.

import { FIELDS, type FieldSpec, type Settings } from "../src/settings-schema.js";

export interface SettingsState {
  settings: Settings;
  /** null = the daemon is unreachable or the first-run choice is unanswered. */
  analytics: boolean | null;
  errors: Record<string, string>;
  advancedOpen: boolean;
  /** Footer line: "Saved", a failure note, or empty. */
  status: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function control(f: FieldSpec, v: Settings[string]): string {
  const name = `name="${f.key}"`;
  switch (f.kind) {
    case "bool":
      return `<input type="checkbox" ${name} ${v === true ? "checked" : ""} />`;
    case "choice":
      return `<select ${name}>${f.choices!.map((c) =>
        `<option value="${esc(c.value)}" ${c.value === v ? "selected" : ""}>${esc(c.label)}</option>`).join("")}
        ${f.choices!.some((c) => c.value === v) ? "" : `<option value="${esc(String(v))}" selected>${esc(String(v))} (custom)</option>`}
      </select>`;
    case "int":
      return `<span class="num"><input type="number" ${name} value="${Number(v)}" min="${f.min}" max="${f.max}" step="1" />
        <span class="unit">${esc(f.unit ?? "")}</span></span>`;
    case "list":
      return `<textarea ${name} rows="3" spellcheck="false" placeholder="${f.list === "bundleIds" ? "com.example.app" : "pattern"}">${esc((v as string[]).join("\n"))}</textarea>`;
  }
}

function field(f: FieldSpec, s: SettingsState): string {
  const err = s.errors[f.key];
  const stacked = f.kind === "list";
  return `<div class="field ${stacked ? "stacked" : ""} ${err ? "bad" : ""}" data-key="${f.key}">
    <label><span class="flab">${esc(f.label)}</span>${stacked ? "" : control(f, s.settings[f.key])}</label>
    ${stacked ? control(f, s.settings[f.key]) : ""}
    ${f.hint ? `<div class="fhint">${esc(f.hint)}</div>` : ""}
    ${err ? `<div class="ferr">${esc(err)}</div>` : ""}
  </div>`;
}

const GROUPS: { title: string; keys: string[] }[] = [
  { title: "Meetings", keys: ["enabled", "whisperModel", "diarization", "calendarSync", "excludeApps"] },
  { title: "Capture", keys: ["excludeBundleIds", "excludeTitlePatterns"] },
  { title: "Updates", keys: ["autoUpdate"] },
];

export function renderSettings(s: SettingsState): string {
  const by = new Map(FIELDS.map((f) => [f.key, f]));
  const group = (g: { title: string; keys: string[] }) =>
    `<section><h2>${esc(g.title)}</h2>${g.keys.map((k) => field(by.get(k)!, s)).join("")}</section>`;
  const advanced = FIELDS.filter((f) => f.advanced);
  const analytics = s.analytics === null
    ? `<div class="fhint">Unavailable until the shyn service is running and you have made your first-run choice.</div>`
    : `<div class="field ${s.errors.analytics ? "bad" : ""}" data-key="analytics">
        <label><span class="flab">Help improve the beta</span>
          <input type="checkbox" name="analytics" ${s.analytics ? "checked" : ""} /></label>
        <div class="fhint">${s.analytics
          ? "Sending crashes and which features you use. Never your content."
          : "Nothing is being sent. Crashes stay on this Mac."}</div>
        ${s.errors.analytics ? `<div class="ferr">${esc(s.errors.analytics)}</div>` : ""}
      </div>`;
  return `
  <form id="settings-form" autocomplete="off" novalidate>
    ${GROUPS.map(group).join("")}
    <section><h2>Privacy</h2>${analytics}</section>
    <section>
      <h2><button type="button" class="disclose" data-action="toggle-advanced" aria-expanded="${s.advancedOpen}">
        ${s.advancedOpen ? "▾" : "▸"} Advanced</button></h2>
      ${s.advancedOpen ? advanced.map((f) => field(f, s)).join("") : ""}
    </section>
    ${s.errors._ ? `<div class="ferr banner">${esc(s.errors._)}</div>` : ""}
    <div class="savebar">
      <span class="status ${s.status && s.status !== "Saved" ? "warn" : ""}">${esc(s.status)}</span>
      <button type="submit" class="btn primary">Save</button>
    </div>
  </form>`;
}
