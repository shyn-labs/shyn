import { existsSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IngestDoc } from "../types.js";
import type { Reader, ReaderAvailability } from "./types.js";
import { macToUnix } from "./epoch.js";
import { copyAndOpen, copyFailureReason } from "./sqlite-copy.js";

const FDA_HINT =
  "Safari history needs Full Disk Access — grant it to the shyn daemon in " +
  "System Settings → Privacy & Security → Full Disk Access — easiest: open " +
  "the shyn apps folder (☀️ → setup → Show apps in Finder), go into " +
  "daemon/bin, and DRAG the shynd file onto the Settings list";

export class SafariHistoryReader implements Reader {
  name = "safari";
  private path: string;
  constructor(opts?: { historyPath?: string }) {
    this.path = opts?.historyPath ?? join(homedir(), "Library", "Safari", "History.db");
  }

  async available(): Promise<ReaderAvailability> {
    if (!existsSync(this.path)) return { ok: false, reason: "no Safari history found" };
    try { accessSync(this.path, constants.R_OK); }
    catch { return { ok: false, reason: FDA_HINT }; }
    // accessSync can pass while the actual copy/open still fails under real
    // TCC (EPERM/EACCES surfaces later than the access() check) — probe it
    // here so available() doesn't lie about what read() can actually do.
    try { copyAndOpen(this.path).cleanup(); return { ok: true }; }
    catch (err) { return { ok: false, reason: copyFailureReason(err, FDA_HINT, "Safari history") }; }
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
        `SELECT i.url url, v.title title, MAX(v.visit_time) t
         FROM history_visits v JOIN history_items i ON i.id = v.history_item
         WHERE v.visit_time >= ? AND i.url LIKE 'http%'
         GROUP BY i.id ORDER BY t`
      ).all(sinceTs - 978307200) as { url: string; title: string | null; t: number }[];
      return rows.map((r) => {
        const title = r.title?.trim() || r.url;
        return { source: "browser" as const, uri: r.url, title,
          ts: macToUnix(r.t), text: `${title}\n${r.url}` };
      });
    } finally { cleanup(); }
  }
}
