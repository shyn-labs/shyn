import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConsent, recordConsentChoice, consentNeedsPrompt } from "../src/analytics-consent.js";

// Consent state. The spec's hard rule: no installId exists and no event is
// queued until the first-run dialog has been SHOWN and answered — even
// though the dialog ships with the toggle pre-checked on. "Pre-checked" is
// a default the user can see and change, not a silent opt-in.

const withHome = (fn: (home: string) => void) => {
  const home = mkdtempSync(join(tmpdir(), "shyn-consent-"));
  try { fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
};

describe("fresh install", () => {
  test("needs a prompt, and analytics is inert until it is answered", () => {
    withHome((home) => {
      const c = loadConsent(home);
      expect(consentNeedsPrompt(c)).toBe(true);
      expect(c.enabled).toBe(false);      // inert BEFORE the answer
      expect(c.installId).toBeUndefined(); // no identity minted yet
    });
  });
});

describe("answering the dialog", () => {
  test("accepting mints an installId and enables sending", () => {
    withHome((home) => {
      recordConsentChoice(home, true);
      const c = loadConsent(home);
      expect(consentNeedsPrompt(c)).toBe(false);
      expect(c.enabled).toBe(true);
      expect(c.installId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  test("declining records the answer and mints NO identity", () => {
    withHome((home) => {
      recordConsentChoice(home, false);
      const c = loadConsent(home);
      expect(consentNeedsPrompt(c)).toBe(false);
      expect(c.enabled).toBe(false);
      // Declining must not leave a stable identifier lying around: if the
      // user later opts in, that is a new decision and a new id.
      expect(c.installId).toBeUndefined();
    });
  });

  test("the choice survives a restart", () => {
    withHome((home) => {
      recordConsentChoice(home, true);
      const first = loadConsent(home).installId;
      expect(loadConsent(home).installId).toBe(first);   // stable, not regenerated
    });
  });

  test("opting out later discards the identity", () => {
    withHome((home) => {
      recordConsentChoice(home, true);
      expect(loadConsent(home).installId).toBeDefined();
      recordConsentChoice(home, false);
      const c = loadConsent(home);
      expect(c.enabled).toBe(false);
      expect(c.installId).toBeUndefined();
    });
  });
});

describe("upgrades from a pre-analytics version", () => {
  test("an existing install is prompted, not silently opted in", () => {
    withHome((home) => {
      // A machine that installed shyn under the old "100% local, zero cloud"
      // promise. It must see the dialog before anything is sent, or it would
      // start phoning home having never been told.
      writeFileSync(join(home, "capture.json"), JSON.stringify({ enabled: true }));
      const c = loadConsent(home);
      expect(consentNeedsPrompt(c)).toBe(true);
      expect(c.enabled).toBe(false);
    });
  });
});

describe("corrupt state", () => {
  test("unreadable consent file fails CLOSED, and re-prompts", () => {
    withHome((home) => {
      writeFileSync(join(home, "analytics-consent.json"), "{ not json");
      const c = loadConsent(home);
      expect(c.enabled).toBe(false);
      expect(consentNeedsPrompt(c)).toBe(true);
    });
  });

  test("a consent file claiming enabled but carrying no id does not send", () => {
    withHome((home) => {
      writeFileSync(join(home, "analytics-consent.json"),
        JSON.stringify({ answered: true, enabled: true }));
      const c = loadConsent(home);
      expect(c.enabled).toBe(false);   // no id => cannot attribute => do not send
    });
  });

  test("the written file records WHAT was consented to, for auditability", () => {
    withHome((home) => {
      recordConsentChoice(home, true);
      const raw = JSON.parse(readFileSync(join(home, "analytics-consent.json"), "utf8"));
      expect(raw.answered).toBe(true);
      expect(raw.answeredAt).toBeGreaterThan(0);
      expect(raw.categories).toEqual(
        expect.arrayContaining(["usage", "crashes", "install", "performance"]));
    });
  });
});
