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

    <p>shyn breaks in ways we cannot predict. Every Mac has a different OS
    version, different hardware, different permissions granted. We cannot
    test for all of it, and almost nobody who hits a bug writes in. They
    just quit.</p>

    <p class="ac-sent"><b>Sent:</b> crashes, which features you use, your
    version, how long things take. Under a random ID that is not you and
    is deleted the moment you turn this off.</p>

    <p class="ac-never"><b>Never sent:</b> a single word shyn captured. Not
    your screen, not your meetings, not your notes, not what you searched
    for, not even your file names.</p>

    <label class="ac-toggle">
      <input type="checkbox" id="ac-on" checked />
      <span>Send anonymous usage data</span>
    </label>

    <div class="ac-actions">
      <button class="btn primary" data-action="analytics-consent-confirm">Continue</button>
    </div>

    <p class="ac-fine">Change it whenever you like in the menu bar. Off means
    off at once, including anything still waiting to send.</p>
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
