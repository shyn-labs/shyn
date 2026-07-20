// Side-effect module — MUST be main.ts's first import. ESM hoists and fully
// evaluates imports in order, so putting these calls in main.ts's body (or
// importing this module after @shyn/engine) leaves a window where a module-
// initialization crash — e.g. better-sqlite3's native binding missing or
// ABI-mismatched after a bundle upgrade, a lived incident class — dies
// unstamped with rotation never run, recreating the exact 2026-07-19
// diagnosis gap this logging exists to close. This module imports only
// ./log.js (node builtins), so nothing heavyweight can crash before it runs.
import {
  installStampedConsole, installCrashLogging, rotateLogIfOversized, sweepLogDir,
} from "./log.js";

installStampedConsole();
installCrashLogging();

// SHYN_LOG_PATH is only set under launchd (see cli launchd.ts); dev runs
// skip rotation entirely. Boot-time rotation handles crash-loop growth; the
// hourly sweep bounds a healthy months-long uptime (boot-only enforcement
// would let the cap go unenforced for exactly the stable case) and covers
// the agents' logs, which have no rotation mechanism of their own.
if (rotateLogIfOversized(process.env.SHYN_LOG_PATH))
  console.log("daemon.log exceeded 5MB — rotated to daemon.log.1 at boot");
setInterval(() => {
  for (const name of sweepLogDir(process.env.SHYN_LOG_PATH))
    console.log(`${name} exceeded 5MB — rotated to ${name}.1`);
}, 3_600_000).unref();
