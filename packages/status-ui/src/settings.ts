import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPatch, settingsFromConfig, validatePatch, type Settings, type Validation } from "./settings-schema.js";

// capture.json read/write for the settings window. Same file the CLI and the
// popover controls write; the Swift agents hot-reload it, so no restart.

const cfgPath = (home: string) => join(home, "capture.json");

function readRaw(home: string): { cfg: Record<string, unknown>; unreadable: boolean } {
  if (!existsSync(cfgPath(home))) return { cfg: {}, unreadable: false };
  try {
    const v = JSON.parse(readFileSync(cfgPath(home), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v)
      ? { cfg: v, unreadable: false } : { cfg: {}, unreadable: true };
  } catch { return { cfg: {}, unreadable: true }; }
}

export function readSettings(home: string): Settings {
  return settingsFromConfig(readRaw(home).cfg);
}

/// Validates then writes. A capture.json that exists but will not parse is
/// refused rather than overwritten: saving over it would silently discard the
/// user's exclusion list, which is a privacy loss they never asked for.
export function saveSettings(home: string, rawPatch: unknown): Validation {
  const v = validatePatch(rawPatch);
  if (!v.ok) return v;
  const { cfg, unreadable } = readRaw(home);
  if (unreadable) {
    return { ok: false, errors: { _: "capture.json is not valid JSON. Fix or remove it, then try again" } };
  }
  // Temp file + rename so an agent hot-reloading mid-write never sees half a file.
  const tmp = cfgPath(home) + ".tmp";
  writeFileSync(tmp, JSON.stringify(applyPatch(cfg, v.patch), null, 2) + "\n");
  renameSync(tmp, cfgPath(home));
  return v;
}
