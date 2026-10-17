#!/usr/bin/env node
// Build-hygiene check: the built artifacts must not contain the builder's
// macOS username, home directory or checkout path (see
// scripts/lib/artifact-scan.mjs for where those used to come from and how
// they are derived at run time).
//
// Usage: node scripts/check-build-paths.mjs [path ...]
//   default paths: dist/capture dist/daemon dist/status (relative to the repo)
// Exit 0 when nothing matches, 1 on any hit, 2 on a usage error (missing path).
// Output never prints the identity strings themselves: matches are redacted to
// <username>, <home>, <checkout>.
//
// The release gate (scripts/check-artifact-leaks.mjs) is the full version:
// it also scans the extracted tarball and .mcpb and the private denylist.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT, builderNeedles, redact, scanDir } from "./lib/artifact-scan.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("usage: node scripts/check-build-paths.mjs [path ...]  (default: dist/capture dist/daemon dist/status)");
  process.exit(0);
}
const paths = (args.length ? args.map((a) => resolve(a)) : ["dist/capture", "dist/daemon", "dist/status"].map((p) => join(REPO_ROOT, p)));
const needles = builderNeedles();

let total = 0;
for (const p of paths) {
  const shown = redact(p, needles);
  if (!existsSync(p)) { console.error(`missing: ${shown}`); process.exit(2); }
  const stats = { files: 0, bytes: 0 };
  const hits = scanDir(p, needles, { stats });
  const byFile = new Map();
  for (const h of hits) {
    const e = byFile.get(h.file) ?? { count: 0, first: h };
    e.count++;
    byFile.set(h.file, e);
  }
  const byNeedle = Object.fromEntries(needles.map((n) => [n.label, hits.filter((h) => h.needle === n.label).length]));
  console.log(`${shown}: scanned ${stats.files} files, ${(stats.bytes / 1e6).toFixed(1)} MB, hits ${hits.length} ${JSON.stringify(byNeedle)}`);
  for (const [file, { count, first }] of byFile)
    console.log(`  ${redact(file, needles)}  x${count}  @${first.offset}  ${redact(first.context, needles)}`);
  total += hits.length;
}
console.log(total === 0 ? "OK: no builder paths found" : `FAIL: ${total} hit(s)`);
process.exit(total === 0 ? 0 : 1);
