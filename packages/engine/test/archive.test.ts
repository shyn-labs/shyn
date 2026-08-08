import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.js";
import { StaticKeyProvider } from "../src/keys.js";
import { Embedder, type EmbedBackend } from "../src/embedder.js";
import { EMBEDDING_DIM } from "../src/storage.js";
import { ARCHIVE_MAGIC } from "../src/archive.js";

const newEngine = () => new Engine({
  dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"),
  keyProvider: new StaticKeyProvider(null),
  embedder: new Embedder(async () => (<EmbedBackend>{
    embed: async () => new Float32Array(EMBEDDING_DIM), dispose: async () => {},
  })),
});
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "shyn-arc-")), "memory.shynarc");

describe("encrypted archive", () => {
  it("round-trips a corpus into a fresh store", async () => {
    // The disaster this exists for: the Keychain key is gone and the only thing
    // left is the archive. The passphrase must be enough to get everything back.
    const a = newEngine();
    const long = Array.from({ length: 400 }, (_, i) => `Me: line number ${i} of the transcript`).join("\n\n");
    a.ingest({ source: "meeting", uri: "meeting://x/1", title: "Standup", ts: 1000, text: long,
               meta: { calTitle: "Standup", attendees: "Sam, Alex" } });
    a.ingest({ source: "notes", uri: "note://2", title: "Idea", ts: 2000, text: "roast the beans first" });
    await a.drain();

    // The round-trip property is "what was STORED comes back" — not the raw
    // input. Ingest legitimately adds a meta header to meeting documents, so
    // capture the stored form to compare against.
    const storedMeeting = a.document({ uri: "meeting://x/1" })!.text;
    expect(storedMeeting).toContain("Meeting: Standup");     // header is part of it
    expect(storedMeeting).toContain("Me: line number 399");

    const path = tmpFile();
    expect(await a.exportArchive("correct horse battery staple", path)).toBe(2);
    await a.close();

    const b = newEngine();                       // a DIFFERENT store, different DB key
    const r = await b.importArchive("correct horse battery staple", path);
    expect(r.imported).toBe(2);

    const restored = b.document({ uri: "meeting://x/1" })!;
    expect(restored.text).toBe(storedMeeting);   // multi-chunk text survives intact
    // And the header appears exactly once — re-ingest must not stack it.
    expect(restored.text.split("Meeting: Standup").length - 1).toBe(1);
    expect(restored.title).toBe("Standup");
    expect(restored.ts).toBe(1000);
    expect(b.document({ uri: "note://2" })!.text).toBe("roast the beans first");
    await b.close();
  });

  it("refuses a wrong passphrase rather than yielding garbage", async () => {
    const a = newEngine();
    a.ingest({ source: "notes", uri: "note://1", title: "n", ts: 1, text: "secret" });
    await a.drain();
    const path = tmpFile();
    await a.exportArchive("right", path);
    await a.close();

    const b = newEngine();
    await expect(b.importArchive("wrong", path)).rejects.toThrow(/wrong passphrase|corrupt/i);
    await b.close();
  });

  it("detects tampering — a truncated or edited archive fails loudly", async () => {
    const a = newEngine();
    for (let i = 0; i < 20; i++)
      a.ingest({ source: "notes", uri: `note://${i}`, title: `n${i}`, ts: i + 1, text: `body ${i}` });
    await a.drain();
    const path = tmpFile();
    await a.exportArchive("pw", path);
    await a.close();

    // Flip a byte in the body. GCM must notice.
    const buf = readFileSync(path);
    buf[buf.length - 5] ^= 0xff;
    writeFileSync(path, buf);

    const b = newEngine();
    await expect(b.importArchive("pw", path)).rejects.toThrow(/wrong passphrase|corrupt/i);
    await b.close();
  });

  it("rejects a file that is not an archive", async () => {
    const path = tmpFile();
    writeFileSync(path, "just some text file, definitely not an archive at all");
    const b = newEngine();
    await expect(b.importArchive("pw", path)).rejects.toThrow(/not a shyn archive/i);
    await b.close();
  });

  it("is idempotent: importing twice merges instead of duplicating", async () => {
    const a = newEngine();
    a.ingest({ source: "notes", uri: "note://1", title: "n", ts: 1, text: "once" });
    await a.drain();
    const path = tmpFile();
    await a.exportArchive("pw", path);
    await a.close();

    const b = newEngine();
    expect((await b.importArchive("pw", path)).imported).toBe(1);
    const second = await b.importArchive("pw", path);
    expect(second.imported).toBe(0);
    expect(second.deduped).toBe(1);
    expect(b.status().documents).toBe(1);
    await b.close();
  });

  it("writes a real encrypted file — magic in the clear, contents not", async () => {
    const a = newEngine();
    a.ingest({ source: "notes", uri: "note://1", title: "n", ts: 1,
               text: "the quarterly retention decision" });
    await a.drain();
    const path = tmpFile();
    await a.exportArchive("pw", path);
    await a.close();

    const raw = readFileSync(path);
    expect(raw.subarray(0, ARCHIVE_MAGIC.length).toString()).toBe(ARCHIVE_MAGIC);
    // The whole point: plaintext must not be sitting on disk.
    expect(raw.includes(Buffer.from("quarterly retention"))).toBe(false);
    expect(raw.includes(Buffer.from("note://1"))).toBe(false);
    expect(statSync(path).size).toBeGreaterThan(ARCHIVE_MAGIC.length);
  });

  it("exports an empty store without producing a broken archive", async () => {
    const a = newEngine();
    const path = tmpFile();
    expect(await a.exportArchive("pw", path)).toBe(0);
    await a.close();
    const b = newEngine();
    expect((await b.importArchive("pw", path)).imported).toBe(0);
    await b.close();
  });

  it("requires a passphrase", async () => {
    const a = newEngine();
    await expect(a.exportArchive("", tmpFile())).rejects.toThrow(/passphrase/i);
    await a.close();
  });
});

describe("restore fidelity", () => {
  it("returns documents that TODAY's hygiene rules would reject", async () => {
    // Found by exporting the real corpus: 34,593 documents went out and 31,144
    // came back, because hygiene rules written AFTER those documents were
    // captured rejected and merged them on the way in. Hygiene is a policy for
    // live capture; a restore must return what was archived.
    const a = newEngine();
    // Bypass hygiene to plant a document that today's rules would reject —
    // exactly the shape of an older corpus.
    const { ingestDocument } = await import("../src/ingest.js");
    ingestDocument((a as any).db,
      { source: "browser", uri: "https://accounts.google.com/ServiceLogin",
        title: "Sign in", ts: 1000, text: "Sign in – Google accounts" },
      { skipHygiene: true });
    await a.drain();
    expect(a.status().documents).toBe(1);

    const path = tmpFile();
    expect(await a.exportArchive("pw", path)).toBe(1);
    await a.close();

    const b = newEngine();
    expect((await b.importArchive("pw", path)).imported).toBe(1);
    expect(b.status().documents).toBe(1);        // survived the restore
    expect(b.document({ uri: "https://accounts.google.com/ServiceLogin" })).not.toBeNull();
    await b.close();
  });
});
