import { describe, it, expect, vi } from "vitest";
import { Embedder, quantizeInt8, QUERY_PREFIX, type EmbedBackend } from "../src/embedder.js";

const fakeBackend = () => {
  const calls: string[] = [];
  const backend: EmbedBackend = {
    embed: async (t) => { calls.push(t); return Float32Array.from([0.5, -1.2, 0.009, 1.0]); },
    dispose: vi.fn(async () => {}),
  };
  return { backend, calls, dispose: backend.dispose };
};

describe("quantizeInt8", () => {
  it("scales by 127 and clamps", () => {
    expect(Array.from(quantizeInt8(Float32Array.from([0.5, -1.2, 0.009, 1.0]))))
      .toEqual([64, -127, 1, 127]);
  });
});

describe("Embedder", () => {
  it("lazy-loads and prefixes queries only", async () => {
    const { backend, calls } = fakeBackend();
    const e = new Embedder(async () => backend);
    expect(e.isReady()).toBe(false);
    await e.embedDoc("a document");
    await e.embedQuery("a query");
    expect(e.isReady()).toBe(true);
    expect(calls[0]).toBe("a document");
    expect(calls[1]).toBe(QUERY_PREFIX + "a query");
    await e.dispose();
  });

  it("disposes backend after idle timeout", async () => {
    vi.useFakeTimers();
    const { backend, dispose } = fakeBackend();
    const e = new Embedder(async () => backend, 1000);
    await e.embedDoc("x");
    await vi.advanceTimersByTimeAsync(1500);
    expect(dispose).toHaveBeenCalled();
    expect(e.isReady()).toBe(false);
    vi.useRealTimers();
  });

  it("recovers after a failed load (retries the factory)", async () => {
    let calls = 0;
    const good = fakeBackend();
    const e = new Embedder(async () => {
      calls++;
      if (calls === 1) throw new Error("transient load failure");
      return good.backend;
    });
    await expect(e.embedDoc("x")).rejects.toThrow(/transient/);
    await expect(e.embedDoc("x")).resolves.toBeInstanceOf(Int8Array);
    expect(calls).toBe(2);
    await e.dispose();
  });

  it("dispose during in-flight load tears down the backend once loaded", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const { backend, dispose } = fakeBackend();
    const e = new Embedder(async () => { await gate; return backend; });
    const inFlight = e.embedDoc("x"); // starts the load, does not resolve yet
    const disposal = e.dispose();     // races the load
    release();
    await inFlight.catch(() => {});   // embed may reject if backend disposed under it — either outcome OK
    await disposal;
    expect(dispose).toHaveBeenCalled();
    expect(e.isReady()).toBe(false);
  });
});
