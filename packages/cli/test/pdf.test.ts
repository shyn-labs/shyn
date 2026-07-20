import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Engine, StaticKeyProvider, Embedder, EMBEDDING_DIM, type EmbedBackend } from "@shyn/engine";
import { startServer } from "@shyn/daemon";
import { runCli } from "../src/main.js";

let dir: string, server: { close(): Promise<void> }, out: string[];
const print = (s: string) => out.push(s);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "shyn-pdf-"));
  process.env.SHYN_HOME = dir;
  const embedder = new Embedder(async () => (<EmbedBackend>{
    embed: async () => { const v = new Float32Array(EMBEDDING_DIM); v[0] = 1; return v; },
    dispose: async () => {},
  }));
  const engine = new Engine({
    dbPath: join(dir, "shyn.db"), keyProvider: new StaticKeyProvider(null), embedder,
  });
  server = await startServer({ socketPath: join(dir, "shyn.sock"), engine, version: "t" });
  out = [];
});
afterEach(async () => { await server.close(); });

async function makePdf(path: string, text: string) {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 50, y: 700, size: 14, font });
  writeFileSync(path, await doc.save());
}

describe("pdf ingestion", () => {
  it("extracts text from a pdf and ingests it", async () => {
    const docs = join(dir, "docs"); mkdirSync(docs);
    await makePdf(join(docs, "paper.pdf"), "Soil carbon permanence in biochar systems");
    await runCli(["ingest", docs], print);
    expect(out.join("\n")).toMatch(/paper\.pdf.*ingested/);
    out = [];
    await runCli(["search", "biochar permanence"], print);
    expect(out.join("\n")).toMatch(/paper\.pdf/);
  });

  it("skips unreadable pdfs without aborting the walk", async () => {
    const docs = join(dir, "docs"); mkdirSync(docs);
    writeFileSync(join(docs, "broken.pdf"), "not a real pdf");
    writeFileSync(join(docs, "fine.md"), "markdown survives");
    await runCli(["ingest", docs], print);
    expect(out.join("\n")).toMatch(/broken\.pdf: skipped/);
    expect(out.join("\n")).toMatch(/fine\.md.*ingested/);
  });
});
