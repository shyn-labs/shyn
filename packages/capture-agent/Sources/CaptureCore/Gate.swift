import Foundation

public enum SkipReason: String, Sendable {
    case paused, excludedApp, excludedTitle, secureInput
}

public func gate(bundleId: String, title: String, config: CaptureConfig,
                 now: Double, secureInput: Bool) -> SkipReason? {
    if config.isPaused(now: now) { return .paused }
    if config.effectiveExcludedBundleIds.contains(bundleId) { return .excludedApp }
    for pattern in config.effectiveTitlePatterns {
        // A privacy gate must fail CLOSED. Foundation's .regularExpression match
        // returns nil for BOTH "no match" and "invalid pattern", so an invalid
        // user-supplied regex (title metacharacters like [ . ( are common) would
        // silently never match and the window the user meant to exclude would be
        // captured. So: if the pattern compiles as a regex, match as regex;
        // otherwise fall back to a literal case-insensitive substring match.
        if (try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])) != nil {
            if title.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil {
                return .excludedTitle
            }
        } else if title.range(of: pattern, options: [.caseInsensitive]) != nil {
            return .excludedTitle
        }
    }
    if secureInput { return .secureInput }
    return nil
}

// Web-content apps lie to AX: their accessibility tree serves tab titles and
// toolbar text (easily clearing any char threshold) while exposing none of
// the page BODY — lived 2026-07-13: a WeWork portal captured as tab strips,
// zero page content. For these bundles OCR is the only honest reader.
public let webContentBundlePrefixes = [
    "com.google.Chrome", "com.apple.Safari", "org.mozilla.firefox",
    "com.microsoft.edgemac", "company.thebrowser.Browser",
    "com.brave.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
]

public func needsOcr(bundleId: String, axCharCount: Int) -> Bool {
    if webContentBundlePrefixes.contains(where: { bundleId.hasPrefix($0) }) { return true }
    return axCharCount < 80
}

// Content-level secret backstop (fails closed): if captured text contains a
// high-entropy, prefix-identifiable credential, the WHOLE capture is dropped
// before ingest — regardless of the window title. Lived 2026-07-16: a
// Cloudflare token-creation page rendered a live `cfat_...` token as page
// text and it was OCR'd into the register. Patterns are case-SENSITIVE and
// prefix-anchored so they fire only on real secrets, never on prose that
// merely discusses tokens.
private let secretPatterns: [String] = [
    "-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "cfat_[A-Za-z0-9_-]{20,}",                 // Cloudflare API token
    "ghp_[A-Za-z0-9]{36}",                     // GitHub PAT (classic)
    "github_pat_[A-Za-z0-9_]{22,}",            // GitHub PAT (fine-grained)
    "gh[osru]_[A-Za-z0-9]{36}",                // GitHub oauth/server/refresh/user
    "sk-(ant-)?[A-Za-z0-9-]{20,}",             // OpenAI / Anthropic
    "AKIA[0-9A-Z]{16}",                        // AWS access key id
    "AIza[0-9A-Za-z_-]{35}",                   // Google API key
    "xox[baprs]-[A-Za-z0-9-]{10,}",            // Slack
    "(sk|rk|pk)_live_[0-9A-Za-z]{20,}",        // Stripe live
]

public func containsSecret(_ text: String) -> Bool {
    for p in secretPatterns {
        if text.range(of: p, options: .regularExpression) != nil { return true }
    }
    return false
}
