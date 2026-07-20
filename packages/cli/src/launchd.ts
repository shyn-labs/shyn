import { mkdirSync, rmSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

export const LAUNCHD_LABEL = "com.shyn.daemon";
export const CAPTURE_LABEL = "com.shyn.capture";
export const MEETING_LABEL = "com.shyn.meeting";
export const STATUS_LABEL = "com.shyn.status";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildPlist(opts: {
  programArguments: string[]; logPath: string; label?: string;
  env?: Record<string, string>;
}): string {
  const args = opts.programArguments
    .map((a) => `    <string>${esc(a)}</string>`).join("\n");
  const env = opts.env && Object.keys(opts.env).length > 0
    ? `  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(opts.env)
    .map(([k, v]) => `    <key>${esc(k)}</key><string>${esc(v)}</string>`).join("\n")}
  </dict>
`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(opts.label ?? LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
${env}  <key>StandardOutPath</key><string>${esc(opts.logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(opts.logPath)}</string>
</dict>
</plist>
`;
}

// Prefer the stable Homebrew symlink over process.execPath: a `brew upgrade
// node` (or any formula whose depends_on "node" drags a major bump along
// with it — see docs/known-issues.md's runtime-ABI-coupling entry) rewrites
// /opt/homebrew/bin/node to point at the new Cellar version, but a launchd
// plist that pinned the OLD versioned Cellar path
// (/opt/homebrew/Cellar/node/25.4.0/...) keeps trying to exec a binary that
// no longer exists after the upgrade — a silent KeepAlive relaunch-fail
// loop, confirmed live on 2026-07-02 (node 25->26). The stable symlink
// always resolves post-upgrade; process.execPath is the fallback for
// machines without it (non-Homebrew Node installs).
function stableNodePath(): string {
  const appleStableSymlink = "/opt/homebrew/bin/node"; // Apple Silicon (ARM64)
  if (existsSync(appleStableSymlink)) return appleStableSymlink;
  const intelStableSymlink = "/usr/local/bin/node"; // Intel Homebrew prefix
  if (existsSync(intelStableSymlink)) return intelStableSymlink;
  return process.execPath;
}

// macOS TCC gates a process's *first* synchronous read of a file under
// ~/Documents behind a consent decision — and for a headless launchd agent
// with no session to show that consent prompt in, the decision never
// resolves: the read (and the whole process, since Node's own module
// loader does this open+read synchronously to load the entry script)
// blocks in the kernel forever. Confirmed live on 2026-07-02: a
// content-free `fs.readFileSync` probe under ~/Documents, run only as a
// LaunchAgent, reproduced the identical zero-output `node::fs::Open` hang
// as the real daemon — with the same probe from an interactive terminal
// returning instantly, because Terminal's own already-resolved TCC
// identity covers the read. A git checkout under e.g.
// ~/Documents/Code/shyn puts the built daemon bundle (and its
// node_modules native addons, loaded the same synchronous way) squarely
// inside that protected folder. shynHome() (~/Library/Application
// Support/shyn) isn't TCC-protected, so staging the resolved program
// there before launchd ever touches it sidesteps the hang entirely.
function stageDaemonProgram(bundleDir: string, shynHome: string): string {
  const staged = join(shynHome, "bin", "daemon");
  rmSync(staged, { recursive: true, force: true });
  // verbatimSymlinks: true is load-bearing, not cosmetic. pnpm's
  // node_modules relies on *relative* symlinks (e.g. node_modules/foo ->
  // .pnpm/foo@1.0.0/node_modules/foo, itself sibling to
  // .pnpm/foo@1.0.0/node_modules/bindings) both to expose flat package
  // names and to give each package's `require()` walk-up a real nested
  // directory to find its own scoped dependencies in.
  //   - cpSync's default (verbatimSymlinks: false) "fixes" a relative
  //     symlink by re-anchoring it to an *absolute* path back at its
  //     original location — the staged copy would still reach into the
  //     TCC-protected repo checkout, defeating the point of staging.
  //   - Dereferencing (copying symlink targets as real content, whether
  //     via { dereference: true } or the system `cp -RL`) is just as
  //     broken a different way: it duplicates each linked package as an
  //     independent copy detached from the `.pnpm/<pkg>/node_modules/`
  //     nesting its own transitive deps' require() walk-up depends on —
  //     confirmed live: better-sqlite3-multiple-ciphers's require("bindings")
  //     started failing with MODULE_NOT_FOUND once dereferencing flattened
  //     it out of its .pnpm sibling directory.
  // verbatimSymlinks: true copies the symlink's relative target text
  // unchanged; since the whole tree it points within is copied alongside
  // it, the relative link still resolves correctly at the new location —
  // self-contained, and structurally identical to the source.
  cpSync(bundleDir, staged, { recursive: true, verbatimSymlinks: true });
  return join(staged, "daemon.mjs");
}

export function daemonProgramArguments(repoRoot: string, shynHome: string): string[] {
  const bundleDir = join(repoRoot, "dist", "daemon");
  if (existsSync(join(bundleDir, "daemon.mjs"))) {
    const staged = stageDaemonProgram(bundleDir, shynHome);
    // Prefer the bundle's own vendored runtime (SP5): ABI-matched to the
    // bundle's natives and immune to brew node upgrades (2026-07-10
    // incident class). Bundles built before vendoring fall back to the
    // stable system-node path as before.
    // Prefer the renamed interpreter (shynd — identifiable in Activity
    // Monitor and TCC panes); bundles built before the rename carry bin/node.
    const stagedShynd = join(shynHome, "bin", "daemon", "bin", "shynd");
    const stagedNode = join(shynHome, "bin", "daemon", "bin", "node");
    const runtime = existsSync(stagedShynd) ? stagedShynd
      : existsSync(stagedNode) ? stagedNode : stableNodePath();
    return [runtime, staged];
  }
  const node = stableNodePath();
  const require = createRequire(import.meta.url);
  return [node, require.resolve("tsx/cli"),
    join(repoRoot, "packages", "daemon", "src", "main.ts")];
}

const plistPathIn = (dir: string) => join(dir, `${LAUNCHD_LABEL}.plist`);

export async function installDaemon(deps: {
  launchAgentsDir: string; logDir: string; repoRoot: string; shynHome: string;
  exec: (cmd: string, args: string[]) => void;
}): Promise<{ plistPath: string }> {
  mkdirSync(deps.launchAgentsDir, { recursive: true });
  mkdirSync(deps.logDir, { recursive: true });
  const plistPath = plistPathIn(deps.launchAgentsDir);
  const logPath = join(deps.logDir, "daemon.log");
  writeFileSync(plistPath, buildPlist({
    programArguments: daemonProgramArguments(deps.repoRoot, deps.shynHome),
    logPath,
    // launchd never rotates the log; the daemon truncates it at boot when
    // oversized, and this is how it learns which file it's writing to.
    env: { SHYN_LOG_PATH: logPath },
  }));
  const domain = `gui/${process.getuid?.() ?? 501}`;
  try { deps.exec("launchctl", ["bootout", domain, plistPath]); } catch { /* not loaded */ }
  deps.exec("launchctl", ["bootstrap", domain, plistPath]);
  return { plistPath };
}

// The Swift agents ride the same install/uninstall flow as the daemon. Same
// TCC-staging rationale as stageDaemonProgram: the .app must live outside
// ~/Documents, and its path + signing identity must be stable so TCC grants
// (Screen Recording / Microphone / System Audio) survive rebuilds. Returns
// `{ skipped }` (not an error) when the bundle wasn't built, so `shyn
// install` still succeeds without it.
type AgentDeps = {
  launchAgentsDir: string; logDir: string; repoRoot: string; shynHome: string;
  exec: (cmd: string, args: string[]) => void;
};

async function installAgentApp(deps: AgentDeps, opts: {
  label: string; appName: string; logName: string; srcDir?: string;
}): Promise<{ plistPath: string } | { skipped: string }> {
  const srcDir = opts.srcDir ?? "capture";
  const srcApp = join(deps.repoRoot, "dist", srcDir, `${opts.appName}.app`);
  const bin = join("Contents", "MacOS", opts.appName);
  if (!existsSync(join(srcApp, bin)))
    return { skipped: `dist/${srcDir}/${opts.appName}.app not built (run: pnpm build-capture or pnpm build:status)` };
  const stagedApp = join(deps.shynHome, "bin", `${opts.appName}.app`);
  rmSync(stagedApp, { recursive: true, force: true });
  mkdirSync(join(deps.shynHome, "bin"), { recursive: true });
  cpSync(srcApp, stagedApp, { recursive: true, verbatimSymlinks: true });
  mkdirSync(deps.launchAgentsDir, { recursive: true });
  mkdirSync(deps.logDir, { recursive: true });
  const plistPath = join(deps.launchAgentsDir, `${opts.label}.plist`);
  writeFileSync(plistPath, buildPlist({
    label: opts.label,
    programArguments: [join(stagedApp, bin)],
    logPath: join(deps.logDir, opts.logName),
  }));
  const domain = `gui/${process.getuid?.() ?? 501}`;
  try { deps.exec("launchctl", ["bootout", domain, plistPath]); } catch { /* not loaded */ }
  deps.exec("launchctl", ["bootstrap", domain, plistPath]);
  return { plistPath };
}

export const installCaptureAgent = (deps: AgentDeps) =>
  installAgentApp(deps, { label: CAPTURE_LABEL, appName: "shyn-capture", logName: "capture.log" });

export const installMeetingAgent = (deps: AgentDeps) =>
  installAgentApp(deps, { label: MEETING_LABEL, appName: "shyn-meeting", logName: "meeting.log" });

export const installStatusApp = (deps: AgentDeps) =>
  installAgentApp(deps, { label: STATUS_LABEL, appName: "shyn-status", logName: "status.log", srcDir: "status" });

export async function uninstallDaemon(deps: {
  launchAgentsDir: string;
  exec: (cmd: string, args: string[]) => void;
  purge?: { shynHome: string; logDir?: string; deleteKeychain: boolean };
}): Promise<void> {
  const plistPath = plistPathIn(deps.launchAgentsDir);
  const domain = `gui/${process.getuid?.() ?? 501}`;
  try { deps.exec("launchctl", ["bootout", domain, plistPath]); } catch { /* not loaded */ }
  if (existsSync(plistPath)) rmSync(plistPath);
  // Tear down both agents alongside the daemon (staged apps die with the
  // shynHome purge below).
  for (const label of [CAPTURE_LABEL, MEETING_LABEL, STATUS_LABEL]) {
    const agentPlist = join(deps.launchAgentsDir, `${label}.plist`);
    try { deps.exec("launchctl", ["bootout", domain, agentPlist]); } catch { /* not loaded */ }
    if (existsSync(agentPlist)) rmSync(agentPlist);
  }
  if (deps.purge) {
    rmSync(deps.purge.shynHome, { recursive: true, force: true });
    if (deps.purge.logDir) rmSync(deps.purge.logDir, { recursive: true, force: true });
    if (deps.purge.deleteKeychain)
      try { deps.exec("security", ["delete-generic-password", "-s", "shyn", "-a", "db-key"]); }
      catch { /* no entry */ }
  }
}
