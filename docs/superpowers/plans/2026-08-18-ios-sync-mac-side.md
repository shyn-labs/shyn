# iOS Sync — Mac Side (Plan 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The daemon exports an encrypted, delta-maintained replica of the memory index into a user-chosen iCloud Drive folder, ready for the (Plan 2) iOS app to consume — with the wire format frozen by committed golden fixtures.

**Architecture:** A `sync_log` table records every upsert/delete at ingest time; a daemon interval task turns unexported log rows into `SHYNSYNC1` files (AES-256-GCM over gzipped JSONL, raw 32-byte key — no scrypt) under `<folder>/index/`, snapshotting and compacting on threshold. Pure file I/O — the daemon's no-network invariant is untouched. Pairing = CLI-minted key in the login Keychain, printed as a terminal QR. (Popover QR ships with Plan 2, when a phone exists to scan it; the popover gets a health row only.)

**Tech Stack:** TypeScript (Node 22), better-sqlite3-multiple-ciphers, node:crypto AES-256-GCM, node:zlib, vitest, `qrcode-terminal`.

**Spec:** `docs/superpowers/specs/2026-08-18-ios-companion-design.md`

## Global Constraints

- Daemon makes **no network requests, ever** — sync writes local files only.
- Deletes are first-class: a `shyn forget` MUST reach every delta consumer.
- Wire magic `SHYNSYNC1`; envelope layout `magic | key_id(8) | iv(12) | tag(16) | gzip(JSONL)`.
- Key: random 32 bytes, login Keychain service `shyn-ios-sync`, account `sync-key`. Never passphrase-derived, never in files.
- Public repo: fixtures/comments use placeholder names only (leak guard enforces).
- All version-lockstep rules of RELEASING.md apply when this ships.

## File Structure

- `packages/engine/src/sync-log.ts` — new: log write helpers + sweep (one responsibility: the change journal).
- `packages/engine/src/storage.ts` — modify: schema v6 migration adding `sync_log`.
- `packages/engine/src/ingest.ts`, `packages/engine/src/forget.ts` — modify: journal writes.
- `packages/engine/src/sync-format.ts` — new: envelope seal/open + line types.
- `packages/engine/src/sync-export.ts` — new: snapshot/delta line generators.
- `packages/engine/src/keys.ts` — modify: sync-key accessor beside the DB-key provider.
- `packages/daemon/src/ios-sync.ts` — new: the interval task (folder layout, thresholds, compaction, pairing.json, seq bookkeeping).
- `packages/daemon/src/server.ts`, `packages/daemon/src/main.ts` — modify: schedule + config plumb.
- `packages/cli/src/main.ts` + `packages/cli/src/ios.ts` — new subcommand `shyn ios`.
- `packages/status-ui/src/derive.ts` (+ renderer) — modify: sync health row.
- `scripts/gen-sync-fixtures.mjs`, `fixtures/sync/*` — golden files.
- `docs/sync-format.md` — the format contract Plan 2 implements against.

---

### Task 1: `sync_log` journal (schema v6 + writes)

**Files:**
- Modify: `packages/engine/src/storage.ts` (SCHEMA string + migrate())
- Create: `packages/engine/src/sync-log.ts`
- Modify: `packages/engine/src/ingest.ts`, `packages/engine/src/forget.ts`
- Test: `packages/engine/test/sync-log.test.ts`

**Interfaces:**
- Produces: table `sync_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL CHECK(op IN ('upsert','delete')), source TEXT NOT NULL, uri TEXT NOT NULL)`; functions `logUpsert(db, source, uri)`, `logDeletes(db, rows: {source,uri}[])`, `sweepSyncLog(db, throughSeq: number)`, `maxSyncSeq(db): number`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/sync-log.test.ts
import { describe, expect, test } from "vitest";
import { openDatabase } from "../src/storage.js";
import { ingestDocument } from "../src/ingest.js";
import { forget } from "../src/forget.js";
import { maxSyncSeq, sweepSyncLog } from "../src/sync-log.js";
import { StaticKeyProvider } from "../src/keys.js";

const db = () => openDatabase(":memory:", new StaticKeyProvider(Buffer.alloc(32)));

describe("sync_log journal", () => {
  test("ingest journals an upsert; dedup does not double-journal", () => {
    const d = db();
    const doc = { source: "browser" as const, uri: "https://example.com/a", title: "A", ts: 1000, text: "alpha beta gamma" };
    ingestDocument(d, doc);
    ingestDocument(d, doc); // content-hash dedup
    const rows = d.prepare("SELECT op, source, uri FROM sync_log ORDER BY seq").all();
    expect(rows).toEqual([{ op: "upsert", source: "browser", uri: "https://example.com/a" }]);
  });

  test("forget journals a delete per removed document", () => {
    const d = db();
    ingestDocument(d, { source: "browser", uri: "https://example.com/a", title: "A", ts: 1000, text: "alpha" });
    forget(d, { uri: "https://example.com/a" });
    const ops = d.prepare("SELECT op FROM sync_log ORDER BY seq").all().map((r: any) => r.op);
    expect(ops).toEqual(["upsert", "delete"]);
  });

  test("sweep removes rows through seq; maxSyncSeq reports the tail", () => {
    const d = db();
    ingestDocument(d, { source: "browser", uri: "https://example.com/a", title: "A", ts: 1, text: "x" });
    ingestDocument(d, { source: "browser", uri: "https://example.com/b", title: "B", ts: 2, text: "y" });
    expect(maxSyncSeq(d)).toBe(2);
    sweepSyncLog(d, 1);
    expect(d.prepare("SELECT COUNT(*) c FROM sync_log").get()).toEqual({ c: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/engine && pnpm vitest run test/sync-log.test.ts`
Expected: FAIL — `sync-log.js` module not found / `sync_log` table missing.

- [ ] **Step 3: Implement**

`storage.ts`: append to the schema string (and bump `schema_version` default to `'6'`):

```sql
CREATE TABLE IF NOT EXISTS sync_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL CHECK(op IN ('upsert','delete')),
  source TEXT NOT NULL,
  uri TEXT NOT NULL
);
```

Add a `migrate()` v5→v6 step following the existing pattern: `CREATE TABLE IF NOT EXISTS sync_log …` then `UPDATE meta SET value='6' WHERE k='schema_version'`.

```ts
// packages/engine/src/sync-log.ts
import type Database from "better-sqlite3-multiple-ciphers";

/** Change journal consumed by the iOS sync exporter. Always on: rows are a few
 *  dozen bytes and swept once exported (or wholesale when sync is disabled). */
export function logUpsert(db: Database.Database, source: string, uri: string): void {
  db.prepare("INSERT INTO sync_log(op, source, uri) VALUES ('upsert', ?, ?)").run(source, uri);
}
export function logDeletes(db: Database.Database, rows: { source: string; uri: string }[]): void {
  const ins = db.prepare("INSERT INTO sync_log(op, source, uri) VALUES ('delete', ?, ?)");
  for (const r of rows) ins.run(r.source, r.uri);
}
export function sweepSyncLog(db: Database.Database, throughSeq: number): void {
  db.prepare("DELETE FROM sync_log WHERE seq <= ?").run(throughSeq);
}
export function maxSyncSeq(db: Database.Database): number {
  return (db.prepare("SELECT COALESCE(MAX(seq),0) m FROM sync_log").get() as { m: number }).m;
}
```

`ingest.ts`: at the point where a document is actually written (NOT on the dedup/rejected early-returns), add `logUpsert(db, doc.source, canonical.uri)` using the same source/uri that lands in `documents`.

`forget.ts`: before the `DELETE FROM documents`, capture the victims and journal them:

```ts
const victims = db.prepare(`SELECT source, uri FROM documents WHERE ${where}`).all(...params) as { source: string; uri: string }[];
// … existing deletes …
logDeletes(db, victims);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/engine && pnpm vitest run test/sync-log.test.ts`
Expected: PASS. Also run the whole engine suite (`pnpm vitest run`) — the migration must not break existing tests.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/storage.ts packages/engine/src/sync-log.ts packages/engine/src/ingest.ts packages/engine/src/forget.ts packages/engine/test/sync-log.test.ts
git commit -m "feat(sync): sync_log change journal — schema v6, journaled ingest/forget"
```

---

### Task 2: `SHYNSYNC1` envelope (seal/open)

**Files:**
- Create: `packages/engine/src/sync-format.ts`
- Test: `packages/engine/test/sync-format.test.ts`

**Interfaces:**
- Produces:
  - `export const SYNC_MAGIC = "SHYNSYNC1"`
  - `export type SyncLine = { t: "hdr"; schema: 1; snapshot: boolean; fromSeq: number; toSeq: number } | { t: "doc"; source: string; uri: string; title: string; ts: number; meta?: Record<string, unknown>; chunks: { pos: number; text: string; vec?: string }[] } | { t: "del"; source: string; uri: string }`
  - `export function keyId(key: Buffer): Buffer` — first 8 bytes of SHA-256(key)
  - `export async function sealSync(key: Buffer, lines: Iterable<SyncLine> | AsyncIterable<SyncLine>, path: string): Promise<number>` — returns line count
  - `export async function* openSync(key: Buffer, path: string): AsyncGenerator<SyncLine>` — throws on bad magic, wrong key-id, failed GCM auth

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/sync-format.test.ts
import { describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { sealSync, openSync, keyId, SYNC_MAGIC, type SyncLine } from "../src/sync-format.js";

const dir = mkdtempSync(join(tmpdir(), "shynsync-"));
const key = randomBytes(32);
const lines: SyncLine[] = [
  { t: "hdr", schema: 1, snapshot: true, fromSeq: 0, toSeq: 2 },
  { t: "doc", source: "browser", uri: "https://example.com/a", title: "A", ts: 1000,
    chunks: [{ pos: 0, text: "alpha", vec: Buffer.alloc(8, 1).toString("base64") }] },
  { t: "del", source: "browser", uri: "https://example.com/b" },
];

describe("SHYNSYNC1 envelope", () => {
  test("round-trips lines", async () => {
    const p = join(dir, "a.shynsync");
    expect(await sealSync(key, lines, p)).toBe(3);
    const out: SyncLine[] = [];
    for await (const l of openSync(key, p)) out.push(l);
    expect(out).toEqual(lines);
    expect(readFileSync(p).subarray(0, SYNC_MAGIC.length).toString()).toBe(SYNC_MAGIC);
  });

  test("wrong key fails loudly before decrypting (key-id mismatch)", async () => {
    const p = join(dir, "b.shynsync");
    await sealSync(key, lines, p);
    await expect(async () => { for await (const _ of openSync(randomBytes(32), p)) {/**/} })
      .rejects.toThrow(/different sync key/);
  });

  test("a flipped body byte fails GCM auth, yields nothing silently-wrong", async () => {
    const p = join(dir, "c.shynsync");
    await sealSync(key, lines, p);
    const buf = readFileSync(p); buf[buf.length - 3] ^= 0xff; writeFileSync(p, buf);
    await expect(async () => { for await (const _ of openSync(key, p)) {/**/} })
      .rejects.toThrow(/corrupt|auth/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/engine && pnpm vitest run test/sync-format.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Mirror `archive.ts`'s streaming construction exactly (write header with zeroed tag, stream `gzip(cipher(JSONL))`, seek back to fill the tag), with two differences: raw key (no scrypt/salt) and an 8-byte key-id after the magic so a wrong key is a clear error, not a GCM failure:

```ts
// packages/engine/src/sync-format.ts (shape — follow archive.ts stream mechanics)
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
export const SYNC_MAGIC = "SHYNSYNC1";
const KEYID_LEN = 8, IV_LEN = 12, TAG_LEN = 16;
export function keyId(key: Buffer): Buffer { return createHash("sha256").update(key).digest().subarray(0, KEYID_LEN); }
// sealSync: magic | keyId | iv | tag-placeholder | gzip(cipher(lines.map(JSON.stringify).join("\n")))
// openSync: verify magic (timingSafeEqual), verify keyId → throw new Error("sealed with a different sync key"),
//           then decipher+gunzip streamed line parse; map stream errors to "sync file is corrupt (failed authentication)".
```

Export the new symbols from `packages/engine/src/index.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/engine && pnpm vitest run test/sync-format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sync-format.ts packages/engine/src/index.ts packages/engine/test/sync-format.test.ts
git commit -m "feat(sync): SHYNSYNC1 envelope — raw-key AES-256-GCM over gzipped JSONL"
```

---

### Task 3: snapshot & delta generators

**Files:**
- Create: `packages/engine/src/sync-export.ts`
- Test: `packages/engine/test/sync-export.test.ts`

**Interfaces:**
- Consumes: `sync_log` (Task 1), `SyncLine` (Task 2), tables `documents/chunks/chunk_vectors`.
- Produces:
  - `export function* snapshotLines(db): Generator<SyncLine>` — hdr(snapshot:true, fromSeq:0, toSeq:maxSyncSeq) then every document with chunks + base64 int8 vectors (vec omitted when a chunk has no vector yet).
  - `export function* deltaLines(db, fromSeq: number): Generator<SyncLine>` — hdr(snapshot:false) then, per distinct (source,uri) in `sync_log WHERE seq > fromSeq` in seq order: a `del` line if the doc no longer exists, else a full `doc` line (upsert-by-replacement — the consumer never patches).
  - `export function unembeddedBacklog(db, fromSeq: number): number` — count of pending `embed_queue` rows belonging to docs referenced by log rows `> fromSeq`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/sync-export.test.ts
import { describe, expect, test } from "vitest";
import { openDatabase } from "../src/storage.js";
import { ingestDocument } from "../src/ingest.js";
import { forget } from "../src/forget.js";
import { StaticKeyProvider } from "../src/keys.js";
import { snapshotLines, deltaLines, unembeddedBacklog } from "../src/sync-export.js";

const db = () => openDatabase(":memory:", new StaticKeyProvider(Buffer.alloc(32)));

describe("sync export generators", () => {
  test("snapshot carries every doc with its chunks", () => {
    const d = db();
    ingestDocument(d, { source: "browser", uri: "https://example.com/a", title: "A", ts: 1, text: "alpha beta" });
    const lines = [...snapshotLines(d)];
    expect(lines[0]).toMatchObject({ t: "hdr", snapshot: true });
    const doc = lines.find((l) => l.t === "doc") as any;
    expect(doc.uri).toBe("https://example.com/a");
    expect(doc.chunks[0].text).toContain("alpha");
  });

  test("delta after forget emits del; after re-ingest emits full doc", () => {
    const d = db();
    ingestDocument(d, { source: "browser", uri: "https://example.com/a", title: "A", ts: 1, text: "alpha" });
    const afterFirst = 1; // seq of the first upsert
    forget(d, { uri: "https://example.com/a" });
    ingestDocument(d, { source: "browser", uri: "https://example.com/b", title: "B", ts: 2, text: "beta" });
    const lines = [...deltaLines(d, afterFirst)];
    const kinds = lines.map((l) => l.t);
    expect(kinds[0]).toBe("hdr");
    expect(kinds).toContain("del");
    expect(lines.find((l) => l.t === "doc") as any).toMatchObject({ uri: "https://example.com/b" });
  });

  test("unembeddedBacklog counts pending vectors for journaled docs", () => {
    const d = db();
    ingestDocument(d, { source: "browser", uri: "https://example.com/a", title: "A", ts: 1, text: "alpha" });
    expect(unembeddedBacklog(d, 0)).toBeGreaterThan(0); // nothing drained in tests
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/engine && pnpm vitest run test/sync-export.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/engine/src/sync-export.ts (core queries)
const DOCS = "SELECT id, source, uri, title, ts, meta_json FROM documents ORDER BY id";
const CHUNKS = `SELECT c.pos, c.text, v.embedding AS vec
                FROM chunks c LEFT JOIN chunk_vectors v ON v.chunk_id = c.id
                WHERE c.doc_id = ? ORDER BY c.pos`;
// doc line: vec present → Buffer(v.embedding).toString("base64"); NULL → omit key.
// deltaLines: SELECT DISTINCT source, uri, MAX(seq) s FROM sync_log WHERE seq > ? GROUP BY source, uri ORDER BY s;
//   for each, look up documents by (source, uri): missing → del line; present → doc line as in snapshot.
// unembeddedBacklog: SELECT COUNT(*) FROM embed_queue q JOIN chunks c ON c.id=q.chunk_id
//   JOIN documents d ON d.id=c.doc_id WHERE q.state='pending' AND EXISTS
//   (SELECT 1 FROM sync_log l WHERE l.seq > ? AND l.source=d.source AND l.uri=d.uri);
```

Export from `index.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/engine && pnpm vitest run test/sync-export.test.ts` — PASS, then full engine suite.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sync-export.ts packages/engine/src/index.ts packages/engine/test/sync-export.test.ts
git commit -m "feat(sync): snapshot and delta line generators over sync_log"
```

---

### Task 4: sync key in the login Keychain

**Files:**
- Modify: `packages/engine/src/keys.ts`
- Test: `packages/engine/test/keys-sync.test.ts`

**Interfaces:**
- Produces: `export function getOrCreateSyncKey(exec = execFileSync): Buffer` and `export function readSyncKey(exec = execFileSync): Buffer | null` — `security find-generic-password -s shyn-ios-sync -a sync-key -w` / `add-generic-password`, hex-encoded, exactly mirroring how `KeychainKeyProvider` shells out for the DB key (same injection seam for tests — study that class first and copy its conventions).

- [ ] **Step 1: Write the failing test** — inject a fake `exec` recording invocations: `readSyncKey` returns null when `security` exits non-zero; `getOrCreateSyncKey` creates (32 random bytes, hex) then returns the same key on second call via the fake's stored value.

```ts
// packages/engine/test/keys-sync.test.ts
import { describe, expect, test } from "vitest";
import { getOrCreateSyncKey, readSyncKey } from "../src/keys.js";

describe("sync key", () => {
  test("creates once, then reads back the same key", () => {
    let stored: string | null = null;
    const fake = ((cmd: string, args: string[]) => {
      if (args.includes("find-generic-password")) {
        if (stored === null) { const e: any = new Error("not found"); e.status = 44; throw e; }
        return stored + "\n";
      }
      if (args.includes("add-generic-password")) { stored = args[args.indexOf("-w") + 1]; return ""; }
      throw new Error("unexpected: " + args.join(" "));
    }) as any;
    expect(readSyncKey(fake)).toBeNull();
    const k1 = getOrCreateSyncKey(fake);
    const k2 = getOrCreateSyncKey(fake);
    expect(k1.length).toBe(32);
    expect(k1.equals(k2)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** (`pnpm vitest run test/keys-sync.test.ts`).
- [ ] **Step 3: Implement** in `keys.ts` beside `KeychainKeyProvider`, same `security` argument style, service `shyn-ios-sync`, account `sync-key`.
- [ ] **Step 4: Run to verify PASS**, then full engine suite.
- [ ] **Step 5: Commit** — `git commit -m "feat(sync): pairing key minted and held in the login Keychain"`

---

### Task 5: daemon exporter task

**Files:**
- Create: `packages/daemon/src/ios-sync.ts`
- Test: `packages/daemon/test/ios-sync.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 exports.
- Produces: `export async function runIosSync(opts: { db: Database; folder: string; key: Buffer; now?: number; snapshotThresholdBytes?: number; embedHoldSeconds?: number }): Promise<{ wrote: "nothing" | "snapshot" | "delta"; toSeq: number }>` — the single entry the scheduler calls.

Behavior (encode each as a test):
1. First run (no `index/` or no snapshot file): write `index/snapshot-<toSeq>.shynsync` from `snapshotLines`, write `pairing.json` (`{ schema: 1, epochSeq: toSeq, keyId: <hex> }`), set meta `ios_sync_seq = toSeq`, sweep the log through `toSeq`.
2. Later run with new log rows and `unembeddedBacklog(db, fromSeq) === 0`: write `index/delta-<fromSeq>-<toSeq>.shynsync`, advance meta, sweep.
3. New rows but backlog > 0 and newest journaled doc younger than `embedHoldSeconds` (default 86400): return `{ wrote: "nothing" }` — vectors are coming; don't ship a vectorless doc we'd immediately re-ship.
4. Accumulated delta bytes on disk > `snapshotThresholdBytes` (default 32 MiB): write a fresh snapshot, delete ALL older snapshot/delta files, update `pairing.json.epochSeq`.
5. No new rows: `{ wrote: "nothing" }`.
6. `forget`-only change: the delta still ships immediately (deletes never wait on embeddings).

- [ ] **Step 1: Write the failing tests** — one `test()` per behavior above, against `openDatabase(":memory:")` + `mkdtempSync` folder + fixed key; drive time via `now`. For behavior 2, drain embeddings is not available in tests — instead set the pending rows' state directly: `db.prepare("UPDATE embed_queue SET state='done'").run()` (matches how engine tests silence the queue; verify against an existing engine test before assuming the state value — if engine tests use `DELETE FROM embed_queue`, use that).
- [ ] **Step 2: Run to verify FAIL** (`cd packages/daemon && pnpm vitest run test/ios-sync.test.ts`).
- [ ] **Step 3: Implement** `ios-sync.ts` — folder layout `index/` + `outbox/` (create `outbox/` now, empty; Plan 2's watcher consumes it), atomic writes (write `.tmp`, rename), meta read/write via the existing `meta` table (`k='ios_sync_seq'`).
- [ ] **Step 4: Run to verify PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(sync): daemon iOS-sync exporter — snapshot, deltas, compaction, embed hold"`

---

### Task 6: wire into daemon config + schedule

**Files:**
- Modify: `packages/daemon/src/main.ts` (read `capture.json` → `iosSync.folder`), `packages/daemon/src/server.ts` (new `setInterval` beside the retention timer, 5 min, guarded on config presence; `try { await runIosSync(...) } catch { /* next tick retries */ }` with an operator-visible `console.error` on repeated failure), `status:` handler exposes `iosSync: { lastExportTs, epochSeq } | null`.
- Test: `packages/daemon/test/ios-sync-wiring.test.ts` — boot the server test harness (follow `server.test.ts` patterns) with a temp `capture.json` containing `"iosSync": {"folder": "<tmp>"}`; assert the folder gains a snapshot within one manually-invoked tick and `status` RPC reports `iosSync.epochSeq`.

- [ ] **Step 1: failing test** → **Step 2: FAIL** → **Step 3: implement** → **Step 4: PASS + full daemon suite** → **Step 5: Commit** `feat(sync): schedule iOS-sync exporter from capture.json`.

---

### Task 7: `shyn ios` CLI (enable / disable / status) with pairing QR

**Files:**
- Create: `packages/cli/src/ios.ts`
- Modify: `packages/cli/src/main.ts` (subcommand dispatch), `packages/cli/package.json` (+`qrcode-terminal`)
- Test: `packages/cli/test/ios.test.ts`

**Interfaces:**
- Produces:
  - `shyn ios enable <folder>` — validates the folder exists (creates if under the user's home), mints/reads the sync key (Task 4), merges `"iosSync": {"folder": <abs>}` into `capture.json` preserving unrelated keys, prints a QR of `shyn-pair:v1:<base64url(key)>` plus the same string as text fallback.
  - `shyn ios disable` — removes the `iosSync` key from `capture.json` (files and Keychain key left in place; say so in output).
  - `shyn ios status` — prints folder, snapshot epoch, delta count, last export age, from `pairing.json` + directory listing (works without the daemon).
- Tests: config merge round-trip (temp HOME), disable leaves other capture.json keys untouched, pairing string round-trips base64url → 32 bytes. QR rendering itself is not asserted (it's `qrcode-terminal`'s job); assert the pairing string is printed.

- [ ] **Step 1: failing tests** → **Step 2: FAIL** → **Step 3: implement** → **Step 4: PASS** → **Step 5: Commit** `feat(cli): shyn ios — enable/disable/status with terminal pairing QR`.

---

### Task 8: golden fixtures for Plan 2

**Files:**
- Create: `scripts/gen-sync-fixtures.mjs`, `fixtures/sync/README.md`, `fixtures/sync/snapshot.shynsync`, `fixtures/sync/delta-upsert-delete.shynsync`, `fixtures/sync/tampered.shynsync`
- Test: `packages/engine/test/sync-fixtures.test.ts`

Fixture key is FIXED and public by design (fixtures only): `000102…1f` (bytes 0–31). Content: two placeholder docs (`https://example.com/one`, source `browser`; a `meeting` doc titled "Acme weekly sync") with deterministic fake int8 vectors (`Buffer.alloc(1024, i)`), one delta containing an upsert of a third doc + a `del` of the first, and `tampered.shynsync` = the snapshot with one body byte flipped. The generator must be deterministic (fixed iv `Buffer.alloc(12, 7)` — fine for fixtures, never for production paths; assert production `sealSync` still uses `randomBytes` by keeping the fixed-iv variant private to the script via an exported-for-fixtures seam `sealSyncWithIv`).

- [ ] **Step 1: failing test** — `sync-fixtures.test.ts` opens each fixture with the fixed key: snapshot yields hdr + 2 docs with 1024-byte vectors; delta yields hdr + doc + del; tampered rejects. Runs against the COMMITTED bytes (no regeneration in tests — the whole point is that the bytes are frozen).
- [ ] **Step 2: FAIL** (fixtures don't exist) → **Step 3:** write generator, run `node scripts/gen-sync-fixtures.mjs`, commit the binaries → **Step 4: PASS** → **Step 5: Commit** `test(sync): frozen SHYNSYNC1 golden fixtures — the wire contract for the iOS app`.

---

### Task 9: popover health row + format doc

**Files:**
- Modify: `packages/status-ui/src/derive.ts` (+ its test `packages/status-ui/test/derive.test.ts`, following existing row patterns): when daemon `status.iosSync` is non-null, render row "iPhone sync" with value "synced <relative age>" (from `lastExportTs`), or "waiting for first export". No QR here (Plan 2).
- Create: `docs/sync-format.md` — the contract: envelope byte layout, key-id derivation, line types with field tables, folder layout, epoch/compaction semantics, pairing string format, fixture key. Written from the code built above; every claim checkable against `sync-format.ts` and `fixtures/sync/`.

- [ ] **Step 1: failing derive test** → **Step 2: FAIL** → **Step 3: implement row + write doc** → **Step 4: PASS + full monorepo `pnpm -r test`** → **Step 5: Commit** `feat(status): iPhone sync health row; docs: SHYNSYNC1 format contract`.

---

## Verification (whole plan)

- [ ] `pnpm typecheck && pnpm -r test` green.
- [ ] Live smoke on the maintainer's Mac: `shyn ios enable ~/Library/Mobile\ Documents/com~apple~CloudDocs/shyn` → within one exporter tick `index/snapshot-*.shynsync` exists; `shyn forget --uri <some test doc>` → next tick writes a delta containing the `del`; iCloud Drive shows the files syncing (cloud icons in Finder).
- [ ] `shyn export` (the passphrase archive) still round-trips — the sibling format must be untouched.

## Self-review notes

- Spec coverage: §1 (format/keys → Tasks 2, 4, 8), §2 (Mac side → Tasks 1, 3, 5, 6, 9; outbox *watcher* deliberately absent per spec §7 v1 scope — the folder is created empty), §6 (golden fixtures → Task 8), §7 (release train — normal RELEASING.md flow applies). §3–5 are Plan 2 (iOS).
- Type consistency: `SyncLine` defined once in Task 2, consumed by Tasks 3, 5, 8. `runIosSync` signature in Task 5 matches Task 6's scheduler call. Keychain seam matches `KeychainKeyProvider`'s existing exec-injection pattern (Task 4 instructs implementer to verify before copying).
