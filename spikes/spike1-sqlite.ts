import Database from "better-sqlite3-multiple-ciphers";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync, rmSync } from "node:fs";

const dir = "spikes/tmp";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const path = `${dir}/spike1.db`;
const KEY = "0123456789abcdef0123456789abcdef";

// 1. Create encrypted DB, load sqlite-vec, create vec0 table
const db = new Database(path);
db.pragma(`key='${KEY}'`);
sqliteVec.load(db);
db.exec(`CREATE VIRTUAL TABLE v USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  month TEXT PARTITION KEY,
  embedding int8[4] distance_metric=cosine
)`);
// NOTE: a raw Int8Array/Buffer blob is NOT enough to select the int8 vec0
// column type — sqlite-vec's vec0 always treats an untyped blob/JSON value
// as float32 unless it is explicitly tagged via the vec_int8() SQL function.
// Also, vec0's rowid/PRIMARY KEY column requires a true SQLITE_INTEGER bind;
// better-sqlite3's default JS-number binding doesn't satisfy vec0's stricter
// virtual-table type check, so integer keys must be bound as BigInt.
const vec = (a: number[]) => JSON.stringify(a);
db.prepare("INSERT INTO v(chunk_id, month, embedding) VALUES (?,?,vec_int8(?))")
  .run(1n, "2026-07", vec([10, 20, 30, 40]));
db.prepare("INSERT INTO v(chunk_id, month, embedding) VALUES (?,?,vec_int8(?))")
  .run(2n, "2026-07", vec([-10, -20, -30, -40]));
const rows = db.prepare(
  "SELECT chunk_id, distance FROM v WHERE embedding MATCH vec_int8(?) AND k = 2"
).all(vec([11, 21, 29, 41])) as { chunk_id: number }[];
console.log("KNN result:", rows);
if (rows[0].chunk_id !== 1) throw new Error("FAIL: KNN wrong nearest neighbor");
db.close();

// 2. Reopen with wrong key must fail
let wrongKeyFailed = false;
try {
  const bad = new Database(path);
  bad.pragma(`key='wrong'`);
  bad.prepare("SELECT count(*) FROM v").get();
} catch { wrongKeyFailed = true; }
if (!wrongKeyFailed) throw new Error("FAIL: DB readable with wrong key");

// 3. Reopen with right key, vec extension again, query works
const db2 = new Database(path);
db2.pragma(`key='${KEY}'`);
sqliteVec.load(db2);
const n = db2.prepare("SELECT count(*) c FROM v").get() as { c: number };
if (n.c !== 2) throw new Error("FAIL: reopen lost rows");
console.log("SPIKE 1: PASS — encryption + vec0 (int8, cosine, partition key) coexist");
