import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage.js";
import { addSelfSample, selfSamples, forgetSelf, decodeEmbedding, SELF_SAMPLE_CAP } from "../src/voice.js";

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
    addSelfSample(d, vec(1, 0), 40, 1);
    expect(forgetSelf(d).removed).toBe(1);
    expect(selfSamples(d)).toEqual([]);
    expect(d.prepare("SELECT COUNT(*) n FROM voice_profiles").get()).toEqual({ n: 0 });
  });
});
