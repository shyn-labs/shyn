import { existsSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { IngestDoc } from "../types.js";
import type { Reader, ReaderAvailability } from "./types.js";
import { macToUnix } from "./epoch.js";
import { copyAndOpen, copyFailureReason } from "./sqlite-copy.js";
import { extractLongestString } from "./protobuf-text.js";

const FDA_HINT =
  "Apple Notes needs Full Disk Access — grant it to the shyn daemon in " +
  "System Settings → Privacy & Security → Full Disk Access — easiest: open " +
  "the shyn apps folder (☀️ → setup → Show apps in Finder), go into " +
  "daemon/bin, and DRAG the shynd file onto the Settings list";

export class NotesReader implements Reader {
  name = "notes";
  private path: string;
  constructor(opts?: { storePath?: string }) {
    this.path = opts?.storePath ?? join(homedir(),
      "Library", "Group Containers", "group.com.apple.notes", "NoteStore.sqlite");
  }

  async available(): Promise<ReaderAvailability> {
    if (!existsSync(this.path)) return { ok: false, reason: "no Apple Notes store found" };
    try { accessSync(this.path, constants.R_OK); }
    catch { return { ok: false, reason: FDA_HINT }; }
    // accessSync can pass while the actual copy/open still fails under real
    // TCC (EPERM/EACCES surfaces later than the access() check) — the schema
    // probe below must run inside this same guarded flow.
    let opened: ReturnType<typeof copyAndOpen>;
    try { opened = copyAndOpen(this.path); }
    catch (err) { return { ok: false, reason: copyFailureReason(err, FDA_HINT, "Notes") }; }
    const { db, cleanup } = opened;
    try {
      db.prepare("SELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT LIMIT 1").get();
      db.prepare("SELECT Z_PK FROM ZICNOTEDATA LIMIT 1").get();
      return { ok: true };
    } catch {
      return { ok: false, reason: "unsupported Notes schema (macOS version not yet supported)" };
    } finally { cleanup(); }
  }

  async read(sinceTs: number): Promise<IngestDoc[]> {
    const a = await this.available();
    if (!a.ok) return [];
    let opened: ReturnType<typeof copyAndOpen>;
    try { opened = copyAndOpen(this.path); }
    catch { return []; }
    const { db, cleanup } = opened;
    try {
      // >= : deliberately re-read the boundary second (watermarks are whole
      // seconds, source is sub-second); content-hash dedup absorbs the overlap.
      const rows = db.prepare(
        `SELECT n.Z_PK id, n.ZTITLE1 title, n.ZMODIFICATIONDATE1 mod, d.ZDATA data
         FROM ZICCLOUDSYNCINGOBJECT n JOIN ZICNOTEDATA d ON d.ZNOTE = n.Z_PK
         WHERE n.ZTITLE1 IS NOT NULL AND n.ZMODIFICATIONDATE1 >= ? AND d.ZDATA IS NOT NULL`
      ).all(sinceTs - 978307200) as
        { id: number; title: string; mod: number; data: Buffer }[];
      const out: IngestDoc[] = [];
      for (const r of rows) {
        let body: string | null = null;
        try { body = extractLongestString(gunzipSync(r.data)); } catch { /* skip bad blob */ }
        if (!body) continue;
        out.push({ source: "notes", uri: `notes://${r.id}`, title: r.title,
          ts: macToUnix(r.mod), text: `${r.title}\n\n${body}` });
      }
      return out;
    } catch { return []; } finally { cleanup(); }
  }
}
