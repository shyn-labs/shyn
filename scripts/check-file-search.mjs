#!/usr/bin/env node
// Manual release gate for the search_files MCP tool. The OWNER runs this with
// thatone running; CI never does. It spawns the bundled MCP server over stdio
// (throwaway SHYN_HOME, so it never touches real shyn data), waits for
// search_files to appear, then runs each query you pass and prints the replies.
//
// Usage:  node scripts/check-file-search.mjs [--limit N] [--socket <path>] [--no-build] "<query>" ["<query>" ...]
//   --limit N       hits per query (default 5)
//   --socket PATH   sets SHYN_FILE_SEARCH_SOCKET for the server (default: thatone's real socket)
//   --no-build      reuse extension/server/index.mjs instead of rebuilding it
//   --help          this text
//
// The output contains paths and snippets of private files: run it only on your
// own machine and do not paste the output anywhere public.
// Exit codes: 0 = no FAIL lines, 1 = at least one FAIL, 2 = usage error.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = 'Usage: node scripts/check-file-search.mjs [--limit N] [--socket <path>] [--no-build] "<query>" ["<query>" ...]';

const usageError = (msg) => { console.error(`error: ${msg}\n${USAGE}`); process.exit(2); };

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); process.exit(0); }
let limit = 5, socket, build = true;
const queries = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--limit") {
    limit = Number(argv[++i]);
    if (!Number.isInteger(limit) || limit < 1) usageError("--limit needs a positive integer");
  } else if (a === "--socket") {
    socket = argv[++i];
    if (!socket) usageError("--socket needs a path");
  } else if (a === "--no-build") build = false;
  else if (a.startsWith("--")) usageError(`unknown flag ${a}`);
  else queries.push(a);
}
if (queries.length === 0) usageError("at least one query is required");

console.log("This prints paths and snippets of files on this Mac. Run it only on your own machine and do not paste the output anywhere public.\n");

let failed = 0;
const pass = (name, note = "") => console.log(`PASS ${name}${note ? ` (${note})` : ""}`);
const fail = (name, reason) => { failed++; console.log(`FAIL ${name}: ${reason}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

const entry = join(root, "extension/server/index.mjs");
const sdk = join(root, "packages/mcp-client/node_modules/@modelcontextprotocol/sdk/dist/esm/client");

let home, client;
try {
  if (build) {
    console.log("building extension/server/index.mjs ...");
    execFileSync("node", ["scripts/build-mcpb.mjs"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  }
  if (!existsSync(entry)) throw new Error(`missing ${entry} (run without --no-build)`);
  const { Client } = await import(pathToFileURL(join(sdk, "index.js")).href);
  const { StdioClientTransport } = await import(pathToFileURL(join(sdk, "stdio.js")).href);

  home = mkdtempSync(join(tmpdir(), "shyn-check-fs-"));
  console.log(`temp SHYN_HOME ${home}`);
  const env = { ...process.env, SHYN_HOME: home };
  if (socket) env.SHYN_FILE_SEARCH_SOCKET = socket;
  // The extra arg is ignored by the server; it only labels the process.
  const transport = new StdioClientTransport({ command: "node", args: [entry, "--shyn-check-file-search"], env, stderr: "ignore" });
  client = new Client({ name: "check-file-search", version: "0" });
  await client.connect(transport);

  let listed = false;
  const deadline = Date.now() + 5000;
  while (true) {
    const { tools } = await client.listTools();
    if (tools.some((t) => t.name === "search_files")) { listed = true; break; }
    if (Date.now() >= deadline) break;
    await sleep(250);
  }
  if (!listed) {
    fail("search_files is listed", "not registered within 5 s (is thatone running and its socket reachable?)");
  } else {
    pass("search_files is listed");
    // memory_status needs the shyn daemon, which is down in the throwaway home.
    let line;
    try {
      const st = textOf(await client.callTool({ name: "memory_status", arguments: {} })).trim().split("\n");
      const last = st[st.length - 1];
      if (/^file search: /.test(last)) line = last;
    } catch { /* treated as absent */ }
    if (line === undefined) console.log("SKIP memory_status line (daemon not running in the throwaway SHYN_HOME)");
    else console.log(`INFO memory_status: ${line}`);

    for (const q of queries) {
      const name = `search_files "${q}"`;
      const t0 = Date.now();
      let text;
      try {
        const r = await client.callTool({ name: "search_files", arguments: { query: q, limit } });
        text = textOf(r);
        if (r.isError && !text.startsWith("error:")) text = `error: ${text}`;
      } catch (e) { text = `error: ${e?.message ?? e}`; }
      const ms = Date.now() - t0;
      console.log(`\n=== ${q} (${ms} ms) ===\n${text}\n`);
      if (text.startsWith("error:")) fail(name, text.split("\n")[0]);
      else if (text.trim().startsWith("no files found")) pass(name, "zero hits");
      else pass(name);
    }
  }
} catch (e) {
  fail("check run", e?.message ?? String(e));
} finally {
  try { await client?.close(); } catch { /* best effort */ }
  if (home) rmSync(home, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
