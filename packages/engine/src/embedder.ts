export const QUERY_PREFIX =
  "Instruct: Given a personal memory search query, retrieve relevant passages from the user's personal data\nQuery: ";

export interface EmbedBackend {
  embed(text: string): Promise<Float32Array>;
  dispose(): Promise<void>;
}

// The embed backend import failed at the module-loader level (e.g. node
// caching a poisoned ERR_MODULE_NOT_FOUND resolution after an EDR scan
// delayed first reads of a freshly staged tree — lived twice on 2026-07-11,
// see docs/known-issues.md). In-process retries can NEVER succeed once node
// has cached the rejection; only a process restart clears it. Tagged so the
// daemon can restart itself once, guarded against crash-looping.
export class EmbedBackendUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`embedding backend unavailable: ${(cause as Error)?.message ?? cause}`);
    this.name = "EmbedBackendUnavailableError";
    this.cause = cause;
  }
}

// Raised when the backend was torn down between acquiring it and using it —
// the narrow window that the in-flight guard cannot cover, because the local
// reference is already captured. An exception here is the whole win: the same
// situation used to reach the native layer and segfault.
export class EmbedderDisposedError extends Error {
  constructor() {
    super("embedding backend was disposed while acquiring it");
    this.name = "EmbedderDisposedError";
  }
}

export class ModelNotReadyError extends Error {
  constructor() {
    super("embedding model not ready");
    this.name = "ModelNotReadyError";
  }
}

export function quantizeInt8(v: Float32Array): Int8Array {
  return Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * 127))));
}

// Import with a poisoned-cache escape hatch. A bare `import()` whose
// resolution failed once is cached as rejected for the process lifetime
// (lived on 2026-07-11: launchd-spawned daemons deterministically poison
// on first boot while shell/kickstart contexts resolve fine). The fallback
// re-resolves through the CJS resolver (fresh path walk, realpathed) and
// imports the entry by file URL with a cache-busting query — a brand-new
// module job, no process restart required.
export async function importEmbedBackendModule(): Promise<any> {
  try {
    return await import("node-llama-cpp");
  } catch (first) {
    if ((first as { code?: string })?.code !== "ERR_MODULE_NOT_FOUND") throw first;
    const { createRequire } = await import("node:module");
    const { pathToFileURL } = await import("node:url");
    const entry = createRequire(import.meta.url).resolve("node-llama-cpp");
    return await import(`${pathToFileURL(entry).href}?heal=${Date.now()}`);
  }
}

// Without an explicit contextSize, node-llama-cpp's "auto" allocates the
// model's full trained context — 32k for Qwen3-embedding, a ~3.7 GB KV cache
// that stays resident for the daemon's lifetime because ambient capture keeps
// the idle-unload timer from ever firing (lived on 2026-07-24: 4.2 GB daemon
// footprint vs 1.25 GB at 2048). Chunked sources cap at ~400 tokens
// (chunk.ts MAX=1600 chars); browser/conversation docs arrive unchunked, and
// getEmbeddingFor THROWS on input longer than the context, so over-length
// input must be truncated to the budget below.
export const EMBED_CONTEXT_TOKENS = 2048;
// headroom for the BOS token getEmbeddingFor may prepend
export const EMBED_MAX_INPUT_TOKENS = EMBED_CONTEXT_TOKENS - 8;

export class LlamaBackend implements EmbedBackend {
  constructor(private model: any, private ctx: any) {}
  static async create(modelPath: string): Promise<LlamaBackend> {
    const { getLlama } = await importEmbedBackendModule();
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath });
    const ctx = await model.createEmbeddingContext({
      contextSize: EMBED_CONTEXT_TOKENS,
      batchSize: 512,
    });
    return new LlamaBackend(model, ctx);
  }
  async embed(text: string): Promise<Float32Array> {
    const tokens = this.model.tokenize(text).slice(0, EMBED_MAX_INPUT_TOKENS);
    return Float32Array.from((await this.ctx.getEmbeddingFor(tokens)).vector);
  }
  async dispose(): Promise<void> { await this.model.dispose(); }
}

export class Embedder {
  private backend: EmbedBackend | null = null;
  private loading: Promise<EmbedBackend> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  // Embeds currently inside the native context, and who is waiting for that to
  // reach zero. Freeing a llama context while a call is inside it is a
  // segfault, not an exception: seven SIGSEGVs between 2 and 7 September 2026,
  // every one `AddonContext::GetEmbedding` dereferencing freed memory at 0x7c.
  private inFlight = 0;
  private quietWaiters: (() => void)[] = [];

  constructor(
    private backendFactory: () => Promise<EmbedBackend>,
    private idleMs = 300_000,
  ) {}

  isReady(): boolean { return this.backend !== null; }

  private async acquire(): Promise<EmbedBackend> {
    if (this.backend) return this.backend;
    if (!this.loading) {
      this.loading = this.backendFactory().catch((err) => {
        this.loading = null; // allow retry on next call
        if ((err as { code?: string })?.code === "ERR_MODULE_NOT_FOUND")
          throw new EmbedBackendUnavailableError(err);
        throw err;
      });
    }
    this.backend = await this.loading;
    this.loading = null;
    return this.backend;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.dispose().catch(() => {}); }, this.idleMs);
    this.idleTimer.unref();
  }

  // CLEARS the idle timer rather than resetting it. Resetting — what touch()
  // did before the call, which is the bug — left a five-minute fuse burning
  // underneath every embed. A machine that sleeps mid-embed makes that fuse
  // fire on wake, straight into a live native call.
  private beginWork(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.inFlight++;
  }

  // The idle window starts at the LAST completion, so concurrent embeds cannot
  // let one finisher arm a timer over its still-running siblings.
  private endWork(): void {
    this.inFlight--;
    if (this.inFlight > 0) return;
    const waiters = this.quietWaiters;
    this.quietWaiters = [];
    for (const w of waiters) w();
    this.touch();
  }

  private whenQuiet(): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => { this.quietWaiters.push(resolve); });
  }

  private async embed(text: string): Promise<Int8Array> {
    const backend = await this.acquire();
    this.beginWork();
    try {
      // acquire() awaits, so a dispose can land between it resolving and this
      // line — and `backend` is a local, so the freed object stays reachable.
      // Fail loudly instead of walking into it.
      if (this.backend !== backend) throw new EmbedderDisposedError();
      return quantizeInt8(await backend.embed(text));
    } finally {
      this.endWork();
    }
  }

  embedDoc(text: string): Promise<Int8Array> { return this.embed(text); }
  embedQuery(text: string): Promise<Int8Array> { return this.embed(QUERY_PREFIX + text); }

  async dispose(): Promise<void> {
    if (this.loading) {
      try { await this.loading; } catch { /* failed load: nothing to dispose */ }
    }
    // The whole point: never free the context under a live call. Loop rather
    // than await once, so an embed that starts while we wait is also seen out.
    while (this.inFlight > 0) await this.whenQuiet();
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const b = this.backend;
    this.backend = null;
    if (b) await b.dispose();
  }
}
