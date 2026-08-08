#!/usr/bin/env tsx
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { shynHome } from "@shyn/engine/paths";
import { rpcCall, isDaemonDownError } from "@shyn/daemon/rpc";
import { extractText, getDocumentProxy } from "unpdf";
import { installDaemon, uninstallDaemon, installCaptureAgent, installMeetingAgent, installStatusApp, LAUNCHD_LABEL } from "./launchd.js";
import { pauseCapture, resumeCapture, addExclude } from "./capture-config.js";
import { requestMeetingStop, requestMeetingCancel } from "./meeting-control.js";
import { runSetup } from "./setup.js";
import { buildDiagnostics, diagnosticsMailtoUrl } from "./diagnose.js";

const DAEMON_DOWN_MESSAGE =
  "shyn daemon is not running — start it with: pnpm --filter @shyn/daemon start";

const sock = () => join(shynHome(), "shyn.sock");
const cfgPath = () => join(shynHome(), "capture.json");
const repoRoot = () => join(import.meta.dirname, "..", "..", "..");
const execReal = (cmd: string, args: string[]) => { execFileSync(cmd, args); };

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if ([".md", ".txt", ".pdf"].includes(extname(p))) yield p;
  }
}

async function fileText(path: string): Promise<string> {
  if (extname(path) !== ".pdf") return readFileSync(path, "utf8");
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(path)), { verbosity: 0 });
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

async function cmdIngest(path: string, print: (s: string) => void) {
  const files = statSync(path).isDirectory() ? [...walk(path)] : [path];
  for (const f of files) {
    let text: string;
    try { text = await fileText(f); }
    catch (err: any) { print(`${f}: skipped (${err?.message ?? "unreadable"})`); continue; }
    const r = await rpcCall(sock(), "ingest", {
      source: "file", uri: f, title: basename(f),
      ts: Math.floor(statSync(f).mtimeMs / 1000), text,
    });
    print(`${f}: ${r.deduped ? "unchanged" : `ingested (${r.chunks} chunks)`}`);
  }
}

// Object.entries + template-literal interpolation stringifies non-scalars
// via their default toString (arrays/objects become "[object Object]");
// JSON.stringify keeps them readable and machine-parseable.
const fmtStatusValue = (v: unknown): string =>
  typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);

async function cmdStatus(print: (s: string) => void) {
  const s = await rpcCall(sock(), "status", {});
  for (const [k, v] of Object.entries(s)) print(`${k}: ${fmtStatusValue(v)}`);
}

async function cmdSearch(query: string, print: (s: string) => void) {
  const r = await rpcCall(sock(), "search", { query });
  print(`mode: ${r.mode}`);
  for (const h of r.hits)
    print(`[${h.score.toFixed(4)}] ${h.uri} (${h.source}) — ${h.text.slice(0, 80)}`);
}

// Reads a passphrase without echoing it and without it reaching shell history —
// an --passphrase flag would sit in ~/.zsh_history forever, and this passphrase
// is the only thing standing between an archive and everything in it.
// SHYN_PASSPHRASE exists for scripted backups, where a TTY does not exist.
async function readPassphrase(prompt: string, print: (s: string) => void): Promise<string | null> {
  const fromEnv = process.env.SHYN_PASSPHRASE;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    print("aborted: needs an interactive terminal, or set SHYN_PASSPHRASE");
    return null;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
  process.stdout.write(prompt);
  const muted = (rl as unknown as { output: NodeJS.WriteStream }).output;
  const origWrite = muted.write.bind(muted);
  (muted as unknown as { write: (c: string) => boolean }).write = () => true;   // swallow the echo
  const answer = await new Promise<string>((res) => rl.question("", res));
  (muted as unknown as { write: typeof origWrite }).write = origWrite;
  process.stdout.write("\n");
  rl.close();
  void stdin;
  return answer;
}

async function cmdExport(args: string[], print: (s: string) => void) {
  const path = args[0];
  if (!path) return print("usage: shyn export <path.shynarc>");
  const pass = await readPassphrase("Passphrase for the archive: ", print);
  if (pass === null) { process.exitCode = 1; return; }
  if (!pass) { print("error: a passphrase is required"); process.exitCode = 1; return; }
  const confirm = process.env.SHYN_PASSPHRASE
    ? pass : await readPassphrase("Confirm passphrase: ", print);
  if (confirm !== pass) { print("error: passphrases do not match"); process.exitCode = 1; return; }
  try {
    const r = await rpcCall(sock(), "export", { path, passphrase: pass }, 600_000);
    print(`exported ${r.documents} document(s) to ${path}`);
    print("Keep this file and the passphrase apart from this Mac — it is the only");
    print("copy of your memory that survives losing the machine or its Keychain.");
  } catch (e: any) { print(`error: ${e.message}`); process.exitCode = 1; }
}

async function cmdImport(args: string[], print: (s: string) => void) {
  const path = args[0];
  if (!path) return print("usage: shyn import <path.shynarc>");
  const pass = await readPassphrase("Passphrase for the archive: ", print);
  if (pass === null) { process.exitCode = 1; return; }
  try {
    const r = await rpcCall(sock(), "import", { path, passphrase: pass }, 600_000);
    print(`imported ${r.imported} document(s); ${r.deduped} already present`);
  } catch (e: any) { print(`error: ${e.message}`); process.exitCode = 1; }
}

async function cmdShow(args: string[], print: (s: string) => void) {
  const uri = args[0];
  if (!uri) return print("usage: shyn show <uri> [--source <source>]");
  const si = args.indexOf("--source");
  const source = si >= 0 ? args[si + 1] : undefined;
  if (si >= 0 && !source) { print("error: --source requires a value"); process.exitCode = 1; return; }
  let d: any;
  try {
    d = await rpcCall(sock(), "document", { uri, source });
  } catch (e: any) {
    // An ambiguous uri arrives as a plain RPC error naming the sources.
    print(`error: ${e.message}`); process.exitCode = 1; return;
  }
  if (!d) { print(`no document with uri "${uri}"`); process.exitCode = 1; return; }
  // No truncation: paging exists to protect an MCP context window, not a
  // terminal. `shyn show <uri> > transcript.md` is the export path.
  print(d.text);
}

async function cmdStats(args: string[], print: (s: string) => void) {
  let days = 7;
  const di = args.indexOf("--days");
  if (di >= 0) {
    days = Number(args[di + 1]);
    if (!Number.isInteger(days) || days <= 0) {
      print("error: --days requires a positive integer"); return;
    }
  }
  const s = await rpcCall(sock(), "stats", { days });
  print(`last ${s.days} days`);
  print(`  pages read: ${s.pagesRead}`);
  const mtg = s.meetingSeconds > 0
    ? `${s.meetings} (${Math.round(s.meetingSeconds / 60)} min transcribed)`
    : String(s.meetings);
  print(`  meetings: ${mtg}`);
  print(`  searches: ${s.searches} (${s.searchesTotal} all-time)`);
  for (const [src, n] of Object.entries(s.docsBySource))
    print(`  ${src}: ${n} ingested`);
  print(`index total: ${s.totals.documents} docs · ${s.totals.chunks} chunks · ${s.totals.vectors} vectors`);
}

async function cmdForget(args: string[], print: (s: string) => void) {
  const sel: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], v = args[i + 1];
    if (v === undefined || v.startsWith("--")) {
      print(`error: ${flag} requires a value`); return;
    }
    if (flag === "--source") sel.source = v;
    else if (flag === "--doc") sel.docId = Number(v);
    else if (flag === "--from") sel.timeFrom = Math.floor(Date.parse(v) / 1000);
    else if (flag === "--to") sel.timeTo = Math.floor(Date.parse(v) / 1000);
    else { print(`error: unknown flag ${flag}`); return; }
  }
  if (Object.keys(sel).length === 0) { print("error: forget requires at least one selector"); return; }
  if (!process.stdin.isTTY) {
    print("aborted: forget requires an interactive terminal to confirm"); return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((res) => rl.question("Type 'yes' to confirm: ", res));
  rl.close();
  if (answer.trim() !== "yes") { print("aborted"); return; }
  const r = await rpcCall(sock(), "forget", { ...sel, confirm: true });
  print(`forgotten: ${r.documents} document(s)`);
}

async function cmdSync(args: string[], print: (s: string) => void) {
  const full = args.includes("--full");
  if (full) print("full backfill: re-walking ALL history (watermarks reset — this can take a while)");
  const results = await rpcCall(sock(), "sync", { full });
  for (const r of results)
    print(r.ok
      ? `${r.name}: ${r.ingested} ingested, ${r.deduped} unchanged`
      : `${r.name}: unavailable — ${r.reason}`);
}

async function cmdInstall(print: (s: string) => void) {
  const { plistPath } = await installDaemon({
    launchAgentsDir: join(homedir(), "Library", "LaunchAgents"),
    logDir: join(homedir(), "Library", "Logs", "shyn"),
    repoRoot: repoRoot(),
    shynHome: shynHome(),
    exec: execReal,
  });
  print(`installed and started ${LAUNCHD_LABEL} (${plistPath})`);
  print(`logs: ~/Library/Logs/shyn/daemon.log`);

  const cap = await installCaptureAgent({
    launchAgentsDir: join(homedir(), "Library", "LaunchAgents"),
    logDir: join(homedir(), "Library", "Logs", "shyn"),
    repoRoot: repoRoot(),
    shynHome: shynHome(),
    exec: execReal,
  });
  print("plistPath" in cap
    ? `installed and started com.shyn.capture (${cap.plistPath})`
    : `capture agent skipped: ${cap.skipped}`);

  const mtg = await installMeetingAgent({
    launchAgentsDir: join(homedir(), "Library", "LaunchAgents"),
    logDir: join(homedir(), "Library", "Logs", "shyn"),
    repoRoot: repoRoot(),
    shynHome: shynHome(),
    exec: execReal,
  });
  print("plistPath" in mtg
    ? `installed and started com.shyn.meeting (${mtg.plistPath})`
    : `meeting agent skipped: ${mtg.skipped}`);

  const st = await installStatusApp({
    launchAgentsDir: join(homedir(), "Library", "LaunchAgents"),
    logDir: join(homedir(), "Library", "Logs", "shyn"),
    repoRoot: repoRoot(),
    shynHome: shynHome(),
    exec: execReal,
  });
  print("plistPath" in st
    ? `installed and started com.shyn.status (${st.plistPath})`
    : `status app skipped: ${st.skipped}`);
}

async function cmdUninstall(args: string[], print: (s: string) => void) {
  const purgeRequested = args.includes("--purge");
  let confirmed = false;

  if (purgeRequested) {
    if (!process.stdin.isTTY) {
      print("purge requires an interactive terminal — daemon uninstalled, data kept");
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((res) =>
        rl.question("This deletes the daemon, database, and Keychain key. Type 'yes' to confirm: ", res));
      rl.close();
      confirmed = answer.trim() === "yes";
      if (!confirmed) {
        print("purge declined — daemon uninstalled, data kept");
      }
    }
  }

  await uninstallDaemon({
    launchAgentsDir: join(homedir(), "Library", "LaunchAgents"),
    exec: execReal,
    purge: confirmed ? { shynHome: shynHome(), logDir: join(homedir(), "Library", "Logs", "shyn"), deleteKeychain: true } : undefined,
  });

  if (!purgeRequested) {
    print("uninstalled: daemon stopped, plist removed (data kept — rerun with --purge to delete it)");
  } else if (!confirmed) {
    // Already printed the decline message above
  } else {
    print("uninstalled: daemon stopped, plist removed, database, logs, and Keychain key deleted");
  }
}

export async function runCli(argv: string[], print: (s: string) => void = console.log) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "ingest" && rest[0]) return await cmdIngest(rest[0], print);
    if (cmd === "status") return await cmdStatus(print);
    if (cmd === "search" && rest[0]) return await cmdSearch(rest.join(" "), print);
    if (cmd === "show") return await cmdShow(rest, print);
    if (cmd === "export") return await cmdExport(rest, print);
    if (cmd === "import") return await cmdImport(rest, print);
    if (cmd === "stats") return await cmdStats(rest, print);
    if (cmd === "diagnose") {
      // diagnose handles daemon-down itself — that's its whole point.
      const diagText = await buildDiagnostics({
        sock: sock(),
        logDir: join(homedir(), "Library", "Logs", "shyn"),
        uid: process.getuid?.() ?? 501,
        exec: (c, a) => execFileSync(c, a, { encoding: "utf8" }),
        rpc: (s, m, p) => rpcCall(s, m, p),
      });
      print(diagText);
      if (rest.includes("--mail")) {
        // opens THEIR mail client with the block staged — nothing sends
        // until the human hits send ("you choose where it goes").
        execFileSync("open", [diagnosticsMailtoUrl(diagText)]);
        print("\n(opened your mail client — describe what happened, review, send)");
      }
      return;
    }
    if (cmd === "forget") return await cmdForget(rest, print);
    if (cmd === "sync") return await cmdSync(rest, print);
    if (cmd === "install") {
      if (process.env.SHYN_PAYLOAD) {
        print("install is for repo checkouts — run: shyn setup");
        return;
      }
      return await cmdInstall(print);
    }
    if (cmd === "uninstall") return await cmdUninstall(rest, print);
    if (cmd === "pause") {
      const until = pauseCapture(cfgPath(), rest[0] ?? "30m", Math.floor(Date.now() / 1000));
      return print(`capture paused until ${new Date(until * 1000).toLocaleString()}`);
    }
    if (cmd === "resume") { resumeCapture(cfgPath()); return print("capture resumed"); }
    if (cmd === "setup") {
      const payload = process.env.SHYN_PAYLOAD;
      if (!payload) {
        print("shyn setup runs from a packaged install (brew). In the repo, use: pnpm setup");
        process.exitCode = 1;
        return;
      }
      // setup-signing.sh narrates "enter your login/keychain password if
      // prompted" while `security` prompts on the tty — execReal's piped
      // stdout would swallow that. Inherit stdio for the setup path only.
      const execInherit = (cmd: string, args: string[]) => {
        execFileSync(cmd, args, { stdio: "inherit" });
      };
      const res = await runSetup({
        payloadRoot: payload,
        shynHome: shynHome(),
        launchAgentsDir: join(homedir(), "Library", "LaunchAgents"),
        logDir: join(homedir(), "Library", "Logs", "shyn"),
        exec: execInherit, print,
      });
      if (!res.ok) { print(`setup failed: ${res.error}`); process.exitCode = 1; }
      return;
    }
    if (cmd === "meeting") {
      const sub = rest[0];
      if (sub === "status") {
        const s = await rpcCall(sock(), "status", {});
        return print(JSON.stringify(s.capture?.meeting ?? { agent: "not-reporting" }, null, 2));
      }
      if (sub === "stop") { requestMeetingStop(shynHome()); return print("meeting stop requested"); }
      if (sub === "cancel") { requestMeetingCancel(shynHome()); return print("meeting cancel requested"); }
      return print("usage: shyn meeting <status|stop|cancel>");
    }
    if (cmd === "exclude") {
      if (!rest[0]) return print("usage: shyn exclude <bundle-id|title-regex>");
      addExclude(cfgPath(), rest[0]); return print(`excluded: ${rest[0]}`);
    }
    print("usage: shyn <ingest <path> | status | search <query> | show <uri> [--source <source>] | export <path> | import <path> | stats [--days N] | diagnose [--mail] | forget [--source|--doc|--from|--to] | sync [--full] | install | uninstall [--purge] | setup | pause [30m|2h|until-tomorrow] | resume | exclude <bundle-id|title-regex> | meeting <status|stop|cancel>>");
  } catch (err) {
    if (isDaemonDownError(err)) print(DAEMON_DOWN_MESSAGE);
    else print(`error: ${(err as Error).message}`);
  }
}

// Compare realpaths: Node resolves symlinks in import.meta.url but leaves
// process.argv[1] as invoked (e.g. macOS /var -> /private/var, brew symlinks).
const invokedAsMain = () => {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]); }
  catch { return false; }
};

if (invokedAsMain()) await runCli(process.argv.slice(2));
