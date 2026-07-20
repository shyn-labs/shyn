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

export class LlamaBackend implements EmbedBackend {
  private constructor(private model: any, private ctx: any) {}
  static async create(modelPath: string): Promise<LlamaBackend> {
    const { getLlama } = await importEmbedBackendModule();
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath });
    const ctx = await model.createEmbeddingContext();
    return new LlamaBackend(model, ctx);
  }
  async embed(text: string): Promise<Float32Array> {
    return Float32Array.from((await this.ctx.getEmbeddingFor(text)).vector);
  }
  async dispose(): Promise<void> { await this.model.dispose(); }
}

export class Embedder {
  private backend: EmbedBackend | null = null;
  private loading: Promise<EmbedBackend> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

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

  private async embed(text: string): Promise<Int8Array> {
    const backend = await this.acquire();
    this.touch();
    return quantizeInt8(await backend.embed(text));
  }

  embedDoc(text: string): Promise<Int8Array> { return this.embed(text); }
  embedQuery(text: string): Promise<Int8Array> { return this.embed(QUERY_PREFIX + text); }

  async dispose(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.loading) {
      try { await this.loading; } catch { /* failed load: nothing to dispose */ }
    }
    const b = this.backend;
    this.backend = null;
    if (b) await b.dispose();
  }
}
