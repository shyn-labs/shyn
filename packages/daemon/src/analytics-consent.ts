import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Consent state for usage analytics.
//
// shyn shipped publicly promising "100% local. Zero cloud. Nothing phones
// home." Analytics changes that, so the consent rules are stricter than the
// default alone would suggest:
//
//   - The first-run dialog ships with the toggle PRE-CHECKED ON. That is a
//     visible default the user can change, not a silent opt-in.
//   - Nothing is sent, and NO installId exists, until that dialog has been
//     shown and answered. "Answered" includes accepting the default.
//   - Existing installs upgrading from a pre-analytics version are prompted
//     too. They installed under the old promise; starting to send data
//     without ever telling them would be the version of this that damages
//     trust. `answered` is absent on their disk, so they prompt naturally.
//   - Declining, or later opting out, DESTROYS the installId. A stable
//     identifier left behind for someone who said no is exactly the thing
//     the promise was about.
//
// Design: docs/superpowers/specs/2026-09-01-analytics-telemetry-design.md

const FILE = "analytics-consent.json";

/// What the user was told they were agreeing to. Written into the file so a
/// later dispute can be settled by reading disk rather than reconstructing
/// which build shipped which dialog copy.
export const CONSENT_CATEGORIES = ["usage", "crashes", "install", "performance"] as const;

export interface Consent {
  answered: boolean;
  enabled: boolean;
  /// Absent unless the user is actively opted in.
  installId?: string;
  answeredAt?: number;
}

const OFF: Consent = { answered: false, enabled: false };

export function loadConsent(home: string): Consent {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(join(home, FILE), "utf8"));
  } catch {
    // Missing OR corrupt both mean "we cannot prove consent". Fail closed
    // and re-ask rather than assume the last known answer.
    return OFF;
  }
  if (raw?.answered !== true) return OFF;
  const installId = typeof raw.installId === "string" ? raw.installId : undefined;
  // enabled without an id is incoherent — there is nothing to attribute the
  // events to, so treat it as off rather than minting an id on the fly.
  const enabled = raw.enabled === true && installId !== undefined;
  return { answered: true, enabled, installId, answeredAt: raw.answeredAt };
}

/// True when the first-run dialog still has to be shown.
export const consentNeedsPrompt = (c: Consent): boolean => !c.answered;

/// Record the user's answer. Minting the id here — not at daemon start — is
/// what makes "no identity before consent" true rather than aspirational.
export function recordConsentChoice(home: string, enabled: boolean): Consent {
  const existing = loadConsent(home);
  const next: Consent = {
    answered: true,
    enabled,
    // Reuse an existing id when staying opted in, so version-adoption curves
    // are not broken by a daemon restart. Opting out drops it entirely.
    installId: enabled ? (existing.installId ?? randomUUID()) : undefined,
    answeredAt: Math.floor(Date.now() / 1000),
  };
  const onDisk: Record<string, unknown> = {
    answered: true,
    enabled,
    answeredAt: next.answeredAt,
    categories: [...CONSENT_CATEGORIES],
  };
  if (next.installId) onDisk.installId = next.installId;
  writeFileSync(join(home, FILE), JSON.stringify(onDisk, null, 2) + "\n");
  return next;
}
