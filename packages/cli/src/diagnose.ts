import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Everything injected: this module makes no network/system calls of its own,
// so it is fully unit-testable and the status app can reuse it verbatim.
// HARD RULE: no document content, no query text, no transcripts — only
// states, counts, versions, and error-level log lines.
export type DiagnoseDeps = {
  sock: string;
  logDir: string;
  uid: number;
  exec: (cmd: string, args: string[]) => string; // stdout; throws when the service is unknown
  rpc: (sock: string, method: string, params: unknown) => Promise<any>;
};

export const SUPPORT_EMAIL = "hello@shyn.day";

// mailto: carries no attachments, so the block rides in the body. Kept pure
// (string in, URL out) so both the CLI and the status app share one
// implementation and it tests without opening anyone's mail client.
export function diagnosticsMailtoUrl(text: string, version?: string): string {
  const MAX = 6000; // conservative: URL-length limits in mail clients
  const block = text.length > MAX ? text.slice(0, MAX) + "\n[truncated — full output: shyn diagnose]" : text;
  const subject = `shyn diagnostics${version ? ` — ${version}` : ""}`;
  const body = `What happened (please describe):\n\n\n----- diagnostics (content-free) -----\n${block}\n`;
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

const LABELS = ["com.shyn.daemon", "com.shyn.capture", "com.shyn.meeting", "com.shyn.status"];
const LOGS = ["daemon.log", "capture.log", "meeting.log", "status.log"];
// A line counts as error-level only when error/fatal/fail(ed|ure) appears
// as a whole marker token within the first 4 tokens — covers "ERROR: x",
// "[error] x", "2026-07-11 12:00:00 ERROR x" (timestamp-first), and
// "model download failed: x" (daemon main.ts) — while excluding prose that
// merely mentions the words later in a sentence. Lines are classified by
// marker position, never scanned for content.
const ERR_TOKEN_RE = /^\[?(\w*error|fatal|fail(ed|ure)?)\]?[:,]?$/i;
const isErrorLine = (l: string) =>
  l.trim().split(/\s+/, 4).some((t) => ERR_TOKEN_RE.test(t));
const MAX_ERR_LINES = 10; // 4 logs × 10 + headers stays under the 80-line budget
const yn = (v: unknown) => (v ? "yes" : "no");

function serviceLine(deps: DiagnoseDeps, label: string): string {
  try {
    const out = deps.exec("launchctl", ["print", `gui/${deps.uid}/${label}`]);
    const state = /state = (\w+)/.exec(out)?.[1] ?? "unknown";
    const exit = /last exit code = ([^\n]+)/.exec(out)?.[1]?.trim();
    return `  ${label}: ${state}${exit !== undefined ? ` (last exit ${exit})` : ""}`;
  } catch {
    return `  ${label}: not loaded`;
  }
}

function errorTail(logDir: string, name: string): string[] {
  const p = join(logDir, name);
  if (!existsSync(p)) return [];
  let raw: string;
  try { raw = readFileSync(p, "utf8"); }
  catch (err: any) {
    // Diagnostics must survive broken machines: permissions, rotation races.
    return [`  ${name}: unreadable (${err?.code ?? err?.message ?? "unknown"})`];
  }
  const hits = raw.split("\n")
    .filter(isErrorLine)
    .slice(-MAX_ERR_LINES)
    .map((l) => `    ${l.slice(0, 200)}`);
  return hits.length ? [`  ${name}:`, ...hits] : [];
}

export async function buildDiagnostics(deps: DiagnoseDeps): Promise<string> {
  const lines: string[] = ["== shyn diagnostics =="];

  let s: any = null;
  try { s = await deps.rpc(deps.sock, "status", {}); }
  catch (err) { lines.push(`daemon: not reachable (${(err as Error).message})`); }

  if (s) {
    lines.push(`versions: daemon ${s.daemonVersion} · protocol ${s.protocolVersion} · schema ${s.schemaVersion}`);
    lines.push(`model: downloaded ${s.modelDownloadPct}% · loaded ${yn(s.modelLoaded)}`);
  }

  lines.push("services:");
  for (const label of LABELS) lines.push(serviceLine(deps, label));

  if (s) {
    lines.push("readers:");
    for (const r of s.readers ?? [])
      lines.push(r.ok
        ? `  ${r.name}: ok (${r.ingested} ingested)`
        : `  ${r.name}: unavailable — ${r.reason ?? "unknown"}`);
    const tcc = s.capture?.tcc ?? {};
    lines.push(`capture: agent ${s.capture?.agent ?? "not-reporting"} · screen tcc: ${yn(tcc.screen)} · ax tcc: ${yn(tcc.ax)}`);
    const m = s.capture?.meeting;
    // calendar and ax are the two rungs of the meeting naming ladder. Neither
    // blocks capture, so both were left out — which made a meeting filed as
    // "Google Chrome meeting" undiagnosable from a bug report (lived
    // 2026-09-06: Accessibility denied for months, nothing said so).
    if (m) lines.push(`meeting: ${m.state} · mic tcc: ${yn(m.tcc?.mic)} · audio tcc: ${yn(m.tcc?.audio)}`
      + ` · calendar tcc: ${yn(m.tcc?.calendar)} · ax tcc: ${yn(m.tcc?.ax)}`
      + ` · whisper ready: ${yn(m.modelReady)}`);
    lines.push(`mcp: last hello ${s.lastMcpHelloTs ? new Date(s.lastMcpHelloTs * 1000).toISOString() : "never"}`);
    lines.push(`index: ${s.documents} docs · ${s.chunks} chunks · ${s.vectors} vectors · ${s.failedEmbeds} failed embeds`);
  }

  lines.push("recent errors:");
  const tails = LOGS.flatMap((n) => errorTail(deps.logDir, n));
  lines.push(...(tails.length ? tails : ["  none found"]));

  return lines.join("\n");
}
