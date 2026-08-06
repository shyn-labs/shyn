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
  paused: false, modelChoice: { selected: "standard", busy: false },
  update: null,
  notice: null,
  setup: { kind: "complete" }, diagnostics: false, ...over,
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
    expect(labels).toEqual(["Health", "Index", "Meeting language"]);
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

describe("meeting language section", () => {
  it("renders two language-framed buttons, selected marked, no note by default", () => {
    const el = mount(render(vm(), NOW));
    const btns = [...el.querySelectorAll('[data-action="meeting-model"]')];
    expect(btns.map((b) => (b as HTMLElement).dataset.arg)).toEqual(["small", "large-v3_turbo"]);
    expect(btns[0].classList.contains("selected")).toBe(true);
    expect(btns[1].classList.contains("selected")).toBe(false);
    expect(el.textContent).toContain("Standard");
    expect(el.textContent).toContain("Multilingual");
    expect(el.querySelector(".model-note")).toBeNull();
  });

  it("multilingual busy: selected flips, note rendered, buttons disabled while downloading", () => {
    const el = mount(render(vm({ modelChoice: {
      selected: "multilingual", busy: true,
      note: "downloading the Multilingual model — meetings still use Standard until it finishes",
    } }), NOW));
    const btns = [...el.querySelectorAll('[data-action="meeting-model"]')] as HTMLButtonElement[];
    expect(btns[1].classList.contains("selected")).toBe(true);
    expect(btns.every((b) => b.disabled)).toBe(true);
    expect(el.querySelector(".model-note")!.textContent).toContain("still use Standard");
  });

  it("custom model: neither selected, note names the model", () => {
    const el = mount(render(vm({ modelChoice: {
      selected: "custom", busy: false, note: 'custom model "medium" set in capture.json',
    } }), NOW));
    const btns = [...el.querySelectorAll('[data-action="meeting-model"]')];
    expect(btns.some((b) => b.classList.contains("selected"))).toBe(false);
    expect(el.querySelector(".model-note")!.textContent).toContain("medium");
  });

  it("no meeting agent → section absent", () => {
    const el = mount(render(vm({ modelChoice: null }), NOW));
    expect(el.querySelector('[data-action="meeting-model"]')).toBeNull();
  });
});

describe("update row", () => {
  it("available: version + Update button", () => {
    const el = mount(render(vm({ update: { version: "0.4.99-alpha", state: "available", canRun: true } }), NOW));
    expect(el.querySelector(".update-row")!.textContent).toContain("0.4.99-alpha");
    expect(el.querySelector('[data-action="run-update"]')).toBeTruthy();
  });

  it("updating: no button, blink copy; failed: copy-command fallback", () => {
    const busy = mount(render(vm({ update: { version: "0.4.99", state: "updating", canRun: true } }), NOW));
    expect(busy.querySelector('[data-action="run-update"]')).toBeNull();
    expect(busy.textContent).toContain("will blink and come back");
    const failed = mount(render(vm({ update: { version: "0.4.99", state: "failed", canRun: true } }), NOW));
    expect(failed.querySelector('[data-action="copy"]')).toBeTruthy();
    expect(failed.textContent).toContain("update failed");
  });

  it("no brew: copy button instead of run; null: no row", () => {
    const noBrew = mount(render(vm({ update: { version: "0.4.99", state: "available", canRun: false } }), NOW));
    expect(noBrew.querySelector('[data-action="run-update"]')).toBeNull();
    expect(noBrew.querySelector('[data-action="copy"]')).toBeTruthy();
    expect(mount(render(vm({ update: null }), NOW)).querySelector(".update-row")).toBeNull();
  });
});

describe("maintainer notice row", () => {
  it("renders the notice text, escaped, above the update row", () => {
    const html = render(vm({
      notice: { severity: "warn", text: "Upgrade by hand once: brew upgrade --cask <shyn>" },
      update: { version: "0.4.20-alpha", state: "available", canRun: true },
    }), NOW);
    expect(html).toContain("notice-row");
    expect(html).toContain("notice-warn");
    expect(html).toContain("Upgrade by hand once");
    expect(html).not.toContain("<shyn>");            // escaped, not injected
    expect(html.indexOf("notice-row")).toBeLessThan(html.indexOf("update-row"));
  });

  it("info severity gets no warn rule, and no notice means no row", () => {
    const info = render(vm({ notice: { severity: "info", text: "Docs moved to shyn.day/docs" } }), NOW);
    expect(info).toContain("notice-row");
    expect(info).not.toContain("notice-warn");
    expect(render(vm({ notice: null }), NOW)).not.toContain("notice-row");
  });
});
