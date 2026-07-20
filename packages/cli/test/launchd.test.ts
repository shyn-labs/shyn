import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlist, installDaemon, uninstallDaemon, installCaptureAgent, installMeetingAgent, installStatusApp, daemonProgramArguments, LAUNCHD_LABEL, CAPTURE_LABEL } from "../src/launchd.js";

describe("launchd", () => {
  it("builds a valid plist with label, args, keepalive and log paths", () => {
    const xml = buildPlist({
      programArguments: ["/usr/local/bin/node", "/x/tsx.js", "/repo/packages/daemon/src/main.ts"],
      logPath: "/tmp/daemon.log",
    });
    expect(xml).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(xml).toContain("<string>/usr/local/bin/node</string>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain("<string>/tmp/daemon.log</string>");
    expect(xml.startsWith("<?xml")).toBe(true);
  });

  it("plist carries EnvironmentVariables when env is given", () => {
    const xml = buildPlist({
      programArguments: ["/bin/x"],
      logPath: "/tmp/d.log",
      env: { SHYN_LOG_PATH: "/tmp/d.log" },
    });
    expect(xml).toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain("<key>SHYN_LOG_PATH</key>");
  });

  it("plist omits EnvironmentVariables when no env is given", () => {
    const xml = buildPlist({ programArguments: ["/bin/x"], logPath: "/tmp/d.log" });
    expect(xml).not.toContain("EnvironmentVariables");
  });

  it("installDaemon passes the log path to the daemon as SHYN_LOG_PATH (boot rotation)", async () => {
    const base = mkdtempSync(join(tmpdir(), "shyn-launchd-"));
    const launchAgentsDir = join(base, "LaunchAgents");
    const logDir = join(base, "Logs");
    const home = join(base, "shyn-home");
    mkdirSync(home, { recursive: true });
    const { plistPath } = await installDaemon({
      launchAgentsDir, logDir, repoRoot: "/repo", shynHome: home, exec: () => {} });
    const xml = readFileSync(plistPath, "utf8");
    // Assert the adjacent key+value pair: a bare value check is satisfied by
    // the StandardOutPath line, letting a wrong SHYN_LOG_PATH ship undetected.
    expect(xml).toContain(`<key>SHYN_LOG_PATH</key><string>${join(logDir, "daemon.log")}</string>`);
  });

  it("install writes plist and bootstraps; uninstall removes and purges logDir", async () => {
    const base = mkdtempSync(join(tmpdir(), "shyn-launchd-"));
    const launchAgentsDir = join(base, "LaunchAgents");
    const logDir = join(base, "Logs");
    const home = join(base, "shyn-home");
    mkdirSync(home, { recursive: true });
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(home, "shyn.db"), "x");
    writeFileSync(join(logDir, "daemon.log"), "log content");
    const calls: string[][] = [];
    const exec = (cmd: string, args: string[]) => { calls.push([cmd, ...args]); };

    const { plistPath } = await installDaemon({
      launchAgentsDir, logDir, repoRoot: "/repo", shynHome: home, exec });
    expect(existsSync(plistPath)).toBe(true);
    expect(readFileSync(plistPath, "utf8")).toContain("/repo/packages/daemon/src/main.ts");
    expect(calls.some(c => c[0] === "launchctl" && c[1] === "bootstrap")).toBe(true);

    await uninstallDaemon({ launchAgentsDir, exec,
      purge: { shynHome: home, logDir, deleteKeychain: true } });
    expect(existsSync(plistPath)).toBe(false);
    expect(existsSync(home)).toBe(false);
    expect(existsSync(logDir)).toBe(false);
    expect(calls.some(c => c[0] === "security" && c[1] === "delete-generic-password")).toBe(true);
  });

  it("uninstall without logDir in purge keeps logs but deletes home", async () => {
    const base = mkdtempSync(join(tmpdir(), "shyn-launchd-"));
    const launchAgentsDir = join(base, "LaunchAgents");
    const logDir = join(base, "Logs");
    const home = join(base, "shyn-home");
    mkdirSync(home, { recursive: true });
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(home, "shyn.db"), "x");
    writeFileSync(join(logDir, "daemon.log"), "log content");
    const calls: string[][] = [];
    const exec = (cmd: string, args: string[]) => { calls.push([cmd, ...args]); };

    await uninstallDaemon({ launchAgentsDir, exec,
      purge: { shynHome: home, deleteKeychain: true } });
    expect(existsSync(home)).toBe(false);
    expect(existsSync(logDir)).toBe(true);
  });

  it("uninstall without purge removes plist but keeps data", async () => {
    const base = mkdtempSync(join(tmpdir(), "shyn-launchd-"));
    const launchAgentsDir = join(base, "LaunchAgents");
    const logDir = join(base, "Logs");
    const home = join(base, "shyn-home");
    mkdirSync(home, { recursive: true });
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(home, "shyn.db"), "x");
    writeFileSync(join(logDir, "daemon.log"), "log content");
    const calls: string[][] = [];
    const exec = (cmd: string, args: string[]) => { calls.push([cmd, ...args]); };

    const { plistPath } = await installDaemon({
      launchAgentsDir, logDir, repoRoot: "/repo", shynHome: home, exec });
    await uninstallDaemon({ launchAgentsDir, exec });
    expect(existsSync(plistPath)).toBe(false);
    expect(existsSync(home)).toBe(true);
    expect(existsSync(logDir)).toBe(true);
    expect(readFileSync(join(home, "shyn.db"), "utf8")).toBe("x");
  });

  it("daemonProgramArguments stages the dist bundle under shynHome (not the repo checkout) when present, on a stable node path", () => {
    const base = mkdtempSync(join(tmpdir(), "shyn-launchd-bundle-"));
    const bundleDir = join(base, "dist", "daemon");
    // Reproduce pnpm's real two-tier layout for a native addon package
    // (modeled on better-sqlite3-multiple-ciphers -> bindings): a
    // top-level flat-name symlink into .pnpm/, whose *sibling* directory
    // inside that same .pnpm/<pkg>/node_modules/ holds another relative
    // symlink to a shared transitive dependency living elsewhere in
    // .pnpm/. This is exactly the shape a naive "dereference every
    // symlink" copy (fs.cpSync's dereference option, or the system
    // `cp -RL`) breaks: it turns the top-level symlink into an
    // independent, detached copy of "nativelib" that's no longer
    // *inside* .pnpm/nativelib@1.0.0/node_modules/ — so nativelib's own
    // require("bindings") walk-up can no longer find its sibling
    // "bindings" and fails with MODULE_NOT_FOUND. Confirmed live on the
    // real daemon bundle (better-sqlite3-multiple-ciphers -> bindings)
    // during this fix.
    const nativelibReal = join(bundleDir, "node_modules", ".pnpm", "nativelib@1.0.0", "node_modules", "nativelib");
    const bindingsReal = join(bundleDir, "node_modules", ".pnpm", "bindings@1.5.0", "node_modules", "bindings");
    mkdirSync(nativelibReal, { recursive: true });
    mkdirSync(bindingsReal, { recursive: true });
    writeFileSync(join(bundleDir, "daemon.mjs"), "// stub bundle");
    writeFileSync(join(bundleDir, "package.json"), '{"type":"module"}');
    writeFileSync(join(nativelibReal, "index.js"), "// native addon loader");
    writeFileSync(join(bindingsReal, "index.js"), "// shared transitive dep");
    symlinkSync(
      join(".pnpm", "nativelib@1.0.0", "node_modules", "nativelib"),
      join(bundleDir, "node_modules", "nativelib"),
    );
    symlinkSync(
      join("..", "..", "bindings@1.5.0", "node_modules", "bindings"),
      join(bundleDir, "node_modules", ".pnpm", "nativelib@1.0.0", "node_modules", "bindings"),
    );
    const home = mkdtempSync(join(tmpdir(), "shyn-launchd-home-"));

    const args = daemonProgramArguments(base, home);
    // Machine-dependent: prefer /opt/homebrew/bin/node (Apple Silicon), then
    // /usr/local/bin/node (Intel Homebrew), else process.execPath as fallback.
    expect(["/opt/homebrew/bin/node", "/usr/local/bin/node", process.execPath]).toContain(args[0]);
    // Staged under shynHome, not the (potentially TCC-protected, e.g.
    // ~/Documents) repo checkout — see stageDaemonProgram's comment in
    // launchd.ts for why launchd can never read a repo path under
    // ~/Documents.
    const stagedRoot = join(home, "bin", "daemon");
    const stagedPath = join(stagedRoot, "daemon.mjs");
    expect(args[1]).toBe(stagedPath);
    expect(existsSync(stagedPath)).toBe(true);
    expect(readFileSync(stagedPath, "utf8")).toBe("// stub bundle");
    // The top-level symlink must survive as a symlink (verbatim, not
    // dereferenced into a detached copy) so nativelib stays *inside*
    // .pnpm/nativelib@1.0.0/node_modules/ where its sibling "bindings" lives.
    const stagedNativelib = join(stagedRoot, "node_modules", "nativelib");
    expect(lstatSync(stagedNativelib).isSymbolicLink()).toBe(true);
    // And it must be self-contained: realpath must land inside the staged
    // tree, never back in the original (potentially TCC-protected) repoRoot.
    // (realpathSync both sides: macOS's /tmp is itself a symlink to
    // /private/tmp, so comparing a realpath'd descendant against a
    // non-realpath'd ancestor would spuriously mismatch on that prefix.)
    const realStagedRoot = realpathSync(stagedRoot);
    const realBase = realpathSync(base);
    const realNativelib = realpathSync(stagedNativelib);
    expect(realNativelib.startsWith(realStagedRoot)).toBe(true);
    expect(realNativelib.startsWith(realBase)).toBe(false);
    // nativelib's own require("bindings") walk-up must still resolve —
    // i.e. the staged, self-contained .pnpm/nativelib@1.0.0/node_modules/
    // must still have its "bindings" sibling reachable.
    const resolvedBindings = join(realNativelib, "..", "bindings");
    expect(readFileSync(join(resolvedBindings, "index.js"), "utf8")).toBe("// shared transitive dep");
  });

  it("daemonProgramArguments falls back to tsx when no bundle is present, on a stable node path", () => {
    const base = mkdtempSync(join(tmpdir(), "shyn-launchd-nobundle-"));
    const home = mkdtempSync(join(tmpdir(), "shyn-launchd-home-"));

    const args = daemonProgramArguments(base, home);
    expect(["/opt/homebrew/bin/node", "/usr/local/bin/node", process.execPath]).toContain(args[0]);
    expect(args[1]).toContain("tsx");
    expect(args[2]).toBe(join(base, "packages", "daemon", "src", "main.ts"));
  });

  it("daemonProgramArguments prefers the bundle's vendored node over any system node", () => {
    const base = mkdtempSync(join(tmpdir(), "shyn-vnode-"));
    const repoRoot = join(base, "repo"), shynHome = join(base, "home");
    const bundle = join(repoRoot, "dist", "daemon");
    mkdirSync(join(bundle, "bin"), { recursive: true });
    writeFileSync(join(bundle, "daemon.mjs"), "// bundled daemon");
    writeFileSync(join(bundle, "bin", "node"), "#!/bin/sh\n");
    const args = daemonProgramArguments(repoRoot, shynHome);
    expect(args[0]).toBe(join(shynHome, "bin", "daemon", "bin", "node"));
    expect(args[1]).toBe(join(shynHome, "bin", "daemon", "daemon.mjs"));
  });

  it("daemonProgramArguments falls back to a system node for bundles without vendored node", () => {
    const base = mkdtempSync(join(tmpdir(), "shyn-vnode-"));
    const repoRoot = join(base, "repo"), shynHome = join(base, "home");
    const bundle = join(repoRoot, "dist", "daemon");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "daemon.mjs"), "// bundled daemon");
    const args = daemonProgramArguments(repoRoot, shynHome);
    expect(args[0]).not.toContain(shynHome);   // stable system node path
    expect(args[1]).toBe(join(shynHome, "bin", "daemon", "daemon.mjs"));
  });
});

describe("capture agent install", () => {
  const mkApp = (repoRoot: string) => {
    const appBin = join(repoRoot, "dist", "capture", "shyn-capture.app",
      "Contents", "MacOS");
    mkdirSync(appBin, { recursive: true });
    writeFileSync(join(appBin, "shyn-capture"), "#!/bin/sh\n");
  };

  it("writes a com.shyn.capture plist pointing at the STAGED app binary", async () => {
    const base = mkdtempSync(join(tmpdir(), "shyn-cap-"));
    const launchAgentsDir = join(base, "LaunchAgents");
    const logDir = join(base, "Logs");
    const shynHome = join(base, "home");
    const repoRoot = join(base, "repo");
    mkApp(repoRoot);
    const calls: string[][] = [];
    const res = await installCaptureAgent({ launchAgentsDir, logDir, repoRoot, shynHome,
      exec: (c, a) => calls.push([c, ...a]) });
    expect("plistPath" in res).toBe(true);
    const plist = readFileSync(join(launchAgentsDir, "com.shyn.capture.plist"), "utf8");
    expect(plist).toContain(`<string>${CAPTURE_LABEL}</string>`);
    const stagedBin = join(shynHome, "bin", "shyn-capture.app", "Contents", "MacOS", "shyn-capture");
    expect(plist).toContain(stagedBin);
    expect(existsSync(stagedBin)).toBe(true);
    expect(calls.some(c => c[0] === "launchctl" && c[1] === "bootstrap")).toBe(true);
  });

  it("skips the agent cleanly when dist/capture is absent", async () => {
    const base = mkdtempSync(join(tmpdir(), "shyn-cap-"));
    const launchAgentsDir = join(base, "LaunchAgents");
    const res = await installCaptureAgent({ launchAgentsDir, logDir: join(base, "Logs"),
      repoRoot: join(base, "empty-repo"), shynHome: join(base, "home"), exec: () => {} });
    expect("skipped" in res).toBe(true);
    expect(existsSync(join(launchAgentsDir, "com.shyn.capture.plist"))).toBe(false);
  });

  it("uninstall boots out and removes the capture plist too", async () => {
    const base = mkdtempSync(join(tmpdir(), "shyn-cap-"));
    const launchAgentsDir = join(base, "LaunchAgents");
    const logDir = join(base, "Logs");
    const shynHome = join(base, "home");
    const repoRoot = join(base, "repo");
    mkApp(repoRoot);
    const calls: string[][] = [];
    const exec = (c: string, a: string[]) => calls.push([c, ...a]);
    await installDaemon({ launchAgentsDir, logDir, repoRoot, shynHome, exec });
    await installCaptureAgent({ launchAgentsDir, logDir, repoRoot, shynHome, exec });
    const capturePlist = join(launchAgentsDir, "com.shyn.capture.plist");
    expect(existsSync(capturePlist)).toBe(true);
    await uninstallDaemon({ launchAgentsDir, exec });
    expect(existsSync(capturePlist)).toBe(false);
    expect(calls.some(c => c[0] === "launchctl" && c[1] === "bootout"
      && c[3]?.endsWith("com.shyn.capture.plist"))).toBe(true);
  });

  it("installs a com.shyn.meeting plist pointing at the STAGED meeting binary", async () => {
    const base = mkdtempSync(join(tmpdir(), "shyn-mtg-"));
    const launchAgentsDir = join(base, "LaunchAgents"), logDir = join(base, "Logs");
    const shynHome = join(base, "home"), repoRoot = join(base, "repo");
    const appBin = join(repoRoot, "dist", "capture", "shyn-meeting.app", "Contents", "MacOS");
    mkdirSync(appBin, { recursive: true }); writeFileSync(join(appBin, "shyn-meeting"), "#!/bin/sh\n");
    const calls: string[][] = [];
    const res = await installMeetingAgent({ launchAgentsDir, logDir, repoRoot, shynHome,
      exec: (c, a) => calls.push([c, ...a]) });
    expect("plistPath" in res).toBe(true);
    const plist = readFileSync(join(launchAgentsDir, "com.shyn.meeting.plist"), "utf8");
    expect(plist).toContain("<string>com.shyn.meeting</string>");
    expect(plist).toContain(join(shynHome, "bin", "shyn-meeting.app", "Contents", "MacOS", "shyn-meeting"));
    expect(calls.some(c => c[0] === "launchctl" && c[1] === "bootstrap")).toBe(true);
  });

  it("skips the meeting agent cleanly when its app is absent", async () => {
    const base = mkdtempSync(join(tmpdir(), "shyn-mtg-"));
    const launchAgentsDir = join(base, "LaunchAgents");
    const res = await installMeetingAgent({ launchAgentsDir, logDir: join(base, "Logs"),
      repoRoot: join(base, "empty-repo"), shynHome: join(base, "home"), exec: () => {} });
    expect("skipped" in res).toBe(true);
    expect(existsSync(join(launchAgentsDir, "com.shyn.meeting.plist"))).toBe(false);
  });

  it("uninstall boots out and removes the meeting plist too", async () => {
    const base = mkdtempSync(join(tmpdir(), "shyn-mtg-"));
    const launchAgentsDir = join(base, "LaunchAgents");
    const calls: string[][] = [];
    const exec = (c: string, a: string[]) => calls.push([c, ...a]);
    mkdirSync(launchAgentsDir, { recursive: true });
    writeFileSync(join(launchAgentsDir, "com.shyn.meeting.plist"), "x");
    await uninstallDaemon({ launchAgentsDir, exec });
    expect(existsSync(join(launchAgentsDir, "com.shyn.meeting.plist"))).toBe(false);
    expect(calls.some(c => c[0] === "launchctl" && c[1] === "bootout"
      && c[3]?.endsWith("com.shyn.meeting.plist"))).toBe(true);
  });

  it("installs a com.shyn.status plist pointing at the STAGED status app", async () => {
    const base = mkdtempSync(join(tmpdir(), "shyn-st-"));
    const launchAgentsDir = join(base, "LaunchAgents"), logDir = join(base, "Logs");
    const shynHome = join(base, "home"), repoRoot = join(base, "repo");
    const appBin = join(repoRoot, "dist", "status", "shyn-status.app", "Contents", "MacOS");
    mkdirSync(appBin, { recursive: true }); writeFileSync(join(appBin, "shyn-status"), "#!/bin/sh\n");
    const calls: string[][] = [];
    const res = await installStatusApp({ launchAgentsDir, logDir, repoRoot, shynHome,
      exec: (c, a) => calls.push([c, ...a]) });
    expect("plistPath" in res).toBe(true);
    const plist = readFileSync(join(launchAgentsDir, "com.shyn.status.plist"), "utf8");
    expect(plist).toContain("<string>com.shyn.status</string>");
    expect(plist).toContain(join(shynHome, "bin", "shyn-status.app", "Contents", "MacOS", "shyn-status"));
    expect(calls.some(c => c[0] === "launchctl" && c[1] === "bootstrap")).toBe(true);
  });

  it("skips the status app cleanly when unbuilt; uninstall removes its plist", async () => {
    const base = mkdtempSync(join(tmpdir(), "shyn-st-"));
    const launchAgentsDir = join(base, "LaunchAgents");
    const res = await installStatusApp({ launchAgentsDir, logDir: join(base, "Logs"),
      repoRoot: join(base, "empty-repo"), shynHome: join(base, "home"), exec: () => {} });
    expect("skipped" in res).toBe(true);
    const calls: string[][] = [];
    mkdirSync(launchAgentsDir, { recursive: true });
    writeFileSync(join(launchAgentsDir, "com.shyn.status.plist"), "x");
    await uninstallDaemon({ launchAgentsDir, exec: (c, a) => calls.push([c, ...a]) });
    expect(existsSync(join(launchAgentsDir, "com.shyn.status.plist"))).toBe(false);
    expect(calls.some(c => c[0] === "launchctl" && c[1] === "bootout"
      && c[3]?.endsWith("com.shyn.status.plist"))).toBe(true);
  });
});

it("daemonProgramArguments prefers the renamed shynd runtime over bin/node", () => {
  const base = mkdtempSync(join(tmpdir(), "shyn-launchd-shynd-"));
  const bundleDir = join(base, "dist", "daemon");
  mkdirSync(join(bundleDir, "bin"), { recursive: true });
  writeFileSync(join(bundleDir, "daemon.mjs"), "// stub");
  writeFileSync(join(bundleDir, "bin", "shynd"), "#!binary");
  writeFileSync(join(bundleDir, "bin", "node"), "#!binary");
  const home = mkdtempSync(join(tmpdir(), "shyn-launchd-home-"));
  const args = daemonProgramArguments(base, home);
  expect(args[0]).toBe(join(home, "bin", "daemon", "bin", "shynd"));
});
