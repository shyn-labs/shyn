import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldRestartForEmbedFailure, EMBED_RESTART_COOLDOWN_MS } from "../src/embed-restart.js";

describe("shouldRestartForEmbedFailure", () => {
  const marker = () => join(mkdtempSync(join(tmpdir(), "shyn-er-")), "embed-restart.json");

  it("allows the first restart and records it", () => {
    const m = marker();
    expect(shouldRestartForEmbedFailure(m, 1_000_000)).toBe(true);
    // immediately after: within cooldown → refuse (no crash loop)
    expect(shouldRestartForEmbedFailure(m, 1_000_001)).toBe(false);
  });

  it("allows again after the cooldown elapses", () => {
    const m = marker();
    expect(shouldRestartForEmbedFailure(m, 1_000_000)).toBe(true);
    expect(shouldRestartForEmbedFailure(m, 1_000_000 + EMBED_RESTART_COOLDOWN_MS + 1)).toBe(true);
  });

  it("treats a corrupt marker as absent", () => {
    const m = marker();
    require("node:fs").writeFileSync(m, "not json");
    expect(shouldRestartForEmbedFailure(m, 5)).toBe(true);
  });
});
