import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureModel, MODEL_FILE } from "../src/model-download.js";

describe("ensureModel", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("removes the .part file instead of leaving it behind on checksum mismatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shyn-model-"));
    const bytes = new TextEncoder().encode("definitely not the real model bytes");
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); controller.close(); },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status: 200, headers: { "content-length": String(bytes.length) },
    })));

    await expect(ensureModel(dir)).rejects.toThrow(/checksum mismatch/);

    expect(existsSync(join(dir, MODEL_FILE))).toBe(false);
    expect(existsSync(join(dir, MODEL_FILE + ".part"))).toBe(false);
  });

  it("re-hashes a cached model and re-downloads on mismatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shyn-model-"));
    writeFileSync(join(dir, MODEL_FILE), "tampered bytes"); // wrong hash
    // stub fetch to return 500 → ensureModel throws, and the tampered file must be GONE
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 500 })) as any;
    try {
      await expect(ensureModel(dir)).rejects.toThrow(/download failed/);
      expect(existsSync(join(dir, MODEL_FILE))).toBe(false); // tampered cache purged
    } finally { globalThis.fetch = oldFetch; }
  });
});
