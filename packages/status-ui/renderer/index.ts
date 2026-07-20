import { render, elapsedText } from "./render.js";
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

window.shyn.onView((vm) => {
  root.innerHTML = render(vm, Math.floor(Date.now() / 1000));
  window.shyn.resize(document.body.scrollHeight);
});

root.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (btn) window.shyn.action(btn.dataset.action!, btn.dataset.arg);
});

// Elapsed timer ticks locally between 3s polls.
setInterval(() => {
  for (const el of root.querySelectorAll<HTMLElement>(".elapsed[data-started]"))
    el.textContent = elapsedText(Math.floor(Date.now() / 1000) - Number(el.dataset.started));
}, 1000);
