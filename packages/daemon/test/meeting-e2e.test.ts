import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine, StaticKeyProvider, Embedder, EMBEDDING_DIM, type EmbedBackend,
} from "@shyn/engine";
import { startServer } from "../src/server.js";
import { rpcCall } from "../src/rpc.js";

// A Node "fake agent" speaking the exact wire shapes shyn-meeting's
// MeetingUploader (Task 9) sends. This is the contract freeze for the
// meeting agent ⇄ daemon boundary — every payload here must match
// meetingPayload / the captureStats meeting block field-for-field.

let sock: string, server: { close(): Promise<void>; scheduleDrain(): void };

const now = Math.floor(Date.now() / 1000);

// mirrors MeetingUploader.meetingPayload → DaemonClient.ingest params
const meetingPayload = (uri: string, title: string, text: string,
                        startEpoch: number, endEpoch: number) => ({
  source: "meeting", uri, title, ts: startEpoch, text,
  meta: { app: "Zoom", bundleId: "us.zoom.xos", startedAt: String(startEpoch),
          endedAt: String(endEpoch), durationSec: String(endEpoch - startEpoch),
          channels: "me,others" },
});

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "shyn-me2e-"));
  sock = join(dir, "e.sock");
  const embedder = new Embedder(async () => (<EmbedBackend>{
    embed: async () => { const v = new Float32Array(EMBEDDING_DIM); v[0] = 1; return v; },
    dispose: async () => {},
  }));
  const engine = new Engine({
    dbPath: join(dir, "t.db"), keyProvider: new StaticKeyProvider(null), embedder,
  });
  server = await startServer({
    socketPath: sock, engine, version: "0.1.0-test",
    meetingRetentionDays: 0, retentionIntervalMs: 200,
  });
});
afterEach(async () => { await server.close(); });

describe("meeting transcription e2e (fake agent → real daemon)", () => {
  it("meeting loop: REPLACE identity, retention-off keeps, search finds transcript", async () => {
    const uri = "meeting://us.zoom.xos/2026-07-10-1430";
    const title = "Zoom meeting · 10 Jul 2026, 2:30 PM";

    // 1. ingest a meeting transcript
    await rpcCall(sock, "ingest", meetingPayload(uri, title,
      "Me: hello everyone, shall we start the standup\nOthers: yes, quarterly synthetic standup agenda first",
      now - 1800, now));
    let s = await rpcCall(sock, "status", {});
    expect(s.documents).toBe(1);

    // 2. re-ingest SAME uri with extended text → REPLACE (one doc, latest text wins)
    await rpcCall(sock, "ingest", meetingPayload(uri, title,
      "Me: hello everyone, shall we start the standup\nOthers: yes, quarterly synthetic standup agenda first\nMe: also the retention decision is due today",
      now - 1800, now));
    s = await rpcCall(sock, "status", {});
    expect(s.documents).toBe(1);

    // 3. captureStats with a meeting block → status.capture.meeting round-trips
    //    (opaque payload store — no daemon handler change needed)
    const stats = { agentVersion: "0.1.0", lastCaptureTs: now, captures: 3,
      meeting: { state: "recording", meetingsCaptured: 1, lastTranscribedTs: now,
                 modelReady: true, tcc: { mic: true, audio: true, calendar: false },
                 sessionStartedAt: now - 300, sessionApp: "Google Meet",
                 whisperDownloading: false } };
    await rpcCall(sock, "captureStats", stats);
    s = await rpcCall(sock, "status", {});
    expect(s.capture.meeting).toEqual(stats.meeting);

    // 4. retention OFF (meetingRetentionDays: 0) → a 40-day-old meeting SURVIVES sweeps
    await rpcCall(sock, "ingest", meetingPayload(
      "meeting://us.zoom.xos/2026-05-31-0900", "Zoom meeting · 31 May 2026, 9:00 AM",
      "Me: KEEPFOREVER_payload this old meeting must not be swept\nOthers: agreed",
      now - 40 * 86400, now - 40 * 86400 + 1800));
    s = await rpcCall(sock, "status", {});
    expect(s.documents).toBe(2);
    await new Promise((r) => setTimeout(r, 1000)); // several 200ms sweep ticks
    s = await rpcCall(sock, "status", {});
    expect(s.documents).toBe(2); // still there — 0 means keep forever

    // 5. transcript is searchable: keyword from second zero, hybrid once drained
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (await rpcCall(sock, "status", {})).pendingEmbeds !== 0)
      await new Promise((r) => setTimeout(r, 20));
    const found = await rpcCall(sock, "search", { query: "quarterly synthetic standup agenda" });
    expect(found.mode).toBe("hybrid");
    const hit = found.hits.find((h: any) => h.source === "meeting");
    expect(hit).toBeTruthy();
    expect(hit.title).toBe(title);
    expect(hit.uri).toBe(uri);
    expect(hit.text).toContain("standup");
  });

  // Calendar-stamped variant (CaptureCore MeetingPayloadTests generate this
  // shape; here we freeze that the daemon round-trips it untouched).
  it("calendar-stamped payload: event title leads, calendar meta keys pass through", async () => {
    const uri = "meeting://us.zoom.xos/2026-07-23-1000";
    const title = "Sprint standup · Zoom · 23 Jul 2026, 10:00 AM";
    await rpcCall(sock, "ingest", {
      source: "meeting", uri, title, ts: now - 1800,
      text: "Me: shall we start the flamingo retro\nOthers: yes",
      meta: { app: "Zoom", bundleId: "us.zoom.xos", startedAt: String(now - 1800),
              endedAt: String(now), durationSec: "1800", channels: "me,others",
              calTitle: "Sprint standup", attendees: "Maya R, Dev P, Sam K",
              attendeeCount: "3" },
    });
    const found = await rpcCall(sock, "search", { query: "flamingo retro" });
    const hit = found.hits.find((h: any) => h.source === "meeting");
    expect(hit).toBeTruthy();
    expect(hit.title).toBe(title);
    expect(hit.uri).toBe(uri);
  });
});
