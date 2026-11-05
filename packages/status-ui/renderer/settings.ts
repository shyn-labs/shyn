// Settings window wiring. Holds the form's state locally, sends only what
// changed, and rebases on what the main process says was saved.

import { renderSettings, type SettingsState } from "./settings-render.js";
import { FIELDS, parseListText, type Patch, type Settings } from "../src/settings-schema.js";

// Not a `declare global`: index.ts already types window.shyn for the popover,
// and a second declaration of the same property would not merge.
interface SettingsBridge {
  settingsGet(): Promise<{ settings: Settings; analytics: boolean | null }>;
  settingsSave(p: { patch: Patch; analytics?: boolean }):
    Promise<{ ok: boolean; saved?: boolean; errors?: Record<string, string> }>;
}
const bridge = (window as unknown as { shyn: SettingsBridge }).shyn;

const root = document.getElementById("settings-root")!;
let loaded: Settings | null = null;
let state: SettingsState | null = null;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function paint(): void {
  if (state) root.innerHTML = renderSettings(state);
}

/// What the form holds now, field by field. Fields hidden under a closed
/// Advanced section are not in the DOM, so they are never read as "cleared".
function readForm(): { values: Settings; analytics: boolean | undefined } {
  const form = root.querySelector<HTMLFormElement>("#settings-form")!;
  const values: Settings = { ...state!.settings };
  for (const f of FIELDS) {
    const el = form.elements.namedItem(f.key) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (!el) continue;
    if (f.kind === "bool") values[f.key] = (el as HTMLInputElement).checked;
    else if (f.kind === "int") values[f.key] = el.value.trim() === "" ? NaN : Number(el.value);
    else if (f.kind === "list") values[f.key] = parseListText(el.value);
    else values[f.key] = el.value;
  }
  const a = form.elements.namedItem("analytics") as HTMLInputElement | null;
  return { values, analytics: a ? a.checked : undefined };
}

async function load(status = ""): Promise<void> {
  const r = await bridge.settingsGet();
  loaded = r.settings;
  state = { settings: r.settings, analytics: r.analytics, errors: {}, advancedOpen: state?.advancedOpen ?? false, status };
  paint();
}

root.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (btn?.dataset.action === "toggle-advanced" && state) {
    // Keep unsaved edits across the toggle.
    const { values } = readForm();
    state = { ...state, settings: values, advancedOpen: !state.advancedOpen };
    paint();
  }
});

root.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state || !loaded) return;
  const { values, analytics } = readForm();
  const patch: Patch = {};
  for (const f of FIELDS) {
    if (!same(values[f.key], loaded[f.key])) patch[f.key] = values[f.key];
  }
  const analyticsChanged = analytics !== undefined && analytics !== state.analytics;
  if (!Object.keys(patch).length && !analyticsChanged) { state = { ...state, settings: values, errors: {}, status: "Nothing changed" }; paint(); return; }
  const r = await bridge.settingsSave({ patch, analytics: analyticsChanged ? analytics : undefined });
  if (r.ok) { await load("Saved"); return; }
  // Failed: keep what the user typed so they can fix it, show why per field.
  // A partial save (settings written, analytics not) rebases the saved part.
  state = { ...state, settings: values, errors: r.errors ?? {}, status: r.saved ? "Saved, except the item below" : "Not saved" };
  if (r.saved) loaded = { ...loaded, ...patch };
  paint();
});

void load();
