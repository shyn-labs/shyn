import { describe, it, expect, vi } from "vitest";
import {
  Embedder, LlamaBackend, quantizeInt8, QUERY_PREFIX,
  EMBED_MAX_INPUT_TOKENS, type EmbedBackend,
} from "../src/embedder.js";

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

describe("LlamaBackend input truncation", () => {
  // one fake token per character, so token counts are easy to reason about
  const fakeLlama = () => {
    const received: number[][] = [];
    const model = {
      tokenize: (t: string) => Array.from({ length: t.length }, (_, i) => i),
      dispose: vi.fn(async () => {}),
    };
    const ctx = {
      getEmbeddingFor: async (tokens: number[]) => {
        received.push(tokens);
        return { vector: [0.5] };
      },
    };
    return { model, ctx, received };
  };

  it("truncates input longer than the context budget instead of throwing", async () => {
    const { model, ctx, received } = fakeLlama();
    const b = new LlamaBackend(model, ctx);
    await b.embed("x".repeat(EMBED_MAX_INPUT_TOKENS + 5000));
    expect(received[0].length).toBe(EMBED_MAX_INPUT_TOKENS);
  });

  it("passes short input through untouched", async () => {
    const { model, ctx, received } = fakeLlama();
    const b = new LlamaBackend(model, ctx);
    await b.embed("short chunk");
    expect(received[0].length).toBe("short chunk".length);
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

// The segfault. Seven SIGSEGVs between 2 and 7 September, every one identical:
//
//   EXC_BAD_ACCESS  KERN_INVALID_ADDRESS at 0x7c
//   libllama.metal.dylib   llama_pooling_type
//   llama-addon.node       AddonContext::GetEmbedding(...)
//
// A freed llama context, dereferenced by a call already inside it. `embed`
// armed the idle timer and then ran the native call underneath it, and
// `dispose` knew nothing about work in flight — it nulled `this.backend` and
// freed the context while `embed` still held the backend in a local const, so
// the freed object stayed reachable. Crash times (03:05, 19:56, 23:50) point at
// a laptop sleeping mid-embed: a wall-clock timer fires on wake, straight into
// a live call.
//
// Same race produced the recurring "DisposedError: Object is disposed" in
// daemon.log — when the JS wrapper noticed first you got the clean error, when
// the native call was already past that check you got the segfault.
describe("dispose must never free the backend under a live embed", () => {
  // A backend whose embed hangs until released, so a dispose can be raced
  // against a call that is genuinely mid-flight.
  const gatedBackend = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Resolves the moment embed() is actually inside the backend. Racing a
    // dispose against a fixed number of microtask ticks is guesswork — the
    // embed has to get through `await acquire()` first, and how many ticks that
    // takes is an implementation detail of the code under test.
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    let disposedWhileEmbedding = false;
    let embedding = false;
    const backend: EmbedBackend = {
      embed: async () => {
        embedding = true;
        entered();
        await gate;
        embedding = false;
        return Float32Array.from([0.5, -1.2, 0.009, 1.0]);
      },
      dispose: vi.fn(async () => { if (embedding) disposedWhileEmbedding = true; }),
    };
    return { backend, inside, release: () => release(),
             wasDisposedMidEmbed: () => disposedWhileEmbedding };
  };

  it("an armed idle timer cannot fire during a call", async () => {
    vi.useFakeTimers();
    const g = gatedBackend();
    const e = new Embedder(async () => g.backend, 1000);
    const inFlight = e.embedDoc("x");
    await g.inside;                            // embed is genuinely mid-call
    await vi.advanceTimersByTimeAsync(5000);   // long past the idle window
    // THE REGRESSION: the timer used to fire here and free the context while
    // the native call was still inside it.
    expect(g.wasDisposedMidEmbed()).toBe(false);
    expect(e.isReady()).toBe(true);
    g.release();
    await inFlight;
    vi.useRealTimers();
    await e.dispose();
  });

  it("an explicit dispose waits for the in-flight embed to finish", async () => {
    const g = gatedBackend();
    const e = new Embedder(async () => g.backend, 60_000);
    const inFlight = e.embedDoc("x");
    await g.inside;                             // embed is genuinely mid-call
    let disposed = false;
    const disposal = e.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);               // must not have completed yet
    g.release();
    await inFlight;
    await disposal;
    expect(g.wasDisposedMidEmbed()).toBe(false);
    expect(e.isReady()).toBe(false);
  });

  it("the idle timer re-arms only once the last concurrent embed is done", async () => {
    vi.useFakeTimers();
    const g = gatedBackend();
    const e = new Embedder(async () => g.backend, 1000);
    const a = e.embedDoc("a"), b = e.embedQuery("b");
    await g.inside;
    await vi.advanceTimersByTimeAsync(3000);
    expect(g.wasDisposedMidEmbed()).toBe(false);
    g.release();
    await Promise.all([a, b]);
    // Now idle: the window starts from the LAST completion, not the first.
    await vi.advanceTimersByTimeAsync(1500);
    expect(e.isReady()).toBe(false);
    vi.useRealTimers();
  });
});
