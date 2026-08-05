import { describe, it, expect } from "vitest";
import { chunkFor } from "../src/chunk.js";
import { joinChunks } from "../src/document.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.js";
import { StaticKeyProvider } from "../src/keys.js";
import { Embedder, type EmbedBackend } from "../src/embedder.js";
import { EMBEDDING_DIM } from "../src/storage.js";

describe("joinChunks", () => {
  it("returns empty string for no chunks", () => {
    expect(joinChunks([])).toBe("");
  });

  it("returns a single chunk unchanged", () => {
    expect(joinChunks(["one chunk only"])).toBe("one chunk only");
  });

  it("round-trips a multi-paragraph document (overlap path)", () => {
    // Must genuinely exceed MAX (1600) or packParagraphs returns ONE chunk and
    // the overlap path is never exercised — the plan's 8×159-char fixture only
    // reached ~1290 chars. Distinct leading tokens per paragraph keep the
    // longest-overlap match unambiguous.
    const para = "a sentence with a fair number of distinct words in it".repeat(3);
    const doc = Array.from({ length: 40 }, (_, i) => `paragraph ${i} ${para}`).join("\n\n");
    const chunks = chunkFor("meeting", doc);
    expect(chunks.length).toBeGreaterThan(1);
    expect(joinChunks(chunks)).toBe(doc);
  });

  it("round-trips the hard-split path (one paragraph past MAX)", () => {
    // Distinct tokens on purpose: self-similar text (e.g. "x".repeat(5000))
    // makes the longest-overlap match ambiguous and would over-strip.
    const doc = Array.from({ length: 900 }, (_, i) => `w${i}`).join(" ");
    const chunks = chunkFor("file", doc);
    expect(chunks.length).toBeGreaterThan(1);
    expect(joinChunks(chunks)).toBe(doc);
  });

  it("restores the blank line between heading-split sections", () => {
    // Sections are packed independently, so adjacent chunks across a section
    // boundary share NO overlap and the separating blank line was consumed.
    const doc = "# One\n\nalpha beta gamma\n\n# Two\n\ndelta epsilon zeta";
    const chunks = chunkFor("file", doc);
    expect(chunks.length).toBe(2);
    expect(joinChunks(chunks)).toBe(doc);
  });

  it("round-trips a transcript-shaped document (single-line segments)", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `Me: line number ${i} of the transcript`);
    const doc = lines.join("\n\n");
    const chunks = chunkFor("meeting", doc);
    expect(chunks.length).toBeGreaterThan(1);
    expect(joinChunks(chunks)).toBe(doc);
  });
});

function newEngine() {
  const embedder = new Embedder(async () => (<EmbedBackend>{
    embed: async () => { const v = new Float32Array(EMBEDDING_DIM); v[0] = 1; return v; },
    dispose: async () => {},
  }));
  return new Engine({
    dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"),
    keyProvider: new StaticKeyProvider(null),
    embedder,
  });
}

describe("Engine.document", () => {
  it("returns the full reassembled text for a multi-chunk document", async () => {
    const e = newEngine();
    const doc = Array.from({ length: 400 }, (_, i) => `Me: line number ${i} of the transcript`).join("\n\n");
    e.ingest({ source: "meeting", uri: "meeting://test/1", title: "Standup", ts: 1000, text: doc });
    await e.drain();
    const got = e.document({ uri: "meeting://test/1" });
    expect(got).not.toBeNull();
    expect(got!.text).toBe(doc);
    expect(got!.chunkCount).toBeGreaterThan(1);
    expect(got!.source).toBe("meeting");
    expect(got!.title).toBe("Standup");
    expect(got!.ts).toBe(1000);
    await e.close();
  });

  it("resolves by docId", async () => {
    const e = newEngine();
    e.ingest({ source: "file", uri: "/a.md", title: "a", ts: 1000, text: "hello world" });
    await e.drain();
    const byUri = e.document({ uri: "/a.md" })!;
    expect(e.document({ docId: byUri.docId })!.text).toBe("hello world");
    await e.close();
  });

  it("returns null for a uri that does not exist", async () => {
    const e = newEngine();
    expect(e.document({ uri: "/nope.md" })).toBeNull();
    await e.close();
  });

  it("throws when neither docId nor uri is given", async () => {
    const e = newEngine();
    expect(() => e.document({})).toThrow(/docId or uri/);
    await e.close();
  });

  it("throws naming the sources when a uri is ambiguous, and resolves with source", async () => {
    const e = newEngine();
    e.ingest({ source: "file", uri: "same", title: "f", ts: 1000, text: "from the file" });
    e.ingest({ source: "notes", uri: "same", title: "n", ts: 1001, text: "from the note" });
    await e.drain();
    expect(() => e.document({ uri: "same" })).toThrow(/file, notes/);
    expect(e.document({ uri: "same", source: "notes" })!.text).toBe("from the note");
    await e.close();
  });
});
