import { describe, it, expect } from "vitest";
import { chunkFor } from "../src/chunk.js";
import { joinChunks } from "../src/document.js";

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
