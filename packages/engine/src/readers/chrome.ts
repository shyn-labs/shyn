import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { IngestDoc } from "../types.js";
import type { Reader, ReaderAvailability } from "./types.js";
import { webkitToUnix } from "./epoch.js";
import { copyAndOpen, copyFailureReason } from "./sqlite-copy.js";

const FDA_HINT =
  "Chrome history could not be read — if this persists, grant the shyn daemon Full Disk Access";

function defaultHistoryPaths(): string[] {
  const root = join(homedir(), "Library", "Application Support", "Google", "Chrome");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => d === "Default" || d.startsWith("Profile "))
    .map((d) => join(root, d, "History"))
    .filter(existsSync);
}

export class ChromeHistoryReader implements Reader {
  name = "chrome";
  private paths: string[];
  constructor(opts?: { historyPaths?: string[] }) {
    this.paths = opts?.historyPaths ?? defaultHistoryPaths();
  }

  async available(): Promise<ReaderAvailability> {
    const found = this.paths.filter(existsSync);
    if (found.length === 0) return { ok: false, reason: "no Chrome history found" };
    // existsSync alone can lie: a path can exist but still fail to copy/open
    // (real TCC often lets access()/stat() succeed while open/copy fails
    // EPERM). Probe each found path so available() doesn't promise more
    // than read() can deliver.
    //
    // read() is already per-profile lenient (a bad profile is silently
    // skipped, good ones still ingest) — available() failing closed on the
    // FIRST unprobeable profile would disable ALL Chrome ingestion over one
    // bad profile (a stale lock, an in-progress migration, etc.). Aggregate
    // instead: ok if ANY profile probes fine, and name the skipped ones.
    const failedProfiles: string[] = [];
    const failedLabels: string[] = [];
    for (const p of found) {
      try { copyAndOpen(p).cleanup(); }
      catch (err) {
        failedProfiles.push(copyFailureReason(err, FDA_HINT, "Chrome history"));
        failedLabels.push(basename(dirname(p))); // p is <profileDir>/History
      }
    }
    if (failedProfiles.length === found.length)
      return { ok: false, reason: failedProfiles[0] };
    if (failedProfiles.length > 0)
      return { ok: true,
        reason: `skipped ${failedProfiles.length} unreadable profile(s): ${failedLabels.join(", ")} — ${failedProfiles[0]}` };
    return { ok: true };
  }

  async read(sinceTs: number): Promise<IngestDoc[]> {
    const out: IngestDoc[] = [];
    for (const p of this.paths.filter(existsSync)) {
      let opened: ReturnType<typeof copyAndOpen>;
      try { opened = copyAndOpen(p); }
      catch { continue; }
      const { db, cleanup } = opened;
      try {
        // >= : deliberately re-read the boundary second (watermarks are whole
        // seconds, source is µs); content-hash dedup absorbs the overlap.
        // last_visit_time µs values exceed 2^53 for modern timestamps, so any
        // float wobble from the JS-number roundtrip is already inside the
        // one-second overlap this boundary re-read absorbs.
        const rows = db.prepare(
          `SELECT url, title, last_visit_time t FROM urls
           WHERE last_visit_time >= ? AND url LIKE 'http%' ORDER BY last_visit_time`
        ).all((sinceTs + 11644473600) * 1e6) as { url: string; title: string | null; t: number }[];
        for (const r of rows) {
          const title = r.title?.trim() || r.url;
          out.push({
            source: "browser", uri: r.url, title,
            ts: webkitToUnix(r.t), text: `${title}\n${r.url}`,
          });
        }
      } finally { cleanup(); }
    }
    return out;
  }
}
