import { getLlama } from "node-llama-cpp";

const llama = await getLlama();
console.log("GPU:", llama.gpu); // expect "metal"
const model = await llama.loadModel({ modelPath: "spikes/tmp/qwen3-embed.gguf" });
const ctx = await model.createEmbeddingContext();

const embed = async (t: string) =>
  Float32Array.from((await ctx.getEmbeddingFor(t)).vector);
const cos = (a: Float32Array, b: Float32Array) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]**2; nb += b[i]**2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

const q = await embed(
  "Instruct: Given a personal memory search query, retrieve relevant passages from the user's personal data\nQuery: article about carbon markets"
);
console.log("dim:", q.length); // expect 1024
const relevant = await embed("Deep dive: how voluntary carbon markets price soil credits");
const irrelevant = await embed("Chicken biryani recipe with fried onions");
const simR = cos(q, relevant), simI = cos(q, irrelevant);
console.log({ simR, simI });
if (!(simR > simI + 0.1)) throw new Error("FAIL: embedding does not separate topics");

const t0 = performance.now();
for (let i = 0; i < 20; i++) await embed(`throughput test document number ${i} about topic ${i}`);
console.log("docs/sec:", (20 / ((performance.now() - t0) / 1000)).toFixed(1));
console.log("SPIKE 2: PASS");
await model.dispose();
