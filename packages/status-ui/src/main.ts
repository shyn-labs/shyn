import { app, BrowserWindow, Tray, nativeImage, ipcMain, screen, clipboard, shell } from "electron";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { shynHome } from "@shyn/engine/paths";
import { buildDiagnostics, diagnosticsMailtoUrl } from "@shyn/cli/diagnose";
import { rpcCall } from "@shyn/daemon/rpc";
import { poll } from "./poll.js";
import { live } from "./live.js";
import { deriveView, type TrayState, type ViewModel, CLAUDE_ADD_COMMAND } from "./derive.js";
import {
  pauseCapture, resumeCapture, readPausedUntil, meetingStop, meetingCancel,
  readMeetingModel, setMeetingModel,
  type PauseSpec, type MeetingModel,
} from "./controls.js";
import {
  shouldAutoOpen, readThrottle, writeThrottle, readCompletedOnce, writeCompletedOnce,
} from "./throttle.js";
import {
  checkLatest, consumeUpdateFailed, findBrew, readUpdateCheckEnabled, upgradeShell,
} from "./update.js";
import { spawn } from "node:child_process";
import type { SettingsPane } from "./derive.js";

const DIST = dirname(fileURLToPath(import.meta.url));   // dist/
const home = shynHome();
const sock = join(home, "shyn.sock");

// In-app update state (spec 2026-07-24). The check lives HERE, in the
// status app — the daemon and agents make no network requests, ever.
let updLatest: string | null = null;
let updUpdating = false;
let updFailed = false;

async function updateCheck() {
  if (!readUpdateCheckEnabled(home)) { updLatest = null; return; }
  updLatest = await checkLatest(fetch);
}
const WIN = { width: 320, height: 440 };

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {

  let tray: Tray | null = null;
  let win: BrowserWindow | null = null;
  let lastTray: TrayState | null = null;
  let lastVm: ViewModel | null = null;

  const OB_WIN = { width: 400, height: 540 };
  let obWin: BrowserWindow | null = null;
  const throttlePath = () => join(app.getPath("userData"), "onboarding-throttle.json");

  const SETTINGS_URLS: Record<SettingsPane, string> = {
    "microphone": "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    "screen-recording": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    "accessibility": "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  };
  let completedMarkerWritten = false;

  function showOnboarding() {
    if (obWin) { obWin.show(); obWin.focus(); return; }
    obWin = new BrowserWindow({
      ...OB_WIN, show: false, frame: false, transparent: true, resizable: false,
      vibrancy: "hud", visualEffectState: "active", center: true,
      fullscreenable: false,
      webPreferences: {
        preload: join(DIST, "preload.cjs"),
        contextIsolation: true, sandbox: true, nodeIntegration: false,
      },
    });
    obWin.on("closed", () => { obWin = null; });
    obWin.once("ready-to-show", () => { obWin?.show(); if (lastVm) obWin?.webContents.send("view", lastVm); });
    void obWin.loadFile(join(DIST, "onboarding.html"));
  }

  const ICONS: Record<TrayState, string> = {
    healthy: "iconIdleTemplate.png",
    warning: "iconWarnTemplate.png",
    recording: "iconRec.png",
    transcribing: "iconBusy.png",
  };
  const icon = (s: TrayState) =>
    nativeImage.createFromPath(join(DIST, "assets", ICONS[s]));

  function installedAgents() {
    const la = join(homedir(), "Library", "LaunchAgents");
    return {
      capture: existsSync(join(la, "com.shyn.capture.plist")),
      meeting: existsSync(join(la, "com.shyn.meeting.plist")),
    };
  }

  async function tick() {
    if (consumeUpdateFailed(home)) { updFailed = true; updUpdating = false; }
    const vm = deriveView(await poll(sock), {
      installed: installedAgents(),
      pausedUntil: readPausedUntil(home),
      meetingModel: readMeetingModel(home),
      update: { latest: updLatest, updating: updUpdating, failed: updFailed,
                brewFound: findBrew() !== null },
      now: Math.floor(Date.now() / 1000),
      claudeCommand: existsSync(join(home, "bin", "shyn-mcp"))
        ? `claude mcp add shyn -- "${join(home, "bin", "shyn-mcp")}"`
        : CLAUDE_ADD_COMMAND,
    });
    lastVm = vm;
    // win and tray are supposed to live for the whole process; if either is
    // destroyed (renderer OOM/GPU fault) a silent live() no-op would leave a
    // dead tray forever — the pre-guard behavior (throw → crash → KeepAlive
    // relaunch) was accidentally a self-heal. Recreate that recovery
    // deliberately: log why, exit, let launchd bring back a working app.
    if ((win && win.isDestroyed()) || (tray && tray.isDestroyed())) {
      console.error("main window/tray destroyed — exiting for launchd relaunch");
      app.exit(1);
      return;
    }
    // obWin is legitimately closable, and tick() awaits poll() for up to 4s —
    // it can be destroyed by the time we resume, and destroyed Electron
    // objects throw on every method call (optional chaining only covers null).
    const t = live(tray), w = live(win), ob = live(obWin);
    if (vm.tray !== lastTray) { lastTray = vm.tray; t?.setImage(icon(vm.tray)); }
    t?.setToolTip(`shyn — ${vm.verdict}`);
    if (w?.isVisible()) w.webContents.send("view", vm);
    if (vm.setup.kind === "complete" && !completedMarkerWritten) {
      completedMarkerWritten = true;
      writeCompletedOnce(throttlePath());
    }
    if (ob) {
      ob.webContents.send("view", vm);
      if (vm.setup.kind === "complete") {
        // 8s: the completion view carries the recall prompt + copy button —
        // give the user time to actually use it before self-dismissing.
        const closing = ob;
        setTimeout(() => {
          if (live(obWin) === closing && lastVm?.setup.kind === "complete") closing.close();
        }, 8000);
      }
    }
  }

  function toggleWindow() {
    const w = live(win), t = live(tray);
    if (!w || !t) return;
    if (w.isVisible()) { w.hide(); return; }
    const b = t.getBounds();
    const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
    const x = Math.min(Math.round(b.x + b.width / 2 - WIN.width / 2),
      display.workArea.x + display.workArea.width - WIN.width - 8);
    w.setPosition(x, display.workArea.y + 4);
    w.show();
    if (lastVm) w.webContents.send("view", lastVm);
  }

  app.whenReady().then(() => {
    app.dock?.hide();   // menu bar app, no Dock icon (plist adds LSUIElement too)
    tray = new Tray(icon("healthy"));
    win = new BrowserWindow({
      ...WIN, show: false, frame: false, transparent: true, resizable: false,
      vibrancy: "hud", visualEffectState: "active",
      alwaysOnTop: true, skipTaskbar: true, fullscreenable: false,
      webPreferences: {
        preload: join(DIST, "preload.cjs"),
        contextIsolation: true, sandbox: true, nodeIntegration: false,
      },
    });
    void win.loadFile(join(DIST, "index.html"));
    win.on("blur", () => live(win)?.hide());
    tray.on("click", toggleWindow);

    ipcMain.on("resize", (_e, h: number) => {
      const w = live(win);
      if (!w) return;
      if (!Number.isFinite(h)) return;
      const bounds = w.getBounds();
      const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
      const maxH = display.workArea.height - 40;
      const clamped = Math.min(Math.max(h, 180), maxH);
      w.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: Math.round(clamped) });
    });

    ipcMain.on("action", (_e, name: string, arg?: string) => {
      try {
        if (name === "pause") pauseCapture(home, (arg ?? "30m") as PauseSpec, Math.floor(Date.now() / 1000));
        else if (name === "resume") resumeCapture(home);
        else if (name === "meeting-stop") meetingStop(home);
        else if (name === "meeting-cancel") meetingCancel(home);
        else if (name === "meeting-model") {
          if (arg === "small" || arg === "large-v3") setMeetingModel(home, arg as MeetingModel);
          else console.error("unknown meeting model:", arg);
        }
        else if (name === "run-update") {
          updUpdating = true; updFailed = false;
          // Detached: `shyn setup` restarts THIS app mid-pipeline; a normal
          // child would die with its parent and strand the upgrade half-done.
          const child = spawn("/bin/bash", ["-lc", upgradeShell(home)],
            { detached: true, stdio: "ignore" });
          child.unref();
        }
        else if (name === "open-onboarding") showOnboarding();
        else if (name === "open-settings") {
          const url = Object.hasOwn(SETTINGS_URLS, arg as string) ? SETTINGS_URLS[arg as SettingsPane] : undefined;
          if (url) void shell.openExternal(url);
          else console.error("unknown settings pane:", arg);
        }
        else if (name === "copy") { if (typeof arg === "string") clipboard.writeText(arg); }
        else if (name === "reveal-apps") { void shell.openPath(join(home, "bin")); }
        else if (name === "diagnose-mail") {
          void buildDiagnostics({
            sock, logDir: join(homedir(), "Library", "Logs", "shyn"),
            uid: process.getuid?.() ?? 501,
            exec: (c, a) => execFileSync(c, a, { encoding: "utf8" }),
            rpc: (s2, m, p) => rpcCall(s2, m, p),
          }).then((t) => shell.openExternal(diagnosticsMailtoUrl(t)))
            .catch((err) => console.error("diagnose-mail failed:", err));
        }
        else if (name === "diagnose") {
          void buildDiagnostics({
            sock, logDir: join(homedir(), "Library", "Logs", "shyn"),
            uid: process.getuid?.() ?? 501,
            exec: (c, a) => execFileSync(c, a, { encoding: "utf8" }),
            rpc: (s, m, p) => rpcCall(s, m, p),
          }).then((t) => clipboard.writeText(t))
            .catch((err) => console.error("diagnose failed:", err));
        }
        else console.error("unknown action:", name);
      } catch (err) {
        console.error("action failed:", err);   // surfaces in status.log under launchd
      }
      void tick();   // reflect immediately rather than waiting out the 3s
    });

    tick().catch((e) => console.error("tick failed:", e));
    setInterval(() => { tick().catch((e) => console.error("tick failed:", e)); }, 3000);
    void updateCheck();
    setInterval(() => void updateCheck(), 24 * 3600 * 1000);

    setTimeout(() => {
      const now = Math.floor(Date.now() / 1000);
      if (
        lastVm?.setup.kind === "steps" &&
        !readCompletedOnce(throttlePath()) &&
        shouldAutoOpen(readThrottle(throttlePath()), now)
      ) {
        writeThrottle(throttlePath(), now);
        showOnboarding();
      }
    }, 4000);
  });

  app.on("window-all-closed", () => { /* keep running — tray app */ });
}
