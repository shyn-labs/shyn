import { render, elapsedText } from "./render.js";
import { startActionArg } from "./record-form.js";
import type { ViewModel } from "../src/derive.js";

declare global {
  interface Window {
    shyn: {
      onView(cb: (vm: ViewModel) => void): void;
      action(name: string, arg?: string): void;
      resize(h: number): void;
    };
  }
}

const root = document.getElementById("root")!;

// Renderer-local UI state. The record form lives here, not in the view
// model: main pushes a fresh view every 3s and re-rendering would wipe
// whatever the user is typing, so while the form is open the pushes are
// held and applied on close.
let lastVm: ViewModel | null = null;
let recordForm = false;

function paint(): void {
  if (!lastVm) return;
  root.innerHTML = render(lastVm, Math.floor(Date.now() / 1000), { recordForm });
  window.shyn.resize(document.body.scrollHeight);
  if (recordForm) root.querySelector<HTMLInputElement>('input[name="title"]')?.focus();
}

window.shyn.onView((vm) => {
  lastVm = vm;
  if (recordForm && vm.canRecord) return;   // hold: typing in progress
  if (recordForm) recordForm = false;        // recording started elsewhere, or state changed
  paint();
});

root.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!btn) return;
  const name = btn.dataset.action!;
  if (name === "record-form-open") { recordForm = true; paint(); return; }
  if (name === "record-form-close") { recordForm = false; paint(); return; }
  window.shyn.action(name, btn.dataset.arg);
});

root.addEventListener("submit", (e) => {
  const form = (e.target as HTMLElement).closest<HTMLFormElement>('form[data-form="record"]');
  if (!form) return;
  e.preventDefault();
  const title = (form.elements.namedItem("title") as HTMLInputElement).value;
  const attendees = (form.elements.namedItem("attendees") as HTMLInputElement).value;
  window.shyn.action("meeting-start", startActionArg(title, attendees));
  recordForm = false;
  paint();
});

root.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && recordForm) { recordForm = false; paint(); }
});

// Elapsed timer ticks locally between 3s polls.
setInterval(() => {
  for (const el of root.querySelectorAll<HTMLElement>(".elapsed[data-started]"))
    el.textContent = elapsedText(Math.floor(Date.now() / 1000) - Number(el.dataset.started));
}, 1000);
