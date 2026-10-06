import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage.js";
import { addSelfSample, selfSamples, forgetSelf, decodeEmbedding, SELF_SAMPLE_CAP } from "../src/voice.js";
import { chooseSelf, relabelInPerson, selfScores, pickSelf, matchLogLine } from "../src/voice.js";
import { Engine } from "../src/engine.js";
import { StaticKeyProvider } from "../src/keys.js";
import { Embedder, type EmbedBackend } from "../src/embedder.js";
import { EMBEDDING_DIM } from "../src/storage.js";

const db = () => openDatabase({ dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"), key: null });
const vec = (...xs: number[]) => Float32Array.from(xs);

describe("self voice profile", () => {
  it("decodes base64 little-endian float32 (wire format from the agent)", () => {
    expect(Array.from(decodeEmbedding(Buffer.from([0, 0, 0x80, 0x3f]).toString("base64")))).toEqual([1]);
  });

  it("keeps the 20 most recent samples, dropping the oldest", () => {
    const d = db();
    for (let i = 0; i < SELF_SAMPLE_CAP + 3; i++) addSelfSample(d, vec(i, 0), 40, 1000 + i);
    const s = selfSamples(d);
    expect(s).toHaveLength(SELF_SAMPLE_CAP);
    expect(s.map((v) => v[0])).not.toContain(0);
    expect(s.map((v) => v[0])).toContain(SELF_SAMPLE_CAP + 2);
  });

  it("forget-self removes the profile and every sample", () => {
    const d = db();
    // Add 3 samples to ensure cascade delete is actually working, not just
    // relying on the selfSamples() JOIN to hide orphaned samples.
    addSelfSample(d, vec(1, 0), 40, 1);
    addSelfSample(d, vec(2, 0), 40, 2);
    addSelfSample(d, vec(3, 0), 40, 3);
    expect(forgetSelf(d).removed).toBe(1);
    expect(selfSamples(d)).toEqual([]);
    expect(d.prepare("SELECT COUNT(*) n FROM voice_profiles").get()).toEqual({ n: 0 });
    // Critical: verify samples are actually deleted, not just hidden by JOIN.
    expect(d.prepare("SELECT COUNT(*) n FROM voice_samples").get()).toEqual({ n: 0 });
  });
});

const unit = (...xs: number[]) => { const v = vec(...xs); const n = Math.hypot(...xs); return v.map((x) => x / n); };

describe("choosing Me in an in-person session", () => {
  const me = unit(1, 0, 0), other = unit(0, 1, 0);
  it("picks the speaker closest to any self sample when it clears threshold and margin", () => {
    expect(chooseSelf([{ label: "S1", embedding: other }, { label: "S2", embedding: unit(0.95, 0.05, 0) }], [me])).toBe("S2");
  });
  it("matches the closest sample, not the centroid", () => {
    const airpods = unit(1, 0, 0), laptop = unit(0, 0, 1);   // centroid would match neither well
    expect(chooseSelf([{ label: "S1", embedding: unit(0, 0.02, 1) }], [airpods, laptop])).toBe("S1");
  });
  it("is null when two speakers are too close to call", () => {
    expect(chooseSelf([{ label: "S1", embedding: unit(1, 0.1, 0) }, { label: "S2", embedding: unit(1, 0.12, 0) }], [me])).toBeNull();
  });
  it("is null when a speaker's vector length differs from the sample's (no truncated comparison)", () => {
    expect(chooseSelf([{ label: "S1", embedding: unit(1, 0, 0, 0) }], [unit(1, 0, 0)])).toBeNull();
  });
  it("is null below threshold and with no samples", () => {
    expect(chooseSelf([{ label: "S1", embedding: other }], [me])).toBeNull();
    expect(chooseSelf([{ label: "S1", embedding: me }], [])).toBeNull();
  });
});

describe("scores behind the Me decision (logged so the thresholds can be tuned)", () => {
  const me = unit(1, 0, 0);
  const spk = [{ label: "S1", embedding: unit(0, 1, 0) }, { label: "S2", embedding: unit(0.95, 0.05, 0) }];

  it("scores every speaker by its closest sample, best first", () => {
    const sc = selfScores(spk, [me]);
    expect(sc.map((x) => x.label)).toEqual(["S2", "S1"]);
    expect(sc[0].score).toBeGreaterThan(0.9);
    expect(sc[1].score).toBeLessThan(0.1);
  });
  it("pickSelf on those scores agrees with chooseSelf", () => {
    expect(pickSelf(selfScores(spk, [me]))).toBe(chooseSelf(spk, [me]));
    expect(pickSelf([])).toBeNull();
  });
  it("the log line has labels and two-decimal numbers only", () => {
    const line = matchLogLine(selfScores(spk, [me]), "S2", 3);
    expect(line).toMatch(/^in-person match: 3 voices, best S2 \d\.\d\d, runner-up S1 \d\.\d\d, margin \d\.\d\d, Me=S2 \(threshold 0\.60, margin 0\.20\)$/);
  });
  it("says when nobody matched and when there is a single voice", () => {
    expect(matchLogLine(selfScores(spk, [unit(0, 0, 1)]), null, 2)).toContain("Me=none");
    expect(matchLogLine(selfScores([spk[1]], [me]), "S2", 1)).toContain("runner-up none");
  });
});

describe("relabelling in-person lines", () => {
  const text = "Speaker 1: hello\nSpeaker 2: hi there\nSpeaker 3: yes\nSpeaker 2: Speaker 1: is quoted";
  it("turns the self speaker into Me and renumbers the rest in order", () => {
    expect(relabelInPerson(text, "S2", ["S1", "S2", "S3"]))
      .toBe("Speaker 1: hello\nMe: hi there\nSpeaker 2: yes\nMe: Speaker 1: is quoted");
  });
  it("leaves every Speaker N alone when Me is not certain", () => {
    expect(relabelInPerson("Speaker 1: hello", null, ["S1"])).toBe("Speaker 1: hello");
  });
});

describe("Engine.ingestMeeting never costs a transcript", () => {
  it("still stores the incoming text when voice storage fails", async () => {
    const embedder = new Embedder(async () => (<EmbedBackend>{
      embed: async () => { const v = new Float32Array(EMBEDDING_DIM); v[0] = 1; return v; },
      dispose: async () => {},
    }));
    const e = new Engine({
      dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"),
      keyProvider: new StaticKeyProvider(null), embedder,
    });
    const d = (e as any).db as ReturnType<typeof db>;
    addSelfSample(d, vec(1, 0, 0), 40, 1);
    // (An odd-length BLOB does NOT throw: Float32Array truncates it. A broken
    // table does, which is the failure class this guard exists for.)
    d.exec("DROP TABLE voice_samples");
    expect(() => selfSamples(d)).toThrow();

    const f32 = (...xs: number[]) => Buffer.from(Float32Array.from(xs).buffer).toString("base64");
    const ts = Math.floor(Date.now() / 1000);
    const errs: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errs.push(a); };
    let r;
    try {
      r = e.ingestMeeting({
        source: "meeting", uri: "meeting://call/corrupt", title: "Recording", ts,
        text: "Speaker 1: hi\nSpeaker 2: hello",
        speakers: [{ label: "S1", channel: "mic", embedding: f32(0, 1, 0), speechSec: 20 },
                   { label: "S2", channel: "mic", embedding: f32(1, 0, 0), speechSec: 20 }],
      });
    } finally { console.error = orig; }
    expect(r.rejected).toBeFalsy();
    expect(errs).toHaveLength(1);
    expect(String(errs[0][0])).toContain("[voice]");
    const doc = e.document({ uri: "meeting://call/corrupt" } as never) as { text: string };
    expect(doc.text).toContain("Speaker 1: hi\nSpeaker 2: hello");
    expect(doc.text).not.toContain("Me:");
    await e.close();
  });
});

describe("Engine.ingestMeeting self samples", () => {
  const f32 = (...xs: number[]) => Buffer.from(Float32Array.from(xs).buffer).toString("base64");
  const mk = () => {
    const embedder = new Embedder(async () => (<EmbedBackend>{
      embed: async () => { const v = new Float32Array(EMBEDDING_DIM); v[0] = 1; return v; },
      dispose: async () => {},
    }));
    const e = new Engine({
      dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"),
      keyProvider: new StaticKeyProvider(null), embedder,
    });
    return { e, d: (e as any).db as ReturnType<typeof db> };
  };
  const call = (text: string, ts = 1000) => ({
    source: "meeting" as const, uri: "meeting://us.zoom.xos/2026-10-05-1000", title: "Zoom call", ts, text,
    speakers: [{ label: "S1", channel: "system" as const, embedding: f32(0, 1, 0), speechSec: 40 }],
    selfSample: { embedding: f32(1, 0, 0), speechSec: 45 },
  });

  it("a retried call payload is deduped, stores identical text and exactly one sample", async () => {
    const { e, d } = mk();
    const first = e.ingestMeeting(call("Me: morning\nSpeaker 1: hi"));
    const second = e.ingestMeeting(call("Me: morning\nSpeaker 1: hi"));
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(selfSamples(d)).toHaveLength(1);
    const t = (e.document({ uri: call("").uri }) as { text: string }).text;
    expect(t).toContain("Me: morning\nSpeaker 1: hi");
    await e.close();
  });

  it("a re-transcription (same uri and ts, new text) still leaves exactly one sample", async () => {
    const { e, d } = mk();
    e.ingestMeeting(call("Me: morning\nSpeaker 1: hi"));
    const r = e.ingestMeeting(call("Me: morning\nSpeaker 1: hi there, shall we start"));
    expect(r.deduped).toBe(false);
    expect(selfSamples(d)).toHaveLength(1);
    const t = (e.document({ uri: call("").uri }) as { text: string }).text;
    expect(t).toContain("shall we start");
    await e.close();
  });

  it("a different call (new ts) adds a second sample", async () => {
    const { e, d } = mk();
    e.ingestMeeting(call("Me: one", 1000));
    e.ingestMeeting({ ...call("Me: two", 2000), uri: "meeting://us.zoom.xos/2026-10-05-1100" });
    expect(selfSamples(d)).toHaveLength(2);
    await e.close();
  });

  it("never stores a self sample from an in-person session (mic speakers)", async () => {
    const { e, d } = mk();
    const r = e.ingestMeeting({
      source: "meeting", uri: "meeting://call/in-person", title: "Recording", ts: 1000,
      text: "Speaker 1: hi\nSpeaker 2: hello",
      speakers: [{ label: "S1", channel: "mic", embedding: f32(0, 1, 0), speechSec: 20 },
                 { label: "S2", channel: "mic", embedding: f32(1, 0, 0), speechSec: 20 }],
      selfSample: { embedding: f32(1, 0, 0), speechSec: 45 },
    });
    expect(r.rejected).toBeFalsy();
    expect(selfSamples(d)).toHaveLength(0);
    await e.close();
  });
});

describe("Engine.ingestMeeting logs the in-person match scores", () => {
  const f32 = (...xs: number[]) => Buffer.from(Float32Array.from(xs).buffer).toString("base64");
  it("logs one numbers-only line and never an embedding", async () => {
    const embedder = new Embedder(async () => (<EmbedBackend>{
      embed: async () => { const v = new Float32Array(EMBEDDING_DIM); v[0] = 1; return v; },
      dispose: async () => {},
    }));
    const e = new Engine({
      dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"),
      keyProvider: new StaticKeyProvider(null), embedder,
    });
    const d = (e as any).db as ReturnType<typeof db>;
    addSelfSample(d, vec(1, 0, 0), 40, 1);
    const errs: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errs.push(a); };
    try {
      e.ingestMeeting({
        source: "meeting", uri: "meeting://call/scores", title: "Recording", ts: 2000,
        text: "Speaker 1: hi\nSpeaker 2: hello",
        speakers: [{ label: "S1", channel: "mic", embedding: f32(0, 1, 0), speechSec: 20 },
                   { label: "S2", channel: "mic", embedding: f32(1, 0.02, 0), speechSec: 20 }],
      });
    } finally { console.error = orig; }
    expect(errs).toHaveLength(1);
    const line = String(errs[0][0]);
    expect(line).toMatch(/^\[voice\] in-person match: 2 voices, best S2 /);
    expect(line).toContain("Me=S2");
    expect(line).not.toContain(f32(1, 0.02, 0));
    await e.close();
  });
});
