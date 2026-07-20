import type { IngestDoc } from "../types.js";

export type ReaderAvailability = { ok: boolean; reason?: string };

export interface Reader {
  name: string;                       // "chrome" | "safari" | "notes" | test fakes
  available(): Promise<ReaderAvailability>;
  // docs with ts >= sinceTs, ascending not required.
  // NOTE: read(sinceTs) MAY re-emit rows at/near the boundary second: source
  // timestamps carry sub-second (or otherwise finer) precision while watermarks
  // are whole seconds, so a row landing in the same second as the watermark can
  // be re-read on the next sync. This overlap is intentional (excluding it risks
  // permanently missing rows that land later within that second). Consumers
  // must dedup downstream — the daemon's syncReaders does this via content-hash
  // dedup in ingestDocument (deduped:true, no duplicate documents created).
  read(sinceTs: number): Promise<IngestDoc[]>;
}
