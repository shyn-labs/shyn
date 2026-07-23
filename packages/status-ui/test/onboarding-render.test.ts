// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderOnboarding } from "../renderer/onboarding.js";
import type { SetupStep, ViewModel } from "../src/derive.js";

const NOW_STEPS: SetupStep[] = [
  { id: "audio", title: "Microphone & system audio", state: "done", detail: "meetings will be transcribed",
    optionalNote: "system audio verifies itself at your first meeting" },
  { id: "screen", title: "Screen recording & Accessibility", state: "todo",
    detail: "allow shyn-capture to read your screen",
    action: { kind: "settings", pane: "screen-recording" } },
  { id: "models", title: "Memory models", state: "busy", detail: "downloading… 64% · search already works" },
  { id: "claude", title: "Connect Claude", state: "todo", detail: "run this once, then restart Claude",
    action: { kind: "copy", text: "claude mcp add shyn -- …" } },
  { id: "recall", title: "Try your first recall", state: "locked", detail: "unlocks when Claude is connected" },
];

const vm = (setup: ViewModel["setup"]): ViewModel => ({
  tray: "healthy", verdict: "all systems go", meeting: null, rows: [], stats: [], week: [], paused: false,
  modelChoice: null, setup,
  diagnostics: false,
});

const mount = (html: string) => { document.body.innerHTML = html; return document.body; };

describe("renderOnboarding", () => {
  it("steps: progress, states, settings + copy actions with exact data attrs", () => {
    const el = mount(renderOnboarding(vm({ kind: "steps", steps: NOW_STEPS, done: 1, total: 5 })));
    expect(el.querySelector(".ob-progress")!.textContent).toContain("1 of 5");
    expect(el.querySelectorAll(".step").length).toBe(5);
    expect(el.querySelector(".step .tick.done")).toBeTruthy();
    expect(el.querySelector(".step .tick.busy")).toBeTruthy();
    expect(el.querySelector(".step .tick.lock")).toBeTruthy();
    const settings = el.querySelector<HTMLElement>('[data-action="open-settings"]')!;
    expect(settings.dataset.arg).toBe("screen-recording");
    const copy = el.querySelector<HTMLElement>('[data-action="copy"]')!;
    expect(copy.dataset.arg).toContain("claude mcp add");
    expect(el.textContent).toContain("system audio verifies itself");
    expect(el.querySelector<HTMLElement>(".bar-fill")!.dataset.pct).toBe("20");
  });

  it("complete: celebration state carries the recall prompt + copy, no steps", () => {
    const el = mount(renderOnboarding(vm({ kind: "complete" })));
    expect(el.textContent).toContain("all set");
    expect(el.querySelector(".step")).toBeNull();
    const copy = el.querySelector<HTMLElement>('[data-action="copy"]')!;
    expect(copy.dataset.arg).toBe("what was I reading in the last hour?");
  });

  it("unavailable: daemon banner, steps greyed container", () => {
    const el = mount(renderOnboarding(vm({ kind: "unavailable" })));
    expect(el.textContent).toContain("daemon");
  });

  it("escapes step content", () => {
    const el = mount(renderOnboarding(vm({ kind: "steps", done: 0, total: 1, steps: [
      { id: "claude", title: "<img src=x onerror=1>", state: "todo", detail: "x" },
    ]})));
    expect(el.querySelector("img")).toBeNull();
  });
});
