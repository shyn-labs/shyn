import type { Row, ViewModel } from "../src/derive.js";
import { UPGRADE_COMMAND } from "../src/update-core.js";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const elapsedText = (sec: number): string => {
  const m = Math.floor(Math.max(0, sec) / 60), s = Math.max(0, sec) % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
};

const dot = (tone: Row["tone"]) => `<span class="dot ${tone}"></span>`;

// Verdict pill tone: mirrors the tray traffic-light, not row tones.
// "transcribing" is a benign in-progress state (not a problem), so it reads ok.
const verdictTone = (tray: ViewModel["tray"]): Row["tone"] =>
  tray === "recording" ? "err" : tray === "warning" ? "warn" : "ok";

const rowHtml = (r: Row) => `
  <div class="row">
    <span class="lab">${dot(r.tone)}${esc(r.label)}</span>
    <span class="val ${r.tone}">${esc(r.value)}</span>
    ${r.hint ? `<div class="hint">${esc(r.hint)}</div>` : ""}
  </div>`;

export function render(vm: ViewModel, nowSec: number): string {
  const live = vm.meeting ? `
  <div class="live ${vm.meeting.state}">
    <div class="live-head">
      ${dot("err")}<b>${esc(vm.meeting.app)}</b>
      <span class="elapsed" data-started="${vm.meeting.startedAt}">${elapsedText(nowSec - vm.meeting.startedAt)}</span>
    </div>
    <div class="live-actions">
      <button data-action="meeting-stop">Stop</button>
      <button data-action="meeting-cancel" class="ghost">Cancel</button>
    </div>
  </div>` : "";

  const controls = vm.paused
    ? `<button data-action="resume" class="wide">Resume capture</button>`
    : `<div class="pauses"><span class="lab">Pause</span>
        <button data-action="pause" data-arg="30m">30m</button>
        <button data-action="pause" data-arg="2h">2h</button>
        <button data-action="pause" data-arg="until-tomorrow">until tomorrow</button>
      </div>`;

  // Language-framed model choice (never model jargon in the labels); both
  // buttons freeze during a download so a second click can't queue a
  // conflicting switch mid-flight.
  const mc = vm.modelChoice;
  const modelSection = mc ? `
  <section class="stats"><h2 class="section-lab">Meeting language</h2>
    <div class="seg">
      <button data-action="meeting-model" data-arg="small"
        class="${mc.selected === "standard" ? "selected" : ""}" ${mc.busy ? "disabled" : ""}>Standard</button>
      <button data-action="meeting-model" data-arg="large-v3"
        class="${mc.selected === "multilingual" ? "selected" : ""}" ${mc.busy ? "disabled" : ""}>Multilingual</button>
    </div>
    <div class="seg-hint">Multilingual: Hindi, Spanish &amp; more · ~3GB one-time download</div>
    ${mc.note ? `<div class="seg-hint model-note">${esc(mc.note)}</div>` : ""}
  </section>` : "";

  // Always reachable: a friend's problem ("search feels wrong") often has
  // no warning state — exactly when they need the mail button. Warning
  // states get the prominent pair; healthy gets one quiet row.
  const diagnostics = vm.diagnostics
    ? `<button data-action="diagnose-mail" class="wide">Email diagnostics to shyn</button>
       <button data-action="diagnose" class="wide ghost">Copy diagnostics</button>`
    : `<button data-action="diagnose-mail" class="wide ghost">Something off? Email diagnostics</button>`;

  const setupRow = vm.setup.kind === "steps" ? `
  <div class="row setup-row" data-action="open-onboarding">
    <span class="lab">☀️ Finish setup (${vm.setup.done}/${vm.setup.total})</span>
    <span class="val">→</span>
  </div>` : "";

  // In-app update (spec 2026-07-24). Quiet by design: no red, no badge —
  // an update is an offer, not a problem.
  const u = vm.update;
  const updateRow = u ? `
  <div class="row update-row">
    ${u.state === "updating"
      ? `<span class="lab">updating to v${esc(u.version)}…</span><span class="val">☀️</span>
         <div class="hint">the ☀️ will blink and come back on the new version</div>`
      : u.state === "failed"
      ? `<span class="lab">update failed</span>
         <button data-action="copy" data-arg="${esc(UPGRADE_COMMAND)}">Copy command</button>
         <div class="hint">paste the copied command into Terminal — details in ~/Library/Logs/shyn/update.log</div>`
      : `<span class="lab">v${esc(u.version)} available</span>
         ${u.canRun
           ? `<button data-action="run-update">Update</button>`
           : `<button data-action="copy" data-arg="${esc(UPGRADE_COMMAND)}">Copy command</button>`}`}
  </div>` : "";

  return `
  <header><b>shyn</b><span class="verdict pill ${verdictTone(vm.tray)}">${esc(vm.verdict)}</span></header>
  ${setupRow}
  ${updateRow}
  ${live}
  <section class="rows"><h2 class="section-lab">Health</h2>${vm.rows.map(rowHtml).join("")}</section>
  <section class="stats"><h2 class="section-lab">Index</h2>${vm.stats.map(rowHtml).join("")}</section>
  ${vm.week.length ? `<section class="stats"><h2 class="section-lab">This week</h2>${vm.week.map(rowHtml).join("")}</section>` : ""}
  ${modelSection}
  <footer>${controls}${diagnostics}</footer>`;
}
