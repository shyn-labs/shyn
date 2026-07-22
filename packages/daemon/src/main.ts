#!/usr/bin/env tsx
// Keep this the FIRST import: it installs stamped logging + crash handlers
// before any heavyweight module (native addons) gets a chance to crash
// unstamped. See log-install.ts for why this cannot live in this file's body.
import "./log-install.js";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  Engine, Embedder, LlamaBackend, KeychainKeyProvider, StaticKeyProvider, ModelNotReadyError,
  EmbedBackendUnavailableError, shynHome, ensureModel,
  ChromeHistoryReader, SafariHistoryReader, NotesReader,
} from "@shyn/engine";
import { startServer } from "./server.js";
import { shouldRestartForEmbedFailure } from "./embed-restart.js";
// Static JSON import (not createRequire): esbuild's build-dist.mjs bundle
// inlines this at build time as a literal object, so the version survives
// bundling correctly even though the bundled daemon.mjs runs from a
// different directory than this source file — a createRequire(import.meta.url)
// resolution would instead be evaluated at runtime against the bundle's own
// location and miss the package.json entirely.
import pkg from "../package.json" with { type: "json" };

const home = shynHome();

// Screen retention window, precedence: env SHYN_SCREEN_RETENTION_DAYS >
// capture.json "retentionDays" (spec §3.4 config-file override) > 30. Both the
// env and the config knob were previously ignored in favour of a hardcoded
// default via `|| 30`, which also made 0 (purge-all) impossible — fixed here
// with an explicit finite/non-negative check.
function resolveRetentionDays(): number {
  const raw = process.env.SHYN_SCREEN_RETENTION_DAYS;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  try {
    const cfg = JSON.parse(readFileSync(join(home, "capture.json"), "utf8"));
    if (typeof cfg.retentionDays === "number" && Number.isFinite(cfg.retentionDays) && cfg.retentionDays >= 0)
      return cfg.retentionDays;
  } catch { /* no/invalid capture.json → default */ }
  return 30;
}

// Meeting retention, precedence: env SHYN_MEETING_RETENTION_DAYS >
// capture.json "meetingRetentionDays" > 0. Unlike screen, <= 0 means KEEP
// FOREVER (sweepMeetingRetention no-ops) — meetings are high-value, so
// retention is opt-in. Negative values are accepted as "disabled" on purpose.
function resolveMeetingRetentionDays(): number {
  const raw = process.env.SHYN_MEETING_RETENTION_DAYS;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  try {
    const cfg = JSON.parse(readFileSync(join(home, "capture.json"), "utf8"));
    if (typeof cfg.meetingRetentionDays === "number" && Number.isFinite(cfg.meetingRetentionDays))
      return cfg.meetingRetentionDays;
  } catch { /* no/invalid capture.json → default */ }
  return 0; // keep forever
}

let modelPct = 0, modelPath: string | null = null;
let serverHandle: Awaited<ReturnType<typeof startServer>> | undefined;

// Background model download — never blocks startup (degraded ladder, spec §5)
if (process.env.SHYN_SKIP_MODEL_DOWNLOAD !== "1") {
  void ensureModel(join(home, "models"), (pct) => { modelPct = pct; })
    .then((p) => { modelPath = p; modelPct = 100; serverHandle?.scheduleDrain(); })
    .catch((err) => console.error("model download failed:", err.message));
}

const embedder = new Embedder(async () => {
  if (!modelPath) throw new ModelNotReadyError();
  return LlamaBackend.create(modelPath);
});

const engine = new Engine({
  dbPath: join(home, "shyn.db"),
  keyProvider: process.env.SHYN_TEST_NO_KEYCHAIN === "1"
    ? new StaticKeyProvider("test-key-0123456789abcdef01234567")
    : new KeychainKeyProvider(),
  embedder,
});

// Chunks that exhausted their attempts during a previous outage get a fresh
// set each boot (bounded: 3 attempts per chunk per process lifetime).
const retried = engine.retryFailedEmbeds();
if (retried > 0) console.log(`re-enqueued ${retried} previously-failed embeds`);

const server = serverHandle = await startServer({
  socketPath: join(home, "shyn.sock"), engine, version: pkg.version,
  onDrainError: (err) => {
    if (!(err instanceof EmbedBackendUnavailableError)) { console.error("drain failed:", err); return; }
    console.error("embed backend unavailable — cause:", (err.cause as Error)?.message ?? err.cause);
    if (shouldRestartForEmbedFailure(join(home, "embed-restart.json"), Date.now())) {
      console.error("embed backend import poisoned — exiting so launchd relaunches with a clean module cache (see known-issues.md)");
      process.exit(1);
    }
    console.error("embed backend still unavailable after a recent self-restart — staying up in keyword-only mode");
  },
  extraStatus: () => ({ modelDownloadPct: modelPct, modelDownloaded: modelPct === 100 }),
  // SHYN_TEST_NO_READERS: run without history readers — a daemon on a scratch
  // SHYN_HOME otherwise backfills the machine's real Chrome/Safari/Notes into it.
  readers: process.env.SHYN_TEST_NO_READERS === "1"
    ? []
    : [new ChromeHistoryReader(), new SafariHistoryReader(), new NotesReader()],
  screenRetentionDays: resolveRetentionDays(),
  meetingRetentionDays: resolveMeetingRetentionDays(),
});
console.log(`shynd listening on ${join(home, "shyn.sock")}`);

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, async () => { await server.close(); await engine.close(); process.exit(0); });
