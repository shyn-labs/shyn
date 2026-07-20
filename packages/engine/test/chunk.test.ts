import { describe, it, expect } from "vitest";
import { chunkFor } from "../src/chunk.js";

describe("chunkFor", () => {
  it("passes through short sources as one chunk", () => {
    expect(chunkFor("browser", "  Title | example.com visit  "))
      .toEqual(["Title | example.com visit"]);
    expect(chunkFor("conversation", "remember this fact")).toEqual(["remember this fact"]);
  });

  it("splits files on headings and size", () => {
    const para = "word ".repeat(100).trim(); // ~500 chars
    const doc = `# Section A\n\n${para}\n\n${para}\n\n${para}\n\n# Section B\n\n${para}`;
    const chunks = chunkFor("file", doc);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1600);
    expect(chunks[0]).toContain("Section A");
    expect(chunks.at(-1)).toContain("Section B");
  });

  it("adds overlap between adjacent chunks of the same section", () => {
    const para = "alpha bravo charlie delta echo ".repeat(30).trim();
    const doc = `${para}\n\n${para}\n\n${para}\n\n${para}`;
    const chunks = chunkFor("file", doc);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const tail = chunks[0].slice(-100);
    expect(chunks[1]).toContain(tail.slice(0, 50));
  });

  it("never returns empty chunks", () => {
    expect(chunkFor("file", "\n\n  \n\n")).toEqual([]);
  });

  it("splits oversized sections and caps every chunk at MAX", () => {
    const para = "word ".repeat(120).trim(); // ~600 chars
    const doc = [para, para, para, para].join("\n\n"); // ~2400 chars, no headings
    const chunks = chunkFor("file", doc);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1600);
  });

  it("splits a single paragraph exceeding MAX without data loss", () => {
    const chunks = chunkFor("file", "x".repeat(5000));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1600);
    // total unique content preserved: strip the 200-char overlaps and rejoin
    const total = chunks.reduce((n, c, i) => n + (i === 0 ? c.length : c.length - 200), 0);
    expect(total).toBe(5000);
  });

  it("treats notes like files", () => {
    const doc = "# H\n\n" + "word ".repeat(120).trim();
    expect(chunkFor("notes", doc)).toEqual(chunkFor("file", doc));
  });

  it("screen source uses the paragraph packer (long OCR text gets split)", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} of screen text with padding`).join("\n\n");
    const chunks = chunkFor("screen", text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 1600)).toBe(true);
  });
});
