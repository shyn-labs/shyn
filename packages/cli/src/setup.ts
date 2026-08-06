import { cpSync, chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requestMeetingStop } from "./meeting-control.js";
import {
  installDaemon, installCaptureAgent, installMeetingAgent, installStatusApp,
} from "./launchd.js";

// `shyn setup` for TARBALL installs (brew cask payload). The payload carries
// a real dist/ directory (dist/daemon, dist/capture/*.app, dist/status/*.app),
// so the existing installers run unmodified with repoRoot = payloadRoot.
// Sequence: mint the machine-local signing identity
// (TCC pins grants to it; see the spec's threat model) → clear quarantine
// with the user's explicit consent → re-sign the apps locally → stage +
// start all four services → stage the CLI/MCP bundles behind shims that use
// the vendored node.
export type SetupDeps = {
  payloadRoot: string; shynHome: string;
  launchAgentsDir: string; logDir: string;
  exec: (cmd: string, args: string[]) => void;
  print: (s: string) => void;
};
export type SetupResult = { ok: true } | { ok: false; error: string };

const APPS = [
  ["capture", "shyn-capture"], ["capture", "shyn-meeting"], ["status", "shyn-status"],
] as const;

export async function runSetup(deps: SetupDeps): Promise<SetupResult> {
  const p = deps.payloadRoot;
  if (!existsSync(join(p, "dist", "daemon", "daemon.mjs")))
    return { ok: false, error: `payload incomplete: ${join(p, "dist/daemon/daemon.mjs")} missing` };
  for (const [dir, app] of APPS)
    if (!existsSync(join(p, "dist", dir, `${app}.app`, "Contents", "MacOS", app)))
      return { ok: false, error: `payload incomplete: dist/${dir}/${app}.app missing` };

  deps.print("▶︎ creating the local signing identity (keeps macOS permission grants stable)…");
  deps.exec("bash", [join(p, "setup", "setup-signing.sh")]);

  deps.print("▶︎ clearing the download quarantine (you chose to install this — see README fine print)…");
  deps.exec("xattr", ["-dr", "com.apple.quarantine", p]);

  deps.print("▶︎ re-signing the apps with your local identity…");
  for (const [dir, app] of APPS)
    deps.exec("codesign", ["--force", "--deep", "--sign", "Shyn Dev", join(p, "dist", dir, `${app}.app`)]);

  // Ask a live meeting to stop BEFORE the agents are replaced. On 2026-08-06 an
  // upgrade restarted the meeting agent mid-session and orphaned 70 minutes of
  // audio. The commit-time sidecar now makes that recoverable, but a clean stop
  // is better than a recovery: the agent hands the session to transcription
  // itself. Best-effort and non-blocking — transcription takes minutes and setup
  // must not wait for it; if the agent dies before consuming the control file,
  // the sidecar is the safety net.
  try {
    requestMeetingStop(deps.shynHome);
    deps.print("▶︎ asked any live meeting to stop cleanly…");
  } catch { /* no live session, or unwritable home: the sidecar still covers it */ }

  deps.print("▶︎ installing launchd services (daemon + screen + meeting + status)…");
  const common = {
    launchAgentsDir: deps.launchAgentsDir, logDir: deps.logDir,
    repoRoot: p, shynHome: deps.shynHome, exec: deps.exec,
  };
  await installDaemon(common);
  for (const install of [installCaptureAgent, installMeetingAgent, installStatusApp]) {
    const r = await install(common);
    if ("skipped" in r) return { ok: false, error: r.skipped };
  }

  deps.print("▶︎ staging the MCP server…");
  const bin = join(deps.shynHome, "bin");
  const shyndPath = join(bin, "daemon", "bin", "shynd");
  const node = existsSync(shyndPath) ? shyndPath : join(bin, "daemon", "bin", "node");
  cpSync(join(p, "mcp"), join(bin, "mcp"), { recursive: true });
  const shim = (target: string) =>
    `#!/bin/sh\nexport SHYN_PAYLOAD="${p}"\nexec "${node}" "${target}" "$@"\n`;
  writeFileSync(join(bin, "shyn-mcp"), shim(join(bin, "mcp", "index.mjs")));
  chmodSync(join(bin, "shyn-mcp"), 0o755);

  deps.print(`
✓ shyn is running. Next steps:
  1. Grant permissions — the ☀️ menu bar window walks each one:
       Screen Recording · shyn-capture      System Audio · shyn-meeting
       Microphone · shyn-meeting            Accessibility · shyn-capture
     if an app isn't listed in System Settings, drag it in from:
       ${bin}
  2. Connect your AI:
     claude mcp add shyn -- "${join(bin, "shyn-mcp")}"
`);
  return { ok: true };
}
