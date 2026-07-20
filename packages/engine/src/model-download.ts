import { createWriteStream, existsSync, mkdirSync, renameSync, createReadStream, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export const MODEL_FILE = "qwen3-embedding-0.6b-q8_0.gguf";
export const MODEL_URL =
  "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf";
// Measured from the verified Task 13 real-run download (shasum -a 256)
export const MODEL_SHA256 = "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439";

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

export async function ensureModel(
  modelsDir: string,
  onProgress?: (pct: number) => void,
): Promise<string> {
  mkdirSync(modelsDir, { recursive: true });
  const dest = join(modelsDir, MODEL_FILE);
  if (existsSync(dest)) {
    if (await sha256File(dest) === MODEL_SHA256) return dest;
    unlinkSync(dest); // tampered/corrupt cache — purge and fall through to re-download
  }
  const tmp = dest + ".part";
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`model download failed: ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let seen = 0;
  await pipeline(
    Readable.fromWeb(res.body as any).on("data", (b: Buffer) => {
      seen += b.length;
      if (total) onProgress?.(Math.round((seen / total) * 100));
    }),
    createWriteStream(tmp),
  );
  const hash = await sha256File(tmp);
  if (hash !== MODEL_SHA256) {
    unlinkSync(tmp); // don't leave a corrupt/tampered .part around to be mistaken for a resume point
    throw new Error(`model checksum mismatch: ${hash}`);
  }
  renameSync(tmp, dest);
  return dest;
}
