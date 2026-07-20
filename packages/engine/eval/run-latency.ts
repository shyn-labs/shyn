import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Engine } from "../src/engine.js";
import { StaticKeyProvider } from "../src/keys.js";
import { Embedder, type EmbedBackend } from "../src/embedder.js";
import { EMBEDDING_DIM } from "../src/storage.js";

const TARGET_CHUNKS = 100_000, QUERIES = 50, P95_BAR_MS = 500;

// Deterministic pseudo-embedding: direction from sha256 of the text
const hashVec = (t: string): Float32Array => {
  const h = createHash("sha256").update(t).digest();
  const v = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) v[i] = (h[i % 32] - 128) / 128;
  return v;
};
const embedder = new Embedder(async () => (<EmbedBackend>{
  embed: async (t) => hashVec(t), dispose: async () => {},
}));

const engine = new Engine({
  dbPath: join(mkdtempSync(join(tmpdir(), "shyn-lat-")), "lat.db"),
  keyProvider: new StaticKeyProvider(null), embedder,
});

const topics = ["carbon", "coffee", "typescript", "fitness", "hiring",
  "travel", "finance", "parenting", "biochar", "retrieval"];
const now = Math.floor(Date.now() / 1000);
console.log(`ingesting ~${TARGET_CHUNKS} chunks...`);
let chunks = 0, docId = 0;
while (chunks < TARGET_CHUNKS) {
  const topic = topics[docId % topics.length];
  // 4 paragraphs ≈ 4 chunks per doc; spread ts over ~2 years for partition realism
  const text = Array.from({ length: 4 }, (_, p) =>
    `${topic} document ${docId} paragraph ${p} ` + `${topic} detail token `.repeat(80)
  ).join("\n\n");
  const r = engine.ingest({ source: "file", uri: `synth://${docId}`, title: `${topic} ${docId}`,
    ts: now - (docId % 730) * 86400, text });
  chunks += r.chunks; docId++;
  if (docId % 5000 === 0) console.log(`  ${chunks} chunks`);
}
console.log("draining embeddings (stub)...");
await engine.drain();

const latencies: number[] = [];
for (let i = 0; i < QUERIES; i++) {
  const q = `${topics[i % topics.length]} detail paragraph ${i}`;
  const t0 = performance.now();
  await engine.search({ query: q, limit: 8 });
  latencies.push(performance.now() - t0);
}
latencies.sort((a, b) => a - b);
const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))];
const status = engine.status();
console.log(`chunks: ${status.chunks}, vectors: ${status.vectors}`);
console.log(`search latency p50: ${p(0.5).toFixed(1)}ms  p95: ${p(0.95).toFixed(1)}ms — bar: <${P95_BAR_MS}ms`);
await engine.close();
if (p(0.95) >= P95_BAR_MS) { console.error("LATENCY BAR FAILED"); process.exit(1); }
console.log("LATENCY BAR PASSED (note: stub embedder — model inference excluded by design)");
