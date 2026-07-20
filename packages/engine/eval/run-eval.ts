import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.js";
import { StaticKeyProvider } from "../src/keys.js";
import { Embedder, LlamaBackend } from "../src/embedder.js";
import { ensureModel } from "../src/model-download.js";
import { shynHome } from "../src/paths.js";
import { corpus } from "./corpus.js";

const mode = process.argv[2]; // "keyword" | "hybrid"
const BAR = mode === "hybrid" ? 0.8 : 0.6;

const embedder = mode === "hybrid"
  ? new Embedder(async () =>
      LlamaBackend.create(await ensureModel(join(shynHome(), "models"))))
  : new Embedder(async () => { throw new Error("keyword-only eval"); });

const engine = new Engine({
  dbPath: join(mkdtempSync(join(tmpdir(), "shyn-eval-")), "eval.db"),
  keyProvider: new StaticKeyProvider(null),
  embedder,
});

const { docs, queries } = corpus();
const now = Math.floor(Date.now() / 1000);
const uriToId = new Map<string, string>();
for (const d of docs) {
  const uri = `eval://${d.id}`;
  uriToId.set(uri, d.id);
  engine.ingest({ source: d.source, uri, title: d.title, ts: now, text: d.text });
}
if (mode === "hybrid") await engine.drain();

let hits5 = 0;
const misses: string[] = [];
for (const q of queries) {
  const r = await engine.search({ query: q.query, limit: 5 });
  const got = r.hits.map((h) => uriToId.get(h.uri));
  if (q.relevant.some((rel) => got.includes(rel))) hits5++;
  else misses.push(`[${q.kind}] "${q.query}" → got: ${got.join(", ") || "nothing"}`);
}
const recall5 = hits5 / queries.length;
console.log(`recall@5 (${mode}): ${recall5.toFixed(3)} — bar: ${BAR}`);
if (misses.length) console.log("misses:\n" + misses.join("\n"));
await engine.close();
if (recall5 < BAR) { console.error("EVAL BAR FAILED"); process.exit(1); }
console.log("EVAL BAR PASSED");
