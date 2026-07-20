// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "../renderer/render.js";
import type { ViewModel } from "../src/derive.js";

const NOW = 1_783_700_000;

const vm = (over: Partial<ViewModel> = {}): ViewModel => ({
  tray: "healthy", verdict: "all systems go", meeting: null,
  rows: [{ label: "Daemon", value: "v0.2.0", tone: "ok" }],
  stats: [{ label: "Index", value: "16,951 docs · 41,000 vectors", tone: "muted" }],
  week: [],
  paused: false, setup: { kind: "complete" }, diagnostics: false, ...over,
});

const mount = (html: string) => {
  document.body.innerHTML = html;
  return document.body;
};

describe("render", () => {
  it("healthy: verdict, rows with tone dots, stats, pause buttons", () => {
    const el = mount(render(vm(), NOW));
    expect(el.querySelector("header .verdict")!.textContent).toBe("all systems go");
    expect(el.querySelector("header .verdict")!.classList.contains("pill")).toBe(true);
    expect(el.querySelector("header .verdict")!.classList.contains("ok")).toBe(true);
    expect(el.querySelector(".row .dot.ok")).toBeTruthy();
    expect(el.textContent).toContain("16,951 docs");
    const pauses = [...el.querySelectorAll('[data-action="pause"]')];
    expect(pauses.map((b) => (b as HTMLElement).dataset.arg)).toEqual(["30m", "2h", "until-tomorrow"]);
    expect(el.querySelector('[data-action="resume"]')).toBeNull();
  });

  it("verdict pill tone follows tray state: warning→warn, recording→err", () => {
    const warn = mount(render(vm({ tray: "warning", verdict: "screen capture permission" }), NOW));
    expect(warn.querySelector("header .verdict")!.classList.contains("warn")).toBe(true);
    const rec = mount(render(vm({ tray: "recording", verdict: "recording meeting" }), NOW));
    expect(rec.querySelector("header .verdict")!.classList.contains("err")).toBe(true);
  });

  it("section micro-labels present for rows and stats", () => {
    const el = mount(render(vm(), NOW));
    const labels = [...el.querySelectorAll(".section-lab")].map((n) => n.textContent);
    expect(labels).toEqual(["Health", "Index"]);
  });

  it("live meeting card: app, elapsed from startedAt, stop/cancel actions", () => {
    const el = mount(render(vm({
      tray: "recording", verdict: "recording meeting",
      meeting: { app: "Google Meet", startedAt: NOW - 754, state: "recording" },
    }), NOW));
    const live = el.querySelector(".live")!;
    expect(live.textContent).toContain("Google Meet");
    expect(live.querySelector(".elapsed")!.textContent).toBe("12:34");
    expect((live.querySelector(".elapsed") as HTMLElement).dataset.started).toBe(String(NOW - 754));
    expect(live.querySelector('[data-action="meeting-stop"]')).toBeTruthy();
    expect(live.querySelector('[data-action="meeting-cancel"]')).toBeTruthy();
  });

  it("paused: resume button replaces pause row", () => {
    const el = mount(render(vm({ paused: true, verdict: "capture paused" }), NOW));
    expect(el.querySelector('[data-action="resume"]')).toBeTruthy();
    expect(el.querySelector('[data-action="pause"]')).toBeNull();
  });

  it("hints render and content is HTML-escaped", () => {
    const el = mount(render(vm({
      rows: [{ label: "Meeting agent", value: "<img src=x onerror=1>", tone: "warn", hint: "System Settings → Privacy" }],
    }), NOW));
    expect(el.querySelector(".hint")!.textContent).toContain("System Settings");
    expect(el.querySelector("img")).toBeNull();   // escaped, not parsed
  });

  it("popover shows Finish-setup row only while setup is incomplete", () => {
    const withSetup = vm({ setup: { kind: "steps", steps: [], done: 2, total: 5 } });
    const el = mount(render(withSetup, NOW));
    const row = el.querySelector<HTMLElement>('[data-action="open-onboarding"]')!;
    expect(row.textContent).toContain("Finish setup (2/5)");
    const done = mount(render(vm({ setup: { kind: "complete" } }), NOW));
    expect(done.querySelector('[data-action="open-onboarding"]')).toBeNull();
  });

  it("Copy diagnostics button appears only when diagnostics is true", () => {
    const warn = mount(render(vm({ diagnostics: true }), NOW));
    expect(warn.querySelector('[data-action="diagnose"]')).toBeTruthy();
    const healthy = mount(render(vm({ diagnostics: false }), NOW));
    expect(healthy.querySelector('[data-action="diagnose"]')).toBeNull();
  });
});
