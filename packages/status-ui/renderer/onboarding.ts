import { RECALL_PROMPT } from "../src/derive.js";
import type { SetupStep, ViewModel } from "../src/derive.js";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const TICK: Record<SetupStep["state"], string> = {
  done: "✓", todo: "", busy: "◔", locked: "•", waiting: "…",
};

const stepHtml = (s: SetupStep) => `
  <div class="step ${s.state}">
    <div class="tick ${s.state === "locked" ? "lock" : s.state}">${TICK[s.state]}</div>
    <div class="step-body">
      <b>${esc(s.title)}</b>
      <div class="sdesc">${esc(s.detail)}</div>
      ${s.action?.kind === "settings"
        ? `<button data-action="open-settings" data-arg="${s.action.pane}">Open System Settings →</button>` : ""}
      ${s.action?.kind === "copy"
        ? `<button data-action="copy" data-arg="${esc(s.action.text)}">Copy</button>` : ""}
      ${s.secondaryAction?.kind === "reveal-apps"
        ? `<button data-action="reveal-apps" class="ghost">Show apps in Finder</button>` : ""}
      ${s.optionalNote ? `<div class="sdesc note">${esc(s.optionalNote)}</div>` : ""}
    </div>
  </div>`;

export function renderOnboarding(vm: ViewModel): string {
  if (vm.setup.kind === "complete") return `
    <div class="ob-hero"><div class="ob-sun">☀️</div>
      <h1>You're all set</h1>
      <p class="sdesc">shyn is remembering. Try asking Claude:</p>
      <p class="sdesc"><b>"${esc(RECALL_PROMPT)}"</b>
        <button data-action="copy" data-arg="${esc(RECALL_PROMPT)}">Copy</button></p></div>`;
  if (vm.setup.kind === "unavailable") return `
    <div class="ob-hero"><div class="ob-sun">☀️</div>
      <h1>Let's set up shyn</h1>
      <p class="sdesc warn">the daemon isn't running — start it with: pnpm shyn install</p></div>`;
  const { steps, done, total } = vm.setup;
  return `
    <div class="ob-hero"><div class="ob-sun">☀️</div>
      <h1>Let's set up shyn</h1>
      <p class="sdesc ob-progress">${done} of ${total} done — about 3 minutes</p></div>
    <div class="bar"><div class="bar-fill" data-pct="${total ? Math.round((done / total) * 100) : 0}"></div></div>
    <div class="steps">${steps.map(stepHtml).join("")}</div>`;
}

// Entry wiring (same bridge as the popover) — executed only in the browser,
// harmless under jsdom import since it guards on the element.
const root = document.getElementById("ob-root");
if (root && (window as any).shyn) {
  (window as any).shyn.onView((vm: ViewModel) => {
    root.innerHTML = renderOnboarding(vm);
    for (const el of root.querySelectorAll<HTMLElement>(".bar-fill[data-pct]"))
      el.style.width = `${Number(el.dataset.pct) || 0}%`;
  });
  root.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (btn) (window as any).shyn.action(btn.dataset.action!, btn.dataset.arg);
  });
}
