import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { extractLongestString } from "../src/readers/protobuf-text.js";
import { NotesReader } from "../src/readers/notes.js";

// Build a length-delimited protobuf field: tag byte (field<<3 | 2), varint len, bytes
function pbString(field: number, s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  if (b.length > 127) throw new Error("test helper supports short strings only");
  return Buffer.concat([Buffer.from([(field << 3) | 2, b.length]), b]);
}

describe("extractLongestString", () => {
  it("finds the longest nested utf8 string", () => {
    const body = pbString(2, "This is the actual note body text, the longest run.");
    const container = Buffer.concat([
      Buffer.from([(3 << 3) | 2, body.length]), body,
      pbString(1, "short"),
    ]);
    expect(extractLongestString(container))
      .toBe("This is the actual note body text, the longest run.");
  });
  it("returns null for garbage", () => {
    expect(extractLongestString(Buffer.from([0xff, 0xff, 0xff]))).toBeNull();
  });
  it("preserves short note bodies that incidentally parse as protobuf", () => {
    expect(extractLongestString(pbString(2, "Hi"))).toBe("Hi");
    expect(extractLongestString(pbString(2, "1:4 ratio"))).toBe("1:4 ratio");
  });
  it("survives nesting at and beyond the depth cap", () => {
    let msg = pbString(2, "the deep note body text");
    for (let i = 0; i < 8; i++)
      msg = Buffer.concat([Buffer.from([(3 << 3) | 2, msg.length]), msg]);
    expect(extractLongestString(msg)).not.toBeNull();
  });
});

// Realistic fixture: source timestamps carry a sub-second remainder that a
// whole-second watermark floors away. This is the boundary-overlap condition
// (same deviation applied in Task 3's Chrome fixture and Task 4's Safari fixture).
const unixToMac = (s: number) => s - 978307200 + 0.437;

function makeNotesFixture(notes: { title: string; body: string; ts: number }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "shyn-notes-"));
  const p = join(dir, "NoteStore.sqlite");
  const db = new Database(p);
  db.exec(`CREATE TABLE ZICCLOUDSYNCINGOBJECT (
             Z_PK INTEGER PRIMARY KEY, ZTITLE1 TEXT, ZMODIFICATIONDATE1 REAL);
           CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZDATA BLOB)`);
  notes.forEach((n, i) => {
    db.prepare("INSERT INTO ZICCLOUDSYNCINGOBJECT(Z_PK, ZTITLE1, ZMODIFICATIONDATE1) VALUES (?,?,?)")
      .run(i + 1, n.title, unixToMac(n.ts));
    const proto = pbString(2, n.body);
    db.prepare("INSERT INTO ZICNOTEDATA(Z_PK, ZNOTE, ZDATA) VALUES (?,?,?)")
      .run(i + 1, i + 1, gzipSync(proto));
  });
  db.close();
  return p;
}

describe("NotesReader", () => {
  it("reads notes with body extraction and incremental watermark", async () => {
    const p = makeNotesFixture([
      { title: "Old note", body: "stale content here", ts: 1000 },
      { title: "Coffee ratios", body: "1:4 decoction to milk for filter coffee", ts: 2000 },
    ]);
    const docs = await new NotesReader({ storePath: p }).read(1500);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ source: "notes", uri: "notes://2", title: "Coffee ratios", ts: 2000 });
    expect(docs[0].text).toContain("1:4 decoction to milk");
  });

  it("degrades to unavailable on schema mismatch instead of throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shyn-notes-"));
    const p = join(dir, "NoteStore.sqlite");
    const bad = new Database(p);
    bad.exec("CREATE TABLE wrong_schema (x INTEGER)");
    bad.close();
    const reader = new NotesReader({ storePath: p });
    const a = await reader.available();
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/unsupported Notes schema/i);
    expect(await reader.read(0)).toEqual([]); // never throws
  });

  it("degrades to unavailable when the store cannot be copied", async () => {
    // A named pipe would be the textbook way to make copyFileSync fail
    // without real TCC, but empirically on this Node/macOS combo
    // copyFileSync *blocks forever* on a FIFO with no writer instead of
    // throwing — that would hang the suite. A directory reliably makes
    // copyFileSync throw synchronously (ENOTSUP) without blocking, and
    // exercises the exact same code path: accessSync gate passes (a
    // directory is readable), copyAndOpen's copyFileSync call throws.
    const dir = mkdtempSync(join(tmpdir(), "shyn-notes-uncopyable-"));
    const p = join(dir, "NoteStore.sqlite");
    mkdirSync(p);
    const reader = new NotesReader({ storePath: p });
    const a = await reader.available();
    expect(a.ok).toBe(false);
    expect(await reader.read(0)).toEqual([]); // never throws
  });
});
