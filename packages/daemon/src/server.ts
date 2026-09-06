import { join, dirname } from "node:path";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { chmodSync, rmSync , readFileSync, writeFileSync} from "node:fs";
import { loadConsent, consentNeedsPrompt, recordConsentChoice } from "./analytics-consent.js";
import type { Engine, Reader, SyncResult } from "@shyn/engine";
import { HEARTBEAT_SECONDS } from "@shyn/engine";

export const PROTOCOL_VERSION = 1;

export async function startServer(opts: {
  socketPath: string; engine: Engine; version: string;
  extraStatus?: () => Record<string, unknown>;
  backfillIntervalMs?: number;
  readers?: Reader[]; readerIntervalMs?: number; initialSyncDelayMs?: number;
  screenRetentionDays?: number; retentionIntervalMs?: number;
  meetingRetentionDays?: number; coverageRetentionDays?: number;
  heartbeatIntervalMs?: number;
  onDrainError?: (err: unknown) => void;
  // Absent when the user has not consented (or has opted out): the whole
  // analytics path is then not merely disabled but not constructed, so there
  // is nothing holding events in memory either.
  analytics?: {
    track(event: string, properties?: Record<string, unknown>): void;
    setEnabled?(on: boolean): void;
  };
  /// Where analytics-consent.json lives. Defaults to the socket's directory.
  home?: string;
}): Promise<{ close(): Promise<void>; scheduleDrain(): void }> {
  const { engine } = opts;
  let draining = Promise.resolve();
  let lastCaptureStats: Record<string, unknown> | null = null;
  // agent name -> epoch seconds of its last captureStats post. Memory-only,
  // like lastCaptureStats: a restart legitimately means "unknown until they post".
  const lastAgentPost: Record<string, number> = {};
  const helloPath = join(dirname(opts.socketPath), "mcp-hello.json");
  let lastMcpHelloTs: number | null = null;
  try {
    const { ts } = JSON.parse(readFileSync(helloPath, "utf8"));
    if (typeof ts === "number") lastMcpHelloTs = ts;
  } catch { /* no marker yet */ }
  // Analytics is absent unless the user consented. Every call site goes
  // through this so a missing queue, an unknown event, or a throwing tracker
  // can never fail the operation the user actually asked for.
  const track = (event: string, properties?: Record<string, unknown>) => {
    try { opts.analytics?.track(event, properties ?? {}); }
    catch { /* never propagates */ }
  };
  const scheduleDrain = () => {
    draining = draining.then(() => engine.drain()).catch((err) => { opts.onDrainError?.(err); });
  };

  let lastSync: SyncResult[] = [];
  let syncing: Promise<SyncResult[]> = Promise.resolve([]);
  const runSync = (): Promise<SyncResult[]> => {
    const run = syncing.then(async () => {
      lastSync = await engine.syncReaders(opts.readers ?? []);
      scheduleDrain();
      return lastSync;
    });
    syncing = run.catch(() => lastSync);
    return run;
  };

  const handlers: Record<string, (p: any) => Promise<unknown> | unknown> = {
    ingest: (p) => { const r = engine.ingest(p); scheduleDrain(); return r; },
    search: (p) => {
      // Counting is never on the search critical path — a failed bump must
      // not fail the search (spec: failures to count are swallowed).
      try { engine.countSearch(); } catch { /* swallowed by design */ }
      // Shape only: THAT a search happened, never what was searched for.
      track("search_memory_called");
      return engine.search(p);
    },
    recent: (p) => { track("recent_activity_called"); return engine.recent(p); },
    // Browser rows in a time window, for the meeting agent's title lookup: the
    // conferencing tab open during a recording carries the meeting's real name
    // (`Meet – Weekly Ops Review`), which beats a calendar that
    // may be stale and needs no permission the reader doesn't already have.
    //
    // NOT folded into `recent`, which emits recent_activity_called — an agent
    // naming its own recording is not the user reaching for their memory, and
    // counting it would inflate the one metric that says whether recall is
    // used at all. Untracked by design; it reads nothing the agent's own
    // documents don't already contain.
    // Wrapped in an object rather than returned bare: DaemonClient.call on the
    // Swift side unwraps `result` as a dictionary and would silently hand back
    // an empty one for a top-level array.
    browserVisits: (p) => ({
      visits: engine.recent({
        timeFrom: p.timeFrom, timeTo: p.timeTo,
        sources: ["browser"], order: "asc", limit: p.limit ?? 200,
      }),
    }),
    document: (p) => { track("get_document_called"); return engine.document(p); },
    // Long-running by nature (scrypt + a whole-corpus stream), so the CLI calls
    // these with a generous timeout rather than the default.
    export: async (p) => ({ documents: await engine.exportArchive(p.passphrase, p.path) }),
    import: (p) => engine.importArchive(p.passphrase, p.path),
    forget: (p) => {
      if (p?.confirm !== true)
        throw Object.assign(new Error("forget requires confirm: true"), { code: -32001 });
      const { confirm: _c, ...sel } = p;
      track("forget_called");
      return engine.forget(sel);
    },
    sync: (p) => {
      if (p?.full) for (const r of opts.readers ?? []) engine.resetReaderWatermark(r.name);
      return runSync();
    },
    // Agents post their heartbeats here; the daemon holds an opaque merged
    // view for status. Shallow merge by top-level key so the screen agent
    // (full Stats shape) and the meeting agent (posts only { meeting: … })
    // don't clobber each other — each owns its own keys. Not persisted — a
    // restart resets to "not-reporting" until the agents' next posts.
    captureStats: (p) => {
      lastCaptureStats = { ...lastCaptureStats, ...p };
      // Per-agent last-seen, so the coverage heartbeat can record WHICH agents
      // were alive at each beat. A live daemon with a dead screen agent used to
      // be invisible (capture.log sat at 0 bytes for weeks).
      const seen = Math.floor(Date.now() / 1000);
      for (const k of Object.keys(p ?? {})) lastAgentPost[k] = seen;
      return { ok: true };
    },
    // Which agents count as reporting right now: posted within two heartbeat
    // intervals. One missed post is jitter, not an outage.
    coverage: (p) => engine.coverage({
      timeFrom: p.timeFrom, timeTo: p.timeTo,
      expectAgents: p.expectAgents ?? Object.keys(lastAgentPost),
    }),
    // Ground-truth "an MCP client actually connected" for onboarding
    // (spec SP6): config-file detection is unreliable (CLAUDE_CONFIG_DIR,
    // per-project scopes, Claude Desktop). Memory-only, like captureStats.
    hello: (p) => {
      if (p?.client === "mcp") {
        lastMcpHelloTs = Math.floor(Date.now() / 1000);
        // Persisted so upgrades/restarts don't un-check the onboarding
        // step (memory-only lastMcpHelloTs regressed visibly on every
        // brew upgrade — lived 2026-07-13).
        try { writeFileSync(helloPath, JSON.stringify({ ts: lastMcpHelloTs }) + "\n"); }
        catch { /* persistence is best-effort; the live flag still works */ }
      }
      return { ok: true };
    },
    status: () => ({
      ...engine.status(), daemonVersion: opts.version, protocolVersion: PROTOCOL_VERSION,
      // Default (no extraStatus wired): there's no download tracking to speak
      // of, so treat the model as already fully downloaded.
      modelDownloadPct: 100, modelDownloaded: true,
      readers: lastSync, capture: lastCaptureStats ?? { agent: "not-reporting" },
      lastMcpHelloTs,
      ...(opts.extraStatus?.() ?? {}),
    }),
    stats: (p) => engine.stats(p ?? {}),
    // Usage analytics. Agents and the CLI call this unconditionally and it is
    // ALWAYS ok:true — a disabled queue, an unknown event from a version-
    // skewed agent, or a missing queue entirely are all no-ops. Analytics
    // must never be something a caller has to handle, and must never be able
    // to fail an operation the user actually asked for.
    "analytics.track": (p) => { track(p?.event, p?.properties ?? {}); return { ok: true }; },
    // Consent lives HERE, not in the status UI. Minting and destroying the
    // installId is the one operation that must not have two implementations
    // that can drift; the UI asks rather than writing the file itself.
    "analytics.consentStatus": () => {
      const c = loadConsent(opts.home ?? dirname(opts.socketPath));
      // Deliberately does NOT return installId: the UI has no use for it and
      // every extra copy is another place it can leak.
      return { needsPrompt: consentNeedsPrompt(c), enabled: c.enabled };
    },
    "analytics.setConsent": (p) => {
      const home = opts.home ?? dirname(opts.socketPath);
      const c = recordConsentChoice(home, p?.enabled === true);
      // Reflect the decision on the LIVE queue immediately. Without this a
      // user who opts out keeps sending until the next daemon restart, which
      // is exactly the "off means off" promise the dialog makes.
      opts.analytics?.setEnabled?.(c.enabled);
      return { ok: true, enabled: c.enabled };
    },
  };

  rmSync(opts.socketPath, { force: true });
  const server = createServer((socket) => {
    // A client may vanish while a slow handler is still running (rpc.ts
    // clients destroy their socket on timeout); the late response write must
    // not take the daemon down with it.
    const respond = (msg: string) => { if (!socket.destroyed) socket.write(msg); };
    const rl = createInterface({ input: socket });
    rl.on("line", async (line) => {
      let id: unknown = null;
      try {
        const req = JSON.parse(line);
        id = req.id;
        const handler = handlers[req.method];
        if (!handler)
          throw Object.assign(new Error("method not found"), { code: -32601 });
        const result = await handler(req.params ?? {});
        respond(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
      } catch (err: any) {
        respond(JSON.stringify({
          jsonrpc: "2.0", id,
          error: { code: err.code ?? -32000, message: err.message ?? "internal error" },
        }) + "\n");
      }
    });
    // readline re-emits its input stream's 'error' on the Interface; with no
    // listener there, a client disconnecting mid-request (write EPIPE) became
    // an unhandled 'error' event that killed the whole daemon — 12 crash
    // cycles in one production log (2026-07-19). The socket's own copy is
    // handled below; this mirrors rpc.ts's identical client-side fix.
    rl.on("error", () => socket.destroy());
    socket.on("error", () => socket.destroy());
  });
  const oldUmask = process.umask(0o077);
  try {
    await new Promise<void>((res, rej) =>
      server.listen(opts.socketPath, () => res()).once("error", rej));
  } finally {
    process.umask(oldUmask);
  }
  chmodSync(opts.socketPath, 0o600); // keep as belt-and-braces

  // Safety net for spec §5's degraded-mode ladder: if the model finishes
  // downloading between ingests (or the main.ts ensureModel().then() races
  // startServer's own promise — see main.ts), this periodic sweep still
  // drains any embed_queue rows left pending.
  const backfill = setInterval(scheduleDrain, opts.backfillIntervalMs ?? 60_000);
  backfill.unref();

  const readerTimer = setInterval(() => { void runSync().catch(() => {}); },
    opts.readerIntervalMs ?? 900_000);
  readerTimer.unref();

  // Spec §14.2: the daemon should be able to answer within 5 minutes of
  // install, which requires readers to have run at least once — the
  // periodic readerTimer above only fires after a full readerIntervalMs
  // (up to 15 minutes by default). Fire one sync shortly after startup
  // instead of waiting for the first interval tick. The delay (default 30s,
  // not 0) is deliberate: it keeps this from racing model download / the
  // first ingest's own drain right at boot.
  const initialSync = setTimeout(() => { void runSync().catch(() => {}); },
    opts.initialSyncDelayMs ?? 30_000);
  initialSync.unref();

  // Spec §3.4: roll the screen source's 30-day window. sweepScreen is a cheap
  // count pre-check when nothing expired (VACUUM only on actual deletions), so
  // the hourly cadence is safe. Failures are swallowed; the next tick retries.
  // Meeting default is 0 = keep forever (sweepMeeting no-ops on <= 0) — the
  // opposite of screen, where 0 would mean purge-all. Don't unify them.
  const retention = setInterval(() => {
    try { engine.sweepScreen(opts.screenRetentionDays ?? 30); } catch { /* next tick retries */ }
    try { engine.sweepMeeting(opts.meetingRetentionDays ?? 0); } catch { /* next tick retries */ }
    // Beats are tiny (two integers) but unbounded growth is still growth; a
    // year of coverage is ~525k rows. Ride the same hourly tick.
    try { engine.sweepCoverage(opts.coverageRetentionDays ?? 400); } catch { /* next tick retries */ }
  }, opts.retentionIntervalMs ?? 3_600_000);
  retention.unref();

  // The observation heartbeat (coverage.ts). Absence of these rows is the only
  // way recall can distinguish "quiet hour" from "asleep / daemon down", which
  // is what made a 14-hour hole read as silence on 2026-08-05. Cheap enough to
  // run unconditionally: one INSERT OR REPLACE per minute.
  const beat = () => {
    const now = Math.floor(Date.now() / 1000);
    const alive = Object.entries(lastAgentPost)
      .filter(([, ts]) => now - ts <= HEARTBEAT_SECONDS * 2)
      .map(([name]) => name);
    try { engine.beat(alive, now); } catch { /* next beat retries */ }
  };
  beat();   // stamp the moment the daemon came up, don't wait a full interval
  const heartbeat = setInterval(beat, opts.heartbeatIntervalMs ?? HEARTBEAT_SECONDS * 1000);
  heartbeat.unref();

  return {
    scheduleDrain,
    close: async () => {
      clearInterval(backfill);
      clearInterval(readerTimer);
      clearTimeout(initialSync);
      clearInterval(retention);
      clearInterval(heartbeat);
      await syncing.catch(() => {});
      await draining;
      await new Promise<void>((res) => server.close(() => res()));
      rmSync(opts.socketPath, { force: true });
    },
  };
}
