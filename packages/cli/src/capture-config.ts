import { existsSync, readFileSync, writeFileSync } from "node:fs";

const read = (path: string): Record<string, unknown> => {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
};
const write = (path: string, cfg: Record<string, unknown>) =>
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");

export function parseDuration(spec: string, nowEpoch: number): number {
  const m = /^(\d+)([mh])$/.exec(spec);
  if (m) return Number(m[1]) * (m[2] === "m" ? 60 : 3600);
  if (spec === "until-tomorrow") {
    const midnight = new Date((nowEpoch + 86400) * 1000);
    midnight.setHours(0, 0, 0, 0);
    return Math.floor(midnight.getTime() / 1000) - nowEpoch;
  }
  throw new Error(`bad duration "${spec}" — use 30m, 2h, or until-tomorrow`);
}

export function pauseCapture(path: string, spec: string, nowEpoch: number): number {
  const cfg = read(path);
  const until = nowEpoch + parseDuration(spec, nowEpoch);
  write(path, { ...cfg, pausedUntil: until });
  return until;
}

export function resumeCapture(path: string): void {
  const { pausedUntil: _p, ...rest } = read(path);
  write(path, rest);
}

export function addExclude(path: string, value: string): void {
  const cfg = read(path);
  const isBundleId = /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(value);
  const key = isBundleId ? "excludeBundleIds" : "excludeTitlePatterns";
  // Title excludes are matched as regexes by the agent. Reject an invalid
  // pattern up front so the user gets a clear error instead of a silently
  // dead exclude (a privacy gate must not fail open). Bundle ids are literal.
  if (!isBundleId) {
    try { new RegExp(value); }
    catch { throw new Error(`invalid title regex "${value}" — fix the pattern or escape metacharacters`); }
  }
  const list = new Set([...((cfg[key] as string[]) ?? []), value]);
  write(path, { ...cfg, [key]: [...list] });
}
