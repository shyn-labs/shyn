import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// These deliberately DUPLICATE the tiny writer contracts in
// packages/cli/src/capture-config.ts and meeting-control.ts rather than
// deep-importing another package's src (spec decision). The tests above
// freeze the shapes; if the CLI contracts ever change, change both.

const cfgPath = (home: string) => join(home, "capture.json");

const readCfg = (home: string): Record<string, unknown> => {
  if (!existsSync(cfgPath(home))) return {};
  try { return JSON.parse(readFileSync(cfgPath(home), "utf8")); } catch { return {}; }
};
const writeCfg = (home: string, cfg: Record<string, unknown>) =>
  writeFileSync(cfgPath(home), JSON.stringify(cfg, null, 2) + "\n");

export type PauseSpec = "30m" | "2h" | "until-tomorrow";

export function pauseCapture(home: string, spec: PauseSpec, nowEpoch: number): number {
  let until: number;
  if (spec === "until-tomorrow") {
    const midnight = new Date((nowEpoch + 86400) * 1000);
    midnight.setHours(0, 0, 0, 0);
    until = Math.floor(midnight.getTime() / 1000);
  } else {
    until = nowEpoch + (spec === "30m" ? 1800 : 7200);
  }
  writeCfg(home, { ...readCfg(home), pausedUntil: until });
  return until;
}

export function resumeCapture(home: string): void {
  const { pausedUntil: _p, ...rest } = readCfg(home);
  writeCfg(home, rest);
}

export function readPausedUntil(home: string): number | null {
  const v = readCfg(home).pausedUntil;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function writeMeetingControl(home: string, action: "stop" | "cancel"): void {
  writeFileSync(join(home, "meeting-control.json"),
    JSON.stringify({ action, ts: Math.floor(Date.now() / 1000) }) + "\n");
}
export const meetingStop = (home: string) => writeMeetingControl(home, "stop");
export const meetingCancel = (home: string) => writeMeetingControl(home, "cancel");
