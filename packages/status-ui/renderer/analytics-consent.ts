// First-run analytics choice.
//
// Shown once, before any event is queued and before an installId exists.
// Deliberately NOT worded as "opt-in" or "opt-out": the box ships ticked,
// and under GDPR a pre-ticked box is not consent (Planet49), so claiming
// opt-in would be a claim this UI does not support. It describes the
// mechanism instead — accurate whatever the default later becomes.
//
// Copy is kept in sync with README.md and shyn.day. If it changes here,
// change it there; a dialog that promises less than the website is the
// failure mode that matters.

export function renderConsent(): string {
  return `
  <div class="ac">
    <h2>Help make the beta reliable</h2>

    <p>shyn runs across different macOS versions, hardware, and permission
    states. Those combinations produce bugs we cannot reproduce or test for,
    and most people who hit one never write in. They just quit.</p>

    <p class="ac-sent"><b>What it sends:</b> which features get used, what
    crashes, the version, and timing numbers, under a random ID that is
    not you.</p>

    <p class="ac-never"><b>What it never sends:</b> anything shyn captured.
    No screen text, no transcripts, no searches, no file paths, no
    identity. Your memory stays on this Mac.</p>

    <label class="ac-toggle">
      <input type="checkbox" id="ac-on" checked />
      <span>Send anonymous usage data</span>
    </label>

    <div class="ac-actions">
      <button class="btn primary" data-action="analytics-consent-confirm">Continue</button>
    </div>

    <p class="ac-fine">You can change this any time in Settings. Turning it
    off stops sending immediately and discards anything queued.</p>
  </div>`;
}

const root = document.getElementById("ac-root");
if (root && (window as any).shyn) {
  root.innerHTML = renderConsent();
  root.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "analytics-consent-confirm") {
      const on = (document.getElementById("ac-on") as HTMLInputElement | null)?.checked ?? false;
      // The checkbox state at the moment Continue is pressed IS the answer.
      (window as any).shyn.action("analytics-consent", on ? "on" : "off");
    }
  });
}
