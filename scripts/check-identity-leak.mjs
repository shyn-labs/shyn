#!/usr/bin/env node
// Blocks author-identity and real-world-identity leaks before they reach a
// public commit. This repo is published under a project identity, and the
// failure mode is mundane: someone (human or agent) writes a test fixture or
// a code comment using whatever real name, company, or meeting title happened
// to be on screen. That shipped once already.
//
// Four checks, ordered by signal:
//   1. author/committer email must belong to the project identity
//   2. added lines must not match the PRIVATE denylist (real names, employers,
//      domains). The list deliberately lives OUTSIDE this repo — committing a
//      list of the names you are hiding would leak the association itself.
//   3. added lines must not carry email addresses outside a tiny allowlist
//   4. added lines must not carry the Firstname-plus-parenthesised-domain
//      shape that browser window titles and screenshots drag in
//
// Modes:
//   --staged            check the staged diff (pre-commit)     [default]
//   --file <path>       check a file's contents (commit-msg)
//   --range <A..B>      check a commit range's added lines (CI / review)
//   --ci                denylist is optional (it is private, so absent in CI)
//
// Usage: node scripts/check-identity-leak.mjs [--staged|--file X|--range A..B] [--ci]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const ci = args.includes("--ci") || process.env.CI === "true";
const mode = args.includes("--file") ? "file" : args.includes("--range") ? "range" : "staged";
const modeArg = args[args.indexOf(`--${mode}`) + 1];

const IDENTITY_EMAIL_SUFFIX = "@shyn.day";
const EMAIL_ALLOWLIST = [
  /@shyn\.day$/i,
  /@example\.(com|org|net)$/i,
  /^noreply@/i,                        // tool/bot trailers (Co-Authored-By)
  /@users\.noreply\.github\.com$/i,
];
const DENYLIST_PATH = process.env.SHYN_LEAK_DENYLIST
  ?? join(homedir(), ".config/shyn/leak-denylist.txt");

const git = (...a) => execFileSync("git", a, { encoding: "utf8" });
const fail = (lines) => {
  console.error("\nidentity-leak check FAILED\n");
  for (const l of lines) console.error(`  ${l}`);
  console.error(`
This repo is public under a project identity. Fixtures and comments must use
placeholder names (Acme, Globex, Sam, example.com), never a real person,
employer, customer, domain, or meeting title.

If a hit is a false positive, rename the fixture — do not weaken the guard.
Denylist: ${DENYLIST_PATH}
`);
  process.exit(1);
};

// --- check 1: commit identity -----------------------------------------------
function checkIdentity(problems) {
  if (mode === "range") return;   // historical commits are audited, not gated
  const who = [
    ["author", process.env.GIT_AUTHOR_EMAIL ?? git("config", "user.email").trim()],
    ["committer", process.env.GIT_COMMITTER_EMAIL ?? git("config", "user.email").trim()],
  ];
  for (const [role, email] of who) {
    if (!email.toLowerCase().endsWith(IDENTITY_EMAIL_SUFFIX)) {
      problems.push(`${role} email "${email}" is not ${IDENTITY_EMAIL_SUFFIX} — `
        + `run: git config user.email bot${IDENTITY_EMAIL_SUFFIX}`);
    }
  }
}

// --- the text under inspection ----------------------------------------------
function addedLines() {
  if (mode === "file") {
    return readFileSync(modeArg, "utf8").split("\n").map((text, i) => ({ text, where: `${modeArg}:${i + 1}` }));
  }
  const diff = mode === "range"
    ? git("diff", "-U0", modeArg)
    : git("diff", "--cached", "-U0");
  const out = [];
  let file = "?";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) { file = line.slice(6); continue; }
    if (line.startsWith("+") && !line.startsWith("+++")) out.push({ text: line.slice(1), where: file });
  }
  return out;
}

// --- check 2: private denylist ----------------------------------------------
function loadDenylist(problems) {
  if (!existsSync(DENYLIST_PATH)) {
    if (ci) return [];
    problems.push(`denylist missing at ${DENYLIST_PATH} — the guard cannot run.`);
    problems.push(`Create it (one term per line, # for comments) or set SHYN_LEAK_DENYLIST.`);
    return null;
  }
  return readFileSync(DENYLIST_PATH, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((term) => ({
      term,
      // Word-ish boundaries so a two-letter term cannot trip inside an
      // ordinary word, while dotted terms (a domain) still match.
      re: new RegExp(`(^|[^A-Za-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`, "i"),
    }));
}

// --- checks 3 & 4: shapes ---------------------------------------------------
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// "Sam (example.com)" — the Chrome profile suffix that window titles and
// screenshots drag in. Placeholder domains are exempt: the title cleaner and
// its tests must contain this exact shape to be testable at all.
const PROFILE_RE = /[A-Z][a-z]+ \(([a-z0-9-]+\.[a-z]{2,})\)/;
const PLACEHOLDER_DOMAINS = /^(example\.(com|org|net)|shyn\.day|localhost)$/i;

function main() {
  const problems = [];
  checkIdentity(problems);
  const denylist = loadDenylist(problems);
  if (denylist === null) fail(problems);

  for (const { text, where } of addedLines()) {
    for (const { term, re } of denylist) {
      if (re.test(text)) problems.push(`${where}: denylisted term "${term}" — ${text.trim().slice(0, 90)}`);
    }
    for (const email of text.match(EMAIL_RE) ?? []) {
      if (!EMAIL_ALLOWLIST.some((re) => re.test(email))) {
        problems.push(`${where}: email address "${email}"`);
      }
    }
    const profile = text.match(PROFILE_RE);
    if (profile && !PLACEHOLDER_DOMAINS.test(profile[1])) {
      problems.push(`${where}: browser-profile shape "${profile[0]}"`);
    }
  }

  if (problems.length) fail(problems);
  const scope = mode === "file" ? modeArg : mode === "range" ? modeArg : "staged changes";
  console.log(`identity-leak check OK (${scope}, ${denylist.length} denylist terms)`);
}

main();
